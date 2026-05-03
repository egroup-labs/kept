use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::{Parser, Subcommand};
use walkdir::WalkDir;

use crate::config;
use crate::server;

#[derive(Parser, Debug)]
#[command(
    name = "kept",
    about = "Headless companion for the Kept browser extension.",
    version,
    long_about = "Runs a tiny local HTTP server that the Kept browser extension hands \
                  conversations to. Saves them as Obsidian-friendly markdown in a folder \
                  of your choice."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the sync daemon in the foreground (ctrl-c to stop).
    Daemon {
        /// Override the configured port (default 18241 — required for the
        /// stock browser extension to find the daemon).
        #[arg(long)]
        port: Option<u16>,
    },

    /// Open the browser-side connect page so the extension can pick up the
    /// auth token. The daemon must be running.
    Connect {
        /// Print the URL instead of trying to open a browser.
        #[arg(long)]
        print: bool,
    },

    /// Show daemon liveness, vault path, token, and last extension contact.
    Status,

    /// Print the active vault path (where conversations get written).
    GetVault,

    /// Set the vault path. Pass an absolute directory; it will be created if
    /// missing. Picks up on the next ingest — no daemon restart needed.
    SetVault {
        /// Absolute path to the directory (e.g. your Obsidian vault).
        path: PathBuf,
    },

    /// Print the current auth token.
    Token,

    /// Print the state directory (~/.kept-cli).
    Path,

    /// List synced conversations.
    List {
        /// Filter by platform: chatgpt | claude | gemini | grok | kimi.
        #[arg(long)]
        platform: Option<String>,
        /// Cap the number of results.
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },

    /// Case-insensitive search across the vault's markdown files. For huge
    /// vaults, prefer ripgrep — this is here so the CLI is self-sufficient.
    Search {
        /// Query string.
        query: String,
        /// Cap the number of matching files shown.
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
}

pub async fn run(cli: Cli) -> Result<(), String> {
    config::init_dirs()?;

    match cli.command {
        Command::Daemon { port } => cmd_daemon(port).await,
        Command::Connect { print } => cmd_connect(print).await,
        Command::Status => cmd_status().await,
        Command::GetVault => cmd_get_vault(),
        Command::SetVault { path } => cmd_set_vault(path),
        Command::Token => cmd_token(),
        Command::Path => cmd_path(),
        Command::List { platform, limit } => cmd_list(platform, limit),
        Command::Search { query, limit } => cmd_search(&query, limit),
    }
}

async fn cmd_daemon(port_override: Option<u16>) -> Result<(), String> {
    let port = port_override.unwrap_or_else(config::port);
    let token = config::read_token()?;
    let vault = config::vault_dir()?;

    log::info!("kept-cli {} starting", env!("CARGO_PKG_VERSION"));
    log::info!("vault: {}", vault.display());
    log::info!("connect: http://127.0.0.1:{}/connect", port);

    let state = Arc::new(server::AppState::new(token));
    server::serve(state, port).await
}

async fn cmd_connect(print_only: bool) -> Result<(), String> {
    let port = config::port();
    let url = format!("http://127.0.0.1:{}/connect", port);

    // Check the daemon is actually up — otherwise the browser will just see
    // a connection-refused page.
    let alive = ping_daemon(port).await;
    if !alive {
        eprintln!(
            "warning: the kept daemon doesn't seem to be running on port {port}. \
             Start it first with `kept daemon` (or `kept daemon &` to background)."
        );
    }

    if print_only {
        println!("{}", url);
        return Ok(());
    }

    match open_browser(&url) {
        Ok(()) => {
            println!("opened {} in your browser.", url);
            println!("if nothing happened, paste it manually.");
        }
        Err(e) => {
            eprintln!("could not open a browser ({}). open this URL manually:", e);
            println!("{}", url);
        }
    }
    Ok(())
}

async fn cmd_status() -> Result<(), String> {
    let port = config::port();
    let token = config::read_token().unwrap_or_default();
    let vault = config::vault_dir()?;
    let state_dir = config::app_dir()?;

    let alive = ping_daemon(port).await;

    println!("kept-cli {}", env!("CARGO_PKG_VERSION"));
    println!("  state dir : {}", state_dir.display());
    println!("  vault     : {}", vault.display());
    println!("  port      : {}", port);
    println!(
        "  token     : {}",
        if token.is_empty() {
            "(missing)".to_string()
        } else {
            mask_token(&token)
        }
    );
    println!(
        "  daemon    : {}",
        if alive { "running" } else { "not running" }
    );

    if alive {
        println!("  connect   : http://127.0.0.1:{}/connect", port);
    } else {
        println!("  start it  : kept daemon");
    }

    // Vault stats
    let counts = count_vault(&vault);
    if counts.total > 0 {
        println!("  synced    : {} conversation(s)", counts.total);
        for (plat, n) in &counts.per_platform {
            if *n > 0 {
                println!("    {:<8}  {}", plat, n);
            }
        }
    } else {
        println!("  synced    : 0");
    }

    Ok(())
}

fn cmd_get_vault() -> Result<(), String> {
    println!("{}", config::vault_dir()?.display());
    Ok(())
}

fn cmd_set_vault(path: PathBuf) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "vault path must be absolute (got {:?}). Try a full path like ~/Documents/Obsidian/Kept.",
            path
        ));
    }
    fs::create_dir_all(&path).map_err(|e| format!("create {:?}: {}", path, e))?;

    // Pre-create per-platform subdirs so the very first ingest doesn't race.
    for p in config::PLATFORMS {
        let pd = path.join(p);
        fs::create_dir_all(&pd).map_err(|e| format!("create {:?}: {}", pd, e))?;
        let assets = pd.join("assets");
        fs::create_dir_all(&assets).map_err(|e| format!("create {:?}: {}", assets, e))?;
    }

    let mut cfg = config::read_config()?;
    cfg.vault_path = Some(path.to_string_lossy().into_owned());
    config::write_config(&cfg)?;

    println!("vault set to: {}", path.display());
    println!("(takes effect on next ingest — no daemon restart needed)");
    Ok(())
}

fn cmd_token() -> Result<(), String> {
    println!("{}", config::read_token()?);
    Ok(())
}

fn cmd_path() -> Result<(), String> {
    println!("{}", config::app_dir()?.display());
    Ok(())
}

fn cmd_list(platform: Option<String>, limit: usize) -> Result<(), String> {
    let vault = config::vault_dir()?;
    if !vault.exists() {
        println!("vault is empty: {}", vault.display());
        return Ok(());
    }

    let mut entries: Vec<ConvEntry> = Vec::new();
    let platforms = match platform.as_deref() {
        Some(p) => vec![p.to_string()],
        None => config::PLATFORMS.iter().map(|s| s.to_string()).collect(),
    };

    for p in platforms {
        let dir = vault.join(&p);
        if !dir.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&dir).min_depth(1).max_depth(1) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let fm = read_frontmatter_head(path);
            entries.push(ConvEntry {
                platform: p.clone(),
                file: path.file_name().unwrap_or_default().to_string_lossy().into(),
                title: fm.title.unwrap_or_else(|| {
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                }),
                updated_at: fm.updated_at.or(fm.created_at),
            });
        }
    }

    // Newest first by updated_at, then by filename (which is date-prefixed).
    entries.sort_by(|a, b| {
        b.updated_at
            .as_deref()
            .unwrap_or("")
            .cmp(a.updated_at.as_deref().unwrap_or(""))
            .then_with(|| b.file.cmp(&a.file))
    });

    if entries.is_empty() {
        println!("no conversations found in {}", vault.display());
        return Ok(());
    }

    let total = entries.len();
    for e in entries.iter().take(limit) {
        let when = e.updated_at.as_deref().unwrap_or("?");
        println!("{:<10}  {:<20}  {}", e.platform, when, e.title);
    }
    if total > limit {
        println!("... {} more (use --limit to show more)", total - limit);
    }
    Ok(())
}

fn cmd_search(query: &str, limit: usize) -> Result<(), String> {
    if query.is_empty() {
        return Err("search query is empty".into());
    }
    let needle = query.to_lowercase();
    let vault = config::vault_dir()?;
    if !vault.exists() {
        println!("vault is empty: {}", vault.display());
        return Ok(());
    }

    let mut hits: Vec<(PathBuf, String)> = Vec::new();
    'outer: for entry in WalkDir::new(&vault).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let lower = content.to_lowercase();
        if let Some(idx) = lower.find(&needle) {
            let snippet = make_snippet(&content, idx, query.len());
            hits.push((path.to_path_buf(), snippet));
            if hits.len() >= limit {
                break 'outer;
            }
        }
    }

    if hits.is_empty() {
        println!("no matches for {:?}", query);
        return Ok(());
    }
    for (path, snippet) in &hits {
        println!("{}", path.display());
        println!("  {}", snippet);
        println!();
    }
    Ok(())
}

// ── helpers ─────────────────────────────────────────────────────────────

#[derive(Default)]
struct VaultCounts {
    total: usize,
    per_platform: Vec<(String, usize)>,
}

fn count_vault(vault: &Path) -> VaultCounts {
    let mut counts = VaultCounts::default();
    if !vault.exists() {
        return counts;
    }
    for p in config::PLATFORMS {
        let dir = vault.join(p);
        let mut n = 0usize;
        if dir.is_dir() {
            for entry in WalkDir::new(&dir).min_depth(1).max_depth(1) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
                    n += 1;
                }
            }
        }
        counts.total += n;
        counts.per_platform.push((p.to_string(), n));
    }
    counts
}

struct ConvEntry {
    platform: String,
    file: String,
    title: String,
    updated_at: Option<String>,
}

#[derive(Default)]
struct FrontmatterHead {
    title: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// Cheap frontmatter reader — only reads the first 8 KiB of the file. The
/// CLI doesn't index, so this gets called every time `list` or `status` runs.
fn read_frontmatter_head(path: &Path) -> FrontmatterHead {
    let mut buf = String::new();
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return FrontmatterHead::default(),
    };
    let _ = file.take(8 * 1024).read_to_string(&mut buf);
    parse_frontmatter(&buf)
}

fn parse_frontmatter(content: &str) -> FrontmatterHead {
    let mut out = FrontmatterHead::default();
    let rest = match content.strip_prefix("---") {
        Some(r) => r,
        None => return out,
    };
    let end = match rest.find("---") {
        Some(e) => e,
        None => return out,
    };
    for line in rest[..end].lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("title:") {
            out.title = Some(unquote(v.trim()));
        } else if let Some(v) = line.strip_prefix("created_at:") {
            out.created_at = Some(unquote(v.trim()));
        } else if let Some(v) = line.strip_prefix("updated_at:") {
            let v = unquote(v.trim());
            if !v.is_empty() {
                out.updated_at = Some(v);
            }
        }
    }
    out
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').trim_matches('\'').to_string()
}

fn make_snippet(content: &str, idx: usize, needle_len: usize) -> String {
    // Operate on bytes, but make sure we cut on char boundaries.
    let bytes = content.as_bytes();
    let start = idx.saturating_sub(40);
    let end = (idx + needle_len + 60).min(bytes.len());

    let mut s = start;
    while s > 0 && !content.is_char_boundary(s) {
        s -= 1;
    }
    let mut e = end;
    while e < bytes.len() && !content.is_char_boundary(e) {
        e += 1;
    }
    let slice = &content[s..e];
    let clean: String = slice
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let trimmed = clean.trim().to_string();
    if s > 0 {
        format!("…{}…", trimmed)
    } else {
        format!("{}…", trimmed)
    }
}

fn mask_token(t: &str) -> String {
    if t.len() <= 8 {
        return "***".into();
    }
    format!("{}…{}", &t[..4], &t[t.len() - 4..])
}

async fn ping_daemon(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/ping", port);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<&str>) = ("open", vec![url]);

    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", url]);

    #[cfg(all(unix, not(target_os = "macos")))]
    let (cmd, args): (&str, Vec<&str>) = ("xdg-open", vec![url]);

    let status = std::process::Command::new(cmd)
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;
    if !status.success() {
        return Err(format!("{} exited with {}", cmd, status));
    }
    Ok(())
}
