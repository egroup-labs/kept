use crate::commands::DbState;
use crate::config;
use crate::models::{
    AgentChatRequest, AgentChatResponse, AgentProgress, IngestPayload, TitleRequest, ToolExecution,
};
use crate::vault;
use futures::{future::join_all, StreamExt};
use reqwest::header::{CONTENT_ENCODING, CONTENT_TYPE};
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::{Emitter, State, Window};
use tokio_util::sync::CancellationToken;

/// Partial state captured while the agent loop runs, so a cancel can save
/// whatever was already produced.
#[derive(Default)]
struct PartialAccumulator {
    content: String,
    reasoning: String,
    tool_calls: Vec<crate::models::ToolCallRecord>,
}

async fn emit_cancelled(
    window: &Window,
    conversation_id: Option<&str>,
    iteration: u32,
    acc: &mut PartialAccumulator,
) -> AgentChatResponse {
    let _ = window.emit(
        "agent-cancelled",
        serde_json::json!({
            "conversation_id": conversation_id,
            "content": acc.content,
            "reasoning": acc.reasoning,
            "tool_calls": acc.tool_calls,
            "iteration": iteration,
        }),
    );
    AgentChatResponse {
        content: std::mem::take(&mut acc.content),
        tool_executions: Vec::new(),
        iterations: iteration,
    }
}

/// Returns true when the app is in restricted privacy mode.
fn is_restricted(cfg: &crate::models::AppConfig) -> bool {
    cfg.privacy_mode.as_deref() == Some("restricted")
}

/// Inject `"provider": { "zdr": true }` into a JSON body when in restricted mode.
fn apply_zdr(body: &mut serde_json::Value, restricted: bool) {
    if restricted {
        body["provider"] = serde_json::json!({ "zdr": true });
    }
}

const MAX_ITERATIONS: u32 = 20;

const SYSTEM_PROMPT: &str = r#"You are Kept, a helpful assistant and resident archivist for a personal vault of AI conversations (ChatGPT, Claude, Gemini). Answer normal questions directly. When the user's archive, conversations, knowledge graph, files, or prior work are relevant, use the available tools to ground the answer.

**Default Behavior**
- Be direct, useful, and concise unless the user asks for depth.
- Do not refuse general-purpose questions just because they are outside the archive.
- Use web search for current events, recent facts, prices, versions, schedules, or anything likely to have changed.
- Use archive and graph tools when the user asks about their past conversations, projects, saved knowledge, or relationships between topics.
- If you use sources or conversations, cite the title or URL in the answer.
- If information is uncertain, say what is uncertain and what you checked.
- Do not invent tool results. If a tool fails or returns nothing useful, say so.

**Graph Structure**
- Node types: conversation, provider, entity, topic, project.
- Edge types: freeform relation labels (e.g. "uses", "related_to", "part_of") connecting entity nodes. Read-only — graph mutations happen automatically when conversations are ingested.

**Tool & Workflow Guidelines**
- **Investigate:** Use `list_nodes`, `search_nodes`, `get_neighbors`, or `search_conversation_content` to explore the graph and find evidence.
- **Tool Routing:** Use graph tools for structure ("what connects to what?"). Use `search_conversation_content` for specific text, evidence, wording, or themes.
- **Visuals:** Use `highlight_nodes` to help users visually inspect important identified nodes.
- **Honesty:** If you cannot find relevant conversations, state so clearly.

**Action & Curation Rules**
- **Synthesis:** Synthesize insights across multiple conversations when creating reports.
- **Citation:** Always cite sources by conversation title.

**Output Formatting**
- Use markdown extensively for readability (headings, lists, tables)."#;

fn supports_anthropic_thinking(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("claude-3-7") || model.contains("sonnet-4") || model.contains("opus-4")
}

fn runtime_system_context(restricted: bool) -> String {
    let now = chrono::Local::now();
    let privacy = if restricted {
        "restricted: do not use public web search or non-ZDR remote routes unless explicitly available"
    } else {
        "flexible: web search tools may be used when useful"
    };
    let web = if restricted {
        "Web search tools are disabled in restricted mode."
    } else {
        "Web search tools are available for current or source-backed information."
    };

    format!(
        "# Runtime Context\n\n- Current local date: {}\n- Current local time: {}\n- UTC offset: {}\n- Privacy mode: {}\n- {}\n- The user's locale should be inferred only when stated; otherwise avoid location-specific assumptions.",
        now.format("%Y-%m-%d"),
        now.format("%H:%M:%S"),
        now.offset(),
        privacy,
        web,
    )
}

fn response_header_value(resp: &reqwest::Response, header: reqwest::header::HeaderName) -> String {
    resp.headers()
        .get(header)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string()
}

fn extract_content_text(value: &serde_json::Value) -> Option<String> {
    if let Some(content) = value.as_str() {
        return Some(content.to_string());
    }
    value
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    part["text"]
                        .as_str()
                        .map(ToOwned::to_owned)
                        .or_else(|| part["content"].as_str().map(ToOwned::to_owned))
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.is_empty())
}

/// Build OpenAI-format content from an AgentMessage: plain string if no attachments,
/// array of content blocks otherwise.
fn build_agent_openai_content(m: &crate::models::AgentMessage) -> serde_json::Value {
    let content = m.content.as_deref().unwrap_or("");
    let attachments = m.attachments.as_deref().unwrap_or(&[]);
    if attachments.is_empty() {
        serde_json::json!(content)
    } else {
        let mut parts = vec![serde_json::json!({ "type": "text", "text": content })];
        for att in attachments {
            if att.media_type.starts_with("image/") || att.media_type == "application/pdf" {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", att.media_type, att.data) }
                }));
            }
        }
        serde_json::Value::Array(parts)
    }
}

/// Build Anthropic-format content from an AgentMessage: plain string if no attachments,
/// array of content blocks otherwise.
fn build_agent_anthropic_content(m: &crate::models::AgentMessage) -> serde_json::Value {
    let content = m.content.as_deref().unwrap_or("");
    let attachments = m.attachments.as_deref().unwrap_or(&[]);
    if attachments.is_empty() {
        serde_json::json!(content)
    } else {
        let mut parts: Vec<serde_json::Value> = Vec::new();
        for att in attachments {
            if att.media_type.starts_with("image/") {
                parts.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": att.media_type,
                        "data": att.data,
                    }
                }));
            } else if att.media_type == "application/pdf" {
                parts.push(serde_json::json!({
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": att.data,
                    }
                }));
            }
        }
        parts.push(serde_json::json!({ "type": "text", "text": content }));
        serde_json::Value::Array(parts)
    }
}

fn parse_openai_sse_response(body: &[u8], label: &str) -> Result<serde_json::Value, String> {
    let text = String::from_utf8_lossy(body);
    let mut role = "assistant".to_string();
    let mut content = String::new();
    let mut finish_reason: Option<String> = None;
    let mut tool_calls: BTreeMap<usize, (String, String, String)> = BTreeMap::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(':') || !line.starts_with("data:") {
            continue;
        }

        let payload = line.trim_start_matches("data:").trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }

        let chunk: serde_json::Value = serde_json::from_str(payload).map_err(|e| {
            format!(
                "Failed to parse {label} SSE chunk as JSON: {e}. Chunk: {}",
                &payload[..payload.len().min(300)]
            )
        })?;

        let choice = &chunk["choices"][0];
        let delta = &choice["delta"];

        if let Some(next_role) = delta["role"].as_str() {
            role = next_role.to_string();
        }

        if let Some(text_part) = extract_content_text(&delta["content"]) {
            content.push_str(&text_part);
        }

        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"]
                    .as_u64()
                    .map(|idx| idx as usize)
                    .unwrap_or(tool_calls.len());
                let entry = tool_calls
                    .entry(index)
                    .or_insert_with(|| (String::new(), String::new(), String::new()));

                if let Some(id) = call["id"].as_str() {
                    entry.0 = id.to_string();
                }
                if let Some(name) = call["function"]["name"].as_str() {
                    entry.1.push_str(name);
                }
                if let Some(arguments) = call["function"]["arguments"].as_str() {
                    entry.2.push_str(arguments);
                }
            }
        }

        if let Some(reason) = choice["finish_reason"].as_str() {
            if !reason.is_empty() && reason != "null" {
                finish_reason = Some(reason.to_string());
            }
        }
    }

    let mut message = serde_json::json!({
        "role": role,
        "content": content,
    });

    if !tool_calls.is_empty() {
        let calls = tool_calls
            .into_values()
            .map(|(id, name, arguments)| {
                serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    }
                })
            })
            .collect::<Vec<_>>();
        message["tool_calls"] = serde_json::Value::Array(calls);
    }

    Ok(serde_json::json!({
        "choices": [{
            "message": message,
            "finish_reason": finish_reason.unwrap_or_else(|| {
                if content.is_empty() && message.get("tool_calls").is_some() {
                    "tool_calls".to_string()
                } else {
                    "stop".to_string()
                }
            }),
        }]
    }))
}

async fn read_json_response(
    resp: reqwest::Response,
    label: &str,
) -> Result<serde_json::Value, String> {
    let content_type = response_header_value(&resp, CONTENT_TYPE);
    let content_encoding = response_header_value(&resp, CONTENT_ENCODING);
    let body = resp
        .bytes()
        .await
        .map_err(|e| {
            format!(
                "Failed to read {label} response body (content-type: {content_type}, content-encoding: {content_encoding}): {e}"
            )
        })?;

    if content_type.contains("text/event-stream") {
        return parse_openai_sse_response(&body, label);
    }

    serde_json::from_slice(&body).map_err(|e| {
        let snippet = String::from_utf8_lossy(&body);
        let snippet = &snippet[..snippet.len().min(300)];
        format!(
            "Failed to parse {label} response as JSON (content-type: {content_type}, content-encoding: {content_encoding}): {e}. Body: {snippet}"
        )
    })
}

fn extract_openai_message_content(message: &serde_json::Value) -> String {
    if let Some(content) = extract_content_text(&message["content"]) {
        return content;
    }

    String::new()
}

#[derive(Clone, serde::Serialize)]
struct AgentDeltaProgress {
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    iteration: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

fn sse_payload_from_line(line: &str) -> Option<&str> {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') || !line.starts_with("data:") {
        return None;
    }
    Some(line.trim_start_matches("data:").trim())
}

fn drain_sse_payloads(buffer: &mut String) -> Vec<String> {
    let mut payloads = Vec::new();
    while let Some(pos) = buffer.find('\n') {
        let line = buffer[..pos].trim_end_matches('\r').to_string();
        buffer.drain(..=pos);
        if let Some(payload) = sse_payload_from_line(&line) {
            if !payload.is_empty() {
                payloads.push(payload.to_string());
            }
        }
    }
    payloads
}

fn drain_final_sse_payload(buffer: &mut String) -> Vec<String> {
    let final_line = buffer.trim();
    if final_line.is_empty() {
        return Vec::new();
    }
    let payload = sse_payload_from_line(final_line)
        .map(ToOwned::to_owned)
        .filter(|payload| !payload.is_empty());
    buffer.clear();
    payload.into_iter().collect()
}

fn emit_message_delta(
    window: &Window,
    channel: &str,
    conversation_id: Option<&str>,
    iteration: u32,
    content_delta: &str,
) {
    if content_delta.is_empty() {
        return;
    }
    let _ = window.emit(
        channel,
        AgentDeltaProgress {
            stage: "message_delta".to_string(),
            tool_name: None,
            iteration,
            content_delta: Some(content_delta.to_string()),
            reasoning_delta: None,
            conversation_id: conversation_id.map(ToOwned::to_owned),
        },
    );
}

fn emit_reasoning_delta(
    window: &Window,
    channel: &str,
    conversation_id: Option<&str>,
    iteration: u32,
    reasoning_delta: &str,
) {
    if reasoning_delta.is_empty() {
        return;
    }
    let _ = window.emit(
        channel,
        AgentDeltaProgress {
            stage: "reasoning_delta".to_string(),
            tool_name: None,
            iteration,
            content_delta: None,
            reasoning_delta: Some(reasoning_delta.to_string()),
            conversation_id: conversation_id.map(ToOwned::to_owned),
        },
    );
}

#[derive(Default)]
struct OpenAiStreamState {
    role: String,
    content: String,
    finish_reason: Option<String>,
    reasoning: String,
    reasoning_details: BTreeMap<usize, serde_json::Value>,
    tool_calls: BTreeMap<usize, (String, String, String)>,
}

impl OpenAiStreamState {
    fn to_response_json(self) -> serde_json::Value {
        let role = if self.role.is_empty() {
            "assistant".to_string()
        } else {
            self.role
        };
        let mut message = serde_json::json!({
            "role": role,
            "content": self.content,
        });

        if !self.reasoning.is_empty() && self.reasoning_details.is_empty() {
            message["reasoning"] = serde_json::Value::String(self.reasoning);
        }
        if !self.reasoning_details.is_empty() {
            let details: Vec<serde_json::Value> = self
                .reasoning_details
                .into_values()
                .map(|mut v| {
                    if let Some(obj) = v.as_object_mut() {
                        obj.remove("index");
                    }
                    v
                })
                .collect();
            message["reasoning_details"] = serde_json::Value::Array(details);
        }

        if !self.tool_calls.is_empty() {
            let calls = self
                .tool_calls
                .into_values()
                .map(|(id, name, arguments)| {
                    serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        }
                    })
                })
                .collect::<Vec<_>>();
            message["tool_calls"] = serde_json::Value::Array(calls);
        }

        let finish_reason = self.finish_reason.unwrap_or_else(|| {
            if message.get("tool_calls").is_some() {
                "tool_calls".to_string()
            } else {
                "stop".to_string()
            }
        });

        serde_json::json!({
            "choices": [{
                "message": message,
                "finish_reason": finish_reason,
            }]
        })
    }
}

fn reasoning_detail_text(detail: &serde_json::Value) -> Option<String> {
    let text = match detail["type"].as_str() {
        Some("reasoning.text") => detail["text"].as_str(),
        Some("reasoning.summary") => detail["summary"].as_str(),
        Some("reasoning.encrypted") => None,
        _ => detail["text"]
            .as_str()
            .or_else(|| detail["summary"].as_str())
            .or_else(|| detail["content"].as_str()),
    }?;

    let text = text.trim_end_matches('\0');
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Merge a streaming `reasoning_details` delta entry into an accumulated entry.
///
/// String fields that the provider streams in chunks (`text`, `summary`, `data`)
/// are concatenated. All other fields (`type`, `id`, `format`, `signature`, …)
/// are copied/overwritten — `signature` in particular arrives once at the end
/// and must replace any prior placeholder. Without this, blocks reassembled
/// from extending the array verbatim end up with mismatched signatures, which
/// Anthropic rejects on the next turn ("Invalid signature in thinking block").
fn merge_reasoning_detail(target: &mut serde_json::Value, src: &serde_json::Value) {
    let (Some(t), Some(s)) = (target.as_object_mut(), src.as_object()) else {
        return;
    };
    for (k, v) in s {
        match k.as_str() {
            "text" | "summary" | "data" => {
                if let Some(new_str) = v.as_str() {
                    let existing = t.get(k).and_then(|x| x.as_str()).unwrap_or("");
                    t.insert(
                        k.clone(),
                        serde_json::Value::String(format!("{existing}{new_str}")),
                    );
                } else {
                    t.insert(k.clone(), v.clone());
                }
            }
            _ => {
                t.insert(k.clone(), v.clone());
            }
        }
    }
}

fn extract_openai_reasoning_delta(delta: &serde_json::Value) -> String {
    if let Some(details) = delta["reasoning_details"].as_array() {
        return details
            .iter()
            .filter_map(reasoning_detail_text)
            .collect::<Vec<_>>()
            .join("");
    }

    for key in ["reasoning", "reasoning_content"] {
        if let Some(part) = delta[key].as_str() {
            if !part.is_empty() {
                return part.to_string();
            }
        }
    }

    String::new()
}

fn apply_openai_stream_payload(
    payload: &str,
    state: &mut OpenAiStreamState,
    window: &Window,
    channel: &str,
    conversation_id: Option<&str>,
    iteration: u32,
) -> Result<(), String> {
    if payload == "[DONE]" {
        return Ok(());
    }

    let chunk: serde_json::Value = serde_json::from_str(payload).map_err(|e| {
        format!(
            "Failed to parse OpenAI-compatible SSE chunk as JSON: {e}. Chunk: {}",
            &payload[..payload.len().min(300)]
        )
    })?;

    let choice = &chunk["choices"][0];
    let delta = &choice["delta"];

    if let Some(next_role) = delta["role"].as_str() {
        state.role = next_role.to_string();
    }

    if let Some(content_delta) = extract_content_text(&delta["content"]) {
        state.content.push_str(&content_delta);
        emit_message_delta(window, channel, conversation_id, iteration, &content_delta);
    }

    let reasoning_delta = extract_openai_reasoning_delta(delta);
    if !reasoning_delta.is_empty() {
        state.reasoning.push_str(&reasoning_delta);
        emit_reasoning_delta(
            window,
            channel,
            conversation_id,
            iteration,
            &reasoning_delta,
        );
    }
    if let Some(details) = delta["reasoning_details"].as_array() {
        for d in details {
            let index = d["index"]
                .as_u64()
                .map(|x| x as usize)
                .unwrap_or_else(|| state.reasoning_details.len());
            let entry = state
                .reasoning_details
                .entry(index)
                .or_insert_with(|| serde_json::json!({}));
            merge_reasoning_detail(entry, d);
        }
    }

    if let Some(calls) = delta["tool_calls"].as_array() {
        for call in calls {
            let index = call["index"]
                .as_u64()
                .map(|idx| idx as usize)
                .unwrap_or(state.tool_calls.len());
            let entry = state
                .tool_calls
                .entry(index)
                .or_insert_with(|| (String::new(), String::new(), String::new()));

            if let Some(id) = call["id"].as_str() {
                entry.0 = id.to_string();
            }
            if let Some(name) = call["function"]["name"].as_str() {
                entry.1.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                entry.2.push_str(arguments);
            }
        }
    }

    if let Some(reason) = choice["finish_reason"].as_str() {
        if !reason.is_empty() && reason != "null" {
            state.finish_reason = Some(reason.to_string());
        }
    }

    Ok(())
}

async fn read_openai_streaming_response(
    resp: reqwest::Response,
    label: &str,
    window: &Window,
    channel: &str,
    conversation_id: Option<&str>,
    iteration: u32,
    cancel_token: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let content_type = response_header_value(&resp, CONTENT_TYPE);
    if !content_type.contains("text/event-stream") {
        return read_json_response(resp, label).await;
    }

    let mut state = OpenAiStreamState::default();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();

    loop {
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => break,
            next = stream.next() => {
                match next {
                    Some(chunk) => {
                        let chunk = chunk.map_err(|e| format!("Failed to read {label} stream: {e}"))?;
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        for payload in drain_sse_payloads(&mut buffer) {
                            apply_openai_stream_payload(
                                &payload,
                                &mut state,
                                window,
                                channel,
                                conversation_id,
                                iteration,
                            )?;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    for payload in drain_final_sse_payload(&mut buffer) {
        apply_openai_stream_payload(
            &payload,
            &mut state,
            window,
            channel,
            conversation_id,
            iteration,
        )?;
    }

    Ok(state.to_response_json())
}

enum AnthropicBlockState {
    Text(String),
    Thinking {
        thinking: String,
        signature: Option<String>,
    },
    RedactedThinking(String),
    Tool {
        id: String,
        name: String,
        input: String,
    },
}

#[derive(Default)]
struct AnthropicStreamState {
    blocks: BTreeMap<usize, AnthropicBlockState>,
    stop_reason: String,
}

impl AnthropicStreamState {
    fn to_response_json(self) -> serde_json::Value {
        let mut content = Vec::new();
        let stop_reason = if self.stop_reason.is_empty() {
            "end_turn".to_string()
        } else {
            self.stop_reason
        };

        for block in self.blocks.into_values() {
            match block {
                AnthropicBlockState::Text(text) => {
                    content.push(serde_json::json!({ "type": "text", "text": text }));
                }
                AnthropicBlockState::Thinking {
                    thinking,
                    signature,
                } => {
                    let mut block = serde_json::json!({
                        "type": "thinking",
                        "thinking": thinking,
                    });
                    if let Some(signature) = signature {
                        block["signature"] = serde_json::Value::String(signature);
                    }
                    content.push(block);
                }
                AnthropicBlockState::RedactedThinking(data) => {
                    content.push(serde_json::json!({
                        "type": "redacted_thinking",
                        "data": data,
                    }));
                }
                AnthropicBlockState::Tool { id, name, input } => {
                    let input_value =
                        serde_json::from_str(&input).unwrap_or_else(|_| serde_json::json!({}));
                    content.push(serde_json::json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input_value,
                    }));
                }
            }
        }

        serde_json::json!({
            "content": content,
            "stop_reason": stop_reason,
        })
    }
}

fn apply_anthropic_stream_payload(
    payload: &str,
    state: &mut AnthropicStreamState,
    window: &Window,
    channel: &str,
    conversation_id: Option<&str>,
    iteration: u32,
) -> Result<(), String> {
    if payload == "[DONE]" {
        return Ok(());
    }

    let event: serde_json::Value = serde_json::from_str(payload).map_err(|e| {
        format!(
            "Failed to parse Anthropic SSE chunk as JSON: {e}. Chunk: {}",
            &payload[..payload.len().min(300)]
        )
    })?;

    match event["type"].as_str() {
        Some("content_block_start") => {
            let index = event["index"].as_u64().unwrap_or(0) as usize;
            let block = &event["content_block"];
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or("").to_string();
                    if !text.is_empty() {
                        emit_message_delta(window, channel, conversation_id, iteration, &text);
                    }
                    state.blocks.insert(index, AnthropicBlockState::Text(text));
                }
                Some("thinking") => {
                    let thinking = block["thinking"].as_str().unwrap_or("").to_string();
                    if !thinking.is_empty() {
                        emit_reasoning_delta(
                            window,
                            channel,
                            conversation_id,
                            iteration,
                            &thinking,
                        );
                    }
                    state.blocks.insert(
                        index,
                        AnthropicBlockState::Thinking {
                            thinking,
                            signature: block["signature"].as_str().map(ToOwned::to_owned),
                        },
                    );
                }
                Some("redacted_thinking") => {
                    state.blocks.insert(
                        index,
                        AnthropicBlockState::RedactedThinking(
                            block["data"].as_str().unwrap_or("").to_string(),
                        ),
                    );
                }
                Some("tool_use") => {
                    let input = if block["input"].is_object() || block["input"].is_array() {
                        block["input"].to_string()
                    } else {
                        String::new()
                    };
                    state.blocks.insert(
                        index,
                        AnthropicBlockState::Tool {
                            id: block["id"].as_str().unwrap_or("").to_string(),
                            name: block["name"].as_str().unwrap_or("").to_string(),
                            input,
                        },
                    );
                }
                _ => {}
            }
        }
        Some("content_block_delta") => {
            let index = event["index"].as_u64().unwrap_or(0) as usize;
            let delta = &event["delta"];
            match delta["type"].as_str() {
                Some("text_delta") => {
                    let text = delta["text"].as_str().unwrap_or("");
                    if let Some(AnthropicBlockState::Text(existing)) = state.blocks.get_mut(&index)
                    {
                        existing.push_str(text);
                    }
                    emit_message_delta(window, channel, conversation_id, iteration, text);
                }
                Some("thinking_delta") => {
                    let thinking = delta["thinking"].as_str().unwrap_or("");
                    if let Some(AnthropicBlockState::Thinking {
                        thinking: existing, ..
                    }) = state.blocks.get_mut(&index)
                    {
                        existing.push_str(thinking);
                    }
                    emit_reasoning_delta(window, channel, conversation_id, iteration, thinking);
                }
                Some("signature_delta") => {
                    if let Some(AnthropicBlockState::Thinking { signature, .. }) =
                        state.blocks.get_mut(&index)
                    {
                        *signature = delta["signature"].as_str().map(ToOwned::to_owned);
                    }
                }
                Some("input_json_delta") => {
                    let partial = delta["partial_json"].as_str().unwrap_or("");
                    if let Some(AnthropicBlockState::Tool { input, .. }) =
                        state.blocks.get_mut(&index)
                    {
                        input.push_str(partial);
                    }
                }
                _ => {}
            }
        }
        Some("message_delta") => {
            if let Some(stop_reason) = event["delta"]["stop_reason"].as_str() {
                state.stop_reason = stop_reason.to_string();
            }
        }
        _ => {}
    }

    Ok(())
}

async fn read_anthropic_streaming_response(
    resp: reqwest::Response,
    window: &Window,
    channel: &str,
    conversation_id: Option<&str>,
    iteration: u32,
    cancel_token: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let mut state = AnthropicStreamState::default();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();

    loop {
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => break,
            next = stream.next() => {
                match next {
                    Some(chunk) => {
                        let chunk = chunk.map_err(|e| format!("Failed to read Anthropic stream: {e}"))?;
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        for payload in drain_sse_payloads(&mut buffer) {
                            apply_anthropic_stream_payload(
                                &payload,
                                &mut state,
                                window,
                                channel,
                                conversation_id,
                                iteration,
                            )?;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    for payload in drain_final_sse_payload(&mut buffer) {
        apply_anthropic_stream_payload(
            &payload,
            &mut state,
            window,
            channel,
            conversation_id,
            iteration,
        )?;
    }

    Ok(state.to_response_json())
}

async fn generate_openai_compatible_title(
    client: &reqwest::Client,
    api_url: &str,
    api_key: &str,
    model: &str,
    message: &str,
    label: &str,
    include_title_header: bool,
    enforce_zdr: bool,
) -> Result<String, String> {
    let system = "Write a 1-5 word title for this conversation. Return ONLY the title.\n\nExamples:\nUser: \"How do I center a div in CSS?\" → Centering Divs\nUser: \"I'm feeling stuck on my novel\" → Writing Block\nUser: \"Can you explain quantum entanglement simply?\" → Quantum Entanglement\nUser: \"Help me plan a birthday party for my daughter\" → Birthday Party Planning\nUser: \"What's the best way to learn Rust?\" → Learning Rust";

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": message }
        ],
        "max_tokens": 10000,
        "stream": false
    });
    apply_zdr(&mut body, enforce_zdr);

    let mut req = client
        .post(api_url)
        .header("Authorization", format!("Bearer {}", api_key));
    if include_title_header {
        req = req.header("X-Title", "Kept");
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Title generation failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "{label} API error ({}): {}",
            status,
            &text[..text.len().min(500)]
        ));
    }

    let json = read_json_response(resp, label).await?;

    let title = extract_openai_message_content(&json["choices"][0]["message"]);
    if title.is_empty() {
        Err(format!("{label} returned empty title. Response: {}", json))
    } else {
        Ok(title)
    }
}

/// Unified agent chat command. Replaces the former per-provider agent and KG
/// agent commands with a single entry point. The caller controls the system
/// prompt and event channel via `AgentChatRequest`.
#[tauri::command]
pub async fn cmd_agent_chat(
    window: Window,
    db: State<'_, DbState>,
    kg: State<'_, crate::commands::KgState>,
    consent: State<'_, crate::commands::CodeConsentState>,
    cancel_state: State<'_, crate::commands::AgentCancelState>,
    request: AgentChatRequest,
) -> Result<AgentChatResponse, String> {
    let cfg = config::read_config()?;
    let restricted = is_restricted(&cfg);
    let conv_id = request.conversation_id.clone();
    let cancel_key = conv_id
        .clone()
        .unwrap_or_else(|| format!("anon-{}", uuid::Uuid::new_v4()));

    let cancel_token = CancellationToken::new();
    if let Ok(mut map) = cancel_state.0.lock() {
        map.insert(cancel_key.clone(), cancel_token.clone());
    }

    struct CancelGuard<'a> {
        state: &'a crate::commands::AgentCancelState,
        key: String,
    }
    impl Drop for CancelGuard<'_> {
        fn drop(&mut self) {
            if let Ok(mut map) = self.state.0.lock() {
                map.remove(&self.key);
            }
        }
    }
    let _cancel_guard = CancelGuard {
        state: &cancel_state,
        key: cancel_key.clone(),
    };

    let mut accumulated = PartialAccumulator::default();

    // System prompt: unified prompt with runtime context and tools.md appended.
    let tools_md = config::tools_md_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let runtime_context = runtime_system_context(restricted);
    let base_prompt = format!("{SYSTEM_PROMPT}\n\n{runtime_context}");
    let system_prompt = if tools_md.is_empty() {
        base_prompt
    } else {
        format!("{base_prompt}\n\n# Available Tools\n\n{tools_md}")
    };

    let event_channel = request.event_channel.as_deref().unwrap_or("agent-progress");

    let registry = crate::tools::ToolRegistry::new(restricted);

    let mut tool_executions: Vec<ToolExecution> = Vec::new();
    let mut iteration: u32 = 0;

    match request.platform.as_str() {
        // ── OpenAI-compatible providers (+ Ollama) ───────────────────────
        "openai" | "openrouter" | "ollama" => {
            let is_ollama = request.platform == "ollama";

            let (api_url, api_key, include_title) = match request.platform.as_str() {
                "openai" => {
                    let key = cfg
                        .openai_api_key
                        .as_deref()
                        .filter(|k| !k.is_empty())
                        .ok_or("OpenAI API key not configured. Set it in Settings.")?;
                    (
                        "https://api.openai.com/v1/chat/completions".to_string(),
                        key.to_string(),
                        false,
                    )
                }
                "openrouter" => {
                    let key = cfg
                        .openrouter_api_key
                        .as_deref()
                        .filter(|k| !k.is_empty())
                        .ok_or("OpenRouter API key not configured. Set it in Settings.")?;
                    (
                        "https://openrouter.ai/api/v1/chat/completions".to_string(),
                        key.to_string(),
                        true,
                    )
                }
                "ollama" => (
                    "http://localhost:11434/api/chat".to_string(),
                    String::new(),
                    false,
                ),
                _ => unreachable!(),
            };

            // Build initial messages with attachment support
            let user_messages: Vec<serde_json::Value> = request
                .messages
                .iter()
                .filter_map(|m| {
                    let content = build_agent_openai_content(m);
                    if content.is_null() {
                        return None;
                    }
                    Some(serde_json::json!({
                        "role": m.role,
                        "content": content
                    }))
                })
                .collect();

            let mut messages = vec![serde_json::json!({
                "role": "system",
                "content": &system_prompt
            })];
            messages.extend(user_messages);

            // Ollama tool-fallback flag
            let mut use_tools = true;

            loop {
                iteration += 1;
                if cancel_token.is_cancelled() {
                    return Ok(emit_cancelled(&window, conv_id.as_deref(), iteration, &mut accumulated).await);
                }
                if iteration > MAX_ITERATIONS {
                    return Err("Agent reached maximum iteration limit".to_string());
                }

                let _ = window.emit(
                    event_channel,
                    AgentProgress {
                        stage: "thinking".to_string(),
                        tool_name: None,
                        tool_arguments: None,
                        iteration,
                    },
                );

                let mut body = serde_json::json!({
                    "model": request.model,
                    "messages": messages,
                    "stream": !is_ollama,
                });
                if use_tools {
                    body["tools"] = registry.to_openai_json();
                }
                if request.platform == "openrouter" {
                    body["reasoning"] = serde_json::json!({
                        "enabled": true,
                        "exclude": false,
                    });
                }
                if !is_ollama && request.platform != "openai" {
                    apply_zdr(&mut body, restricted);
                }

                let resp = if is_ollama {
                    crate::commands::http_client()
                        .post(&api_url)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|e| format!("Ollama request failed: {}", e))?
                } else {
                    let mut req = crate::commands::http_client()
                        .post(&api_url)
                        .header("Authorization", format!("Bearer {}", api_key));
                    if include_title {
                        req = req.header("X-Title", "Kept");
                    }
                    req.json(&body)
                        .send()
                        .await
                        .map_err(|e| format!("Request failed: {}", e))?
                };

                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    // Ollama tool-fallback: if model doesn't support tools, retry without
                    if is_ollama && use_tools && text.contains("does not support tools") {
                        use_tools = false;
                        iteration -= 1;
                        continue;
                    }
                    return Err(format!(
                        "API error ({}): {}",
                        status,
                        &text[..text.len().min(500)]
                    ));
                }

                // Ollama returns plain JSON; others may return SSE
                let json = if is_ollama {
                    resp.json::<serde_json::Value>()
                        .await
                        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?
                } else {
                    read_openai_streaming_response(
                        resp,
                        "OpenAI-compatible",
                        &window,
                        event_channel,
                        conv_id.as_deref(),
                        iteration,
                        &cancel_token,
                    )
                    .await?
                };

                // Ollama nests under "message"; OpenAI-compat under "choices[0].message"
                let (message_val, finish_reason) = if is_ollama {
                    let m = json["message"].clone();
                    // Ollama signals tool use by presence of tool_calls array
                    let fr = if m["tool_calls"].as_array().is_none_or(|a| a.is_empty()) {
                        "stop".to_string()
                    } else {
                        "tool_calls".to_string()
                    };
                    (m, fr)
                } else {
                    let choice = &json["choices"][0];
                    let m = choice["message"].clone();
                    let fr = choice["finish_reason"].as_str().unwrap_or("").to_string();
                    (m, fr)
                };

                messages.push(message_val.clone());

                // Capture partial content/reasoning into the accumulator so a
                // cancel after this point still saves them. Replace each
                // iteration; the latest assistant turn is the canonical state.
                accumulated.content = message_val["content"]
                    .as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                accumulated.reasoning = message_val["reasoning"]
                    .as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_default();

                if cancel_token.is_cancelled() {
                    return Ok(emit_cancelled(&window, conv_id.as_deref(), iteration, &mut accumulated).await);
                }

                if use_tools && finish_reason == "tool_calls" {
                    if let Some(tool_calls) = message_val["tool_calls"].as_array() {
                        // Parse all tool calls upfront
                        let parsed: Vec<(String, String, serde_json::Value)> = tool_calls
                            .iter()
                            .map(|tc| {
                                let tc_id = tc["id"].as_str().unwrap_or("").to_string();
                                let func_name =
                                    tc["function"]["name"].as_str().unwrap_or("").to_string();
                                let args: serde_json::Value = if is_ollama {
                                    tc["function"]["arguments"].clone()
                                } else {
                                    let args_str =
                                        tc["function"]["arguments"].as_str().unwrap_or("{}");
                                    serde_json::from_str(args_str).unwrap_or(serde_json::json!({}))
                                };
                                (tc_id, func_name, args)
                            })
                            .collect();

                        for (_, func_name, args) in &parsed {
                            accumulated.tool_calls.push(crate::models::ToolCallRecord {
                                name: func_name.clone(),
                                arguments: args.clone(),
                            });
                            let _ = window.emit(
                                event_channel,
                                AgentProgress {
                                    stage: "tool_call".to_string(),
                                    tool_name: Some(func_name.clone()),
                                    tool_arguments: Some(args.clone()),
                                    iteration,
                                },
                            );
                        }

                        // Acquire locks once for the whole batch
                        let (db_arc, kg_arc) = {
                            let db_guard =
                                db.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
                            let db_arc =
                                db_guard.as_ref().ok_or("Database not initialized")?.clone();
                            let kg_guard =
                                kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
                            let kg_arc = kg_guard
                                .as_ref()
                                .ok_or("KG database not initialized")?
                                .clone();
                            (db_arc, kg_arc)
                        };
                        let ctx = crate::tools::ToolContext {
                            db: &db_arc,
                            kg: Some(&kg_arc),
                            config: &cfg,
                            window: Some(&window),
                            consent_map: Some(&consent.0),
                            conversation_id: conv_id.as_deref(),
                        };

                        // Execute all tools in parallel
                        let results = tokio::select! {
                            biased;
                            _ = cancel_token.cancelled() => {
                                return Ok(emit_cancelled(&window, conv_id.as_deref(), iteration, &mut accumulated).await);
                            }
                            res = join_all(parsed.iter().map(|(_, func_name, args)| {
                                registry.execute(func_name, args, &ctx)
                            })) => res,
                        };

                        for ((tc_id, func_name, args), result) in parsed.into_iter().zip(results) {
                            tool_executions.push(ToolExecution {
                                tool_name: func_name.clone(),
                                arguments: args,
                                result: result.clone(),
                            });

                            let _ = window.emit(
                                event_channel,
                                AgentProgress {
                                    stage: "tool_result".to_string(),
                                    tool_name: Some(func_name),
                                    tool_arguments: None,
                                    iteration,
                                },
                            );

                            if is_ollama {
                                messages.push(serde_json::json!({
                                    "role": "tool",
                                    "content": result,
                                }));
                            } else {
                                messages.push(serde_json::json!({
                                    "role": "tool",
                                    "tool_call_id": tc_id,
                                    "content": result,
                                }));
                            }
                        }
                    }
                    continue;
                }

                // Text response — we're done
                let content = if is_ollama {
                    message_val["content"].as_str().unwrap_or("").to_string()
                } else {
                    extract_openai_message_content(&message_val)
                };

                let _ = window.emit(
                    event_channel,
                    AgentProgress {
                        stage: "done".to_string(),
                        tool_name: None,
                        tool_arguments: None,
                        iteration,
                    },
                );

                return Ok(AgentChatResponse {
                    content,
                    tool_executions,
                    iterations: iteration,
                });
            }
        }
        // ── Anthropic native path ────────────────────────────────────────
        "anthropic" => {
            let api_key = cfg
                .anthropic_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("Anthropic API key not configured. Set it in Settings.")?;

            let client = crate::commands::http_client();

            // Build initial messages with attachment support
            let user_messages: Vec<serde_json::Value> = request
                .messages
                .iter()
                .filter_map(|m| {
                    let content = build_agent_anthropic_content(m);
                    if content.is_null() {
                        return None;
                    }
                    Some(serde_json::json!({
                        "role": m.role,
                        "content": content
                    }))
                })
                .collect();

            let mut messages = user_messages;
            let mut thinking_enabled = supports_anthropic_thinking(&request.model);

            loop {
                iteration += 1;
                if cancel_token.is_cancelled() {
                    return Ok(emit_cancelled(&window, conv_id.as_deref(), iteration, &mut accumulated).await);
                }
                if iteration > MAX_ITERATIONS {
                    return Err("Agent reached maximum iteration limit".to_string());
                }

                let _ = window.emit(
                    event_channel,
                    AgentProgress {
                        stage: "thinking".to_string(),
                        tool_name: None,
                        tool_arguments: None,
                        iteration,
                    },
                );

                let mut body = serde_json::json!({
                    "model": request.model,
                    "system": &system_prompt,
                    "messages": messages,
                    "tools": registry.to_anthropic_json(),
                    "max_tokens": if thinking_enabled { 8192 } else { 4096 },
                    "stream": true,
                });
                if thinking_enabled {
                    body["thinking"] = serde_json::json!({
                        "type": "enabled",
                        "budget_tokens": 1024,
                    });
                }

                let resp = client
                    .post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", api_key)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("Anthropic request failed: {}", e))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    let lower = text.to_ascii_lowercase();
                    if thinking_enabled
                        && (lower.contains("thinking")
                            || lower.contains("budget_tokens")
                            || lower.contains("not supported")
                            || lower.contains("unsupported"))
                    {
                        thinking_enabled = false;
                        iteration -= 1;
                        continue;
                    }
                    return Err(format!(
                        "Anthropic API error ({}): {}",
                        status,
                        &text[..text.len().min(500)]
                    ));
                }

                let json = read_anthropic_streaming_response(
                    resp,
                    &window,
                    event_channel,
                    conv_id.as_deref(),
                    iteration,
                    &cancel_token,
                )
                .await?;

                let stop_reason = json["stop_reason"].as_str().unwrap_or("");
                let content_blocks = json["content"].as_array();

                // Collect text and tool_use blocks
                let mut text_parts: Vec<String> = Vec::new();
                let mut tool_uses: Vec<(String, String, serde_json::Value)> = Vec::new();

                if let Some(blocks) = content_blocks {
                    for block in blocks {
                        match block["type"].as_str() {
                            Some("text") => {
                                if let Some(t) = block["text"].as_str() {
                                    text_parts.push(t.to_string());
                                }
                            }
                            Some("tool_use") => {
                                let id = block["id"].as_str().unwrap_or("").to_string();
                                let name = block["name"].as_str().unwrap_or("").to_string();
                                let input = block["input"].clone();
                                tool_uses.push((id, name, input));
                            }
                            _ => {}
                        }
                    }
                }

                // Append assistant message to history (preserve the raw content blocks)
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": json["content"],
                }));

                // Capture text content into accumulator. Anthropic doesn't have a
                // separate streamed reasoning text field on the response root —
                // thinking blocks live inside content; combine plain text parts.
                accumulated.content = text_parts.join("");
                // Reasoning: pull from any thinking blocks within content.
                if let Some(blocks) = json["content"].as_array() {
                    let thinking: String = blocks
                        .iter()
                        .filter_map(|b| {
                            if b["type"].as_str() == Some("thinking") {
                                b["thinking"].as_str().map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !thinking.is_empty() {
                        accumulated.reasoning = thinking;
                    }
                }

                if cancel_token.is_cancelled() {
                    return Ok(emit_cancelled(&window, conv_id.as_deref(), iteration, &mut accumulated).await);
                }

                if stop_reason == "tool_use" && !tool_uses.is_empty() {
                    for (_, func_name, args) in &tool_uses {
                        accumulated.tool_calls.push(crate::models::ToolCallRecord {
                            name: func_name.clone(),
                            arguments: args.clone(),
                        });
                        let _ = window.emit(
                            event_channel,
                            AgentProgress {
                                stage: "tool_call".to_string(),
                                tool_name: Some(func_name.clone()),
                                tool_arguments: Some(args.clone()),
                                iteration,
                            },
                        );
                    }

                    // Acquire locks once for the whole batch
                    let (db_arc, kg_arc) = {
                        let db_guard = db.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
                        let db_arc = db_guard.as_ref().ok_or("Database not initialized")?.clone();
                        let kg_guard = kg.0.lock().map_err(|e| format!("KG lock error: {}", e))?;
                        let kg_arc = kg_guard
                            .as_ref()
                            .ok_or("KG database not initialized")?
                            .clone();
                        (db_arc, kg_arc)
                    };
                    let ctx = crate::tools::ToolContext {
                        db: &db_arc,
                        kg: Some(&kg_arc),
                        config: &cfg,
                        window: Some(&window),
                        consent_map: Some(&consent.0),
                        conversation_id: conv_id.as_deref(),
                    };

                    let results = tokio::select! {
                        biased;
                        _ = cancel_token.cancelled() => {
                            return Ok(emit_cancelled(&window, conv_id.as_deref(), iteration, &mut accumulated).await);
                        }
                        res = join_all(
                            tool_uses
                                .iter()
                                .map(|(_, func_name, args)| registry.execute(func_name, args, &ctx)),
                        ) => res,
                    };

                    let mut tool_results: Vec<serde_json::Value> = Vec::new();
                    for ((tc_id, func_name, args), result) in tool_uses.into_iter().zip(results) {
                        tool_executions.push(ToolExecution {
                            tool_name: func_name.clone(),
                            arguments: args,
                            result: result.clone(),
                        });

                        let _ = window.emit(
                            event_channel,
                            AgentProgress {
                                stage: "tool_result".to_string(),
                                tool_name: Some(func_name),
                                tool_arguments: None,
                                iteration,
                            },
                        );

                        tool_results.push(serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tc_id,
                            "content": result,
                        }));
                    }

                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": tool_results,
                    }));

                    continue;
                }

                // Final text response
                let content = text_parts.join("\n");

                let _ = window.emit(
                    event_channel,
                    AgentProgress {
                        stage: "done".to_string(),
                        tool_name: None,
                        tool_arguments: None,
                        iteration,
                    },
                );

                return Ok(AgentChatResponse {
                    content,
                    tool_executions,
                    iterations: iteration,
                });
            }
        }
        other => Err(format!("Unknown platform: {}", other)),
    }
}

/// Generate a short title for a chat conversation from the first user message.
#[tauri::command]
pub async fn cmd_generate_title(request: TitleRequest) -> Result<String, String> {
    let cfg = config::read_config()?;
    let client = crate::commands::http_client();

    let system = "Write a 1-5 word title for this conversation. Return ONLY the title.\n\nExamples:\nUser: \"How do I center a div in CSS?\" → Centering Divs\nUser: \"I'm feeling stuck on my novel\" → Writing Block\nUser: \"Can you explain quantum entanglement simply?\" → Quantum Entanglement\nUser: \"Help me plan a birthday party for my daughter\" → Birthday Party Planning\nUser: \"What's the best way to learn Rust?\" → Learning Rust";

    let title = match request.platform.as_str() {
        "openai" => {
            let api_key = cfg
                .openai_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("OpenAI API key not configured")?;

            let body = serde_json::json!({
                "model": request.model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": request.message }
                ],
                "max_completion_tokens": 1000,
                "stream": false
            });

            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Title generation failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "OpenAI API error ({}): {}",
                    status,
                    &text[..text.len().min(500)]
                ));
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            json["choices"][0]["message"]["content"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("OpenAI returned empty title. Response: {}", json))?
                .to_string()
        }
        "anthropic" => {
            let api_key = cfg
                .anthropic_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("Anthropic API key not configured")?;

            let body = serde_json::json!({
                "model": request.model,
                "system": system,
                "messages": [
                    { "role": "user", "content": request.message }
                ],
                "max_tokens": 30
            });

            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Title generation failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "Anthropic API error ({}): {}",
                    status,
                    &text[..text.len().min(500)]
                ));
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            json["content"][0]["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("Anthropic returned empty title. Response: {}", json))?
                .to_string()
        }
        "openrouter" => {
            let api_key = cfg
                .openrouter_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("OpenRouter API key not configured")?;
            generate_openai_compatible_title(
                client,
                "https://openrouter.ai/api/v1/chat/completions",
                api_key,
                &request.model,
                &request.message,
                "OpenRouter",
                true,
                is_restricted(&cfg),
            )
            .await?
        }
        other => return Err(format!("Unknown platform: {}", other)),
    };

    // Strip surrounding quotes and whitespace
    let title = title.trim().trim_matches('"').trim().to_string();
    Ok(title)
}

// ── Project conversation suggestions ────────────────────────────────

const SUGGEST_TOOL_NAMES: &[&str] = &[
    "search_conversations",
    "list_conversations",
    "read_conversation",
    "recommend_conversation",
];

/// Suggest conversations for a project using an LLM agent.
/// Auto-selects the best available provider from config.
#[tauri::command]
pub async fn cmd_suggest_project_conversations(
    window: Window,
    db: State<'_, DbState>,
    kg: State<'_, crate::commands::KgState>,
    project_id: String,
    name: String,
    description: String,
) -> Result<crate::models::SuggestProjectResponse, String> {
    let cfg = config::read_config()?;
    let restricted = is_restricted(&cfg);

    // Fetch already-linked conversation titles so the agent can skip them.
    // Each lock is acquired and explicitly dropped to avoid any interaction with
    // the async runtime or the tool-execution locks later in the function.
    let linked_ids: Vec<String> = {
        let guard = kg.0.lock().map_err(|e| format!("KG lock: {}", e))?;
        let ids = match guard.as_ref() {
            Some(kgdb) => kgdb
                .get_project_timeline(&project_id)
                .unwrap_or_default()
                .into_iter()
                .map(|(conv_id, _, _)| conv_id)
                .collect(),
            None => vec![],
        };
        drop(guard);
        ids
    };
    let already_linked: Vec<String> = if linked_ids.is_empty() {
        vec![]
    } else {
        let guard = db.0.lock().map_err(|e| format!("DB lock: {}", e))?;
        let titles = match guard.as_ref() {
            Some(database) => {
                let convs = database.list_conversations(None).unwrap_or_default();
                let id_set: std::collections::HashSet<&str> =
                    linked_ids.iter().map(|s| s.as_str()).collect();
                convs
                    .iter()
                    .filter(|c| id_set.contains(c.conversation_id.as_str()))
                    .map(|c| c.title.clone())
                    .collect()
            }
            None => vec![],
        };
        drop(guard);
        titles
    };

    log::info!(
        "[suggest] project={:?} already_linked={} titles={:?}",
        name,
        already_linked.len(),
        already_linked
    );

    // Pick best available OpenAI-compatible provider
    let (model, api_key, api_url) = if !restricted {
        if let Some(key) = cfg.openai_api_key.as_deref().filter(|k| !k.is_empty()) {
            (
                "gpt-4o".to_string(),
                key.to_string(),
                "https://api.openai.com/v1/chat/completions".to_string(),
            )
        } else if let Some(key) = cfg.anthropic_api_key.as_deref().filter(|k| !k.is_empty()) {
            (
                "claude-sonnet-4-6".to_string(),
                key.to_string(),
                "https://api.anthropic.com/v1/messages".to_string(),
            )
        } else {
            ("".to_string(), "".to_string(), "".to_string())
        }
    } else {
        ("".to_string(), "".to_string(), "".to_string())
    };
    let (model, api_key, api_url, is_anthropic) = if !model.is_empty() {
        let is_anthropic = api_url.contains("anthropic");
        (model, api_key, api_url, is_anthropic)
    } else if let Some(key) = cfg.openrouter_api_key.as_deref().filter(|k| !k.is_empty()) {
        (
            "anthropic/claude-sonnet-4-6".to_string(),
            key.to_string(),
            "https://openrouter.ai/api/v1/chat/completions".to_string(),
            false,
        )
    } else {
        return Err("No API key configured. Set a provider key in Settings.".to_string());
    };

    let exclude_section = if already_linked.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nThe following conversations are ALREADY linked to this project — do NOT recommend them again:\n{}",
            already_linked.iter().map(|t| format!("- {}", t)).collect::<Vec<_>>().join("\n")
        )
    };

    let system_prompt = format!(
        r#"You are a project curator for Kept, a personal AI conversation archive.

Project: "{name}"
Description: "{desc}"

Your task: find conversations that are directly PART OF this project — conversations where the user was actively working on, discussing, building, or debugging this specific project. These are conversations from the user's journey through this project.

A conversation belongs to a project if:
- It directly discusses the project's subject matter (e.g. writing code for it, designing it, debugging it)
- The conversation content shows the user working on tasks that are part of this project
- It contains project-specific terminology, code, or decisions

A conversation does NOT belong if it merely mentions a related topic in passing.

Strategy:
1. First list_conversations to see all available titles.
2. From the titles alone, recommend any that clearly match the project.
3. Then search_conversations with 2-3 keyword queries using specific project terminology.
4. For ambiguous search results, use read_conversation to check a snippet and confirm the conversation is truly part of this project before recommending.
5. Batch multiple recommend_conversation calls in a single response to be efficient.

IMPORTANT: Quality over quantity. Only recommend conversations that are genuinely part of this project's journey. Use search snippets and read_conversation to verify when unsure.{exclude}"#,
        name = name,
        desc = if description.is_empty() {
            "No description provided"
        } else {
            &description
        },
        exclude = exclude_section,
    );

    let registry = crate::tools::ToolRegistry::new(restricted);

    let client = crate::commands::http_client();
    let event_name = "suggest-progress";
    let mut recommendations: Vec<crate::models::ConversationRecommendation> = Vec::new();
    let mut iteration: u32 = 0;
    let max_suggest_iterations: u32 = 15;

    if is_anthropic {
        // Anthropic Messages API path
        let mut messages = vec![serde_json::json!({
            "role": "user",
            "content": "Find conversations relevant to this project and recommend them."
        })];

        let anthropic_tools = registry.to_anthropic_json_for_names(SUGGEST_TOOL_NAMES);

        loop {
            iteration += 1;
            if iteration > max_suggest_iterations {
                break;
            }

            let _ = window.emit(
                event_name,
                AgentProgress {
                    stage: "thinking".to_string(),
                    tool_name: None,
                    tool_arguments: None,
                    iteration,
                },
            );

            let body = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": messages,
                "tools": anthropic_tools,
            });

            let resp = client
                .post(&api_url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "API error ({}): {}",
                    status,
                    &text[..text.len().min(500)]
                ));
            }

            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Parse error: {}", e))?;
            let stop_reason = json["stop_reason"].as_str().unwrap_or("");
            let content_blocks = json["content"].as_array();

            let mut has_tool_use = false;
            let mut assistant_content = Vec::new();
            let mut tool_results = Vec::new();
            let mut final_text = String::new();

            let mut tool_use_blocks: Vec<(String, String, serde_json::Value)> = Vec::new();
            if let Some(blocks) = content_blocks {
                for block in blocks {
                    assistant_content.push(block.clone());
                    match block["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = block["text"].as_str() {
                                final_text.push_str(t);
                            }
                        }
                        Some("tool_use") => {
                            has_tool_use = true;
                            tool_use_blocks.push((
                                block["id"].as_str().unwrap_or("").to_string(),
                                block["name"].as_str().unwrap_or("").to_string(),
                                block["input"].clone(),
                            ));
                        }
                        _ => {}
                    }
                }
            }

            if !tool_use_blocks.is_empty() {
                for (_, tool_name, _) in &tool_use_blocks {
                    let _ = window.emit(
                        event_name,
                        AgentProgress {
                            stage: "tool_call".to_string(),
                            tool_name: Some(tool_name.clone()),
                            tool_arguments: None,
                            iteration,
                        },
                    );
                }

                let db_arc = {
                    let guard = db.0.lock().map_err(|e| format!("DB lock: {}", e))?;
                    guard.as_ref().ok_or("DB not initialized")?.clone()
                };
                let ctx = crate::tools::ToolContext {
                    db: &db_arc,
                    kg: None,
                    config: &cfg,
                    window: Some(&window),
                    consent_map: None,
                    conversation_id: None,
                };

                let registry_ref = &registry;
                let results = join_all(tool_use_blocks.iter().map(|(_, tool_name, args)| {
                    let ctx_ref = &ctx;
                    async move {
                        if tool_name == "recommend_conversation" {
                            let fp = args["file_path"].as_str().unwrap_or("").to_string();
                            let title = args["title"].as_str().unwrap_or("").to_string();
                            let reason = args["reason"].as_str().unwrap_or("").to_string();
                            let conv_id = ctx_ref
                                .db
                                .get_conversation_id_by_path(&fp)
                                .unwrap_or(None)
                                .unwrap_or_default();
                            (
                                format!("Recommendation recorded: {}", title),
                                Some((conv_id, fp, title, reason)),
                            )
                        } else {
                            let result = registry_ref.execute(tool_name, args, ctx_ref).await;
                            (result, None)
                        }
                    }
                }))
                .await;

                for ((tool_id, _tool_name, _args), (result, rec)) in
                    tool_use_blocks.into_iter().zip(results)
                {
                    if let Some((conv_id, file_path, title, reason)) = rec {
                        recommendations.push(crate::models::ConversationRecommendation {
                            conversation_id: conv_id,
                            file_path,
                            title,
                            reason,
                        });
                    }
                    tool_results.push(serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result,
                    }));
                }
            }

            if has_tool_use {
                messages
                    .push(serde_json::json!({ "role": "assistant", "content": assistant_content }));
                messages.push(serde_json::json!({ "role": "user", "content": tool_results }));
                if stop_reason != "tool_use" {
                    break;
                }
                continue;
            }

            let _ = window.emit(
                event_name,
                AgentProgress {
                    stage: "done".to_string(),
                    tool_name: None,
                    tool_arguments: None,
                    iteration,
                },
            );

            return Ok(crate::models::SuggestProjectResponse {
                recommendations,
                summary: final_text,
            });
        }

        let _ = window.emit(
            event_name,
            AgentProgress {
                stage: "done".to_string(),
                tool_name: None,
                tool_arguments: None,
                iteration,
            },
        );

        return Ok(crate::models::SuggestProjectResponse {
            recommendations,
            summary: "Finished analyzing conversations.".to_string(),
        });
    }

    // OpenAI-compatible path (openai, openrouter)
    let include_title = !api_url.contains("openai.com");
    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": system_prompt }),
        serde_json::json!({ "role": "user", "content": "Find conversations relevant to this project and recommend them." }),
    ];

    loop {
        iteration += 1;
        if iteration > max_suggest_iterations {
            break;
        }

        // Throttle to stay under rate limits (~20 RPM → 3s between calls)
        if iteration > 1 {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }

        let _ = window.emit(
            event_name,
            AgentProgress {
                stage: "thinking".to_string(),
                tool_name: None,
                tool_arguments: None,
                iteration,
            },
        );

        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "tools": registry.to_openai_json_for_names(SUGGEST_TOOL_NAMES),
            "stream": false,
        });
        // Force the first call to list_conversations so the agent sees the vault
        if iteration == 1 {
            body["tool_choice"] = serde_json::json!({
                "type": "function",
                "function": { "name": "list_conversations" }
            });
        } else {
            body["tool_choice"] = serde_json::json!("auto");
        }
        apply_zdr(&mut body, restricted);

        // Send request with retry on rate limit (429) and transient errors
        let resp = {
            let mut retries = 0u32;
            loop {
                let mut req = client
                    .post(&api_url)
                    .header("Authorization", format!("Bearer {}", api_key));
                if include_title {
                    req = req.header("X-Title", "Kept");
                }
                match req.json(&body).send().await {
                    Ok(r) if r.status().as_u16() == 429 && retries < 3 => {
                        retries += 1;
                        let wait = Duration::from_secs(5 * retries as u64);
                        let _ = window.emit(
                            event_name,
                            AgentProgress {
                                stage: "tool_call".to_string(),
                                tool_name: Some(format!(
                                    "Rate limited, retry {}/3 in {}s...",
                                    retries,
                                    wait.as_secs()
                                )),
                                tool_arguments: None,
                                iteration,
                            },
                        );
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    Ok(r) => break r,
                    Err(e)
                        if retries < 3 && (e.is_timeout() || e.is_connect() || e.is_request()) =>
                    {
                        retries += 1;
                        let wait = Duration::from_secs(5 * retries as u64);
                        let _ = window.emit(
                            event_name,
                            AgentProgress {
                                stage: "tool_call".to_string(),
                                tool_name: Some(format!(
                                    "Connection error, retry {}/3 in {}s...",
                                    retries,
                                    wait.as_secs()
                                )),
                                tool_arguments: None,
                                iteration,
                            },
                        );
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    Err(e) => {
                        let mut msg = format!("Request failed: {}", e);
                        let mut source = std::error::Error::source(&e);
                        while let Some(cause) = source {
                            msg.push_str(&format!(" — caused by: {}", cause));
                            source = std::error::Error::source(cause);
                        }
                        if e.is_timeout() {
                            msg.push_str(" [TIMEOUT]");
                        }
                        if e.is_connect() {
                            msg.push_str(" [CONNECTION]");
                        }
                        return Err(msg);
                    }
                }
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "API error ({}): {}",
                status,
                &text[..text.len().min(500)]
            ));
        }

        let json = read_json_response(resp, "suggest").await?;
        let choice = &json["choices"][0];
        let message = &choice["message"];
        let finish_reason = choice["finish_reason"].as_str().unwrap_or("");

        log::info!(
            "[suggest] iter={} finish_reason={:?} has_tool_calls={} content_preview={:?}",
            iteration,
            finish_reason,
            message["tool_calls"]
                .as_array()
                .map(|a| a.len())
                .unwrap_or(0),
            message["content"].as_str().map(|s| &s[..s.len().min(120)]),
        );

        messages.push(message.clone());

        // Check for tool calls — some providers (e.g. Gemini via OpenRouter) return
        // tool_calls with finish_reason "stop" instead of "tool_calls"
        let has_tool_calls = message["tool_calls"]
            .as_array()
            .is_some_and(|a| !a.is_empty());
        if has_tool_calls {
            if let Some(tool_calls) = message["tool_calls"].as_array() {
                let parsed: Vec<(String, String, serde_json::Value)> = tool_calls
                    .iter()
                    .map(|tc| {
                        let tc_id = tc["id"].as_str().unwrap_or("").to_string();
                        let func_name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                        let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                        let args: serde_json::Value =
                            serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
                        (tc_id, func_name, args)
                    })
                    .collect();

                for (_, func_name, args) in &parsed {
                    let _ = window.emit(
                        event_name,
                        AgentProgress {
                            stage: "tool_call".to_string(),
                            tool_name: Some(func_name.clone()),
                            tool_arguments: Some(args.clone()),
                            iteration,
                        },
                    );
                }

                let db_arc = {
                    let guard = db.0.lock().map_err(|e| format!("DB lock: {}", e))?;
                    guard.as_ref().ok_or("DB not initialized")?.clone()
                };
                let ctx = crate::tools::ToolContext {
                    db: &db_arc,
                    kg: None,
                    config: &cfg,
                    window: Some(&window),
                    consent_map: None,
                    conversation_id: None,
                };

                let registry_ref = &registry;
                let results = join_all(parsed.iter().map(|(_, func_name, args)| {
                    let ctx_ref = &ctx;
                    async move {
                        if func_name == "recommend_conversation" {
                            let fp = args["file_path"].as_str().unwrap_or("").to_string();
                            let title = args["title"].as_str().unwrap_or("").to_string();
                            let reason = args["reason"].as_str().unwrap_or("").to_string();
                            let conv_id = ctx_ref
                                .db
                                .get_conversation_id_by_path(&fp)
                                .unwrap_or(None)
                                .unwrap_or_default();
                            (
                                format!("Recommendation recorded: {}", title),
                                Some((conv_id, fp, title, reason)),
                            )
                        } else {
                            let result = registry_ref.execute(func_name, args, ctx_ref).await;
                            (result, None)
                        }
                    }
                }))
                .await;

                for ((tc_id, func_name, _args), (result, rec)) in parsed.into_iter().zip(results) {
                    if let Some((conv_id, file_path, title, reason)) = rec {
                        recommendations.push(crate::models::ConversationRecommendation {
                            conversation_id: conv_id,
                            file_path,
                            title,
                            reason,
                        });
                    }

                    log::info!(
                        "[suggest] tool={} result_len={} result_preview={:?}",
                        func_name,
                        result.len(),
                        &result[..result.len().min(200)],
                    );

                    messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": result,
                    }));
                }
            }
            continue;
        }

        let content = extract_openai_message_content(message);

        let _ = window.emit(
            event_name,
            AgentProgress {
                stage: "done".to_string(),
                tool_name: None,
                tool_arguments: None,
                iteration,
            },
        );

        return Ok(crate::models::SuggestProjectResponse {
            recommendations,
            summary: content,
        });
    }

    let _ = window.emit(
        event_name,
        AgentProgress {
            stage: "done".to_string(),
            tool_name: None,
            tool_arguments: None,
            iteration,
        },
    );

    Ok(crate::models::SuggestProjectResponse {
        recommendations,
        summary: "Finished analyzing conversations.".to_string(),
    })
}

/// HTTP-friendly agent chat — takes Arc<Database> directly, no Tauri Window needed.
/// Auto-selects the best available provider from config.
pub async fn agent_chat_http(
    db: &crate::db::Database,
    prompt: &str,
    url: &str,
    page_title: &str,
    page_content: &str,
    has_selection: bool,
) -> Result<AgentChatResponse, String> {
    let cfg = config::read_config()?;

    let restricted = is_restricted(&cfg);

    // Pick best available provider + model (skip Anthropic/OpenAI direct in restricted mode)
    let (provider, model, api_key, api_url) = if !restricted {
        if let Some(key) = cfg.anthropic_api_key.as_deref().filter(|k| !k.is_empty()) {
            (
                "anthropic".to_string(),
                "claude-sonnet-4-6".to_string(),
                key.to_string(),
                None,
            )
        } else if let Some(key) = cfg.openai_api_key.as_deref().filter(|k| !k.is_empty()) {
            (
                "openai".to_string(),
                "gpt-4o".to_string(),
                key.to_string(),
                Some("https://api.openai.com/v1/chat/completions".to_string()),
            )
        } else {
            // fall through to OpenRouter below
            ("".to_string(), "".to_string(), "".to_string(), None)
        }
    } else {
        ("".to_string(), "".to_string(), "".to_string(), None)
    };
    let (provider, model, api_key, api_url) = if !provider.is_empty() {
        (provider, model, api_key, api_url)
    } else if let Some(key) = cfg.openrouter_api_key.as_deref().filter(|k| !k.is_empty()) {
        (
            "openrouter".to_string(),
            "anthropic/claude-sonnet-4-6".to_string(),
            key.to_string(),
            Some("https://openrouter.ai/api/v1/chat/completions".to_string()),
        )
    } else {
        return Err(
            "No API key configured. Set OpenAI, Anthropic, or OpenRouter in Settings.".to_string(),
        );
    };

    // Build system prompt with page context
    let page_context = if !page_content.is_empty() {
        let label = if has_selection {
            "Selected text"
        } else {
            "Page content"
        };
        format!(
            "\n\nThe user is currently browsing: {} (\"{}\")\n\n<{}>\n{}\n</{}>",
            url,
            page_title,
            label.to_lowercase().replace(' ', "_"),
            page_content,
            label.to_lowercase().replace(' ', "_"),
        )
    } else {
        format!("\n\nThe user is currently browsing: {}", url)
    };

    let system = format!(
        "{}{}\n\nKeep your responses concise — this is shown in a small overlay in their browser. You can reference the page content to answer questions about what the user is looking at.",
        SYSTEM_PROMPT, page_context
    );

    let registry = crate::tools::ToolRegistry::new(restricted);
    let client = crate::commands::http_client();
    let mut tool_executions: Vec<ToolExecution> = Vec::new();
    let mut iteration: u32 = 0;

    match provider.as_str() {
        "anthropic" => {
            let mut messages = vec![serde_json::json!({
                "role": "user",
                "content": prompt
            })];

            loop {
                iteration += 1;
                if iteration > MAX_ITERATIONS {
                    return Err("Agent reached maximum iteration limit".to_string());
                }

                let body = serde_json::json!({
                    "model": model,
                    "system": system,
                    "messages": messages,
                    "tools": registry.to_anthropic_json(),
                    "max_tokens": 4096,
                });

                let resp = client
                    .post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", &api_key)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("Anthropic request failed: {}", e))?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(format!(
                        "API error ({}): {}",
                        status,
                        &text[..text.len().min(500)]
                    ));
                }

                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("Failed to parse response: {}", e))?;

                let stop_reason = json["stop_reason"].as_str().unwrap_or("");
                let content_blocks = json["content"].as_array();

                let mut text_parts: Vec<String> = Vec::new();
                let mut tool_uses: Vec<(String, String, serde_json::Value)> = Vec::new();

                if let Some(blocks) = content_blocks {
                    for block in blocks {
                        match block["type"].as_str() {
                            Some("text") => {
                                if let Some(t) = block["text"].as_str() {
                                    text_parts.push(t.to_string());
                                }
                            }
                            Some("tool_use") => {
                                let id = block["id"].as_str().unwrap_or("").to_string();
                                let name = block["name"].as_str().unwrap_or("").to_string();
                                let input = block["input"].clone();
                                tool_uses.push((id, name, input));
                            }
                            _ => {}
                        }
                    }
                }

                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": json["content"],
                }));

                if stop_reason == "tool_use" && !tool_uses.is_empty() {
                    let ctx = crate::tools::ToolContext {
                        db,
                        kg: None,
                        config: &cfg,
                        window: None,
                        consent_map: None,
                        conversation_id: None,
                    };

                    let results = join_all(
                        tool_uses
                            .iter()
                            .map(|(_, func_name, args)| registry.execute(func_name, args, &ctx)),
                    )
                    .await;

                    let mut tool_results: Vec<serde_json::Value> = Vec::new();
                    for ((tc_id, func_name, args), result) in tool_uses.into_iter().zip(results) {
                        tool_executions.push(ToolExecution {
                            tool_name: func_name.clone(),
                            arguments: args,
                            result: result.clone(),
                        });
                        tool_results.push(serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tc_id,
                            "content": result,
                        }));
                    }

                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": tool_results,
                    }));

                    continue;
                }

                let content = text_parts.join("\n");
                return Ok(AgentChatResponse {
                    content,
                    tool_executions,
                    iterations: iteration,
                });
            }
        }
        "openai" | "openrouter" => {
            let api_url = api_url
                .as_deref()
                .ok_or("Missing API URL for provider".to_string())?;

            let mut messages = vec![
                serde_json::json!({ "role": "system", "content": system }),
                serde_json::json!({ "role": "user", "content": prompt }),
            ];

            loop {
                iteration += 1;
                if iteration > MAX_ITERATIONS {
                    return Err("Agent reached maximum iteration limit".to_string());
                }

                let mut body = serde_json::json!({
                    "model": model,
                    "messages": messages,
                    "tools": registry.to_openai_json(),
                    "stream": false,
                });
                if provider != "openai" {
                    apply_zdr(&mut body, restricted);
                }

                let resp = client
                    .post(api_url)
                    .header("Authorization", format!("Bearer {}", api_key));
                let resp = if provider == "openai" {
                    resp.json(&body)
                        .send()
                        .await
                        .map_err(|e| format!("API request failed: {}", e))?
                } else {
                    resp.header("X-Title", "Kept")
                        .json(&body)
                        .send()
                        .await
                        .map_err(|e| format!("API request failed: {}", e))?
                };

                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(format!(
                        "API error ({}): {}",
                        status,
                        &text[..text.len().min(500)]
                    ));
                }

                let json = read_json_response(resp, "OpenAI-compatible agent").await?;

                let choice = &json["choices"][0];
                let message = &choice["message"];
                let finish_reason = choice["finish_reason"].as_str().unwrap_or("");

                messages.push(message.clone());

                if finish_reason == "tool_calls" {
                    if let Some(tool_calls) = message["tool_calls"].as_array() {
                        let parsed: Vec<(String, String, serde_json::Value)> = tool_calls
                            .iter()
                            .map(|tc| {
                                let tc_id = tc["id"].as_str().unwrap_or("").to_string();
                                let func_name =
                                    tc["function"]["name"].as_str().unwrap_or("").to_string();
                                let args: serde_json::Value = tc["function"]["arguments"]
                                    .as_str()
                                    .and_then(|s| serde_json::from_str(s).ok())
                                    .unwrap_or(serde_json::json!({}));
                                (tc_id, func_name, args)
                            })
                            .collect();

                        let ctx = crate::tools::ToolContext {
                            db,
                            kg: None,
                            config: &cfg,
                            window: None,
                            consent_map: None,
                            conversation_id: None,
                        };

                        let results =
                            join_all(parsed.iter().map(|(_, func_name, args)| {
                                registry.execute(func_name, args, &ctx)
                            }))
                            .await;

                        for ((tc_id, func_name, args), result) in parsed.into_iter().zip(results) {
                            tool_executions.push(ToolExecution {
                                tool_name: func_name,
                                arguments: args,
                                result: result.clone(),
                            });
                            messages.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tc_id,
                                "content": result,
                            }));
                        }
                        continue;
                    }
                }

                let content = extract_openai_message_content(message);
                return Ok(AgentChatResponse {
                    content,
                    tool_executions,
                    iterations: iteration,
                });
            }
        }
        _ => Err(format!("Unsupported provider: {}", provider)),
    }
}

/// Save a Kept chat conversation to the vault and index it in the database.
#[tauri::command]
pub fn cmd_save_kept_chat(
    payload: IngestPayload,
    db_state: State<DbState>,
) -> Result<String, String> {
    let (file_path, hash, skipped) = vault::save_conversation(&payload, None)?;

    if !skipped {
        let guard = db_state
            .0
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        if let Some(ref db) = *guard {
            db.upsert_conversation(&payload, &file_path, &hash)?;
        }
    }

    Ok(file_path)
}

/// Cancel an in-flight `cmd_agent_chat` for the given conversation.
/// Idempotent — cancelling an unknown id is a no-op.
#[tauri::command]
pub fn cmd_agent_cancel(
    state: tauri::State<'_, crate::commands::AgentCancelState>,
    conversation_id: String,
) -> Result<(), String> {
    if let Ok(map) = state.0.lock() {
        if let Some(token) = map.get(&conversation_id) {
            token.cancel();
        }
    }
    Ok(())
}

#[cfg(test)]
mod cancel_tests {
    use super::*;

    #[test]
    fn partial_accumulator_round_trips_into_response_via_take() {
        let mut acc = PartialAccumulator {
            content: "Partial answer".into(),
            reasoning: "Thinking step".into(),
            tool_calls: vec![crate::models::ToolCallRecord {
                name: "search_nodes".into(),
                arguments: serde_json::json!({"q": "x"}),
            }],
        };
        let content = std::mem::take(&mut acc.content);
        assert_eq!(content, "Partial answer");
        assert_eq!(acc.reasoning, "Thinking step");
        assert_eq!(acc.tool_calls.len(), 1);
    }
}
