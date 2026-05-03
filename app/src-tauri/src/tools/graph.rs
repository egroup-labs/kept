use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};
use tauri::Emitter;

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

/// Returns 10 tools for the KG agent: search_conversation_content,
/// highlight_nodes, list_nodes, search_nodes, get_neighbors, get_stats,
/// add_edge, remove_edge, add_entity, remove_node.
pub fn register_kg() -> Vec<ToolDef> {
    vec![
        // ── search_conversation_content ─────────────────────────────────────
        ToolDef {
            name: "search_conversation_content",
            description: "Full-text search across archived conversations. Optionally filter by platform or title. Returns deduplicated results with cleaned snippets.",
            parameters: vec![
                ParamDef {
                    name: "query",
                    param_type: ParamType::String,
                    description: "Search query text",
                    required: true,
                },
                ParamDef {
                    name: "platform",
                    param_type: ParamType::String,
                    description: "Filter by platform (e.g. 'chatgpt', 'claude', 'gemini')",
                    required: false,
                },
                ParamDef {
                    name: "title_contains",
                    param_type: ParamType::String,
                    description: "Filter results to conversations whose title contains this string (case-insensitive)",
                    required: false,
                },
                ParamDef {
                    name: "limit",
                    param_type: ParamType::Integer,
                    description: "Maximum number of results to return (default 20)",
                    required: false,
                },
            ],
            handler: Box::new(SearchConversationContent),
        },
        // ── highlight_nodes ─────────────────────────────────────────────────
        ToolDef {
            name: "highlight_nodes",
            description: "Highlight specific nodes in the knowledge graph view by emitting a frontend event.",
            parameters: vec![
                ParamDef {
                    name: "node_ids",
                    param_type: ParamType::StringArray,
                    description: "Array of node IDs to highlight",
                    required: true,
                },
                ParamDef {
                    name: "focus",
                    param_type: ParamType::Boolean,
                    description: "Whether to focus/zoom the graph to the highlighted nodes",
                    required: false,
                },
            ],
            handler: Box::new(HighlightNodes),
        },
        // ── list_nodes ──────────────────────────────────────────────────────
        ToolDef {
            name: "list_nodes",
            description: "List nodes in the knowledge graph, optionally filtered by node type.",
            parameters: vec![
                ParamDef {
                    name: "node_type",
                    param_type: ParamType::String,
                    description: "Filter by node type: 'entity', 'conversation', 'provider', 'topic', 'project'",
                    required: false,
                },
                ParamDef {
                    name: "limit",
                    param_type: ParamType::Integer,
                    description: "Maximum number of nodes to return (default 50)",
                    required: false,
                },
            ],
            handler: Box::new(ListNodes),
        },
        // ── search_nodes ────────────────────────────────────────────────────
        ToolDef {
            name: "search_nodes",
            description: "Search for nodes in the knowledge graph by keyword. Returns matching nodes and their edges.",
            parameters: vec![
                ParamDef {
                    name: "query",
                    param_type: ParamType::String,
                    description: "Keywords to search for",
                    required: true,
                },
                ParamDef {
                    name: "limit",
                    param_type: ParamType::Integer,
                    description: "Maximum number of results (default 20)",
                    required: false,
                },
            ],
            handler: Box::new(SearchNodes),
        },
        // ── get_neighbors ───────────────────────────────────────────────────
        ToolDef {
            name: "get_neighbors",
            description: "Get all directly connected nodes and edges for a given node ID.",
            parameters: vec![ParamDef {
                name: "node_id",
                param_type: ParamType::String,
                description: "The ID of the node to get neighbors for",
                required: true,
            }],
            handler: Box::new(GetNeighbors),
        },
        // ── get_stats ───────────────────────────────────────────────────────
        ToolDef {
            name: "get_stats",
            description: "Get aggregate statistics about the knowledge graph: entity count, triple count, conversation count, project count, and top entities.",
            parameters: vec![],
            handler: Box::new(GetStats),
        },
        // ── add_edge ────────────────────────────────────────────────────────
        ToolDef {
            name: "add_edge",
            description: "Add a directed relationship (triple) between two nodes in the knowledge graph.",
            parameters: vec![
                ParamDef {
                    name: "source",
                    param_type: ParamType::String,
                    description: "ID of the source node",
                    required: true,
                },
                ParamDef {
                    name: "target",
                    param_type: ParamType::String,
                    description: "ID of the target node",
                    required: true,
                },
                ParamDef {
                    name: "relation",
                    param_type: ParamType::String,
                    description: "Relation label (e.g. 'uses', 'related_to', 'part_of')",
                    required: true,
                },
            ],
            handler: Box::new(AddEdge),
        },
        // ── remove_edge ─────────────────────────────────────────────────────
        ToolDef {
            name: "remove_edge",
            description: "Remove a directed relationship (triple) between two nodes in the knowledge graph.",
            parameters: vec![
                ParamDef {
                    name: "source",
                    param_type: ParamType::String,
                    description: "ID of the source node",
                    required: true,
                },
                ParamDef {
                    name: "target",
                    param_type: ParamType::String,
                    description: "ID of the target node",
                    required: true,
                },
                ParamDef {
                    name: "relation",
                    param_type: ParamType::String,
                    description: "Relation label to remove",
                    required: true,
                },
            ],
            handler: Box::new(RemoveEdge),
        },
        // ── add_entity ──────────────────────────────────────────────────────
        ToolDef {
            name: "add_entity",
            description: "Add a new entity node to the knowledge graph.",
            parameters: vec![
                ParamDef {
                    name: "name",
                    param_type: ParamType::String,
                    description: "Display name of the entity",
                    required: true,
                },
                ParamDef {
                    name: "entity_type",
                    param_type: ParamType::String,
                    description: "Semantic type: 'technology', 'person', 'concept', 'method', 'tool', etc.",
                    required: false,
                },
            ],
            handler: Box::new(AddEntity),
        },
        // ── remove_node ─────────────────────────────────────────────────────
        ToolDef {
            name: "remove_node",
            description: "Remove a node and all its associated edges and mentions from the knowledge graph.",
            parameters: vec![ParamDef {
                name: "node_id",
                param_type: ParamType::String,
                description: "ID of the node to remove",
                required: true,
            }],
            handler: Box::new(RemoveNode),
        },
    ]
}

struct SearchConversationContent;

#[async_trait::async_trait]
impl ToolHandler for SearchConversationContent {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let query = args["query"].as_str().unwrap_or("");
        let limit = args["limit"].as_i64().unwrap_or(20);
        let platform_filter = args
            .get("platform")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let title_filter = args
            .get("title_contains")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase());

        match ctx.db.search(query, limit) {
            Ok(results) => {
                // Filter + deduplicate by file_path
                let mut seen = std::collections::HashSet::new();
                let filtered: Vec<serde_json::Value> = results
                    .into_iter()
                    .filter(|r| {
                        if let Some(p) = platform_filter {
                            if r.platform != p {
                                return false;
                            }
                        }
                        if let Some(ref tf) = title_filter {
                            if !r.title.to_lowercase().contains(tf.as_str()) {
                                return false;
                            }
                        }
                        true
                    })
                    .filter(|r| seen.insert(r.file_path.clone()))
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

                if filtered.is_empty() {
                    "No conversations found matching that query.".to_string()
                } else {
                    serde_json::to_string_pretty(&filtered).unwrap_or_default()
                }
            }
            Err(e) => format!("Search error: {}", e),
        }
    }
}

struct HighlightNodes;

#[async_trait::async_trait]
impl ToolHandler for HighlightNodes {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        if ctx.kg.is_none() {
            return "Knowledge graph not available.".to_string();
        }
        let node_ids: Vec<String> = args["node_ids"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let focus = args
            .get("focus")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let count = node_ids.len();
        let payload = serde_json::json!({
            "node_ids": node_ids,
            "focus": focus,
        });
        if let Some(w) = ctx.window {
            let _ = w.emit("kg-agent-highlight", payload);
        }
        format!("Highlighted {} node(s).", count)
    }
}

struct ListNodes;

#[async_trait::async_trait]
impl ToolHandler for ListNodes {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let limit = args["limit"].as_u64().unwrap_or(50) as usize;
        let type_filter = args
            .get("node_type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        match kg.get_full_graph(limit) {
            Ok(graph) => {
                let nodes: Vec<serde_json::Value> = graph
                    .nodes
                    .into_iter()
                    .filter(|n| type_filter.is_none_or(|t| n.node_type == t))
                    .map(|n| {
                        serde_json::json!({
                            "id": n.id,
                            "name": n.name,
                            "node_type": n.node_type,
                            "platform": n.platform,
                            "frequency": n.frequency,
                            "entity_type": n.entity_type,
                        })
                    })
                    .collect();
                if nodes.is_empty() {
                    "No nodes found.".to_string()
                } else {
                    serde_json::to_string_pretty(&nodes).unwrap_or_default()
                }
            }
            Err(e) => format!("Error listing nodes: {}", e),
        }
    }
}

struct SearchNodes;

#[async_trait::async_trait]
impl ToolHandler for SearchNodes {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let query = args["query"].as_str().unwrap_or("");
        let limit = args["limit"].as_u64().unwrap_or(20) as usize;
        let keywords: Vec<String> = query
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .collect();

        match kg.search_subgraph(&keywords, &[], 0.0, limit) {
            Ok(graph) => {
                let nodes: Vec<serde_json::Value> = graph
                    .nodes
                    .iter()
                    .map(|n| {
                        serde_json::json!({
                            "id": n.id,
                            "name": n.name,
                            "node_type": n.node_type,
                            "platform": n.platform,
                            "frequency": n.frequency,
                            "entity_type": n.entity_type,
                        })
                    })
                    .collect();
                let edges: Vec<serde_json::Value> = graph
                    .edges
                    .iter()
                    .map(|e| {
                        serde_json::json!({
                            "source": e.source,
                            "target": e.target,
                            "relation": e.relation,
                            "weight": e.weight,
                        })
                    })
                    .collect();
                if nodes.is_empty() {
                    "No matching nodes found.".to_string()
                } else {
                    serde_json::to_string_pretty(&serde_json::json!({
                        "nodes": nodes,
                        "edges": edges,
                    }))
                    .unwrap_or_default()
                }
            }
            Err(e) => format!("Graph search error: {}", e),
        }
    }
}

struct GetNeighbors;

#[async_trait::async_trait]
impl ToolHandler for GetNeighbors {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let node_id = args["node_id"].as_str().unwrap_or("");
        match kg.get_node_neighbors(node_id) {
            Ok(graph) => {
                let nodes: Vec<serde_json::Value> = graph
                    .nodes
                    .iter()
                    .map(|n| {
                        serde_json::json!({
                            "id": n.id,
                            "name": n.name,
                            "node_type": n.node_type,
                            "platform": n.platform,
                            "frequency": n.frequency,
                            "entity_type": n.entity_type,
                        })
                    })
                    .collect();
                let edges: Vec<serde_json::Value> = graph
                    .edges
                    .iter()
                    .map(|e| {
                        serde_json::json!({
                            "source": e.source,
                            "target": e.target,
                            "relation": e.relation,
                            "weight": e.weight,
                        })
                    })
                    .collect();
                serde_json::to_string_pretty(&serde_json::json!({
                    "nodes": nodes,
                    "edges": edges,
                }))
                .unwrap_or_default()
            }
            Err(e) => format!("Error getting neighbors: {}", e),
        }
    }
}

struct GetStats;

#[async_trait::async_trait]
impl ToolHandler for GetStats {
    async fn run(&self, ctx: &ToolContext<'_>, _args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        match kg.get_stats() {
            Ok(stats) => {
                serde_json::to_string_pretty(&serde_json::json!({
                    "entity_count": stats.entity_count,
                    "triple_count": stats.triple_count,
                    "conversation_count": stats.conversation_count,
                    "project_count": stats.project_count,
                    "top_entities": stats.top_entities,
                }))
                .unwrap_or_default()
            }
            Err(e) => format!("Error getting stats: {}", e),
        }
    }
}

struct AddEdge;

#[async_trait::async_trait]
impl ToolHandler for AddEdge {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let source = args["source"].as_str().unwrap_or("");
        let target = args["target"].as_str().unwrap_or("");
        let relation = args["relation"].as_str().unwrap_or("");
        // Verify both entities exist
        if kg.entity_frequency(source).unwrap_or(0) == 0 {
            return format!("Error adding edge: source entity '{}' does not exist. Use add_entity first.", source);
        }
        if kg.entity_frequency(target).unwrap_or(0) == 0 {
            return format!("Error adding edge: target entity '{}' does not exist. Use add_entity first.", target);
        }
        match kg.upsert_triple(source, relation, target) {
            Ok(()) => format!("Edge added: {} --[{}]--> {}", source, relation, target),
            Err(e) => format!("Error adding edge: {}", e),
        }
    }
}

struct RemoveEdge;

#[async_trait::async_trait]
impl ToolHandler for RemoveEdge {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let source = args["source"].as_str().unwrap_or("");
        let target = args["target"].as_str().unwrap_or("");
        let relation = args["relation"].as_str().unwrap_or("");
        match kg.remove_triple(source, relation, target) {
            Ok(()) => format!("Edge removed: {} --[{}]--> {}", source, relation, target),
            Err(e) => format!("Error removing edge: {}", e),
        }
    }
}

struct AddEntity;

#[async_trait::async_trait]
impl ToolHandler for AddEntity {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let name = args["name"].as_str().unwrap_or("");
        let entity_type = args
            .get("entity_type")
            .and_then(|v| v.as_str())
            .unwrap_or("concept");
        let id = name.to_lowercase().replace(' ', "_");
        match kg.upsert_entity(&id, name, &[], entity_type) {
            Ok(()) => format!("Entity added: {} (id: {})", name, id),
            Err(e) => format!("Error adding entity: {}", e),
        }
    }
}

struct RemoveNode;

#[async_trait::async_trait]
impl ToolHandler for RemoveNode {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let kg = match ctx.kg {
            Some(k) => k,
            None => return "Knowledge graph not available.".to_string(),
        };
        let node_id = args["node_id"].as_str().unwrap_or("");
        match kg.remove_entity(node_id) {
            Ok(()) => format!("Node removed: {}", node_id),
            Err(e) => format!("Error removing node: {}", e),
        }
    }
}
