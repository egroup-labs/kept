export interface ConversationMeta {
  id: number;
  conversation_id: string;
  platform: string;
  title: string;
  model: string | null;
  message_count: number;
  file_path: string;
  content_hash: string;
  created_at: string | null;
  updated_at: string | null;
  indexed_at: string;
  preview: string | null;
}

export interface VaultNode {
  name: string;
  title?: string;
  updated_at?: string | null;
  path: string | null;
  is_dir: boolean;
  children: VaultNode[];
}

export interface SearchResult {
  conversation_id: string;
  platform: string;
  title: string;
  file_path: string;
  snippet: string;
  role: string;
  rank: number;
}

export interface Attachment {
  media_type: string;
  data: string;
  filename?: string;
}

export interface ChatAttachment {
  media_type: string;
  data: string;
  filename?: string;
  preview?: string;
  filePath?: string;
}

export interface ObsidianValidation {
  exists: boolean;
  is_vault: boolean;
}

export interface ObsidianExportResult {
  files_copied: number;
  duration_ms: number;
}

export interface Message {
  role: string;
  content: string;
  timestamp: string | null;
  attachments?: Attachment[];
}

export interface TitleRequest {
  platform: string;
  model: string;
  message: string;
}

export interface ModelEntry {
  provider: string;
  model: string;
}

export interface AvailableModel {
  id: string;
  provider: string;
  display_name?: string | null;
  owned_by?: string | null;
}

export interface ProviderStatus {
  provider: string;
  available: boolean;
}

export interface AppConfig {
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  openrouter_api_key: string | null;
  auto_launch: boolean | null;
  dark_mode: boolean | null;
  ollama_model: string | null;
  ollama_embed_model: string | null;
  privacy_mode: string | null;
  claude_scan_paths: string[] | null;
  claude_pinned_projects: string[] | null;
  claude_templates: ClaudeTemplate[] | null;
  model_assignments: Record<string, ModelEntry[]> | null;
  primary_provider: string | null;
  kb_paths: string[] | null;
  fs_allowed_paths: string[] | null;
  obsidian_vault_path: string | null;
  obsidian_auto_sync: boolean | null;
  obsidian_last_sync_at: string | null;
}

export interface KbFileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
}

export interface AgentMessage {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  attachments?: Attachment[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecution {
  tool_name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface AgentChatRequest {
  platform: string;
  model: string;
  messages: AgentMessage[];
  event_channel?: string;
  conversation_id?: string;
}

export interface AgentChatResponse {
  content: string;
  tool_executions: ToolExecution[];
  iterations: number;
}

export interface IngestPayload {
  conversation_id: string;
  platform: string;
  title: string;
  model: string | null;
  messages: Message[];
  created_at: string | null;
  updated_at: string | null;
  markdown: string | null;
  images: null;
}

export interface VaultConversationIngested {
  conversation_id: string;
  platform: string;
  title: string;
  file_path: string;
  skipped: boolean;
}

export interface ExtensionStatus {
  connected: boolean;
  last_seen_ms: number | null;
}

export interface VaultStats {
  conversations_bytes: number;
  assets_bytes: number;
  database_bytes: number;
  kg_bytes: number;
  conversation_count: number;
  asset_count: number;
}

export interface AgentProgress {
  stage: 'thinking' | 'reasoning_delta' | 'message_delta' | 'tool_call' | 'tool_result' | 'done';
  tool_name?: string;
  iteration: number;
  content_delta?: string;
  reasoning_delta?: string;
  conversation_id?: string;
}

export type View = 'vault' | 'chat' | 'settings' | 'knowledge' | 'projects' | 'claude';

// ── Knowledge Graph types ─────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  node_type: 'conversation' | 'provider' | 'project' | 'entity' | 'topic';
  frequency?: number;
  file_path?: string;
  platform?: string;
  /** Alternative names merged into this entity during deduplication */
  synonyms?: string[];
  /** Number of distinct entity neighbors connected via triples */
  neighbor_count?: number;
  /** Number of distinct conversation threads this entity is mentioned in */
  thread_count?: number;
  /** Semantic type: technology, person, concept, method, tool, framework, etc. */
  entity_type?: string;
  /** Description text (used for project nodes) */
  description?: string;
  /** Development phase: ideation, design, implementation, debugging, review, exploration */
  phase?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface KeywordEntry {
  term: string;
  /** "title" or "user_message" */
  source: string;
  /** Raw count in this conversation */
  count: number;
  /** TF-IDF score */
  tfidf: number;
}

export interface ConversationKeywords {
  conv_id: string;
  title: string;
  platform: string;
  keywords: KeywordEntry[];
  /** Individual user prompts, one per turn, in conversation order. */
  user_prompts: string[];
}

export interface Topic {
  id: string;
  name: string;
  /** 3-5 sentence description of what this topic covers */
  description: string;
  /** Agent-generated search terms for this topic */
  keywords: string[];
}

export interface KgStats {
  entity_count: number;
  triple_count: number;
  conversation_count: number;
  project_count: number;
  /** Top entities by frequency: [name, count] */
  top_entities: [string, number][];
}

export interface ProjectConversation {
  conv_id: string;
  file_path: string;
  phase: string;
  order: number;
}

export interface ProjectData {
  id: string;
  name: string;
  description: string;
  conversation_count: number;
  conversations: ProjectConversation[];
}

export interface ConversationRecommendation {
  conversation_id: string;
  file_path: string;
  title: string;
  reason: string;
}

export interface SuggestProjectResponse {
  recommendations: ConversationRecommendation[];
  summary: string;
}

export interface KgIndexLog {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DigestData {
  content: string;
  generated_at: string;
  from_cache: boolean;
}

export interface DigestItem {
  conversation_id: string;
  platform: string;
  title: string;
  model: string | null;
  message_count: number;
  file_path: string;
  preview: string | null;
  updated_at: string | null;
  created_at: string | null;
  status: 'active' | 'dismissed' | 'snoozed';
  reason: 'stale' | 'unfinished' | 'low_messages';
  summary: string | null;
  last_role: string | null;
  days_inactive: number | null;
  snoozed_until: string | null;
  /** Project linked to this conversation, if any */
  project_id: string | null;
  project_name: string | null;
  /** LLM-guessed project name (only meaningful when project_id is null) */
  project_hint: string | null;
  /** Extracted topic keywords (small tags for display) */
  key_topics: string[] | null;
  /** LLM judgment: null=unsummarized, true=unresolved, false=resolved (hidden) */
  is_unresolved: boolean | null;
  /** LLM-authored reason this needs attention; replaces the reason badge when set */
  attention_reason: string | null;
  /** ISO timestamp when the user first saw this card; null = still new */
  seen_at: string | null;
  /** Vault-wide KG topics this conversation belongs to (broader than key_topics) */
  topics: string[] | null;
}

export interface SuggestedProject {
  suggested_name: string;
  suggested_description: string;
  conversation_ids: string[];
  conversation_titles: string[];
}

// ── Claude Code Manager types ───────────────────────────────────────────────

export interface ClaudeProject {
  name: string;
  path: string;
  is_global: boolean;
  has_claude_md: boolean;
  has_dot_claude_md: boolean;
  has_settings: boolean;
  skill_count: number;
  memory_file_count: number;
}

export interface ClaudeFile {
  name: string;
  relative_path: string;
  content: string;
  size: number;
  modified: string | null;
}

export interface ClaudeSkill {
  filename: string;
  name: string | null;
  description: string | null;
  content: string;
}

export interface ClaudeScanConfig {
  scan_paths: string[];
  pinned_projects: string[];
}

export interface ClaudeSkillWithProject {
  project_name: string;
  project_path: string;
  skill: ClaudeSkill;
}

export interface ClaudeFileWithProject {
  project_name: string;
  project_path: string;
  file: ClaudeFile;
}

export interface ClaudeTemplate {
  name: string;
  entries: ClaudeTemplateEntry[];
}

export interface ClaudeTemplateEntry {
  source_project: string;
  relative_path: string;
}
