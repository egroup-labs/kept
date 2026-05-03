import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ChatMessage from "./ChatMessage";
import MessageSequence from "./MessageSequence";
import {
  parseFrontmatter,
  parseMessages,
  type Frontmatter,
  type ConversationMessage,
} from "../lib/markdown";

const PLATFORM_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  ollama: "Ollama",
  kept: "Kept",
};

const MODEL_NAMES: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-5": "GPT-5",
  "gpt-5-instant": "GPT-5 Instant",
  "gpt-5-nano": "GPT-5 Nano",
  "gpt-5-pro": "GPT-5 Pro",
  "gpt-5-thinking": "GPT-5 Thinking",
  "gpt-5-1": "GPT-5.1",
  "gpt-5-1-pro": "GPT-5.1 Pro",
  "gpt-5-1-thinking": "GPT-5.1 Thinking",
  "gpt-5-2": "GPT-5.2",
  "gpt-5-2-instant": "GPT-5.2 Instant",
  "gpt-5-2-thinking": "GPT-5.2 Thinking",
  "o3": "o3",
  "o3-pro": "o3 Pro",
  "o4-mini-high": "o4-mini (High)",
  "claude-opus-4-20250514": "Claude Opus 4",
  "claude-opus-4-5-20251101": "Claude Opus 4.5",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "gemini-3-pro": "Gemini 3 Pro",
  "gemini-fast": "Gemini Fast",
  "gemini-thinking": "Gemini Thinking",
  "agent-mode": "Agent Mode",
};

function humanize(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .replace(/(\d{4,})/g, "")       // strip date suffixes like 20250514
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function displayName(value: string | undefined, map: Record<string, string>): string | null {
  if (!value) return null;
  return map[value] || humanize(value);
}

// ── Virtualizer ─────────────────────────────────────────────────────────────

/** Estimate height for a message based on content length */
function estimateHeight(msg: ConversationMessage): number {
  const len = msg.content.length;
  const lines = msg.content.split("\n").length;
  // Rough: short msgs ~80px, code-heavy msgs taller
  const base = 60 + lines * 18;
  const charEstimate = 60 + len * 0.15;
  return Math.min(Math.max(base, charEstimate), 2000);
}

const OVERSCAN = 3; // extra items above/below viewport

function useVirtualizer(
  messages: ConversationMessage[],
  scrollRef: React.RefObject<HTMLDivElement | null>,
) {
  const count = messages.length;

  // Heights: measured (from DOM) or estimated
  const heights = useRef<number[]>([]);
  const measured = useRef<boolean[]>([]);

  // Visible range
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 10) });

  // Initialize heights on message change
  useEffect(() => {
    heights.current = messages.map((m, i) =>
      measured.current[i] ? heights.current[i] : estimateHeight(m)
    );
    measured.current = new Array(count).fill(false);
  }, [messages, count]);

  // Measure rendered items
  const measureRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (!el || measured.current[index]) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0) {
      heights.current[index] = h;
      measured.current[index] = true;
    }
  }, []);

  // Compute offsets
  const getOffset = useCallback((index: number) => {
    let offset = 0;
    for (let i = 0; i < index; i++) offset += (heights.current[i] || 100);
    return offset;
  }, []);

  const getTotalHeight = useCallback(() => {
    let total = 0;
    for (let i = 0; i < count; i++) total += (heights.current[i] || 100);
    return total;
  }, [count]);

  // Recalculate visible range on scroll
  const recalc = useCallback(() => {
    const el = scrollRef.current;
    if (!el || count === 0) return;

    const scrollTop = el.scrollTop;
    const viewH = el.clientHeight;
    const top = scrollTop;
    const bottom = scrollTop + viewH;

    let offset = 0;
    let start = 0;
    for (let i = 0; i < count; i++) {
      const h = heights.current[i] || 100;
      if (offset + h > top) { start = i; break; }
      offset += h;
    }

    let end = start;
    for (let i = start; i < count; i++) {
      end = i + 1;
      offset += (heights.current[i] || 100);
      if (offset >= bottom) break;
    }

    start = Math.max(0, start - OVERSCAN);
    end = Math.min(count, end + OVERSCAN);

    setRange((prev) => {
      if (prev.start === start && prev.end === end) return prev;
      return { start, end };
    });
  }, [count, scrollRef]);

  const getHeight = useCallback((index: number) => {
    return heights.current[index] || 100;
  }, []);

  return { range, measureRef, getOffset, getHeight, getTotalHeight, recalc };
}

// ── Controls ─────────────────────────────────────────────────────────────────

function MessageControls({ visible, expanded, onScrollTop, onNext, onToggle }: {
  visible: boolean;
  expanded: boolean;
  onScrollTop: () => void;
  onNext: () => void;
  onToggle: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const applyParallax = (idx: number) => {
    const el = containerRef.current;
    if (!el) return;
    for (let i = 0; i < el.children.length; i++) {
      const btn = el.children[i] as HTMLElement;
      if (i === idx) {
        btn.style.padding = "0 14px";
        btn.style.background = "#1c2326";
      } else {
        btn.style.padding = "0 10px";
        btn.style.background = "#111719";
      }
    }
  };

  const resetParallax = () => {
    const el = containerRef.current;
    if (!el) return;
    for (let i = 0; i < el.children.length; i++) {
      const btn = el.children[i] as HTMLElement;
      btn.style.padding = "0 10px";
      btn.style.background = "#141a1d";
    }
  };

  return (
    <div
      className="absolute left-0 right-0 flex justify-center"
      style={{
        bottom: 76,
        zIndex: 3,
        pointerEvents: visible ? "auto" : "none",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 400ms cubic-bezier(0.16, 1, 0.3, 1), transform 400ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <div
        ref={containerRef}
        onMouseLeave={resetParallax}
        style={{
          display: "inline-flex",
          alignItems: "stretch",
          gap: 2,
          background: "#0e1518",
          borderRadius: 12,
          padding: 3,
        }}
      >
        {/* Scroll to top of message */}
        <button
          onClick={onScrollTop}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; applyParallax(0); }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
          style={{
            background: "#141a1d",
            border: "none",
            cursor: "pointer",
            borderRadius: 9,
            padding: "0 10px",
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            color: "rgba(195, 236, 255, 0.4)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 12,
            fontWeight: 500,
            transition: "padding 300ms ease-out, background 300ms ease-out, color 200ms ease",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 12V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M4 7L8 3L12 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Top
        </button>

        {/* Toggle expand/collapse */}
        <button
          onClick={onToggle}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; applyParallax(1); }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
          style={{
            background: "#141a1d",
            border: "none",
            cursor: "pointer",
            borderRadius: 9,
            padding: "0 10px",
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            color: "rgba(195, 236, 255, 0.4)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 12,
            fontWeight: 500,
            transition: "padding 300ms ease-out, background 300ms ease-out, color 200ms ease",
          }}
        >
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 10L8 6L12 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {expanded ? "Collapse" : "Expand"}
        </button>

        {/* Next message */}
        <button
          onClick={onNext}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; applyParallax(2); }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
          style={{
            background: "#141a1d",
            border: "none",
            cursor: "pointer",
            borderRadius: 9,
            padding: "0 10px",
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            color: "rgba(195, 236, 255, 0.4)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 12,
            fontWeight: 500,
            transition: "padding 300ms ease-out, background 300ms ease-out, color 200ms ease",
          }}
        >
          Next
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 4V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M4 9L8 13L12 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Components ──────────────────────────────────────────────────────────────

const MessageRow = memo(function MessageRow({
  msg,
  assistantLabel,
  index,
  measureRef,
  expanded,
  onToggleExpand,
  onClampDetected,
}: {
  msg: ConversationMessage;
  assistantLabel: string | undefined;
  index: number;
  measureRef: (index: number, el: HTMLDivElement | null) => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClampDetected?: (needsClamp: boolean) => void;
}) {
  const ref = useCallback((el: HTMLDivElement | null) => measureRef(index, el), [index, measureRef]);

  return (
    <div
      ref={ref}
      data-msg-index={index}
      style={{
        color: msg.role === "assistant" ? "#7FB3CC" : "#C3ECFF",
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 15.5,
        fontWeight: 400,
        lineHeight: "1.6",
        letterSpacing: "0.01em",
        padding: "14px 0",
      }}
    >
      <ChatMessage
        role={msg.role}
        content={msg.content}
        assistantLabel={assistantLabel}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onClampDetected={onClampDetected}
      />
    </div>
  );
});

// ── Main ────────────────────────────────────────────────────────────────────

function ContinueChatButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "rgba(195,236,255,0.1)",
        backdropFilter: "blur(32px) saturate(1.3)",
        border: "none",
        borderRadius: 10,
        padding: "9px 20px",
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 13,
        fontWeight: 600,
        color: "rgba(195,236,255,0.75)",
        cursor: "pointer",
        transition: "color 300ms ease, background 300ms ease, transform 150ms ease",
        letterSpacing: "-0.01em",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "rgba(195,236,255,0.95)";
        e.currentTarget.style.background = "rgba(195,236,255,0.18)";
        e.currentTarget.style.transform = "scale(1.03)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "rgba(195,236,255,0.75)";
        e.currentTarget.style.background = "rgba(195,236,255,0.1)";
        e.currentTarget.style.transform = "scale(1)";
      }}
    >
      Continue Chat
    </button>
  );
}


interface ConversationViewProps {
  markdown: string | null;
  visible?: boolean;
  hideHeader?: boolean;
  error?: string | null;
  onContinueChat?: (messages: ConversationMessage[], title: string, conversationId?: string) => void;
  onRename?: (newTitle: string) => void;
  onDelete?: () => void;
}

export default function ConversationView({ markdown, visible = true, hideHeader = false, error = null, onContinueChat, onRename, onDelete }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerWrapperRef = useRef<HTMLDivElement>(null);
  const [innerWrapperRect, setInnerWrapperRect] = useState<{ top: number; bottom: number; right: number } | null>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const [parsed, setParsed] = useState<{
    frontmatter: Frontmatter;
    title: string | null;
    messages: ConversationMessage[];
  } | null>(null);

  // Expand/collapse state for long user messages
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set());
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleDraft, setEditTitleDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const clampableRef = useRef<Set<number>>(new Set());
  const [activeClampIdx, setActiveClampIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!markdown) { setParsed(null); return; }
    const { frontmatter, body } = parseFrontmatter(markdown);
    const { title, messages } = parseMessages(body);
    setParsed({ frontmatter, title, messages });
    setExpandedSet(new Set());
    clampableRef.current = new Set();
    setActiveClampIdx(null);
  }, [markdown]);

  const messages = parsed?.messages || [];
  const { range, measureRef, getOffset, getHeight, getTotalHeight, recalc } =
    useVirtualizer(messages, scrollRef);

  const [headerOffset, setHeaderOffset] = useState(0);
  const [currentMsgIdx, setCurrentMsgIdx] = useState<number | null>(null);
  // Bumped whenever measurements may have changed so the sequence rail recomputes.
  const [heightsVersion, setHeightsVersion] = useState(0);

  const toggleExpand = useCallback((idx: number) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  const registerClampable = useCallback((idx: number, needsClamp: boolean) => {
    if (needsClamp) clampableRef.current.add(idx);
    else clampableRef.current.delete(idx);
  }, []);

  // Find the active clampable user message in viewport
  const updateActiveClamp = useCallback(() => {
    const el = scrollRef.current;
    if (!el) { setActiveClampIdx(null); return; }
    // The inner content div has padding/title before the virtualizer spacers
    const contentEl = el.firstElementChild as HTMLElement | null;
    if (!contentEl) { setActiveClampIdx(null); return; }
    // Offset from scroll container top to where virtualizer index 0 starts
    // (title + top spacer are before the message rows)
    const scrollTop = el.scrollTop;
    const viewH = el.clientHeight;
    const viewCenter = scrollTop + viewH * 0.35;

    let best: number | null = null;
    let bestDist = Infinity;
    for (const idx of clampableRef.current) {
      if (messages[idx]?.role !== "user") continue;
      // Use DOM element if available, otherwise virtualizer offsets
      const domEl = el.querySelector(`[data-msg-index="${idx}"]`) as HTMLElement | null;
      let msgTop: number;
      let msgH: number;
      if (domEl) {
        msgTop = domEl.offsetTop + contentEl.offsetTop;
        msgH = domEl.offsetHeight;
      } else {
        // Not rendered — message is offscreen, skip
        continue;
      }
      const msgBottom = msgTop + msgH;
      // Must overlap viewport by at least 30%
      const overlapTop = Math.max(scrollTop, msgTop);
      const overlapBot = Math.min(scrollTop + viewH, msgBottom);
      const overlap = Math.max(0, overlapBot - overlapTop);
      if (overlap < viewH * 0.15) continue;

      const msgCenter = msgTop + msgH / 2;
      const d = Math.abs(viewCenter - msgCenter);
      if (d < bestDist) {
        bestDist = d;
        best = idx;
      }
    }
    setActiveClampIdx(prev => prev === best ? prev : best);
  }, [messages]);

  // Find the message closest to the upper-third of the viewport.
  const updateCurrentMsg = useCallback(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) {
      setCurrentMsgIdx(null);
      return;
    }
    const probe = el.scrollTop + el.clientHeight * 0.3;
    let cumul = headerOffset;
    let found = messages.length - 1;
    for (let i = 0; i < messages.length; i++) {
      const h = getHeight(i);
      if (cumul + h > probe) { found = i; break; }
      cumul += h;
    }
    setCurrentMsgIdx((prev) => (prev === found ? prev : found));
  }, [messages, getHeight, headerOffset]);

  const scrollToMessage = useCallback((idx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // Try the rendered DOM element first for accuracy.
    const domEl = el.querySelector(`[data-msg-index="${idx}"]`) as HTMLElement | null;
    const contentEl = el.firstElementChild as HTMLElement | null;
    let target: number;
    if (domEl && contentEl) {
      target = domEl.offsetTop + contentEl.offsetTop;
    } else {
      target = headerOffset + getOffset(idx);
    }
    el.scrollTo({ top: Math.max(0, target - 40), behavior: "smooth" });
  }, [getOffset, headerOffset]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFadeTop(el.scrollTop > 8);
    setFadeBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
    recalc();
    updateActiveClamp();
    updateCurrentMsg();
  }, [recalc, updateActiveClamp, updateCurrentMsg]);

  // Track the inner wrapper's bounding rect so the rail can be portal-positioned
  // outside it (the wrapper has overflow:hidden which would otherwise clip the rail).
  useEffect(() => {
    const el = innerWrapperRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setInnerWrapperRect({ top: r.top, bottom: r.bottom, right: r.right });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); };
  }, [parsed]);

  // Recalc on parse / resize — also update fade states so floating button is correct on load
  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFadeTop(el.scrollTop > 8);
    setFadeBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);

  useEffect(() => {
    recalc();
    // Defer fade check to after layout settles
    requestAnimationFrame(updateFades);
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { recalc(); updateFades(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [recalc, parsed, updateFades]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [markdown]);

  // Measure the offset from the scroll-container top to the first message,
  // then keep it fresh on resize / parse changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      const firstMsg = el.querySelector('[data-msg-index="0"]') as HTMLElement | null;
      const contentEl = el.firstElementChild as HTMLElement | null;
      if (firstMsg && contentEl) {
        const offset = firstMsg.offsetTop + contentEl.offsetTop;
        setHeaderOffset((prev) => (Math.abs(prev - offset) < 1 ? prev : offset));
      }
    };
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [parsed]);

  // Whenever the visible range expands, more rows get measured by the virtualizer —
  // bump the version so the sequence rail recomputes its proportional gaps.
  useEffect(() => {
    setHeightsVersion((v) => v + 1);
  }, [range.start, range.end, parsed]);

  // Track the active message after parse / heights change.
  useEffect(() => {
    updateCurrentMsg();
  }, [updateCurrentMsg, heightsVersion]);

  if (!parsed || !visible) {
    return (
      <div className="flex flex-1 items-center justify-center h-full">
        <span style={{
          color: error ? "rgba(247, 118, 142, 0.4)" : "rgba(195, 236, 255, 0.25)",
          fontFamily: "'DM Sans', sans-serif",
          fontSize: error ? 14 : 16, fontWeight: 500, letterSpacing: "-0.02em",
          textAlign: "center",
          maxWidth: 320,
          lineHeight: 1.5,
        }}>
          {error ? `Failed to load conversation` : markdown === null ? "Select a conversation" : "Loading..."}
        </span>
      </div>
    );
  }

  const title = parsed.frontmatter.title || parsed.title || "Untitled";
  const assistantLabel = displayName(parsed.frontmatter.platform, PLATFORM_NAMES) || undefined;
  const meta = [
    displayName(parsed.frontmatter.platform, PLATFORM_NAMES),
    displayName(parsed.frontmatter.model, MODEL_NAMES),
    parsed.frontmatter.messages ? `${parsed.frontmatter.messages} messages` : null,
    (parsed.frontmatter.updated_at || parsed.frontmatter.created_at || parsed.frontmatter.synced)
      ? new Date((parsed.frontmatter.updated_at || parsed.frontmatter.created_at || parsed.frontmatter.synced)!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null,
  ].filter(Boolean);

  const topPad = getOffset(range.start);
  const totalHeight = getTotalHeight();
  const renderedHeight = getOffset(range.end) - topPad;
  const bottomPad = Math.max(0, totalHeight - topPad - renderedHeight);

  return (
    <div className="flex flex-col items-center h-full w-full min-h-0" style={{ padding: hideHeader ? "0 24px" : "16px 24px 24px" }}>
      <div ref={innerWrapperRef} className="flex flex-col min-h-0 w-full" style={{ maxWidth: "clamp(600px, 55vw, 900px)", flex: 1, overflow: "hidden" }}>
        {/* Header — hidden when titlebar shows it */}
        {!hideHeader && (
          <div className="shrink-0" style={{ padding: "4px 0 14px" }}>
            <h2 style={{
              margin: 0, fontFamily: "'DM Sans', sans-serif",
              fontSize: 18, fontWeight: 600, color: "#C3ECFF",
              letterSpacing: "-0.03em", lineHeight: "1.3",
            }}>
              {title}
            </h2>
            {meta.length > 0 && (
              <div style={{
                marginTop: 6, fontFamily: "'DM Sans', sans-serif",
                fontSize: 12, fontWeight: 500, color: "rgba(195, 236, 255, 0.35)",
                letterSpacing: "-0.01em", display: "flex", gap: 8, alignItems: "center",
              }}>
                {meta.map((m, i) => (
                  <span key={i}>
                    {i > 0 && <span style={{ margin: "0 4px", opacity: 0.4 }}>&middot;</span>}
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Messages — virtualized scroll */}
        <div className="relative flex-1 min-h-0">
          {/* Base top fade — subtle, always on scroll */}
          <div
            className="absolute left-0 right-0 top-0 pointer-events-none"
            style={{
              height: 60,
              zIndex: 2,
              background: "linear-gradient(to bottom, var(--color-base) 0%, transparent 100%)",
              opacity: fadeTop ? 1 : 0,
              transition: "opacity 400ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
          {/* Base bottom fade — subtle, always on scroll — sits under floating button */}
          <div
            className="absolute left-0 right-0 bottom-0 pointer-events-none"
            style={{
              height: 60,
              zIndex: 1,
              background: "linear-gradient(to top, var(--color-base) 0%, transparent 100%)",
              opacity: fadeBottom ? 1 : 0,
              transition: "opacity 400ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
          {/* Intense top fade — only when viewing an expanded long user message */}
          <div
            className="absolute left-0 right-0 top-0 pointer-events-none"
            style={{
              height: 240,
              zIndex: 2,
              background: "linear-gradient(to bottom, var(--color-base) 0%, rgba(2,10,13,0.9) 20%, rgba(2,10,13,0.5) 50%, rgba(2,10,13,0.2) 75%, transparent 100%)",
              opacity: fadeTop && activeClampIdx !== null && expandedSet.has(activeClampIdx) ? 1 : 0,
              transition: "opacity 600ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
          {/* Intense bottom fade — only when viewing an expanded long user message — sits under floating button */}
          <div
            className="absolute left-0 right-0 bottom-0 pointer-events-none"
            style={{
              height: 480,
              zIndex: 1,
              background: "linear-gradient(to top, var(--color-base) 0%, rgba(2,10,13,0.95) 15%, rgba(2,10,13,0.7) 40%, rgba(2,10,13,0.3) 65%, transparent 100%)",
              opacity: fadeBottom && activeClampIdx !== null && expandedSet.has(activeClampIdx) ? 1 : 0,
              transition: "opacity 600ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
          {/* Floating controls for long user messages */}
          <MessageControls
            visible={activeClampIdx !== null && expandedSet.has(activeClampIdx)}
            expanded={activeClampIdx !== null && expandedSet.has(activeClampIdx)}
            onScrollTop={() => {
              if (activeClampIdx === null || !scrollRef.current) return;
              const top = getOffset(activeClampIdx);
              scrollRef.current.scrollTo({ top: Math.max(0, top - 40), behavior: "smooth" });
            }}
            onNext={() => {
              if (activeClampIdx === null || !scrollRef.current) return;
              // Find next message after active
              const nextIdx = activeClampIdx + 1;
              if (nextIdx < messages.length) {
                const top = getOffset(nextIdx);
                scrollRef.current.scrollTo({ top: Math.max(0, top - 40), behavior: "smooth" });
              }
            }}
            onToggle={() => {
              if (activeClampIdx === null) return;
              // When collapsing, scroll to message top so user doesn't get lost
              if (expandedSet.has(activeClampIdx) && scrollRef.current) {
                const top = getOffset(activeClampIdx);
                scrollRef.current.scrollTo({ top: Math.max(0, top - 40), behavior: "smooth" });
              }
              toggleExpand(activeClampIdx);
            }}
          />
          {/* Rail rendered via portal below — see end of component. */}
          <div
            ref={scrollRef}
            className="absolute inset-0 overflow-y-auto scrollbar-none"
            onScroll={handleScroll}
            style={{
              padding: hideHeader ? "0 0 8px" : "8px 0 28px",
            }}
          >
          <div style={{ maxWidth: "clamp(560px, 50vw, 840px)", padding: "0 24px" }}>
            {/* Scrollable title */}
            {hideHeader && (
              <div style={{ padding: "64px 0 14px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <h1 style={{
                    margin: 0,
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: "clamp(28px, 2.5vw, 34px)",
                    fontWeight: 600,
                    color: "rgba(195, 236, 255, 0.75)",
                    letterSpacing: "-0.04em",
                    lineHeight: 1.15,
                    textWrap: "balance" as const,
                    flex: 1,
                  }}>
                    {title}
                  </h1>
                  {(onRename || onDelete) && (
                    <div style={{ display: "flex", gap: 4, flexShrink: 0, paddingTop: 4 }}>
                      {onRename && (
                        <img
                          src="/icons/EditIcon.svg"
                          alt="Edit"
                          title="Rename conversation"
                          onClick={() => { setEditTitleDraft(title); setEditingTitle(true); }}
                          style={{
                            width: 26, height: 26,
                            filter: "invert(0.7) sepia(0.3) saturate(2) hue-rotate(170deg) brightness(1.1)",
                            opacity: 0.35, cursor: "pointer",
                            transition: "transform 200ms ease, opacity 200ms ease",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.15)"; e.currentTarget.style.opacity = "0.8"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.opacity = "0.35"; }}
                        />
                      )}
                      {onDelete && (
                        <img
                          src="/icons/TrashIcon.svg"
                          alt="Delete"
                          title="Delete conversation"
                          onClick={() => setConfirmingDelete(true)}
                          style={{
                            width: 26, height: 26,
                            filter: "invert(0.7) sepia(0.3) saturate(2) hue-rotate(170deg) brightness(1.1)",
                            opacity: 0.35, cursor: "pointer",
                            transition: "transform 200ms ease, opacity 200ms ease",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.15)"; e.currentTarget.style.opacity = "0.8"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.opacity = "0.35"; }}
                        />
                      )}
                    </div>
                  )}
                </div>
                {meta.length > 0 && (
                  <div style={{
                    marginTop: 10,
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "rgba(195, 236, 255, 0.25)",
                    letterSpacing: "-0.01em",
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}>
                    {meta.map((m, i) => (
                      <span key={i}>
                        {i > 0 && <span style={{ margin: "0 2px", opacity: 0.4 }}>&middot;</span>}
                        {m}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Top spacer */}
            <div style={{ height: topPad }} />
            {/* Visible messages */}
            {messages.slice(range.start, range.end).map((msg, i) => {
              const idx = range.start + i;
              return (
                <MessageRow
                  key={idx}
                  msg={msg}
                  assistantLabel={assistantLabel}
                  index={idx}
                  measureRef={measureRef}
                  expanded={expandedSet.has(idx)}
                  onToggleExpand={() => toggleExpand(idx)}
                  onClampDetected={(c) => registerClampable(idx, c)}
                />
              );
            })}
            {/* Bottom spacer */}
            <div style={{ height: bottomPad }} />
            {/* Inline Continue in Chat — visible when scrolled to bottom */}
            {onContinueChat && messages.length > 0 && (
              <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 120px" }}>
                <ContinueChatButton onClick={() => onContinueChat(
                  messages,
                  parsed.frontmatter.title || parsed.title || "Untitled",
                  parsed.frontmatter.id,
                )} />
              </div>
            )}
          </div>
        </div>
          {/* Floating sticky Continue in Chat — visible when NOT at bottom */}
          {onContinueChat && messages.length > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: 32,
                left: 0,
                right: 0,
                display: "flex",
                justifyContent: "center",
                zIndex: 5,
                opacity: fadeBottom ? 1 : 0,
                pointerEvents: fadeBottom ? "auto" : "none",
                transition: "opacity 300ms ease",
              }}
            >
              <ContinueChatButton onClick={() => onContinueChat(
                messages,
                parsed.frontmatter.title || parsed.title || "Untitled",
                parsed.frontmatter.id,
              )} />
            </div>
          )}
        </div>
      </div>
      {/* Message-sequence rail — portal'd outside the inner wrapper (which has overflow:hidden)
          and positioned fixed relative to the inner wrapper's right edge so the rail isn't
          glued to the conversation column on wide viewports. */}
      {innerWrapperRect && messages.length >= 2 && createPortal(
        <div
          style={{
            position: "fixed",
            top: innerWrapperRect.top + (hideHeader ? 100 : 60),
            bottom: window.innerHeight - innerWrapperRect.bottom + 60,
            left: innerWrapperRect.right + 28,
            width: 32,
            zIndex: 50,
          }}
        >
          <MessageSequence
            messages={messages}
            getHeight={getHeight}
            scrollToMessage={scrollToMessage}
            scrollRef={scrollRef}
            activeIdx={currentMsgIdx}
            heightsVersion={heightsVersion}
            top={0}
            bottom={0}
            right={0}
          />
        </div>,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {/* Rename dialog */}
      {editingTitle && parsed && createPortal(
        <div
          onClick={() => setEditingTitle(false)}
          style={{
            position: "absolute", inset: 0, zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)",
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#0b1115", border: "1px solid rgba(195, 236, 255, 0.08)",
            borderRadius: 12, padding: 24, width: 360,
            display: "flex", flexDirection: "column", gap: 16,
          }}>
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 16, fontWeight: 600, color: "rgba(195, 236, 255, 0.9)", letterSpacing: "-0.02em" }}>
              Rename Conversation
            </span>
            <input
              autoFocus
              value={editTitleDraft}
              onChange={(e) => setEditTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editTitleDraft.trim()) { onRename?.(editTitleDraft.trim()); setEditingTitle(false); }
                if (e.key === "Escape") setEditingTitle(false);
              }}
              placeholder="Conversation title"
              style={{
                background: "rgba(195, 236, 255, 0.05)", border: "1px solid rgba(195, 236, 255, 0.1)",
                borderRadius: 8, padding: "10px 12px", color: "rgba(195, 236, 255, 0.9)",
                fontFamily: "'DM Sans', sans-serif", fontSize: 14, outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditingTitle(false)} style={{
                background: "rgba(195, 236, 255, 0.06)", border: "none", borderRadius: 6, padding: "8px 16px",
                color: "rgba(195, 236, 255, 0.6)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}>Cancel</button>
              <button onClick={() => {
                if (editTitleDraft.trim()) { onRename?.(editTitleDraft.trim()); setEditingTitle(false); }
              }} style={{
                background: "rgba(195, 236, 255, 0.1)", border: "1px solid rgba(195, 236, 255, 0.15)", borderRadius: 6, padding: "8px 20px",
                color: "rgba(195, 236, 255, 0.9)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Save</button>
            </div>
          </div>
        </div>,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {/* Delete confirmation */}
      {confirmingDelete && parsed && createPortal(
        <div
          onClick={() => setConfirmingDelete(false)}
          style={{
            position: "absolute", inset: 0, zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)",
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#0b1115", border: "1px solid rgba(195, 236, 255, 0.08)",
            borderRadius: 12, padding: 24, width: 360,
            display: "flex", flexDirection: "column", gap: 16,
          }}>
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 16, fontWeight: 600, color: "rgba(195, 236, 255, 0.9)", letterSpacing: "-0.02em" }}>
              Delete Conversation
            </span>
            <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "rgba(195, 236, 255, 0.5)", lineHeight: 1.5, margin: 0 }}>
              Are you sure you want to delete <strong style={{ color: "rgba(195, 236, 255, 0.8)" }}>{parsed.frontmatter.title || parsed.title || "Untitled"}</strong>? This will remove the file from your vault.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmingDelete(false)} style={{
                background: "rgba(195, 236, 255, 0.06)", border: "none", borderRadius: 6, padding: "8px 16px",
                color: "rgba(195, 236, 255, 0.6)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}>Cancel</button>
              <button onClick={() => { setConfirmingDelete(false); onDelete?.(); }} style={{
                background: "rgba(248, 113, 113, 0.12)", border: "1px solid rgba(248, 113, 113, 0.2)", borderRadius: 6, padding: "8px 20px",
                color: "#f87171", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Delete</button>
            </div>
          </div>
        </div>,
        document.getElementById("kept-app-container") ?? document.body,
      )}
    </div>
  );
}
