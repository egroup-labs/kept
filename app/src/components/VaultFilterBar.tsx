import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cmdKgGetProjects, cmdKgCreateProject, cmdKgLinkConversation, cmdSuggestProjectConversations, cmdKgGetTopics, cmdKgGetTopicGraph, isTauri, getConfig } from "../lib/tauri-api";
import type { ConversationRecommendation } from "../lib/types";

interface SubFilter {
  id: string;
  label: string;
  image?: string;
  gradient?: string;
  description?: string;
}

interface FilterDef {
  id: string;
  label: string;
  items?: SubFilter[];
  isSearch?: boolean;
}

const PROJECT_GRADIENTS = [
  "conic-gradient(from 220deg at 30% 70%, #0d2847 0%, #1a1040 25%, #0a2a3d 50%, #141832 75%, #0d2847 100%)",
  "conic-gradient(from 140deg at 65% 35%, #0a3028 0%, #0d2038 30%, #122e2a 60%, #0a2830 100%), radial-gradient(ellipse at 20% 80%, #163830 0%, transparent 60%)",
  "conic-gradient(from 30deg at 40% 55%, #1a1035 0%, #28103a 20%, #12082e 45%, #1e1540 70%, #1a1035 100%), radial-gradient(ellipse at 70% 30%, #2a1848 0%, transparent 55%)",
  "conic-gradient(from 310deg at 55% 60%, #082838 0%, #0d1e3a 30%, #0a2e40 55%, #101a30 80%, #082838 100%)",
  "conic-gradient(from 80deg at 45% 40%, #1e1810 0%, #2a1a0e 25%, #1a1612 50%, #221c10 75%, #1e1810 100%), radial-gradient(ellipse at 30% 70%, #2e200a 0%, transparent 50%)",
  "conic-gradient(from 180deg at 50% 50%, #0a1e2e 0%, #122838 25%, #0e1a2a 50%, #162e3a 75%, #0a1e2e 100%), radial-gradient(ellipse at 70% 25%, #1a3848 0%, transparent 50%)",
];

const STATIC_FILTERS: readonly FilterDef[] = [
  {
    id: "vendor",
    label: "Sources",
    items: [
      { id: "chatgpt", label: "ChatGPT", image: "/sources/chatgpt.webp" },
      { id: "claude", label: "Claude", image: "/sources/claude.webp" },
      { id: "gemini", label: "Gemini", image: "/sources/gemini.webp" },
      { id: "grok", label: "Grok", image: "/sources/grok.webp" },
      { id: "kimi", label: "Kimi", image: "/sources/kimi.webp" },
      { id: "ollama", label: "Ollama", image: "/sources/ollama.webp" },
      { id: "kept", label: "Kept", image: "/sources/kept-lock.webp" },
    ],
  },
  {
    id: "project",
    label: "Projects",
    items: [],
  },
  {
    id: "topic",
    label: "Topics",
    items: [],
  },
];

type FilterId = string;

// ── Shared sizing constants per mode ──
const NORMAL_RADIUS = 10;
const NORMAL_TILE_BASIS = 32;
const NORMAL_TILE_RADIUS = 6;

const COMPACT_TILE_BASIS = 28;
const COMPACT_TILE_RADIUS = 5;

function getFlexWeight(dist: number, hasSubmenu: boolean, isNormal: boolean): number {
  if (isNormal) {
    if (dist === 0) return hasSubmenu ? 10 : 3;
    if (dist === 1) return 2;
    if (dist === 2) return 1.6;
    return 1.3;
  }
  // compact
  if (dist === 0) return 3;
  if (dist === 1) return 2;
  if (dist === 2) return 1.6;
  return 1.3;
}

// ── Topic gradients (deterministic per index) ──
const TOPIC_GRADIENTS = [
  "conic-gradient(from 180deg at 50% 50%, #0a1e2e 0%, #122838 25%, #0e1a2a 50%, #162e3a 75%, #0a1e2e 100%), radial-gradient(ellipse at 70% 25%, #1a3848 0%, transparent 50%)",
  "conic-gradient(from 260deg at 35% 65%, #1a1420 0%, #241830 30%, #161024 55%, #1e1428 80%, #1a1420 100%)",
  "conic-gradient(from 90deg at 60% 45%, #0e2420 0%, #0a1e28 30%, #122a24 55%, #0c2028 80%, #0e2420 100%), radial-gradient(ellipse at 25% 75%, #183830 0%, transparent 55%)",
  "conic-gradient(from 340deg at 45% 55%, #201810 0%, #2a1e14 20%, #1c1410 45%, #241a12 70%, #201810 100%), radial-gradient(ellipse at 60% 30%, #302010 0%, transparent 50%)",
  "conic-gradient(from 150deg at 55% 40%, #1a0e18 0%, #280e20 25%, #1e0a1a 50%, #220e1e 75%, #1a0e18 100%), radial-gradient(ellipse at 35% 70%, #301828 0%, transparent 55%)",
  "conic-gradient(from 50deg at 40% 60%, #0c1830 0%, #141e3a 25%, #0e1428 50%, #161a34 75%, #0c1830 100%)",
  "conic-gradient(from 120deg at 50% 50%, #0d2520 0%, #0a2030 25%, #102a28 50%, #0c2432 75%, #0d2520 100%)",
  "conic-gradient(from 200deg at 60% 40%, #1e1018 0%, #2a1420 25%, #1c0c16 50%, #24101e 75%, #1e1018 100%)",
];

// ── Discover topics button ──
function DiscoverTile({ compact, onClick, discovering }: { compact?: boolean; onClick: () => void; discovering: boolean }) {
  const basis = compact ? COMPACT_TILE_BASIS : NORMAL_TILE_BASIS;
  const radius = compact ? COMPACT_TILE_RADIUS : NORMAL_TILE_RADIUS;
  return (
    <div
      onClick={discovering ? undefined : onClick}
      style={{
        position: "relative",
        flex: `1 0 ${basis}px`,
        borderRadius: radius,
        cursor: discovering ? "default" : "pointer",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "0 10px",
        background: discovering ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.06)",
        transition: "background 200ms ease-out",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { if (!discovering) (e.currentTarget as HTMLElement).style.background = "rgba(217, 119, 87, 0.14)"; }}
      onMouseLeave={(e) => { if (!discovering) (e.currentTarget as HTMLElement).style.background = "rgba(217, 119, 87, 0.06)"; }}
    >
      {discovering ? (
        <div style={{
          width: 12, height: 12,
          border: "1.5px solid rgba(217, 119, 87, 0.2)",
          borderTopColor: "rgba(217, 119, 87, 0.6)",
          borderRadius: "50%",
          animation: "spin 800ms linear infinite",
          flexShrink: 0,
        }} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="8" cy="8" r="6" stroke="rgba(217, 119, 87, 0.5)" strokeWidth="1.5" fill="none" />
          <path d="M8 5v3l2 1.5" stroke="rgba(217, 119, 87, 0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span style={{
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        color: "rgba(217, 119, 87, 0.6)",
        letterSpacing: "-0.01em",
      }}>
        {discovering ? "Discovering..." : "Discover"}
      </span>
    </div>
  );
}

// ── New project button ──
function NewProjectTile({ compact, onClick }: { compact?: boolean; onClick: () => void }) {
  const basis = compact ? COMPACT_TILE_BASIS : NORMAL_TILE_BASIS;
  const radius = compact ? COMPACT_TILE_RADIUS : NORMAL_TILE_RADIUS;
  return (
    <div
      onClick={onClick}
      style={{
        position: "relative",
        flex: `1 0 ${basis}px`,
        borderRadius: radius,
        cursor: "pointer",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "0 10px",
        background: "rgba(195, 236, 255, 0.06)",
        transition: "background 200ms ease-out",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(195, 236, 255, 0.12)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(195, 236, 255, 0.06)"; }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M8 3v10M3 8h10" stroke="rgba(195, 236, 255, 0.5)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span style={{
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        color: "rgba(195, 236, 255, 0.5)",
        letterSpacing: "-0.01em",
      }}>
        New
      </span>
    </div>
  );
}

// ── Submenu tile strip (shared by both modes) ──
function SubFilterTiles({ items, compact, onSelect, trailing }: {
  items: SubFilter[];
  compact?: boolean;
  onSelect?: (id: string, label: string, description?: string) => void;
  trailing?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tileCount = items.length;
  const basis = compact ? COMPACT_TILE_BASIS : NORMAL_TILE_BASIS;
  const radius = compact ? COMPACT_TILE_RADIUS : NORMAL_TILE_RADIUS;

  const applyParallax = (hoveredIdx: number) => {
    const el = containerRef.current;
    if (!el) return;
    for (let i = 0; i < tileCount; i++) {
      const tile = el.children[i] as HTMLElement;
      if (!tile) continue;
      const dist = Math.abs(i - hoveredIdx);
      const flex = dist === 0 ? 2.5 : dist === 1 ? 1.3 : 1;
      tile.style.flex = `${flex} 0 ${basis}px`;
      const img = tile.querySelector("img");
      const bg = tile.querySelector<HTMLElement>("[data-bg]");
      const label = tile.querySelector<HTMLElement>("[data-label]");
      if (dist === 0) {
        if (img) img.style.opacity = "0.7";
        if (bg) bg.style.opacity = "1";
        if (label) label.style.color = "rgba(195, 236, 255, 1)";
      } else {
        if (img) img.style.opacity = `${Math.max(0.3, 0.5 - dist * 0.05)}`;
        if (bg) bg.style.opacity = `${Math.max(0.6, 0.85 - dist * 0.08)}`;
        if (label) label.style.color = `rgba(195, 236, 255, ${Math.max(0.55, 0.9 - dist * 0.1)})`;
      }
    }
  };

  const resetParallax = () => {
    const el = containerRef.current;
    if (!el) return;
    for (let i = 0; i < tileCount; i++) {
      const tile = el.children[i] as HTMLElement;
      if (!tile) continue;
      tile.style.flex = `1 0 ${basis}px`;
      const img = tile.querySelector("img");
      const bg = tile.querySelector<HTMLElement>("[data-bg]");
      const label = tile.querySelector<HTMLElement>("[data-label]");
      if (img) img.style.opacity = "0.5";
      if (bg) bg.style.opacity = "0.85";
      if (label) label.style.color = "rgba(195, 236, 255, 0.9)";
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseLeave={resetParallax}
      style={{
        display: "flex",
        flexDirection: "row",
        gap: 3,
        flex: 1,
        minWidth: 0,
        height: compact ? undefined : "100%",
        padding: compact ? "3px 4px" : undefined,
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
      }}
    >
      {items.map((item, i) => (
        <div
          key={item.id}
          onMouseEnter={() => applyParallax(i)}
          onClick={() => onSelect?.(item.id, item.label, item.description)}
          style={{
            position: "relative",
            flex: `1 0 ${basis}px`,
            borderRadius: radius,
            cursor: "pointer",
            overflow: "hidden",
            transition: "flex 300ms cubic-bezier(0.25, 0.1, 0.25, 1)",
          }}
        >
          <div
            data-bg
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: radius,
              background: item.gradient || (compact ? "#1a2830" : "#141e24"),
              opacity: item.gradient ? 0.85 : 1,
              transition: "opacity 300ms ease-out",
            }}
          />
          {item.image && (
            <img
              src={item.image}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                borderRadius: radius,
                opacity: 0.5,
                transition: "opacity 300ms ease-out",
                willChange: "opacity",
                transform: "translateZ(0)",
              }}
            />
          )}
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: radius,
              background: "linear-gradient(to left, rgba(10, 18, 22, 0.9) 0%, rgba(10, 18, 22, 0.4) 50%, rgba(10, 18, 22, 0) 100%)",
            }}
          />
          <span
            data-label
            style={{
              position: "absolute",
              bottom: compact ? 4 : 6,
              left: compact ? 5 : 7,
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 11,
              fontWeight: 600,
              color: "rgba(195, 236, 255, 0.9)",
              letterSpacing: "-0.01em",
              lineHeight: 1,
              transition: "color 300ms ease-out",
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
          </span>
        </div>
      ))}
      {trailing}
    </div>
  );
}

// ── Search submenu (compact only) ──
function SearchSubmenu({
  value,
  onValueChange,
  onSearch,
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSearch?: (query: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flex: 1,
        padding: "0 12px",
        minWidth: 0,
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSearch?.(value.trim());
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        }}
        placeholder="Search conversations..."
        style={{
          background: "none",
          border: "none",
          outline: "none",
          color: "rgba(195, 236, 255, 0.8)",
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          width: "100%",
          minWidth: 0,
        }}
      />
    </div>
  );
}

// ── New project dialog (shared) ──
function NewProjectDialog({ onSubmit, onCancel }: { onSubmit: (name: string, description: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const handleSubmit = () => {
    if (name.trim()) onSubmit(name.trim(), description.trim());
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0b1115",
          border: "1px solid rgba(195, 236, 255, 0.08)",
          borderRadius: 12,
          padding: 24,
          width: 360,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 16,
          fontWeight: 600,
          color: "rgba(195, 236, 255, 0.9)",
          letterSpacing: "-0.02em",
        }}>
          New Project
        </span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onCancel(); }}
          placeholder="Project name"
          style={{
            background: "rgba(195, 236, 255, 0.05)",
            border: "1px solid rgba(195, 236, 255, 0.1)",
            borderRadius: 8,
            padding: "10px 12px",
            color: "rgba(195, 236, 255, 0.9)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 14,
            outline: "none",
          }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
          placeholder="Description (optional)"
          rows={3}
          style={{
            background: "rgba(195, 236, 255, 0.05)",
            border: "1px solid rgba(195, 236, 255, 0.1)",
            borderRadius: 8,
            padding: "10px 12px",
            color: "rgba(195, 236, 255, 0.9)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 14,
            outline: "none",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              background: "rgba(195, 236, 255, 0.06)",
              border: "none",
              borderRadius: 6,
              padding: "8px 16px",
              color: "rgba(195, 236, 255, 0.6)",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            style={{
              background: name.trim() ? "rgba(217, 119, 87, 0.8)" : "rgba(195, 236, 255, 0.06)",
              border: "none",
              borderRadius: 6,
              padding: "8px 16px",
              color: name.trim() ? "#fff" : "rgba(195, 236, 255, 0.3)",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 13,
              fontWeight: 600,
              cursor: name.trim() ? "pointer" : "default",
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Project suggestions panel ──
function ProjectSuggestionsPanel({
  project,
  onClose,
}: {
  project: { id: string; name: string; description: string };
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState<ConversationRecommendation[]>([]);
  const [summary, setSummary] = useState("");
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("Searching conversations...");

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    setLoading(true);

    if (isTauri) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        if (cancelled) return;
        listen<{ stage: string; tool_name?: string; iteration: number }>("suggest-progress", (event) => {
          if (cancelled) return;
          const { stage, tool_name } = event.payload;
          setProgress(prev => {
            if (stage === "tool_call") {
              if (tool_name === "list_conversations") return "Browsing all conversations in the vault...";
              if (tool_name === "search_conversations") return "Searching for relevant keywords...";
              if (tool_name === "read_conversation") return "Reading a conversation to check relevance...";
              if (tool_name === "recommend_conversation") return "Found a relevant conversation!";
              return `Running ${tool_name}...`;
            }
            if (stage === "thinking" && prev && !prev.startsWith("Searching conversations")) return prev;
            if (stage === "thinking") return "Analyzing project and planning search strategy...";
            return prev;
          });
        }).then((fn) => { unlisten = fn; });
      });
    }

    cmdSuggestProjectConversations(project.id, project.name, project.description)
      .then((resp) => {
        if (cancelled) return;
        setRecommendations(resp.recommendations);
        setSummary(resp.summary);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; unlisten?.(); };
  }, [project.id, project.name, project.description]);

  const handleLink = (rec: ConversationRecommendation) => {
    if (!rec.conversation_id) return;
    cmdKgLinkConversation(project.id, rec.conversation_id, "general").catch(() => {});
    setLinked((prev) => new Set(prev).add(rec.file_path));
  };

  const handleDismiss = (filePath: string) => {
    setDismissed((prev) => new Set(prev).add(filePath));
  };

  const visible = recommendations.filter(
    (r) => !dismissed.has(r.file_path)
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0b1115",
          border: "1px solid rgba(195, 236, 255, 0.08)",
          borderRadius: 12,
          padding: 24,
          width: 480,
          maxHeight: "min(80vh, 600px)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "hidden",
        }}
      >
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 16,
          fontWeight: 600,
          color: "rgba(195, 236, 255, 0.9)",
          letterSpacing: "-0.02em",
        }}>
          Suggested conversations for {project.name}
        </span>

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "24px 0" }}>
            <div style={{
              width: 20, height: 20,
              border: "2px solid rgba(195,236,255,0.15)",
              borderTopColor: "rgba(195,236,255,0.5)",
              borderRadius: "50%",
              animation: "spin 800ms linear infinite",
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: 13,
              color: "rgba(195, 236, 255, 0.5)",
              fontFamily: "'DM Sans', sans-serif",
              transition: "opacity 200ms ease",
            }}>
              {progress}
            </span>
          </div>
        ) : error ? (
          <p style={{ fontSize: 13, color: "#f87171", fontFamily: "'DM Sans', sans-serif" }}>
            {error}
          </p>
        ) : visible.length === 0 ? (
          <p style={{ fontSize: 13, color: "rgba(195, 236, 255, 0.4)", fontFamily: "'DM Sans', sans-serif", padding: "12px 0" }}>
            {recommendations.length === 0 ? "No relevant conversations found." : "All suggestions handled."}
          </p>
        ) : (
          <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
            {visible.map((rec) => {
              const isLinked = linked.has(rec.file_path);
              return (
                <div
                  key={rec.file_path}
                  style={{
                    background: isLinked ? "rgba(74,222,128,0.06)" : "rgba(195, 236, 255, 0.03)",
                    border: `1px solid ${isLinked ? "rgba(74,222,128,0.15)" : "rgba(195, 236, 255, 0.06)"}`,
                    borderRadius: 10,
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <span style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    color: "rgba(195, 236, 255, 0.9)",
                    letterSpacing: "-0.01em",
                  }}>
                    {rec.title}
                  </span>
                  <span style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 12,
                    color: "rgba(195, 236, 255, 0.4)",
                    lineHeight: 1.4,
                  }}>
                    {rec.reason}
                  </span>
                  {!isLinked && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <button
                        onClick={() => handleLink(rec)}
                        style={{
                          background: "rgba(195, 236, 255, 0.08)",
                          border: "1px solid rgba(195, 236, 255, 0.12)",
                          borderRadius: 6,
                          padding: "5px 14px",
                          cursor: "pointer",
                          color: "rgba(195, 236, 255, 0.8)",
                          fontSize: 12,
                          fontFamily: "'DM Sans', sans-serif",
                          fontWeight: 500,
                          transition: "background 200ms ease",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.14)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.08)"; }}
                      >
                        Add to project
                      </button>
                      <button
                        onClick={() => handleDismiss(rec.file_path)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: "5px 10px",
                          cursor: "pointer",
                          color: "rgba(195, 236, 255, 0.3)",
                          fontSize: 12,
                          fontFamily: "'DM Sans', sans-serif",
                          fontWeight: 500,
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {isLinked && (
                    <span style={{ fontSize: 12, color: "#4ade80", fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>
                      Added
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {summary && !loading && (
          <p style={{
            fontSize: 12,
            color: "rgba(195, 236, 255, 0.35)",
            fontFamily: "'DM Sans', sans-serif",
            lineHeight: 1.4,
            fontStyle: "italic",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {summary.split("\n")[0].replace(/[*_`#~\[\]]/g, "").slice(0, 120)}
          </p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{
            background: "transparent", border: "none", padding: "8px 16px",
            color: "rgba(195, 236, 255, 0.4)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500,
            cursor: "pointer", transition: "color 200ms ease",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.7)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
          >
            Cancel
          </button>
          {visible.length > 0 && !loading && (
            <button onClick={() => {
              for (const rec of visible.filter(r => !linked.has(r.file_path))) handleLink(rec);
            }} style={{
              background: "rgba(195, 236, 255, 0.08)", border: "1px solid rgba(195, 236, 255, 0.12)", borderRadius: 6, padding: "8px 20px",
              color: "rgba(195, 236, 255, 0.8)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500,
              cursor: "pointer", transition: "background 200ms ease",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.14)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.08)"; }}
            >
              Add all
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared hook for filter state + project/topic loading ──
function useFilterState(presentSources?: Set<string>) {
  const [activeId, setActiveId] = useState<FilterId | null>("vendor");
  const [hoveredId, setHoveredId] = useState<FilterId | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const [projectItems, setProjectItems] = useState<SubFilter[]>([]);
  const [topicItems, setTopicItems] = useState<SubFilter[]>([]);
  const [showNewProject, setShowNewProject] = useState(false);
  const [suggestionsProject, setSuggestionsProject] = useState<{ id: string; name: string; description: string } | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const loadProjects = useCallback(() => {
    cmdKgGetProjects().then((projects) => {
      setProjectItems(
        projects.map((p, i) => ({
          id: p.id,
          label: p.name,
          description: p.description,
          gradient: PROJECT_GRADIENTS[i % PROJECT_GRADIENTS.length],
        }))
      );
    }).catch(() => {});
  }, []);

  const loadTopics = useCallback(() => {
    cmdKgGetTopics().then((topics) => {
      setTopicItems(
        topics.map((t, i) => ({
          id: t.id,
          label: t.name,
          description: t.description,
          gradient: TOPIC_GRADIENTS[i % TOPIC_GRADIENTS.length],
        }))
      );
    }).catch(() => {});
  }, []);

  const handleDiscover = useCallback(async () => {
    if (discovering) return;
    setDiscovering(true);

    try {
      const config = await getConfig();
      const assignments = config.model_assignments;
      const agentic = assignments?.agentic?.[0];
      if (!agentic) {
        console.warn("[Kept] No agentic model configured — cannot discover topics. Configure one in Settings → Model Assignments.");
        setDiscovering(false);
        return;
      }
      await cmdKgGetTopicGraph(agentic.provider, agentic.model);
      loadTopics();
    } catch (err) {
      console.error("[Kept] Topic discovery failed:", err);
    } finally {
      setDiscovering(false);
    }
  }, [discovering, loadTopics]);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { loadTopics(); }, [loadTopics]);

  const filters: FilterDef[] = STATIC_FILTERS.map((f) => {
    if (f.id === "project") return { ...f, items: projectItems };
    if (f.id === "topic") return { ...f, items: topicItems };
    if (f.id === "vendor" && presentSources) {
      return { ...f, items: f.items?.filter((item) => presentSources.has(item.id)) };
    }
    return { ...f, items: f.items ? [...f.items] : undefined };
  });

  const activeIdx = activeId ? filters.findIndex(f => f.id === activeId) : -1;
  const activeFilter = activeId ? filters.find(f => f.id === activeId) : null;
  const isProjectFilter = activeFilter?.id === "project";
  const isTopicFilter = activeFilter?.id === "topic";

  const handleHoverEnter = (id: FilterId) => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHoveredId(id);
  };

  const handleHoverLeave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHoveredId(null), 300);
  };

  return {
    activeId, setActiveId,
    hoveredId,
    filters,
    activeIdx, activeFilter, isProjectFilter, isTopicFilter,
    showNewProject, setShowNewProject,
    suggestionsProject, setSuggestionsProject,
    loadProjects, loadTopics,
    discovering, handleDiscover,
    topicItems,
    handleHoverEnter, handleHoverLeave,
  };
}

// ── Public props (superset of both modes) ──
interface VaultFilterBarProps {
  visible?: boolean;
  compact?: boolean;
  projectRefreshKey?: number;
  /** Platforms that currently have conversations — hides Source tiles with no matches. */
  presentSources?: Set<string>;
  onFilterChange?: (filterId: FilterId) => void;
  onSubFilterSelect?: (category: string, subFilterId: string, label: string, description?: string) => void;
  onSearch?: (query: string) => void;
  onChange?: (query: string) => void;
  onSubmenuChange?: (open: boolean) => void;
  backButton?: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════════
// Normal (tall) layout — submenu tiles inline inside the button
// ═══════════════════════════════════════════════════════════════
function NormalLayout({ visible, projectRefreshKey, presentSources, onFilterChange, onSubFilterSelect }: VaultFilterBarProps) {
  const {
    activeId, setActiveId, hoveredId,
    filters, activeIdx, activeFilter, isProjectFilter, isTopicFilter,
    showNewProject, setShowNewProject,
    suggestionsProject, setSuggestionsProject,
    loadProjects,
    discovering, handleDiscover,
    topicItems,
    handleHoverEnter, handleHoverLeave,
  } = useFilterState(presentSources);

  useEffect(() => { if (projectRefreshKey) loadProjects(); }, [projectRefreshKey, loadProjects]);

  const hasSubmenu = !!(activeFilter?.items && (activeFilter.items.length > 0 || isProjectFilter || isTopicFilter));

  const handleClick = (id: FilterId) => {
    const newId = activeId === id ? null : id;
    setActiveId(newId);
    onFilterChange?.(newId ?? "");
  };

  const barHeight = hasSubmenu ? 80 : 52;

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 900,
        margin: "0 auto",
        height: barHeight,
        boxSizing: "border-box",
        padding: 4,
        borderRadius: NORMAL_RADIUS + 2,
        background: "rgb(2, 10, 13)",
        border: "1px solid rgba(195, 236, 255, 0.08)",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "height 400ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity 400ms cubic-bezier(0.25,0.1,0.25,1), transform 400ms cubic-bezier(0.25,0.1,0.25,1)",
      }}
    >
      <div style={{ display: "flex", gap: 4, height: "100%" }}>
        {filters.map((filter, i) => {
          const isActive = filter.id === activeId;
          const isHovered = filter.id === hoveredId;
          const dist = activeIdx >= 0 ? Math.abs(i - activeIdx) : -1;
          let flex = activeIdx >= 0 ? getFlexWeight(dist, isActive && hasSubmenu, true) : 1;

          const hoveredIdx = hoveredId ? filters.findIndex(f => f.id === hoveredId) : -1;
          if (hoveredIdx >= 0 && hoveredIdx !== activeIdx) {
            const hoverDist = Math.abs(i - hoveredIdx);
            if (hoverDist === 0) flex += 1;
            else if (hoverDist === 1) flex += 0.3;
          }

          const labelAlpha = isActive ? 0.9 : activeIdx < 0 ? 0.5 : dist <= 1 ? 0.55 : dist <= 2 ? 0.35 : 0.25;
          const hoverAlpha = isHovered && !isActive ? 0.15 : 0;
          const showTiles = isActive && hasSubmenu && !!activeFilter.items;

          return (
            <button
              key={filter.id}
              onClick={() => handleClick(filter.id)}
              onMouseEnter={() => handleHoverEnter(filter.id)}
              onMouseLeave={handleHoverLeave}
              style={{
                flex: `${flex} ${flex} 0%`,
                minWidth: 0,
                height: "100%",
                borderRadius: NORMAL_RADIUS,
                border: "none",
                background: isActive
                  ? (showTiles ? "rgba(195, 236, 255, 0.08)" : "rgba(195, 236, 255, 0.14)")
                  : `rgba(195, 236, 255, ${(activeIdx < 0 ? 0.07 : dist <= 1 ? 0.08 : dist <= 2 ? 0.06 : 0.04) + hoverAlpha})`,
                cursor: "pointer",
                padding: showTiles ? 5 : "0 12px",
                display: "flex",
                alignItems: showTiles ? "stretch" : "center",
                justifyContent: showTiles ? "flex-start" : "center",
                gap: showTiles ? 4 : 0,
                overflow: "hidden",
                transition: "flex 400ms cubic-bezier(0.25, 0.1, 0.25, 1), background 300ms ease-out, padding 400ms cubic-bezier(0.25, 0.1, 0.25, 1), gap 400ms cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
            >
              {showTiles ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 10px",
                    borderRadius: NORMAL_TILE_RADIUS,
                    background: "rgba(195, 236, 255, 0.05)",
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "rgba(195, 236, 255, 0.45)",
                      letterSpacing: "-0.01em",
                      whiteSpace: "nowrap",
                      lineHeight: 1,
                    }}
                  >
                    {filter.label}
                  </span>
                </div>
              ) : (
                <span
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: isActive ? 17 : 15,
                    fontWeight: isActive ? 600 : 500,
                    color: `rgba(195, 236, 255, ${labelAlpha + hoverAlpha})`,
                    letterSpacing: "-0.02em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    lineHeight: 1,
                    flexShrink: 0,
                    transition: "color 300ms ease-out, font-size 400ms cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                >
                  {filter.label}
                </span>
              )}

              {showTiles && (
                <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, minWidth: 0, height: "100%" }}>
                  <SubFilterTiles
                    items={activeFilter.items!}
                    onSelect={(id, label, desc) => onSubFilterSelect?.(filter.id, id, label, desc)}
                    trailing={filter.id === "project" ? <NewProjectTile onClick={() => setShowNewProject(true)} /> : filter.id === "topic" && topicItems.length === 0 ? <DiscoverTile onClick={handleDiscover} discovering={discovering} /> : undefined}
                  />
                </div>
              )}
            </button>
          );
        })}
      </div>
      {showNewProject && createPortal(
        <NewProjectDialog
          onCancel={() => setShowNewProject(false)}
          onSubmit={(name, description) => {
            setShowNewProject(false);
            cmdKgCreateProject(name, description).then((project) => {
              loadProjects();
              setSuggestionsProject({ id: project.id, name: project.name, description: project.description });
            }).catch(() => {});
          }}
        />,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {suggestionsProject && createPortal(
        <ProjectSuggestionsPanel
          project={suggestionsProject}
          onClose={() => setSuggestionsProject(null)}
        />,
        document.getElementById("kept-app-container") ?? document.body,
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Compact layout — submenu floats above as a separate panel
// ═══════════════════════════════════════════════════════════════
function CompactLayout({ visible, projectRefreshKey, presentSources, onFilterChange, onSubFilterSelect, onSearch, onChange, onSubmenuChange, backButton }: VaultFilterBarProps) {
  const {
    activeId, setActiveId, hoveredId,
    filters, activeIdx, activeFilter, isProjectFilter, isTopicFilter,
    showNewProject, setShowNewProject,
    suggestionsProject, setSuggestionsProject,
    loadProjects,
    discovering, handleDiscover,
    topicItems,
    handleHoverEnter, handleHoverLeave,
  } = useFilterState(presentSources);

  useEffect(() => { if (projectRefreshKey) loadProjects(); }, [projectRefreshKey, loadProjects]);

  const [searchValue, setSearchValue] = useState("");
  const hasSubmenu = !!(activeFilter && (activeFilter.items?.length || activeFilter.isSearch || isProjectFilter || isTopicFilter));

  // Track the last active filter to keep submenu content during exit animation
  const [renderedId, setRenderedId] = useState<FilterId | null>("vendor");
  const [submenuVisible, setSubmenuVisible] = useState(true);
  const swapTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (swapTimer.current) { clearTimeout(swapTimer.current); swapTimer.current = null; }

    if (hasSubmenu) {
      if (renderedId && renderedId !== activeId) {
        setSubmenuVisible(false);
        swapTimer.current = setTimeout(() => {
          setRenderedId(activeId);
          requestAnimationFrame(() => setSubmenuVisible(true));
        }, 200);
      } else {
        setRenderedId(activeId);
        requestAnimationFrame(() => setSubmenuVisible(true));
      }
    } else {
      setSubmenuVisible(false);
      const t = setTimeout(() => setRenderedId(null), 350);
      return () => clearTimeout(t);
    }
  }, [hasSubmenu, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderedFilter = renderedId ? filters.find(f => f.id === renderedId) : null;
  const showSubmenu = renderedFilter && (renderedFilter.items?.length || renderedFilter.isSearch || renderedFilter.id === "project" || renderedFilter.id === "topic");

  const handleClick = (id: FilterId) => {
    const newId = activeId === id ? null : id;
    setActiveId(newId);
    onFilterChange?.(newId ?? "");
  };

  useEffect(() => {
    onSubmenuChange?.(hasSubmenu);
  }, [hasSubmenu, onSubmenuChange]);

  return (
    <div
      style={{
        width: "100%",
        position: "relative",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 400ms cubic-bezier(0.25,0.1,0.25,1), transform 400ms cubic-bezier(0.25,0.1,0.25,1)",
      }}
    >
      {/* Main row: back button + filter pills */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 48, background: "#020A0D", borderRadius: 8, position: "relative", zIndex: 1 }}>
        {backButton}

        {filters.map((filter, i) => {
          const isActive = activeId !== null && filter.id === activeId;
          const isHovered = filter.id === hoveredId;
          const dist = activeIdx >= 0 ? Math.abs(i - activeIdx) : -1;

          const hoveredIdx = hoveredId ? filters.findIndex(f => f.id === hoveredId) : -1;
          let flex = dist >= 0 ? getFlexWeight(dist, false, false) : 1;
          if (hoveredIdx >= 0 && hoveredIdx !== activeIdx) {
            const hoverDist = Math.abs(i - hoveredIdx);
            if (hoverDist === 0) flex += 1;
            else if (hoverDist === 1) flex += 0.3;
          }

          const labelAlpha = isActive ? 0.9 : activeIdx < 0 ? 0.5 : dist <= 1 ? 0.5 : 0.3;
          const hoverAlpha = isHovered && !isActive ? 0.15 : 0;

          return (
            <button
              key={filter.id}
              onClick={() => handleClick(filter.id)}
              onMouseEnter={() => handleHoverEnter(filter.id)}
              onMouseLeave={handleHoverLeave}
              style={{
                flex: `${flex} ${flex} 0%`,
                minWidth: 0,
                height: 48,
                borderRadius: 8,
                border: "none",
                background: isActive
                  ? "rgba(195, 236, 255, 0.14)"
                  : `rgba(195, 236, 255, ${(activeIdx < 0 ? 0.07 : dist <= 1 ? 0.08 : 0.05) + hoverAlpha})`,
                cursor: "pointer",
                padding: "0 8px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                overflow: "hidden",
                transition: "flex 400ms cubic-bezier(0.25, 0.1, 0.25, 1), background 300ms ease-out",
              }}
            >
              {filter.isSearch && (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: isActive ? 0.6 : 0.3, transition: "opacity 300ms ease-out" }}>
                  <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              <span
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: isActive ? 17 : 15,
                  fontWeight: isActive ? 600 : 500,
                  color: `rgba(195, 236, 255, ${labelAlpha + hoverAlpha})`,
                  letterSpacing: "-0.02em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  transition: "color 300ms ease-out",
                }}
              >
                {filter.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Submenu — animated in/out */}
      {showSubmenu && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            right: 0,
            height: 56,
            borderRadius: 8,
            background: "rgb(11, 17, 21)",
            border: "1px solid rgba(195, 236, 255, 0.04)",
            display: "flex",
            overflow: "hidden",
            opacity: submenuVisible ? 1 : 0,
            transform: submenuVisible ? "translateY(0) scale(1)" : "translateY(8px) scale(0.97)",
            transition: "opacity 300ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1)",
          }}
        >
          {renderedFilter.isSearch ? (
            <SearchSubmenu
              value={searchValue}
              onValueChange={(v) => { setSearchValue(v); onChange?.(v); }}
              onSearch={onSearch}
            />
          ) : renderedFilter.items ? (
            <SubFilterTiles
              items={renderedFilter.items}
              compact
              onSelect={(id, label, desc) => onSubFilterSelect?.(renderedFilter.id, id, label, desc)}
              trailing={renderedFilter.id === "project" ? <NewProjectTile compact onClick={() => setShowNewProject(true)} /> : renderedFilter.id === "topic" && topicItems.length === 0 ? <DiscoverTile compact onClick={handleDiscover} discovering={discovering} /> : undefined}
            />
          ) : null}
        </div>
      )}
      {showNewProject && createPortal(
        <NewProjectDialog
          onCancel={() => setShowNewProject(false)}
          onSubmit={(name, description) => {
            setShowNewProject(false);
            cmdKgCreateProject(name, description).then((project) => {
              loadProjects();
              setSuggestionsProject({ id: project.id, name: project.name, description: project.description });
            }).catch(() => {});
          }}
        />,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {suggestionsProject && createPortal(
        <ProjectSuggestionsPanel
          project={suggestionsProject}
          onClose={() => setSuggestionsProject(null)}
        />,
        document.getElementById("kept-app-container") ?? document.body,
      )}
    </div>
  );
}

// ── Default export — switches between layouts based on `compact` prop ──
export default function VaultFilterBar(props: VaultFilterBarProps) {
  return props.compact ? <CompactLayout {...props} /> : <NormalLayout {...props} />;
}
