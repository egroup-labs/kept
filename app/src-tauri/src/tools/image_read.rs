use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};

pub fn register() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "read_image",
        description: "Describe or extract text from an image file.",
        parameters: vec![
            ParamDef {
                name: "path",
                param_type: ParamType::String,
                description: "Path to the image file",
                required: true,
            },
            ParamDef {
                name: "task",
                param_type: ParamType::String,
                description: "\"describe\" or \"ocr\" (default: \"describe\")",
                required: false,
            },
        ],
        handler: Box::new(ReadImage),
    }]
}

struct ReadImage;

#[async_trait::async_trait]
impl ToolHandler for ReadImage {
    async fn run(&self, _ctx: &ToolContext<'_>, _args: &serde_json::Value) -> String {
        "Tool not yet implemented: read_image. This capability is coming soon.".to_string()
    }
}
