#Requires -Version 5.1
<#
.SYNOPSIS
Kept MCP server installer -- Windows PowerShell.

.DESCRIPTION
Installs the kept-vault MCP server into Claude Code and/or OpenClaw.
With no target flags, auto-detects which CLIs are installed.

.EXAMPLE
./scripts/install-kept-mcp.ps1
./scripts/install-kept-mcp.ps1 -ClaudeCode
./scripts/install-kept-mcp.ps1 -OpenClaw
./scripts/install-kept-mcp.ps1 -ClaudeCode -OpenClaw
iex "& { $(irm https://raw.githubusercontent.com/egroup-labs/kept.work/main/scripts/install-kept-mcp.ps1) }"
& ([scriptblock]::Create((irm .../scripts/install-kept-mcp.ps1))) -ClaudeCode
#>
[CmdletBinding()]
param(
  [switch]$ClaudeCode,
  [switch]$OpenClaw,
  [string]$Dir,
  [string]$Ref,
  [switch]$NoBuild,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$RepoUrl    = 'https://github.com/egroup-labs/kept.git'
$DefaultDir = Join-Path $HOME '.kept\mcp-src'
$VaultPath  = if ($env:KEPT_VAULT_PATH) { $env:KEPT_VAULT_PATH } else { Join-Path $HOME '.kept\vault' }
if (-not $Ref) { $Ref = if ($env:KEPT_REF) { $env:KEPT_REF } else { 'main' } }

if ($Help) {
  @"
Usage: install-kept-mcp.ps1 [-ClaudeCode] [-OpenClaw] [-Dir <path>] [-NoBuild]

Installs the kept-vault MCP server into Claude Code and/or OpenClaw.
With no target flags: auto-detects installed CLIs.

Flags:
  -ClaudeCode   Register with Claude Code (disables auto-detect)
  -OpenClaw     Register with OpenClaw   (disables auto-detect)
  -Dir <path>   Repo source directory (default: $DefaultDir; cloned if missing)
  -Ref <ref>    Branch/tag/sha to clone (default: main; overrides KEPT_REF)
  -NoBuild      Skip npm install + build

Env:
  KEPT_VAULT_PATH  Vault location passed to the MCP server (default: ~\.kept\vault)
  KEPT_REF         Branch/tag to clone (default: main)
  GITHUB_TOKEN     Used to clone the repo while it is private
"@
  return
}

function Have([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Log([string]$msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
# Use throw, not exit: when this script is run via [scriptblock]::Create(),
# `exit` terminates the *host* PowerShell session instead of just the script.
function Die([string]$msg)  { throw "install-kept-mcp: $msg" }

# Resolve npm-installed CLIs (npm, claude, openclaw) to their .cmd shim on
# Windows. Bare `npm` etc. resolve to .ps1 scripts that fail under a restricted
# ExecutionPolicy; the .cmd variant bypasses the PS script loader entirely.
function ResolveExe([string]$name) {
  $cmd = Get-Command "$name.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$auto = -not ($ClaudeCode -or $OpenClaw)
if ($auto) {
  if (Have 'claude')   { $ClaudeCode = $true }
  if (Have 'openclaw') { $OpenClaw   = $true }
  if (-not ($ClaudeCode -or $OpenClaw)) {
    Die "neither 'claude' nor 'openclaw' found on PATH. Install one, or pass -ClaudeCode / -OpenClaw."
  }
}

if (-not (Have 'node')) { Die 'node not found. Install Node.js 20+: https://nodejs.org' }
if (-not (Have 'npm'))  { Die 'npm not found.' }

$nodeVer = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) { Die "Node 20+ required (found v$nodeVer)" }

if (-not $Dir) {
  $scriptPath = $MyInvocation.MyCommand.Path
  if ($scriptPath) {
    $scriptDir = Split-Path -Parent $scriptPath
    foreach ($c in @($scriptDir, (Split-Path -Parent $scriptDir))) {
      if ($c -and (Test-Path (Join-Path $c 'mcp\package.json'))) {
        $Dir = $c
        break
      }
    }
  }
  if (-not $Dir) { $Dir = $DefaultDir }
}

$mcpDir = Join-Path $Dir 'mcp'

if (-not (Test-Path (Join-Path $mcpDir 'package.json'))) {
  if (-not (Have 'git')) { Die "git not found and repo not present at $Dir" }
  if ((Test-Path $Dir) -and (Get-ChildItem -Force -LiteralPath $Dir | Select-Object -First 1)) {
    Die "$Dir exists and is not a Kept checkout. Delete it or pass -Dir <path>."
  }
  $parent = Split-Path -Parent $Dir
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $cloneUrl = $RepoUrl
  if ($env:GITHUB_TOKEN) {
    $cloneUrl = "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/egroup-labs/kept.git"
    Log "Cloning egroup-labs/kept.work@$Ref into $Dir (authenticated)"
  } else {
    Log "Cloning $RepoUrl@$Ref into $Dir"
  }
  # Sparse checkout: only fetch mcp subtree, not full repo.
  & git clone --filter=blob:none --sparse --depth 1 --branch $Ref $cloneUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die "git clone failed (ref '$Ref' missing? token expired? network?)." }
  & git -C $Dir sparse-checkout set mcp
  if ($LASTEXITCODE -ne 0) { Die 'git sparse-checkout failed. Requires git 2.25+.' }
  # Scrub token from stored remote so it doesn't linger on disk.
  & git -C $Dir remote set-url origin $RepoUrl | Out-Null
  if (-not (Test-Path (Join-Path $mcpDir 'package.json'))) {
    Die "clone succeeded but $mcpDir\package.json is missing -- wrong ref?"
  }
} else {
  Log "Using existing repo at $Dir"
}

if (-not $NoBuild) {
  $npm = ResolveExe 'npm'
  if (-not $npm) { Die 'npm not found.' }

  Push-Location $mcpDir
  try {
    Log 'Installing dependencies'
    & $npm install --silent
    if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }
    Log 'Building'
    & $npm run build --silent
    if ($LASTEXITCODE -ne 0) { Die 'npm run build failed' }
  } finally {
    Pop-Location
  }
}

$entry = Join-Path $mcpDir 'dist\index.js'
if (-not (Test-Path $entry)) { Die "build output missing: $entry. Re-run without -NoBuild." }

# Ensure the vault directory exists so the MCP server starts cleanly on first run.
if (-not (Test-Path $VaultPath)) { New-Item -ItemType Directory -Force -Path $VaultPath | Out-Null }

if ($ClaudeCode) {
  # Use $claudeExe, not $claude -- PS vars are case-insensitive; a bare $claude
  # would collide with any future [switch]$Claude param. Same reason openclaw
  # block uses $openclawExe.
  $claudeExe = ResolveExe 'claude'
  if (-not $claudeExe) { Die 'claude CLI not on PATH' }
  Log 'Registering with Claude Code'
  # Best-effort cleanup -- on first install the server doesn't exist yet, and
  # claude CLI exits non-zero + writes to stderr. Under EAP=Stop that becomes
  # a terminating NativeCommandError, so swallow explicitly.
  # -s user: register at user scope so the MCP is available across all
  # projects, not just the current working directory (claude's default is local).
  # Also remove any stray local-scope entry so it doesn't shadow user scope.
  try { & $claudeExe mcp remove -s local kept-vault 2>&1 | Out-Null } catch { }
  try { & $claudeExe mcp remove -s user  kept-vault 2>&1 | Out-Null } catch { }
  $global:LASTEXITCODE = 0
  & $claudeExe mcp add -s user kept-vault -e "KEPT_VAULT_PATH=$VaultPath" -- node $entry
  if ($LASTEXITCODE -ne 0) { Die 'claude mcp add failed' }
}

if ($OpenClaw) {
  # $openclaw would alias to $OpenClaw (case-insensitive), which is a [switch]
  # param -- string assignment hits ConvertToFinalInvalidCastException.
  $openclawExe = ResolveExe 'openclaw'
  if (-not $openclawExe) { Die 'openclaw CLI not on PATH' }
  Log 'Registering with OpenClaw'
  $entryJson = ($entry  -replace '\\','\\')
  $vaultJson = ($VaultPath -replace '\\','\\')
  $config = '{"command":"node","args":["' + $entryJson + '"],"env":{"KEPT_VAULT_PATH":"' + $vaultJson + '"}}'
  # PS 5.1 strips double quotes when passing args to native commands. Escape
  # each " as \" so CommandLineToArgvW on the receiving side reconstructs the
  # JSON verbatim. PS 7+ with PSNativeCommandArgumentPassing='Standard' does
  # this automatically, but we target both.
  $configArg = $config -replace '"', '\"'
  & $openclawExe mcp set kept-vault $configArg
  if ($LASTEXITCODE -ne 0) { Die 'openclaw mcp set failed' }
}

Log "Done. Vault path: $VaultPath"
