#!/usr/bin/env bash
# Kept installer — Linux / macOS.
#
# Interactive (TUI checkbox):
#   curl -fsSL https://kept.work/install.sh | bash
#   bash <(curl -fsSL https://kept.work/install.sh)
#
# Non-interactive:
#   curl -fsSL https://kept.work/install.sh | bash -s -- --components app,cli,mcp
#   curl -fsSL https://kept.work/install.sh | bash -s -- --components cli --from-source
#
# Components: app, cli, mcp
#   app  — Kept desktop application
#   cli  — kept-cli (minimal headless companion, no UI)
#   mcp  — kept-vault MCP server, registered with Claude Code / OpenClaw
#
# Each component tries a prebuilt binary from GitHub Releases first, then
# falls back to building from source (requires the relevant toolchain).
#
# Env / flags:
#   --components a,b,c     Components to install (skips TUI)
#   --from-source          Skip binary download, build everything from source
#   --no-extension         Don't extract the browser extension when installing app
#   --version v0.3.1       Specific app release tag (default: latest)
#   --ref main             Git ref for source builds (default: main)
#   --src-dir PATH         Where to clone for source builds (default: ~/.kept/src)
#   --linux-package auto   For app: auto | deb | appimage
#   --yes / -y             Don't prompt for confirmation
#   --no-tui               Fail instead of opening the TUI
#
#   KEPT_REPO              github org/repo (default: egroup-labs/kept.work)
#   KEPT_VAULT_PATH        Vault location (default: ~/.kept/vault)
#   KEPT_BIN_DIR           Where to put kept-cli (default: ~/.local/bin)
#   KEPT_APP_DIR           macOS app location (default: /Applications)
#   GITHUB_TOKEN           Used for clones while the repo is private

set -euo pipefail

REPO="${KEPT_REPO:-egroup-labs/kept.work}"
VERSION="${KEPT_VERSION:-latest}"
SRC_DIR="${KEPT_SRC_DIR:-$HOME/.kept/src}"
REF="${KEPT_REF:-main}"
LINUX_PACKAGE="${KEPT_LINUX_PACKAGE:-auto}"
COMPONENTS="${KEPT_COMPONENTS:-}"
FROM_SOURCE=0
INSTALL_EXTENSION="${KEPT_INSTALL_EXTENSION:-1}"
NO_TUI=0
ASSUME_YES=0

usage() { sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --components)        COMPONENTS="${2:?}"; shift 2 ;;
    --components=*)      COMPONENTS="${1#*=}"; shift ;;
    --from-source)       FROM_SOURCE=1; shift ;;
    --no-extension)      INSTALL_EXTENSION=0; shift ;;
    --version)           VERSION="${2:?}"; shift 2 ;;
    --version=*)         VERSION="${1#*=}"; shift ;;
    --ref)               REF="${2:?}"; shift 2 ;;
    --ref=*)             REF="${1#*=}"; shift ;;
    --src-dir)           SRC_DIR="${2:?}"; shift 2 ;;
    --linux-package)     LINUX_PACKAGE="${2:?}"; shift 2 ;;
    --yes|-y)            ASSUME_YES=1; shift ;;
    --no-tui)            NO_TUI=1; shift ;;
    -h|--help)           usage 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; usage 1 ;;
  esac
done

# ---- helpers ---------------------------------------------------------------

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

sudo_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"
  elif have sudo;             then sudo "$@"
  else die "sudo required for: $*"
  fi
}

warn_path() {
  local d="$1"
  case ":$PATH:" in
    *":$d:"*) ;;
    *) warn "$d is not on PATH — add it to your shell rc or invoke binaries by full path" ;;
  esac
}

ensure_tty() {
  if [[ ! -t 0 ]]; then
    if [[ -r /dev/tty ]] && { exec </dev/tty; } 2>/dev/null; then
      :
    else
      die "no terminal available; pass --components <list>"
    fi
  fi
}

# ---- platform --------------------------------------------------------------

OS="$(uname -s)"
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x86_64 ;;
  arm64|aarch64) ARCH=aarch64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported OS: $OS (use install.ps1 on Windows)" ;;
esac

# Some Mac users run /bin/bash 3.2 — keep features in that range.

TMPDIR_INSTALL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

# ---- release fetch ---------------------------------------------------------

ASSET_URLS=""
ASSETS_FETCHED=0

api_url() {
  if [[ "$VERSION" == "latest" ]]; then
    printf 'https://api.github.com/repos/%s/releases/latest' "$REPO"
  else
    local tag="$VERSION"
    [[ "$tag" == v* ]] || tag="v$tag"
    printf 'https://api.github.com/repos/%s/releases/tags/%s' "$REPO" "$tag"
  fi
}

ensure_assets() {
  [[ $ASSETS_FETCHED -eq 1 ]] && return 0
  have curl || die "curl is required"
  log "Resolving release from $REPO ($VERSION)"
  local hdr_auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && hdr_auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  ASSET_URLS="$(curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: kept-installer' \
    "${hdr_auth[@]}" \
    "$(api_url)" 2>/dev/null \
    | sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' || true)"
  ASSETS_FETCHED=1
  if [[ -z "$ASSET_URLS" ]]; then
    warn "no release assets resolved (private repo without GITHUB_TOKEN, no published release, or network error)"
  fi
}

choose_url() {
  local pattern="$1"
  printf '%s\n' "$ASSET_URLS" | grep -Ei "$pattern" | grep -Eiv '\.sig$' | head -n 1 || true
}

download() {
  local url="$1" dest="$2"
  log "Downloading $(basename "$dest")"
  local hdr_auth=()
  [[ -n "${GITHUB_TOKEN:-}" ]] && hdr_auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fL --progress-bar -H 'User-Agent: kept-installer' "${hdr_auth[@]}" "$url" -o "$dest"
}

# ---- source dir ------------------------------------------------------------

resolve_local_checkout() {
  # If the script lives inside a Kept checkout, prefer that.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  for c in "$script_dir" "${script_dir%/*}"; do
    if [[ -n "$c" && -f "$c/app/src-tauri/Cargo.toml" && -d "$c/cli" && -d "$c/mcp" ]]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

ensure_source_dir() {
  local found
  if found="$(resolve_local_checkout)"; then
    SRC_DIR="$found"
    log "Using existing Kept checkout at $SRC_DIR"
    return
  fi
  if [[ -f "$SRC_DIR/app/src-tauri/Cargo.toml" ]]; then
    log "Using existing Kept checkout at $SRC_DIR"
    return
  fi
  have git || die "git not found and no Kept checkout available; install git or pre-clone to $SRC_DIR"
  if [[ -d "$SRC_DIR" && -n "$(ls -A "$SRC_DIR" 2>/dev/null)" ]]; then
    die "$SRC_DIR exists and is not a Kept checkout. Delete it or pass --src-dir PATH."
  fi
  mkdir -p "$(dirname "$SRC_DIR")"

  local clone_url="https://github.com/$REPO.git"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    clone_url="https://x-access-token:${GITHUB_TOKEN}@github.com/$REPO.git"
    log "Cloning $REPO@$REF into $SRC_DIR (authenticated)"
  else
    log "Cloning $REPO@$REF into $SRC_DIR"
  fi
  git clone --filter=blob:none --sparse --depth 1 --branch "$REF" "$clone_url" "$SRC_DIR" \
    || die "git clone failed (ref '$REF' missing? token expired? network?)"
  git -C "$SRC_DIR" sparse-checkout set app cli mcp extension scripts \
    || die "git sparse-checkout failed (requires git 2.25+)"
  git -C "$SRC_DIR" remote set-url origin "https://github.com/$REPO.git" >/dev/null 2>&1 || true
  [[ -f "$SRC_DIR/app/src-tauri/Cargo.toml" ]] || die "clone succeeded but checkout is incomplete"
}

# ---- component: APP --------------------------------------------------------

# Install Kept.app from a local .app directory or a downloaded artifact.
install_macos_app_from_app() {
  local app="$1"
  local app_dir="${KEPT_APP_DIR:-/Applications}"
  if [[ ! -w "$app_dir" ]]; then
    app_dir="$HOME/Applications"
    mkdir -p "$app_dir"
  fi
  rm -rf "$app_dir/Kept.app"
  ditto "$app" "$app_dir/Kept.app"
  xattr -dr com.apple.quarantine "$app_dir/Kept.app" 2>/dev/null || true
  log "Installed Kept to $app_dir/Kept.app"
}

install_macos_from_dmg() {
  local file="$1"
  local mount app
  mount="$(hdiutil attach -nobrowse -quiet "$file" | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/")); exit}')"
  [[ -n "$mount" ]] || die "failed to mount DMG"
  app="$(find "$mount" -maxdepth 2 -name 'Kept.app' -type d | head -n 1)"
  [[ -n "$app" ]] || { hdiutil detach -quiet "$mount" || true; die "Kept.app not found in DMG"; }
  install_macos_app_from_app "$app"
  hdiutil detach -quiet "$mount" || true
}

install_app_binary_macos() {
  ensure_assets
  [[ -n "$ASSET_URLS" ]] || return 1
  if [[ "$ARCH" != "aarch64" ]]; then
    warn "macOS release builds are Apple Silicon only — falling back to source build"
    return 1
  fi
  local url file
  url="$(choose_url '\.dmg$')"
  if [[ -n "$url" ]]; then
    file="$TMPDIR_INSTALL/Kept.dmg"
    download "$url" "$file"
    install_macos_from_dmg "$file"
    return 0
  fi
  url="$(choose_url '\.app\.tar\.gz$')"
  [[ -n "$url" ]] || return 1
  file="$TMPDIR_INSTALL/Kept.app.tar.gz"
  download "$url" "$file"
  mkdir -p "$TMPDIR_INSTALL/app"
  tar -xzf "$file" -C "$TMPDIR_INSTALL/app"
  local app
  app="$(find "$TMPDIR_INSTALL/app" -maxdepth 3 -name 'Kept.app' -type d | head -n 1)"
  [[ -n "$app" ]] || die "Kept.app not found in archive"
  install_macos_app_from_app "$app"
}

install_linux_from_deb() {
  local file="$1"
  sudo_cmd apt-get install -y "$file"
  log "Installed Kept from Debian package"
}

install_linux_from_appimage() {
  local file="$1"
  local bin_dir bin
  bin_dir="${KEPT_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin_dir"
  bin="$bin_dir/kept"
  cp "$file" "$bin"
  chmod +x "$bin"
  log "Installed Kept AppImage to $bin"
  warn_path "$bin_dir"
}

install_app_binary_linux() {
  ensure_assets
  [[ -n "$ASSET_URLS" ]] || return 1
  local deb_url appimage_url file
  deb_url="$(choose_url '\.deb$')"
  appimage_url="$(choose_url '\.AppImage$')"

  case "$LINUX_PACKAGE" in
    deb)
      [[ -n "$deb_url" ]] || return 1
      file="$TMPDIR_INSTALL/Kept.deb"
      download "$deb_url" "$file"
      install_linux_from_deb "$file"
      ;;
    appimage)
      [[ -n "$appimage_url" ]] || return 1
      file="$TMPDIR_INSTALL/Kept.AppImage"
      download "$appimage_url" "$file"
      install_linux_from_appimage "$file"
      ;;
    auto)
      if have apt-get && [[ -n "$deb_url" ]]; then
        file="$TMPDIR_INSTALL/Kept.deb"
        download "$deb_url" "$file"
        install_linux_from_deb "$file" && return 0
      fi
      [[ -n "$appimage_url" ]] || return 1
      file="$TMPDIR_INSTALL/Kept.AppImage"
      download "$appimage_url" "$file"
      install_linux_from_appimage "$file"
      ;;
    *) die "invalid --linux-package=$LINUX_PACKAGE (expected: auto, deb, appimage)" ;;
  esac
}

install_app_source() {
  have node  || die "node 20+ required to build the desktop app from source"
  have npm   || die "npm required to build the desktop app from source"
  have cargo || die "cargo (Rust toolchain) required — install via https://rustup.rs"
  ensure_source_dir
  log "Building desktop app from source (this can take several minutes)..."
  ( cd "$SRC_DIR/app" && npm install && npx --yes tauri build ) \
    || die "tauri build failed (Linux: install webkit2gtk + libsoup deps, see app/docker/Dockerfile)"

  local bundle_dir="$SRC_DIR/app/src-tauri/target/release/bundle"
  case "$OS" in
    Darwin)
      local app
      app="$(find "$bundle_dir/macos" -maxdepth 2 -name 'Kept.app' -type d 2>/dev/null | head -n 1)"
      [[ -n "$app" ]] || die "no Kept.app produced under $bundle_dir/macos"
      install_macos_app_from_app "$app"
      ;;
    Linux)
      local deb appimg
      deb="$(find "$bundle_dir/deb"      -maxdepth 2 -name '*.deb'      2>/dev/null | head -n 1)"
      appimg="$(find "$bundle_dir/appimage" -maxdepth 2 -name '*.AppImage' 2>/dev/null | head -n 1)"
      case "$LINUX_PACKAGE" in
        deb)
          [[ -n "$deb" ]] || die "no .deb produced under $bundle_dir/deb"
          install_linux_from_deb "$deb"
          ;;
        appimage)
          [[ -n "$appimg" ]] || die "no .AppImage produced under $bundle_dir/appimage"
          install_linux_from_appimage "$appimg"
          ;;
        auto)
          if have apt-get && [[ -n "$deb" ]]; then install_linux_from_deb "$deb"
          elif [[ -n "$appimg" ]];           then install_linux_from_appimage "$appimg"
          elif [[ -n "$deb" ]];              then install_linux_from_deb "$deb"
          else die "no .deb or .AppImage produced under $bundle_dir"
          fi
          ;;
      esac
      ;;
  esac
}

install_app() {
  if [[ $FROM_SOURCE -eq 1 ]]; then
    install_app_source
    return
  fi
  case "$OS" in
    Darwin)
      install_app_binary_macos && return 0
      warn "no usable macOS asset in release; falling back to source build"
      install_app_source
      ;;
    Linux)
      install_app_binary_linux && return 0
      warn "no usable Linux asset in release; falling back to source build"
      install_app_source
      ;;
  esac
}

# ---- component: CLI --------------------------------------------------------

cli_asset_pattern() {
  case "$OS" in
    Darwin) printf 'kept-cli-macos-%s$' "$ARCH" ;;
    Linux)  printf 'kept-cli-linux-%s$' "$ARCH" ;;
  esac
}

install_cli_binary() {
  ensure_assets
  [[ -n "$ASSET_URLS" ]] || return 1
  local url dest
  url="$(choose_url "$(cli_asset_pattern)")"
  [[ -n "$url" ]] || return 1
  dest="${KEPT_BIN_DIR:-$HOME/.local/bin}/kept-cli"
  mkdir -p "$(dirname "$dest")"
  download "$url" "$dest"
  chmod +x "$dest"
  log "Installed kept-cli to $dest"
  warn_path "$(dirname "$dest")"
}

install_cli_source() {
  have cargo || die "cargo (Rust toolchain) required — install via https://rustup.rs"
  ensure_source_dir
  log "Building kept-cli from source..."
  ( cd "$SRC_DIR/cli" && cargo build --release ) || die "cargo build failed in $SRC_DIR/cli"
  local src="$SRC_DIR/cli/target/release/kept"
  [[ -f "$src" ]] || die "build output missing: $src"
  local dest="${KEPT_BIN_DIR:-$HOME/.local/bin}/kept-cli"
  mkdir -p "$(dirname "$dest")"
  install -m 0755 "$src" "$dest" 2>/dev/null || { cp "$src" "$dest"; chmod +x "$dest"; }
  log "Installed kept-cli to $dest"
  warn_path "$(dirname "$dest")"
}

install_cli() {
  if [[ $FROM_SOURCE -eq 1 ]]; then
    install_cli_source
    return
  fi
  install_cli_binary && return 0
  warn "no kept-cli binary in release; falling back to source build"
  install_cli_source
}

# ---- component: MCP --------------------------------------------------------

install_mcp() {
  have node || die "node 20+ required for the MCP server"
  have npm  || die "npm required for the MCP server"
  local node_major
  node_major="$(node -v | sed 's/^v//; s/\..*//')"
  [[ "$node_major" -ge 20 ]] || die "node 20+ required (found $(node -v))"

  ensure_source_dir
  local mcp_dir="$SRC_DIR/mcp"
  log "Installing MCP dependencies"
  ( cd "$mcp_dir" && npm install --silent ) || die "npm install failed in $mcp_dir"
  log "Building MCP server"
  ( cd "$mcp_dir" && npm run build --silent ) || die "npm run build failed in $mcp_dir"
  local entry="$mcp_dir/dist/index.js"
  [[ -f "$entry" ]] || die "build output missing: $entry"

  local vault="${KEPT_VAULT_PATH:-$HOME/.kept/vault}"
  mkdir -p "$vault"

  local registered=0
  if have claude; then
    log "Registering with Claude Code (user scope)"
    claude mcp remove -s local kept-vault >/dev/null 2>&1 || true
    claude mcp remove -s user  kept-vault >/dev/null 2>&1 || true
    claude mcp add -s user kept-vault -e "KEPT_VAULT_PATH=$vault" -- node "$entry"
    registered=1
  fi
  if have openclaw; then
    log "Registering with OpenClaw"
    local cfg
    cfg=$(printf '{"command":"node","args":["%s"],"env":{"KEPT_VAULT_PATH":"%s"}}' "$entry" "$vault")
    openclaw mcp set kept-vault "$cfg"
    registered=1
  fi
  if [[ $registered -eq 0 ]]; then
    warn "neither 'claude' nor 'openclaw' found on PATH"
    warn "MCP server built at: $entry — register manually when an MCP client is installed"
  fi
}

# ---- component: EXTENSION (auxiliary) --------------------------------------

EXTENSION_DIR_RESULT=""

install_extension() {
  [[ "$INSTALL_EXTENSION" == "1" ]] || return 0
  local ext_dir="${KEPT_EXTENSION_DIR:-$HOME/.local/share/kept/extension}"

  # Prefer the release zip; if absent, copy from source checkout.
  ensure_assets
  local ext_url
  ext_url="$(choose_url '^.*/kept-extension.*\.zip$')"
  if [[ -n "$ext_url" ]] && have unzip; then
    local zip="$TMPDIR_INSTALL/kept-extension-chrome.zip"
    download "$ext_url" "$zip"
    rm -rf "$ext_dir"
    mkdir -p "$ext_dir"
    unzip -q "$zip" -d "$ext_dir"
    EXTENSION_DIR_RESULT="$ext_dir"
    log "Extension extracted to $ext_dir"
    return 0
  fi

  # Source fallback
  if ensure_source_dir 2>/dev/null && [[ -f "$SRC_DIR/extension/manifest.json" ]]; then
    rm -rf "$ext_dir"
    mkdir -p "$ext_dir"
    cp -R "$SRC_DIR/extension/." "$ext_dir/"
    EXTENSION_DIR_RESULT="$ext_dir"
    log "Extension copied from source to $ext_dir"
    return 0
  fi

  warn "no extension zip in release and no source checkout — skipping extension"
}

# ---- TUI -------------------------------------------------------------------

# Items: parallel arrays. Default: app on, others off.
TUI_KEYS=(app cli mcp)
TUI_LABEL=(\
  "Desktop app  — full UI, search, knowledge graph" \
  "CLI          — minimal headless companion (~3.6 MB)" \
  "MCP server   — register kept-vault with Claude Code / OpenClaw" \
)
TUI_SEL=(1 0 0)
TUI_CURSOR=0

tui_select() {
  ensure_tty
  printf '\033[?25l'  # hide cursor
  trap 'printf "\033[?25h\n"' EXIT INT TERM

  printf '\n\033[1mKept installer\033[0m\n'
  printf 'Select components:  ↑/↓ move   space toggle   enter install   q quit\n\n'

  local n=${#TUI_KEYS[@]} first=1
  while true; do
    if [[ $first -eq 0 ]]; then printf '\033[%dA' "$n"; fi
    first=0
    local i
    for ((i = 0; i < n; i++)); do
      local mark=" "; [[ "${TUI_SEL[i]}" -eq 1 ]] && mark="x"
      local pre="  "; [[ $i -eq $TUI_CURSOR ]] && pre="\033[1;36m> \033[0m"
      local body="${TUI_LABEL[i]}"
      [[ $i -eq $TUI_CURSOR ]] && body="\033[1m${body}\033[0m"
      printf '\033[2K\r%b[%s] %b\n' "$pre" "$mark" "$body"
    done

    local k=""
    IFS= read -rsn1 k || break
    case "$k" in
      $'\033')
        local rest=""
        IFS= read -rsn2 -t 0.05 rest || true
        case "$rest" in
          '[A') ((TUI_CURSOR > 0))     && TUI_CURSOR=$((TUI_CURSOR - 1)) ;;
          '[B') ((TUI_CURSOR < n - 1)) && TUI_CURSOR=$((TUI_CURSOR + 1)) ;;
        esac
        ;;
      ' ')      TUI_SEL[$TUI_CURSOR]=$((1 - TUI_SEL[TUI_CURSOR])) ;;
      'k')      ((TUI_CURSOR > 0))     && TUI_CURSOR=$((TUI_CURSOR - 1)) || true ;;
      'j')      ((TUI_CURSOR < n - 1)) && TUI_CURSOR=$((TUI_CURSOR + 1)) || true ;;
      'a')      local x; for ((x=0;x<n;x++)); do TUI_SEL[$x]=1; done ;;
      'n')      local x; for ((x=0;x<n;x++)); do TUI_SEL[$x]=0; done ;;
      ''|$'\n') break ;;
      'q'|$'\003')
        printf '\033[?25h\n'; trap - EXIT INT TERM; exit 130 ;;
    esac
  done

  printf '\033[?25h\n'
  trap - EXIT INT TERM

  local picked=()
  local i
  for ((i = 0; i < ${#TUI_KEYS[@]}; i++)); do
    [[ "${TUI_SEL[i]}" -eq 1 ]] && picked+=("${TUI_KEYS[i]}")
  done
  if [[ ${#picked[@]} -eq 0 ]]; then
    die "no components selected"
  fi
  COMPONENTS="$(IFS=,; printf '%s' "${picked[*]}")"
}

# ---- summary ---------------------------------------------------------------

print_summary() {
  printf '\n\033[1;32mKept installation complete.\033[0m\n'
  if [[ -n "$EXTENSION_DIR_RESULT" ]]; then
    cat <<EOF

To enable browser capture:
  1. Open chrome://extensions in a Chromium-based browser
  2. Enable Developer Mode
  3. Load unpacked: $EXTENSION_DIR_RESULT
  4. Launch Kept and open http://localhost:18241/connect in that browser
EOF
  fi
}

# ---- main ------------------------------------------------------------------

if [[ -z "$COMPONENTS" ]]; then
  if [[ $NO_TUI -eq 1 ]]; then
    die "no components specified; pass --components app,cli,mcp"
  fi
  tui_select
fi

# Validate
IFS=',' read -r -a CHOSEN <<<"$COMPONENTS"
for c in "${CHOSEN[@]}"; do
  case "$c" in
    app|cli|mcp) ;;
    "") ;;
    *) die "unknown component: '$c' (expected: app, cli, mcp)" ;;
  esac
done

log "Components: $COMPONENTS"
[[ $FROM_SOURCE -eq 1 ]] && log "Mode: source build (--from-source)"

# Confirm before doing anything that modifies the system.
if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then
  printf 'Proceed with install? [Y/n] '
  read -r REPLY || REPLY=""
  case "$REPLY" in
    n|N|no|NO) die "aborted by user" ;;
  esac
fi

for c in "${CHOSEN[@]}"; do
  [[ -z "$c" ]] && continue
  case "$c" in
    app) install_app ;;
    cli) install_cli ;;
    mcp) install_mcp ;;
  esac
done

# Auto-install extension only when app is selected.
case ",$COMPONENTS," in
  *,app,*) install_extension ;;
esac

print_summary
