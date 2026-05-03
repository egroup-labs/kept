#!/usr/bin/env bash
set -euo pipefail

# Generates the update.json manifest for the Tauri updater plugin.
# Run from kept/app/ after `npm run tauri build`.
#
# Usage: ./scripts/generate-update-manifest.sh <version> <base-url>
# Example: ./scripts/generate-update-manifest.sh 0.2.0 https://your-server.com/releases
#
# Requires: jq

VERSION="${1:?Usage: $0 <version> <base-url>}"
BASE_URL="${2:?Usage: $0 <version> <base-url>}"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  echo "Install with: sudo apt install jq (Linux) or choco install jq (Windows)" >&2
  exit 1
fi

BUNDLE_DIR="src-tauri/target/release/bundle"
OUT_FILE="update.json"
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Start with the base manifest (no platforms yet)
MANIFEST=$(jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$PUB_DATE" \
  '{version: $version, notes: "Kept v\($version)", pub_date: $pub_date, platforms: {}}')

# Linux AppImage (built on Linux)
APPIMAGE_SIG_FILE=$(find "$BUNDLE_DIR/appimage/" -name "*.AppImage.tar.gz.sig" 2>/dev/null | head -1)
if [[ -n "$APPIMAGE_SIG_FILE" ]]; then
  APPIMAGE_NAME=$(basename "${APPIMAGE_SIG_FILE%.sig}")
  LINUX_URL="${BASE_URL}/v${VERSION}/${APPIMAGE_NAME}"
  LINUX_SIG=$(cat "$APPIMAGE_SIG_FILE")

  MANIFEST=$(echo "$MANIFEST" | jq \
    --arg url "$LINUX_URL" \
    --arg sig "$LINUX_SIG" \
    '.platforms["linux-x86_64"] = {url: $url, signature: $sig}')
fi

# Windows NSIS (built on Windows — sig file may also be found locally)
NSIS_SIG_FILE=$(find "$BUNDLE_DIR/nsis/" -name "*.nsis.zip.sig" 2>/dev/null | head -1)
if [[ -n "$NSIS_SIG_FILE" ]]; then
  NSIS_NAME=$(basename "${NSIS_SIG_FILE%.sig}")
  WINDOWS_URL="${BASE_URL}/v${VERSION}/${NSIS_NAME}"
  WINDOWS_SIG=$(cat "$NSIS_SIG_FILE")

  MANIFEST=$(echo "$MANIFEST" | jq \
    --arg url "$WINDOWS_URL" \
    --arg sig "$WINDOWS_SIG" \
    '.platforms["windows-x86_64"] = {url: $url, signature: $sig}')
fi

# Check that at least one platform was found
PLATFORM_COUNT=$(echo "$MANIFEST" | jq '.platforms | length')
if [[ "$PLATFORM_COUNT" -eq 0 ]]; then
  echo "Error: No updater artifacts found in $BUNDLE_DIR" >&2
  echo "Did you run 'npm run tauri build' with TAURI_SIGNING_PRIVATE_KEY set?" >&2
  exit 1
fi

echo "$MANIFEST" | jq . > "$OUT_FILE"

echo "Generated $OUT_FILE for v${VERSION}"
echo ""
cat "$OUT_FILE"
