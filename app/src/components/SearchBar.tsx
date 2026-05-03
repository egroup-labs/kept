import { useEffect, useRef, useState } from "react";
import Squircle from "./Squircle";
import { useScale } from "./ChatContainer";
const SearchIcon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>')}`;

interface SearchBarProps {
  onSearch?: (query: string) => void;
  onChange?: (query: string) => void;
  placeholder?: string;
  buttonLabel?: string;
  compact?: boolean;
  variant?: "light" | "dark";
}

const VARIANT_HIDE_DELAY_MS = 180;
const VARIANT_FADE_IN_MS = 260;

export default function SearchBar({
  onSearch,
  onChange,
  placeholder = "Start typing...",
  buttonLabel = "Search",
  compact = false,
  variant = "light",
}: SearchBarProps) {
  const rawScale = useScale();
  const scale = Math.min(rawScale, 1.1);
  const s = (v: number) => Math.round(v * scale);

  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [btnHovered, setBtnHovered] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const [renderVariant, setRenderVariant] = useState(variant);
  const [isVariantVisible, setIsVariantVisible] = useState(true);
  const [isSwappingVariant, setIsSwappingVariant] = useState(false);
  const dark = renderVariant === "dark";

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setMeasuredWidth(Math.round(entries[0].contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (variant === renderVariant) return;

    setIsVariantVisible(false);
    const swapTimer = setTimeout(() => {
      setIsSwappingVariant(true);
      setRenderVariant(variant);
      requestAnimationFrame(() => {
        setIsVariantVisible(true);
        requestAnimationFrame(() => setIsSwappingVariant(false));
      });
    }, VARIANT_HIDE_DELAY_MS);

    return () => clearTimeout(swapTimer);
  }, [renderVariant, variant]);

  const containerWidth = measuredWidth || s(440);
  const containerHeight = s(compact ? 40 : 46);
  const pad = s(compact ? 10 : 14);
  const padRight = s(compact ? 6 : 14);
  const btnW = s(68);
  const btnH = s(32);
  const isActive = isHovered || isFocused;
  const isExpanded = isFocused;
  const showButton = !compact || isExpanded;

  // Shading
  const shadingWidth = containerWidth * 0.75;
  const shadingHeight = containerHeight * 1.4;
  const shadingLeft = (containerWidth - shadingWidth) / 2;
  const shadingTop = (containerHeight - shadingHeight) / 2;

  // Parallax
  const parallaxX = (mousePos.x / containerWidth - 0.5) * s(-16);
  const parallaxY = (mousePos.y / containerHeight - 0.5) * s(-10);

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const hasValue = value.trim().length > 0;
  const themeTransition = (transition: string) => (isSwappingVariant ? "none" : transition);

  const handleSearch = () => {
    if (!hasValue) return;
    onSearch?.(value.trim());
    inputRef.current?.blur();
  };

  // Theme colors
  const bg = dark ? "rgba(14, 30, 40, 0.85)" : "#A6E1FF";
  const idleGradient = dark
    ? "linear-gradient(95.27deg, rgba(35, 70, 95, 0.3) 22.43%, rgba(25, 55, 75, 0.32) 81.48%)"
    : "linear-gradient(95.27deg, #9AD7F6 22.43%, #41A3D4 81.48%)";
  const activeGradient = dark
    ? "linear-gradient(135deg, rgba(120, 200, 240, 0.08) 0%, rgba(160, 220, 245, 0.05) 60%, rgba(100, 190, 230, 0.04) 100%)"
    : "linear-gradient(135deg, rgba(255,255,255,0.2) 0%, rgba(90,180,220,0.15) 60%, rgba(58,149,194,0.1) 100%)";
  const btnBg = dark
    ? (hasValue
      ? "linear-gradient(296.25deg, rgba(195, 236, 255, 0.08) 2.26%, rgba(195, 236, 255, 0.14) 80.86%)"
      : "linear-gradient(296.25deg, rgba(195, 236, 255, 0.03) 2.26%, rgba(195, 236, 255, 0.06) 80.86%)")
    : (hasValue
      ? "linear-gradient(296.25deg, #A6E1FF 2.26%, #BAE8FF 80.86%)"
      : "linear-gradient(296.25deg, rgba(166, 225, 255, 0.4) 2.26%, rgba(186, 232, 255, 0.4) 80.86%)");
  const btnShadow = dark
    ? "shadow-[0px_1.4px_7px_1.4px_rgba(0,0,0,0.2)]"
    : "shadow-[0px_1.4px_7px_1.4px_rgba(12,41,55,0.1)]";
  const textColor = dark ? (isFocused ? "#C3ECFF" : "rgba(195, 236, 255, 0.75)") : (isFocused ? "#0C2937" : "#2B6480");
  const placeholderClass = dark
    ? (isFocused ? "placeholder-[#C3ECFF]/40" : "placeholder-[#C3ECFF]/40")
    : (isFocused ? "placeholder-[#2B6480]/50" : "placeholder-[#2B6480]");
  const btnTextColor = dark
    ? (hasValue ? "rgba(195, 236, 255, 0.7)" : "rgba(195, 236, 255, 0.3)")
    : (hasValue ? "#0C2937" : "rgba(12, 41, 55, 0.7)");
  const btnTextWeight = dark ? 500 : 600;
  const iconFilter = dark
    ? (isFocused
      ? "brightness(0) invert(0.82) sepia(0.15) saturate(3) hue-rotate(175deg)"
      : "brightness(0) invert(0.65) sepia(0.25) saturate(4) hue-rotate(175deg)")
    : "none";
  const iconOpacity = dark ? (isFocused ? 0.8 : 0.8) : 1;
  const shadow = dark ? "shadow-lg" : "shadow-2xl";

  return (
    <div
      ref={wrapperRef}
      className="relative"
      style={{
        width: compact
          ? isExpanded ? "clamp(240px, 40vw, 400px)" : isHovered ? "clamp(160px, 24vw, 230px)" : "clamp(140px, 20vw, 200px)"
          : "clamp(280px, 30vw, 460px)",
        opacity: isVariantVisible ? 1 : 0,
        pointerEvents: isVariantVisible ? "auto" : "none",
        transition: `width 400ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity ${VARIANT_FADE_IN_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
      }}
    >
      <div
        className={`transition-all duration-500 ease-out ${
          isActive ? "scale-[1.01]" : "scale-100"
        }`}
        style={{
          opacity: compact && !isActive ? 0.65 : 1,
        }}
      >
        <Squircle
          width={containerWidth}
          height={containerHeight}
          radius={s(compact ? 10 : 13)}
          shadow={shadow}
          className="cursor-text"
          onMouseMove={handleMouseMove}
          onMouseEnter={() => {
            if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
            setIsHovered(true);
          }}
          onMouseLeave={() => {
            hoverLeaveTimer.current = setTimeout(() => setIsHovered(false), 250);
            setMousePos({ x: containerWidth / 2, y: containerHeight / 2 });
          }}
          onClick={() => inputRef.current?.focus()}
        >
          <div className="relative w-full h-full cursor-text">
            {/* Background */}
            <div
              className="absolute inset-0"
              style={{
                backgroundColor: bg,
                pointerEvents: "none",
                transition: themeTransition("background-color 700ms cubic-bezier(0.16,1,0.3,1)"),
              }}
            />

            {/* Idle gradient shading */}
            <div
              className="absolute"
              style={{
                width: shadingWidth,
                height: shadingHeight,
                left: shadingLeft + parallaxX,
                top: shadingTop + parallaxY,
                borderRadius: "50%",
                background: idleGradient,
                filter: `blur(${s(28)}px)`,
                opacity: dark ? 1 : (isActive ? 0 : 1),
                transition: themeTransition(
                  "left 700ms ease-out, top 700ms ease-out, opacity 700ms ease-in-out",
                ),
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
                background: activeGradient,
                filter: `blur(${s(25)}px)`,
                opacity: isActive ? 1 : 0,
                transition: themeTransition(
                  "left 700ms ease-out, top 700ms ease-out, opacity 700ms ease-in-out",
                ),
                pointerEvents: "none",
              }}
            />

            {/* Search icon */}
            <img
              src={SearchIcon}
              alt=""
              className="absolute pointer-events-none"
              style={{
                left: pad,
                top: (containerHeight - s(20)) / 2,
                width: s(20),
                height: s(20),
                opacity: iconOpacity,
                filter: iconFilter,
                transition: themeTransition("opacity 700ms ease-out, filter 700ms ease-out"),
              }}
            />

            {/* Input */}
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  inputRef.current?.blur();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearch();
                }
              }}
              onFocus={() => { setIsFocused(true); if (value) requestAnimationFrame(() => inputRef.current?.select()); }}
              onBlur={() => setIsFocused(false)}
              placeholder={placeholder}
              className={`absolute bg-transparent outline-none transition-colors duration-500 ease-in-out ${placeholderClass}`}
              style={{
                left: pad + s(26),
                top: 0,
                width: showButton
                  ? containerWidth - pad - btnW - padRight - pad - s(26)
                  : containerWidth - pad * 2 - s(26),
                height: containerHeight,
                color: textColor,
                fontFamily: '"DM Sans", sans-serif',
                fontSize: s(17),
                fontWeight: 500,
                letterSpacing: "-0.04em",
                lineHeight: "100%",
                fontVariationSettings: '"opsz" 30',
                transition: themeTransition(
                  "width 400ms cubic-bezier(0.25, 0.1, 0.25, 1), color 500ms ease-in-out",
                ),
              }}
            />

            {/* Search button */}
            <div
              className="absolute"
              style={{
                right: padRight,
                top: (containerHeight - btnH) / 2,
                opacity: showButton ? 1 : 0,
                transform: showButton ? "scale(1)" : "scale(0.8)",
                pointerEvents: showButton ? "auto" : "none",
                transition: "opacity 300ms ease-out, transform 300ms ease-out",
              }}
            >
              <div
                style={{
                  filter: hasValue && btnHovered && !dark ? "brightness(1.05)" : "none",
                  transition: "filter 300ms ease-out",
                }}
                onMouseEnter={() => { if (hasValue) setBtnHovered(true); }}
                onMouseLeave={() => setBtnHovered(false)}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent blur on input
                }}
              >
              <Squircle
                width={btnW}
                height={btnH}
                radius={s(7)}
                shadow={btnShadow}
                className={hasValue ? "cursor-pointer active:scale-95" : "cursor-default"}
                style={{
                  background: btnBg,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSearch();
                }}
              >
                {/* Hover overlay for dark mode — crossfade since gradients can't transition */}
                {dark && (
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      background: "linear-gradient(296.25deg, rgba(140, 210, 245, 0.18) 2.26%, rgba(160, 220, 250, 0.24) 80.86%)",
                      opacity: hasValue && btnHovered ? 1 : 0,
                      transition: "opacity 300ms ease-out",
                    }}
                  />
                )}
                <div className="relative flex items-center justify-center w-full h-full">
                  <span
                    style={{
                      fontFamily: '"DM Sans", sans-serif',
                      fontSize: s(15),
                      fontWeight: btnTextWeight,
                      color: btnTextColor,
                      letterSpacing: "-0.04em",
                      fontVariationSettings: `"opsz" 30, "wght" ${btnTextWeight}`,
                      transition: themeTransition("color 700ms cubic-bezier(0.16,1,0.3,1)"),
                    }}
                  >
                    {buttonLabel}
                  </span>
                </div>
              </Squircle>
              {dark && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    borderRadius: s(7),
                    boxShadow: "inset 0 0 0 1px rgba(195, 236, 255, 0.03)",
                  }}
                />
              )}
              </div>
            </div>
          </div>
        </Squircle>
        {dark && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              borderRadius: s(compact ? 10 : 13),
              boxShadow: "inset 0 0 0 1px rgba(195, 236, 255, 0.03)",
            }}
          />
        )}
      </div>
    </div>
  );
}
