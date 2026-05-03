/**
 * platforms/grok.js
 *
 * Grok platform adapter for Kept.
 * Handles API access, conversation parsing, and syncing.
 *
 * Grok uses REST endpoints at grok.com.
 * Requires session cookies and x-xai-request-id header.
 */

import {
    rateLimitedFetch,
    downloadImageAsBase64,
    buildRecentRangeConversation,
    formatMarkdown,
    contentHash,
    sendToApp,
    dbg,
    isAbortError,
    throwIfAborted,
} from "../utils.js";
import { GROK_PAGE_SIZE, GROK_MAX_PAGES } from "../config.js";

// ── Grok Helpers ─────────────────────────────────────────────────────

function generateRequestId() {
    return crypto.randomUUID();
}

const GROK_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
};

function grokHeaders() {
    return {
        ...GROK_HEADERS,
        "x-xai-request-id": generateRequestId(),
    };
}

// ── Grok Fetchers ────────────────────────────────────────────────────

async function fetchGrokConversations(signal = null) {
    dbg("Fetching Grok conversation list...");

    let all = [];
    let pageToken = null;
    let page = 0;
    do {
        let url = `https://grok.com/rest/app-chat/conversations?pageSize=${GROK_PAGE_SIZE}`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const resp = await rateLimitedFetch(url, { headers: grokHeaders(), signal });
        const data = await resp.json();
        dbg(`Grok conversations page ${++page}:`,
            (data.conversations || []).length, "items,",
            "nextPageToken:", data.nextPageToken ?? "none");
        all = all.concat(data.conversations || []);
        pageToken = data.nextPageToken ?? null;
    } while (pageToken && page < GROK_MAX_PAGES);
    dbg("Grok total conversations fetched:", all.length);
    return all;
}

async function fetchGrokResponseNodes(conversationId, signal = null) {
    dbg("Fetching Grok response nodes for:", conversationId);
    const resp = await rateLimitedFetch(
        `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
        { headers: grokHeaders(), signal }
    );
    return resp.json();
}

async function fetchGrokConversationMeta(conversationId, signal = null) {
    dbg("Fetching Grok conversation meta for:", conversationId);
    try {
        const resp = await rateLimitedFetch(
            `https://grok.com/rest/app-chat/conversations/${conversationId}`,
            { headers: grokHeaders(), signal }
        );
        return await resp.json();
    } catch (err) {
        if (isAbortError(err)) throw err;
        dbg("Failed to fetch Grok conversation meta:", err.message);
        return null;
    }
}

async function fetchGrokResponses(conversationId, responseIds, signal = null) {
    dbg("Fetching Grok responses for:", conversationId, "ids:", responseIds.length);
    const resp = await rateLimitedFetch(
        `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`,
        {
            method: "POST",
            headers: grokHeaders(),
            body: JSON.stringify({ responseIds }),
            signal,
        }
    );
    return resp.json();
}

// ── Grok Parser ──────────────────────────────────────────────────────

function parseGrokConversation(convMeta, nodeData, responseData) {
    const conversationId = convMeta.conversationId || convMeta.id;
    if (!conversationId) return null;

    let title = convMeta.title || "";

    // Parse the loaded responses into messages
    const messages = [];
    const responses = Array.isArray(responseData) ? responseData : responseData?.responses || responseData?.messages || [];

    for (const resp of responses) {
        if (!resp) continue;

        // Determine role — Grok uses "human" / "assistant" or similar
        let role = "assistant";
        if (resp.sender === "human" || resp.role === "human" || resp.role === "user" || resp.sender === "user") {
            role = "user";
        }

        // Extract text content
        let content = "";
        if (typeof resp.message === "string") {
            content = resp.message;
        } else if (typeof resp.text === "string") {
            content = resp.text;
        } else if (typeof resp.content === "string") {
            content = resp.content;
        } else if (resp.message && typeof resp.message === "object") {
            content = resp.message.text || resp.message.content || JSON.stringify(resp.message);
        }

        // Extract timestamp
        let timestamp = null;
        if (resp.createdAt) {
            timestamp = new Date(resp.createdAt).toISOString();
        } else if (resp.created_at) {
            timestamp = resp.created_at;
        }

        // Detect image attachments
        const images = [];
        const attachments = resp.fileAttachmentsMetadata || resp.attachments || [];
        for (const att of attachments) {
            if (att.fileUri) {
                // Validate the fileUri: must be a valid URL path and not contain ".." traversal
                if (att.fileUri.includes("..")) continue;
                try {
                    new URL(`https://assets.grok.com/${att.fileUri}`);
                } catch {
                    continue;
                }

                // Extract a safe filename from the URI path (e.g. "users/.../1bca7ba1-.../image.jpg" → "1bca7ba1-..._image")
                const uriParts = att.fileUri.split("/");
                const baseName = uriParts.length >= 2
                    ? `${uriParts[uriParts.length - 2]}_${uriParts[uriParts.length - 1].replace(/\.[^.]+$/, "")}`
                    : uriParts[uriParts.length - 1].replace(/\.[^.]+$/, "");
                images.push({
                    file_id: baseName,
                    url: `https://assets.grok.com/${att.fileUri}`,
                    width: att.width || null,
                    height: att.height || null,
                });
            }
        }

        if (!content.trim() && images.length === 0) continue;

        messages.push({
            role,
            content: content || "",
            timestamp,
            images: images.length > 0 ? images : undefined,
        });
    }

    if (messages.length === 0) return null;

    // Sort messages chronologically by timestamp (oldest first)
    messages.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return new Date(a.timestamp) - new Date(b.timestamp);
    });

    // Derive title from first user message if API didn't provide one
    if (!title) {
        const firstUser = messages.find(m => m.role === "user");
        title = firstUser
            ? firstUser.content.slice(0, 80).replace(/\n/g, " ").trim() || "Untitled"
            : "Untitled";
    }

    // Extract model from the first response that has it
    let model = "grok";
    for (const resp of responses) {
        if (resp?.model) { model = resp.model; break; }
    }

    return {
        conversation_id: conversationId,
        title,
        messages,
        metadata: { model },
        created_at: convMeta.createdAt || convMeta.created_at || new Date().toISOString(),
        updated_at: convMeta.updatedAt || convMeta.updated_at || new Date().toISOString(),
    };
}

async function collectGrokImagePayloads(parsed, signal = null) {
    const imagePayloads = [];
    for (const msg of parsed.messages) {
        if (!msg.images) continue;
        for (const img of msg.images) {
            try {
                const { base64, contentType } = await downloadImageAsBase64(img.url, true, { signal });
                const ext = (contentType.split("/")[1] || "png").split(";")[0];
                imagePayloads.push({
                    filename: `${img.file_id}.${ext}`,
                    base64_data: base64,
                    content_type: contentType,
                });
            } catch (err) {
                if (isAbortError(err)) throw err;
                dbg(`Failed to download Grok image ${img.file_id}: ${err.message}`);
            }
        }
    }
    return imagePayloads;
}

export async function inspectGrokConversation(conversationId, options = {}) {
    const { mode = "full", count = 12, signal = null } = options;
    const [nodeData, convMeta] = await Promise.all([
        fetchGrokResponseNodes(conversationId, signal),
        fetchGrokConversationMeta(conversationId, signal),
    ]);

    const responseIdSet = new Set();
    const walkNodes = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (obj.responseId) responseIdSet.add(obj.responseId);
        if (Array.isArray(obj)) obj.forEach(walkNodes);
        else Object.values(obj).forEach(walkNodes);
    };
    walkNodes(nodeData);
    const responseIds = [...responseIdSet];

    if (responseIds.length === 0) throw new Error("No messages found in conversation");

    const responseData = await fetchGrokResponses(conversationId, responseIds, signal);
    const parsedBase = parseGrokConversation(
        convMeta && convMeta.title ? convMeta : { conversationId },
        nodeData,
        responseData,
    );
    if (!parsedBase) throw new Error("Could not parse conversation");

    const parsed = mode === "recent"
        ? buildRecentRangeConversation(parsedBase, count)
        : parsedBase;
    const markdown = formatMarkdown(parsed, "grok");
    const hash = await contentHash(markdown);
    const images = await collectGrokImagePayloads(parsed, signal);

    return {
        parsed,
        markdown,
        hash,
        images,
        baseConversationId: parsedBase.conversation_id,
        savedConversationId: parsed.conversation_id,
    };
}

// ── Save One ──────────────────────────────────────────────────────────
export async function saveOneGrok(conversationId, options = {}) {
    const result = await inspectGrokConversation(conversationId, options);
    const sent = await sendToApp(result.parsed, "grok", result.markdown, result.images);
    if (!sent) throw new Error("Failed to send to Kept app â€” is it running?");
    return {
        title: result.parsed.title,
        hash: result.hash,
        baseConversationId: result.baseConversationId,
        savedConversationId: result.savedConversationId,
    };
    if (false) {

    const nodeData = await fetchGrokResponseNodes(conversationId);

    const responseIdSet = new Set();
    const walkNodes = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (obj.responseId) responseIdSet.add(obj.responseId);
        if (Array.isArray(obj)) obj.forEach(walkNodes);
        else Object.values(obj).forEach(walkNodes);
    };
    walkNodes(nodeData);
    const responseIds = [...responseIdSet];

    if (responseIds.length === 0) throw new Error("No messages found in conversation");

    const responseData = await fetchGrokResponses(conversationId, responseIds);
    const parsed = parseGrokConversation(
        { conversationId, title: "Grok Conversation" },
        nodeData,
        responseData,
    );
    if (!parsed) throw new Error("Could not parse conversation");

    const md = formatMarkdown(parsed, "grok");

    const imagePayloads = [];
    for (const msg of parsed.messages) {
        if (!msg.images) continue;
        for (const img of msg.images) {
            try {
                const { base64, contentType } = await downloadImageAsBase64(img.url);
                const ext = (contentType.split("/")[1] || "png").split(";")[0];
                imagePayloads.push({
                    filename: `${img.file_id}.${ext}`,
                    base64_data: base64,
                    content_type: contentType,
                });
            } catch { /* non-fatal */ }
        }
    }

    const sent = await sendToApp(parsed, "grok", md, imagePayloads);
    if (!sent) throw new Error("Failed to send to Kept app — is it running?");
    return { title: parsed.title };
    }
}

// ── Sync ─────────────────────────────────────────────────────────────
export async function syncGrok(
    status,
    { getHashes, saveHashes, broadcastStatus, debug = false, debugMaxConversations = 5, maxConversations = 0, previousStatus = null, signal = null, afterSave = null },
) {
    status.grok = { syncing: true, error: null, count: 0, lastSync: null };
    broadcastStatus(status);

    let convList = [];
    const hashes = await getHashes();
    let synced = 0;

    try {
        throwIfAborted(signal);
        convList = await fetchGrokConversations(signal);

        const effectiveMax = maxConversations > 0 ? maxConversations : (debug ? debugMaxConversations : 0);
        if (effectiveMax > 0 && convList.length > effectiveMax) {
            dbg(`Grok: limiting to ${effectiveMax} conversations (was ${convList.length})`);
            convList = convList.slice(0, effectiveMax);
        }

        for (const item of convList) {
            throwIfAborted(signal);
            const convId = item.conversationId || item.id;
            const nodeData = await fetchGrokResponseNodes(convId, signal);

            const responseIdSet = new Set();
            const walkNodes = (obj) => {
                if (!obj || typeof obj !== "object") return;
                if (obj.responseId) responseIdSet.add(obj.responseId);
                if (Array.isArray(obj)) obj.forEach(walkNodes);
                else Object.values(obj).forEach(walkNodes);
            };
            walkNodes(nodeData);
            const responseIds = [...responseIdSet];

            if (responseIds.length === 0) {
                dbg("Grok: no response IDs for conversation", convId);
                continue;
            }

            const responseData = await fetchGrokResponses(convId, responseIds, signal);
            const parsed = parseGrokConversation(item, nodeData, responseData);
            if (!parsed) continue;

            const md = formatMarkdown(parsed, "grok");
            const hash = await contentHash(md);
            const hashKey = `grok:${parsed.conversation_id}`;

            if (hashes[hashKey] === hash) continue;

            const imagePayloads = [];
            for (const msg of parsed.messages) {
                if (!msg.images) continue;
                for (const img of msg.images) {
                    try {
                        const { base64, contentType } = await downloadImageAsBase64(img.url, true, { signal });
                        const ext = (contentType.split("/")[1] || "png").split(";")[0];
                        imagePayloads.push({
                            filename: `${img.file_id}.${ext}`,
                            base64_data: base64,
                            content_type: contentType,
                        });
                        dbg(`Downloaded Grok image: ${img.file_id}`);
                    } catch (err) {
                        if (isAbortError(err)) throw err;
                        dbg(`Failed to download Grok image ${img.file_id}: ${err.message}`);
                    }
                }
            }

            throwIfAborted(signal);
            const sent = await sendToApp(parsed, "grok", md, imagePayloads, null, { signal });
            if (!sent) {
                await saveHashes(hashes);
                status.grok = {
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
                    platform: "grok",
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
            status.grok = previousStatus
                ? { ...previousStatus, syncing: false }
                : { syncing: false, error: "Sync stopped", count: synced, total: convList.length, lastSync: null };
            broadcastStatus(status);
        }
        throw err;
    }

    await saveHashes(hashes);
    status.grok = {
        syncing: false,
        error: null,
        count: synced,
        total: convList.length,
        lastSync: new Date().toISOString(),
    };
    broadcastStatus(status);
    return synced;
}
