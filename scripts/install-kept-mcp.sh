#!/usr/bin/env bash
# Kept MCP server installer — Linux / macOS
# Usage:
#   ./scripts/install-kept-mcp.sh                  # auto-detect claude / openclaw
#   ./scripts/install-kept-mcp.sh --claudecode
#   ./scripts/install-kept-mcp.sh --openclaw
#   ./scripts/install-kept-mcp.sh --claudecode --openclaw
#   curl -fsSL https://raw.githubusercontent.com/egroup-labs/kept.work/main/scripts/install-kept-mcp.sh | bash
#   bash <(curl -fsSL .../install-kept-mcp.sh) --claudecode

set -euo pipefail

REPO_URL="https://github.com/egroup-labs/kept.git"
DEFAULT_DIR="$HOME/.kept/mcp-src"
VAULT_PATH="${KEPT_VAULT_PATH:-$HOME/.kept/vault}"
REF="${KEPT_REF:-main}"

INSTALL_CLAUDE=0
INSTALL_OPENCLAW=0
AUTO=1
DIR=""
NO_BUILD=0

usage() {
  cat <<EOF
Usage: install-kept-mcp.sh [--claudecode] [--openclaw] [--dir PATH] [--no-build] [--help]

Installs the kept-vault MCP server into Claude Code and/or OpenClaw.
With no target flags: auto-detects which CLIs are installed and registers with all found.

Flags:
  --claudecode   Register with Claude Code (disables auto-detect)
  --openclaw     Register with OpenClaw   (disables auto-detect)
  --dir PATH     Repo source directory (default: $DEFAULT_DIR; cloned if missing)
  --ref REF      Branch/tag/sha to clone (default: main; overrides KEPT_REF)
  --no-build     Skip npm install + build (assume dist/ already built)
  -h, --help     Show this help

Env:
  KEPT_VAULT_PATH  Vault location passed to the MCP server (default: ~/.kept/vault)
  KEPT_REF         Branch/tag to clone (default: main)
  GITHUB_TOKEN     Used to clone the repo while it is private
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --claudecode) INSTALL_CLAUDE=1; AUTO=0; shift ;;
    --openclaw)   INSTALL_OPENCLAW=1; AUTO=0; shift ;;
    --dir)        DIR="${2:-}"; shift 2 ;;
    --ref)        REF="${2:-}"; shift 2 ;;
    --no-build)   NO_BUILD=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
log()  { printf '==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

if [[ $AUTO -eq 1 ]]; then
  have claude   && INSTALL_CLAUDE=1   || true
  have openclaw && INSTALL_OPENCLAW=1 || true
  if [[ $INSTALL_CLAUDE -eq 0 && $INSTALL_OPENCLAW -eq 0 ]]; then
    die "neither 'claude' nor 'openclaw' found on PATH. Install one, or pass --claudecode / --openclaw."
  fi
fi

have node || die "node not found. Install Node.js 20+: https://nodejs.org"
have npm  || die "npm not found."

NODE_VER="$(node -v)"          # "v24.13.1"
NODE_MAJOR="${NODE_VER#v}"     # "24.13.1"
NODE_MAJOR="${NODE_MAJOR%%.*}" # "24"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node 20+ required (found $NODE_VER)"
fi

# Resolve source dir: explicit --dir, else script's repo (or its parent if script lives in scripts/), else default.
if [[ -z "$DIR" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  for candidate in "$SCRIPT_DIR" "${SCRIPT_DIR%/*}"; do
    if [[ -n "$candidate" && -f "$candidate/mcp/package.json" ]]; then
      DIR="$candidate"
      break
    fi
  done
  [[ -n "$DIR" ]] || DIR="$DEFAULT_DIR"
fi

MCP_DIR="$DIR/mcp"

if [[ ! -f "$MCP_DIR/package.json" ]]; then
  have git || die "git not found and repo not present at $DIR"
  if [[ -d "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
    die "$DIR exists and is not a Kept checkout. Delete it or pass --dir PATH."
  fi
  mkdir -p "$(dirname "$DIR")"
  CLONE_URL="$REPO_URL"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/egroup-labs/kept.git"
    log "Cloning egroup-labs/kept.work@$REF into $DIR (authenticated)"
  else
    log "Cloning $REPO_URL@$REF into $DIR"
  fi
  # Sparse checkout: only fetch mcp subtree, not full repo.
  if ! git clone --filter=blob:none --sparse --depth 1 --branch "$REF" "$CLONE_URL" "$DIR"; then
    die "git clone failed (ref '$REF' missing? token expired? network?)."
  fi
  if ! git -C "$DIR" sparse-checkout set mcp; then
    die "git sparse-checkout failed. Requires git 2.25+."
  fi
  # Scrub token from stored remote so it doesn't linger on disk.
  git -C "$DIR" remote set-url origin "$REPO_URL"
  [[ -f "$MCP_DIR/package.json" ]] || die "clone succeeded but $MCP_DIR/package.json is missing — wrong ref?"
else
  log "Using existing repo at $DIR"
fi

if [[ $NO_BUILD -eq 0 ]]; then
  log "Installing dependencies"
  (cd "$MCP_DIR" && npm install --silent) || die "npm install failed in $MCP_DIR"
  log "Building"
  (cd "$MCP_DIR" && npm run build --silent) || die "npm run build failed in $MCP_DIR"
fi

ENTRY="$MCP_DIR/dist/index.js"
[[ -f "$ENTRY" ]] || die "build output missing: $ENTRY. Re-run without --no-build."

# Ensure the vault directory exists so the MCP server starts cleanly on first run.
mkdir -p "$VAULT_PATH"

if [[ $INSTALL_CLAUDE -eq 1 ]]; then
  have claude || die "claude CLI not on PATH"
  log "Registering with Claude Code"
  # -s user: register at user scope so the MCP is available across all
  # projects, not just the current working directory (claude's default is local).
  # Also remove any stray local-scope entry so it doesn't shadow user scope.
  claude mcp remove -s local kept-vault >/dev/null 2>&1 || true
  claude mcp remove -s user  kept-vault >/dev/null 2>&1 || true
  claude mcp add -s user kept-vault -e "KEPT_VAULT_PATH=$VAULT_PATH" -- node "$ENTRY"
fi

if [[ $INSTALL_OPENCLAW -eq 1 ]]; then
  have openclaw || die "openclaw CLI not on PATH"
  log "Registering with OpenClaw"
  CONFIG=$(printf '{"command":"node","args":["%s"],"env":{"KEPT_VAULT_PATH":"%s"}}' "$ENTRY" "$VAULT_PATH")
  openclaw mcp set kept-vault "$CONFIG"
fi

log "Done. Vault path: $VAULT_PATH"
