//! Obsidian export: copy Kept vault .md files into a user-chosen Obsidian vault.
//!
//! Two entry points:
//! - `export_vault(dest)` — synchronous, called by the manual Sync button.
//! - `request_auto_sync()` — debounced background trigger, called from
//!   `vault::save_conversation` after every successful ingest.
//!
//! Copies are **incremental**: a file is skipped if the destination already
//! exists with the same size and an mtime ≥ the source's. This both speeds
//! up repeat syncs and preserves any user-side edits made inside Obsidian
//! (they survive until the source-of-truth in Kept is updated).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use walkdir::WalkDir;

use crate::config::{read_config, vault_dir, write_config};
use crate::state::now_ms;

#[derive(Debug, Serialize)]
pub struct ValidationResult {
    pub exists: bool,
    pub is_vault: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub files_copied: u32,
    pub files_skipped: u32,
    pub duration_ms: u64,
}

pub fn validate_vault_path(path: &str) -> ValidationResult {
    let p = Path::new(path);
    ValidationResult {
        exists: p.is_dir(),
        is_vault: p.join(".obsidian").is_dir(),
    }
}

/// Core export — pure over `source_root` so it can be unit-tested without
/// touching `~/.kept/vault/`. Walks `source_root` for `.md` files and copies
/// each into `{dest_path}/Kept/{relative_path}`. Incremental: skips files
/// where the destination already has the same size and an mtime ≥ source.
///
/// Errors out early if `{dest_path}/.obsidian/` does not exist.
pub fn export_vault_from(source_root: &Path, dest_path: &str) -> Result<ExportResult, String> {
    let start = std::time::Instant::now();
    let dest = Path::new(dest_path);

    if !dest.join(".obsidian").is_dir() {
        return Err(format!(
            "Not an Obsidian vault: missing .obsidian/ directory at {dest_path}"
        ));
    }

    let kept_root: PathBuf = dest.join("Kept");
    let mut copied: u32 = 0;
    let mut skipped: u32 = 0;

    for entry in WalkDir::new(source_root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }

        let rel = p
            .strip_prefix(source_root)
            .map_err(|e| format!("Strip prefix failed for {p:?}: {e}"))?;
        let target = kept_root.join(rel);

        if dest_is_up_to_date(p, &target) {
            skipped += 1;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Create dir {parent:?} failed: {e}"))?;
        }
        fs::copy(p, &target).map_err(|e| format!("Copy {p:?} → {target:?} failed: {e}"))?;
        copied += 1;
    }

    Ok(ExportResult {
        files_copied: copied,
        files_skipped: skipped,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Returns true if `dest` already has the same size as `src` and a modified
/// time at least as recent as `src`'s. Any I/O failure → false (fall through
/// to a real copy, which is the safe choice).
fn dest_is_up_to_date(src: &Path, dest: &Path) -> bool {
    let (src_meta, dst_meta) = match (src.metadata(), dest.metadata()) {
        (Ok(s), Ok(d)) => (s, d),
        _ => return false,
    };
    if src_meta.len() != dst_meta.len() {
        return false;
    }
    match (src_meta.modified(), dst_meta.modified()) {
        (Ok(s), Ok(d)) => d >= s,
        _ => false,
    }
}

/// Public entry point called by the Tauri command. Runs the core export and,
/// on success, persists `dest_path` plus the sync timestamp to config so the
/// UI can display "last synced …" without needing extra round-trips.
/// Config-save failures are logged and swallowed so the user still sees
/// success when the actual copy worked.
pub fn export_vault(dest_path: &str) -> Result<ExportResult, String> {
    let source_root = vault_dir()?;
    let result = export_vault_from(&source_root, dest_path)?;

    if let Err(e) = persist_sync_state(dest_path) {
        log::warn!("Failed to persist Obsidian sync state to config: {e}");
    }

    Ok(result)
}

fn persist_sync_state(path: &str) -> Result<(), String> {
    let mut config = read_config()?;
    config.obsidian_vault_path = Some(path.to_string());
    config.obsidian_last_sync_at = Some(chrono::Utc::now().to_rfc3339());
    write_config(&config)
}

// ── Debounced auto-sync trigger ──────────────────────────────────────────
//
// Called from `vault::save_conversation` on every successful, non-skipped
// write. We coalesce bursts of ingests (e.g. an extension-driven backlog
// import of 50 conversations) into a single export run by debouncing
// requests for `DEBOUNCE_MS` of quiet time.

const DEBOUNCE_MS: u64 = 5_000;
const POLL_INTERVAL: Duration = Duration::from_millis(1_000);

static LAST_REQUEST_MS: AtomicU64 = AtomicU64::new(0);
static WORKER_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Request a debounced auto-sync. Cheap to call; bails out fast if the user
/// hasn't configured a vault path or has explicitly disabled auto-sync.
/// Spawns at most one background worker thread at a time.
pub fn request_auto_sync() {
    if !auto_sync_enabled() {
        return;
    }

    LAST_REQUEST_MS.store(now_ms(), Ordering::Relaxed);

    if WORKER_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        std::thread::spawn(run_debounce_worker);
    }
}

fn auto_sync_enabled() -> bool {
    let cfg = match read_config() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let path_set = cfg
        .obsidian_vault_path
        .as_deref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    if !path_set {
        return false;
    }
    // Treat None as enabled by default once a path is configured; user
    // opts out by setting `obsidian_auto_sync = false`.
    cfg.obsidian_auto_sync != Some(false)
}

fn run_debounce_worker() {
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let last = LAST_REQUEST_MS.load(Ordering::Relaxed);
        if now_ms().saturating_sub(last) < DEBOUNCE_MS {
            continue;
        }

        // Re-read config in case the user changed the path or disabled
        // auto-sync between request and quiet-window expiry.
        let cfg = read_config().unwrap_or_default();
        let path = cfg.obsidian_vault_path.clone();
        let enabled = cfg.obsidian_auto_sync != Some(false);

        if let Some(p) = path.filter(|p| !p.trim().is_empty()) {
            if enabled {
                match export_vault(&p) {
                    Ok(res) => log::info!(
                        "Auto Obsidian sync: copied {} / skipped {} ({}ms)",
                        res.files_copied,
                        res.files_skipped,
                        res.duration_ms
                    ),
                    Err(e) => log::warn!("Auto Obsidian sync failed: {e}"),
                }
            }
        }

        // Release the worker slot. If another request bumped LAST_REQUEST_MS
        // while we were syncing, loop and let the next iteration handle it.
        WORKER_ACTIVE.store(false, Ordering::Relaxed);
        let after = LAST_REQUEST_MS.load(Ordering::Relaxed);
        if after > last
            && WORKER_ACTIVE
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            continue;
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_returns_false_for_missing_path() {
        let res = validate_vault_path("/definitely/not/a/real/path/xyz123");
        assert!(!res.exists);
        assert!(!res.is_vault);
    }

    #[test]
    fn validate_returns_exists_but_not_vault_for_empty_folder() {
        let dir = TempDir::new().unwrap();
        let res = validate_vault_path(dir.path().to_str().unwrap());
        assert!(res.exists);
        assert!(!res.is_vault);
    }

    #[test]
    fn validate_returns_is_vault_when_dot_obsidian_present() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".obsidian")).unwrap();
        let res = validate_vault_path(dir.path().to_str().unwrap());
        assert!(res.exists);
        assert!(res.is_vault);
    }

    #[test]
    fn export_rejects_non_vault_dest() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        // No .obsidian in dest.
        let result = export_vault_from(src.path(), dest.path().to_str().unwrap());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".obsidian"));
    }

    #[test]
    fn export_copies_md_files_preserving_subdirs() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir(dest.path().join(".obsidian")).unwrap();

        // Synthetic vault layout.
        fs::create_dir_all(src.path().join("chatgpt")).unwrap();
        fs::create_dir_all(src.path().join("claude")).unwrap();
        fs::write(src.path().join("chatgpt/a.md"), "# A").unwrap();
        fs::write(src.path().join("chatgpt/b.md"), "# B").unwrap();
        fs::write(src.path().join("claude/c.md"), "# C").unwrap();

        let result = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(result.files_copied, 3);
        assert_eq!(result.files_skipped, 0);

        assert_eq!(fs::read_to_string(dest.path().join("Kept/chatgpt/a.md")).unwrap(), "# A");
        assert_eq!(fs::read_to_string(dest.path().join("Kept/chatgpt/b.md")).unwrap(), "# B");
        assert_eq!(fs::read_to_string(dest.path().join("Kept/claude/c.md")).unwrap(), "# C");
    }

    #[test]
    fn export_skips_non_md_files() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir(dest.path().join(".obsidian")).unwrap();

        fs::create_dir_all(src.path().join("chatgpt/assets")).unwrap();
        fs::write(src.path().join("chatgpt/a.md"), "# A").unwrap();
        fs::write(src.path().join("chatgpt/assets/img.png"), b"\x89PNG\r\n").unwrap();
        fs::write(src.path().join("chatgpt/notes.txt"), "skip me").unwrap();

        let result = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(result.files_copied, 1);
        assert!(dest.path().join("Kept/chatgpt/a.md").exists());
        assert!(!dest.path().join("Kept/chatgpt/assets/img.png").exists());
        assert!(!dest.path().join("Kept/chatgpt/notes.txt").exists());
    }

    #[test]
    fn export_overwrites_existing_dest_files() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir(dest.path().join(".obsidian")).unwrap();

        // Pre-existing destination file with different content (and older mtime).
        fs::create_dir_all(dest.path().join("Kept/chatgpt")).unwrap();
        fs::write(dest.path().join("Kept/chatgpt/a.md"), "OLD").unwrap();
        // Wait long enough that filesystem mtime granularity (1s on macOS HFS,
        // ~10ms on most others) reliably distinguishes the two writes.
        std::thread::sleep(Duration::from_millis(1100));

        fs::create_dir_all(src.path().join("chatgpt")).unwrap();
        fs::write(src.path().join("chatgpt/a.md"), "NEW LONGER").unwrap();

        let result = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(result.files_copied, 1);
        assert_eq!(fs::read_to_string(dest.path().join("Kept/chatgpt/a.md")).unwrap(), "NEW LONGER");
    }

    #[test]
    fn export_succeeds_with_empty_source() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir(dest.path().join(".obsidian")).unwrap();

        let result = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(result.files_copied, 0);
        assert_eq!(result.files_skipped, 0);
    }

    #[test]
    fn second_export_skips_unchanged_files() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir(dest.path().join(".obsidian")).unwrap();
        fs::create_dir_all(src.path().join("chatgpt")).unwrap();
        fs::write(src.path().join("chatgpt/a.md"), "stable").unwrap();
        fs::write(src.path().join("chatgpt/b.md"), "stable").unwrap();

        let first = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(first.files_copied, 2);
        assert_eq!(first.files_skipped, 0);

        let second = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(second.files_copied, 0);
        assert_eq!(second.files_skipped, 2);
    }

    #[test]
    fn second_export_recopies_when_source_changes() {
        let src = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        fs::create_dir(dest.path().join(".obsidian")).unwrap();
        fs::create_dir_all(src.path().join("chatgpt")).unwrap();
        fs::write(src.path().join("chatgpt/a.md"), "v1").unwrap();
        fs::write(src.path().join("chatgpt/b.md"), "stable").unwrap();

        let first = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(first.files_copied, 2);

        // Bump mtime + size on a.md so it looks "changed".
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(src.path().join("chatgpt/a.md"), "v2 longer content").unwrap();

        let second = export_vault_from(src.path(), dest.path().to_str().unwrap()).unwrap();
        assert_eq!(second.files_copied, 1);
        assert_eq!(second.files_skipped, 1);
        assert_eq!(
            fs::read_to_string(dest.path().join("Kept/chatgpt/a.md")).unwrap(),
            "v2 longer content"
        );
    }
}
