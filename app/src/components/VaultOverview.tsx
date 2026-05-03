import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationMeta, ConversationRecommendation } from "../lib/types";
import { cmdKgLinkConversation, cmdKgUnlinkConversation, cmdKgUpdateProject, cmdKgDeleteProject, cmdSuggestProjectConversations, isTauri, listConversations as apiListConversations, search as apiSearch } from "../lib/tauri-api";

function progressMessage(stage: string, toolName?: string, prev?: string): string {
  if (stage === "tool_call") {
    if (toolName === "list_conversations") return "Browsing all conversations in the vault...";
    if (toolName === "search_conversations") return "Searching for relevant keywords...";
    if (toolName === "read_conversation") return "Reading a conversation to check relevance...";
    if (toolName === "recommend_conversation") return "Found a relevant conversation!";
    return `Running ${toolName}...`;
  }
  // Don't overwrite a descriptive tool message with generic "thinking"
  if (stage === "thinking" && prev && !prev.startsWith("Searching conversations")) return prev;
  if (stage === "thinking") return "Analyzing project and planning search strategy...";
  if (stage === "tool_result") return prev ?? "Processing results...";
  return prev ?? "Working...";
}

const PLATFORM_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  kimi: "Kimi",
  ollama: "Ollama",
  kept: "Kept",
};

export interface VaultColumn {
  label: string;
  items: ConversationMeta[];
  description?: string;
  projectId?: string;
}

interface VaultOverviewProps {
  conversations: ConversationMeta[];
  onSelect: (path: string) => void;
  onShowAll?: (column: VaultColumn) => void;
  searchQuery?: string;
  compact?: boolean;
  visible?: boolean;
}

function scoreConversation(conv: ConversationMeta, terms: string[]): number {
  let score = 0;
  const title = (conv.title || "").toLowerCase();
  const preview = (conv.preview || "").toLowerCase();
  const platform = (conv.platform || "").toLowerCase();
  const platformLabel = (PLATFORM_NAMES[conv.platform] || conv.platform || "").toLowerCase();
  const model = (conv.model || "").toLowerCase();

  for (const term of terms) {
    // Title: highest priority
    if (title === term) score += 100;
    else if (title.startsWith(term)) score += 60;
    else if (title.includes(term)) score += 40;

    // Preview/description
    if (preview.includes(term)) score += 15;

    // Platform (id or display name)
    if (platform === term || platformLabel === term) score += 25;
    else if (platform.includes(term) || platformLabel.includes(term)) score += 12;

    // Model
    if (model.includes(term)) score += 10;
  }

  return score;
}

function searchConversations(conversations: ConversationMeta[], query: string): ConversationMeta[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored = conversations
    .map(conv => ({ conv, score: scoreConversation(conv, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(({ conv }) => conv);
}

interface Column {
  id: string;
  label: string;
  items: ConversationMeta[];
}

const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 8;
// Fallback height estimates (px) used before DOM measurement
const FALLBACK_ITEM_H = 58;
const FALLBACK_HEADER_H = 62;
const FALLBACK_SHOWALL_H = 42;

function buildColumns(conversations: ConversationMeta[]): Column[] {
  if (conversations.length === 0) return [];

  const byDate = [...conversations].sort(
    (a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime()
  );

  const byMessages = [...conversations].sort((a, b) => b.message_count - a.message_count);

  const platformMap = new Map<string, ConversationMeta[]>();
  for (const c of byDate) {
    const key = c.platform || "unknown";
    if (!platformMap.has(key)) platformMap.set(key, []);
    platformMap.get(key)!.push(c);
  }
  const platforms = [...platformMap.entries()].sort((a, b) => b[1].length - a[1].length);

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const thisWeek = byDate.filter(c => new Date(c.updated_at || c.indexed_at).getTime() > weekAgo);
  const older = byDate.filter(c => new Date(c.updated_at || c.indexed_at).getTime() < monthAgo);

  const columns: Column[] = [
    { id: "recent", label: "Recent", items: byDate },
    { id: "longest", label: "Most Messages", items: byMessages },
  ];

  for (const [platform, items] of platforms.slice(0, 2)) {
    const name = PLATFORM_NAMES[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
    columns.push({ id: `platform-${platform}`, label: name, items });
  }

  if (thisWeek.length > 5) {
    columns.push({ id: "this-week", label: "This Week", items: thisWeek });
  }

  if (older.length > 0) {
    columns.push({ id: "older", label: "Older", items: older });
  }

  return columns.slice(0, 5);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ConversationItem({ conv, onSelect, onRemove }: { conv: ConversationMeta; onSelect: (path: string) => void; onRemove?: () => void }) {
  const platform = PLATFORM_NAMES[conv.platform] || conv.platform.charAt(0).toUpperCase() + conv.platform.slice(1);
  const date = formatDate(conv.updated_at || conv.created_at);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      data-col-item
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={() => onSelect(conv.file_path)}
        style={{
          background: "none",
          border: "none",
          padding: "5px 0",
          cursor: "pointer",
          textAlign: "left",
          flex: 1,
          minWidth: 0,
          color: hovered ? "rgba(195, 236, 255, 0.9)" : "rgba(195, 236, 255, 0.5)",
          transition: "color 200ms ease",
        }}
      >
        <div
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 15,
            fontWeight: 400,
            letterSpacing: "-0.02em",
            lineHeight: "1.35",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as const,
            overflow: "hidden",
          }}
        >
          {conv.title || "Untitled"}
        </div>
        <div
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 14,
            fontWeight: 400,
            color: "rgba(195, 236, 255, 0.25)",
            letterSpacing: "0.01em",
            marginTop: 3,
            transition: "color 200ms ease",
          }}
        >
          {platform}{conv.message_count > 0 ? ` · ${conv.message_count} msgs` : ""}{date ? ` · ${date}` : ""}
        </div>
      </button>
      {onRemove && (
        <button
          title="Remove from project"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "6px 2px",
            flexShrink: 0,
            opacity: hovered ? 0.5 : 0,
            transition: "opacity 200ms ease",
            color: "rgba(195, 236, 255, 0.6)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "#f87171"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = hovered ? "0.5" : "0"; e.currentTarget.style.color = "rgba(195, 236, 255, 0.6)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ShowAllButton({ delay, onClick }: { delay: number; onClick: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={{
      opacity: mounted ? 1 : 0,
      transform: mounted ? "translateY(0)" : "translateY(6px)",
      transition: `opacity 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms, transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms`,
    }}>
      <button
        data-col-showall
        onClick={onClick}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "10px 0 4px",
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 17,
          fontWeight: 500,
          color: "rgba(195, 236, 255, 0.75)",
          textAlign: "left",
          letterSpacing: "-0.02em",
          transition: "color 200ms ease, letter-spacing 300ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "rgba(195, 236, 255, 1)";
          e.currentTarget.style.letterSpacing = "0.01em";
          const chev = e.currentTarget.querySelector<HTMLElement>("[data-chev]");
          if (chev) chev.style.color = "rgba(195, 236, 255, 0.8)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "rgba(195, 236, 255, 0.75)";
          e.currentTarget.style.letterSpacing = "-0.02em";
          const chev = e.currentTarget.querySelector<HTMLElement>("[data-chev]");
          if (chev) chev.style.color = "rgba(195, 236, 255, 0.15)";
        }}
      >
        Show all
        <span data-chev style={{ marginLeft: 10, fontSize: 28, position: "relative", top: 3, color: "rgba(195, 236, 255, 0.15)", transition: "color 300ms ease" }}>›</span>
      </button>
    </div>
  );
}

function ColumnView({ column, colIndex, appeared, onSelect, onShowAll, pageSize }: { column: Column; colIndex: number; appeared: boolean; onSelect: (path: string) => void; onShowAll?: (column: VaultColumn) => void; pageSize: number }) {
  const shown = column.items.slice(0, pageSize);
  const hasMore = column.items.length > pageSize;
  const colDelay = colIndex * 60;

  const stagger = (rowIndex: number) => ({
    opacity: appeared ? 1 : 0,
    transform: appeared ? "translateY(0)" : "translateY(6px)",
    transition: `opacity 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${colDelay + rowIndex * 30}ms, transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${colDelay + rowIndex * 30}ms`,
  });

  return (
    <div data-col style={{ display: "flex", flexDirection: "column", minWidth: 0, breakInside: "avoid" as const, marginBottom: 48 }}>
      <div
        data-col-header
        style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 20,
          fontWeight: 500,
          color: "rgba(195, 236, 255, 0.7)",
          letterSpacing: "-0.04em",
          lineHeight: 1.2,
          padding: "0 0 10px",
          ...stagger(0),
        }}
      >
        {column.label}
        <div style={{ fontSize: 16, fontWeight: 400, color: "rgba(195, 236, 255, 0.25)", letterSpacing: "0.02em", marginTop: 6 }}>
          {column.items.length} items
        </div>
      </div>
      {shown.map((conv, ri) => (
        <div key={conv.id} style={stagger(ri + 1)}>
          <ConversationItem conv={conv} onSelect={onSelect} />
        </div>
      ))}
      {hasMore && (
        <ShowAllButton delay={colDelay + (shown.length + 1) * 30} onClick={() => onShowAll?.(column)} />
      )}
    </div>
  );
}

export default function VaultOverview({ conversations, onSelect, onShowAll, searchQuery = "", compact = false, visible = true }: VaultOverviewProps) {
  const allColumns = useMemo(() => buildColumns(conversations), [conversations]);
  const searchResults = useMemo(() => searchConversations(conversations, searchQuery), [conversations, searchQuery]);
  const isSearching = searchQuery.trim().length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const [appeared, setAppeared] = useState(false);
  const [searchAppeared, setSearchAppeared] = useState(false);
  const [visibleColCount, setVisibleColCount] = useState(4);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [topPad, setTopPad] = useState(36);
  const [needsScroll, setNeedsScroll] = useState(false);

  // Track how many columns fit based on full available width (scrollRef), not the constrained grid
  // Also compute dynamic page size by measuring actual rendered DOM elements
  useEffect(() => {
    const scroll = scrollRef.current;
    const grid = gridRef.current;
    if (!scroll || !grid) return;
    const update = () => {
      const gap = 28;
      const minCol = 160;
      const pad = compact ? 24 * 2 : 48 * 2;
      const w = scroll.clientWidth - pad;
      const count = Math.max(3, Math.floor((w + gap) / (minCol + gap)));
      setVisibleColCount(Math.min(count, 5, Math.max(1, allColumns.length)));

      // Top padding: just enough to clear the floating search bar
      const computedTopPad = compact ? 12 : 24;
      setTopPad(computedTopPad);

      // Measure actual element heights from the first rendered column
      const firstCol = grid.querySelector<HTMLElement>("[data-col]");
      const headerEl = firstCol?.querySelector<HTMLElement>("[data-col-header]");
      const itemEl = firstCol?.querySelector<HTMLElement>("[data-col-item]");
      const showAllEl = firstCol?.querySelector<HTMLElement>("[data-col-showall]");

      const headerH = headerEl?.offsetHeight ?? FALLBACK_HEADER_H;
      const itemH = itemEl?.offsetHeight ?? FALLBACK_ITEM_H;
      const showAllH = showAllEl?.offsetHeight ?? FALLBACK_SHOWALL_H;
      const colMargin = 48; // marginBottom on the column div

      // Available height = container minus top padding and the column's fixed chrome
      const scrollRect = scroll.getBoundingClientRect();
      const gridTop = grid.getBoundingClientRect().top - scrollRect.top + scroll.scrollTop;
      // Bottom reserve for filter bar + fade overlay (both absolutely positioned over this container).
      // Non-compact: filter bar up to 80px + 32px bottom offset + fade overlay.
      // Compact: filter bar 48px + 32px bottom offset + fade overlay.
      const bottomReserve = compact ? 140 : 180;

      const availableH = scroll.clientHeight - gridTop - bottomReserve;
      const itemSpace = availableH - headerH - showAllH - colMargin;
      // Use 1.15x item height to account for variable heights (2-line titles)
      const safeItemH = itemH > 0 ? itemH * 1.15 : FALLBACK_ITEM_H;
      const computed = Math.min(MAX_PAGE_SIZE, Math.max(3, Math.floor(itemSpace / safeItemH)));
      setPageSize(computed);

      // Check if grid content overflows the container
      const contentHeight = grid.offsetHeight + gridTop;
      setNeedsScroll(contentHeight > scroll.clientHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [compact, allColumns.length]);

  const columns = allColumns.slice(0, visibleColCount);

  // Staggered entrance: reset to hidden when leaving tab (invisible, no flash),
  // then animate in when becoming visible again.
  // rAF inside rAF guarantees the browser has painted the hidden state first.
  useEffect(() => {
    if (visible) {
      setAppeared(false);
      let raf2: number;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setAppeared(true));
      });
      return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    } else {
      setAppeared(false);
    }
  }, [visible]);

  // Reset search stagger when query changes
  useEffect(() => {
    if (isSearching) {
      setSearchAppeared(false);
      const raf = requestAnimationFrame(() => setSearchAppeared(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFadeTop(el.scrollTop > 8);
    setFadeBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);

  // Search results: distribute into columns
  const searchColumns: ConversationMeta[][] = useMemo(() => {
    if (!isSearching) return [];
    const cols: ConversationMeta[][] = Array.from({ length: visibleColCount }, () => []);
    searchResults.forEach((item, i) => cols[i % visibleColCount].push(item));
    return cols;
  }, [isSearching, searchResults, visibleColCount]);

  if (conversations.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center h-full">
        <span
          style={{
            color: "rgba(195, 236, 255, 0.25)",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 16,
            fontWeight: 500,
            letterSpacing: "-0.02em",
          }}
        >
          No conversations yet
        </span>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex flex-col h-full w-full overflow-y-auto scrollbar-none"
      onScroll={checkScroll}
      style={{
        padding: needsScroll ? `${topPad}px 0 100px` : `${topPad}px 0 0`,
        maskImage:
          !fadeTop && !fadeBottom
            ? "none"
            : `linear-gradient(to bottom, ${fadeTop ? "transparent" : "black"} 0px, black ${fadeTop ? "60px" : "0px"}, black calc(100% - ${fadeBottom ? "60px" : "0px"}), ${fadeBottom ? "transparent" : "black"} 100%)`,
      }}
    >
      <div style={{
        width: "100%",
        maxWidth: visibleColCount * 220 + (visibleColCount - 1) * 28,
        margin: "0 auto",
        padding: compact ? "0 24px" : "0 48px",
      }}>
        {/* Normal column grid */}
        <div
          ref={gridRef}
          style={{
            display: isSearching ? "none" : "grid",
            gridTemplateColumns: `repeat(${visibleColCount}, 1fr)`,
            gap: 28,
            alignItems: "start",
          }}
        >
          {columns.map((column, ci) => (
            <ColumnView key={column.id} column={column} colIndex={ci} appeared={appeared} onSelect={onSelect} onShowAll={onShowAll} pageSize={pageSize} />
          ))}
        </div>

        {/* Search results */}
        {isSearching && (
          <div>
            <div style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 14,
              fontWeight: 400,
              color: "rgba(195, 236, 255, 0.25)",
              letterSpacing: "-0.01em",
              marginBottom: 20,
              opacity: searchAppeared ? 1 : 0,
              transition: "opacity 300ms ease",
            }}>
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
            </div>
            {searchResults.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${visibleColCount}, minmax(0, 1fr))`,
                  gap: 28,
                  alignItems: "start",
                }}
              >
                {searchColumns.map((items, ci) => (
                  <div key={ci} style={{ display: "flex", flexDirection: "column" }}>
                    {items.map((conv, ri) => {
                      const delay = ri * 30 + ci * 50;
                      return (
                        <div
                          key={conv.id}
                          style={{
                            opacity: searchAppeared ? 1 : 0,
                            transform: searchAppeared ? "translateY(0)" : "translateY(6px)",
                            transition: `opacity 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms, transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms`,
                          }}
                        >
                          <ConversationItem conv={conv} onSelect={onSelect} />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 15,
                fontWeight: 400,
                color: "rgba(195, 236, 255, 0.2)",
                letterSpacing: "-0.02em",
                padding: "40px 0",
                opacity: searchAppeared ? 1 : 0,
                transition: "opacity 400ms ease",
              }}>
                No conversations match your search
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const INITIAL_ROWS = 50;

export function VaultColumnExpanded({ column, onSelect, onRefresh, onBack, onStartSuggestion, compact = false }: { column: VaultColumn; onSelect: (path: string) => void; onRefresh?: () => void; onBack?: () => void; onStartSuggestion?: (projectId: string, name: string, description: string) => void; compact?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const [colCount, setColCount] = useState(4);
  const [appeared, setAppeared] = useState(false);
  const [loadedRows, setLoadedRows] = useState(INITIAL_ROWS);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(column.label);
  const [editDesc, setEditDesc] = useState(column.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  // Filter the column's conversations by title using the same scoring/match
  // routine the global vault search uses, so behavior matches expectations.
  const displayItems = useMemo(() => {
    return filterQuery.trim()
      ? searchConversations(column.items, filterQuery)
      : column.items;
  }, [column.items, filterQuery]);

  // Reset the lazy-load window when the filter narrows the list — otherwise
  // a previously-scrolled position stays even if displayItems is short now.
  useEffect(() => {
    setLoadedRows(INITIAL_ROWS);
  }, [filterQuery]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const gap = 28;
      const minCol = 160;
      const pad = compact ? 24 * 2 : 48 * 2;
      const w = el.clientWidth - pad;
      setColCount(Math.max(2, Math.min(5, Math.floor((w + gap) / (minCol + gap)))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [compact]);

  // Trigger staggered entrance animation
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAppeared(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Lazy load more rows when sentinel enters viewport
  const totalRows = Math.ceil(displayItems.length / colCount);
  useEffect(() => {
    if (loadedRows >= totalRows) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setLoadedRows(prev => Math.min(prev + INITIAL_ROWS, totalRows));
        }
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadedRows, totalRows]);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFadeTop(el.scrollTop > 8);
    setFadeBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
  }, []);

  // Split items into columns, capped by loadedRows
  const visibleCount = loadedRows * colCount;
  const visibleItems = displayItems.slice(0, visibleCount);
  const itemColumns: ConversationMeta[][] = Array.from({ length: colCount }, () => []);
  visibleItems.forEach((item, i) => {
    itemColumns[i % colCount].push(item);
  });

  return (
    <div
      ref={scrollRef}
      className="flex flex-col h-full w-full overflow-y-auto scrollbar-none"
      onScroll={checkScroll}
      style={{
        padding: compact ? "36px 0 40px" : "60px 0 40px",
        maskImage:
          !fadeTop && !fadeBottom
            ? "none"
            : `linear-gradient(to bottom, ${fadeTop ? "transparent" : "black"} 0px, black ${fadeTop ? "60px" : "0px"}, black calc(100% - ${fadeBottom ? "60px" : "0px"}), ${fadeBottom ? "transparent" : "black"} 100%)`,
      }}
    >
      <div style={{
        width: "100%",
        maxWidth: colCount * 220 + (colCount - 1) * 28,
        margin: "0 auto",
        padding: compact ? "0 24px" : "0 48px",
      }}>
        <div style={{
          marginBottom: compact ? 24 : 36,
          opacity: appeared ? 1 : 0,
          transform: appeared ? "translateY(0)" : "translateY(8px)",
          transition: "opacity 500ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 500ms cubic-bezier(0.25, 0.1, 0.25, 1)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1 style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: compact ? 24 : 30,
              fontWeight: 600,
              color: "rgba(195, 236, 255, 0.85)",
              letterSpacing: "-0.04em",
              lineHeight: 1.1,
              margin: 0,
              flex: 1,
            }}>
              {column.label}
            </h1>
            {column.projectId && (
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <img
                  src="/icons/EditIcon.svg"
                  alt="Edit"
                  title="Edit project"
                  onClick={() => { setEditName(column.label); setEditDesc(column.description ?? ""); setEditing(true); }}
                  style={{
                    width: 26, height: 26,
                    filter: "invert(0.7) sepia(0.3) saturate(2) hue-rotate(170deg) brightness(1.1)",
                    opacity: 0.35,
                    cursor: "pointer", transition: "transform 200ms ease, opacity 200ms ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "scale(1.15)";
                    e.currentTarget.style.opacity = "0.8";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.opacity = "0.35";
                  }}
                />
                <img
                  src="/icons/TrashIcon.svg"
                  alt="Delete"
                  title="Delete project"
                  onClick={() => setConfirmDelete(true)}
                  style={{
                    width: 26, height: 26,
                    filter: "invert(0.7) sepia(0.3) saturate(2) hue-rotate(170deg) brightness(1.1)",
                    opacity: 0.35,
                    cursor: "pointer", transition: "transform 200ms ease, opacity 200ms ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "scale(1.15)";
                    e.currentTarget.style.opacity = "0.8";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "scale(1)";
                    e.currentTarget.style.opacity = "0.35";
                  }}
                />
              </div>
            )}
          </div>
          {column.description && (
            <div style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: compact ? 15 : 17,
              fontWeight: 400,
              color: "rgba(195, 236, 255, 0.35)",
              letterSpacing: "-0.01em",
              lineHeight: 1.45,
              marginTop: 8,
              maxWidth: 540,
            }}>
              {column.description}
            </div>
          )}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 28,
            gap: 8,
          }}>
            {column.projectId && (<div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowAddSearch(true)}
                style={{
                  background: "rgba(195, 236, 255, 0.06)",
                  border: "1px solid rgba(195, 236, 255, 0.1)",
                  borderRadius: 8,
                  padding: "5px 14px",
                  cursor: "pointer",
                  color: "rgba(195, 236, 255, 0.5)",
                  fontSize: 15,
                  fontFamily: "'DM Sans', sans-serif",
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  transition: "all 200ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(195, 236, 255, 0.1)";
                  e.currentTarget.style.color = "rgba(195, 236, 255, 0.7)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(195, 236, 255, 0.06)";
                  e.currentTarget.style.color = "rgba(195, 236, 255, 0.5)";
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  if (onStartSuggestion && column.projectId) {
                    onStartSuggestion(column.projectId, column.label, column.description ?? "");
                  } else {
                    setShowSuggestions(true);
                  }
                }}
                style={{
                  background: "rgba(195, 236, 255, 0.06)",
                  border: "1px solid rgba(195, 236, 255, 0.1)",
                  borderRadius: 8,
                  padding: "5px 14px",
                  cursor: "pointer",
                  color: "rgba(195, 236, 255, 0.5)",
                  fontSize: 15,
                  fontFamily: "'DM Sans', sans-serif",
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  transition: "all 200ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(195, 236, 255, 0.1)";
                  e.currentTarget.style.color = "rgba(195, 236, 255, 0.7)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(195, 236, 255, 0.06)";
                  e.currentTarget.style.color = "rgba(195, 236, 255, 0.5)";
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 20h12v-3h2v4c0 0.5523 -0.4477 1 -1 1H5c-0.55228 0 -1 -0.4477 -1 -1v-4h2zm17 -5H1v-2h22zm-3 -7.16406V11h-2V9h-5V4H6v7H4V3l0.00488 -0.10254C4.05621 2.39333 4.48232 2 5 2h9.1641z" />
                </svg>
                Find related
              </button>
            </div>)}
            <span style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: compact ? 15 : 17,
              fontWeight: 400,
              color: "rgba(195, 236, 255, 0.25)",
              letterSpacing: "-0.01em",
              flexShrink: 0,
            }}>
              {filterQuery.trim()
                ? `${displayItems.length} of ${column.items.length}`
                : `${column.items.length} conversation${column.items.length !== 1 ? "s" : ""}`}
            </span>
          </div>
          {/* Filter row — own row beneath the action buttons, flushed left */}
          <div style={{
            display: "flex",
            marginTop: 14,
          }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flex: "0 1 360px",
                minWidth: 200,
                background: "rgba(195, 236, 255, 0.05)",
                border: "1px solid rgba(195, 236, 255, 0.08)",
                borderRadius: 8,
                padding: compact ? "5px 10px" : "6px 12px",
                transition: "border-color 200ms ease, background 200ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(195, 236, 255, 0.07)";
                e.currentTarget.style.borderColor = "rgba(195, 236, 255, 0.14)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(195, 236, 255, 0.05)";
                e.currentTarget.style.borderColor = "rgba(195, 236, 255, 0.08)";
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
                <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (filterQuery) setFilterQuery("");
                    else (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder={`Filter ${column.items.length} conversation${column.items.length !== 1 ? "s" : ""}…`}
                style={{
                  background: "none",
                  border: "none",
                  outline: "none",
                  color: "rgba(195, 236, 255, 0.85)",
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: compact ? 13 : 14,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  width: "100%",
                  minWidth: 0,
                }}
              />
              {filterQuery && (
                <button
                  type="button"
                  onClick={() => setFilterQuery("")}
                  aria-label="Clear filter"
                  style={{
                    flexShrink: 0,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: "rgba(195, 236, 255, 0.4)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    transition: "color 200ms ease, background 200ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; e.currentTarget.style.background = "rgba(195, 236, 255, 0.08)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; e.currentTarget.style.background = "none"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        {filterQuery.trim() && displayItems.length === 0 && (
          <div style={{
            padding: "40px 0",
            textAlign: "center",
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 14,
            color: "rgba(195, 236, 255, 0.35)",
            letterSpacing: "-0.01em",
          }}>
            No conversations match "{filterQuery}".
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
            gap: 28,
            alignItems: "start",
          }}
        >
          {itemColumns.map((items, ci) => (
            <div key={ci} style={{ display: "flex", flexDirection: "column" }}>
              {items.map((conv, ri) => {
                // Stagger: delay by row + column offset
                const delay = ri * 30 + ci * 50;
                return (
                  <div
                    key={conv.id}
                    style={{
                      opacity: appeared ? 1 : 0,
                      transform: appeared ? "translateY(0)" : "translateY(6px)",
                      transition: `opacity 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms, transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms`,
                    }}
                  >
                    <ConversationItem
                      conv={conv}
                      onSelect={onSelect}
                      onRemove={column.projectId ? () => {
                        cmdKgUnlinkConversation(column.projectId!, conv.conversation_id).then(() => onRefresh?.()).catch(() => {});
                      } : undefined}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {loadedRows < totalRows && (
          <div ref={sentinelRef} style={{ height: 1 }} />
        )}
      </div>
      {showAddSearch && column.projectId && createPortal(
        <AddConversationPalette
          projectId={column.projectId}
          onClose={() => { setShowAddSearch(false); onRefresh?.(); }}
        />,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {showSuggestions && column.projectId && createPortal(
        <SuggestionsPanel
          projectId={column.projectId}
          name={column.label}
          description={column.description ?? ""}
          onClose={() => { setShowSuggestions(false); onRefresh?.(); }}
        />,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {editing && column.projectId && createPortal(
        <div
          onClick={() => setEditing(false)}
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
              Edit Project
            </span>
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editName.trim()) {
                  cmdKgUpdateProject(column.projectId!, editName.trim(), editDesc.trim()).then(() => { setEditing(false); onRefresh?.(); onBack?.(); }).catch(() => {});
                }
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder="Project name"
              style={{
                background: "rgba(195, 236, 255, 0.05)", border: "1px solid rgba(195, 236, 255, 0.1)",
                borderRadius: 8, padding: "10px 12px", color: "rgba(195, 236, 255, 0.9)",
                fontFamily: "'DM Sans', sans-serif", fontSize: 14, outline: "none",
              }}
            />
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
              placeholder="Description (optional)"
              rows={3}
              style={{
                background: "rgba(195, 236, 255, 0.05)", border: "1px solid rgba(195, 236, 255, 0.1)",
                borderRadius: 8, padding: "10px 12px", color: "rgba(195, 236, 255, 0.9)",
                fontFamily: "'DM Sans', sans-serif", fontSize: 14, outline: "none", resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setEditing(false)} style={{
                background: "rgba(195, 236, 255, 0.06)", border: "none", borderRadius: 6, padding: "8px 16px",
                color: "rgba(195, 236, 255, 0.6)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}>Cancel</button>
              <button onClick={() => {
                if (!editName.trim()) return;
                cmdKgUpdateProject(column.projectId!, editName.trim(), editDesc.trim()).then(() => { setEditing(false); onRefresh?.(); onBack?.(); }).catch(() => {});
              }} style={{
                background: "rgba(195, 236, 255, 0.1)", border: "1px solid rgba(195, 236, 255, 0.15)", borderRadius: 6, padding: "8px 20px",
                color: "rgba(195, 236, 255, 0.9)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>Save</button>
            </div>
          </div>
        </div>,
        document.getElementById("kept-app-container") ?? document.body,
      )}
      {confirmDelete && column.projectId && createPortal(
        <div
          onClick={() => setConfirmDelete(false)}
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
              Delete Project
            </span>
            <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "rgba(195, 236, 255, 0.5)", lineHeight: 1.5, margin: 0 }}>
              Are you sure you want to delete <strong style={{ color: "rgba(195, 236, 255, 0.8)" }}>{column.label}</strong>? All conversations will be kept in your vault.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDelete(false)} style={{
                background: "rgba(195, 236, 255, 0.06)", border: "none", borderRadius: 6, padding: "8px 16px",
                color: "rgba(195, 236, 255, 0.6)", fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}>Cancel</button>
              <button onClick={() => {
                cmdKgDeleteProject(column.projectId!).then(() => { setConfirmDelete(false); onBack?.(); }).catch(() => {});
              }} style={{
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

// ── Inline suggestions panel for project detail view ──
function SuggestionsPanel({ projectId, name, description, onClose }: {
  projectId: string;
  name: string;
  description: string;
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

    // Listen for progress events from the agent
    if (isTauri) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        if (cancelled) return;
        listen<{ stage: string; tool_name?: string; iteration: number }>("suggest-progress", (event) => {
          if (cancelled) return;
          setProgress(prev => progressMessage(event.payload.stage, event.payload.tool_name ?? undefined, prev));
        }).then((fn) => { unlisten = fn; });
      });
    }

    cmdSuggestProjectConversations(projectId, name, description)
      .then((resp) => {
        if (cancelled) return;
        setRecommendations(resp.recommendations);
        setSummary(resp.summary);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; unlisten?.(); };
  }, [projectId, name, description]);

  const handleLink = (rec: ConversationRecommendation) => {
    if (!rec.conversation_id) return;
    cmdKgLinkConversation(projectId, rec.conversation_id, "general").catch(() => {});
    setLinked((prev) => new Set(prev).add(rec.file_path));
  };

  const visible = recommendations.filter((r) => !dismissed.has(r.file_path));

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0b1115",
          border: "1px solid rgba(195, 236, 255, 0.08)",
          borderRadius: 12, padding: 24, width: 480,
          maxHeight: "min(80vh, 600px)",
          display: "flex", flexDirection: "column", gap: 16, overflow: "hidden",
        }}
      >
        <span style={{
          fontFamily: "'DM Sans', sans-serif", fontSize: 16, fontWeight: 600,
          color: "rgba(195, 236, 255, 0.9)", letterSpacing: "-0.02em",
        }}>
          Find conversations for {name}
        </span>

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "24px 0" }}>
            <div style={{
              width: 20, height: 20,
              border: "2px solid rgba(195,236,255,0.15)",
              borderTopColor: "rgba(195,236,255,0.5)",
              borderRadius: "50%",
              animation: "spin 800ms linear infinite", flexShrink: 0,
            }} />
            <span style={{ fontSize: 13, color: "rgba(195, 236, 255, 0.5)", fontFamily: "'DM Sans', sans-serif", transition: "opacity 200ms ease" }}>
              {progress}
            </span>
          </div>
        ) : error ? (
          <p style={{ fontSize: 13, color: "#f87171", fontFamily: "'DM Sans', sans-serif" }}>{error}</p>
        ) : visible.length === 0 ? (
          <p style={{ fontSize: 13, color: "rgba(195, 236, 255, 0.4)", fontFamily: "'DM Sans', sans-serif", padding: "12px 0" }}>
            {recommendations.length === 0 ? "No relevant conversations found." : "All suggestions handled."}
          </p>
        ) : (
          <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
            {visible.map((rec) => {
              const isLinked = linked.has(rec.file_path);
              return (
                <div key={rec.file_path} style={{
                  background: isLinked ? "rgba(74,222,128,0.06)" : "rgba(195, 236, 255, 0.03)",
                  border: `1px solid ${isLinked ? "rgba(74,222,128,0.15)" : "rgba(195, 236, 255, 0.06)"}`,
                  borderRadius: 10, padding: "12px 14px",
                  display: "flex", flexDirection: "column", gap: 6,
                }}>
                  <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 600, color: "rgba(195, 236, 255, 0.9)", letterSpacing: "-0.01em" }}>
                    {rec.title}
                  </span>
                  <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "rgba(195, 236, 255, 0.4)", lineHeight: 1.4 }}>
                    {rec.reason}
                  </span>
                  {!isLinked ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <button onClick={() => handleLink(rec)} style={{
                        background: "rgba(195, 236, 255, 0.08)", border: "1px solid rgba(195, 236, 255, 0.12)",
                        borderRadius: 6, padding: "5px 14px", cursor: "pointer",
                        color: "rgba(195, 236, 255, 0.8)", fontSize: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 500,
                        transition: "background 200ms ease",
                      }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.14)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.08)"; }}
                      >
                        Add to project
                      </button>
                      <button onClick={() => setDismissed((prev) => new Set(prev).add(rec.file_path))} style={{
                        background: "transparent", border: "none", padding: "5px 10px", cursor: "pointer",
                        color: "rgba(195, 236, 255, 0.3)", fontSize: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 500,
                      }}>
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: "#4ade80", fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>Added</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {summary && !loading && (
          <p style={{ fontSize: 12, color: "rgba(195, 236, 255, 0.35)", fontFamily: "'DM Sans', sans-serif", lineHeight: 1.4, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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

// ── Add conversation palette (cmd+k style search) ──
function AddConversationPalette({ projectId, onClose }: {
  projectId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationMeta[]>([]);
  const [allConvs, setAllConvs] = useState<ConversationMeta[]>([]);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    apiListConversations().then((convs) => {
      const sorted = convs.sort((a, b) =>
        new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime()
      );
      setAllConvs(sorted);
      setResults(sorted.slice(0, 20));
    }).catch(() => {});
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults(allConvs.slice(0, 20));
      return;
    }
    debounceRef.current = setTimeout(() => {
      apiSearch(query.trim(), 20).then((searchResults) => {
        const seen = new Set<string>();
        const convs: ConversationMeta[] = [];
        for (const r of searchResults) {
          if (seen.has(r.file_path)) continue;
          seen.add(r.file_path);
          const match = allConvs.find(c => c.file_path === r.file_path);
          if (match) convs.push(match);
          else convs.push({ id: 0, conversation_id: r.conversation_id, platform: r.platform, title: r.title, model: null, message_count: 0, file_path: r.file_path, content_hash: "", created_at: null, updated_at: null, indexed_at: "", preview: r.snippet });
        }
        setResults(convs);
      }).catch(() => {});
    }, 150);
  }, [query, allConvs]);

  const handleAdd = (conv: ConversationMeta) => {
    if (!conv.conversation_id) return;
    cmdKgLinkConversation(projectId, conv.conversation_id, "general").catch(() => {});
    setLinked(prev => new Set(prev).add(conv.file_path));
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: "12vh",
        background: "rgba(0, 0, 0, 0.6)", backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0b1115",
          border: "1px solid rgba(195, 236, 255, 0.1)",
          borderRadius: 14,
          width: 520,
          maxHeight: "min(60vh, 480px)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid rgba(195, 236, 255, 0.06)" }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search conversations to add..."
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              color: "rgba(195, 236, 255, 0.9)",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 16,
              fontWeight: 500,
              letterSpacing: "-0.02em",
              outline: "none",
              caretColor: "rgba(195, 236, 255, 0.5)",
            }}
          />
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: "4px 6px 6px" }}>
          {results.length === 0 ? (
            <div style={{ padding: "20px 12px", textAlign: "center", color: "rgba(195, 236, 255, 0.3)", fontFamily: "'DM Sans', sans-serif", fontSize: 13 }}>
              {query ? "No matching conversations" : "No conversations in vault"}
            </div>
          ) : results.map((conv) => {
            const isLinked = linked.has(conv.file_path);
            return (
              <div
                key={conv.file_path}
                onClick={() => !isLinked && handleAdd(conv)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  cursor: isLinked ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  transition: "background 150ms ease",
                }}
                onMouseEnter={(e) => { if (!isLinked) e.currentTarget.style.background = "rgba(195, 236, 255, 0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 500,
                    color: isLinked ? "rgba(195, 236, 255, 0.4)" : "rgba(195, 236, 255, 0.85)",
                    letterSpacing: "-0.01em",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {conv.title || "Untitled"}
                  </div>
                  <div style={{
                    fontFamily: "'DM Sans', sans-serif", fontSize: 12,
                    color: "rgba(195, 236, 255, 0.25)",
                    marginTop: 2,
                  }}>
                    {PLATFORM_NAMES[conv.platform] ?? conv.platform}
                    {conv.message_count > 0 && ` · ${conv.message_count} messages`}
                  </div>
                </div>
                {isLinked ? (
                  <span style={{ fontSize: 12, color: "#4ade80", fontFamily: "'DM Sans', sans-serif", fontWeight: 500, flexShrink: 0 }}>
                    Added
                  </span>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(195,236,255,0.3)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
