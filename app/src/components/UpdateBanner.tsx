import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/tauri-api";
import type { Update } from "@tauri-apps/plugin-updater";

type BannerState =
  | { kind: "hidden" }
  | { kind: "available"; version: string }
  | { kind: "downloading" }
  | { kind: "error"; message: string };

export default function UpdateBanner() {
  const [state, setState] = useState<BannerState>({ kind: "hidden" });
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!isTauri) {
      // Mock: simulate an available update after 2 seconds
      const timer = setTimeout(() => {
        if (!cancelled) {
          updateRef.current = {
            version: "0.99.0",
            body: "Mock update for UI development",
            downloadAndInstall: async () => {
              // Simulate download over 3 seconds
              await new Promise((r) => setTimeout(r, 3000));
            },
          } as unknown as Update;
          setState({ kind: "available", version: "0.99.0" });
        }
      }, 2000);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // Real Tauri update check
    (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (cancelled || !update) return;

        updateRef.current = update;
        setState({ kind: "available", version: update.version });
      } catch {
        // Update check failed — silently ignore, retry next launch
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUpdate() {
    const update = updateRef.current;
    if (!update) return;

    setState({ kind: "downloading" });

    try {
      await update.downloadAndInstall();
      if (isTauri) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } else {
        // Mock: just dismiss the banner
        setState({ kind: "hidden" });
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      let message: string;
      if (raw.includes("signature")) {
        message = "Signature verification failed — the update may not have been signed correctly. Please try again later or download manually from kept.work.";
      } else if (raw.includes("network") || raw.includes("connect") || raw.includes("timeout")) {
        message = "Could not reach the update server. Check your internet connection and try again.";
      } else if (raw.includes("permission") || raw.includes("access")) {
        message = "Permission denied — try running the app as administrator.";
      } else if (raw) {
        message = raw;
      } else {
        message = "An unknown error occurred. Please try again later or download manually from kept.work.";
      }
      setState({ kind: "error", message });
    }
  }

  const dismiss = () => setState({ kind: "hidden" });

  if (state.kind === "hidden") return null;

  return (
    <div
      onClick={state.kind !== "downloading" ? dismiss : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0b1115",
          border: "1px solid rgba(195, 236, 255, 0.08)",
          borderRadius: 12,
          padding: 28,
          width: 360,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {state.kind === "available" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", textAlign: "center" }}>
              <span style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 18,
                fontWeight: 600,
                color: "rgba(195, 236, 255, 0.9)",
                letterSpacing: "-0.02em",
              }}>
                Update Available
              </span>
              <span style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 14,
                color: "rgba(195, 236, 255, 0.45)",
              }}>
                Kept v{state.version} is ready to install.
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                onClick={dismiss}
                style={{
                  background: "rgba(195, 236, 255, 0.06)",
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 16px",
                  color: "rgba(195, 236, 255, 0.6)",
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Later
              </button>
              <button
                onClick={handleUpdate}
                style={{
                  background: "rgba(195, 236, 255, 0.1)",
                  border: "1px solid rgba(195, 236, 255, 0.15)",
                  borderRadius: 6,
                  padding: "8px 20px",
                  color: "rgba(195, 236, 255, 0.9)",
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Update now
              </button>
            </div>
          </>
        )}
        {state.kind === "downloading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", padding: "8px 0" }}>
            <span style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 14,
              fontWeight: 500,
              color: "rgba(195, 236, 255, 0.7)",
            }}>
              Downloading update...
            </span>
          </div>
        )}
        {state.kind === "error" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", textAlign: "center" }}>
              <span style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 18,
                fontWeight: 600,
                color: "rgba(195, 236, 255, 0.9)",
                letterSpacing: "-0.02em",
              }}>
                Update Failed
              </span>
              <span style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 14,
                color: "rgba(255, 100, 100, 0.8)",
              }}>
                {state.message}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                onClick={dismiss}
                style={{
                  background: "rgba(195, 236, 255, 0.06)",
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 16px",
                  color: "rgba(195, 236, 255, 0.6)",
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
