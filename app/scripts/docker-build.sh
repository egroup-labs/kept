#!/usr/bin/env bash
set -euo pipefail

# Build Kept Linux packages (.deb + .AppImage) inside Docker.
#
# Usage:
#   ./scripts/docker-build.sh                    # normal build
#   ./scripts/docker-build.sh --no-cache         # rebuild Docker image from scratch
#   ./scripts/docker-build.sh --clean            # delete cargo/target caches
#
# Updater signing (optional — set before running):
#   export TAURI_SIGNING_PRIVATE_KEY="..."
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."

cd "$(dirname "$0")/.."

IMAGE_NAME="kept-builder"
NO_CACHE=""

for arg in "$@"; do
  case "$arg" in
    --no-cache)
      NO_CACHE="--no-cache"
      ;;
    --clean)
      echo "Removing cached Docker volumes..."
      docker volume rm kept-cargo-registry kept-cargo-git kept-cargo-target 2>/dev/null || true
      echo "Done."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: $0 [--no-cache] [--clean]"
      exit 1
      ;;
  esac
done

# ── Build the Docker image ────────────────────────────────────
echo "==> Building Docker image '${IMAGE_NAME}'..."
docker build $NO_CACHE -t "$IMAGE_NAME" -f docker/Dockerfile .

# ── Prepare output directory ──────────────────────────────────
mkdir -p dist-packages

# ── Run the build ─────────────────────────────────────────────
echo ""
echo "==> Starting build container..."
echo ""

docker run --rm \
  -v "$(pwd):/src:ro" \
  -v "$(pwd)/dist-packages:/output" \
  -v kept-cargo-registry:/root/.cargo/registry \
  -v kept-cargo-git:/root/.cargo/git \
  -v kept-cargo-target:/cache/target \
  -e TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-}" \
  -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  "$IMAGE_NAME"

echo ""
echo "Artifacts are in dist-packages/:"
ls -lh dist-packages/
