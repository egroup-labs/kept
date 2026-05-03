#!/usr/bin/env bash
set -euo pipefail

echo "══════════════════════════════════════════════════"
echo "  Kept — Docker build"
echo "══════════════════════════════════════════════════"
echo ""

# ── Copy source (exclude host artifacts) ──────────────────────
echo "==> Copying source to build directory..."
cd /src
tar --exclude='node_modules' \
    --exclude='src-tauri/target' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='dist-packages' \
    -cf - . | tar -xf - -C /work/

cd /work

# If a cached target dir is mounted, symlink it
if [ -d /cache/target ] && [ "$(ls -A /cache/target 2>/dev/null)" != "" ] || [ -d /cache/target ]; then
  ln -sfn /cache/target /work/src-tauri/target
fi

# ── Install JS dependencies ──────────────────────────────────
echo "==> Installing npm dependencies..."
npm ci --ignore-scripts 2>&1 | tail -1

# ── Build ─────────────────────────────────────────────────────
echo "==> Building Tauri app (release)..."
echo ""
BUILD_EXIT=0
if npx tauri build 2>&1; then
  :
else
  BUILD_EXIT=$?
  echo ""
  echo "==> Tauri build exited with code ${BUILD_EXIT}. Collecting any artifacts that were produced..."
fi

# ── Collect artifacts ─────────────────────────────────────────
echo ""
echo "==> Collecting artifacts..."
mkdir -p /output

BUNDLE_DIR="/work/src-tauri/target/release/bundle"

# .deb
find "$BUNDLE_DIR/deb/" -maxdepth 1 \( -name "*.deb" -o -name "*.deb.sig" \) \
  -exec cp -v {} /output/ \; 2>/dev/null || true

# AppImage
find "$BUNDLE_DIR/appimage/" -maxdepth 1 \
  \( -name "*.AppImage" -o -name "*.AppImage.tar.gz" -o -name "*.AppImage.tar.gz.sig" \) \
  -exec cp -v {} /output/ \; 2>/dev/null || true

# Fix ownership so host user can access the files
if [ -n "${HOST_UID:-}" ]; then
  chown -R "${HOST_UID}:${HOST_GID:-${HOST_UID}}" /output/
fi

echo ""
echo "══════════════════════════════════════════════════"
if [ "$BUILD_EXIT" -eq 0 ]; then
  echo "  Build complete! Artifacts in dist-packages/"
else
  echo "  Partial build artifacts copied to dist-packages/"
fi
echo "══════════════════════════════════════════════════"
echo ""
ls -lh /output/

if [ "$BUILD_EXIT" -ne 0 ]; then
  echo ""
  echo "Build failed, but any completed artifacts were copied to /output."
  exit "$BUILD_EXIT"
fi
