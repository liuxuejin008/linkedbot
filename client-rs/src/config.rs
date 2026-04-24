use std::env;
use std::path::PathBuf;

/// ChannelClient 运行配置，从 .env 文件或环境变量读取。
#[derive(Debug, Clone)]
pub struct Config {
    pub server_url: String,
    pub email: String,
    pub password: String,
    pub channel_ids: Vec<i64>,
    pub receiver_url: String,
    pub receiver_method: String,
    pub sync_interval_secs: u64,
}

impl Config {
    pub fn from_env() -> Self {
        // Load .env next to the binary, then current dir
        let exe_dir = env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from));
        if let Some(dir) = exe_dir {
            let _ = dotenvy::from_path(dir.join(".env"));
        }
        let _ = dotenvy::dotenv(); // cwd/.env

        let server_url = get_required("CHANNEL_SERVER_URL").trim_end_matches('/').to_string();
        let email = get_required("CHANNEL_EMAIL");
        let password = get_required("CHANNEL_PASSWORD");

        let channel_ids: Vec<i64> = env::var("CHANNEL_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        let receiver_url = env::var("CHANNEL_RECEIVER_URL")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        let receiver_method = env::var("CHANNEL_RECEIVER_METHOD")
            .unwrap_or_else(|_| "POST".to_string())
            .to_uppercase();

        let sync_interval_secs: u64 = env::var("CHANNEL_SYNC_INTERVAL")
            .unwrap_or_else(|_| "60".into())
            .parse()
            .unwrap_or(60);

        Config {
            server_url,
            email,
            password,
            channel_ids,
            receiver_url,
            receiver_method,
            sync_interval_secs,
        }
    }
}

fn get_required(key: &str) -> String {
    match env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            eprintln!("环境变量 {key} 为必填项");
            std::process::exit(1);
        }
    }
}
