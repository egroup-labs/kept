# Kept

Kept is a desktop app that captures, archives, and searches AI conversations locally. Chrome extension intercepts API responses from ChatGPT, Claude, and Gemini; Tauri desktop app stores them as Obsidian-compatible markdown with full-text search, knowledge graph, and local RAG.

## Tech Stack

- **Frontend:** Vanilla TypeScript (no framework), Vite, CSS custom properties
- **Backend:** Rust, Tauri 2, SQLite (FTS), CozoDB (knowledge graph), Axum (HTTP server)
- **Rendering:** Pixi.js (graph), D3, marked, KaTeX, highlight.js, DOMPurify

## Project Structure

```
app/src/              # TypeScript frontend
  main.ts                  # App init, view routing, DOMContentLoaded entry
  styles.css               # Single CSS file with design tokens
  components/              # View components (factory functions)
  lib/                     # Types, API wrappers, mocks, utilities

app/src-tauri/src/    # Rust backend
  lib.rs                   # Tauri app setup, command registration
  commands.rs              # All Tauri commands (cmd_*)
  config.rs                # ~/.kept/ directory paths
  db.rs                    # SQLite layer
  vault.rs                 # File operations
  chat.rs                  # LLM API calls + agent tool execution
  claude.rs                # Claude Code manager filesystem ops
  models.rs                # Serde data structures
  kg-gen/                  # Knowledge graph extraction + storage
```

Data lives in `~/.kept/` (vault/, index.db, kg.db/, config.toml, token).

## Patterns

### Frontend Components

Factory functions that take a container and build DOM imperatively:

```typescript
export function createFooView(container: HTMLElement) {
  const wrapper = document.createElement('div');
  wrapper.className = 'foo-view';
  container.appendChild(wrapper);
  // Build DOM, attach listeners, call API functions
  return { /* public methods */ };
}
```

Views are toggled via `.active` class. The `View` type union in `types.ts` lists all views. Sidebar nav items map to views in `sidebar.ts`.

### Tauri Commands

```rust
#[tauri::command]
pub fn cmd_action_subject(arg: String) -> Result<ReturnType, String> { ... }
```

Register in `lib.rs` `tauri::generate_handler![]`. All errors are `String`. Sanitize API errors (strip auth headers, truncate). Path validation: canonicalize + starts_with check.

### API Layer (tauri-api.ts)

`invoke<T>()` detects Tauri vs browser. In browser: `mockInvoke()` returns hardcoded test data for full frontend dev without backend. Every Tauri command needs a mock case.

```typescript
export async function fooBar(arg: string): Promise<FooData> {
  return invoke('cmd_foo_bar', { arg });
}
```

### CSS

Single file. Design tokens in `:root`:
- Surfaces: `--bg`, `--bg-surface`, `--bg-surface-2`, `--bg-sidebar`, `--bg-hover`
- Text: `--text-1` (primary) through `--text-4` (muted)
- Accent: `--accent` (#D97757, Claude orange)
- Border: `--border`, `--border-subtle`

Views need `padding-top: 60px` to clear the floating search bar.

## Conventions

- **Commits:** Conventional commits — `feat(scope):`, `fix(scope):`
- **Naming:** camelCase functions, PascalCase types, kebab-case CSS, `cmd_snake_case` Tauri commands
- **TypeScript:** Strict mode. Use `interface` for objects, `type` for unions. Explicit types on parameters/returns.
- **Security:** DOMPurify all rendered HTML. Validate all file paths against base directory. Never expose API keys in errors.
- **No frameworks:** Build DOM with `createElement`. No React, no templating.

## Running

```bash
cd app
npm run dev          # Frontend only (localhost:1420, mock data)
npm run tauri dev    # Full app with Rust backend
```

## Gotchas

- `isTauri` detection: frontend works in browser with mocks, no Tauri needed for UI work
- Search bar is `position: absolute` — all views need top padding to avoid overlap
- Vite build may fail on `kg-renderer.ts` worker format in production (pre-existing)
- MSVC Build Tools required for Rust compilation on Windows (`link.exe`)
- `config.toml` at `~/.kept/config.toml` stores API keys and app settings
