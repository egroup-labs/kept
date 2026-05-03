use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::config;
use crate::models::IngestPayload;

/// Sanitize a string for use as a filename. Mirrors the extension's
/// `sanitizeFilename` so files written by the CLI line up with what the
/// extension would produce on its own.
fn sanitize_filename(s: &str) -> String {
    let mapped: String = s
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

    let mut result = String::with_capacity(mapped.len());
    let mut last_was_sep = false;
    for c in mapped.chars() {
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
    let trimmed = result.trim_end_matches(['-', '_']).to_lowercase();
    if trimmed.chars().count() > 80 {
        trimmed.chars().take(80).collect()
    } else {
        trimmed
    }
}

/// Convert `\[...\]` → `$$...$$` and `\(...\)` → `$...$` so KaTeX/Obsidian
/// renders the math the same way the desktop app does.
fn normalize_math(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let chars: Vec<char> = content.chars().collect();
    let len = chars.len();
    let mut i = 0;
    while i < len {
        if chars[i] == '\\' && i + 1 < len {
            match chars[i + 1] {
                '[' => {
                    out.push_str("$$");
                    i += 2;
                    while i < len {
                        if chars[i] == '\\' && i + 1 < len && chars[i + 1] == ']' {
                            out.push_str("$$");
                            i += 2;
                            break;
                        }
                        out.push(chars[i]);
                        i += 1;
                    }
                }
                '(' => {
                    out.push('$');
                    i += 2;
                    while i < len {
                        if chars[i] == '\\' && i + 1 < len && chars[i + 1] == ')' {
                            out.push('$');
                            i += 2;
                            break;
                        }
                        out.push(chars[i]);
                        i += 1;
                    }
                }
                _ => {
                    out.push(chars[i]);
                    i += 1;
                }
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Render a conversation to markdown when the extension didn't supply its own.
/// Frontmatter shape matches the desktop app's renderer so files are
/// interchangeable across the two clients.
fn render_markdown(payload: &IngestPayload) -> String {
    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("id: \"{}\"\n", payload.conversation_id));
    md.push_str(&format!("platform: \"{}\"\n", payload.platform));
    md.push_str(&format!(
        "title: \"{}\"\n",
        payload.title.replace('\\', "\\\\").replace('"', "\\\"")
    ));
    md.push_str(&format!("synced: {}\n", chrono::Utc::now().to_rfc3339()));
    if let Some(ref c) = payload.created_at {
        md.push_str(&format!("created_at: {}\n", c));
    }
    if let Some(ref u) = payload.updated_at {
        md.push_str(&format!("updated_at: {}\n", u));
    } else if let Some(ref c) = payload.created_at {
        md.push_str(&format!("updated_at: {}\n", c));
    }
    md.push_str(&format!("messages: {}\n", payload.messages.len()));
    if let Some(ref m) = payload.model {
        md.push_str(&format!("model: \"{}\"\n", m));
    }
    md.push_str("tags:\n");
    md.push_str(&format!("  - \"kept/{}\"\n", payload.platform));
    md.push_str("---\n\n");

    md.push_str(&format!("# {}\n\n", payload.title));

    for msg in &payload.messages {
        let role = match msg.role.as_str() {
            "user" => "You",
            "assistant" => "Assistant",
            other => other,
        };
        if let Some(ref ts) = msg.timestamp {
            md.push_str(&format!("### {} — {}\n\n", role, ts));
        } else {
            md.push_str(&format!("### {}\n\n", role));
        }
        md.push_str(&msg.content);
        md.push_str("\n\n---\n\n");
    }
    md
}

pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

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

/// Build the destination file path for a conversation:
/// `{root}/{platform}/{YYYY-MM-DD}_{slug}.md`.
fn conversation_file_path(payload: &IngestPayload, root: &Path) -> PathBuf {
    let date = payload
        .created_at
        .as_deref()
        .and_then(|s| s.get(..10))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());

    let slug = sanitize_filename(&payload.title);
    let filename = format!("{}_{}.md", date, slug);
    root.join(&payload.platform).join(filename)
}

/// Decide which root to use: an explicit `X-Kept-Target-Dir` from the
/// extension wins over the configured vault.
pub fn resolve_root(target_override: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = target_override {
        return Ok(p.to_path_buf());
    }
    config::vault_dir()
}

/// Save a conversation to disk. Returns `(file_path, content_hash, skipped)`.
/// `skipped == true` means the on-disk file already had the same content.
pub fn save_conversation(
    payload: &IngestPayload,
    target_override: Option<&Path>,
) -> Result<(String, String, bool), String> {
    let root = resolve_root(target_override)?;
    let raw = payload
        .markdown
        .clone()
        .unwrap_or_else(|| render_markdown(payload));
    let markdown = normalize_math(&raw);
    let hash = content_hash(&markdown);

    let base_path = conversation_file_path(payload, &root);

    let file_path = if base_path.exists() {
        let existing = fs::read_to_string(&base_path)
            .map_err(|e| format!("read existing: {}", e))?;
        if content_hash(&existing) == hash {
            return Ok((base_path.to_string_lossy().into_owned(), hash, true));
        }
        let existing_id = extract_frontmatter_id(&existing);
        if existing_id.as_deref() == Some(&payload.conversation_id) {
            base_path
        } else {
            // Filename collision with a different conversation — disambiguate.
            let stem = base_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let parent = base_path
                .parent()
                .ok_or_else(|| "no parent dir".to_string())?
                .to_path_buf();
            let mut n = 2u32;
            loop {
                let candidate = parent.join(format!("{}_{}.md", stem, n));
                if !candidate.exists() {
                    break candidate;
                }
                let existing = fs::read_to_string(&candidate)
                    .map_err(|e| format!("read existing: {}", e))?;
                if content_hash(&existing) == hash {
                    return Ok((candidate.to_string_lossy().into_owned(), hash, true));
                }
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

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {}", e))?;
    }
    fs::write(&file_path, &markdown).map_err(|e| format!("write file: {}", e))?;

    Ok((file_path.to_string_lossy().into_owned(), hash, false))
}

/// Decode and store any base64 images attached to the payload. Returns one
/// `(filename, success)` tuple per image. Filenames containing path traversal
/// characters are rejected outright.
pub fn save_images(payload: &IngestPayload, target_override: Option<&Path>) -> Vec<(String, bool)> {
    use base64::Engine;

    let images = match &payload.images {
        Some(imgs) if !imgs.is_empty() => imgs,
        _ => return vec![],
    };

    let root = match resolve_root(target_override) {
        Ok(r) => r,
        Err(e) => {
            log::error!("resolve vault root: {}", e);
            return images.iter().map(|i| (i.filename.clone(), false)).collect();
        }
    };
    let dir = config::assets_dir_in(&root, &payload.platform);
    if let Err(e) = fs::create_dir_all(&dir) {
        log::error!("create assets dir {:?}: {}", dir, e);
        return images.iter().map(|i| (i.filename.clone(), false)).collect();
    }

    let mut results = Vec::with_capacity(images.len());
    for img in images {
        if img.filename.contains("..")
            || img.filename.contains('/')
            || img.filename.contains('\\')
        {
            log::warn!("rejected image filename with traversal chars: {}", img.filename);
            results.push((img.filename.clone(), false));
            continue;
        }
        let path = dir.join(&img.filename);

        // Defense in depth: even after the char check above, verify the
        // resolved path still lives inside the assets dir.
        let canonical_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        let probe = if path.exists() {
            path.canonicalize().unwrap_or_else(|_| path.clone())
        } else {
            let parent = path
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .unwrap_or_else(|| dir.clone());
            parent.join(img.filename.as_str())
        };
        if !probe.starts_with(&canonical_dir) {
            log::warn!("rejected image path outside assets dir: {:?}", probe);
            results.push((img.filename.clone(), false));
            continue;
        }

        if path.exists() {
            results.push((img.filename.clone(), true));
            continue;
        }

        match base64::engine::general_purpose::STANDARD.decode(&img.base64_data) {
            Ok(bytes) => match fs::write(&path, &bytes) {
                Ok(()) => results.push((img.filename.clone(), true)),
                Err(e) => {
                    log::error!("write image {:?}: {}", path, e);
                    results.push((img.filename.clone(), false));
                }
            },
            Err(e) => {
                log::error!("decode base64 for {}: {}", img.filename, e);
                results.push((img.filename.clone(), false));
            }
        }
    }
    results
}
