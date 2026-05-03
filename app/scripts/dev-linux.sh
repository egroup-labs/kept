#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APT_INSTALL="sudo apt install -y build-essential clang libclang-dev pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev libpango1.0-dev libcairo2-dev libgdk-pixbuf-2.0-dev libglib2.0-dev"

print_install_hint() {
  echo "Ubuntu/Debian:"
  echo "  sudo apt update"
  echo "  $APT_INSTALL"
}

# Toolchain prereqs: bindgen-using crates (zstd-sys via CozoDB) need clang +
# libclang + a working C toolchain (stddef.h ships with libc6-dev, pulled in by
# build-essential). Catch these before pkg-config so the user gets one clear
# error instead of a cryptic cargo bindgen failure deep in the build.
toolchain_missing=()
command -v cc       >/dev/null 2>&1 || toolchain_missing+=("build-essential (cc)")
command -v clang    >/dev/null 2>&1 || toolchain_missing+=("clang")
command -v pkg-config >/dev/null 2>&1 || toolchain_missing+=("pkg-config")
# libclang.so lives in /usr/lib/llvm-*/lib (Ubuntu's versioned packages don't
# add this dir to ldconfig's cache) or /usr/lib{,64,/x86_64-linux-gnu}.
# Check the filesystem directly first, then fall back to ldconfig for distros
# that do register it.
shopt -s nullglob
libclang_files=(
  /usr/lib/libclang*.so*
  /usr/lib/x86_64-linux-gnu/libclang*.so*
  /usr/lib64/libclang*.so*
  /usr/lib/llvm-*/lib/libclang*.so*
  /usr/local/lib/libclang*.so*
)
shopt -u nullglob
if [ "${#libclang_files[@]}" -eq 0 ] && ! ldconfig -p 2>/dev/null | grep -qE 'libclang[-.]'; then
  toolchain_missing+=("libclang-dev")
fi

if [ "${#toolchain_missing[@]}" -gt 0 ]; then
  echo "Missing build toolchain:"
  for t in "${toolchain_missing[@]}"; do
    echo "  - $t"
  done
  echo
  print_install_hint
  exit 1
fi

missing=()
for lib in glib-2.0 gobject-2.0 gdk-3.0 pango cairo gdk-pixbuf-2.0 gtk+-3.0 webkit2gtk-4.1 libsoup-3.0; do
  if ! pkg-config --exists "$lib"; then
    missing+=("$lib")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing system deps for Tauri (Linux):"
  for lib in "${missing[@]}"; do
    echo "  - $lib"
  done
  echo
  print_install_hint
  exit 1
fi

if [ -n "${SNAP:-}" ] || [ -n "${SNAP_NAME:-}" ] || [ -n "${SNAP_LIBRARY_PATH:-}" ]; then
  echo "Detected Snap environment. Running with a clean env to avoid GLIBC errors."
fi

NPM_BIN="$(command -v npm || true)"
CARGO_BIN="$(command -v cargo || true)"
PATH_ENTRIES="/usr/bin:/bin"
if [ -n "$NPM_BIN" ]; then PATH_ENTRIES="$(dirname "$NPM_BIN"):$PATH_ENTRIES"; fi
if [ -n "$CARGO_BIN" ]; then PATH_ENTRIES="$(dirname "$CARGO_BIN"):$PATH_ENTRIES"; fi

exec env -i \
  HOME="$HOME" USER="$USER" \
  PATH="$PATH_ENTRIES" \
  DISPLAY="${DISPLAY:-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
  XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
  LANG="${LANG:-C.UTF-8}" LC_ALL="${LC_ALL:-}" \
  /bin/bash -c 'npm run tauri dev'
