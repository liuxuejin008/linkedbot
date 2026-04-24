mod api;
mod client;
mod config;
mod receiver;
mod sse;

use config::Config;
use std::sync::Arc;
use tokio::sync::watch;
use tracing::{error, info};

#[tokio::main]
async fn main() {
    init_tracing();

    let cfg = Arc::new(Config::from_env());
    let api = Arc::new(api::ChannelServerApi::new(cfg.clone()));

    if let Err(e) = api.login().await {
        error!("[ChannelClient] 登录失败: {e}");
        std::process::exit(1);
    }

    let channels = match api.list_channels().await {
        Ok(all) => {
            if cfg.channel_ids.is_empty() {
                all
            } else {
                all.into_iter()
                    .filter(|ch| cfg.channel_ids.contains(&ch.id))
                    .collect()
            }
        }
        Err(e) => {
            error!("[ChannelClient] 获取频道列表失败: {e}");
            std::process::exit(1);
        }
    };

    if channels.is_empty() {
        error!("[ChannelClient] 未找到频道，请先在 ChannelServer 上创建频道");
        std::process::exit(1);
    }

    let names: Vec<String> = channels
        .iter()
        .map(|ch| format!("{} (#{}, {})", ch.name, ch.id, ch.mode))
        .collect();
    info!(
        "[ChannelClient] 监听 {} 个频道: {}",
        channels.len(),
        names.join(", ")
    );

    let (stop_tx, stop_rx) = watch::channel(false);

    let mut handles = Vec::new();
    for ch in channels {
        let cl = client::ChannelClient::new(api.clone(), ch);
        let rx = stop_rx.clone();
        handles.push(tokio::spawn(async move { cl.run(rx).await }));
    }

    // Graceful shutdown on SIGINT / SIGTERM
    shutdown_signal().await;
    info!("[ChannelClient] 收到退出信号，正在关闭...");
    let _ = stop_tx.send(true);

    for h in handles {
        let _ = h.await;
    }

    info!("[ChannelClient] 已退出");
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,reqwest=warn,hyper=warn,h2=warn,rustls=warn")),
        )
        .with_timer(fmt::time::LocalTime::new(
            time_format_description(),
        ))
        .with_target(false)
        .init();
}

fn time_format_description() -> &'static [time::format_description::BorrowedFormatItem<'static>] {
    // HH:MM:SS — matches the Python client format
    use time::macros::format_description;
    format_description!("[hour]:[minute]:[second]")
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await.ok();
    }
}
