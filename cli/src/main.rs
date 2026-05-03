mod cli;
mod config;
mod models;
mod server;
mod vault;

use clap::Parser;

#[tokio::main]
async fn main() {
    // Default log level: info. User can override with RUST_LOG.
    if std::env::var_os("RUST_LOG").is_none() {
        std::env::set_var("RUST_LOG", "info");
    }
    env_logger::Builder::from_default_env()
        .format_timestamp_secs()
        .init();

    let args = cli::Cli::parse();
    if let Err(e) = cli::run(args).await {
        eprintln!("error: {}", e);
        std::process::exit(1);
    }
}
