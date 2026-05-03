/**
 * platforms/kimi.js
 *
 * Kimi platform adapter for Kept.
 * Handles API access, conversation parsing, and syncing.
 *
 * Kimi uses REST endpoints at kimi.com.
 * Auth token is read from localStorage by the kimi-auth.js content script.
 */

import {
    rateLimitedFetch,
    AuthError,
    buildRecentRangeConversation,
    formatMarkdown,
    contentHash,
    sendToApp,
    dbg,
    isAbortError,
    throwIfAborted,
} from "../utils.js";
import { KIMI_PAGE_SIZE, KIMI_MESSAGES_PAGE_SIZE, KIMI_MAX_PAGES } from "../config.js";

// ── Kimi Auth ────────────────────────────────────────────────────────

/**
 * Get the access_token cached by the kimi-auth.js content script.
 * The content script reads localStorage on kimi.com and stores the
 * token via chrome.storage.local, avoiding the "cookies" permission.
 * Requires the user to have visited kimi.com while logged in.
 */
async function getKimiAccessToken() {
    dbg("Attempting to get cached Kimi access token...");

    const { kimiAuthToken } = await chrome.storage.local.get("kimiAuthToken");

    if (kimiAuthToken) {
        dbg("Kimi access token obtained from storage");
        return kimiAuthToken;
    }

    throw new AuthError(401);
}

function kimiHeaders(token) {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "authorization": `Bearer ${token}`,
    };
}

// ── Kimi Fetchers ────────────────────────────────────────────────────

async function fetchKimiConversations(token, signal = null) {
    dbg("Fetching Kimi conversation list...");

    let all = [];
    let pageToken = "";
    let page = 0;
    do {
        const body = { project_id: "", page_size: KIMI_PAGE_SIZE, query: "" };
        if (pageToken) body.page_token = pageToken;
        const resp = await rateLimitedFetch(
            "https://www.kimi.com/apiv2/kimi.chat.v1.ChatService/ListChats",
            { method: "POST", headers: kimiHeaders(token), body: JSON.stringify(body), signal }
        );
        const data = await resp.json();
        dbg(`Kimi conversations page ${++page}:`,
            (data.chats || []).length, "items,",
            "nextPageToken:", data.nextPageToken ?? "none");
        all = all.concat(data.chats || []);
        pageToken = data.nextPageToken ?? "";
    } while (pageToken && page < KIMI_MAX_PAGES);
    dbg("Kimi total conversations fetched:", all.length);
    return all;
}

async function fetchKimiChatMeta(token, chatId, signal = null) {
    dbg("Fetching Kimi chat meta for:", chatId);
    try {
        const resp = await rateLimitedFetch(
            "https://www.kimi.com/apiv2/kimi.chat.v1.ChatService/GetChat",
            {
                method: "POST",
                headers: kimiHeaders(token),
                body: JSON.stringify({ chat_id: chatId }),
                signal,
            }
        );
        return await resp.json();
    } catch (err) {
        if (isAbortError(err)) throw err;
        dbg("Failed to fetch Kimi chat meta:", err.message);
        return null;
    }
}

async function fetchKimiMessages(token, chatId, signal = null) {
    dbg("Fetching Kimi messages for:", chatId);
    const resp = await rateLimitedFetch(
        "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages",
        {
            method: "POST",
            headers: kimiHeaders(token),
            body: JSON.stringify({ chat_id: chatId, page_size: KIMI_MESSAGES_PAGE_SIZE }),
            signal,
        }
    );
    return resp.json();
}

// ── Kimi Parser ──────────────────────────────────────────────────────

function parseKimiConversation(convMeta, messagesData) {
    const chatId = convMeta.id || convMeta.chat_id;
    if (!chatId) return null;

    let title = convMeta.name || convMeta.title || "";
    const rawMessages = messagesData.messages || messagesData.items || [];

    // Kimi returns messages newest-first — reverse to chronological order
    const orderedMessages = [...rawMessages].reverse();

    const messages = [];
    for (const msg of orderedMessages) {
        // Determine role
        let role = "assistant";
        if (msg.role === "user" || msg.sender === "user" || msg.role === "human") {
            role = "user";
        } else if (msg.role === "system") {
            role = "system";
        }

        // Extract content — can be direct string or in blocks
        let content = "";
        if (typeof msg.content === "string") {
            content = msg.content;
        } else if (typeof msg.text === "string") {
            content = msg.text;
        } else if (Array.isArray(msg.blocks)) {
            // Kimi stores content in blocks[].text.content
            const parts = [];
            for (const block of msg.blocks) {
                if (block.type === "TEXT" || block.type === "text" || !block.type) {
                    const text = block.text?.content || block.content || "";
                    if (text) parts.push(text);
                }
            }
            content = parts.join("\n");
        }

        if (!content.trim()) continue;

        // Timestamp
        let timestamp = null;
        if (msg.created_at || msg.createTime) {
            timestamp = msg.created_at || msg.createTime;
        } else if (msg.create_time) {
            try {
                timestamp = new Date(msg.create_time * 1000).toISOString();
            } catch {
                // skip
            }
        }

        messages.push({ role, content, timestamp });
    }

    if (messages.length === 0) return null;

    // Derive title from first user message if API didn't provide one
    if (!title) {
        const firstUser = messages.find(m => m.role === "user");
        title = firstUser
            ? firstUser.content.slice(0, 80).replace(/\n/g, " ").trim() || "Untitled"
            : "Untitled";
    }

    // Extract model from message scenario/kimiPlus fields
    let model = "kimi";
    for (const msg of orderedMessages) {
        if (msg.kimiPlus?.name) { model = msg.kimiPlus.name; break; }
        if (msg.scenario === "SCENARIO_K2D5") { model = "k2.5"; break; }
        if (typeof msg.scenario === "string" && msg.scenario.startsWith("SCENARIO_")) {
            model = msg.scenario.replace("SCENARIO_", "").toLowerCase().replace(/_/g, "-");
            break;
        }
    }

    return {
        conversation_id: chatId,
        title,
        messages,
        metadata: { model },
        created_at: convMeta.createTime || convMeta.created_at || new Date().toISOString(),
        updated_at: convMeta.updateTime || convMeta.updated_at || new Date().toISOString(),
    };
}

export async function inspectKimiConversation(conversationId, options = {}) {
    const { mode = "full", count = 12, signal = null } = options;
    const token = await getKimiAccessToken();
    const [messagesData, chatMeta] = await Promise.all([
        fetchKimiMessages(token, conversationId, signal),
        fetchKimiChatMeta(token, conversationId, signal),
    ]);
    // GetChat may return the chat directly or nested under a "chat" key
    const meta = chatMeta?.chat || chatMeta;
    const convMeta = meta && (meta.name || meta.title)
        ? { ...meta, id: meta.id || meta.chat_id || conversationId }
        : { id: conversationId };
    const parsedBase = parseKimiConversation(convMeta, messagesData);
    if (!parsedBase) throw new Error("Could not parse conversation");

    const parsed = mode === "recent"
        ? buildRecentRangeConversation(parsedBase, count)
        : parsedBase;
    const markdown = formatMarkdown(parsed, "kimi");
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
export async function saveOneKimi(conversationId, options = {}) {
    const result = await inspectKimiConversation(conversationId, options);
    const sent = await sendToApp(result.parsed, "kimi", result.markdown);
    if (!sent) throw new Error("Failed to send to Kept app â€” is it running?");
    return {
        title: result.parsed.title,
        hash: result.hash,
        baseConversationId: result.baseConversationId,
        savedConversationId: result.savedConversationId,
    };
    if (false) {

    const token = await getKimiAccessToken();
    const messagesData = await fetchKimiMessages(token, conversationId);
    const parsed = parseKimiConversation(
        { id: conversationId, name: "Kimi Conversation" },
        messagesData,
    );
    if (!parsed) throw new Error("Could not parse conversation");

    const md = formatMarkdown(parsed, "kimi");
    const sent = await sendToApp(parsed, "kimi", md);
    if (!sent) throw new Error("Failed to send to Kept app — is it running?");
    return { title: parsed.title };
    }
}

// ── Sync ─────────────────────────────────────────────────────────────
export async function syncKimi(
    status,
    { getHashes, saveHashes, broadcastStatus, debug = false, debugMaxConversations = 5, maxConversations = 0, previousStatus = null, signal = null, afterSave = null },
) {
    status.kimi = { syncing: true, error: null, count: 0, lastSync: null };
    broadcastStatus(status);

    let convList = [];
    const hashes = await getHashes();
    let synced = 0;

    try {
        throwIfAborted(signal);
        const token = await getKimiAccessToken();
        convList = await fetchKimiConversations(token, signal);

        const effectiveMax = maxConversations > 0 ? maxConversations : (debug ? debugMaxConversations : 0);
        if (effectiveMax > 0 && convList.length > effectiveMax) {
            dbg(`Kimi: limiting to ${effectiveMax} conversations (was ${convList.length})`);
            convList = convList.slice(0, effectiveMax);
        }

        for (const item of convList) {
            throwIfAborted(signal);
            const chatId = item.id || item.chat_id;
            const messagesData = await fetchKimiMessages(token, chatId, signal);
            const parsed = parseKimiConversation(item, messagesData);
            if (!parsed) continue;

            const md = formatMarkdown(parsed, "kimi");
            const hash = await contentHash(md);
            const hashKey = `kimi:${parsed.conversation_id}`;

            if (hashes[hashKey] === hash) continue;

            throwIfAborted(signal);
            const sent = await sendToApp(parsed, "kimi", md, [], null, { signal });
            if (!sent) {
                await saveHashes(hashes);
                status.kimi = {
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
                    platform: "kimi",
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
            status.kimi = previousStatus
                ? { ...previousStatus, syncing: false }
                : { syncing: false, error: "Sync stopped", count: synced, total: convList.length, lastSync: null };
            broadcastStatus(status);
        }
        throw err;
    }

    await saveHashes(hashes);
    status.kimi = {
        syncing: false,
        error: null,
        count: synced,
        total: convList.length,
        lastSync: new Date().toISOString(),
    };
    broadcastStatus(status);
    return synced;
}
