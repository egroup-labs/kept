#!/usr/bin/env bash
# Cut a release: bump version files, commit, tag, and push.
#
# Usage:
#   scripts/release.sh <component> <version|major|minor|patch> [flags]
#
# Components: app | extension | mcp | cli
# Version:    explicit X.Y.Z, or one of: major, minor, patch
#
# Flags:
#   --no-push     Commit and tag locally, skip the git push.
#   --dry-run     Show what would change; touch nothing.
#   --allow-dirty Skip the clean-working-tree check.
#   -y, --yes     Don't prompt before commit/tag/push.
#
# Tag formats:
#   app        -> vX.Y.Z         (matches scripts/install.sh)
#   extension  -> extension-vX.Y.Z
#   mcp        -> mcp-vX.Y.Z
#   cli        -> cli-vX.Y.Z

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

# ---- arg parsing -----------------------------------------------------------

COMPONENT=""
VERSION_ARG=""
PUSH=1
DRY_RUN=0
ALLOW_DIRTY=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)      usage 0 ;;
    --no-push)      PUSH=0 ;;
    --dry-run)      DRY_RUN=1 ;;
    --allow-dirty)  ALLOW_DIRTY=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    -*) die "unknown flag: $1" ;;
    *)
      if [[ -z "$COMPONENT" ]]; then COMPONENT="$1"
      elif [[ -z "$VERSION_ARG" ]]; then VERSION_ARG="$1"
      else die "unexpected argument: $1"
      fi
      ;;
  esac
  shift
done

[[ -n "$COMPONENT" && -n "$VERSION_ARG" ]] || usage

# ---- component config ------------------------------------------------------

# Each component has:
#   PRIMARY_FILE  — file we read the current version from
#   TAG_PREFIX    — prefix prepended to the version for the git tag
#   FILES         — list of files to update (handled per-type below)
#   CARGO_PKG     — Rust package name (for Cargo.lock updates), or empty

case "$COMPONENT" in
  app)
    TAG_PREFIX="v"
    PRIMARY_FILE="app/package.json"
    JSON_FILES=("app/package.json" "app/src-tauri/tauri.conf.json")
    CARGO_TOML_FILES=("app/src-tauri/Cargo.toml")
    CARGO_LOCK_FILES=("app/src-tauri/Cargo.lock")
    CARGO_PKG="kept"
    MANIFEST_FILES=()
    ;;
  extension)
    TAG_PREFIX="extension-v"
    PRIMARY_FILE="extension/manifest.json"
    JSON_FILES=()
    CARGO_TOML_FILES=()
    CARGO_LOCK_FILES=()
    CARGO_PKG=""
    MANIFEST_FILES=("extension/manifest.json")
    ;;
  mcp)
    TAG_PREFIX="mcp-v"
    PRIMARY_FILE="mcp/package.json"
    JSON_FILES=("mcp/package.json")
    CARGO_TOML_FILES=()
    CARGO_LOCK_FILES=()
    CARGO_PKG=""
    MANIFEST_FILES=()
    ;;
  cli)
    TAG_PREFIX="cli-v"
    PRIMARY_FILE="cli/Cargo.toml"
    JSON_FILES=()
    CARGO_TOML_FILES=("cli/Cargo.toml")
    CARGO_LOCK_FILES=("cli/Cargo.lock")
    CARGO_PKG="kept-cli"
    MANIFEST_FILES=()
    ;;
  *)
    die "unknown component '$COMPONENT' (expected: app, extension, mcp, cli)"
    ;;
esac

[[ -f "$PRIMARY_FILE" ]] || die "primary file missing: $PRIMARY_FILE"

# ---- read current version --------------------------------------------------

read_json_version() {
  # First top-level "version": "X" line.
  grep -m1 -E '^[[:space:]]*"version"[[:space:]]*:' "$1" \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

read_cargo_toml_version() {
  # First version = "X" inside [package].
  awk '
    /^\[package\]/ { in_pkg=1; next }
    /^\[/          { in_pkg=0 }
    in_pkg && /^version[[:space:]]*=[[:space:]]*"/ {
      sub(/^version[[:space:]]*=[[:space:]]*"/, "")
      sub(/".*$/, "")
      print
      exit
    }
  ' "$1"
}

case "$PRIMARY_FILE" in
  *.json) CURRENT="$(read_json_version "$PRIMARY_FILE")" ;;
  *.toml) CURRENT="$(read_cargo_toml_version "$PRIMARY_FILE")" ;;
  *)      die "don't know how to read version from $PRIMARY_FILE" ;;
esac

[[ -n "$CURRENT" ]] || die "could not read current version from $PRIMARY_FILE"

# ---- semver helpers --------------------------------------------------------

is_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

is_semver "$CURRENT" || die "current version '$CURRENT' is not X.Y.Z (in $PRIMARY_FILE)"

bump() {
  local cur="$1" kind="$2"
  IFS=. read -r MA MI PA <<<"$cur"
  case "$kind" in
    major) printf '%s.0.0' "$((MA + 1))" ;;
    minor) printf '%s.%s.0' "$MA" "$((MI + 1))" ;;
    patch) printf '%s.%s.%s' "$MA" "$MI" "$((PA + 1))" ;;
    *) die "unknown bump kind: $kind" ;;
  esac
}

# Returns 0 if $1 > $2 (strictly greater).
semver_gt() {
  local a="$1" b="$2"
  [[ "$a" == "$b" ]] && return 1
  local aMa aMi aPa bMa bMi bPa
  IFS=. read -r aMa aMi aPa <<<"$a"
  IFS=. read -r bMa bMi bPa <<<"$b"
  (( aMa != bMa )) && { (( aMa > bMa )); return; }
  (( aMi != bMi )) && { (( aMi > bMi )); return; }
  (( aPa > bPa ))
}

case "$VERSION_ARG" in
  major|minor|patch) NEW="$(bump "$CURRENT" "$VERSION_ARG")" ;;
  *)                 NEW="$VERSION_ARG" ;;
esac

is_semver "$NEW"          || die "new version '$NEW' is not X.Y.Z"
semver_gt "$NEW" "$CURRENT" || die "new version '$NEW' must be greater than current '$CURRENT'"

TAG="${TAG_PREFIX}${NEW}"

# ---- preflight checks ------------------------------------------------------

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "not a git repository"
fi

if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    die "working tree is dirty (use --allow-dirty to override)"
  fi
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag '$TAG' already exists locally"
fi

if [[ "$PUSH" -eq 1 ]]; then
  REMOTE="$(git remote | head -n1)"
  if [[ -n "$REMOTE" ]]; then
    if git ls-remote --tags --exit-code "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
      die "tag '$TAG' already exists on remote '$REMOTE'"
    fi
  fi
fi

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || echo "DETACHED")"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  warn "you are on branch '$CURRENT_BRANCH' (not main)"
fi

log "component:  $COMPONENT"
log "current:    $CURRENT"
log "new:        $NEW"
log "tag:        $TAG"
log "branch:     $CURRENT_BRANCH"

# ---- file edits ------------------------------------------------------------

CHANGED_FILES=()

update_json() {
  local file="$1"
  [[ -f "$file" ]] || die "file missing: $file"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would update $file"
    return
  fi
  # Replace the first top-level "version": "X" entry.
  python3 - "$file" "$NEW" <<'PY'
import json, sys
path, new = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
data["version"] = new
with open(path, "r", encoding="utf-8") as f:
    raw = f.read()
trailing_nl = raw.endswith("\n")
indent = 2
# Detect 4-space indent if used.
for line in raw.splitlines():
    s = line.lstrip(" ")
    if s and line != s:
        indent = len(line) - len(s)
        break
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=indent, ensure_ascii=False)
    if trailing_nl:
        f.write("\n")
PY
  CHANGED_FILES+=("$file")
}

update_cargo_toml() {
  local file="$1"
  [[ -f "$file" ]] || die "file missing: $file"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would update $file"
    return
  fi
  python3 - "$file" "$NEW" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

# Replace version inside the [package] section only.
def replace_in_package(text, new):
    pattern = re.compile(r'(\[package\][^\[]*?\n)(version\s*=\s*")([^"]+)(")', re.DOTALL)
    m = pattern.search(text)
    if not m:
        raise SystemExit(f"no [package].version found in {path}")
    return text[:m.start(2)] + m.group(2) + new + m.group(4) + text[m.end(4):]

with open(path, "w", encoding="utf-8") as f:
    f.write(replace_in_package(text, new))
PY
  CHANGED_FILES+=("$file")
}

update_cargo_lock() {
  local file="$1" pkg="$2"
  [[ -f "$file" ]] || die "file missing: $file"
  [[ -n "$pkg" ]]  || die "no cargo package name set"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "would update $file (package: $pkg)"
    return
  fi
  python3 - "$file" "$pkg" "$NEW" <<'PY'
import re, sys
path, pkg, new = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()
pattern = re.compile(
    r'(\[\[package\]\]\nname\s*=\s*"' + re.escape(pkg) + r'"\nversion\s*=\s*")([^"]+)(")'
)
new_text, n = pattern.subn(r'\g<1>' + new + r'\g<3>', text, count=1)
if n == 0:
    raise SystemExit(f"package '{pkg}' not found in {path}")
with open(path, "w", encoding="utf-8") as f:
    f.write(new_text)
PY
  CHANGED_FILES+=("$file")
}

update_manifest_json() {
  # Same shape as update_json — separate hook in case extensions diverge.
  update_json "$1"
}

if ! command -v python3 >/dev/null 2>&1; then
  die "python3 is required for in-place file edits"
fi

log "applying version updates..."

for f in "${JSON_FILES[@]}";        do update_json "$f";        done
for f in "${CARGO_TOML_FILES[@]}";  do update_cargo_toml "$f";  done
for f in "${MANIFEST_FILES[@]}";    do update_manifest_json "$f"; done
for f in "${CARGO_LOCK_FILES[@]}";  do update_cargo_lock "$f" "$CARGO_PKG"; done

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run complete (no changes written, no commit, no tag)"
  exit 0
fi

# ---- confirm, commit, tag, push -------------------------------------------

log "files staged for commit:"
for f in "${CHANGED_FILES[@]}"; do printf '   %s\n' "$f"; done

confirm() {
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  local msg="$1" ans=""
  if [[ -t 0 ]]; then
    read -r -p "$msg [y/N] " ans || ans=""
  elif { exec 3</dev/tty; } 2>/dev/null; then
    read -r -u 3 -p "$msg [y/N] " ans || ans=""
    exec 3<&-
  else
    die "no terminal available for confirmation; pass --yes to skip the prompt"
  fi
  [[ "$ans" =~ ^[Yy]$ ]]
}

if ! confirm "Commit, tag as '$TAG', and $( ((PUSH)) && echo push || echo skip-push )?"; then
  warn "aborted by user — files have been modified but not committed"
  exit 1
fi

git add -- "${CHANGED_FILES[@]}"

COMMIT_MSG="release($COMPONENT): $NEW"
git commit -m "$COMMIT_MSG"
git tag -a "$TAG" -m "$COMPONENT $NEW"

log "committed and tagged $TAG"

if [[ "$PUSH" -eq 1 ]]; then
  REMOTE="$(git remote | head -n1)"
  [[ -n "$REMOTE" ]] || die "no git remote configured"
  log "pushing branch '$CURRENT_BRANCH' and tag '$TAG' to '$REMOTE'..."
  git push "$REMOTE" "$CURRENT_BRANCH"
  git push "$REMOTE" "$TAG"
  log "done — release $TAG pushed"
else
  log "done — tag created locally; push with: git push <remote> $CURRENT_BRANCH && git push <remote> $TAG"
fi
