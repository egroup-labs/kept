use crate::config;
use crate::db::Database;
use crate::kg_gen::kggen::KgDatabase;
use crate::models::{
    AppConfig, AvailableModel, ConversationMeta, DigestData, ExtensionStatus, GraphData,
    IngestPayload, KgStats, SearchResult, VaultNode, VaultStats,
};
use crate::state;
use crate::vault;
use calamine::Reader;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::{Manager, State};

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

pub fn http_client() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

pub struct DbState(pub Mutex<Option<Arc<Database>>>);
pub struct KgState(pub Mutex<Option<Arc<KgDatabase>>>);
pub struct GraphCacheState(pub Mutex<HashMap<usize, GraphData>>);
pub struct TokenState(pub Arc<Mutex<String>>);
pub struct CodeConsentState(pub Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>);
pub struct AgentCancelState(pub Mutex<HashMap<String, tokio_util::sync::CancellationToken>>);

fn with_db<F, T>(state: &State<DbState>, f: F) -> Result<T, String>
where
    F: FnOnce(&Database) -> Result<T, String>,
{
    let guard = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let db = guard.as_ref().ok_or("Database not initialized")?;
    f(db.as_ref())
}

fn with_kg<F, T>(state: &State<KgState>, f: F) -> Result<T, String>
where
    F: FnOnce(&KgDatabase) -> Result<T, String>,
{
    let guard = state
        .0
        .lock()
        .map_err(|e| format!("KG lock error: {}", e))?;
    let kg = guard.as_ref().ok_or("KG database not initialized")?;
    f(kg)
}

fn effective_graph_limit(limit: Option<usize>) -> usize {
    match limit {
        Some(n) if n > 0 => n,
        _ => 200,
    }
}

fn model_display_name(model: &serde_json::Value) -> Option<String> {
    for key in ["display_name", "name", "label", "title"] {
        if let Some(value) = model[key].as_str() {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn model_owned_by(model: &serde_json::Value) -> Option<String> {
    model["owned_by"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn is_free_model_id(id: &str) -> bool {
    id.trim().to_ascii_lowercase().ends_with(":free")
}

fn string_field(model: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = model[*key].as_str() {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn openrouter_frontend_model_id(model: &serde_json::Value) -> Option<String> {
    model["endpoint"]["model_variant_slug"]
        .as_str()
        .or_else(|| model["model_variant_slug"].as_str())
        .or_else(|| model["canonical_slug"].as_str())
        .or_else(|| model["slug"].as_str())
        .or_else(|| model["id"].as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

fn openrouter_frontend_text_model(model: &serde_json::Value) -> bool {
    if model["has_text_output"].as_bool().unwrap_or(false) {
        return true;
    }

    for path in [
        &model["output_modalities"],
        &model["architecture"]["output_modalities"],
        &model["endpoint"]["output_modalities"],
    ] {
        if let Some(modalities) = path.as_array() {
            return modalities
                .iter()
                .any(|value| value.as_str() == Some("text"));
        }
    }

    true
}

fn openrouter_frontend_model(model: &serde_json::Value) -> Option<AvailableModel> {
    let id = openrouter_frontend_model_id(model)?;
    if is_free_model_id(&id) {
        return None;
    }

    let owned_by = string_field(
        model,
        &["author_display_name", "author", "provider_name", "owner"],
    )
    .or_else(|| {
        model["author"]["slug"]
            .as_str()
            .or_else(|| model["author"]["name"].as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });

    Some(AvailableModel {
        id,
        provider: "openrouter".to_string(),
        display_name: string_field(model, &["short_name", "name", "display_name", "label"]),
        owned_by,
    })
}

fn sort_available_models(models: &mut [AvailableModel]) {
    models.sort_by(|a, b| {
        let a_name = a
            .display_name
            .as_deref()
            .unwrap_or(&a.id)
            .to_ascii_lowercase();
        let b_name = b
            .display_name
            .as_deref()
            .unwrap_or(&b.id)
            .to_ascii_lowercase();
        a_name.cmp(&b_name).then_with(|| a.id.cmp(&b.id))
    });
}

fn invalidate_graph_cache(state: &State<GraphCacheState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|e| format!("Graph cache lock error: {}", e))?;
    guard.clear();
    Ok(())
}

/// Get the vault directory tree grouped by platform.
#[tauri::command]
pub fn cmd_vault_tree() -> Result<Vec<VaultNode>, String> {
    vault::vault_tree()
}

/// Read a conversation markdown file and return its content.
/// Validates the path is within the vault directory to prevent path traversal.
/// Handles legacy paths (e.g. ~/.scout/vault/) by remapping to the current vault.
#[tauri::command]
pub fn cmd_get_conversation(file_path: String) -> Result<String, String> {
    let vault = config::vault_dir()?;

    // Try the path as-is first; if it doesn't exist, remap legacy vault prefixes
    let resolved = if std::path::Path::new(&file_path).exists() {
        file_path.clone()
    } else if let Some(idx) = file_path.find("/vault/") {
        let rel = &file_path[idx + 7..]; // portion after "/vault/"
        let remapped = vault.join(rel);
        if remapped.exists() {
            remapped.to_string_lossy().to_string()
        } else {
            return Err("File not found".to_string());
        }
    } else {
        return Err("File not found".to_string());
    };

    let requested = std::path::Path::new(&resolved)
        .canonicalize()
        .map_err(|_| "File not found".to_string())?;
    let vault_canonical = vault.canonicalize().unwrap_or(vault);
    if !requested.starts_with(&vault_canonical) {
        return Err("Access denied: path outside vault".to_string());
    }
    vault::read_conversation(&resolved)
}

/// List conversations from the database, optionally filtered by platform.
#[tauri::command]
pub fn cmd_list_conversations(
    db: State<DbState>,
    platform: Option<String>,
) -> Result<Vec<ConversationMeta>, String> {
    with_db(&db, |d| d.list_conversations(platform.as_deref()))
}

/// Full-text search across all conversations.
#[tauri::command]
pub fn cmd_search(
    db: State<DbState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, String> {
    let limit = limit.unwrap_or(50);
    with_db(&db, |d| d.search(&query, limit))
}

/// Reindex all vault files into the database. Clears the index first
/// and rebuilds from the markdown files on disk.
pub fn reindex_vault(d: &Database) -> Result<String, String> {
    d.clear_all()?;

    let tree = vault::vault_tree()?;
    let mut count = 0;

    for platform_node in &tree {
        for file_node in &platform_node.children {
            if let Some(ref file_path) = file_node.path {
                let content = vault::read_conversation(file_path)?;
                let hash = vault::content_hash(&content);

                let meta = parse_frontmatter(&content);
                let title = meta
                    .title
                    .filter(|t| !t.is_empty())
                    .or_else(|| extract_body_title(&content))
                    .unwrap_or_else(|| file_node.name.clone());
                let payload = IngestPayload {
                    conversation_id: meta.id.unwrap_or_else(|| file_node.name.clone()),
                    platform: meta.platform.unwrap_or_else(|| platform_node.name.clone()),
                    title,
                    model: meta.model,
                    messages: parse_messages(&content),
                    created_at: meta.created_at.clone(),
                    updated_at: meta.updated_at.or(meta.created_at),
                    markdown: Some(content),
                    images: None,
                };

                d.upsert_conversation(&payload, file_path, &hash)?;
                count += 1;
            }
        }
    }

    Ok(format!("Reindexed {} conversations", count))
}

/// Reindex all vault files into the database.
#[tauri::command]
pub fn cmd_reindex(db: State<DbState>) -> Result<String, String> {
    with_db(&db, reindex_vault)
}

/// Read the auth token.
#[tauri::command]
pub fn cmd_get_token() -> Result<String, String> {
    config::read_token()
}

/// Get extension connection status (based on recent pings).
#[tauri::command]
pub fn cmd_extension_status() -> Result<ExtensionStatus, String> {
    const CONNECTED_WINDOW_MS: u64 = 900_000;
    let last_seen = state::get_extension_last_ping_ms();
    let connected =
        last_seen > 0 && state::now_ms().saturating_sub(last_seen) <= CONNECTED_WINDOW_MS;
    let last_seen_ms = if last_seen > 0 { Some(last_seen) } else { None };
    Ok(ExtensionStatus {
        connected,
        last_seen_ms,
    })
}

/// Request the extension to sync — opens the connect page with sync=1 to
/// trigger an immediate sync via the content script, and also sets the
/// sync_requested flag as a fallback for the next extension ping.
/// `providers` is a comma-separated list (e.g. "chatgpt,claude") or empty for all.
/// `limit` is max conversations per provider (0 = unlimited).
#[tauri::command]
pub fn cmd_request_extension_sync(providers: String, limit: u32) -> Result<(), String> {
    state::set_sync_requested(true);
    state::begin_sync(limit);
    let mut url = "http://localhost:18241/connect?close=1&sync=1".to_string();
    if !providers.is_empty() {
        url.push_str(&format!("&providers={}", providers));
    }
    if limit > 0 {
        url.push_str(&format!("&limit={}", limit));
    }
    // Open silently in browser — the connect page auto-closes
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    Ok(())
}

/// Request the extension to stop an in-progress sync.
#[tauri::command]
pub fn cmd_stop_extension_sync() -> Result<(), String> {
    state::stop_sync();
    let url = "http://localhost:18241/connect?close=1&stop=1";
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    Ok(())
}

/// Rotate the auth token and open a new connection page in the browser.
#[tauri::command]
pub fn cmd_refresh_token(token_state: State<TokenState>) -> Result<String, String> {
    let token = uuid::Uuid::new_v4().to_string();
    config::write_token(&token)?;
    let mut guard = token_state
        .0
        .lock()
        .map_err(|_| "Token lock error".to_string())?;
    *guard = token;
    state::set_extension_ping_ms(0);
    let url = "http://localhost:18241/connect?close=1";
    // Try to open in a small new browser window (Chrome/Chromium), fall back to default
    let opened_in_new_window = {
        #[cfg(target_os = "linux")]
        {
            // Read the default browser .desktop file to find the actual executable
            std::process::Command::new("xdg-settings")
                .args(["get", "default-web-browser"])
                .output()
                .ok()
                .and_then(|out| {
                    let desktop = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    // Resolve the .desktop file to its Exec= command
                    let exec = std::process::Command::new("sh")
                        .args(["-c", &format!(
                            "grep -hm1 '^Exec=' /usr/share/applications/{0} ~/.local/share/applications/{0} 2>/dev/null | head -1 | sed 's/^Exec=//' | sed 's/ %.*//'",
                            desktop
                        )])
                        .output()
                        .ok()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                        .filter(|s| !s.is_empty());
                    exec
                })
                .and_then(|exe| {
                    // Only Chromium-based browsers support --new-window reliably
                    // Check by looking for common chromium flags support
                    let is_chromium = exe.contains("chrom") || exe.contains("brave") || exe.contains("edge") || exe.contains("vivaldi") || exe.contains("opera");
                    if is_chromium {
                        std::process::Command::new(&exe)
                            .args(["--new-window", "--window-size=520,480", "--window-position=200,200", url])
                            .spawn()
                            .ok()
                            .map(|_| true)
                    } else {
                        None
                    }
                })
                .unwrap_or(false)
        }
        #[cfg(target_os = "macos")]
        {
            // Detect default browser via LaunchServices
            let app_name = std::process::Command::new("sh")
                .args(["-c", "plutil -convert json -o - \"$(python3 -c \"import LaunchServices; print(LaunchServices.LSCopyDefaultHandlerForURLScheme('http'))\" 2>/dev/null || defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null | grep -A1 'https' | grep -o '\".*\"' | tr -d '\"' | head -1)\" 2>/dev/null | grep -o '\"CFBundleName\"[^,]*' | cut -d'\"' -f4"])
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty());

            // Try known Chromium-based browser names, falling back to default opener
            let chromium_apps = app_name
                .filter(|name| {
                    let n = name.to_lowercase();
                    n.contains("chrome")
                        || n.contains("chromium")
                        || n.contains("brave")
                        || n.contains("edge")
                        || n.contains("vivaldi")
                        || n.contains("opera")
                        || n.contains("arc")
                })
                .or_else(|| {
                    // Fallback: try common app names in order
                    for name in &[
                        "Google Chrome",
                        "Chromium",
                        "Microsoft Edge",
                        "Brave Browser",
                        "Arc",
                    ] {
                        if std::process::Command::new("open")
                            .args(["-Ra", name])
                            .output()
                            .map(|o| o.status.success())
                            .unwrap_or(false)
                        {
                            return Some(name.to_string());
                        }
                    }
                    None
                });

            if let Some(name) = chromium_apps {
                std::process::Command::new("open")
                    .args([
                        "-na",
                        &name,
                        "--args",
                        "--new-window",
                        "--window-size=520,480",
                        "--window-position=200,200",
                        url,
                    ])
                    .spawn()
                    .map(|_| true)
                    .unwrap_or(false)
            } else {
                false
            }
        }
        #[cfg(target_os = "windows")]
        {
            // Detect default browser from registry (ProgId → shell\open\command)
            let browser_cmd = std::process::Command::new("reg")
                .args(["query", r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice", "/v", "ProgId"])
                .output()
                .ok()
                .and_then(|out| {
                    let text = String::from_utf8_lossy(&out.stdout).to_string();
                    let prog_id = text.lines()
                        .find(|l| l.contains("ProgId"))
                        .and_then(|l| l.split_whitespace().last())
                        .map(|s| s.to_string());
                    prog_id
                })
                .and_then(|prog_id| {
                    let key = format!(r"{}\shell\open\command", prog_id);
                    std::process::Command::new("reg")
                        .args(["query", &format!(r"HKCR\{}", key), "/ve"])
                        .output()
                        .ok()
                        .and_then(|out| {
                            let text = String::from_utf8_lossy(&out.stdout).to_string();
                            text.lines()
                                .find(|l| l.contains("REG_SZ"))
                                .and_then(|l| {
                                    // Extract executable path from value like "C:\...\msedge.exe" --single-argument %1
                                    let val = l.splitn(3, "REG_SZ").nth(1)?.trim().to_string();
                                    let exe = if val.starts_with('"') {
                                        val.split('"').nth(1).map(|s| s.to_string())
                                    } else {
                                        val.split_whitespace().next().map(|s| s.to_string())
                                    };
                                    exe.filter(|e| !e.is_empty())
                                })
                        })
                });

            if let Some(exe) = browser_cmd {
                let exe_lower = exe.to_lowercase();
                let is_chromium = exe_lower.contains("chrome")
                    || exe_lower.contains("chromium")
                    || exe_lower.contains("msedge")
                    || exe_lower.contains("brave")
                    || exe_lower.contains("vivaldi")
                    || exe_lower.contains("opera");
                if is_chromium {
                    std::process::Command::new(&exe)
                        .args([
                            "--new-window",
                            "--window-size=520,480",
                            "--window-position=200,200",
                            url,
                        ])
                        .spawn()
                        .map(|_| true)
                        .unwrap_or(false)
                } else {
                    std::process::Command::new(&exe)
                        .arg(url)
                        .spawn()
                        .map(|_| true)
                        .unwrap_or(false)
                }
            } else {
                false
            }
        }
    };
    if !opened_in_new_window {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    }
    Ok("Opened connection page".to_string())
}

/// Read the app config.
#[tauri::command]
pub fn cmd_get_config() -> Result<AppConfig, String> {
    config::read_config()
}

/// Update the app config.
#[tauri::command]
pub fn cmd_set_config(config: AppConfig) -> Result<(), String> {
    config::write_config(&config)
}

/// Validate a path for Obsidian export.
/// Returns whether the path exists and whether it contains a `.obsidian/` directory.
#[tauri::command]
pub fn cmd_export_validate(path: String) -> crate::export::ValidationResult {
    crate::export::validate_vault_path(&path)
}

/// Copy all Kept vault .md files into the given Obsidian vault folder.
/// Writes to `{path}/Kept/{relative_path}`, preserving the vault's directory structure.
/// Overwrites existing files. Errors if `{path}/.obsidian/` is missing.
#[tauri::command]
pub async fn cmd_export_to_obsidian(path: String) -> Result<crate::export::ExportResult, String> {
    tokio::task::spawn_blocking(move || crate::export::export_vault(&path))
        .await
        .map_err(|e| format!("Export task join failed: {e}"))?
}

/// Get the vault directory path.
#[tauri::command]
pub fn cmd_vault_path() -> Result<String, String> {
    Ok(config::vault_dir()?.to_string_lossy().to_string())
}

/// Read text from the system clipboard.
#[tauri::command]
pub fn cmd_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

/// Add file/directory paths to the knowledge base.
#[tauri::command]
pub fn cmd_kb_add_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut cfg = config::read_config()?;
    let mut kb = cfg.kb_paths.unwrap_or_default();
    let mut added = Vec::new();
    for p in paths {
        let path = std::path::Path::new(&p);
        if !path.exists() {
            continue;
        }
        let canonical = path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        if !kb.contains(&canonical) {
            kb.push(canonical.clone());
            added.push(canonical);
        }
    }
    cfg.kb_paths = Some(kb);
    config::write_config(&cfg)?;
    Ok(added)
}

/// Remove a path from the knowledge base.
#[tauri::command]
pub fn cmd_kb_remove_path(path: String) -> Result<(), String> {
    let mut cfg = config::read_config()?;
    let mut kb = cfg.kb_paths.unwrap_or_default();
    kb.retain(|p| p != &path);
    cfg.kb_paths = Some(kb);
    config::write_config(&cfg)?;
    Ok(())
}

/// List all files accessible through knowledge base paths.
#[tauri::command]
pub fn cmd_kb_list_files() -> Result<Vec<crate::models::KbFileEntry>, String> {
    let cfg = config::read_config()?;
    let kb = cfg.kb_paths.unwrap_or_default();
    let mut entries = Vec::new();
    for p in &kb {
        let path = std::path::Path::new(p);
        if !path.exists() {
            continue;
        }
        let meta = path.metadata().map_err(|e| e.to_string())?;
        if meta.is_file() {
            entries.push(crate::models::KbFileEntry {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: p.clone(),
                size: meta.len(),
                is_dir: false,
            });
        } else if meta.is_dir() {
            // List files in directory (non-recursive, first level)
            if let Ok(iter) = std::fs::read_dir(path) {
                for entry in iter.flatten() {
                    if let Ok(m) = entry.metadata() {
                        entries.push(crate::models::KbFileEntry {
                            name: entry.file_name().to_string_lossy().to_string(),
                            path: entry.path().to_string_lossy().to_string(),
                            size: m.len(),
                            is_dir: m.is_dir(),
                        });
                    }
                }
            }
        }
    }
    Ok(entries)
}

/// Extract text from a file based on its extension.
fn extract_file_text(path: &std::path::Path) -> Result<String, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        // PDF
        "pdf" => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            pdf_extract::extract_text_from_mem(&bytes)
                .map_err(|e| format!("PDF extraction error: {e}"))
        }
        // DOCX (ZIP of XML)
        "docx" => {
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let mut archive =
                zip::ZipArchive::new(file).map_err(|e| format!("Not a valid DOCX: {e}"))?;
            let mut text = String::new();
            if let Ok(mut doc) = archive.by_name("word/document.xml") {
                let mut xml = String::new();
                std::io::Read::read_to_string(&mut doc, &mut xml).map_err(|e| e.to_string())?;
                // Extract text between <w:t> tags
                for segment in xml.split("<w:t") {
                    if let Some(start) = segment.find('>') {
                        if let Some(end) = segment[start..].find("</w:t>") {
                            text.push_str(&segment[start + 1..start + end]);
                        }
                    }
                    // Paragraph breaks
                    if segment.contains("</w:p>") {
                        text.push('\n');
                    }
                }
            }
            if text.is_empty() {
                Err("Could not extract text from DOCX".to_string())
            } else {
                Ok(text)
            }
        }
        // HTML
        "html" | "htm" => {
            let html = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(html2text::from_read(html.as_bytes(), 120))
        }
        // Excel spreadsheets
        "xlsx" | "xls" | "ods" => {
            let mut workbook: calamine::Sheets<_> = calamine::open_workbook_auto(path)
                .map_err(|e| format!("Spreadsheet error: {e}"))?;
            let mut text = String::new();
            for name in workbook.sheet_names().to_vec() {
                if let Ok(range) = workbook.worksheet_range(&name) {
                    text.push_str(&format!("## {name}\n"));
                    for row in range.rows() {
                        let cells: Vec<String> = row
                            .iter()
                            .map(|c| match c {
                                calamine::Data::Empty => String::new(),
                                calamine::Data::String(s) => s.clone(),
                                calamine::Data::Float(f) => f.to_string(),
                                calamine::Data::Int(i) => i.to_string(),
                                calamine::Data::Bool(b) => b.to_string(),
                                calamine::Data::DateTime(d) => d.to_string(),
                                calamine::Data::DateTimeIso(s) => s.clone(),
                                calamine::Data::DurationIso(s) => s.clone(),
                                calamine::Data::Error(e) => format!("#{e:?}"),
                            })
                            .collect();
                        text.push_str(&cells.join("\t"));
                        text.push('\n');
                    }
                    text.push('\n');
                }
            }
            Ok(text)
        }
        // Plain text and code — read as-is
        _ => std::fs::read_to_string(path).map_err(|e| format!("Cannot read file as text: {e}")),
    }
}

/// Read a file from a knowledge base path. Validates the path is within an allowed kb_path.
/// Supports PDF, DOCX, HTML, XLSX, and all text/code formats.
#[tauri::command]
pub fn cmd_kb_read_file(path: String) -> Result<String, String> {
    let cfg = config::read_config()?;
    let kb = cfg.kb_paths.unwrap_or_default();
    let target = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {e}"))?;
    let allowed = kb.iter().any(|p| {
        std::path::Path::new(p)
            .canonicalize()
            .map(|cp| target.starts_with(&cp) || target == cp)
            .unwrap_or(false)
    });
    if !allowed {
        return Err("File is not within any knowledge base path".to_string());
    }
    if !target.is_file() {
        return Err("Path is not a file".to_string());
    }
    let content = extract_file_text(&target)?;
    // Cap at 512KB
    if content.len() > 512 * 1024 {
        let truncated: String = content.chars().take(512 * 1024).collect();
        Ok(format!("{truncated}\n\n[Truncated: file exceeds 512KB]"))
    } else {
        Ok(content)
    }
}

/// Search for text across knowledge base files. Returns matching lines with context.
#[tauri::command]
pub fn cmd_kb_search(query: String, max_results: Option<usize>) -> Result<String, String> {
    let cfg = config::read_config()?;
    let kb = cfg.kb_paths.unwrap_or_default();
    let limit = max_results.unwrap_or(50);
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    fn search_path(
        path: &std::path::Path,
        query_lower: &str,
        results: &mut Vec<String>,
        limit: usize,
    ) {
        if results.len() >= limit {
            return;
        }
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(path) {
                for (i, line) in content.lines().enumerate() {
                    if results.len() >= limit {
                        return;
                    }
                    if line.to_lowercase().contains(query_lower) {
                        results.push(format!("{}:{}: {}", path.display(), i + 1, line));
                    }
                }
            }
        } else if path.is_dir() {
            if let Ok(iter) = std::fs::read_dir(path) {
                for entry in iter.flatten() {
                    search_path(&entry.path(), query_lower, results, limit);
                }
            }
        }
    }

    for p in &kb {
        search_path(std::path::Path::new(p), &query_lower, &mut results, limit);
    }
    Ok(results.join("\n"))
}

/// Grep knowledge base files with a regex pattern.
#[tauri::command]
pub fn cmd_kb_grep(pattern: String, file_path: Option<String>) -> Result<String, String> {
    let re = regex::Regex::new(&pattern).map_err(|e| format!("Invalid regex: {e}"))?;
    let cfg = config::read_config()?;
    let kb = cfg.kb_paths.unwrap_or_default();
    let mut results = Vec::new();
    let limit = 100;

    fn grep_path(
        path: &std::path::Path,
        re: &regex::Regex,
        results: &mut Vec<String>,
        limit: usize,
    ) {
        if results.len() >= limit {
            return;
        }
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(path) {
                for (i, line) in content.lines().enumerate() {
                    if results.len() >= limit {
                        return;
                    }
                    if re.is_match(line) {
                        results.push(format!("{}:{}: {}", path.display(), i + 1, line));
                    }
                }
            }
        } else if path.is_dir() {
            if let Ok(iter) = std::fs::read_dir(path) {
                for entry in iter.flatten() {
                    grep_path(&entry.path(), re, results, limit);
                }
            }
        }
    }

    if let Some(fp) = &file_path {
        // Validate it's within kb paths
        let target = std::path::Path::new(fp)
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?;
        let allowed = kb.iter().any(|p| {
            std::path::Path::new(p)
                .canonicalize()
                .map(|cp| target.starts_with(&cp) || target == cp)
                .unwrap_or(false)
        });
        if !allowed {
            return Err("File is not within any knowledge base path".to_string());
        }
        grep_path(&target, &re, &mut results, limit);
    } else {
        for p in &kb {
            grep_path(std::path::Path::new(p), &re, &mut results, limit);
        }
    }
    Ok(results.join("\n"))
}

/// Read a file and return its contents as base64.
#[tauri::command]
pub fn cmd_read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bytes,
    ))
}

/// Zip the bundled extension folder and return the path to the zip file.
#[tauri::command]
pub fn cmd_extension_zip(app_handle: tauri::AppHandle) -> Result<String, String> {
    use std::io::Write;
    use walkdir::WalkDir;

    // In dev, the extension folder is at ../../extension relative to src-tauri
    // In production, it's a bundled resource
    let ext_dir = app_handle
        .path()
        .resource_dir()
        .map(|r| r.join("extension"))
        .ok()
        .filter(|p| p.exists())
        .or_else(|| {
            // Dev fallback: look relative to the manifest dir
            let dev_path =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extension");
            dev_path.canonicalize().ok()
        })
        .ok_or("Could not find extension folder")?;

    let zip_path = config::app_dir()?.join("kept-extension.zip");
    let file =
        std::fs::File::create(&zip_path).map_err(|e| format!("Failed to create zip: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in WalkDir::new(&ext_dir) {
        let entry = entry.map_err(|e| format!("Walk error: {}", e))?;
        let path = entry.path();
        let name = path
            .strip_prefix(&ext_dir)
            .map_err(|e| format!("Strip prefix error: {}", e))?;

        // Zip spec requires forward slashes; Windows paths use backslashes
        let zip_name = name.to_string_lossy().replace('\\', "/");

        if path.is_file() {
            zip.start_file(&zip_name, options)
                .map_err(|e| format!("Zip start_file error: {}", e))?;
            let data = std::fs::read(path).map_err(|e| format!("Read error: {}", e))?;
            zip.write_all(&data)
                .map_err(|e| format!("Zip write error: {}", e))?;
        } else if path.is_dir() && !zip_name.is_empty() {
            zip.add_directory(&zip_name, options)
                .map_err(|e| format!("Zip add_directory error: {}", e))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("Zip finish error: {}", e))?;
    Ok(zip_path.to_string_lossy().to_string())
}

/// Open the vault directory in the system file explorer.
#[tauri::command]
pub fn cmd_open_vault() -> Result<(), String> {
    let vault = config::vault_dir()?;
    tauri_plugin_opener::open_path(vault.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("Failed to open vault: {}", e))
}

fn walk(
    dir: &std::path::Path,
    conv_bytes: &mut u64,
    asset_bytes: &mut u64,
    conv_count: &mut u64,
    asset_count: &mut u64,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, conv_bytes, asset_bytes, conv_count, asset_count);
        } else if let Ok(meta) = path.metadata() {
            let size = meta.len();
            let in_assets = path.components().any(|c| c.as_os_str() == "assets");
            if in_assets {
                *asset_bytes += size;
                *asset_count += 1;
            } else {
                *conv_bytes += size;
                *conv_count += 1;
            }
        }
    }
}

fn walk_size(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += walk_size(&path);
        } else if let Ok(meta) = path.metadata() {
            total += meta.len();
        }
    }
    total
}

/// Get vault storage statistics (sizes of conversations, assets, databases).
#[tauri::command]
pub fn cmd_vault_stats() -> Result<VaultStats, String> {
    use std::fs;

    let vault = config::vault_dir()?;
    let app = config::app_dir()?;

    let mut conversations_bytes: u64 = 0;
    let mut assets_bytes: u64 = 0;
    let mut conversation_count: u64 = 0;
    let mut asset_count: u64 = 0;

    // Walk the vault directory
    if vault.exists() {
        walk(
            &vault,
            &mut conversations_bytes,
            &mut assets_bytes,
            &mut conversation_count,
            &mut asset_count,
        );
    }

    // SQLite database size
    let db_path = app.join("index.db");
    let database_bytes = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

    // KG database size (directory, walk all files)
    let kg_path = app.join("kg.db");
    let mut kg_bytes: u64 = 0;
    if kg_path.exists() {
        if kg_path.is_dir() {
            kg_bytes = walk_size(&kg_path);
        } else {
            kg_bytes = fs::metadata(&kg_path).map(|m| m.len()).unwrap_or(0);
        }
    }

    Ok(VaultStats {
        conversations_bytes,
        assets_bytes,
        database_bytes,
        kg_bytes,
        conversation_count,
        asset_count,
    })
}

/// Migrate files from ~/Downloads/Kept/ into ~/.kept/vault/
#[tauri::command]
pub fn cmd_migrate_downloads(db: State<DbState>) -> Result<String, String> {
    let downloads_dir = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join("Downloads")
        .join("Kept");

    if !downloads_dir.exists() {
        return Ok("No ~/Downloads/Kept/ directory found".to_string());
    }

    let vault = config::vault_dir()?;
    let mut count = 0;

    for platform in &["chatgpt", "claude"] {
        let src_dir = downloads_dir.join(platform);
        if !src_dir.is_dir() {
            continue;
        }

        let dst_dir = vault.join(platform);
        std::fs::create_dir_all(&dst_dir)
            .map_err(|e| format!("Failed to create {:?}: {}", dst_dir, e))?;

        for entry in walkdir::WalkDir::new(&src_dir).min_depth(1).max_depth(1) {
            let entry = entry.map_err(|e| format!("Walk error: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                let filename = path.file_name().unwrap();
                let dst = dst_dir.join(filename);

                if !dst.exists() {
                    std::fs::copy(path, &dst)
                        .map_err(|e| format!("Failed to copy {:?}: {}", path, e))?;
                    count += 1;
                }
            }
        }
    }

    // Reindex after migration
    if count > 0 {
        with_db(&db, |d| {
            d.clear_all()?;

            let tree = crate::vault::vault_tree()?;
            for platform_node in &tree {
                for file_node in &platform_node.children {
                    if let Some(ref file_path) = file_node.path {
                        let content = crate::vault::read_conversation(file_path)?;
                        let hash = crate::vault::content_hash(&content);
                        let meta = parse_frontmatter(&content);
                        let title = meta
                            .title
                            .filter(|t| !t.is_empty())
                            .or_else(|| extract_body_title(&content))
                            .unwrap_or_else(|| file_node.name.clone());
                        let payload = IngestPayload {
                            conversation_id: meta.id.unwrap_or_else(|| file_node.name.clone()),
                            platform: meta.platform.unwrap_or_else(|| platform_node.name.clone()),
                            title,
                            model: meta.model,
                            messages: parse_messages(&content),
                            created_at: meta.created_at,
                            updated_at: None,
                            markdown: Some(content),
                            images: None,
                        };
                        d.upsert_conversation(&payload, file_path, &hash)?;
                    }
                }
            }
            Ok(())
        })?;
    }

    Ok(format!("Migrated {} files from ~/Downloads/Kept/", count))
}

// ── Knowledge Graph commands ──────────────────────────────────────────────────

/// Wipe the KG database directory and reinitialize with a clean schema.
#[tauri::command]
pub fn cmd_kg_reset_db(
    kg: State<KgState>,
    graph_cache: State<GraphCacheState>,
) -> Result<String, String> {
    let mut guard = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
    // Drop the existing connection so the database files are released.
    *guard = None;
    let db_path = config::kg_db_path()?;
    if let Err(e) = std::fs::remove_dir_all(&db_path) {
        eprintln!("Warning: failed to remove KG directory: {}", e);
    }
    match KgDatabase::init(&db_path.to_string_lossy()) {
        Ok(new_kg) => {
            *guard = Some(Arc::new(new_kg));
            invalidate_graph_cache(&graph_cache)?;
            Ok("KG database reset successfully.".to_string())
        }
        Err(e) => {
            // Try once more after a clean wipe
            let _ = std::fs::remove_dir_all(&db_path);
            let new_kg = KgDatabase::init(&db_path.to_string_lossy()).map_err(|e2| {
                format!(
                    "Failed to reinit KG database: {} (first attempt: {})",
                    e2, e
                )
            })?;
            *guard = Some(Arc::new(new_kg));
            invalidate_graph_cache(&graph_cache)?;
            Ok("KG database reset successfully.".to_string())
        }
    }
}

/// Clear all conversations from the vault (files + database).
#[tauri::command]
pub fn cmd_clear_vault(db: State<DbState>) -> Result<String, String> {
    // Clear the database index
    with_db(&db, |d| d.clear_all())?;

    // Delete all .md files from vault platform directories
    let vault = config::vault_dir()?;
    let mut deleted = 0u32;
    if vault.exists() {
        for entry in std::fs::read_dir(&vault).map_err(|e| format!("Read vault dir: {}", e))? {
            let entry = entry.map_err(|e| format!("Read entry: {}", e))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Only touch known platform subdirectories, not assets or other dirs
            for file in std::fs::read_dir(&path).map_err(|e| format!("Read platform dir: {}", e))? {
                let file = file.map_err(|e| format!("Read file: {}", e))?;
                let fp = file.path();
                if fp.is_file() && fp.extension().is_some_and(|ext| ext == "md") {
                    let _ = std::fs::remove_file(&fp);
                    deleted += 1;
                }
            }
        }
    }

    Ok(format!("Cleared {} conversations", deleted))
}

/// Return a text summary of the KG stats.
#[tauri::command]
pub fn cmd_kg_summary(kg: State<KgState>) -> Result<String, String> {
    with_kg(&kg, |k| {
        let stats = k.get_stats()?;
        Ok(format!(
            "Entities: {}\nRelationships: {}\nConversations indexed: {}\n\nTop entities:\n{}",
            stats.entity_count,
            stats.triple_count,
            stats.conversation_count,
            stats
                .top_entities
                .iter()
                .map(|(name, freq)| format!("  • {} ({})", name, freq))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    })
}

/// Return structured KG statistics.
#[tauri::command]
pub fn cmd_kg_stats(kg: State<KgState>) -> Result<KgStats, String> {
    with_kg(&kg, |k| k.get_stats())
}

/// Return the graph of providers and conversations from SQLite.
#[tauri::command]
pub async fn cmd_kg_get_graph(
    kg: State<'_, KgState>,
    graph_cache: State<'_, GraphCacheState>,
    limit: Option<usize>,
) -> Result<GraphData, String> {
    let lim = effective_graph_limit(limit);

    if let Some(cached) = graph_cache
        .0
        .lock()
        .map_err(|e| format!("Graph cache lock error: {}", e))?
        .get(&lim)
        .cloned()
    {
        return Ok(cached);
    }

    let graph = with_kg(&kg, |k| k.get_full_graph(lim))?;
    graph_cache
        .0
        .lock()
        .map_err(|e| format!("Graph cache lock error: {}", e))?
        .insert(lim, graph.clone());
    Ok(graph)
}

/// Search the KG and return a subgraph matching the query.
/// Uses text substring matching per keyword (no embedding required).
#[tauri::command]
pub async fn cmd_kg_search(
    kg: State<'_, KgState>,
    query: String,
    limit: Option<usize>,
) -> Result<GraphData, String> {
    let keywords: Vec<String> = query
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|kw| kw.to_lowercase())
        .filter(|kw| !kw.is_empty())
        .collect();

    with_kg(&kg, |k| {
        let lim = match limit {
            Some(n) if n > 0 => n,
            _ => 20,
        };
        k.search_subgraph(&keywords, &[], 0.70, lim)
    })
}

/// Return all nodes one hop away from `node_id` for Neo4j-style graph expansion.
#[tauri::command]
pub fn cmd_kg_get_neighbors(kg: State<KgState>, node_id: String) -> Result<GraphData, String> {
    with_kg(&kg, |k| k.get_node_neighbors(&node_id))
}

/// Delete a conversation (removes DB entries and vault file).
#[tauri::command]
pub fn cmd_delete_conversation(db: State<DbState>, file_path: String) -> Result<(), String> {
    let guard = db.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let database = guard.as_ref().ok_or("Database not initialized")?;
    database.delete_conversation_by_path(&file_path)
}

/// Rename a conversation's title.
#[tauri::command]
pub fn cmd_rename_conversation(
    db: State<DbState>,
    file_path: String,
    new_title: String,
) -> Result<(), String> {
    let guard = db.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let database = guard.as_ref().ok_or("Database not initialized")?;
    database.rename_conversation(&file_path, &new_title)
}

/// Create a new project with a name and description.
#[tauri::command]
pub fn cmd_kg_create_project(
    kg: State<KgState>,
    name: String,
    description: String,
) -> Result<serde_json::Value, String> {
    with_kg(&kg, |k| {
        let id = uuid::Uuid::new_v4().to_string();
        k.upsert_project(&id, &name, &description, &[])?;
        Ok(serde_json::json!({
            "id": id,
            "name": name,
            "description": description,
            "conversation_count": 0,
            "conversations": [],
        }))
    })
}

/// Link a conversation to a project.
#[tauri::command]
pub fn cmd_kg_link_conversation(
    kg: State<KgState>,
    project_id: String,
    conversation_id: String,
    phase: String,
) -> Result<(), String> {
    with_kg(&kg, |k| {
        k.link_project_conv(&project_id, &conversation_id, &phase, 0)
    })
}

/// Unlink a conversation from a project.
#[tauri::command]
pub fn cmd_kg_unlink_conversation(
    kg: State<KgState>,
    project_id: String,
    conversation_id: String,
) -> Result<(), String> {
    with_kg(&kg, |k| {
        k.unlink_project_conv(&project_id, &conversation_id)
    })
}

/// Update a project's name and description.
#[tauri::command]
pub fn cmd_kg_update_project(
    kg: State<KgState>,
    project_id: String,
    name: String,
    description: String,
) -> Result<(), String> {
    with_kg(&kg, |k| {
        k.upsert_project(&project_id, &name, &description, &[])
    })
}

/// Delete a project (keeps conversations).
#[tauri::command]
pub fn cmd_kg_delete_project(kg: State<KgState>, project_id: String) -> Result<(), String> {
    with_kg(&kg, |k| k.delete_project(&project_id))
}

/// Return all detected projects as a graph of project → conversation nodes.
#[tauri::command]
pub fn cmd_kg_get_projects(kg: State<KgState>) -> Result<Vec<serde_json::Value>, String> {
    with_kg(&kg, |k| {
        let projects = k.get_projects()?;
        let mut result = Vec::new();
        for (id, name, description, conv_count) in projects {
            let timeline = k.get_project_timeline(&id)?;
            let convs: Vec<serde_json::Value> = timeline.iter().map(|(cid, phase, order)| {
                serde_json::json!({ "conv_id": cid, "phase": phase, "order": order })
            }).collect();
            result.push(serde_json::json!({
                "id": id,
                "name": name,
                "description": description,
                "conversation_count": conv_count,
                "conversations": convs,
            }));
        }
        Ok(result)
    })
}

fn build_digest_prompt(
    projects_text: &str,
    recent_text: &str,
    stale_text: &str,
    today: &str,
) -> String {
    format!(
        r#"You are analyzing a user's AI conversation vault to produce a concise, actionable digest.

Today's date: {today}

{projects_text}

{recent_text}

{stale_text}

Generate a digest using **exactly** these markdown sections. Each section starts with `## `.

## What you've been working on
One short paragraph: what topics, how many conversations, which platforms. No bullet list here.

## Project progress
A bullet per project in this format:
- **Project Name** — current phase, brief activity summary
  > Suggested next step or action (use a blockquote)

Include conversation count parenthetically. Show phase progression (e.g. ideation → design → implementation) when multiple phases exist.

## Reminders
Stale or forgotten projects (no activity in 7+ days) with a gentle nudge.
Format each as:
- **Project Name** — last active N days ago, was in [phase]
  > Suggested way to pick it back up (use a blockquote)

If nothing is stale, write: "All projects have recent activity — nice work!"

## Highlights
Notable decisions, breakthroughs, or key topics from recent conversations. Use a short bullet list.
If nothing notable, omit this section entirely.

Formatting rules:
- Bold project names with **Name**
- Use `> blockquote` for all actionable suggestions
- Keep each section under 80 words — the layout shows sections side by side in columns
- Keep total output under 400 words
- Never invent information not present in the data above
- Be conversational but concise"#,
        today = today,
        projects_text = projects_text,
        recent_text = recent_text,
        stale_text = stale_text,
    )
}

async fn call_ollama_digest(model: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model, "stream": false,
        "messages": [{"role": "user", "content": prompt}]
    });
    let resp = http_client()
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            // Include the full cause chain — reqwest's Display often truncates the real reason
            let mut msg = format!("Ollama digest request failed: {}", e);
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                msg.push_str(&format!(" | caused by: {}", s));
                src = s.source();
            }
            msg
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama digest error {}: {}", status, text));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Ollama digest parse error: {}", e))?;
    Ok(json["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

async fn call_openai_digest(model: &str, api_key: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}]
    });
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI digest request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI digest error {}: {}", status, text));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("OpenAI digest parse error: {}", e))?;
    Ok(json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

async fn call_anthropic_digest(model: &str, api_key: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "messages": [{"role": "user", "content": prompt}]
    });
    // KEPT_ANTHROPIC_BASE_URL lets us point the digest path at a local mock
    // server for rate-limit / burn-rate testing (see scripts/mock-anthropic-429.py).
    // Production code path is unchanged when the variable is unset.
    let url = std::env::var("KEPT_ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com/v1/messages".to_string());
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic digest request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic digest error {}: {}", status, text));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Anthropic digest parse error: {}", e))?;
    Ok(json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

async fn call_openrouter_digest(
    model: &str,
    api_key: &str,
    prompt: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}]
    });
    let client = reqwest::Client::new();
    let resp = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("X-Title", "Kept")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenRouter digest request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OpenRouter digest error {}: {}", status, text));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("OpenRouter digest parse error: {}", e))?;
    Ok(json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

/// Generate an LLM-powered digest of project activity, staleness, and progress.
/// Returns cached digest if fresh, otherwise regenerates.
#[tauri::command]
pub async fn cmd_generate_digest(
    db: State<'_, DbState>,
    kg: State<'_, KgState>,
    force_refresh: Option<bool>,
    provider: Option<String>,
) -> Result<DigestData, String> {
    use chrono::{Duration, NaiveDate, Utc};

    let force = force_refresh.unwrap_or(false);
    let today = Utc::now().format("%Y-%m-%d").to_string();

    // 1. Compute conv_hash (conversation count + latest updated_at)
    let all_convs = with_db(&db, |d| d.list_conversations(None))?;
    let conv_hash = {
        let latest = all_convs
            .first()
            .and_then(|c| c.updated_at.as_deref())
            .unwrap_or("none");
        format!("{}:{}", all_convs.len(), latest)
    };

    // 2. Check cache
    if !force {
        let cached = with_kg(&kg, |k| k.get_digest())?;
        if let Some((content, generated_at, cached_hash)) = cached {
            if cached_hash == conv_hash {
                if let Ok(gen_date) = NaiveDate::parse_from_str(&generated_at[..10], "%Y-%m-%d") {
                    let today_date =
                        NaiveDate::parse_from_str(&today, "%Y-%m-%d").unwrap_or(gen_date);
                    if today_date.signed_duration_since(gen_date) < Duration::days(1) {
                        return Ok(DigestData {
                            content,
                            generated_at,
                            from_cache: true,
                        });
                    }
                }
            }
        }
    }

    // 3. Gather data from KG
    let (projects, all_summaries) = with_kg(&kg, |k| {
        let projects = k.get_projects()?;
        let summaries = k.get_all_summaries()?;
        Ok((projects, summaries))
    })?;

    if projects.is_empty() && all_summaries.is_empty() {
        return Ok(DigestData {
            content: "No projects or summaries found yet. Index your vault in the Knowledge tab to generate a digest.".to_string(),
            generated_at: today,
            from_cache: false,
        });
    }

    // 4. Get conversation dates from SQLite
    let mut all_conv_ids: Vec<String> = Vec::new();
    let mut project_timelines: Vec<(String, String, String, i64, Vec<(String, String, i64)>)> =
        Vec::new();
    for (pid, pname, pdesc, conv_count) in &projects {
        let timeline = with_kg(&kg, |k| k.get_project_timeline(pid))?;
        let conv_ids: Vec<String> = timeline.iter().map(|(cid, _, _)| cid.clone()).collect();
        all_conv_ids.extend(conv_ids);
        project_timelines.push((
            pid.clone(),
            pname.clone(),
            pdesc.clone(),
            *conv_count,
            timeline,
        ));
    }
    all_conv_ids.sort();
    all_conv_ids.dedup();

    let conv_dates: std::collections::HashMap<
        String,
        (Option<String>, Option<String>, String, String),
    > = with_db(&db, |d| {
        let convs = d.get_conversations_by_ids(&all_conv_ids)?;
        Ok(convs
            .into_iter()
            .map(|c| {
                (
                    c.conversation_id,
                    (c.created_at, c.updated_at, c.title, c.platform),
                )
            })
            .collect())
    })?;

    let summary_map: std::collections::HashMap<String, (String, String, String, String)> =
        all_summaries
            .iter()
            .map(|(cid, summary, _hint, phase, decisions, topics)| {
                (
                    cid.clone(),
                    (
                        summary.clone(),
                        phase.clone(),
                        decisions.clone(),
                        topics.clone(),
                    ),
                )
            })
            .collect();

    // 5. Build projects section text
    let mut projects_lines = Vec::new();
    projects_lines.push(format!("## Active Projects ({})", project_timelines.len()));
    for (_pid, pname, pdesc, conv_count, timeline) in &project_timelines {
        let mut first_date = String::from("unknown");
        let mut last_date = String::from("unknown");
        let mut phases = Vec::new();
        let mut all_decisions: Vec<String> = Vec::new();
        let mut all_topics: Vec<String> = Vec::new();
        let mut recent_summaries: Vec<String> = Vec::new();

        for (cid, phase, _order) in timeline {
            if let Some((created, updated, _title, _platform)) = conv_dates.get(cid) {
                let date = updated
                    .as_deref()
                    .or(created.as_deref())
                    .unwrap_or("unknown");
                if first_date == "unknown" || date < first_date.as_str() {
                    first_date = date.to_string();
                }
                if last_date == "unknown" || date > last_date.as_str() {
                    last_date = date.to_string();
                }
            }
            phases.push(phase.clone());
            if let Some((summary, _, decisions_json, topics_json)) = summary_map.get(cid) {
                if let Ok(decs) = serde_json::from_str::<Vec<String>>(decisions_json) {
                    all_decisions.extend(decs);
                }
                if let Ok(tops) = serde_json::from_str::<Vec<String>>(topics_json) {
                    all_topics.extend(tops);
                }
                if recent_summaries.len() < 3 && !summary.is_empty() {
                    recent_summaries.push(summary.clone());
                }
            }
        }

        let days_inactive = if last_date != "unknown" {
            NaiveDate::parse_from_str(&last_date[..10.min(last_date.len())], "%Y-%m-%d")
                .ok()
                .and_then(|ld| {
                    NaiveDate::parse_from_str(&today, "%Y-%m-%d")
                        .ok()
                        .map(|td| td.signed_duration_since(ld).num_days())
                })
                .unwrap_or(-1)
        } else {
            -1
        };

        phases.dedup();
        all_decisions.truncate(15);
        all_topics.sort();
        all_topics.dedup();
        all_topics.truncate(15);

        let summaries_text = if recent_summaries.is_empty() {
            String::new()
        } else {
            let items: Vec<String> = recent_summaries
                .iter()
                .map(|s| format!("    - {}", s))
                .collect();
            format!("\n  Recent summaries:\n{}", items.join("\n"))
        };

        projects_lines.push(format!(
            "- Project: {}\n  Description: {}\n  Started: {}\n  Last activity: {}\n  Days since last activity: {}\n  Phase progression: {}\n  Conversations: {}\n  Key decisions: {}\n  Key topics: {}{}",
            pname,
            pdesc,
            first_date,
            last_date,
            if days_inactive >= 0 {
                days_inactive.to_string()
            } else {
                "unknown".to_string()
            },
            phases.join(" → "),
            conv_count,
            if all_decisions.is_empty() {
                "none".to_string()
            } else {
                all_decisions.join(", ")
            },
            if all_topics.is_empty() {
                "none".to_string()
            } else {
                all_topics.join(", ")
            },
            summaries_text,
        ));
    }

    // 6. Build recent activity section (last 7 days)
    let seven_days_ago = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
        .map(|d| d - Duration::days(7))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default();

    let recent_convs: Vec<&ConversationMeta> = all_convs
        .iter()
        .filter(|c| {
            c.created_at
                .as_deref()
                .or(c.updated_at.as_deref())
                .map(|d| d >= seven_days_ago.as_str())
                .unwrap_or(false)
        })
        .take(30)
        .collect();

    let mut platforms_seen: std::collections::HashSet<&str> = Default::default();
    let mut recent_lines = Vec::new();
    recent_lines.push("## Recent Activity (last 7 days)".to_string());
    recent_lines.push(format!("- {} new conversations", recent_convs.len()));
    for c in &recent_convs {
        platforms_seen.insert(&c.platform);
        let date = c
            .created_at
            .as_deref()
            .or(c.updated_at.as_deref())
            .unwrap_or("?");
        let (phase, summary_line) = summary_map
            .get(&c.conversation_id)
            .map(|(s, p, _, _)| {
                let sum = if s.is_empty() {
                    String::new()
                } else {
                    format!("\n  Summary: {}", s)
                };
                (p.as_str().to_string(), sum)
            })
            .unwrap_or_else(|| ("unknown".to_string(), String::new()));
        recent_lines.push(format!(
            "- [{}] {} ({}) - Phase: {}{}",
            date, c.title, c.platform, phase, summary_line
        ));
    }
    recent_lines.insert(
        2,
        format!(
            "- Platforms: {}",
            platforms_seen.into_iter().collect::<Vec<_>>().join(", ")
        ),
    );

    // 7. Build stale projects section
    let mut stale_lines = Vec::new();
    stale_lines.push("## Stale Projects (no activity in 7+ days)".to_string());
    let mut has_stale = false;
    for (_pid, pname, pdesc, _conv_count, timeline) in &project_timelines {
        let mut last_date = String::new();
        let mut last_phase = String::new();
        for (cid, phase, _) in timeline {
            if let Some((created, updated, _, _)) = conv_dates.get(cid) {
                let date = updated.as_deref().or(created.as_deref()).unwrap_or("");
                if date > last_date.as_str() {
                    last_date = date.to_string();
                    last_phase = phase.clone();
                }
            }
        }
        if !last_date.is_empty() {
            if let Ok(ld) =
                NaiveDate::parse_from_str(&last_date[..10.min(last_date.len())], "%Y-%m-%d")
            {
                if let Ok(td) = NaiveDate::parse_from_str(&today, "%Y-%m-%d") {
                    let days = td.signed_duration_since(ld).num_days();
                    if days >= 7 {
                        has_stale = true;
                        stale_lines.push(format!(
                            "- {} (last active {} days ago, was in {} phase): {}",
                            pname, days, last_phase, pdesc
                        ));
                    }
                }
            }
        }
    }
    if !has_stale {
        stale_lines.push("None — all projects have recent activity.".to_string());
    }

    // 8. Build prompt and call LLM
    let prompt = build_digest_prompt(
        &projects_lines.join("\n"),
        &recent_lines.join("\n"),
        &stale_lines.join("\n"),
        &today,
    );

    let cfg = config::read_config().unwrap_or_default();
    let provider_str = provider.as_deref().unwrap_or("ollama");
    let content = match provider_str {
        "openai" => {
            let api_key = cfg
                .openai_api_key
                .as_deref()
                .ok_or("OpenAI API key not configured. Set it in Settings.")?;
            call_openai_digest("gpt-5-nano", api_key, &prompt).await?
        }
        "anthropic" => {
            let api_key = cfg
                .anthropic_api_key
                .as_deref()
                .ok_or("Anthropic API key not configured. Set it in Settings.")?;
            call_anthropic_digest("claude-sonnet-4-20250514", api_key, &prompt).await?
        }
        "openrouter" => {
            let api_key = cfg
                .openrouter_api_key
                .as_deref()
                .ok_or("OpenRouter API key not configured. Set it in Settings.")?;
            call_openrouter_digest("openai/gpt-5-nano", api_key, &prompt).await?
        }
        _ => {
            let model = cfg.ollama_model.as_deref().unwrap_or("gemma3:1b");
            call_ollama_digest(model, &prompt).await?
        }
    };

    // 9. Cache the result
    let generated_at = Utc::now().to_rfc3339();
    let _ = with_kg(&kg, |k| {
        k.upsert_digest(&content, &generated_at, &conv_hash)
    });

    Ok(DigestData {
        content,
        generated_at,
        from_cache: false,
    })
}

// ── Summary + Embedding generation (used by Digest) ────────────────────────

/// Generate an embedding vector for the given text. Returns empty Vec on failure.
/// Supports ollama (local) and OpenAI. Best-effort — failure is logged but not fatal.
async fn call_embedding(
    provider: &str,
    model: &str,
    text: &str,
    cfg: &AppConfig,
) -> Result<Vec<f64>, String> {
    match provider {
        "ollama" => {
            let body = serde_json::json!({ "model": model, "prompt": text });
            let resp = http_client()
                .post("http://127.0.0.1:11434/api/embeddings")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Ollama embedding failed: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("Ollama embedding error: {}", resp.status()));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Ollama embedding parse: {}", e))?;
            let vec: Vec<f64> = json["embedding"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
                .unwrap_or_default();
            Ok(vec)
        }
        "openai" => {
            let api_key = cfg
                .openai_api_key
                .as_deref()
                .ok_or("OpenAI API key missing")?;
            let body = serde_json::json!({ "model": model, "input": text });
            let resp = http_client()
                .post("https://api.openai.com/v1/embeddings")
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("OpenAI embedding failed: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("OpenAI embedding error: {}", resp.status()));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("OpenAI embedding parse: {}", e))?;
            let vec: Vec<f64> = json["data"][0]["embedding"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
                .unwrap_or_default();
            Ok(vec)
        }
        other => Err(format!("Unsupported embedding provider: {}", other)),
    }
}

/// Summary fields extracted from LLM for a conversation.
#[derive(Debug, Clone)]
struct ConvSummary {
    summary: String,
    project_hint: String,
    phase: String,
    key_topics: Vec<String>,
    key_decisions: Vec<String>,
    /// True iff the conversation still has open threads / unresolved questions.
    is_unresolved: bool,
    /// Short human-readable reason (if is_unresolved=true), else empty string.
    attention_reason: String,
}

/// Build the structured JSON prompt for conversation summarization.
fn build_summary_prompt(title: &str, markdown: &str) -> String {
    // Keep markdown reasonable size
    let truncated: String = markdown.chars().take(12_000).collect();
    format!(
        r#"You are analyzing an archived AI conversation. Output a single JSON object with these fields and NOTHING else (no prose, no markdown fences):

{{
  "summary": "One or two sentences describing what the conversation is about and what state it is in.",
  "project_hint": "A short name (2-5 words) guessing the broader project/topic this belongs to. Use title-case. If uncertain, return an empty string.",
  "phase": "One of: ideation, design, implementation, debugging, review, exploration",
  "key_topics": ["up to 5 short topic keywords"],
  "key_decisions": ["up to 3 concrete decisions made, if any"],
  "is_unresolved": true or false,
  "attention_reason": "MAX 3 WORDS. Short noun phrase, title-case, no punctuation. E.g. 'Open question', 'Stalled plan', 'Needs benchmarking'. Empty string if is_unresolved is false."
}}

Judging `is_unresolved`: set it to true ONLY if the user would benefit from revisiting this conversation. Typical signals: the user's last question wasn't fully answered; the assistant proposed a plan that was never confirmed or executed; the conversation ends mid-task (e.g., with TODOs, incomplete code, pending experiments); the user expressed confusion/frustration that wasn't resolved. Set it to false when the conversation reaches a natural conclusion (answer given and acknowledged, task completed, casual exchange, clearly abandoned by choice).

Conversation title: {}

Conversation content:
{}"#,
        title, truncated
    )
}

/// Parse the LLM JSON response. Tolerant of extra whitespace and markdown code fences.
fn parse_summary_json(raw: &str) -> Option<ConvSummary> {
    // Strip common markdown fences
    let trimmed = raw.trim();
    let cleaned = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim_end_matches("```")
        .trim();

    // Try to find JSON object bounds
    let start = cleaned.find('{')?;
    let end = cleaned.rfind('}')?;
    if end <= start {
        return None;
    }
    let json_str = &cleaned[start..=end];

    let v: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let summary = v["summary"].as_str().unwrap_or("").trim().to_string();
    let project_hint = v["project_hint"].as_str().unwrap_or("").trim().to_string();
    let phase = v["phase"]
        .as_str()
        .unwrap_or("exploration")
        .trim()
        .to_string();
    let key_topics: Vec<String> = v["key_topics"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let key_decisions: Vec<String> = v["key_decisions"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if summary.is_empty() {
        return None;
    }
    // Default is_unresolved to true when missing: pre-existing prompts that
    // don't emit the flag still produce a conservative (card-shown) result.
    let is_unresolved = v["is_unresolved"].as_bool().unwrap_or(true);
    // Hard-cap to 3 words regardless of what the LLM returns.
    let attention_reason = {
        let raw = v["attention_reason"].as_str().unwrap_or("").trim();
        let words: Vec<&str> = raw.split_whitespace().take(3).collect();
        words.join(" ")
    };
    Some(ConvSummary {
        summary,
        project_hint,
        phase,
        key_topics,
        key_decisions,
        is_unresolved,
        attention_reason,
    })
}

/// Call the configured chat model with a prompt, returning the raw text response.
async fn call_chat_model(
    provider: &str,
    model: &str,
    prompt: &str,
    cfg: &AppConfig,
) -> Result<String, String> {
    match provider {
        "openai" => {
            let api_key = cfg
                .openai_api_key
                .as_deref()
                .ok_or("OpenAI API key missing")?;
            call_openai_digest(model, api_key, prompt).await
        }
        "anthropic" => {
            let api_key = cfg
                .anthropic_api_key
                .as_deref()
                .ok_or("Anthropic API key missing")?;
            call_anthropic_digest(model, api_key, prompt).await
        }
        "openrouter" => {
            let api_key = cfg
                .openrouter_api_key
                .as_deref()
                .ok_or("OpenRouter API key missing")?;
            call_openrouter_digest(model, api_key, prompt).await
        }
        _ => call_ollama_digest(model, prompt).await,
    }
}

/// Resolve all entries for a model assignment key, in fallback order.
/// Returns an empty Vec if the key is missing.
fn resolve_models(cfg: &AppConfig, key: &str) -> Vec<(String, String)> {
    cfg.model_assignments
        .as_ref()
        .and_then(|m| m.get(key))
        .map(|v| {
            v.iter()
                .filter(|m| !is_free_model_id(&m.model))
                .map(|m| (m.provider.clone(), m.model.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Generate summary + embedding for a single conversation and store in kg_summary.
/// Walks the configured fallback chain: tries each provider/model in `model_assignments.chat`,
/// then `agentic`, until one succeeds. Same for embeddings.
async fn generate_and_store_summary(
    kg: &std::sync::Arc<crate::kg_gen::kggen::KgDatabase>,
    conv_id: &str,
    title: &str,
    markdown: &str,
    cfg: &AppConfig,
) -> Result<ConvSummary, String> {
    // 1. Build the fallback chain: chat entries first, then agentic entries
    let mut chat_chain = resolve_models(cfg, "chat");
    chat_chain.extend(resolve_models(cfg, "agentic"));
    if chat_chain.is_empty() {
        return Err("No chat/agentic models configured".to_string());
    }

    // 2. Try each provider/model in order until one succeeds
    let prompt = build_summary_prompt(title, markdown);
    let mut last_err = String::from("All chat models failed");
    let mut summary_opt: Option<ConvSummary> = None;
    for (provider, model) in &chat_chain {
        match call_chat_model(provider, model, &prompt, cfg).await {
            Ok(raw) => match parse_summary_json(&raw) {
                Some(s) => {
                    summary_opt = Some(s);
                    break;
                }
                None => {
                    last_err = format!(
                        "[{}/{}] could not parse JSON. Raw: {}",
                        provider,
                        model,
                        raw.chars().take(200).collect::<String>()
                    );
                    eprintln!("[digest] chat fallback: {}", last_err);
                }
            },
            Err(e) => {
                last_err = format!("[{}/{}] {}", provider, model, e);
                eprintln!("[digest] chat fallback: {}", last_err);
            }
        }
    }
    let summary = summary_opt.ok_or(last_err)?;

    // 3. Embedding fallback chain (best-effort — empty vec if all fail)
    let embedding_chain = resolve_models(cfg, "embeddings");
    let embed_text = format!("{}\n{}", summary.summary, summary.key_topics.join(", "));
    let mut embedding: Vec<f64> = Vec::new();
    for (provider, model) in &embedding_chain {
        match call_embedding(provider, model, &embed_text, cfg).await {
            Ok(v) if !v.is_empty() => {
                embedding = v;
                break;
            }
            Ok(_) => {
                eprintln!(
                    "[digest] embedding fallback: [{}/{}] returned empty",
                    provider, model
                );
            }
            Err(e) => {
                eprintln!(
                    "[digest] embedding fallback: [{}/{}] {}",
                    provider, model, e
                );
            }
        }
    }

    // 4. Persist to kg_summary
    kg.upsert_summary(
        conv_id,
        &summary.summary,
        &summary.project_hint,
        &summary.phase,
        &summary.key_decisions,
        &summary.key_topics,
        &embedding,
    )?;

    Ok(summary)
}

// ── Digest Items (LLM-based, batch-promoted) ────────────────────────────────

/// Fetch a clone of the KG database handle for use outside the mutex guard (KG is internally thread-safe).
fn clone_kg_handle(
    state: &State<KgState>,
) -> Result<Arc<crate::kg_gen::kggen::KgDatabase>, String> {
    let guard = state
        .0
        .lock()
        .map_err(|e| format!("KG lock error: {}", e))?;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "KG not initialized".to_string())
}

/// Enrich display-ready digest items with cached summaries + project + topics.
/// Pure read-side — never generates summaries (the idle summarizer does that).
async fn enrich_digest_items(
    _db: &State<'_, DbState>,
    kg: &State<'_, KgState>,
    mut items: Vec<crate::models::DigestItem>,
) -> Result<Vec<crate::models::DigestItem>, String> {
    if items.is_empty() {
        return Ok(items);
    }

    let kg_arc = clone_kg_handle(kg)?;

    let conv_ids: Vec<String> = items.iter().map(|i| i.conversation_id.clone()).collect();
    let project_map = kg_arc
        .get_projects_for_conversations(&conv_ids)
        .unwrap_or_default();
    let topic_map = kg_arc
        .get_topics_for_conversations(&conv_ids)
        .unwrap_or_default();

    for item in &mut items {
        // Project link
        if let Some((pid, pname)) = project_map.get(&item.conversation_id) {
            item.project_id = Some(pid.clone());
            item.project_name = Some(pname.clone());
        }
        // Vault-wide KG topics
        if let Some(topics) = topic_map.get(&item.conversation_id) {
            if !topics.is_empty() {
                item.topics = Some(topics.clone());
            }
        }
        // Cached per-conversation summary/hint/topics from kg_summary
        if let Ok(Some((summary, project_hint, _phase))) = kg_arc.get_summary(&item.conversation_id)
        {
            if item.summary.is_none() && !summary.is_empty() {
                item.summary = Some(summary);
            }
            if !project_hint.is_empty() {
                item.project_hint = Some(project_hint);
            }
            if let Ok(kts) = kg_arc.get_summary_topics(&item.conversation_id) {
                if !kts.is_empty() {
                    item.key_topics = Some(kts);
                }
            }
        }
    }
    Ok(items)
}

/// Return digest items currently visible to the user (active + expired-snoozed).
/// Does NOT trigger any LLM work — that's handled entirely by the background
/// idle summarizer and the gated batch promoter.
#[tauri::command]
pub async fn cmd_get_digest_items(
    db: State<'_, DbState>,
    kg: State<'_, KgState>,
    with_summaries: Option<bool>,
) -> Result<Vec<crate::models::DigestItem>, String> {
    let _ = with_summaries; // kept for API compat; LLM work is no longer on-demand here
    let items = with_db(&db, |d| d.list_active_digest_items())?;
    enrich_digest_items(&db, &kg, items).await
}

/// Update a digest item's status (dismiss or snooze).
#[tauri::command]
pub async fn cmd_update_digest_item(
    db: State<'_, DbState>,
    conversation_id: String,
    action: String,
    snooze_days: Option<i64>,
) -> Result<(), String> {
    let (status, snoozed_until) = match action.as_str() {
        "dismiss" => ("dismissed".to_string(), None),
        "snooze" => {
            let days = snooze_days.unwrap_or(3);
            let until = chrono::Utc::now() + chrono::Duration::days(days);
            ("snoozed".to_string(), Some(until.to_rfc3339()))
        }
        other => return Err(format!("Unknown action: {}", other)),
    };
    with_db(&db, |d| {
        d.update_digest_item_status(&conversation_id, &status, snoozed_until.as_deref())
    })
}

/// Bulk-update multiple digest items with the same action (e.g. "snooze all in project").
/// Returns the number of items updated.
#[tauri::command]
pub async fn cmd_bulk_update_digest_items(
    db: State<'_, DbState>,
    conversation_ids: Vec<String>,
    action: String,
    snooze_days: Option<i64>,
) -> Result<usize, String> {
    let (status, snoozed_until): (String, Option<String>) = match action.as_str() {
        "dismiss" => ("dismissed".to_string(), None),
        "snooze" => {
            let days = snooze_days.unwrap_or(3);
            let until = chrono::Utc::now() + chrono::Duration::days(days);
            ("snoozed".to_string(), Some(until.to_rfc3339()))
        }
        other => return Err(format!("Unknown action: {}", other)),
    };

    let mut count = 0;
    for cid in &conversation_ids {
        let res = with_db(&db, |d| {
            d.update_digest_item_status(cid, &status, snoozed_until.as_deref())
        });
        if res.is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

/// Force-run a batch promotion (bypasses the interval gate) and return fresh items.
/// This is what the Refresh button calls.
#[tauri::command]
pub async fn cmd_refresh_digest(
    db: State<'_, DbState>,
    kg: State<'_, KgState>,
    with_summaries: Option<bool>,
) -> Result<Vec<crate::models::DigestItem>, String> {
    let _ = with_summaries;
    let db_arc = {
        let guard = db.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "DB not initialized".to_string())?
    };
    // Promote pending+unresolved → active (no interval gate — Refresh is explicit)
    let promoted = db_arc.promote_pending_digest_items().unwrap_or(0);
    // Stamp last_run so the gate restarts from "now"
    let cfg = config::read_config().unwrap_or_default();
    let mut cfg_w = cfg.clone();
    cfg_w.last_digest_auto_run = Some(chrono::Utc::now().to_rfc3339());
    let _ = config::write_config(&cfg_w);
    eprintln!(
        "[digest] Refresh: promoted {} pending items → active",
        promoted
    );

    let items = with_db(&db, |d| d.list_active_digest_items())?;
    enrich_digest_items(&db, &kg, items).await
}

/// Per-tick outcome counts. Surfaced to the spawn loop so it can drive a
/// circuit breaker that pauses the summarizer when the user's API is rate
/// limited — without this signal, the loop would keep grinding once a minute
/// and bill the user's key for every conversation that does squeak past the
/// limit. Field totals satisfy: ok + rate_limited + other_failed + skipped = attempted.
#[derive(Debug, Default, Clone, Copy)]
pub struct IdleSummarizerTickStats {
    pub ok: usize,
    pub rate_limited: usize,
    pub other_failed: usize,
    pub skipped: usize,
}

/// Classify an LLM error string into a coarse kind we can use for retry-window
/// sizing and for the circuit breaker. Matching is string-based because the
/// per-provider `call_*_digest` helpers all collapse the response into a single
/// `Result<String, String>` of the form "<Provider> ... error <status>: <body>".
/// HTTP 429 is the rate-limit signal across all three providers.
fn classify_digest_error(err: &str) -> &'static str {
    let lower = err.to_ascii_lowercase();
    if lower.contains(" 429")
        || lower.contains("rate_limit")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
    {
        "rate_limit"
    } else if lower.contains("context length")
        || lower.contains("context_length")
        || lower.contains("too many tokens")
        || lower.contains("maximum context")
        || lower.contains(" 413")
    {
        "context_length"
    } else if lower.contains(" 401") || lower.contains(" 403") || lower.contains("unauthorized") {
        "auth"
    } else if lower.contains("timed out") || lower.contains("timeout") || lower.contains(" 5") {
        "transient"
    } else {
        "other"
    }
}

/// Pick a (base, max) retry window for a failed summary attempt. The actual
/// per-attempt window is `min(base × 2^(failure_count − 1), max)` — see
/// `db::exponential_backoff_minutes`.
///
/// Reasoning per kind:
/// - **rate_limit**: tier limits usually clear in a minute, but if a vault
///   chronically overflows the user's TPM the retries should back off fast.
///   Base 30min, cap 6h.
/// - **transient**: network/5xx hiccups. Start short (15min), cap at 3h.
/// - **context_length**: deterministic; the conversation is bigger than what
///   we'll send. Cheap to retry rarely, no value in retrying often. Base 1d,
///   cap 7d.
/// - **auth**: only fixes by user changing the key. Hold flat at 1d.
/// - **other**: unknown. Base 1h, cap 24h.
fn retry_window_for_error(kind: &str) -> (i64, i64) {
    match kind {
        "rate_limit" => (30, 6 * 60),
        "transient" => (15, 3 * 60),
        "context_length" => (24 * 60, 7 * 24 * 60),
        "auth" => (24 * 60, 24 * 60),
        _ => (60, 24 * 60),
    }
}

/// Default window (in days) after which the idle summarizer auto-halts if no
/// successful summary has been produced. Configurable via
/// `AppConfig.idle_summarizer_auto_halt_days`; set to 0 to disable.
const AUTO_HALT_DEFAULT_DAYS: i64 = 3;

/// Pure date-math helper: was the bad-state started at `started_rfc3339` more
/// than `halt_days` ago, relative to `now`? Returns false on parse failure
/// (safe default — never auto-halt on garbled data). Extracted so it can be
/// unit-tested without a DB or wall-clock dependency.
fn should_auto_halt(started_rfc3339: &str, now: chrono::DateTime<chrono::Utc>, halt_days: i64) -> bool {
    if halt_days <= 0 {
        return false;
    }
    match chrono::DateTime::parse_from_rfc3339(started_rfc3339) {
        Ok(started) => {
            let elapsed = now.signed_duration_since(started.with_timezone(&chrono::Utc));
            elapsed >= chrono::Duration::days(halt_days)
        }
        Err(_) => false,
    }
}

/// Background idle summarizer — finds conversations that have been inactive
/// for `idle_minutes` (default 5) and have no digest_items row yet, then runs
/// the LLM summary pipeline and stores the judgment with status='pending'.
///
/// Per-tick caps + an inter-call delay keep the burst under typical hosted-LLM
/// input-TPM limits (Anthropic tier 1 is 30K input tokens/minute). With a 12K
/// char markdown truncation in `build_summary_prompt` (~3K tokens/call) the
/// numbers below give roughly 4 calls every ~25s ≈ ~12K input tokens/min —
/// well clear of the tier-1 cap and leaves room for other API users on the key.
///
/// Three nested guardrails govern execution:
///   1. `digest_auto_summarize == Some(false)` — user opt-out, never run.
///   2. `idle_summarizer_halted == Some(true)` — auto-halted (or manually
///      halted), require `cmd_resume_idle_summarizer` to resume.
///   3. If we've been in a purely-failing state for >= halt_days, FLIP the
///      halted flag in config and return — the next tick (and all subsequent)
///      will short-circuit on (2) until the user resumes.
pub async fn run_idle_summarizer(
    db: Arc<Database>,
    kg: Arc<crate::kg_gen::kggen::KgDatabase>,
) -> Result<IdleSummarizerTickStats, String> {
    let cfg = config::read_config().unwrap_or_default();
    if cfg.digest_auto_summarize == Some(false) {
        return Ok(IdleSummarizerTickStats::default());
    }
    if cfg.idle_summarizer_halted == Some(true) {
        return Ok(IdleSummarizerTickStats::default());
    }

    // Auto-halt gate: if we've been failing for too long, persist the halt
    // flag and return. We DO this check before pulling candidates so we
    // short-circuit before any LLM calls.
    let halt_days = cfg
        .idle_summarizer_auto_halt_days
        .unwrap_or(AUTO_HALT_DEFAULT_DAYS);
    if halt_days > 0 {
        if let Ok((_, Some(bad_start))) = db.idle_summarizer_health() {
            if should_auto_halt(&bad_start, chrono::Utc::now(), halt_days) {
                let mut cfg_w = cfg.clone();
                cfg_w.idle_summarizer_halted = Some(true);
                cfg_w.idle_summarizer_halted_at = Some(chrono::Utc::now().to_rfc3339());
                if let Err(e) = config::write_config(&cfg_w) {
                    log::error!(
                        "Failed to persist idle summarizer halt flag: {}. Continuing in-memory only.",
                        e
                    );
                }
                log::warn!(
                    "Idle summarizer auto-halted: no successful summary in {} days \
                     (bad state began {}). Manual resume required via \
                     cmd_resume_idle_summarizer.",
                    halt_days,
                    bad_start
                );
                return Ok(IdleSummarizerTickStats::default());
            }
        }
    }

    const IDLE_MINUTES: i64 = 5;
    const PER_TICK_CAP: i64 = 4;
    const PER_CALL_DELAY: std::time::Duration = std::time::Duration::from_secs(6);

    let candidates = db.get_idle_unsummarized_conversations(IDLE_MINUTES, PER_TICK_CAP)?;
    if candidates.is_empty() {
        return Ok(IdleSummarizerTickStats::default());
    }

    let mut stats = IdleSummarizerTickStats::default();
    for (idx, (conv_id, title, file_path)) in candidates.iter().enumerate() {
        // Inter-call throttle. Between calls only — the first call fires
        // immediately. This caps the burst rate at ~10 calls/min even before
        // PER_TICK_CAP would.
        if idx > 0 {
            tokio::time::sleep(PER_CALL_DELAY).await;
        }
        // Skip if kg_summary already exists (belt-and-suspenders)
        if let Ok(Some(_)) = kg.get_summary(conv_id) {
            // Still insert a digest_items judgment row so it can be promoted later.
            // We don't have is_unresolved in kg_summary (lives in digest_items), so
            // just mark the row so it isn't re-picked next tick.
            let _ = db.upsert_digest_judgment(conv_id, None, None, None);
            stats.skipped += 1;
            continue;
        }
        let markdown = match vault::read_conversation(file_path) {
            Ok(md) => md,
            Err(e) => {
                eprintln!("[digest] idle vault read failed for {}: {}", conv_id, e);
                // I/O failure is not an LLM failure — record it so we don't
                // re-read a missing file every minute, but tag it distinctly.
                let (base, max) = retry_window_for_error("other");
                let _ = db.record_digest_attempt_failed(conv_id, "vault_io", base, max);
                stats.other_failed += 1;
                continue;
            }
        };
        match generate_and_store_summary(&kg, conv_id, title, &markdown, &cfg).await {
            Ok(summary) => {
                stats.ok += 1;
                let ar = if summary.attention_reason.is_empty() {
                    None
                } else {
                    Some(summary.attention_reason.as_str())
                };
                let _ = db.upsert_digest_judgment(
                    conv_id,
                    Some(summary.summary.as_str()),
                    Some(summary.is_unresolved),
                    ar,
                );
                eprintln!(
                    "[digest] idle summary OK: {} — \"{}\" (unresolved={})",
                    conv_id, title, summary.is_unresolved
                );
            }
            Err(e) => {
                let kind = classify_digest_error(&e);
                let (base, max) = retry_window_for_error(kind);
                match db.record_digest_attempt_failed(conv_id, kind, base, max) {
                    Ok((applied, count)) => {
                        eprintln!(
                            "[digest] idle summary FAILED for {} (kind={}, failure #{}, retry_in={}min): {}",
                            conv_id, kind, count, applied, e
                        );
                    }
                    Err(db_err) => {
                        eprintln!(
                            "[digest] idle summary FAILED for {} (kind={}): {} (also failed to record: {})",
                            conv_id, kind, e, db_err
                        );
                    }
                }
                if kind == "rate_limit" {
                    stats.rate_limited += 1;
                } else {
                    stats.other_failed += 1;
                }
            }
        }
    }
    Ok(stats)
}

/// Scheduled batch promoter — flips 'pending' + is_unresolved=true rows to
/// 'active' so they become visible in the Digest. Respects the configurable
/// `digest_auto_run_interval_minutes` gate. Updates `last_digest_auto_run`.
pub async fn run_digest_batch_promotion(
    db: Arc<Database>,
    _kg: Arc<crate::kg_gen::kggen::KgDatabase>,
) -> Result<(bool, usize), String> {
    let cfg = config::read_config().unwrap_or_default();
    if !should_run_auto_digest(&cfg) {
        return Ok((false, 0));
    }
    let promoted = db.promote_pending_digest_items().unwrap_or(0);

    let mut cfg_w = cfg.clone();
    cfg_w.last_digest_auto_run = Some(chrono::Utc::now().to_rfc3339());
    if let Err(e) = config::write_config(&cfg_w) {
        log::warn!("Failed to persist last_digest_auto_run: {}", e);
    }
    eprintln!(
        "[digest] batch promoted {} pending items → active",
        promoted
    );
    Ok((true, promoted))
}

/// True iff the auto-digest pass should run now.
/// Gate: opt-out ⇒ never; otherwise ≥ `digest_auto_run_interval_minutes` since last run.
/// Default interval is 10080 minutes (7 days). Override in config.toml for testing.
pub fn should_run_auto_digest(cfg: &AppConfig) -> bool {
    if cfg.digest_auto_summarize == Some(false) {
        return false;
    }
    let interval_minutes = cfg.digest_auto_run_interval_minutes.unwrap_or(10080);
    match cfg.last_digest_auto_run.as_deref() {
        None => true, // never run
        Some(ts) => match chrono::DateTime::parse_from_rfc3339(ts) {
            Ok(last) => {
                let elapsed = chrono::Utc::now()
                    .signed_duration_since(last.with_timezone(&chrono::Utc))
                    .num_minutes();
                elapsed >= interval_minutes
            }
            Err(_) => true, // bad timestamp — treat as never run
        },
    }
}

/// Normalize a project_hint for clustering: lowercase, strip articles/whitespace.
fn normalize_hint(s: &str) -> String {
    let lower = s.to_lowercase();
    let cleaned: String = lower
        .replace("the ", " ")
        .replace("a ", " ")
        .replace("an ", " ")
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Compute suggested projects from active digest items:
/// groups unassigned items by normalized project_hint; suggests clusters of 2+ items.
#[tauri::command]
pub async fn cmd_get_suggested_projects(
    db: State<'_, DbState>,
    kg: State<'_, KgState>,
) -> Result<Vec<crate::models::SuggestedProject>, String> {
    // Load enriched items (no fresh LLM calls — just pull cached summaries)
    let raw = with_db(&db, |d| d.list_active_digest_items())?;
    let items = enrich_digest_items(&db, &kg, raw).await?;

    // Group unassigned items by normalized project_hint
    let mut groups: std::collections::HashMap<String, (String, Vec<crate::models::DigestItem>)> =
        Default::default();
    for item in items.into_iter() {
        // Skip already-assigned conversations
        if item.project_id.is_some() {
            continue;
        }
        // Need a non-empty hint to cluster
        let hint = match item.project_hint.as_deref() {
            Some(h) if !h.trim().is_empty() => h.trim().to_string(),
            _ => continue,
        };
        let key = normalize_hint(&hint);
        if key.is_empty() {
            continue;
        }
        groups
            .entry(key)
            .or_insert_with(|| (hint.clone(), Vec::new()))
            .1
            .push(item);
    }

    // Build suggestions for groups with 2+ members
    let mut suggestions: Vec<crate::models::SuggestedProject> = groups
        .into_iter()
        .filter(|(_, (_, g))| g.len() >= 2)
        .map(|(_, (name, group))| {
            let conversation_ids: Vec<String> =
                group.iter().map(|i| i.conversation_id.clone()).collect();
            let conversation_titles: Vec<String> = group.iter().map(|i| i.title.clone()).collect();
            // Description: merge a few summaries
            let description_bits: Vec<String> = group
                .iter()
                .filter_map(|i| i.summary.clone())
                .take(2)
                .collect();
            let suggested_description = if description_bits.is_empty() {
                format!("{} related conversations", group.len())
            } else {
                description_bits.join(" ")
            };
            crate::models::SuggestedProject {
                suggested_name: name,
                suggested_description,
                conversation_ids,
                conversation_titles,
            }
        })
        .collect();

    // Sort: larger clusters first
    suggestions.sort_by_key(|s| std::cmp::Reverse(s.conversation_ids.len()));
    Ok(suggestions)
}

/// Create a new project from a set of digest conversations.
/// Creates the project and links all provided conversations.
#[tauri::command]
pub async fn cmd_create_project_from_digest(
    kg: State<'_, KgState>,
    name: String,
    description: String,
    conversation_ids: Vec<String>,
) -> Result<String, String> {
    let project_id = uuid::Uuid::new_v4().to_string();
    let kg_arc = clone_kg_handle(&kg)?;
    kg_arc.upsert_project(&project_id, &name, &description, &[])?;
    for cid in &conversation_ids {
        kg_arc.link_project_conv(&project_id, cid, "exploration", 0)?;
    }
    Ok(project_id)
}

/// Link a single conversation from the digest to an existing project.
#[tauri::command]
pub async fn cmd_link_conversation_to_project(
    kg: State<'_, KgState>,
    project_id: String,
    conversation_id: String,
) -> Result<(), String> {
    let kg_arc = clone_kg_handle(&kg)?;
    kg_arc.link_project_conv(&project_id, &conversation_id, "exploration", 0)
}

/// Create a new project and immediately link a single conversation to it.
/// Returns the new project_id.
#[tauri::command]
pub async fn cmd_create_project_with_conversation(
    kg: State<'_, KgState>,
    name: String,
    description: String,
    conversation_id: String,
) -> Result<String, String> {
    let project_id = uuid::Uuid::new_v4().to_string();
    let kg_arc = clone_kg_handle(&kg)?;
    kg_arc.upsert_project(&project_id, &name, &description, &[])?;
    kg_arc.link_project_conv(&project_id, &conversation_id, "exploration", 0)?;
    Ok(project_id)
}

/// Trigger an auto-summarization pass if the gate allows it (test_mode=always,
/// otherwise 7-day threshold). Called by the Digest view when it opens.
/// Returns (ran, candidates_detected, summaries_generated). `ran=false` when the
/// gate rejected the call (respecting production cadence).
#[tauri::command]
pub async fn cmd_trigger_digest_auto_pass(
    db: State<'_, DbState>,
    kg: State<'_, KgState>,
) -> Result<(bool, usize, usize), String> {
    let db_arc = {
        let guard = db.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "DB not initialized".to_string())?
    };
    let kg_arc = clone_kg_handle(&kg)?;
    let (ran, promoted) = run_digest_batch_promotion(db_arc, kg_arc).await?;
    // Legacy tuple shape is (ran, candidates, summaries). Under the new flow,
    // "promoted" best maps to the middle slot; the third is always 0.
    Ok((ran, promoted, 0))
}

/// Stamp seen_at=now for the listed conversation_ids (only those with NULL seen_at).
/// Used by the UI to mark which digest items have been seen by the user.
#[tauri::command]
pub async fn cmd_mark_digest_items_seen(
    db: State<'_, DbState>,
    conversation_ids: Vec<String>,
) -> Result<usize, String> {
    with_db(&db, |d| d.mark_digest_items_seen(&conversation_ids))
}

/// Index all vault conversations into the KG via topic-based classification.
/// Pipeline: read vault → TF-IDF keywords → discover topics → classify conversations → store.
#[tauri::command]
pub async fn cmd_kg_index_vault(
    app: tauri::AppHandle,
    kg: State<'_, KgState>,
    graph_cache: State<'_, GraphCacheState>,
    provider: Option<String>,
    model: Option<String>,
    force_reindex: Option<bool>,
) -> Result<String, String> {
    use tauri::Emitter;

    // Helper to emit progress events
    let emit_progress = |current: u32, total: u32, title: &str| {
        let _ = app.emit(
            "kg_index_progress",
            serde_json::json!({ "current": current, "total": total, "title": title }),
        );
    };

    invalidate_graph_cache(&graph_cache)?;

    if force_reindex.unwrap_or(false) {
        let guard = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
        let k = guard.as_ref().ok_or("KG database not initialized")?;
        k.clear_all()?;
    }

    // 1. Read vault conversations
    emit_progress(0, 3, "Reading vault conversations");
    let docs = read_vault_docs()?;
    if docs.is_empty() {
        return Err("Vault is empty — nothing to index.".to_string());
    }
    let n_docs = docs.len();

    // 2. Extract TF-IDF keywords (fast, local-only — no LLM calls)
    emit_progress(
        1,
        3,
        &format!("Extracting keywords from {} conversations", n_docs),
    );
    let doc_refs: Vec<(&str, &str, &str, &str)> = docs
        .iter()
        .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
        .collect();
    let conversations = crate::kg_gen::keyword_extract::extract_keywords_from_corpus(&doc_refs);

    // 3. Store keywords as entities and link to conversations via mentions
    emit_progress(2, 5, "Building knowledge graph from keywords");
    let (total_entities, total_mentions, has_topics) = {
        let guard = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
        let k = guard.as_ref().ok_or("KG database not initialized")?;

        let mut total_entities = 0usize;
        let mut total_mentions = 0usize;
        let keywords_per_conv = 8;

        for conv in &conversations {
            for kw in conv.keywords.iter().take(keywords_per_conv) {
                let normalized = crate::kg_gen::triplets::normalize_entity_name(&kw.term);
                let entity_id = crate::kg_gen::triplets::entity_id_from_name(&normalized);
                if entity_id.is_empty() {
                    continue;
                }

                k.upsert_entity(&entity_id, &normalized, &[], "keyword")?;
                total_entities += 1;

                k.upsert_mention(
                    &entity_id,
                    &conv.conv_id,
                    &conv.title,
                    &conv.conv_id,
                    &conv.platform,
                )?;
                total_mentions += 1;
            }
        }

        let has_topics = k.has_cached_topics();
        (total_entities, total_mentions, has_topics)
    }; // guard dropped here before any .await

    // Resolve the agentic provider/model from config or parameters
    let cfg = crate::config::read_config()?;
    let assignments_cfg = cfg.model_assignments.as_ref();
    let (topic_provider, topic_model) = match (provider, model) {
        (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => (p, m),
        _ => {
            let agentic = assignments_cfg
                .and_then(|m| m.get("agentic"))
                .and_then(|v| v.first());
            match agentic {
                Some(a) => (a.provider.clone(), a.model.clone()),
                None => (String::new(), String::new()),
            }
        }
    };
    let has_llm = !topic_provider.is_empty() && !topic_model.is_empty();

    // 4. Auto-discover topics if none exist, or classify new conversations into existing topics
    let mut topic_count = 0usize;
    let mut newly_classified = 0usize;
    if !has_topics {
        // No topics yet — discover from scratch
        if has_llm {
            emit_progress(3, 5, "Discovering topics via LLM");
            match crate::kg_gen::topic_discovery::discover_topics(
                &topic_provider,
                &topic_model,
                &conversations,
            )
            .await
            {
                Ok(topics) if !topics.is_empty() => {
                    emit_progress(
                        4,
                        5,
                        &format!("Classifying conversations into {} topics", topics.len()),
                    );
                    match crate::kg_gen::topic_discovery::classify_conversations(
                        &topic_provider,
                        &topic_model,
                        &topics,
                        &conversations,
                    )
                    .await
                    {
                        Ok(assignments) => {
                            let guard2 =
                                kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
                            let k2 = guard2.as_ref().ok_or("KG database not initialized")?;
                            k2.store_topics(&topics)?;
                            k2.store_topic_assignments(&assignments, &conversations)?;
                            topic_count = topics.len();
                        }
                        Err(e) => {
                            log::warn!("Topic classification failed (graph still built): {}", e);
                        }
                    }
                }
                Ok(_) => {
                    log::info!("Topic discovery returned no topics");
                }
                Err(e) => {
                    log::warn!("Topic discovery failed (graph still built): {}", e);
                }
            }
        } else {
            log::info!("Skipping topic discovery: no agentic model configured");
        }
    } else if has_llm {
        // Topics exist — classify any new unclassified conversations
        let already_classified = {
            let guard2 = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
            let k2 = guard2.as_ref().ok_or("KG database not initialized")?;
            k2.get_all_classified_paths()?
        };
        let new_convs: Vec<_> = conversations
            .iter()
            .filter(|c| !already_classified.contains(&c.conv_id))
            .cloned()
            .collect();

        if !new_convs.is_empty() {
            emit_progress(
                3,
                5,
                &format!("Classifying {} new conversations", new_convs.len()),
            );
            let topics = {
                let guard2 = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
                let k2 = guard2.as_ref().ok_or("KG database not initialized")?;
                k2.get_cached_topics()?
            };
            match crate::kg_gen::topic_discovery::classify_conversations(
                &topic_provider,
                &topic_model,
                &topics,
                &new_convs,
            )
            .await
            {
                Ok(assignments) => {
                    let guard2 = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
                    let k2 = guard2.as_ref().ok_or("KG database not initialized")?;
                    k2.store_topic_assignments(&assignments, &new_convs)?;
                    newly_classified = new_convs.len();
                }
                Err(e) => {
                    log::warn!("New conversation classification failed: {}", e);
                }
            }
        }
    }

    emit_progress(5, 5, "Done");
    invalidate_graph_cache(&graph_cache)?;

    let mut summary = format!(
        "Indexed {} conversations: {} entities, {} mentions.",
        n_docs, total_entities, total_mentions
    );
    if topic_count > 0 {
        summary.push_str(&format!(" Discovered {} topics.", topic_count));
    }
    if newly_classified > 0 {
        summary.push_str(&format!(
            " Classified {} new conversations.",
            newly_classified
        ));
    }
    Ok(summary)
}

/// Read all vault conversations as (path, title, platform, body) tuples.
fn read_vault_docs() -> Result<Vec<(String, String, String, String)>, String> {
    let tree = vault::vault_tree()?;
    let mut docs = Vec::new();

    for platform_node in &tree {
        for file_node in &platform_node.children {
            if let Some(ref path) = file_node.path {
                let content = match vault::read_conversation(path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let meta = parse_frontmatter(&content);
                let title = meta
                    .title
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| clean_vault_filename(path, &file_node.name));
                let body = if let Some(rest) = content.strip_prefix("---") {
                    if let Some(end) = rest.find("---") {
                        rest[end + 3..].trim_start().to_string()
                    } else {
                        content.clone()
                    }
                } else {
                    content.clone()
                };
                docs.push((path.clone(), title, platform_node.name.clone(), body));
            }
        }
    }

    Ok(docs)
}

/// Extract TF-IDF keywords from all vault conversations.
/// Returns structured keyword data for the agent pipeline.
#[tauri::command]
pub fn cmd_kg_extract_keywords(
) -> Result<Vec<crate::kg_gen::keyword_extract::ConversationKeywords>, String> {
    let docs = read_vault_docs()?;
    let doc_refs: Vec<(&str, &str, &str, &str)> = docs
        .iter()
        .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
        .collect();
    Ok(crate::kg_gen::keyword_extract::extract_keywords_from_corpus(&doc_refs))
}

/// Discover topics from all vault conversations using an LLM.
/// Returns a structured taxonomy of topics with descriptions and search keywords.
#[tauri::command]
pub async fn cmd_kg_discover_topics(
    provider: String,
    model: String,
) -> Result<Vec<crate::kg_gen::topic_discovery::Topic>, String> {
    let docs = read_vault_docs()?;
    if docs.is_empty() {
        return Err("Vault is empty — nothing to analyze.".to_string());
    }

    let doc_refs: Vec<(&str, &str, &str, &str)> = docs
        .iter()
        .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
        .collect();
    let conversations = crate::kg_gen::keyword_extract::extract_keywords_from_corpus(&doc_refs);

    crate::kg_gen::topic_discovery::discover_topics(&provider, &model, &conversations).await
}

/// Return cached topics from the KG. Returns an empty vec if none have been discovered yet.
#[tauri::command]
pub fn cmd_kg_get_topics(
    kg: State<'_, KgState>,
) -> Result<Vec<crate::kg_gen::topic_discovery::Topic>, String> {
    with_kg(&kg, |k| k.get_cached_topics())
}

/// Return file paths of conversations assigned to a specific topic.
#[tauri::command]
pub fn cmd_kg_get_topic_conversations(
    kg: State<'_, KgState>,
    topic_id: String,
) -> Result<Vec<String>, String> {
    with_kg(&kg, |k| k.get_topic_conversation_paths(&topic_id))
}

/// Classify new (unclassified) vault conversations into existing topics.
/// Skips conversations that are already assigned to at least one topic.
/// Returns the number of newly classified conversations.
#[tauri::command]
pub async fn cmd_kg_classify_new_conversations(
    kg: State<'_, KgState>,
    graph_cache: State<'_, GraphCacheState>,
) -> Result<u32, String> {
    // 1. Check we have topics
    let topics = with_kg(&kg, |k| k.get_cached_topics())?;
    if topics.is_empty() {
        return Ok(0);
    }

    // 2. Get the agentic model from config
    let cfg = crate::config::read_config()?;
    let assignments_cfg = cfg.model_assignments.as_ref();
    let agentic = assignments_cfg
        .and_then(|m| m.get("agentic"))
        .and_then(|v| v.first())
        .ok_or("No agentic model configured")?;
    let provider = agentic.provider.clone();
    let model = agentic.model.clone();

    // 3. Find unclassified conversations
    let already_classified = with_kg(&kg, |k| k.get_all_classified_paths())?;
    let docs = read_vault_docs()?;
    let new_docs: Vec<_> = docs
        .iter()
        .filter(|(path, _, _, _)| !already_classified.contains(path))
        .collect();

    if new_docs.is_empty() {
        return Ok(0);
    }

    let new_count = new_docs.len() as u32;
    log::info!(
        "Classifying {} new conversations into {} existing topics",
        new_count,
        topics.len()
    );

    // 4. Extract keywords for the new conversations only
    let doc_refs: Vec<(&str, &str, &str, &str)> = new_docs
        .iter()
        .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
        .collect();
    let conversations = crate::kg_gen::keyword_extract::extract_keywords_from_corpus(&doc_refs);

    // 5. Classify new conversations against existing topics
    let new_assignments = crate::kg_gen::topic_discovery::classify_conversations(
        &provider,
        &model,
        &topics,
        &conversations,
    )
    .await?;

    // 6. Store the new assignments (upserts, safe if already exists)
    with_kg(&kg, |k| {
        k.store_topic_assignments(&new_assignments, &conversations)
    })?;

    // Invalidate graph cache
    if let Ok(mut cache) = graph_cache.0.lock() {
        cache.clear();
    }

    Ok(new_count)
}

/// Return a graph that uses LLM-discovered topics as hub nodes instead of providers.
/// If topics are already cached in the KG, returns the cached graph instantly.
/// If not cached and provider/model are given, runs the full pipeline:
///   extract keywords → discover topics → classify conversations → build graph.
#[tauri::command]
pub async fn cmd_kg_get_topic_graph(
    kg: State<'_, KgState>,
    graph_cache: State<'_, GraphCacheState>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<GraphData, String> {
    // Check cache first
    let has_cached = with_kg(&kg, |k| Ok(k.has_cached_topics()))?;
    if has_cached {
        return with_kg(&kg, |k| k.build_topic_graph());
    }

    // Need to generate — require provider/model
    let provider = provider.ok_or(
        "No topic data cached. Please configure a model for agentic tasks in Settings → Model Assignments."
    )?;
    let model = model.ok_or("No topic data cached. Model not specified.")?;

    // Step 1: Extract keywords
    let docs = read_vault_docs()?;
    if docs.is_empty() {
        return Err("Vault is empty — nothing to analyze.".to_string());
    }
    let doc_refs: Vec<(&str, &str, &str, &str)> = docs
        .iter()
        .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
        .collect();
    let conversations = crate::kg_gen::keyword_extract::extract_keywords_from_corpus(&doc_refs);

    // Step 2: Discover topics
    let topics =
        crate::kg_gen::topic_discovery::discover_topics(&provider, &model, &conversations).await?;

    // Step 3: Classify conversations into topics
    let assignments = crate::kg_gen::topic_discovery::classify_conversations(
        &provider,
        &model,
        &topics,
        &conversations,
    )
    .await?;

    // Step 4: Store in KG for caching
    with_kg(&kg, |k| {
        k.store_topics(&topics)?;
        k.store_topic_assignments(&assignments, &conversations)?;
        Ok(())
    })?;

    // Invalidate the regular graph cache since we modified the KG
    if let Ok(mut cache) = graph_cache.0.lock() {
        cache.clear();
    }

    // Step 5: Build and return the topic-based graph
    with_kg(&kg, |k| k.build_topic_graph())
}

// --- Frontmatter parsing (delegated to vault::parse_frontmatter) ---

fn parse_frontmatter(content: &str) -> vault::FrontmatterMeta {
    vault::parse_frontmatter(content)
}

/// Clean a vault filename (e.g. "2026-02-20_basics-of-rl.md") into a readable display title.
/// Strips date prefix and extension, replaces separators with spaces, capitalizes first letter.
fn clean_vault_filename(path: &str, fallback: &str) -> String {
    let fname = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| fallback.to_string());
    let s = fname.trim_end_matches(".md");
    let s = if s.len() > 11 {
        let is_date = s[..10].chars().enumerate().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        });
        if is_date {
            let rest = &s[10..];
            if rest.starts_with('_') || rest.starts_with('-') {
                &rest[1..]
            } else {
                rest
            }
        } else {
            s
        }
    } else {
        s
    };
    let clean: String = s
        .chars()
        .map(|c| if c == '_' || c == '-' { ' ' } else { c })
        .collect();
    let mut chars = clean.chars();
    match chars.next() {
        None => fallback.to_string(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn extract_body_title(content: &str) -> Option<String> {
    let body = if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("---") {
            &rest[end + 3..]
        } else {
            content
        }
    } else {
        content
    };

    for line in body.lines() {
        if let Some(val) = line.strip_prefix("# ") {
            let title = val.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
        if line.starts_with("### ") {
            break;
        }
    }

    None
}

/// Parse messages from markdown content (### Role sections separated by ---).
fn parse_messages(content: &str) -> Vec<crate::models::Message> {
    let mut messages = Vec::new();

    // Skip frontmatter
    let body = if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("---") {
            &rest[end + 3..]
        } else {
            content
        }
    } else {
        content
    };

    // Split on ### headers
    let mut current_role: Option<String> = None;
    let mut current_content = String::new();
    let mut current_timestamp: Option<String> = None;

    for line in body.lines() {
        if let Some(header) = line.strip_prefix("### ") {
            // Save previous message
            if let Some(ref role) = current_role {
                let trimmed = current_content.trim().trim_end_matches("---").trim();
                if !trimmed.is_empty() {
                    messages.push(crate::models::Message {
                        role: role.clone(),
                        content: trimmed.to_string(),
                        timestamp: current_timestamp.take(),
                        attachments: None,
                        reasoning: None,
                        tool_calls: None,
                    });
                }
            }

            // Parse new header: "### You — 2024-01-01T00:00:00Z" or "### Assistant"
            let (role_str, ts) = if let Some(idx) = header.find(" — ") {
                (&header[..idx], Some(header[idx + 5..].to_string()))
            } else {
                (header, None)
            };

            current_role = Some(match role_str.trim() {
                "You" => "user".to_string(),
                "Assistant" => "assistant".to_string(),
                other => other.to_lowercase(),
            });
            current_timestamp = ts;
            current_content.clear();
        } else if line.starts_with("# ") && current_role.is_none() {
            // Skip the title line
            continue;
        } else {
            current_content.push_str(line);
            current_content.push('\n');
        }
    }

    // Save last message
    if let Some(ref role) = current_role {
        let trimmed = current_content.trim().trim_end_matches("---").trim();
        if !trimmed.is_empty() {
            messages.push(crate::models::Message {
                role: role.clone(),
                content: trimmed.to_string(),
                timestamp: current_timestamp,
                attachments: None,
                reasoning: None,
                tool_calls: None,
            });
        }
    }

    messages
}

// ── Claude Code Manager commands ─────────────────────────────────────────────

#[tauri::command]
pub fn cmd_claude_scan_projects() -> Result<Vec<crate::models::ClaudeProject>, String> {
    let config = config::read_config()?;
    let scan_paths = config.claude_scan_paths.unwrap_or_default();
    let pinned = config.claude_pinned_projects.unwrap_or_default();
    Ok(crate::claude::scan_projects(&scan_paths, &pinned))
}

#[tauri::command]
pub fn cmd_claude_get_scan_config() -> Result<crate::models::ClaudeScanConfig, String> {
    let config = config::read_config()?;
    Ok(crate::models::ClaudeScanConfig {
        scan_paths: config.claude_scan_paths.unwrap_or_default(),
        pinned_projects: config.claude_pinned_projects.unwrap_or_default(),
    })
}

#[tauri::command]
pub fn cmd_claude_set_scan_config(
    scan_config: crate::models::ClaudeScanConfig,
) -> Result<(), String> {
    let mut config = config::read_config()?;
    config.claude_scan_paths = Some(scan_config.scan_paths);
    config.claude_pinned_projects = Some(scan_config.pinned_projects);
    config::write_config(&config)
}

#[tauri::command]
pub fn cmd_claude_read_instructions(
    project_path: String,
) -> Result<Vec<crate::models::ClaudeFile>, String> {
    crate::claude::read_instructions(&project_path)
}

#[tauri::command]
pub fn cmd_claude_list_skills(
    project_path: String,
) -> Result<Vec<crate::models::ClaudeSkill>, String> {
    crate::claude::list_skills(&project_path)
}

#[tauri::command]
pub fn cmd_claude_list_memory(
    project_path: String,
) -> Result<Vec<crate::models::ClaudeFile>, String> {
    crate::claude::list_memory(&project_path)
}

#[tauri::command]
pub fn cmd_claude_read_settings(
    project_path: String,
) -> Result<Vec<crate::models::ClaudeFile>, String> {
    crate::claude::read_settings(&project_path)
}

#[tauri::command]
pub fn cmd_claude_write_file(
    project_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    crate::claude::write_project_file(&project_path, &relative_path, &content)
}

#[tauri::command]
pub fn cmd_claude_delete_skill(project_path: String, filename: String) -> Result<(), String> {
    crate::claude::delete_skill(&project_path, &filename)
}

#[tauri::command]
pub fn cmd_claude_scan_all_skills() -> Result<Vec<crate::models::ClaudeSkillWithProject>, String> {
    let config = config::read_config()?;
    let scan_paths = config.claude_scan_paths.unwrap_or_default();
    let pinned = config.claude_pinned_projects.unwrap_or_default();
    Ok(crate::claude::scan_all_skills(&scan_paths, &pinned))
}

#[tauri::command]
pub fn cmd_claude_scan_all_memory() -> Result<Vec<crate::models::ClaudeFileWithProject>, String> {
    let config = config::read_config()?;
    let scan_paths = config.claude_scan_paths.unwrap_or_default();
    let pinned = config.claude_pinned_projects.unwrap_or_default();
    Ok(crate::claude::scan_all_memory(&scan_paths, &pinned))
}

#[tauri::command]
pub fn cmd_claude_copy_file(
    source_project: String,
    relative_path: String,
    target_project: String,
) -> Result<(), String> {
    crate::claude::copy_file(&source_project, &relative_path, &target_project)
}

#[tauri::command]
pub fn cmd_claude_diff_file(
    project_a: String,
    project_b: String,
    relative_path: String,
) -> Result<(String, String), String> {
    crate::claude::diff_file(&project_a, &project_b, &relative_path)
}

#[tauri::command]
pub fn cmd_claude_get_templates() -> Result<Vec<crate::models::ClaudeTemplate>, String> {
    let config = config::read_config()?;
    Ok(config.claude_templates.unwrap_or_default())
}

#[tauri::command]
pub fn cmd_claude_set_templates(
    templates: Vec<crate::models::ClaudeTemplate>,
) -> Result<(), String> {
    let mut config = config::read_config()?;
    config.claude_templates = Some(templates);
    config::write_config(&config)
}

/// Returns true if an OpenAI model ID supports chat completions.
/// Excludes embeddings, TTS, whisper, DALL-E, image gen, moderation, realtime, etc.
fn is_openai_chat_model(id: &str) -> bool {
    const EXCLUDE_PREFIXES: &[&str] = &[
        "text-embedding-",
        "dall-e-",
        "gpt-image-",
        "chatgpt-image-",
        "tts-",
        "whisper-",
        "gpt-oss-",
        "computer-use-",
        "babbage-",
        "davinci-",
        "sora-",
        "codex-",
    ];
    const EXCLUDE_CONTAINS: &[&str] = &[
        "-tts",
        "-transcribe",
        "-realtime",
        "moderation",
        "-audio-preview",
        "-codex",
        "-deep-research",
    ];

    for prefix in EXCLUDE_PREFIXES {
        if id.starts_with(prefix) {
            return false;
        }
    }
    for needle in EXCLUDE_CONTAINS {
        if id.contains(needle) {
            return false;
        }
    }
    true
}

/// List available models for a given provider.
/// Fetches from provider APIs or returns hardcoded lists.
#[tauri::command]
pub async fn cmd_list_models(
    provider: String,
    api_key: Option<String>,
) -> Result<Vec<AvailableModel>, String> {
    let cfg = config::read_config()?;
    let client = http_client();

    match provider.as_str() {
        "openai" => {
            let api_key = cfg
                .openai_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("OpenAI API key not configured")?;

            let resp = client
                .get("https://api.openai.com/v1/models")
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
                .await
                .map_err(|e| format!("OpenAI models request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "OpenAI API error ({}): {}",
                    status,
                    &text[..text.len().min(200)]
                ));
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse OpenAI models response: {}", e))?;

            let mut models: Vec<AvailableModel> = json["data"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|model| {
                            let id = model["id"].as_str()?;
                            if !is_openai_chat_model(id) || is_free_model_id(id) {
                                return None;
                            }
                            Some(AvailableModel {
                                id: id.to_string(),
                                provider: provider.clone(),
                                display_name: model_display_name(model),
                                owned_by: model_owned_by(model),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            sort_available_models(&mut models);
            Ok(models)
        }

        "anthropic" => Ok(vec![
            AvailableModel {
                id: "claude-sonnet-4-6".to_string(),
                provider: provider.clone(),
                display_name: Some("Sonnet 4.6".to_string()),
                owned_by: Some("anthropic".to_string()),
            },
            AvailableModel {
                id: "claude-sonnet-4-5".to_string(),
                provider: provider.clone(),
                display_name: Some("Sonnet 4.5".to_string()),
                owned_by: Some("anthropic".to_string()),
            },
            AvailableModel {
                id: "claude-haiku-3-5".to_string(),
                provider: provider.clone(),
                display_name: Some("Haiku 3.5".to_string()),
                owned_by: Some("anthropic".to_string()),
            },
            AvailableModel {
                id: "claude-opus-4".to_string(),
                provider: provider.clone(),
                display_name: Some("Opus 4".to_string()),
                owned_by: Some("anthropic".to_string()),
            },
        ]),

        "openrouter" => {
            let api_key = api_key
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| cfg.openrouter_api_key.clone())
                .filter(|k| !k.is_empty())
                .ok_or("OpenRouter API key not configured")?;

            let resp = client
                .get("https://openrouter.ai/api/frontend/models/find?order=top-weekly")
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
                .await
                .map_err(|e| format!("OpenRouter models request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "OpenRouter API error ({}): {}",
                    status,
                    &text[..text.len().min(200)]
                ));
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse OpenRouter models response: {}", e))?;

            // In restricted privacy mode, fetch ZDR endpoint list and filter
            let restricted = cfg.privacy_mode.as_deref() == Some("restricted");
            let zdr_model_ids: Option<std::collections::HashSet<String>> = if restricted {
                let zdr_ids = async {
                    let r = client
                        .get("https://openrouter.ai/api/v1/endpoints/zdr")
                        .header("Authorization", format!("Bearer {}", api_key))
                        .send()
                        .await
                        .ok()?;
                    if !r.status().is_success() {
                        return None;
                    }
                    let json: serde_json::Value = r.json().await.ok()?;
                    Some(
                        json["data"]
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|ep| ep["model_id"].as_str().map(|s| s.to_string()))
                                    .collect::<std::collections::HashSet<String>>()
                            })
                            .unwrap_or_default(),
                    )
                }
                .await;
                zdr_ids
            } else {
                None
            };

            let source_models = json["data"]["models"]
                .as_array()
                .or_else(|| json["models"].as_array())
                .or_else(|| json["data"].as_array());

            let models: Vec<AvailableModel> = source_models
                .map(|arr| {
                    arr.iter()
                        .filter(|model| openrouter_frontend_text_model(model))
                        .filter_map(openrouter_frontend_model)
                        .filter(|model| {
                            // In restricted mode, only allow ZDR-capable models
                            if let Some(ref zdr_ids) = zdr_model_ids {
                                zdr_ids.contains(&model.id)
                            } else {
                                true
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(models)
        }

        "ollama" => {
            let resp = client
                .get("http://127.0.0.1:11434/api/tags")
                .send()
                .await
                .map_err(|e| format!("Ollama request failed (is it running?): {}", e))?;

            if !resp.status().is_success() {
                return Err("Ollama API error".to_string());
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

            let mut models: Vec<AvailableModel> = json["models"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|model| {
                            let id = model["name"].as_str()?;
                            if is_free_model_id(id) {
                                return None;
                            }
                            Some(AvailableModel {
                                id: id.to_string(),
                                provider: provider.clone(),
                                display_name: model_display_name(model),
                                owned_by: None,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            sort_available_models(&mut models);
            Ok(models)
        }

        other => Err(format!("Unknown provider: {}", other)),
    }
}

/// Check which providers are configured and available.
#[tauri::command]
pub async fn cmd_check_providers() -> Result<Vec<crate::models::ProviderStatus>, String> {
    let cfg = config::read_config()?;
    let mut statuses = vec![];

    statuses.push(crate::models::ProviderStatus {
        provider: "openai".to_string(),
        available: cfg.openai_api_key.as_deref().is_some_and(|k| !k.is_empty()),
    });

    statuses.push(crate::models::ProviderStatus {
        provider: "anthropic".to_string(),
        available: cfg
            .anthropic_api_key
            .as_deref()
            .is_some_and(|k| !k.is_empty()),
    });

    statuses.push(crate::models::ProviderStatus {
        provider: "openrouter".to_string(),
        available: cfg
            .openrouter_api_key
            .as_deref()
            .is_some_and(|k| !k.is_empty()),
    });

    // Ollama — quick connectivity check
    let ollama_available = reqwest::Client::new()
        .get("http://127.0.0.1:11434/api/tags")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    statuses.push(crate::models::ProviderStatus {
        provider: "ollama".to_string(),
        available: ollama_available,
    });

    Ok(statuses)
}

/// Reveal a file highlighted in the system file explorer.
#[tauri::command]
pub fn cmd_reveal_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        tauri_plugin_opener::open_path(p.to_string_lossy().as_ref(), None::<&str>)
            .map_err(|e| format!("Failed to open location: {}", e))
    } else {
        tauri_plugin_opener::reveal_item_in_dir(p)
            .map_err(|e| format!("Failed to reveal file: {}", e))
    }
}

/// Check whether a given path exists and is a directory.
#[tauri::command]
pub fn cmd_validate_path(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).is_dir())
}

/// Status snapshot for the idle summarizer. Used by the UI to render a
/// "summarizer paused" banner with a resume button.
#[derive(serde::Serialize)]
pub struct IdleSummarizerStatus {
    pub halted: bool,
    pub halted_at: Option<String>,
    pub last_success_at: Option<String>,
    pub bad_state_started_at: Option<String>,
    pub auto_halt_days: i64,
    pub digest_auto_summarize: bool,
}

/// Read the current state of the idle summarizer: halt flag, last success,
/// and bad-state start. Cheap — one DB read plus one config read.
#[tauri::command]
pub fn cmd_idle_summarizer_status(
    db: State<'_, DbState>,
) -> Result<IdleSummarizerStatus, String> {
    let cfg = config::read_config().unwrap_or_default();
    let (last_success_at, bad_state_started_at) = with_db(&db, |d| d.idle_summarizer_health())?;
    Ok(IdleSummarizerStatus {
        halted: cfg.idle_summarizer_halted == Some(true),
        halted_at: cfg.idle_summarizer_halted_at,
        last_success_at,
        bad_state_started_at,
        auto_halt_days: cfg
            .idle_summarizer_auto_halt_days
            .unwrap_or(AUTO_HALT_DEFAULT_DAYS),
        digest_auto_summarize: cfg.digest_auto_summarize != Some(false),
    })
}

/// Clear the halted flag so the background loop resumes on the next tick.
/// Does not retroactively retry rows whose backoff window has not yet
/// elapsed — those will re-enter the queue naturally once `next_retry_at`
/// passes. Returns the new status snapshot.
#[tauri::command]
pub fn cmd_resume_idle_summarizer(
    db: State<'_, DbState>,
) -> Result<IdleSummarizerStatus, String> {
    let mut cfg = config::read_config().unwrap_or_default();
    cfg.idle_summarizer_halted = Some(false);
    cfg.idle_summarizer_halted_at = None;
    config::write_config(&cfg).map_err(|e| format!("Failed to clear halt flag: {}", e))?;
    log::info!("Idle summarizer resumed by user");
    cmd_idle_summarizer_status(db)
}

/// Respond to a pending code-execution consent request.
#[tauri::command]
pub fn cmd_respond_code_consent(
    state: State<'_, CodeConsentState>,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(sender) = map.remove(&request_id) {
        let _ = sender.send(approved);
        Ok(())
    } else {
        Err(format!("No pending consent request: {}", request_id))
    }
}

#[cfg(test)]
mod idle_summarizer_tests {
    use super::{classify_digest_error, retry_window_for_error, should_auto_halt};
    use chrono::{Duration, Utc};

    #[test]
    fn auto_halt_disabled_when_days_is_zero() {
        let started = (Utc::now() - Duration::days(30)).to_rfc3339();
        assert!(!should_auto_halt(&started, Utc::now(), 0));
    }

    #[test]
    fn auto_halt_disabled_when_days_is_negative() {
        let started = (Utc::now() - Duration::days(30)).to_rfc3339();
        assert!(!should_auto_halt(&started, Utc::now(), -1));
    }

    #[test]
    fn auto_halt_triggers_exactly_at_window() {
        let now = Utc::now();
        let started = (now - Duration::days(3)).to_rfc3339();
        assert!(should_auto_halt(&started, now, 3));
    }

    #[test]
    fn auto_halt_does_not_trigger_before_window() {
        let now = Utc::now();
        // Just shy of 3 days
        let started = (now - Duration::days(3) + Duration::minutes(1)).to_rfc3339();
        assert!(!should_auto_halt(&started, now, 3));
    }

    #[test]
    fn auto_halt_triggers_well_past_window() {
        let now = Utc::now();
        let started = (now - Duration::days(10)).to_rfc3339();
        assert!(should_auto_halt(&started, now, 3));
    }

    #[test]
    fn auto_halt_safe_on_garbled_timestamp() {
        // Parse failure must not panic and must NOT auto-halt — a corrupted
        // DB value should never be the trigger that disables the feature.
        assert!(!should_auto_halt("not-a-timestamp", Utc::now(), 3));
        assert!(!should_auto_halt("", Utc::now(), 3));
    }

    // Real error strings from the per-provider call_*_digest helpers. If a
    // helper's format changes (status code, body framing), update these — the
    // circuit breaker only fires on errors classified as "rate_limit".
    #[test]
    fn classifies_anthropic_429_as_rate_limit() {
        let err = "Anthropic digest error 429 Too Many Requests: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your organization's rate limit of 30,000 input tokens per minute\"}}";
        assert_eq!(classify_digest_error(err), "rate_limit");
        assert_eq!(retry_window_for_error("rate_limit"), (30, 6 * 60));
    }

    #[test]
    fn classifies_openai_rate_limit() {
        let err = "OpenAI digest error 429: rate_limit_exceeded";
        assert_eq!(classify_digest_error(err), "rate_limit");
    }

    #[test]
    fn classifies_context_length_overflow() {
        let err = "Anthropic digest error 400: {\"error\":{\"message\":\"prompt is too long: 250000 tokens > 200000 maximum context length\"}}";
        assert_eq!(classify_digest_error(err), "context_length");
    }

    #[test]
    fn classifies_auth_failure() {
        let err = "Anthropic digest error 401: Unauthorized";
        assert_eq!(classify_digest_error(err), "auth");
        let (base, max) = retry_window_for_error("auth");
        assert_eq!((base, max), (24 * 60, 24 * 60));
    }

    #[test]
    fn unknown_falls_through_to_other() {
        assert_eq!(classify_digest_error("some weird stringified panic"), "other");
        assert_eq!(retry_window_for_error("other"), (60, 24 * 60));
    }
}
