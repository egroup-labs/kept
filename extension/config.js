/**
 * config.js
 *
 * Centralised configuration constants for Kept.
 * All tuneable values (page sizes, rate limits, host allowlists, etc.)
 * live here so they can be adjusted in a single place.
 */

// ── Kept App ─────────────────────────────────────────────────────────
export const KEPT_APP_URL = "http://localhost:18241";

// ── Rate Limiting ────────────────────────────────────────────────────
/** Minimum delay between consecutive fetches to the same domain (ms). */
export const RATE_LIMIT_MS = 1_800;

// ── Allowed Fetch Hosts ──────────────────────────────────────────────
export const ALLOWED_FETCH_HOSTS = [
    "chatgpt.com",
    "files.oaiusercontent.com",  // DALL-E image downloads (returned by /backend-api/files/download)
    "claude.ai",
    "gemini.google.com",
    "lh3.googleusercontent.com", // Gemini inline image CDN
    "grok.com",
    "assets.grok.com",           // Grok image attachment CDN
    "www.kimi.com",
    "kimi-img.moonshot.cn",      // Kimi image attachment CDN
];

// ── ChatGPT ──────────────────────────────────────────────────────────
/** Conversations fetched per page. */
export const CHATGPT_PAGE_SIZE = 100;

// ── Claude ──────────────────────────────────────────────────────
/** Conversations fetched per page. */
export const CLAUDE_PAGE_SIZE = 50;
/** Max pagination loops for conversation list. */
export const CLAUDE_MAX_PAGES = 100;

// ── Gemini ───────────────────────────────────────────────────────────
/** Conversations fetched per page. */
export const GEMINI_PAGE_SIZE = 100;
/** Max pagination loops for conversation list. */
export const GEMINI_MAX_PAGES = 100;
/** Max turns requested per conversation (set high to get all). */
export const GEMINI_MAX_TURNS = 10_000;

// ── Grok ─────────────────────────────────────────────────────────────
/** Conversations fetched per page. */
export const GROK_PAGE_SIZE = 60;
/** Max pagination loops for conversation list. */
export const GROK_MAX_PAGES = 200;

// ── Kimi ─────────────────────────────────────────────────────────────
/** Conversations fetched per page. */
export const KIMI_PAGE_SIZE = 50;
/** Messages fetched per conversation. */
export const KIMI_MESSAGES_PAGE_SIZE = 1_000;
/** Max pagination loops for conversation list. */
export const KIMI_MAX_PAGES = 200;
