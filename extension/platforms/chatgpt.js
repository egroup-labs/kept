/**
 * platforms/chatgpt.js
 *
 * ChatGPT platform adapter for Kept.
 * Handles API access, conversation parsing, and syncing.
 */

import {
    rateLimitedFetch,
    AuthError,
    downloadImageAsBase64,
    cloneParsedConversation,
    buildRecentRangeConversation,
    formatMarkdown,
    contentHash,
    makeVariantConversationId,
    sendToApp,
    dbg,
    debugMode,
    isAbortError,
    throwIfAborted,
} from "../utils.js";
import { CHATGPT_PAGE_SIZE } from "../config.js";

// ── ChatGPT Fetchers ─────────────────────────────────────────────────
async function getChatGPTAccessToken(signal = null) {
    dbg("Fetching ChatGPT access token...");
    const resp = await rateLimitedFetch("https://chatgpt.com/api/auth/session", { signal });
    const data = await resp.json();
    const token = data.accessToken;
    if (!token) {
        dbg("ChatGPT session response (no accessToken):", JSON.stringify(Object.keys(data)));
        throw new AuthError(401);
    }
    dbg("ChatGPT access token obtained");
    return token;
}

async function fetchChatGPTConversations(token, signal = null) {
    const conversations = [];
    let offset = 0;
    const limit = CHATGPT_PAGE_SIZE;
    const headers = { Authorization: `Bearer ${token}` };

    while (true) {
        const resp = await rateLimitedFetch(
            `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
            { headers, signal }
        );
        const data = await resp.json();
        dbg("ChatGPT conversations response:", JSON.stringify(Object.keys(data)), "total:", data.total, "items:", data.items?.length);
        if (debugMode && !data.items) dbg("ChatGPT raw response (no items key):", JSON.stringify(data).slice(0, 500));
        const items = data.items || [];
        if (items.length === 0) break;
        conversations.push(...items);
        offset += items.length;
        if (items.length < limit || offset >= (data.total || Infinity)) break;
    }

    return conversations;
}

async function fetchChatGPTConversation(token, id, signal = null) {
    const resp = await rateLimitedFetch(
        `https://chatgpt.com/backend-api/conversation/${id}`,
        { headers: { Authorization: `Bearer ${token}` }, signal }
    );
    return resp.json();
}

async function fetchChatGPTImageUrl(token, fileId, conversationId, signal = null) {
    const resp = await rateLimitedFetch(
        `https://chatgpt.com/backend-api/files/download/${fileId}?conversation_id=${conversationId}`,
        { headers: { Authorization: `Bearer ${token}` }, signal }
    );
    const data = await resp.json();
    return data.download_url;
}

async function downloadChatGPTImage(token, fileId, conversationId, signal = null) {
    // Method 1: /files/download/ → get signed download_url → fetch image
    try {
        const downloadUrl = await fetchChatGPTImageUrl(token, fileId, conversationId, signal);
        if (downloadUrl) {
            return await downloadImageAsBase64(downloadUrl, true, { signal });
        }
    } catch (err) {
        if (isAbortError(err)) throw err;
        dbg(`files/download failed for ${fileId}: ${err.message}, trying estuary fallback...`);
    }

    // Method 2: estuary content endpoint (works for some user-uploaded files)
    try {
        const resp = await rateLimitedFetch(
            `https://chatgpt.com/backend-api/estuary/content?id=${encodeURIComponent(fileId)}`,
            { headers: { Authorization: `Bearer ${token}` }, signal }
        );
        const blob = await resp.arrayBuffer();
        const bytes = new Uint8Array(blob);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return { base64: btoa(binary), contentType: resp.headers.get("content-type") || "image/png" };
    } catch (err) {
        if (isAbortError(err)) throw err;
        dbg(`estuary fallback also failed for ${fileId}: ${err.message}`);
    }

    return null;
}

// ── ChatGPT Helpers ──────────────────────────────────────────────────
function isDalleParamString(s) {
    if (s.length > 200 || !s.startsWith("{")) return false;
    try {
        const obj = JSON.parse(s);
        return obj && typeof obj === "object" && ("size" in obj || "prompt" in obj) && "n" in obj;
    } catch { return false; }
}

function getCurrentBranchNodeIds(mapping, currentNodeId) {
    if (!currentNodeId || !mapping[currentNodeId]) return null;
    const allowed = new Set();
    let cursor = currentNodeId;
    while (cursor && mapping[cursor] && !allowed.has(cursor)) {
        allowed.add(cursor);
        cursor = mapping[cursor].parent || null;
    }
    return allowed;
}

// ── ChatGPT Parser ───────────────────────────────────────────────────
function parseChatGPTConversation(body, options = {}) {
    const { branchOnly = false } = options;
    const convId = body.conversation_id;
    if (!convId) return null;

    const title = body.title || "Untitled";
    const mapping = body.mapping || {};
    const branchNodeIds = branchOnly
        ? getCurrentBranchNodeIds(mapping, body.current_node || body.currentNode || null)
        : null;

    const messages = [];
    for (const [nodeId, node] of Object.entries(mapping)) {
        if (branchNodeIds && !branchNodeIds.has(nodeId)) continue;
        const msg = node.message;
        if (!msg) continue;
        const role = msg.author?.role;
        if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") continue;
        const parts = msg.content?.parts || [];
        const content = parts
            .filter((p) => typeof p === "string")
            .filter((p) => !isDalleParamString(p))
            .join("\n");

        // Detect DALL-E image parts
        const images = [];
        for (const part of parts) {
            if (part && typeof part === "object" && part.content_type === "image_asset_pointer") {
                const pointer = part.asset_pointer || "";
                // Two known protocols, two shapes:
                //   file-service://file_<id>                       → single asset
                //   sediment://<page_id>#file_<id>#p_<N>.<ext>     → PDF-page asset
                // Strip prefix, split on "#", pick the first segment matching file_<id>.
                const hasKnownPrefix = pointer.startsWith("file-service://") || pointer.startsWith("sediment://");
                const rest = pointer.replace("file-service://", "").replace("sediment://", "");
                const fileId = rest.split("#").find((seg) => /^file_[A-Za-z0-9]{16,}$/.test(seg)) || null;
                if (hasKnownPrefix && fileId) {
                    images.push({
                        file_id: fileId,
                        width: part.width || null,
                        height: part.height || null,
                        dalle_prompt: part.metadata?.dalle?.prompt || null,
                    });
                } else if (rest) {
                    dbg(`Skipping image with unparseable asset_pointer: ${pointer.slice(0, 120)}`);
                }
            }
        }

        if (!content.trim() && images.length === 0) continue;

        let timestamp = null;
        let sortKey = msg.create_time;

        if (!sortKey) {
            // Tool messages lack create_time — inherit from parent node
            let p = node.parent;
            while (p && mapping[p]) {
                const parentTime = mapping[p].message?.create_time;
                if (parentTime) {
                    sortKey = parentTime + 0.0001;
                    break;
                }
                p = mapping[p].parent;
            }
        }

        if (sortKey) {
            try {
                timestamp = new Date(sortKey * 1000).toISOString();
            } catch {
                // invalid timestamp
            }
        }

        messages.push({
            role,
            content: content || "",
            timestamp,
            images: images.length > 0 ? images : undefined,
            _sort: sortKey || 0,
        });
    }

    messages.sort((a, b) => a._sort - b._sort);
    messages.forEach((m) => delete m._sort);

    if (messages.length === 0) return null;

    // Extract model slug
    let model = "unknown";
    for (const node of Object.values(mapping)) {
        const slug = node.message?.metadata?.model_slug;
        if (slug) {
            model = slug;
            break;
        }
    }

    return {
        conversation_id: convId,
        title,
        messages,
        metadata: {
            model,
            current_node: body.current_node || body.currentNode || null,
        },
        create_time: body.create_time,
        update_time: body.update_time,
    };
}

async function collectChatGPTImagePayloads(token, parsed, sourceConversationId, signal = null) {
    const imagePayloads = [];
    for (const msg of parsed.messages) {
        if (!msg.images) continue;
        for (const img of msg.images) {
            try {
                const result = await downloadChatGPTImage(token, img.file_id, sourceConversationId, signal);
                if (result) {
                    imagePayloads.push({
                        filename: `${img.file_id}.png`,
                        base64_data: result.base64,
                        content_type: result.contentType,
                    });
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
                dbg(`Failed to download image ${img.file_id}: ${err.message}`);
            }
        }
    }
    return imagePayloads;
}

function applyChatGPTExportMode(parsed, mode, count) {
    if (mode === "branch") {
        const branchToken = parsed.metadata?.current_node || "current";
        return cloneParsedConversation(parsed, {
            conversation_id: makeVariantConversationId(parsed.conversation_id, "branch", branchToken),
            title: `${parsed.title} (Current branch)`,
        });
    }
    if (mode === "recent") {
        return buildRecentRangeConversation(parsed, count);
    }
    return parsed;
}

export async function inspectChatGPTConversation(conversationId, options = {}) {
    const { mode = "full", count = 12, signal = null } = options;
    const token = await getChatGPTAccessToken(signal);
    const fullConv = await fetchChatGPTConversation(token, conversationId, signal);
    const parsedBase = parseChatGPTConversation(fullConv, { branchOnly: mode === "branch" });
    if (!parsedBase) throw new Error("Could not parse conversation");

    const parsed = applyChatGPTExportMode(parsedBase, mode, count);
    const markdown = formatMarkdown(parsed, "chatgpt");
    const hash = await contentHash(markdown);
    const images = await collectChatGPTImagePayloads(token, parsed, parsedBase.conversation_id, signal);

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
export async function saveOneChatGPT(conversationId, options = {}) {
    const result = await inspectChatGPTConversation(conversationId, options);
    const sent = await sendToApp(result.parsed, "chatgpt", result.markdown, result.images);
    if (!sent) throw new Error("Failed to send to Kept app â€” is it running?");
    return {
        title: result.parsed.title,
        hash: result.hash,
        baseConversationId: result.baseConversationId,
        savedConversationId: result.savedConversationId,
    };
}

// ── Sync ─────────────────────────────────────────────────────────────
export async function syncChatGPT(
    status,
    { getHashes, saveHashes, broadcastStatus, debug = false, debugMaxConversations = 5, maxConversations = 0, previousStatus = null, signal = null, afterSave = null },
) {
    status.chatgpt = { syncing: true, error: null, count: 0, lastSync: null };
    broadcastStatus(status);

    let convList = [];
    const hashes = await getHashes();
    let synced = 0;
    let rateLimited = false;

    try {
        throwIfAborted(signal);
        const token = await getChatGPTAccessToken(signal);
        convList = await fetchChatGPTConversations(token, signal);

        const effectiveMax = maxConversations > 0 ? maxConversations : (debug ? debugMaxConversations : 0);
        if (effectiveMax > 0 && convList.length > effectiveMax) {
            dbg(`ChatGPT: limiting to ${effectiveMax} conversations (was ${convList.length})`);
            convList = convList.slice(0, effectiveMax);
        }

        for (const item of convList) {
            throwIfAborted(signal);

            let fullConv;
            try {
                fullConv = await fetchChatGPTConversation(token, item.id, signal);
            } catch (err) {
                if (isAbortError(err)) throw err;
                if (err.message?.includes("HTTP 429")) {
                    dbg(`Rate limited fetching conversation ${item.id}, stopping sync`);
                    rateLimited = true;
                    break;
                }
                dbg(`Skipping conversation ${item.id}: ${err.message}`);
                continue;
            }

            const parsed = parseChatGPTConversation(fullConv);
            if (!parsed) continue;

            const md = formatMarkdown(parsed, "chatgpt");
            const hash = await contentHash(md);
            const hashKey = `chatgpt:${parsed.conversation_id}`;

            if (hashes[hashKey] === hash) continue; // unchanged

            const imagePayloads = [];
            for (const msg of parsed.messages) {
                if (!msg.images) continue;
                for (const img of msg.images) {
                    try {
                        const result = await downloadChatGPTImage(token, img.file_id, parsed.conversation_id, signal);
                        if (result) {
                            imagePayloads.push({
                                filename: `${img.file_id}.png`,
                                base64_data: result.base64,
                                content_type: result.contentType,
                            });
                            dbg(`Downloaded image: ${img.file_id}`);
                        }
                    } catch (err) {
                        if (isAbortError(err)) throw err;
                        dbg(`Failed to download image ${img.file_id}: ${err.message}`);
                    }
                }
            }

            throwIfAborted(signal);
            const sent = await sendToApp(parsed, "chatgpt", md, imagePayloads, null, { signal });
            if (!sent) {
                await saveHashes(hashes);
                status.chatgpt = {
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
                    platform: "chatgpt",
                    title: parsed.title,
                    hash,
                    baseConversationId: parsed.conversation_id,
                    savedConversationId: parsed.conversation_id,
                });
            }
            synced++;

            // Periodic persistence so progress survives service-worker death mid-sync.
            if (synced % 5 === 0) {
                await saveHashes(hashes);
                dbg(`ChatGPT sync checkpoint: ${synced}/${convList.length} persisted`);
            }
        }
    } catch (err) {
        if (isAbortError(err)) {
            await saveHashes(hashes);
            status.chatgpt = previousStatus
                ? { ...previousStatus, syncing: false }
                : { syncing: false, error: "Sync stopped", count: synced, total: convList.length, lastSync: null };
            broadcastStatus(status);
            dbg(`ChatGPT sync aborted: synced=${synced}/${convList.length}`);
            throw err;
        }
        if (err.message?.includes("HTTP 429")) {
            await saveHashes(hashes);
            status.chatgpt = {
                syncing: false,
                error: "Rate limited by ChatGPT — try again later",
                count: synced,
                total: convList.length,
                lastSync: null,
            };
            broadcastStatus(status);
            dbg(`ChatGPT sync stopped (rate limited): synced=${synced}/${convList.length}`);
            return synced;
        }
        dbg(`ChatGPT sync failed: ${err.name}: ${err.message} (synced=${synced}/${convList.length})`);
        throw err;
    }

    await saveHashes(hashes);
    if (rateLimited) {
        status.chatgpt = {
            syncing: false,
            error: `Rate limited by ChatGPT — synced ${synced}, try again later`,
            count: synced,
            total: convList.length,
            lastSync: null,
        };
        dbg(`ChatGPT sync stopped (rate limited): synced=${synced}/${convList.length}`);
    } else {
        status.chatgpt = {
            syncing: false,
            error: null,
            count: synced,
            total: convList.length,
            lastSync: new Date().toISOString(),
        };
        dbg(`ChatGPT sync done: synced=${synced}/${convList.length}`);
    }
    broadcastStatus(status);
    return synced;
}
