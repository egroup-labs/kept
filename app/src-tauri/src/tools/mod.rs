pub mod code_exec;
pub mod conversation;
pub mod filesystem;
pub mod graph;
pub mod image_read;
pub mod knowledge;
pub mod pdf_read;
pub mod web;

/// The type of a tool parameter.
pub enum ParamType {
    String,
    Integer,
    Boolean,
    StringArray,
}

impl ParamType {
    pub fn as_json_type(&self) -> &'static str {
        match self {
            ParamType::String => "string",
            ParamType::Integer => "integer",
            ParamType::Boolean => "boolean",
            ParamType::StringArray => "array",
        }
    }
}

/// Definition of a single parameter for a tool.
pub struct ParamDef {
    pub name: &'static str,
    pub param_type: ParamType,
    pub description: &'static str,
    pub required: bool,
}

pub type ConsentMap = std::sync::Arc<
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
>;

/// Runtime context passed to every tool handler.
pub struct ToolContext<'a> {
    pub db: &'a crate::db::Database,
    pub kg: Option<&'a crate::kg_gen::kggen::KgDatabase>,
    pub config: &'a crate::models::AppConfig,
    pub window: Option<&'a tauri::Window>,
    pub consent_map: Option<&'a ConsentMap>,
    /// Conversation id of the current chat, when known. Tools that keep per-chat
    /// state (e.g. code-execution artifact folders) use this to group files.
    pub conversation_id: Option<&'a str>,
}

/// Async handler trait for tool implementations.
///
/// Each tool implements this on a unit struct. Sync tools simply
/// omit `.await` in the body — the compiler handles the rest.
#[async_trait::async_trait]
pub trait ToolHandler: Send + Sync {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String;
}

/// A registered tool with its metadata and handler function.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Vec<ParamDef>,
    pub handler: Box<dyn ToolHandler>,
}

/// Registry that holds all available tools.
pub struct ToolRegistry {
    pub tools: Vec<ToolDef>,
}

impl ToolRegistry {
    /// Build a tool registry.
    ///
    /// Always includes conversation, code execution, PDF/image reading,
    /// and filesystem tools. When `restricted` is false, also includes
    /// knowledge base and full knowledge-graph tools.
    pub fn new(restricted: bool) -> Self {
        let mut tools: Vec<ToolDef> = Vec::new();

        tools.extend(conversation::register());
        tools.extend(code_exec::register());
        tools.extend(pdf_read::register());
        tools.extend(image_read::register());
        tools.extend(filesystem::register());

        if !restricted {
            tools.extend(knowledge::register());
            tools.extend(graph::register_kg());
            tools.extend(web::register());
        }

        Self { tools }
    }

    /// Serialize the registry to OpenAI function-calling format.
    ///
    /// ```json
    /// [
    ///   {
    ///     "type": "function",
    ///     "function": {
    ///       "name": "...",
    ///       "description": "...",
    ///       "parameters": {
    ///         "type": "object",
    ///         "properties": { ... },
    ///         "required": [ ... ]
    ///       }
    ///     }
    ///   }
    /// ]
    /// ```
    pub fn to_openai_json(&self) -> serde_json::Value {
        let tools: Vec<serde_json::Value> = self.tools.iter().map(openai_tool_json).collect();

        serde_json::Value::Array(tools)
    }

    pub fn to_openai_json_for_names(&self, names: &[&str]) -> serde_json::Value {
        let tools: Vec<serde_json::Value> = self
            .tools
            .iter()
            .filter(|tool| names.contains(&tool.name))
            .map(openai_tool_json)
            .collect();

        serde_json::Value::Array(tools)
    }

    /// Serialize the registry to Anthropic tool-calling format.
    ///
    /// Uses `"input_schema"` instead of `"parameters"` and omits the
    /// `"type":"function"` envelope.
    ///
    /// ```json
    /// [
    ///   {
    ///     "name": "...",
    ///     "description": "...",
    ///     "input_schema": {
    ///       "type": "object",
    ///       "properties": { ... },
    ///       "required": [ ... ]
    ///     }
    ///   }
    /// ]
    /// ```
    pub fn to_anthropic_json(&self) -> serde_json::Value {
        let tools: Vec<serde_json::Value> = self.tools.iter().map(anthropic_tool_json).collect();

        serde_json::Value::Array(tools)
    }

    pub fn to_anthropic_json_for_names(&self, names: &[&str]) -> serde_json::Value {
        let tools: Vec<serde_json::Value> = self
            .tools
            .iter()
            .filter(|tool| names.contains(&tool.name))
            .map(anthropic_tool_json)
            .collect();

        serde_json::Value::Array(tools)
    }

    /// Find a tool by name and invoke its handler with the provided arguments.
    ///
    /// Returns `"Unknown tool: {name}"` when no matching tool is registered.
    pub async fn execute(
        &self,
        name: &str,
        args: &serde_json::Value,
        ctx: &ToolContext<'_>,
    ) -> String {
        for tool in &self.tools {
            if tool.name == name {
                let args_compact = args.to_string();
                let args_preview: String = args_compact.chars().take(300).collect();
                let result = tool.handler.run(ctx, args).await;
                let preview: String = result.chars().take(200).collect();
                log::debug!(
                    "[tool] {}({}) → {}",
                    name,
                    args_preview.replace('\n', " "),
                    preview.replace('\n', " ")
                );
                return result;
            }
        }
        log::debug!("[tool] unknown: {}", name);
        format!("Unknown tool: {}", name)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn openai_tool_json(tool: &ToolDef) -> serde_json::Value {
    let (properties, required) = build_properties_and_required(&tool.parameters);
    serde_json::json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required
            }
        }
    })
}

fn anthropic_tool_json(tool: &ToolDef) -> serde_json::Value {
    let (properties, required) = build_properties_and_required(&tool.parameters);
    serde_json::json!({
        "name": tool.name,
        "description": tool.description,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": required
        }
    })
}

/// Build the `properties` map and `required` array from a slice of `ParamDef`s.
fn build_properties_and_required(
    params: &[ParamDef],
) -> (
    serde_json::Map<std::string::String, serde_json::Value>,
    Vec<&'static str>,
) {
    let mut properties = serde_json::Map::new();
    let mut required: Vec<&'static str> = Vec::new();

    for param in params {
        let json_type = param.param_type.as_json_type();

        let mut prop = serde_json::json!({
            "type": json_type,
            "description": param.description
        });

        // For array parameters, specify that items are strings.
        if let ParamType::StringArray = &param.param_type {
            prop.as_object_mut()
                .unwrap()
                .insert("items".to_string(), serde_json::json!({"type": "string"}));
        }

        properties.insert(param.name.to_string(), prop);

        if param.required {
            required.push(param.name);
        }
    }

    (properties, required)
}
