import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ChatContainer, { useScale, type ChatContainerHandle, type ChatModelOption } from "./components/ChatContainer";
import ChatMessage from "./components/ChatMessage";
import MessageSequence from "./components/MessageSequence";
import CodingManager from "./components/CodingManager";
import Dashboard from "./components/Dashboard";
import DigestView from "./components/DigestView";
import Settings, { type SectionId } from "./components/Settings";
import GraphExplorer from "./components/GraphExplorer";
import KeptLogoAnimated from "./components/KeptLogoAnimated";
import ResizeGrips from "./components/ResizeGrips";
import ConversationView from "./components/ConversationView";
import VaultOverview, { VaultColumnExpanded, type VaultColumn } from "./components/VaultOverview";
import VaultFilterBar from "./components/VaultFilterBar";
import InlineCodeConsent, { useCodeConsentQueue } from "./components/CodeConsentDialog";
import SearchBar from "./components/SearchBar";
import { CompactNav, useCompact } from "./components/SideNav";
import Titlebar from "./components/Titlebar";
import UpdateBanner from "./components/UpdateBanner";
import { responsiveRadius, squirclePath } from "./lib/squircle";
import { agentChat, cmdKgClassifyNewConversations, cmdKgGetGraph, cmdKgGetProjects, cmdKgGetTopicConversations, cmdKgLinkConversation, cmdSuggestProjectConversations, deleteConversation, generateTitle, getConfig, getConversation, getExtensionStatus, getExtensionZip, getVaultPath, isTauri, listConversations, listModels, refreshToken, renameConversation, requestExtensionSync, saveKeptChat, setConfig, stopExtensionSync } from "./lib/tauri-api";
import { parseFrontmatter, parseMessages } from "./lib/markdown";
import type {
  AppConfig,
  AgentChatRequest,
  AvailableModel,
  ChatAttachment,
  ConversationMeta,
  ConversationRecommendation,
  IngestPayload,
  ModelEntry,
  TitleRequest,
  VaultConversationIngested,
} from "./lib/types";

const MODEL_PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  openrouter: "OpenRouter",
};

const VAULT_TAB_REFRESH_DELAY_MS = 420;

// Friendly status labels shown in the chat while a tool call is in flight.
// Falls back to "Working" for any tool not listed here.
const TOOL_STATUS_LABELS: Record<string, string> = {
  execute_code: "Running code",
  search_conversations: "Searching conversations",
  search_conversation_content: "Searching conversations",
  search_knowledge_files: "Searching files",
  grep_knowledge_files: "Searching files",
  search_nodes: "Searching graph",
  read_conversation: "Reading conversation",
  read_knowledge_file: "Reading file",
  read_file: "Reading file",
  read_pdf: "Reading PDF",
  read_image: "Reading image",
  list_conversations: "Listing conversations",
  list_knowledge_files: "Listing files",
  list_directory: "Listing files",
  list_nodes: "Listing graph nodes",
  list_fs_allowed_paths: "Checking file access",
  graph_search: "Querying graph",
  get_neighbors: "Querying graph",
  get_stats: "Fetching graph stats",
  highlight_nodes: "Highlighting graph",
  add_edge: "Updating graph",
  remove_edge: "Updating graph",
  add_entity: "Updating graph",
  remove_node: "Updating graph",
  web_search: "Searching the web",
  read_web_page: "Reading web page",
};

function statusLabelForTool(toolName: string): string {
  return TOOL_STATUS_LABELS[toolName] ?? "Working";
}
const TOKEN_PROVIDER_IDS = ["openai", "anthropic", "openrouter"] as const;
type TokenProviderId = typeof TOKEN_PROVIDER_IDS[number];
type ChatUiMessage = {
  role: string;
  content: string;
  attachments?: ChatAttachment[];
  reasoning?: string;
  toolCalls?: { name: string; arguments: unknown }[];
};

function buildChatModelOption(
  providerId: string,
  modelId: string,
  menuLabel: string,
): ChatModelOption {
  return {
    id: `${providerId}:${modelId}`,
    label: menuLabel,
    provider: MODEL_PROVIDER_LABELS[providerId] ?? providerId,
    providerId,
    modelId,
    menuLabel,
  };
}

function isFreeModelId(modelId: string | null | undefined): boolean {
  return !!modelId?.trim().toLowerCase().endsWith(":free");
}

function formatModelLabel(model: AvailableModel): string {
  const display = model.display_name?.trim();
  if (display) return display;
  const tail = model.id.split("/").pop() ?? model.id;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function modelToChatOption(model: AvailableModel): ChatModelOption {
  return buildChatModelOption(model.provider, model.id, formatModelLabel(model));
}

function assignmentToChatOption(entry: ModelEntry): ChatModelOption {
  const label = entry.model.split("/").pop()?.replace(/[-_]/g, " ") ?? entry.model;
  return buildChatModelOption(entry.provider, entry.model, label.replace(/\b\w/g, (char) => char.toUpperCase()));
}

function dedupeChatModelOptions(options: ChatModelOption[]): ChatModelOption[] {
  const seen = new Set<string>();
  const result: ChatModelOption[] = [];
  for (const option of options) {
    if (seen.has(option.id) || isFreeModelId(option.modelId)) continue;
    seen.add(option.id);
    result.push(option);
  }
  return result;
}

function apiKeyForProvider(config: AppConfig, providerId: TokenProviderId): string | undefined {
  switch (providerId) {
    case "openai":
      return config.openai_api_key ?? undefined;
    case "anthropic":
      return config.anthropic_api_key ?? undefined;
    case "openrouter":
      return config.openrouter_api_key ?? undefined;
  }
}

function hasConfiguredSecret(value: string | null | undefined): boolean {
  return !!value?.trim();
}

function ConvTitleBar({ convInfo, onBack, backLabel = "Back" }: {
  convInfo: { title: string; frontmatter: { platform?: string; model?: string; messages?: number } };
  onBack: () => void;
  backLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vs = Math.min(useScale(), 1.15);
  const s = (v: number) => Math.round(v * vs);

  const applyParallax = (hoveredIdx: number) => {
    const el = containerRef.current;
    if (!el) return;
    const back = el.children[0] as HTMLElement;
    const info = el.children[1] as HTMLElement;
    if (hoveredIdx === 0) {
      back.style.padding = `0 ${s(18)}px 0 ${s(14)}px`;
      back.style.background = "rgba(195, 236, 255, 0.07)";
      info.style.background = "rgba(195, 236, 255, 0.04)";
    } else {
      back.style.padding = `0 ${s(14)}px 0 ${s(10)}px`;
      back.style.background = "rgba(195, 236, 255, 0.04)";
      info.style.background = "rgba(195, 236, 255, 0.08)";
    }
  };

  const resetParallax = () => {
    const el = containerRef.current;
    if (!el) return;
    const back = el.children[0] as HTMLElement;
    const info = el.children[1] as HTMLElement;
    back.style.padding = `0 ${s(14)}px 0 ${s(10)}px`;
    back.style.background = "rgba(195, 236, 255, 0.04)";
    info.style.background = "rgba(195, 236, 255, 0.06)";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative", pointerEvents: "none" }}>
      <div
        ref={containerRef}
        onMouseLeave={resetParallax}
        style={{
          display: "inline-flex",
          alignItems: "stretch",
          gap: s(3),
          maxWidth: "100%",
          minWidth: 0,
          background: "rgba(195, 236, 255, 0.03)",
          borderRadius: s(14),
          padding: s(4),
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "rgba(195, 236, 255, 0.04)",
            border: "none",
            cursor: "pointer",
            borderRadius: s(10),
            padding: `0 ${s(14)}px 0 ${s(10)}px`,
            display: "inline-flex",
            alignItems: "center",
            gap: s(2),
            color: "rgba(195, 236, 255, 0.4)",
            flex: "0 0 auto",
            transition: "padding 300ms ease-out, background 300ms ease-out, color 200ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; applyParallax(0); }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
        >
          <svg width={s(16)} height={s(16)} viewBox="0 0 16 16" fill="none" style={{ display: "block", flexShrink: 0 }}>
            <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: s(14),
            fontWeight: 500,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
          }}>{backLabel}</span>
        </button>
        <div
          onMouseEnter={() => applyParallax(1)}
          style={{
            minWidth: 0,
            textAlign: "left",
            background: "rgba(195, 236, 255, 0.06)",
            borderRadius: s(10),
            padding: `${s(9)}px ${s(16)}px`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: "1 1 0%",
            cursor: "default",
            transition: "background 300ms ease-out",
          }}
        >
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: s(15),
            fontWeight: 600,
            color: "rgba(195, 236, 255, 0.75)",
            letterSpacing: "-0.02em",
            lineHeight: 1.3,
            maxWidth: s(200),
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>
            {convInfo.title}
          </div>
        </div>
      </div>
    </div>
  );
}

const SETTINGS_SECTION_LABELS: Record<string, string> = {
  "api-access": "API Access",
  "general": "General",
  "knowledge-graph": "Knowledge Graph",
  "vault": "Vault",
};

function SettingsTitleBar({ section, onBack, backLabel = "Back" }: { section: string; onBack: () => void; backLabel?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vs = Math.min(useScale(), 1.15);
  const s = (v: number) => Math.round(v * vs);

  const applyParallax = (hoveredIdx: number) => {
    const el = containerRef.current;
    if (!el) return;
    const back = el.children[0] as HTMLElement;
    const info = el.children[1] as HTMLElement;
    if (hoveredIdx === 0) {
      back.style.padding = `0 ${s(18)}px 0 ${s(14)}px`;
      back.style.background = "rgba(195, 236, 255, 0.07)";
      info.style.background = "rgba(195, 236, 255, 0.04)";
    } else {
      back.style.padding = `0 ${s(14)}px 0 ${s(10)}px`;
      back.style.background = "rgba(195, 236, 255, 0.04)";
      info.style.background = "rgba(195, 236, 255, 0.08)";
    }
  };

  const resetParallax = () => {
    const el = containerRef.current;
    if (!el) return;
    const back = el.children[0] as HTMLElement;
    const info = el.children[1] as HTMLElement;
    back.style.padding = `0 ${s(14)}px 0 ${s(10)}px`;
    back.style.background = "rgba(195, 236, 255, 0.04)";
    info.style.background = "rgba(195, 236, 255, 0.06)";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative", pointerEvents: "none" }}>
      <div
        ref={containerRef}
        onMouseLeave={resetParallax}
        style={{
          display: "inline-flex",
          alignItems: "stretch",
          gap: s(3),
          maxWidth: "100%",
          minWidth: 0,
          background: "rgba(195, 236, 255, 0.03)",
          borderRadius: s(14),
          padding: s(4),
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "rgba(195, 236, 255, 0.04)",
            border: "none",
            cursor: "pointer",
            borderRadius: s(10),
            padding: `0 ${s(14)}px 0 ${s(10)}px`,
            display: "inline-flex",
            alignItems: "center",
            gap: s(2),
            color: "rgba(195, 236, 255, 0.4)",
            flex: "0 0 auto",
            transition: "padding 300ms ease-out, background 300ms ease-out, color 200ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; applyParallax(0); }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
        >
          <svg width={s(16)} height={s(16)} viewBox="0 0 16 16" fill="none" style={{ display: "block", flexShrink: 0 }}>
            <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: s(14),
            fontWeight: 500,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
          }}>{backLabel}</span>
        </button>
        <div
          onMouseEnter={() => applyParallax(1)}
          style={{
            minWidth: 0,
            textAlign: "left",
            background: "rgba(195, 236, 255, 0.06)",
            borderRadius: s(10),
            padding: `${s(9)}px ${s(16)}px`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: "1 1 0%",
            cursor: "default",
            transition: "background 300ms ease-out",
          }}
        >
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: s(15),
            fontWeight: 600,
            color: "rgba(195, 236, 255, 0.75)",
            letterSpacing: "-0.02em",
            lineHeight: 1.3,
            whiteSpace: "nowrap",
          }}>
            {SETTINGS_SECTION_LABELS[section] ?? section}
          </div>
        </div>
      </div>
    </div>
  );
}

function VaultColumnTitleBar({ label, itemCount, onBack, backLabel = "Back" }: { label: string; itemCount: number; onBack: () => void; backLabel?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vs = Math.min(useScale(), 1.15);
  const s = (v: number) => Math.round(v * vs);

  const applyParallax = (hoveredIdx: number) => {
    const el = containerRef.current;
    if (!el) return;
    const back = el.children[0] as HTMLElement;
    const info = el.children[1] as HTMLElement;
    if (hoveredIdx === 0) {
      back.style.padding = `0 ${s(18)}px 0 ${s(14)}px`;
      back.style.background = "rgba(195, 236, 255, 0.07)";
      info.style.background = "rgba(195, 236, 255, 0.04)";
    } else {
      back.style.padding = `0 ${s(14)}px 0 ${s(10)}px`;
      back.style.background = "rgba(195, 236, 255, 0.04)";
      info.style.background = "rgba(195, 236, 255, 0.08)";
    }
  };

  const resetParallax = () => {
    const el = containerRef.current;
    if (!el) return;
    const back = el.children[0] as HTMLElement;
    const info = el.children[1] as HTMLElement;
    back.style.padding = `0 ${s(14)}px 0 ${s(10)}px`;
    back.style.background = "rgba(195, 236, 255, 0.04)";
    info.style.background = "rgba(195, 236, 255, 0.06)";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative", pointerEvents: "none" }}>
      <div
        ref={containerRef}
        onMouseLeave={resetParallax}
        style={{
          display: "inline-flex",
          alignItems: "stretch",
          gap: s(3),
          maxWidth: "100%",
          minWidth: 0,
          background: "rgba(195, 236, 255, 0.03)",
          borderRadius: s(14),
          padding: s(4),
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "rgba(195, 236, 255, 0.04)",
            border: "none",
            cursor: "pointer",
            borderRadius: s(10),
            padding: `0 ${s(14)}px 0 ${s(10)}px`,
            display: "inline-flex",
            alignItems: "center",
            gap: s(2),
            color: "rgba(195, 236, 255, 0.4)",
            flex: "0 0 auto",
            transition: "padding 300ms ease-out, background 300ms ease-out, color 200ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)"; applyParallax(0); }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
        >
          <svg width={s(16)} height={s(16)} viewBox="0 0 16 16" fill="none" style={{ display: "block", flexShrink: 0 }}>
            <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: s(14),
            fontWeight: 500,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
          }}>{backLabel}</span>
        </button>
        <div
          onMouseEnter={() => applyParallax(1)}
          style={{
            minWidth: 0,
            textAlign: "left",
            background: "rgba(195, 236, 255, 0.06)",
            borderRadius: s(10),
            padding: `${s(9)}px ${s(16)}px`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            flex: "1 1 0%",
            cursor: "default",
            transition: "background 300ms ease-out",
          }}
        >
          <div style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: s(15),
            fontWeight: 600,
            color: "rgba(195, 236, 255, 0.75)",
            letterSpacing: "-0.02em",
            lineHeight: 1.3,
            whiteSpace: "nowrap",
          }}>
            {label}
            <span style={{ fontWeight: 400, color: "rgba(195, 236, 255, 0.3)", marginLeft: 8 }}>
              {itemCount} items
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SuggestionResultsPanel({ projectId, name, recommendations, summary, onClose }: {
  projectId: string;
  name: string;
  recommendations: ConversationRecommendation[];
  summary: string;
  onClose: () => void;
}) {
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const handleLink = (rec: ConversationRecommendation) => {
    if (!rec.conversation_id) return;
    cmdKgLinkConversation(projectId, rec.conversation_id, "general").catch(() => {});
    setLinked(prev => new Set(prev).add(rec.file_path));
  };

  const visible = recommendations.filter(r => !dismissed.has(r.file_path));

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
          Suggestions for {name}
        </span>

        {visible.length === 0 ? (
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
                      <button onClick={() => setDismissed(prev => new Set(prev).add(rec.file_path))} style={{
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

        {summary && (
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
          {visible.length > 0 && (
            <button onClick={() => {
              const toLink = visible.filter(r => !linked.has(r.file_path));
              for (const rec of toLink) handleLink(rec);
              // Close and refresh after a brief delay for the links to persist
              setTimeout(() => onClose(), 300);
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

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const radius = 40;
  const [chatActive, setChatActive] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [activePage, setActivePageRaw] = useState("Chat");
  const setActivePage = useCallback((page: string) => {
    setActivePageRaw(page);
  }, []);
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [spacerHeight, setSpacerHeight] = useState<number>(0);
  const initialSpacerRef = useRef<number>(0);
  const spacerSnapshotRef = useRef<number>(0);
  const { pending: pendingConsent, remaining: pendingConsentRemaining, respond: respondConsent } = useCodeConsentQueue();
  const [chatTitle, setChatTitle] = useState("New Chat");
  const chatConvId = useRef<string>(crypto.randomUUID());
  const chatTitleRef = useRef("New Chat");
  const chatModelRef = useRef<string | null>(null);
  const [explorerReady, setExplorerReady] = useState(false);
  const [bootStatus, setBootStatus] = useState("Initializing graph");
  const [showStartupOverlay, setShowStartupOverlay] = useState(true);
  const [explorerSearch, setExplorerSearch] = useState("");
  const [explorerSearchZoom, setExplorerSearchZoom] = useState(0);
  const explorerGraphPrefetch = useMemo(() => cmdKgGetGraph(0), []);
  const [settingsSection, setSettingsSection] = useState<SectionId | null>(null);
  const [settingsReturnPage, setSettingsReturnPage] = useState<string | null>(null);
  // Page the user came from when opening a conversation. Null means Vault
  // (the default back target); set to "Explorer" when the preview was
  // clicked from the Graph Explorer side panel so Back returns there.
  const [conversationReturnPage, setConversationReturnPage] = useState<string | null>(null);
  const [onboardingState, setOnboardingState] = useState<"checking" | "required" | "ready">(
    isTauri ? "checking" : "ready",
  );
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [providerChatModels, setProviderChatModels] = useState<Record<string, ChatModelOption[]>>({});
  const titlebarRef = useRef<HTMLDivElement>(null);
  const [titlebarCenterY, setTitlebarCenterY] = useState(59);
  useEffect(() => {
    const el = titlebarRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const measure = () => {
      const tb = el.getBoundingClientRect();
      const ct = container.getBoundingClientRect();
      // Find the window control buttons and align to their vertical center
      const buttons = el.querySelectorAll("button[aria-label]");
      if (buttons.length > 0) {
        const btnRect = buttons[0].getBoundingClientRect();
        const lastBtnRect = buttons[buttons.length - 1].getBoundingClientRect();
        const btnsTop = Math.min(btnRect.top, lastBtnRect.top);
        const btnsBottom = Math.max(btnRect.bottom, lastBtnRect.bottom);
        setTitlebarCenterY((btnsTop + btnsBottom) / 2 - ct.top);
      } else {
        setTitlebarCenterY(tb.top + tb.height / 2 - ct.top);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onboardRef = useRef<HTMLDivElement>(null);
  const onboardGridRef = useRef<HTMLDivElement>(null);
  const [hoveredPanel, setHoveredPanel] = useState<0 | 1 | 2 | 3 | -1>(-1);
  const [onboardStep, setOnboardStep] = useState(0); // 0 = vault location, 1 = operating mode, 2 = api access, 3 = browser extension, 4 = import
  const [onboardVisible, setOnboardVisible] = useState(true);
  const [importCount, setImportCount] = useState(0);
  const [importSyncing, setImportSyncing] = useState(false);
  const importSyncingRef = useRef(false);
  const [importProviders, setImportProviders] = useState<Record<string, boolean>>({
    chatgpt: true, claude: true, gemini: true, grok: false, kimi: false,
  });
  const [importLimit, setImportLimit] = useState(50); // 0 = all

  const goToStep = useCallback((step: number) => {
    setOnboardVisible(false);
    setTimeout(() => {
      setOnboardStep(step);
      setOnboardVisible(true);
    }, 250);
  }, []);

  // Preload onboarding background images
  useEffect(() => {
    for (const src of ["/sources/facility.webp", "/sources/private.webp", "/sources/network.webp", "/sources/connection.webp", "/sources/kept-globe.webp"]) {
      const img = new Image();
      img.src = src;
    }
  }, []);
  const [vaultLocation, setVaultLocation] = useState("~/.kept");
  const [operatingMode, setOperatingMode] = useState<"flexible" | "restricted" | null>(null);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [waitingForExtension, setWaitingForExtension] = useState(false);

  // Grid columns change per step
  const vaultBaseCols = useMemo(() => [1], []);
  const operatingBaseCols = useMemo(() => [1, 1], []);
  const apiBaseCols = useMemo(() => [1], []);
  const extensionBaseCols = useMemo(() => [1], []);
  const importBaseCols = useMemo(() => [1], []);
  const onboardBaseCols = onboardStep === 0 ? vaultBaseCols : onboardStep === 1 ? operatingBaseCols : onboardStep === 2 ? apiBaseCols : onboardStep === 3 ? extensionBaseCols : importBaseCols;
  const onboardTargetCols = useRef([1, 1]);
  const onboardCurrentCols = useRef([1, 1]);
  const onboardRafId = useRef(0);
  const onboardCardRefs = useRef<(HTMLDivElement | null)[]>([null, null]);
  const onboardInputFocused = useRef(false);

  // Vault state
  const [vaultConversations, setVaultConversations] = useState<ConversationMeta[]>([]);
  const vaultLoaded = useRef(false);
  const [selectedConvPath, setSelectedConvPath] = useState<string | null>(null);
  const selectedConvPathRef = useRef<string | null>(null);
  const [expandedColumn, setExpandedColumn] = useState<VaultColumn | null>(null);
  const [projectRefreshKey, setProjectRefreshKey] = useState(0);

  // Project suggestion state — persists across modal open/close
  const [suggestionState, setSuggestionState] = useState<{
    projectId: string;
    name: string;
    status: "running" | "done" | "error";
    progress: string;
    recommendations: ConversationRecommendation[];
    summary: string;
    error?: string;
  } | null>(null);
  const suggestionAbortRef = useRef(false);

  const startSuggestion = useCallback((projectId: string, name: string, description: string) => {
    suggestionAbortRef.current = false;
    setSuggestionState({
      projectId, name, status: "running", progress: "Starting search...",
      recommendations: [], summary: "",
    });
    cmdSuggestProjectConversations(projectId, name, description)
      .then((resp) => {
        if (suggestionAbortRef.current) return;
        setSuggestionState(prev => prev ? {
          ...prev, status: "done",
          recommendations: resp.recommendations,
          summary: resp.summary,
        } : null);
      })
      .catch((err) => {
        if (suggestionAbortRef.current) return;
        setSuggestionState(prev => prev ? {
          ...prev, status: "error", error: String(err),
        } : null);
      });
  }, []);

  const dismissSuggestion = useCallback(() => {
    suggestionAbortRef.current = true;
    setSuggestionState(null);
  }, []);
  const [showSuggestionResults, setShowSuggestionResults] = useState(false);
  const [vaultSearch, setVaultSearch] = useState("");
  const vaultSearchTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const handleSubFilterSelect = useCallback((category: string, subFilterId: string, label: string, description?: string) => {
    if (category === "vendor") {
      const filtered = vaultConversations
        .filter(c => c.platform === subFilterId)
        .sort((a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime());
      setExpandedColumn({ label, items: filtered });
    } else if (category === "project") {
      // Fetch actual linked conversations from the KG
      cmdKgGetProjects().then((projects) => {
        const project = projects.find(p => p.id === subFilterId);
        if (!project) return;
        const linkedIds = new Set(project.conversations.map(c => c.conv_id));
        const filtered = vaultConversations
          .filter(c => linkedIds.has(c.conversation_id))
          .sort((a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime());
        setExpandedColumn({ label, items: filtered, projectId: subFilterId, description });
      }).catch(() => {});
    } else if (category === "topic") {
      // Fetch conversation file paths from the KG for this topic
      cmdKgGetTopicConversations(subFilterId).then((paths) => {
        const pathSet = new Set(paths);
        const filtered = vaultConversations
          .filter(c => pathSet.has(c.file_path))
          .sort((a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime());
        setExpandedColumn({ label, items: filtered, description });
      }).catch(() => {});
    } else {
      const term = label.toLowerCase();
      const filtered = vaultConversations
        .filter(c => {
          const title = (c.title || "").toLowerCase();
          const preview = (c.preview || "").toLowerCase();
          return title.includes(term) || preview.includes(term);
        })
        .sort((a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime());
      setExpandedColumn({ label, items: filtered });
    }
  }, [vaultConversations]);
  const vaultRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topicClassifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topicClassifyInFlight = useRef(false);

  const queueTopicClassification = useCallback(() => {
    if (topicClassifyTimer.current) clearTimeout(topicClassifyTimer.current);
    topicClassifyTimer.current = setTimeout(() => {
      topicClassifyTimer.current = null;
      if (topicClassifyInFlight.current) return;
      topicClassifyInFlight.current = true;
      cmdKgClassifyNewConversations()
        .catch((err) => { console.warn("[Kept] Topic classification skipped:", err); })
        .finally(() => { topicClassifyInFlight.current = false; });
    }, 30_000); // Wait 30s after last ingestion before classifying
  }, []);
  const [conversationMarkdown, setConversationMarkdown] = useState<string | null>(null);
  const [convLoadError, setConvLoadError] = useState<string | null>(null);
  const isRestricted = appConfig?.privacy_mode === "restricted";

  const enabledTokenProviders = useMemo(() => {
    if (!appConfig) return new Set<string>();
    const restricted = appConfig.privacy_mode === "restricted";
    return new Set<string>(
      TOKEN_PROVIDER_IDS.filter((providerId) => {
        // In restricted mode, disable direct OpenAI/Anthropic API access
        if (restricted && (providerId === "openai" || providerId === "anthropic")) return false;
        switch (providerId) {
          case "openai":
            return hasConfiguredSecret(appConfig.openai_api_key);
          case "anthropic":
            return hasConfiguredSecret(appConfig.anthropic_api_key);
          case "openrouter":
            return hasConfiguredSecret(appConfig.openrouter_api_key);
          default:
            return false;
        }
      }),
    );
  }, [appConfig]);

  useEffect(() => {
    if (!appConfig) {
      setProviderChatModels({});
      return;
    }

    const providerIds = TOKEN_PROVIDER_IDS.filter((providerId) =>
      enabledTokenProviders.has(providerId),
    );
    if (providerIds.length === 0) {
      setProviderChatModels({});
      return;
    }

    let cancelled = false;
    void Promise.all(
      providerIds.map(async (providerId) => {
        try {
          const models = await listModels(providerId, apiKeyForProvider(appConfig, providerId));
          return [
            providerId,
            models
              .filter((model) => !isFreeModelId(model.id))
              .slice(0, 10)
              .map(modelToChatOption),
          ] as const;
        } catch (err) {
          console.warn(`[Kept] Failed to list ${providerId} models:`, err);
          return [providerId, []] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setProviderChatModels(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [appConfig, enabledTokenProviders]);

  const chatModelOptions = useMemo(() => {
    const assigned = (appConfig?.model_assignments?.chat ?? [])
      .filter((entry) => enabledTokenProviders.has(entry.provider) && !isFreeModelId(entry.model))
      .map(assignmentToChatOption);
    const discovered = TOKEN_PROVIDER_IDS.flatMap((providerId) =>
      providerChatModels[providerId] ?? [],
    );
    return dedupeChatModelOptions([...assigned, ...discovered]);
  }, [appConfig, enabledTokenProviders, providerChatModels]);

  const preferredChatModelIds = useMemo(() => {
    const assignments = appConfig?.model_assignments?.chat ?? [];
    const availableIds = new Set(chatModelOptions.map((option) => option.id));
    return assignments
      .map((entry) => `${entry.provider}:${entry.model}`)
      .filter((id, index, ids) => availableIds.has(id) && ids.indexOf(id) === index);
  }, [appConfig, chatModelOptions]);

  const convInfo = useMemo(() => {
    if (!conversationMarkdown) return null;
    const { frontmatter, body } = parseFrontmatter(conversationMarkdown);
    const { title } = parseMessages(body);
    return { frontmatter, title: frontmatter.title || title || "Untitled" };
  }, [conversationMarkdown]);

  const presentSources = useMemo(
    () => new Set(vaultConversations.map(c => c.platform).filter(Boolean)),
    [vaultConversations],
  );

  const refreshVault = useCallback(() => {
    listConversations().then((data) => {
      const applyData = () => {
        setVaultConversations(data);
        vaultLoaded.current = true;
      };
      if (vaultLoaded.current) {
        startTransition(applyData);
        return;
      }
      applyData();
    }).catch(() => {});
  }, []);

  const loadConversation = useCallback((filePath: string) => {
    setConvLoadError(null);
    getConversation(filePath)
      .then(setConversationMarkdown)
      .catch((err) => {
        console.error("Failed to load conversation:", filePath, err);
        setConversationMarkdown(null);
        setConvLoadError(String(err));
      });
  }, []);

  const queueVaultRefresh = useCallback(() => {
    if (vaultRefreshTimer.current) {
      clearTimeout(vaultRefreshTimer.current);
    }
    vaultRefreshTimer.current = setTimeout(() => {
      vaultRefreshTimer.current = null;
      refreshVault();
    }, 150);
  }, [refreshVault]);

  useEffect(() => {
    if (activePage !== "Vault") return;
    if (!vaultLoaded.current) {
      refreshVault();
      return;
    }

    if (vaultRefreshTimer.current) {
      clearTimeout(vaultRefreshTimer.current);
    }
    vaultRefreshTimer.current = setTimeout(() => {
      vaultRefreshTimer.current = null;
      refreshVault();
    }, VAULT_TAB_REFRESH_DELAY_MS);

    return () => {
      if (vaultRefreshTimer.current) {
        clearTimeout(vaultRefreshTimer.current);
        vaultRefreshTimer.current = null;
      }
    };
  }, [activePage, refreshVault]);

  // Refresh vault when window regains focus (e.g. user tabs back from Chrome after extension ingest)
  useEffect(() => {
    const onFocus = () => {
      if (activePage === "Vault") refreshVault();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activePage, refreshVault]);

  useEffect(() => {
    selectedConvPathRef.current = selectedConvPath;
  }, [selectedConvPath]);

  useEffect(() => {
    if (!selectedConvPath) {
      setConversationMarkdown(null);
      setConvLoadError(null);
      return;
    }
    loadConversation(selectedConvPath);
  }, [loadConversation, selectedConvPath]);

  // Reset selection when leaving vault
  useEffect(() => {
    if (activePage !== "Vault") {
      setSelectedConvPath(null);
      setExpandedColumn(null);
      setVaultSearch("");
      setConversationReturnPage(null);
    }
  }, [activePage]);

  // Reset to main settings menu when leaving settings
  useEffect(() => {
    if (activePage !== "Settings") {
      setSettingsSection(null);
      setSettingsReturnPage(null);
    }
  }, [activePage]);

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;

    getVaultPath().then((p) => {
      if (!cancelled) {
        // Show parent dir (e.g. ~/.kept) not the vault subdir
        const parent = p.replace(/\/vault\/?$/, "") || p;
        setVaultLocation(parent);
      }
    }).catch(() => {});

    getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setAppConfig(cfg);

        // Restore operating mode selection and start on appropriate step
        if (cfg.privacy_mode === "flexible" || cfg.privacy_mode === "restricted") {
          setOperatingMode(cfg.privacy_mode);
        }

        setOnboardingState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Failed to load settings:", err);
        setOnboardingState("ready");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Reset grid columns on step change ──
  useEffect(() => {
    onboardTargetCols.current = [...onboardBaseCols];
    onboardCurrentCols.current = [...onboardBaseCols];
    onboardInputFocused.current = false;
    setHoveredPanel(-1);
    // Force-reset the grid element to avoid stale parallax columns
    const el = onboardGridRef.current;
    if (el) {
      el.style.gridTemplateColumns = onboardBaseCols.map(c => `${c}fr`).join(" ");
    }
    // Check extension status when entering step 3
    if (onboardStep === 3) {
      getExtensionStatus().then((s) => {
        setExtensionConnected(s.connected);
        if (!s.connected) setWaitingForExtension(false);
      }).catch(() => {});
    }
    // Check extension status when entering step 4
    if (onboardStep === 4) {
      getExtensionStatus().then((s) => {
        setExtensionConnected(s.connected);
      }).catch(() => {});
    }
  }, [onboardStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Poll for extension connection after clicking Check Connection ──
  useEffect(() => {
    if (!waitingForExtension || extensionConnected) return;
    const pollId = window.setInterval(() => {
      getExtensionStatus().then((s) => {
        if (s.connected) {
          setExtensionConnected(true);
          setWaitingForExtension(false);
        }
      }).catch(() => {});
    }, 1000);
    const timeoutId = window.setTimeout(() => {
      setWaitingForExtension(false);
    }, 5000);
    return () => {
      window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
    };
  }, [waitingForExtension, extensionConnected]);


  // ── Onboarding grid parallax (spring-based, only for multi-column steps) ──
  useEffect(() => {
    if (onboardingState === "ready") return;

    const baseCols = onboardBaseCols;
    const colCount = baseCols.length;

    // Skip parallax for single-column steps — nothing to redistribute
    if (colCount < 2) return;

    const boost = 0.4;
    const sigma = 0.3;
    const colTotal = baseCols.reduce((a, b) => a + b, 0);
    const colCenters: number[] = [];
    let cumulative = 0;
    for (let i = 0; i < colCount; i++) {
      colCenters.push((cumulative + baseCols[i] / 2) / colTotal);
      cumulative += baseCols[i];
    }

    const onMove = (e: MouseEvent) => {
      if (onboardInputFocused.current) return;
      const el = onboardGridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      for (let i = 0; i < colCount; i++) {
        const dist = mx - colCenters[i];
        onboardTargetCols.current[i] = baseCols[i] + boost * Math.exp(-dist * dist / (2 * sigma * sigma));
      }
    };

    const onLeave = () => {
      if (onboardInputFocused.current) return;
      onboardTargetCols.current = [...baseCols];
    };

    const springK = 0.08;
    const damping = 0.75;
    const vel = new Array(colCount).fill(0);

    const tick = () => {
      const el = onboardGridRef.current;
      if (!el) { onboardRafId.current = requestAnimationFrame(tick); return; }
      const curCount = onboardCurrentCols.current.length;
      for (let i = 0; i < curCount; i++) {
        const force = (onboardTargetCols.current[i] - onboardCurrentCols.current[i]) * springK;
        vel[i] = (vel[i] + force) * damping;
        onboardCurrentCols.current[i] += vel[i];
      }
      el.style.transition = "none";
      el.style.gridTemplateColumns = onboardCurrentCols.current.map(c => `${c.toFixed(3)}fr`).join(" ");
      onboardRafId.current = requestAnimationFrame(tick);
    };

    onboardRafId.current = requestAnimationFrame(tick);
    const gridEl = onboardGridRef.current;
    if (gridEl) {
      gridEl.addEventListener("mousemove", onMove);
      gridEl.addEventListener("mouseleave", onLeave);
    }
    return () => {
      cancelAnimationFrame(onboardRafId.current);
      if (gridEl) {
        gridEl.removeEventListener("mousemove", onMove);
        gridEl.removeEventListener("mouseleave", onLeave);
      }
    };
  }, [onboardingState, onboardStep, onboardBaseCols]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Onboarding card squircle clip-paths ──
  useEffect(() => {
    if (onboardingState === "ready") return;
    const cards = onboardCardRefs.current;
    const ro = new ResizeObserver(() => {
      for (const el of cards) {
        if (!el) continue;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (w > 0 && h > 0) {
          const r = responsiveRadius(w, h);
          el.style.clipPath = `path("${squirclePath(w, h, r)}")`;
        }
      }
    });
    for (const el of cards) { if (el) ro.observe(el); }
    return () => ro.disconnect();
  }, [onboardingState]);

  useEffect(() => {
    return () => {
      if (vaultRefreshTimer.current) {
        clearTimeout(vaultRefreshTimer.current);
        vaultRefreshTimer.current = null;
      }
    };
  }, []);

  // Listen for suggest-progress events at App level
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      if (disposed) return;
      listen<{ stage: string; tool_name?: string; iteration: number }>("suggest-progress", (event) => {
        if (disposed) return;
        const { stage, tool_name } = event.payload;
        setSuggestionState(prev => {
          if (!prev || prev.status !== "running") return prev;
          let msg = prev.progress;
          if (stage === "tool_call") {
            if (tool_name === "list_conversations") msg = "Browsing conversations...";
            else if (tool_name === "search_conversations") msg = "Searching keywords...";
            else if (tool_name === "read_conversation") msg = "Reading conversation...";
            else if (tool_name === "recommend_conversation") msg = "Found a match!";
          }
          return { ...prev, progress: msg };
        });
      }).then(fn => { unlisten = fn; });
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauri) return;

    let isDisposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (isDisposed) return;

      unlisten = await listen<VaultConversationIngested>("vault_conversation_ingested", (event) => {
        if (event.payload.skipped) return;

        queueVaultRefresh();
        queueTopicClassification();

        // Count imports during onboarding step 4
        if (importSyncingRef.current) {
          setImportCount(c => c + 1);
        }

        if (selectedConvPathRef.current === event.payload.file_path) {
          loadConversation(event.payload.file_path);
        }
      });
    })().catch((err) => {
      console.error("Failed to listen for vault ingest events:", err);
    });

    return () => {
      isDisposed = true;
      if (unlisten) unlisten();
      if (topicClassifyTimer.current) clearTimeout(topicClassifyTimer.current);
    };
  }, [loadConversation, queueVaultRefresh, queueTopicClassification]);

  // Auto-stop import syncing indicator after an idle period with no new conversations.
  // Use a longer grace period (30s) while waiting for the first result (browser needs to
  // open, extension authenticates, fetches lists, etc.), then a shorter timeout (10s)
  // once conversations start arriving.
  useEffect(() => {
    if (!importSyncing) return;
    const timeout = importCount === 0 ? 30_000 : 10_000;
    const id = window.setTimeout(() => {
      setImportSyncing(false);
      importSyncingRef.current = false;
    }, timeout);
    return () => window.clearTimeout(id);
  }, [importSyncing, importCount]);

  const handleStopImport = useCallback(() => {
    setImportSyncing(false);
    importSyncingRef.current = false;
    stopExtensionSync().catch(() => {});
  }, []);

  const [loading, setLoading] = useState(false);
  const [logoLoading, setLogoLoading] = useState(false);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const streamBufferRef = useRef("");
  const streamFlushTimerRef = useRef<number | null>(null);
  const reasoningStreamBufferRef = useRef("");
  const reasoningStreamFlushTimerRef = useRef<number | null>(null);
  const assistantReasoningRef = useRef("");
  const activeStreamConvIdRef = useRef<string | null>(null);
  const pendingToolsRef = useRef<{ name: string; arguments: unknown }[]>([]);
  const [pendingToolsVersion, setPendingToolsVersion] = useState(0);

  const setChatStatusIfChanged = useCallback((next: string | null) => {
    setChatStatus((prev) => {
      return prev === next ? prev : next;
    });
  }, []);

  const flushStreamingBuffer = useCallback(() => {
    const delta = streamBufferRef.current;
    streamBufferRef.current = "";
    streamFlushTimerRef.current = null;
    if (!delta) return;

    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") {
        next[next.length - 1] = { ...last, content: `${last.content}${delta}` };
      } else {
        next.push({
          role: "assistant",
          content: delta,
          reasoning: assistantReasoningRef.current || undefined,
        });
      }
      return next;
    });
  }, []);

  const flushReasoningStreamingBuffer = useCallback(() => {
    const delta = reasoningStreamBufferRef.current;
    reasoningStreamBufferRef.current = "";
    reasoningStreamFlushTimerRef.current = null;
    if (!delta) return;

    assistantReasoningRef.current += delta;
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") {
        next[next.length - 1] = {
          ...last,
          reasoning: `${last.reasoning ?? ""}${delta}`,
        };
      } else {
        next.push({
          role: "assistant",
          content: "",
          reasoning: assistantReasoningRef.current,
        });
      }
      return next;
    });
  }, []);

  const clearVisibleAssistantContent = useCallback(() => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role !== "assistant" || !last.content) return prev;
      next[next.length - 1] = { ...last, content: "" };
      return next;
    });
  }, []);

  const clearStreamingBuffer = useCallback(() => {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (reasoningStreamFlushTimerRef.current !== null) {
      window.clearTimeout(reasoningStreamFlushTimerRef.current);
      reasoningStreamFlushTimerRef.current = null;
    }
    streamBufferRef.current = "";
    reasoningStreamBufferRef.current = "";
  }, []);

  const appendStreamingDelta = useCallback((delta: string) => {
    if (!delta) return;
    streamBufferRef.current += delta;
    if (streamFlushTimerRef.current === null) {
      streamFlushTimerRef.current = window.setTimeout(flushStreamingBuffer, 64);
    }
  }, [flushStreamingBuffer]);

  const appendReasoningDelta = useCallback((delta: string) => {
    if (!delta) return;
    reasoningStreamBufferRef.current += delta;
    if (reasoningStreamFlushTimerRef.current === null) {
      reasoningStreamFlushTimerRef.current = window.setTimeout(flushReasoningStreamingBuffer, 64);
    }
  }, [flushReasoningStreamingBuffer]);

  useEffect(() => {
    if (loading) {
      const t = setTimeout(() => setLogoLoading(true), 300);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => setLogoLoading(false), 2000);
      return () => clearTimeout(t);
    }
  }, [loading]);

  // Reset status when we're not loading anymore
  useEffect(() => {
    if (!loading) setChatStatusIfChanged(null);
  }, [loading, setChatStatusIfChanged]);

  // Listen for agent-progress events to show what the agent is doing
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<{
        stage: string;
        tool_name?: string;
        tool_arguments?: unknown;
        iteration: number;
        content_delta?: string;
        reasoning_delta?: string;
        conversation_id?: string;
      }>("agent-progress", (event) => {
        const { stage, tool_name, content_delta, reasoning_delta, conversation_id } = event.payload;
        if (conversation_id && activeStreamConvIdRef.current && conversation_id !== activeStreamConvIdRef.current) {
          return;
        }
        if (stage === "tool_call" && tool_name) {
          clearStreamingBuffer();
          clearVisibleAssistantContent();
          setChatStatusIfChanged(statusLabelForTool(tool_name));
          pendingToolsRef.current = [
            ...pendingToolsRef.current,
            { name: tool_name, arguments: event.payload.tool_arguments ?? {} },
          ];
          setPendingToolsVersion((v) => v + 1);
        } else if (stage === "tool_result") {
          setChatStatusIfChanged("Thinking");
        } else if (stage === "thinking") {
          setChatStatusIfChanged("Thinking");
        } else if (stage === "reasoning_delta") {
          setChatStatusIfChanged("Thinking");
          appendReasoningDelta(reasoning_delta ?? "");
        } else if (stage === "message_delta") {
          setChatStatusIfChanged(null);
          appendStreamingDelta(content_delta ?? "");
        } else if (stage === "done") {
          setChatStatusIfChanged(null);
        }
      });
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appendReasoningDelta, appendStreamingDelta, clearStreamingBuffer, clearVisibleAssistantContent, setChatStatusIfChanged]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<ChatContainerHandle>(null);
  const isCompact = useCompact();
  const chatScale = useScale();
  const chatWidth = Math.round(560 * chatScale);

  useEffect(() => {
    let maximized = false;
    let checking = false;
    let lastCheckTime = 0;

    const checkMaximized = async () => {
      if (checking) return;
      checking = true;
      try {
        const win = getCurrentWindow();
        const [m, f] = await Promise.all([win.isMaximized(), win.isFullscreen()]);

        let tiled = false;
        try {
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          const sw = window.screen.width;
          const sh = window.screen.height;
          const fullHeight = pos.y <= 0 && (pos.y + size.height >= sh - 2);
          const touchesLeftOrRight = pos.x <= 0 || (pos.x + size.width >= sw - 2);
          const fullWidth = pos.x <= 0 && (pos.x + size.width >= sw - 2);
          const touchesTopOrBottom = pos.y <= 0 || (pos.y + size.height >= sh - 2);
          tiled = (fullHeight && touchesLeftOrRight) || (fullWidth && touchesTopOrBottom);
        } catch { /* ignore */ }

        maximized = m || f || tiled;
        setIsMaximized(maximized);
      } catch {
        // GTK widget may be invalid after sleep/resume
      } finally {
        checking = false;
      }
    };

    // Leading-edge throttle: run immediately, then skip for 150ms
    const throttledCheck = () => {
      const now = Date.now();
      if (now - lastCheckTime < 150) return;
      lastCheckTime = now;
      checkMaximized();
    };

    checkMaximized();

    const unlistenResize = getCurrentWindow().onResized(() => throttledCheck());
    const unlistenMove = getCurrentWindow().onMoved(() => throttledCheck());

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setTimeout(() => checkMaximized(), 500);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      unlistenResize.then((fn) => fn());
      unlistenMove.then((fn) => fn());
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const persistChat = useCallback((allMessages: ChatUiMessage[]) => {
    const now = new Date().toISOString();
    const payload: IngestPayload = {
      conversation_id: chatConvId.current,
      platform: "kept",
      title: chatTitleRef.current,
      model: chatModelRef.current,
      messages: allMessages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: null,
        reasoning: m.reasoning ?? null,
        tool_calls: m.toolCalls ?? null,
      })),
      created_at: now,
      updated_at: now,
      markdown: null,
      images: null,
    };
    saveKeptChat(payload).catch((err) => console.warn("Failed to persist chat:", err));
  }, []);

  const handleSendMessage = async (text: string, model: string, attachments?: ChatAttachment[]) => {
    const isFirstMessage = messages.length === 0;
    const userMsg: ChatUiMessage = { role: "user", content: text, attachments };
    const newMessages = [...messages, userMsg];
    const convId = chatConvId.current;
    clearStreamingBuffer();
    assistantReasoningRef.current = "";
    pendingToolsRef.current = [];
    setPendingToolsVersion((v) => v + 1);
    activeStreamConvIdRef.current = convId;
    setMessages(newMessages);
    setChatActive(true);
    setLoading(true);
    requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (!container) return;
      const lastUserEl = container.querySelector(
        `[data-chat-msg-index="${newMessages.length - 1}"]`,
      ) as HTMLElement | null;
      const userMsgH = lastUserEl?.offsetHeight ?? 0;
      const initial = Math.max(0, container.clientHeight - userMsgH - 80);
      initialSpacerRef.current = initial;
      setSpacerHeight(initial);

      if (lastUserEl) {
        const top = lastUserEl.offsetTop - 80;
        container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
    });
    try { localStorage.removeItem(`kept_spacer_${convId}`); } catch { /* ignore */ }

    // Tracks the freshest message list across async callbacks (title-gen,
    // agent, error). Every save path reads from here so a late-resolving
    // title callback never overwrites a full (user + assistant) save with
    // its stale user-only copy.
    let latestMessages: ChatUiMessage[] = newMessages;

    const selectedModel = chatModelOptions.find((option) => option.id === model)
      ?? chatModelOptions[0]
      ?? null;
    if (!selectedModel) {
      if (chatConvId.current !== convId) return;
      activeStreamConvIdRef.current = null;
      clearStreamingBuffer();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error: No configured chat provider is available. Add an API key in Settings." },
      ]);
      setLoading(false);
      return;
    }
    const mapped = { platform: selectedModel.providerId, model: selectedModel.modelId };
    chatModelRef.current = mapped.model;

    // Fire title generation in parallel on first message
    if (isFirstMessage) {
      const fallbackTitle = text.length > 50 ? text.slice(0, 50) + "…" : text;
      // Pick the fastest cheap model available for title generation
      const titleReq: TitleRequest = (() => {
        const cfg = appConfig;
        if (hasConfiguredSecret(cfg?.openai_api_key)) return { platform: "openai", model: "gpt-5-nano", message: text };
        if (hasConfiguredSecret(cfg?.anthropic_api_key)) return { platform: "anthropic", model: "claude-haiku-4-5-20251001", message: text };
        if (hasConfiguredSecret(cfg?.openrouter_api_key)) return { platform: "openrouter", model: "openai/gpt-5-nano", message: text };
        return { platform: mapped.platform, model: mapped.model, message: text };
      })();

      const applyTitle = (title: string) => {
        if (chatConvId.current === convId) {
          setChatTitle(title);
          chatTitleRef.current = title;
        }
        const now = new Date().toISOString();
        // Use the latest snapshot (may already include assistant reply) so
        // this save never clobbers a more-complete persist.
        saveKeptChat({
          conversation_id: convId,
          platform: "kept",
          title,
          model: mapped.model,
          messages: latestMessages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: null,
            reasoning: m.reasoning ?? null,
            tool_calls: m.toolCalls ?? null,
          })),
          created_at: now,
          updated_at: now,
          markdown: null,
          images: null,
        }).catch(() => {});
      };

      let resolved = false;
      const fallbackTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          applyTitle(fallbackTitle);
        }
      }, 8000);

      generateTitle(titleReq).then((title) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(fallbackTimer);
          // If the API returned a useless placeholder, use the fallback instead
          const usable = title && title.trim() !== "" && title.trim().toLowerCase() !== "new chat";
          applyTitle(usable ? title.trim() : fallbackTitle);
        }
      }).catch(() => {
        if (!resolved) {
          resolved = true;
          clearTimeout(fallbackTimer);
          applyTitle(fallbackTitle);
        }
      });
    }

    try {
      const request: AgentChatRequest = {
        platform: mapped.platform,
        model: mapped.model,
        messages: newMessages.map((m) => ({
          role: m.role,
          content: m.content,
          attachments: (m as typeof userMsg).attachments?.map(a => ({
            media_type: a.media_type,
            data: a.data,
            filename: a.filename,
          })),
        })),
        event_channel: "agent-progress",
        conversation_id: convId,
      };
      const result = await agentChat(request);
      flushReasoningStreamingBuffer();
      flushStreamingBuffer();
      if (chatConvId.current !== convId) return;
      const reasoning = assistantReasoningRef.current.trim();
      const allMessages: ChatUiMessage[] = [
        ...newMessages,
        {
          role: "assistant",
          content: result.content,
          reasoning: reasoning || undefined,
          toolCalls: result.tool_executions.length > 0
            ? result.tool_executions.map((t) => ({ name: t.tool_name, arguments: t.arguments }))
            : undefined,
        },
      ];
      latestMessages = allMessages;
      setMessages(allMessages);
      persistChat(allMessages);
      pendingToolsRef.current = [];
      setPendingToolsVersion((v) => v + 1);
    } catch (err) {
      clearStreamingBuffer();
      if (chatConvId.current !== convId) return;
      const errMessages = [...newMessages, { role: "assistant", content: `Error: ${err}` }];
      latestMessages = errMessages;
      setMessages(errMessages);
      // Persist even on error so the user's message (and the failure context)
      // survive a reload.
      persistChat(errMessages);
    } finally {
      if (chatConvId.current === convId) {
        setLoading(false);
        activeStreamConvIdRef.current = null;
        try {
          localStorage.setItem(`kept_spacer_${convId}`, String(spacerSnapshotRef.current ?? 0));
        } catch { /* ignore */ }
      }
    }
  };

  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);

  // Chat-view message-sequence rail
  const [chatActiveMsgIdx, setChatActiveMsgIdx] = useState<number | null>(null);
  const [chatHeightsVersion, setChatHeightsVersion] = useState(0);

  const getChatMsgHeight = useCallback((i: number) => {
    const el = messagesContainerRef.current;
    if (!el) return 100;
    const m = el.querySelector(`[data-chat-msg-index="${i}"]`) as HTMLElement | null;
    return m?.offsetHeight ?? 100;
  }, []);

  const chatScrollToMessage = useCallback((i: number) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const m = el.querySelector(`[data-chat-msg-index="${i}"]`) as HTMLElement | null;
    if (!m) return;
    const target = m.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 80;
    el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, []);

  const updateChatActiveMsg = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) { setChatActiveMsgIdx(null); return; }
    const containerTop = el.getBoundingClientRect().top;
    const probeY = containerTop + el.clientHeight * 0.3;
    let bestIdx: number | null = null;
    let bestDist = Infinity;
    const all = el.querySelectorAll("[data-chat-msg-index]");
    all.forEach((node) => {
      const m = node as HTMLElement;
      const idx = Number(m.dataset.chatMsgIndex);
      const r = m.getBoundingClientRect();
      const center = (r.top + r.bottom) / 2;
      const d = Math.abs(center - probeY);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    });
    setChatActiveMsgIdx((prev) => (prev === bestIdx ? prev : bestIdx));
  }, []);

  const checkScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    setFadeTop(el.scrollTop > 8);
    setFadeBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
    updateChatActiveMsg();
  }, [updateChatActiveMsg]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      checkScroll();
      setChatHeightsVersion((v) => v + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkScroll]);

  useEffect(() => { spacerSnapshotRef.current = spacerHeight; }, [spacerHeight]);

  useEffect(() => {
    if (!loading) return;
    const lastIdx = messages.length - 1;
    if (lastIdx < 0 || messages[lastIdx]?.role !== "assistant") return;
    const container = messagesContainerRef.current;
    if (!container) return;
    const target = container.querySelector(
      `[data-chat-msg-index="${lastIdx}"]`,
    ) as HTMLElement | null;
    if (!target) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = entry.contentRect.height;
      const next = Math.max(0, initialSpacerRef.current - h);
      setSpacerHeight((prev) => (prev === next ? prev : next));
    });
    obs.observe(target);
    return () => obs.disconnect();
  }, [loading, messages]);

  // Recompute the rail's gap proportions when message content changes
  // (covers new messages and streaming token updates).
  useEffect(() => {
    setChatHeightsVersion((v) => v + 1);
    updateChatActiveMsg();
  }, [messages, updateChatActiveMsg]);

  const handleNewChat = useCallback(() => {
    clearStreamingBuffer();
    assistantReasoningRef.current = "";
    activeStreamConvIdRef.current = null;
    setMessages([]);
    setSpacerHeight(0);
    setChatTitle("New Chat");
    chatTitleRef.current = "New Chat";
    chatConvId.current = crypto.randomUUID();
    chatModelRef.current = null;
    setChatActive(false);
    setLoading(false);
  }, [clearStreamingBuffer]);

  const handleContinueChat = useCallback((
    msgs: { role: string; content: string; reasoning?: string; toolCalls?: { name: string; arguments: unknown }[] }[],
    title: string,
    conversationId?: string,
  ) => {
    clearStreamingBuffer();
    assistantReasoningRef.current = "";
    activeStreamConvIdRef.current = null;
    setMessages(msgs.map(m => ({
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      toolCalls: m.toolCalls,
    })));
    const stored = Number.parseInt(localStorage.getItem(`kept_spacer_${conversationId || ''}`) ?? '0', 10);
    setSpacerHeight(Number.isFinite(stored) ? stored : 0);
    setChatTitle(title);
    chatTitleRef.current = title;
    chatConvId.current = conversationId || crypto.randomUUID();
    chatModelRef.current = null;
    setChatActive(true);
    setSelectedConvPath(null);
    setActivePage("Chat");
  }, [clearStreamingBuffer, setActivePage]);

  const handleRename = useCallback((newTitle: string) => {
    setChatTitle(newTitle);
    chatTitleRef.current = newTitle;
  }, []);

  const handleExplorerReady = useCallback(() => {
    setExplorerReady(true);
    setBootStatus("Ready");
  }, []);

  useEffect(() => {
    if (!explorerReady) return;
    const t = setTimeout(() => setShowStartupOverlay(false), 550);
    return () => clearTimeout(t);
  }, [explorerReady]);

  const lastMessage = messages[messages.length - 1];
  const hasVisibleStreamingAssistant =
    loading
    && lastMessage?.role === "assistant"
    && (!!lastMessage.content.trim() || !!lastMessage.reasoning?.trim());
  const showChatActivity = loading && !hasVisibleStreamingAssistant;

  return (
    <div
      className="h-full w-full transition-[padding] duration-500 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
      style={{
        padding: isMaximized ? 0 : "6px 8px 8px",
      }}
      onMouseDown={(e) => {
        if (e.button === 0 && e.target === e.currentTarget) {
          getCurrentWindow().startDragging();
        }
      }}
    >
      <div
        id="kept-app-container"
        ref={containerRef}
        className={`relative flex h-full flex-col bg-base overflow-hidden transition-[padding,border-radius] duration-500 ease-[cubic-bezier(0.25,0.1,0.25,1)] ${isMaximized ? "px-2 pb-2" : "px-4 pb-4"}`}
        style={{
          borderRadius: isMaximized ? 0 : `${radius}px`,
          willChange: "border-radius, padding",
        }}
      >
        {/* Inset edge glow — visible at window edges for contrast on dark backgrounds */}
        {!isMaximized && (
          <div
            className="absolute inset-0 pointer-events-none z-[100]"
            style={{
              borderRadius: `${radius}px`,
              boxShadow: "inset 0 0 12px rgba(160, 210, 240, 0.06), inset 0 0 1px rgba(160, 210, 240, 0.12)",
            }}
          />
        )}

        {/* Dim overlay — fades in when the model picker is open, focusing attention on it */}
        <div
          className="absolute inset-0 pointer-events-none z-[60] transition-opacity duration-300 ease-out"
          style={{
            background: "rgba(2,10,13,0.55)",
            opacity: modelDropdownOpen ? 1 : 0,
          }}
        />

        <div ref={titlebarRef}>
        <Titlebar
          isMaximized={isMaximized}
          isCompact={true}
          compactSlot={<CompactNav activePage={activePage} onNavigate={setActivePage} />}
          centerSlot={
            <div style={{ position: "relative", width: "100%", minWidth: 0, pointerEvents: "none" }}>
              {/* Search bar — hidden when viewing a conversation or settings section */}
              <div style={{
                display: "flex",
                justifyContent: "center",
                opacity: (selectedConvPath && activePage === "Vault") || (expandedColumn && activePage === "Vault") || activePage === "Settings" ? 0 : 1,
                pointerEvents: "none",
                transition: "opacity 300ms ease",
              }}>
                <div style={{ pointerEvents: (activePage === "Vault" && !selectedConvPath && !expandedColumn) || (activePage === "Explorer") ? "auto" : "none" }}>
                  <SearchBar onSearch={(q) => { if (activePage === "Explorer") { setExplorerSearch(q); setExplorerSearchZoom(n => n + 1); } else if (activePage === "Vault") { setVaultSearch(q); } }} onChange={(q) => { if (activePage === "Explorer") setExplorerSearch(q); else if (activePage === "Vault") { if (vaultSearchTimer.current) clearTimeout(vaultSearchTimer.current); vaultSearchTimer.current = setTimeout(() => setVaultSearch(q), 200); } }} compact={isCompact} variant={activePage === "Explorer" || activePage === "Vault" ? "dark" : "light"} />
                </div>
              </div>
              {/* Conversation title + meta — shown when viewing a conversation */}
              {selectedConvPath && activePage === "Vault" && convInfo && (
                <div style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                }}>
                  <ConvTitleBar
                    convInfo={convInfo}
                    backLabel={conversationReturnPage ?? "Vault"}
                    onBack={() => {
                      const back = conversationReturnPage;
                      setSelectedConvPath(null);
                      setConversationReturnPage(null);
                      if (back) setActivePage(back);
                    }}
                  />
                </div>
              )}
              {/* Settings section title — shown when in a settings subpage */}
              {settingsSection && activePage === "Settings" && (
                <div style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                }}>
                  <SettingsTitleBar section={settingsSection} backLabel={settingsReturnPage ?? "Settings"} onBack={() => {
                    if (settingsReturnPage) {
                      setSettingsSection(null);
                      setActivePage(settingsReturnPage);
                      setSettingsReturnPage(null);
                      return;
                    }
                    setSettingsSection(null);
                  }} />
                </div>
              )}
              {/* Vault column expanded title — shown when "Show all" is active */}
              {expandedColumn && !selectedConvPath && activePage === "Vault" && (
                <div style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                }}>
                  <VaultColumnTitleBar label={expandedColumn.label} itemCount={expandedColumn.items.length} onBack={() => setExpandedColumn(null)} backLabel="Vault" />
                </div>
              )}
            </div>
          }
          centerSlotVisible={activePage === "Vault" || (activePage === "Explorer" && explorerReady) || activePage === "Settings"}
        />
        </div>

        {/* Dark fade above bottom filter bar — Vault overview */}
        <div
          className="absolute pointer-events-none z-[9]"
          style={{
            left: 0,
            right: 0,
            bottom: 0,
            height: isMaximized ? 120 : 140,
            background: `linear-gradient(to bottom, transparent 0%, var(--color-base) ${isMaximized ? "50%" : "45%"})`,
            opacity: activePage === "Vault" && !selectedConvPath && !expandedColumn ? 1 : 0,
            transition: "opacity 400ms ease",
          }}
        />

        {/* Vault filter bar — horizontal, at bottom on non-compact Vault */}
        <div
          className="absolute z-10"
          style={{
            left: isMaximized ? 40 : 48,
            right: isMaximized ? 40 : 48,
            bottom: isMaximized ? 24 : 32,
            pointerEvents: activePage === "Vault" && !isCompact && !selectedConvPath && !expandedColumn ? "auto" : "none",
          }}
        >
          <VaultFilterBar visible={activePage === "Vault" && !isCompact && !selectedConvPath && !expandedColumn} projectRefreshKey={projectRefreshKey} onSubFilterSelect={handleSubFilterSelect} presentSources={presentSources} />
        </div>

        {/* Animated logo — absolutely positioned, transitions between center and titlebar */}
        <div
          className={`absolute ${modelDropdownOpen ? "z-[1]" : "z-[75]"}`}
          style={{
            left: "50%",
            top: chatActive && activePage === "Chat" ? titlebarCenterY : "50%",
            transform: chatActive && activePage === "Chat"
              ? "translate(-50%, -50%) scale(0.49)"
              : "translate(-50%, -50%) scale(0.65)",
            opacity: activePage === "Chat" ? 1 : 0,
            pointerEvents: activePage === "Chat" ? "auto" : "none",
            willChange: "transform, top, opacity",
            transition: "top 700ms cubic-bezier(0.16,1,0.3,1), transform 500ms cubic-bezier(0.16,1,0.3,1), opacity 500ms cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          <KeptLogoAnimated size={56} speed={logoLoading && activePage === "Chat" ? 2 : 0.15} dimmed={activePage !== "Chat" || !chatActive || !logoLoading} compact={chatActive && activePage === "Chat"} label={chatTitle} hasMessages={messages.length > 0} onNewChat={handleNewChat} onRename={handleRename} />
        </div>

        {/* Explorer page — full-bleed behind titlebar for seamless gradient fade */}
        <div
          className="absolute inset-0 z-[2]"
          inert={activePage !== "Explorer"}
          style={{
            opacity: activePage === "Explorer" ? 1 : 0,
            visibility: activePage === "Explorer" ? "visible" : "hidden",
            transform: activePage === "Explorer" ? "scale(1)" : "scale(0.99)",
            pointerEvents: activePage === "Explorer" ? "auto" : "none",
            transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Explorer" ? "0ms" : "700ms"),
          }}
        >
          <GraphExplorer
            visible={activePage === "Explorer"}
            onReady={handleExplorerReady}
            onStatusChange={setBootStatus}
            searchQuery={explorerSearch}
            searchZoomTrigger={explorerSearchZoom}
            prefetchedData={explorerGraphPrefetch}
            hasApiKey={!!(appConfig?.openai_api_key || appConfig?.anthropic_api_key || appConfig?.openrouter_api_key)}
            onNavigateSettings={() => {
              setSettingsReturnPage("Explorer");
              setActivePage("Settings");
              setSettingsSection("api-access");
            }}
            onOpenConversation={(filePath) => {
              setSelectedConvPath(filePath);
              setConversationReturnPage("Explorer");
              setActivePage("Vault");
            }}
          />
        </div>

        {/* Conversation view — full-bleed in compact mode, behind titlebar with gradient fades */}
        {isCompact && selectedConvPath && activePage === "Vault" && (
          <div
            className="absolute z-[12]"
            style={{
              top: 80,
              bottom: 0,
              left: isMaximized ? 40 : 48,
              right: isMaximized ? 40 : 48,
              pointerEvents: "auto",
            }}
          >
            <ConversationView markdown={conversationMarkdown} visible hideHeader error={convLoadError} onContinueChat={handleContinueChat} />
            {/* Top fade */}
            <div
              className="absolute left-0 right-0 top-0 pointer-events-none"
              style={{
                height: 60,
                background: "linear-gradient(to bottom, var(--color-base) 0%, rgba(2,10,13,0.7) 40%, rgba(2,10,13,0.3) 70%, transparent 100%)",
                zIndex: 1,
              }}
            />
            {/* Bottom fade */}
            <div
              className="absolute left-0 right-0 bottom-0 pointer-events-none"
              style={{
                height: 80,
                background: "linear-gradient(to top, var(--color-base) 0%, var(--color-base) 10%, rgba(2,10,13,0.7) 35%, rgba(2,10,13,0.3) 60%, transparent 100%)",
                zIndex: 1,
              }}
            />
          </div>
        )}

        <main className={`relative flex flex-1 flex-col items-center overflow-hidden ${modelDropdownOpen ? "z-[80]" : "z-[5]"}`} style={{ pointerEvents: activePage === "Explorer" || (isCompact && selectedConvPath && activePage === "Vault") ? "none" : "auto" }}>
          {/* Chat page */}
          <div
            className="flex flex-col items-center w-full min-h-0"
            inert={activePage !== "Chat"}
            style={{
              opacity: activePage === "Chat" ? 1 : 0,
              visibility: activePage === "Chat" ? "visible" : "hidden",
              transform: activePage === "Chat" ? "translateY(0) scale(1)" : "translateY(6px) scale(0.99)",
              pointerEvents: activePage === "Chat" ? "auto" : "none",
              position: "absolute",
              inset: "0 0 24px 0",
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Chat" ? "0ms" : "700ms"),
            }}
          >
            <div
              ref={messagesContainerRef}
              className="flex-1 w-full overflow-y-auto scrollbar-none flex flex-col items-center"
              style={{ position: "relative", zIndex: 0 }}
              onScroll={checkScroll}
            >
              <div className="flex-1" />
              <div className="w-full flex flex-col gap-3 pt-24" style={{ maxWidth: chatWidth }}>
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    data-chat-msg-index={i}
                    style={{
                      width: "100%",
                      color: msg.role === "assistant" ? "#7FB3CC" : "#C3ECFF",
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 15,
                      fontWeight: 500,
                      lineHeight: "1.45",
                      padding: "14px 0",
                    }}
                  >
                    <ChatMessage
                      role={msg.role}
                      content={msg.content}
                      attachments={msg.attachments}
                      reasoning={msg.reasoning}
                      toolCalls={
                        loading && i === messages.length - 1 && msg.role === "assistant"
                          ? (pendingToolsVersion >= 0 ? pendingToolsRef.current : pendingToolsRef.current)
                          : msg.toolCalls
                      }
                      streaming={loading && i === messages.length - 1 && msg.role === "assistant"}
                      thinkingActive={loading && i === messages.length - 1 && msg.role === "assistant" && !!msg.reasoning?.trim() && !msg.content.trim()}
                    />
                  </div>
                ))}
                {pendingConsent && (
                  <div style={{ width: "100%", padding: "6px 0" }}>
                    <InlineCodeConsent
                      pending={pendingConsent}
                      remaining={pendingConsentRemaining}
                      onRespond={respondConsent}
                    />
                  </div>
                )}
                {showChatActivity && (
                  <div
                    style={{
                      color: "#4A7D96",
                      fontFamily: "'DM Sans', sans-serif",
                      fontSize: 15,
                      fontWeight: 500,
                      padding: "10px 0",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {chatStatus && (
                      <span style={{ animation: "pulse 1.6s ease-in-out infinite" }}>
                        {chatStatus}
                      </span>
                    )}
                    <span className="inline-flex gap-1">
                      <span style={{ animation: "pulse 1.4s ease-in-out infinite" }}>.</span>
                      <span style={{ animation: "pulse 1.4s ease-in-out 0.2s infinite" }}>.</span>
                      <span style={{ animation: "pulse 1.4s ease-in-out 0.4s infinite" }}>.</span>
                    </span>
                  </div>
                )}
                {spacerHeight > 0 && (
                  <div
                    aria-hidden
                    style={{ height: spacerHeight, flexShrink: 0 }}
                  />
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
            {/* Top fade overlay — avoids mask-image which causes WebView2 rendering bugs on Windows */}
            <div
              className="absolute left-0 right-0 top-0 pointer-events-none"
              style={{
                height: 80,
                background: "linear-gradient(to bottom, var(--color-base) 0%, rgba(2,10,13,0.7) 40%, rgba(2,10,13,0.3) 70%, transparent 100%)",
                zIndex: 1,
                opacity: chatActive || fadeTop ? 1 : 0,
                transition: "opacity 300ms ease",
              }}
            />
            {/* Bottom fade overlay */}
            <div
              className="absolute left-0 right-0 bottom-0 pointer-events-none"
              style={{
                height: 80,
                background: "linear-gradient(to top, var(--color-base) 0%, rgba(2,10,13,0.7) 40%, rgba(2,10,13,0.3) 70%, transparent 100%)",
                zIndex: 1,
                opacity: fadeBottom ? 1 : 0,
                transition: "opacity 300ms ease",
              }}
            />
            <div style={{ position: "relative", zIndex: 80 }}>
              <ChatContainer
                ref={chatRef}
                onSendMessage={handleSendMessage}
                loading={loading}
                models={chatModelOptions}
                preferredModelIds={preferredChatModelIds}
                onConfigureModels={() => {
                  setSettingsReturnPage("Chat");
                  setActivePage("Settings");
                  setSettingsSection("api-access");
                }}
                onDropdownOpenChange={setModelDropdownOpen}
              />
            </div>
          </div>

          {/* Dashboard page */}
          <div
            className={`flex w-full min-h-0 scrollbar-none ${activePage === "Dashboard" ? "overflow-y-auto" : "overflow-hidden"}`}
            inert={activePage !== "Dashboard"}
            style={{
              opacity: activePage === "Dashboard" ? 1 : 0,
              visibility: activePage === "Dashboard" ? "visible" : "hidden",
              transform: activePage === "Dashboard" ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.99)",
              pointerEvents: activePage === "Dashboard" ? "auto" : "none",
              position: "absolute",
              inset: "0 0 24px 0",
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Dashboard" ? "0ms" : "700ms"),
            }}
          >
            <Dashboard />
          </div>

          {/* Digest page */}
          <div
            className={`flex flex-col items-center w-full min-h-0 scrollbar-none ${activePage === "Digest" ? "overflow-y-auto" : "overflow-hidden"}`}
            inert={activePage !== "Digest"}
            style={{
              opacity: activePage === "Digest" ? 1 : 0,
              visibility: activePage === "Digest" ? "visible" : "hidden",
              transform: activePage === "Digest" ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.99)",
              pointerEvents: activePage === "Digest" ? "auto" : "none",
              position: "absolute",
              inset: "0 0 24px 0",
              zIndex: 6,
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Digest" ? "0ms" : "700ms"),
            }}
          >
            <DigestView
              visible={activePage === "Digest"}
              onOpenConversation={(filePath) => {
                setSelectedConvPath(filePath);
                setActivePage("Vault");
              }}
              onContinueInChat={handleContinueChat}
            />
          </div>

          {/* Coding page */}
          <div
            className={`flex w-full min-h-0 scrollbar-none ${activePage === "Coding" ? "overflow-y-auto" : "overflow-hidden"}`}
            inert={activePage !== "Coding"}
            style={{
              opacity: activePage === "Coding" ? 1 : 0,
              visibility: activePage === "Coding" ? "visible" : "hidden",
              transform: activePage === "Coding" ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.99)",
              pointerEvents: activePage === "Coding" ? "auto" : "none",
              position: "absolute",
              inset: "0 0 24px 0",
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Coding" ? "0ms" : "700ms"),
            }}
          >
            <CodingManager />
          </div>

          {/* Vault page */}
          <div
            className="relative w-full min-h-0 overflow-hidden"
            inert={activePage !== "Vault"}
            style={{
              opacity: activePage === "Vault" ? 1 : 0,
              visibility: activePage === "Vault" ? "visible" : "hidden",
              transform: activePage === "Vault" ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.99)",
              pointerEvents: activePage === "Vault" && !(isCompact && selectedConvPath) ? "auto" : "none",
              position: "absolute",
              inset: "0 0 24px 0",
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Vault" ? "0ms" : "700ms"),
            }}
          >
            {/* Import sync banner */}
            {importSyncing && !selectedConvPath && !expandedColumn && (
              <div style={{
                position: "absolute",
                bottom: 24,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 20,
                background: "rgba(2,10,13,0.85)",
                backdropFilter: "blur(16px)",
                border: "1px solid rgba(195,236,255,0.1)",
                borderRadius: 12,
                padding: "10px 14px 10px 18px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              }}>
                <div style={{
                  width: 18, height: 18,
                  border: "2px solid rgba(195,236,255,0.15)",
                  borderTopColor: "rgba(195,236,255,0.5)",
                  borderRadius: "50%",
                  animation: "spin 800ms linear infinite",
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 13,
                  color: "rgba(195,236,255,0.7)",
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  whiteSpace: "nowrap",
                }}>
                  Importing{importCount > 0 ? ` — ${importCount} saved` : "..."}
                </span>
                <button
                  type="button"
                  onClick={handleStopImport}
                  style={{
                    background: "rgba(248,113,113,0.1)",
                    border: "1px solid rgba(248,113,113,0.18)",
                    borderRadius: 6,
                    padding: "4px 12px",
                    cursor: "pointer",
                    color: "#f87171",
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    fontWeight: 500,
                    transition: "background 200ms ease",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,113,113,0.18)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(248,113,113,0.1)"; }}
                >
                  Stop
                </button>
              </div>
            )}

            {/* Suggestion progress indicator — visible for running, done, and error states */}
            {suggestionState && (
              <div style={{
                position: "absolute",
                top: 12,
                right: 16,
                zIndex: 20,
                background: "rgba(2,10,13,0.85)",
                backdropFilter: "blur(16px)",
                border: `1px solid ${suggestionState.status === "error" ? "rgba(248,113,113,0.2)" : suggestionState.status === "done" ? "rgba(74,222,128,0.15)" : "rgba(195,236,255,0.1)"}`,
                borderRadius: 10,
                padding: "8px 12px 8px 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
                cursor: suggestionState.status === "done" ? "pointer" : "default",
              }}
                onClick={() => {
                  if (suggestionState.status === "done" && suggestionState.recommendations.length > 0) {
                    setShowSuggestionResults(true);
                  }
                }}
              >
                {suggestionState.status === "running" ? (
                  <div style={{
                    width: 14, height: 14,
                    border: "2px solid rgba(195,236,255,0.15)",
                    borderTopColor: "rgba(195,236,255,0.5)",
                    borderRadius: "50%",
                    animation: "spin 800ms linear infinite",
                    flexShrink: 0,
                  }} />
                ) : suggestionState.status === "error" ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
                <span style={{
                  fontSize: 12,
                  color: suggestionState.status === "error" ? "#f87171" : "rgba(195,236,255,0.6)",
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  maxWidth: 500,
                }}>
                  {suggestionState.status === "error"
                    ? `Failed: ${suggestionState.error ?? "Unknown error"}`
                    : suggestionState.status === "done"
                      ? `Found ${suggestionState.recommendations.length} suggestion${suggestionState.recommendations.length === 1 ? "" : "s"} for ${suggestionState.name}`
                      : `${suggestionState.name}: ${suggestionState.progress}`}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); dismissSuggestion(); }}
                  title={suggestionState.status === "running" ? "Stop" : "Dismiss"}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 2,
                    color: "rgba(195,236,255,0.3)",
                    transition: "color 200ms ease",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = suggestionState.status === "running" ? "#f87171" : "rgba(195,236,255,0.7)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195,236,255,0.3)"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}

            {/* Suggestion results panel */}
            {showSuggestionResults && suggestionState && suggestionState.status === "done" && createPortal(
              <SuggestionResultsPanel
                projectId={suggestionState.projectId}
                name={suggestionState.name}
                recommendations={suggestionState.recommendations}
                summary={suggestionState.summary}
                onClose={() => {
                  setShowSuggestionResults(false);
                  refreshVault();
                  setProjectRefreshKey(k => k + 1);
                  // Re-fetch the expanded column's linked conversations
                  if (expandedColumn?.projectId) {
                    const { label, projectId, description } = expandedColumn;
                    setTimeout(() => {
                      Promise.all([listConversations(), cmdKgGetProjects()]).then(([convs, projects]) => {
                        const project = projects.find(p => p.id === projectId);
                        if (!project) return;
                        const linkedIds = new Set(project.conversations.map(c => c.conv_id));
                        const filtered = convs
                          .filter(c => linkedIds.has(c.conversation_id))
                          .sort((a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime());
                        setExpandedColumn({ label, items: filtered, projectId, description });
                      }).catch(() => {});
                    }, 300);
                  }
                }}
              />,
              document.getElementById("kept-app-container") ?? document.body,
            )}

            {/* Overview grid — full page when no conversation selected */}
            <div
              className="absolute inset-0 flex items-stretch"
              style={{
                top: 0,
                left: isCompact ? 32 : 0,
                right: isCompact ? 32 : 0,
                opacity: selectedConvPath || expandedColumn ? 0 : 1,
                pointerEvents: selectedConvPath || expandedColumn ? "none" : "auto",
                transform: selectedConvPath || expandedColumn ? "scale(0.98)" : "scale(1)",
                transition: "opacity 400ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
            >
              {!selectedConvPath && !expandedColumn && (
                <VaultOverview conversations={vaultConversations} onSelect={setSelectedConvPath} onShowAll={setExpandedColumn} searchQuery={vaultSearch} compact={isCompact} visible={activePage === "Vault"} />
              )}
            </div>
            {/* Expanded column view — shown when "Show all" is clicked */}
            <div
              className="absolute inset-0 flex items-stretch"
              style={{
                top: 0,
                left: isCompact ? 32 : 0,
                right: isCompact ? 32 : 0,
                opacity: expandedColumn && !selectedConvPath ? 1 : 0,
                pointerEvents: expandedColumn && !selectedConvPath ? "auto" : "none",
                transform: expandedColumn && !selectedConvPath ? "scale(1)" : "scale(0.98)",
                transition: "opacity 400ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
            >
              {expandedColumn && (
                <VaultColumnExpanded column={expandedColumn} onSelect={(path) => { setSelectedConvPath(path); }} onRefresh={() => {
                  refreshVault();
                  // Re-fetch linked conversations from KG
                  if (expandedColumn?.projectId) {
                    const { label, projectId, description } = expandedColumn;
                    setTimeout(() => {
                      Promise.all([listConversations(), cmdKgGetProjects()]).then(([convs, projects]) => {
                        const project = projects.find(p => p.id === projectId);
                        if (!project) return;
                        const linkedIds = new Set(project.conversations.map(c => c.conv_id));
                        const filtered = convs
                          .filter(c => linkedIds.has(c.conversation_id))
                          .sort((a, b) => new Date(b.updated_at || b.indexed_at).getTime() - new Date(a.updated_at || a.indexed_at).getTime());
                        setExpandedColumn({ label, items: filtered, projectId, description });
                      }).catch(() => {});
                    }, 300);
                  }
                }} onBack={() => { setExpandedColumn(null); refreshVault(); setProjectRefreshKey(k => k + 1); }} onStartSuggestion={startSuggestion} compact={isCompact} />
              )}
            </div>
            {/* Conversation view + sidebar list — non-compact only (compact uses full-bleed layer) */}
            {!isCompact && selectedConvPath && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ left: 0, right: 0 }}
              >
                <div style={{ width: "100%", maxWidth: 800, height: "100%" }}>
                  <ConversationView
                    markdown={conversationMarkdown}
                    visible={activePage === "Vault"}
                    hideHeader
                    error={convLoadError}
                    onContinueChat={handleContinueChat}
                    onRename={(newTitle) => {
                      if (!selectedConvPath) return;
                      renameConversation(selectedConvPath, newTitle).then(() => refreshVault()).catch(() => {});
                    }}
                    onDelete={() => {
                      if (!selectedConvPath) return;
                      deleteConversation(selectedConvPath).then(() => {
                        setSelectedConvPath(null);
                        refreshVault();
                      }).catch(() => {});
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Settings page */}
          <div
            className={`flex w-full min-h-0 scrollbar-none ${activePage === "Settings" ? "overflow-y-auto" : "overflow-hidden"}`}
            inert={activePage !== "Settings"}
            style={{
              opacity: activePage === "Settings" ? 1 : 0,
              visibility: activePage === "Settings" ? "visible" : "hidden",
              transform: activePage === "Settings" ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.99)",
              pointerEvents: activePage === "Settings" ? "auto" : "none",
              position: "absolute",
              inset: "0 0 24px 0",
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (activePage === "Settings" ? "0ms" : "700ms"),
              maskImage: "none",
            }}
          >
            <Settings
              activeSection={settingsSection}
              onSectionChange={setSettingsSection}
              onConfigChange={setAppConfig}
              restrictedMode={isRestricted}
            />
          </div>

          {/* Other pages (placeholder) */}
          <div
            className="flex flex-1 items-center justify-center w-full"
            style={{
              opacity: !["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? 1 : 0,
              visibility: !["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? "visible" : "hidden",
              transform: !["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? "translateY(0) scale(1)" : "translateY(-6px) scale(0.99)",
              pointerEvents: !["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? "auto" : "none",
              position: !["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? "relative" : "absolute",
              inset: !["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? undefined : 0,
              transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (!["Chat", "Explorer", "Dashboard", "Coding", "Vault", "Settings", "Digest"].includes(activePage) ? "0ms" : "700ms"),
            }}
          >
            <span style={{ color: "rgba(195, 236, 255, 0.46)", fontFamily: "'DM Sans', sans-serif", fontSize: 24, fontWeight: 500 }}>
              {activePage}
            </span>
          </div>
        </main>

        {/* Chat message-sequence rail — outside the transformed chat-page wrapper so
            position:fixed anchors to the viewport rather than the wrapper's containing block.
            Anchored to the conversation column's right edge, not the viewport edge. */}
        {activePage === "Chat" && messages.length >= 2 && (
          <div
            style={{
              position: "fixed",
              top: 100,
              bottom: 200,
              left: `calc(50% + ${chatWidth / 2 + 28}px)`,
              width: 32,
              zIndex: 50,
            }}
          >
            <MessageSequence
              messages={messages}
              getHeight={getChatMsgHeight}
              scrollToMessage={chatScrollToMessage}
              scrollRef={messagesContainerRef}
              activeIdx={chatActiveMsgIdx}
              heightsVersion={chatHeightsVersion}
              top={0}
              bottom={0}
              right={0}
            />
          </div>
        )}

        {/* Horizontal filter bar — at bottom, compact Vault only */}
        {isCompact && (
          <div
            className="absolute z-[60]"
            style={{
              bottom: isMaximized ? 24 : 32,
              left: isMaximized ? 40 : 48,
              right: isMaximized ? 40 : 48,
              display: "flex",
              justifyContent: "center",
              opacity: activePage === "Vault" && !selectedConvPath && !expandedColumn ? 1 : 0,
              pointerEvents: activePage === "Vault" && !selectedConvPath && !expandedColumn ? "auto" : "none",
              transform: activePage === "Vault" && !selectedConvPath && !expandedColumn ? "translateY(0)" : "translateY(12px)",
              transition: "opacity 400ms cubic-bezier(0.25,0.1,0.25,1), transform 400ms cubic-bezier(0.25,0.1,0.25,1)",
            }}
          >
            <VaultFilterBar
              compact
              visible={activePage === "Vault" && !selectedConvPath && !expandedColumn}
              projectRefreshKey={projectRefreshKey}
              presentSources={presentSources}
              onSubFilterSelect={handleSubFilterSelect}
              onSubmenuChange={() => {}}
              backButton={selectedConvPath ? (
                <button
                  onClick={() => setSelectedConvPath(null)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "6px 8px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 500,
                    color: "rgba(195, 236, 255, 0.4)",
                    transition: "color 200ms ease",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.7)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195, 236, 255, 0.4)"; }}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back
                </button>
              ) : undefined}
            />
          </div>
        )}

        <UpdateBanner />
        {showStartupOverlay && (
          <div
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              const target = e.target as HTMLElement;
              if (target.closest("button")) return;
              getCurrentWindow().startDragging();
            }}
            className="absolute inset-0 z-[180] flex flex-col items-center justify-center"
            style={{
              background: "#020A0D",
              opacity: explorerReady ? 0 : 1,
              pointerEvents: explorerReady ? "none" : "auto",
              transition: "opacity 500ms cubic-bezier(0.16,1,0.3,1)",
              cursor: "default",
            }}
          >
            <span
              style={{
                fontFamily: '"DM Sans", sans-serif',
                fontWeight: 500,
                fontSize: 20,
                letterSpacing: "-0.02em",
                color: "rgba(195, 236, 255, 0.15)",
                marginBottom: 24,
              }}
            >
              Kept
            </span>
            <span
              style={{
                fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Segoe UI Mono', Menlo, Monaco, Consolas, monospace",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "rgba(195, 236, 255, 0.30)",
              }}
            >
              {bootStatus}
            </span>
          </div>
        )}
        {onboardingState !== "ready" && (
          <div
            ref={onboardRef}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              const target = e.target as HTMLElement;
              if (target.closest("input, button, a, textarea, select, [role='button']")) return;
              getCurrentWindow().startDragging();
            }}
            className="absolute inset-0 z-[210] select-none"
            style={{ background: "var(--color-base)", overflow: "hidden", cursor: "default", userSelect: "none", WebkitUserSelect: "none" }}
          >
            {/* Close button — matches titlebar style */}
            <button
              onClick={() => getCurrentWindow().close()}
              className="cursor-pointer transition-[color,transform] duration-300 ease-out hover:text-orange-400 hover:scale-110 active:scale-95"
              style={{
                position: "absolute",
                top: 32,
                right: 32,
                zIndex: 10,
                background: "transparent",
                border: "none",
                padding: 4,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#4E6D7C",
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            {/* ── Bento grid ── */}
            <div
              className="absolute inset-0 flex flex-col items-center justify-center"
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                const target = e.target as HTMLElement;
                if (target.closest("input, button, a, textarea, select, [role='button'], [data-no-drag]")) return;
                getCurrentWindow().startDragging();
              }}
              style={{
                pointerEvents: onboardingState === "checking" ? "none" : "auto",
              }}
            >
              {/* Step dots */}
              <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
                {[0, 1, 2, 3, 4].map(i => (
                  <div
                    key={i}
                    style={{
                      width: i === onboardStep ? 18 : 6,
                      height: 6,
                      borderRadius: 3,
                      background: i === onboardStep
                        ? "rgba(195,236,255,0.5)"
                        : i < onboardStep
                          ? "rgba(195,236,255,0.25)"
                          : "rgba(195,236,255,0.1)",
                      transition: "width 400ms cubic-bezier(0.16,1,0.3,1), background 400ms ease",
                    }}
                  />
                ))}
              </div>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "clamp(17px, 1.8vw, 22px)",
                  fontWeight: 600,
                  letterSpacing: "-0.03em",
                  color: "var(--color-fg)",
                  fontVariationSettings: '"opsz" 30',
                  marginBottom: 24,
                  opacity: onboardVisible ? 0.85 : 0,
                  transform: onboardVisible ? "translateY(0)" : "translateY(8px)",
                  transition: "opacity 300ms ease, transform 300ms ease",
                }}
              >
                {onboardStep === 0 ? "Vault Location" : onboardStep === 1 ? "Operating Mode" : onboardStep === 2 ? "API Access" : onboardStep === 3 ? "Browser Extension" : "Import Conversations"}
              </span>
              <div
                ref={onboardGridRef}
                style={{
                  display: "grid",
                  gridTemplateColumns: onboardStep === 1 ? "1fr 1fr" : "1fr",
                  gap: 6,
                  width: onboardStep === 1 ? "min(760px, calc(100% - 80px))" : onboardStep === 2 ? "min(680px, calc(100% - 80px))" : "min(520px, calc(100% - 80px))",
                  height: onboardStep === 2 ? "min(380px, calc(100% - 120px))" : onboardStep === 4 ? "min(360px, calc(100% - 120px))" : "min(320px, calc(100% - 120px))",
                  opacity: onboardVisible ? 1 : 0,
                  transform: onboardVisible ? "translateY(0) scale(1)" : "translateY(12px) scale(0.98)",
                  transition: "opacity 300ms ease, transform 300ms cubic-bezier(0.16,1,0.3,1)",
                }}
              >

              {onboardStep === 0 ? (<>
              {/* ── Step 0: Vault Location ── */}

              {/* Vault location card */}
              {(() => {
                const isHovered = hoveredPanel === 0;
                return (
                  <div
                    ref={(el) => { onboardCardRefs.current[0] = el; }}
                    className="relative w-full h-full"
                    style={{ background: "rgb(2,10,13)", overflow: "hidden", borderRadius: 24 }}
                    onMouseEnter={() => setHoveredPanel(0)}
                    onMouseLeave={() => { if (hoveredPanel === 0) setHoveredPanel(-1); }}
                  >
                    <img
                      src="/sources/facility.webp"
                      alt=""
                      draggable={false}
                      className="absolute pointer-events-none select-none"
                      style={{
                        top: 0, left: 0, width: "100%", height: "100%",
                        objectFit: "cover",
                        opacity: isHovered ? 0.55 : 0.45,
                        filter: isHovered
                          ? "blur(12px) saturate(1.5) brightness(1.2)"
                          : "blur(16px) saturate(1.3) brightness(1.2)",
                        willChange: "transform",
                        transition: "opacity 400ms ease, filter 400ms ease",
                        transform: "scale(1.5)",
                      }}
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ zIndex: 1, padding: "clamp(16px, 3vw, 32px)" }}>
                      {/* Safe vault icon */}
                      <svg width="42" height="42" viewBox="-1.5 -1.5 48 48" fill="none" style={{ opacity: 0.5, marginBottom: 20 }}>
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9.107 35.938 7.433 42.59" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m35.893 35.938 1.674 6.651" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M22.5 2.411c-5.25 0-10.744 0-15.308.894-1.986.389-3.525 1.932-3.963 3.907C2.411 10.9 2.411 14.25 2.411 19.454c0 5.204 0 8.554.818 12.242.438 1.975 1.978 3.518 3.963 3.907 4.564.894 10.057.894 15.308.894 5.25 0 10.744 0 15.308-.894 1.985-.389 3.524-1.932 3.963-3.907.818-3.688.818-7.038.818-12.242 0-5.204 0-8.555-.818-12.242-.439-1.975-1.978-3.518-3.963-3.907C33.244 2.411 27.75 2.411 22.5 2.411Z" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m11.25 16.607 0 5.357" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M27.58 24.643a5.357 5.357 0 1 0 0-10.714m0 10.714a5.357 5.357 0 1 1 0-10.714m0 10.714.0001 2.678m-.0001-13.392V11.25m4.64 5.357 2.32-1.34M20.621 23.304l2.32-1.34m9.279 0 2.32 1.34M20.621 15.268l2.32 1.34" />
                      </svg>
                      <p style={{
                        fontSize: "clamp(12px, 1.2vw, 14px)",
                        color: "rgba(195,236,255,0.5)",
                        textAlign: "center",
                        lineHeight: 1.5,
                        maxWidth: 380,
                        margin: "0 0 16px",
                      }}>
                        Your conversations, settings, and search index live here.
                      </p>
                      {/* Path display with inline open button */}
                      <div style={{
                        background: "rgba(255,255,255,0.06)",
                        borderRadius: 10,
                        padding: "10px 12px 10px 20px",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 16,
                        maxWidth: "100%",
                      }}>
                        <span style={{
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: "clamp(13px, 1.2vw, 15px)",
                          color: "var(--color-fg)",
                          letterSpacing: "-0.01em",
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                          {vaultLocation}
                        </span>
                        <button
                          type="button"
                          title="Reveal in file explorer"
                          onClick={async () => {
                            try {
                              const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
                              await revealItemInDir(vaultLocation);
                            } catch { /* browser / mock mode */ }
                          }}
                          style={{
                            background: "transparent",
                            border: "none",
                            borderRadius: 6,
                            padding: 6,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            opacity: 0.4,
                            transition: "opacity 200ms ease",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                      {/* Change + OK buttons */}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const { open } = await import("@tauri-apps/plugin-dialog");
                              const selected = await open({ directory: true, title: "Choose Kept data location" });
                              if (selected) setVaultLocation(selected);
                            } catch { /* browser / mock mode */ }
                          }}
                          style={{
                            background: "rgba(255,255,255,0.07)",
                            border: "none",
                            borderRadius: 10,
                            padding: "10px 18px",
                            cursor: "pointer",
                            color: "var(--color-fg)",
                            fontSize: "clamp(13px, 1.2vw, 14px)",
                            fontFamily: "var(--font-sans)",
                            fontWeight: 500,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            letterSpacing: "-0.02em",
                            transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.12)";
                            e.currentTarget.style.transform = "scale(1.04)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.07)";
                            e.currentTarget.style.transform = "scale(1)";
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={() => goToStep(1)}
                          style={{
                            background: "rgba(255,255,255,0.12)",
                            border: "none",
                            borderRadius: 10,
                            padding: "10px 28px",
                            cursor: "pointer",
                            color: "var(--color-fg)",
                            fontSize: "clamp(13px, 1.2vw, 14px)",
                            fontFamily: "var(--font-sans)",
                            fontWeight: 600,
                            letterSpacing: "-0.02em",
                            transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.18)";
                            e.currentTarget.style.transform = "scale(1.04)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.12)";
                            e.currentTarget.style.transform = "scale(1)";
                          }}
                        >
                          OK
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}

              </>) : onboardStep === 1 ? (<>
              {/* ── Step 1: Operating Mode ── */}

              {/* Restricted card (left) */}
              {(() => {
                const isHovered = hoveredPanel === 0;
                const isSelected = operatingMode === "restricted";
                return (
                  <div
                    ref={(el) => { onboardCardRefs.current[0] = el; }}
                    role="button"
                    className="relative w-full h-full cursor-pointer"
                    style={{
                      background: "rgb(2,10,13)",
                      overflow: "hidden",
                      borderRadius: 24,
                      boxShadow: isSelected
                        ? "0 0 0 2px rgba(255,255,255,0.7), 0 0 32px rgba(255,255,255,0.12)"
                        : "0 0 0 1px rgba(255,255,255,0.06)",
                      transition: "box-shadow 400ms ease",
                    }}
                    onMouseEnter={() => setHoveredPanel(0)}
                    onMouseLeave={() => { if (hoveredPanel === 0) setHoveredPanel(-1); }}
                    onClick={() => {
                      setOperatingMode("restricted");
                      getConfig().then((cfg) => {
                        const next = { ...cfg, privacy_mode: "restricted" };
                        setConfig(next).then(() => setAppConfig(next));
                      });
                      setTimeout(() => goToStep(2), 350);
                    }}
                  >
                    <img
                      src="/sources/private.webp"
                      alt=""
                      draggable={false}
                      className="absolute pointer-events-none select-none"
                      style={{
                        top: 0, left: 0, width: "100%", height: "100%",
                        objectFit: "cover",
                        opacity: isSelected ? 0.65 : isHovered ? 0.55 : 0.45,
                        filter: isSelected
                          ? "blur(10px) saturate(2.8) brightness(1.1) hue-rotate(10deg)"
                          : isHovered
                            ? "blur(12px) saturate(2.5) brightness(1.0) hue-rotate(10deg)"
                            : "blur(16px) saturate(2.2) brightness(0.95) hue-rotate(10deg)",
                        willChange: "transform",
                        transition: "opacity 400ms ease, filter 400ms ease",
                        transform: "scale(1.5)",
                      }}
                    />
                    {/* Center icon */}
                    <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 1 }}>
                      <svg width="42" height="42" viewBox="-1.5 -1.5 48 48" fill="none" style={{ opacity: isSelected ? 0.95 : isHovered ? 0.8 : 0.35, transform: isSelected ? "scale(1.1)" : isHovered ? "scale(1.08)" : "scale(1)", transition: "opacity 400ms ease, transform 500ms cubic-bezier(0.16,1,0.3,1)" }}>
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M2.411 21.958s12.237-.837 20.089-.837 20.089.837 20.089.837" />
                        <path stroke="currentColor" strokeWidth="3.5" d="M15.484 2.838c2.218-.216 4.932-.427 7.069-.427 2.137 0 4.85.21 7.068.426 2.508.244 4.59 2.002 5.249 4.434.58 2.142 1.235 4.767 1.587 6.863.378 2.261.626 5.237.774 7.499-4.254-.235-10.217-.512-14.731-.512-4.477 0-10.378.272-14.625.506.148-2.261.395-5.233.774-7.492.351-2.096 1.007-4.721 1.587-6.863.659-2.432 2.74-4.19 5.248-4.434Z" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M18.997 35.279a5.263 5.263 0 0 1 7.006 0" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M12.583 42.455c4.117 0 6.432-2.316 6.432-6.433s-2.315-6.432-6.432-6.432c-4.117 0-6.433 2.316-6.433 6.432 0 4.117 2.316 6.433 6.433 6.433ZM32.418 42.59c4.117 0 6.432-2.316 6.432-6.433 0-4.117-2.316-6.432-6.432-6.432-4.117 0-6.433 2.315-6.433 6.432 0 4.117 2.316 6.433 6.433 6.433Z" />
                      </svg>
                    </div>
                    <div className="absolute bottom-0 left-0 right-0" style={{ zIndex: 1, padding: "clamp(12px, 2vw, 20px)" }}>
                      <span
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "clamp(14px, 1.6vw, 18px)",
                          fontWeight: 600,
                          letterSpacing: "-0.03em",
                          lineHeight: 1.15,
                          color: "var(--color-fg)",
                          fontVariationSettings: '"opsz" 30',
                          display: "block",
                          transition: "color 300ms ease",
                        }}
                      >
                        Restricted
                      </span>
                      <p style={{
                        fontSize: "clamp(12px, 1.2vw, 14px)",
                        color: "rgba(195,236,255,0.5)",
                        letterSpacing: "-0.01em",
                        margin: "6px 0 0",
                        lineHeight: 1.4,
                        width: 220,
                      }}>
                        No-log models only. Restricted tools and file access.
                      </p>
                    </div>
                  </div>
                );
              })()}

              {/* Flexible card (right) */}
              {(() => {
                const isHovered = hoveredPanel === 1;
                const isSelected = operatingMode === "flexible";
                return (
                  <div
                    ref={(el) => { onboardCardRefs.current[1] = el; }}
                    role="button"
                    className="relative w-full h-full cursor-pointer"
                    style={{
                      background: "rgb(2,10,13)",
                      overflow: "hidden",
                      borderRadius: 24,
                      boxShadow: isSelected
                        ? "0 0 0 2px rgba(255,255,255,0.7), 0 0 32px rgba(255,255,255,0.12)"
                        : "0 0 0 1px rgba(255,255,255,0.06)",
                      transition: "box-shadow 400ms ease",
                    }}
                    onMouseEnter={() => setHoveredPanel(1)}
                    onMouseLeave={() => { if (hoveredPanel === 1) setHoveredPanel(-1); }}
                    onClick={() => {
                      setOperatingMode("flexible");
                      getConfig().then((cfg) => {
                        const next = { ...cfg, privacy_mode: "flexible" };
                        setConfig(next).then(() => setAppConfig(next));
                      });
                      setTimeout(() => goToStep(2), 350);
                    }}
                  >
                    <img
                      src="/sources/network.webp"
                      alt=""
                      draggable={false}
                      className="absolute pointer-events-none select-none"
                      style={{
                        top: 0, left: 0, width: "100%", height: "100%",
                        objectFit: "cover",
                        opacity: isSelected ? 0.65 : isHovered ? 0.55 : 0.45,
                        filter: isSelected
                          ? "blur(10px) saturate(1.6) brightness(1.35)"
                          : isHovered
                            ? "blur(12px) saturate(1.5) brightness(1.2)"
                            : "blur(16px) saturate(1.3) brightness(1.2)",
                        willChange: "transform",
                        transition: "opacity 400ms ease, filter 400ms ease",
                        transform: "scale(1.5)",
                      }}
                    />
                    {/* Center icon */}
                    <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 1 }}>
                      <svg width="42" height="42" viewBox="-1.5 -1.5 48 48" fill="none" style={{ opacity: isSelected ? 0.95 : isHovered ? 0.8 : 0.35, transform: isSelected ? "scale(1.1)" : isHovered ? "scale(1.08)" : "scale(1)", transition: "opacity 400ms ease, transform 500ms cubic-bezier(0.16,1,0.3,1)" }}>
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M1.608 19.567 10.98 5.082A3.214 3.214 0 0 1 14.576 3.214c2.668 0 4.72 2.36 4.351 5.002l-.767 5.484 7.958 0M1.608 38.049c.376.108.812.237 1.3.382 3.945 1.17 11.24 3.028 18.623 3.355 7.065.313 11.97.376 17.25.2 2.589-.087 4.613-2.234 4.613-4.824 0-2.694-2.183-4.877-4.877-4.877l-5.77 0" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M29.926 13.768c-2.069-.143-1.711-.143-3.78 0-2.385.165-4.123 2.23-4.123 4.618 0 2.388 1.738 4.452 4.123 4.617 2.069.144 1.711.144 3.78 0 2.385-.165 4.123-2.23 4.123-4.617 0-2.388-1.738-4.452-4.123-4.618" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" d="M31.533 23.217c-2.069-.144-2.514-.144-4.583 0-2.385.165-4.123 2.23-4.123 4.617 0 2.388 1.738 4.453 4.123 4.618 2.069.143 2.514.143 4.583 0 2.385-.166 4.123-2.23 4.123-4.618 0-2.388-1.738-4.452-4.123-4.617" />
                      </svg>
                    </div>
                    <div className="absolute bottom-0 left-0 right-0" style={{ zIndex: 1, padding: "clamp(12px, 2vw, 20px)" }}>
                      <span
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "clamp(14px, 1.6vw, 18px)",
                          fontWeight: 600,
                          letterSpacing: "-0.03em",
                          lineHeight: 1.15,
                          color: "var(--color-fg)",
                          fontVariationSettings: '"opsz" 30',
                          display: "block",
                          transition: "color 300ms ease",
                        }}
                      >
                        Flexible
                      </span>
                      <p style={{
                        fontSize: "clamp(12px, 1.2vw, 14px)",
                        color: "rgba(195,236,255,0.5)",
                        letterSpacing: "-0.01em",
                        margin: "6px 0 0",
                        lineHeight: 1.4,
                        width: 220,
                      }}>
                        All models, tools, and file access enabled. Data stays local.
                      </p>
                    </div>
                  </div>
                );
              })()}

              </>) : onboardStep === 2 ? (<>
              {/* ── Step 2: API Access ── */}

              {/* BYOK card */}
              {(() => {
                const isHovered = hoveredPanel === 0;
                return (
                  <div
                    ref={(el) => { onboardCardRefs.current[0] = el; }}
                    role="button"
                    className="relative w-full h-full cursor-pointer"
                    style={{ background: "rgb(2,10,13)", overflow: "hidden", borderRadius: 24 }}
                    onMouseEnter={() => setHoveredPanel(0)}
                    onMouseLeave={() => { if (hoveredPanel === 0) setHoveredPanel(-1); }}
                    onClick={() => {
                      setOnboardingState("ready");
                      setSettingsReturnPage("Chat");
                      setActivePage("Settings");
                      setSettingsSection("api-access");
                    }}
                  >
                    <img
                      src="/sources/connection.webp"
                      alt=""
                      draggable={false}
                      className="absolute pointer-events-none select-none"
                      style={{
                        top: 0, left: 0, width: "100%", height: "100%",
                        objectFit: "cover",
                        opacity: isHovered ? 0.55 : 0.45,
                        filter: isHovered
                          ? "blur(12px) saturate(1.5) brightness(1.2)"
                          : "blur(16px) saturate(1.3) brightness(1.2)",
                        willChange: "transform",
                        transition: "opacity 400ms ease, filter 400ms ease",
                        transform: "scale(1.5)",
                      }}
                    />
	                    {/* Center icon */}
                    <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 1 }}>
                      <svg width="42" height="42" viewBox="-1.5 -1.5 48 48" fill="none" style={{ opacity: isHovered ? 0.8 : 0.5, transform: isHovered ? "scale(1.08)" : "scale(1)", transition: "opacity 400ms ease, transform 500ms cubic-bezier(0.16,1,0.3,1)" }}>
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m27.817 26.625-5.885 0" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M17.715 18.772c-2.826-0.53-5.519-0.53-8.345 0" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m13.542 26.625 0-8.25" />
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M2.007 27.97C2.605 32.544 6.518 36.062 11.117 36.42c3.7 0.29 7.503 0.544 11.383 0.544 3.88 0 7.684-0.255 11.383-0.544 4.599-0.358 8.512-3.877 9.11-8.45C43.227 26.176 43.393 24.35 43.393 22.5c0-1.85-0.166-3.676-0.4-5.47-0.598-4.574-4.511-8.092-9.11-8.451C30.184 8.29 26.38 8.036 22.5 8.036c-3.88 0-7.684 0.255-11.383 0.543C6.518 8.938 2.605 12.456 2.007 17.03 1.773 18.824 1.607 20.649 1.607 22.5c0 1.85 0.166 3.676 0.4 5.47Z" />
                      </svg>
                    </div>
                    <div className="absolute bottom-0 left-0 right-0" style={{ zIndex: 1, padding: "clamp(12px, 2vw, 20px)" }}>
                      <span
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "clamp(14px, 1.6vw, 18px)",
                          fontWeight: 600,
                          letterSpacing: "-0.03em",
                          lineHeight: 1.15,
                          color: "var(--color-fg)",
                          fontVariationSettings: '"opsz" 30',
                          display: "block",
                          marginBottom: 12,
                        }}
                      >
                        Bring Your Own Key
                      </span>
                      <p style={{
                        fontSize: "clamp(12px, 1.2vw, 14px)",
                        color: "rgba(195,236,255,0.45)",
                        letterSpacing: 0,
                        margin: "4px 0 14px",
                        lineHeight: 1.45,
                        maxWidth: 320,
                      }}>
                        Connect OpenAI, Anthropic, OpenRouter, or local Ollama from Settings.
                      </p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOnboardingState("ready");
                          setSettingsReturnPage("Chat");
                          setActivePage("Settings");
                          setSettingsSection("api-access");
                        }}
                        style={{
                          background: "rgba(255,255,255,0.12)",
                          backdropFilter: "blur(12px)",
                          color: "var(--color-fg)",
                          border: "none",
                          borderRadius: 10,
                          padding: "10px 22px",
                          fontSize: 13,
                          fontFamily: "var(--font-sans)",
                          fontWeight: 600,
                          letterSpacing: 0,
                          fontVariationSettings: '"opsz" 30',
                          cursor: "pointer",
                          transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "rgba(255,255,255,0.18)";
                          e.currentTarget.style.transform = "scale(1.04)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "rgba(255,255,255,0.12)";
                          e.currentTarget.style.transform = "scale(1)";
                        }}
                      >
                        Open Settings
                      </button>
                    </div>
                  </div>
                );
              })()}

              </>) : onboardStep === 3 ? (<>
              {/* ── Step 3: Browser Extension ── */}

              {/* Extension card */}
              {(() => {
                const isHovered = hoveredPanel === 0;
                void isHovered; // card-level hover not used for effects anymore
                return (
                  <div
                    ref={(el) => { onboardCardRefs.current[0] = el; }}
                    data-no-drag
                    className="relative w-full h-full"
                    style={{ background: "rgb(2,10,13)", overflow: "hidden", borderRadius: 24, cursor: "grab" }}
                    onMouseEnter={() => setHoveredPanel(0)}
                    onMouseLeave={() => { if (hoveredPanel === 0) setHoveredPanel(-1); }}
                    onMouseDownCapture={(e) => {
                      const target = e.target as HTMLElement;
                      if (target.closest("button")) return;
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                    onPointerDown={(e) => {
                      const target = e.target as HTMLElement;
                      if (target.closest("button")) return;
                      e.stopPropagation();
                      e.preventDefault();
                      const card = e.currentTarget;
                      const innerCard = card.querySelector("[data-ext-card]") as HTMLElement;
                      const placeholder = card.querySelector("[data-ext-placeholder]") as HTMLElement;
                      if (!innerCard) return;
                      const rect = innerCard.getBoundingClientRect();
                      const offsetX = e.clientX - rect.left;
                      const offsetY = e.clientY - rect.top;

                      const ghost = innerCard.cloneNode(true) as HTMLElement;
                      ghost.style.position = "fixed";
                      ghost.style.left = `${e.clientX - offsetX}px`;
                      ghost.style.top = `${e.clientY - offsetY}px`;
                      ghost.style.width = `${rect.width}px`;
                      ghost.style.zIndex = "9999";
                      ghost.style.pointerEvents = "none";
                      ghost.style.opacity = "0.95";
                      ghost.style.transform = "scale(1.04)";
                      ghost.style.boxShadow = "0 12px 40px rgba(0,0,0,0.5)";
                      ghost.style.transition = "none";
                      ghost.style.margin = "0";
                      document.body.appendChild(ghost);

                      innerCard.style.opacity = "0";
                      innerCard.style.transform = "scale(0.97)";
                      if (placeholder) placeholder.style.opacity = "1";
                      card.style.cursor = "grabbing";

                      let osDragStarted = false;
                      const fadeZone = 80;

                      const onMove = (ev: PointerEvent) => {
                        ghost.style.left = `${ev.clientX - offsetX}px`;
                        ghost.style.top = `${ev.clientY - offsetY}px`;

                        // Fade out smoothly based on ghost's closest edge to window boundary
                        if (!osDragStarted) {
                          const gx = ev.clientX - offsetX;
                          const gy = ev.clientY - offsetY;
                          const gw = rect.width;
                          const gh = rect.height;
                          const distToEdge = Math.min(
                            gx,
                            gy,
                            window.innerWidth - (gx + gw),
                            window.innerHeight - (gy + gh),
                          );
                          const fade = Math.min(1, Math.max(0, distToEdge / fadeZone));
                          ghost.style.opacity = `${0.95 * fade}`;
                        }

                        const ghostLeft = ev.clientX - offsetX;
                        const ghostTop = ev.clientY - offsetY;
                        const ghostRight = ghostLeft + rect.width;
                        const ghostBottom = ghostTop + rect.height;
                        if (!osDragStarted && (
                          ghostLeft <= 0 || ghostTop <= 0 ||
                          ghostRight >= window.innerWidth ||
                          ghostBottom >= window.innerHeight
                        )) {
                          osDragStarted = true;
                          ghost.remove();
                          const restore = () => {
                            innerCard.style.transition = "opacity 300ms ease, transform 300ms ease";
                            innerCard.style.opacity = "1";
                            innerCard.style.transform = "scale(1)";
                            if (placeholder) placeholder.style.opacity = "0";
                            card.style.cursor = "grab";
                          };
                          getExtensionZip().then(async (zipPath) => {
                            const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
                            await startDrag({ item: [zipPath], icon: "" });
                            // startDrag may resolve immediately on some platforms;
                            // delay restore so the card doesn't pop back during OS drag
                            setTimeout(restore, 800);
                          }).catch(() => {
                            setTimeout(restore, 800);
                          });
                        }
                      };

                      const onUp = () => {
                        document.removeEventListener("pointermove", onMove);
                        document.removeEventListener("pointerup", onUp);
                        if (!osDragStarted) {
                          ghost.style.transition = "all 300ms cubic-bezier(0.16,1,0.3,1)";
                          ghost.style.left = `${rect.left}px`;
                          ghost.style.top = `${rect.top}px`;
                          ghost.style.transform = "scale(1)";
                          ghost.style.opacity = "0";
                          innerCard.style.opacity = "1";
                          innerCard.style.transform = "scale(1)";
                          if (placeholder) placeholder.style.opacity = "0";
                          card.style.cursor = "grab";
                          setTimeout(() => ghost.remove(), 300);
                        }
                      };

                      document.addEventListener("pointermove", onMove);
                      document.addEventListener("pointerup", onUp);
                    }}
                  >
                    <img
                      src="/sources/network.webp"
                      alt=""
                      draggable={false}
                      className="absolute pointer-events-none select-none"
                      style={{
                        top: 0, left: 0, width: "100%", height: "100%",
                        objectFit: "cover",
                        opacity: 0.45,
                        filter: "blur(16px) saturate(1.3) brightness(1.2)",
                        willChange: "transform",
                        transition: "opacity 400ms ease, filter 400ms ease",
                        transform: "scale(1.5)",
                      }}
                    />
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center"
                      style={{ zIndex: 1, padding: "clamp(16px, 3vw, 32px)", background: "rgba(2, 10, 13, 0.55)", backdropFilter: "blur(4px)" }}
                    >
                      {extensionConnected ? (<>
                        {/* Connected state */}
                        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" style={{ opacity: 1, marginBottom: 16 }}>
                          <path d="M20 6L9 17l-5-5" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: "clamp(14px, 1.4vw, 17px)",
                          fontWeight: 600,
                          color: "#4ade80",
                          marginBottom: 8,
                        }}>
                          Extension Connected
                        </span>
                        <p style={{
                          fontSize: "clamp(12px, 1.2vw, 14px)",
                          color: "rgba(195,236,255,0.5)",
                          textAlign: "center",
                          lineHeight: 1.5,
                          maxWidth: 340,
                          margin: "0 0 20px",
                        }}>
                          Your AI conversations will sync automatically.
                        </p>
                        <button
                          type="button"
                          onClick={() => goToStep(4)}
                          style={{
                            background: "rgba(255,255,255,0.12)",
                            border: "none",
                            borderRadius: 10,
                            padding: "10px 32px",
                            cursor: "pointer",
                            color: "var(--color-fg)",
                            fontSize: "clamp(13px, 1.2vw, 14px)",
                            fontFamily: "var(--font-sans)",
                            fontWeight: 600,
                            letterSpacing: "-0.02em",
                            transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                                                      }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.18)";
                                                        e.currentTarget.style.transform = "scale(1.04)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "rgba(255,255,255,0.12)";
                                                        e.currentTarget.style.transform = "scale(1)";
                          }}
                        >
                          Next
                        </button>
                      </>) : (<>
                        {/* Not connected — drag to install */}
                        <p style={{
                          fontSize: "clamp(12px, 1.2vw, 14px)",
                          color: "rgba(195,236,255,0.5)",
                          textAlign: "center",
                          lineHeight: 1.6,
                          maxWidth: 380,
                          margin: "0 0 14px",
                        }}>
                          Open your browser's <strong style={{ color: "var(--color-fg)", fontWeight: 600 }}>extensions page</strong>, enable <strong style={{ color: "var(--color-fg)", fontWeight: 600 }}>Developer Mode</strong>, then drag this onto the page:
                        </p>
                        {/* Dashed placeholder — visible when zip box is dragged away */}
                        <div
                          data-ext-placeholder
                          style={{
                            border: "2px dashed rgba(186,232,255,0.15)",
                            borderRadius: 14,
                            padding: "16px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: 0,
                            transition: "opacity 300ms ease",
                            pointerEvents: "none",
                            position: "absolute",
                            left: "50%",
                            top: "50%",
                            transform: "translate(-50%, -50%)",
                            minWidth: 220,
                            minHeight: 50,
                          }}
                        >
                          <span style={{
                            fontFamily: "var(--font-sans)",
                            fontSize: 13,
                            fontWeight: 500,
                            color: "rgba(186,232,255,0.2)",
                            letterSpacing: "-0.01em",
                          }}>
                            Drop on the extensions page
                          </span>
                        </div>
                        {/* Visual zip box — light mode, squircled, hover-scales */}
                        <div
                          data-ext-card
                          onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            el.style.transform = "scale(1.06)";
                            el.style.filter = "brightness(1.05)";
                          }}
                          onMouseLeave={(e) => {
                            const el = e.currentTarget;
                            el.style.transform = "scale(1)";
                            el.style.filter = "brightness(1)";
                          }}
                          style={{
                            background: "linear-gradient(135deg, rgba(232,244,251,0.92) 0%, rgba(214,236,248,0.90) 50%, rgba(200,228,244,0.88) 100%)",
                            clipPath: `path("${squirclePath(220, 54, 16)}")`,
                            padding: "4px 12px 4px 4px",
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            width: 220,
                            height: 54,
                            transition: "transform 300ms cubic-bezier(0.16,1,0.3,1), filter 300ms ease, opacity 200ms ease",
                            pointerEvents: "auto",
                            transform: "scale(1)",
                            marginBottom: 14,
                          }}
                        >
                          <img
                            src="/sources/kept-globe.webp"
                            alt="Kept"
                            draggable={false}
                            style={{
                              width: 46,
                              height: 46,
                              borderRadius: 14,
                              flexShrink: 0,
                              objectFit: "cover",
                            }}
                          />
                          <div style={{ lineHeight: 1.15 }}>
                            <span style={{
                              fontFamily: "var(--font-mono, monospace)",
                              fontSize: "clamp(12px, 1.1vw, 13px)",
                              fontWeight: 550,
                              color: "#0C2937",
                              letterSpacing: "-0.01em",
                              display: "block",
                            }}>
                              kept-extension.zip
                            </span>
                            <span style={{
                              fontSize: "clamp(11px, 1.1vw, 14px)",
                              fontWeight: 500,
                              color: "rgba(12,41,55,0.5)",
                            }}>
                              Drag to extensions page
                            </span>
                          </div>
                        </div>
                        {waitingForExtension ? (
                          <span style={{
                            fontSize: "clamp(12px, 1.1vw, 13px)",
                            color: "rgba(195,236,255,0.4)",
                            fontFamily: "var(--font-sans)",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1.2s linear infinite" }}>
                              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                            Waiting for extension...
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              refreshToken().catch(() => {});
                              setWaitingForExtension(true);
                            }}
                            style={{
                              background: "rgba(255,255,255,0.12)",
                              border: "none",
                              borderRadius: 10,
                              padding: "10px 20px",
                              cursor: "pointer",
                              color: "var(--color-fg)",
                              fontSize: "clamp(13px, 1.2vw, 14px)",
                              fontFamily: "var(--font-sans)",
                              fontWeight: 600,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              letterSpacing: "-0.02em",
                              transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                                                          }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = "rgba(255,255,255,0.18)";
                                                              e.currentTarget.style.transform = "scale(1.04)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = "rgba(255,255,255,0.12)";
                                                              e.currentTarget.style.transform = "scale(1)";
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Check connection
                          </button>
                        )}
                      </>)}
                    </div>
                  </div>
                );
              })()}

              </>) : (<>
              {/* ── Step 4: Import Conversations ── */}

              {(() => {
                const isHovered = hoveredPanel === 0;
                return (
                  <div
                    ref={(el) => { onboardCardRefs.current[0] = el; }}
                    className="relative w-full h-full"
                    style={{ background: "rgb(2,10,13)", overflow: "hidden", borderRadius: 24 }}
                    onMouseEnter={() => setHoveredPanel(0)}
                    onMouseLeave={() => { if (hoveredPanel === 0) setHoveredPanel(-1); }}
                  >
                    <img
                      src="/sources/kept-globe.webp"
                      alt=""
                      draggable={false}
                      className="absolute pointer-events-none select-none"
                      style={{
                        top: 0, left: 0, width: "100%", height: "100%",
                        objectFit: "cover",
                        opacity: isHovered ? 0.55 : 0.45,
                        filter: isHovered
                          ? "blur(12px) saturate(1.5) brightness(1.2)"
                          : "blur(16px) saturate(1.3) brightness(1.2)",
                        willChange: "transform",
                        transition: "opacity 400ms ease, filter 400ms ease",
                        transform: "scale(1.5)",
                      }}
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ zIndex: 1, padding: "clamp(12px, 2vw, 24px)" }}>
                      {importSyncing ? (<>
                        {/* Syncing state */}
                        <div style={{
                          width: 32, height: 32, marginBottom: 16,
                          border: "2px solid rgba(195,236,255,0.15)",
                          borderTopColor: "rgba(195,236,255,0.5)",
                          borderRadius: "50%",
                          animation: "spin 800ms linear infinite",
                        }} />
                        <p style={{
                          fontSize: "clamp(13px, 1.3vw, 15px)",
                          color: "rgba(195,236,255,0.7)",
                          textAlign: "center",
                          fontWeight: 500,
                          lineHeight: 1.5,
                          marginBottom: 14,
                        }}>
                          Importing conversations... {importCount > 0 && <span style={{ color: "var(--color-fg)" }}>{importCount} saved</span>}
                        </p>
                        <button
                          type="button"
                          onClick={handleStopImport}
                          style={{
                            background: "rgba(248,113,113,0.1)",
                            border: "1px solid rgba(248,113,113,0.2)",
                            borderRadius: 8,
                            padding: "7px 20px",
                            cursor: "pointer",
                            color: "#f87171",
                            fontSize: 13,
                            fontFamily: "var(--font-sans)",
                            fontWeight: 500,
                            letterSpacing: "-0.01em",
                            transition: "all 200ms ease",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,113,113,0.18)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(248,113,113,0.1)"; }}
                        >
                          Stop Import
                        </button>
                      </>) : importCount > 0 ? (<>
                        {/* Done state */}
                        <div style={{
                          background: "rgba(74,222,128,0.08)",
                          border: "1px solid rgba(74,222,128,0.15)",
                          borderRadius: 12,
                          padding: "16px 24px",
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          maxWidth: 380,
                        }}>
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, color: "#4ade80" }}>
                            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <div>
                            <p style={{
                              fontSize: 15,
                              color: "var(--color-fg)",
                              fontWeight: 600,
                              fontFamily: "var(--font-sans)",
                              letterSpacing: "-0.02em",
                              margin: 0,
                            }}>
                              {importCount} conversation{importCount === 1 ? "" : "s"} imported
                            </p>
                            <p style={{
                              fontSize: 13,
                              color: "rgba(195,236,255,0.45)",
                              margin: "4px 0 0",
                              lineHeight: 1.4,
                            }}>
                              Your conversations are ready to explore.
                            </p>
                          </div>
                        </div>
                      </>) : (<>
                        {/* Selection state */}
                        {!extensionConnected ? (<>
                          <p style={{
                            fontSize: "clamp(12px, 1.2vw, 14px)",
                            color: "rgba(195,236,255,0.4)",
                            textAlign: "center",
                            lineHeight: 1.5,
                            maxWidth: 340,
                            margin: "0 0 16px",
                          }}>
                            Connect the browser extension to import conversations from AI providers.
                          </p>
                          {waitingForExtension ? (
                            <span style={{
                              fontSize: "clamp(12px, 1.1vw, 13px)",
                              color: "rgba(195,236,255,0.4)",
                              fontFamily: "var(--font-sans)",
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1.2s linear infinite" }}>
                                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                              </svg>
                              Waiting for extension...
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                refreshToken().catch(() => {});
                                setWaitingForExtension(true);
                              }}
                              style={{
                                background: "rgba(255,255,255,0.12)",
                                border: "none",
                                borderRadius: 10,
                                padding: "10px 20px",
                                cursor: "pointer",
                                color: "var(--color-fg)",
                                fontSize: "clamp(13px, 1.2vw, 14px)",
                                fontFamily: "var(--font-sans)",
                                fontWeight: 600,
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                letterSpacing: "-0.02em",
                                transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = "rgba(255,255,255,0.18)";
                                e.currentTarget.style.transform = "scale(1.04)";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = "rgba(255,255,255,0.12)";
                                e.currentTarget.style.transform = "scale(1)";
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              Check connection
                            </button>
                          )}
                        </>) : (<>
                          {/* Provider toggles */}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 16, maxWidth: 420 }}>
                            {([
                              ["chatgpt", "ChatGPT"],
                              ["claude", "Claude"],
                              ["gemini", "Gemini"],
                              ["grok", "Grok"],
                              ["kimi", "Kimi"],
                            ] as const).map(([id, label]) => {
                              const enabled = importProviders[id];
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => setImportProviders(p => ({ ...p, [id]: !p[id] }))}
                                  style={{
                                    background: enabled ? "rgba(195,236,255,0.12)" : "rgba(195,236,255,0.03)",
                                    border: `1px solid ${enabled ? "rgba(195,236,255,0.2)" : "rgba(195,236,255,0.06)"}`,
                                    borderRadius: 8,
                                    padding: "6px 14px",
                                    cursor: "pointer",
                                    color: enabled ? "var(--color-fg)" : "rgba(195,236,255,0.3)",
                                    fontSize: 13,
                                    fontFamily: "var(--font-sans)",
                                    fontWeight: 500,
                                    letterSpacing: "-0.01em",
                                    transition: "all 200ms ease",
                                  }}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>

                          {/* Limit toggle */}
                          <div style={{
                            display: "flex", gap: 0, marginBottom: 18,
                            background: "rgba(195,236,255,0.04)",
                            borderRadius: 8,
                            border: "1px solid rgba(195,236,255,0.06)",
                            overflow: "hidden",
                          }}>
                            {([50, 100, 250, 0] as const).map((limit) => {
                              const active = importLimit === limit;
                              return (
                                <button
                                  key={limit}
                                  type="button"
                                  onClick={() => setImportLimit(limit)}
                                  style={{
                                    background: active ? "rgba(195,236,255,0.1)" : "transparent",
                                    border: "none",
                                    padding: "7px 16px",
                                    cursor: "pointer",
                                    color: active ? "var(--color-fg)" : "rgba(195,236,255,0.35)",
                                    fontSize: 13,
                                    fontFamily: "var(--font-sans)",
                                    fontWeight: active ? 600 : 400,
                                    letterSpacing: "-0.01em",
                                    transition: "all 200ms ease",
                                  }}
                                >
                                  {limit === 0 ? "All" : `Latest ${limit}`}
                                </button>
                              );
                            })}
                          </div>

                          {/* Start button */}
                          <button
                            type="button"
                            disabled={!Object.values(importProviders).some(Boolean)}
                            onClick={() => {
                              const selected = Object.entries(importProviders).filter(([, v]) => v).map(([k]) => k);
                              if (selected.length === 0) return;
                              setImportSyncing(true);
                              importSyncingRef.current = true;
                              requestExtensionSync(selected, importLimit).catch(() => {});
                            }}
                            style={{
                              background: Object.values(importProviders).some(Boolean) ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
                              border: "none",
                              borderRadius: 10,
                              padding: "10px 28px",
                              cursor: Object.values(importProviders).some(Boolean) ? "pointer" : "default",
                              color: Object.values(importProviders).some(Boolean) ? "var(--color-fg)" : "rgba(195,236,255,0.25)",
                              fontSize: "clamp(13px, 1.2vw, 14px)",
                              fontFamily: "var(--font-sans)",
                              fontWeight: 600,
                              letterSpacing: "-0.02em",
                              transition: "all 350ms cubic-bezier(0.34,1.56,0.64,1)",
                            }}
                            onMouseEnter={(e) => {
                              if (Object.values(importProviders).some(Boolean)) {
                                e.currentTarget.style.background = "rgba(255,255,255,0.18)";
                                e.currentTarget.style.transform = "scale(1.04)";
                              }
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = Object.values(importProviders).some(Boolean) ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)";
                              e.currentTarget.style.transform = "scale(1)";
                            }}
                          >
                            Start Import
                          </button>
                        </>)}
                      </>)}
                    </div>
                  </div>
                );
              })()}

              </>)}
              </div>

              {/* "Skip for now" / "Done" button below the grid */}
              {(onboardStep === 2 || (onboardStep === 3 && !extensionConnected) || (onboardStep === 4 && !importSyncing)) && (
                <button
                  type="button"
                  onClick={() => {
                    if (onboardStep === 2) {
                      goToStep(3);
                    } else if (onboardStep === 3) {
                      goToStep(4);
                    } else {
                      setOnboardingState("ready");
                      setActivePage("Chat");
                      setSettingsSection(null);
                      setSettingsReturnPage(null);
                    }
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "rgba(195,236,255,0.4)",
                    opacity: onboardVisible ? 1 : 0,
                    transform: onboardVisible ? "translateY(0)" : "translateY(6px)",
                    fontSize: "clamp(13px, 1.3vw, 15px)",
                    fontFamily: "var(--font-sans)",
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    marginTop: 18,
                    padding: "8px 4px",
                    transition: "color 200ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(195,236,255,0.7)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(195,236,255,0.4)"; }}
                >
                  {onboardStep === 4 ? (importCount > 0 ? "Done" : "Skip for now") : "Skip for now"}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>

            {/* ── Checking overlay ── */}
            {onboardingState === "checking" && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{
                  background: "rgba(2, 10, 13, 0.6)",
                  backdropFilter: "blur(8px)",
                  zIndex: 2,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          background: "var(--color-fg-muted)",
                          animation: `pulse 1.4s ease-in-out ${i * 200}ms infinite`,
                        }}
                      />
                    ))}
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--color-fg-faint)",
                    }}
                  >
                    Verifying
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        {!isMaximized && <ResizeGrips />}
      </div>
    </div>
  );
}
