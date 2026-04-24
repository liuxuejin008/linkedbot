use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;
use tracing::{info, warn};

/// Infrastructure headers that should NOT be forwarded to the ChannelReceiver.
const SKIP_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
];

/// Result of calling a ChannelReceiver.
pub struct ReceiverResult {
    pub ok: bool,
    pub body: String,
    pub status_code: u16,
    pub headers: HashMap<String, String>,
}

/// Decide the body string and Content-Type for the outgoing request to the
/// ChannelReceiver. When the ChannelServer received a non-JSON payload it
/// stores it as `{ "_raw": "<original>" }` and keeps the original Content-Type
/// in the headers map — we restore both here.
fn build_request_body(
    payload: &Value,
    original_headers: Option<&HashMap<String, String>>,
) -> (String, String) {
    if let Some(raw) = payload.get("_raw") {
        let ct = original_headers
            .and_then(|h| h.get("content-type").or_else(|| h.get("Content-Type")))
            .cloned()
            .unwrap_or_else(|| "application/octet-stream".into());
        let body = match raw {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        return (body, ct);
    }
    (payload.to_string(), "application/json".into())
}

/// Build the header map to send to the ChannelReceiver, filtering out
/// infrastructure headers and adding LinkedBot metadata.
fn build_forward_headers(
    original_headers: Option<&HashMap<String, String>>,
    content_type: &str,
    channel_id: i64,
    req_id: &str,
    extra_headers: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();

    if let Some(orig) = original_headers {
        for (k, v) in orig {
            if !SKIP_HEADERS.contains(&k.to_lowercase().as_str()) {
                out.insert(k.clone(), v.clone());
            }
        }
    }

    out.insert("Content-Type".into(), content_type.into());
    out.insert("X-LinkedBot-Channel-Id".into(), channel_id.to_string());
    out.insert("X-LinkedBot-Request-Id".into(), req_id.into());

    for (k, v) in extra_headers {
        out.insert(k.clone(), v.clone());
    }
    out
}

/// Forward a request to a ChannelReceiver endpoint and return the result.
pub async fn call_receiver(
    http: &Client,
    target_url: &str,
    target_method: &str,
    payload: &Value,
    channel_id: i64,
    req_id: &str,
    original_headers: Option<&HashMap<String, String>>,
    extra_headers: &HashMap<String, String>,
) -> ReceiverResult {
    let method = target_method.to_uppercase();
    let (body_str, ct) = build_request_body(payload, original_headers);
    let headers = build_forward_headers(original_headers, &ct, channel_id, req_id, extra_headers);

    let t0 = Instant::now();

    let mut builder = http.request(
        method.parse().unwrap_or(reqwest::Method::POST),
        target_url,
    );
    for (k, v) in &headers {
        builder = builder.header(k.as_str(), v.as_str());
    }

    if method == "GET" {
        if let Some(obj) = payload.as_object() {
            let mut params = Vec::new();
            for (k, v) in obj {
                let val_str = match v {
                    Value::String(s) => s.clone(),
                    _ => v.to_string(),
                };
                params.push((k, val_str));
            }
            builder = builder.query(&params);
        }
    } else {
        builder = builder.body(body_str);
    }

    builder = builder.timeout(std::time::Duration::from_secs(15));

    match builder.send().await {
        Ok(resp) => {
            let elapsed = t0.elapsed().as_millis();
            let status = resp.status().as_u16();
            let ok = resp.status().is_success();
            let resp_headers: HashMap<String, String> = resp
                .headers()
                .iter()
                .filter(|(k, _)| {
                    let lk = k.as_str().to_lowercase();
                    lk != "transfer-encoding" && lk != "connection"
                })
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let resp_body = resp.text().await.unwrap_or_default();

            if ok {
                info!(
                    "[ChannelClient] ReqID={} → {} {} [HTTP {}, {}ms]",
                    req_id, method, target_url, status, elapsed
                );
            } else {
                warn!(
                    "[ChannelClient] ReqID={} → {} {} [HTTP {}, {}ms]",
                    req_id, method, target_url, status, elapsed
                );
            }
            ReceiverResult {
                ok,
                body: resp_body,
                status_code: status,
                headers: resp_headers,
            }
        }
        Err(e) => {
            let elapsed = t0.elapsed().as_millis();
            warn!(
                "[ChannelClient] ReqID={} → {} {} 连接失败: {} ({}ms)",
                req_id, method, target_url, e, elapsed
            );
            ReceiverResult {
                ok: false,
                body: e.to_string(),
                status_code: 502,
                headers: HashMap::new(),
            }
        }
    }
}
