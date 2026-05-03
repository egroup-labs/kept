import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/tauri-api";
import hljs from "highlight.js";

interface ConsentPayload {
  request_id: string;
  language: string;
  code: string;
  dependencies?: string[];
}

const LANG_MAP: Record<string, string> = {
  python: "python",
  javascript: "javascript",
  bash: "bash",
  shell: "bash",
};

const LANG_LABELS: Record<string, string> = {
  python: "Python",
  javascript: "JavaScript",
  bash: "Shell",
  shell: "Shell",
};

/**
 * Subscribes to `code-exec-consent` events from the backend and exposes the
 * head of the pending queue. The agent can fire multiple tool calls in
 * parallel (chat.rs uses join_all); each one emits its own event. We append
 * to a queue instead of overwriting so no request is lost. Consumers see
 * `pending` (queue[0]); calling `respond(true|false)` pops the head and
 * reveals the next.
 */
export function useCodeConsentQueue() {
  const [queue, setQueue] = useState<ConsentPayload[]>([]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<ConsentPayload>("code-exec-consent", (event) => {
        setQueue((prev) => {
          // Dedupe on request_id (guards against StrictMode double-register
          // in dev and any duplicate backend emissions).
          if (prev.some((p) => p.request_id === event.payload.request_id)) {
            return prev;
          }
          return [...prev, event.payload];
        });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const respond = async (approved: boolean) => {
    const pending = queue[0];
    if (!pending) return;
    const id = pending.request_id;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("cmd_respond_code_consent", {
        requestId: id,
        approved,
      });
    } catch (e) {
      console.error("Failed to respond to consent:", e);
    }
    // Pop the head (only if it still matches — a late-arriving event race
    // shouldn't dequeue a different pending item).
    setQueue((prev) => (prev[0]?.request_id === id ? prev.slice(1) : prev));
  };

  return {
    pending: queue[0] ?? null,
    remaining: Math.max(0, queue.length - 1),
    respond,
  };
}

interface InlineCodeConsentProps {
  pending: ConsentPayload;
  remaining: number;
  onRespond: (approved: boolean) => void;
}

export default function InlineCodeConsent({
  pending,
  remaining,
  onRespond,
}: InlineCodeConsentProps) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.textContent = pending.code;
      codeRef.current.removeAttribute("data-highlighted");
      hljs.highlightElement(codeRef.current);
    }
  }, [pending]);

  const hljsLang = LANG_MAP[pending.language] || "plaintext";
  const label = LANG_LABELS[pending.language] || pending.language;

  return (
    <div
      style={{
        background: "rgba(195, 236, 255, 0.04)",
        border: "1px solid rgba(195, 236, 255, 0.1)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        animation: "cardSlideIn 0.25s cubic-bezier(0.16,1,0.3,1) forwards",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid rgba(195, 236, 255, 0.08)",
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#89BCF5"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 13,
            fontWeight: 600,
            color: "rgba(195, 236, 255, 0.8)",
            letterSpacing: "-0.01em",
            flex: 1,
          }}
        >
          Code Execution Request
          {remaining > 0 && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 500,
                color: "rgba(195, 236, 255, 0.4)",
              }}
            >
              (+{remaining} more queued)
            </span>
          )}
        </span>
        <span
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#89BCF5",
            background: "rgba(137, 188, 245, 0.12)",
            padding: "3px 8px",
            borderRadius: 5,
          }}
        >
          {label}
        </span>
      </div>

      {pending.dependencies && pending.dependencies.length > 0 && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid rgba(195, 236, 255, 0.08)",
            background: "rgba(137, 188, 245, 0.04)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <span
            style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "rgba(195, 236, 255, 0.45)",
            }}
          >
            Will install
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {pending.dependencies.map((dep) => (
              <span
                key={dep}
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "rgba(195, 236, 255, 0.85)",
                  background: "rgba(195, 236, 255, 0.06)",
                  border: "1px solid rgba(195, 236, 255, 0.1)",
                  padding: "2px 8px",
                  borderRadius: 5,
                }}
              >
                {dep}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: "10px 16px" }}>
        <pre
          style={{
            margin: 0,
            borderRadius: 8,
            background: "rgba(2, 10, 13, 0.5)",
            border: "1px solid rgba(195, 236, 255, 0.06)",
            padding: 12,
            overflow: "auto",
            maxHeight: 320,
          }}
        >
          <code
            ref={codeRef}
            className={`language-${hljsLang}`}
            style={{
              fontSize: 12.5,
              fontFamily: "var(--font-mono)",
              lineHeight: 1.5,
              whiteSpace: "pre",
              tabSize: 4,
            }}
          />
        </pre>
      </div>

      <div
        style={{
          padding: "10px 16px 12px",
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          borderTop: "1px solid rgba(195, 236, 255, 0.08)",
        }}
      >
        <button
          onClick={() => onRespond(false)}
          style={{
            padding: "7px 16px",
            borderRadius: 7,
            border: "1px solid rgba(195, 236, 255, 0.12)",
            background: "transparent",
            color: "rgba(195, 236, 255, 0.65)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 12.5,
            fontWeight: 500,
            cursor: "pointer",
            transition: "background 150ms ease, color 150ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(195, 236, 255, 0.06)";
            e.currentTarget.style.color = "rgba(195, 236, 255, 0.9)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "rgba(195, 236, 255, 0.65)";
          }}
        >
          Deny
        </button>
        <button
          onClick={() => onRespond(true)}
          style={{
            padding: "7px 18px",
            borderRadius: 7,
            border: "none",
            background: "#89BCF5",
            color: "#0C2937",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 150ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#9ACFFC";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#89BCF5";
          }}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
