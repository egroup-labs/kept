# kept-cli

Headless companion for the [Kept](../README.md) browser extension. Runs a tiny
local HTTP server that the extension hands conversations to, and writes them
as Obsidian-friendly markdown into a folder of your choice.

This is the *minimal* variant of Kept — no UI, no SQLite index, no knowledge
graph, no LLM features. If all you want is "sync my AI chats to my notes
vault and stay out of my way", this is it. The compiled binary is ~3.6 MB
and the daemon idles at a few MB of RSS.

## What it does

- Listens on `127.0.0.1:18241` (the same port the extension expects).
- Accepts `/api/ingest`, `/api/extension_ping`, `/api/ping`, `/api/assets/...`
  and `/connect` — exactly the surface the Kept extension needs.
- Writes one markdown file per conversation into `<vault>/<platform>/<date>_<slug>.md`,
  with YAML frontmatter and content-hash dedup so re-syncs don't churn.
- Saves any inline images into `<vault>/<platform>/assets/`.

## What it does *not* do

- No GUI.
- No full-text index, no knowledge graph, no embeddings.
- No agent / chat / summarization.
- No LLM API calls — your conversations only ever go to disk.

If you need any of those, run the desktop app (`app/`) instead.

## Install

You need a Rust toolchain (1.75+).

```bash
cd cli
cargo build --release
# binary lands at cli/target/release/kept
sudo install -m 0755 target/release/kept /usr/local/bin/kept   # optional
```

Or, in one shot from anywhere in the repo:

```bash
cargo install --path cli
```

## Usage

```bash
# 1. Start the daemon (foreground; ctrl-c to stop)
kept daemon

# 2. In another shell — point the extension at this daemon.
#    Opens http://127.0.0.1:18241/connect in your browser; the
#    Kept extension's content script picks up the auth token from
#    the page and stores it in chrome.storage.local.
kept connect

# 3. (Optional) point sync at your Obsidian vault instead of the default.
kept set-vault ~/Documents/Obsidian/MyVault/Kept
```

That's it. From now on, every time you open or scroll an AI chat in a tab the
extension watches, it'll POST the conversation to the daemon and you'll see a
new `.md` file appear in the vault.

### Other commands

```bash
kept status          # daemon liveness, vault path, conversation counts
kept get-vault       # print the active vault directory
kept list            # list synced conversations (newest first)
kept list --platform claude --limit 100
kept search "transformer"
kept token           # print the auth token (e.g. for scripting curl calls)
kept path            # print ~/.kept-cli (state directory)
```

## Layout

```
~/.kept-cli/
  config.toml        # vault_path, port
  token              # auth token (UUID); rotate by deleting + restarting
  vault/             # default sync target if you don't override with set-vault
    chatgpt/
    claude/
    gemini/
    grok/
    kimi/
```

The vault is intentionally a plain folder of markdown files — open it as an
Obsidian vault, point ripgrep at it, version it with git, whatever.

## Running it persistently

`kept daemon` is a foreground process. Wire it into your service manager.

### systemd (user unit)

`~/.config/systemd/user/kept.service`:

```ini
[Unit]
Description=Kept CLI — local sync daemon for AI conversations
After=network.target

[Service]
Type=simple
ExecStart=%h/.cargo/bin/kept daemon
Restart=on-failure
RestartSec=3
# A few MB is plenty; cap to catch runaway bugs.
MemoryMax=128M

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kept
journalctl --user -u kept -f          # tail logs
```

### launchd (macOS)

`~/Library/LaunchAgents/dev.kept.cli.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>dev.kept.cli</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/kept</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>/tmp/kept.log</string>
  <key>StandardErrorPath</key><string>/tmp/kept.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/dev.kept.cli.plist
```

### Windows

Easiest is the [NSSM](https://nssm.cc/) wrapper:

```
nssm install KeptCLI "C:\path\to\kept.exe" daemon
nssm start KeptCLI
```

## Coexisting with the desktop app

Both clients want port `18241` (the extension hard-codes it). You can't run
the CLI daemon and the desktop app at the same time. If you switch between
them, run `kept connect` (or click "Connect" in the desktop app) again so the
extension picks up the new auth token — they keep separate token stores.

The vault format is identical, so files written by one client are perfectly
readable by the other.

## Security notes

- The HTTP server binds to `127.0.0.1` and `::1` only. It is not reachable
  from other machines on your network.
- All write endpoints (`/api/ingest`, `/api/extension_ping`) require
  `Authorization: Bearer <token>`.
- The `X-Kept-Target-Dir` header (set by the extension's per-provider sync
  override) is rejected unless it is an absolute path with no `..` segments
  and points at an existing directory.
- Image filenames are validated against path traversal both lexically and
  via canonicalization before writing.
- The auth token lives in `~/.kept-cli/token`. Rotate by deleting the file
  and restarting the daemon (you'll need to `kept connect` again to push the
  new token to the extension).
