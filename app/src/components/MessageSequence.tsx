import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SeqMessage {
  role: string;
  content: string;
}

const SEQ_MIN_GAP = 10;
const SEQ_PAD = 6;
// Distance from the rail container's right edge to the center of the dots.
// Smaller = closer to the edge. The rail container itself stays wide for the hit zone.
const DOT_CENTER_FROM_RIGHT = 8;

function computeSeqPositions(heights: number[], available: number): number[] {
  const N = heights.length;
  if (N === 0) return [];
  if (N === 1) return [available / 2];

  const inner = Math.max(0, available - 2 * SEQ_PAD);
  const gapHeights = heights.slice(0, N - 1);

  // If even the minimum-spaced layout doesn't fit, just spread evenly.
  if ((N - 1) * SEQ_MIN_GAP > inner) {
    const gap = inner / (N - 1);
    return heights.map((_, i) => SEQ_PAD + i * gap);
  }

  // Iteratively lock gaps that fall below the minimum, scale the remainder.
  const locked = new Array(N - 1).fill(false);
  for (let iter = 0; iter < 24; iter++) {
    let lockedSum = 0;
    let unlockedSum = 0;
    for (let i = 0; i < N - 1; i++) {
      if (locked[i]) lockedSum += SEQ_MIN_GAP;
      else unlockedSum += gapHeights[i];
    }
    if (unlockedSum === 0) break;
    const scale = (inner - lockedSum) / unlockedSum;
    let changed = false;
    for (let i = 0; i < N - 1; i++) {
      if (!locked[i] && scale * gapHeights[i] < SEQ_MIN_GAP) {
        locked[i] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }

  let lockedSum = 0;
  let unlockedSum = 0;
  for (let i = 0; i < N - 1; i++) {
    if (locked[i]) lockedSum += SEQ_MIN_GAP;
    else unlockedSum += gapHeights[i];
  }
  const scale = unlockedSum > 0 ? (inner - lockedSum) / unlockedSum : 0;
  const gaps = gapHeights.map((h, i) => locked[i] ? SEQ_MIN_GAP : Math.max(SEQ_MIN_GAP, scale * h));

  const positions = [SEQ_PAD];
  for (let i = 0; i < gaps.length; i++) {
    positions.push(positions[positions.length - 1] + gaps[i]);
  }
  return positions;
}

interface MessageSequenceProps {
  messages: SeqMessage[];
  /** Pixel height of message i in the actual scroll content. Estimates are fine. */
  getHeight: (i: number) => number;
  /** Smoothly scroll the host container to message i. */
  scrollToMessage: (i: number) => void;
  /** The host scroll container — used to forward wheel events when the cursor sits over the rail. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Index currently considered "in view"; highlighted on the rail. */
  activeIdx: number | null;
  /** Bumped by the host whenever heights/messages change so positions recompute. */
  heightsVersion: number;
  /** Optional inset overrides; default top/bottom 60. */
  top?: number;
  bottom?: number;
  /** Distance from the right edge of the host. Default 0. */
  right?: number;
}

export default function MessageSequence({
  messages,
  getHeight,
  scrollToMessage,
  scrollRef,
  activeIdx,
  heightsVersion,
  top = 60,
  bottom = 60,
  right = 0,
}: MessageSequenceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);
  const [hover, setHover] = useState<{ idx: number; railLeft: number; railRight: number; dotY: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const positions = useMemo(() => {
    if (containerH === 0) return [];
    const heights = messages.map((_, i) => Math.max(1, getHeight(i)));
    return computeSeqPositions(heights, containerH);
    // heightsVersion is intentionally a dependency to force recompute when measurements change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, containerH, heightsVersion]);

  // Snap mouse to the nearest dot — the entire rail strip is the hit zone.
  const updateHoverFromPointer = useCallback((clientY: number) => {
    const el = containerRef.current;
    if (!el || positions.length === 0) return;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top;
    let bestIdx = 0;
    let bestDist = Math.abs(positions[0] - y);
    for (let i = 1; i < positions.length; i++) {
      const d = Math.abs(positions[i] - y);
      if (d < bestDist) { bestIdx = i; bestDist = d; }
    }
    setHover({
      idx: bestIdx,
      // anchor the popup on the dot center, not the rail container edge
      railLeft: rect.right - DOT_CENTER_FROM_RIGHT,
      railRight: rect.right - DOT_CENTER_FROM_RIGHT,
      dotY: rect.top + positions[bestIdx],
    });
  }, [positions]);

  // Forward wheel events so vertical scroll still works when the cursor sits over the rail.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const sc = scrollRef.current;
    if (sc) sc.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: "auto" });
  }, [scrollRef]);

  if (messages.length < 2) return null;

  const previewText = (msg: SeqMessage) =>
    msg.content.replace(/\s+/g, " ").trim().slice(0, 140);

  const hoveredMsg = hover ? messages[hover.idx] : null;
  const hoveredIsUser = hoveredMsg?.role === "user";

  return (
    <>
      <div
        ref={containerRef}
        onMouseMove={(e) => updateHoverFromPointer(e.clientY)}
        onMouseLeave={() => setHover(null)}
        onClick={() => { if (hover) scrollToMessage(hover.idx); }}
        onWheel={handleWheel}
        style={{
          position: "absolute",
          top,
          bottom,
          right,
          width: 32,
          zIndex: 4,
          cursor: "pointer",
        }}
      >
        {/* Dots are anchored to the right edge of the rail so they sit "on the side"
            rather than floating in the conversation; the rail's full width is still the hit zone. */}
        <div
          style={{
            position: "absolute",
            top: SEQ_PAD,
            bottom: SEQ_PAD,
            right: DOT_CENTER_FROM_RIGHT - 0.5,
            width: 1,
            background: "rgba(195, 236, 255, 0.07)",
            pointerEvents: "none",
          }}
        />
        {messages.map((msg, i) => {
          const dotTop = positions[i];
          if (dotTop === undefined) return null;
          const isUser = msg.role === "user";
          const isActive = activeIdx === i;
          const isHovered = hover?.idx === i;
          const emphasized = isActive || isHovered;
          const dotColor = isUser
            ? "rgba(240, 145, 158, 0.9)"
            : "rgba(90, 143, 248, 0.9)";
          const size = emphasized ? 11 : 7;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                top: dotTop,
                right: DOT_CENTER_FROM_RIGHT - size / 2,
                transform: "translateY(-50%)",
                width: size,
                height: size,
                borderRadius: "50%",
                background: dotColor,
                opacity: emphasized ? 1 : 0.6,
                boxShadow: emphasized
                  ? `0 0 0 4px ${isUser ? "rgba(240,145,158,0.14)" : "rgba(90,143,248,0.14)"}`
                  : "none",
                transition: "width 140ms ease, height 140ms ease, right 140ms ease, opacity 140ms ease, box-shadow 140ms ease",
                pointerEvents: "none",
              }}
            />
          );
        })}
      </div>
      {hover && hoveredMsg && (() => {
        const PREVIEW_W = 240;
        const PREVIEW_PAD_H = 26;
        const GAP = 10;
        const VIEWPORT_MARGIN = 12;
        const totalW = PREVIEW_W + PREVIEW_PAD_H;
        const spaceRight = window.innerWidth - hover.railRight - GAP - VIEWPORT_MARGIN;
        const spaceLeft = hover.railLeft - GAP - VIEWPORT_MARGIN;
        const placeLeft = totalW > spaceRight && spaceLeft > spaceRight;
        const left = placeLeft
          ? Math.max(VIEWPORT_MARGIN, hover.railLeft - GAP - totalW)
          : hover.railRight + GAP;
        const popTop = Math.max(VIEWPORT_MARGIN, Math.min(window.innerHeight - 110, hover.dotY - 32));
        return createPortal(
          <div
            style={{
              position: "fixed",
              left,
              top: popTop,
              background: "#0e1518",
              border: "1px solid rgba(195, 236, 255, 0.08)",
              borderRadius: 8,
              padding: "8px 12px",
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 12,
              fontWeight: 400,
              color: "rgba(195, 236, 255, 0.75)",
              width: PREVIEW_W,
              pointerEvents: "none",
              boxShadow: "0 4px 24px rgba(0,0,0,0.45)",
              zIndex: 9999,
              lineHeight: 1.45,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: hoveredIsUser ? "rgba(240, 145, 158, 0.85)" : "rgba(137, 188, 245, 0.9)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              {hoveredIsUser ? "User" : "Assistant"}
            </div>
            <div
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical" as const,
                overflow: "hidden",
              }}
            >
              {previewText(hoveredMsg)}
            </div>
          </div>,
          document.getElementById("kept-app-container") ?? document.body,
        );
      })()}
    </>
  );
}
