use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};

pub fn register() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_knowledge_files",
            description: "List all files and directories in the user's knowledge base. Returns file names, paths, sizes, and whether each entry is a directory.",
            parameters: vec![],
            handler: Box::new(ListKnowledgeFiles),
        },
        ToolDef {
            name: "read_knowledge_file",
            description: "Read the full text content of a file from the knowledge base. Use list_knowledge_files first to discover available files.",
            parameters: vec![
                ParamDef {
                    name: "path",
                    param_type: ParamType::String,
                    description: "Full path to the file to read",
                    required: true,
                },
            ],
            handler: Box::new(ReadKnowledgeFile),
        },
        ToolDef {
            name: "search_knowledge_files",
            description: "Case-insensitive text search across all knowledge base files. Returns matching lines with file path, line number, and content.",
            parameters: vec![
                ParamDef {
                    name: "query",
                    param_type: ParamType::String,
                    description: "Text to search for",
                    required: true,
                },
                ParamDef {
                    name: "max_results",
                    param_type: ParamType::Integer,
                    description: "Maximum matching lines to return (default 50)",
                    required: false,
                },
            ],
            handler: Box::new(SearchKnowledgeFiles),
        },
        ToolDef {
            name: "grep_knowledge_files",
            description: "Search knowledge base files using a regex pattern. Optionally scope to a single file. Returns matching lines with file path and line number.",
            parameters: vec![
                ParamDef {
                    name: "pattern",
                    param_type: ParamType::String,
                    description: "Regex pattern to match",
                    required: true,
                },
                ParamDef {
                    name: "file_path",
                    param_type: ParamType::String,
                    description: "Optional: scope search to this file path",
                    required: false,
                },
            ],
            handler: Box::new(GrepKnowledgeFiles),
        },
    ]
}

struct ListKnowledgeFiles;

#[async_trait::async_trait]
impl ToolHandler for ListKnowledgeFiles {
    async fn run(&self, _ctx: &ToolContext<'_>, _args: &serde_json::Value) -> String {
        match crate::commands::cmd_kb_list_files() {
            Ok(files) => serde_json::to_string_pretty(&files).unwrap_or_default(),
            Err(e) => format!("Error listing files: {e}"),
        }
    }
}

struct ReadKnowledgeFile;

#[async_trait::async_trait]
impl ToolHandler for ReadKnowledgeFile {
    async fn run(&self, _ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let path = args["path"].as_str().unwrap_or("").to_string();
        match crate::commands::cmd_kb_read_file(path) {
            Ok(content) => content,
            Err(e) => format!("Error reading file: {e}"),
        }
    }
}

struct SearchKnowledgeFiles;

#[async_trait::async_trait]
impl ToolHandler for SearchKnowledgeFiles {
    async fn run(&self, _ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let query = args["query"].as_str().unwrap_or("").to_string();
        let max = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        match crate::commands::cmd_kb_search(query, max) {
            Ok(results) => {
                if results.is_empty() {
                    "No matches found.".to_string()
                } else {
                    results
                }
            }
            Err(e) => format!("Error searching: {e}"),
        }
    }
}

struct GrepKnowledgeFiles;

#[async_trait::async_trait]
impl ToolHandler for GrepKnowledgeFiles {
    async fn run(&self, _ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let pattern = args["pattern"].as_str().unwrap_or("").to_string();
        let fp = args
            .get("file_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        match crate::commands::cmd_kb_grep(pattern, fp) {
            Ok(results) => {
                if results.is_empty() {
                    "No matches found.".to_string()
                } else {
                    results
                }
            }
            Err(e) => format!("Error: {e}"),
        }
    }
}
