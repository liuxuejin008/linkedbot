use crate::api::{ChannelInfo, ChannelServerApi, ForwardTarget};
use crate::receiver;
use crate::sse::SseStream;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::watch;
use tokio::time::{sleep, Duration, Instant};
use tracing::{info, warn};

/// Per-channel SSE listener that proxies events to local ChannelReceivers.
#[allow(dead_code)]
pub struct ChannelClient {
    api: Arc<ChannelServerApi>,
    pub channel_id: i64,
    pub channel_name: String,
    pub mode: String,
    since: i64,
    proxy_since: i64,
    receivers: Vec<ForwardTarget>,
}

impl ChannelClient {
    pub fn new(api: Arc<ChannelServerApi>, ch: ChannelInfo) -> Self {
        Self {
            api,
            channel_id: ch.id,
            channel_name: ch.name,
            mode: if ch.mode.is_empty() {
                "sendbox".into()
            } else {
                ch.mode
            },
            since: 0,
            proxy_since: 0,
            receivers: Vec::new(),
        }
    }

    // ── Receiver sync ────────────────────────────────────────────────────

    async fn sync_receivers(&mut self) {
        match self.api.get_receiver_targets(self.channel_id).await {
            Ok(targets) => {
                let enabled: Vec<_> = targets.into_iter().filter(|t| t.enabled != 0).collect();
                if !enabled.is_empty() {
                    let urls: Vec<_> = enabled.iter().map(|t| t.url.as_str()).collect();
                    info!(
                        "[ChannelClient] 频道#{} 已同步 {} 个 ChannelReceiver: {}",
                        self.channel_id,
                        enabled.len(),
                        urls.join(", ")
                    );
                    self.receivers = enabled;
                } else if !self.api.cfg.receiver_url.is_empty() {
                    info!(
                        "[ChannelClient] 频道#{} 使用默认 ChannelReceiver: {}",
                        self.channel_id, self.api.cfg.receiver_url
                    );
                    self.receivers = vec![ForwardTarget {
                        id: 0,
                        channel_id: self.channel_id,
                        url: self.api.cfg.receiver_url.clone(),
                        method: Some(self.api.cfg.receiver_method.clone()),
                        extra_headers_json: None,
                        enabled: 1,
                    }];
                } else {
                    warn!(
                        "[ChannelClient] 频道#{} 未配置 ChannelReceiver",
                        self.channel_id
                    );
                    self.receivers.clear();
                }
            }
            Err(e) => {
                warn!(
                    "[ChannelClient] 频道#{} 同步 ChannelReceiver 失败: {}",
                    self.channel_id, e
                );
            }
        }
    }

    // ── Sendbox event handler ────────────────────────────────────────────

    async fn on_sendbox_message(&self, msg: &Value) {
        if self.receivers.is_empty() {
            return;
        }

        let original_headers = parse_headers(msg.get("headers"));
        let payload = msg.get("payload").unwrap_or(msg);
        let msg_id = msg
            .get("id")
            .and_then(|v| v.as_i64())
            .map(|v| v.to_string())
            .unwrap_or_default();

        let mut all_ok = true;
        for target in &self.receivers {
            let extra = parse_extra_headers(&target.extra_headers_json);
            let method = target.method.as_deref().unwrap_or("POST");
            let result = receiver::call_receiver(
                &self.api.http,
                &target.url,
                method,
                payload,
                self.channel_id,
                &msg_id,
                original_headers.as_ref(),
                &extra,
            )
            .await;
            if !result.ok {
                all_ok = false;
            }
        }

        if all_ok {
            if let Err(e) = self.api.ack_sendbox_message(self.channel_id).await {
                warn!(
                    "[ChannelClient] 频道#{} 消息#{} 标读失败: {}",
                    self.channel_id, msg_id, e
                );
            } else {
                info!(
                    "[ChannelClient] 频道#{} 消息#{} 已标为已读",
                    self.channel_id, msg_id
                );
            }
        }
    }

    // ── Proxy event handler ──────────────────────────────────────────────

    async fn on_proxy_request(&self, pr: &Value) {
        let req_id = pr.get("request_id").and_then(|v| v.as_i64()).unwrap_or(0);
        let original_headers = parse_headers(pr.get("headers"));
        let payload = pr.get("payload").unwrap_or(pr);

        if self.receivers.is_empty() {
            warn!(
                "[ChannelClient] 频道#{} ReqID={}：无 ChannelReceiver，返回 502",
                self.channel_id, req_id
            );
            let _ = self
                .api
                .submit_proxy_result(
                    self.channel_id,
                    req_id,
                    r#"{"error":"no_receiver_configured"}"#,
                    502,
                    None,
                )
                .await;
            return;
        }

        // Proxy mode uses only the first receiver (single synchronous response)
        let target = &self.receivers[0];
        let extra = parse_extra_headers(&target.extra_headers_json);
        let method = target.method.as_deref().unwrap_or("POST");

        let result = receiver::call_receiver(
            &self.api.http,
            &target.url,
            method,
            payload,
            self.channel_id,
            &req_id.to_string(),
            original_headers.as_ref(),
            &extra,
        )
        .await;

        let resp_headers = if result.headers.is_empty() {
            None
        } else {
            Some(result.headers)
        };

        match self
            .api
            .submit_proxy_result(
                self.channel_id,
                req_id,
                &result.body,
                result.status_code,
                resp_headers,
            )
            .await
        {
            Ok(_) => info!(
                "[ChannelClient] 频道#{} ReqID={} 结果已回传 ChannelServer (HTTP {})",
                self.channel_id, req_id, result.status_code
            ),
            Err(e) => warn!(
                "[ChannelClient] 频道#{} ReqID={} 回传失败: {}",
                self.channel_id, req_id, e
            ),
        }
    }

    // ── Main SSE loop ────────────────────────────────────────────────────

    pub async fn run(mut self, mut stop: watch::Receiver<bool>) {
        let mut backoff = 1.0_f64;
        let sync_interval = Duration::from_secs(self.api.cfg.sync_interval_secs);
        let mut next_sync = Instant::now();

        loop {
            if *stop.borrow() {
                break;
            }

            if Instant::now() >= next_sync {
                self.sync_receivers().await;
                next_sync = Instant::now() + sync_interval;
            }

            let sse_url = format!(
                "{}/api/channels/{}/messages/stream?since={}&proxy_since={}",
                self.api.cfg.server_url, self.channel_id, self.since, self.proxy_since
            );
            info!(
                "[ChannelClient] 频道#{} SSE 连接中 (since={}, proxy_since={}, mode={})...",
                self.channel_id, self.since, self.proxy_since, self.mode
            );

            let connect_result = self
                .api
                .http
                .get(&sse_url)
                .header("Authorization", self.api.auth_header().await)
                .send()
                .await;

            match connect_result {
                Ok(resp) if resp.status().as_u16() == 401 => {
                    warn!("[ChannelClient] SSE 401，重新登录...");
                    let _ = self.api.login().await;
                    continue;
                }
                Ok(resp) if resp.status().is_success() => {
                    info!(
                        "[ChannelClient] 频道#{} SSE 已连接",
                        self.channel_id
                    );
                    backoff = 1.0;

                    let mut stream = SseStream::new(resp);
                    loop {
                        if *stop.borrow() {
                            break;
                        }

                        // Use tokio::select to check stop signal while waiting for events
                        let evt = tokio::select! {
                            e = stream.next_event() => e,
                            _ = stop.changed() => break,
                        };

                        let evt = match evt {
                            Some(e) => e,
                            None => break, // stream ended
                        };

                        match evt.event.as_str() {
                            "proxy_request" if !evt.data.is_empty() => {
                                let pr: Value = match serde_json::from_str(&evt.data) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                                if let Some(id_str) = evt.id.strip_prefix('p') {
                                    if let Ok(id) = id_str.parse::<i64>() {
                                        self.proxy_since = self.proxy_since.max(id);
                                    }
                                }
                                self.on_proxy_request(&pr).await;
                            }
                            "message" if !evt.data.is_empty() => {
                                let msg: Value = match serde_json::from_str(&evt.data) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                                if let Ok(id) = evt.id.parse::<i64>() {
                                    self.since = self.since.max(id);
                                }
                                self.on_sendbox_message(&msg).await;
                            }
                            "reconnect" => break,
                            "skip" => {} // corrupted record, cursor already advanced
                            _ => {}
                        }
                    }
                }
                Ok(resp) => {
                    warn!(
                        "[ChannelClient] 频道#{} SSE HTTP 错误: {}",
                        self.channel_id,
                        resp.status()
                    );
                }
                Err(e) => {
                    warn!(
                        "[ChannelClient] 频道#{} SSE 连接失败: {}",
                        self.channel_id, e
                    );
                }
            }

            if *stop.borrow() {
                break;
            }

            info!(
                "[ChannelClient] 频道#{} SSE 断开，{:.0}s 后重连...",
                self.channel_id, backoff
            );

            tokio::select! {
                _ = sleep(Duration::from_secs_f64(backoff)) => {}
                _ = stop.changed() => break,
            }
            backoff = (backoff * 2.0).min(30.0);
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn parse_headers(val: Option<&Value>) -> Option<HashMap<String, String>> {
    val.and_then(|v| {
        v.as_object().map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
    })
}

fn parse_extra_headers(val: &Option<Value>) -> HashMap<String, String> {
    val.as_ref()
        .and_then(|v| {
            let obj = match v {
                Value::String(s) => serde_json::from_str(s).ok(),
                Value::Object(_) => Some(v.clone()),
                _ => None,
            };
            obj.and_then(|o| {
                o.as_object().map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
            })
        })
        .unwrap_or_default()
}
