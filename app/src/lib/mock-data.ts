import type { VaultNode, SearchResult, AppConfig } from './types';

export const MOCK_VAULT_TREE: VaultNode[] = [
  {
    name: 'chatgpt',
    path: null,
    is_dir: true,
    children: [
      { name: '2025-06-15_building-a-rust-web-server.md', path: '/mock/chatgpt/2025-06-15_building-a-rust-web-server.md', is_dir: false, children: [] },
      { name: '2025-06-14_react-hooks-deep-dive.md', path: '/mock/chatgpt/2025-06-14_react-hooks-deep-dive.md', is_dir: false, children: [] },
      { name: '2025-06-12_typescript-generics-explained.md', path: '/mock/chatgpt/2025-06-12_typescript-generics-explained.md', is_dir: false, children: [] },
      { name: '2025-06-10_debugging-memory-leaks.md', path: '/mock/chatgpt/2025-06-10_debugging-memory-leaks.md', is_dir: false, children: [] },
      { name: '2025-06-08_sql-query-optimization.md', path: '/mock/chatgpt/2025-06-08_sql-query-optimization.md', is_dir: false, children: [] },
    ],
  },
  {
    name: 'claude',
    path: null,
    is_dir: true,
    children: [
      { name: '2025-06-15_tauri-desktop-app-architecture.md', path: '/mock/claude/2025-06-15_tauri-desktop-app-architecture.md', is_dir: false, children: [] },
      { name: '2025-06-13_sqlite-fts5-search.md', path: '/mock/claude/2025-06-13_sqlite-fts5-search.md', is_dir: false, children: [] },
      { name: '2025-06-11_chrome-extension-manifest-v3.md', path: '/mock/claude/2025-06-11_chrome-extension-manifest-v3.md', is_dir: false, children: [] },
    ],
  },
];

export const MOCK_CONVERSATION = `---
id: conv-abc123
platform: chatgpt
title: Building a Rust Web Server
synced: 2025-06-15T10:30:00Z
messages: 6
model: gpt-4o
---

# Building a Rust Web Server

### User

How do I set up a basic web server in Rust using axum?

### Assistant

Here's how to create a basic axum web server:

\`\`\`rust
use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(|| async { "Hello, World!" }))
        .route("/health", get(health_check));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health_check() -> &'static str {
    "OK"
}
\`\`\`

Key points:
- **axum** is built on top of \`hyper\` and \`tower\`
- Routes are defined using the \`Router\` type
- Handler functions are async and return types that implement \`IntoResponse\`
- Use \`tokio\` as the async runtime

### User

How do I add JSON request/response handling?

### Assistant

Use \`axum::Json\` for both extracting JSON from requests and returning JSON responses:

\`\`\`rust
use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct CreateUser {
    name: String,
    email: String,
}

#[derive(Serialize)]
struct User {
    id: u64,
    name: String,
    email: String,
}

async fn create_user(Json(payload): Json<CreateUser>) -> Json<User> {
    let user = User {
        id: 1,
        name: payload.name,
        email: payload.email,
    };
    Json(user)
}
\`\`\`

You'll need these dependencies in \`Cargo.toml\`:

\`\`\`toml
[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
\`\`\`

> **Tip:** Axum automatically returns a \`400 Bad Request\` if the JSON deserialization fails.
`;

export const MOCK_SEARCH_RESULTS: SearchResult[] = [
  {
    conversation_id: 'conv-abc123',
    platform: 'chatgpt',
    title: 'Building a Rust Web Server',
    file_path: '/mock/chatgpt/2025-06-15_building-a-rust-web-server.md',
    snippet: 'Here\'s how to create a basic <mark>axum</mark> web <mark>server</mark> using Rust with routing and JSON support',
    role: 'assistant',
    rank: 1.5,
  },
  {
    conversation_id: 'conv-def456',
    platform: 'claude',
    title: 'Tauri Desktop App Architecture',
    file_path: '/mock/claude/2025-06-15_tauri-desktop-app-architecture.md',
    snippet: 'The <mark>axum</mark> <mark>server</mark> runs on localhost:18241 and handles ingest requests from the Chrome extension',
    role: 'assistant',
    rank: 2.1,
  },
  {
    conversation_id: 'conv-ghi789',
    platform: 'chatgpt',
    title: 'SQL Query Optimization',
    file_path: '/mock/chatgpt/2025-06-08_sql-query-optimization.md',
    snippet: 'Use EXPLAIN ANALYZE to understand how the <mark>server</mark> processes your queries and identify bottlenecks',
    role: 'assistant',
    rank: 3.2,
  },
];

export const MOCK_TOKEN = 'kpt_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

export const MOCK_CONFIG: AppConfig = {
  openai_api_key: null,
  anthropic_api_key: null,
  openrouter_api_key: null,
  auto_launch: false,
  dark_mode: null,
  ollama_model: null,
  ollama_embed_model: null,
  privacy_mode: null,
  claude_scan_paths: null,
  claude_pinned_projects: null,
  claude_templates: null,
  model_assignments: {
    agentic: [
      { provider: "anthropic", model: "claude-sonnet-4-6" },
    ],
    chat: [
      { provider: "anthropic", model: "claude-sonnet-4-6" },
    ],
    kg_extraction: [
      { provider: "ollama", model: "gemma3:1b" },
    ],
    embeddings: [
      { provider: "ollama", model: "nomic-embed-text" },
    ],
  },
  primary_provider: null,
  kb_paths: null,
  fs_allowed_paths: null,
  obsidian_vault_path: null,
  obsidian_auto_sync: null,
  obsidian_last_sync_at: null,
};

export const MOCK_VAULT_PATH = '~/.kept/vault';
