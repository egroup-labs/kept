use std::fs;
use std::path::PathBuf;

use crate::models::CliConfig;

/// Top-level CLI state directory: `~/.kept-cli/`.
///
/// Kept intentionally separate from the desktop app's `~/.kept/` so the two
/// can coexist without stomping on each other's auth tokens or config. The
/// vault destination is configurable and defaults to `~/.kept-cli/vault/`.
const APP_DIR_NAME: &str = ".kept-cli";

/// Default port — must match the value baked into `extension/config.js`.
pub const DEFAULT_PORT: u16 = 18241;

/// Platforms the extension can sync. Used to pre-create directories so the
/// extension's image-asset paths resolve immediately on first run.
pub const PLATFORMS: &[&str] = &["chatgpt", "claude", "gemini", "grok", "kimi"];

pub fn app_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .ok_or_else(|| "could not determine home directory".to_string())
        .map(|h| h.join(APP_DIR_NAME))
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("config.toml"))
}

pub fn token_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("token"))
}

pub fn default_vault_dir() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("vault"))
}

/// Resolve the active vault directory: config override if set, else default.
pub fn vault_dir() -> Result<PathBuf, String> {
    let cfg = read_config()?;
    if let Some(p) = cfg.vault_path.as_deref() {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    default_vault_dir()
}

/// Per-platform asset directory inside `root`.
pub fn assets_dir_in(root: &std::path::Path, platform: &str) -> PathBuf {
    root.join(platform).join("assets")
}

/// Create the state directory, generate a token if missing, write a default
/// config. Idempotent — safe to call on every start.
pub fn init_dirs() -> Result<(), String> {
    let base = app_dir()?;
    fs::create_dir_all(&base).map_err(|e| format!("create {:?}: {}", base, e))?;

    // Default vault tree (only when the config doesn't override the location).
    let cfg = read_config().unwrap_or_default();
    let vault_root = match cfg.vault_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_vault_dir()?,
    };
    fs::create_dir_all(&vault_root).map_err(|e| format!("create {:?}: {}", vault_root, e))?;
    for p in PLATFORMS {
        let plat = vault_root.join(p);
        fs::create_dir_all(&plat).map_err(|e| format!("create {:?}: {}", plat, e))?;
        let assets = plat.join("assets");
        fs::create_dir_all(&assets).map_err(|e| format!("create {:?}: {}", assets, e))?;
    }

    // Token: generate once.
    let tp = token_path()?;
    if !tp.exists() {
        let token = uuid::Uuid::new_v4().to_string();
        fs::write(&tp, &token).map_err(|e| format!("write token: {}", e))?;
        log::info!("generated auth token at {:?}", tp);
    }

    // Config: write defaults if missing.
    let cp = config_path()?;
    if !cp.exists() {
        let toml_str = toml::to_string_pretty(&CliConfig::default())
            .map_err(|e| format!("serialize config: {}", e))?;
        fs::write(&cp, toml_str).map_err(|e| format!("write config: {}", e))?;
        log::info!("created default config at {:?}", cp);
    }

    Ok(())
}

pub fn read_token() -> Result<String, String> {
    fs::read_to_string(token_path()?)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("read token: {}", e))
}

pub fn read_config() -> Result<CliConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(CliConfig::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("read config: {}", e))?;
    toml::from_str(&content).map_err(|e| format!("parse config: {}", e))
}

pub fn write_config(cfg: &CliConfig) -> Result<(), String> {
    let toml_str = toml::to_string_pretty(cfg).map_err(|e| format!("serialize config: {}", e))?;
    fs::write(config_path()?, toml_str).map_err(|e| format!("write config: {}", e))
}

pub fn port() -> u16 {
    read_config()
        .ok()
        .and_then(|c| c.port)
        .unwrap_or(DEFAULT_PORT)
}
