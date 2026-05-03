import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDprScale } from "./SideNav";

let lastMouseDown = 0;

function handleMouseDown(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("input, button, a, textarea, select, [role='button']")) return;

  const now = Date.now();
  if (now - lastMouseDown < 300) {
    lastMouseDown = 0;
    getCurrentWindow().toggleMaximize();
    return;
  }
  lastMouseDown = now;
  getCurrentWindow().startDragging();
}

interface TitlebarProps {
  isMaximized?: boolean;
  isCompact?: boolean;
  compactSlot?: React.ReactNode;
  centerSlot?: React.ReactNode;
  centerSlotVisible?: boolean;
}

export default function Titlebar({ isMaximized = false, isCompact = false, compactSlot, centerSlot, centerSlotVisible = true }: TitlebarProps) {
  const ds = useDprScale();
  const iconSize = Math.round(22 * ds);

  return (
    <div
      className="relative z-[70] flex shrink-0 select-none items-center justify-between px-8 pt-10 pb-3"
    >
      {/* Invisible drag surface — sits below interactive children, catches clicks in empty titlebar areas */}
      <div
        onMouseDown={handleMouseDown}
        style={{ position: "absolute", inset: 0, zIndex: 0, cursor: "default" }}
      />
      <div style={{ position: "relative", zIndex: 1 }}>
        <span
          className="pointer-events-none"
          style={{
            fontFamily: '"DM Sans", sans-serif',
            fontWeight: 500,
            fontSize: Math.max(24, Math.round(22 * ds)),
            lineHeight: "120%",
            letterSpacing: "-0.02em",
            color: "#C3ECFF",
            fontVariationSettings: '"opsz" 30',
            opacity: isCompact ? 0 : 1,
            transition: isCompact
              ? "opacity 250ms cubic-bezier(0.25, 0.1, 0.25, 1)"
              : "opacity 300ms cubic-bezier(0.25, 0.1, 0.25, 1) 200ms",
          }}
        >
          Kept
        </span>
        {compactSlot && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: "50%",
              transform: "translateY(-50%)",
              opacity: isCompact ? 1 : 0,
              pointerEvents: isCompact ? "auto" : "none",
              transition: isCompact
                ? "opacity 300ms cubic-bezier(0.25, 0.1, 0.25, 1) 200ms"
                : "opacity 250ms cubic-bezier(0.25, 0.1, 0.25, 1)",
            }}
          >
            {compactSlot}
          </div>
        )}
      </div>

      {centerSlot && (
        <div
          style={{
            position: "relative",
            zIndex: 1,
            flex: 1,
            minWidth: 0,
            margin: "0 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: centerSlotVisible ? 1 : 0,
            visibility: centerSlotVisible ? "visible" : "hidden",
            transform: centerSlotVisible ? "scale(1)" : "scale(0.97)",
            pointerEvents: "none",
            transition: "opacity 500ms cubic-bezier(0.16,1,0.3,1), transform 500ms cubic-bezier(0.16,1,0.3,1), visibility 0ms linear " + (centerSlotVisible ? "0ms" : "500ms"),
          }}
        >
          {centerSlot}
        </div>
      )}

      <div className="flex items-center" style={{ position: "relative", zIndex: 1, gap: Math.round(8 * ds) }}>
        <button
          onClick={() => getCurrentWindow().minimize()}
          className="cursor-pointer rounded-md text-[#4E6D7C] transition-[color,transform] duration-300 ease-out hover:text-[#C3ECFF] hover:scale-110 active:scale-95"
          style={{ padding: Math.round(4 * ds) }}
          aria-label="Minimize"
        >
          <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
            <path d="M2 20h20" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>

        <button
          onClick={() => getCurrentWindow().toggleMaximize()}
          className="cursor-pointer rounded-md brightness-100 transition-[filter,transform] duration-300 ease-out hover:brightness-200 hover:scale-110 active:scale-95"
          style={{ padding: Math.round(4 * ds) }}
          aria-label="Maximize"
        >
          <img src={isMaximized ? "/ShrinkWindow.svg" : "/ExpandIcon.svg"} width={iconSize} height={iconSize} alt={isMaximized ? "Restore" : "Maximize"} />
        </button>

        <button
          onClick={() => getCurrentWindow().close()}
          className="cursor-pointer rounded-md text-[#4E6D7C] transition-[color,transform] duration-300 ease-out hover:text-orange-400 hover:scale-110 active:scale-95"
          style={{ padding: Math.round(4 * ds) }}
          aria-label="Close"
        >
          <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
            <path d="M22 2L2 22" stroke="currentColor" strokeWidth="2" />
            <path d="M2 2L22 22" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
