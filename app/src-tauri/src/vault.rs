use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::config::{assets_dir, vault_dir};
use crate::models::{IngestPayload, VaultNode};

fn unquote(s: &str) -> String {
    s.trim_matches('"').trim_matches('\'').to_string()
}

/// Unified frontmatter metadata extracted from a markdown conversation file.
pub struct FrontmatterMeta {
    pub id: Option<String>,
    pub platform: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Parse YAML frontmatter from a markdown string, extracting all known fields.
/// Used by both commands.rs (reindex) and vault.rs (vault tree display).
pub fn parse_frontmatter(content: &str) -> FrontmatterMeta {
    let mut meta = FrontmatterMeta {
        id: None,
        platform: None,
        title: None,
        model: None,
        created_at: None,
        updated_at: None,
    };

    if !content.starts_with("---") {
        return meta;
    }

    let rest = &content[3..];
    if let Some(end) = rest.find("---") {
        let frontmatter = &rest[..end];
        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("id:") {
                meta.id = Some(unquote(val.trim()));
            } else if let Some(val) = line.strip_prefix("platform:") {
                meta.platform = Some(unquote(val.trim()));
            } else if let Some(val) = line.strip_prefix("title:") {
                let v = unquote(val.trim());
                if !v.is_empty() {
                    meta.title = Some(v);
                }
            } else if let Some(val) = line.strip_prefix("model:") {
                meta.model = Some(unquote(val.trim()));
            } else if let Some(val) = line.strip_prefix("created_at:") {
                meta.created_at = Some(unquote(val.trim()));
            } else if let Some(val) = line.strip_prefix("updated_at:") {
                let v = unquote(val.trim());
                if !v.is_empty() {
                    meta.updated_at = Some(v);
                }
            }
        }
    }

    meta
}

fn read_frontmatter_from_file(path: &std::path::Path) -> FrontmatterMeta {
    let file = match fs::File::open(path).ok() {
        Some(f) => f,
        None => {
            return FrontmatterMeta {
                id: None,
                platform: None,
                title: None,
                model: None,
                created_at: None,
                updated_at: None,
            }
        }
    };
    let mut buf = String::new();
    let _ = file.take(8192).read_to_string(&mut buf).ok();
    let mut meta = parse_frontmatter(&buf);
    // Fall back to extracting title from first # heading if frontmatter has none
    if meta.title.is_none() {
        meta.title = extract_markdown_title(&buf);
    }
    meta
}

fn extract_markdown_title(content: &str) -> Option<String> {
    let body = if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("---") {
            &rest[end + 3..]
        } else {
            content
        }
    } else {
        content
    };

    for line in body.lines() {
        if let Some(val) = line.strip_prefix("# ") {
            let title = val.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
        if line.starts_with("### ") {
            break;
        }
    }

    None
}

/// Sanitize a string for use as a filename (matches extension's sanitizeFilename).
fn sanitize_filename(s: &str) -> String {
    let sanitized: String = s
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else if c == ' ' {
                '-'
            } else {
                '_'
            }
        })
        .collect();

    // Collapse repeated dashes/underscores, trim, lowercase, truncate
    let mut result = String::new();
    let mut last_was_sep = false;
    for c in sanitized.chars() {
        if c == '-' || c == '_' {
            if !last_was_sep && !result.is_empty() {
                result.push(c);
                last_was_sep = true;
            }
        } else {
            result.push(c);
            last_was_sep = false;
        }
    }

    let result = result
        .trim_end_matches(['-', '_'])
        .to_lowercase();
    if result.chars().count() > 80 {
        result.chars().take(80).collect::<String>()
    } else {
        result
    }
}

/// Convert `\[...\]` → `$$...$$` and `\(...\)` → `$...$` for Obsidian compatibility.
fn normalize_math(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let chars: Vec<char> = content.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '\\' && i + 1 < len {
            match chars[i + 1] {
                '[' => {
                    result.push_str("$$");
                    i += 2;
                    while i < len {
                        if chars[i] == '\\' && i + 1 < len && chars[i + 1] == ']' {
                            result.push_str("$$");
                            i += 2;
                            break;
                        }
                        result.push(chars[i]);
                        i += 1;
                    }
                }
                '(' => {
                    result.push('$');
                    i += 2;
                    while i < len {
                        if chars[i] == '\\' && i + 1 < len && chars[i + 1] == ')' {
                            result.push('$');
                            i += 2;
                            break;
                        }
                        result.push(chars[i]);
                        i += 1;
                    }
                }
                _ => {
                    result.push(chars[i]);
                    i += 1;
                }
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }

    result
}

/// Format tool arguments JSON into a comma-separated `key=jsonValue` list.
/// Values are JSON-stringified so strings keep their quotes.
fn format_tool_args(args: &serde_json::Value) -> String {
    let Some(obj) = args.as_object() else {
        return String::new();
    };
    obj.iter()
        .map(|(k, v)| format!("{}={}", k, serde_json::to_string(v).unwrap_or_else(|_| "null".into())))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Render markdown from an IngestPayload (matching extension format).
fn render_markdown(payload: &IngestPayload) -> String {
    let mut md = String::new();

    // YAML frontmatter
    md.push_str("---\n");
    md.push_str(&format!("id: \"{}\"\n", payload.conversation_id));
    md.push_str(&format!("platform: \"{}\"\n", payload.platform));
    md.push_str(&format!(
        "title: \"{}\"\n",
        payload.title.replace('\\', "\\\\").replace('"', "\\\"")
    ));
    md.push_str(&format!("synced: {}\n", chrono::Utc::now().to_rfc3339()));
    if let Some(ref created_at) = payload.created_at {
        md.push_str(&format!("created_at: {}\n", created_at));
    }
    if let Some(ref updated_at) = payload.updated_at {
        md.push_str(&format!("updated_at: {}\n", updated_at));
    } else if let Some(ref created_at) = payload.created_at {
        md.push_str(&format!("updated_at: {}\n", created_at));
    }
    md.push_str(&format!("messages: {}\n", payload.messages.len()));
    if let Some(ref model) = payload.model {
        md.push_str(&format!("model: \"{}\"\n", model));
    }
    md.push_str("tags:\n");
    md.push_str(&format!("  - \"kept/{}\"\n", payload.platform));
    md.push_str("---\n\n");

    // Title
    md.push_str(&format!("# {}\n\n", payload.title));

    // Messages
    for msg in &payload.messages {
        let role_display = match msg.role.as_str() {
            "user" => "You",
            "assistant" => "Assistant",
            _ => &msg.role,
        };

        if let Some(ref ts) = msg.timestamp {
            md.push_str(&format!("### {} — {}\n\n", role_display, ts));
        } else {
            md.push_str(&format!("### {}\n\n", role_display));
        }

        if let Some(reasoning) = msg.reasoning.as_deref().filter(|s| !s.trim().is_empty()) {
            md.push_str("<!-- kept:thinking -->\n");
            md.push_str(reasoning.trim_end());
            md.push_str("\n<!-- /kept:thinking -->\n\n");
        }

        if let Some(tools) = msg.tool_calls.as_ref().filter(|v| !v.is_empty()) {
            md.push_str("<!-- kept:tools -->\n");
            for t in tools {
                md.push_str(&format!("- {}({})\n", t.name, format_tool_args(&t.arguments)));
            }
            md.push_str("<!-- /kept:tools -->\n\n");
        }

        md.push_str(&msg.content);
        md.push_str("\n\n---\n\n");
    }

    md
}

/// Compute SHA-256 hash of content.
pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Build the file path for a conversation: {root}/{platform}/{date}_{title}.md
///
/// `root_override` lets callers redirect writes to an alternate directory
/// (e.g. the browser extension's `X-Kept-Target-Dir` header). When None,
/// defaults to the configured vault directory.
fn conversation_file_path(
    payload: &IngestPayload,
    root_override: Option<&Path>,
) -> Result<PathBuf, String> {
    let platform = &payload.platform;
    let date = payload
        .created_at
        .as_deref()
        .and_then(|s| s.get(..10))
        .unwrap_or("");

    let date_prefix = if date.is_empty() {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    } else {
        date.to_string()
    };

    let title_slug = sanitize_filename(&payload.title);
    let filename = format!("{}_{}.md", date_prefix, title_slug);

    let root = match root_override {
        Some(p) => p.to_path_buf(),
        None => vault_dir()?,
    };
    Ok(root.join(platform).join(filename))
}

/// Extract the conversation id from markdown frontmatter (the `id: "..."` line).
fn extract_frontmatter_id(content: &str) -> Option<String> {
    let fm = content.strip_prefix("---\n")?;
    let end = fm.find("\n---")?;
    for line in fm[..end].lines() {
        if let Some(rest) = line.strip_prefix("id: ") {
            return Some(rest.trim_matches('"').to_string());
        }
    }
    None
}

/// Save a conversation to the vault. Returns (file_path, content_hash, skipped).
///
/// `root_override` directs the write to an alternate directory instead of
/// the default vault. When None, falls back to `vault_dir()`.
pub fn save_conversation(
    payload: &IngestPayload,
    root_override: Option<&Path>,
) -> Result<(String, String, bool), String> {
    let raw = payload
        .markdown
        .clone()
        .unwrap_or_else(|| render_markdown(payload));
    let markdown = normalize_math(&raw);

    let hash = content_hash(&markdown);
    let base_path = conversation_file_path(payload, root_override)?;

    // Check if file exists with same hash (dedup), or find a unique path.
    // If existing file has the same conversation_id, overwrite it (conversation update).
    // Only create a suffixed file for genuinely different conversations.
    let file_path = if base_path.exists() {
        let existing = fs::read_to_string(&base_path)
            .map_err(|e| format!("Failed to read existing file: {}", e))?;
        if content_hash(&existing) == hash {
            let path_str = base_path.to_string_lossy().to_string();
            return Ok((path_str, hash, true));
        }
        // Same conversation_id → overwrite (this is an update with more messages)
        let existing_id = extract_frontmatter_id(&existing);
        if existing_id.as_deref() == Some(&payload.conversation_id) {
            base_path
        } else {
            // Different conversation, same filename — find a unique suffix
            let stem = base_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let parent = base_path.parent().unwrap();
            let mut n = 2u32;
            loop {
                let candidate = parent.join(format!("{}_{}.md", stem, n));
                if !candidate.exists() {
                    break candidate;
                }
                let existing = fs::read_to_string(&candidate)
                    .map_err(|e| format!("Failed to read existing file: {}", e))?;
                if content_hash(&existing) == hash {
                    let path_str = candidate.to_string_lossy().to_string();
                    return Ok((path_str, hash, true));
                }
                // Same conversation_id in suffixed file → overwrite it too
                let candidate_id = extract_frontmatter_id(&existing);
                if candidate_id.as_deref() == Some(&payload.conversation_id) {
                    break candidate;
                }
                n += 1;
            }
        }
    } else {
        base_path
    };

    // Ensure parent directory exists
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&file_path, &markdown).map_err(|e| format!("Failed to write file: {}", e))?;

    let path_str = file_path.to_string_lossy().to_string();
    log::info!("Saved conversation to {}", path_str);

    // Schedule a debounced Obsidian export. No-op if the user hasn't
    // configured a vault path or has disabled auto-sync.
    crate::export::request_auto_sync();

    Ok((path_str, hash, false))
}

/// Read a conversation markdown file.
pub fn read_conversation(file_path: &str) -> Result<String, String> {
    fs::read_to_string(file_path).map_err(|e| format!("Failed to read file: {}", e))
}

/// Walk the vault directory and return a tree structure.
pub fn vault_tree() -> Result<Vec<VaultNode>, String> {
    let vault = vault_dir()?;
    if !vault.exists() {
        return Ok(vec![]);
    }

    let mut platforms: Vec<VaultNode> = Vec::new();

    // List platform directories
    let entries = fs::read_dir(&vault).map_err(|e| format!("Failed to read vault dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            let platform_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let mut children: Vec<VaultNode> = Vec::new();

            // Walk files in this platform directory
            for file_entry in WalkDir::new(&path)
                .min_depth(1)
                .max_depth(1)
                .sort_by_file_name()
            {
                let file_entry = file_entry.map_err(|e| format!("Failed to walk dir: {}", e))?;
                let file_path = file_entry.path();

                if file_path.is_file() && file_path.extension().is_some_and(|ext| ext == "md") {
                    let file_name = file_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();

                    let fm = read_frontmatter_from_file(file_path);
                    children.push(VaultNode {
                        name: file_name,
                        title: fm.title,
                        updated_at: fm.updated_at,
                        path: Some(file_path.to_string_lossy().to_string()),
                        is_dir: false,
                        children: vec![],
                    });
                }
            }

            // Sort children by name descending (newest first)
            children.sort_by(|a, b| b.name.cmp(&a.name));

            platforms.push(VaultNode {
                name: platform_name,
                title: None,
                updated_at: None,
                path: Some(path.to_string_lossy().to_string()),
                is_dir: true,
                children,
            });
        }
    }

    platforms.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(platforms)
}

/// Save images from an ingest payload to disk. Returns list of (filename, success).
///
/// `root_override` redirects the `<root>/<platform>/assets/` target. When
/// None, falls back to the default vault's assets directory.
pub fn save_images(
    payload: &IngestPayload,
    root_override: Option<&Path>,
) -> Vec<(String, bool)> {
    use base64::Engine;

    let images = match &payload.images {
        Some(imgs) if !imgs.is_empty() => imgs,
        _ => return vec![],
    };

    let dir = match root_override {
        Some(root) => root.join(&payload.platform).join("assets"),
        None => match assets_dir(&payload.platform) {
            Ok(d) => d,
            Err(e) => {
                log::error!("Failed to determine assets dir: {}", e);
                return images.iter().map(|i| (i.filename.clone(), false)).collect();
            }
        },
    };
    if let Err(e) = fs::create_dir_all(&dir) {
        log::error!("Failed to create assets dir {:?}: {}", dir, e);
        return images.iter().map(|i| (i.filename.clone(), false)).collect();
    }

    let mut results = Vec::new();
    for img in images {
        // Reject filenames containing path traversal characters
        if img.filename.contains("..") || img.filename.contains('/') || img.filename.contains('\\')
        {
            log::error!(
                "Rejected image filename with path traversal characters: {}",
                img.filename
            );
            results.push((img.filename.clone(), false));
            continue;
        }

        let path = dir.join(&img.filename);

        // Canonicalize and verify the path is within the assets directory
        // For new files, canonicalize the parent and check containment
        let canonical_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        let canonical_path = if path.exists() {
            path.canonicalize().unwrap_or_else(|_| path.clone())
        } else {
            // File doesn't exist yet — resolve the parent
            let parent = path
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .unwrap_or_else(|| dir.clone());
            parent.join(img.filename.as_str())
        };
        if !canonical_path.starts_with(&canonical_dir) {
            log::error!(
                "Rejected image path outside assets dir: {:?}",
                canonical_path
            );
            results.push((img.filename.clone(), false));
            continue;
        }

        // Skip if already exists (dedup by filename)
        if path.exists() {
            log::debug!("Image already exists, skipping: {:?}", path);
            results.push((img.filename.clone(), true));
            continue;
        }

        match base64::engine::general_purpose::STANDARD.decode(&img.base64_data) {
            Ok(bytes) => match fs::write(&path, &bytes) {
                Ok(()) => {
                    log::info!("Saved image: {:?} ({} bytes)", path, bytes.len());
                    results.push((img.filename.clone(), true));
                }
                Err(e) => {
                    log::error!("Failed to write image {:?}: {}", path, e);
                    results.push((img.filename.clone(), false));
                }
            },
            Err(e) => {
                log::error!("Failed to decode base64 for {}: {}", img.filename, e);
                results.push((img.filename.clone(), false));
            }
        }
    }

    results
}

#[cfg(test)]
mod transparency_render_tests {
    use super::render_markdown;
    use crate::models::{IngestPayload, Message, ToolCallRecord};
    use serde_json::json;

    fn payload_with(messages: Vec<Message>) -> IngestPayload {
        IngestPayload {
            conversation_id: "c1".into(),
            platform: "kept".into(),
            title: "Test".into(),
            model: None,
            messages,
            created_at: Some("2026-05-04T00:00:00Z".into()),
            updated_at: None,
            markdown: None,
            images: None,
        }
    }

    #[test]
    fn renders_thinking_and_tools_comments_for_assistant() {
        let p = payload_with(vec![
            Message {
                role: "user".into(),
                content: "hi".into(),
                timestamp: None,
                attachments: None,
                reasoning: None,
                tool_calls: None,
            },
            Message {
                role: "assistant".into(),
                content: "Here's what I found.".into(),
                timestamp: None,
                attachments: None,
                reasoning: Some("Step 1: search".into()),
                tool_calls: Some(vec![ToolCallRecord {
                    name: "search_nodes".into(),
                    arguments: json!({"query": "rust", "limit": 10}),
                }]),
            },
        ]);
        let md = render_markdown(&p);
        assert!(md.contains("<!-- kept:thinking -->\nStep 1: search\n<!-- /kept:thinking -->"));
        assert!(md.contains("<!-- kept:tools -->"));
        // serde_json::Map is BTreeMap by default → keys sort alphabetically.
        assert!(md.contains("- search_nodes("));
        assert!(md.contains("query=\"rust\""));
        assert!(md.contains("limit=10"));
        assert!(md.contains("Here's what I found."));
        let t_idx = md.find("<!-- kept:thinking -->").unwrap();
        let l_idx = md.find("<!-- kept:tools -->").unwrap();
        let c_idx = md.find("Here's what I found.").unwrap();
        assert!(t_idx < l_idx && l_idx < c_idx);
    }

    #[test]
    fn omits_blocks_when_fields_absent() {
        let p = payload_with(vec![Message {
            role: "assistant".into(),
            content: "Hello.".into(),
            timestamp: None,
            attachments: None,
            reasoning: None,
            tool_calls: None,
        }]);
        let md = render_markdown(&p);
        assert!(!md.contains("kept:thinking"));
        assert!(!md.contains("kept:tools"));
        assert!(md.contains("Hello."));
    }
}
