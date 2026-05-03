# Reproducible build environment for Kept (Tauri 2)
# Produces: .deb, .AppImage, and updater artifacts for Linux x86_64
#
# Usage (via convenience script):
#   ./scripts/docker-build.sh
#
# Or manually:
#   docker build -t kept-builder -f docker/Dockerfile .
#   docker run --rm -v "$(pwd):/src:ro" -v "$(pwd)/dist-packages:/output" kept-builder

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ── System dependencies for Tauri 2 on Ubuntu 24.04 ──────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    wget \
    file \
    pkg-config \
    # Tauri / WebKitGTK
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    xdg-utils \
    # SSL
    libssl-dev \
    # bindgen (used by zstd-sys → cozorocks/RocksDB)
    libclang-dev \
    # AppImage: linuxdeploy is distributed as an AppImage, needs FUSE or extract mode
    libfuse2t64 \
    # Misc build tools
    patchelf \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 LTS ───────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Rust stable ──────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# ── Tauri CLI ────────────────────────────────────────────────
RUN cargo install tauri-cli --version "^2" --locked

# ── Allow AppImage tools to run without FUSE inside Docker ───
ENV APPIMAGE_EXTRACT_AND_RUN=1

WORKDIR /work

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
