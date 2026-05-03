use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use tower_http::cors::{Any, CorsLayer};

use crate::config;
use crate::models::{IngestPayload, IngestResponse};
use crate::vault;

/// Shared state passed to every handler. Token is read once at startup and
/// kept in `Arc` for cheap clones; vault path is re-read from config on each
/// ingest so `kept set-vault` takes effect without restarting the daemon.
pub struct AppState {
    pub token: Arc<String>,
    pub last_extension_ping: AtomicI64,
}

impl AppState {
    pub fn new(token: String) -> Self {
        Self {
            token: Arc::new(token),
            last_extension_ping: AtomicI64::new(0),
        }
    }
}

fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, String)> {
    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if provided != expected {
        return Err((StatusCode::UNAUTHORIZED, "invalid or missing auth token".into()));
    }
    Ok(())
}

/// Validate the optional `X-Kept-Target-Dir` header. Mirrors the desktop
/// app's checks: must be absolute, no `..` segments, must already exist.
fn parse_target_dir(headers: &HeaderMap) -> Result<Option<PathBuf>, (StatusCode, String)> {
    let raw = match headers
        .get("x-kept-target-dir")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => s,
        None => return Ok(None),
    };

    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("sync target must be absolute: {raw}"),
        ));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("sync target must not contain `..`: {raw}"),
        ));
    }
    if !path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("sync target is not an existing directory: {raw}"),
        ));
    }
    Ok(Some(path))
}

/// `GET /api/ping` — discovery endpoint, no auth.
async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "app": "kept",
        "version": env!("CARGO_PKG_VERSION"),
        "variant": "cli",
    }))
}

/// `POST /api/ingest` — receive a conversation from the extension.
async fn ingest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<IngestPayload>,
) -> Result<Json<IngestResponse>, (StatusCode, String)> {
    check_auth(&headers, &state.token)?;
    state
        .last_extension_ping
        .store(chrono::Utc::now().timestamp(), Ordering::Relaxed);

    let target = parse_target_dir(&headers)?;
    let target_ref = target.as_deref();

    let img_results = vault::save_images(&payload, target_ref);
    if !img_results.is_empty() {
        let saved = img_results.iter().filter(|(_, ok)| *ok).count();
        let failed = img_results.len() - saved;
        log::info!("images: {} saved, {} failed", saved, failed);
    }

    let (file_path, _hash, skipped) = vault::save_conversation(&payload, target_ref)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if skipped {
        log::debug!("skipped (unchanged): {}", file_path);
    } else {
        log::info!(
            "saved {} [{}] → {}",
            payload.platform,
            payload.conversation_id,
            file_path
        );
    }

    Ok(Json(IngestResponse {
        status: "ok".into(),
        file_path,
        skipped,
    }))
}

/// `POST /api/extension_ping` — extension presence heartbeat.
///
/// The CLI variant has no UI to surface "sync requested" or privacy-mode
/// flags, so both are reported as defaults.
async fn extension_ping(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    check_auth(&headers, &state.token)?;
    state
        .last_extension_ping
        .store(chrono::Utc::now().timestamp(), Ordering::Relaxed);
    Ok(Json(serde_json::json!({
        "status": "ok",
        "sync_requested": false,
        "restricted_mode": false,
    })))
}

/// `GET /api/assets/:platform/:filename` — serve previously ingested images.
/// No auth (extension pages embed these as `<img>` tags from the conversation
/// host) but localhost-bound and strictly path-validated.
async fn serve_asset(
    Path((platform, filename)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if !config::PLATFORMS.contains(&platform.as_str()) {
        return Err((StatusCode::BAD_REQUEST, "invalid platform".into()));
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err((StatusCode::BAD_REQUEST, "invalid filename".into()));
    }

    let root = config::vault_dir().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let assets = config::assets_dir_in(&root, &platform);
    let path = assets.join(&filename);

    let canonical = path
        .canonicalize()
        .map_err(|_| (StatusCode::NOT_FOUND, "file not found".into()))?;
    let canonical_assets = assets.canonicalize().unwrap_or(assets);
    if !canonical.starts_with(&canonical_assets) {
        return Err((StatusCode::BAD_REQUEST, "invalid path".into()));
    }

    let bytes = std::fs::read(&canonical)
        .map_err(|_| (StatusCode::NOT_FOUND, "file not found".into()))?;

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

/// `GET /connect` — the page the user opens in their browser to hand the
/// extension our auth token. The extension's content script (`connect.js`)
/// reads `<meta name="kept-token">` from this page.
async fn connect_page(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let token = html_escape(&state.token);
    let html = format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="kept-token" content="{token}" />
  <title>Kept CLI — Connect Extension</title>
  <style>
    :root {{ color-scheme: dark; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0b0d10; color: #e6e8eb; margin: 0;
      display: grid; place-items: center; min-height: 100vh; padding: 24px;
    }}
    .card {{
      max-width: 480px; width: 100%;
      background: #14171b; border: 1px solid #23272d; border-radius: 12px;
      padding: 28px;
    }}
    h1 {{ margin: 0 0 8px; font-size: 20px; font-weight: 600; }}
    p {{ color: #a0a4ab; line-height: 1.55; margin: 8px 0; }}
    #kept-status-tag {{
      display: inline-block; padding: 3px 10px; border-radius: 999px;
      font-size: 12px; background: #2a2e35; color: #cfd2d8;
    }}
    #kept-status-tag.connected {{ background: rgba(74,222,128,.12); color: #4ade80; }}
    #kept-status-tag.not-found {{ background: rgba(248,113,113,.12); color: #f87171; }}
    code {{ background: #1c2025; padding: 1px 6px; border-radius: 4px; font-size: 12px; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Kept CLI</h1>
    <p>Status: <span id="kept-status-tag">checking…</span></p>
    <p id="kept-connect-detail">Looking for the Kept browser extension…</p>
    <div id="kept-install-section" style="display:none">
      <p>The extension wasn't detected. Install it from the <code>extension/</code> folder of the Kept repo (Developer Mode → Load unpacked), then reload this page.</p>
    </div>
  </div>
  <script>
    setTimeout(function() {{
      var t = document.getElementById('kept-status-tag');
      if (t && t.textContent === 'checking…') {{
        t.className = 'not-found'; t.textContent = 'not detected';
        document.getElementById('kept-connect-detail').textContent =
          'No response from the Kept extension — install it and reload.';
        document.getElementById('kept-install-section').style.display = 'block';
      }}
    }}, 800);
  </script>
</body>
</html>"##,
        token = token
    );
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

pub fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/ping", get(ping))
        .route("/api/ingest", post(ingest))
        .route("/api/extension_ping", post(extension_ping))
        .route("/api/assets/:platform/:filename", get(serve_asset))
        .route("/connect", get(connect_page))
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(cors)
        .with_state(state)
}

/// Bind to localhost on `port` and serve until ctrl-c. Tries IPv4 first;
/// falls back gracefully if IPv6 loopback isn't available.
pub async fn serve(state: Arc<AppState>, port: u16) -> Result<(), String> {
    let router = build_router(state);

    let v4 = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{}: {} — is another Kept already running?", port, e))?;

    let v6 = tokio::net::TcpListener::bind(("::1", port)).await;
    match &v6 {
        Ok(_) => log::info!("listening on http://127.0.0.1:{} and http://[::1]:{}", port, port),
        Err(e) => log::warn!(
            "IPv6 loopback unavailable ({}), listening on http://127.0.0.1:{} only",
            e,
            port
        ),
    }

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        log::info!("shutting down");
    };

    if let Ok(v6) = v6 {
        let app = router.clone();
        tokio::select! {
            res = axum::serve(v4, router).with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            }) => res.map_err(|e| format!("server error (v4): {}", e))?,
            res = axum::serve(v6, app).with_graceful_shutdown(async {
                // Second listener also waits for ctrl-c; tokio::signal::ctrl_c
                // is broadcast so both branches fire and the select returns.
                let _ = tokio::signal::ctrl_c().await;
            }) => res.map_err(|e| format!("server error (v6): {}", e))?,
        }
    } else {
        axum::serve(v4, router)
            .with_graceful_shutdown(shutdown)
            .await
            .map_err(|e| format!("server error: {}", e))?;
    }

    Ok(())
}
