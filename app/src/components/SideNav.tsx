import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import Squircle from "./Squircle";
import { useScale } from "./ChatContainer";

const pages = ["Vault", "Chat", "Digest", "Explorer", "Settings"] as const;

const COMPACT_THRESHOLD = 550;

/** Scale factor based on pixel density — scales down on low-DPI (large, low-res) displays. */
export function useDprScale(): number {
  const compute = () => Math.min(1, 0.4 + devicePixelRatio * 0.4);
  const [scale, setScale] = useState(compute);
  useEffect(() => {
    let mql: MediaQueryList;
    const update = () => {
      setScale(compute());
      mql = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      mql.addEventListener("change", update, { once: true });
    };
    mql = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    mql.addEventListener("change", update, { once: true });
    return () => mql.removeEventListener("change", update);
  }, []);
  return scale;
}

export function useCompact() {
  const compute = () => window.innerHeight < COMPACT_THRESHOLD || window.innerWidth < 940;
  const [compact, setCompact] = useState(compute);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setCompact(compute()); });
    };
    window.addEventListener("resize", update);
    return () => { if (raf) cancelAnimationFrame(raf); window.removeEventListener("resize", update); };
  }, []);
  return compact;
}

interface SideNavProps {
  activePage: string;
  onNavigate: (page: string) => void;
}

export { CompactNav };

/* ── Compact dropdown mode ── */

const BASE_BTN_W = 120;
const BASE_BTN_H = 46;
const BASE_DROP_ITEM_H = 36;
const BASE_DROP_GAP = 3;
const BASE_DROP_PAD = 8;

function CompactNav({ activePage, onNavigate }: SideNavProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const s = useDprScale();
  const vs = Math.min(useScale(), 1.15);

  const btnW = Math.round(BASE_BTN_W * vs);
  const btnH = Math.round(BASE_BTN_H * vs);
  const dropItemH = Math.round(BASE_DROP_ITEM_H * s);
  const dropGap = Math.round(BASE_DROP_GAP * s);
  const dropPad = Math.round(BASE_DROP_PAD * s);
  const dropdownHeight = dropPad * 2 + dropItemH * pages.length + dropGap * (pages.length - 1);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", zIndex: 100 }}>
      <button
        className="cursor-pointer flex items-center bg-transparent border-none outline-none transition-opacity duration-300 ease-out hover:opacity-70"
        style={{
          gap: Math.round(8 * vs),
          userSelect: "none",
          padding: 0,
        }}
        onClick={() => setOpen((p) => !p)}
      >
        <span
          style={{
            fontFamily: '"DM Sans", sans-serif',
            fontSize: Math.round(22 * vs),
            fontWeight: 500,
            color: "#C3ECFF",
            letterSpacing: "-0.02em",
            lineHeight: "120%",
          }}
        >
          {activePage}
        </span>
        <ChevronDown
          size={Math.round(20 * vs)}
          color="rgba(195, 236, 255, 0.5)"
          strokeWidth={2.5}
          style={{
            transition: "transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1)",
            transform: `translateY(${Math.round(1 * vs)}px) ${open ? "rotate(180deg)" : "rotate(0deg)"}`,
          }}
        />
      </button>

      <div
        className="absolute z-50"
        style={{
          left: 0,
          top: btnH + Math.round(6 * s),
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <div
          className="transition-all duration-300 origin-top"
          style={{
            opacity: open ? 1 : 0,
            transform: open ? "scale(1) translateY(0)" : "scale(0.95) translateY(-4px)",
            pointerEvents: open ? "auto" : "none",
          }}
        >
          <Squircle
            width={btnW}
            height={dropdownHeight}
            radius={Math.round(11 * s)}
            shadow="shadow-[0px_3px_12px_2px_rgba(12,41,55,0.06)]"
            style={{
              background: "linear-gradient(296.25deg, #7DB8F7 2.26%, #9ACFFC 80.86%)",
              border: "1px solid rgba(255,255,255,0.35)",
            }}
          >
            <div className="flex flex-col" style={{ padding: dropPad, gap: dropGap }}>
              {pages.map((page) => (
                <button
                  key={page}
                  className="w-full text-left cursor-pointer"
                  style={{
                    height: dropItemH,
                    borderRadius: Math.round(8 * s),
                    padding: `0 ${Math.round(10 * s)}px`,
                    fontFamily: '"DM Sans", sans-serif',
                    fontSize: Math.round(20 * s),
                    fontWeight: 600,
                    color: "#0A2330",
                    letterSpacing: "-0.03em",
                    background: page === activePage ? "rgba(255,255,255,0.3)" : "transparent",
                    border: "none",
                    transition: "background 200ms ease-out",
                    userSelect: "none",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = page === activePage ? "rgba(255,255,255,0.3)" : "transparent";
                  }}
                  onClick={(e) => { e.currentTarget.blur(); onNavigate(page); setOpen(false); }}
                >
                  {page}
                </button>
              ))}
            </div>
          </Squircle>
        </div>
      </div>
    </div>
  );
}

