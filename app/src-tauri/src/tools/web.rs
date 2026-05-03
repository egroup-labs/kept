use super::{ParamDef, ParamType, ToolContext, ToolDef, ToolHandler};
use reqwest::header::{CONTENT_TYPE, USER_AGENT};
use std::collections::HashSet;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;

const SEARCH_USER_AGENT: &str = "Kept/0.3 (+https://kept.local)";
const MAX_SEARCH_RESULTS: usize = 10;
const DEFAULT_SEARCH_RESULTS: usize = 5;
const DEFAULT_PAGE_CHARS: usize = 12_000;
const MAX_PAGE_CHARS: usize = 30_000;

pub fn register() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "web_search",
            description: "Search the public web for current or source-backed information. Returns title, URL, and snippet results. Use this for current events, recent facts, product/library/version lookups, or when the user asks to search the web.",
            parameters: vec![
                ParamDef {
                    name: "query",
                    param_type: ParamType::String,
                    description: "Search query",
                    required: true,
                },
                ParamDef {
                    name: "max_results",
                    param_type: ParamType::Integer,
                    description: "Maximum number of results to return (default 5, max 10)",
                    required: false,
                },
            ],
            handler: Box::new(WebSearch),
        },
        ToolDef {
            name: "read_web_page",
            description: "Fetch and extract readable text from a public HTTP(S) web page. Use after web_search when a result needs verification or more detail.",
            parameters: vec![
                ParamDef {
                    name: "url",
                    param_type: ParamType::String,
                    description: "HTTP(S) URL to read",
                    required: true,
                },
                ParamDef {
                    name: "max_chars",
                    param_type: ParamType::Integer,
                    description: "Maximum extracted characters to return (default 12000, max 30000)",
                    required: false,
                },
            ],
            handler: Box::new(ReadWebPage),
        },
    ]
}

struct WebSearch;

#[async_trait::async_trait]
impl ToolHandler for WebSearch {
    async fn run(&self, _ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let query = match args["query"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(query) => query,
            None => return "Error: 'query' parameter is required.".to_string(),
        };
        let max_results = args["max_results"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_SEARCH_RESULTS)
            .clamp(1, MAX_SEARCH_RESULTS);

        let url = format!(
            "https://html.duckduckgo.com/html/?q={}&kl=us-en",
            percent_encode(query)
        );
        let resp = match crate::commands::http_client()
            .get(url)
            .header(USER_AGENT, SEARCH_USER_AGENT)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => return format!("Web search request failed: {e}"),
        };

        if !resp.status().is_success() {
            return format!("Web search failed with HTTP status {}", resp.status());
        }

        let html = match resp.text().await {
            Ok(text) => text,
            Err(e) => return format!("Failed to read web search response: {e}"),
        };

        let results = parse_duckduckgo_results(&html, max_results);
        if results.is_empty() {
            "No web search results found.".to_string()
        } else {
            serde_json::to_string_pretty(&results).unwrap_or_default()
        }
    }
}

struct ReadWebPage;

#[async_trait::async_trait]
impl ToolHandler for ReadWebPage {
    async fn run(&self, _ctx: &ToolContext<'_>, args: &serde_json::Value) -> String {
        let url = match args["url"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(url) => url,
            None => return "Error: 'url' parameter is required.".to_string(),
        };
        if let Err(msg) = validate_public_http_url(url) {
            return format!("Error: {msg}");
        }

        let max_chars = args["max_chars"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_PAGE_CHARS)
            .clamp(1_000, MAX_PAGE_CHARS);

        let resp = match crate::commands::http_client()
            .get(url)
            .header(USER_AGENT, SEARCH_USER_AGENT)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => return format!("Web page request failed: {e}"),
        };

        if !resp.status().is_success() {
            return format!("Web page fetch failed with HTTP status {}", resp.status());
        }

        let final_url = resp.url().to_string();
        let content_type = resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = match resp.text().await {
            Ok(text) => text,
            Err(e) => return format!("Failed to read web page body: {e}"),
        };

        let title = extract_title(&body);
        let text = if content_type.contains("text/html") || body.contains("<html") {
            html_to_text(&body)
        } else {
            normalize_whitespace(&body)
        };

        serde_json::to_string_pretty(&serde_json::json!({
            "url": final_url,
            "title": title,
            "content": truncate_chars(&text, max_chars),
            "truncated": text.chars().count() > max_chars,
        }))
        .unwrap_or_default()
    }
}

fn parse_duckduckgo_results(html: &str, limit: usize) -> Vec<serde_json::Value> {
    let mut results = Vec::new();
    let mut seen_urls = HashSet::new();
    let mut cursor = 0;

    while results.len() < limit {
        let Some(marker_rel) = html[cursor..].find("result__a") else {
            break;
        };
        let marker = cursor + marker_rel;
        let Some(anchor_start) = html[..marker].rfind("<a") else {
            cursor = marker + "result__a".len();
            continue;
        };
        let Some(tag_end_rel) = html[marker..].find('>') else {
            break;
        };
        let tag_end = marker + tag_end_rel;
        let tag = &html[anchor_start..=tag_end];
        let Some(close_rel) = html[(tag_end + 1)..].to_ascii_lowercase().find("</a>") else {
            break;
        };
        let close = tag_end + 1 + close_rel;

        let Some(raw_href) = extract_href(tag) else {
            cursor = close + 4;
            continue;
        };
        let url = unwrap_duckduckgo_href(&raw_href);
        if !url.starts_with("http://") && !url.starts_with("https://") {
            cursor = close + 4;
            continue;
        }
        if !seen_urls.insert(url.clone()) {
            cursor = close + 4;
            continue;
        }

        let title = clean_html_text(&html[(tag_end + 1)..close]);
        let next_marker = html[(close + 4)..]
            .find("result__a")
            .map(|pos| close + 4 + pos)
            .unwrap_or(html.len());
        let snippet = extract_result_snippet(&html[(close + 4)..next_marker]);

        if !title.is_empty() {
            results.push(serde_json::json!({
                "title": title,
                "url": url,
                "snippet": snippet,
            }));
        }

        cursor = close + 4;
    }

    results
}

fn extract_result_snippet(block: &str) -> String {
    let Some(marker) = block.find("result__snippet") else {
        return String::new();
    };
    let Some(tag_end_rel) = block[marker..].find('>') else {
        return String::new();
    };
    let text_start = marker + tag_end_rel + 1;
    let lower = block[text_start..].to_ascii_lowercase();
    let text_end = ["</a>", "</td>", "</div>"]
        .iter()
        .filter_map(|needle| lower.find(needle).map(|pos| text_start + pos))
        .min()
        .unwrap_or(block.len());
    clean_html_text(&block[text_start..text_end])
}

fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start_rel) = lower.find("<title") else {
        return String::new();
    };
    let Some(open_end_rel) = html[start_rel..].find('>') else {
        return String::new();
    };
    let text_start = start_rel + open_end_rel + 1;
    let Some(close_rel) = lower[text_start..].find("</title>") else {
        return String::new();
    };
    clean_html_text(&html[text_start..(text_start + close_rel)])
}

fn html_to_text(html: &str) -> String {
    let mut cleaned = html.to_string();
    for tag in ["script", "style", "noscript", "svg"] {
        cleaned = remove_html_sections(&cleaned, tag);
    }
    clean_html_text(&cleaned)
}

fn remove_html_sections(input: &str, tag: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    let open = format!("<{tag}");
    let close = format!("</{tag}>");

    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(start) = lower.find(&open) else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..start]);
        let after_start = &rest[start..];
        let after_lower = after_start.to_ascii_lowercase();
        match after_lower.find(&close) {
            Some(close_pos) => {
                rest = &after_start[(close_pos + close.len())..];
            }
            None => break,
        }
    }

    output
}

fn clean_html_text(input: &str) -> String {
    normalize_whitespace(&decode_html_entities(&strip_tags(input)))
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_html_entities(input: &str) -> String {
    let mut out = input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ");

    while let Some(start) = out.find("&#") {
        let Some(end_rel) = out[start..].find(';') else {
            break;
        };
        let end = start + end_rel;
        let entity = &out[(start + 2)..end];
        let parsed = if let Some(hex) = entity
            .strip_prefix('x')
            .or_else(|| entity.strip_prefix('X'))
        {
            u32::from_str_radix(hex, 16).ok()
        } else {
            entity.parse::<u32>().ok()
        };
        let Some(ch) = parsed.and_then(char::from_u32) else {
            break;
        };
        out.replace_range(start..=end, &ch.to_string());
    }

    out
}

fn extract_href(tag: &str) -> Option<String> {
    static HREF_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = HREF_RE.get_or_init(|| {
        regex::Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']*)["']"#).expect("valid href regex")
    });
    re.captures(tag)
        .and_then(|caps| caps.get(1).map(|m| decode_html_entities(m.as_str())))
}

fn unwrap_duckduckgo_href(href: &str) -> String {
    let href = decode_html_entities(href);
    let href = if href.starts_with("//") {
        format!("https:{href}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href
    };

    if let Some(pos) = href.find("uddg=") {
        let encoded = &href[(pos + 5)..];
        let encoded = encoded.split('&').next().unwrap_or(encoded);
        return percent_decode(encoded);
    }

    href
}

fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &input[(i + 1)..(i + 3)];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in input.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("\n\n[... truncated]");
            break;
        }
        out.push(ch);
    }
    out
}

fn validate_public_http_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("Only http:// and https:// URLs are supported.".to_string());
    }

    let host = extract_host(url).ok_or_else(|| "Could not parse URL host.".to_string())?;
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return Err("Local/private hosts are not allowed.".to_string());
    }

    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        if ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
            return Err("Private or local IP addresses are not allowed.".to_string());
        }
    }
    if let Ok(ip) = host.parse::<Ipv6Addr>() {
        if ip.is_loopback()
            || ip.is_unspecified()
            || ip.is_unique_local()
            || ip.is_unicast_link_local()
        {
            return Err("Private or local IP addresses are not allowed.".to_string());
        }
    }

    Ok(())
}

fn extract_host(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://")?.1;
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    if host_port.starts_with('[') {
        host_port.find(']').map(|end| host_port[1..end].to_string())
    } else {
        Some(host_port.split(':').next().unwrap_or_default().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_duckduckgo_result_links() {
        let html = r#"
            <div class="result">
              <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&amp;rut=abc">Example &amp; Test</a>
              <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">A <b>sample</b> snippet.</a>
            </div>
        "#;

        let results = parse_duckduckgo_results(html, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["title"], "Example & Test");
        assert_eq!(results[0]["url"], "https://example.com/page?a=1");
        assert_eq!(results[0]["snippet"], "A sample snippet.");
    }

    #[test]
    fn blocks_local_web_page_urls() {
        assert!(validate_public_http_url("http://127.0.0.1:3000").is_err());
        assert!(validate_public_http_url("http://192.168.1.4/page").is_err());
        assert!(validate_public_http_url("https://localhost/page").is_err());
        assert!(validate_public_http_url("file:///etc/passwd").is_err());
        assert!(validate_public_http_url("https://example.com/page").is_ok());
    }
}
