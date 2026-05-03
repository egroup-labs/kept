use std::fs;
use std::path::PathBuf;

use crate::models::AppConfig;

const APP_DIR_NAME: &str = ".kept";

fn kept_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())
        .map(|h| h.join(APP_DIR_NAME))
}

/// Returns the base Kept directory: ~/.kept/
pub fn app_dir() -> Result<PathBuf, String> {
    kept_dir()
}

/// Returns the vault directory: ~/.kept/vault/
pub fn vault_dir() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("vault"))
}

/// Returns the database path: ~/.kept/index.db
pub fn db_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("index.db"))
}

/// Returns the token file path: ~/.kept/token
pub fn token_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("token"))
}

/// Returns the config file path: ~/.kept/config.toml
pub fn config_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("config.toml"))
}

/// Returns the knowledge graph database path: ~/.kept/kg.db/
pub fn kg_db_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("kg.db"))
}

/// Returns the assets directory for a platform: ~/.kept/vault/{platform}/assets/
pub fn assets_dir(platform: &str) -> Result<PathBuf, String> {
    Ok(vault_dir()?.join(platform).join("assets"))
}

/// Returns the tools manifest path: ~/.kept/tools.md
pub fn tools_md_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("tools.md"))
}

/// Returns the artifacts directory: ~/.kept/artifacts/
///
/// Each code execution gets its own subdirectory here. Code files and any files
/// the execution creates are persisted there so the user can inspect them later.
pub fn artifacts_dir() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("artifacts"))
}

/// Returns the shared Python uv project directory: ~/.kept/runtime/python/
///
/// A single persistent uv project (pyproject.toml + uv.lock + .venv/). Python
/// deps requested via `execute_code` are added here with `uv add` and scripts
/// run against this project with `uv run --project`.
pub fn runtime_python_dir() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("runtime").join("python"))
}

/// Returns the shared Node.js runtime directory: ~/.kept/runtime/node/
///
/// Contains a single `node_modules/` where `npm install` targets go. We set
/// `NODE_PATH` to its `node_modules/` before spawning.
pub fn runtime_node_dir() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("runtime").join("node"))
}

const DEFAULT_TOOLS_MD: &str = r#"# Tools

## Conversation Tools
- **search_conversations** - Full-text search across archived conversations. Search first, read selectively.
- **read_conversation** - Read a conversation's markdown content. Use after searching to get details.
- **list_conversations** - List all conversations with metadata. Optionally filter by platform.

## Knowledge Base Tools
- **list_knowledge_files** - List files and directories in the knowledge base.
- **read_knowledge_file** - Read a file from the knowledge base. Use list first to discover files.
- **search_knowledge_files** - Case-insensitive text search across knowledge base files.
- **grep_knowledge_files** - Regex search across knowledge base files.

## Code Execution
- **execute_code** - Run a python/javascript/shell snippet on the user's machine. The UI handles consent — just call, don't ask in chat. Put non-stdlib package names (matplotlib, numpy, requests, axios, etc.) in `dependencies`; they install into a shared environment and stay available across later calls in the same chat. Write clean code — imports and logic only, no install commands or metadata headers. Files created in one run are reusable in later runs (listed in the tool result).

## File Tools
- **read_pdf** - Extract text content from a PDF file.
- **read_image** - Describe or extract text (OCR) from an image file.
- **read_file** - Read a file from the local filesystem (scoped to allowed directories).
- **list_directory** - List contents of a directory.
- **list_fs_allowed_paths** - List filesystem paths the agent is allowed to access.

## Graph Tools
- **graph_search** - Query the knowledge graph for connected entities and their connections.
- **search_conversation_content** - Full-text search across archived conversations with optional platform and title filters.
- **highlight_nodes** - Highlight specific nodes in the knowledge graph view.
- **list_nodes** - List nodes in the knowledge graph, optionally filtered by node type.
- **search_nodes** - Search for nodes by keyword. Returns matching nodes and edges.
- **get_neighbors** - Get all directly connected nodes and edges for a given node.
- **get_stats** - Get aggregate statistics: entity count, triple count, conversation count, top entities.
- **add_edge** - Add a directed relationship between two nodes.
- **remove_edge** - Remove a directed relationship between two nodes.
- **add_entity** - Add a new entity node to the knowledge graph.
- **remove_node** - Remove a node and all its associated edges and mentions.
"#;

/// Initialize the ~/.kept/ directory structure and generate token if needed.
pub fn init_kept_dirs() -> Result<(), String> {
    let base = app_dir()?;
    let vault = vault_dir()?;

    // Create directories
    let platforms = ["chatgpt", "claude", "gemini", "grok", "kimi"];
    fs::create_dir_all(&base).map_err(|e| format!("Failed to create {:?}: {}", base, e))?;
    fs::create_dir_all(&vault).map_err(|e| format!("Failed to create {:?}: {}", vault, e))?;
    for platform in &platforms {
        let plat_dir = vault.join(platform);
        fs::create_dir_all(&plat_dir)
            .map_err(|e| format!("Failed to create {:?}: {}", plat_dir, e))?;
        let assets = plat_dir.join("assets");
        fs::create_dir_all(&assets).map_err(|e| format!("Failed to create {:?}: {}", assets, e))?;
    }

    // Generate auth token if it doesn't exist
    let token_file = token_path()?;
    if !token_file.exists() {
        let token = uuid::Uuid::new_v4().to_string();
        fs::write(&token_file, &token).map_err(|e| format!("Failed to write token: {}", e))?;
        log::info!("Generated auth token at {:?}", token_file);
    }

    // Create default config.toml if it doesn't exist
    let config_file = config_path()?;
    if !config_file.exists() {
        let default_config = AppConfig::default();
        let toml_str = toml::to_string_pretty(&default_config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&config_file, toml_str).map_err(|e| format!("Failed to write config: {}", e))?;
        log::info!("Created default config at {:?}", config_file);
    }

    // Create default tools.md if it doesn't exist
    let tools_file = tools_md_path()?;
    if !tools_file.exists() {
        fs::write(&tools_file, DEFAULT_TOOLS_MD)
            .map_err(|e| format!("Failed to write tools.md: {}", e))?;
        log::info!("Created default tools.md at {:?}", tools_file);
    }

    Ok(())
}

/// Read the auth token from ~/.kept/token
pub fn read_token() -> Result<String, String> {
    fs::read_to_string(token_path()?)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Failed to read token: {}", e))
}

/// Write the auth token to ~/.kept/token
pub fn write_token(token: &str) -> Result<(), String> {
    fs::write(token_path()?, token.trim()).map_err(|e| format!("Failed to write token: {}", e))
}

/// Read the app config from ~/.kept/config.toml
pub fn read_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
    let mut config: AppConfig =
        toml::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    // Backfill default model assignments for existing configs that lack them
    if config.model_assignments.is_none() {
        config.model_assignments = AppConfig::default().model_assignments;
    } else if let (Some(ref mut assignments), Some(defaults)) =
        (&mut config.model_assignments, AppConfig::default().model_assignments)
    {
        // Merge any missing task keys from defaults
        for (key, value) in defaults {
            assignments.entry(key).or_insert(value);
        }
    }
    // Backfill default fs_allowed_paths for existing configs that lack it
    if config.fs_allowed_paths.is_none() {
        config.fs_allowed_paths = AppConfig::default().fs_allowed_paths;
    }

    Ok(config)
}

/// Write the app config to ~/.kept/config.toml
pub fn write_config(config: &AppConfig) -> Result<(), String> {
    let toml_str =
        toml::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(config_path()?, toml_str).map_err(|e| format!("Failed to write config: {}", e))
}
