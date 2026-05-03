use std::sync::{Arc, Mutex};

use axum::extract::DefaultBodyLimit;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tauri::{AppHandle, Emitter};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::chat;
use crate::config;
use crate::db::Database;
use crate::kg_gen::kggen::KgDatabase;
use crate::models::{IngestPayload, IngestResponse, VaultConversationIngested};
use crate::state;
use crate::vault;

pub struct AppState {
    pub app: AppHandle,
    pub db: Arc<Database>,
    pub kg: Option<Arc<KgDatabase>>,
    pub token: Arc<Mutex<String>>,
}

/// Verify the Authorization: Bearer <token> header.
fn check_auth(headers: &HeaderMap, expected_token: &str) -> Result<(), (StatusCode, String)> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let provided = auth.strip_prefix("Bearer ").unwrap_or("");

    if provided != expected_token {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Invalid or missing auth token".to_string(),
        ));
    }
    Ok(())
}

/// GET /api/ping — app discovery endpoint (no auth required)
async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "app": "kept",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

/// Pick the right `<scheme>://extensions` URL for the requesting browser.
/// Falls back to `chrome://extensions` for plain Chromium / Chrome / unknown.
/// Each Chromium fork only honours its own scheme — `chrome://` 404s on
/// Brave, Edge, Vivaldi, etc. — so we sniff the User-Agent.
fn extensions_url_for_ua(ua: &str) -> &'static str {
    let lc = ua.to_ascii_lowercase();
    if lc.contains("vivaldi") {
        "vivaldi://extensions"
    } else if lc.contains("opr/") || lc.contains("opera") {
        "opera://extensions"
    } else if lc.contains("edg/") || lc.contains("edge/") {
        "edge://extensions"
    } else if lc.contains("brave") {
        // Brave hides itself in UA by default; this only catches forks that
        // advertise themselves. Most Brave installs will hit the fallback.
        "brave://extensions"
    } else {
        "chrome://extensions"
    }
}

/// GET /connect — browser-based connection page for the extension (no auth required)
async fn connect_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let raw_token = state.token.lock().map(|t| t.clone()).unwrap_or_default();
    // HTML-escape the token to prevent injection via the meta tag
    let token = raw_token
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;");
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let extensions_url = extensions_url_for_ua(ua);
    let html = format!(
        r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="kept-token" content="{token}" />
    <title>Kept — Connect Extension</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet" />
    <style>
      :root {{
        --bg:         #020A0D;
        --bg-surface: rgba(195,236,255,0.04);
        --bg-inset:   rgba(195,236,255,0.06);
        --bg-hover:   rgba(195,236,255,0.08);
        --border:     rgba(195,236,255,0.08);
        --border-sub: rgba(195,236,255,0.05);
        --text:       #C3ECFF;
        --text-2:     rgba(195,236,255,0.6);
        --text-3:     rgba(195,236,255,0.35);
        --tag-check-bg: rgba(251,191,36,0.1);  --tag-check-fg: #fbbf24;
        --tag-ok-bg:    rgba(74,222,128,0.1);   --tag-ok-fg:    #4ade80;
        --tag-err-bg:   rgba(248,113,113,0.1);  --tag-err-fg:   #f87171;
      }}

      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      body {{
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        background: var(--bg);
        color: var(--text);
        font-size: 13px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
      }}
      .wrap {{ max-width: 480px; margin: 0 auto; padding: 48px 24px; }}

      h1 {{
        font-size: 28px;
        font-weight: 600;
        letter-spacing: -0.03em;
        margin-bottom: 32px;
        color: var(--text);
      }}
      .section {{ margin-bottom: 32px; }}
      .section-title {{
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 12px;
        color: var(--text-2);
        letter-spacing: -0.01em;
      }}

      .status-card {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--bg-surface);
        padding: 14px 16px;
        border-radius: 10px;
        border: 1px solid var(--border);
      }}
      .status-label {{ font-weight: 500; color: var(--text-2); font-size: 13px; }}

      .status-tag {{
        display: inline-block;
        padding: 3px 10px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 500;
        background: var(--bg-inset);
        color: var(--text-3);
      }}
      .status-tag.checking  {{ background: var(--tag-check-bg); color: var(--tag-check-fg); }}
      .status-tag.connected {{ background: var(--tag-ok-bg);    color: var(--tag-ok-fg);    }}
      .status-tag.not-found {{ background: var(--tag-err-bg);   color: var(--tag-err-fg);   }}

      .hint {{ font-size: 13px; color: var(--text-3); margin-top: 10px; line-height: 1.6; }}

      #kept-install-section {{ display: none; }}

      .steps {{ list-style: none; margin-bottom: 16px; }}
      .steps li {{
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 10px 0;
        border-bottom: 1px solid var(--border-sub);
        color: var(--text-2);
        font-size: 13px;
      }}
      .steps li:last-child {{ border-bottom: none; }}
      .step-num {{
        width: 22px; height: 22px;
        border-radius: 50%;
        background: var(--bg-inset);
        border: 1px solid var(--border);
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 600;
        color: var(--text-3);
        flex-shrink: 0; margin-top: 1px;
      }}
      .steps code {{
        font-family: 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
        font-size: 12px;
        background: var(--bg-inset);
        padding: 1px 6px;
        border-radius: 4px;
        color: var(--text-2);
      }}
      .steps strong {{ font-weight: 600; color: var(--text); }}

      .btn-reload {{
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 9px 18px;
        background: rgba(255,255,255,0.08);
        color: var(--text);
        border: none;
        border-radius: 8px;
        font: 500 13px 'DM Sans', system-ui, sans-serif;
        cursor: pointer;
        text-decoration: none;
        transition: all 0.2s ease;
      }}
      .btn-reload:hover {{ background: rgba(255,255,255,0.14); }}

      .chrome-url {{
        font-family: 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
        font-size: 12px;
        background: var(--bg-inset);
        padding: 2px 7px;
        border-radius: 5px;
        color: var(--text-2);
        cursor: pointer;
        border: none;
        text-decoration: underline;
        text-underline-offset: 2px;
        transition: color 0.2s;
        position: relative;
      }}
      .chrome-url:hover {{ color: var(--text); }}
      .chrome-url.did-copy {{ color: var(--tag-ok-fg); }}
      .chrome-url .copied {{
        display: none;
        position: absolute;
        left: 50%;
        bottom: calc(100% + 5px);
        transform: translateX(-50%);
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 2px 8px;
        font-size: 11px;
        font-family: 'DM Sans', system-ui, sans-serif;
        color: var(--tag-ok-fg);
        white-space: nowrap;
        pointer-events: none;
      }}
      .chrome-url.did-copy .copied {{ display: block; }}
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Connect Extension</h1>

      <div class="section">
        <div class="section-title">Extension status</div>
        <div class="status-card">
          <span class="status-label">Kept browser extension</span>
          <span id="kept-status-tag" class="status-tag checking">checking…</span>
        </div>
        <div id="kept-connect-detail" class="hint">Looking for the Kept extension in this browser…</div>
      </div>

      <div id="kept-install-section" class="section">
        <div class="section-title">How to install</div>
        <ol class="steps">
          <li>
            <div class="step-num">1</div>
            <div>Open <button class="chrome-url" onclick="copyUrl(this)" title="Click to copy">{extensions_url}<span class="copied">Copied!</span></button> in your browser</div>
          </li>
          <li>
            <div class="step-num">2</div>
            <div>Enable <strong>Developer Mode</strong> using the toggle in the top-right corner</div>
          </li>
          <li>
            <div class="step-num">3</div>
            <div>Click <strong>Load unpacked</strong> and select the <code>extension/</code> folder from the Kept directory</div>
          </li>
          <li>
            <div class="step-num">4</div>
            <div>Return here and reload the page</div>
          </li>
        </ol>
        <a href="javascript:location.reload()" class="btn-reload">&#8635; Reload page</a>
      </div>
    </div>

    <script>
      function copyUrl(btn) {{
        navigator.clipboard.writeText('{extensions_url}').then(function () {{
          btn.classList.add('did-copy');
          setTimeout(function () {{ btn.classList.remove('did-copy'); }}, 1800);
        }});
      }}

      // If connect.js has not cleared the 'checking' class within 800 ms,
      // the extension is not installed — reveal the install guide.
      setTimeout(function () {{
        var tag = document.getElementById('kept-status-tag');
        if (tag && tag.classList.contains('checking')) {{
          tag.className = 'status-tag not-found';
          tag.textContent = 'not detected';
          document.getElementById('kept-connect-detail').textContent =
            'The Kept extension was not found. Follow the steps below to install it.';
          document.getElementById('kept-install-section').style.display = 'block';
        }}
      }}, 800);
    </script>
  </body>
</html>"##,
        token = token,
        extensions_url = extensions_url
    );
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
}

/// GET /api/assets/:platform/:filename — serve saved images (no auth, localhost-only)
async fn serve_asset(
    Path((platform, filename)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // Validate platform
    const ALLOWED_PLATFORMS: &[&str] = &["chatgpt", "claude", "gemini", "grok", "kimi"];
    if !ALLOWED_PLATFORMS.contains(&platform.as_str()) {
        return Err((StatusCode::BAD_REQUEST, "Invalid platform".to_string()));
    }

    // Validate filename has no path traversal
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err((StatusCode::BAD_REQUEST, "Invalid filename".to_string()));
    }

    let assets = crate::config::assets_dir(&platform).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Config error: {}", e),
        )
    })?;
    let path = assets.join(&filename);

    // Canonicalize and verify the path is within the assets directory
    let canonical = path
        .canonicalize()
        .map_err(|_| (StatusCode::NOT_FOUND, "File not found".to_string()))?;
    let canonical_assets = assets.canonicalize().unwrap_or(assets);
    if !canonical.starts_with(&canonical_assets) {
        return Err((StatusCode::BAD_REQUEST, "Invalid path".to_string()));
    }

    let bytes = std::fs::read(&canonical)
        .map_err(|_| (StatusCode::NOT_FOUND, "File not found".to_string()))?;

    let content_type = match canonical.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };

    Ok((
        [
            ("content-type", content_type),
            ("cache-control", "public, max-age=31536000, immutable"),
        ],
        bytes,
    ))
}

/// Parse and validate the `X-Kept-Target-Dir` header. When present and valid,
/// the returned PathBuf will be used as the vault root for this ingest.
/// Rejects relative paths, `..` traversal, and non-existent / non-directory
/// targets — the extension surfaces the error on the provider row.
fn parse_target_dir_header(headers: &HeaderMap) -> Result<Option<std::path::PathBuf>, (StatusCode, String)> {
    let raw = match headers.get("x-kept-target-dir").and_then(|v| v.to_str().ok()) {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => return Ok(None),
    };

    let path = std::path::PathBuf::from(raw);
    if !path.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Sync target must be an absolute path: {raw}"),
        ));
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Sync target must not contain `..` segments: {raw}"),
        ));
    }
    if !path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Sync target is not an existing directory: {raw}"),
        ));
    }
    Ok(Some(path))
}

/// POST /api/ingest — receive a conversation from the extension
async fn ingest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<IngestPayload>,
) -> Result<Json<IngestResponse>, (StatusCode, String)> {
    let token = state.token.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Token lock error".to_string(),
        )
    })?;
    check_auth(&headers, &token)?;
    state::set_extension_ping_now();

    // Reject if sync limit reached or user stopped the sync
    if state::should_reject_ingest() {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Sync limit reached or sync stopped".to_string(),
        ));
    }

    // Optional extension-provided override for the target root directory.
    let target_root = parse_target_dir_header(&headers)?;
    let target_ref = target_root.as_deref();

    // Save images to disk (if any)
    let img_results = vault::save_images(&payload, target_ref);
    if !img_results.is_empty() {
        let saved: Vec<_> = img_results.iter().filter(|(_, ok)| *ok).collect();
        let failed: Vec<_> = img_results.iter().filter(|(_, ok)| !*ok).collect();
        log::info!("Images: {} saved, {} failed", saved.len(), failed.len());
    }

    // Save markdown file to vault
    let (file_path, hash, skipped) = vault::save_conversation(&payload, target_ref)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Index in database (unless content unchanged)
    if !skipped {
        state
            .db
            .upsert_conversation(&payload, &file_path, &hash)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        state::increment_sync_ingested();
    }

    let event = VaultConversationIngested {
        conversation_id: payload.conversation_id.clone(),
        platform: payload.platform.clone(),
        title: payload.title.clone(),
        file_path: file_path.clone(),
        skipped,
    };
    let _ = state.app.emit("vault_conversation_ingested", &event);

    // Summarization is handled by the periodic idle-summarizer worker started
    // in lib.rs — it picks up conversations 5+ minutes after their last activity.
    // Nothing to do here on ingest.

    Ok(Json(IngestResponse {
        status: "ok".to_string(),
        file_path,
        skipped,
    }))
}

/// POST /api/extension_ping — extension presence check-in (auth required)
async fn extension_ping(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let token = state.token.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Token lock error".to_string(),
        )
    })?;
    check_auth(&headers, &token)?;
    state::set_extension_ping_now();
    let sync_requested = state::take_sync_requested();
    let restricted = config::read_config()
        .map(|cfg| cfg.privacy_mode.as_deref() == Some("restricted"))
        .unwrap_or(false);
    Ok(Json(serde_json::json!({ "status": "ok", "sync_requested": sync_requested, "restricted_mode": restricted })))
}

/// GET /api/projects — list all projects (auth required)
async fn list_projects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let token = state.token.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Token lock error".to_string(),
        )
    })?;
    check_auth(&headers, &token)?;

    let kg = state.kg.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Knowledge graph not available".to_string(),
    ))?;

    let projects = kg.get_projects().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("KG error: {}", e),
        )
    })?;

    let list: Vec<serde_json::Value> = projects.into_iter().map(|(id, name, description, conv_count)| {
        serde_json::json!({ "id": id, "name": name, "description": description, "conversation_count": conv_count })
    }).collect();

    Ok(Json(serde_json::json!({ "projects": list })))
}

/// POST /api/projects — create a new project (auth required)
async fn create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let token = state.token.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Token lock error".to_string(),
        )
    })?;
    check_auth(&headers, &token)?;

    let kg = state.kg.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Knowledge graph not available".to_string(),
    ))?;

    let name = body["name"]
        .as_str()
        .ok_or((StatusCode::BAD_REQUEST, "Missing 'name' field".to_string()))?;
    if name.trim().is_empty() || name.len() > 200 {
        return Err((StatusCode::BAD_REQUEST, "Invalid project name".to_string()));
    }
    let description = body["description"].as_str().unwrap_or("");

    let id = uuid::Uuid::new_v4().to_string();
    kg.upsert_project(&id, name, description, &[])
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("KG error: {}", e),
            )
        })?;

    Ok(Json(serde_json::json!({ "id": id, "name": name })))
}

/// POST /api/projects/:id/link — link a conversation to a project (auth required)
async fn link_conversation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let token = state.token.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Token lock error".to_string(),
        )
    })?;
    check_auth(&headers, &token)?;

    let kg = state.kg.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Knowledge graph not available".to_string(),
    ))?;

    let conv_id = body["conversation_id"].as_str().ok_or((
        StatusCode::BAD_REQUEST,
        "Missing 'conversation_id' field".to_string(),
    ))?;
    let phase = body["phase"].as_str().unwrap_or("general");

    kg.link_project_conv(&project_id, conv_id, phase, 0)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("KG error: {}", e),
            )
        })?;

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

/// POST /api/agent/chat — run the Kept agent from the browser extension
async fn agent_chat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let token = state.token.lock().unwrap().clone();
    check_auth(&headers, &token)?;

    // Block agent chat entirely in restricted privacy mode
    let cfg = config::read_config().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if cfg.privacy_mode.as_deref() == Some("restricted") {
        return Err((
            StatusCode::FORBIDDEN,
            "Agent chat is disabled in restricted privacy mode. Page content and browsing context are not sent to LLMs in this mode.".to_string(),
        ));
    }

    let prompt = body["prompt"].as_str().ok_or((
        StatusCode::BAD_REQUEST,
        "Missing 'prompt' field".to_string(),
    ))?;
    let url = body["url"].as_str().unwrap_or("unknown");
    let page_title = body["page_title"].as_str().unwrap_or("");
    let page_content = body["page_content"].as_str().unwrap_or("");
    let has_selection = body["has_selection"].as_bool().unwrap_or(false);

    let result = chat::agent_chat_http(
        &state.db,
        prompt,
        url,
        page_title,
        page_content,
        has_selection,
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "status": "ok",
        "content": result.content,
        "tool_executions": result.tool_executions,
        "iterations": result.iterations,
    })))
}

/// Start the HTTP server on 127.0.0.1:18241 and [::1]:18241
pub async fn start_server(
    app: AppHandle,
    db: Arc<Database>,
    kg: Option<Arc<KgDatabase>>,
    token: Arc<Mutex<String>>,
) -> Result<(), String> {
    let state = Arc::new(AppState { app, db, kg, token });

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/ping", get(ping))
        .route("/api/ingest", post(ingest))
        .route("/api/assets/:platform/:filename", get(serve_asset))
        .route("/api/extension_ping", post(extension_ping))
        .route("/api/projects", get(list_projects))
        .route("/api/projects", post(create_project))
        .route("/api/projects/:id/link", post(link_conversation))
        .route("/api/agent/chat", post(agent_chat))
        .route("/connect", get(connect_page))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    let listener_v4 = tokio::net::TcpListener::bind("127.0.0.1:18241")
        .await
        .map_err(|e| format!("Failed to bind to 127.0.0.1:18241: {}", e))?;

    let listener_v6 = tokio::net::TcpListener::bind("[::1]:18241").await;

    match &listener_v6 {
        Ok(_) => log::info!("Kept HTTP server listening on http://127.0.0.1:18241 and http://[::1]:18241"),
        Err(e) => log::warn!("IPv6 loopback unavailable ({}), listening on http://127.0.0.1:18241 only", e),
    }

    if let Ok(v6) = listener_v6 {
        let app_v6 = app.clone();
        tokio::select! {
            res = axum::serve(listener_v4, app) => {
                res.map_err(|e| format!("Server error (IPv4): {}", e))?;
            }
            res = axum::serve(v6, app_v6) => {
                res.map_err(|e| format!("Server error (IPv6): {}", e))?;
            }
        }
    } else {
        axum::serve(listener_v4, app)
            .await
            .map_err(|e| format!("Server error: {}", e))?;
    }

    Ok(())
}
