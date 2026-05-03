import { useRef, useState, useEffect, useCallback } from "react";
import { squirclePath } from "../lib/squircle";

interface SquircleProps {
  width?: number;
  height?: number;
  radius: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  shadow?: string;
  onMouseMove?: React.MouseEventHandler;
  onMouseEnter?: React.MouseEventHandler;
  onMouseLeave?: React.MouseEventHandler;
  onClick?: React.MouseEventHandler;
}

export default function Squircle({
  width,
  height,
  radius,
  className = "",
  style = {},
  children,
  shadow = "",
  onMouseMove,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: SquircleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [clipPath, setClipPath] = useState<string>("");

  const updateClip = useCallback(
    (w: number, h: number) => {
      if (w > 0 && h > 0) {
        setClipPath(`path("${squirclePath(w, h, radius)}")`);
      }
    },
    [radius]
  );

  // For fixed-size elements, compute clip-path synchronously
  useEffect(() => {
    if (width && height) {
      updateClip(width, height);
    }
  }, [width, height, updateClip]);

  // For responsive elements, debounce squircle recomputation during resize
  useEffect(() => {
    if (width && height) return; // skip if fixed
    const el = containerRef.current;
    if (!el) return;

    let timer = 0;
    const observer = new ResizeObserver((entries) => {
      const { width: w, height: h } = entries[0].contentRect;
      clearTimeout(timer);
      timer = window.setTimeout(() => updateClip(w, h), 100);
    });
    observer.observe(el);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [width, height, updateClip]);

  const sizeStyle: React.CSSProperties =
    width && height ? { width, height } : {};

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
      style={sizeStyle}
      onMouseMove={onMouseMove}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {shadow && (
        <div
          className={`absolute inset-0 pointer-events-none ${shadow}`}
          style={{ borderRadius: radius }}
        />
      )}
      <div
        className="relative w-full h-full"
        style={{ clipPath, borderRadius: radius, overflow: "hidden", ...style }}
      >
        {children}
      </div>
    </div>
  );
}
