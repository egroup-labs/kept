/**
 * utils.js
 *
 * Shared utilities for Kept platform adapters.
 * Exported for use by platform adapters and background.js.
 * Configuration constants live in config.js.
 */

import { ALLOWED_FETCH_HOSTS, RATE_LIMIT_MS, KEPT_APP_URL } from "./config.js";
export { ALLOWED_FETCH_HOSTS, KEPT_APP_URL };

// ── Debug Logging ────────────────────────────────────────────────────
// Note: debugMode is initialised asynchronously from storage. There is a tiny
// race window between module load and the storage read completing where early
// dbg() calls will be silently dropped. This is acceptable because debug logs
// before storage initialises are not critical, and the alternative (making
// dbg() async or checking storage on every call) would complicate all callers.
export let debugMode = false;
chrome.storage.local.get("debugMode").then(({ debugMode: d }) => { debugMode = !!d; });

export function dbg(...args) {
    if (!debugMode) return;
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    console.log("[Kept]", line);
    chrome.runtime.sendMessage({ type: "debug-log", line }).catch(() => { });
}

export function setDebugMode(value) {
    debugMode = !!value;
}

export function isAbortError(error) {
    return error?.name === "AbortError";
}

function makeAbortError(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    return new DOMException("The operation was aborted", "AbortError");
}

export function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw makeAbortError(signal);
    }
}

async function sleepWithAbort(ms, signal) {
    if (ms <= 0) return;
    if (!signal) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return;
    }
    if (signal.aborted) {
        throw makeAbortError(signal);
    }
    await new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timeoutId);
            reject(makeAbortError(signal));
        };
        const timeoutId = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

// ── Rate-limited fetch ───────────────────────────────────────────────
// Per-domain rate limiter: each hostname gets its own 1 req/s throttle,
// allowing parallel fetching across different providers.
const lastFetchByDomain = new Map();

// ALLOWED_FETCH_HOSTS is imported from config.js and re-exported above.

export async function rateLimitedFetch(url, opts = {}) {
    const { signal = null, ...fetchOpts } = opts;

    // Validate URL is from allowed domains only
    let urlObj;
    try {
        urlObj = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }
    const hostname = urlObj.hostname.toLowerCase();
    if (!ALLOWED_FETCH_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h))) {
        throw new Error(`Blocked request to unauthorized domain: ${hostname}`);
    }

    // RATE_LIMIT_MS imported from config.js
    const now = Date.now();
    const lastTime = lastFetchByDomain.get(hostname) || 0;
    const wait = RATE_LIMIT_MS - (now - lastTime);
    if (wait > 0) await sleepWithAbort(wait, signal);
    throwIfAborted(signal);
    lastFetchByDomain.set(hostname, Date.now());

    dbg(`FETCH ${url}`);
    const resp = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        ...fetchOpts,
        signal: signal ?? undefined,
    });
    dbg(`  → ${resp.status} ${resp.statusText} (type=${resp.type}, redirected=${resp.redirected}, url=${resp.url})`);
    if (resp.status === 401 || resp.status === 403) {
        throw new AuthError(resp.status);
    }
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} from ${url}`);
    }
    return resp;
}

export class AuthError extends Error {
    constructor(status) {
        super(`Not authenticated (${status})`);
        this.name = "AuthError";
        this.status = status;
    }
}

// ── Image downloader ─────────────────────────────────────────────────
export async function downloadImageAsBase64(url, useCredentials = true, opts = {}) {
    const fetchOpts = useCredentials ? { ...opts } : { ...opts, credentials: "omit" };
    const resp = await rateLimitedFetch(url, fetchOpts);
    // Note: rateLimitedFetch already throws on non-ok responses, so no need to check resp.ok here.
    const blob = await resp.arrayBuffer();
    const bytes = new Uint8Array(blob);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const contentType = resp.headers.get("content-type") || "image/png";
    return { base64, contentType };
}

// ── Markdown Formatter ───────────────────────────────────────────────
const ROLE_DISPLAY = { user: "You", assistant: "Assistant", system: "System", tool: "tool" };

export function escapeYaml(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

export function sanitizeFilename(name) {
    return (
        name
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
            .trim()
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .toLowerCase()
            .replace(/^-|-$/g, "") || "untitled"
    );
}

function cloneImages(images) {
    if (!Array.isArray(images)) return undefined;
    return images.map((img) => ({ ...img }));
}

export function cloneParsedConversation(parsed, overrides = {}) {
    return {
        ...parsed,
        ...overrides,
        metadata: parsed.metadata ? { ...parsed.metadata } : {},
        messages: (overrides.messages || parsed.messages || []).map((msg) => ({
            ...msg,
            images: cloneImages(msg.images),
        })),
    };
}

export function makeVariantConversationId(baseId, variant, token = "") {
    const suffix = token ? `${variant}::${token}` : variant;
    return `${baseId}::${suffix}`;
}

export function buildRecentRangeConversation(parsed, count) {
    const safeCount = Math.max(1, Number(count) || 1);
    const sliced = (parsed.messages || []).slice(-safeCount);
    return cloneParsedConversation(parsed, {
        conversation_id: makeVariantConversationId(parsed.conversation_id, "recent", String(safeCount)),
        title: `${parsed.title} (Last ${sliced.length} messages)`,
        messages: sliced,
    });
}

export function formatMarkdown(parsed, platform) {
    const { conversation_id, title, messages, metadata } = parsed;
    const now = new Date().toISOString();
    const model = metadata?.model || "unknown";

    // Sanitize heading to prevent markdown injection
    const safeHeading = title
        .replace(/[\r\n]+/g, " ")
        .replace(/\[/g, "\\[")
        .replace(/]/g, "\\]");

    const lines = [
        "---",
        `id: "${escapeYaml(conversation_id)}"`,
        `platform: "${escapeYaml(platform)}"`,
        `title: "${escapeYaml(title)}"`,
        `synced: ${now}`,
        `messages: ${messages.length}`,
        `model: "${escapeYaml(model)}"`,
        "tags:",
        `  - "kept/${escapeYaml(platform)}"`,
        "---",
        "",
        `# ${safeHeading}`,
        "",
    ];

    for (const msg of messages) {
        const roleDisplay = ROLE_DISPLAY[msg.role] || msg.role;
        if (msg.timestamp) {
            lines.push(`### ${roleDisplay} — ${msg.timestamp}`);
        } else {
            lines.push(`### ${roleDisplay}`);
        }
        lines.push("");
        lines.push(msg.content);
        if (msg.images) {
            for (const img of msg.images) {
                // Use external URL if available (e.g. Gemini), otherwise local asset server
                let imageUrl;
                if (img.url) {
                    imageUrl = img.url;
                } else {
                    const filename = img.file_id.includes(".") ? img.file_id : `${img.file_id}.png`;
                    imageUrl = `http://localhost:18241/api/assets/${platform}/${filename}`;
                }
                lines.push("");
                lines.push(`![image](${imageUrl})`);
                if (img.dalle_prompt) {
                    lines.push("");
                    lines.push(`> **Prompt:** ${img.dalle_prompt}`);
                }
            }
        }
        lines.push("");
        lines.push("---");
        lines.push("");
    }

    return lines.join("\n");
}

// ── SHA-256 Content Hash ─────────────────────────────────────────────
export async function contentHash(text) {
    // Strip the 'synced:' frontmatter line so the hash is stable across re-fetches
    const stable = text.replace(/^synced: .+$/m, "");
    const data = new TextEncoder().encode(stable);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

// ── Kept App Integration ─────────────────────────────────────────────
// KEPT_APP_URL is imported from config.js and re-exported above.

export async function isAppRunning() {
    try {
        const resp = await fetch(`${KEPT_APP_URL}/api/ping`, {
            signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) return false;
        const data = await resp.json();
        return data.status === "ok";
    } catch {
        return false;
    }
}

export async function getAppToken() {
    const { keptAppToken = "" } =
        await chrome.storage.local.get(["keptAppToken"]);
    return keptAppToken || "";
}

/**
 * Returns the user-configured sync target directory, or null when no override
 * is set (the desktop app then falls back to its default vault dir). Empty
 * strings and whitespace are treated as "unset".
 */
export async function getSyncTargetDir() {
    const { syncTargetDir = "" } =
        await chrome.storage.local.get(["syncTargetDir"]);
    const trimmed = (syncTargetDir || "").trim();
    return trimmed.length > 0 ? trimmed : null;
}

export async function sendToApp(parsed, platform, markdown, images = [], appToken = null, options = {}) {
    const { signal = null } = options;
    throwIfAborted(signal);
    const token = appToken ?? await getAppToken();
    if (!token) {
        dbg("No app token configured");
        return false;
    }

    try {
        const payload = {
            conversation_id: parsed.conversation_id,
            platform,
            title: parsed.title,
            model: parsed.metadata?.model || null,
            messages: parsed.messages,
            created_at: parsed.create_time
                ? new Date(parsed.create_time * 1000).toISOString()
                : parsed.created_at || null,
            updated_at: parsed.update_time
                ? new Date(parsed.update_time * 1000).toISOString()
                : parsed.updated_at || null,
            markdown,
            images: images.length > 0 ? images : undefined,
        };

        const targetDir = await getSyncTargetDir();
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        };
        if (targetDir) headers["X-Kept-Target-Dir"] = targetDir;

        const resp = await fetch(`${KEPT_APP_URL}/api/ingest`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: signal ?? AbortSignal.timeout(30000),
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            dbg(`App ingest failed: ${resp.status} ${text}`);
            return false;
        }

        const result = await resp.json();
        dbg(`App ingest: ${result.status}, path: ${result.file_path}, skipped: ${result.skipped}`);
        return true;
    } catch (err) {
        dbg(`App ingest error: ${err.message}`);
        return false;
    }
}

