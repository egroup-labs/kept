/**
 * Kept — Background Service Worker
 *
 * Orchestrates platform syncing (ChatGPT, Claude, Gemini, Grok, Kimi) using session cookies.
 * Platform-specific logic lives in platforms/{chatgpt,claude,gemini,grok,kimi}.js.
 * Shared utilities live in utils.js.
 */

import { syncChatGPT, saveOneChatGPT, inspectChatGPTConversation } from "./platforms/chatgpt.js";
import { syncClaude, saveOneClaude, inspectClaudeConversation } from "./platforms/claude.js";
import { syncGemini, saveOneGemini, inspectGeminiConversation } from "./platforms/gemini.js";
import { syncGrok, saveOneGrok, inspectGrokConversation } from "./platforms/grok.js";
import { syncKimi, saveOneKimi, inspectKimiConversation } from "./platforms/kimi.js";
import { AuthError, dbg, isAbortError, setDebugMode, getAppToken, getSyncTargetDir, KEPT_APP_URL } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────
const ALARM_NAME = "kept-auto-sync";
const DEFAULT_INTERVAL_MIN = 60;
const PING_ALARM_NAME = "kept-connect-ping";
const PING_INTERVAL_MIN = 5;
const CONNECT_FLOW_TIMEOUT_MS = 10_000;
const CONVERSATION_STATE_KEY = "conversationStates";
const DEFAULT_IDLE_MIN = 5;
const PROJECT_CACHE_TTL_MS = 2 * 60 * 1000;

/** When true, each provider fetches at most 5 conversations. */
const DEBUG = false;
const DEBUG_MAX_CONVERSATIONS = 5;

// ── Sync State (per-provider namespaced hashes) ─────────────────────
function makeProviderDeps(providerName, previousStatus = null, signal = null, afterSave = null, maxConversations = 0) {
  return {
    getHashes: async () => {
      const key = `contentHashes_${providerName}`;
      const result = await chrome.storage.local.get(key);
      return result[key] || {};
    },
    saveHashes: async (hashes) => {
      await chrome.storage.local.set({ [`contentHashes_${providerName}`]: hashes });
    },
    broadcastStatus,
    debug: DEBUG,
    debugMaxConversations: DEBUG_MAX_CONVERSATIONS,
    maxConversations,
    previousStatus,
    signal,
    afterSave,
  };
}

// ── Status Broadcasting ──────────────────────────────────────────────
function broadcastStatus(status) {
  chrome.storage.local.set({ lastStatus: status });
  chrome.runtime.sendMessage({ type: "sync-status", status }).catch(() => {
    // popup not open — that's fine
  });
}

// ── Sync Orchestrator (parallel) ─────────────────────────────────────
let syncing = false;
let syncAbort = null;
let lastSyncTime = 0;
const MIN_SYNC_INTERVAL_MS = 10_000; // 10 seconds
let pendingConnectFlow = null;

const PROVIDERS = [
  { name: "chatgpt", displayName: "ChatGPT", fn: syncChatGPT, save: saveOneChatGPT, inspect: inspectChatGPTConversation, supportsBranch: true },
  { name: "claude", displayName: "Claude", fn: syncClaude, save: saveOneClaude, inspect: inspectClaudeConversation, supportsBranch: false },
  { name: "gemini", displayName: "Gemini", fn: syncGemini, save: saveOneGemini, inspect: inspectGeminiConversation, supportsBranch: false },
  { name: "grok", displayName: "Grok", fn: syncGrok, save: saveOneGrok, inspect: inspectGrokConversation, supportsBranch: false },
  { name: "kimi", displayName: "Kimi", fn: syncKimi, save: saveOneKimi, inspect: inspectKimiConversation, supportsBranch: false },
];
const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((provider) => [provider.name, provider]));

function makeConversationStateKey(platform, conversationId) {
  return `${platform}:${conversationId}`;
}

function defaultEnabledProviders() {
  return Object.fromEntries(PROVIDERS.map(({ name }) => [name, true]));
}

async function getConversationStates() {
  const { [CONVERSATION_STATE_KEY]: states = {} } = await chrome.storage.local.get(CONVERSATION_STATE_KEY);
  return states;
}

async function saveConversationStates(states) {
  await chrome.storage.local.set({ [CONVERSATION_STATE_KEY]: states });
}

async function upsertConversationState({ platform, baseConversationId, savedConversationId, title, hash, mode = "full", project = null, status = "saved" }) {
  const states = await getConversationStates();
  const key = makeConversationStateKey(platform, baseConversationId);
  const previous = states[key] || {};
  states[key] = {
    ...previous,
    platform,
    baseConversationId,
    savedConversationId,
    title,
    hash: hash ?? previous.hash ?? null,
    mode,
    savedAt: new Date().toISOString(),
    status,
    projectId: project?.id || previous.projectId || null,
    projectName: project?.name || previous.projectName || null,
  };
  await saveConversationStates(states);
}

function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function getProjectScore(project, text) {
  const haystack = String(text || "").toLowerCase();
  const projectName = String(project.name || "").toLowerCase();
  const description = String(project.description || "").toLowerCase();
  let score = 0;

  if (projectName && haystack.includes(projectName)) score += 50;
  for (const token of normalizeWords(project.name)) {
    if (haystack.includes(token)) score += 10;
  }
  for (const token of normalizeWords(project.description).slice(0, 8)) {
    if (haystack.includes(token)) score += 2;
  }
  if (description && haystack.includes(description)) score += 8;
  return score;
}

let projectCache = { loadedAt: 0, projects: [] };

async function fetchProjectsFromApp() {
  const now = Date.now();
  if (now - projectCache.loadedAt < PROJECT_CACHE_TTL_MS && projectCache.projects.length > 0) {
    return projectCache.projects;
  }

  const token = await getAppToken();
  if (!token) {
    throw new Error("Not connected to Kept app");
  }

  const resp = await fetch(`${KEPT_APP_URL}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = await resp.json();
  projectCache = {
    loadedAt: now,
    projects: Array.isArray(data.projects) ? data.projects : [],
  };
  return projectCache.projects;
}

async function linkConversationToProject(projectId, conversationId) {
  const token = await getAppToken();
  if (!token) throw new Error("Not connected to Kept app");

  const resp = await fetch(`${KEPT_APP_URL}/api/projects/${encodeURIComponent(projectId)}/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ conversation_id: conversationId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
}

async function maybeRouteConversation({ platform, title, baseConversationId, savedConversationId, context = {} }) {
  const { autoRouteProjects = false } = await chrome.storage.local.get("autoRouteProjects");
  if (!autoRouteProjects) return null;

  let projects;
  try {
    projects = await fetchProjectsFromApp();
  } catch (err) {
    dbg(`Project fetch failed: ${err.message}`);
    return null;
  }
  if (projects.length === 0) return null;

  const text = [title, context.pageTitle, context.url, platform].filter(Boolean).join(" \n ").toLowerCase();
  let bestProject = null;
  let bestScore = 0;
  for (const project of projects) {
    const score = getProjectScore(project, text);
    if (score > bestScore) {
      bestScore = score;
      bestProject = project;
    }
  }
  if (!bestProject || bestScore < 20) return null;

  await linkConversationToProject(bestProject.id, savedConversationId);
  await upsertConversationState({
    platform,
    baseConversationId,
    savedConversationId,
    title,
    hash: null,
    status: "routed",
    project: bestProject,
  });
  return bestProject;
}

async function recordConversationSave(result, context = {}, options = {}) {
  const project = await maybeRouteConversation({
    platform: options.platform,
    title: result.title,
    baseConversationId: result.baseConversationId,
    savedConversationId: result.savedConversationId,
    context,
  }).catch((err) => {
    dbg(`Project routing failed: ${err.message}`);
    return null;
  });

  await upsertConversationState({
    platform: options.platform,
    baseConversationId: result.baseConversationId,
    savedConversationId: result.savedConversationId,
    title: result.title,
    hash: result.hash,
    mode: options.mode || "full",
    project,
    status: project ? "routed" : "saved",
  });

  return project;
}

async function inspectConversation(platform, conversationId) {
  const provider = PROVIDER_MAP[platform];
  if (!provider?.inspect) throw new Error("Unsupported platform");
  return provider.inspect(conversationId, { mode: "full" });
}

async function saveConversationWithMode({ platform, conversationId, mode = "full", count = 12, context = {} }) {
  const provider = PROVIDER_MAP[platform];
  if (!provider?.save) throw new Error("Invalid platform");
  if (mode === "branch" && !provider.supportsBranch) {
    throw new Error("Branch export is not supported for this provider");
  }

  const result = await provider.save(conversationId, { mode, count });
  const project = await recordConversationSave(result, context, { platform, mode });
  return { ...result, project };
}

async function isBrowserIdle() {
  const { syncOnlyWhenIdle = false, syncIdleMin = DEFAULT_IDLE_MIN } =
    await chrome.storage.local.get(["syncOnlyWhenIdle", "syncIdleMin"]);
  if (!syncOnlyWhenIdle) return true;

  const threshold = Math.max(1, Number(syncIdleMin) || DEFAULT_IDLE_MIN) * 60;
  const state = await chrome.idle.queryState(threshold);
  return state === "idle" || state === "locked";
}

function settleConnectFlow(flow, ok) {
  if (!flow || pendingConnectFlow !== flow) return;
  clearTimeout(flow.timeoutId);
  pendingConnectFlow = null;
  flow.resolve(ok);
}

async function closeTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // tab already gone
  }
}

async function startConnectFlow({ active = false, autoClose = true } = {}) {
  if (pendingConnectFlow) return pendingConnectFlow.promise;

  let resolveFlow;
  const promise = new Promise((resolve) => {
    resolveFlow = resolve;
  });
  const flow = {
    promise,
    resolve: resolveFlow,
    timeoutId: null,
    tabId: null,
    autoClose,
  };
  pendingConnectFlow = flow;

  try {
    const connectUrl = new URL(`${KEPT_APP_URL}/connect`);
    if (autoClose) connectUrl.searchParams.set("close", "1");
    const tab = await chrome.tabs.create({ url: connectUrl.toString(), active });
    flow.tabId = tab.id ?? null;
    flow.timeoutId = setTimeout(() => {
      settleConnectFlow(flow, false);
      if (flow.autoClose) closeTab(flow.tabId);
    }, CONNECT_FLOW_TIMEOUT_MS);
  } catch (err) {
    pendingConnectFlow = null;
    dbg(`Failed to open connect page: ${err.message}`);
    return false;
  }

  return promise;
}

async function ensureAppConnection({ active = false, autoClose = true } = {}) {
  const token = await getAppToken();
  if (token && await notifyAppConnection(token)) {
    return true;
  }
  dbg("App token missing or stale, refreshing connection");
  return startConnectFlow({ active, autoClose });
}

async function syncAll({ manual = false, providers = null, maxConversations = 0 } = {}) {
  if (syncing) return;
  const now = Date.now();
  if (now - lastSyncTime < MIN_SYNC_INTERVAL_MS) return;
  if (!manual && !await isBrowserIdle()) {
    dbg("Skipping auto-sync because the browser is active");
    return;
  }
  lastSyncTime = now;
  syncing = true;
  syncAbort = new AbortController();
  const { signal } = syncAbort;
  const { enabledProviders = defaultEnabledProviders(), syncLimit = 0 } = await chrome.storage.local.get(["enabledProviders", "syncLimit"]);
  // Use explicitly passed maxConversations, or fall back to the stored syncLimit (0 = unlimited)
  const effectiveLimit = maxConversations > 0 ? maxConversations : (syncLimit > 0 ? syncLimit : 0);
  // If specific providers were requested (e.g. from onboarding), use those; otherwise use settings
  const activeProviders = providers
    ? PROVIDERS.filter(({ name }) => providers.includes(name))
    : PROVIDERS.filter(({ name }) => enabledProviders[name] !== false);

  // Load previously persisted status so each provider's last known state is
  // preserved. Providers that sync successfully (or fail) will overwrite their
  // own key; providers that haven't run yet keep their previous result.
  const { lastStatus: prevStatus = {} } = await chrome.storage.local.get("lastStatus");
  const status = { ...prevStatus, syncing: true };
  for (const { name } of PROVIDERS) {
    if (enabledProviders[name] === false) {
      status[name] = {
        ...(prevStatus[name] || {}),
        syncing: false,
        disabled: true,
        error: null,
      };
    } else if (status[name]?.disabled) {
      status[name] = { ...status[name], disabled: false };
    }
  }

  // Treat signed-out providers as inactive for this run — same behaviour as
  // a user-disabled toggle. The notLoggedIn marker stays set until the user
  // explicitly retries via the popup toggle (which clears it through
  // `clear-auth-state`).
  const skipSignedOut = providers
    ? new Set() // explicit override (e.g. retry from toggle) — don't filter
    : new Set(
        PROVIDERS
          .map(({ name }) => name)
          .filter((name) => prevStatus[name]?.notLoggedIn === true),
      );
  const finalProviders = activeProviders.filter(({ name }) => !skipSignedOut.has(name));

  dbg("=== Sync started (parallel) ===");

  const appConnected = await ensureAppConnection({ active: false, autoClose: true });
  if (!appConnected) {
    status.syncing = false;
    for (const { name } of activeProviders) {
      status[name] = {
        ...(prevStatus[name] || {}),
        syncing: false,
        error: "Not connected to Kept app",
      };
    }
    syncing = false;
    syncAbort = null;
    await chrome.storage.local.set({ lastStatus: status });
    broadcastStatus(status);
    return;
  }

  // MV3 service workers are terminated after ~30s idle. Long syncs (thousands
  // of conversations × rate-limited fetches) can silently die mid-loop. A
  // periodic trivial chrome.* call keeps the worker alive for the sync duration.
  const keepaliveId = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);

  try {
    // Launch all (non-skipped) providers in parallel
    await Promise.allSettled(
      finalProviders.map(async ({ name, displayName, fn }) => {
        if (signal.aborted) return;
        try {
          dbg(`Syncing ${name}...`);
          await fn(
            status,
            makeProviderDeps(
              name,
              prevStatus[name] || null,
              signal,
              async (result) => {
                await recordConversationSave(result, {}, { platform: name, mode: "full" });
              },
              effectiveLimit,
            ),
          );
          dbg(`${name} done:`, status[name]?.count, "new /", status[name]?.total, "total");
        } catch (err) {
          if (signal.aborted || isAbortError(err)) return;
          dbg(`${name} error:`, err.name, err.message);
          const isAuth = err instanceof AuthError;
          status[name] = {
            syncing: false,
            notLoggedIn: isAuth,
            error: isAuth
              ? `Not logged in to ${displayName}`
              : err.message,
            count: 0,
            lastSync: null,
          };
          broadcastStatus(status);
        }
      })
    );
  } finally {
    clearInterval(keepaliveId);
    status.syncing = false;
    for (const { name } of finalProviders) {
      if (!status[name]) continue;
      if (signal.aborted && status[name].syncing) {
        status[name] = prevStatus[name]
          ? { ...prevStatus[name], syncing: false }
          : { syncing: false, error: "Sync stopped", count: 0, lastSync: null };
      } else if (status[name].syncing) {
        status[name].syncing = false;
      }
    }
    syncing = false;
    syncAbort = null;

    dbg(signal.aborted ? "=== Sync stopped ===" : "=== Sync finished ===", JSON.stringify(status));

    // Persist last sync status
    await chrome.storage.local.set({ lastStatus: status });
    broadcastStatus(status);
  }
}

function stopSync() {
  if (syncAbort) {
    syncAbort.abort();
    lastSyncTime = 0;
    dbg("Sync stop requested");
  }
}

// ── Auto-sync Alarms ─────────────────────────────────────────────────
async function setupAlarm() {
  const { autoSync = false, syncIntervalMin = DEFAULT_INTERVAL_MIN } =
    await chrome.storage.local.get(["autoSync", "syncIntervalMin"]);

  await chrome.alarms.clear(ALARM_NAME);

  if (autoSync) {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: syncIntervalMin,
    });
  }
}

// ── App Connection Ping ──────────────────────────────────────────────
async function notifyAppConnection(appToken = null) {
  const token = appToken ?? await getAppToken();
  if (!token) return false;
  try {
    const resp = await fetch(`${KEPT_APP_URL}/api/extension_ping`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) {
      dbg(`Extension ping failed: HTTP ${resp.status}`);
      return false;
    }
    // Check if the app requested a sync (e.g. from onboarding)
    try {
      const body = await resp.json();
      if (body.sync_requested) {
        dbg("App requested sync via ping response");
        syncAll({ manual: true });
      }
      // Store restricted mode flag so content scripts can check it
      chrome.storage.local.set({ restricted_mode: !!body.restricted_mode });
    } catch (_) { /* ignore parse errors */ }
    return true;
  } catch (err) {
    dbg(`Extension ping failed: ${err.message}`);
    return false;
  }
}

async function setupPingAlarm() {
  await chrome.alarms.clear(PING_ALARM_NAME);
  chrome.alarms.create(PING_ALARM_NAME, {
    periodInMinutes: PING_INTERVAL_MIN,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncAll();
  } else if (alarm.name === PING_ALARM_NAME) {
    notifyAppConnection();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const flow = pendingConnectFlow;
  if (flow?.tabId === tabId) {
    settleConnectFlow(flow, false);
  }
});

// ── Message Handlers (popup communication) ───────────────────────────
const ALLOWED_SETTINGS = {
  autoSync: "boolean",
  syncIntervalMin: "number",
  debugMode: "boolean",
  keptAppToken: "string",
  enabledProviders: "object",
  syncOnlyWhenIdle: "boolean",
  syncIdleMin: "number",
  autoRouteProjects: "boolean",
  syncLimit: "number",
  syncTargetDir: "string",
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension (popup pages + content scripts)
  if (sender.id !== chrome.runtime.id) return;
  const isExtensionPage = sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  const isContentScript = !!sender.tab;
  if (!isExtensionPage && !isContentScript) return;

  if (msg.type === "kimi-auth-token") {
    if (typeof msg.token === "string" && msg.token) {
      chrome.storage.local.set({ kimiAuthToken: msg.token });
      dbg("Kimi auth token cached from content script");
    }
    return;
  }

  if (msg.type === "connect-app") {
    startConnectFlow({
      active: !!msg.active,
      autoClose: msg.autoClose !== false,
    })
      .then((ok) => {
        sendResponse({ ok });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.type === "connect-flow-result") {
    (async () => {
      let ok = false;
      let error = msg.error || "Failed to connect to Kept";

      if (msg.ok && typeof msg.token === "string" && msg.token) {
        ok = await notifyAppConnection(msg.token);
        if (!ok) error = "Could not verify the Kept desktop app";
        // Schedule a follow-up ping to pick up any pending sync requests
        // (e.g. from the onboarding import step)
        if (ok) setTimeout(() => notifyAppConnection(msg.token), 2000);
      }

      const flow = pendingConnectFlow;
      if (flow) settleConnectFlow(flow, ok);

      if (msg.autoClose && sender.tab?.id != null) {
        await closeTab(sender.tab.id);
      }

      sendResponse(ok ? { ok: true } : { ok: false, error });
    })();
    return true;
  }

  // ── Get app token (for direct API calls from content script) ──
  if (msg.type === "get-app-token") {
    getAppToken()
      .then((token) => sendResponse({ ok: true, token }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Agent chat (proxied through background to avoid Private Network Access prompts) ──
  if (msg.type === "agent-chat") {
    (async () => {
      try {
        const token = await getAppToken();
        if (!token) {
          sendResponse({ ok: false, error: "Not connected — run Connect Application first" });
          return;
        }
        const resp = await fetch(`${KEPT_APP_URL}/api/agent/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({
            prompt: msg.prompt,
            url: msg.url || "unknown",
            page_title: msg.page_title || "",
            page_content: msg.page_content || "",
            has_selection: msg.has_selection || false,
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          sendResponse({ ok: false, status: resp.status, error: text || `Error ${resp.status}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ ok: true, content: data.content, tool_executions: data.tool_executions, iterations: data.iterations });
      } catch (err) {
        sendResponse({ ok: false, error: err.name === "TimeoutError" ? "Request timed out" : (err.message || "Connection error") });
      }
    })();
    return true;
  }

  // ── Save agent chat to vault (from content script) ──
  if (msg.type === "save-agent-chat") {
    (async () => {
      try {
        const token = await getAppToken();
        if (!token) {
          sendResponse({ ok: false, error: "Not connected to Kept app" });
          return;
        }
        const targetDir = await getSyncTargetDir();
        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        };
        if (targetDir) headers["X-Kept-Target-Dir"] = targetDir;
        const resp = await fetch(`${KEPT_APP_URL}/api/ingest`, {
          method: "POST",
          headers,
          body: JSON.stringify(msg.payload),
          signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          sendResponse({ ok: false, error: text || `Error ${resp.status}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ ok: true, file_path: data.file_path });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Connection error" });
      }
    })();
    return true;
  }

  // ── Save single conversation (from content script command palette) ──
  if (msg.type === "save-conversation") {
    if (!PROVIDER_MAP[msg.platform] || !msg.conversationId) {
      sendResponse({ ok: false, error: "Invalid platform or conversation ID" });
      return;
    }
    dbg(`Saving ${msg.platform} conversation: ${msg.conversationId}`);
    saveConversationWithMode({
      platform: msg.platform,
      conversationId: msg.conversationId,
      mode: msg.mode || "full",
      count: msg.count || 12,
      context: msg.context || {},
    })
      .then((result) => {
        dbg(`Saved ${msg.platform} conversation: ${result.title}`);
        sendResponse({
          ok: true,
          title: result.title,
          project: result.project?.name || null,
          baseConversationId: result.baseConversationId,
          savedConversationId: result.savedConversationId,
        });
      })
      .catch((err) => {
        dbg(`Save failed for ${msg.platform}: ${err.message}`);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async response
  }

  // ── Project operations (from content script command palette) ──
  if (msg.type === "get-conversation-state") {
    (async () => {
      try {
        const result = await inspectConversation(msg.platform, msg.conversationId);
        const states = await getConversationStates();
        const saved = states[makeConversationStateKey(msg.platform, result.baseConversationId)];
        const state = !saved
          ? "unsynced"
          : saved.hash === result.hash
            ? (saved.projectName ? "routed" : "saved")
            : "changed";
        sendResponse({
          ok: true,
          state,
          title: result.parsed.title,
          project: saved?.projectName || null,
          savedAt: saved?.savedAt || null,
          baseConversationId: result.baseConversationId,
          savedConversationId: saved?.savedConversationId || result.savedConversationId,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "open-kept-conversation") {
    (async () => {
      try {
        const token = await getAppToken();
        if (!token) {
          sendResponse({ ok: false, error: "Not connected to Kept app" });
          return;
        }
        const resp = await fetch(`${KEPT_APP_URL}/api/open_conversation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ file_path: msg.filePath }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
          return;
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "list-projects") {
    (async () => {
      try {
        const projects = await fetchProjectsFromApp();
        sendResponse({ ok: true, projects });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "create-project") {
    (async () => {
      try {
        const token = await getAppToken();
        if (!token) { sendResponse({ ok: false, error: "Not connected to Kept app" }); return; }
        const resp = await fetch(`${KEPT_APP_URL}/api/projects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: msg.name, description: msg.description || "" }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) { sendResponse({ ok: false, error: `HTTP ${resp.status}` }); return; }
        const data = await resp.json();
        projectCache.loadedAt = 0;
        sendResponse({ ok: true, id: data.id, name: data.name });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "link-project") {
    (async () => {
      try {
        const token = await getAppToken();
        if (!token) { sendResponse({ ok: false, error: "Not connected to Kept app" }); return; }
        const resp = await fetch(`${KEPT_APP_URL}/api/projects/${encodeURIComponent(msg.projectId)}/link`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ conversation_id: msg.conversationId }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) { sendResponse({ ok: false, error: `HTTP ${resp.status}` }); return; }
        if (msg.platform && msg.baseConversationId && msg.projectName) {
          await upsertConversationState({
            platform: msg.platform,
            baseConversationId: msg.baseConversationId,
            savedConversationId: msg.savedConversationId || msg.conversationId,
            title: msg.title || "Conversation",
            hash: msg.hash || null,
            status: "routed",
            project: { id: msg.projectId, name: msg.projectName },
          });
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "sync-now") {
    syncAll({
      manual: true,
      providers: Array.isArray(msg.providers) ? msg.providers : null,
      maxConversations: typeof msg.maxConversations === "number" ? msg.maxConversations : 0,
    });
    sendResponse({ ok: true });
    return true; // keep message channel open for async callers
  } else if (msg.type === "retry-auth") {
    // User toggled a previously signed-out provider back on. Clear the
    // marker and trigger a single-provider sync run; if the user is still
    // signed out the next AuthError will re-mark it.
    const provider = typeof msg.provider === "string" ? msg.provider : null;
    if (!provider) {
      sendResponse({ ok: false, error: "Missing provider" });
      return true;
    }
    chrome.storage.local.get("lastStatus").then(({ lastStatus = {} }) => {
      if (lastStatus[provider]) {
        lastStatus[provider] = { ...lastStatus[provider], notLoggedIn: false, error: null };
      }
      chrome.storage.local.set({ lastStatus }).then(() => {
        broadcastStatus(lastStatus);
        syncAll({ manual: true, providers: [provider] });
        sendResponse({ ok: true });
      });
    });
    return true;
  } else if (msg.type === "stop-sync") {
    stopSync();
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === "get-status") {
    chrome.storage.local.get("lastStatus").then(({ lastStatus }) => {
      sendResponse({ status: lastStatus || {} });
    });
    return true; // async response
  } else if (msg.type === "update-settings") {
    if (!msg.settings || typeof msg.settings !== "object") {
      sendResponse({ error: "Invalid settings" });
      return;
    }
    const sanitized = {};
    for (const [key, value] of Object.entries(msg.settings)) {
      if (!(key in ALLOWED_SETTINGS)) continue;
      if (typeof value !== ALLOWED_SETTINGS[key]) continue;
      if (key === "syncIntervalMin" && (value < 1 || value > 1440)) continue;
      if (key === "syncIdleMin" && (value < 1 || value > 120)) continue;
      if (key === "syncLimit" && (value < 0 || value > 1000)) continue;
      if (key === "keptAppToken" && (value.trim().length === 0 || value.length > 256)) continue;
      if (key === "syncTargetDir" && value.length > 1024) continue;
      if (key === "enabledProviders") {
        const providers = defaultEnabledProviders();
        for (const providerName of Object.keys(providers)) {
          if (typeof value[providerName] === "boolean") {
            providers[providerName] = value[providerName];
          }
        }
        sanitized[key] = providers;
        continue;
      }
      sanitized[key] = value;
    }
    chrome.storage.local.set(sanitized).then(() => {
      if ("debugMode" in sanitized) setDebugMode(sanitized.debugMode);
      setupAlarm();
      if ("keptAppToken" in sanitized) {
        notifyAppConnection(sanitized.keptAppToken);
      }
      sendResponse({ ok: true });
    });
    return true; // async response
  }
});

// ── Initialization ───────────────────────────────────────────────────
// If the service worker was terminated mid-sync, the persisted status
// will still show syncing=true. Clear it on startup so the UI isn't stuck.
chrome.storage.local.get("lastStatus").then(({ lastStatus }) => {
  if (lastStatus?.syncing) {
    lastStatus.syncing = false;
    for (const key of Object.keys(lastStatus)) {
      if (lastStatus[key]?.syncing) lastStatus[key].syncing = false;
    }
    chrome.storage.local.set({ lastStatus });
  }
});

chrome.storage.local.get(["enabledProviders", "syncIdleMin", "syncOnlyWhenIdle", "autoRouteProjects"]).then((stored) => {
  const updates = {};
  const defaultProviders = defaultEnabledProviders();

  if (!stored.enabledProviders || typeof stored.enabledProviders !== "object") {
    updates.enabledProviders = defaultProviders;
  } else {
    const mergedProviders = { ...defaultProviders };
    let changed = false;
    for (const providerName of Object.keys(defaultProviders)) {
      if (typeof stored.enabledProviders[providerName] === "boolean") {
        mergedProviders[providerName] = stored.enabledProviders[providerName];
      }
      if (mergedProviders[providerName] !== stored.enabledProviders[providerName]) {
        changed = true;
      }
    }
    if (changed) {
      updates.enabledProviders = mergedProviders;
    }
  }

  if (typeof stored.syncIdleMin !== "number") updates.syncIdleMin = DEFAULT_IDLE_MIN;
  if (typeof stored.syncOnlyWhenIdle !== "boolean") updates.syncOnlyWhenIdle = false;
  if (typeof stored.autoRouteProjects !== "boolean") updates.autoRouteProjects = false;

  if (Object.keys(updates).length > 0) {
    chrome.storage.local.set(updates);
  }
});
syncing = false;

// ── Storage change listener ──────────────────────────────────────────
// Ping the app whenever keptAppToken changes so manual token updates
// and /connect flows both refresh the desktop-app heartbeat quickly.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.keptAppToken) {
    projectCache = { loadedAt: 0, projects: [] };
    if (changes.keptAppToken.newValue) {
      notifyAppConnection(changes.keptAppToken.newValue);
    }
  }
});

setupAlarm();
setupPingAlarm();
notifyAppConnection();
