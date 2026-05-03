#Requires -Version 5.1
<#
.SYNOPSIS
Kept installer — Windows.

.DESCRIPTION
Interactive checkbox installer for Kept components: desktop app, CLI, and the
kept-vault MCP server. Each component tries a prebuilt binary from GitHub
Releases first and falls back to building from source.

.EXAMPLE
# Interactive
irm https://kept.work/install.ps1 | iex

# Non-interactive
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/egroup-labs/kept.work/main/scripts/install.ps1))) -Components app,cli,mcp

.PARAMETER Components
Comma-or-space separated list of components to install: app, cli, mcp.
When omitted, opens a TUI checkbox.

.PARAMETER FromSource
Skip binary download and build everything from source.

.PARAMETER Version
Specific app release tag (default: latest).

.PARAMETER Ref
Git ref for source builds (default: main).

.PARAMETER SrcDir
Where to clone for source builds (default: $HOME\.kept\src).

.PARAMETER NoExtension
Skip extracting the browser extension when installing the app.

.PARAMETER NoTui
Fail instead of opening the TUI when no components are passed.

.PARAMETER Yes
Skip confirmation prompt.

.PARAMETER Silent
Pass /S to the desktop app installer (silent install).
#>
[CmdletBinding()]
param(
  [string]$Repo = 'egroup-labs/kept.work',
  [string]$Version = 'latest',
  [string[]]$Components,
  [switch]$FromSource,
  [string]$Ref,
  [string]$SrcDir,
  [switch]$NoExtension,
  [switch]$NoTui,
  [switch]$Yes,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $SrcDir) { $SrcDir = if ($env:KEPT_SRC_DIR) { $env:KEPT_SRC_DIR } else { Join-Path $HOME '.kept\src' } }
if (-not $Ref)    { $Ref    = if ($env:KEPT_REF)     { $env:KEPT_REF }     else { 'main' } }
$VaultPath = if ($env:KEPT_VAULT_PATH) { $env:KEPT_VAULT_PATH } else { Join-Path $HOME '.kept\vault' }
$BinDir    = if ($env:KEPT_BIN_DIR)    { $env:KEPT_BIN_DIR }    else { Join-Path $env:LOCALAPPDATA 'Kept\bin' }

# ---- helpers ---------------------------------------------------------------

function Log([string]$msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "warning: $msg" -ForegroundColor Yellow }
# throw, not exit -- iex / scriptblock invocation would otherwise kill the host shell.
function Die([string]$msg)  { throw "install-kept: $msg" }
function Have([string]$cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Resolve npm-installed CLIs (npm, claude, openclaw) to their .cmd shim on
# Windows: bare .ps1 shims fail under restrictive ExecutionPolicy.
function ResolveExe([string]$name) {
  $cmd = Get-Command "$name.cmd" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# ---- release fetch ---------------------------------------------------------

$script:Release = $null

function Get-Release {
  if ($script:Release) { return $script:Release }
  $headers = @{ 'User-Agent' = 'kept-installer' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  if ($Version -eq 'latest') {
    $uri = "https://api.github.com/repos/$Repo/releases/latest"
  } else {
    $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    $uri = "https://api.github.com/repos/$Repo/releases/tags/$tag"
  }
  Log "Resolving release from $Repo ($Version)"
  try {
    $script:Release = Invoke-RestMethod -Headers $headers -Uri $uri
  } catch {
    Warn "could not resolve release: $($_.Exception.Message)"
    $script:Release = [pscustomobject]@{ assets = @() }
  }
  return $script:Release
}

function Find-Asset([string]$pattern) {
  $rel = Get-Release
  foreach ($a in $rel.assets) {
    if ($a.name -match $pattern -and $a.name -notmatch '\.sig$') { return $a }
  }
  return $null
}

function Download-Asset($asset, [string]$dir) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $path = Join-Path $dir $asset.name
  Log "Downloading $($asset.name)"
  $headers = @{ 'User-Agent' = 'kept-installer' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $asset.browser_download_url -OutFile $path
  return $path
}

# ---- source dir ------------------------------------------------------------

function Resolve-LocalCheckout {
  $scriptPath = $MyInvocation.MyCommand.Path
  if (-not $scriptPath) { return $null }
  $scriptDir = Split-Path -Parent $scriptPath
  foreach ($c in @($scriptDir, (Split-Path -Parent $scriptDir))) {
    if ($c -and
        (Test-Path (Join-Path $c 'app\src-tauri\Cargo.toml')) -and
        (Test-Path (Join-Path $c 'cli')) -and
        (Test-Path (Join-Path $c 'mcp'))) {
      return $c
    }
  }
  return $null
}

function Ensure-SourceDir {
  $found = Resolve-LocalCheckout
  if ($found) {
    $script:SrcDir = $found
    Log "Using existing Kept checkout at $script:SrcDir"
    return
  }
  if (Test-Path (Join-Path $SrcDir 'app\src-tauri\Cargo.toml')) {
    Log "Using existing Kept checkout at $SrcDir"
    return
  }
  if (-not (Have 'git')) { Die "git not found and no Kept checkout available; install git or pre-clone to $SrcDir" }
  if ((Test-Path $SrcDir) -and (Get-ChildItem -Force -LiteralPath $SrcDir | Select-Object -First 1)) {
    Die "$SrcDir exists and is not a Kept checkout. Delete it or pass -SrcDir <path>."
  }
  $parent = Split-Path -Parent $SrcDir
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  $cloneUrl = "https://github.com/$Repo.git"
  if ($env:GITHUB_TOKEN) {
    $cloneUrl = "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$Repo.git"
    Log "Cloning $Repo@$Ref into $SrcDir (authenticated)"
  } else {
    Log "Cloning $Repo@$Ref into $SrcDir"
  }
  & git clone --filter=blob:none --sparse --depth 1 --branch $Ref $cloneUrl $SrcDir
  if ($LASTEXITCODE -ne 0) { Die "git clone failed (ref '$Ref' missing? token expired? network?)" }
  & git -C $SrcDir sparse-checkout set app cli mcp extension scripts
  if ($LASTEXITCODE -ne 0) { Die 'git sparse-checkout failed (requires git 2.25+)' }
  & git -C $SrcDir remote set-url origin "https://github.com/$Repo.git" | Out-Null
  if (-not (Test-Path (Join-Path $SrcDir 'app\src-tauri\Cargo.toml'))) {
    Die "clone succeeded but checkout is incomplete"
  }
}

# ---- component: APP --------------------------------------------------------

function Run-AppInstaller([string]$installerPath) {
  Log "Running installer: $(Split-Path -Leaf $installerPath)"
  if ($Silent) {
    Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait
  } else {
    Start-Process -FilePath $installerPath -Wait
  }
}

function Install-AppBinary {
  $rel = Get-Release
  if (-not $rel.assets) { return $false }
  $asset = Find-Asset '(?i)\.exe$'
  if (-not $asset) {
    $asset = Find-Asset '(?i)\.msi$'
  }
  if (-not $asset) { return $false }
  $work = Join-Path ([IO.Path]::GetTempPath()) ("kept-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    $installer = Download-Asset $asset $work
    Run-AppInstaller $installer
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
  return $true
}

function Install-AppSource {
  if (-not (Have 'node'))  { Die 'node 20+ required to build the desktop app from source' }
  if (-not (Have 'npm'))   { Die 'npm required to build the desktop app from source' }
  if (-not (Have 'cargo')) { Die 'cargo (Rust toolchain) required — install via https://rustup.rs' }
  Ensure-SourceDir
  Log 'Building desktop app from source (this can take several minutes)...'
  $appDir = Join-Path $SrcDir 'app'
  Push-Location $appDir
  try {
    $npm = ResolveExe 'npm'
    & $npm install
    if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }
    & $npm run tauri -- build
    if ($LASTEXITCODE -ne 0) { Die 'tauri build failed' }
  } finally {
    Pop-Location
  }
  $bundleDir = Join-Path $appDir 'src-tauri\target\release\bundle'
  $installer = Get-ChildItem -Path (Join-Path $bundleDir 'nsis') -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $installer) {
    $installer = Get-ChildItem -Path (Join-Path $bundleDir 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $installer) { Die "no Windows installer produced under $bundleDir" }
  Run-AppInstaller $installer.FullName
}

function Install-App {
  if ($FromSource) { Install-AppSource; return }
  if (Install-AppBinary) { return }
  Warn 'no usable Windows installer in release; falling back to source build'
  Install-AppSource
}

# ---- component: CLI --------------------------------------------------------

function Install-CliBinary {
  $rel = Get-Release
  if (-not $rel.assets) { return $false }
  $arch = if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
  } else { 'x86' }
  $asset = Find-Asset "(?i)kept-cli-windows-$arch.*\.exe$"
  if (-not $asset) { return $false }
  if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Force -Path $BinDir | Out-Null }
  $headers = @{ 'User-Agent' = 'kept-installer' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
  $dest = Join-Path $BinDir 'kept-cli.exe'
  Log "Downloading $($asset.name)"
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $asset.browser_download_url -OutFile $dest
  Log "Installed kept-cli to $dest"
  Warn-Path $BinDir
  return $true
}

function Install-CliSource {
  if (-not (Have 'cargo')) { Die 'cargo (Rust toolchain) required — install via https://rustup.rs' }
  Ensure-SourceDir
  Log 'Building kept-cli from source...'
  $cliDir = Join-Path $SrcDir 'cli'
  Push-Location $cliDir
  try {
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { Die "cargo build failed in $cliDir" }
  } finally {
    Pop-Location
  }
  $src = Join-Path $cliDir 'target\release\kept.exe'
  if (-not (Test-Path $src)) { Die "build output missing: $src" }
  if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Force -Path $BinDir | Out-Null }
  $dest = Join-Path $BinDir 'kept-cli.exe'
  Copy-Item -Path $src -Destination $dest -Force
  Log "Installed kept-cli to $dest"
  Warn-Path $BinDir
}

function Install-Cli {
  if ($FromSource) { Install-CliSource; return }
  if (Install-CliBinary) { return }
  Warn 'no kept-cli binary in release; falling back to source build'
  Install-CliSource
}

function Warn-Path([string]$d) {
  $segments = $env:Path -split ';' | Where-Object { $_ -and (Test-Path $_) -and ($_ -ieq $d) }
  if (-not $segments) {
    Warn "$d is not on PATH — add it to your User PATH or invoke kept-cli.exe by full path"
  }
}

# ---- component: MCP --------------------------------------------------------

function Install-Mcp {
  if (-not (Have 'node')) { Die 'node 20+ required for the MCP server' }
  if (-not (Have 'npm'))  { Die 'npm required for the MCP server' }
  $nodeVer = (& node -v).TrimStart('v')
  $nodeMajor = [int]($nodeVer.Split('.')[0])
  if ($nodeMajor -lt 20) { Die "Node 20+ required (found v$nodeVer)" }

  Ensure-SourceDir
  $mcpDir = Join-Path $SrcDir 'mcp'
  $npm = ResolveExe 'npm'

  Push-Location $mcpDir
  try {
    Log 'Installing MCP dependencies'
    & $npm install --silent
    if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }
    Log 'Building MCP server'
    & $npm run build --silent
    if ($LASTEXITCODE -ne 0) { Die 'npm run build failed' }
  } finally {
    Pop-Location
  }
  $entry = Join-Path $mcpDir 'dist\index.js'
  if (-not (Test-Path $entry)) { Die "build output missing: $entry" }
  if (-not (Test-Path $VaultPath)) { New-Item -ItemType Directory -Force -Path $VaultPath | Out-Null }

  $registered = $false
  $claudeExe = ResolveExe 'claude'
  if ($claudeExe) {
    Log 'Registering with Claude Code (user scope)'
    try { & $claudeExe mcp remove -s local kept-vault 2>&1 | Out-Null } catch { }
    try { & $claudeExe mcp remove -s user  kept-vault 2>&1 | Out-Null } catch { }
    $global:LASTEXITCODE = 0
    & $claudeExe mcp add -s user kept-vault -e "KEPT_VAULT_PATH=$VaultPath" -- node $entry
    if ($LASTEXITCODE -ne 0) { Die 'claude mcp add failed' }
    $registered = $true
  }
  $openclawExe = ResolveExe 'openclaw'
  if ($openclawExe) {
    Log 'Registering with OpenClaw'
    $entryJson = $entry     -replace '\\','\\'
    $vaultJson = $VaultPath -replace '\\','\\'
    $cfg = '{"command":"node","args":["' + $entryJson + '"],"env":{"KEPT_VAULT_PATH":"' + $vaultJson + '"}}'
    # PS 5.1 strips quotes when forwarding to native commands; escape each " as \".
    $cfgArg = $cfg -replace '"', '\"'
    & $openclawExe mcp set kept-vault $cfgArg
    if ($LASTEXITCODE -ne 0) { Die 'openclaw mcp set failed' }
    $registered = $true
  }
  if (-not $registered) {
    Warn "neither 'claude' nor 'openclaw' found on PATH"
    Warn "MCP server built at: $entry — register manually when an MCP client is installed"
  }
}

# ---- component: EXTENSION (auxiliary) --------------------------------------

$script:ExtensionDirResult = $null

function Install-Extension {
  if ($NoExtension) { return }
  $extDir = if ($env:KEPT_EXTENSION_DIR) { $env:KEPT_EXTENSION_DIR } else { Join-Path $env:LOCALAPPDATA 'Kept\extension' }

  $asset = Find-Asset '(?i)^kept-extension.*\.zip$'
  if ($asset) {
    $work = Join-Path ([IO.Path]::GetTempPath()) ("kept-ext-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
      $zip = Download-Asset $asset $work
      if (Test-Path $extDir) { Remove-Item -Recurse -Force $extDir }
      New-Item -ItemType Directory -Force -Path $extDir | Out-Null
      Expand-Archive -Path $zip -DestinationPath $extDir -Force
      $script:ExtensionDirResult = $extDir
      Log "Extension extracted to $extDir"
      return
    } finally {
      Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
  }

  # Source fallback
  try { Ensure-SourceDir } catch { Warn $_; return }
  $extSrc = Join-Path $SrcDir 'extension'
  if (Test-Path (Join-Path $extSrc 'manifest.json')) {
    if (Test-Path $extDir) { Remove-Item -Recurse -Force $extDir }
    New-Item -ItemType Directory -Force -Path $extDir | Out-Null
    Copy-Item -Path (Join-Path $extSrc '*') -Destination $extDir -Recurse -Force
    $script:ExtensionDirResult = $extDir
    Log "Extension copied from source to $extDir"
    return
  }
  Warn 'no extension zip in release and no source checkout — skipping extension'
}

# ---- TUI -------------------------------------------------------------------

function Invoke-TuiSelect {
  $keys   = @('app', 'cli', 'mcp')
  $labels = @(
    'Desktop app  - full UI, search, knowledge graph',
    'CLI          - minimal headless companion (~3.6 MB)',
    'MCP server   - register kept-vault with Claude Code / OpenClaw'
  )
  $sel    = @($true, $false, $false)
  $cursor = 0
  $n      = $keys.Length

  $prevCursorVisible = [Console]::CursorVisible
  [Console]::CursorVisible = $false
  try {
    Write-Host ''
    Write-Host 'Kept installer' -ForegroundColor White
    Write-Host 'Select components:  ↑/↓ move   space toggle   enter install   q quit' -ForegroundColor DarkGray
    Write-Host ''

    $itemTop = [Console]::CursorTop
    while ($true) {
      [Console]::SetCursorPosition(0, $itemTop)
      for ($i = 0; $i -lt $n; $i++) {
        $mark = if ($sel[$i]) { 'x' } else { ' ' }
        $line = if ($i -eq $cursor) { "> [$mark] $($labels[$i])" } else { "  [$mark] $($labels[$i])" }
        # Pad to clear any leftover characters from a previous longer line.
        $pad = [Math]::Max(0, [Console]::WindowWidth - 1 - $line.Length)
        if ($i -eq $cursor) {
          Write-Host ($line + (' ' * $pad)) -ForegroundColor Cyan
        } else {
          Write-Host ($line + (' ' * $pad))
        }
      }
      $key = [Console]::ReadKey($true)
      switch ($key.Key) {
        'UpArrow'   { if ($cursor -gt 0)     { $cursor-- } }
        'DownArrow' { if ($cursor -lt $n-1) { $cursor++ } }
        'K'         { if ($cursor -gt 0)     { $cursor-- } }
        'J'         { if ($cursor -lt $n-1) { $cursor++ } }
        'Spacebar'  { $sel[$cursor] = -not $sel[$cursor] }
        'A'         { for ($i=0; $i -lt $n; $i++) { $sel[$i] = $true } }
        'N'         { for ($i=0; $i -lt $n; $i++) { $sel[$i] = $false } }
        'Enter'     {
          $picked = @()
          for ($i = 0; $i -lt $n; $i++) { if ($sel[$i]) { $picked += $keys[$i] } }
          if ($picked.Count -eq 0) { Die 'no components selected' }
          return $picked
        }
        'Q'         { Write-Host ''; Die 'aborted' }
        'Escape'    { Write-Host ''; Die 'aborted' }
      }
    }
  } finally {
    [Console]::CursorVisible = $prevCursorVisible
    Write-Host ''
  }
}

# ---- main ------------------------------------------------------------------

# Normalise -Components into a flat list of strings.
if ($Components) {
  $flat = @()
  foreach ($c in $Components) { $flat += ($c -split '[,\s]+') }
  $Components = $flat | Where-Object { $_ }
}

if (-not $Components -or $Components.Count -eq 0) {
  if ($NoTui) { Die 'no components specified; pass -Components app,cli,mcp' }
  $Components = Invoke-TuiSelect
}

foreach ($c in $Components) {
  if ($c -notin @('app','cli','mcp')) { Die "unknown component: '$c' (expected: app, cli, mcp)" }
}

Log "Components: $($Components -join ', ')"
if ($FromSource) { Log 'Mode: source build (-FromSource)' }

if (-not $Yes -and [Environment]::UserInteractive -and $Host.UI.RawUI) {
  $reply = Read-Host 'Proceed with install? [Y/n]'
  if ($reply -match '^(n|no)$') { Die 'aborted by user' }
}

foreach ($c in $Components) {
  switch ($c) {
    'app' { Install-App }
    'cli' { Install-Cli }
    'mcp' { Install-Mcp }
  }
}

if ($Components -contains 'app' -and -not $NoExtension) { Install-Extension }

Write-Host ''
Write-Host 'Kept installation complete.' -ForegroundColor Green
if ($script:ExtensionDirResult) {
  Write-Host ''
  Write-Host 'To enable browser capture:'
  Write-Host '  1. Open chrome://extensions in a Chromium-based browser'
  Write-Host '  2. Enable Developer Mode'
  Write-Host "  3. Load unpacked: $script:ExtensionDirResult"
  Write-Host '  4. Launch Kept and open http://localhost:18241/connect in that browser'
}
