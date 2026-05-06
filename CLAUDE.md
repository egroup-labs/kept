# CLAUDE.md

Apply caveman:ultra mode.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Kept

Local desktop archive for AI conversations. Chromium extension intercepts provider API responses (ChatGPT, Claude, Gemini, Grok, Kimi); Tauri 2 desktop app stores them as Obsidian-compatible markdown under `~/.kept/vault/` with SQLite FTS5 search, CozoDB knowledge graph, agent chat over the vault, and an MCP server.

## Architecture

Three workspaces, each independent:

```
app/                Tauri 2 desktop app
  src/                  React 19 + Vite + Tailwind 4 frontend
    main.tsx                Root, mounts <App />
    App.tsx                 View routing, top-level layout
    components/             React .tsx components
    lib/tauri-api.ts        invoke() wrapper — falls through to mockInvoke in browser
    lib/mock-data.ts        Hardcoded fixtures for browser dev
    lib/types.ts            Shared TS types (mirrors Rust models)
    index.css               Single entry: imports tailwind + fonts + @theme tokens
  src-tauri/src/        Rust backend
    lib.rs                  App setup, plugin registration, generate_handler! list
    commands.rs             All cmd_* Tauri commands
    server.rs               Axum HTTP server on localhost:18241 (extension ingress)
    db.rs                   SQLite + FTS5
    vault.rs                Markdown read/write under ~/.kept/vault/
    chat.rs                 LLM API calls + agent loop
    claude.rs               Filesystem ops over user's Claude Code projects
    config.rs               ~/.kept/ paths, token, config.toml
    kg-gen/                 CozoDB knowledge graph: triplets, topics, keywords
    tools/                  Agent tools: code_exec, conversation, filesystem,
                            graph, image_read, knowledge, pdf_read, web
    models.rs               Serde structs

extension/            Chromium MV3 extension (vanilla JS)
  background.js           Service worker, alarms, sync orchestration
  platforms/              One adapter per provider (chatgpt|claude|gemini|grok|kimi)
  command-palette.js      Content script, all-URLs
  manifest.json           MV3, host perms per provider + localhost:18241

mcp/                  kept-vault-server (TypeScript MCP server)
  src/index.ts            Server entry
  src/tools/              list, read, write, manage, search, explore
  src/vault.ts            Path resolution (KEPT_VAULT_PATH env override)
  tests/                  Vitest

scripts/              Shell + PowerShell installers (app + MCP)
```

**Data flow:** browser extension → POST `http://localhost:18241/...` (Bearer token from `~/.kept/token`) → `server.rs` Axum routes → `vault.rs` writes markdown + `db.rs` indexes FTS → KG worker (`kg-gen/`) extracts triplets/topics into CozoDB. Frontend reads via Tauri `invoke()`.

**State stored in `~/.kept/`:** `vault/{provider}/`, `index.db` (SQLite), `kg.db/` (CozoDB), `config.toml`, `token`, `tools.md`, `artifacts/`, `runtime/{python,node}/`.

## Commands

App (`cd app`):
- Install: `npm ci`
- Frontend-only dev (mocks, no Rust): `npm run dev` → `http://localhost:1420`
- Full app: `npm run tauri dev`
- Linux full app: `npm run tauri:dev:linux`
- Build frontend bundle: `npm run build` (`tsc -b && vite build`)
- Production app bundle: `npm run tauri build`

MCP (`cd mcp`):
- Build: `npm run build`
- Test: `npm test` (vitest), single file: `npx vitest run tests/tools/search.test.ts`
- Lint: `npm run lint` (biome), autofix: `npm run lint:fix`
- Typecheck + lint: `npm run check`

No test framework in `app/`. No lint config in `app/` beyond TS strict.

## Conventions

- **Tauri commands:** `cmd_snake_case` in `commands.rs` (or `chat.rs`), registered in `lib.rs` `tauri::generate_handler![]`. Errors are `String` — sanitize (strip auth, truncate). Path inputs: canonicalize + `starts_with(base)` check.
- **API layer:** Every Tauri command needs a matching case in `mockInvoke()` in `tauri-api.ts` so browser-only dev works.
- **Frontend:** React 19 functional components with hooks. TypeScript strict. `interface` for objects, `type` for unions.
- **Styling:** Tailwind 4 via `@tailwindcss/vite`. Theme tokens defined in `@theme` block in `index.css` (`--color-base`, `--color-surface`, `--color-fg`, `--color-accent`, etc.). Use Tailwind utilities; don't add ad-hoc CSS files.
- **Markdown rendering:** `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `rehype-highlight`. DOMPurify any non-react-markdown HTML path.
- **Commits:** Conventional — `feat(scope):`, `fix(scope):`. Useful scopes: `app`, `extension`, `mcp`.
- **Naming:** camelCase functions/vars, PascalCase types/components, kebab-case file names for non-components, `cmd_snake_case` Tauri commands.

## Key files

- `app/src-tauri/src/lib.rs` — full command registry; add new commands to `generate_handler!` here
- `app/src-tauri/src/commands.rs` — most `cmd_*` implementations
- `app/src-tauri/src/server.rs` — extension HTTP ingress (auth, routes)
- `app/src/lib/tauri-api.ts` — every TS→Rust call goes here; mock branch required
- `app/src/lib/mock-data.ts` — fixtures for browser dev
- `app/src/index.css` — Tailwind `@theme` tokens (single source for design tokens)
- `app/src-tauri/src/config.rs` — `~/.kept/` path map, default `tools.md` content
- `extension/platforms/{provider}.js` — provider sync adapters; private APIs change frequently
- `mcp/src/vault.ts` — vault path resolution honoring `KEPT_VAULT_PATH`

## Gotchas

- **Frontend-only dev (`npm run dev`) requires mock cases.** A new Tauri command that isn't mocked will throw in browser mode.
- **MSVC Build Tools required on Windows** for Rust crates (`zstd-sys`, `cozorocks`). Linux needs the apt list in README.md.
- **HTTP server is bearer-auth.** Extension reads token from `~/.kept/token` via the `/connect` page. Don't expose endpoints without auth checks in `server.rs`.
- **Provider APIs are unofficial.** Adapters in `extension/platforms/` break when providers change response shapes — expect breakage, not bugs.
- **Path validation:** any Rust command taking a user path must canonicalize and verify it sits under an allowed root (`vault_dir`, `kb` paths, `fs_allowed_paths`). See existing `cmd_validate_path`.
- **Reindex on startup:** `lib.rs` spawns a background thread that walks the vault and rebuilds the SQLite index by content hash. Renames of vault files done outside the app are picked up on next launch.
- **Two background workers** in `lib.rs`: idle conversation summarizer (60s tick) and digest batch promoter (interval-gated). Don't add another loop without the same pattern.
- **WebKitGTK drag blocker:** dragstart is intercepted globally; opt in with `data-drag-handle` attribute on the element.

## Don't

- Don't introduce React state libraries (Redux/Zustand/etc.) — current code uses local state + props.
- Don't add a second CSS file or CSS-in-JS — keep design tokens in `index.css` `@theme` block.
- Don't return raw `reqwest`/`anyhow` errors from commands — sanitize to `String`.
- Don't read `~/.kept/` paths directly in TS — go through Tauri commands.
- Don't bypass `mockInvoke` for new commands; it's the contract that keeps `npm run dev` usable.
