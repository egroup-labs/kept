#!/usr/bin/env python3
"""
Seed the local Kept vault with synthetic conversations so the idle digest
summarizer has something to pick up. Used together with
`scripts/mock-anthropic-429.py` to verify the burn-rate fix (#4) on a
machine whose real vault is empty.

What it does
------------
For each seeded conversation:
  1. Writes a markdown file to `~/.kept/vault/mock/burnrate-NNN.md`
     (the loop only reads files via `vault::read_conversation`, so the
     content just has to exist and be reasonably long).
  2. Inserts a row into `conversations` in `~/.kept/index.db` with
     `message_count > 0`, `file_path` pointing at the file, and
     `updated_at` set `--idle-minutes` ago so the
     `(now - updated_at) >= IDLE_MINUTES` filter in
     `get_idle_unsummarized_conversations` passes immediately.
  3. Does NOT touch `digest_items` — leaving those rows absent is
     exactly what makes the conversation eligible for the idle loop.

After seeding, launch the app pointed at the 429 mock and watch the
mock's stderr for the per-tick burst pattern.

Usage
-----
    # Add 5 mock conversations (default), aged 10 minutes
    python3 app/scripts/mock-vault-seed.py

    # Add 20 mock conversations
    python3 app/scripts/mock-vault-seed.py --count 20

    # Make them look 30 minutes idle so they're eligible immediately
    python3 app/scripts/mock-vault-seed.py --idle-minutes 30

    # Wipe everything this script previously seeded (markdown files,
    # conversations rows, and any digest_items rows tied to the seeded
    # conversation_ids). Real user data is untouched because we filter
    # by `conversation_id LIKE 'burnrate-%'`.
    python3 app/scripts/mock-vault-seed.py --reset

You'll usually want `--reset` between test runs so the loop starts
from a clean slate (no leftover status='error' rows with future
next_retry_at suppressing the queue).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import sqlite3
import sys
from pathlib import Path

ID_PREFIX = "burnrate-"
PLATFORM = "mock"
KEPT_HOME = Path(os.environ.get("KEPT_HOME", Path.home() / ".kept"))
DB_PATH = KEPT_HOME / "index.db"
VAULT_DIR = KEPT_HOME / "vault" / PLATFORM


# Long enough that `build_summary_prompt`'s 12_000-char truncation kicks in,
# matching the real-world prompt-size shape we want to bill against. Roughly
# ~3K tokens per call after truncation.
def synthetic_markdown(idx: int) -> str:
    header = (
        f"---\n"
        f"title: Burn-rate test conversation #{idx}\n"
        f"platform: {PLATFORM}\n"
        f"---\n\n"
        f"# Burn-rate test conversation #{idx}\n\n"
    )
    body_unit = (
        "**user:** Pretend we are debugging a slow SQL query in a multi-tenant "
        "Postgres database. The customer reports that the `orders` view is "
        "returning rows from other tenants. We use row-level security with a "
        "`tenant_id` column on every table. Walk me through what could be wrong.\n\n"
        "**assistant:** A few things to check first: confirm that the connection "
        "pool is setting `app.current_tenant_id` via `SET LOCAL` rather than `SET`, "
        "because `SET` persists across transactions when connection pooling reuses "
        "sessions. Then verify the RLS policy on `orders` references the right "
        "setting key. We should also look for any `SECURITY DEFINER` functions in "
        "the query path — those run as the owner, bypassing the caller's row "
        "security context unless `SECURITY INVOKER` is specified.\n\n"
    )
    # Multiply the body so the file is well over 12K chars — matches the
    # real prompt-size profile that the summary call would have sent.
    return header + body_unit * 40


def reset(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    # Delete digest_items first to avoid orphaning. We filter by the same
    # ID prefix the seeder writes; real user rows are untouched.
    cur.execute(
        "DELETE FROM digest_items WHERE conversation_id LIKE ?",
        (f"{ID_PREFIX}%",),
    )
    digest_deleted = cur.rowcount
    cur.execute(
        "DELETE FROM conversations WHERE conversation_id LIKE ?",
        (f"{ID_PREFIX}%",),
    )
    convo_deleted = cur.rowcount
    conn.commit()

    # Markdown files
    files_deleted = 0
    if VAULT_DIR.exists():
        for f in VAULT_DIR.glob(f"{ID_PREFIX}*.md"):
            f.unlink()
            files_deleted += 1
        if not any(VAULT_DIR.iterdir()):
            VAULT_DIR.rmdir()
    print(
        f"reset: removed {convo_deleted} conversations, "
        f"{digest_deleted} digest_items rows, {files_deleted} markdown files",
        file=sys.stderr,
    )


def seed(conn: sqlite3.Connection, count: int, idle_minutes: int) -> None:
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    aged_ts = (
        dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=idle_minutes)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    cur = conn.cursor()
    inserted = 0
    for i in range(1, count + 1):
        conv_id = f"{ID_PREFIX}{i:03d}"
        title = f"Burn-rate test conversation #{i}"
        path = VAULT_DIR / f"{conv_id}.md"
        content = synthetic_markdown(i)
        path.write_text(content, encoding="utf-8")
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        try:
            cur.execute(
                """
                INSERT INTO conversations
                    (conversation_id, platform, title, model, message_count,
                     file_path, content_hash, created_at, updated_at, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    conv_id,
                    PLATFORM,
                    title,
                    "mock-model",
                    2,  # message_count must be > 0 to pass the idle-loop filter
                    str(path),
                    content_hash,
                    aged_ts,
                    aged_ts,
                    aged_ts,
                ),
            )
            inserted += 1
        except sqlite3.IntegrityError:
            # Already exists from a previous seed run; refresh the timestamps
            # so it re-enters the idle window.
            cur.execute(
                """
                UPDATE conversations
                   SET updated_at = ?, indexed_at = ?, content_hash = ?
                 WHERE conversation_id = ?
                """,
                (aged_ts, aged_ts, content_hash, conv_id),
            )
    conn.commit()
    print(
        f"seeded {inserted} new + refreshed any existing, "
        f"aged {idle_minutes} min, vault dir: {VAULT_DIR}",
        file=sys.stderr,
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--count", type=int, default=5, help="Number of mock conversations to insert (default 5)")
    p.add_argument(
        "--idle-minutes",
        type=int,
        default=10,
        help="How many minutes old to make each conversation's updated_at (default 10)",
    )
    p.add_argument(
        "--reset",
        action="store_true",
        help="Delete previously seeded conversations, digest_items, and markdown files",
    )
    args = p.parse_args()

    if not DB_PATH.exists():
        print(
            f"error: {DB_PATH} not found — launch the Kept app at least once "
            f"to initialize the database, then re-run this script.",
            file=sys.stderr,
        )
        return 1

    conn = sqlite3.connect(DB_PATH)
    try:
        if args.reset:
            reset(conn)
        else:
            seed(conn, args.count, args.idle_minutes)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
