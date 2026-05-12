use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;

use crate::config::db_path;
use crate::models::{ConversationMeta, DigestItem, IngestPayload, SearchResult};

pub struct Database {
    conn: Mutex<Connection>,
}

/// Exponential backoff schedule for a failed digest attempt.
/// Returns `min(base × 2^(count − 1), max)` saturating at `i64::MAX`. Negative
/// or zero counts collapse to `base.min(max)`. The bit shift is clamped at 30
/// so `1 << shift` never overflows even for absurd counts.
pub(crate) fn exponential_backoff_minutes(base: i64, max: i64, failure_count: i64) -> i64 {
    let base = base.max(0);
    let max = max.max(base);
    if failure_count <= 1 {
        return base.min(max);
    }
    let shift = (failure_count - 1).clamp(0, 30) as u32;
    let multiplier = 1_i64 << shift;
    base.saturating_mul(multiplier).min(max)
}

fn normalize_fts_query(query: &str) -> String {
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>()
        .join(" AND ")
}

impl Database {
    /// Open (or create) the SQLite database and initialize schema.
    pub fn init() -> Result<Self, String> {
        let path = db_path()?;
        let conn = Connection::open(&path)
            .map_err(|e| format!("Failed to open database at {:?}: {}", path, e))?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| format!("Failed to set WAL mode: {}", e))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("Failed to enable foreign keys: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
                id              INTEGER PRIMARY KEY,
                conversation_id TEXT NOT NULL UNIQUE,
                platform        TEXT NOT NULL,
                title           TEXT NOT NULL,
                model           TEXT,
                message_count   INTEGER DEFAULT 0,
                file_path       TEXT NOT NULL,
                content_hash    TEXT NOT NULL,
                created_at      TEXT,
                updated_at      TEXT,
                indexed_at      TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY,
                conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                timestamp       TEXT,
                position        INTEGER NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content, role UNINDEXED, conversation_id UNINDEXED,
                tokenize='porter unicode61'
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conv_role_pos
            ON messages(conversation_id, role, position);

            CREATE TABLE IF NOT EXISTS digest_items (
                id               INTEGER PRIMARY KEY,
                conversation_id  TEXT NOT NULL UNIQUE,
                status           TEXT NOT NULL DEFAULT 'active',
                reason           TEXT NOT NULL DEFAULT 'stale',
                summary          TEXT,
                last_role        TEXT,
                days_inactive    INTEGER,
                snoozed_until    TEXT,
                is_unresolved    INTEGER,         -- NULL = not yet summarized, 1 = yes, 0 = no
                attention_reason TEXT,            -- LLM-authored human reason (replaces enum when set)
                seen_at          TEXT,            -- first time the user saw this card
                created_at       TEXT DEFAULT (datetime('now')),
                updated_at       TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_digest_items_status
            ON digest_items(status);",
        )
        .map_err(|e| format!("Failed to create schema: {}", e))?;

        // Migrations for digest_items: add columns if missing (idempotent).
        for (col, typ) in [
            ("is_unresolved", "INTEGER"),
            ("attention_reason", "TEXT"),
            ("seen_at", "TEXT"),
            ("next_retry_at", "TEXT"),
            ("error_kind", "TEXT"),
            ("failure_count", "INTEGER"),
        ] {
            let exists: bool = conn
                .prepare(&format!("SELECT {} FROM digest_items LIMIT 0", col))
                .is_ok();
            if !exists {
                conn.execute_batch(&format!(
                    "ALTER TABLE digest_items ADD COLUMN {} {};",
                    col, typ
                ))
                .map_err(|e| format!("Failed to add digest column {}: {}", col, e))?;
            }
        }

        // Migration: add preview column to conversations (idempotent)
        let has_preview: bool = conn
            .prepare("SELECT preview FROM conversations LIMIT 0")
            .is_ok();
        if !has_preview {
            conn.execute_batch("ALTER TABLE conversations ADD COLUMN preview TEXT;")
                .map_err(|e| format!("Failed to add preview column: {}", e))?;

            // Backfill preview for existing rows
            conn.execute_batch(
                "UPDATE conversations SET preview = SUBSTR(
                    (SELECT m.content FROM messages m
                     WHERE m.conversation_id = conversations.id AND m.role = 'user'
                     ORDER BY m.position LIMIT 1), 1, 200
                ) WHERE preview IS NULL;",
            )
            .map_err(|e| format!("Failed to backfill previews: {}", e))?;
        }

        // Migration: recount message_count to only include user/assistant messages
        conn.execute_batch(
            "UPDATE conversations SET message_count = (
                SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = conversations.id
                  AND m.role IN ('user', 'assistant')
            );",
        )
        .map_err(|e| format!("Failed to recount messages: {}", e))?;

        log::info!("Database initialized at {:?}", path);
        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    /// Upsert a conversation and its messages into the database.
    /// Returns true if the conversation was actually inserted/updated (not skipped).
    pub fn upsert_conversation(
        &self,
        payload: &IngestPayload,
        file_path: &str,
        content_hash: &str,
    ) -> Result<bool, String> {
        let mut conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;

        // Check if conversation exists with same hash
        let existing_hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM conversations WHERE conversation_id = ?1",
                params![payload.conversation_id],
                |row| row.get(0),
            )
            .ok();

        if existing_hash.as_deref() == Some(content_hash) {
            return Ok(false); // No changes
        }

        // Wrap delete+insert in a transaction for atomicity
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;

        // Delete old data if updating
        if existing_hash.is_some() {
            let old_id: i64 = tx
                .query_row(
                    "SELECT id FROM conversations WHERE conversation_id = ?1",
                    params![payload.conversation_id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to get old conversation id: {}", e))?;

            tx.execute(
                "DELETE FROM messages_fts WHERE conversation_id = ?1",
                params![old_id.to_string()],
            )
            .map_err(|e| format!("Failed to delete old FTS entries: {}", e))?;

            tx.execute(
                "DELETE FROM messages WHERE conversation_id = ?1",
                params![old_id],
            )
            .map_err(|e| format!("Failed to delete old messages: {}", e))?;

            tx.execute("DELETE FROM conversations WHERE id = ?1", params![old_id])
                .map_err(|e| format!("Failed to delete old conversation: {}", e))?;
        }

        // Insert conversation
        tx.execute(
            "INSERT INTO conversations (conversation_id, platform, title, model, message_count, file_path, content_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                payload.conversation_id,
                payload.platform,
                payload.title,
                payload.model,
                payload.messages.iter().filter(|m| m.role == "user" || m.role == "assistant").count() as i64,
                file_path,
                content_hash,
                payload.created_at,
                payload.updated_at,
            ],
        )
        .map_err(|e| format!("Failed to insert conversation: {}", e))?;

        let conv_db_id = tx.last_insert_rowid();

        // Insert messages and FTS entries
        let mut preview: Option<String> = None;
        for (i, msg) in payload.messages.iter().enumerate() {
            tx.execute(
                "INSERT INTO messages (conversation_id, role, content, timestamp, position)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![conv_db_id, msg.role, msg.content, msg.timestamp, i as i64],
            )
            .map_err(|e| format!("Failed to insert message: {}", e))?;

            tx.execute(
                "INSERT INTO messages_fts (content, role, conversation_id)
                 VALUES (?1, ?2, ?3)",
                params![msg.content, msg.role, conv_db_id.to_string()],
            )
            .map_err(|e| format!("Failed to insert FTS entry: {}", e))?;

            // Capture preview from the first user message
            if preview.is_none() && msg.role == "user" {
                preview = Some(msg.content.chars().take(200).collect());
            }
        }

        // Store denormalized preview on the conversation row
        if let Some(ref p) = preview {
            tx.execute(
                "UPDATE conversations SET preview = ?1 WHERE id = ?2",
                params![p, conv_db_id],
            )
            .map_err(|e| format!("Failed to update preview: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        log::info!(
            "Indexed conversation '{}' ({} messages)",
            payload.title,
            payload.messages.len()
        );
        Ok(true)
    }

    /// List all conversations, ordered by created_at descending.
    pub fn list_conversations(
        &self,
        platform: Option<&str>,
    ) -> Result<Vec<ConversationMeta>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;

        let (sql, params_vec): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match platform {
            Some(p) => (
                "SELECT c.id, c.conversation_id, c.platform, c.title, c.model, c.message_count,
                        c.file_path, c.content_hash, c.created_at, c.updated_at, c.indexed_at,
                        c.preview
                 FROM conversations c WHERE c.platform = ?1
                 ORDER BY c.created_at DESC",
                vec![Box::new(p.to_string())],
            ),
            None => (
                "SELECT c.id, c.conversation_id, c.platform, c.title, c.model, c.message_count,
                        c.file_path, c.content_hash, c.created_at, c.updated_at, c.indexed_at,
                        c.preview
                 FROM conversations c
                 ORDER BY c.created_at DESC",
                vec![],
            ),
        };

        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(ConversationMeta {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    platform: row.get(2)?,
                    title: row.get(3)?,
                    model: row.get(4)?,
                    message_count: row.get(5)?,
                    file_path: row.get(6)?,
                    content_hash: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    indexed_at: row.get(10)?,
                    preview: row.get(11)?,
                })
            })
            .map_err(|e| format!("Failed to query conversations: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(result)
    }

    /// Delete a conversation by file_path (removes DB entries and vault file).
    pub fn delete_conversation_by_path(&self, file_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, conversation_id FROM conversations WHERE file_path = ?1",
                params![file_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("Query error: {}", e))?;
        if let Some((id, _conv_id)) = row {
            conn.execute("DELETE FROM messages_fts WHERE conversation_id = ?1", params![id.to_string()])
                .map_err(|e| format!("FTS delete error: {}", e))?;
            conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])
                .map_err(|e| format!("Messages delete error: {}", e))?;
            conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
                .map_err(|e| format!("Conversation delete error: {}", e))?;
        }
        // Delete the vault file
        let _ = std::fs::remove_file(file_path);
        Ok(())
    }

    /// Rename a conversation's title in the DB.
    pub fn rename_conversation(&self, file_path: &str, new_title: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE conversations SET title = ?1 WHERE file_path = ?2",
            params![new_title, file_path],
        )
        .map_err(|e| format!("Update error: {}", e))?;
        Ok(())
    }

    /// Look up conversation_id by file_path.
    pub fn get_conversation_id_by_path(&self, file_path: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT conversation_id FROM conversations WHERE file_path = ?1",
            rusqlite::params![file_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Query error: {}", e))
    }

    /// Full-text search across messages.
    pub fn search(&self, query: &str, limit: i64) -> Result<Vec<SearchResult>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let normalized_query = normalize_fts_query(query);
        if normalized_query.is_empty() {
            return Ok(Vec::new());
        }

        let mut stmt = conn
            .prepare(
                "SELECT
                    c.conversation_id,
                    c.platform,
                    c.title,
                    c.file_path,
                    snippet(messages_fts, 0, '<mark>', '</mark>', '...', 40) as snippet,
                    messages_fts.role,
                    rank
                 FROM messages_fts
                 JOIN conversations c ON c.id = CAST(messages_fts.conversation_id AS INTEGER)
                 WHERE messages_fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare search query: {}", e))?;

        let rows = stmt
            .query_map(params![normalized_query, limit], |row| {
                Ok(SearchResult {
                    conversation_id: row.get(0)?,
                    platform: row.get(1)?,
                    title: row.get(2)?,
                    file_path: row.get(3)?,
                    snippet: row.get(4)?,
                    role: row.get(5)?,
                    rank: row.get(6)?,
                })
            })
            .map_err(|e| format!("Failed to execute search: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Failed to read search result: {}", e))?);
        }
        Ok(result)
    }

    /// Get conversations by their conversation_id values (for cross-DB queries).
    pub fn get_conversations_by_ids(
        &self,
        conv_ids: &[String],
    ) -> Result<Vec<ConversationMeta>, String> {
        if conv_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let placeholders: String = conv_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, conversation_id, platform, title, model, message_count, file_path, content_hash, created_at, updated_at, indexed_at
             FROM conversations WHERE conversation_id IN ({})
             ORDER BY created_at DESC",
            placeholders
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let params: Vec<Box<dyn rusqlite::types::ToSql>> = conv_ids
            .iter()
            .map(|id| Box::new(id.clone()) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(ConversationMeta {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    platform: row.get(2)?,
                    title: row.get(3)?,
                    model: row.get(4)?,
                    message_count: row.get(5)?,
                    file_path: row.get(6)?,
                    content_hash: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    indexed_at: row.get(10)?,
                    preview: None,
                })
            })
            .map_err(|e| format!("Failed to query conversations: {}", e))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
        }
        Ok(result)
    }

    /// Reindex all vault files (drop and rebuild FTS + messages).
    pub fn clear_all(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute_batch(
            "DELETE FROM messages_fts;
             DELETE FROM messages;
             DELETE FROM conversations;",
        )
        .map_err(|e| format!("Failed to clear database: {}", e))?;
        Ok(())
    }

    // ── Digest methods ───────────────────────────────────────────────────────

    /// Find conversations that have been idle for `idle_minutes` (no activity
    /// since their last update) and don't have a digest_items row yet.
    /// Returns (conversation_id, title, file_path) tuples, capped at `limit`.
    ///
    /// Used by the idle summarizer: "the chat seems done — summarize it".
    pub fn get_idle_unsummarized_conversations(
        &self,
        idle_minutes: i64,
        limit: i64,
    ) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        // A conversation is eligible for the idle summarizer if EITHER:
        //   - it has no digest_items row at all (never attempted), OR
        //   - its row is marked status='error' AND next_retry_at has elapsed
        //     (failed attempt whose backoff window has passed).
        // Any other status — 'pending', 'active', 'snoozed', 'dismissed' — means
        // we already produced a summary (or the user managed the row) and we
        // must NOT re-bill the user's API by re-summarizing. Without this guard,
        // a failure that returned an error from the LLM left the row absent,
        // causing the 60s loop to re-attempt forever.
        let mut stmt = conn.prepare(
            "SELECT c.conversation_id, c.title, c.file_path
             FROM conversations c
             LEFT JOIN digest_items d ON d.conversation_id = c.conversation_id
             WHERE (
                   d.conversation_id IS NULL
                OR (d.status = 'error'
                    AND (d.next_retry_at IS NULL OR d.next_retry_at <= datetime('now')))
             )
               AND c.message_count > 0
               AND (julianday('now') - julianday(COALESCE(c.updated_at, c.created_at))) * 24 * 60 >= ?1
               AND julianday('now') - julianday(COALESCE(c.updated_at, c.created_at)) <= 30
             ORDER BY c.updated_at DESC
             LIMIT ?2",
        ).map_err(|e| format!("Prepare error: {}", e))?;
        let rows = stmt.query_map(params![idle_minutes, limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }).map_err(|e| format!("Query error: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(out)
    }

    /// Record that the idle summarizer tried to summarize this conversation and
    /// failed. Inserts a digest_items row with status='error' so the idle queue
    /// stops re-picking it for at least the computed retry window.
    ///
    /// Retry windows grow exponentially per consecutive failure on the same
    /// conversation: `min(base × 2^(failure_count − 1), max)`. The first
    /// failure waits `base`, the second `2·base`, the third `4·base`, and so
    /// on, until the per-kind cap. This keeps a permanently broken
    /// conversation (e.g. one that always 429s on the user's tier, or always
    /// overflows context) from re-burning the API every hour — after a few
    /// failures it falls back to retrying once a day or less.
    ///
    /// Returns `(applied_minutes, new_failure_count)` so callers can log what
    /// they actually committed.
    ///
    /// `error_kind` is a short tag like "rate_limit", "context_length",
    /// "auth", "transient" — surfaced for diagnostics, not user-facing.
    pub fn record_digest_attempt_failed(
        &self,
        conversation_id: &str,
        error_kind: &str,
        base_retry_minutes: i64,
        max_retry_minutes: i64,
    ) -> Result<(i64, i64), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        // Read the prior failure count for THIS conversation. Other status
        // values ('active', 'snoozed', 'pending', 'dismissed') wouldn't be
        // selected by the idle summarizer in the first place, so they should
        // never reach here — but if they do, we treat the prior count as 0 so
        // we don't trample over their state.
        let prior_count: i64 = conn
            .query_row(
                "SELECT COALESCE(failure_count, 0) FROM digest_items
                 WHERE conversation_id = ?1 AND status = 'error'",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Read failure_count error: {}", e))?
            .unwrap_or(0);
        let new_count = prior_count + 1;
        let applied = exponential_backoff_minutes(base_retry_minutes, max_retry_minutes, new_count);

        conn.execute(
            "INSERT INTO digest_items
                 (conversation_id, status, reason, error_kind, next_retry_at, failure_count)
             VALUES (?1, 'error', 'summary_failed', ?2,
                     datetime('now', ?3), ?4)
             ON CONFLICT(conversation_id) DO UPDATE SET
               status        = CASE
                                 WHEN digest_items.status IN ('active','snoozed','dismissed','pending')
                                   THEN digest_items.status
                                 ELSE 'error'
                               END,
               error_kind    = excluded.error_kind,
               next_retry_at = excluded.next_retry_at,
               failure_count = excluded.failure_count,
               updated_at    = datetime('now')",
            params![
                conversation_id,
                error_kind,
                format!("+{} minutes", applied),
                new_count,
            ],
        ).map_err(|e| format!("Record digest failure error: {}", e))?;
        Ok((applied, new_count))
    }

    /// Return the timestamp at which the idle summarizer entered a
    /// "purely failing" state — defined as the earliest `digest_items` error
    /// row updated since the most recent successful summary (or all-time if
    /// no successful summary exists yet). Returns `None` if there are no
    /// outstanding error rows.
    ///
    /// Used by the auto-halt logic: if this timestamp is older than the
    /// configured halt window, the loop stops calling LLM providers.
    ///
    /// Returns a tuple of (last_success_at, bad_state_started_at) so callers
    /// don't need a second round-trip to render the diagnostic.
    pub fn idle_summarizer_health(&self) -> Result<(Option<String>, Option<String>), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        // MAX/MIN over zero rows in SQLite returns a single NULL row, not "no
        // rows" — so query_row succeeds and we just need to read it as
        // Option<String>.
        let last_success: Option<String> = conn
            .query_row(
                "SELECT MAX(updated_at) FROM digest_items WHERE summary IS NOT NULL",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(|e| format!("Read last success error: {}", e))?;

        let bad_start: Option<String> = match &last_success {
            Some(ts) => conn
                .query_row(
                    "SELECT MIN(updated_at) FROM digest_items
                     WHERE status = 'error' AND updated_at > ?1",
                    params![ts],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(|e| format!("Read bad-state-start error: {}", e))?,
            None => conn
                .query_row(
                    "SELECT MIN(updated_at) FROM digest_items WHERE status = 'error'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(|e| format!("Read bad-state-start error: {}", e))?,
        };

        Ok((last_success, bad_start))
    }

    /// Promote summarized-and-unresolved pending items into visible ('active') state.
    /// Only touches status='pending' rows, leaves user-set states alone. Filters
    /// out conversations older than 30 days (conservative). Returns promoted count.
    pub fn promote_pending_digest_items(&self) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let n = conn.execute(
            "UPDATE digest_items SET status = 'active', updated_at = datetime('now')
             WHERE status = 'pending'
               AND is_unresolved = 1
               AND conversation_id IN (
                 SELECT c.conversation_id FROM conversations c
                 WHERE julianday('now') - julianday(COALESCE(c.updated_at, c.created_at)) <= 30
               )",
            [],
        ).map_err(|e| format!("Promote error: {}", e))?;
        Ok(n)
    }

    /// Insert OR update the summary-side fields of a digest_items row.
    /// On insert: status defaults to 'pending' (invisible until promoted).
    /// On conflict: only updates summary fields — NEVER touches status, snoozed_until, seen_at.
    /// This protects user-set states (dismissed, snoozed) from being clobbered.
    pub fn upsert_digest_judgment(
        &self,
        conversation_id: &str,
        summary: Option<&str>,
        is_unresolved: Option<bool>,
        attention_reason: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let is_unresolved_int: Option<i64> = is_unresolved.map(|b| if b { 1 } else { 0 });
        conn.execute(
            "INSERT INTO digest_items (conversation_id, status, reason, summary, is_unresolved, attention_reason)
             VALUES (?1, 'pending', 'unfinished', ?2, ?3, ?4)
             ON CONFLICT(conversation_id) DO UPDATE SET
               summary = COALESCE(excluded.summary, digest_items.summary),
               is_unresolved = COALESCE(excluded.is_unresolved, digest_items.is_unresolved),
               attention_reason = COALESCE(excluded.attention_reason, digest_items.attention_reason),
               updated_at = datetime('now')",
            params![
                conversation_id,
                summary,
                is_unresolved_int,
                attention_reason,
            ],
        ).map_err(|e| format!("Upsert judgment error: {}", e))?;
        Ok(())
    }

    /// List active digest items. Excludes items the LLM has marked as resolved
    /// (is_unresolved = 0) — unsummarized items (NULL) and confirmed unresolved items (1)
    /// are both shown. Also filters out conversations older than 30 days so
    /// backfilled vaults don't spam Digest with ancient items.
    pub fn list_active_digest_items(&self) -> Result<Vec<DigestItem>, String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT d.conversation_id, c.platform, c.title, c.model, c.message_count,
                    c.file_path, c.preview, c.updated_at, c.created_at,
                    d.status, d.reason, d.summary, d.last_role, d.days_inactive, d.snoozed_until,
                    d.is_unresolved, d.attention_reason, d.seen_at
             FROM digest_items d
             JOIN conversations c ON c.conversation_id = d.conversation_id
             WHERE (d.status = 'active'
                OR (d.status = 'snoozed' AND d.snoozed_until < datetime('now')))
               AND (d.is_unresolved IS NULL OR d.is_unresolved = 1)
               AND julianday('now') - julianday(COALESCE(c.updated_at, c.created_at)) <= 30
             ORDER BY
               CASE d.reason WHEN 'unfinished' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
               c.updated_at DESC"
        ).map_err(|e| format!("Prepare error: {}", e))?;

        let rows = stmt.query_map([], |row| {
            let is_unresolved_raw: Option<i64> = row.get(15)?;
            Ok(DigestItem {
                conversation_id: row.get(0)?,
                platform: row.get(1)?,
                title: row.get(2)?,
                model: row.get(3)?,
                message_count: row.get(4)?,
                file_path: row.get(5)?,
                preview: row.get(6)?,
                updated_at: row.get(7)?,
                created_at: row.get(8)?,
                status: row.get(9)?,
                reason: row.get(10)?,
                summary: row.get(11)?,
                last_role: row.get(12)?,
                days_inactive: row.get(13)?,
                snoozed_until: row.get(14)?,
                is_unresolved: is_unresolved_raw.map(|v| v != 0),
                attention_reason: row.get(16)?,
                seen_at: row.get(17)?,
                project_id: None,
                project_name: None,
                project_hint: None,
                key_topics: None,
                topics: None,
            })
        }).map_err(|e| format!("Query error: {}", e))?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(result)
    }

    /// Update a digest item's status (dismiss or snooze).
    /// Snooze additionally clears seen_at so the card re-appears as NEW when it comes back.
    pub fn update_digest_item_status(
        &self,
        conversation_id: &str,
        status: &str,
        snoozed_until: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        if status == "snoozed" {
            conn.execute(
                "UPDATE digest_items SET status = ?1, snoozed_until = ?2, seen_at = NULL, updated_at = datetime('now')
                 WHERE conversation_id = ?3",
                params![status, snoozed_until, conversation_id],
            ).map_err(|e| format!("Update error: {}", e))?;
        } else {
            conn.execute(
                "UPDATE digest_items SET status = ?1, snoozed_until = ?2, updated_at = datetime('now')
                 WHERE conversation_id = ?3",
                params![status, snoozed_until, conversation_id],
            ).map_err(|e| format!("Update error: {}", e))?;
        }
        Ok(())
    }

    /// Stamp `seen_at = now` for each given conversation_id that currently has no seen_at.
    /// Idempotent — items already seen keep their original timestamp.
    pub fn mark_digest_items_seen(&self, conv_ids: &[String]) -> Result<usize, String> {
        if conv_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut count = 0;
        for cid in conv_ids {
            let n = conn.execute(
                "UPDATE digest_items SET seen_at = datetime('now')
                 WHERE conversation_id = ?1 AND seen_at IS NULL",
                params![cid],
            ).map_err(|e| format!("Mark seen error: {}", e))?;
            count += n;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::{exponential_backoff_minutes, normalize_fts_query};

    #[test]
    fn normalizes_free_form_search_into_safe_fts_terms() {
        assert_eq!(normalize_fts_query("file:test"), "file AND test");
        assert_eq!(normalize_fts_query("Claude - file:path"), "claude AND file AND path");
        assert_eq!(normalize_fts_query("   "), "");
    }

    #[test]
    fn first_failure_uses_base_window() {
        assert_eq!(exponential_backoff_minutes(30, 6 * 60, 1), 30);
    }

    #[test]
    fn windows_double_per_consecutive_failure() {
        // base=30, max=6h=360 → 30, 60, 120, 240, capped at 360
        assert_eq!(exponential_backoff_minutes(30, 360, 1), 30);
        assert_eq!(exponential_backoff_minutes(30, 360, 2), 60);
        assert_eq!(exponential_backoff_minutes(30, 360, 3), 120);
        assert_eq!(exponential_backoff_minutes(30, 360, 4), 240);
        assert_eq!(exponential_backoff_minutes(30, 360, 5), 360);
        assert_eq!(exponential_backoff_minutes(30, 360, 6), 360);
    }

    #[test]
    fn caps_at_max_for_high_counts() {
        // A conversation that has failed 50 times should be retried at max,
        // not produce arithmetic overflow or panic.
        assert_eq!(exponential_backoff_minutes(60, 24 * 60, 50), 24 * 60);
    }

    #[test]
    fn auth_fixed_window_when_base_equals_max() {
        // For auth failures we configure base == max (no exponential), so the
        // retry window is constant regardless of count.
        let day = 24 * 60;
        assert_eq!(exponential_backoff_minutes(day, day, 1), day);
        assert_eq!(exponential_backoff_minutes(day, day, 7), day);
    }

    #[test]
    fn zero_or_negative_count_falls_back_to_base() {
        assert_eq!(exponential_backoff_minutes(30, 360, 0), 30);
        assert_eq!(exponential_backoff_minutes(30, 360, -5), 30);
    }
}
