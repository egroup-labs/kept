import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw, X, Clock, ArrowRight, MessageSquare, Hourglass,
  MessageCircleQuestion, FolderPlus, Folder, Sparkles, Check, ChevronDown, ChevronRight, Plus,
} from "lucide-react";
import type { DigestItem, SuggestedProject, ProjectData } from "../lib/types";
import type { ConversationMessage } from "../lib/markdown";
import {
  getDigestItems, updateDigestItem, refreshDigest,
  getSuggestedProjects, createProjectFromDigest, linkConversationToProject,
  createProjectWithConversation, markDigestItemsSeen, triggerDigestAutoPass,
  bulkUpdateDigestItems, cmdKgGetProjects, getConversation,
} from "../lib/tauri-api";
import { parseMessages } from "../lib/markdown";
import Squircle from "./Squircle";

interface DigestViewProps {
  visible: boolean;
  onOpenConversation: (filePath: string) => void;
  onContinueInChat: (messages: ConversationMessage[], title: string, conversationId?: string) => void;
}

const REASON_CONFIG = {
  unfinished: { label: "Unfinished", icon: MessageCircleQuestion },
  stale: { label: "Stale", icon: Hourglass },
  low_messages: { label: "Quiet", icon: MessageSquare },
} as const;

const SNOOZE_OPTIONS = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

const PROJECT_COLORS = [
  "#5FA3E8", "#7FB3CC", "#5FCFE8", "#4EB39A",
  "#9BC4E8", "#7DC4F2", "#5FE8B8", "#4DB8E8",
];

function projectColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Unknown";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "chatgpt": return "ChatGPT";
    case "claude": return "Claude";
    case "gemini": return "Gemini";
    case "grok": return "Grok";
    case "kimi": return "Kimi";
    case "deepseek": return "DeepSeek";
    default: return platform;
  }
}

const SPRING = "cubic-bezier(0.34,1.56,0.64,1)";

// Light chat-glass palette (used only on the suggestion banner)
const GLASS_BG = "#89BCF5";
const GLASS_SHADE = "linear-gradient(95.27deg, #79B0F9 22.43%, #5A8FF8 81.48%)";
const GLASS_ACTIVE = "radial-gradient(ellipse at 50% 45%, rgba(255,255,255,0.22) 0%, rgba(100,160,248,0.12) 50%, transparent 100%)";
const GLASS_TEXT_DARK = "#0C2937";
const GLASS_TEXT_MED = "#2B6480";
const GLASS_TEXT_FAINT = "rgba(12,41,55,0.55)";
const GLASS_BTN_BG = "rgba(255,255,255,0.22)";
const GLASS_BTN_BG_HOVER = "rgba(255,255,255,0.32)";

const GLASS_MENU: React.CSSProperties = {
  background: "rgba(2, 10, 13, 0.75)",
  borderRadius: 12,
  padding: 4,
  zIndex: 50,
  backdropFilter: "blur(24px) saturate(1.4)",
  WebkitBackdropFilter: "blur(24px) saturate(1.4)",
  boxShadow: "0 0 0 1px rgba(255,255,255,0.06), 0 24px 60px rgba(0,0,0,0.55)",
};

// ── Project badge / add-to-project dropdown ──────────────────────────────────

function ProjectBadge({
  item,
  projects,
  onAssign,
  onCreateProject,
}: {
  item: DigestItem;
  projects: ProjectData[];
  onAssign: (projectId: string) => void;
  onCreateProject: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [creating]);

  const startCreate = () => {
    setNameDraft(item.project_hint?.trim() ?? "");
    setCreating(true);
  };

  const confirmCreate = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    setOpen(false);
    setCreating(false);
    onCreateProject(trimmed);
  };

  const cancelCreate = () => {
    setCreating(false);
    setNameDraft("");
  };

  if (item.project_id && item.project_name) {
    return null;
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((p) => !p)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--color-fg-muted)",
          background: "transparent",
          border: "none",
          padding: "3px 9px",
          borderRadius: 7,
          cursor: "pointer",
          letterSpacing: "-0.02em",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.06)",
          transition: `color 200ms ease, box-shadow 200ms ease, background 200ms ease, transform 250ms ${SPRING}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--color-fg)";
          e.currentTarget.style.background = "rgba(255,255,255,0.06)";
          e.currentTarget.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.12)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--color-fg-muted)";
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.06)";
        }}
      >
        <FolderPlus size={11} strokeWidth={2.2} />
        Add to project
      </button>

      {open && (
        <div
          style={{
            ...GLASS_MENU,
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: 220,
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          {!creating ? (
            <button
              onClick={startCreate}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                fontSize: 12.5,
                fontWeight: 500,
                color: "var(--color-fg)",
                background: "transparent",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                marginBottom: projects.length > 0 ? 4 : 0,
                letterSpacing: "-0.02em",
                transition: "background 150ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <Plus size={13} strokeWidth={2.2} />
              {item.project_hint ? `Create "${item.project_hint}"` : "Create new project"}
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", marginBottom: projects.length > 0 ? 4 : 0 }}>
              <input
                ref={inputRef}
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Project name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); confirmCreate(); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelCreate(); }
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--color-fg)",
                  background: "rgba(255,255,255,0.04)",
                  border: "none",
                  boxShadow: "0 0 0 1px rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  padding: "6px 9px",
                  outline: "none",
                  fontFamily: "var(--font-sans)",
                  letterSpacing: "-0.02em",
                }}
              />
              <button
                onClick={confirmCreate}
                disabled={!nameDraft.trim()}
                title="Create"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  background: nameDraft.trim() ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)",
                  color: "var(--color-fg)",
                  border: "none",
                  borderRadius: 7,
                  cursor: nameDraft.trim() ? "pointer" : "default",
                  flexShrink: 0,
                  transition: "background 150ms ease",
                }}
              >
                <Check size={12} strokeWidth={3} />
              </button>
              <button
                onClick={cancelCreate}
                title="Cancel"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  background: "transparent",
                  color: "var(--color-fg-muted)",
                  border: "none",
                  borderRadius: 7,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <X size={12} strokeWidth={3} />
              </button>
            </div>
          )}
          {projects.length > 0 && (
            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "2px 6px 4px" }} />
          )}
          {projects.map((p) => {
            const c = projectColor(p.id);
            return (
              <button
                key={p.id}
                onClick={() => { setOpen(false); onAssign(p.id); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--color-fg-secondary)",
                  background: "transparent",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  letterSpacing: "-0.02em",
                  transition: "background 150ms ease, color 150ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--color-fg)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, flexShrink: 0 }} />
                {p.name}
              </button>
            );
          })}
          {item.project_hint && (
            <div style={{
              padding: "6px 10px 4px",
              fontSize: 10.5,
              color: "var(--color-fg-faint)",
              borderTop: "1px solid rgba(255,255,255,0.06)",
              marginTop: 4,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}>
              Suggestion · {item.project_hint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Suggested projects banner — light frosted-glass squircle ─────────────────

function SuggestedProjectsBanner({
  suggestions,
  onAccept,
  onDismiss,
}: {
  suggestions: SuggestedProject[];
  onAccept: (suggestion: SuggestedProject) => Promise<void>;
  onDismiss: (index: number) => void;
}) {
  const [working, setWorking] = useState<number | null>(null);

  if (suggestions.length === 0) return null;

  return (
    <div style={{ marginBottom: 22, display: "flex", flexDirection: "column", gap: 10 }}>
      {suggestions.map((s, i) => (
        <SuggestionCard
          key={i}
          suggestion={s}
          working={working === i}
          disabled={working !== null}
          onAccept={async () => { setWorking(i); await onAccept(s); setWorking(null); }}
          onDismiss={() => onDismiss(i)}
        />
      ))}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  working,
  disabled,
  onAccept,
  onDismiss,
}: {
  suggestion: SuggestedProject;
  working: boolean;
  disabled: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const rect = cardRef.current?.getBoundingClientRect();
  const cw = rect?.width ?? 720;
  const ch = rect?.height ?? 90;
  const parallaxX = (mousePos.x / cw - 0.5) * -16;
  const parallaxY = (mousePos.y / ch - 0.5) * -16;

  return (
    <div
      ref={cardRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={handleMouseMove}
    >
      <Squircle
        radius={20}
        shadow="shadow-[0_10px_40px_rgba(12,41,55,0.18)]"
        style={{ background: GLASS_BG }}
      >
        <div style={{
          position: "relative",
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          minHeight: 64,
        }}>
          {/* Idle shading layer */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: "-12%",
              borderRadius: "50%",
              background: GLASS_SHADE,
              filter: "blur(28px)",
              opacity: hovered ? 0 : 1,
              transform: `translate(${parallaxX * 0.4}px, ${parallaxY * 0.4}px)`,
              transition: "opacity 700ms ease-in-out, transform 700ms ease-out",
              pointerEvents: "none",
            }}
          />
          {/* Active (hover) shading layer */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: "-12%",
              borderRadius: "50%",
              background: GLASS_ACTIVE,
              filter: "blur(30px)",
              opacity: hovered ? 1 : 0,
              transform: `translate(${parallaxX}px, ${parallaxY}px)`,
              transition: "opacity 700ms ease-in-out, transform 700ms ease-out",
              pointerEvents: "none",
            }}
          />

          <div
            style={{
              position: "relative",
              width: 34,
              height: 34,
              borderRadius: 11,
              background: "rgba(255,255,255,0.32)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: GLASS_TEXT_DARK,
            }}
          >
            <Sparkles size={16} strokeWidth={1.8} />
          </div>
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: GLASS_TEXT_DARK,
              marginBottom: 3,
              letterSpacing: "-0.02em",
              fontVariationSettings: '"opsz" 30',
            }}>
              {suggestion.conversation_ids.length} conversations look like {suggestion.suggested_name}
            </div>
            <div
              style={{
                fontSize: 12,
                color: GLASS_TEXT_MED,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                letterSpacing: "-0.01em",
              }}
            >
              {suggestion.conversation_titles.slice(0, 3).join(" · ")}
              {suggestion.conversation_titles.length > 3 ? ` +${suggestion.conversation_titles.length - 3} more` : ""}
            </div>
          </div>
          <button
            onClick={onAccept}
            disabled={disabled}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 600,
              color: GLASS_TEXT_DARK,
              background: GLASS_BTN_BG,
              border: "none",
              borderRadius: 9,
              cursor: disabled ? "default" : "pointer",
              opacity: working ? 0.6 : 1,
              flexShrink: 0,
              letterSpacing: "-0.02em",
              transition: `background 200ms ease, transform 350ms ${SPRING}`,
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = GLASS_BTN_BG_HOVER; e.currentTarget.style.transform = "scale(1.04)"; } }}
            onMouseLeave={(e) => { if (!disabled) { e.currentTarget.style.background = GLASS_BTN_BG; e.currentTarget.style.transform = "scale(1)"; } }}
          >
            {working ? <Check size={12} strokeWidth={2.5} /> : <FolderPlus size={12} strokeWidth={2.2} />}
            {working ? "Creating" : "Create project"}
          </button>
          <button
            onClick={onDismiss}
            title="Not now"
            style={{
              position: "relative",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 6,
              borderRadius: 8,
              color: GLASS_TEXT_FAINT,
              flexShrink: 0,
              transition: "color 180ms ease, background 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = GLASS_TEXT_DARK; e.currentTarget.style.background = "rgba(255,255,255,0.24)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = GLASS_TEXT_FAINT; e.currentTarget.style.background = "transparent"; }}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>
      </Squircle>
    </div>
  );
}

// ── Digest row (dark) ────────────────────────────────────────────────────────

function DigestRow({
  item,
  projects,
  index,
  onContinue,
  onDismiss,
  onSnooze,
  onAssignProject,
  onCreateProject,
}: {
  item: DigestItem;
  projects: ProjectData[];
  index: number;
  onContinue: () => void;
  onDismiss: () => void;
  onSnooze: (days: number) => void;
  onAssignProject: (projectId: string) => void;
  onCreateProject: (name: string) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const snoozeRef = useRef<HTMLDivElement>(null);

  const config = REASON_CONFIG[item.reason] ?? REASON_CONFIG.stale;
  const ReasonIcon = config.icon;

  useEffect(() => {
    if (!snoozeOpen) return;
    const handle = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) setSnoozeOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [snoozeOpen]);

  const handleDismiss = () => { setExiting(true); setTimeout(onDismiss, 220); };
  const handleSnooze = (days: number) => { setSnoozeOpen(false); setExiting(true); setTimeout(() => onSnooze(days), 220); };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        background: hovered ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)",
        borderRadius: 14,
        padding: "clamp(14px, 1.4vw, 18px) clamp(16px, 1.6vw, 20px)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        opacity: exiting ? 0 : 1,
        transform: exiting ? "translateX(12px) scale(0.98)" : "translateX(0) scale(1)",
        transition: `opacity 220ms ease, transform 220ms ease, background 220ms ease, box-shadow 220ms ease`,
        boxShadow: hovered
          ? "0 0 0 1px rgba(255,255,255,0.10), 0 12px 32px rgba(0,0,0,0.18)"
          : "0 0 0 1px rgba(255,255,255,0.05)",
        animation: `digestRowIn 500ms ${SPRING} ${Math.min(index * 40, 240)}ms both`,
      }}
    >
      {/* Top meta row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {!item.seen_at && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 9.5,
              fontWeight: 700,
              color: "var(--color-accent-hover)",
              background: "rgba(77, 184, 232, 0.10)",
              boxShadow: "0 0 0 1px rgba(77, 184, 232, 0.28)",
              borderRadius: 5,
              padding: "2px 7px 2px 5px",
              letterSpacing: "0.10em",
              textTransform: "uppercase",
            }}
          >
            <span style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--color-accent-hover)",
              boxShadow: "0 0 8px rgba(77, 184, 232, 0.7)",
            }} />
            New
          </span>
        )}

        <span
          title={item.attention_reason ?? config.label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontWeight: 500,
            color: "var(--color-fg-secondary)",
            letterSpacing: "-0.01em",
            maxWidth: 280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <ReasonIcon size={12} strokeWidth={2} />
          {item.attention_reason ?? config.label}
        </span>

        <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--color-fg-faint)", flexShrink: 0 }} />

        <span style={{
          fontSize: 11.5,
          color: "var(--color-fg-muted)",
          fontWeight: 500,
          letterSpacing: "-0.01em",
        }}>
          {platformLabel(item.platform)}
        </span>

        <span style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--color-fg-faint)", flexShrink: 0 }} />

        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11.5,
          color: "var(--color-fg-muted)",
          fontWeight: 500,
          letterSpacing: "-0.01em",
        }}>
          <Clock size={11} strokeWidth={2} />
          {timeAgo(item.updated_at ?? item.created_at)}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <ProjectBadge item={item} projects={projects} onAssign={onAssignProject} onCreateProject={onCreateProject} />
          <button
            onClick={handleDismiss}
            title="Dismiss"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 5,
              borderRadius: 6,
              color: "var(--color-fg-faint)",
              opacity: hovered ? 1 : 0.6,
              transition: "color 180ms ease, background 180ms ease, opacity 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg)"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-faint)"; e.currentTarget.style.background = "transparent"; }}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: "clamp(14px, 1.25vw, 16px)",
          fontWeight: 600,
          color: "var(--color-fg)",
          lineHeight: 1.3,
          letterSpacing: "-0.03em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {item.title}
      </div>

      {/* Summary */}
      {(item.summary || item.preview) && (
        <div
          style={{
            fontSize: "clamp(12.5px, 1.05vw, 13.5px)",
            color: "var(--color-fg-muted)",
            lineHeight: 1.55,
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {item.summary ?? item.preview}
        </div>
      )}

      {/* Actions row */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 4,
      }}>
        <button
          onClick={onContinue}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 16px",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--color-fg)",
            background: "rgba(255,255,255,0.10)",
            border: "none",
            borderRadius: 9,
            cursor: "pointer",
            letterSpacing: "-0.02em",
            transition: `background 200ms ease, transform 350ms ${SPRING}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.16)";
            e.currentTarget.style.transform = "scale(1.04)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.10)";
            e.currentTarget.style.transform = "scale(1)";
          }}
        >
          Continue
          <ArrowRight size={12} strokeWidth={2.2} />
        </button>

        <div ref={snoozeRef} style={{ position: "relative" }}>
          <button
            onClick={() => setSnoozeOpen((p) => !p)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "8px 13px",
              fontSize: 12.5,
              fontWeight: 500,
              color: "var(--color-fg-muted)",
              background: "transparent",
              border: "none",
              borderRadius: 9,
              cursor: "pointer",
              letterSpacing: "-0.02em",
              transition: "background 200ms ease, color 200ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.06)";
              e.currentTarget.style.color = "var(--color-fg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--color-fg-muted)";
            }}
          >
            <Clock size={12} strokeWidth={2} />
            Snooze
          </button>

          {snoozeOpen && (
            <div
              style={{
                ...GLASS_MENU,
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                minWidth: 130,
              }}
            >
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => handleSnooze(opt.days)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "7px 12px",
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "var(--color-fg-secondary)",
                    background: "transparent",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    letterSpacing: "-0.02em",
                    transition: "background 150ms ease, color 150ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--color-fg)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        <span style={{
          fontSize: 11,
          color: "var(--color-fg-faint)",
          fontWeight: 500,
          letterSpacing: "-0.01em",
        }}>
          {item.message_count} messages
        </span>
      </div>
    </div>
  );
}

// ── Project bucket (dark) ────────────────────────────────────────────────────

interface ProjectSection {
  /** null means "Unassigned" bucket */
  projectId: string | null;
  projectName: string;
  items: DigestItem[];
}

function ProjectBucket({
  section,
  projects,
  collapsed,
  onToggleCollapsed,
  onContinue,
  onDismiss,
  onSnooze,
  onAssignProject,
  onCreateProject,
  onBulkSnooze,
  onBulkDismiss,
}: {
  section: ProjectSection;
  projects: ProjectData[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContinue: (item: DigestItem) => void;
  onDismiss: (item: DigestItem) => void;
  onSnooze: (item: DigestItem, days: number) => void;
  onAssignProject: (item: DigestItem, projectId: string) => void;
  onCreateProject: (item: DigestItem, name: string) => void;
  onBulkSnooze: (days: number) => void;
  onBulkDismiss: () => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeRef = useRef<HTMLDivElement>(null);
  const color = section.projectId ? projectColor(section.projectId) : "#7FB3CC";

  useEffect(() => {
    if (!snoozeOpen) return;
    const handle = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) setSnoozeOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [snoozeOpen]);

  const unresolvedCount = section.items.reduce((acc, i) => acc + (i.is_unresolved ? 1 : 0), 0);
  const topicCounts = new Map<string, number>();
  for (const item of section.items) {
    for (const t of item.key_topics ?? []) {
      const k = t.trim();
      if (!k) continue;
      topicCounts.set(k, (topicCounts.get(k) ?? 0) + 1);
    }
  }
  const topTopics = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  const isUnassigned = !section.projectId;

  return (
    <div
      style={{
        position: "relative",
        background: "rgb(2,10,13)",
        borderRadius: 24,
        overflow: "hidden",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.05)",
      }}
    >
      {/* Ambient project-color glow */}
      {!isUnassigned && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `radial-gradient(ellipse at 0% 0%, ${color}1A 0%, transparent 55%), radial-gradient(ellipse at 100% 100%, ${color}0F 0%, transparent 60%)`,
          }}
        />
      )}

      {/* Header */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "clamp(16px, 1.6vw, 22px) clamp(20px, 1.8vw, 26px)",
        }}
      >
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand" : "Collapse"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 4,
            borderRadius: 6,
            color: "var(--color-fg-muted)",
            transition: "color 180ms ease, background 180ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg)"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-muted)"; e.currentTarget.style.background = "transparent"; }}
        >
          {collapsed ? <ChevronRight size={16} strokeWidth={2.2} /> : <ChevronDown size={16} strokeWidth={2.2} />}
        </button>

        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
          flex: 1,
        }}>
          {!isUnassigned && (
            <span style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 14px ${color}80`,
              flexShrink: 0,
            }} />
          )}
          {isUnassigned && (
            <Folder size={15} strokeWidth={1.8} color="var(--color-fg-muted)" style={{ flexShrink: 0 }} />
          )}
          <span style={{
            fontSize: "clamp(15px, 1.4vw, 18px)",
            fontWeight: 600,
            color: "var(--color-fg)",
            letterSpacing: "-0.03em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {section.projectName}
          </span>
          <span style={{
            fontSize: 11.5,
            fontWeight: 500,
            color: "var(--color-fg-muted)",
            background: "rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: "2px 7px",
            letterSpacing: "-0.01em",
            flexShrink: 0,
          }}>
            {section.items.length}
          </span>
          {unresolvedCount > 0 && (
            <span style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: "var(--color-fg-muted)",
              letterSpacing: "-0.01em",
              flexShrink: 0,
            }}>
              · {unresolvedCount} unresolved
            </span>
          )}
        </div>

        <div ref={snoozeRef} style={{ position: "relative" }}>
          <button
            onClick={() => setSnoozeOpen((p) => !p)}
            title="Snooze all"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "6px 11px",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--color-fg-muted)",
              background: "transparent",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              letterSpacing: "-0.02em",
              transition: "background 180ms ease, color 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--color-fg)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-fg-muted)"; }}
          >
            <Clock size={12} strokeWidth={2} />
            Snooze all
          </button>
          {snoozeOpen && (
            <div
              style={{
                ...GLASS_MENU,
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                minWidth: 130,
              }}
            >
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => { setSnoozeOpen(false); onBulkSnooze(opt.days); }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "7px 12px",
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "var(--color-fg-secondary)",
                    background: "transparent",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    letterSpacing: "-0.02em",
                    transition: "background 150ms ease, color 150ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--color-fg)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={onBulkDismiss}
          title="Dismiss all in this section"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 11px",
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-fg-muted)",
            background: "transparent",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            letterSpacing: "-0.02em",
            transition: "background 180ms ease, color 180ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--color-fg)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-fg-muted)"; }}
        >
          <X size={12} strokeWidth={2.2} />
          Clear
        </button>
      </div>

      {/* Topics strip */}
      {!collapsed && !isUnassigned && topTopics.length > 0 && (
        <div style={{
          position: "relative",
          padding: "0 clamp(20px, 1.8vw, 26px) 12px",
          display: "flex",
          flexWrap: "wrap",
          gap: 5,
        }}>
          {topTopics.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--color-fg-muted)",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 6,
                padding: "3px 8px",
                letterSpacing: "-0.01em",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Items */}
      {!collapsed && (
        <div style={{
          position: "relative",
          padding: "4px clamp(14px, 1.4vw, 18px) clamp(14px, 1.4vw, 18px)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          {section.items.map((item, idx) => (
            <DigestRow
              key={item.conversation_id}
              item={item}
              projects={projects}
              index={idx}
              onContinue={() => onContinue(item)}
              onDismiss={() => onDismiss(item)}
              onSnooze={(days) => onSnooze(item, days)}
              onAssignProject={(pid) => onAssignProject(item, pid)}
              onCreateProject={(name) => onCreateProject(item, name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export default function DigestView({ visible, onOpenConversation, onContinueInChat }: DigestViewProps) {
  const [items, setItems] = useState<DigestItem[]>([]);
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedProject[]>([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const autoPass = triggerDigestAutoPass().catch((e) => {
        console.warn("Auto-pass failed:", e);
        return [false, 0, 0] as [boolean, number, number];
      });

      const [itemsData, projectsData, suggestionsData] = await Promise.all([
        getDigestItems(false),
        cmdKgGetProjects(),
        getSuggestedProjects(),
      ]);
      setItems(itemsData);
      setProjects(projectsData);
      setSuggestions(suggestionsData.filter((s) => !dismissedSuggestions.has(s.suggested_name)));

      const [ran, , generated] = await autoPass;
      if (ran && generated > 0) {
        const [fresh, freshSugs] = await Promise.all([getDigestItems(false), getSuggestedProjects()]);
        setItems(fresh);
        setSuggestions(freshSugs.filter((s) => !dismissedSuggestions.has(s.suggested_name)));
      }
    } catch (e) {
      console.error("Failed to load digest:", e);
    } finally {
      setLoading(false);
    }
  }, [dismissedSuggestions]);

  useEffect(() => {
    if (visible) {
      if (!loaded.current) {
        loaded.current = true;
      }
      load();
    }
  }, [visible, load]);

  const unseenIdsRef = useRef<string[]>([]);
  useEffect(() => {
    unseenIdsRef.current = items.filter((i) => !i.seen_at).map((i) => i.conversation_id);
  }, [items]);

  useEffect(() => {
    if (!visible && loaded.current) {
      const ids = unseenIdsRef.current;
      if (ids.length > 0) {
        markDigestItemsSeen(ids).catch(() => {});
      }
    }
  }, [visible]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await refreshDigest();
      setItems(data);
      const [projectsData, suggestionsData] = await Promise.all([
        cmdKgGetProjects(),
        getSuggestedProjects(),
      ]);
      setProjects(projectsData);
      setSuggestions(suggestionsData.filter((s) => !dismissedSuggestions.has(s.suggested_name)));
    } catch (e) {
      console.error("Failed to refresh:", e);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismiss = async (conversationId: string) => {
    setItems((prev) => prev.filter((i) => i.conversation_id !== conversationId));
    try {
      await updateDigestItem(conversationId, "dismiss");
    } catch (e) {
      console.error("Failed to dismiss:", e);
      load();
    }
  };

  const handleSnooze = async (conversationId: string, days: number) => {
    setItems((prev) => prev.filter((i) => i.conversation_id !== conversationId));
    try {
      await updateDigestItem(conversationId, "snooze", days);
    } catch (e) {
      console.error("Failed to snooze:", e);
      load();
    }
  };

  const handleAssignProject = async (conversationId: string, projectId: string) => {
    const proj = projects.find((p) => p.id === projectId);
    if (!proj) return;
    setItems((prev) => prev.map((i) =>
      i.conversation_id === conversationId
        ? { ...i, project_id: projectId, project_name: proj.name }
        : i,
    ));
    try {
      await linkConversationToProject(projectId, conversationId);
    } catch (e) {
      console.error("Failed to link:", e);
      load();
    }
  };

  const handleCreateProjectFromCard = async (item: DigestItem, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const description = item.summary ?? "";
    try {
      const projectId = await createProjectWithConversation(trimmed, description, item.conversation_id);
      setItems((prev) => prev.map((i) =>
        i.conversation_id === item.conversation_id
          ? { ...i, project_id: projectId, project_name: trimmed }
          : i,
      ));
      cmdKgGetProjects().then(setProjects).catch(() => {});
    } catch (e) {
      console.error("Failed to create project:", e);
    }
  };

  const handleContinueClick = async (item: DigestItem) => {
    try {
      const markdown = await getConversation(item.file_path);
      const parsed = parseMessages(markdown);
      if (parsed.messages.length === 0) {
        onOpenConversation(item.file_path);
        return;
      }
      onContinueInChat(parsed.messages, parsed.title ?? item.title, item.conversation_id);
    } catch (e) {
      console.error("Failed to load conversation for Continue:", e);
      onOpenConversation(item.file_path);
    }
  };

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleCollapsed = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const sections: ProjectSection[] = useMemo(() => {
    const byProject = new Map<string, ProjectSection>();
    const unassigned: DigestItem[] = [];
    for (const item of items) {
      if (item.project_id && item.project_name) {
        const key = item.project_id;
        const existing = byProject.get(key);
        if (existing) existing.items.push(item);
        else byProject.set(key, { projectId: key, projectName: item.project_name, items: [item] });
      } else {
        unassigned.push(item);
      }
    }
    const list: ProjectSection[] = Array.from(byProject.values())
      .sort((a, b) => b.items.length - a.items.length);
    if (unassigned.length > 0) {
      list.push({ projectId: null, projectName: "Unassigned", items: unassigned });
    }
    return list;
  }, [items]);

  const bulkApply = async (conversationIds: string[], action: "dismiss" | "snooze", days?: number) => {
    setItems((prev) => prev.filter((i) => !conversationIds.includes(i.conversation_id)));
    try {
      await bulkUpdateDigestItems(conversationIds, action, days);
    } catch (e) {
      console.error("Bulk action failed:", e);
      load();
    }
  };

  const handleAcceptSuggestion = async (suggestion: SuggestedProject) => {
    try {
      const projectId = await createProjectFromDigest(
        suggestion.suggested_name,
        suggestion.suggested_description,
        suggestion.conversation_ids,
      );
      setItems((prev) => prev.map((i) =>
        suggestion.conversation_ids.includes(i.conversation_id)
          ? { ...i, project_id: projectId, project_name: suggestion.suggested_name }
          : i,
      ));
      setSuggestions((prev) => prev.filter((s) => s.suggested_name !== suggestion.suggested_name));
      cmdKgGetProjects().then(setProjects).catch(() => {});
    } catch (e) {
      console.error("Failed to create project:", e);
    }
  };

  const handleDismissSuggestion = (index: number) => {
    const s = suggestions[index];
    if (!s) return;
    setDismissedSuggestions((prev) => new Set(prev).add(s.suggested_name));
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 1080,
        margin: "0 auto",
        padding: "64px clamp(20px, 4vw, 48px) 56px",
        fontFamily: "var(--font-sans)",
        flexShrink: 0,
      }}
    >
      {/* Compact header row */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 22,
        padding: "0 4px",
      }}>
        <div style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
        }}>
          <span style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--color-fg)",
            letterSpacing: "-0.03em",
            fontVariationSettings: '"opsz" 30',
          }}>
            Digest
          </span>
          <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-fg-muted)",
            letterSpacing: "-0.01em",
          }}>
            {loading
              ? "Scanning…"
              : items.length === 0
                ? "All caught up"
                : `${items.length} waiting`}
          </span>
        </div>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh digest"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            fontSize: 12,
            fontWeight: 500,
            color: "var(--color-fg-secondary)",
            background: "transparent",
            border: "none",
            borderRadius: 8,
            cursor: refreshing ? "default" : "pointer",
            opacity: refreshing ? 0.5 : 1,
            letterSpacing: "-0.02em",
            transition: `background 200ms ease, color 200ms ease, transform 350ms ${SPRING}`,
          }}
          onMouseEnter={(e) => {
            if (refreshing) return;
            e.currentTarget.style.background = "rgba(195,236,255,0.06)";
            e.currentTarget.style.color = "var(--color-fg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--color-fg-secondary)";
          }}
        >
          <RefreshCw size={12} strokeWidth={2.2} style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }} />
          Refresh
        </button>
      </div>

      {/* Suggested projects banner — light glass */}
      {!loading && (
        <SuggestedProjectsBanner
          suggestions={suggestions}
          onAccept={handleAcceptSuggestion}
          onDismiss={handleDismissSuggestion}
        />
      )}

      {/* Loading skeleton */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[1, 2].map((i) => (
            <div
              key={i}
              style={{
                background: "rgb(2,10,13)",
                borderRadius: 24,
                boxShadow: "0 0 0 1px rgba(255,255,255,0.05)",
                padding: "20px 24px",
                animation: "skeletonPulse 1.6s ease-in-out infinite",
              }}
            >
              <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 6, height: 14, width: "30%", marginBottom: 16 }} />
              <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 12, height: 78, marginBottom: 8 }} />
              <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 12, height: 78 }} />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && (
        <div style={{
          padding: "clamp(56px, 7vw, 96px) 24px",
          background: "rgb(2,10,13)",
          borderRadius: 24,
          boxShadow: "0 0 0 1px rgba(255,255,255,0.05)",
          textAlign: "center",
          overflow: "hidden",
          position: "relative",
        }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            background: "rgba(255,255,255,0.08)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.10), inset 0 0 24px rgba(255,255,255,0.06)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 22,
            color: "var(--color-fg)",
          }}>
            <Check size={26} strokeWidth={1.8} />
          </div>
          <p style={{
            fontSize: "clamp(16px, 1.6vw, 19px)",
            fontWeight: 600,
            margin: "0 0 8px",
            color: "var(--color-fg)",
            letterSpacing: "-0.03em",
          }}>
            All caught up
          </p>
          <p style={{
            fontSize: 13,
            margin: 0,
            color: "var(--color-fg-muted)",
            letterSpacing: "-0.01em",
          }}>
            Refresh to re-scan your vault for stale or unfinished threads.
          </p>
        </div>
      )}

      {/* Buckets */}
      {!loading && sections.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {sections.map((section) => {
            const key = section.projectId ?? "unassigned";
            const collapsed = collapsedSections.has(key);
            return (
              <ProjectBucket
                key={key}
                section={section}
                projects={projects}
                collapsed={collapsed}
                onToggleCollapsed={() => toggleCollapsed(key)}
                onContinue={(item) => handleContinueClick(item)}
                onDismiss={(item) => handleDismiss(item.conversation_id)}
                onSnooze={(item, days) => handleSnooze(item.conversation_id, days)}
                onAssignProject={(item, pid) => handleAssignProject(item.conversation_id, pid)}
                onCreateProject={(item, name) => handleCreateProjectFromCard(item, name)}
                onBulkSnooze={(days) => bulkApply(section.items.map((i) => i.conversation_id), "snooze", days)}
                onBulkDismiss={() => bulkApply(section.items.map((i) => i.conversation_id), "dismiss")}
              />
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes digestRowIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes skeletonPulse {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
