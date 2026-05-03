use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};
use std::path::{Path, PathBuf};

const MAX_TEXT_BYTES: usize = 512 * 1024;
const MAX_DIR_ENTRIES: usize = 150;

/// Validate that a path is within the configured `fs_allowed_paths`.
///
/// Returns the canonicalized path on success.
/// Returns an error string if the path is outside all allowed directories
/// or if no directories are configured.
/// Format the allowed paths list for inclusion in error messages.
fn format_allowed_paths(config: &crate::models::AppConfig) -> String {
    match config.fs_allowed_paths.as_ref() {
        Some(paths) if !paths.is_empty() => paths
            .iter()
            .map(|p| format!("  - {}", p))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => "  (none configured)".to_string(),
    }
}

pub fn validate_path(raw: &str, config: &crate::models::AppConfig) -> Result<PathBuf, String> {
    let target = Path::new(raw)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path '{}': {}", raw, e))?;

    let allowed = match config.fs_allowed_paths.as_ref() {
        Some(paths) if !paths.is_empty() => paths,
        _ => {
            return Err(format!(
                "No allowed filesystem paths configured. Add fs_allowed_paths to config.toml.\nAllowed paths:\n{}",
                format_allowed_paths(config)
            ))
        }
    };

    let is_allowed = allowed.iter().any(|p| {
        Path::new(p)
            .canonicalize()
            .map(|cp| target.starts_with(&cp) || target == cp)
            .unwrap_or(false)
    });

    if !is_allowed {
        return Err(format!(
            "Path '{}' is not within any allowed directory.\nAllowed paths:\n{}",
            raw,
            format_allowed_paths(config)
        ));
    }

    Ok(target)
}

/// Format a byte count as a human-readable size string.
fn format_size(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

pub fn register() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_fs_allowed_paths",
            description: "List the filesystem paths the agent is allowed to access.",
            parameters: vec![],
            handler: Box::new(ListFsAllowedPaths),
        },
        ToolDef {
            name: "read_file",
            description: "Read a file from the local filesystem (scoped to allowed directories).",
            parameters: vec![
                ParamDef {
                    name: "path",
                    param_type: ParamType::String,
                    description: "Path to the file",
                    required: true,
                },
                ParamDef {
                    name: "offset",
                    param_type: ParamType::Integer,
                    description: "Start line (0-indexed)",
                    required: false,
                },
                ParamDef {
                    name: "limit",
                    param_type: ParamType::Integer,
                    description: "Max lines to read",
                    required: false,
                },
            ],
            handler: Box::new(ReadFile),
        },
        ToolDef {
            name: "list_directory",
            description: "List contents of a directory.",
            parameters: vec![
                ParamDef {
                    name: "path",
                    param_type: ParamType::String,
                    description: "Directory path",
                    required: true,
                },
                ParamDef {
                    name: "recursive",
                    param_type: ParamType::Boolean,
                    description: "Include subdirectories up to 2 levels deep (default false)",
                    required: false,
                },
            ],
            handler: Box::new(ListDirectory),
        },
    ]
}

struct ListFsAllowedPaths;

#[async_trait::async_trait]
impl ToolHandler for ListFsAllowedPaths {
    async fn run(&self, ctx: &ToolContext<'_>, _args: &serde_json::Value) -> String {
        match ctx.config.fs_allowed_paths.as_ref() {
            Some(paths) if !paths.is_empty() => {
                let mut lines: Vec<String> = vec!["Allowed filesystem paths:".to_string()];
                for p in paths {
                    lines.push(format!("  - {}", p));
                }
                lines.join("\n")
            }
            _ => "No allowed filesystem paths configured. Add fs_allowed_paths to config.toml.".to_string(),
        }
    }
}

struct ReadFile;

#[async_trait::async_trait]
impl ToolHandler for ReadFile {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let path_str = match args["path"].as_str() {
            Some(p) if !p.is_empty() => p,
            _ => return "Error: 'path' parameter is required.".to_string(),
        };

        let target = match validate_path(path_str, ctx.config) {
            Ok(p) => p,
            Err(e) => return format!("Error: {}", e),
        };

        if !target.is_file() {
            return format!("Error: '{}' is not a file.", path_str);
        }

        // Binary detection: read first 8KB and scan for null bytes
        let probe = match std::fs::File::open(&target)
            .and_then(|mut f| {
                use std::io::Read;
                let mut buf = vec![0u8; 8192];
                let n = f.read(&mut buf)?;
                buf.truncate(n);
                Ok(buf)
            }) {
            Ok(b) => b,
            Err(e) => return format!("Error reading file: {}", e),
        };

        if probe.contains(&0) {
            return "Binary file detected — cannot read as text.".to_string();
        }

        // Read full file as text
        let content = match std::fs::read_to_string(&target) {
            Ok(c) => c,
            Err(e) => return format!("Error reading file: {}", e),
        };

        let lines: Vec<&str> = content.lines().collect();

        let offset = args
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;

        let slice = if offset >= lines.len() {
            return format!(
                "Offset {} is beyond end of file ({} lines).",
                offset,
                lines.len()
            );
        } else {
            &lines[offset..]
        };

        let slice = match args.get("limit").and_then(|v| v.as_u64()) {
            Some(limit) => {
                let limit = limit as usize;
                &slice[..limit.min(slice.len())]
            }
            None => slice,
        };

        let result = slice.join("\n");

        if result.len() > MAX_TEXT_BYTES {
            let truncated: String = result.chars().take(MAX_TEXT_BYTES).collect();
            format!("{}\n\n[Truncated: exceeds 512KB]", truncated)
        } else {
            result
        }
    }
}

struct ListDirectory;

#[async_trait::async_trait]
impl ToolHandler for ListDirectory {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let path_str = match args["path"].as_str() {
            Some(p) if !p.is_empty() => p,
            _ => return "Error: 'path' parameter is required.".to_string(),
        };

        let target = match validate_path(path_str, ctx.config) {
            Ok(p) => p,
            Err(e) => return format!("Error: {}", e),
        };

        if !target.is_dir() {
            return format!("Error: '{}' is not a directory.", path_str);
        }

        let recursive = args
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut lines: Vec<String> = Vec::new();
        let mut truncated = false;

        if recursive {
            for entry in walkdir::WalkDir::new(&target)
                .max_depth(2)
                .sort_by_file_name()
                .into_iter()
                .filter_map(|e| e.ok())
                .skip(1) // skip root dir itself
            {
                if lines.len() >= MAX_DIR_ENTRIES {
                    truncated = true;
                    break;
                }
                let rel = entry
                    .path()
                    .strip_prefix(&target)
                    .unwrap_or(entry.path());
                let display = rel.to_string_lossy();
                if entry.file_type().is_dir() {
                    lines.push(format!("{}/ (dir)", display));
                } else {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    lines.push(format!("{} ({})", display, format_size(size)));
                }
            }
        } else {
            let mut entries: Vec<_> = match std::fs::read_dir(&target) {
                Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
                Err(e) => return format!("Error reading directory: {}", e),
            };
            entries.sort_by_key(|e| e.file_name());

            for entry in entries {
                if lines.len() >= MAX_DIR_ENTRIES {
                    truncated = true;
                    break;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let ft = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                if ft.is_dir() {
                    lines.push(format!("{}/ (dir)", name));
                } else {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    lines.push(format!("{} ({})", name, format_size(size)));
                }
            }
        }

        if truncated {
            lines.push(format!("[... truncated at {} entries]", MAX_DIR_ENTRIES));
        }

        if lines.is_empty() {
            "Directory is empty.".to_string()
        } else {
            lines.join("\n")
        }
    }
}
