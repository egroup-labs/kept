/**
 * platforms/gemini.js
 *
 * Gemini platform adapter for Kept.
 * Handles API access, conversation parsing, and syncing.
 *
 * Gemini uses the internal batchexecute RPC endpoint.
 * All requests rely on Google session cookies (credentials: "include").
 * Requires an SNlM0e XSRF token extracted from the Gemini page HTML.
 */

import {
    rateLimitedFetch,
    buildRecentRangeConversation,
    formatMarkdown,
    contentHash,
    sendToApp,
    dbg,
    isAbortError,
    throwIfAborted,
} from "../utils.js";
import { GEMINI_PAGE_SIZE, GEMINI_MAX_PAGES, GEMINI_MAX_TURNS } from "../config.js";

// ── Gemini Auth ──────────────────────────────────────────────────────

/**
 * Extract the SNlM0e XSRF token from the Gemini app page HTML.
 * This token is embedded in a <script> tag and is required for all POST requests.
 */
async function getGeminiToken(signal = null) {
    dbg("Fetching Gemini SNlM0e token...");
    const resp = await rateLimitedFetch("https://gemini.google.com/app", { signal });
    if (!resp.ok) {
        throw new Error(`Failed to load Gemini page: ${resp.status}`);
    }
    const html = await resp.text();
    const match = html.match(/"SNlM0e":"([^"]+)"/);
    if (!match) {
        throw new Error("Could not extract Gemini SNlM0e token — not logged in?");
    }
    dbg("Gemini SNlM0e token obtained");
    return match[1];
}

// ── Gemini Response Parsing ──────────────────────────────────────────

/**
 * Parse the batchexecute ")]}'" prefixed response.
 * Returns the inner parsed JSON data for the given RPC ID.
 */
function parseBatchResponse(raw, rpcId) {
    const cleaned = raw.replace(/^\)\]\}'\n*/, "");

    // The response contains multiple chunks separated by newlines.
    // Each chunk is prefixed with a byte-length number on its own line.
    const lines = cleaned.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || /^\d+$/.test(trimmed)) continue;
        try {
            const outer = JSON.parse(trimmed);
            // outer is an array of arrays: [["wrb.fr", "RpcId", "data_json", ...], ...]
            if (!Array.isArray(outer)) continue;
            for (const item of outer) {
                if (Array.isArray(item) && item[0] === "wrb.fr" && item[1] === rpcId) {
                    return JSON.parse(item[2]);
                }
            }
        } catch {
            // try next line
        }
    }
    return null;
}

// ── Gemini Fetchers ──────────────────────────────────────────────────

async function fetchGeminiConversations(token, signal = null) {
    dbg("Fetching Gemini conversation list...");

    const allConversations = [];
    let pageToken = null;
    let page = 0;

    do {
        // Server caps at 100 per page; pageToken at parsed[1] drives pagination
        const requestData = JSON.stringify([GEMINI_PAGE_SIZE, pageToken, [0, null, 1]]);
        const freq = JSON.stringify([[["MaZiqc", requestData, null, "generic"]]]);
        const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(token)}`;

        const resp = await rateLimitedFetch(
            "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fapp",
            {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body,
                signal,
            }
        );

        const raw = await resp.text();
        const parsed = parseBatchResponse(raw, "MaZiqc");
        if (!parsed) {
            dbg("Gemini: could not parse conversation list response");
            break;
        }

        // Conversation array can be at parsed[2] or parsed[0]
        const convArray = Array.isArray(parsed[2]) ? parsed[2]
            : Array.isArray(parsed[0]) ? parsed[0] : null;
        if (!convArray) {
            dbg("Gemini: no conversation array found in response", JSON.stringify(parsed).slice(0, 500));
            break;
        }

        let pageCount = 0;
        for (const conv of convArray) {
            if (!Array.isArray(conv)) continue;
            const id = conv[0];
            if (typeof id !== "string" || !id.startsWith("c_")) continue;
            const title = conv[1] || "Untitled";

            // Timestamp at conv[5]: [seconds, nanoseconds]
            let createdAt = null;
            if (Array.isArray(conv[5]) && conv[5][0]) {
                try {
                    createdAt = new Date(conv[5][0] * 1000).toISOString();
                } catch {
                    // skip
                }
            }

            allConversations.push({ id, title, createdAt });
            pageCount++;
        }

        // Pagination token lives at parsed[1]
        pageToken = typeof parsed[1] === "string" ? parsed[1] : null;
        dbg(`Gemini conversations page ${++page}:`, pageCount, "items,",
            "nextToken:", pageToken ? pageToken.substring(0, 20) + "..." : "none");

    } while (pageToken && page < GEMINI_MAX_PAGES);

    dbg("Gemini total conversations fetched:", allConversations.length);
    return allConversations;
}

async function fetchGeminiConversation(token, convId, signal = null) {
    dbg("Fetching Gemini conversation:", convId);
    // Second param = number of turns to fetch (use high number to get all)
    const requestData = JSON.stringify([convId, GEMINI_MAX_TURNS]);
    const freq = JSON.stringify([[["hNvQHb", requestData, null, "generic"]]]);
    const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(token)}`;

    const resp = await rateLimitedFetch(
        "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp",
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body,
            signal,
        }
    );

    const raw = await resp.text();
    return parseBatchResponse(raw, "hNvQHb");
}

// ── Gemini Parser ────────────────────────────────────────────────────

function parseGeminiConversation(convId, titleHint, parsedData) {
    if (!parsedData || !Array.isArray(parsedData)) return null;

    const messages = [];

    let title = titleHint || null;

    // ── Extract timestamps ──
    // Timestamps may appear at parsedData[5] as [seconds, nanos]
    let createdAt = null;
    let updatedAt = null;
    for (const idx of [5, 6, 7]) {
        if (Array.isArray(parsedData[idx]) && typeof parsedData[idx][0] === "number" && parsedData[idx][0] > 1e9) {
            const ts = new Date(parsedData[idx][0] * 1000).toISOString();
            if (!createdAt) createdAt = ts;
            else if (!updatedAt) updatedAt = ts;
        }
    }

    // parsedData[0] contains the turns array
    const turns = Array.isArray(parsedData[0]) ? parsedData[0] : parsedData;

    // Gemini returns turns newest-first — reverse to chronological order
    const orderedTurns = [...turns].reverse();

    let firstTurnTs = null;
    let lastTurnTs = null;

    for (const turn of orderedTurns) {
        if (!Array.isArray(turn)) continue;

        // ── Turn timestamp ──
        // Timestamps can be at turn[1] as [seconds, nanos] or turn[4]
        let turnTs = null;
        for (const ti of [1, 4]) {
            if (Array.isArray(turn[ti]) && typeof turn[ti][0] === "number" && turn[ti][0] > 1e9) {
                turnTs = new Date(turn[ti][0] * 1000).toISOString();
                break;
            }
        }
        if (turnTs) {
            if (!firstTurnTs) firstTurnTs = turnTs;
            lastTurnTs = turnTs;
        }

        // ── User message ──
        try {
            const userText = turn[2]?.[0]?.[0];
            if (typeof userText === "string" && userText.trim()) {
                messages.push({
                    role: "user",
                    content: userText,
                    timestamp: turnTs,
                });
            }
        } catch {
            // skip
        }

        // ── Assistant message ──
        try {
            const aiText = turn[3]?.[0]?.[0]?.[1]?.[0];
            const images = extractGeminiImages(turn);

            const hasText = typeof aiText === "string" && aiText.trim();
            if (hasText || images.length > 0) {
                messages.push({
                    role: "assistant",
                    content: hasText ? aiText : "",
                    timestamp: turnTs,
                    images: images.length > 0 ? images : undefined,
                });
            }
        } catch {
            // skip
        }
    }

    if (messages.length === 0) return null;

    // If no title was provided, use the first user message (truncated)
    if (!title) {
        const firstUser = messages.find((m) => m.role === "user");
        if (firstUser) {
            title = firstUser.content.slice(0, 80).replace(/\n/g, " ").trim();
            if (firstUser.content.length > 80) title += "…";
        } else {
            title = "Untitled";
        }
    }

    // Extract model name from the first assistant turn that has it at index [3][21]
    let model = "gemini";
    for (const turn of orderedTurns) {
        const turnModel = turn[3]?.[21];
        if (typeof turnModel === "string" && turnModel.trim()) {
            model = "gemini-" + turnModel.trim().toLowerCase().replace(/\s+/g, "-");
            break;
        }
    }

    return {
        conversation_id: convId,
        title,
        messages,
        metadata: { model },
        created_at: createdAt || firstTurnTs,
        updated_at: updatedAt || lastTurnTs,
    };
}

/**
 * Recursively search a turn's nested arrays for Gemini image entries.
 * Image arrays contain a googleusercontent.com URL at index 3 and MIME type at index 10.
 */
function extractGeminiImages(data) {
    const images = [];
    const seen = new Set();

    function walk(arr) {
        if (!Array.isArray(arr)) return;
        // Check if this array looks like an image entry:
        // index 3 = URL string containing googleusercontent.com
        // index 11 = MIME type string like "image/png" (sometimes at index 10)
        const mimeIdx = typeof arr[11] === "string" && arr[11].startsWith("image/") ? 11
            : typeof arr[10] === "string" && arr[10].startsWith("image/") ? 10
                : -1;
        if (
            arr.length > 11 &&
            typeof arr[3] === "string" &&
            arr[3].includes("googleusercontent.com") &&
            mimeIdx !== -1
        ) {
            const url = arr[3];
            if (!seen.has(url)) {
                seen.add(url);
                const filename = arr[2] || `gemini_${seen.size}`;
                // Dimensions can be at index 14 or 15
                const dims = Array.isArray(arr[15]) ? arr[15] : Array.isArray(arr[14]) ? arr[14] : [];
                images.push({
                    file_id: typeof filename === "string" ? filename.replace(/\.[^.]+$/, "") : `gemini_${seen.size}`,
                    url,
                    width: dims[0] || null,
                    height: dims[1] || null,
                    content_type: arr[mimeIdx],
                });
            }
            return; // don't recurse into image arrays
        }
        for (const item of arr) {
            walk(item);
        }
    }

    walk(data);
    return images;
}

export async function inspectGeminiConversation(conversationId, options = {}) {
    const { mode = "full", count = 12, signal = null } = options;
    const apiId = conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
    const token = await getGeminiToken(signal);
    const rawConv = await fetchGeminiConversation(token, apiId, signal);
    const parsedBase = parseGeminiConversation(apiId, null, rawConv);
    if (!parsedBase) throw new Error("Could not parse conversation");

    const parsed = mode === "recent"
        ? buildRecentRangeConversation(parsedBase, count)
        : parsedBase;
    const markdown = formatMarkdown(parsed, "gemini");
    const hash = await contentHash(markdown);

    return {
        parsed,
        markdown,
        hash,
        images: [],
        baseConversationId: parsedBase.conversation_id,
        savedConversationId: parsed.conversation_id,
    };
}

// ── Save One ──────────────────────────────────────────────────────────
export async function saveOneGemini(conversationId, options = {}) {
    const result = await inspectGeminiConversation(conversationId, options);
    const sent = await sendToApp(result.parsed, "gemini", result.markdown);
    if (!sent) throw new Error("Failed to send to Kept app â€” is it running?");
    return {
        title: result.parsed.title,
        hash: result.hash,
        baseConversationId: result.baseConversationId,
        savedConversationId: result.savedConversationId,
    };
    if (false) {

    // Gemini API expects c_ prefix but URLs omit it
    const apiId = conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
    const token = await getGeminiToken();
    const rawConv = await fetchGeminiConversation(token, apiId);

    // Debug: dump top-level structure to find title location
    if (Array.isArray(rawConv)) {
        dbg("Gemini hNvQHb response structure:");
        for (let i = 0; i < rawConv.length; i++) {
            const v = rawConv[i];
            if (v === null || v === undefined) {
                dbg(`  [${i}] = null`);
            } else if (typeof v === "string") {
                dbg(`  [${i}] = string: "${v.slice(0, 120)}"`);
            } else if (typeof v === "number") {
                dbg(`  [${i}] = number: ${v}`);
            } else if (Array.isArray(v)) {
                dbg(`  [${i}] = array[${v.length}]`);
            } else {
                dbg(`  [${i}] = ${typeof v}`);
            }
        }
    }

    const parsed = parseGeminiConversation(apiId, null, rawConv);
    if (!parsed) throw new Error("Could not parse conversation");

    const md = formatMarkdown(parsed, "gemini");
    const sent = await sendToApp(parsed, "gemini", md);
    if (!sent) throw new Error("Failed to send to Kept app — is it running?");
    return { title: parsed.title };
    }
}

// ── Sync ─────────────────────────────────────────────────────────────
export async function syncGemini(
    status,
    { getHashes, saveHashes, broadcastStatus, debug = false, debugMaxConversations = 5, maxConversations = 0, previousStatus = null, signal = null, afterSave = null },
) {
    status.gemini = { syncing: true, error: null, count: 0, lastSync: null };
    broadcastStatus(status);

    let convList = [];
    const hashes = await getHashes();
    let synced = 0;

    try {
        throwIfAborted(signal);
        const token = await getGeminiToken(signal);
        convList = await fetchGeminiConversations(token, signal);

        const effectiveMax = maxConversations > 0 ? maxConversations : (debug ? debugMaxConversations : 0);
        if (effectiveMax > 0 && convList.length > effectiveMax) {
            dbg(`Gemini: limiting to ${effectiveMax} conversations (was ${convList.length})`);
            convList = convList.slice(0, effectiveMax);
        }

        for (const item of convList) {
            throwIfAborted(signal);
            const rawConv = await fetchGeminiConversation(token, item.id, signal);
            const parsed = parseGeminiConversation(item.id, item.title, rawConv);
            if (!parsed) continue;

            if (item.createdAt) {
                parsed.created_at = item.createdAt;
                parsed.updated_at = item.createdAt;
            }

            const md = formatMarkdown(parsed, "gemini");
            const hash = await contentHash(md);
            const hashKey = `gemini:${parsed.conversation_id}`;

            if (hashes[hashKey] === hash) continue;

            throwIfAborted(signal);
            const sent = await sendToApp(parsed, "gemini", md, [], null, { signal });
            if (!sent) {
                await saveHashes(hashes);
                status.gemini = {
                    syncing: false,
                    error: "Failed to send to Kept app",
                    count: synced,
                    total: convList.length,
                    lastSync: null,
                };
                broadcastStatus(status);
                return synced;
            }

            hashes[hashKey] = hash;
            if (afterSave) {
                await afterSave({
                    platform: "gemini",
                    title: parsed.title,
                    hash,
                    baseConversationId: parsed.conversation_id,
                    savedConversationId: parsed.conversation_id,
                });
            }
            synced++;
        }
    } catch (err) {
        if (isAbortError(err)) {
            await saveHashes(hashes);
            status.gemini = previousStatus
                ? { ...previousStatus, syncing: false }
                : { syncing: false, error: "Sync stopped", count: synced, total: convList.length, lastSync: null };
            broadcastStatus(status);
        }
        throw err;
    }

    await saveHashes(hashes);
    status.gemini = {
        syncing: false,
        error: null,
        count: synced,
        total: convList.length,
        lastSync: new Date().toISOString(),
    };
    broadcastStatus(status);
    return synced;
}
