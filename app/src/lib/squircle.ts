/**
 * Figma-accurate corner smoothing (100%).
 * Based on https://www.figma.com/blog/desperately-seeking-squircles/
 * and the figma-squircle package by phamfoo.
 */
export function getCornerParams(cornerRadius: number, budget: number) {
  const smoothing = 1; // 100%
  let r = Math.min(cornerRadius, budget);
  let p = (1 + smoothing) * r;

  let s = smoothing;
  if (p > budget) {
    s = Math.max(0, budget / r - 1);
    p = budget;
  }

  const arcMeasure = (90 * (1 - s) * Math.PI) / 180;
  const arcSectionLength = Math.sin(arcMeasure / 2) * r * Math.sqrt(2);
  const angleAlpha = ((90 * (Math.PI / 180)) - arcMeasure) / 2;
  const p3ToP4 = r * Math.tan(angleAlpha / 2);
  const angleBeta = (45 * s * Math.PI) / 180;
  const c = p3ToP4 * Math.cos(angleBeta);
  const d = c * Math.tan(angleBeta);
  const b = (p - arcSectionLength - c - d) / 3;
  const a = 2 * b;

  return { a, b, c, d, p, arcSectionLength, r };
}

function f(n: number) { return n.toFixed(4); }

export function squirclePath(w: number, h: number, cornerRadius: number): string {
  const budget = Math.min(w, h) / 2;
  const { a, b, c, d, p, arcSectionLength, r } = getCornerParams(cornerRadius, budget);

  if (r === 0) return `M0,0 L${w},0 L${w},${h} L0,${h} Z`;

  return [
    // Start top edge
    `M ${f(w - p)} 0`,
    // Top-right corner
    `c ${f(a)} 0 ${f(a + b)} 0 ${f(a + b + c)} ${f(d)}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(arcSectionLength)} ${f(arcSectionLength)}`,
    `c ${f(d)} ${f(c)} ${f(d)} ${f(b + c)} ${f(d)} ${f(a + b + c)}`,
    // Right edge
    `L ${f(w)} ${f(h - p)}`,
    // Bottom-right corner
    `c 0 ${f(a)} 0 ${f(a + b)} ${f(-d)} ${f(a + b + c)}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(-arcSectionLength)} ${f(arcSectionLength)}`,
    `c ${f(-c)} ${f(d)} ${f(-(b + c))} ${f(d)} ${f(-(a + b + c))} ${f(d)}`,
    // Bottom edge
    `L ${f(p)} ${f(h)}`,
    // Bottom-left corner
    `c ${f(-a)} 0 ${f(-(a + b))} 0 ${f(-(a + b + c))} ${f(-d)}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(-arcSectionLength)} ${f(-arcSectionLength)}`,
    `c ${f(-d)} ${f(-c)} ${f(-d)} ${f(-(b + c))} ${f(-d)} ${f(-(a + b + c))}`,
    // Left edge
    `L 0 ${f(p)}`,
    // Top-left corner
    `c 0 ${f(-a)} 0 ${f(-(a + b))} ${f(d)} ${f(-(a + b + c))}`,
    `a ${f(r)} ${f(r)} 0 0 1 ${f(arcSectionLength)} ${f(-arcSectionLength)}`,
    `c ${f(c)} ${f(-d)} ${f(b + c)} ${f(-d)} ${f(a + b + c)} ${f(-d)}`,
    "Z",
  ].join(" ");
}

/** Responsive radius: ~5% of shorter dimension, clamped 30–40px */
export function responsiveRadius(w: number, h: number): number {
  return Math.max(30, Math.min(40, Math.min(w, h) * 0.05));
}
