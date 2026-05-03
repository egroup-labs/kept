import { getCurrentWindow } from "@tauri-apps/api/window";

const GRIP = 8; // px — invisible hit zone size
const CORNER = 20; // px — corner grip size (larger for easier grabbing)

type Direction =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

function grip(dir: Direction) {
  return (e: React.MouseEvent) => {
    if (e.button === 0) {
      e.preventDefault();
      getCurrentWindow().startResizeDragging(dir);
    }
  };
}

const base = "absolute select-none z-50";

export default function ResizeGrips() {
  return (
    <>
      {/* Edges */}
      <div onMouseDown={grip("North")} className={base} style={{ cursor: "n-resize", top: 0, left: CORNER, right: CORNER, height: GRIP }} />
      <div onMouseDown={grip("South")} className={base} style={{ cursor: "s-resize", bottom: 0, left: CORNER, right: CORNER, height: GRIP }} />
      <div onMouseDown={grip("West")} className={base} style={{ cursor: "w-resize", left: 0, top: CORNER, bottom: CORNER, width: GRIP }} />
      <div onMouseDown={grip("East")} className={base} style={{ cursor: "e-resize", right: 0, top: CORNER, bottom: CORNER, width: GRIP }} />
      {/* Corners */}
      <div onMouseDown={grip("NorthWest")} className={base} style={{ cursor: "nw-resize", top: 0, left: 0, width: CORNER, height: CORNER }} />
      <div onMouseDown={grip("NorthEast")} className={base} style={{ cursor: "ne-resize", top: 0, right: 0, width: CORNER, height: CORNER }} />
      <div onMouseDown={grip("SouthWest")} className={base} style={{ cursor: "sw-resize", bottom: 0, left: 0, width: CORNER, height: CORNER }} />
      <div onMouseDown={grip("SouthEast")} className={base} style={{ cursor: "se-resize", bottom: 0, right: 0, width: CORNER, height: CORNER }} />
    </>
  );
}
