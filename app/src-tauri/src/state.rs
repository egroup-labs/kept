use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static EXTENSION_LAST_PING_MS: AtomicU64 = AtomicU64::new(0);
static SYNC_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Max conversations to ingest during this sync (0 = unlimited).
static SYNC_LIMIT: AtomicU32 = AtomicU32::new(0);
/// How many non-skipped conversations have been ingested in the current sync.
static SYNC_INGESTED: AtomicU32 = AtomicU32::new(0);
/// Whether the user has requested to stop the current sync.
static SYNC_STOPPED: AtomicBool = AtomicBool::new(false);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn set_extension_ping_now() {
    set_extension_ping_ms(now_ms());
}

pub fn set_extension_ping_ms(ms: u64) {
    EXTENSION_LAST_PING_MS.store(ms, Ordering::Relaxed);
}

pub fn get_extension_last_ping_ms() -> u64 {
    EXTENSION_LAST_PING_MS.load(Ordering::Relaxed)
}

/// Set sync_requested flag (consumed by extension on next ping).
pub fn set_sync_requested(v: bool) {
    SYNC_REQUESTED.store(v, Ordering::Relaxed);
}

/// Consume the sync_requested flag — returns true once, then resets to false.
pub fn take_sync_requested() -> bool {
    SYNC_REQUESTED.swap(false, Ordering::Relaxed)
}

// ── Sync limit / stop gate ──────────────────────────────────────────

/// Begin a new sync session: reset counter, set limit, clear stopped flag.
pub fn begin_sync(limit: u32) {
    SYNC_INGESTED.store(0, Ordering::Relaxed);
    SYNC_LIMIT.store(limit, Ordering::Relaxed);
    SYNC_STOPPED.store(false, Ordering::Relaxed);
}

/// Mark the current sync as stopped by the user.
pub fn stop_sync() {
    SYNC_STOPPED.store(true, Ordering::Relaxed);
}

/// Increment the ingested counter by 1 and return the new count.
pub fn increment_sync_ingested() -> u32 {
    SYNC_INGESTED.fetch_add(1, Ordering::Relaxed) + 1
}

/// Returns `true` if the ingest should be rejected (limit reached or stopped).
pub fn should_reject_ingest() -> bool {
    if SYNC_STOPPED.load(Ordering::Relaxed) {
        return true;
    }
    let limit = SYNC_LIMIT.load(Ordering::Relaxed);
    if limit == 0 {
        return false; // unlimited
    }
    SYNC_INGESTED.load(Ordering::Relaxed) >= limit
}
