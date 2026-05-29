/**
 * platforms/claude.js
 *
 * Claude platform adapter for Kept.
 * Handles API access, conversation parsing, and syncing.
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
import { CLAUDE_PAGE_SIZE, CLAUDE_MAX_PAGES } from "../config.js";

// ── Claude Fetchers ──────────────────────────────────────────────────
const CLAUDE_HEADERS = { "Content-Type": "application/json", "Accept": "application/json" };

async function getClaudeOrgId(signal = null) {
    const resp = await rateLimitedFetch("https://claude.ai/api/organizations", {
        headers: CLAUDE_HEADERS,
        signal,
    });
    const orgs = await resp.json();
    dbg("Claude orgs response:", JSON.stringify(orgs).slice(0, 300));
    if (!Array.isArray(orgs) || orgs.length === 0) {
        throw new Error("No Claude organizations found");
    }
    dbg("Claude orgId:", orgs[0].uuid);
    return orgs[0].uuid;
}

async function fetchClaudeConversations(orgId, signal = null) {
    const allConversations = [];
    let cursor = null;
    let offset = 0;
    let page = 0;

    do {
        let url = `https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=${CLAUDE_PAGE_SIZE}`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
        else if (offset > 0) url += `&offset=${offset}`;

        const resp = await rateLimitedFetch(url, { headers: CLAUDE_HEADERS, signal });
        const data = await resp.json();

        const items = Array.isArray(data) ? data : (data.conversations || data.items || []);
        dbg(`Claude conversations page ${++page}:`, items.length, "items");
        if (items.length === 0) break;

        allConversations.push(...items);

        if (Array.isArray(data)) {
            // Offset-based pagination: a full page implies there may be more
            if (items.length < CLAUDE_PAGE_SIZE) break;
            offset += items.length;
            cursor = null;
        } else {
            cursor = data.cursor || data.nextCursor || null;
            if (!cursor) break;
        }
    } while (page < CLAUDE_MAX_PAGES);

    dbg("Claude total conversations fetched:", allConversations.length);
    return allConversations;
}

async function fetchClaudeConversation(orgId, convId, signal = null) {
    const resp = await rateLimitedFetch(
        `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}`,
        { headers: CLAUDE_HEADERS, signal }
    );
    return resp.json();
}

// ── Claude Parser ────────────────────────────────────────────────────
function parseClaudeConversation(body) {
    const convId = body.uuid;
    if (!convId) return null;

    const title = body.name || "Untitled";
    const model = body.model || "unknown";
    const chatMessages = body.chat_messages || [];

    const messages = [];
    for (const msg of chatMessages) {
        const senderMap = { human: "user", assistant: "assistant" };
        const role = senderMap[msg.sender];
        if (!role) continue;

        // Claude messages can have text directly or content array
        let content = msg.text || "";
        if (!content && Array.isArray(msg.content)) {
            content = msg.content
                .filter((b) => b.type === "text")
                .map((b) => b.text || "")
                .join("\n");
        }
        if (!content.trim()) continue;

        messages.push({
            role,
            content,
            timestamp: msg.created_at || null,
        });
    }

    if (messages.length === 0) return null;

    return {
        conversation_id: convId,
        title,
        messages,
        metadata: { model },
        created_at: body.created_at,
        updated_at: body.updated_at,
    };
}

export async function inspectClaudeConversation(conversationId, options = {}) {
    const { mode = "full", count = 12, signal = null } = options;
    const orgId = await getClaudeOrgId(signal);
    const fullConv = await fetchClaudeConversation(orgId, conversationId, signal);
    const parsedBase = parseClaudeConversation(fullConv);
    if (!parsedBase) throw new Error("Could not parse conversation");

    const parsed = mode === "recent"
        ? buildRecentRangeConversation(parsedBase, count)
        : parsedBase;
    const markdown = formatMarkdown(parsed, "claude");
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
export async function saveOneClaude(conversationId, options = {}) {
    const result = await inspectClaudeConversation(conversationId, options);
    const sent = await sendToApp(result.parsed, "claude", result.markdown);
    if (!sent) throw new Error("Failed to send to Kept app â€” is it running?");
    return {
        title: result.parsed.title,
        hash: result.hash,
        baseConversationId: result.baseConversationId,
        savedConversationId: result.savedConversationId,
    };
    if (false) {

    const orgId = await getClaudeOrgId();
    const fullConv = await fetchClaudeConversation(orgId, conversationId);
    const parsed = parseClaudeConversation(fullConv);
    if (!parsed) throw new Error("Could not parse conversation");

    const md = formatMarkdown(parsed, "claude");
    const sent = await sendToApp(parsed, "claude", md);
    if (!sent) throw new Error("Failed to send to Kept app — is it running?");
    return { title: parsed.title };
    }
}

// ── Sync ─────────────────────────────────────────────────────────────
export async function syncClaude(
    status,
    { getHashes, saveHashes, broadcastStatus, debug = false, debugMaxConversations = 5, maxConversations = 0, previousStatus = null, signal = null, afterSave = null },
) {
    status.claude = { syncing: true, error: null, count: 0, lastSync: null };
    broadcastStatus(status);

    let convList = [];
    const hashes = await getHashes();
    let synced = 0;

    try {
        throwIfAborted(signal);
        const orgId = await getClaudeOrgId(signal);
        convList = await fetchClaudeConversations(orgId, signal);

        const effectiveMax = maxConversations > 0 ? maxConversations : (debug ? debugMaxConversations : 0);
        if (effectiveMax > 0 && convList.length > effectiveMax) {
            dbg(`Claude: limiting to ${effectiveMax} conversations (was ${convList.length})`);
            convList = convList.slice(0, effectiveMax);
        }

        for (const item of convList) {
            throwIfAborted(signal);
            const fullConv = await fetchClaudeConversation(orgId, item.uuid, signal);
            const parsed = parseClaudeConversation(fullConv);
            if (!parsed) continue;

            const md = formatMarkdown(parsed, "claude");
            const hash = await contentHash(md);
            const hashKey = `claude:${parsed.conversation_id}`;

            if (hashes[hashKey] === hash) continue; // unchanged

            throwIfAborted(signal);
            const sent = await sendToApp(parsed, "claude", md, [], null, { signal });
            if (!sent) {
                await saveHashes(hashes);
                status.claude = {
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
                    platform: "claude",
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
            status.claude = previousStatus
                ? { ...previousStatus, syncing: false }
                : { syncing: false, error: "Sync stopped", count: synced, total: convList.length, lastSync: null };
            broadcastStatus(status);
        }
        throw err;
    }

    await saveHashes(hashes);
    status.claude = {
        syncing: false,
        error: null,
        count: synced,
        total: convList.length,
        lastSync: new Date().toISOString(),
    };
    broadcastStatus(status);
    return synced;
}
