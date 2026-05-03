use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{ClaudeFile, ClaudeProject, ClaudeSkill};

/// Return the global Claude config directory: ~/.claude/
pub fn global_claude_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .ok_or_else(|| "Could not determine home directory".to_string())
        .map(|h| h.join(".claude"))
}

/// Validate that a resolved path is within the expected base directory.
fn validate_path(base: &Path, target: &Path) -> Result<(), String> {
    let canonical_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let canonical_target = if target.exists() {
        target
            .canonicalize()
            .unwrap_or_else(|_| target.to_path_buf())
    } else {
        let parent = target
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| base.to_path_buf());
        parent.join(target.file_name().unwrap_or_default())
    };
    if !canonical_target.starts_with(&canonical_base) {
        return Err("Access denied: path outside project".to_string());
    }
    Ok(())
}

/// Inspect a single directory and produce a ClaudeProject summary.
fn inspect_project(path: &Path, is_global: bool) -> Option<ClaudeProject> {
    let dot_claude = path.join(".claude");
    let claude_md = path.join("CLAUDE.md");
    let dot_claude_md = dot_claude.join("CLAUDE.md");
    let settings_json = dot_claude.join("settings.json");
    let settings_local_json = dot_claude.join("settings.local.json");
    let commands_dir = dot_claude.join("commands");

    let has_claude_md = claude_md.is_file();
    let has_dot_claude_md = dot_claude_md.is_file();
    let has_settings = settings_json.is_file() || settings_local_json.is_file();
    let has_dot_claude = dot_claude.is_dir();

    if !has_claude_md && !has_dot_claude {
        return None;
    }

    let skill_count = if commands_dir.is_dir() {
        fs::read_dir(&commands_dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
                    .count() as u32
            })
            .unwrap_or(0)
    } else {
        0
    };

    let memory_file_count = count_memory_files(&dot_claude);

    let name = if is_global {
        "Global".to_string()
    } else {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    };

    Some(ClaudeProject {
        name,
        path: path.to_string_lossy().to_string(),
        is_global,
        has_claude_md,
        has_dot_claude_md,
        has_settings,
        skill_count,
        memory_file_count,
    })
}

fn count_memory_files(dot_claude: &Path) -> u32 {
    let projects_dir = dot_claude.join("projects");
    if !projects_dir.is_dir() {
        return 0;
    }
    let mut count = 0u32;
    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let memory_dir = entry.path().join("memory");
            if memory_dir.is_dir() {
                if let Ok(files) = fs::read_dir(&memory_dir) {
                    count += files
                        .filter_map(|f| f.ok())
                        .filter(|f| f.path().is_file())
                        .count() as u32;
                }
            }
        }
    }
    count
}

fn file_modified_iso(path: &Path) -> Option<String> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        })
}

pub fn scan_projects(scan_paths: &[String], pinned: &[String]) -> Vec<ClaudeProject> {
    let mut projects = Vec::new();

    // Always include global
    if let Ok(global) = global_claude_dir() {
        if global.is_dir() {
            if let Some(p) = inspect_project(global.parent().unwrap_or(&global), true) {
                projects.push(p);
            }
        }
    }

    for scan_path in scan_paths {
        let dir = Path::new(scan_path);
        if !dir.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let child = entry.path();
                if child.is_dir() {
                    if let Some(p) = inspect_project(&child, false) {
                        let path_str = child.to_string_lossy().to_string();
                        if !pinned.contains(&path_str) {
                            projects.push(p);
                        }
                    }
                }
            }
        }
    }

    for pinned_path in pinned {
        let dir = Path::new(pinned_path);
        if dir.is_dir() {
            if let Some(p) = inspect_project(dir, false) {
                projects.push(p);
            }
        }
    }

    projects.sort_by(|a, b| {
        if a.is_global && !b.is_global {
            std::cmp::Ordering::Less
        } else if !a.is_global && b.is_global {
            std::cmp::Ordering::Greater
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    projects
}

pub fn read_instructions(project_path: &str) -> Result<Vec<ClaudeFile>, String> {
    let base = Path::new(project_path);
    let mut files = Vec::new();

    let claude_md = base.join("CLAUDE.md");
    if claude_md.is_file() {
        let content = fs::read_to_string(&claude_md)
            .map_err(|e| format!("Failed to read CLAUDE.md: {}", e))?;
        let size = fs::metadata(&claude_md).map(|m| m.len()).unwrap_or(0);
        files.push(ClaudeFile {
            name: "CLAUDE.md".to_string(),
            relative_path: "CLAUDE.md".to_string(),
            content,
            size,
            modified: file_modified_iso(&claude_md),
        });
    }

    let dot_claude_md = base.join(".claude").join("CLAUDE.md");
    if dot_claude_md.is_file() {
        let content = fs::read_to_string(&dot_claude_md)
            .map_err(|e| format!("Failed to read .claude/CLAUDE.md: {}", e))?;
        let size = fs::metadata(&dot_claude_md).map(|m| m.len()).unwrap_or(0);
        files.push(ClaudeFile {
            name: ".claude/CLAUDE.md".to_string(),
            relative_path: ".claude/CLAUDE.md".to_string(),
            content,
            size,
            modified: file_modified_iso(&dot_claude_md),
        });
    }

    Ok(files)
}

fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;

    if !content.starts_with("---") {
        return (name, description);
    }

    let rest = &content[3..];
    if let Some(end) = rest.find("---") {
        let frontmatter = &rest[..end];
        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                let v = val.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    name = Some(v.to_string());
                }
            } else if let Some(val) = line.strip_prefix("description:") {
                let v = val.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    description = Some(v.to_string());
                }
            }
        }
    }

    (name, description)
}

pub fn list_skills(project_path: &str) -> Result<Vec<ClaudeSkill>, String> {
    let commands_dir = Path::new(project_path).join(".claude").join("commands");
    if !commands_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut skills = Vec::new();
    let entries =
        fs::read_dir(&commands_dir).map_err(|e| format!("Failed to read commands dir: {}", e))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read skill {}: {}", filename, e))?;
            let (name, description) = parse_skill_frontmatter(&content);
            skills.push(ClaudeSkill {
                filename,
                name,
                description,
                content,
            });
        }
    }

    skills.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(skills)
}

pub fn list_memory(project_path: &str) -> Result<Vec<ClaudeFile>, String> {
    let projects_dir = Path::new(project_path).join(".claude").join("projects");
    if !projects_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut files = Vec::new();
    let entries =
        fs::read_dir(&projects_dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let memory_dir = entry.path().join("memory");
        if !memory_dir.is_dir() {
            continue;
        }
        let project_name = entry
            .path()
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        if let Ok(mem_entries) = fs::read_dir(&memory_dir) {
            for mem_entry in mem_entries.filter_map(|e| e.ok()) {
                let mem_path = mem_entry.path();
                if mem_path.is_file() {
                    let filename = mem_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let content = fs::read_to_string(&mem_path).unwrap_or_default();
                    let size = fs::metadata(&mem_path).map(|m| m.len()).unwrap_or(0);
                    let relative = format!(".claude/projects/{}/memory/{}", project_name, filename);
                    files.push(ClaudeFile {
                        name: filename,
                        relative_path: relative,
                        content,
                        size,
                        modified: file_modified_iso(&mem_path),
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

/// Read .claude/settings.json and .claude/settings.local.json
pub fn read_settings(project_path: &str) -> Result<Vec<ClaudeFile>, String> {
    let dot_claude = Path::new(project_path).join(".claude");
    let mut files = Vec::new();

    for filename in &["settings.json", "settings.local.json"] {
        let path = dot_claude.join(filename);
        if path.is_file() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {}", filename, e))?;
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            files.push(ClaudeFile {
                name: filename.to_string(),
                relative_path: format!(".claude/{}", filename),
                content,
                size,
                modified: file_modified_iso(&path),
            });
        }
    }

    Ok(files)
}

pub fn write_project_file(
    project_path: &str,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    let base = Path::new(project_path);
    let target = base.join(relative_path);
    validate_path(base, &target)?;

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&target, content).map_err(|e| format!("Failed to write file: {}", e))
}

pub fn delete_skill(project_path: &str, filename: &str) -> Result<(), String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".to_string());
    }
    let target = Path::new(project_path)
        .join(".claude")
        .join("commands")
        .join(filename);
    let base = Path::new(project_path).join(".claude").join("commands");
    validate_path(&base, &target)?;

    if !target.is_file() {
        return Err("Skill file not found".to_string());
    }
    fs::remove_file(&target).map_err(|e| format!("Failed to delete skill: {}", e))
}

/// Collect all skills across all discovered projects.
pub fn scan_all_skills(
    scan_paths: &[String],
    pinned: &[String],
) -> Vec<crate::models::ClaudeSkillWithProject> {
    let projects = scan_projects(scan_paths, pinned);
    let mut all = Vec::new();
    for project in &projects {
        if let Ok(skills) = list_skills(&project.path) {
            for skill in skills {
                all.push(crate::models::ClaudeSkillWithProject {
                    project_name: project.name.clone(),
                    project_path: project.path.clone(),
                    skill,
                });
            }
        }
    }
    all
}

/// Collect all memory files across all discovered projects.
pub fn scan_all_memory(
    scan_paths: &[String],
    pinned: &[String],
) -> Vec<crate::models::ClaudeFileWithProject> {
    let projects = scan_projects(scan_paths, pinned);
    let mut all = Vec::new();
    for project in &projects {
        if let Ok(files) = list_memory(&project.path) {
            for file in files {
                all.push(crate::models::ClaudeFileWithProject {
                    project_name: project.name.clone(),
                    project_path: project.path.clone(),
                    file,
                });
            }
        }
    }
    all
}

/// Copy a file from one project to the same relative path in another project.
pub fn copy_file(
    source_project: &str,
    relative_path: &str,
    target_project: &str,
) -> Result<(), String> {
    let source_base = Path::new(source_project);
    let source_file = source_base.join(relative_path);
    validate_path(source_base, &source_file)?;

    let target_base = Path::new(target_project);
    let target_file = target_base.join(relative_path);
    validate_path(target_base, &target_file)?;

    let content = fs::read_to_string(&source_file)
        .map_err(|e| format!("Failed to read source file: {}", e))?;

    if let Some(parent) = target_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create target directory: {}", e))?;
    }

    fs::write(&target_file, content).map_err(|e| format!("Failed to write target file: {}", e))
}

/// Read the same relative path from two projects and return both contents for diffing.
pub fn diff_file(
    project_a: &str,
    project_b: &str,
    relative_path: &str,
) -> Result<(String, String), String> {
    let path_a = Path::new(project_a).join(relative_path);
    validate_path(Path::new(project_a), &path_a)?;
    let path_b = Path::new(project_b).join(relative_path);
    validate_path(Path::new(project_b), &path_b)?;

    let content_a = if path_a.is_file() {
        fs::read_to_string(&path_a).map_err(|e| format!("Failed to read {}: {}", project_a, e))?
    } else {
        String::new()
    };
    let content_b = if path_b.is_file() {
        fs::read_to_string(&path_b).map_err(|e| format!("Failed to read {}: {}", project_b, e))?
    } else {
        String::new()
    };

    Ok((content_a, content_b))
}
