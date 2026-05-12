use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Payload for the code execution consent request event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeExecConsentRequest {
    pub request_id: String,
    pub language: String,
    pub code: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

/// Image payload from the extension (base64-encoded)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePayload {
    pub filename: String,
    pub base64_data: String,
    pub content_type: String,
}

/// Incoming conversation from the extension
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestPayload {
    pub conversation_id: String,
    pub platform: String,
    pub title: String,
    pub model: Option<String>,
    pub messages: Vec<Message>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Pre-rendered markdown from the extension (optional).
    /// If provided, we save it directly; otherwise we render from messages.
    pub markdown: Option<String>,
    #[serde(default)]
    pub images: Option<Vec<ImagePayload>>,
}

/// An attachment (image, PDF, etc.) sent with a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    /// MIME type, e.g. "image/png", "application/pdf"
    pub media_type: String,
    /// Base64-encoded file data
    pub data: String,
    /// Original filename (for display)
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallRecord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRecord {
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Stored conversation metadata (from DB)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMeta {
    pub id: i64,
    pub conversation_id: String,
    pub platform: String,
    pub title: String,
    pub model: Option<String>,
    pub message_count: i64,
    pub file_path: String,
    pub content_hash: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub indexed_at: String,
    pub preview: Option<String>,
}

/// Vault tree node for the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultNode {
    pub name: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub path: Option<String>,
    pub is_dir: bool,
    pub children: Vec<VaultNode>,
}

/// Search result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub conversation_id: String,
    pub platform: String,
    pub title: String,
    pub file_path: String,
    pub snippet: String,
    pub role: String,
    pub rank: f64,
}

/// Request to generate a short chat title from the first user message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitleRequest {
    pub platform: String,
    pub model: String,
    pub message: String,
}

/// A model assigned to a task, with provider identification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub provider: String,
    pub model: String,
}

/// A model returned from a provider model listing endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableModel {
    pub id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

/// Provider availability status returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub provider: String,
    pub available: bool,
}

/// App configuration stored in config.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub anthropic_api_key: Option<String>,
    #[serde(default)]
    pub auto_launch: Option<bool>,
    #[serde(default)]
    pub dark_mode: Option<bool>,
    #[serde(default)]
    pub openrouter_api_key: Option<String>,
    /// Ollama model used for KG extraction (default: gemma3:1b)
    #[serde(default)]
    pub ollama_model: Option<String>,
    /// Ollama model used for embedding-based entity deduplication (default: nomic-embed-text)
    #[serde(default)]
    pub ollama_embed_model: Option<String>,
    /// Operating mode: "flexible" or "restricted"
    #[serde(default)]
    pub privacy_mode: Option<String>,
    /// Directories to scan for Claude Code projects
    #[serde(default)]
    pub claude_scan_paths: Option<Vec<String>>,
    /// Manually pinned Claude Code project paths
    #[serde(default)]
    pub claude_pinned_projects: Option<Vec<String>>,
    /// Saved Claude file templates
    #[serde(default)]
    pub claude_templates: Option<Vec<ClaudeTemplate>>,
    /// Model assignments per task: maps task key to ordered list of models.
    /// Keys: "agentic", "chat", "kg_extraction", "embeddings"
    #[serde(default)]
    pub model_assignments: Option<HashMap<String, Vec<ModelEntry>>>,
    /// Primary provider slug (e.g. "openai", "anthropic", "openrouter")
    #[serde(default)]
    pub primary_provider: Option<String>,
    /// File/directory paths added to the knowledge base (originals, not copies)
    #[serde(default)]
    pub kb_paths: Option<Vec<String>>,
    /// Filesystem paths the agent is allowed to read/list
    #[serde(default)]
    pub fs_allowed_paths: Option<Vec<String>>,
    /// Whether the weekly auto-summarize pass for the Digest is enabled (default true)
    #[serde(default)]
    pub digest_auto_summarize: Option<bool>,
    /// ISO timestamp (RFC3339) of the last automatic digest summary run
    #[serde(default)]
    pub last_digest_auto_run: Option<String>,
    /// Minimum interval between automatic digest batch promotions, in minutes.
    /// Default: 10080 (7 days). Set to a small value (e.g. 5) in config.toml to
    /// speed up manual testing. Refresh button bypasses this gate entirely.
    #[serde(default)]
    pub digest_auto_run_interval_minutes: Option<i64>,
    /// Path to the user's Obsidian vault for Export to Obsidian feature.
    /// Pre-fills the input in Settings → General → Export to Obsidian.
    #[serde(default)]
    pub obsidian_vault_path: Option<String>,
    /// When true, ingested conversations are automatically synced to the
    /// Obsidian vault (debounced). Treated as enabled by default once an
    /// `obsidian_vault_path` is configured.
    #[serde(default)]
    pub obsidian_auto_sync: Option<bool>,
    /// RFC3339 timestamp of the last successful Obsidian export (manual or auto).
    #[serde(default)]
    pub obsidian_last_sync_at: Option<String>,
    /// When true, the idle digest summarizer is paused and will not call any
    /// LLM provider until the user explicitly resumes it via
    /// `cmd_resume_idle_summarizer`. Set automatically after a sustained
    /// failure window (see `idle_summarizer_auto_halt_days`) so a misconfigured
    /// or rate-limited API key can't keep draining credit while the app is
    /// unattended. Treat None as "not halted".
    #[serde(default)]
    pub idle_summarizer_halted: Option<bool>,
    /// RFC3339 timestamp of when the idle summarizer was last auto-halted.
    /// Surfaced to the UI so users can see *why* the summarizer stopped.
    #[serde(default)]
    pub idle_summarizer_halted_at: Option<String>,
    /// Number of days of all-failing ticks before auto-halt triggers.
    /// Default 3. Set to 0 to disable auto-halt entirely (not recommended).
    #[serde(default)]
    pub idle_summarizer_auto_halt_days: Option<i64>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut model_assignments = HashMap::new();
        model_assignments.insert(
            "chat".to_string(),
            vec![ModelEntry {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            }],
        );
        model_assignments.insert(
            "agentic".to_string(),
            vec![ModelEntry {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            }],
        );
        model_assignments.insert(
            "kg_extraction".to_string(),
            vec![ModelEntry {
                provider: "ollama".to_string(),
                model: "gemma3:1b".to_string(),
            }],
        );
        model_assignments.insert(
            "embeddings".to_string(),
            vec![ModelEntry {
                provider: "ollama".to_string(),
                model: "nomic-embed-text".to_string(),
            }],
        );

        Self {
            openai_api_key: None,
            anthropic_api_key: None,
            auto_launch: None,
            dark_mode: None,
            openrouter_api_key: None,
            ollama_model: None,
            ollama_embed_model: None,
            privacy_mode: None,
            claude_scan_paths: None,
            claude_pinned_projects: None,
            claude_templates: None,
            model_assignments: Some(model_assignments),
            primary_provider: None,
            kb_paths: None,
            fs_allowed_paths: dirs::home_dir().map(|h| vec![h.to_string_lossy().to_string()]),
            idle_summarizer_halted: None,
            idle_summarizer_halted_at: None,
            idle_summarizer_auto_halt_days: None,
            digest_auto_summarize: None,
            last_digest_auto_run: None,
            digest_auto_run_interval_minutes: None,
            obsidian_vault_path: None,
            obsidian_auto_sync: None,
            obsidian_last_sync_at: None,
        }
    }
}

/// A file entry from the knowledge base
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbFileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

/// Ingest response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestResponse {
    pub status: String,
    pub file_path: String,
    pub skipped: bool,
}

/// Event emitted after the extension ingests a conversation into the vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultConversationIngested {
    pub conversation_id: String,
    pub platform: String,
    pub title: String,
    pub file_path: String,
    pub skipped: bool,
}

/// Extension connection status (derived from ping timestamps)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionStatus {
    pub connected: bool,
    pub last_seen_ms: Option<u64>,
}

/// Agent chat request (Kept)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChatRequest {
    pub platform: String,
    pub model: String,
    pub messages: Vec<AgentMessage>,
    /// Event channel name for progress events. Defaults to "agent-progress".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_channel: Option<String>,
    /// Conversation id — used by tools that want per-chat state (e.g. code
    /// execution artifacts all land in the same folder for a given chat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

/// A message in the agent conversation (supports tool calls)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

/// A tool call from the LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Record of a tool execution for the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecution {
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub result: String,
}

/// Agent chat response (Kept)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChatResponse {
    pub content: String,
    pub tool_executions: Vec<ToolExecution>,
    pub iterations: u32,
}

/// Progress event emitted during agent loop
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProgress {
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_arguments: Option<serde_json::Value>,
    pub iteration: u32,
}

/// Vault storage statistics for the settings page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStats {
    /// Total size of all conversation markdown files in bytes.
    pub conversations_bytes: u64,
    /// Total size of asset files (images, etc.) in bytes.
    pub assets_bytes: u64,
    /// SQLite database size in bytes.
    pub database_bytes: u64,
    /// Knowledge graph database size in bytes.
    pub kg_bytes: u64,
    /// Number of conversation files.
    pub conversation_count: u64,
    /// Number of asset files.
    pub asset_count: u64,
}

// ── Knowledge Graph types ─────────────────────────────────────────────────────

/// A node in the knowledge graph (conversation, provider, or project).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    /// "conversation", "provider", "project", or "entity"
    pub node_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// Alternative names merged into this entity during deduplication.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synonyms: Option<Vec<String>>,
    /// Number of distinct entity neighbors (other entities connected via triples).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub neighbor_count: Option<i64>,
    /// Number of distinct conversation threads this entity is mentioned in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_count: Option<i64>,
    /// Semantic type of the entity (technology, person, concept, method, tool, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    /// Description text (used for project nodes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Development phase: ideation, design, implementation, debugging, review, exploration.
    /// Used for conversation nodes within a project context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

/// A directed edge in the knowledge graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub relation: String,
    pub weight: i64,
}

/// A subgraph (nodes + edges) returned to the frontend for D3 rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Aggregate statistics about the knowledge graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KgStats {
    pub entity_count: i64,
    pub triple_count: i64,
    pub conversation_count: i64,
    pub project_count: i64,
    /// Top entities by frequency: (name, frequency)
    pub top_entities: Vec<(String, i64)>,
}

/// A conversation recommendation from the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationRecommendation {
    pub conversation_id: String,
    pub file_path: String,
    pub title: String,
    pub reason: String,
}

/// Response from the project suggestion agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestProjectResponse {
    pub recommendations: Vec<ConversationRecommendation>,
    pub summary: String,
}

/// Digest response returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestData {
    /// Markdown content of the digest (LLM-generated)
    pub content: String,
    /// ISO timestamp of when digest was generated
    pub generated_at: String,
    /// Whether this was served from cache
    pub from_cache: bool,
}

/// A digest item representing an unfinished/stale conversation surfaced for user review.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestItem {
    pub conversation_id: String,
    pub platform: String,
    pub title: String,
    pub model: Option<String>,
    pub message_count: i64,
    pub file_path: String,
    pub preview: Option<String>,
    pub updated_at: Option<String>,
    pub created_at: Option<String>,
    /// "active", "dismissed", "snoozed"
    pub status: String,
    /// Why this was flagged: "stale", "unfinished", "low_messages"
    pub reason: String,
    /// LLM-generated summary (optional)
    pub summary: Option<String>,
    /// Last message role at detection time
    pub last_role: Option<String>,
    /// Days since last activity
    pub days_inactive: Option<i64>,
    /// ISO timestamp: hidden until this time if snoozed
    pub snoozed_until: Option<String>,
    /// Project ID this conversation is linked to (if any)
    pub project_id: Option<String>,
    /// Project name (denormalized for display)
    pub project_name: Option<String>,
    /// LLM-guessed project name (unused if project_id is set)
    pub project_hint: Option<String>,
    /// LLM-extracted key topics/keywords (e.g. ["embeddings", "RAG", "postgres"])
    pub key_topics: Option<Vec<String>>,
    /// LLM judgment: does this conversation still need attention? None = not yet summarized.
    pub is_unresolved: Option<bool>,
    /// LLM-authored explanation of WHY this needs attention (human-readable).
    pub attention_reason: Option<String>,
    /// ISO timestamp when the user first saw this card. None = new/unseen.
    pub seen_at: Option<String>,
    /// Vault-wide KG topics this conversation belongs to (broader than key_topics).
    pub topics: Option<Vec<String>>,
}

/// A cluster of related conversations proposed as a new project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestedProject {
    /// Proposed project name (derived from shared project_hint)
    pub suggested_name: String,
    /// Short description auto-generated from topics/summaries
    pub suggested_description: String,
    /// Conversation IDs that would be grouped
    pub conversation_ids: Vec<String>,
    /// Titles (denormalized for display in the banner)
    pub conversation_titles: Vec<String>,
}

// ── Claude Code Manager types ────────────────────────────────────────────────

/// A discovered Claude Code project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeProject {
    pub name: String,
    pub path: String,
    pub is_global: bool,
    pub has_claude_md: bool,
    pub has_dot_claude_md: bool,
    pub has_settings: bool,
    pub skill_count: u32,
    pub memory_file_count: u32,
}

/// A file within a Claude Code project (CLAUDE.md, memory file, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeFile {
    pub name: String,
    pub relative_path: String,
    pub content: String,
    pub size: u64,
    pub modified: Option<String>,
}

/// A skill (custom command) in .claude/commands/
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSkill {
    pub filename: String,
    /// Parsed from frontmatter `name:` field
    pub name: Option<String>,
    /// Parsed from frontmatter `description:` field
    pub description: Option<String>,
    pub content: String,
}

/// Scan paths configuration for Claude project discovery
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeScanConfig {
    pub scan_paths: Vec<String>,
    pub pinned_projects: Vec<String>,
}

/// A skill annotated with its source project (for cross-project browser).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSkillWithProject {
    pub project_name: String,
    pub project_path: String,
    pub skill: ClaudeSkill,
}

/// A file annotated with its source project (for cross-project browser).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeFileWithProject {
    pub project_name: String,
    pub project_path: String,
    pub file: ClaudeFile,
}

/// A reusable template of skills/memory files that can be applied to projects.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeTemplate {
    pub name: String,
    pub entries: Vec<ClaudeTemplateEntry>,
}

/// One entry in a template — references a file in a source project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeTemplateEntry {
    pub source_project: String,
    pub relative_path: String,
}
