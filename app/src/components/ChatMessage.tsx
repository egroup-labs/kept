import { memo, useState, useRef, useLayoutEffect, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";
import type { ChatAttachment } from "../lib/types";

interface ChatMessageProps {
  role: string;
  content: string;
  /** Label shown for assistant messages (e.g. platform name). Falls back to "Assistant". */
  assistantLabel?: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Reports whether this message is long enough to need clamping */
  onClampDetected?: (needsClamp: boolean) => void;
  attachments?: ChatAttachment[];
  reasoning?: string;
  toolCalls?: { name: string; arguments: unknown }[];
  streaming?: boolean;
  thinkingActive?: boolean;
}

function formatArgs(args: unknown): string {
  if (args == null || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}

export function RoleLabel({ role, assistantLabel }: { role: string; assistantLabel?: string }) {
  const label = role === "assistant" ? (assistantLabel || "Agent") : "User";
  const isUser = role !== "assistant";
  return (
    <span className="inline-flex items-center gap-2">
      <div
        className={`w-5 h-5 rounded-full shrink-0 ${
          isUser
            ? "bg-[radial-gradient(circle_at_40%_38%,#E06488_0%,#F0919E_55%,#F8BCC4_100%)] shadow-[0_1px_6px_2px_rgba(224,100,136,0.15)]"
            : "bg-[radial-gradient(circle_at_40%_38%,#3472F8_0%,#5A8FF8_55%,#89BCF5_100%)] shadow-[0_1px_6px_2px_rgba(52,114,248,0.15)]"
        }`}
      />
      <span className="font-['DM_Sans',sans-serif] text-[15px] font-semibold tracking-[-0.01em] leading-none text-[rgba(195,236,255,0.5)]">
        {label}
      </span>
    </span>
  );
}

const COLLAPSED_LINES = 7;
const LINE_HEIGHT = 1.45;
const FONT_SIZE = 15;
const MAX_HEIGHT = Math.round(COLLAPSED_LINES * LINE_HEIGHT * FONT_SIZE);

function UserMessage({ content, expanded = false, onToggleExpand, onClampDetected, attachments }: {
  content: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClampDetected?: (needsClamp: boolean) => void;
  attachments?: ChatAttachment[];
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  // Optimistically estimate clamping from content length to avoid flash of unclamped text
  const likelyLong = content.length > 400 || content.split("\n").length > COLLAPSED_LINES;
  const [needsClamp, setNeedsClamp] = useState(likelyLong);
  const [targetHeight, setTargetHeight] = useState<number>(MAX_HEIGHT);

  // useLayoutEffect fires synchronously before browser paint, preventing the visible flash
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const h = el.scrollHeight;
    const clamp = h > MAX_HEIGHT + 10;
    setNeedsClamp(clamp);
    onClampDetected?.(clamp);
    setTargetHeight(expanded ? h : MAX_HEIGHT);
  }, [content, expanded, onClampDetected]);

  const imgs = attachments?.filter(a => a.media_type.startsWith("image/")) ?? [];

  return (
    <div style={{ color: expanded ? "rgba(195, 236, 255, 0.7)" : "rgba(195, 236, 255, 0.85)", transition: "color 400ms ease" }}>
      {imgs.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {imgs.map((att, i) => {
            const src = att.preview || `data:${att.media_type};base64,${att.data}`;
            return (
              <img
                key={i}
                src={src}
                alt={att.filename || "attachment"}
                style={{
                  maxWidth: 180,
                  maxHeight: 140,
                  borderRadius: 8,
                  objectFit: "cover",
                  border: "1px solid rgba(195, 236, 255, 0.1)",
                }}
              />
            );
          })}
        </div>
      )}
      <div
        ref={outerRef}
        style={{
          height: needsClamp ? targetHeight : undefined,
          overflow: "hidden",
          maskImage: needsClamp && !expanded
            ? "linear-gradient(to bottom, black 50%, transparent 100%)"
            : undefined,
          transition: needsClamp ? "height 400ms cubic-bezier(0.16, 1, 0.3, 1)" : undefined,
        }}
      >
        <div ref={innerRef} className="chat-msg-user" style={{ color: "inherit" }}>
          {content}
        </div>
      </div>
      {needsClamp && (
        <button
          onClick={() => {
            if (expanded && outerRef.current) {
              const rect = outerRef.current.getBoundingClientRect();
              if (rect.top < 60) {
                const scrollParent = outerRef.current.closest("[class*='overflow-y']") as HTMLElement;
                if (scrollParent) {
                  scrollParent.scrollTo({ top: scrollParent.scrollTop + rect.top - 60, behavior: "smooth" });
                }
              }
            }
            onToggleExpand?.();
          }}
          className="bg-none border-none cursor-pointer py-1 px-0 font-['DM_Sans',sans-serif] text-[13px] font-medium text-[rgba(195,236,255,0.3)] transition-colors duration-200 ease-[ease] hover:text-[rgba(195,236,255,0.6)]"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function ThinkingBlock({ content, active = false }: { content?: string; active?: boolean }) {
  const trimmed = content?.trim();
  if (!trimmed) return null;

  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        marginBottom: 10,
        borderLeft: "1px solid rgba(195,236,255,0.16)",
        paddingLeft: 10,
      }}
    >
      <div
        style={{
          color: "rgba(195,236,255,0.48)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
          paddingBottom: 5,
        }}
      >
        Thinking
      </div>
      <MarkdownRenderer
        content={trimmed}
        className="chat-markdown chat-thinking-markdown"
        streaming={active}
      />
    </div>
  );
}

function ToolsBlock({ toolCalls }: { toolCalls?: { name: string; arguments: unknown }[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        marginBottom: 10,
        borderLeft: "1px solid rgba(195,236,255,0.16)",
        paddingLeft: 10,
      }}
    >
      <div
        style={{
          color: "rgba(195,236,255,0.48)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
          paddingBottom: 5,
        }}
      >
        Tool calls
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        {toolCalls.map((t, i) => {
          const argsStr = formatArgs(t.arguments);
          const display = `${t.name}(${argsStr.length > 80 ? argsStr.slice(0, 80) + "…" : argsStr})`;
          return (
            <li
              key={i}
              title={`${t.name}(${argsStr})`}
              style={{
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                fontSize: 12,
                color: "rgba(195,236,255,0.55)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {display}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DetailsBlock({
  reasoning,
  toolCalls,
  thinkingActive,
  streaming,
}: {
  reasoning?: string;
  toolCalls?: { name: string; arguments: unknown }[];
  thinkingActive?: boolean;
  streaming?: boolean;
}) {
  const hasReasoning = !!reasoning?.trim();
  const hasTools = !!toolCalls && toolCalls.length > 0;

  const label = hasReasoning && hasTools ? "Details" : hasTools ? "Tool calls" : "Thinking";

  const [open, setOpen] = useState<boolean>(true);
  const wasStreaming = useRef<boolean>(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      setOpen(false);
    }
    wasStreaming.current = !!streaming;
  }, [streaming]);
  useEffect(() => { if (streaming) setOpen(true); }, [streaming]);

  if (!hasReasoning && !hasTools) return null;

  return (
    <div style={{ width: "100%", minWidth: 0, marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          background: "transparent",
          border: "none",
          padding: "0 0 8px",
          cursor: "pointer",
          color: "rgba(195,236,255,0.6)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
      </button>
      {open && (
        <div>
          <ThinkingBlock content={reasoning} active={thinkingActive} />
          <ToolsBlock toolCalls={toolCalls} />
        </div>
      )}
    </div>
  );
}

export default memo(function ChatMessage({
  role,
  content,
  assistantLabel,
  expanded,
  onToggleExpand,
  onClampDetected,
  attachments,
  reasoning,
  toolCalls,
  streaming = false,
  thinkingActive = false,
}: ChatMessageProps) {
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <RoleLabel role={role} assistantLabel={assistantLabel} />
      <div style={{ marginTop: 4, width: "100%", minWidth: 0 }}>
        {role !== "assistant"
          ? <UserMessage content={content} expanded={expanded} onToggleExpand={onToggleExpand} onClampDetected={onClampDetected} attachments={attachments} />
          : (
            <>
              <DetailsBlock
                reasoning={reasoning}
                toolCalls={toolCalls}
                thinkingActive={thinkingActive}
                streaming={streaming}
              />
              {content ? <MarkdownRenderer content={content} streaming={streaming} /> : null}
            </>
          )}
      </div>
    </div>
  );
});
