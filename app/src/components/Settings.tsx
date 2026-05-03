import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getConfig,
  setConfig,
  getVaultPath,
  getVaultStats,
  openVault,
  reindex,
  cmdKgStats,
  cmdKgIndexVault,
  cmdKgResetDb,
  listModels,
  exportValidate,
  exportToObsidian,
  revealFile,
  getExtensionZip,
  getExtensionStatus,
  validatePath,
} from "../lib/tauri-api";
import type { AppConfig, AvailableModel, KgStats, VaultStats, ModelEntry } from "../lib/types";
import { squirclePath } from "../lib/squircle";

// ── Helpers ──────────────────────────────────────────────────

function maskKey(key: string | null): string {
  if (!key) return "";
  if (key.length <= 8) return "*".repeat(key.length);
  return key.slice(0, 4) + "*".repeat(Math.min(20, key.length - 8)) + key.slice(-4);
}

function isFreeModelId(modelId: string | null | undefined): boolean {
  return !!modelId?.trim().toLowerCase().endsWith(":free");
}

// ── Section definitions ─────────────────────────────────────

const SECTIONS = [
  { id: "api-access", label: "API\nAccess", description: "Providers & models", image: "/sources/connection.webp" },
  { id: "general", label: "General", description: "App settings", image: "/sources/models.webp" },
  { id: "knowledge-graph", label: "Knowledge\nGraph", description: "Entity extraction", image: "/sources/network.webp" },
  { id: "vault", label: "Vault", description: "Storage & data", image: "/sources/facility.webp" },
] as const;

export type SectionId = typeof SECTIONS[number]["id"];

const API_PROVIDERS = [
  {
    name: "OpenAI",
    description: "GPT models for chat and knowledge graph extraction",
    image: "/sources/chatgpt.webp",
    configKey: "openai_api_key" as keyof AppConfig,
    placeholder: "sk-...",
    brightness: 1.6,
    secretLabel: "API key",
    providerSlug: "openai",
  },
  {
    name: "Anthropic",
    description: "Claude models for chat and knowledge graph extraction",
    image: "/sources/claude.webp",
    configKey: "anthropic_api_key" as keyof AppConfig,
    placeholder: "sk-ant-...",
    brightness: 1.2,
    secretLabel: "API key",
    providerSlug: "anthropic",
  },
  {
    name: "OpenRouter",
    description: "Route to 300+ models from any provider",
    image: "/sources/models.webp",
    configKey: "openrouter_api_key" as keyof AppConfig,
    placeholder: "sk-or-...",
    brightness: 1.0,
    secretLabel: "API key",
    providerSlug: "openrouter",
  },
];

function getModelSummary(config: AppConfig, providerSlug: string): string {
  const assignments = config.model_assignments;
  if (!assignments) return "";
  const parts: string[] = [];
  const chatModels = (assignments.chat ?? []).filter(m => m.provider === providerSlug);
  if (chatModels.length > 0) {
    parts.push(chatModels.map(m => m.model).join(", "));
  }
  const agenticModel = (assignments.agentic ?? []).find(m => m.provider === providerSlug);
  if (agenticModel) {
    parts.push(`Agent: ${agenticModel.model}`);
  }
  return parts.join(" · ");
}

const TASK_COLUMNS = [
  { key: "chat", label: "General\nChat", description: "Chat completions", image: "/sources/assistant.webp", brightness: 1.2, baseWeight: 1.4 },
  { key: "agentic", label: "Agentic\nTasks", description: "Tool-using agent loops", image: "/sources/tools.webp", brightness: 1.0, baseWeight: 1.0 },
  { key: "kg_extraction", label: "KG\nExtraction", description: "Entity extraction", image: "/sources/network.webp", brightness: 1.1, baseWeight: 0.9 },
  { key: "embeddings", label: "Embeddings", description: "Entity deduplication", image: "/sources/models.webp", brightness: 1.0, baseWeight: 0.8 },
] as const;

type TaskKey = typeof TASK_COLUMNS[number]["key"];

// ── Bento card with parallax ────────────────────────────────

function BentoCard({
  label,
  description,
  image,
  isHovered,
  onClick,
  onEnter,
  onLeave,
}: {
  label: string;
  description: string;
  image: string;
  isHovered: boolean;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [clip, setClip] = useState("inset(0 round 20px)");
  const handleMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMouse({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  // Compute squircle clip-path on resize
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) {
        setClip(`path("${squirclePath(w, h, 24)}")`);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const w = ref.current?.offsetWidth || 300;
  const h = ref.current?.offsetHeight || 200;

  return (
    <div
      ref={ref}
      className="relative w-full h-full cursor-pointer"
      style={{ clipPath: clip, background: "rgb(2,10,13)", overflow: "hidden", borderRadius: 24 }}
      onMouseMove={handleMove}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      {/* Background image — edge to edge, blurred to match ProviderCard's
          frosted-haze treatment in the API Access submenu. Hover lifts the blur
          (12px) so the artwork resolves under the cursor; idle is heavier (16px). */}
      <img
        src={image}
        alt=""
        draggable={false}
        className="absolute pointer-events-none select-none"
        style={{
          inset: -1,
          width: "calc(100% + 2px)",
          height: "calc(100% + 2px)",
          objectFit: "cover",
          opacity: isHovered ? 0.85 : 0.55,
          filter: isHovered
            ? "blur(12px) saturate(1.5)"
            : "blur(16px) saturate(1.3)",
          willChange: "transform, filter",
          transition: "opacity 400ms ease, filter 400ms ease, transform 600ms cubic-bezier(0.16,1,0.3,1)",
          transform: isHovered
            ? `scale(1.16) translate(${(mouse.x / w - 0.5) * -6}px, ${(mouse.y / h - 0.5) * -6}px)`
            : "scale(1.08)",
        }}
      />

      {/* Parallax glow */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 280,
          height: 280,
          left: mouse.x - 140,
          top: mouse.y - 140,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(59,158,204,0.12) 0%, transparent 70%)",
          opacity: isHovered ? 1 : 0,
          transition: "opacity 400ms ease",
        }}
      />

      {/* Bottom gradient scrim for text legibility */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "linear-gradient(to top, rgba(2,10,13,0.85) 0%, rgba(2,10,13,0.35) 35%, transparent 60%)",
        }}
      />

      {/* Label — bottom-left */}
      <div className="absolute bottom-0 left-0" style={{ zIndex: 1, padding: "clamp(12px, 2vw, 20px)" }}>
        <span
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: "clamp(16px, 2.2vw, 28px)",
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1.15,
            color: "var(--color-fg)",
            whiteSpace: "pre-line",
          }}
        >
          {label}
        </span>
        <p
          style={{
            fontSize: "clamp(14px, 1.6vw, 20px)",
            color: "var(--color-fg-muted)",
            letterSpacing: "-0.01em",
            margin: "4px 0 0",
          }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}

// ── Provider card — frosted glass ────────────────────────────

function ProviderCard({
  name,
  image,
  hasKey,
  value,
  placeholder,
  index,
  brightness,
  editing,
  modelSummary,
  isPrimary,
  onClick,
  onDelete,
}: {
  name: string;
  image: string;
  hasKey: boolean;
  value: string | null;
  placeholder: string;
  index: number;
  brightness: number;
  editing: boolean;
  modelSummary?: string;
  isPrimary?: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [clip, setClip] = useState("inset(0 round 20px)");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) setClip(`path("${squirclePath(w, h, 20)}")`);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="relative w-full h-full"
      style={{
        clipPath: clip,
        overflow: "hidden",
        borderRadius: 20,
        background: "var(--color-base)",
        opacity: 0,
        animation: `cardSlideIn 600ms cubic-bezier(0.16,1,0.3,1) ${index * 80}ms forwards`,
        cursor: editing ? "default" : "pointer",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => { if (!editing) onClick(); }}
    >
      {/* Blurred background image — scale overscan avoids edge darkening, delayed until clip ready */}
      <img
        src={image}
        alt=""
        draggable={false}
        className="absolute pointer-events-none select-none"
        style={{
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: hasKey ? (hovered ? 0.55 : 0.45) : (hovered ? 0.4 : 0.3),
          filter: hasKey
            ? (hovered ? `blur(12px) saturate(1.5) brightness(${brightness})` : `blur(16px) saturate(1.3) brightness(${brightness})`)
            : (hovered ? `blur(18px) saturate(1.0) brightness(${brightness})` : `blur(24px) saturate(0.8) brightness(${brightness})`),
          transition: "opacity 400ms ease, filter 400ms ease",
          transform: "scale(1.5)",
          willChange: "transform",
        }}
      />

      {/* Provider name — top left */}
      <div style={{
        padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
      }}>
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: "clamp(18px, 2.2vw, 28px)",
          fontWeight: 600,
          color: editing ? "transparent" : hasKey ? "var(--color-fg)" : (hovered ? "rgba(195,236,255,0.65)" : "rgba(195,236,255,0.45)"),
          letterSpacing: "-0.03em",
          lineHeight: 1.15,
          display: "block",
          textShadow: hasKey ? "0 1px 8px rgba(0,0,0,0.5)" : "none",
          transition: "color 300ms ease",
        }}>
          {name}
        </span>
        {!editing && hasKey && isPrimary && (
          <span style={{
            fontFamily: "var(--font-sans)",
            fontSize: "clamp(12px, 1.2vw, 14px)",
            fontWeight: 500,
            color: "rgba(195, 236, 255, 0.6)",
            letterSpacing: "-0.01em",
            marginTop: 4,
            display: "block",
            textShadow: "0 1px 6px rgba(0,0,0,0.5)",
          }}>
            Primary
          </span>
        )}
      </div>

      {/* API key / placeholder — bottom left */}
      {!editing && (
        <div style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
        }}>
          <div style={{
            fontFamily: "var(--font-mono)",
            fontSize: "clamp(16px, 2vw, 26px)",
            color: value ? "var(--color-fg-secondary)" : (hovered ? "var(--color-fg-muted)" : "var(--color-fg-faint)"),
            transition: "color 300ms ease",
            lineHeight: 1.5,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            maskImage: hasKey
              ? "linear-gradient(to right, black 65%, transparent 85%)"
              : "linear-gradient(to right, black 80%, transparent 100%)",
            WebkitMaskImage: hasKey
              ? "linear-gradient(to right, black 65%, transparent 85%)"
              : "linear-gradient(to right, black 80%, transparent 100%)",
          }}>
            {value ? maskKey(value) : placeholder}
          </div>
          {hasKey && modelSummary && (
            <div style={{
              fontFamily: "var(--font-sans)",
              fontSize: "clamp(10px, 1vw, 11px)",
              color: "rgba(195, 236, 255, 0.35)",
              letterSpacing: "-0.01em",
              marginTop: 2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>
              {modelSummary}
            </div>
          )}
        </div>
      )}

      {/* Check mark — bottom right, always visible for set keys */}
      {hasKey && !editing && (
        <div style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
          display: "flex",
          alignItems: "center",
          height: "calc(clamp(16px, 2vw, 26px) * 1.5 + clamp(14px, 2vw, 22px) * 2)",
        }}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-fg-secondary)"
            strokeWidth="3.5"
            strokeLinecap="square"
            strokeLinejoin="miter"
            style={{
              width: "clamp(18px, 1.8vw, 24px)",
              height: "clamp(18px, 1.8vw, 24px)",
              opacity: 0.3,
            }}
          >
            <polyline points="4 12 10 18 20 6" />
          </svg>
        </div>
      )}

      {/* Plus icon — centered on empty cards */}
      {!hasKey && !editing && (
        <div
          className="absolute inset-0"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "opacity 300ms ease, transform 300ms cubic-bezier(0.16,1,0.3,1)",
            pointerEvents: hovered ? "auto" : "none",
          }}
        >
          <svg
            width="clamp(28px, 3vw, 44px)"
            height="clamp(28px, 3vw, 44px)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="square"
            style={{
              opacity: hovered ? 0.55 : 0.3,
              transform: hovered ? "scale(1.1)" : "scale(0.9)",
              transition: "transform 200ms ease, opacity 200ms ease",
            }}
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
      )}

      {/* Edit + Delete icons on hover for cards with keys */}
      {!editing && hasKey && (
        <div
          className="absolute inset-0"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "clamp(12px, 1.5vw, 20px)",
            opacity: hovered ? 1 : 0,
            transform: hovered ? "scale(1)" : "scale(0.85)",
            transition: "opacity 300ms ease, transform 300ms cubic-bezier(0.16,1,0.3,1)",
            pointerEvents: hovered ? "auto" : "none",
          }}
        >
          <img
            src="/icons/EditIcon.svg"
            alt="Edit"
            data-role="edit-icon"
            style={{
              width: "clamp(28px, 3vw, 44px)",
              height: "clamp(28px, 3vw, 44px)",
              filter: "invert(1)",
              opacity: 0.3,
              transition: "transform 200ms ease, opacity 200ms ease",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.15)";
              e.currentTarget.style.opacity = "1";
              const sibling = e.currentTarget.nextElementSibling as HTMLElement | null;
              if (sibling) sibling.style.opacity = "0.2";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
              e.currentTarget.style.opacity = "0.3";
              const sibling = e.currentTarget.nextElementSibling as HTMLElement | null;
              if (sibling) sibling.style.opacity = "0.3";
            }}
          />
          <img
            src="/icons/TrashIcon.svg"
            alt="Delete"
            data-role="trash-icon"
            style={{
              width: "clamp(28px, 3vw, 44px)",
              height: "clamp(28px, 3vw, 44px)",
              filter: "invert(1)",
              opacity: 0.3,
              transition: "transform 200ms ease, opacity 200ms ease",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.15)";
              e.currentTarget.style.opacity = "1";
              const sibling = e.currentTarget.previousElementSibling as HTMLElement | null;
              if (sibling) sibling.style.opacity = "0.2";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
              e.currentTarget.style.opacity = "0.3";
              const sibling = e.currentTarget.previousElementSibling as HTMLElement | null;
              if (sibling) sibling.style.opacity = "0.7";
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          />
        </div>
      )}

      {/* In-card dim when editing */}
      {editing && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: "rgba(2, 10, 13, 0.5)",
            backdropFilter: "blur(4px)",
          }}
        />
      )}
    </div>
  );
}

// ── Detail sub-components ───────────────────────────────────

// ── Section detail views ────────────────────────────────────

function ProvidersSection({ config, updateField, restrictedMode = false }: {
  config: AppConfig;
  updateField: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
  restrictedMode?: boolean;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const landscapeTarget = useRef(window.innerWidth / window.innerHeight > 1.2 ? 1 : 0);
  const landscapeCurrent = useRef(landscapeTarget.current);
  const landscapeVel = useRef(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [deletingKey, setDeletingKey] = useState<keyof AppConfig | null>(null);
  const deletingProvider = deletingKey !== null ? API_PROVIDERS.find(p => p.configKey === deletingKey) ?? null : null;
  const frozen = useRef(false);

  // Model management state
  const [pickerState, setPickerState] = useState<{
    task: TaskKey;
    models?: AvailableModel[];
    loading?: boolean;
    customInput?: boolean;
  } | null>(null);
  const [dragState, setDragState] = useState<{
    task: TaskKey;
    fromIndex: number;
    currentY: number;
    startY: number;
    cardHeight: number;
    settled?: boolean;
  } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerState) return;
    const handle = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerState(null);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [pickerState]);

  // Model helpers
  const getModels = (task: TaskKey): ModelEntry[] => {
    return (config.model_assignments?.[task] ?? []).filter((entry) => !isFreeModelId(entry.model));
  };

  const setModelsForTask = (task: TaskKey, models: ModelEntry[]) => {
    const current = config.model_assignments ?? {};
    updateField("model_assignments", { ...current, [task]: models.filter((entry) => !isFreeModelId(entry.model)) });
  };


  // Set a single agentic model for a provider (replaces any previous one from this provider)
  const setAgenticModel = (providerSlug: string, entry: ModelEntry | null) => {
    const current = getModels("agentic").filter(m => m.provider !== providerSlug);
    setModelsForTask("agentic", entry ? [...current, entry] : current);
    setPickerState(null);
  };

  const reorderModels = (task: TaskKey, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const models = [...getModels(task)];
    const [moved] = models.splice(fromIndex, 1);
    models.splice(toIndex, 0, moved);
    setModelsForTask(task, models);
  };

  // Picker actions
  const openPicker = (task: TaskKey, providerSlug: string) => {
    setPickerState({ task, loading: true });
    const provider = API_PROVIDERS.find((entry) => entry.providerSlug === providerSlug);
    const draftApiKey = provider ? (config[provider.configKey] as string | null | undefined) : undefined;
    listModels(providerSlug, draftApiKey ?? undefined).then(models => {
      const filtered = models.filter((model) => !isFreeModelId(model.id));
      setPickerState(prev => prev ? { ...prev, models: filtered, loading: false } : null);
    }).catch(() => {
      setPickerState(prev => prev ? { ...prev, models: [], loading: false } : null);
    });
  };

  // Drag handlers
  const dragRef = useRef<{
    task: TaskKey;
    fromIndex: number;
    startY: number;
    cardHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: PointerEvent) => {
      setDragState(prev => prev ? { ...prev, currentY: e.clientY } : null);
    };
    const onUp = (e: PointerEvent) => {
      const ds = dragRef.current;
      if (!ds) { setDragState(null); return; }
      const delta = e.clientY - ds.startY;
      const indexOffset = Math.round(delta / ds.cardHeight);
      const toIndex = Math.max(0, Math.min(
        getModels(ds.task).length - 1,
        ds.fromIndex + indexOffset
      ));
      const snappedY = (toIndex - ds.fromIndex) * ds.cardHeight + ds.startY;
      setDragState(prev => prev ? { ...prev, currentY: snappedY, settled: true } : null);
      setTimeout(() => {
        reorderModels(ds.task, ds.fromIndex, toIndex);
        dragRef.current = null;
        setDragState(null);
      }, 200);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [!!dragState]);

  useEffect(() => {
    const check = () => {
      landscapeTarget.current = window.innerWidth / window.innerHeight > 1.2 ? 1 : 0;
    };
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Freeze parallax when a card is being edited
  useEffect(() => {
    frozen.current = editingIndex !== null;
    if (frozen.current) {
      for (let i = 0; i < baseValues.length; i++) {
        targetVals.current[i] = currentVals.current[i];
      }
    }
  }, [editingIndex]);

  // Sort providers: set keys first, then unset
  const availableProviders = restrictedMode
    ? API_PROVIDERS.filter(p => p.providerSlug !== "openai" && p.providerSlug !== "anthropic")
    : API_PROVIDERS;
  const sortedProviders = [...availableProviders].sort((a, b) => {
    const aSet = config[a.configKey] ? 1 : 0;
    const bSet = config[b.configKey] ? 1 : 0;
    return bSet - aSet;
  });

  // Spring-based size-parallax grid
  const SET_WEIGHT = 1.4;
  const UNSET_WEIGHT = 0.8;
  const baseValues: number[] = sortedProviders.map(p => config[p.configKey] ? SET_WEIGHT : UNSET_WEIGHT);
  const boost = 0.25;
  const springK = 0.04;
  const damping = 0.82;

  const targetVals = useRef([...baseValues]);
  const currentVals = useRef([...baseValues]);
  const baseValsRef = useRef([...baseValues]);
  const rafId = useRef(0);
  const hovering = useRef(false);

  useEffect(() => {
    baseValsRef.current = [...baseValues];
    if (!hovering.current && !frozen.current) {
      for (let i = 0; i < baseValues.length; i++) {
        targetVals.current[i] = baseValues[i];
      }
    }
  }, [config.openai_api_key, config.anthropic_api_key, config.openrouter_api_key]);

  useEffect(() => {
    const vel = baseValsRef.current.map(() => 0);
    let hoveredIdx = -1;

    const updateTargets = () => {
      const bv = baseValsRef.current;
      for (let i = 0; i < bv.length; i++) {
        targetVals.current[i] = hoveredIdx === i ? bv[i] + boost : bv[i];
      }
    };

    const onMove = (e: MouseEvent) => {
      if (frozen.current) return;
      hovering.current = true;
      const el = gridRef.current;
      if (!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      let newIdx = -1;
      for (let i = 0; i < children.length; i++) {
        const rect = children[i].getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          newIdx = i;
          break;
        }
      }
      if (newIdx !== hoveredIdx) {
        hoveredIdx = newIdx;
        updateTargets();
      }
    };

    const onLeave = () => {
      hovering.current = false;
      hoveredIdx = -1;
      if (frozen.current) return;
      const bv = baseValsRef.current;
      for (let i = 0; i < bv.length; i++) targetVals.current[i] = bv[i];
    };

    const onEnter = () => { hovering.current = true; };

    const tick = () => {
      const el = gridRef.current;
      if (!el) { rafId.current = requestAnimationFrame(tick); return; }
      for (let i = 0; i < baseValues.length; i++) {
        const force = (targetVals.current[i] - currentVals.current[i]) * springK;
        vel[i] = (vel[i] + force) * damping;
        currentVals.current[i] += vel[i];
      }
      const lForce = (landscapeTarget.current - landscapeCurrent.current) * 0.05;
      landscapeVel.current = (landscapeVel.current + lForce) * 0.8;
      landscapeCurrent.current += landscapeVel.current;
      const t = Math.max(0, Math.min(1, landscapeCurrent.current));
      const isLandscape = t > 0.5;
      const fade = Math.abs(t - 0.5) * 2;

      const fr = currentVals.current.map(v => `${v.toFixed(3)}fr`).join(" ");
      el.style.transition = "none";
      if (isLandscape) {
        el.style.gridTemplateColumns = fr;
        el.style.gridTemplateRows = "1fr";
        el.style.gridAutoFlow = "column";
      } else {
        el.style.gridTemplateRows = fr;
        el.style.gridTemplateColumns = "1fr";
        el.style.gridAutoFlow = "row";
      }
      el.style.opacity = `${fade}`;
      rafId.current = requestAnimationFrame(tick);
    };

    rafId.current = requestAnimationFrame(tick);
    const el = gridRef.current;
    el?.addEventListener("mouseenter", onEnter);
    el?.addEventListener("mousemove", onMove);
    el?.addEventListener("mouseleave", onLeave);
    return () => {
      el?.removeEventListener("mouseenter", onEnter);
      el?.removeEventListener("mousemove", onMove);
      el?.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editingProvider = editingIndex !== null ? sortedProviders[editingIndex] : null;

  const startEdit = (i: number) => {
    const p = sortedProviders[i];
    setDraft((config[p.configKey] as string) || "");
    setEditingIndex(i);
    setPickerState(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const saveEdit = () => {
    if (editingProvider) {
      updateField(editingProvider.configKey, draft.trim() || null);
    }
    setEditingIndex(null);
    setPickerState(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setPickerState(null);
  };

  // Get current agentic model for this provider (single selection)
  const currentAgenticModel: ModelEntry | null =
    editingProvider
      ? (getModels("agentic").find(m => m.provider === editingProvider.providerSlug) ?? null)
      : null;

  const editingProviderHasKey = editingProvider ? !!config[editingProvider.configKey] || draft.trim().length > 0 : false;

  const initLandscape = landscapeTarget.current > 0.5;
  return (
    <>
      <div
        ref={gridRef}
        style={{
          display: "grid",
          gap: 6,
          flex: 1,
          minHeight: 0,
          ...(initLandscape
            ? { gridTemplateColumns: baseValues.map(v => `${v}fr`).join(" "), gridTemplateRows: "1fr" }
            : { gridTemplateColumns: "1fr", gridTemplateRows: baseValues.map(v => `${v}fr`).join(" ") }
          ),
        }}
      >
        {sortedProviders.map((p, i) => (
          <ProviderCard
            key={p.configKey}
            name={p.name}
            image={p.image}
            hasKey={!!config[p.configKey]}
            value={config[p.configKey] as string | null}
            placeholder={p.placeholder}
            index={i}
            brightness={p.brightness}
            editing={editingIndex === i}
            modelSummary={getModelSummary(config, p.providerSlug)}
            isPrimary={config.primary_provider === p.providerSlug}
            onClick={() => startEdit(i)}
            onDelete={() => setDeletingKey(p.configKey)}
          />
        ))}
      </div>

      {/* Delete confirmation modal */}
      {deletingProvider && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(2, 10, 13, 0.75)",
            backdropFilter: "blur(16px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "cardSlideIn 250ms cubic-bezier(0.16,1,0.3,1) forwards",
          }}
          onClick={() => setDeletingKey(null)}
        >
          <div
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 16,
              padding: "28px 30px 24px",
              width: "min(380px, 85vw)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(195,236,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--color-fg-secondary)",
              letterSpacing: "-0.03em",
              fontVariationSettings: '"opsz" 30',
            }}>
              Remove {deletingProvider.name} {deletingProvider.secretLabel}?
            </span>
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              color: "var(--color-fg-faint)",
              lineHeight: 1.5,
            }}>
              This will clear your stored {deletingProvider.secretLabel}. You can always add it back later.
            </span>
            <div style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 6,
            }}>
              <button
                onClick={() => setDeletingKey(null)}
                style={{
                  background: "transparent",
                  color: "var(--color-fg-faint)",
                  border: "none",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  borderRadius: 8,
                  transition: "color 200ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-faint)"; }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  updateField(deletingProvider.configKey, null);
                  setDeletingKey(null);
                }}
                style={{
                  background: "rgba(122, 48, 64, 0.3)",
                  color: "#FF8A9E",
                  border: "1px solid #7A3040",
                  borderRadius: 8,
                  padding: "8px 20px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  transition: "all 200ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(122, 48, 64, 0.5)";
                  e.currentTarget.style.color = "#FFB0BE";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(122, 48, 64, 0.3)";
                  e.currentTarget.style.color = "#FF8A9E";
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-page edit modal — two-zone: API key + model assignments */}
      {editingProvider && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(2, 10, 13, 0.75)",
            backdropFilter: "blur(16px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "cardSlideIn 250ms cubic-bezier(0.16,1,0.3,1) forwards",
          }}
          onClick={cancelEdit}
        >
          <div
            style={{
              background: "var(--color-surface)",
              border: "none",
              borderRadius: 16,
              padding: "28px 30px 24px",
              width: "min(480px, 90vw)",
              maxHeight: "min(85vh, 720px)",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 18,
              boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
            }}
            className="scrollbar-none"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Zone 1 — API Key */}
            <label style={{
              fontFamily: "var(--font-sans)",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--color-fg)",
              letterSpacing: "-0.03em",
              fontVariationSettings: '"opsz" 30',
            }}>
              {editingProvider.name} {editingProvider.secretLabel}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") cancelEdit();
              }}
              placeholder={editingProvider.placeholder}
              style={{
                width: "100%",
                background: "var(--color-base)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 10,
                padding: "12px 14px",
                color: "var(--color-fg)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                letterSpacing: "-0.01em",
                outline: "none",
                caretColor: "var(--color-fg-secondary)",
                transition: "border-color 200ms ease",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--color-border)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--color-border-subtle)"; }}
            />
            {/* Primary provider toggle */}
            {editingProviderHasKey && (() => {
              const isCurrentPrimary = config.primary_provider === editingProvider.providerSlug;
              return (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 0",
                  }}
                >
                  <span style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--color-fg-muted)",
                    letterSpacing: "-0.02em",
                  }}>
                    Primary provider
                  </span>
                  <div
                    onClick={() => {
                      updateField("primary_provider", isCurrentPrimary ? null : editingProvider.providerSlug);
                    }}
                    style={{
                      width: 36,
                      height: 20,
                      borderRadius: 10,
                      background: isCurrentPrimary ? "rgba(195, 236, 255, 0.25)" : "rgba(195, 236, 255, 0.08)",
                      border: `1px solid ${isCurrentPrimary ? "rgba(195, 236, 255, 0.3)" : "rgba(195, 236, 255, 0.1)"}`,
                      cursor: "pointer",
                      position: "relative",
                      transition: "background 200ms ease, border-color 200ms ease",
                      flexShrink: 0,
                    }}
                  >
                    <div style={{
                      width: 14,
                      height: 14,
                      borderRadius: 7,
                      background: isCurrentPrimary ? "rgba(195, 236, 255, 0.8)" : "rgba(195, 236, 255, 0.25)",
                      position: "absolute",
                      top: 2,
                      left: isCurrentPrimary ? 19 : 2,
                      transition: "left 200ms cubic-bezier(0.16,1,0.3,1), background 200ms ease",
                    }} />
                  </div>
                </div>
              );
            })()}

            {/* Zone 2 — Model Assignments */}
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              opacity: editingProviderHasKey ? 1 : 0.35,
              pointerEvents: editingProviderHasKey ? "auto" : "none",
            }}>

              {/* ── Default Agent Model (agentic) — single selection ── */}
              {editingProviderHasKey && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "rgba(195, 236, 255, 0.4)",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}>
                    Default Agent Model
                  </span>
                  {currentAgenticModel ? (
                    <div
                      style={{
                        background: "rgba(2, 10, 13, 0.3)",
                        border: "1px solid rgba(195, 236, 255, 0.06)",
                        borderRadius: 10,
                        padding: "7px 8px 7px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--color-fg)",
                          letterSpacing: "-0.01em",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                          {currentAgenticModel.model}
                        </div>
                      </div>
                      <img
                        src="/icons/TrashIcon.svg"
                        alt="Remove"
                        onClick={() => setAgenticModel(editingProvider.providerSlug, null)}
                        style={{
                          width: 22,
                          height: 22,
                          filter: "invert(1)",
                          opacity: 0.18,
                          cursor: "pointer",
                          padding: 3,
                          borderRadius: 6,
                          transition: "transform 200ms ease, opacity 200ms ease",
                          flexShrink: 0,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = "scale(1.15)";
                          e.currentTarget.style.opacity = "1";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = "scale(1)";
                          e.currentTarget.style.opacity = "0.18";
                        }}
                      />
                    </div>
                  ) : (
                    <div style={{ position: "relative" }}>
                      <div
                        style={{
                          background: "rgba(2, 10, 13, 0.2)",
                          border: "1px dashed rgba(195, 236, 255, 0.1)",
                          borderRadius: 10,
                          padding: "7px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          cursor: "pointer",
                          transition: "border-color 200ms ease, background 200ms ease",
                          fontFamily: "var(--font-sans)",
                          fontSize: 12,
                          color: "rgba(195, 236, 255, 0.35)",
                        }}
                        onClick={() => openPicker("agentic", editingProvider.providerSlug)}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = "rgba(195, 236, 255, 0.25)";
                          e.currentTarget.style.background = "rgba(2, 10, 13, 0.4)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = "rgba(195, 236, 255, 0.1)";
                          e.currentTarget.style.background = "rgba(2, 10, 13, 0.2)";
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="rgba(195, 236, 255, 0.3)"
                          strokeWidth="2.5"
                          strokeLinecap="square"
                        >
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Select model
                      </div>
                    </div>
                  )}
                  {/* Change button when agentic model is already set */}
                  {currentAgenticModel && (
                    <div style={{ position: "relative" }}>
                      <div
                        onClick={() => openPicker("agentic", editingProvider.providerSlug)}
                        style={{
                          fontFamily: "var(--font-sans)",
                          fontSize: 11,
                          color: "var(--color-fg-faint)",
                          cursor: "pointer",
                          padding: "2px 0",
                          transition: "color 200ms ease",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-faint)"; }}
                      >
                        Change...
                      </div>
                    </div>
                  )}
                  {/* Agentic model picker popover */}
                  {pickerState?.task === "agentic" && (
                    <div
                      ref={pickerRef}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        background: "rgba(10, 18, 22, 0.95)",
                        border: "1px solid rgba(195, 236, 255, 0.08)",
                        borderRadius: 12,
                        padding: "6px",
                        boxShadow: "0 12px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(195,236,255,0.03) inset",
                        backdropFilter: "blur(20px)",
                        maxHeight: 220,
                        overflowY: "auto",
                      }}
                    >
                      <div style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "rgba(195, 236, 255, 0.4)",
                        padding: "4px 8px 6px",
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        fontFamily: "var(--font-sans)",
                      }}>
                        {editingProvider.name}
                      </div>
                      {pickerState.loading ? (
                        <div style={{
                          padding: "12px 10px",
                          fontSize: 12,
                          color: "var(--color-fg-faint)",
                          fontFamily: "var(--font-sans)",
                        }}>
                          Loading...
                        </div>
                      ) : (
                        <>
                          {(pickerState.models ?? []).map((model) => (
                            <div
                              key={`agentic-${model.provider}:${model.id}`}
                              onClick={() => {
                                setAgenticModel(editingProvider.providerSlug, {
                                  provider: editingProvider.providerSlug,
                                  model: model.id,
                                });
                              }}
                              style={{
                                padding: "7px 10px",
                                borderRadius: 8,
                                cursor: "pointer",
                                color: "var(--color-fg-secondary)",
                                letterSpacing: "-0.01em",
                                transition: "background 150ms ease",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.06)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                            >
                              <div style={{
                                fontFamily: "var(--font-sans)",
                                fontSize: 12,
                                fontWeight: 600,
                                color: "var(--color-fg)",
                                letterSpacing: "-0.02em",
                              }}>
                                {model.display_name?.trim() || model.id}
                              </div>
                              {(model.display_name?.trim() && model.display_name.trim() !== model.id) || model.owned_by ? (
                                <div style={{
                                  fontFamily: "var(--font-mono)",
                                  fontSize: 11,
                                  color: "var(--color-fg-faint)",
                                  letterSpacing: "-0.01em",
                                  marginTop: 2,
                                }}>
                                  {model.id}
                                  {model.owned_by ? ` · ${model.owned_by}` : ""}
                                </div>
                              ) : null}
                            </div>
                          ))}
                          {pickerState.customInput ? (
                            <div style={{ padding: "4px 4px" }}>
                              <input
                                autoFocus
                                type="text"
                                placeholder="model-id"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                                    const id = (e.target as HTMLInputElement).value.trim();
                                    setAgenticModel(editingProvider.providerSlug, {
                                      provider: editingProvider.providerSlug,
                                      model: id,
                                    });
                                  }
                                  if (e.key === "Escape") {
                                    setPickerState(prev => prev ? { ...prev, customInput: false } : null);
                                  }
                                }}
                                style={{
                                  width: "100%",
                                  background: "rgba(2, 10, 13, 0.6)",
                                  border: "1px solid rgba(195, 236, 255, 0.1)",
                                  borderRadius: 8,
                                  padding: "7px 10px",
                                  color: "var(--color-fg)",
                                  fontFamily: "var(--font-mono)",
                                  fontSize: 12,
                                  outline: "none",
                                  caretColor: "var(--color-fg-secondary)",
                                }}
                              />
                            </div>
                          ) : (
                            <div
                              onClick={() => setPickerState(prev => prev ? { ...prev, customInput: true } : null)}
                              style={{
                                padding: "7px 10px",
                                borderRadius: 8,
                                cursor: "pointer",
                                fontFamily: "var(--font-sans)",
                                fontSize: 12,
                                color: "var(--color-fg-faint)",
                                fontStyle: "italic",
                                transition: "background 150ms ease",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(195, 236, 255, 0.06)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                            >
                              Custom...
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Cancel / Save buttons */}
            <div style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 4,
            }}>
              <button
                onClick={cancelEdit}
                style={{
                  background: "transparent",
                  color: "var(--color-fg-muted)",
                  border: "none",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  borderRadius: 8,
                  transition: "color 200ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-muted)"; }}
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                style={{
                  background: "var(--color-surface-raised)",
                  color: "var(--color-fg-secondary)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 8,
                  padding: "8px 20px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  transition: "all 200ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--color-border)";
                  e.currentTarget.style.color = "var(--color-fg)";
                  e.currentTarget.style.borderColor = "var(--color-border)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--color-surface-raised)";
                  e.currentTarget.style.color = "var(--color-fg-secondary)";
                  e.currentTarget.style.borderColor = "var(--color-border-subtle)";
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Agent filesystem access editor ────────────────────────────

function FsAccessEditor({ paths, onChange, hideHeader = false }: {
  paths: string[];
  onChange: (next: string[]) => void;
  hideHeader?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [validating, setValidating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirming = useRef(false);

  const handleConfirm = async () => {
    if (confirming.current) return;
    confirming.current = true;
    const trimmed = draft.trim();
    if (!trimmed) {
      setAdding(false);
      setDraft("");
      confirming.current = false;
      return;
    }
    if (paths.includes(trimmed)) {
      setAdding(false);
      setDraft("");
      confirming.current = false;
      return;
    }
    setValidating(true);
    try {
      const valid = await validatePath(trimmed);
      if (valid) {
        onChange([...paths, trimmed]);
        setDraft("");
        setAdding(false);
      } else {
        setDraft("");
        inputRef.current?.focus();
      }
    } catch {
      setDraft("");
      inputRef.current?.focus();
    } finally {
      setValidating(false);
      confirming.current = false;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleConfirm();
    }
    if (e.key === "Escape") {
      setAdding(false);
      setDraft("");
    }
  };

  const handleRemove = (index: number) => {
    onChange(paths.filter((_, i) => i !== index));
  };

  const handleStartAdd = () => {
    if (!adding) {
      setAdding(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <>
      {/* Header row (only when used standalone) */}
      {!hideHeader && (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          fontWeight: 600,
          color: "var(--color-fg)",
          letterSpacing: "-0.03em",
          margin: 0,
        }}>
          Agent file system access
        </h3>
        <button
          onClick={handleStartAdd}
          disabled={adding}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            border: "1.5px solid rgba(166,225,255,0.1)",
            background: adding ? "rgba(166,225,255,0.02)" : "rgba(166,225,255,0.04)",
            color: adding ? "rgba(195,236,255,0.2)" : "rgba(195,236,255,0.5)",
            cursor: adding ? "default" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            lineHeight: 1,
            padding: 0,
            transition: "background 200ms ease, border-color 200ms ease, color 200ms ease",
          }}
          onMouseEnter={(e) => {
            if (!adding) {
              e.currentTarget.style.background = "rgba(166,225,255,0.08)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.2)";
              e.currentTarget.style.color = "rgba(195,236,255,0.7)";
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = adding ? "rgba(166,225,255,0.02)" : "rgba(166,225,255,0.04)";
            e.currentTarget.style.borderColor = "rgba(166,225,255,0.1)";
            e.currentTarget.style.color = adding ? "rgba(195,236,255,0.2)" : "rgba(195,236,255,0.5)";
          }}
        >
          +
        </button>
      </div>
      )}

      {/* Path list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {paths.map((p, i) => (
          <PathRow key={p} path={p} onRemove={() => handleRemove(i)} />
        ))}

        {/* Add input */}
        {adding && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(166,225,255,0.02)",
            border: "1.5px solid rgba(166,225,255,0.1)",
          }}>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleConfirm}
              onKeyDown={handleKeyDown}
              disabled={validating}
              placeholder="/path/to/folder"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--color-fg-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                letterSpacing: "-0.01em",
                padding: 0,
              }}
            />
            {validating && (
              <span style={{
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                color: "rgba(195,236,255,0.3)",
              }}>
                ...
              </span>
            )}
          </div>
        )}

        {/* Add-path button (shown when used inside a panel that hides the editor's header) */}
        {hideHeader && !adding && (
          <button
            onClick={handleStartAdd}
            style={{
              alignSelf: "flex-start",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px dashed rgba(166,225,255,0.16)",
              background: "transparent",
              color: "var(--color-fg-muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              cursor: "pointer",
              marginTop: paths.length > 0 ? 4 : 0,
              transition: "background 200ms ease, border-color 200ms ease, color 200ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(166,225,255,0.04)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.28)";
              e.currentTarget.style.color = "var(--color-fg-secondary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.16)";
              e.currentTarget.style.color = "var(--color-fg-muted)";
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
            Add path
          </button>
        )}

        {/* Empty hint when no paths yet */}
        {hideHeader && paths.length === 0 && !adding && (
          <p style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11.5,
            color: "var(--color-fg-faint)",
            margin: "4px 0 0",
            letterSpacing: "-0.01em",
          }}>
            No folders allowed yet — the agent can't read any files outside your vault.
          </p>
        )}
      </div>
    </>
  );
}

function PathRow({ path, onRemove }: { path: string; onRemove: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderRadius: 10,
        background: hovered ? "rgba(166,225,255,0.04)" : "transparent",
        transition: "background 200ms ease",
      }}
    >
      <span style={{
        flex: 1,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        color: "var(--color-fg-secondary)",
        letterSpacing: "-0.01em",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {path}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: hovered ? "rgba(255,120,120,0.6)" : "rgba(195,236,255,0.15)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          padding: 0,
          transition: "color 200ms ease",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(255,120,120,0.8)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = hovered ? "rgba(255,120,120,0.6)" : "rgba(195,236,255,0.15)"; }}
      >
        ✕
      </button>
    </div>
  );
}

// ── General section ───────────────────────────────────────────

function GeneralSection({ config, updateField }: {
  config: AppConfig;
  updateField: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
}) {
  const current = config.privacy_mode === "restricted" ? "restricted" : "flexible";
  const [hovered, setHovered] = useState<string | null>(null);

  const [obsidianPath, setObsidianPath] = useState<string>(config.obsidian_vault_path ?? "");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Auto-sync defaults to ON once a path is configured; user opts out by
  // explicitly setting `obsidian_auto_sync = false`.
  const autoSyncOn = config.obsidian_auto_sync !== false;
  const lastSyncLabel = useMemo(() => {
    const iso = config.obsidian_last_sync_at;
    if (!iso) return null;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    const mins = Math.floor((Date.now() - ms) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : `${days}d ago`;
  }, [config.obsidian_last_sync_at]);

  const handleBrowseObsidian = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, title: "Select Obsidian vault folder" });
      if (typeof selected === "string") {
        setObsidianPath(selected);
      }
    } catch (e) {
      console.error("Folder picker failed:", e);
    }
  }, []);

  const handleSyncObsidian = useCallback(async () => {
    if (!obsidianPath.trim()) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const validation = await exportValidate(obsidianPath);
      if (!validation.exists) {
        setSyncResult({ ok: false, message: "Folder not found." });
        return;
      }
      if (!validation.is_vault) {
        setSyncResult({ ok: false, message: "Not an Obsidian vault (missing .obsidian folder)." });
        return;
      }
      const result = await exportToObsidian(obsidianPath);
      setSyncResult({
        ok: true,
        message: `Copied ${result.files_copied} files · ${new Date().toLocaleString()}`,
      });
      updateField("obsidian_vault_path", obsidianPath);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = raw.startsWith("Export task join failed")
        ? "Export failed unexpectedly. Please try again."
        : raw;
      setSyncResult({ ok: false, message: msg });
    } finally {
      setSyncing(false);
    }
  }, [obsidianPath, updateField]);

  const handleSelect = (mode: "flexible" | "restricted") => {
    updateField("privacy_mode", mode);
  };

  return (
    <div style={{
      flex: 1,
      padding: "clamp(10px, 1.4vw, 18px) clamp(16px, 2vw, 28px) 16px",
      overflowY: "auto",
      minHeight: 0,
      maskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 16px), transparent 100%)",
      WebkitMaskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 16px), transparent 100%)",
    }}
    className="scrollbar-none"
    >
      <div style={{
        maxWidth: 1080,
        margin: "0 auto",
        display: "grid",
        // Two-column dense layout: Operating Mode (compact) sits above Agent
        // file system access in col 1; Export to Obsidian fills col 2 across
        // both rows; Browser Extension takes a full-width row at the bottom.
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gridTemplateAreas: `
          "operating  obsidian"
          "fs         obsidian"
          "extension  extension"
        `,
        gridAutoRows: "min-content",
        gap: 8,
        alignItems: "start",
      }}>
      {/* ── Operating Mode — compact segmented switch in header ── */}
      <GeneralPanel area="operating">
        <PanelHeader
          title="Operating Mode"
          subtitle={current === "restricted"
            ? "Zero data retention only. Disables direct OpenAI/Anthropic keys; all requests enforce ZDR routing."
            : "All providers available. Use any API key. No routing restrictions applied."}
          right={
            <div
              role="tablist"
              aria-label="Operating mode"
              style={{
                display: "flex",
                background: "rgba(166,225,255,0.03)",
                border: "1px solid rgba(166,225,255,0.06)",
                borderRadius: 10,
                padding: 2,
                gap: 2,
              }}
            >
              {([
                {
                  id: "restricted" as const,
                  label: "Restricted",
                  icon: (
                    <svg width="13" height="13" viewBox="-1.5 -1.5 48 48" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.411 21.958s12.237-.837 20.089-.837 20.089.837 20.089.837" />
                      <path d="M15.484 2.838c2.218-.216 4.932-.427 7.069-.427 2.137 0 4.85.21 7.068.426 2.508.244 4.59 2.002 5.249 4.434.58 2.142 1.235 4.767 1.587 6.863.378 2.261.626 5.237.774 7.499-4.254-.235-10.217-.512-14.731-.512-4.477 0-10.378.272-14.625.506.148-2.261.395-5.233.774-7.492.351-2.096 1.007-4.721 1.587-6.863.659-2.432 2.74-4.19 5.248-4.434Z" />
                      <path d="M18.997 35.279a5.263 5.263 0 0 1 7.006 0" />
                      <path d="M12.583 42.455c4.117 0 6.432-2.316 6.432-6.433s-2.315-6.432-6.432-6.432c-4.117 0-6.433 2.316-6.433 6.432 0 4.117 2.316 6.433 6.433 6.433ZM32.418 42.59c4.117 0 6.432-2.316 6.432-6.433 0-4.117-2.316-6.432-6.432-6.432-4.117 0-6.433 2.315-6.433 6.432 0 4.117 2.316 6.433 6.433 6.433Z" />
                    </svg>
                  ),
                },
                {
                  id: "flexible" as const,
                  label: "Flexible",
                  icon: (
                    <svg width="13" height="13" viewBox="-1.5 -1.5 48 48" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.608 19.567 10.98 5.082A3.214 3.214 0 0 1 14.576 3.214c2.668 0 4.72 2.36 4.351 5.002l-.767 5.484 7.958 0M1.608 38.049c.376.108.812.237 1.3.382 3.945 1.17 11.24 3.028 18.623 3.355 7.065.313 11.97.376 17.25.2 2.589-.087 4.613-2.234 4.613-4.824 0-2.694-2.183-4.877-4.877-4.877l-5.77 0" />
                      <path d="M29.926 13.768c-2.069-.143-1.711-.143-3.78 0-2.385.165-4.123 2.23-4.123 4.618 0 2.388 1.738 4.452 4.123 4.617 2.069.144 1.711.144 3.78 0 2.385-.165 4.123-2.23 4.123-4.617 0-2.388-1.738-4.452-4.123-4.618" />
                      <path d="M31.533 23.217c-2.069-.144-2.514-.144-4.583 0-2.385.165-4.123 2.23-4.123 4.617 0 2.388 1.738 4.453 4.123 4.618 2.069.143 2.514.143 4.583 0 2.385-.166 4.123-2.23 4.123-4.618 0-2.388-1.738-4.452-4.123-4.617" />
                    </svg>
                  ),
                },
              ]).map(({ id, label, icon }) => {
                const isActive = current === id;
                const isHov = hovered === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => handleSelect(id)}
                    onMouseEnter={() => setHovered(id)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 10px",
                      borderRadius: 8,
                      border: "none",
                      background: isActive
                        ? "rgba(166,225,255,0.12)"
                        : isHov ? "rgba(166,225,255,0.05)" : "transparent",
                      color: isActive ? "rgba(195,236,255,0.9)" : "rgba(195,236,255,0.45)",
                      fontFamily: "var(--font-sans)",
                      fontSize: 12,
                      fontWeight: 500,
                      letterSpacing: "-0.01em",
                      cursor: "pointer",
                      transition: "background 200ms ease, color 200ms ease",
                    }}
                  >
                    {icon}
                    {label}
                  </button>
                );
              })}
            </div>
          }
        />
      </GeneralPanel>

      {/* ── Export to Obsidian ── */}
      <GeneralPanel area="obsidian">
        <PanelHeader
          title="Export to Obsidian"
          subtitle={<>Copy every conversation in your Kept vault into an Obsidian vault folder (under a <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.92em", background: "rgba(166,225,255,0.08)", padding: "1px 5px", borderRadius: 4 }}>Kept/</code> subfolder). Each sync overwrites previously exported files.</>}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={obsidianPath}
            onChange={(e) => setObsidianPath(e.target.value)}
            placeholder="C:\\Users\\you\\Documents\\MyVault"
            disabled={syncing}
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: "8px 12px",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 10,
              background: "var(--color-base)",
              color: "var(--color-fg)",
              letterSpacing: "-0.01em",
              outline: "none",
              caretColor: "var(--color-fg-secondary)",
              transition: "border-color 200ms ease",
              opacity: syncing ? 0.5 : 1,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--color-border)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--color-border-subtle)"; }}
          />
          <button
            type="button"
            onClick={handleBrowseObsidian}
            disabled={syncing}
            style={{
              padding: "6px 14px",
              borderRadius: 10,
              border: "1px solid rgba(166,225,255,0.1)",
              background: "rgba(166,225,255,0.04)",
              color: "var(--color-fg-secondary)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              cursor: syncing ? "not-allowed" : "pointer",
              opacity: syncing ? 0.5 : 1,
              transition: "background 200ms ease, border-color 200ms ease",
            }}
            onMouseEnter={(e) => {
              if (syncing) return;
              e.currentTarget.style.background = "rgba(166,225,255,0.08)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(166,225,255,0.04)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.1)";
            }}
          >
            Browse…
          </button>
        </div>

        {/* Auto-sync toggle row */}
        <div
          onClick={() => {
            const next = !autoSyncOn;
            updateField("obsidian_auto_sync", next);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderRadius: 10,
            cursor: "pointer",
            background: "rgba(166,225,255,0.02)",
            border: "1px solid rgba(166,225,255,0.06)",
            transition: "background 200ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(166,225,255,0.04)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(166,225,255,0.02)"; }}
        >
          <div style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            background: autoSyncOn ? "rgba(109,186,140,0.5)" : "rgba(166,225,255,0.1)",
            position: "relative",
            transition: "background 200ms ease",
            flexShrink: 0,
          }}>
            <div style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              background: autoSyncOn ? "#6DBA8C" : "rgba(195,236,255,0.3)",
              position: "absolute",
              top: 3,
              left: autoSyncOn ? 19 : 3,
              transition: "left 200ms ease, background 200ms ease",
            }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 500,
              color: "var(--color-fg-secondary)",
              letterSpacing: "-0.01em",
            }}>
              Auto-sync new conversations
            </div>
            <div style={{
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              color: "var(--color-fg-faint)",
              letterSpacing: "-0.01em",
              marginTop: 1,
              lineHeight: 1.3,
            }}>
              {!obsidianPath.trim()
                ? "Set a vault path above to enable."
                : autoSyncOn
                  ? `Copies new and changed files within ~5s of an ingest.${lastSyncLabel ? ` Last synced ${lastSyncLabel}.` : ""}`
                  : "Updates only happen when you click Sync."}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={handleSyncObsidian}
            disabled={syncing || !obsidianPath.trim()}
            style={{
              padding: "8px 20px",
              borderRadius: 10,
              border: "1px solid rgba(166,225,255,0.12)",
              background: "rgba(166,225,255,0.06)",
              color: "var(--color-fg-secondary)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              cursor: syncing || !obsidianPath.trim() ? "not-allowed" : "pointer",
              opacity: syncing || !obsidianPath.trim() ? 0.5 : 1,
              transition: "background 200ms ease, border-color 200ms ease",
            }}
            onMouseEnter={(e) => {
              if (syncing || !obsidianPath.trim()) return;
              e.currentTarget.style.background = "rgba(166,225,255,0.1)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.22)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(166,225,255,0.06)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.12)";
            }}
          >
            {syncing ? "Copying…" : autoSyncOn ? "Sync now" : "Sync"}
          </button>
        </div>

        {syncResult && (
          <p style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: syncResult.ok ? "rgba(109,186,140,0.8)" : "rgba(255,120,120,0.75)",
            letterSpacing: "-0.01em",
            margin: 0,
          }}>
            {syncResult.ok ? "✓ " : "✗ "}{syncResult.message}
          </p>
        )}
      </GeneralPanel>

      {/* ── Tool Access — col 1 row 2, sits below Operating Mode ── */}
      <GeneralPanel area="fs">
        <PanelHeader
          title="Agent file system access"
          subtitle="Folders the chat agent is allowed to read from."
        />
        <FsAccessEditor
          paths={config.fs_allowed_paths ?? []}
          onChange={(next) => updateField("fs_allowed_paths", next)}
          hideHeader
        />
      </GeneralPanel>

      {/* ── Browser Extension — full-width row at the bottom ── */}
      <GeneralPanel area="extension">
        <PanelHeader
          title="Browser Extension"
          subtitle="Install or reinstall the Chrome extension to capture AI conversations."
        />
        <ExtensionInstallSection hideHeader />
      </GeneralPanel>
      </div>
    </div>
  );
}

// ── Shared layout primitives for the General page ────────────

function GeneralPanel({ children, span = "auto", area }: {
  children: React.ReactNode;
  span?: "auto" | "full";
  area?: string;
}) {
  return (
    <div
      style={{
        gridArea: area,
        gridColumn: !area && span === "full" ? "1 / -1" : undefined,
        padding: "14px 18px",
        borderRadius: 14,
        background: "rgba(166,225,255,0.025)",
        border: "1px solid rgba(166,225,255,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

function PanelHeader({ title, subtitle, right }: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <h3 style={{
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--color-fg)",
          letterSpacing: "-0.03em",
          margin: 0,
        }}>
          {title}
        </h3>
        {subtitle && (
          <p style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--color-fg-faint)",
            letterSpacing: "-0.01em",
            margin: "3px 0 0",
            lineHeight: 1.35,
          }}>
            {subtitle}
          </p>
        )}
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
  );
}

// ── Browser Extension install section ────────────────────────

function ExtensionInstallSection({ hideHeader = false }: { hideHeader?: boolean }) {
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [zipRevealed, setZipRevealed] = useState<string | null>(null);

  useEffect(() => {
    getExtensionStatus().then((s) => setExtensionConnected(s.connected)).catch(() => {});
  }, []);

  const handleCheckConnection = async () => {
    setChecking(true);
    try {
      const s = await getExtensionStatus();
      setExtensionConnected(s.connected);
    } catch { /* ignore */ }
    setChecking(false);
  };

  const handleRevealZip = async () => {
    try {
      const zipPath = await getExtensionZip();
      setZipRevealed(zipPath);
      revealFile(zipPath);
    } catch { /* ignore */ }
  };

  return (
    <>
      {!hideHeader && (
      <div>
        <h3 style={{
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          fontWeight: 600,
          color: "var(--color-fg)",
          letterSpacing: "-0.03em",
          margin: 0,
        }}>
          Browser Extension
        </h3>
        <p style={{
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          color: "var(--color-fg-faint)",
          letterSpacing: "-0.01em",
          margin: "6px 0 0",
          lineHeight: 1.5,
        }}>
          Install or reinstall the Chrome extension to capture AI conversations.
        </p>
      </div>
      )}

      {/* Extension status indicator */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 18px",
        borderRadius: 14,
        background: extensionConnected ? "rgba(109,186,140,0.06)" : "rgba(166,225,255,0.02)",
        border: extensionConnected ? "1.5px solid rgba(109,186,140,0.2)" : "1.5px solid rgba(166,225,255,0.06)",
        transition: "background 200ms ease, border-color 200ms ease",
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: extensionConnected ? "#4ade80" : "rgba(195,236,255,0.25)",
          flexShrink: 0,
          transition: "background 200ms ease",
        }} />
        <span style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 500,
          color: extensionConnected ? "rgba(109,186,140,0.85)" : "var(--color-fg-secondary)",
          letterSpacing: "-0.01em",
          flex: 1,
        }}>
          {extensionConnected ? "Extension connected" : "Extension not detected"}
        </span>
        <button
          onClick={handleCheckConnection}
          disabled={checking}
          style={{
            padding: "5px 12px",
            borderRadius: 8,
            border: "1px solid rgba(166,225,255,0.1)",
            background: "rgba(166,225,255,0.04)",
            color: "var(--color-fg-secondary)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 500,
            cursor: checking ? "wait" : "pointer",
            transition: "background 200ms ease, border-color 200ms ease",
            letterSpacing: "-0.01em",
            opacity: checking ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(166,225,255,0.08)";
            e.currentTarget.style.borderColor = "rgba(166,225,255,0.2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(166,225,255,0.04)";
            e.currentTarget.style.borderColor = "rgba(166,225,255,0.1)";
          }}
        >
          {checking ? "Checking..." : "Refresh"}
        </button>
      </div>

      {/* Drag-to-install card + Save .zip */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        padding: "24px 18px",
        borderRadius: 14,
        background: "rgba(166,225,255,0.02)",
        border: "1.5px solid rgba(166,225,255,0.06)",
      }}>
        <p style={{
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          color: "var(--color-fg-faint)",
          textAlign: "center",
          lineHeight: 1.5,
          margin: 0,
        }}>
          Open your browser's <strong style={{ color: "var(--color-fg-secondary)", fontWeight: 600 }}>extensions page</strong>, enable{" "}
          <strong style={{ color: "var(--color-fg-secondary)", fontWeight: 600 }}>Developer Mode</strong>, then drag this onto the page:
        </p>

        {/* Draggable zip card */}
        <ExtensionDragCard />

        {/* Save .zip button */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleRevealZip}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: "1px solid rgba(166,225,255,0.08)",
              background: "rgba(166,225,255,0.03)",
              color: "var(--color-fg-secondary)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background 200ms ease, border-color 200ms ease",
              letterSpacing: "-0.01em",
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(166,225,255,0.06)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.15)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(166,225,255,0.03)";
              e.currentTarget.style.borderColor = "rgba(166,225,255,0.08)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Show .zip in folder
          </button>
        </div>

        {zipRevealed && (
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--color-fg-faint)",
            letterSpacing: "-0.01em",
            wordBreak: "break-all",
            textAlign: "center",
            lineHeight: 1.4,
          }}>
            {zipRevealed}
          </span>
        )}
      </div>
    </>
  );
}

// ── Draggable extension zip card (shared by onboarding & settings) ──

function ExtensionDragCard() {
  const cardRef = useRef<HTMLDivElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    e.stopPropagation();
    e.preventDefault();

    const innerCard = cardRef.current;
    const placeholder = placeholderRef.current;
    const wrapper = wrapperRef.current;
    if (!innerCard || !wrapper) return;

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
    wrapper.style.cursor = "grabbing";

    let osDragStarted = false;
    const fadeZone = 80;

    const onMove = (ev: PointerEvent) => {
      ghost.style.left = `${ev.clientX - offsetX}px`;
      ghost.style.top = `${ev.clientY - offsetY}px`;

      if (!osDragStarted) {
        const gx = ev.clientX - offsetX;
        const gy = ev.clientY - offsetY;
        const gw = rect.width;
        const gh = rect.height;
        const distToEdge = Math.min(
          gx, gy,
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
          wrapper.style.cursor = "grab";
        };
        getExtensionZip().then(async (zipPath) => {
          const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
          await startDrag({ item: [zipPath], icon: "" });
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
        wrapper.style.cursor = "grab";
        setTimeout(() => ghost.remove(), 300);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", cursor: "grab" }}
      onPointerDown={handlePointerDown}
    >
      {/* Dashed placeholder — visible when zip box is dragged away */}
      <div
        ref={placeholderRef}
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
      {/* Visual zip box */}
      <div
        ref={cardRef}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "scale(1.06)";
          e.currentTarget.style.filter = "brightness(1.05)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "scale(1)";
          e.currentTarget.style.filter = "brightness(1)";
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
            fontSize: 13,
            fontWeight: 550,
            color: "#0C2937",
            letterSpacing: "-0.01em",
            display: "block",
          }}>
            kept-extension.zip
          </span>
          <span style={{
            fontSize: 11,
            fontWeight: 500,
            color: "rgba(12,41,55,0.5)",
          }}>
            Drag to extensions page
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Knowledge Graph card definitions ─────────────────────────

const KG_CARDS = [
  { key: "stats", label: "Graph\nStats", image: "/sources/network.webp", brightness: 1.2, baseWeight: 1.5 },
  { key: "index", label: "Build\nGraph", image: "/sources/tools.webp", brightness: 1.1, baseWeight: 1.0 },
  { key: "reset", label: "Delete\nGraph", image: "/sources/facility.webp", brightness: 1.0, baseWeight: 0.7 },
] as const;

// ── KG section — full-bleed parallax cards ──

function KnowledgeGraphSection({ kgStats, indexing, indexResult, onIndex, onReset }: {
  kgStats: KgStats | null;
  indexing: boolean;
  indexResult: string | null;
  onIndex: () => void;
  onReset: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isEmpty = kgStats && kgStats.entity_count === 0 && kgStats.triple_count === 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr minmax(160px, 0.4fr)",
        gridTemplateRows: "1fr 1fr",
        gap: 6,
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* ── Stats card (spans both rows on the left) ── */}
      <KgCard
        card={KG_CARDS[0]}
        cardIdx={0}
        isHovered={false}
        kgStats={kgStats}
        indexing={indexing}
        indexResult={indexResult}
        onIndex={onIndex}
        onReset={() => setConfirmingDelete(true)}
      />

      {/* ── Action cards (right column, stacked) ── */}
      <KgActionsColumn
        cardIdx={1}
        isEmpty={!!isEmpty}
        indexing={indexing}
        indexResult={indexResult}
        onIndex={onIndex}
        onDelete={() => setConfirmingDelete(true)}
      />

      {/* ── Delete graph confirmation modal ── */}
      {confirmingDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(2, 10, 13, 0.75)",
            backdropFilter: "blur(16px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "cardSlideIn 250ms cubic-bezier(0.16,1,0.3,1) forwards",
          }}
          onClick={() => setConfirmingDelete(false)}
        >
          <div
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 16,
              padding: "28px 30px 24px",
              width: "min(380px, 85vw)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(195,236,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--color-fg-secondary)",
              letterSpacing: "-0.03em",
              fontVariationSettings: '"opsz" 30',
            }}>
              Delete knowledge graph?
            </span>
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              color: "var(--color-fg-faint)",
              lineHeight: 1.5,
            }}>
              This will permanently delete all extracted entities and relationships. You can rebuild the graph afterward.
            </span>
            <div style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 6,
            }}>
              <button
                onClick={() => setConfirmingDelete(false)}
                style={{
                  background: "transparent",
                  color: "var(--color-fg-faint)",
                  border: "none",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  borderRadius: 8,
                  transition: "color 200ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-faint)"; }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onReset();
                  setConfirmingDelete(false);
                }}
                style={{
                  background: "rgba(122, 48, 64, 0.3)",
                  color: "#FF8A9E",
                  border: "1px solid #7A3040",
                  borderRadius: 8,
                  padding: "8px 20px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  transition: "all 200ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(122, 48, 64, 0.5)";
                  e.currentTarget.style.color = "#FFB0BE";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(122, 48, 64, 0.3)";
                  e.currentTarget.style.color = "#FF8A9E";
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Individual KG card ──────────────────────────────────────

function KgCard({
  card,
  cardIdx,
  isHovered,
  kgStats,
  indexing,
  indexResult,
  onIndex,
  onReset,
}: {
  card: typeof KG_CARDS[number];
  cardIdx: number;
  isHovered: boolean;
  kgStats: KgStats | null;
  indexing: boolean;
  indexResult: string | null;
  onIndex: () => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState("inset(0 round 20px)");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) setClip(`path("${squirclePath(w, h, 20)}")`);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const isAction = card.key === "index" || card.key === "reset";
  const hasContent = card.key === "stats" ? !!kgStats : true;
  const isEmpty = kgStats && kgStats.entity_count === 0 && kgStats.triple_count === 0;

  return (
    <div
      ref={ref}
      className="relative w-full h-full"
      style={{
        clipPath: clip,
        overflow: "hidden",
        borderRadius: 20,
        background: "var(--color-base)",
        opacity: 0,
        animation: `cardSlideIn 600ms cubic-bezier(0.16,1,0.3,1) ${cardIdx * 80}ms forwards`,
        display: "flex",
        flexDirection: "column",
        cursor: isAction ? "pointer" : "default",
        ...(card.key === "stats" ? { gridRow: "1 / 3" } : {}),
      }}
      onClick={
        card.key === "index" && !indexing ? onIndex
        : card.key === "reset" ? onReset
        : undefined
      }
    >
      {/* Blurred background image */}
      <img
        src={card.image}
        alt=""
        draggable={false}
        className="absolute pointer-events-none select-none"
        style={{
          top: 0, left: 0, width: "100%", height: "100%",
          objectFit: "cover",
          opacity: hasContent ? (isHovered ? 0.55 : 0.45) : (isHovered ? 0.25 : 0.15),
          filter: hasContent
            ? (isHovered ? `blur(12px) saturate(1.5) brightness(${card.brightness})` : `blur(16px) saturate(1.3) brightness(${card.brightness})`)
            : (isHovered ? `blur(22px) saturate(0.8) brightness(${card.brightness})` : `blur(32px) saturate(0.6) brightness(${card.brightness})`),
          transition: "opacity 400ms ease, filter 400ms ease",
          transform: "scale(1.5)",
          willChange: "transform",
        }}
      />

      {/* Card label — top left */}
      <div style={{
        padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
        position: "relative",
        zIndex: 1,
      }}>
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: "clamp(14px, 1.6vw, 20px)",
          fontWeight: 500,
          color: hasContent ? "var(--color-fg)" : (isHovered ? "rgba(195,236,255,0.5)" : "rgba(195,236,255,0.25)"),
          letterSpacing: "-0.03em",
          lineHeight: 1.15,
          display: "block",
          whiteSpace: "pre-line",
          textShadow: hasContent ? "0 1px 8px rgba(0,0,0,0.5)" : "none",
          transition: "color 300ms ease",
        }}>
          {card.key === "index" && !isEmpty ? "Rebuild\nGraph" : card.label}
        </span>
      </div>

      {/* Card content */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: isAction ? "flex-end" : "flex-start",
          padding: "0 clamp(10px, 1.5vw, 16px) clamp(10px, 1.5vw, 16px)",
          gap: 6,
          overflowY: "auto",
        }}
        className="scrollbar-none"
      >
        {/* ── Stats card content ── */}
        {card.key === "stats" && kgStats && isEmpty && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div
              style={{
                background: "rgba(2, 10, 13, 0.45)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(195, 236, 255, 0.06)",
                borderRadius: 12,
                padding: "16px 20px",
                textAlign: "center",
              }}
            >
              <div style={{
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                color: "var(--color-fg-muted)",
                lineHeight: 1.5,
              }}>
                Knowledge graph is empty
              </div>
              <div style={{
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                color: "var(--color-fg-faint)",
                marginTop: 4,
              }}>
                Use Build Graph to extract entities from your conversations
              </div>
            </div>
          </div>
        )}
        {card.key === "stats" && kgStats && !isEmpty && (
          <>
            {/* Stat counters */}
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { label: "Entities", value: kgStats.entity_count },
                { label: "Relations", value: kgStats.triple_count },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    flex: 1,
                    background: "rgba(2, 10, 13, 0.45)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(195, 236, 255, 0.06)",
                    borderRadius: 12,
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <span style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: "clamp(18px, 2.2vw, 28px)",
                    fontWeight: 600,
                    color: "var(--color-fg)",
                    letterSpacing: "-0.03em",
                  }}>
                    {s.value}
                  </span>
                  <span style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 9,
                    fontWeight: 500,
                    color: "rgba(195, 236, 255, 0.35)",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { label: "Conversations", value: kgStats.conversation_count },
                { label: "Projects", value: kgStats.project_count },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    flex: 1,
                    background: "rgba(2, 10, 13, 0.45)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(195, 236, 255, 0.06)",
                    borderRadius: 12,
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <span style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: "clamp(18px, 2.2vw, 28px)",
                    fontWeight: 600,
                    color: "var(--color-fg)",
                    letterSpacing: "-0.03em",
                  }}>
                    {s.value}
                  </span>
                  <span style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 9,
                    fontWeight: 500,
                    color: "rgba(195, 236, 255, 0.35)",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Top entities */}
            {kgStats.top_entities.length > 0 && (
              <div
                style={{
                  background: "rgba(2, 10, 13, 0.45)",
                  backdropFilter: "blur(12px)",
                  border: "1px solid rgba(195, 236, 255, 0.06)",
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                <div style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 9,
                  fontWeight: 500,
                  color: "rgba(195, 236, 255, 0.35)",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  lineHeight: 1,
                  marginBottom: 8,
                }}>
                  Top Entities
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {kgStats.top_entities.slice(0, 8).map(([name, count]) => (
                    <span
                      key={name}
                      style={{
                        background: "rgba(195, 236, 255, 0.06)",
                        border: "1px solid rgba(195, 236, 255, 0.08)",
                        borderRadius: 8,
                        padding: "4px 10px",
                        fontFamily: "var(--font-sans)",
                        fontSize: 11,
                        color: "var(--color-fg-secondary)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      {name}
                      <span style={{ color: "var(--color-fg-faint)", fontSize: 10 }}>{count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Index card content ── */}
        {card.key === "index" && (
          <div
            style={{
              background: "rgba(2, 10, 13, 0.45)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(195, 236, 255, 0.06)",
              borderRadius: 12,
              padding: "10px 14px",
            }}
          >
            <div style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--color-fg-muted)",
              lineHeight: 1.5,
            }}>
              {indexing
                ? "Building knowledge graph from conversations..."
                : indexResult
                  ? indexResult
                  : isEmpty
                    ? "Extract keywords and relationships from your conversations into the knowledge graph"
                    : "Re-extract keywords and rebuild the knowledge graph from your conversations"}
            </div>
          </div>
        )}

        {/* ── Reset card content ── */}
        {card.key === "reset" && (
          <div
            style={{
              background: "rgba(2, 10, 13, 0.45)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(195, 236, 255, 0.06)",
              borderRadius: 12,
              padding: "10px 14px",
            }}
          >
            <div style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--color-fg-muted)",
              lineHeight: 1.5,
            }}>
              Permanently delete all entities and relationships from the knowledge graph.
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation modal moved to KnowledgeGraphSection */}
    </div>
  );
}

// ── KG actions column (build + delete, stacked with hover) ──

const KG_ACTION_CARDS = [
  { key: "index", label: "Build\nGraph", image: "/sources/tools.webp", brightness: 1.1 },
  { key: "reset", label: "Delete\nGraph", image: "/sources/facility.webp", brightness: 1.0 },
] as const;

type KgActionCardDef = typeof KG_ACTION_CARDS[number];

function KgActionCard({ action, isEmpty, indexing, indexResult, onIndex, onDelete }: {
  action: KgActionCardDef;
  isEmpty: boolean;
  indexing: boolean;
  indexResult: string | null;
  onIndex: () => void;
  onDelete: () => void;
}) {
  const isIndex = action.key === "index";
  const ref = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState("inset(0 round 20px)");
  const [hov, setHov] = useState(false);
  const busy = isIndex && indexing;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) setClip(`path("${squirclePath(w, h, 20)}")`);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        position: "relative",
        clipPath: clip,
        overflow: "hidden",
        borderRadius: 20,
        background: "var(--color-base)",
        display: "flex",
        flexDirection: "column",
        cursor: busy ? "wait" : "pointer",
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => {
        if (busy) return;
        if (isIndex) onIndex();
        else onDelete();
      }}
    >
      <img
        src={action.image}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          top: 0, left: 0, width: "100%", height: "100%",
          objectFit: "cover",
          opacity: hov ? 0.55 : 0.45,
          filter: hov
            ? `blur(12px) saturate(1.5) brightness(${action.brightness})`
            : `blur(16px) saturate(1.3) brightness(${action.brightness})`,
          transition: "opacity 400ms ease, filter 400ms ease",
          transform: "scale(1.5)",
          willChange: "transform",
          pointerEvents: "none",
        }}
      />
      <div style={{
        padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
        position: "relative",
        zIndex: 1,
      }}>
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: "clamp(14px, 1.6vw, 20px)",
          fontWeight: 500,
          color: "var(--color-fg)",
          letterSpacing: "-0.03em",
          lineHeight: 1.15,
          display: "block",
          whiteSpace: "pre-line",
          textShadow: "0 1px 8px rgba(0,0,0,0.5)",
        }}>
          {isIndex && !isEmpty ? "Rebuild\nGraph" : action.label}
        </span>
      </div>
      <div style={{
        position: "relative",
        zIndex: 2,
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        padding: "0 clamp(10px, 1.5vw, 16px) clamp(10px, 1.5vw, 16px)",
        gap: 6,
      }}>
        <div style={{
          background: "rgba(2, 10, 13, 0.45)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(195, 236, 255, 0.06)",
          borderRadius: 12,
          padding: "10px 14px",
        }}>
          <div style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--color-fg-muted)",
            lineHeight: 1.5,
          }}>
            {isIndex
              ? (busy
                  ? "Building knowledge graph from conversations..."
                  : indexResult
                    ? indexResult
                    : isEmpty
                      ? "Extract keywords and relationships from your conversations into the knowledge graph"
                      : "Re-extract keywords and rebuild the knowledge graph from your conversations")
              : "Permanently delete all entities and relationships from the knowledge graph"
            }
          </div>
        </div>
      </div>
    </div>
  );
}

function KgActionsColumn({ cardIdx, isEmpty, indexing, indexResult, onIndex, onDelete }: {
  cardIdx: number;
  isEmpty: boolean;
  indexing: boolean;
  indexResult: string | null;
  onIndex: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 6,
      opacity: 0,
      animation: `cardSlideIn 600ms cubic-bezier(0.16,1,0.3,1) ${cardIdx * 80}ms forwards`,
      gridRow: "1 / 3",
    }}>
      {KG_ACTION_CARDS.map((action) => (
        <KgActionCard
          key={action.key}
          action={action}
          isEmpty={isEmpty}
          indexing={indexing}
          indexResult={indexResult}
          onIndex={onIndex}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

// ── Vault card definitions ───────────────────────────────────

const VAULT_ACTION_CARDS = [
  { key: "rebuild", label: "Refresh\nDatabase", image: "/sources/connection.webp", brightness: 1.1 },
  { key: "clear", label: "Clear\nVault", image: "/sources/private.webp", brightness: 0.9 },
] as const;

type VaultActionCardDef = typeof VAULT_ACTION_CARDS[number];

function VaultActionCard({ action, reindexing, reindexResult, clearing, clearResult, onReindex, onClearRequest }: {
  action: VaultActionCardDef;
  reindexing: boolean;
  reindexResult: string | null;
  clearing: boolean;
  clearResult: string | null;
  onReindex: () => void;
  onClearRequest: () => void;
}) {
  const isRebuild = action.key === "rebuild";
  const isClear = action.key === "clear";
  const ref = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState("inset(0 round 20px)");
  const [hov, setHov] = useState(false);
  const busy = isRebuild ? reindexing : clearing;
  const result = isRebuild ? reindexResult : clearResult;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) setClip(`path("${squirclePath(w, h, 20)}")`);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        position: "relative",
        clipPath: clip,
        overflow: "hidden",
        borderRadius: 20,
        background: "var(--color-base)",
        display: "flex",
        flexDirection: "column",
        cursor: busy ? "wait" : "pointer",
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => {
        if (busy) return;
        if (isRebuild) onReindex();
        if (isClear) onClearRequest();
      }}
    >
      <img
        src={action.image}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          top: 0, left: 0, width: "100%", height: "100%",
          objectFit: "cover",
          opacity: hov ? 0.55 : 0.45,
          filter: hov
            ? `blur(12px) saturate(1.5) brightness(${action.brightness})`
            : `blur(16px) saturate(1.3) brightness(${action.brightness})`,
          transition: "opacity 400ms ease, filter 400ms ease",
          transform: "scale(1.5)",
          willChange: "transform",
          pointerEvents: "none",
        }}
      />
      <div style={{
        padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
        position: "relative",
        zIndex: 1,
      }}>
        <span style={{
          fontFamily: "'DM Sans', sans-serif",
          fontSize: "clamp(14px, 1.6vw, 20px)",
          fontWeight: 500,
          color: "var(--color-fg)",
          letterSpacing: "-0.03em",
          lineHeight: 1.15,
          display: "block",
          whiteSpace: "pre-line",
          textShadow: "0 1px 8px rgba(0,0,0,0.5)",
        }}>
          {action.label}
        </span>
      </div>
      <div style={{
        position: "relative",
        zIndex: 2,
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        padding: "0 clamp(10px, 1.5vw, 16px) clamp(10px, 1.5vw, 16px)",
        gap: 6,
      }}>
        <div style={{
          background: "rgba(2, 10, 13, 0.45)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(195, 236, 255, 0.06)",
          borderRadius: 12,
          padding: "10px 14px",
        }}>
          <div style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--color-fg-muted)",
            lineHeight: 1.5,
          }}>
            {isRebuild
              ? (busy ? "Refreshing database..." : result ? result : "Re-scan vault files and refresh the search database")
              : (busy ? "Clearing vault..." : result ? result : "Delete all archived conversations and their search index")
            }
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Vault section — full-bleed parallax cards like API keys / models ──

function VaultSection({ vaultPath, vaultStats, reindexing, reindexResult, onReindex, clearing, clearResult, onClear }: {
  vaultPath: string;
  vaultStats: VaultStats | null;
  reindexing: boolean;
  reindexResult: string | null;
  onReindex: () => void;
  clearing: boolean;
  clearResult: string | null;
  onClear: () => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  const fmt = (b: number) => {
    if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${b} B`;
  };

  const segments = vaultStats ? [
    { label: "Conversations", bytes: vaultStats.conversations_bytes, color: "#3B9ECC" },
    { label: "Assets", bytes: vaultStats.assets_bytes, color: "#7AA2F7" },
    { label: "Database", bytes: vaultStats.database_bytes, color: "#9ECE6A" },
    { label: "Knowledge Graph", bytes: vaultStats.kg_bytes, color: "#BB9AF7" },
  ] : [];
  const totalBytes = segments.reduce((s, seg) => s + seg.bytes, 0);

  return (
    <div
      ref={gridRef}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr minmax(160px, 0.4fr)",
        gridTemplateRows: "1fr 1fr",
        gap: 6,
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* ── Combined vault info card (path + storage) — spans both rows ── */}
      <div
        style={{
          position: "relative",
          gridRow: "1 / 3",
          minHeight: 0,
          borderRadius: 20,
          overflow: "hidden",
          background: "var(--color-base)",
          display: "flex",
          flexDirection: "column",
          opacity: 0,
          animation: "cardSlideIn 600ms cubic-bezier(0.16,1,0.3,1) forwards",
        }}
      >
        <img
          src="/sources/facility.webp"
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            top: 0, left: 0, width: "100%", height: "100%",
            objectFit: "cover",
            opacity: 0.45,
            filter: "blur(16px) saturate(1.3) brightness(1.3)",
            transition: "opacity 400ms ease, filter 400ms ease",
            transform: "scale(1.5)",
            willChange: "transform",
            pointerEvents: "none",
          }}
        />

        <div style={{
          padding: "clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 28px)",
          position: "relative",
          zIndex: 1,
        }}>
          <span style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: "clamp(14px, 1.6vw, 20px)",
            fontWeight: 500,
            color: "var(--color-fg)",
            letterSpacing: "-0.03em",
            lineHeight: 1.15,
            display: "block",
            textShadow: "0 1px 8px rgba(0,0,0,0.5)",
          }}>
            Vault
          </span>
        </div>

        <div style={{
          position: "relative",
          zIndex: 2,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: "0 clamp(10px, 1.5vw, 16px) clamp(10px, 1.5vw, 16px)",
          gap: 8,
        }}>
          {/* Path */}
          <div style={{
            background: "rgba(2, 10, 13, 0.45)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(195, 236, 255, 0.06)",
            borderRadius: 12,
            padding: "10px 14px",
          }}>
            <div style={{
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 500,
              color: "rgba(195, 236, 255, 0.35)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              lineHeight: 1,
              marginBottom: 6,
            }}>
              Location
            </div>
            <div style={{
              fontFamily: "var(--font-mono)",
              fontSize: "clamp(11px, 1.2vw, 14px)",
              color: "var(--color-fg-secondary)",
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              maskImage: "linear-gradient(to right, black 80%, transparent 100%)",
              WebkitMaskImage: "linear-gradient(to right, black 80%, transparent 100%)",
            }}>
              {vaultPath || "~/.kept/vault/"}
            </div>
          </div>

          {/* Stats row */}
          {vaultStats && (
            <div style={{ display: "flex", gap: 6 }}>
              <div style={{
                flex: 1,
                background: "rgba(2, 10, 13, 0.45)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(195, 236, 255, 0.06)",
                borderRadius: 12,
                padding: "10px 14px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}>
                <span style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "clamp(16px, 2vw, 24px)",
                  fontWeight: 600,
                  color: "var(--color-fg)",
                  letterSpacing: "-0.03em",
                }}>
                  {vaultStats.conversation_count}
                </span>
                <span style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 9,
                  fontWeight: 500,
                  color: "rgba(195, 236, 255, 0.35)",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}>
                  Conversations
                </span>
              </div>
              <div style={{
                flex: 1,
                background: "rgba(2, 10, 13, 0.45)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(195, 236, 255, 0.06)",
                borderRadius: 12,
                padding: "10px 14px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}>
                <span style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "clamp(16px, 2vw, 24px)",
                  fontWeight: 600,
                  color: "var(--color-fg)",
                  letterSpacing: "-0.03em",
                }}>
                  {vaultStats.asset_count}
                </span>
                <span style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 9,
                  fontWeight: 500,
                  color: "rgba(195, 236, 255, 0.35)",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}>
                  Assets
                </span>
              </div>
              <div style={{
                flex: 1,
                background: "rgba(2, 10, 13, 0.45)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(195, 236, 255, 0.06)",
                borderRadius: 12,
                padding: "10px 14px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}>
                <span style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "clamp(16px, 2vw, 24px)",
                  fontWeight: 600,
                  color: "var(--color-fg)",
                  letterSpacing: "-0.03em",
                }}>
                  {fmt(totalBytes)}
                </span>
                <span style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 9,
                  fontWeight: 500,
                  color: "rgba(195, 236, 255, 0.35)",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}>
                  Total Size
                </span>
              </div>
            </div>
          )}

          {/* Storage bar */}
          {vaultStats && totalBytes > 0 && (
            <div style={{
              background: "rgba(2, 10, 13, 0.45)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(195, 236, 255, 0.06)",
              borderRadius: 12,
              padding: "10px 14px",
            }}>
              <div style={{
                display: "flex",
                height: 6,
                borderRadius: 3,
                overflow: "hidden",
                gap: 2,
              }}>
                {segments.filter(s => s.bytes > 0).map((seg) => (
                  <div
                    key={seg.label}
                    title={`${seg.label}: ${fmt(seg.bytes)}`}
                    style={{
                      flex: seg.bytes / totalBytes,
                      background: seg.color,
                      borderRadius: 3,
                      opacity: 0.6,
                      minWidth: 4,
                    }}
                  />
                ))}
              </div>
              <div style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "4px 12px",
                marginTop: 8,
              }}>
                {segments.filter(s => s.bytes > 0).map((seg) => (
                  <span key={seg.label} style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 10,
                    color: "rgba(195, 236, 255, 0.35)",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: 3,
                      background: seg.color, opacity: 0.6,
                      display: "inline-block",
                    }} />
                    {seg.label} {fmt(seg.bytes)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Open Vault button */}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={(e) => { e.stopPropagation(); openVault(); }}
              style={{
                background: "rgba(2, 10, 13, 0.45)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(195, 236, 255, 0.06)",
                borderRadius: 12,
                padding: "10px 18px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                transition: "all 250ms ease",
                fontFamily: "'DM Sans', sans-serif",
                fontSize: "clamp(12px, 1.3vw, 15px)",
                fontWeight: 500,
                color: "var(--color-fg-secondary)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "rgba(195, 236, 255, 0.15)";
                e.currentTarget.style.background = "rgba(2, 10, 13, 0.55)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "rgba(195, 236, 255, 0.06)";
                e.currentTarget.style.background = "rgba(2, 10, 13, 0.45)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Open Vault
            </button>
          </div>
        </div>
      </div>

      {/* ── Action cards (right column, one per row) ── */}
      <VaultActionsColumn
        cardIdx={1}
        reindexing={reindexing}
        reindexResult={reindexResult}
        onReindex={onReindex}
        clearing={clearing}
        clearResult={clearResult}
        onClear={onClear}
      />
    </div>
  );
}

// ── Vault actions column (rebuild + clear, stacked) ──────────

function VaultActionsColumn({ cardIdx, reindexing, reindexResult, onReindex, clearing, clearResult, onClear }: {
  cardIdx: number;
  reindexing: boolean;
  reindexResult: string | null;
  onReindex: () => void;
  clearing: boolean;
  clearResult: string | null;
  onClear: () => void;
}) {
  const [confirmingClear, setConfirmingClear] = useState(false);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 6,
      opacity: 0,
      animation: `cardSlideIn 600ms cubic-bezier(0.16,1,0.3,1) ${cardIdx * 80}ms forwards`,
      gridRow: "1 / 3",
    }}>
      {VAULT_ACTION_CARDS.map((action) => (
        <VaultActionCard
          key={action.key}
          action={action}
          reindexing={reindexing}
          reindexResult={reindexResult}
          clearing={clearing}
          clearResult={clearResult}
          onReindex={onReindex}
          onClearRequest={() => setConfirmingClear(true)}
        />
      ))}

      {/* ── Clear vault confirmation modal ── */}
      {confirmingClear && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(2, 10, 13, 0.75)",
            backdropFilter: "blur(16px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "cardSlideIn 250ms cubic-bezier(0.16,1,0.3,1) forwards",
          }}
          onClick={() => setConfirmingClear(false)}
        >
          <div
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 16,
              padding: "28px 30px 24px",
              width: "min(380px, 85vw)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(195,236,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--color-fg-secondary)",
              letterSpacing: "-0.03em",
              fontVariationSettings: '"opsz" 30',
            }}>
              Clear all conversations?
            </span>
            <span style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              color: "var(--color-fg-faint)",
              lineHeight: 1.5,
            }}>
              This will permanently delete all archived conversations and their search index. Your knowledge graph and settings will not be affected.
            </span>
            <div style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 6,
            }}>
              <button
                onClick={() => setConfirmingClear(false)}
                style={{
                  background: "transparent",
                  color: "var(--color-fg-faint)",
                  border: "none",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  borderRadius: 8,
                  transition: "color 200ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-fg-secondary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-fg-faint)"; }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onClear();
                  setConfirmingClear(false);
                }}
                style={{
                  background: "rgba(122, 48, 64, 0.3)",
                  color: "#FF8A9E",
                  border: "1px solid #7A3040",
                  borderRadius: 8,
                  padding: "8px 20px",
                  fontSize: 13,
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  letterSpacing: "-0.03em",
                  fontVariationSettings: '"opsz" 30',
                  cursor: "pointer",
                  transition: "all 200ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(122, 48, 64, 0.5)";
                  e.currentTarget.style.color = "#FFB0BE";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(122, 48, 64, 0.3)";
                  e.currentTarget.style.color = "#FF8A9E";
                }}
              >
                Clear Vault
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Settings Component ──────────────────────────────────

export default function Settings({ activeSection, onSectionChange, onConfigChange, restrictedMode = false }: {
  activeSection: SectionId | null;
  onSectionChange: (section: SectionId | null) => void;
  onConfigChange?: (config: AppConfig) => void;
  restrictedMode?: boolean;
}) {
  const setActiveSection = onSectionChange;
  const [config, setLocalConfig] = useState<AppConfig | null>(null);
  const [vaultPath, setVaultPath] = useState<string>("");
  const [kgStats, setKgStats] = useState<KgStats | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexResult, setIndexResult] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<string | null>(null);
  const [vaultStats, setVaultStats] = useState<VaultStats | null>(null);
  const [hoveredSection, setHoveredSection] = useState<SectionId | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Detect tall/narrow aspect ratio for single-column fallback
  useEffect(() => {
    const el = gridRef.current?.parentElement ?? document.body;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setIsNarrow(width < 500 || height / width > 1.8);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    getConfig().then((next) => {
      setLocalConfig(next);
      onConfigChange?.(next);
    });
    getVaultPath().then(setVaultPath);
    cmdKgStats().then(setKgStats).catch(() => {});
    getVaultStats().then(setVaultStats).catch(() => {});
  }, [onConfigChange]);

  const persistConfig = useCallback(
    (next: AppConfig) => {
      setLocalConfig(next);
      onConfigChange?.(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setConfig(next);
      }, 600);
    },
    [onConfigChange],
  );

  const updateField = useCallback(
    <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
      if (!config) return;
      persistConfig({ ...config, [key]: value });
    },
    [config, persistConfig],
  );

  const handleIndexVault = useCallback(async () => {
    setIndexing(true);
    setIndexResult(null);
    try {
      const result = await cmdKgIndexVault(false);
      setIndexResult(result);
      cmdKgStats().then(setKgStats).catch(() => {});
    } catch (e) {
      setIndexResult(`Error: ${e}`);
    } finally {
      setIndexing(false);
    }
  }, [config]);

  const handleReindex = useCallback(async () => {
    setReindexing(true);
    setReindexResult(null);
    try {
      const result = await reindex();
      setReindexResult(result);
    } catch (e) {
      setReindexResult(`Error: ${e}`);
    } finally {
      setReindexing(false);
    }
  }, []);

  const handleClearVault = useCallback(async () => {
    setClearing(true);
    setClearResult(null);
    try {
      const { clearVault } = await import("../lib/tauri-api");
      const result = await clearVault();
      setClearResult(result);
      // Refresh vault stats
      try { setVaultStats(await getVaultStats()); } catch { /* ignore */ }
    } catch (e) {
      setClearResult(`Error: ${e}`);
    } finally {
      setClearing(false);
    }
  }, []);

  const handleResetKg = useCallback(async () => {
    try {
      await cmdKgResetDb();
    } catch (e) {
      console.error("KG reset failed:", e);
    }
    // Always refresh stats from backend after reset attempt
    try {
      const stats = await cmdKgStats();
      setKgStats(stats);
    } catch {
      setKgStats({ entity_count: 0, triple_count: 0, conversation_count: 0, project_count: 0, top_entities: [] });
    }
  }, []);

  // ── Bento grid parallax (hooks must be before early returns) ──

  const baseCols = [1.8, 1.2, 1.3];
  const baseRows = [1, 1];
  const boostCol = 0.4;
  const boostRow = 0.15;
  const sigma = 0.3;

  // Spring-based parallax: lerp current values toward target with momentum
  const targetCols = useRef([...baseCols]);
  const targetRows = useRef([...baseRows]);
  const currentCols = useRef([...baseCols]);
  const currentRows = useRef([...baseRows]);
  const rafId = useRef(0);

  useEffect(() => {
    if (activeSection) return;

    // Precompute centers
    const colTotal = baseCols.reduce((a, b) => a + b, 0);
    const colCenters: number[] = [];
    let colAcc = 0;
    for (const c of baseCols) { colCenters.push((colAcc + c / 2) / colTotal); colAcc += c; }

    const rowTotal = baseRows.reduce((a, b) => a + b, 0);
    const rowCenters: number[] = [];
    let rowAcc = 0;
    for (const r of baseRows) { rowCenters.push((rowAcc + r / 2) / rowTotal); rowAcc += r; }

    const onMove = (e: MouseEvent) => {
      const el = gridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;

      for (let i = 0; i < baseCols.length; i++) {
        const dist = mx - colCenters[i];
        targetCols.current[i] = baseCols[i] + boostCol * Math.exp(-dist * dist / (2 * sigma * sigma));
      }
      for (let i = 0; i < baseRows.length; i++) {
        const dist = my - rowCenters[i];
        targetRows.current[i] = baseRows[i] + boostRow * Math.exp(-dist * dist / (2 * sigma * sigma));
      }
    };

    // Spring animation loop
    const springK = 0.08; // stiffness — lower = more springy/laggy
    const damping = 0.75; // velocity retention
    const velCols = baseCols.map(() => 0);
    const velRows = baseRows.map(() => 0);

    const tick = () => {
      const el = gridRef.current;
      if (!el) { rafId.current = requestAnimationFrame(tick); return; }

      for (let i = 0; i < baseCols.length; i++) {
        const force = (targetCols.current[i] - currentCols.current[i]) * springK;
        velCols[i] = (velCols[i] + force) * damping;
        currentCols.current[i] += velCols[i];
      }
      for (let i = 0; i < baseRows.length; i++) {
        const force = (targetRows.current[i] - currentRows.current[i]) * springK;
        velRows[i] = (velRows[i] + force) * damping;
        currentRows.current[i] += velRows[i];
      }

      el.style.transition = "none";
      el.style.gridTemplateColumns = currentCols.current.map(c => `${c.toFixed(3)}fr`).join(" ");
      el.style.gridTemplateRows = currentRows.current.map(r => `${r.toFixed(3)}fr`).join(" ");

      rafId.current = requestAnimationFrame(tick);
    };

    rafId.current = requestAnimationFrame(tick);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(rafId.current);
    };
  }, [activeSection]);

  const gridAreaMap: Record<string, string> = {
    "api-access": "api", "general": "general", "knowledge-graph": "kg",
    "vault": "vault",
  };

  // ── Loading state ──

  if (!config) {
    return (
      <div className="w-full flex items-center justify-center py-20">
        <span className="text-sm text-fg-faint">Loading settings…</span>
      </div>
    );
  }

  // ── Transition: keep previous section mounted during exit animation ──

  const showGrid = !activeSection;
  const showDetail = !!activeSection;
  const transEase = "cubic-bezier(0.16,1,0.3,1)";
  const transDur = "500ms";

  return (
    <div className="relative w-full h-full font-sans" style={{ overflow: "hidden" }}>
      {/* ── Bento grid layer ── */}
      <div
        ref={gridRef}
        className="absolute inset-0"
        style={{
          ...(isNarrow ? {
            padding: "8px 16px 16px",
            display: "flex",
            flexDirection: "column" as const,
            gap: 6,
            overflowY: "auto" as const,
          } : {
            padding: "8px 36px 16px",
            display: "grid",
            gridTemplateColumns: baseCols.map(c => `${c}fr`).join(" "),
            gridTemplateRows: baseRows.map(r => `${r}fr`).join(" "),
            gridTemplateAreas: `
              "general vault   api"
              "general kg      api"
            `,
            gap: 6,
          }),
          opacity: showGrid ? 1 : 0,
          transform: showGrid ? "scale(1)" : "scale(1.04)",
          pointerEvents: showGrid ? "auto" : "none",
          transition: `opacity ${transDur} ${transEase}, transform ${transDur} ${transEase}`,
        }}
      >
        {SECTIONS.map((s) => (
          <div key={s.id} style={isNarrow
            ? { minHeight: 140, flex: "1 1 0%" }
            : { gridArea: gridAreaMap[s.id] }
          }>
            <BentoCard
              label={s.label}
              description={s.description}
              image={s.image}
              isHovered={hoveredSection === s.id}
              onClick={() => setActiveSection(s.id)}
              onEnter={() => {
                if (hoverLeaveTimer.current) { clearTimeout(hoverLeaveTimer.current); hoverLeaveTimer.current = null; }
                setHoveredSection(s.id);
              }}
              onLeave={() => {
                if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
                hoverLeaveTimer.current = setTimeout(() => setHoveredSection(null), 300);
              }}
            />
          </div>
        ))}
      </div>

      {/* ── Detail view layer ── */}
      <div
        className="absolute inset-0 scrollbar-none"
        style={{
          opacity: showDetail ? 1 : 0,
          transform: showDetail ? "translateY(0) scale(1)" : "translateY(12px) scale(0.97)",
          pointerEvents: showDetail ? "auto" : "none",
          transition: `opacity ${transDur} ${transEase}, transform ${transDur} ${transEase}`,
          ...(activeSection === "api-access" || activeSection === "general" || activeSection === "vault" || activeSection === "knowledge-graph"
            ? { display: "flex", flexDirection: "column" as const, padding: "8px 36px 16px" }
            : { overflowY: "auto" as const, maskImage: showDetail
                ? "linear-gradient(to bottom, transparent 0px, black 40px, black calc(100% - 40px), transparent 100%)"
                : "none" }
          ),
        }}
      >
        {activeSection === "api-access" ? (
          <ProvidersSection config={config!} updateField={updateField} restrictedMode={restrictedMode} />
        ) : activeSection === "general" ? (
          <GeneralSection config={config!} updateField={updateField} />
        ) : activeSection === "vault" ? (
          <VaultSection
            vaultPath={vaultPath}
            vaultStats={vaultStats}
            reindexing={reindexing}
            reindexResult={reindexResult}
            onReindex={handleReindex}
            clearing={clearing}
            clearResult={clearResult}
            onClear={handleClearVault}
          />
        ) : activeSection === "knowledge-graph" ? (
          <KnowledgeGraphSection
            kgStats={kgStats}
            indexing={indexing}
            indexResult={indexResult}
            onIndex={handleIndexVault}
            onReset={handleResetKg}
          />
        ) : null}
      </div>
    </div>
  );
}
