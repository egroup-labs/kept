use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};
use crate::config;
use crate::models::CodeExecConsentRequest;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;
use tokio::process::Command;

/// Maximum combined output size (256 KB).
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// How long to wait for npm install (seconds).
const DEP_INSTALL_TIMEOUT_SECS: u64 = 300;

pub fn register() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "execute_code",
        description: "Run a python, javascript, or shell snippet on the user's machine. \
                      Returns stdout/stderr plus the artifact directory where the script and any \
                      files it creates are stored. The UI handles user consent — do not ask \
                      for permission in chat, just call. Put non-stdlib package names (e.g. \
                      matplotlib, numpy, requests, axios) in `dependencies`; the tool installs \
                      them into a shared environment and they stay available across later calls \
                      in the same chat. Write clean code — imports and logic only, no install \
                      commands or metadata headers.",
        parameters: vec![
            ParamDef {
                name: "language",
                param_type: ParamType::String,
                description: "Language: \"python\", \"javascript\", \"bash\" (or \"shell\")",
                required: true,
            },
            ParamDef {
                name: "code",
                param_type: ParamType::String,
                description: "The code to execute",
                required: true,
            },
            ParamDef {
                name: "dependencies",
                param_type: ParamType::StringArray,
                description: "Optional list of packages the script imports beyond the stdlib. \
                              For python these are pip-style specifiers (e.g. [\"matplotlib\", \
                              \"numpy>=2\"]); for javascript these are npm package names. \
                              Ignored for bash/shell.",
                required: false,
            },
            ParamDef {
                name: "timeout_ms",
                param_type: ParamType::Integer,
                description: "Max execution time in milliseconds (default 30000, max 120000)",
                required: false,
            },
        ],
        handler: Box::new(ExecuteCode),
    }]
}

struct ExecuteCode;

#[async_trait::async_trait]
impl ToolHandler for ExecuteCode {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        // ── Parse arguments ──────────────────────────────────────────────
        let language = match args["language"].as_str() {
            Some(l) => l.to_lowercase(),
            None => return "Error: missing required parameter 'language'.".to_string(),
        };
        let code = match args["code"].as_str() {
            Some(c) => c.to_string(),
            None => return "Error: missing required parameter 'code'.".to_string(),
        };
        let timeout_ms: u64 = args["timeout_ms"]
            .as_u64()
            .unwrap_or(30_000)
            .clamp(1_000, 120_000);
        let dependencies: Vec<String> = args["dependencies"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // Dependencies are only meaningful for python/javascript
        let effective_deps = match language.as_str() {
            "python" | "javascript" => dependencies.clone(),
            _ => Vec::new(),
        };

        // ── Consent flow ─────────────────────────────────────────────────
        let window = match ctx.window {
            Some(w) => w,
            None => return "Error: code execution requires a UI window for user consent.".to_string(),
        };
        let consent_map = match ctx.consent_map {
            Some(m) => m,
            None => return "Error: code execution consent not available in this context.".to_string(),
        };

        let exec_uuid = uuid::Uuid::new_v4();
        let request_id = exec_uuid.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

        {
            let mut map = match consent_map.lock() {
                Ok(m) => m,
                Err(e) => return format!("Error: consent lock poisoned: {}", e),
            };
            map.insert(request_id.clone(), tx);
        }

        let payload = CodeExecConsentRequest {
            request_id: request_id.clone(),
            language: language.clone(),
            code: code.clone(),
            dependencies: effective_deps.clone(),
        };
        if let Err(e) = window.emit("code-exec-consent", &payload) {
            if let Ok(mut map) = consent_map.lock() {
                map.remove(&request_id);
            }
            return format!("Error: failed to emit consent event: {}", e);
        }

        // No consent timeout — the user can take as long as they want.
        let approved = match rx.await {
            Ok(approved) => approved,
            Err(_) => {
                if let Ok(mut map) = consent_map.lock() {
                    map.remove(&request_id);
                }
                return "Error: consent channel closed (app shutting down?).".to_string();
            }
        };

        if !approved {
            return "Code execution denied by user.".to_string();
        }

        // ── Install / prepare dependencies ───────────────────────────────
        //
        // Python: add deps to the shared uv project (~/.kept/runtime/python/).
        //   Already-present packages are a near-instant no-op. The script runs
        //   against this project's venv so deps accumulate across calls — one
        //   forgotten `numpy` declaration doesn't break a later call that
        //   actually does need it.
        //
        // Node: npm install into the shared node_modules, NODE_PATH at spawn.
        let install_log = if effective_deps.is_empty() {
            String::new()
        } else {
            match language.as_str() {
                "python" => match install_python_deps(&effective_deps).await {
                    Ok(msg) => msg,
                    Err(e) => {
                        return format!(
                            "Error: failed to install dependencies ({}):\n{}",
                            effective_deps.join(", "),
                            e
                        );
                    }
                },
                "javascript" => match install_node_deps(&effective_deps).await {
                    Ok(msg) => msg,
                    Err(e) => {
                        return format!(
                            "Error: failed to install dependencies ({}):\n{}",
                            effective_deps.join(", "),
                            e
                        );
                    }
                },
                _ => String::new(),
            }
        };

        // ── Resolve interpreter ──────────────────────────────────────────
        let (interpreter, prefix_args, script_ext, extra_env) = match resolve_interpreter(&language)
        {
            Ok(v) => v,
            Err(msg) => return msg,
        };

        // ── Prepare artifact directory (per-chat) ────────────────────────
        let base_artifacts = match config::artifacts_dir() {
            Ok(p) => p,
            Err(e) => return format!("Error: cannot resolve artifacts dir: {}", e),
        };
        let artifact_dir = base_artifacts.join(artifact_dir_name_for_chat(
            ctx.conversation_id,
            &exec_uuid,
        ));
        if let Err(e) = std::fs::create_dir_all(&artifact_dir) {
            return format!("Error: failed to create artifact directory: {}", e);
        }

        // Snapshot existing files so we can diff.
        let pre_files: HashSet<PathBuf> = list_files_recursive(&artifact_dir);

        // Write the script as-is. No PEP 723 header injection — deps are
        // handled via the shared uv project, and any leading `# /// script`
        // block the LLM mistakenly added is stripped so uv doesn't re-parse
        // it against the real project's deps.
        let final_code = if language == "python" {
            strip_existing_pep723_header(&code).to_string()
        } else {
            code.clone()
        };

        let script_name = build_script_name(&exec_uuid, script_ext);
        let script_path = artifact_dir.join(&script_name);
        if let Err(e) = std::fs::write(&script_path, &final_code) {
            return format!("Error: failed to write script file: {}", e);
        }

        // ── Spawn process ────────────────────────────────────────────────
        let mut cmd = Command::new(&interpreter);
        for a in &prefix_args {
            cmd.arg(a);
        }
        cmd.arg(&script_path);

        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        cmd.current_dir(&artifact_dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return format!(
                        "Error: '{}' not found on this system. Please install {} and ensure it is on your PATH.\n\nArtifact directory (script preserved): {}",
                        interpreter.display(),
                        language_display_name(&language),
                        artifact_dir.display(),
                    );
                }
                return format!(
                    "Error: failed to spawn process: {}\n\nArtifact directory: {}",
                    e,
                    artifact_dir.display(),
                );
            }
        };

        let exec_result = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            child.wait_with_output(),
        )
        .await;

        let post_files: HashSet<PathBuf> = list_files_recursive(&artifact_dir);
        let mut created: Vec<PathBuf> = post_files
            .difference(&pre_files)
            .filter(|p| p.as_path() != script_path.as_path())
            .cloned()
            .collect();
        created.sort();

        let mut reusable: Vec<PathBuf> = pre_files.iter().cloned().collect();
        reusable.sort();

        match exec_result {
            Ok(Ok(output)) => {
                let exit_code = output.status.code().unwrap_or(-1);
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                format_output(
                    exit_code,
                    &stdout,
                    &stderr,
                    &artifact_dir,
                    &created,
                    &reusable,
                    &install_log,
                )
            }
            Ok(Err(e)) => format!(
                "Error: process failed: {}\n\nArtifact directory: {}",
                e,
                artifact_dir.display()
            ),
            Err(_) => format!(
                "Error: execution timed out after {}ms. The process was killed.\n\nArtifact directory: {}{}",
                timeout_ms,
                artifact_dir.display(),
                format_file_section("Files created during execution", &artifact_dir, &created),
            ),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Artifact naming
// ─────────────────────────────────────────────────────────────────────────

/// When a conversation id is known, all runs land in the same per-chat folder
/// so files are reusable across turns. Otherwise we fall back to a timestamped
/// ad-hoc folder per run.
fn artifact_dir_name_for_chat(conversation_id: Option<&str>, uuid: &uuid::Uuid) -> String {
    if let Some(id) = conversation_id.map(sanitize_for_path).filter(|s| !s.is_empty()) {
        return format!("chat_{}", id);
    }
    let ts = chrono::Local::now().format("%Y-%m-%d--%H%M%S");
    let short = uuid.to_string();
    format!("adhoc_{}_{}", ts, &short[..8])
}

/// Script name format: `YYYY-MM-DD--HHMMSS_<uuid-prefix>.<ext>` — scripts from
/// different runs in the same chat never collide and are easy to order by eye.
fn build_script_name(uuid: &uuid::Uuid, ext: &str) -> String {
    let ts = chrono::Local::now().format("%Y-%m-%d--%H%M%S");
    let short = uuid.to_string();
    format!("{}_{}.{}", ts, &short[..8], ext)
}

fn sanitize_for_path(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c,
            _ => '_',
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────
// Interpreter resolution
// ─────────────────────────────────────────────────────────────────────────

/// Resolve the interpreter binary, the args that go between the interpreter
/// and the script path, the script file extension, and any env vars to set.
fn resolve_interpreter(
    language: &str,
) -> Result<(PathBuf, Vec<String>, &'static str, Vec<(String, String)>), String> {
    match language {
        "python" => {
            // uv is bundled with the app. We run against a persistent project
            // at ~/.kept/runtime/python/ so previously-installed deps carry
            // over between calls — much more forgiving than ephemeral envs
            // when an LLM forgets to declare a dep.
            let project = ensure_python_project()?;
            let args = vec![
                "run".to_string(),
                "--project".to_string(),
                project.to_string_lossy().into_owned(),
                "--quiet".to_string(),
                "python".to_string(),
                "-u".to_string(),
            ];
            let env = vec![("PYTHONUNBUFFERED".to_string(), "1".to_string())];
            Ok((PathBuf::from("uv"), args, "py", env))
        }
        "javascript" => {
            let mut env = Vec::new();
            if let Ok(runtime) = config::runtime_node_dir() {
                let nm = runtime.join("node_modules");
                if nm.exists() {
                    env.push(("NODE_PATH".to_string(), nm.to_string_lossy().into_owned()));
                }
            }
            Ok((PathBuf::from("node"), Vec::new(), "mjs", env))
        }
        "bash" | "shell" => {
            if cfg!(windows) {
                Ok((
                    PathBuf::from("cmd.exe"),
                    vec!["/C".to_string()],
                    "bat",
                    Vec::new(),
                ))
            } else {
                Ok((PathBuf::from("sh"), Vec::new(), "sh", Vec::new()))
            }
        }
        _ => Err(format!(
            "Error: unsupported language '{}'. Supported: python, javascript, bash/shell.",
            language
        )),
    }
}

fn language_display_name(language: &str) -> &'static str {
    match language {
        "python" => "Python (via uv)",
        "javascript" => "Node.js",
        "bash" | "shell" => "a shell interpreter",
        _ => "the required runtime",
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Shared uv project + dependency install
// ─────────────────────────────────────────────────────────────────────────

/// Minimal pyproject.toml written when the shared uv project is bootstrapped.
const DEFAULT_PYPROJECT: &str = r#"[project]
name = "kept-runtime"
version = "0.1.0"
description = "Shared Python environment for Kept's code-execution tool."
requires-python = ">=3.8"
dependencies = []
"#;

/// Ensure the shared uv project directory exists (pyproject.toml present).
/// Returns the project directory path.
fn ensure_python_project() -> Result<PathBuf, String> {
    let runtime = config::runtime_python_dir()?;
    std::fs::create_dir_all(&runtime)
        .map_err(|e| format!("failed to create python runtime dir: {}", e))?;
    let pyproject = runtime.join("pyproject.toml");
    if !pyproject.exists() {
        std::fs::write(&pyproject, DEFAULT_PYPROJECT)
            .map_err(|e| format!("failed to write pyproject.toml: {}", e))?;
    }
    Ok(runtime)
}

/// Add a list of packages to the shared uv project.
///
/// `uv add --project <dir> <pkgs...>` is idempotent: already-present packages
/// are a fast no-op; new ones update pyproject + uv.lock and sync .venv/.
async fn install_python_deps(deps: &[String]) -> Result<String, String> {
    let project = ensure_python_project()?;

    let mut cmd = Command::new("uv");
    cmd.arg("add")
        .arg("--project")
        .arg(&project)
        .arg("--quiet");
    for d in deps {
        cmd.arg(d);
    }

    let output = tokio::time::timeout(Duration::from_secs(DEP_INSTALL_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "uv add timed out".to_string())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "`uv` not found on PATH (expected bundled with Kept)".to_string()
            } else {
                format!("failed to run uv: {}", e)
            }
        })?;

    if !output.status.success() {
        return Err(format!(
            "uv add failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(format!("Installed/verified via uv: {}", deps.join(", ")))
}

/// If `code` begins with a PEP 723 `# /// script` block, return the code with
/// that block (and any following blank line) removed. Otherwise return `code`
/// unchanged.
fn strip_existing_pep723_header(code: &str) -> &str {
    let trimmed = code.trim_start_matches('\u{FEFF}');
    if !trimmed.trim_start().starts_with("# /// script") {
        return code;
    }
    // Find the closing `# ///` marker line, then skip past it.
    let mut in_block = false;
    let mut end_byte: Option<usize> = None;
    let mut cursor = 0usize;
    for line in trimmed.split_inclusive('\n') {
        let l = line.trim_end_matches(['\n', '\r']).trim_start();
        if !in_block && l.starts_with("# /// script") {
            in_block = true;
        } else if in_block && l == "# ///" {
            end_byte = Some(cursor + line.len());
            break;
        }
        cursor += line.len();
    }
    match end_byte {
        Some(end) => {
            // Also skip a single blank line after the closing marker if present.
            let rest = &trimmed[end..];
            if let Some(stripped) = rest.strip_prefix('\n') {
                stripped
            } else {
                rest
            }
        }
        None => code,
    }
}

/// Install npm packages into the shared node runtime. Idempotent; already
/// present packages are fast no-ops.
async fn install_node_deps(deps: &[String]) -> Result<String, String> {
    let runtime = config::runtime_node_dir()?;
    std::fs::create_dir_all(&runtime)
        .map_err(|e| format!("failed to create node runtime dir: {}", e))?;

    let pkg_json = runtime.join("package.json");
    if !pkg_json.exists() {
        std::fs::write(
            &pkg_json,
            r#"{"name":"kept-runtime","private":true,"type":"module","dependencies":{}}"#,
        )
        .map_err(|e| format!("failed to write package.json: {}", e))?;
    }

    let mut cmd = Command::new("npm");
    cmd.arg("install")
        .arg("--silent")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--save");
    for d in deps {
        cmd.arg(d);
    }
    cmd.current_dir(&runtime);

    let output = tokio::time::timeout(Duration::from_secs(DEP_INSTALL_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "npm install timed out".to_string())?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "`npm` not found on PATH. Install Node.js to use npm dependencies.".to_string()
            } else {
                format!("failed to run npm: {}", e)
            }
        })?;

    if !output.status.success() {
        return Err(format!(
            "npm install failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(format!(
        "Installed/verified npm dependencies: {}",
        deps.join(", ")
    ))
}

// ─────────────────────────────────────────────────────────────────────────
// File diffing + output formatting
// ─────────────────────────────────────────────────────────────────────────

fn list_files_recursive(root: &Path) -> HashSet<PathBuf> {
    let mut out = HashSet::new();
    walk(root, &mut out);
    out
}

fn walk(path: &Path, out: &mut HashSet<PathBuf>) {
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk(&p, out),
            Ok(ft) if ft.is_file() => {
                out.insert(p);
            }
            _ => {}
        }
    }
}

/// Scan stderr for well-known "missing package" errors (Python
/// ModuleNotFoundError / ImportError, Node "Cannot find module") and return a
/// short, targeted hint telling the model exactly how to fix the call.
fn detect_missing_dep_hint(stderr: &str) -> Option<String> {
    // Python: `ModuleNotFoundError: No module named 'foo'`
    //         `ImportError: No module named 'foo'`
    for line in stderr.lines() {
        let t = line.trim();
        for prefix in [
            "ModuleNotFoundError: No module named '",
            "ImportError: No module named '",
        ] {
            if let Some(rest) = t.strip_prefix(prefix) {
                if let Some(end) = rest.find('\'') {
                    let name = &rest[..end];
                    // Take the top-level package (matplotlib.pyplot -> matplotlib)
                    let pkg = name.split('.').next().unwrap_or(name);
                    return Some(format!(
                        "HINT: import failed because `{pkg}` is not available. Retry \
                         the same execute_code call with `dependencies: [\"{pkg}\"]` \
                         (add any other non-stdlib imports from the script too).",
                        pkg = pkg
                    ));
                }
            }
        }
    }
    // Node: `Error: Cannot find module 'foo'`
    //       `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'foo'`
    for line in stderr.lines() {
        let t = line.trim();
        for prefix in [
            "Error: Cannot find module '",
            "Cannot find module '",
            "Cannot find package '",
        ] {
            if let Some(rest) = t.strip_prefix(prefix) {
                if let Some(end) = rest.find('\'') {
                    let pkg = &rest[..end];
                    // Skip relative/absolute paths — those are not installable packages.
                    if pkg.starts_with('.') || pkg.starts_with('/') || pkg.contains(':') {
                        continue;
                    }
                    return Some(format!(
                        "HINT: `require`/`import` failed because `{pkg}` is not installed. \
                         Retry the same execute_code call with `dependencies: [\"{pkg}\"]` \
                         (add any other non-stdlib imports from the script too).",
                        pkg = pkg
                    ));
                }
            }
        }
    }
    None
}

fn format_file_section(header: &str, artifact_dir: &Path, files: &[PathBuf]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut s = format!("\n\n{}:", header);
    for f in files {
        let rel = f.strip_prefix(artifact_dir).unwrap_or(f);
        s.push_str(&format!("\n  - {}", rel.display()));
    }
    s
}

fn format_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    artifact_dir: &Path,
    created: &[PathBuf],
    reusable: &[PathBuf],
    install_log: &str,
) -> String {
    let mut out = format!("[exit code: {}]", exit_code);

    let stdout = stdout.trim();
    let stderr = stderr.trim();

    if !stdout.is_empty() {
        out.push_str("\n\n");
        out.push_str(stdout);
    }
    if !stderr.is_empty() {
        out.push_str("\n\n--- stderr ---\n");
        out.push_str(stderr);
    }
    if stdout.is_empty() && stderr.is_empty() {
        out.push_str("\n\n(no output)");
    }

    // Spot common failure modes and nudge the LLM toward the exact fix so it
    // doesn't have to guess and burn another user approval.
    if exit_code != 0 {
        if let Some(hint) = detect_missing_dep_hint(stderr) {
            out.push_str("\n\n");
            out.push_str(&hint);
        }
    }

    if !install_log.is_empty() {
        out.push_str("\n\n");
        out.push_str(install_log);
    }

    out.push_str(&format!("\n\nArtifact directory: {}", artifact_dir.display()));
    out.push_str(&format_file_section(
        "Files created during execution",
        artifact_dir,
        created,
    ));
    out.push_str(&format_file_section(
        "Reusable files from earlier runs in this chat",
        artifact_dir,
        reusable,
    ));

    if out.len() > MAX_OUTPUT_BYTES {
        out.truncate(MAX_OUTPUT_BYTES);
        out.push_str("\n\n[output truncated at 256KB]");
    }

    out
}
