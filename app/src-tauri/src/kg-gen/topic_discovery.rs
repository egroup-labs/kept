use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
    pub id: String,
    pub name: String,
    pub description: String,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TopicResponse {
    topics: Vec<Topic>,
}

/// Maximum characters for the discovery prompt in a single LLM call.
/// ~25K tokens — generous for cloud models, auto-batches only for very large vaults.
const MAX_PROMPT_CHARS: usize = 100_000;

const SYSTEM_PROMPT: &str = r#"You are analyzing a corpus of AI conversations to discover the broad interest areas and domains the user works in.

You will receive a numbered list of conversations, each with a title and top keywords.

Your task: identify the user's 5-20 broad interest areas — the kind of categories they would mentally file their work under. Think like a user organizing a bookshelf, not like a librarian cataloguing individual items.

IMPORTANT:
- Topics must be BROAD domains, not individual projects or tasks. "Web Development" is a good topic. "Chrome Extension Authentication" is too narrow — that's a single project.
- Multiple related conversations should map to the same topic. If you see 5 conversations about React, CSS, and Chrome extensions, they all belong under something like "Web Development" or "Frontend Engineering".
- Prefer 2-3 word names that a user would naturally say: "Machine Learning", "Finance & Trading", "DevOps", "Academic Writing".
- Aim for 8-20 topics. Fewer broad topics is better than many narrow ones, but don't collapse genuinely distinct areas together (e.g. "Machine Learning" and "Web Development" should stay separate).

Each topic needs:
- "id": kebab-case slug (e.g. "web-development")
- "name": short human-readable name (e.g. "Web Development")
- "description": 3-5 sentences describing the broad area, what kinds of work and questions fall under it
- "keywords": You MUST provide 20-40 search terms per topic. This is critical — more keywords means better search coverage. Layer them from broad to specific:
  * Broad domain terms (e.g. "machine learning", "frontend", "trading")
  * Subtopics (e.g. "reinforcement learning", "CSS layout", "backtesting")
  * Specific tools/libraries (e.g. "PyTorch", "React", "pandas")
  * Techniques/methods (e.g. "backpropagation", "responsive design", "momentum strategy")
  * Jargon/acronyms (e.g. "CNN", "REST API", "sharpe ratio")
  Generate these yourself. The goal is to cast a wide net so any conversation in this area matches several keywords.

Output ONLY valid JSON matching this schema, no markdown fences, no explanation:
{"topics": [{"id": "...", "name": "...", "description": "...", "keywords": ["...", ...]}, ...]}
"#;

const MERGE_SYSTEM_PROMPT: &str = r#"You are consolidating topic lists discovered independently from different batches of conversations belonging to the same user.

Your task: merge overlapping topics into a single coherent taxonomy of 5-20 broad topics.

Rules:
- Merge topics that cover the same broad domain (e.g. "Web Development" and "Frontend Engineering" should become one topic)
- Keep genuinely distinct topics even if they appeared in only one batch
- Prefer broader, more inclusive names
- Combine and deduplicate keywords from merged topics
- Update descriptions to reflect the merged scope
- Aim for 8-20 final topics

Output ONLY valid JSON, no markdown fences:
{"topics": [{"id": "kebab-case", "name": "Short Name", "description": "3-5 sentences.", "keywords": ["term1", ..., "term40"]}, ...]}
"#;

/// Build a compact summary line for a conversation: title, keywords, and first user prompt.
fn conversation_summary_line(
    index: usize,
    conv: &super::keyword_extract::ConversationKeywords,
) -> String {
    let top_keywords: Vec<&str> = conv
        .keywords
        .iter()
        .take(15)
        .map(|k| k.term.as_str())
        .collect();

    let mut line = format!(
        "{}. \"{}\" — keywords: {}",
        index,
        conv.title,
        top_keywords.join(", ")
    );

    // Include the first user prompt (truncated) for actual conversation context
    if let Some(first_prompt) = conv.user_prompts.first() {
        let truncated: String = first_prompt
            .lines()
            .take(3)
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(200)
            .collect();
        if !truncated.is_empty() {
            line.push_str(&format!("\n   First prompt: {}", truncated));
        }
    }

    line.push('\n');
    line
}

/// Build the user prompt from conversation keywords.
pub fn build_discovery_prompt(
    conversations: &[super::keyword_extract::ConversationKeywords],
) -> String {
    let mut prompt = String::with_capacity(conversations.len() * 300);
    for (i, conv) in conversations.iter().enumerate() {
        prompt.push_str(&conversation_summary_line(i + 1, conv));
    }
    prompt
}

/// Parse the LLM response into topics. Extracts JSON from the response text,
/// handling cases where the model wraps it in markdown fences.
pub fn parse_topics_response(response: &str) -> Result<Vec<Topic>, String> {
    // Try to find JSON in the response (model might wrap in ```json ... ```)
    let json_str = if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            &response[start..=end]
        } else {
            response
        }
    } else {
        response
    };

    let parsed: TopicResponse = serde_json::from_str(json_str).map_err(|e| {
        format!(
            "Failed to parse topics JSON: {}. Response: {}",
            e,
            &response[..response.len().min(200)]
        )
    })?;

    if parsed.topics.is_empty() {
        return Err("LLM returned zero topics".to_string());
    }

    Ok(parsed.topics)
}

/// Send a non-streaming chat completion request to the specified provider.
/// Returns the assistant's response text.
pub async fn llm_call(
    provider: &str,
    model: &str,
    system: &str,
    user_message: &str,
) -> Result<String, String> {
    let cfg = crate::config::read_config()?;
    let client = crate::commands::http_client();

    match provider {
        "openai" => {
            let api_key = cfg
                .openai_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("OpenAI API key not configured. Set it in Settings.")?;
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user_message }
                ],
            });
            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("OpenAI request failed: {}", e))?;
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
                .map_err(|e| format!("Failed to parse OpenAI response: {}", e))?;
            Ok(json["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        "anthropic" => {
            let api_key = cfg
                .anthropic_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("Anthropic API key not configured. Set it in Settings.")?;
            let body = serde_json::json!({
                "model": model,
                "system": system,
                "messages": [
                    { "role": "user", "content": user_message }
                ],
                "max_tokens": 8192,
            });
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
                return Err(format!(
                    "Anthropic API error ({}): {}",
                    status,
                    &text[..text.len().min(500)]
                ));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse Anthropic response: {}", e))?;
            Ok(json["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        "ollama" => {
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user_message }
                ],
                "stream": false,
            });
            let resp = client
                .post("http://localhost:11434/api/chat")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Ollama request failed: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "Ollama API error ({}): {}",
                    status,
                    &text[..text.len().min(500)]
                ));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;
            Ok(json["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        "openrouter" => {
            let api_key = cfg
                .openrouter_api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or("OpenRouter API key not configured. Set it in Settings.")?;
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user_message }
                ],
            });
            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Authorization", format!("Bearer {}", api_key))
                .header("X-Title", "Kept")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("OpenRouter request failed: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "OpenRouter API error ({}): {}",
                    status,
                    &text[..text.len().min(500)]
                ));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse OpenRouter response: {}", e))?;
            Ok(json["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        other => Err(format!("Unknown provider: {}", other)),
    }
}

/// Split conversations into contiguous ranges where each batch's prompt fits within max_chars.
fn batch_conversation_ranges(
    conversations: &[super::keyword_extract::ConversationKeywords],
    max_chars: usize,
) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut batch_start = 0;
    let mut current_chars: usize = 0;

    for (i, conv) in conversations.iter().enumerate() {
        let line_len = conversation_summary_line(i - batch_start + 1, conv).len();

        if current_chars + line_len > max_chars && i > batch_start {
            ranges.push(batch_start..i);
            batch_start = i;
            current_chars = 0;
        }

        current_chars += line_len;
    }

    if batch_start < conversations.len() {
        ranges.push(batch_start..conversations.len());
    }

    ranges
}

fn build_merge_prompt(topics: &[Topic]) -> String {
    let mut prompt = format!(
        "Consolidate these {} topics discovered from separate conversation batches:\n\n",
        topics.len()
    );
    for (i, topic) in topics.iter().enumerate() {
        prompt.push_str(&format!(
            "{}. {} ({})\n   {}\n   Keywords: {}\n\n",
            i + 1,
            topic.name,
            topic.id,
            topic.description,
            topic.keywords.join(", ")
        ));
    }
    prompt
}

/// Single-pass topic discovery with one retry on parse failure.
async fn discover_topics_single(
    provider: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<Vec<Topic>, String> {
    let response = llm_call(provider, model, system_prompt, user_prompt).await?;

    match parse_topics_response(&response) {
        Ok(topics) => Ok(topics),
        Err(first_err) => {
            let retry_prompt = format!(
                "Your previous response was not valid JSON. The error was: {}\n\nPlease output ONLY valid JSON matching the schema, no markdown fences:\n{{\"topics\": [{{\"id\": \"...\", \"name\": \"...\", \"description\": \"...\", \"keywords\": [\"...\"]}}]}}",
                first_err
            );
            let retry_response = llm_call(provider, model, system_prompt, &retry_prompt).await?;
            parse_topics_response(&retry_response)
        }
    }
}

/// Discover topics from the full vault using an LLM.
/// Automatically batches if the corpus exceeds the prompt size limit, then merges results.
pub async fn discover_topics(
    provider: &str,
    model: &str,
    conversations: &[super::keyword_extract::ConversationKeywords],
) -> Result<Vec<Topic>, String> {
    let full_prompt = build_discovery_prompt(conversations);

    if full_prompt.len() <= MAX_PROMPT_CHARS {
        return discover_topics_single(provider, model, SYSTEM_PROMPT, &full_prompt).await;
    }

    // Batch mode — split, discover per batch, merge
    let ranges = batch_conversation_ranges(conversations, MAX_PROMPT_CHARS);
    let mut all_topics: Vec<Topic> = Vec::new();

    for (batch_idx, range) in ranges.iter().enumerate() {
        let batch = &conversations[range.clone()];
        let prompt = build_discovery_prompt(batch);
        match discover_topics_single(provider, model, SYSTEM_PROMPT, &prompt).await {
            Ok(topics) => all_topics.extend(topics),
            Err(e) => {
                eprintln!(
                    "Batch {}/{} topic discovery failed: {}",
                    batch_idx + 1,
                    ranges.len(),
                    e
                );
            }
        }
    }

    if all_topics.is_empty() {
        return Err("All topic discovery batches failed".to_string());
    }

    // Single batch succeeded — no merge needed
    if ranges.len() == 1 {
        return Ok(all_topics);
    }

    // Merge pass — consolidate overlapping topics from different batches
    let merge_prompt = build_merge_prompt(&all_topics);
    discover_topics_single(provider, model, MERGE_SYSTEM_PROMPT, &merge_prompt).await
}

// ── Topic ↔ Conversation Classification ─────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT: &str = r#"You are classifying conversations into topics.

You will receive:
- A list of topics, each with an id, name, and description
- A numbered list of conversations, each with a title and top keywords

Your task: for each conversation, select which topic(s) it belongs to. A conversation belongs to a topic if its subject matter falls within the topic's domain — use your judgement about semantic relevance.

Be inclusive rather than exclusive — if a conversation is even partially about a topic, include it. A conversation can belong to multiple topics.

Output ONLY a JSON object mapping topic IDs to arrays of conversation numbers. Only include topics that have at least one match. No markdown fences, no explanation:
{"web-development": [1, 3, 7], "machine-learning": [2, 4, 5, 7]}
"#;

/// Result of classifying conversations against topics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicAssignment {
    pub topic_id: String,
    pub topic_name: String,
    /// Indices into the original conversations slice.
    pub conversation_indices: Vec<usize>,
}

fn build_classify_prompt(
    topics: &[Topic],
    conversations: &[super::keyword_extract::ConversationKeywords],
) -> String {
    let mut prompt = String::from("Topics:\n");
    for topic in topics {
        prompt.push_str(&format!(
            "- {} (id: {}): {}\n",
            topic.name, topic.id, topic.description
        ));
    }
    prompt.push_str("\nConversations:\n");
    for (i, conv) in conversations.iter().enumerate() {
        prompt.push_str(&conversation_summary_line(i + 1, conv));
    }
    prompt
}

/// Estimate the character length of a classify prompt for a given topic + conversation count.
/// Used for batching decisions without building the full prompt.
fn estimate_classify_prompt_len(topics: &[Topic], conv_count: usize) -> usize {
    // Topic list: ~150 chars per topic
    let header = topics.len() * 150;
    // Each conversation: ~300 chars (title + keywords + truncated first prompt)
    header + conv_count * 300
}

/// Parse the batch classify response: {"topic-id": [1, 3, 7], ...}
fn parse_batch_classify_response(
    response: &str,
    max_index: usize,
) -> std::collections::HashMap<String, Vec<usize>> {
    let json_str = if let Some(start) = response.find('{') {
        if let Some(end) = response.rfind('}') {
            &response[start..=end]
        } else {
            response
        }
    } else {
        response
    };

    let parsed: std::collections::HashMap<String, Vec<serde_json::Value>> =
        match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(_) => return Default::default(),
        };

    parsed
        .into_iter()
        .map(|(topic_id, indices)| {
            let valid: Vec<usize> = indices
                .iter()
                .filter_map(|v| v.as_u64().map(|n| n as usize))
                .filter(|&n| n >= 1 && n <= max_index)
                .map(|n| n - 1)
                .collect();
            (topic_id, valid)
        })
        .filter(|(_, v)| !v.is_empty())
        .collect()
}

/// Classify conversations into topics in a single LLM call (or batched by prompt size).
/// All topics are sent together so the model maps each conversation to its topic(s) at once.
pub async fn classify_conversations(
    provider: &str,
    model: &str,
    topics: &[Topic],
    conversations: &[super::keyword_extract::ConversationKeywords],
) -> Result<Vec<TopicAssignment>, String> {
    let merged = if estimate_classify_prompt_len(topics, conversations.len()) <= MAX_PROMPT_CHARS {
        classify_batch(provider, model, topics, conversations).await?
    } else {
        // Split conversations into ranges that fit, union results
        let ranges = batch_conversation_ranges(conversations, MAX_PROMPT_CHARS);
        let mut merged: std::collections::HashMap<String, Vec<usize>> = Default::default();
        for range in &ranges {
            let batch = &conversations[range.clone()];
            match classify_batch(provider, model, topics, batch).await {
                Ok(batch_map) => {
                    for (tid, indices) in batch_map {
                        merged
                            .entry(tid)
                            .or_default()
                            .extend(indices.iter().map(|&i| i + range.start));
                    }
                }
                Err(e) => {
                    eprintln!("Classification batch failed: {}", e);
                }
            }
        }
        merged
    };

    let assignments = topics
        .iter()
        .map(|t| TopicAssignment {
            topic_id: t.id.clone(),
            topic_name: t.name.clone(),
            conversation_indices: merged.get(&t.id).cloned().unwrap_or_default(),
        })
        .collect();

    Ok(assignments)
}

async fn classify_batch(
    provider: &str,
    model: &str,
    topics: &[Topic],
    conversations: &[super::keyword_extract::ConversationKeywords],
) -> Result<std::collections::HashMap<String, Vec<usize>>, String> {
    let prompt = build_classify_prompt(topics, conversations);
    let response = llm_call(provider, model, CLASSIFY_SYSTEM_PROMPT, &prompt).await?;
    let result = parse_batch_classify_response(&response, conversations.len());

    if result.is_empty() {
        // Retry once — the model might have returned prose instead of JSON
        let retry_prompt = format!(
            "Your previous response was not valid JSON. Please output ONLY a JSON object mapping topic IDs to arrays of conversation numbers, e.g. {{\"web-dev\": [1, 3], \"ml\": [2, 5]}}. If no conversations match any topic, output {{}}.\n\n{}",
            prompt
        );
        let retry_response =
            llm_call(provider, model, CLASSIFY_SYSTEM_PROMPT, &retry_prompt).await?;
        Ok(parse_batch_classify_response(
            &retry_response,
            conversations.len(),
        ))
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_topics_response_clean_json() {
        let json = r#"{"topics": [{"id": "web-dev", "name": "Web Development", "description": "Building web apps.", "keywords": ["react", "html"]}]}"#;
        let topics = parse_topics_response(json).unwrap();
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].id, "web-dev");
        assert_eq!(topics[0].name, "Web Development");
        assert_eq!(topics[0].keywords, vec!["react", "html"]);
    }

    #[test]
    fn test_parse_topics_response_markdown_fenced() {
        let json = "Here are the topics:\n```json\n{\"topics\": [{\"id\": \"ml\", \"name\": \"Machine Learning\", \"description\": \"ML stuff.\", \"keywords\": [\"neural\"]}]}\n```";
        let topics = parse_topics_response(json).unwrap();
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].id, "ml");
    }

    #[test]
    fn test_parse_topics_response_invalid() {
        let result = parse_topics_response("not json at all");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_topics_response_empty_topics() {
        let json = r#"{"topics": []}"#;
        let result = parse_topics_response(json);
        assert!(result.is_err());
    }

    #[tokio::test]
    #[ignore] // run with: cargo test test_real_topic_discovery -- --ignored --nocapture
    async fn test_real_topic_discovery() {
        let vault_dir = dirs::home_dir().unwrap().join(".kept/vault");
        if !vault_dir.exists() {
            eprintln!("No vault at {:?}, skipping", vault_dir);
            return;
        }

        // Read vault conversations
        let mut docs: Vec<(String, String, String, String)> = Vec::new();
        for platform_entry in std::fs::read_dir(&vault_dir).unwrap() {
            let platform_entry = platform_entry.unwrap();
            let platform = platform_entry.file_name().to_string_lossy().to_string();
            if !platform_entry.file_type().unwrap().is_dir() {
                continue;
            }
            for file_entry in std::fs::read_dir(platform_entry.path()).unwrap() {
                let file_entry = file_entry.unwrap();
                let path = file_entry.path();
                if path.extension().map(|e| e != "md").unwrap_or(true) {
                    continue;
                }
                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let title = if content.starts_with("---") {
                    content
                        .lines()
                        .find(|l| l.starts_with("title:"))
                        .map(|l| {
                            l.trim_start_matches("title:")
                                .trim()
                                .trim_matches('"')
                                .to_string()
                        })
                        .unwrap_or_else(|| path.file_stem().unwrap().to_string_lossy().to_string())
                } else {
                    path.file_stem().unwrap().to_string_lossy().to_string()
                };
                let body = if let Some(rest) = content.strip_prefix("---") {
                    if let Some(end) = rest.find("---") {
                        rest[end + 3..].to_string()
                    } else {
                        content.clone()
                    }
                } else {
                    content.clone()
                };
                docs.push((
                    path.to_string_lossy().to_string(),
                    title,
                    platform.clone(),
                    body,
                ));
            }
        }

        // Limit to first 50 conversations
        docs.truncate(50);
        eprintln!("Using {} conversations for topic discovery", docs.len());

        let doc_refs: Vec<(&str, &str, &str, &str)> = docs
            .iter()
            .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
            .collect();

        let conversations = super::super::keyword_extract::extract_keywords_from_corpus(&doc_refs);

        // Print the prompt being sent
        let prompt = build_discovery_prompt(&conversations);
        eprintln!("\n=== PROMPT ({} chars) ===\n{}\n", prompt.len(), prompt);

        // Call LLM
        let topics = discover_topics("openai", "gpt-5-nano", &conversations)
            .await
            .unwrap();

        // Format output
        let mut output = String::new();
        output.push_str(&format!(
            "=== Topic Discovery Results ({} topics from {} conversations) ===\n\n",
            topics.len(),
            conversations.len()
        ));
        for (i, topic) in topics.iter().enumerate() {
            output.push_str(&format!("{}. {} ({})\n", i + 1, topic.name, topic.id));
            output.push_str(&format!("   {}\n", topic.description));
            output.push_str(&format!("   Keywords: {}\n\n", topic.keywords.join(", ")));
        }

        eprintln!("{}", output);

        // Write to file
        let out_path = std::env::current_dir()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap() // from src-tauri up to project root
            .join("discovered_topics.txt");
        std::fs::write(&out_path, &output).unwrap();
        eprintln!("Written to {:?}", out_path);

        // Also write JSON
        let json_path = out_path.with_extension("json");
        let json = serde_json::to_string_pretty(&topics).unwrap();
        std::fs::write(&json_path, &json).unwrap();
        eprintln!("JSON written to {:?}", json_path);
    }

    #[tokio::test]
    #[ignore] // run with: cargo test test_real_full_pipeline -- --ignored --nocapture
    async fn test_real_full_pipeline() {
        let vault_dir = dirs::home_dir().unwrap().join(".kept/vault");
        if !vault_dir.exists() {
            eprintln!("No vault at {:?}, skipping", vault_dir);
            return;
        }

        // Read vault
        let mut docs: Vec<(String, String, String, String)> = Vec::new();
        for platform_entry in std::fs::read_dir(&vault_dir).unwrap() {
            let platform_entry = platform_entry.unwrap();
            let platform = platform_entry.file_name().to_string_lossy().to_string();
            if !platform_entry.file_type().unwrap().is_dir() {
                continue;
            }
            for file_entry in std::fs::read_dir(platform_entry.path()).unwrap() {
                let file_entry = file_entry.unwrap();
                let path = file_entry.path();
                if path.extension().map(|e| e != "md").unwrap_or(true) {
                    continue;
                }
                let content = std::fs::read_to_string(&path).unwrap_or_default();
                let title = if content.starts_with("---") {
                    content
                        .lines()
                        .find(|l| l.starts_with("title:"))
                        .map(|l| {
                            l.trim_start_matches("title:")
                                .trim()
                                .trim_matches('"')
                                .to_string()
                        })
                        .unwrap_or_else(|| path.file_stem().unwrap().to_string_lossy().to_string())
                } else {
                    path.file_stem().unwrap().to_string_lossy().to_string()
                };
                let body = if let Some(rest) = content.strip_prefix("---") {
                    if let Some(end) = rest.find("---") {
                        rest[end + 3..].to_string()
                    } else {
                        content.clone()
                    }
                } else {
                    content.clone()
                };
                docs.push((
                    path.to_string_lossy().to_string(),
                    title,
                    platform.clone(),
                    body,
                ));
            }
        }

        docs.truncate(50);
        eprintln!("=== Full Pipeline: {} conversations ===\n", docs.len());

        // Step 1: TF-IDF keywords
        let doc_refs: Vec<(&str, &str, &str, &str)> = docs
            .iter()
            .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
            .collect();
        let conversations = super::super::keyword_extract::extract_keywords_from_corpus(&doc_refs);
        eprintln!(
            "Step 1: Extracted keywords from {} conversations",
            conversations.len()
        );

        // Step 2: Discover topics
        let provider = "openai";
        let model = "gpt-5-nano";
        eprintln!(
            "Step 2: Discovering topics via {} / {} ...",
            provider, model
        );
        let topics = discover_topics(provider, model, &conversations)
            .await
            .unwrap();
        eprintln!("  Found {} topics:", topics.len());
        for (i, t) in topics.iter().enumerate() {
            eprintln!("  {}. {} — {} keywords", i + 1, t.name, t.keywords.len());
        }
        eprintln!();

        // Step 3: Classify conversations
        eprintln!("Step 3: Classifying conversations into topics ...");
        let assignments = classify_conversations(provider, model, &topics, &conversations)
            .await
            .unwrap();

        let mut output = String::new();
        for assignment in &assignments {
            output.push_str(&format!(
                "\n=== {} ({}) — {} conversations ===\n",
                assignment.topic_name,
                assignment.topic_id,
                assignment.conversation_indices.len()
            ));
            for &idx in &assignment.conversation_indices {
                if idx < conversations.len() {
                    let conv = &conversations[idx];
                    let kw: Vec<&str> = conv
                        .keywords
                        .iter()
                        .take(3)
                        .map(|k| k.term.as_str())
                        .collect();
                    output.push_str(&format!(
                        "  [{}] {} ({})\n",
                        conv.platform,
                        conv.title,
                        kw.join(", ")
                    ));
                }
            }
        }
        eprintln!("{}", output);

        // Stats
        let total_links: usize = assignments
            .iter()
            .map(|a| a.conversation_indices.len())
            .sum();
        let unassigned: Vec<usize> = {
            let mut assigned = std::collections::HashSet::new();
            for a in &assignments {
                for &idx in &a.conversation_indices {
                    assigned.insert(idx);
                }
            }
            (0..conversations.len())
                .filter(|i| !assigned.contains(i))
                .collect()
        };
        eprintln!(
            "\n=== Summary ===\n{} conversations, {} topics, {} total links",
            conversations.len(),
            topics.len(),
            total_links
        );
        eprintln!(
            "Avg {:.1} topics per conversation",
            total_links as f64 / conversations.len() as f64
        );
        if !unassigned.is_empty() {
            eprintln!("{} unassigned conversations:", unassigned.len());
            for &idx in &unassigned {
                eprintln!("  - {}", conversations[idx].title);
            }
        }

        // Step 4: Store in KG and verify graph
        let kg_path = std::env::temp_dir().join("kept_test_kg.db");
        if kg_path.exists() {
            std::fs::remove_dir_all(&kg_path).ok();
        }
        let kg = super::super::kggen::KgDatabase::init(kg_path.to_str().unwrap()).unwrap();

        // Store topics as projects
        for topic in &topics {
            kg.upsert_project(&topic.id, &topic.name, &topic.description, &[])
                .unwrap();
        }

        // Store keyword entities + mentions
        let mut n_entities = 0usize;
        let mut n_mentions = 0usize;
        for assignment in &assignments {
            let topic = topics.iter().find(|t| t.id == assignment.topic_id).unwrap();
            for &conv_idx in &assignment.conversation_indices {
                if conv_idx >= conversations.len() {
                    continue;
                }
                let conv = &conversations[conv_idx];

                kg.link_project_conv(&assignment.topic_id, &conv.conv_id, "", 0)
                    .unwrap();

                for keyword in &topic.keywords {
                    let normalized = super::super::triplets::normalize_entity_name(keyword);
                    let entity_id = super::super::triplets::entity_id_from_name(&normalized);
                    if entity_id.is_empty() {
                        continue;
                    }
                    kg.upsert_entity(&entity_id, &normalized, &[], "keyword")
                        .unwrap();
                    n_entities += 1;
                    kg.upsert_mention(
                        &entity_id,
                        &conv.conv_id,
                        &conv.title,
                        &conv.conv_id,
                        &conv.platform,
                    )
                    .unwrap();
                    n_mentions += 1;
                }
            }
        }

        eprintln!(
            "\nStep 4: Stored {} entity upserts, {} mention upserts",
            n_entities, n_mentions
        );

        // Verify graph
        let stats = kg.get_stats().unwrap();
        eprintln!(
            "KG stats: {} entities, {} triples, {} conversations, {} projects",
            stats.entity_count, stats.triple_count, stats.conversation_count, stats.project_count
        );
        eprintln!("Top entities:");
        for (name, freq) in &stats.top_entities {
            eprintln!("  {} (freq={})", name, freq);
        }

        let graph = kg.get_full_graph(50).unwrap();
        eprintln!(
            "\nGraph: {} nodes, {} edges",
            graph.nodes.len(),
            graph.edges.len()
        );
        let entity_nodes = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == "entity")
            .count();
        let conv_nodes = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == "conversation")
            .count();
        let project_nodes = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == "project")
            .count();
        eprintln!(
            "  {} entity nodes, {} conversation nodes, {} project nodes",
            entity_nodes, conv_nodes, project_nodes
        );

        assert!(entity_nodes > 0, "should have entity nodes");
        assert!(conv_nodes > 0, "should have conversation nodes");
        assert!(!graph.edges.is_empty(), "should have edges");

        // Cleanup
        std::fs::remove_dir_all(&kg_path).ok();
    }

    #[test]
    fn test_build_discovery_prompt() {
        use super::super::keyword_extract::{ConversationKeywords, KeywordEntry};
        let convs = vec![ConversationKeywords {
            conv_id: "c1".into(),
            title: "React App Setup".into(),
            platform: "claude".into(),
            keywords: vec![
                KeywordEntry {
                    term: "react".into(),
                    source: "title".into(),
                    count: 3,
                    tfidf: 5.0,
                },
                KeywordEntry {
                    term: "typescript".into(),
                    source: "user_message".into(),
                    count: 2,
                    tfidf: 4.0,
                },
                KeywordEntry {
                    term: "webpack".into(),
                    source: "user_message".into(),
                    count: 1,
                    tfidf: 3.0,
                },
            ],
            user_prompts: vec![],
        }];
        let prompt = build_discovery_prompt(&convs);
        assert!(prompt.contains("1. \"React App Setup\""));
        assert!(prompt.contains("react, typescript, webpack"));
    }

    fn make_conv(
        id: &str,
        title: &str,
        keywords: &[&str],
    ) -> super::super::keyword_extract::ConversationKeywords {
        use super::super::keyword_extract::{ConversationKeywords, KeywordEntry};
        ConversationKeywords {
            conv_id: id.into(),
            title: title.into(),
            platform: "test".into(),
            keywords: keywords
                .iter()
                .map(|k| KeywordEntry {
                    term: k.to_string(),
                    source: "title".into(),
                    count: 1,
                    tfidf: 1.0,
                })
                .collect(),
            user_prompts: vec![],
        }
    }

    #[test]
    fn test_batch_single_batch_when_small() {
        let convs: Vec<_> = (0..10)
            .map(|i| {
                make_conv(
                    &format!("c{}", i),
                    &format!("Topic {}", i),
                    &["rust", "code"],
                )
            })
            .collect();
        let ranges = batch_conversation_ranges(&convs, 100_000);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0], 0..10);
    }

    #[test]
    fn test_batch_splits_when_large() {
        // Each line is ~50 chars. With max_chars=200, we should get multiple batches.
        let convs: Vec<_> = (0..20)
            .map(|i| {
                make_conv(
                    &format!("c{}", i),
                    &format!("A Moderately Long Conversation Title Number {}", i),
                    &["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
                )
            })
            .collect();
        let ranges = batch_conversation_ranges(&convs, 200);
        assert!(ranges.len() > 1, "should split into multiple batches");
        // All conversations should be covered
        let total: usize = ranges.iter().map(|r| r.len()).sum();
        assert_eq!(total, 20);
        // Ranges should be contiguous
        for i in 1..ranges.len() {
            assert_eq!(ranges[i].start, ranges[i - 1].end);
        }
    }

    #[test]
    fn test_batch_never_empty() {
        // Even if a single conversation exceeds the limit, it gets its own batch
        let convs = vec![make_conv(
            "c0",
            "Very Long Title That Exceeds Any Reasonable Limit",
            &["kw1", "kw2", "kw3", "kw4", "kw5"],
        )];
        let ranges = batch_conversation_ranges(&convs, 10);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0], 0..1);
    }

    #[test]
    fn test_build_merge_prompt() {
        let topics = vec![
            Topic {
                id: "web-dev".into(),
                name: "Web Development".into(),
                description: "Building web apps.".into(),
                keywords: vec!["react".into(), "html".into()],
            },
            Topic {
                id: "ml".into(),
                name: "Machine Learning".into(),
                description: "ML stuff.".into(),
                keywords: vec!["pytorch".into()],
            },
        ];
        let prompt = build_merge_prompt(&topics);
        assert!(prompt.contains("2 topics"));
        assert!(prompt.contains("Web Development"));
        assert!(prompt.contains("Machine Learning"));
        assert!(prompt.contains("react, html"));
        assert!(prompt.contains("pytorch"));
    }

    #[test]
    fn test_parse_batch_classify_response_clean() {
        let result = parse_batch_classify_response(r#"{"ml": [1, 3, 5], "web": [2, 4]}"#, 10);
        assert_eq!(result.get("ml").unwrap(), &vec![0, 2, 4]); // 0-indexed
        assert_eq!(result.get("web").unwrap(), &vec![1, 3]);
    }

    #[test]
    fn test_parse_batch_classify_response_with_prose() {
        let result =
            parse_batch_classify_response("Here are the results:\n{\"ml\": [2, 4, 6]}", 10);
        assert_eq!(result.get("ml").unwrap(), &vec![1, 3, 5]);
    }

    #[test]
    fn test_parse_batch_classify_response_empty() {
        let result = parse_batch_classify_response("{}", 10);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_batch_classify_response_filters_out_of_range() {
        let result = parse_batch_classify_response(r#"{"ml": [0, 1, 5, 99]}"#, 5);
        // 0 is below 1 (1-indexed), 99 is above max_index=5
        assert_eq!(result.get("ml").unwrap(), &vec![0, 4]); // only 1 and 5 are valid
    }

    #[test]
    fn test_parse_batch_classify_response_invalid() {
        let result = parse_batch_classify_response("not json at all", 10);
        assert!(result.is_empty());
    }

    #[test]
    fn test_build_classify_prompt() {
        let topics = vec![Topic {
            id: "ml".into(),
            name: "Machine Learning".into(),
            description: "ML and AI research.".into(),
            keywords: vec!["neural".into(), "pytorch".into()],
        }];
        let convs = vec![
            make_conv("c1", "Training a CNN", &["cnn", "pytorch"]),
            make_conv("c2", "React Components", &["react", "hooks"]),
        ];
        let prompt = build_classify_prompt(&topics, &convs);
        assert!(prompt.contains("Machine Learning"));
        assert!(prompt.contains("ml"));
        assert!(prompt.contains("1. \"Training a CNN\""));
        assert!(prompt.contains("2. \"React Components\""));
    }
}
