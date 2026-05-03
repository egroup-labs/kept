/**
 * command-palette.js
 *
 * Content script injected into ChatGPT, Claude, Gemini, Grok, and Kimi pages.
 * Monitors text input for the "@kept" trigger and shows an inline chip
 * over the trigger text with a filterable command palette.
 */

(() => {
  // ── Platform detection ──────────────────────────────────────────────
  const PLATFORM_MAP = {
    "chatgpt.com": "chatgpt",
    "claude.ai": "claude",
    "gemini.google.com": "gemini",
    "grok.com": "grok",
    "www.kimi.com": "kimi",
    "teams.microsoft.com": "teams",
    "teams.cloud.microsoft": "teams",
    "www.youtube.com": "youtube",
  };

  // Platforms that support conversation export (AI chat sites)
  const AI_PLATFORMS = new Set(["chatgpt", "claude", "gemini", "grok", "kimi"]);

  const hostname = window.location.hostname;
  const platform = PLATFORM_MAP[hostname] || null;
  const isAIPlatform = platform ? AI_PLATFORMS.has(platform) : false;

  // ── Conversation ID extraction ──────────────────────────────────────
  function getConversationId() {
    const path = window.location.pathname;
    switch (platform) {
      case "chatgpt": {
        const m = path.match(/\/[cg]\/([a-f0-9-]+)/);
        return m ? m[1] : null;
      }
      case "claude": {
        const m = path.match(/\/chat\/([a-f0-9-]+)/);
        return m ? m[1] : null;
      }
      case "gemini": {
        const m = path.match(/\/app\/([a-zA-Z0-9_-]+)/);
        return m ? m[1] : null;
      }
      case "grok": {
        const m = path.match(/\/c\/([a-f0-9-]+)/);
        return m ? m[1] : null;
      }
      case "kimi": {
        const m = path.match(/\/chat\/([a-zA-Z0-9_-]+)/);
        return m ? m[1] : null;
      }
      default:
        return null;
    }
  }

  let threadState = null;
  let threadStateRequestId = 0;
  let lastObservedUrl = window.location.href;
  let threadBadgeHost = null;
  let threadBadgeEl = null;

  // Restricted privacy mode — disables agent chat from the extension
  let restrictedMode = false;
  try {
    chrome.storage.local.get("restricted_mode", (result) => {
      restrictedMode = !!result.restricted_mode;
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.restricted_mode) {
        restrictedMode = !!changes.restricted_mode.newValue;
      }
    });
  } catch (_) { /* storage unavailable */ }

  // ── Commands registry ───────────────────────────────────────────────

  function getPageContext() {
    // Prefer selected text if any
    const selection = window.getSelection()?.toString().trim();
    if (selection && selection.length > 20) {
      return { url: window.location.href, pageTitle: document.title, text: selection.slice(0, 30000), selected: true };
    }

    // Extract main content, avoiding nav/header/footer noise
    const main = document.querySelector("main, article, [role='main']");
    const root = main || document.body;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "NAV", "HEADER", "FOOTER"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (el.offsetParent === null && el.style?.display !== "contents") {
          return NodeFilter.FILTER_REJECT;
        }
        const text = node.textContent.trim();
        if (text.length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const chunks = [];
    let totalLen = 0;
    const MAX_LEN = 30000;
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (totalLen + text.length > MAX_LEN) {
        chunks.push(text.slice(0, MAX_LEN - totalLen));
        break;
      }
      chunks.push(text);
      totalLen += text.length;
    }

    return { url: window.location.href, pageTitle: document.title, text: chunks.join("\n"), selected: false };
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function stripHtml(value) {
    return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  function truncateText(value, max = 96) {
    const text = String(value || "").trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
  }

  function cleanPageTitle(value = document.title || "") {
    return String(value || "")
      .replace(/\s*[\-|:]\s*(ChatGPT|Claude|Gemini|Grok|Kimi|Microsoft Teams|YouTube).*$/i, "")
      .trim();
  }

  function formatRelativeShort(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
    return date.toLocaleDateString();
  }

  function getCommands() {
    const convId = isAIPlatform ? getConversationId() : null;
    const commands = [];

    if (isAIPlatform) {
      commands.push(
        {
          id: "save",
          label: "Export Chat",
          keywords: ["save", "download", "export", "backup", "keep"],
          run: () => {
            if (convId) saveConversation(convId);
            else showStatus("error", "No conversation open");
          },
        },
        {
          id: "range",
          label: "Export Recent Range",
          keywords: ["range", "recent", "slice", "window", "subset"],
          run: () => {
            if (!convId) { showStatus("error", "No conversation open"); return; }
            showRangePicker(convId);
          },
        },
        {
          id: "project",
          label: "Add to project",
          keywords: ["project", "folder", "organize", "group", "collection"],
          run: () => {
            if (!convId) { showStatus("error", "No conversation open"); return; }
            showProjectPicker(convId);
          },
        },
      );

      if (platform === "chatgpt") {
        commands.splice(1, 0, {
          id: "branch",
          label: "Export Current Branch",
          keywords: ["branch", "fork", "path", "thread"],
          run: () => {
            if (!convId) { showStatus("error", "No conversation open"); return; }
            saveConversation(convId, { mode: "branch" });
          },
        });
      }
    }

    // Show "Ask Kept" as a command on non-AI sites (agent is the primary use case there)
    if (!isAIPlatform && !restrictedMode) {
      commands.push({
        id: "ask",
        label: "Ask Kept",
        keywords: ["ask", "chat", "question", "search", "help", "agent"],
        run: () => {
          // Switch to agent chat mode — show chat history and prompt for input
          filterText = "";
          renderPalette();
        },
      });
    }

    // Show "Save Chat" when there's an active agent conversation
    if (chatHistory.length >= 2) {
      commands.push({
        id: "save-agent-chat",
        label: "Save Chat to Vault",
        keywords: ["save", "export", "archive", "vault", "keep", "note"],
        run: () => { saveAgentChat(); },
      });
    }

    // Show "Resume Chat" when there's a stored conversation for this site
    if (hasStoredChat && !restrictedMode) {
      commands.push({
        id: "resume",
        label: "Resume Chat",
        keywords: ["resume", "history", "continue", "previous", "last", "old"],
        run: () => { loadChatFromStorage(); },
      });
    }

    commands.push({
      id: "connect",
      label: "Connect Application",
      keywords: ["connect", "link", "auth", "token", "login", "refresh"],
      run: () => { connectToApp(); },
    });

    return commands;
  }

  function filterCommands(query) {
    const q = (query || "").trim().toLowerCase();
    const commands = getCommands();
    if (!q) return commands;
    return commands.filter((cmd) =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.keywords.some((kw) => kw.includes(q))
    );
  }

  // ── Caret + text measurement helpers ────────────────────────────────
  function getCaretRect() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(false);
      const rects = range.getClientRects();
      if (rects.length > 0) return rects[rects.length - 1];
    }
    const el = document.activeElement;
    if (el) return el.getBoundingClientRect();
    return null;
  }

  function isEditableTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "url", "email", "tel", "password", "number", ""].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  // Last known mouse position — used to anchor the standalone palette
  // when @kept is triggered outside any editable element.
  let lastMousePos = { x: 0, y: 0, known: false };

  function measureTextWidth(text, refEl) {
    const span = document.createElement("span");
    const cs = window.getComputedStyle(refEl);
    span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing};`;
    span.textContent = text;
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    span.remove();
    return w;
  }

  // Walk up the DOM to find the first ancestor with a non-transparent bg
  function resolveBackground(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = window.getComputedStyle(node).backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
      node = node.parentElement;
    }
    return "#ffffff";
  }

  // ── Inline chip overlay ─────────────────────────────────────────────
  let chipHost = null; // outer host element on document.body
  let chipEl = null;   // inner element inside shadow DOM
  let chipFilterSpan = null;
  let chipCursor = null;
  let triggerEditorEl = null;
  let editorBlocker = null; // capture-phase blocker on the editor element
  // Anchored position — set once on open, never recalculated
  let chipAnchor = null; // { left, top, height, fontSize, fontFamily, bg }

  /**
   * Apply !important inline styles to a host element.
   * Inline !important beats all stylesheet rules including page !important.
   */
  function lockHostStyles(el, overrides = {}) {
    const base = {
      position: "fixed",
      "z-index": "2147483646",
      display: "block",
      margin: "0",
      padding: "0",
      border: "none",
      background: "none",
      "box-shadow": "none",
      float: "none",
      clear: "none",
      width: "max-content",
      height: "max-content",
      "min-width": "0",
      "min-height": "0",
      "max-width": "none",
      "max-height": "none",
      overflow: "visible",
      transform: "none",
      filter: "none",
      "clip-path": "none",
      mask: "none",
      visibility: "visible",
      contain: "none",
      isolation: "auto",
      "mix-blend-mode": "normal",
      "pointer-events": "none",
      opacity: "0",
      transition: "opacity 100ms ease",
      color: "initial",
      font: "initial",
      "line-height": "normal",
      "letter-spacing": "normal",
      "text-transform": "none",
      "text-decoration": "none",
      "text-indent": "0",
      "vertical-align": "baseline",
      top: "0",
      left: "0",
      right: "auto",
      bottom: "auto",
      ...overrides,
    };
    for (const [prop, val] of Object.entries(base)) {
      el.style.setProperty(prop, val, "important");
    }
  }

  /** Set a property with !important on a locked host element. */
  function setHostProp(el, prop, value) {
    el.style.setProperty(prop, value, "important");
  }

  /** Block all keyboard/input events on the editor element while palette is open */
  function installEditorBlocker(el) {
    removeEditorBlocker();
    if (!el) return;
    const blocker = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const events = ["keydown", "keyup", "keypress", "beforeinput", "input", "compositionstart", "compositionend"];
    events.forEach((evt) => el.addEventListener(evt, blocker, true));
    editorBlocker = { el, blocker, events };
  }
  function removeEditorBlocker() {
    if (!editorBlocker) return;
    const { el, blocker, events } = editorBlocker;
    events.forEach((evt) => el.removeEventListener(evt, blocker, true));
    editorBlocker = null;
  }

  function createChip() {
    if (chipHost) return;

    chipHost = document.createElement("div");
    chipHost.id = "kept-chip-host";
    lockHostStyles(chipHost);
    document.body.appendChild(chipHost);

    const chipShadow = chipHost.attachShadow({ mode: "closed" });
    const chipSheet = new CSSStyleSheet();
    chipSheet.replaceSync(`
      :host {
        display: block;
        color-scheme: dark;
        line-height: normal;
        /* font-family and font-size are set on the host element via setHostProp */
      }
      @keyframes kept-blink { 0%,100%{opacity:1} 50%{opacity:0} }
      .chip {
        all: unset;
        display: inline-flex;
        width: max-content;
        align-items: center;
        gap: 3px;
        border-radius: 6px;
        border: 1px solid rgba(59,158,204,0.30);
        box-sizing: border-box;
        padding: 2px 10px 2px 6px;
        white-space: pre;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', system-ui, sans-serif;
        font-size: inherit;
        line-height: normal;
      }
      .kept-label {
        all: unset;
        display: inline;
        color: #3B9ECC;
        font-weight: 600;
        font-size: inherit;
        font-family: inherit;
        white-space: pre;
      }
      .kept-filter {
        all: unset;
        display: inline;
        color: #3B9ECC;
        font-weight: 500;
        font-size: inherit;
        font-family: inherit;
        white-space: pre;
      }
      .kept-cursor {
        all: unset;
        display: inline-block;
        width: 1.5px;
        height: 1em;
        background: #3B9ECC;
        margin-left: 1px;
        animation: kept-blink 1s step-end infinite;
        vertical-align: middle;
        flex-shrink: 0;
      }
    `);
    chipShadow.adoptedStyleSheets = [chipSheet];

    chipEl = document.createElement("div");
    chipEl.className = "chip";
    chipEl.innerHTML = `
      <span class="kept-label">@kept</span>
      <span class="kept-filter"></span>
      <span class="kept-cursor"></span>
    `;
    chipShadow.appendChild(chipEl);

    chipFilterSpan = chipEl.querySelector(".kept-filter");
    chipCursor = chipEl.querySelector(".kept-cursor");
  }

  function updateChipFilter(filter) {
    if (chipFilterSpan) chipFilterSpan.textContent = filter ? " " + filter : "";
  }

  /** Called once when the palette opens — anchors the chip position. */
  function anchorChip() {
    const caretRect = getCaretRect();
    if (!caretRect) return;

    triggerEditorEl = document.activeElement;
    createChip();

    const cs = window.getComputedStyle(triggerEditorEl);
    const keptWidth = measureTextWidth("@kept", triggerEditorEl);
    const lineHeight = caretRect.height || parseFloat(cs.lineHeight) || 20;
    const editorBg = resolveBackground(triggerEditorEl);
    const padX = 6;
    const padY = 2;

    chipAnchor = {
      left: caretRect.left - keptWidth - padX,
      top: caretRect.top - padY,
      height: lineHeight + padY * 2,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      bg: editorBg,
    };

    // Position the host container and set font so it cascades into shadow DOM
    setHostProp(chipHost, "left", `${chipAnchor.left}px`);
    setHostProp(chipHost, "top", `${chipAnchor.top}px`);
    setHostProp(chipHost, "opacity", "1");
    setHostProp(chipHost, "font-family", chipAnchor.fontFamily);
    setHostProp(chipHost, "font-size", chipAnchor.fontSize);
    setHostProp(chipHost, "color", "transparent");
    // Style the inner chip element (inside shadow DOM)
    chipEl.style.setProperty("height", `${chipAnchor.height}px`);
    chipEl.style.setProperty("background", "#0B1519");

    updateChipFilter("");
  }

  /** Update chip content without repositioning — width auto-sizes via max-content. */
  function refreshChip(filter) {
    if (!chipEl || !chipAnchor) return;
    updateChipFilter(filter);
  }

  function hideChip() {
    if (!chipHost) return;
    setHostProp(chipHost, "opacity", "0");
    chipAnchor = null;
    triggerEditorEl = null;
  }

  // ── Per-site chat history persistence ────────────────────────────────
  const CHAT_STORAGE_PREFIX = "kept_chat_";
  const MAX_STORED_MESSAGES = 50;

  function chatStorageKey() {
    return `${CHAT_STORAGE_PREFIX}${hostname}`;
  }

  function saveChatToStorage() {
    if (chatHistory.length === 0) return;
    try {
      const trimmed = chatHistory.slice(-MAX_STORED_MESSAGES);
      chrome.storage.local.set({ [chatStorageKey()]: { messages: trimmed, updatedAt: Date.now() } });
    } catch (_) { /* storage unavailable */ }
  }

  function clearChatStorage() {
    try { chrome.storage.local.remove(chatStorageKey()); } catch (_) {}
    hasStoredChat = false;
  }

  /** Load stored chat history for this site and enter chat mode */
  function loadChatFromStorage() {
    try {
      chrome.storage.local.get(chatStorageKey(), (result) => {
        const data = result[chatStorageKey()];
        if (data && data.messages && data.messages.length > 0) {
          chatHistory = data.messages;
          filterText = "";
          renderChatHistory();
          renderPalette();
          positionPalette();
        } else {
          showStatus("error", "No saved conversation found");
        }
      });
    } catch (_) {
      showStatus("error", "Could not load history");
    }
  }

  /** Whether stored history exists for this site (loaded async on init) */
  let hasStoredChat = false;

  // Check on init
  try {
    chrome.storage.local.get(chatStorageKey(), (result) => {
      const data = result[chatStorageKey()];
      hasStoredChat = !!(data && data.messages && data.messages.length > 0);
    });
  } catch (_) {}

  // ── Shadow DOM palette (dropdown below chip) ────────────────────────
  let paletteHost = null;
  let shadow = null;
  let paletteEl = null;
  let pasteTarget = null;
  let chatHistoryEl = null;
  let dismissTimer = null;
  let chatHistory = []; // { role: 'user'|'assistant', content: string }[]

  function createPalette() {
    if (paletteHost) return;

    paletteHost = document.createElement("div");
    paletteHost.id = "kept-palette-host";
    lockHostStyles(paletteHost, {
      "z-index": "2147483647",
      transition: "opacity 150ms ease",
    });
    document.body.appendChild(paletteHost);

    shadow = paletteHost.attachShadow({ mode: "closed" });

    const paletteSheet = new CSSStyleSheet();
    paletteSheet.replaceSync(`
      :host {
        all: initial;
        color-scheme: dark;
      }
      *:not(svg):not(svg *),
      *::before, *::after {
        all: unset;
        box-sizing: border-box;
      }
      .palette {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195,236,255,0.85);
        background: #0B1519;
        border: 1px solid rgba(59, 158, 204, 0.25);
        border-radius: 10px;
        padding: 3px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(59,158,204,0.08);
        min-width: 200px;
        max-width: 280px;
        backdrop-filter: blur(20px);
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      @keyframes kept-blink { 0%,100%{opacity:1} 50%{opacity:0} }
      .standalone-header {
        display: flex;
        align-items: center;
        padding: 7px 10px;
        margin-bottom: 1px;
        border-radius: 7px;
        background: rgba(59,158,204,0.08);
        border: 1px solid rgba(59,158,204,0.2);
        font-size: 12px;
        font-family: inherit;
        line-height: 1.2;
        white-space: pre;
        color: rgba(195,236,255,0.85);
      }
      .sh-label {
        display: inline;
        color: #3B9ECC;
        font-weight: 600;
      }
      .sh-filter {
        display: inline;
        color: rgba(195,236,255,0.9);
        font-weight: 500;
      }
      .sh-cursor {
        display: inline-block;
        width: 1.5px;
        height: 12px;
        background: #3B9ECC;
        margin-left: 2px;
        animation: kept-blink 1s step-end infinite;
        vertical-align: middle;
        flex-shrink: 0;
      }
      .action {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 7px;
        border: none;
        background: transparent;
        color: rgba(195,236,255,0.85);
        font-size: 12px;
        font-weight: 500;
        line-height: 1.4;
        cursor: pointer;
        transition: background 120ms ease;
        text-align: left;
        width: 100%;
        font-family: inherit;
      }
      .action:hover, .action.selected { background: rgba(59,158,204,0.12); }
      .action:active { background: rgba(59,158,204,0.2); }
      .action .body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .action .label {
        display: block;
        flex: 1;
        min-width: 0;
      }
      .action .meta {
        display: block;
        font-size: 10px;
        color: rgba(195,236,255,0.38);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty {
        display: block;
        padding: 8px 10px;
        font-size: 11px;
        color: rgba(195,236,255,0.25);
      }
      .hint { display: none; }
      .status {
        padding: 8px 10px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 8px;
        color: rgba(195,236,255,0.7);
      }
      .status.success { color: #4ADE80; }
      .status.error { color: #FF8A9E; }
      .back {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 10px;
        font-size: 10px;
        font-weight: 500;
        color: rgba(195,236,255,0.3);
        cursor: pointer;
        border: none;
        background: none;
        font-family: inherit;
        transition: color 120ms ease;
      }
      .back:hover { color: rgba(195,236,255,0.6); }
      .project-list {
        max-height: 180px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .project-list::-webkit-scrollbar { width: 4px; }
      .project-list::-webkit-scrollbar-thumb { background: rgba(195,236,255,0.1); border-radius: 2px; }
      .new-input {
        display: block;
        appearance: none;
        -webkit-appearance: none;
        width: 100%;
        padding: 7px 10px;
        border-radius: 6px;
        border: 1px solid rgba(59,158,204,0.2);
        background: rgba(0,0,0,0.2);
        color: rgba(195,236,255,0.85);
        font-size: 12px;
        font-family: inherit;
        outline: none;
        margin-top: 2px;
      }
      .new-input::placeholder { color: rgba(195,236,255,0.2); }
      .new-input:focus { border-color: rgba(59,158,204,0.4); }
      .chat-history {
        max-height: 360px;
        overflow-y: auto;
        padding: 8px 10px 4px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .chat-history:empty { display: none; }
      .chat-history::-webkit-scrollbar { width: 4px; }
      .chat-history::-webkit-scrollbar-thumb { background: rgba(195,236,255,0.1); border-radius: 2px; }
      .chat-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 0 0 4px;
        flex-shrink: 0;
      }
      .chat-clear {
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        font-weight: 500;
        color: rgba(195,236,255,0.4);
        cursor: pointer;
        padding: 4px 10px;
        border-radius: 5px;
        transition: color 120ms ease, background 120ms ease;
        font-family: inherit;
      }
      .chat-clear:hover {
        color: rgba(255,138,158,0.85);
        background: rgba(255,138,158,0.1);
      }
      .chat-msg {
        display: block;
        padding: 4px 0;
        font-size: 12px;
        line-height: 1.45;
      }
      .chat-msg + .chat-msg {
        border-top: 1px solid rgba(195,236,255,0.04);
      }
      .chat-msg-role {
        display: block;
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 2px;
      }
      .chat-msg-content {
        display: block;
      }
      .chat-msg-user .chat-msg-role { color: rgba(195, 236, 255, 0.5); }
      .chat-msg-assistant .chat-msg-role { color: rgba(127, 179, 204, 0.6); }
      .chat-msg-user .chat-msg-content { color: rgba(195, 236, 255, 0.85); }
      .chat-msg-assistant .chat-msg-content { color: #7FB3CC; }
      .chat-msg-assistant .chat-msg-content strong { color: rgba(195, 236, 255, 0.9); font-weight: 700; }
      .chat-msg-content p {
        display: block;
        margin: 0 0 4px;
      }
      .chat-msg-content p:last-child { margin-bottom: 0; }
      .chat-msg-content h1, .chat-msg-content h2,
      .chat-msg-content h3, .chat-msg-content h4 {
        display: block;
        font-weight: 700;
        margin: 6px 0 3px;
        color: rgba(195,236,255,0.95);
      }
      .chat-msg-content h1 { font-size: 14px; }
      .chat-msg-content h2 { font-size: 13px; }
      .chat-msg-content h3 { font-size: 12px; }
      .chat-msg-content h4 { font-size: 11px; font-weight: 600; }
      .chat-msg-content ul, .chat-msg-content ol {
        display: block;
        margin: 3px 0;
        padding-left: 18px;
      }
      .chat-msg-content ul { list-style: disc; }
      .chat-msg-content ol { list-style: decimal; }
      .chat-msg-content li {
        display: list-item;
        margin: 1px 0;
      }
      .chat-msg-content hr {
        display: block;
        border: none;
        border-top: 1px solid rgba(195,236,255,0.08);
        margin: 6px 0;
      }
      .chat-msg-content .code-block {
        display: block;
        background: rgba(0,0,0,0.35);
        border-radius: 6px;
        margin: 5px 0;
        overflow: hidden;
      }
      .chat-msg-content .code-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        background: rgba(0,0,0,0.25);
        border-bottom: 1px solid rgba(195,236,255,0.06);
      }
      .chat-msg-content .code-lang {
        display: inline;
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: rgba(195,236,255,0.35);
        font-family: inherit;
      }
      .chat-msg-content .code-copy {
        display: inline;
        font-size: 9px;
        font-weight: 500;
        color: rgba(195,236,255,0.4);
        cursor: pointer;
        padding: 1px 5px;
        border-radius: 3px;
        transition: color 120ms ease, background 120ms ease;
        font-family: inherit;
      }
      .chat-msg-content .code-copy:hover {
        color: rgba(195,236,255,0.7);
        background: rgba(195,236,255,0.06);
      }
      .chat-msg-content pre {
        display: block;
        padding: 6px 8px;
        margin: 0;
        overflow-x: auto;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
        font-size: 11px;
        line-height: 1.5;
        white-space: pre;
        color: rgba(195,236,255,0.8);
        -webkit-overflow-scrolling: touch;
      }
      .chat-msg-content pre::-webkit-scrollbar { height: 3px; }
      .chat-msg-content pre::-webkit-scrollbar-thumb { background: rgba(195,236,255,0.1); border-radius: 2px; }
      .chat-msg-content pre code {
        background: none;
        padding: 0;
        border-radius: 0;
        font-size: inherit;
        font-family: inherit;
      }
      .chat-msg-content code {
        background: rgba(0,0,0,0.3);
        padding: 1px 4px;
        border-radius: 3px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
        font-size: 11px;
      }
      .chat-msg-content a {
        color: #3B9ECC;
        text-decoration: underline;
        cursor: pointer;
      }
      .chat-msg-content a:hover { color: #5DC0ED; }
      .chat-msg-content em { font-style: italic; }
      br { display: block; }
      strong { font-weight: 700; }
      em { font-style: italic; }
      .spinner {
        display: block;
        width: 13px; height: 13px;
        border-style: solid;
        border-width: 2px;
        border-color: rgba(59,158,204,0.2);
        border-top-color: #3B9ECC;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
        flex-shrink: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    `);
    shadow.adoptedStyleSheets = [paletteSheet];

    paletteEl = document.createElement("div");
    paletteEl.className = "palette";
    shadow.appendChild(paletteEl);

    // Hidden textarea to capture native paste events (avoids clipboardRead permission)
    pasteTarget = document.createElement("textarea");
    pasteTarget.setAttribute("aria-hidden", "true");
    pasteTarget.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
    shadow.appendChild(pasteTarget);
    pasteTarget.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData("text");
      if (text && paletteOpen && !submenu) {
        e.preventDefault();
        filterText += text.replace(/\n/g, " ");
        selectedIdx = 0;
        refreshChip(filterText);
        renderPalette();
      }
    });

    // Chat history container — rendered when agent messages exist
    chatHistoryEl = document.createElement("div");
    chatHistoryEl.className = "chat-history";
    paletteEl.appendChild(chatHistoryEl);
  }

  function positionPalette() {
    let anchor;
    if (standaloneMode) {
      const x = lastMousePos.known ? lastMousePos.x : window.innerWidth / 2;
      const y = lastMousePos.known ? lastMousePos.y : window.innerHeight / 3;
      anchor = { left: x, top: y, bottom: y, right: x, width: 0, height: 0 };
    } else {
      anchor = chipHost && chipHost.style.getPropertyValue("opacity") === "1"
        ? chipHost.getBoundingClientRect()
        : getCaretRect();
    }
    if (!anchor) return;

    const MARGIN = 4;
    let top = anchor.bottom + MARGIN;
    let left = anchor.left;

    if (left + 280 > window.innerWidth) left = window.innerWidth - 288;
    if (left < 8) left = 8;

    setHostProp(paletteHost, "left", `${left}px`);
    setHostProp(paletteHost, "top", `${top}px`);

    requestAnimationFrame(() => {
      if (!paletteHost) return;
      const pr = paletteHost.getBoundingClientRect();
      if (pr.bottom > window.innerHeight - 8) {
        setHostProp(paletteHost, "top", `${anchor.top - pr.height - MARGIN}px`);
      }
    });
  }

  const CHECK_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const X_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

  // ── Palette lifecycle ───────────────────────────────────────────────
  let paletteOpen = false;
  let standaloneMode = false; // true when opened outside any editable element
  let filterText = "";
  let selectedIdx = 0;
  let activePaletteTextInput = null;

  // Submenu state — when non-null, arrow keys / Enter navigate the submenu instead
  let submenu = null; // { items: [...], selectedIdx: 0 }

  /** Update the .selected class on submenu action buttons to reflect submenu.selectedIdx */
  function updateSubmenuHighlight() {
    if (!submenu || !paletteEl) return;
    const buttons = paletteEl.querySelectorAll(".project-list > .action");
    buttons.forEach((btn, i) => {
      btn.classList.toggle("selected", i === submenu.selectedIdx);
    });
  }

  /**
   * In standalone mode (no editable target), the palette has no inline @kept chip
   * floating over the page. Show the trigger label + current filter as a header
   * inside the palette itself so the user has visible feedback.
   */
  function renderStandaloneHeader() {
    if (!standaloneMode || !paletteEl) return;
    let header = paletteEl.querySelector(".standalone-header");
    if (!header) {
      header = document.createElement("div");
      header.className = "standalone-header";
    }
    header.innerHTML = `<span class="sh-label">@kept</span><span class="sh-filter">${filterText ? " " + escapeHtml(filterText) : ""}</span><span class="sh-cursor"></span>`;
    if (paletteEl.firstChild !== header) {
      paletteEl.insertBefore(header, paletteEl.firstChild);
    }
  }

  function renderPalette() {
    renderPaletteInner();
    renderStandaloneHeader();
  }

  function renderPaletteInner() {
    if (!paletteEl) return;
    clearTimeout(dismissTimer);
    activePaletteTextInput = null;
    submenu = null; // leaving submenu, back to main palette

    // Preserve chat history element across re-renders
    const existingChat = paletteEl.querySelector(".chat-history");

    // If chat history is active and no filter text, hide commands
    if (chatHistory.length > 0 && !filterText.trim()) {
      paletteEl.innerHTML = "";
      if (existingChat) paletteEl.appendChild(existingChat);
      else if (chatHistoryEl) paletteEl.appendChild(chatHistoryEl);
      return;
    }

    const matches = filterCommands(filterText);
    selectedIdx = Math.min(selectedIdx, Math.max(0, matches.length - 1));

    if (matches.length === 0) {
      if (filterText.trim() && !restrictedMode) {
        // No matching commands — offer "Ask Kept" agent (hidden in restricted mode)
        paletteEl.innerHTML = "";
        if (existingChat) paletteEl.appendChild(existingChat);
        else if (chatHistoryEl) paletteEl.appendChild(chatHistoryEl);
        const askBtn = document.createElement("button");
        askBtn.className = "action selected";
        askBtn.innerHTML = `<span class="body"><span class="label">Ask Kept</span></span>`;
        askBtn.addEventListener("click", () => askAgent(filterText.trim()));
        paletteEl.appendChild(askBtn);
      } else {
        paletteEl.innerHTML = `
          <div class="empty">No matching commands</div>
          <div class="hint">backspace to clear &middot; esc to dismiss</div>
        `;
        if (existingChat) paletteEl.insertBefore(existingChat, paletteEl.firstChild);
      }
      return;
    }

    const commandsHtml = matches.map((cmd, i) => `
      <button class="action${i === selectedIdx ? " selected" : ""}" data-idx="${i}">
        <span class="body">
          <span class="label">${escapeHtml(cmd.label)}</span>
        </span>
      </button>
    `).join("") + `<div class="hint">${filterText ? "typing to filter" : "type to filter"} &middot; enter to run &middot; esc to dismiss</div>`;

    paletteEl.innerHTML = commandsHtml;
    if (existingChat) paletteEl.insertBefore(existingChat, paletteEl.firstChild);
    else if (chatHistoryEl && chatHistory.length > 0) paletteEl.insertBefore(chatHistoryEl, paletteEl.firstChild);

    paletteEl.querySelectorAll(".action").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const cmd = matches[idx];
        if (cmd) cmd.run();
      });
    });
  }

  function openPalette() {
    filterText = "";
    selectedIdx = 0;
    standaloneMode = !isEditableTarget(document.activeElement);
    if (standaloneMode) {
      triggerEditorEl = null;
    } else {
      anchorChip();
    }
    createPalette();
    clearTimeout(dismissTimer);
    renderPalette();
    positionPalette();
    paletteOpen = true;
    if (!standaloneMode) installEditorBlocker(triggerEditorEl);
    requestAnimationFrame(() => {
      setHostProp(paletteHost, "opacity", "1");
      setHostProp(paletteHost, "pointer-events", "auto");
    });
    // Silently ensure the desktop app is connected whenever the palette opens
    tryConnect();
  }

  function dismiss() {
    if (!paletteHost) return;
    if (!standaloneMode) {
      removeEditorChars(triggerEditorEl || document.activeElement, TRIGGER.length + filterText.length);
    }
    paletteOpen = false;
    standaloneMode = false;
    filterText = "";
    selectedIdx = 0;
    submenu = null;
    activePaletteTextInput = null;
    // Persist chat history for this site before clearing the UI
    if (chatHistory.length > 0) {
      saveChatToStorage();
      hasStoredChat = true;
    }
    chatHistory = [];
    if (chatHistoryEl) chatHistoryEl.innerHTML = "";
    if (paletteEl) {
      paletteEl.style.maxWidth = "";
      paletteEl.style.minWidth = "";
    }
    setHostProp(paletteHost, "opacity", "0");
    setHostProp(paletteHost, "pointer-events", "none");
    removeEditorBlocker();
    hideChip();
    clearTimeout(dismissTimer);
  }

  function showStatus(type, message) {
    if (!paletteEl) return;
    clearTimeout(dismissTimer);
    const icon =
      type === "loading"
        ? '<div class="spinner"></div>'
        : type === "success"
          ? CHECK_ICON
          : X_ICON;

    paletteEl.innerHTML = `<div class="status ${type}">${icon}${escapeHtml(message)}</div>`;
    renderStandaloneHeader();

    if (type === "success") {
      dismissTimer = setTimeout(dismiss, 2000);
    } else if (type === "error") {
      dismissTimer = setTimeout(dismiss, 4000);
    }
  }

  function getSaveLoadingMessage(mode, count) {
    if (mode === "branch") return "Saving branch...";
    if (mode === "recent") return `Saving last ${count} messages...`;
    return "Saving...";
  }

  function getSaveSuccessMessage(response, mode, count) {
    const title = truncateText(response?.title || "", 56);
    const projectSuffix = response?.project ? ` (${response.project})` : "";
    if (mode === "branch") {
      return title ? `Saved branch: ${title}${projectSuffix}` : `Saved branch${projectSuffix}`;
    }
    if (mode === "recent") {
      return title ? `Saved last ${count} messages: ${title}${projectSuffix}` : `Saved last ${count} messages${projectSuffix}`;
    }
    return title ? `Saved: ${title}${projectSuffix}` : `Saved to Kept${projectSuffix}`;
  }

  async function requestSaveConversation(convId, options = {}) {
    return withAutoReconnect(
      () => chrome.runtime.sendMessage({
        type: "save-conversation",
        platform,
        conversationId: convId,
        mode: options.mode || "full",
        count: options.count || 12,
        context: options.context || getPageContext(),
      }),
      options.reconnectOptions || {}
    );
  }

  async function saveConversation(convId, options = {}) {
    const mode = options.mode || "full";
    const count = Math.max(1, Number(options.count) || 12);
    showStatus("loading", getSaveLoadingMessage(mode, count));

    try {
      const response = await requestSaveConversation(convId, {
        ...options,
        mode,
        count,
      });

      if (response && response.ok) {
        showStatus("success", getSaveSuccessMessage(response, mode, count));
        refreshConversationState(true);
        return response;
      }

      showStatus("error", (response && response.error) || "Failed to save");
      return null;
    } catch (err) {
      showStatus("error", err.message || "Connection error");
      return null;
    }
  }

  // ── Connect to Kept app ─────────────────────────────────────────────

  /** Silently attempt to refresh the connection token. Returns true on success. */
  async function tryConnect() {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "connect-app",
        active: false,
        autoClose: true,
      });
      return !!resp?.ok;
    } catch {
      return false;
    }
  }

  async function connectToApp() {
    showStatus("loading", "Connecting\u2026");
    if (await tryConnect()) {
      showStatus("success", "Connected to Kept");
    } else {
      showStatus("error", "Could not reach Kept app — is it running?");
    }
  }

  /**
   * Run an action, and if it fails with a connection/send error,
   * silently try to reconnect and retry once before showing the error.
   */
  async function withAutoReconnect(action, options = {}) {
    const result = await action();
    if (result && result.ok) return result;
    // Check if the error looks like a connection/auth issue
    const err = (result && result.error) || "";
    const isConnErr = !result || /not connected|failed to send|auth|token|running/i.test(err);
    if (!isConnErr) return result;
    // Try reconnecting silently
    if (typeof options.onReconnect === "function") {
      options.onReconnect();
    } else {
      showStatus("loading", "Reconnecting...");
    }
    const connected = await tryConnect();
    if (!connected) return result; // return original error
    // Retry the action
    return await action();
  }

  // ── Agent chat ─────────────────────────────────────────────────────

  let codeBlockIdCounter = 0;

  function formatMarkdown(content) {
    // Extract fenced code blocks first to protect them from inline processing
    const codeBlocks = [];
    let src = content.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const id = `kept-cb-${++codeBlockIdCounter}`;
      const langLabel = lang || "text";
      const escapedCode = escapeHtml(code.replace(/\n$/, ""));
      codeBlocks.push(
        `<div class="code-block" data-code-id="${id}">` +
          `<div class="code-header">` +
            `<span class="code-lang">${escapeHtml(langLabel)}</span>` +
            `<button class="code-copy" data-copy-id="${id}">Copy</button>` +
          `</div>` +
          `<pre><code id="${id}">${escapedCode}</code></pre>` +
        `</div>`
      );
      return `\x00CB${codeBlocks.length - 1}\x00`;
    });

    // Process line by line
    const lines = src.split("\n");
    const out = [];
    let inList = false;
    let listType = null; // "ul" or "ol"

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Code block placeholder
      const cbMatch = line.match(/^\x00CB(\d+)\x00$/);
      if (cbMatch) {
        if (inList) { out.push(`</${listType}>`); inList = false; }
        out.push(codeBlocks[Number(cbMatch[1])]);
        continue;
      }

      // Headers
      const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (hMatch) {
        if (inList) { out.push(`</${listType}>`); inList = false; }
        const level = hMatch[1].length;
        out.push(`<h${level}>${inlineFormat(hMatch[2])}</h${level}>`);
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        if (inList) { out.push(`</${listType}>`); inList = false; }
        out.push("<hr>");
        continue;
      }

      // Unordered list
      const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)$/);
      if (ulMatch) {
        if (!inList || listType !== "ul") {
          if (inList) out.push(`</${listType}>`);
          out.push("<ul>");
          inList = true;
          listType = "ul";
        }
        out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^[\s]*\d+[.)]\s+(.+)$/);
      if (olMatch) {
        if (!inList || listType !== "ol") {
          if (inList) out.push(`</${listType}>`);
          out.push("<ol>");
          inList = true;
          listType = "ol";
        }
        out.push(`<li>${inlineFormat(olMatch[1])}</li>`);
        continue;
      }

      // Close list if we hit a non-list line
      if (inList) { out.push(`</${listType}>`); inList = false; }

      // Empty line → paragraph break
      if (line.trim() === "") {
        out.push("<br>");
        continue;
      }

      // Regular paragraph line
      out.push(`<p>${inlineFormat(line)}</p>`);
    }
    if (inList) out.push(`</${listType}>`);

    return out.join("");
  }

  /** Process inline markdown: bold, italic, code, links */
  function inlineFormat(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  async function getStoredAppToken() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "get-app-token" });
      return resp && resp.ok ? (resp.token || "") : "";
    } catch {
      return "";
    }
  }

  function renderChatHistory() {
    if (!chatHistoryEl) return;
    if (chatHistory.length === 0) {
      chatHistoryEl.innerHTML = "";
      if (paletteEl) {
        paletteEl.style.maxWidth = "";
        paletteEl.style.minWidth = "";
      }
      return;
    }

    const recent = chatHistory.slice(-20);
    const clearBtn = `<div class="chat-toolbar"><button class="chat-clear">Clear history</button></div>`;
    chatHistoryEl.innerHTML = clearBtn + recent.map((msg) => {
      const isUser = msg.role === "user";
      const roleLabel = isUser ? "You" : "Kept";
      const content = isUser ? escapeHtml(msg.content) : formatMarkdown(msg.content);
      return `<div class="chat-msg chat-msg-${msg.role}">
        <div class="chat-msg-role">${roleLabel}</div>
        <div class="chat-msg-content">${content}</div>
      </div>`;
    }).join("");

    // Wire up clear history button
    const clearEl = chatHistoryEl.querySelector(".chat-clear");
    if (clearEl) {
      clearEl.addEventListener("click", () => {
        chatHistory = [];
        clearChatStorage();
        renderChatHistory();
        renderPalette();
        positionPalette();
      });
    }

    // Wire up copy buttons for code blocks
    chatHistoryEl.querySelectorAll(".code-copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        const codeEl = chatHistoryEl.querySelector(`#${btn.dataset.copyId}`);
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent || "").then(() => {
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = "Copy"; }, 1500);
          }).catch(() => {});
        }
      });
    });

    if (paletteEl) {
      paletteEl.style.maxWidth = "400px";
      paletteEl.style.minWidth = "320px";
    }
    chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
  }

  function showAgentStatus(type, message) {
    if (!paletteEl) return;
    const icon =
      type === "loading"
        ? '<div class="spinner"></div>'
        : type === "success"
          ? CHECK_ICON
          : X_ICON;
    // Show status after chat history, not replacing it
    const statusEl = paletteEl.querySelector(".agent-status") || document.createElement("div");
    statusEl.className = `status agent-status ${type}`;
    statusEl.innerHTML = `${icon}${escapeHtml(message)}`;
    if (!statusEl.parentNode) paletteEl.appendChild(statusEl);
  }

  async function saveAgentChat() {
    if (chatHistory.length < 2) {
      showStatus("error", "No conversation to save");
      return;
    }
    showStatus("loading", "Saving to vault\u2026");

    // Build a title from the first user message
    const firstUserMsg = chatHistory.find(m => m.role === "user");
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 80).replace(/\n/g, " ").trim() + (firstUserMsg.content.length > 80 ? "\u2026" : "")
      : "Kept Agent Chat";

    const now = new Date().toISOString();
    const originUrl = window.location.href;
    const originTitle = document.title || hostname;

    // Build markdown in vault format
    const frontmatter = [
      "---",
      `id: "kept-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}"`,
      `platform: "kept"`,
      `title: "${title.replace(/"/g, '\\"')}"`,
      `synced: ${now}`,
      `created_at: ${now}`,
      `updated_at: ${now}`,
      `messages: ${chatHistory.length}`,
      `model: "agent"`,
      `origin_url: "${originUrl.replace(/"/g, '\\"')}"`,
      `origin_site: "${hostname}"`,
      `origin_title: "${originTitle.replace(/"/g, '\\"')}"`,
      "tags:",
      "  - kept/agent",
      `  - kept/site/${hostname}`,
      "---",
    ].join("\n");

    const body = chatHistory.map((msg) => {
      const role = msg.role === "user" ? "You" : "Assistant";
      return `### ${role}\n\n${msg.content}`;
    }).join("\n\n---\n\n");

    const markdown = `${frontmatter}\n\n# ${title}\n\n> Kept Agent chat on [${originTitle}](${originUrl})\n\n---\n\n${body}\n`;

    // Build ingest payload
    const payload = {
      conversation_id: `kept-agent-${Date.now()}`,
      platform: "kept",
      title,
      model: "agent",
      messages: chatHistory.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: now,
      })),
      created_at: now,
      updated_at: now,
      markdown,
    };

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "save-agent-chat",
        payload,
      });
      if (resp && resp.ok) {
        showStatus("success", "Saved to vault");
      } else {
        showStatus("error", (resp && resp.error) || "Failed to save");
      }
    } catch (err) {
      showStatus("error", err.message || "Connection error");
    }
  }

  function revertFailedMessage() {
    if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === "user") {
      chatHistory.pop();
      renderChatHistory();
    }
  }

  const AGENT_MAX_RETRIES = 3;
  const AGENT_RETRY_DELAYS = [2000, 4000, 8000]; // exponential back-off

  async function askAgent(prompt) {
    if (!prompt || !prompt.trim()) return;
    chatHistory.push({ role: "user", content: prompt });
    renderChatHistory();
    showAgentStatus("loading", "Thinking\u2026");
    positionPalette();

    let lastError = null;

    for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
      try {
        const page = getPageContext();
        const resp = await chrome.runtime.sendMessage({
          type: "agent-chat",
          prompt,
          url: page.url,
          page_title: page.pageTitle,
          page_content: page.text || "",
          has_selection: page.selected || false,
        });

        if (resp && resp.ok) {
          chatHistory.push({ role: "assistant", content: resp.content || "No response." });
          filterText = "";
          refreshChip(filterText);
          renderChatHistory();
          saveChatToStorage();
          hasStoredChat = true;
          const statusEl = paletteEl?.querySelector(".agent-status");
          if (statusEl) statusEl.remove();
          positionPalette();
          return; // success
        }

        lastError = (resp && resp.error) || "Connection error";

        // Don't retry on 4xx client errors (auth, forbidden, bad request)
        if (resp && resp.status >= 400 && resp.status < 500) break;

        if (attempt < AGENT_MAX_RETRIES) {
          const isConnErr = !resp || /not connected|token|running/i.test(lastError);
          showAgentStatus("loading", isConnErr
            ? `Connecting\u2026 (retry ${attempt + 1}/${AGENT_MAX_RETRIES})`
            : `Retrying\u2026 (${attempt + 1}/${AGENT_MAX_RETRIES})`);
          if (isConnErr) await tryConnect();
          await new Promise(r => setTimeout(r, AGENT_RETRY_DELAYS[attempt]));
          continue;
        }
      } catch (err) {
        lastError = err.message || "Connection error";
        if (attempt < AGENT_MAX_RETRIES) {
          showAgentStatus("loading", `Reconnecting\u2026 (retry ${attempt + 1}/${AGENT_MAX_RETRIES})`);
          await tryConnect();
          await new Promise(r => setTimeout(r, AGENT_RETRY_DELAYS[attempt]));
          continue;
        }
      }
    }

    // All attempts exhausted
    revertFailedMessage();
    showAgentStatus("error", lastError || "Connection error");
  }

  // ── Project picker sub-menu ──────────────────────────────────────────
  function showRangePicker(convId) {
    if (!paletteEl) return;
    clearTimeout(dismissTimer);
    activePaletteTextInput = null;

    const ranges = [
      { count: 6, label: "Last 6 messages", meta: "Fast capture for the current exchange" },
      { count: 12, label: "Last 12 messages", meta: "Good default for recent context" },
      { count: 20, label: "Last 20 messages", meta: "Keeps a larger working window" },
      { count: 40, label: "Last 40 messages", meta: "Use when the thread is still compact" },
    ];

    paletteEl.innerHTML = `
      <button class="back" data-action="back">&larr; Back</button>
      <div class="project-list">
        ${ranges.map((option, index) => `
          <button class="action" data-range-idx="${index}">
            <span class="body">
              <span class="label">${escapeHtml(option.label)}</span>
              <span class="meta">${escapeHtml(option.meta)}</span>
            </span>
          </button>
        `).join("")}
      </div>
    `;

    // Register submenu for keyboard navigation
    const rangeActions = ranges.map((option) => ({
      run: () => saveConversation(convId, { mode: "recent", count: option.count }),
    }));
    submenu = { items: rangeActions, selectedIdx: 0, back: () => renderPalette() };
    updateSubmenuHighlight();

    paletteEl.querySelector('[data-action="back"]').addEventListener("click", () => {
      renderPalette();
    });

    paletteEl.querySelectorAll("[data-range-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const option = ranges[Number(btn.dataset.rangeIdx)];
        if (option) saveConversation(convId, { mode: "recent", count: option.count });
      });
    });
  }

  let projectPickerActive = false;

  async function showProjectPicker(convId) {
    if (!paletteEl) return;
    clearTimeout(dismissTimer);
    activePaletteTextInput = null;
    projectPickerActive = true;

    paletteEl.innerHTML = `<div class="status"><div class="spinner"></div>Loading projects...</div>`;

    try {
      const resp = await withAutoReconnect(() =>
        chrome.runtime.sendMessage({ type: "list-projects" })
      );
      if (!resp || !resp.ok) {
        showStatus("error", (resp && resp.error) || "Failed to load projects");
        projectPickerActive = false;
        return;
      }
      renderProjectList(resp.projects || [], convId);
    } catch (err) {
      showStatus("error", err.message || "Connection error");
      projectPickerActive = false;
    }
  }

  function renderProjectList(projects, convId) {
    if (!paletteEl) return;
    clearTimeout(dismissTimer);
    activePaletteTextInput = null;

    const backBtn = `<button class="back" data-action="back">\u2190 Back</button>`;
    const projectItems = projects.map((p, index) => `
      <button class="action" data-project-idx="${index}">
        <span class="body">
          <span class="label">${escapeHtml(p.name)}</span>
          <span class="meta">${escapeHtml(`${p.conversation_count || 0} linked conversations`)}</span>
        </span>
      </button>
    `).join("");
    const newItem = `
      <button class="action" data-action="new-project">
        <span class="body">
          <span class="label">Create new project</span>
          <span class="meta">Save this conversation into a new bucket</span>
        </span>
      </button>
    `;

    paletteEl.innerHTML = `
      ${backBtn}
      <div class="project-list">${projectItems}${newItem}</div>
    `;

    // Register submenu for keyboard navigation
    const projectActions = [
      ...projects.map((p) => ({ run: () => linkToProject(p, convId) })),
      { run: () => showNewProjectInput(convId) },
    ];
    const backFn = () => { projectPickerActive = false; renderPalette(); };
    submenu = { items: projectActions, selectedIdx: 0, back: backFn };
    updateSubmenuHighlight();

    // Back button
    paletteEl.querySelector('[data-action="back"]').addEventListener("click", backFn);

    // Existing project buttons
    paletteEl.querySelectorAll("[data-project-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const project = projects[Number(btn.dataset.projectIdx)];
        if (project) linkToProject(project, convId);
      });
    });

    // New project button
    paletteEl.querySelector('[data-action="new-project"]').addEventListener("click", () => {
      showNewProjectInput(convId);
    });
  }

  function showNewProjectInput(convId) {
    if (!paletteEl) return;
    clearTimeout(dismissTimer);
    submenu = null; // text input handles its own keys

    // Disable palette key-capture so the shadow input can receive focus & keystrokes
    paletteOpen = false;
    removeEditorBlocker();

    const backBtn = `<button class="back" data-action="back">\u2190 Back</button>`;
    paletteEl.innerHTML = `
      ${backBtn}
      <div style="padding: 4px 6px;">
        <input class="new-input" type="text" placeholder="Project name..." maxlength="200" autofocus />
      </div>
      <div class="hint" style="padding: 2px 10px 4px;">enter to create</div>
    `;

    const input = paletteEl.querySelector(".new-input");
    activePaletteTextInput = input;
    requestAnimationFrame(() => {
      input.focus();
    });

    paletteEl.querySelector('[data-action="back"]').addEventListener("click", () => {
      paletteOpen = true;
      installEditorBlocker(triggerEditorEl);
      showProjectPicker(convId);
    });

    input.addEventListener("keydown", (e) => {
      e.stopImmediatePropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        createAndLink(name, convId);
      } else if (e.key === "Escape") {
        e.preventDefault();
        paletteOpen = true;
        installEditorBlocker(triggerEditorEl);
        showProjectPicker(convId);
      }
    });
  }

  async function createAndLink(projectName, convId) {
    showStatus("loading", "Creating project...");

    try {
      const createResp = await withAutoReconnect(() =>
        chrome.runtime.sendMessage({
          type: "create-project",
          name: projectName,
        })
      );
      if (!createResp || !createResp.ok) {
        showStatus("error", (createResp && createResp.error) || "Failed to create project");
        return;
      }
      await linkToProject({ id: createResp.id, name: createResp.name || projectName }, convId);
    } catch (err) {
      showStatus("error", err.message || "Connection error");
    }
  }

  async function linkToProject(project, convId) {
    showStatus("loading", "Saving before linking...");
    projectPickerActive = false;

    try {
      const saveResp = await requestSaveConversation(convId);
      if (!saveResp || !saveResp.ok) {
        showStatus("error", (saveResp && saveResp.error) || "Failed to save");
        return;
      }

      showStatus("loading", `Adding to ${truncateText(project.name, 32)}...`);
      const resp = await withAutoReconnect(() =>
        chrome.runtime.sendMessage({
          type: "link-project",
          projectId: project.id,
          projectName: project.name,
          platform,
          conversationId: saveResp.savedConversationId || saveResp.baseConversationId || convId,
          baseConversationId: saveResp.baseConversationId || convId,
          savedConversationId: saveResp.savedConversationId || saveResp.baseConversationId || convId,
          title: saveResp.title || threadState?.title || "Conversation",
        })
      );
      if (resp && resp.ok) {
        showStatus("success", `Added to ${truncateText(project.name, 40)}`);
        refreshConversationState(true);
      } else {
        showStatus("error", (resp && resp.error) || "Failed to link");
      }
    } catch (err) {
      showStatus("error", err.message || "Connection error");
    }
  }

  // ── Delete N characters backwards from editor ───────────────────────

  function createThreadBadge() {
    if (threadBadgeHost) return;

    threadBadgeHost = document.createElement("div");
    threadBadgeHost.id = "kept-badge-host";
    lockHostStyles(threadBadgeHost, {
      "z-index": "2147483644",
      bottom: "10px",
      right: "20px",
      top: "auto",
      left: "auto",
    });
    document.body.appendChild(threadBadgeHost);

    const badgeShadow = threadBadgeHost.attachShadow({ mode: "closed" });
    const badgeSheet = new CSSStyleSheet();
    badgeSheet.replaceSync(`
      :host { all: initial; color-scheme: dark; }
      *, *::before, *::after { all: unset; box-sizing: border-box; }
      .badge {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid rgba(59,158,204,0.18);
        background: rgba(11,21,25,0.92);
        color: rgba(232,247,255,0.88);
        border-radius: 999px;
        padding: 3px 7px;
        box-shadow: 0 8px 20px rgba(0,0,0,0.24);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        cursor: pointer;
        max-width: min(280px, calc(100vw - 40px));
      }
      .badge.hidden { display: none; }
      .pill {
        display: inline;
        border-radius: 999px;
        padding: 2px 6px;
        font-size: 10px;
        font-weight: 600;
      }
      .meta {
        display: inline;
        font-size: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: rgba(195,236,255,0.6);
      }
      .cta {
        display: inline;
        font-size: 10px;
        color: rgba(195,236,255,0.88);
      }
      .badge.ok .pill { background: rgba(74,222,128,0.14); color: #86efac; }
      .badge.warning .pill { background: rgba(245,158,11,0.14); color: #fcd34d; }
      .badge.loading .pill { background: rgba(59,158,204,0.18); color: #8ad1ef; }
      .badge.error .pill { background: rgba(255,138,158,0.16); color: #ff9aae; }
    `);
    badgeShadow.adoptedStyleSheets = [badgeSheet];

    threadBadgeEl = document.createElement("button");
    threadBadgeEl.type = "button";
    threadBadgeEl.className = "badge hidden";
    threadBadgeEl.innerHTML = `
      <span class="pill"></span>
      <span class="meta"></span>
      <span class="cta"></span>
    `;
    badgeShadow.appendChild(threadBadgeEl);

    threadBadgeEl.addEventListener("click", async () => {
      const convId = getConversationId();
      if (!convId) return;

      if (!threadState || threadState.state === "unsynced" || threadState.state === "changed") {
        threadState = { ...(threadState || {}), state: "loading" };
        renderThreadBadge();
        try {
          const resp = await requestSaveConversation(convId, {
            reconnectOptions: {
              onReconnect: () => {
                threadState = { ...(threadState || {}), state: "loading" };
                renderThreadBadge();
              },
            },
          });
          if (resp && resp.ok) {
            await refreshConversationState(true);
          } else {
            threadState = { ...(threadState || {}), state: "error", error: (resp && resp.error) || "Failed to save" };
            renderThreadBadge();
          }
        } catch (err) {
          threadState = { ...(threadState || {}), state: "error", error: err.message || "Connection error" };
          renderThreadBadge();
        }
        return;
      }
    });
  }

  function renderThreadBadge() {
    createThreadBadge();

    const convId = getConversationId();
    if (!convId) {
      threadBadgeEl.className = "badge hidden";
      return;
    }

    const state = threadState?.state || "loading";
    let tone = "loading";
    let label = "Checking";
    let meta = "";
    let cta = "";

    if (state === "saved") {
      tone = "ok";
      label = "Saved";
      meta = threadState?.savedAt ? formatRelativeShort(threadState.savedAt) : "";
      cta = "";
    } else if (state === "routed") {
      tone = "ok";
      label = threadState?.project ? truncateText(threadState.project, 16) : "Linked";
      meta = threadState?.savedAt ? formatRelativeShort(threadState.savedAt) : "";
      cta = "";
    } else if (state === "changed") {
      tone = "warning";
      label = "Changed";
      meta = "Differs from archive";
      cta = "Save";
    } else if (state === "unsynced") {
      tone = "warning";
      label = "Unsaved";
      meta = "";
      cta = "Save";
    } else if (state === "error") {
      tone = "error";
      label = "Error";
      meta = truncateText(threadState?.error || "Unavailable", 30);
    }

    threadBadgeEl.className = `badge ${tone}`;
    threadBadgeEl.querySelector(".pill").textContent = label;
    threadBadgeEl.querySelector(".meta").textContent = meta;
    threadBadgeEl.querySelector(".cta").textContent = cta;
  }

  async function refreshConversationState(force = false) {
    const convId = getConversationId();
    if (!convId) {
      threadState = null;
      renderThreadBadge();
      return;
    }

    const requestId = ++threadStateRequestId;
    if (force || !threadState || threadState.conversationId !== convId) {
      threadState = { conversationId: convId, state: "loading" };
      renderThreadBadge();
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "get-conversation-state",
        platform,
        conversationId: convId,
      });
      if (requestId !== threadStateRequestId || convId !== getConversationId()) return;

      if (resp && resp.ok) {
        threadState = { ...resp, conversationId: convId };
      } else {
        threadState = {
          conversationId: convId,
          state: "error",
          error: (resp && resp.error) || "Could not inspect this thread",
        };
      }
    } catch (err) {
      if (requestId !== threadStateRequestId || convId !== getConversationId()) return;
      threadState = {
        conversationId: convId,
        state: "error",
        error: err.message || "Could not inspect this thread",
      };
    }

    renderThreadBadge();
  }

  function removeEditorChars(el, count) {
    if (!el || count <= 0) return;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const pos = el.selectionStart;
      el.value = el.value.slice(0, pos - count) + el.value.slice(pos);
      el.selectionStart = el.selectionEnd = Math.max(0, pos - count);
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      el.focus();
      for (let i = 0; i < count; i++) {
        document.execCommand("delete", false);
      }
    }
  }

  // ── Input monitoring (keydown buffer) ───────────────────────────────
  const TRIGGER = "@kept";
  let keyBuffer = "";
  let bufferTimeout = null;
  const BUFFER_RESET_MS = 3000;

  // Block keypress/beforeinput while palette is open — ProseMirror may react to these
  for (const evt of ["keypress", "beforeinput"]) {
    window.addEventListener(evt, (e) => {
      if (paletteOpen) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  // Track mouse so the standalone palette can anchor at the cursor when
  // @kept is triggered outside any editable element.
  window.addEventListener("mousemove", (e) => {
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;
    lastMousePos.known = true;
  }, { passive: true, capture: true });


  window.addEventListener(
    "keydown",
    (e) => {
      const eventPath = typeof e.composedPath === "function" ? e.composedPath() : [];
      const inPaletteInput = !!activePaletteTextInput && eventPath.includes(activePaletteTextInput);
      if (inPaletteInput) {
        return;
      }
      // Some synthetic/IME events fire keydown with key=undefined — ignore them
      if (e.key == null) return;
      // ── While palette is open — capture ALL keys ──
      if (paletteOpen) {
        // Allow Ctrl/Cmd+C (copy) to pass through natively
        if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) return;
        // Ctrl/Cmd+V — focus hidden textarea so native paste fires on it
        if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
          if (pasteTarget) pasteTarget.focus();
          return;
        }

        // Block everything from reaching the editor by default
        e.preventDefault();
        e.stopImmediatePropagation();

        if (e.key === "Escape") {
          if (submenu) {
            // Exit submenu back to main palette
            if (submenu.back) submenu.back();
            else renderPalette();
          } else {
            dismiss();
          }
          return;
        }

        // ── Submenu navigation ──
        if (submenu) {
          if (e.key === "Enter") {
            const item = submenu.items[submenu.selectedIdx];
            if (item) item.run();
            return;
          }
          if (e.key === "ArrowDown") {
            submenu.selectedIdx = (submenu.selectedIdx + 1) % submenu.items.length;
            updateSubmenuHighlight();
            return;
          }
          if (e.key === "ArrowUp") {
            submenu.selectedIdx = (submenu.selectedIdx - 1 + submenu.items.length) % submenu.items.length;
            updateSubmenuHighlight();
            return;
          }
          if (e.key === "Backspace") {
            // Go back from submenu
            if (submenu.back) submenu.back();
            else renderPalette();
            return;
          }
          // Swallow all other keys in submenu
          return;
        }

        // ── Main palette navigation ──
        if (e.key === "Enter") {
          const matches = filterCommands(filterText);
          if (matches.length > 0) {
            matches[selectedIdx || 0].run();
          } else if (filterText.trim() && !restrictedMode) {
            // No matching commands — ask the agent (blocked in restricted mode)
            askAgent(filterText.trim());
            filterText = "";
          } else if (chatHistory.length > 0) {
            // In chat mode with empty input — do nothing
          } else {
            dismiss();
          }
          return;
        }

        if (e.key === "ArrowDown") {
          const matches = filterCommands(filterText);
          if (matches.length > 0) {
            selectedIdx = (selectedIdx + 1) % matches.length;
            renderPalette();
          }
          return;
        }

        if (e.key === "ArrowUp") {
          const matches = filterCommands(filterText);
          if (matches.length > 0) {
            selectedIdx = (selectedIdx - 1 + matches.length) % matches.length;
            renderPalette();
          }
          return;
        }

        if (e.key === "Backspace") {
          if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+Backspace — delete last word from filter
            filterText = filterText.replace(/\S+\s*$/, "");
          } else if (filterText.length > 0) {
            filterText = filterText.slice(0, -1);
          }
          // If filter is now empty, dismiss (unless in chat mode)
          if (filterText.length === 0 && chatHistory.length === 0) {
            dismiss();
            return;
          }
          refreshChip(filterText);
          renderPalette();
          return;
        }

        if (e.key === "Delete") {
          // Nothing to delete forward in the filter — ignore
          return;
        }

        // Ctrl/Cmd shortcuts on the filter
        if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
          const k = e.key.toLowerCase();
          if (k === "a") {
            // Select all → clear filter (equivalent of selecting all + next keystroke replaces)
            // We'll just clear it since there's no real selection model
            filterText = "";
            refreshChip(filterText);
            renderPalette();
          } else if (k === "u") {
            // Ctrl+U — clear entire line (unix-style)
            filterText = "";
            refreshChip(filterText);
            renderPalette();
          } else if (k === "w") {
            // Ctrl+W — delete last word
            filterText = filterText.replace(/\S+\s*$/, "");
            refreshChip(filterText);
            renderPalette();
          }
          return;
        }

        // Printable character — add to filter
        if (e.key.length === 1 && !e.altKey) {
          filterText += e.key;
          selectedIdx = 0;
          refreshChip(filterText);
          renderPalette();
          return;
        }

        // All other keys (Tab, Home, End, Shift, etc.) — swallowed
        return;
      }

      // ── Track keystrokes for trigger detection ──
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
        if (e.key === "Backspace") keyBuffer = keyBuffer.slice(0, -1);
        return;
      }

      // Once we have a partial match for the trigger, suppress keystrokes
      // from reaching the page so site shortcuts (e.g. GitHub "e" for edit)
      // don't fire while the user is typing "@kept"
      const candidate = (keyBuffer + e.key).slice(-TRIGGER.length);
      if (candidate.length >= 2 && TRIGGER.startsWith(candidate)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }

      clearTimeout(bufferTimeout);
      bufferTimeout = setTimeout(() => { keyBuffer = ""; }, BUFFER_RESET_MS);

      keyBuffer += e.key;
      if (keyBuffer.length > TRIGGER.length) {
        keyBuffer = keyBuffer.slice(-TRIGGER.length);
      }

      if (keyBuffer === TRIGGER) {
        keyBuffer = "";
        clearTimeout(bufferTimeout);
        requestAnimationFrame(() => {
          openPalette();
        });
      }
    },
    true,
  );

  // ── Click-outside dismiss ───────────────────────────────────────────
  // Thread badge and conversation state polling only on AI platforms
  if (isAIPlatform) {
    createThreadBadge();
    refreshConversationState(true);

    setInterval(() => {
      if (window.location.href !== lastObservedUrl) {
        lastObservedUrl = window.location.href;
        threadState = null;
        refreshConversationState(true);
      }
    }, 1000);

    setInterval(() => {
      if (!document.hidden) {
        refreshConversationState(false);
      }
    }, 45000);
  }

  document.addEventListener(
    "mousedown",
    (e) => {
      if (paletteOpen && e.target !== paletteHost) {
        dismiss();
      }
    },
    true,
  );
})();
