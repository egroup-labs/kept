import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

const GRIP = 8;     // px — invisible hit zone along each edge
const CORNER = 48;  // px — corner grip; must exceed the inner container's
                    // border-radius (App.tsx `radius = 40`) so users can grab
                    // resize at the visible rounded corner, not just the
                    // outermost square.

// Matches `tauri.conf.json` -> windows[0].minWidth / minHeight. Kept in sync
// here because the manual resize path enforces the floor itself; if it
// drifts the user can clip the window below the OS minimum and the layout
// will start clipping internal UI.
const MIN_W_CSS = 800;
const MIN_H_CSS = 500;

type Direction =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

/**
 * Manual window resize via JS, used in place of Tauri's
 * `getCurrentWindow().startResizeDragging()`.
 *
 * Why manual: on macOS 26 with `decorations: false` + `transparent: true` +
 * `macOSPrivateApi: true`, `startResizeDragging` fires but AppKit silently
 * declines to actually resize the window (the cursor changes, the gesture
 * begins, nothing happens). Driving setSize/setPosition from the JS side
 * works reliably because it does not depend on AppKit's window-drag gesture
 * machinery — it just reads the cursor and pushes a new frame.
 *
 * Mechanics:
 *  - On mousedown we synchronously capture the cursor's screen position and
 *    asynchronously fetch the window's current outer size and position.
 *  - mousemove events are coalesced via requestAnimationFrame so we issue at
 *    most one IPC per frame.
 *  - Each frame computes (dx, dy) in physical pixels from the starting
 *    cursor position and applies them to the captured starting size/pos
 *    according to which edges the gesture grabbed.
 *  - For West/North gestures we move the window's origin opposite to the
 *    size delta so the OPPOSITE edge stays anchored.
 *  - The minimum is clamped here AND enforced by AppKit, so the worst case
 *    if the math drifts is a sticky bottom-right edge — never a window
 *    smaller than usable.
 */
function startManualResize(dir: Direction, e: React.MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();

  const win = getCurrentWindow();
  const dpr = window.devicePixelRatio || 1;

  // Captured synchronously — these are the source of truth for delta math.
  const startScreenX = e.screenX;
  const startScreenY = e.screenY;

  let startSize: { width: number; height: number } | null = null;
  let startPos: { x: number; y: number } | null = null;

  // Kick off the async fetch immediately. Until it resolves, mousemove
  // events are queued (latest wins, see below) and applied once we have
  // a starting state. The cursor's `screenX/Y` from the original mousedown
  // is preserved, so deltas remain correct across the warm-up.
  Promise.all([win.outerSize(), win.outerPosition()])
    .then(([size, pos]) => {
      startSize = { width: size.width, height: size.height };
      startPos = { x: pos.x, y: pos.y };
    })
    .catch(() => {
      // If we couldn't read the starting state, give up on this gesture.
      detach();
    });

  let pending: MouseEvent | null = null;
  let rafId: number | null = null;

  const applyFrame = () => {
    rafId = null;
    if (!startSize || !startPos || !pending) return;
    const ev = pending;
    pending = null;

    // screenX/Y on macOS WKWebView is reported in CSS px; window sizes/positions
    // are physical px in Tauri.
    const dx = (ev.screenX - startScreenX) * dpr;
    const dy = (ev.screenY - startScreenY) * dpr;

    let w = startSize.width;
    let h = startSize.height;
    let x = startPos.x;
    let y = startPos.y;

    const minW = MIN_W_CSS * dpr;
    const minH = MIN_H_CSS * dpr;

    if (dir.includes("East")) {
      w = Math.max(minW, startSize.width + dx);
    } else if (dir.includes("West")) {
      const next = Math.max(minW, startSize.width - dx);
      x = startPos.x + (startSize.width - next);
      w = next;
    }
    if (dir.includes("South")) {
      h = Math.max(minH, startSize.height + dy);
    } else if (dir.includes("North")) {
      const next = Math.max(minH, startSize.height - dy);
      y = startPos.y + (startSize.height - next);
      h = next;
    }

    // Fire-and-forget — awaiting would serialize the gesture and feel laggy.
    win.setSize(new PhysicalSize(Math.round(w), Math.round(h)));
    win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
  };

  const onMove = (ev: MouseEvent) => {
    pending = ev;
    if (rafId === null) {
      rafId = requestAnimationFrame(applyFrame);
    }
  };

  const onUp = () => {
    detach();
  };

  function detach() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function grip(dir: Direction) {
  return (e: React.MouseEvent) => startManualResize(dir, e);
}

// z-[210] places grips above the Titlebar (`z-[70]`) and inset edge glow
// (`z-[100]`) at the top corners, where their hit zones overlap. Without
// this, the titlebar's invisible drag surface intercepts mouse events at
// the top-left and top-right corners.
const base = "absolute select-none z-[210]";

export default function ResizeGrips() {
  return (
    <>
      {/* Edges: 8px-wide invisible strips between the corner blocks. */}
      <div onMouseDown={grip("North")} className={base} style={{ cursor: "n-resize", top: 0, left: CORNER, right: CORNER, height: GRIP }} />
      <div onMouseDown={grip("South")} className={base} style={{ cursor: "s-resize", bottom: 0, left: CORNER, right: CORNER, height: GRIP }} />
      <div onMouseDown={grip("West")} className={base} style={{ cursor: "w-resize", left: 0, top: CORNER, bottom: CORNER, width: GRIP }} />
      <div onMouseDown={grip("East")} className={base} style={{ cursor: "e-resize", right: 0, top: CORNER, bottom: CORNER, width: GRIP }} />
      {/* Corners: 48×48 blocks that cover both the absolute window corner AND
          the visible rounded arc of the inner app container (radius 40 + 8px
          outer padding). */}
      <div onMouseDown={grip("NorthWest")} className={base} style={{ cursor: "nw-resize", top: 0, left: 0, width: CORNER, height: CORNER }} />
      <div onMouseDown={grip("NorthEast")} className={base} style={{ cursor: "ne-resize", top: 0, right: 0, width: CORNER, height: CORNER }} />
      <div onMouseDown={grip("SouthWest")} className={base} style={{ cursor: "sw-resize", bottom: 0, left: 0, width: CORNER, height: CORNER }} />
      <div onMouseDown={grip("SouthEast")} className={base} style={{ cursor: "se-resize", bottom: 0, right: 0, width: CORNER, height: CORNER }} />
    </>
  );
}
