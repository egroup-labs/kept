# kept-vault-server

`kept-vault-server` is the MCP server for a Kept vault. It lets MCP clients read, write, search, rename, and delete Markdown files in `~/.kept/vault`.

## Install

Requires Node.js 20+ and git 2.25+.

Inside Claude Code:

```text
/plugin marketplace add egroup-labs/kept.work
/plugin install kept-vault@kept-plugins
```

Linux/macOS one-liner:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/egroup-labs/kept.work/main/scripts/install-kept-mcp.sh)
```

PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/egroup-labs/kept.work/main/scripts/install-kept-mcp.ps1)))
```

The installer uses git sparse-checkout to fetch only `mcp/`, builds the server locally, and registers it with the supported CLI it detects.

Set `KEPT_VAULT_PATH` to use a vault outside the default `~/.kept/vault`.

## Tools

| Tool | Description |
| --- | --- |
| `list_vault` | Browse the vault root |
| `list_directory` | Browse a specific folder |
| `read_file` | Read a conversation or note |
| `write_file` | Create a new file; fails if it already exists |
| `update_file` | Overwrite an existing file; fails if missing |
| `delete_file` | Remove a file |
| `move_file` | Move or rename a file |
| `grep_vault` | Regex search across Markdown files |

## Development

```bash
cd mcp
npm ci
npm run build
npm test
```

Other useful commands:

```bash
npm run dev
npm run lint
npm run check
```

## Installer Flags

| Bash | PowerShell | Purpose |
| --- | --- | --- |
| `--claudecode` | `-ClaudeCode` | Register with Claude Code |
| `--openclaw` | `-OpenClaw` | Register with OpenClaw |
| `--ref REF` | `-Ref <ref>` | Branch, tag, or SHA; default `main` |
| `--dir PATH` | `-Dir <path>` | Source directory; default `~/.kept/mcp-src` |
| `--no-build` | `-NoBuild` | Skip `npm install` and build |
| `-h`, `--help` | `-Help` | Show help |

Environment variables:

- `KEPT_VAULT_PATH` - vault location
- `KEPT_REF` - branch, tag, or SHA for install scripts
- `GITHUB_TOKEN` - optional token for private repository access

## License

MIT
