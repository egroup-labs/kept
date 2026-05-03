use super::filesystem::validate_path;
use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};

const MAX_PDF_CHARS: usize = 50_000;

pub fn register() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "read_pdf",
        description: "Extract text content from a PDF file (scoped to allowed directories).",
        parameters: vec![
            ParamDef {
                name: "path",
                param_type: ParamType::String,
                description: "Path to the PDF file",
                required: true,
            },
            ParamDef {
                name: "pages",
                param_type: ParamType::String,
                description: "Page range: \"3\", \"1-5\", or \"3-end\". Omit to read all pages.",
                required: false,
            },
        ],
        handler: Box::new(ReadPdf),
    }]
}

struct ReadPdf;

#[async_trait::async_trait]
impl ToolHandler for ReadPdf {
    async fn run(&self, ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let path_str = match args["path"].as_str() {
            Some(p) if !p.is_empty() => p,
            _ => return "Error: 'path' parameter is required.".to_string(),
        };

        let target = match validate_path(path_str, ctx.config) {
            Ok(p) => p,
            Err(e) => return format!("Error: {}", e),
        };

        if !target.is_file() {
            return format!("File not found: {}", path_str);
        }

        let full_text = match pdf_extract::extract_text(&target) {
            Ok(text) => text,
            Err(e) => return format!("PDF extraction failed: {}", e),
        };

        let all_pages: Vec<&str> = full_text.split('\x0C').collect();
        let page_count = all_pages.len();

        let text = match args.get("pages").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            Some(pages_str) => match parse_page_range(pages_str, page_count) {
                Ok((start, end)) => {
                    if start > page_count {
                        return format!(
                            "Page {} out of range. Document has {} page(s).",
                            start, page_count
                        );
                    }
                    let end_clamped = end.min(page_count);
                    let selected = &all_pages[(start - 1)..end_clamped];
                    selected.join("\n\n--- Page Break ---\n\n")
                }
                Err(msg) => return msg,
            },
            None => full_text,
        };

        if text.len() > MAX_PDF_CHARS {
            format!(
                "{}\n\n[... truncated at {} characters]",
                &text[..MAX_PDF_CHARS],
                MAX_PDF_CHARS
            )
        } else {
            text
        }
    }
}

/// Parse a page range string into (start, end) inclusive, 1-indexed.
///
/// Accepts: "3", "1-5", "3-end", "1-end".
/// "end" resolves to the total page count.
fn parse_page_range(s: &str, page_count: usize) -> Result<(usize, usize), String> {
    let s = s.trim();
    if let Some((left, right)) = s.split_once('-') {
        let start: usize = left
            .trim()
            .parse()
            .map_err(|_| format!("Invalid page range: '{}'. Use '3', '1-5', or '1-end'.", s))?;
        let right_trimmed = right.trim();
        let end: usize = if right_trimmed.eq_ignore_ascii_case("end") {
            page_count
        } else {
            right_trimmed
                .parse()
                .map_err(|_| format!("Invalid page range: '{}'. Use '3', '1-5', or '1-end'.", s))?
        };
        if start == 0 || end == 0 || start > end {
            return Err(format!("Invalid page range: '{}'. Use '3', '1-5', or '1-end'.", s));
        }
        Ok((start, end))
    } else {
        let page: usize = s
            .parse()
            .map_err(|_| format!("Invalid page range: '{}'. Use '3', '1-5', or '1-end'.", s))?;
        if page == 0 {
            return Err(format!("Invalid page range: '{}'. Pages start at 1.", s));
        }
        Ok((page, page))
    }
}
