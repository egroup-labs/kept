import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDown, ChevronRight, Search, Settings2 } from "lucide-react";
import {
  type CSSProperties,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Squircle from "./Squircle";
import { readFileBase64 } from "../lib/tauri-api";
import type { ChatAttachment } from "../lib/types";

/** Scale factor based on viewport height. Baseline = 900px CSS pixels. */
export function useScale() {
  const compute = () => {
    const fromHeight = window.innerHeight / 900;
    const fromWidth = window.innerWidth / 700;
    return Math.max(0.95, Math.min(1.15, fromHeight, fromWidth));
  };
  const [scale, setScale] = useState(compute);

  useEffect(() => {
    let rafId = 0;
    const update = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        setScale(compute());
      });
    };

    // Window resize
    window.addEventListener("resize", update);

    // DPI change via matchMedia (fires when dragging between monitors)
    let mql: MediaQueryList | null = null;
    let onDpiChange: (() => void) | null = null;

    const watchDpi = () => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      onDpiChange = () => {
        update();
        // Re-arm for the new DPI value
        mql?.removeEventListener("change", onDpiChange!);
        watchDpi();
      };
      mql.addEventListener("change", onDpiChange);
    };
    watchDpi();

    // Tauri scale-factor change (most reliable for cross-monitor drag)
    const unlistenPromise = getCurrentWindow().onScaleChanged(() => update());

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", update);
      mql?.removeEventListener("change", onDpiChange!);
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  return scale;
}

interface ChatContainerProps {
  onSendMessage?: (text: string, model: string, attachments?: ChatAttachment[]) => void;
  onStop?: () => void;
  loading?: boolean;
  models?: ChatModelOption[];
  preferredModelIds?: string[];
  onConfigureModels?: () => void;
  onDropdownOpenChange?: (open: boolean) => void;
}

export interface ChatContainerHandle {
  focus: () => void;
}

export interface ChatModelOption {
  id: string;
  label: string;
  provider: string;
  providerId: string;
  modelId: string;
  lastUsedAt?: string | null;
  menuLabel?: string;
}

const MODEL_HISTORY_KEY = "kept_model_history";

function getModelHistory(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(MODEL_HISTORY_KEY) || "{}");
  } catch { return {}; }
}

function recordModelUse(modelId: string) {
  const history = getModelHistory();
  history[modelId] = Date.now();
  localStorage.setItem(MODEL_HISTORY_KEY, JSON.stringify(history));
}

function sortModels(models: ChatModelOption[], preferredModelIds: string[] = []): ChatModelOption[] {
  const history = getModelHistory();
  const preferredRanks = new Map(preferredModelIds.map((id, index) => [id, index]));
  return [...models].sort((a, b) => {
    // History-based sorting: most recently used first
    const aTime = history[a.id] ?? 0;
    const bTime = history[b.id] ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    // Then preferred models
    const aRank = preferredRanks.get(a.id);
    const bRank = preferredRanks.get(b.id);
    if (aRank !== undefined || bRank !== undefined) {
      if (aRank === undefined) return 1;
      if (bRank === undefined) return -1;
      if (aRank !== bRank) return aRank - bRank;
    }
    return a.provider.localeCompare(b.provider);
  });
}

function getClippingRect(element: HTMLElement): { top: number; bottom: number } {
  let current: HTMLElement | null = element.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    const overflow = style.overflow;
    if (/(hidden|clip|auto|scroll)/.test(overflowY) || /(hidden|clip|auto|scroll)/.test(overflow)) {
      const rect = current.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    current = current.parentElement;
  }

  return { top: 0, bottom: window.innerHeight };
}

const ChatContainer = forwardRef<ChatContainerHandle, ChatContainerProps>(function ChatContainer(
  { onSendMessage, onStop, loading, models = [], preferredModelIds = [], onConfigureModels, onDropdownOpenChange },
  ref,
) {
  const scale = useScale();
  /** Scale a base pixel value */
  const s = (v: number) => Math.round(v * scale);
  const sortedModels = useMemo(
    () => sortModels(models, preferredModelIds),
    [models, preferredModelIds],
  );
  const primaryModels = useMemo(() => sortedModels.slice(0, 3), [sortedModels]);
  const overflowModels = useMemo(() => sortedModels.slice(3), [sortedModels]);
  const overflowGroups = useMemo(() => {
    const grouped = new Map<string, ChatModelOption[]>();
    for (const model of overflowModels) {
      const existing = grouped.get(model.provider);
      if (existing) {
        existing.push(model);
      } else {
        grouped.set(model.provider, [model]);
      }
    }
    return Array.from(grouped.entries())
      .map(([provider, items]) => ({ provider, items: sortModels(items, preferredModelIds) }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [overflowModels, preferredModelIds]);
  const hasOverflow = overflowGroups.length > 0;

  // State
  const [textareaValue, setTextareaValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [textareaHeight, setTextareaHeight] = useState(s(40));
  const [isFocused, setIsFocused] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    // Initialize from history: pick the most recently used model that's available
    const history = getModelHistory();
    const available = new Set(sortedModels.map(m => m.id));
    const best = Object.entries(history)
      .filter(([id]) => available.has(id))
      .sort(([, a], [, b]) => b - a)[0];
    return best ? best[0] : sortedModels[0]?.id ?? null;
  });
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);
  const [isScrollbarHovered, setIsScrollbarHovered] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isMorePinned, setIsMorePinned] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string | null>(overflowGroups[0]?.provider ?? null);
  const [submenuOffsetTop, setSubmenuOffsetTop] = useState(0);
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);
  const [modelBtnHovered, setModelBtnHovered] = useState(false);
  const [sendBtnHovered, setSendBtnHovered] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredSearchModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return sortedModels.filter((model) => {
      const haystack = `${model.label} ${model.menuLabel ?? ""} ${model.provider} ${model.modelId}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [searchQuery, sortedModels]);
  const isSearchActive = searchQuery.trim().length > 0;
  const topPreferredModelId = useMemo(
    () => preferredModelIds.find((id) => models.some((model) => model.id === id)) ?? null,
    [models, preferredModelIds],
  );

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  const previousTopPreferredModelIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (topPreferredModelId && previousTopPreferredModelIdRef.current !== topPreferredModelId) {
      previousTopPreferredModelIdRef.current = topPreferredModelId;
      setSelectedModel(topPreferredModelId);
      return;
    }
    previousTopPreferredModelIdRef.current = topPreferredModelId;

    if (!models.some((model) => model.id === selectedModel)) {
      setSelectedModel(topPreferredModelId ?? sortedModels[0]?.id ?? null);
    }
  }, [models, selectedModel, sortedModels, topPreferredModelId]);

  useEffect(() => {
    if (!isDropdownOpen) {
      setIsMoreOpen(false);
      setIsMorePinned(false);
      setHoveredMenuItem(null);
      setSearchQuery("");
      return;
    }
    if (!hasOverflow) {
      setActiveProvider(null);
      setIsMoreOpen(false);
      setIsMorePinned(false);
      return;
    }
    const selectedOverflowProvider = overflowModels.find((model) => model.id === selectedModel)?.provider;
    setActiveProvider((current) => {
      if (current && overflowGroups.some((group) => group.provider === current)) {
        return current;
      }
      return selectedOverflowProvider ?? overflowGroups[0]?.provider ?? null;
    });
  }, [hasOverflow, isDropdownOpen, overflowGroups, overflowModels, selectedModel]);

  const selectedModelOption = useMemo(
    () => models.find((model) => model.id === selectedModel) ?? sortedModels[0] ?? null,
    [models, selectedModel, sortedModels],
  );
  const activeProviderGroup = overflowGroups.find((group) => group.provider === activeProvider) ?? overflowGroups[0] ?? null;
  const hasAvailableModels = sortedModels.length > 0;

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ y: 0, scrollTop: 0 });
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownPanelRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);

  // Scaled constants
  const containerWidth = s(560);
  const pad = s(20);
  const bottomPad = s(16);
  const btnH = s(44);
  const minTa = s(46);
  const maxTa = s(180);
  const containerHeight = textareaHeight + s(78);
  const isActive = hasAvailableModels && (isHovered || isFocused || isDraggingScrollbar || isDropdownOpen);

  // Shading dimensions — oversized so the blur feathers fully to the edges
  const shadingWidth = containerWidth * 1.1;
  const shadingHeight = containerHeight * 1.1;
  const shadingLeft = (containerWidth - shadingWidth) / 2;
  const shadingTop = (containerHeight - shadingHeight) / 2;

  // Parallax
  const parallaxX = (mousePos.x / containerWidth - 0.5) * s(-20);
  const parallaxY = (mousePos.y / containerHeight - 0.5) * s(-20);

  // Textarea auto-resize
  const updateThumbPosition = useCallback(() => {
    if (!textareaRef.current || !scrollbarThumbRef.current) return;
    const { scrollTop, scrollHeight } = textareaRef.current;
    const trackHeight = textareaHeight;
    const scrollRatio = trackHeight / scrollHeight;
    const thumbHeight = Math.max(trackHeight * scrollRatio, 16);
    const maxThumbTop = trackHeight - thumbHeight;
    const scrollPercent = scrollTop / (scrollHeight - trackHeight);
    const thumbTop = Math.min(
      Math.max(scrollPercent * maxThumbTop, 0),
      maxThumbTop
    );
    scrollbarThumbRef.current.style.height = `${thumbHeight}px`;
    scrollbarThumbRef.current.style.transform = `translateY(${thumbTop}px)`;
  }, [textareaHeight]);

  useLayoutEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "0px";
    const scrollHeight = textareaRef.current.scrollHeight;
    const newHeight = Math.min(Math.max(scrollHeight, minTa), maxTa);
    setTextareaHeight(newHeight);
    textareaRef.current.style.height = `${newHeight}px`;
    requestAnimationFrame(updateThumbPosition);
  }, [textareaValue, updateThumbPosition, minTa, maxTa]);

  // Scrollbar drag handling
  useEffect(() => {
    if (!isDraggingScrollbar) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!textareaRef.current) return;
      const { scrollHeight } = textareaRef.current;
      const trackHeight = textareaHeight;
      const deltaY = e.clientY - dragStartRef.current.y;
      const ratio = scrollHeight / trackHeight;
      textareaRef.current.scrollTop =
        dragStartRef.current.scrollTop + deltaY * ratio;
      updateThumbPosition();
    };
    const handleMouseUp = () => setIsDraggingScrollbar(false);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingScrollbar, textareaHeight, updateThumbPosition]);

  // Notify parent of dropdown open/close
  useEffect(() => {
    onDropdownOpenChange?.(isDropdownOpen);
  }, [isDropdownOpen, onDropdownOpenChange]);

  // Click outside to close dropdown
  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (modelSelectorRef.current?.contains(event.target as Node)) return;
      if (dropdownPanelRef.current?.contains(event.target as Node)) return;
      setIsDropdownOpen(false);
      setIsMoreOpen(false);
      setIsMorePinned(false);
      setHoveredMenuItem(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDropdownOpen]);

  // Mouse tracking for parallax
  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const handleScrollbarMouseDown = (e: React.MouseEvent) => {
    if (!textareaRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingScrollbar(true);
    dragStartRef.current = {
      y: e.clientY,
      scrollTop: textareaRef.current.scrollTop,
    };
  };

  const handleSend = () => {
    if ((!textareaValue.trim() && attachments.length === 0) || loading || !selectedModelOption) return;
    recordModelUse(selectedModelOption.id);

    // Separate path-ref attachments from base64 (image) attachments
    const pathRefs = attachments.filter(a => a.filePath && !a.data);
    const realAttachments = attachments.filter(a => !a.filePath || !!a.data);

    let messageText = textareaValue.trim();
    if (pathRefs.length > 0) {
      const lines = pathRefs.map(a => `[Attached file: ${a.filePath}]`).join("\n");
      messageText = lines + (messageText ? "\n\n" + messageText : "");
    }

    onSendMessage?.(messageText, selectedModelOption.id, realAttachments.length > 0 ? realAttachments : undefined);
    setTextareaValue("");
    setAttachments([]);
  };

  const compressImage = (dataUrl: string, maxDim = 1024, quality = 0.85): Promise<{ base64: string; dataUrl: string }> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: compressed.split(",")[1], dataUrl: compressed });
      };
      img.src = dataUrl;
    });
  };

  const addAttachmentFromFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      if (file.type.startsWith("image/")) {
        const { base64, dataUrl: preview } = await compressImage(dataUrl);
        setAttachments(prev => [...prev, { media_type: "image/jpeg", data: base64, filename: file.name, preview }]);
      } else {
        const base64 = dataUrl.split(",")[1];
        setAttachments(prev => [...prev, { media_type: file.type || "application/octet-stream", data: base64, filename: file.name }]);
      }
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addAttachmentFromFile(file);
        return;
      }
    }
  };

  // Tauri file drop listener (Tauri intercepts native drops before HTML5 events).
  // Debounce to prevent duplicate events (WebKitGTK / StrictMode can fire twice).
  const dropListenerRef = useRef<(() => void) | null>(null);
  const lastDropRef = useRef<number>(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        dropListenerRef.current?.();
        dropListenerRef.current = null;

        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
        const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf" };
        const unlisten = await getCurrentWindow().onDragDropEvent(async (event) => {
          if (event.payload.type === "drop") {
            // Debounce: ignore duplicate drop events within 500ms
            const now = Date.now();
            if (now - lastDropRef.current < 500) return;
            lastDropRef.current = now;

            const paths = [...new Set(event.payload.paths as string[])];
            const newAttachments: ChatAttachment[] = [];
            for (const filePath of paths) {
              const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
              const filename = filePath.split("/").pop() || filePath.split("\\").pop() || filePath;
              if (imageExts.has(ext)) {
                try {
                  const rawBase64 = await readFileBase64(filePath);
                  const origType = mimeMap[ext] || "image/png";
                  const dataUrl = `data:${origType};base64,${rawBase64}`;
                  const { base64, dataUrl: preview } = await compressImage(dataUrl);
                  newAttachments.push({ media_type: "image/jpeg", data: base64, filename, preview });
                } catch (err) {
                  console.error("Failed to read dropped file:", err);
                }
              } else {
                // Non-image files: store path reference — agent reads via tools
                newAttachments.push({ media_type: "text/plain", data: "", filename, filePath });
              }
            }
            if (newAttachments.length > 0) {
              setAttachments(prev => [...prev, ...newAttachments]);
            }
          }
        });
        if (cancelled) {
          unlisten();
        } else {
          dropListenerRef.current = unlisten;
        }
      } catch { /* not in Tauri */ }
    })();
    return () => {
      cancelled = true;
      dropListenerRef.current?.();
      dropListenerRef.current = null;
    };
  }, []);

  const showScrollbar =
    textareaRef.current &&
    textareaRef.current.scrollHeight > textareaHeight;

  // Dropdown dimensions
  const dropItemH = s(32);
  const dropGap = s(3);
  const dropPad = s(6);
  const dropdownItems = primaryModels.length + (hasOverflow ? 1 : 0);
  const dropdownHeight = dropPad * 2 + dropItemH * dropdownItems + dropGap * Math.max(0, dropdownItems - 1);
  const modelBtnW = s(188);
  const sendBtnW = s(72);
  const providerColumnW = s(122);
  const submenuGap = s(8);
  const submenuPad = s(6);
  const submenuColumnGap = s(6);
  const submenuModelColumnW = s(180);
  const submenuProviderRows = overflowGroups.length;
  const submenuVisibleRows = Math.max(activeProviderGroup?.items.length ?? 0, submenuProviderRows, 1);
  const submenuTopHeight = dropItemH * submenuVisibleRows + dropGap * Math.max(0, submenuVisibleRows - 1);
  // Bottom row (search + settings) + gap separating it from the top section
  const submenuBottomRowH = dropItemH;
  const submenuSectionGap = dropGap;
  const submenuHeight = submenuPad * 2 + submenuTopHeight + submenuSectionGap + submenuBottomRowH;
  const dropdownBottomOffset = btnH + bottomPad + s(6);
  const submenuTop = dropPad + primaryModels.length * (dropItemH + dropGap);
  const viewportMargin = s(12);
  const submenuShadowAllowance = s(18);
  const menuTextStyle = {
    fontFamily: '"DM Sans", sans-serif',
    fontSize: s(14),
    fontWeight: 600,
    color: "#0C2937",
    letterSpacing: "-0.04em",
  } satisfies CSSProperties;
  const handleModelSelect = (modelId: string) => {
    setSelectedModel(modelId);
    recordModelUse(modelId);
    setIsDropdownOpen(false);
    setIsMoreOpen(false);
    setIsMorePinned(false);
    setHoveredMenuItem(null);
    setSearchQuery("");
  };

  useLayoutEffect(() => {
    if (!isDropdownOpen || !isMoreOpen || !hasOverflow || !dropdownPanelRef.current || !moreButtonRef.current) {
      setSubmenuOffsetTop(submenuTop);
      return;
    }

    const updateSubmenuDirection = () => {
      const panelRect = dropdownPanelRef.current?.getBoundingClientRect();
      const moreRect = moreButtonRef.current?.getBoundingClientRect();
      if (!panelRect || !moreRect) return;

      const clippingRect = getClippingRect(dropdownPanelRef.current!);
      const alignedTop = moreRect.top - panelRect.top;
      const upwardAlignedTop = moreRect.bottom - panelRect.top - submenuHeight;
      const minTop = clippingRect.top + viewportMargin + submenuShadowAllowance - panelRect.top;
      const maxTop = clippingRect.bottom - viewportMargin - submenuShadowAllowance - submenuHeight - panelRect.top;
      const preferredTop =
        moreRect.top + submenuHeight > clippingRect.bottom - viewportMargin - submenuShadowAllowance
          ? upwardAlignedTop
          : alignedTop;
      setSubmenuOffsetTop(Math.min(Math.max(preferredTop, minTop), maxTop));
    };

    updateSubmenuDirection();
    window.addEventListener("resize", updateSubmenuDirection);
    return () => window.removeEventListener("resize", updateSubmenuDirection);
  }, [
    containerHeight,
    dropdownBottomOffset,
    dropdownHeight,
    hasOverflow,
    isDropdownOpen,
    isMoreOpen,
    submenuHeight,
    submenuTop,
    submenuShadowAllowance,
    viewportMargin,
  ]);

  return (
    <div
      className="relative transition-[width] duration-500 ease-out"
      style={{ width: containerWidth, maxWidth: "100%" }}
      ref={dropdownRef}
    >
      {/* Attachment previews — floating above the chat container */}
      {attachments.length > 0 && (
        <div
          className="flex flex-wrap"
          style={{
            gap: s(6),
            padding: `0 ${s(12)}px`,
            marginBottom: s(8),
          }}
        >
          {attachments.map((att, i) => (
            <div
              key={i}
              className="relative overflow-hidden flex items-center justify-center shrink-0 bg-[rgba(166,225,255,0.12)] border border-[rgba(166,225,255,0.15)] group"
              style={{
                width: s(44),
                height: s(44),
                borderRadius: s(8),
              }}
            >
              {att.preview ? (
                <img src={att.preview} alt="" className="w-full h-full object-cover" />
              ) : (
                <span
                  className="text-[rgba(166,225,255,0.5)] font-semibold"
                  style={{ fontSize: s(att.filePath ? 18 : 9) }}
                >
                  {att.filePath ? "\u{1F4CE}" : (att.filename?.split(".").pop()?.toUpperCase() || "FILE")}
                </span>
              )}
              <div
                onClick={(e) => { e.stopPropagation(); setAttachments(prev => prev.filter((_, j) => j !== i)); }}
                className="absolute flex items-center justify-center cursor-pointer bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-[ease]"
                style={{
                  top: s(2),
                  right: s(2),
                  width: s(16),
                  height: s(16),
                  borderRadius: s(8),
                }}
              >
                <svg width={s(8)} height={s(8)} viewBox="0 0 8 8" fill="none">
                  <path d="M1 1L7 7M7 1L1 7" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Ambient glow — soft halo behind the panel that blends into the dark bg */}
      <div
        className="absolute pointer-events-none"
        style={{
          inset: s(-28),
          borderRadius: s(44),
          background: isActive
            ? "radial-gradient(ellipse at 50% 55%, rgba(80,150,248,0.20) 0%, rgba(52,114,248,0.08) 40%, transparent 72%)"
            : "radial-gradient(ellipse at 50% 55%, rgba(80,150,248,0.09) 0%, rgba(52,114,248,0.03) 40%, transparent 72%)",
          transition: "background 700ms ease-out",
        }}
      />
      {/* Scale wrapper — outside clip-path so the whole squircle grows */}
      <div
        className={`transition-transform duration-100 ease-out ${isActive ? "scale-[1.003]" : "scale-100"}`}
      >
        {/* Main squircle container */}
        <Squircle
          width={containerWidth}
          height={containerHeight}
          radius={s(24)}
          shadow="shadow-2xl"
          className={hasAvailableModels ? "cursor-text" : "cursor-default"}
          onMouseMove={handleMouseMove}
          onMouseEnter={() => {
            if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
            setIsHovered(true);
          }}
          onMouseLeave={() => {
            hoverLeaveTimer.current = setTimeout(() => setIsHovered(false), 250);
            setMousePos({ x: containerWidth / 2, y: containerHeight / 2 });
          }}
          onClick={() => { if (hasAvailableModels) textareaRef.current?.focus(); }}
        >
          <div
            className={`relative w-full h-full ${hasAvailableModels ? "cursor-text" : "cursor-default"}`}
            onClick={() => { if (hasAvailableModels) textareaRef.current?.focus(); }}
          >
            {/* Background */}
            <div
              className="absolute inset-0"
              style={{ backgroundColor: "#89BCF5", pointerEvents: "none" }}
            />

            {/* Idle gradient (shading) layer */}
            <div
              className="absolute"
              style={{
                width: shadingWidth,
                height: shadingHeight,
                left: shadingLeft + parallaxX,
                top: shadingTop + parallaxY,
                borderRadius: "50%",
                background:
                  "linear-gradient(95.27deg, #79B0F9 22.43%, #5A8FF8 81.48%)",
                filter: `blur(${s(28)}px)`,
                opacity: isActive ? 0 : 1,
                transition: "left 700ms ease-out, top 700ms ease-out, opacity 700ms ease-in-out",
                pointerEvents: "none",
              }}
            />

            {/* Active shading gradient */}
            <div
              className="absolute"
              style={{
                width: shadingWidth,
                height: shadingHeight,
                left: shadingLeft + parallaxX,
                top: shadingTop + parallaxY,
                borderRadius: "50%",
                background:
                  "radial-gradient(ellipse at 50% 45%, rgba(255,255,255,0.22) 0%, rgba(100,160,248,0.12) 50%, transparent 100%)",
                filter: `blur(${s(30)}px)`,
                opacity: isActive ? 1 : 0,
                transition: "left 700ms ease-out, top 700ms ease-out, opacity 700ms ease-in-out",
                pointerEvents: "none",
              }}
            />

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={textareaValue}
              onChange={(e) => setTextareaValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onPaste={handlePaste}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onScroll={updateThumbPosition}
              disabled={!hasAvailableModels}
              placeholder={hasAvailableModels ? "Ask anything..." : "Add an API key to enable chat"}
              className={`scrollbar-none absolute resize-none bg-transparent outline-none transition-colors duration-500 ease-in-out ${isFocused
                ? "text-[#0C2937] placeholder-[#2B6480]/50"
                : "text-[#2B6480] placeholder-[#2B6480]"
                }`}
              style={{
                left: pad,
                top: pad,
                width: containerWidth - pad * 2,
                height: textareaHeight,
                fontFamily: '"DM Sans", sans-serif',
                fontSize: s(18),
                fontWeight: 500,
                letterSpacing: "-0.04em",
                lineHeight: "100%",
                fontVariationSettings: '"opsz" 30',
              }}
            />

            {/* Custom scrollbar */}
            <div
              className="absolute transition-opacity duration-300"
              style={{
                right: s(14),
                top: pad,
                width: s(14),
                height: textareaHeight,
                opacity: showScrollbar ? 1 : 0,
                pointerEvents: showScrollbar ? "auto" : "none",
              }}
            >
              <div
                className="absolute right-0 top-0"
                style={{
                  width: isScrollbarHovered || isDraggingScrollbar ? s(8) : s(5),
                  transition: "width 0.3s, background 0.3s, opacity 0.3s",
                }}
                onMouseEnter={() => setIsScrollbarHovered(true)}
                onMouseLeave={() => setIsScrollbarHovered(false)}
                onMouseDown={handleScrollbarMouseDown}
              >
                <div
                  ref={scrollbarThumbRef}
                  className="rounded-full"
                  style={{
                    width: "100%",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.3) 100%)",
                    border: "1px solid rgba(255,255,255,0.5)",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                    backdropFilter: "blur(4px)",
                  }}
                />
              </div>
            </div>

            {/* Button row — pinned to bottom */}
            <div
              className="absolute bottom-0 left-0 right-0 flex items-center justify-between"
              style={{ padding: `0 ${pad}px ${bottomPad}px` }}
            >
              {/* Model selector button */}
              <div ref={modelSelectorRef}>
                <Squircle
                  width={modelBtnW}
                  height={btnH}
                  radius={s(8)}
                  shadow="shadow-[0px_2px_6px_0px_rgba(12,41,55,0.04)]"
                  className="cursor-pointer select-none"
                  style={{
                    background: hasAvailableModels
                      ? (modelBtnHovered ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.22)")
                      : (modelBtnHovered ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.15)"),
                    opacity: hasAvailableModels ? 1 : 0.85,
                    transition: "background 200ms ease",
                  }}
                  onMouseEnter={() => setModelBtnHovered(true)}
                  onMouseLeave={() => setModelBtnHovered(false)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!hasAvailableModels) {
                      onConfigureModels?.();
                      return;
                    }
                    setIsDropdownOpen((prev) => !prev);
                  }}
                >
                  <div className="flex items-center justify-between w-full h-full" style={{ padding: `0 ${s(10)}px` }}>
                    {hasAvailableModels ? (
                      <>
                        <div className="flex min-w-0 flex-col justify-center" style={{ gap: s(1) }}>
                          <span
                            style={{
                              fontFamily: '"DM Sans", sans-serif',
                              fontSize: s(14),
                              fontWeight: 700,
                              color: "rgba(12,41,55,0.9)",
                              letterSpacing: "-0.04em",
                              lineHeight: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {selectedModelOption?.menuLabel ?? selectedModelOption?.label ?? "No models"}
                          </span>
                          <span
                            style={{
                              fontFamily: '"DM Sans", sans-serif',
                              fontSize: s(13),
                              fontWeight: 700,
                              color: "rgba(12,41,55,0.6)",
                              letterSpacing: "-0.02em",
                              lineHeight: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {selectedModelOption?.provider}
                          </span>
                        </div>
                        <ChevronDown
                          size={s(13)}
                          color="rgba(12,41,55,0.78)"
                          strokeWidth={2.5}
                          className={`transition-transform duration-300 ${isDropdownOpen ? "rotate-180" : ""}`}
                        />
                      </>
                    ) : (
                      <>
                        <span
                          style={{
                            fontFamily: '"DM Sans", sans-serif',
                            fontSize: s(13),
                            fontWeight: 700,
                            color: "rgba(12,41,55,0.6)",
                            letterSpacing: "-0.03em",
                            lineHeight: 1,
                          }}
                        >
                          Add an API key
                        </span>
                        <ChevronRight
                          size={s(13)}
                          color="rgba(12,41,55,0.5)"
                          strokeWidth={2.5}
                        />
                      </>
                    )}
                  </div>
                </Squircle>
              </div>

              {/* Send / Stop button */}
              <Squircle
                width={sendBtnW}
                height={btnH}
                radius={s(9)}
                shadow="shadow-[0px_2px_6px_0px_rgba(12,41,55,0.04)]"
                className="cursor-pointer select-none active:scale-95"
                style={{
                  background: loading
                    ? (sendBtnHovered ? "rgba(248,113,113,0.55)" : "rgba(248,113,113,0.42)")
                    : (sendBtnHovered ? "rgba(255,255,255,0.42)" : "rgba(255,255,255,0.32)"),
                  opacity: hasAvailableModels ? 1 : 0.55,
                  pointerEvents: hasAvailableModels ? "auto" : "none",
                  transition: "background 200ms ease",
                }}
                onMouseEnter={() => setSendBtnHovered(true)}
                onMouseLeave={() => setSendBtnHovered(false)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (loading) onStop?.();
                  else handleSend();
                }}
              >
                <div className="flex items-center justify-center w-full h-full">
                  <span
                    style={{
                      fontFamily: '"DM Sans", sans-serif',
                      fontSize: s(16),
                      fontWeight: 600,
                      color: loading ? "rgba(255,255,255,0.92)" : "rgba(12,41,55,0.88)",
                      letterSpacing: "-0.04em",
                    }}
                  >
                    {loading ? "Stop" : "Send"}
                  </span>
                </div>
              </Squircle>
            </div>
          </div>
        </Squircle>
      </div>

      {/* Dropdown — rendered outside the clipped container, opens upward */}
      <div
        className="absolute z-50"
        style={{
          left: pad,
          bottom: dropdownBottomOffset,
          pointerEvents: isDropdownOpen ? "auto" : "none",
        }}
      >
        <div
          className={`transition-all duration-300 origin-bottom ${isDropdownOpen
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 translate-y-2 pointer-events-none"
            }`}
          ref={dropdownPanelRef}
        >
          <Squircle
            width={modelBtnW}
            height={dropdownHeight}
            radius={s(16)}
            shadow="shadow-[0px_3px_12px_2px_rgba(12,41,55,0.06)]"
            style={{
              background:
                "linear-gradient(296.25deg, #7DB8F7 2.26%, #9ACFFC 80.86%)",
              border: "1px solid rgba(255,255,255,0.35)",
            }}
          >
            <div className="flex flex-col" style={{ padding: dropPad, gap: dropGap }}>
              {primaryModels.map((model) => (
                <button
                  key={model.id}
                  className="w-full text-left transition-colors cursor-pointer"
                  style={{
                    height: dropItemH,
                    borderRadius: s(8),
                    padding: `0 ${s(10)}px`,
                    background:
                      selectedModel === model.id
                        ? "rgba(255,255,255,0.45)"
                        : hoveredMenuItem === `primary:${model.id}`
                          ? "rgba(255,255,255,0.28)"
                          : "transparent",
                    ...menuTextStyle,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMorePinned(false);
                    setIsMoreOpen(false);
                    handleModelSelect(model.id);
                  }}
                  onMouseEnter={() => {
                    setHoveredMenuItem(`primary:${model.id}`);
                    if (!isMorePinned) {
                      setIsMoreOpen(false);
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredMenuItem((current) => (current === `primary:${model.id}` ? null : current));
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {model.menuLabel ?? model.label}
                  </span>
                </button>
              ))}
              {hasOverflow && (
                <button
                  ref={moreButtonRef}
                  className="w-full text-left transition-colors cursor-pointer"
                  style={{
                    height: dropItemH,
                    borderRadius: s(8),
                    padding: `0 ${s(10)}px`,
                    background:
                      isMoreOpen || hoveredMenuItem === "main:more"
                        ? "rgba(255,255,255,0.45)"
                        : "transparent",
                    ...menuTextStyle,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMorePinned((current) => {
                      const next = !current;
                      setIsMoreOpen(next);
                      return next;
                    });
                  }}
                  onMouseEnter={() => {
                    setHoveredMenuItem("main:more");
                  }}
                  onMouseLeave={() => {
                    setHoveredMenuItem((current) => (current === "main:more" ? null : current));
                  }}
                >
                  <span className="flex h-full items-center justify-between gap-2">
                    <span>More</span>
                    <ChevronRight size={s(14)} strokeWidth={2.4} />
                  </span>
                </button>
              )}
            </div>
          </Squircle>
          {hasOverflow && activeProviderGroup && (
            <div
              className={`absolute transition-all duration-200 ${isDropdownOpen && isMoreOpen
                ? "opacity-100 translate-x-0"
                : "opacity-0 translate-x-2 pointer-events-none"
                }`}
              style={{
                left: modelBtnW + submenuGap,
                top: submenuOffsetTop,
              }}
              onMouseEnter={() => setIsMoreOpen(true)}
              onMouseLeave={() => {
                if (!isMorePinned) {
                  setIsMoreOpen(false);
                }
              }}
            >
              <Squircle
                width={providerColumnW + submenuModelColumnW + submenuPad * 2 + submenuColumnGap}
                height={submenuHeight}
                radius={s(11)}
                shadow="shadow-[0px_3px_12px_2px_rgba(12,41,55,0.06)]"
                style={{
                  background: "linear-gradient(296.25deg, #7DB8F7 2.26%, #9ACFFC 80.86%)",
                  border: "1px solid rgba(255,255,255,0.35)",
                }}
              >
                <div
                  className="flex flex-col h-full"
                  style={{
                    padding: submenuPad,
                    gap: submenuSectionGap,
                  }}
                >
                  <div
                    className="grid"
                    style={{
                      gridTemplateColumns: `${providerColumnW}px ${submenuModelColumnW}px`,
                      gap: submenuColumnGap,
                      flex: 1,
                      minHeight: 0,
                    }}
                  >
                    <div className="flex flex-col" style={{ gap: dropGap }}>
                      {overflowGroups.map((group) => (
                        <button
                          key={group.provider}
                          className="w-full text-left transition-colors cursor-pointer"
                          style={{
                            height: dropItemH,
                            flexShrink: 0,
                            borderRadius: s(8),
                            padding: `0 ${s(10)}px`,
                            background:
                              activeProviderGroup.provider === group.provider || hoveredMenuItem === `provider:${group.provider}`
                                ? "rgba(255,255,255,0.45)"
                                : "transparent",
                            ...menuTextStyle,
                          }}
                          onMouseEnter={() => {
                            setHoveredMenuItem(`provider:${group.provider}`);
                            setActiveProvider(group.provider);
                          }}
                          onMouseLeave={() => {
                            setHoveredMenuItem((current) => (current === `provider:${group.provider}` ? null : current));
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveProvider(group.provider);
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {group.provider}
                          </span>
                        </button>
                      ))}
                    </div>
                  <div
                    className="flex flex-col scrollbar-none"
                    style={{
                      gap: dropGap,
                      borderLeft: "1px solid rgba(12,41,55,0.08)",
                      paddingLeft: submenuColumnGap,
                      overflowY: "auto",
                      minHeight: 0,
                    }}
                  >
                    {isSearchActive ? (
                      filteredSearchModels.length === 0 ? (
                        <div
                          className="flex items-center"
                          style={{
                            height: dropItemH,
                            padding: `0 ${s(10)}px`,
                            ...menuTextStyle,
                            color: "rgba(12,41,55,0.55)",
                            flexShrink: 0,
                          }}
                        >
                          No matches
                        </div>
                      ) : (
                        filteredSearchModels.map((model) => (
                          <button
                            key={model.id}
                            className="w-full text-left transition-colors cursor-pointer"
                            style={{
                              height: dropItemH,
                              flexShrink: 0,
                              borderRadius: s(8),
                              padding: `0 ${s(10)}px`,
                              background:
                                selectedModel === model.id
                                  ? "rgba(255,255,255,0.45)"
                                  : hoveredMenuItem === `search:${model.id}`
                                    ? "rgba(255,255,255,0.28)"
                                    : "transparent",
                              ...menuTextStyle,
                            }}
                            onMouseEnter={() => setHoveredMenuItem(`search:${model.id}`)}
                            onMouseLeave={() => {
                              setHoveredMenuItem((current) => (current === `search:${model.id}` ? null : current));
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleModelSelect(model.id);
                            }}
                          >
                            <span
                              className="flex items-baseline justify-between gap-2"
                              style={{
                                overflow: "hidden",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                {model.menuLabel ?? model.label}
                              </span>
                              <span
                                style={{
                                  fontSize: s(11),
                                  fontWeight: 600,
                                  color: "rgba(12,41,55,0.55)",
                                  flexShrink: 0,
                                }}
                              >
                                {model.provider}
                              </span>
                            </span>
                          </button>
                        ))
                      )
                    ) : (
                      activeProviderGroup.items.map((model) => (
                        <button
                          key={model.id}
                          className="w-full text-left transition-colors cursor-pointer"
                          style={{
                            height: dropItemH,
                            flexShrink: 0,
                            borderRadius: s(8),
                            padding: `0 ${s(10)}px`,
                            background:
                              selectedModel === model.id
                                ? "rgba(255,255,255,0.45)"
                                : hoveredMenuItem === `overflow:${model.id}`
                                  ? "rgba(255,255,255,0.28)"
                                  : "transparent",
                            ...menuTextStyle,
                          }}
                          onMouseEnter={() => setHoveredMenuItem(`overflow:${model.id}`)}
                          onMouseLeave={() => {
                            setHoveredMenuItem((current) => (current === `overflow:${model.id}` ? null : current));
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleModelSelect(model.id);
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {model.menuLabel ?? model.label}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  </div>
                  <div
                    className="flex items-center"
                    style={{ gap: dropGap, height: submenuBottomRowH, flexShrink: 0 }}
                  >
                    <div
                      className="flex items-center transition-colors cursor-text"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: "100%",
                        borderRadius: s(8),
                        padding: `0 ${s(10)}px`,
                        gap: s(8),
                        background:
                          isSearchActive || hoveredMenuItem === "search"
                            ? "rgba(255,255,255,0.55)"
                            : "rgba(255,255,255,0.35)",
                        ...menuTextStyle,
                      }}
                      onMouseEnter={() => setHoveredMenuItem("search")}
                      onMouseLeave={() => {
                        setHoveredMenuItem((current) => (current === "search" ? null : current));
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        searchInputRef.current?.focus();
                      }}
                    >
                      <Search size={s(13)} strokeWidth={2.4} color="#0C2937" />
                      <input
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape") {
                            if (searchQuery) {
                              setSearchQuery("");
                            } else {
                              searchInputRef.current?.blur();
                            }
                          } else if (e.key === "Enter" && filteredSearchModels.length > 0) {
                            e.preventDefault();
                            handleModelSelect(filteredSearchModels[0].id);
                          }
                        }}
                        placeholder="Search"
                        spellCheck={false}
                        style={{
                          background: "transparent",
                          border: "none",
                          outline: "none",
                          flex: 1,
                          minWidth: 0,
                          padding: 0,
                          color: "#0C2937",
                          fontFamily: '"DM Sans", sans-serif',
                          fontSize: s(14),
                          fontWeight: 600,
                          letterSpacing: "-0.04em",
                        }}
                      />
                    </div>
                    <button
                      title="Settings"
                      aria-label="Settings"
                      className="flex items-center justify-center transition-colors cursor-pointer"
                      style={{
                        height: "100%",
                        width: dropItemH,
                        flexShrink: 0,
                        borderRadius: s(8),
                        background: hoveredMenuItem === "more:settings" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.35)",
                        ...menuTextStyle,
                      }}
                      onMouseEnter={() => setHoveredMenuItem("more:settings")}
                      onMouseLeave={() => {
                        setHoveredMenuItem((current) => (current === "more:settings" ? null : current));
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsDropdownOpen(false);
                        setIsMoreOpen(false);
                        setIsMorePinned(false);
                        onConfigureModels?.();
                      }}
                    >
                      <Settings2 size={s(14)} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              </Squircle>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatContainer;
