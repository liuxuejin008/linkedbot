use crate::config::Config;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

/// ChannelServer REST API 通信客户端。
///
/// 封装登录、频道查询、转发规则同步、消息拉取、
/// 以及 Proxy 模式下的回调结果提交（ReqID → 回传响应）。
pub struct ChannelServerApi {
    pub cfg: Arc<Config>,
    pub http: Client,
    token: RwLock<String>,
    user_id: RwLock<i64>,
}

#[derive(Debug, Deserialize)]
struct LoginResp {
    access_token: String,
    user_id: i64,
    email: String,
}

#[derive(Debug, Deserialize)]
struct ChannelListResp {
    channels: Vec<ChannelInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ChannelInfo {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub webhook_secret: String,
}

#[derive(Debug, Deserialize)]
struct ForwardListResp {
    forwards: Vec<ForwardTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ForwardTarget {
    pub id: i64,
    pub channel_id: i64,
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub extra_headers_json: Option<serde_json::Value>,
    #[serde(default)]
    pub enabled: i64,
}

#[derive(Serialize)]
struct ProxyResultPayload {
    body: String,
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<HashMap<String, String>>,
}

impl ChannelServerApi {
    pub fn new(cfg: Arc<Config>) -> Self {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build HTTP client");
        Self {
            cfg,
            http,
            token: RwLock::new(String::new()),
            user_id: RwLock::new(0),
        }
    }

    pub async fn auth_header(&self) -> String {
        format!("Bearer {}", self.token.read().await)
    }

    pub async fn login(&self) -> Result<(), String> {
        let url = format!("{}/api/auth/login", self.cfg.server_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "email": self.cfg.email,
                "password": self.cfg.password,
            }))
            .send()
            .await
            .map_err(|e| format!("网络错误: {e}"))?;

        if resp.status().as_u16() == 401 {
            return Err("邮箱或密码错误".into());
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }

        let data: LoginResp = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
        *self.token.write().await = data.access_token;
        *self.user_id.write().await = data.user_id;
        info!("[ChannelClient] 已登录 ChannelServer，账号={}", data.email);
        Ok(())
    }

    pub async fn list_channels(&self) -> Result<Vec<ChannelInfo>, String> {
        let url = format!("{}/api/channels", self.cfg.server_url);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header().await)
            .send()
            .await
            .map_err(|e| format!("网络错误: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let data: ChannelListResp = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
        Ok(data.channels)
    }

    pub async fn get_receiver_targets(&self, channel_id: i64) -> Result<Vec<ForwardTarget>, String> {
        let url = format!(
            "{}/api/channels/{}/forwards",
            self.cfg.server_url, channel_id
        );
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header().await)
            .send()
            .await
            .map_err(|e| format!("网络错误: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let data: ForwardListResp = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
        Ok(data.forwards)
    }

    pub async fn submit_proxy_result(
        &self,
        channel_id: i64,
        req_id: i64,
        body: &str,
        status: u16,
        headers: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        let url = format!(
            "{}/api/channels/{}/proxy-response/{}",
            self.cfg.server_url, channel_id, req_id
        );
        let payload = ProxyResultPayload {
            body: body.to_string(),
            status,
            headers,
        };
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header().await)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("网络错误: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        Ok(())
    }

    pub async fn ack_sendbox_message(&self, channel_id: i64) -> Result<(), String> {
        let url = format!(
            "{}/api/channels/{}/messages/pull",
            self.cfg.server_url, channel_id
        );
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header().await)
            .query(&[("limit", "1")])
            .send()
            .await
            .map_err(|e| format!("网络错误: {e}"))?;
        if !resp.status().is_success() {
            error!(
                "[ChannelClient] ack_sendbox_message 失败: HTTP {}",
                resp.status()
            );
        }
        Ok(())
    }
}
