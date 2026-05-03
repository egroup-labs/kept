# Kept Desktop App

The desktop app is a Tauri 2 application with a React frontend and Rust backend.

It owns the local vault, the `localhost:18241` ingest server, SQLite search, CozoDB graph storage, optional model integrations, and the main Kept UI.

## Run

```bash
cd kept/app
npm ci
npm run tauri dev
```

## Linux

Ubuntu/Debian dependencies:

```bash
sudo apt update
sudo apt install -y \
  build-essential clang libclang-dev pkg-config \
  libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libpango1.0-dev libcairo2-dev libgdk-pixbuf-2.0-dev libglib2.0-dev
```

`build-essential` + `clang` + `libclang-dev` cover the bindgen-using crates
(notably `zstd-sys` via CozoDB); the rest are GTK / WebKitGTK / GLib for Tauri.

Run with the helper script:

```bash
npm run tauri:dev:linux
```

The helper avoids common WebKitGTK and Snap environment issues.

## Frontend-Only Mode

```bash
cd kept/app
npm ci
npm run dev
```

The frontend runs at `http://localhost:1420` and uses mock Tauri responses when it is outside the desktop shell.

## Useful Paths

- `src/` - React UI
- `src/lib/tauri-api.ts` - frontend command wrapper and mock responses
- `src-tauri/src/server.rs` - local Axum server used by the extension
- `src-tauri/src/vault.rs` - Markdown vault writes
- `src-tauri/src/db.rs` - SQLite search index
- `src-tauri/src/kg-gen/` - graph and topic generation
- `src-tauri/src/tools/` - agent tool implementations
