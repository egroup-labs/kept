#!/usr/bin/env python3
"""
Mock Anthropic Messages API that responds with HTTP 429 (rate limit) for
every request. Tracks call frequency and prints a running tally to stderr.

Used to verify that the idle digest summarizer does NOT keep hammering a
hosted-LLM API when the user's key is being rate-limited — the original
bug behind #4.

Usage
-----

    # Terminal A: start the mock on http://127.0.0.1:18242
    python3 scripts/mock-anthropic-429.py

    # Terminal B: launch the Kept dev app pointed at the mock
    KEPT_ANTHROPIC_BASE_URL=http://127.0.0.1:18242 npm run tauri dev

Then configure an Anthropic key in Settings (any non-empty string works
since the mock ignores it), set the chat model to anthropic / sonnet,
and wait. The mock should see a small bounded number of requests over
the first few minutes, NOT an open-ended flood.

Expected with the fix on `fix/digest-runaway-retries`:
  - First ~5 minutes: ~4 requests per minute per candidate batch
    (PER_TICK_CAP=4, 6s spacing → one tick clears in ~25s, then 35s
    of quiet until the next tick).
  - After all rows have been failure-tagged: zero requests until each
    row's `next_retry_at` elapses (30min for the first rate-limit
    failure, doubling per consecutive failure up to 6h).
  - After 3 consecutive all-rate-limited ticks: the circuit breaker
    kicks in and pauses the loop for 1 hour. Log line in the Kept app:
    "Idle summarizer: pausing for 3600s after 3 consecutive
    rate-limited ticks".
  - After 3 days of no successful summary: auto-halt persists to
    config, no further requests until cmd_resume_idle_summarizer is
    called. Log line: "Idle summarizer auto-halted".

If you see request rates that look like one-per-second sustained over
many minutes, something is wrong — file an issue.

Exit with Ctrl-C; the script prints a final summary.
"""

import datetime as dt
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

HOST = "127.0.0.1"
PORT = 18242

# Mimics the real Anthropic 429 body so the Rust-side error-classification
# string-matching in commands::classify_digest_error sees "rate_limit_error"
# and tags the row correctly.
RATE_LIMIT_BODY = json.dumps({
    "type": "error",
    "error": {
        "type": "rate_limit_error",
        "message": (
            "[MOCK] This request would exceed your organization's rate "
            "limit of 30,000 input tokens per minute. For details, refer "
            "to: https://docs.claude.com/en/api/rate-limits. You can see "
            "the response headers for current usage. Please reduce the "
            "prompt length or the maximum tokens requested, or try again "
            "later."
        ),
    },
}).encode("utf-8")


class Counter:
    def __init__(self) -> None:
        self.total = 0
        self.by_minute: dict[str, int] = {}
        self.started_at = time.monotonic()
        self.first_call_at: float | None = None
        self.last_call_at: float | None = None
        self._lock = Lock()

    def bump(self) -> tuple[int, str]:
        now = time.monotonic()
        with self._lock:
            self.total += 1
            if self.first_call_at is None:
                self.first_call_at = now
            self.last_call_at = now
            stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
            self.by_minute[stamp] = self.by_minute.get(stamp, 0) + 1
            return self.total, stamp

    def summary(self) -> str:
        lines = ["", "── mock-anthropic-429 summary ──"]
        lines.append(f"total requests: {self.total}")
        if self.first_call_at is not None and self.last_call_at is not None:
            span = self.last_call_at - self.first_call_at
            lines.append(f"elapsed (first → last): {span:.1f}s")
            if span > 0:
                lines.append(f"average rate: {self.total / span:.2f} req/s")
        lines.append("per-minute breakdown:")
        for minute, count in sorted(self.by_minute.items()):
            lines.append(f"  {minute}  {count}")
        return "\n".join(lines)


COUNTER = Counter()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 — http.server naming
        length = int(self.headers.get("Content-Length", "0"))
        # Drain the body so the connection closes cleanly. We don't actually
        # parse it; the mock is rate-limit-only.
        if length > 0:
            self.rfile.read(length)
        total, minute = COUNTER.bump()
        sys.stderr.write(f"[{minute}] 429 #{total} → {self.path}\n")
        sys.stderr.flush()
        self.send_response(429)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(RATE_LIMIT_BODY)))
        # Anthropic also sets these on 429 — included for realism so any
        # future header-driven backoff logic can pick them up.
        self.send_header("retry-after", "60")
        self.send_header("anthropic-ratelimit-input-tokens-remaining", "0")
        self.send_header("anthropic-ratelimit-input-tokens-reset", "60")
        self.end_headers()
        self.wfile.write(RATE_LIMIT_BODY)

    def log_message(self, *args: object) -> None:  # silence default logs
        return


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"mock-anthropic-429: listening on http://{HOST}:{PORT}", file=sys.stderr)
    print(
        "point Kept at this server with:\n"
        f"    KEPT_ANTHROPIC_BASE_URL=http://{HOST}:{PORT} npm run tauri dev\n",
        file=sys.stderr,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(COUNTER.summary(), file=sys.stderr)
        server.server_close()


if __name__ == "__main__":
    main()
