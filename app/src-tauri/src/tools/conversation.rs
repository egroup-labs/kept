use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};
use crate::vault;

const MAX_READ_CHARS: usize = 30_000;

/// Strip HTML tags (< > pairs) and replace literal `\n` sequences with spaces.
fn clean_snippet(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            out.push(ch);
        }
    }
    out.replace("\\n", " ")
}

pub fn register() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "search_conversations",
            description: "Full-text search across all archived conversations. Returns matching conversation titles, snippets, and file paths. Use FTS5 query syntax: simple words are OR'd by default, use quotes for phrases.",
            parameters: vec![
                ParamDef {
                    name: "query",
                    param_type: ParamType::String,
                    description: "The search query (FTS5 syntax)",
                    required: true,
                },
                ParamDef {
                    name: "limit",
                    param_type: ParamType::Integer,
                    description: "Maximum number of results (default 20)",
                    required: false,
                },
            ],
            handler: Box::new(SearchConversations),
        },
        ToolDef {
            name: "read_conversation",
            description: "Read the full markdown content of a specific conversation by its file path. Use this after searching to read conversations in detail.",
            parameters: vec![
                ParamDef {
                    name: "file_path",
                    param_type: ParamType::String,
                    description: "The file path of the conversation to read",
                    required: true,
                },
            ],
            handler: Box::new(ReadConversation),
        },
        ToolDef {
            name: "list_conversations",
            description: "List all archived conversations with metadata (title, platform, model, date, message count). Optionally filter by platform.",
            parameters: vec![
                ParamDef {
                    name: "platform",
                    param_type: ParamType::String,
                    description: "Optional: filter by 'chatgpt', 'claude', or 'gemini'. Leave empty or omit to list ALL conversations.",
                    required: false,
                },
            ],
            handler: Box::new(ListConversations),
        },
        ToolDef {
            name: "recommend_conversation",
            description: "Recommend a conversation to link to the project. Call this for each relevant conversation you find.",
            parameters: vec![
                ParamDef {
                    name: "file_path",
                    param_type: ParamType::String,
                    description: "File path of the conversation",
                    required: true,
                },
                ParamDef {
                    name: "title",
                    param_type: ParamType::String,
                    description: "Title of the conversation",
                    required: true,
                },
                ParamDef {
                    name: "reason",
                    param_type: ParamType::String,
                    description: "Brief reason why this conversation is relevant",
                    required: true,
                },
            ],
            handler: Box::new(RecommendConversation),
        },
    ]
}

struct SearchConversations;

#[async_trait::async_trait]
impl ToolHandler for SearchConversations {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let query = args["query"].as_str().unwrap_or("");
        let limit = args["limit"].as_i64().unwrap_or(20);
        match ctx.db.search(query, limit) {
            Ok(results) => {
                if results.is_empty() {
                    "No conversations found matching that query.".to_string()
                } else {
                    let items: Vec<serde_json::Value> = results
                        .iter()
                        .map(|r| {
                            serde_json::json!({
                                "title": r.title,
                                "platform": r.platform,
                                "file_path": r.file_path,
                                "snippet": clean_snippet(&r.snippet),
                                "role": r.role,
                            })
                        })
                        .collect();
                    serde_json::to_string_pretty(&items).unwrap_or_default()
                }
            }
            Err(e) => format!(
                "Search error: {}. Try simplifying your query — avoid special characters.",
                e
            ),
        }
    }
}

struct ReadConversation;

#[async_trait::async_trait]
impl ToolHandler for ReadConversation {
    async fn run(&self, _ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let file_path = args["file_path"].as_str().unwrap_or("");
        match vault::read_conversation(file_path) {
            Ok(content) => {
                if content.len() > MAX_READ_CHARS {
                    let truncated = &content[..MAX_READ_CHARS];
                    format!(
                        "{}\n\n[... truncated at {} characters]",
                        truncated, MAX_READ_CHARS
                    )
                } else {
                    content
                }
            }
            Err(e) => format!("Error reading conversation: {}", e),
        }
    }
}

struct RecommendConversation;

#[async_trait::async_trait]
impl ToolHandler for RecommendConversation {
    async fn run(&self, _ctx: &ToolContext<'_>, _args: &serde_json::Value) -> String {
        unreachable!(
            "recommend_conversation is a definition-only tool intercepted by cmd_suggest_project_conversations"
        )
    }
}

struct ListConversations;

#[async_trait::async_trait]
impl ToolHandler for ListConversations {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let platform = args
            .get("platform")
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty() && *p != "all" && *p != "any");
        match ctx.db.list_conversations(platform) {
            Ok(convs) => {
                if convs.is_empty() {
                    "No conversations found in the vault.".to_string()
                } else {
                    let items: Vec<serde_json::Value> = convs
                        .iter()
                        .map(|c| {
                            serde_json::json!({
                                "title": c.title,
                                "platform": c.platform,
                                "model": c.model,
                                "message_count": c.message_count,
                                "created_at": c.created_at,
                                "file_path": c.file_path,
                            })
                        })
                        .collect();
                    serde_json::to_string_pretty(&items).unwrap_or_default()
                }
            }
            Err(e) => format!("Error listing conversations: {}", e),
        }
    }
}
