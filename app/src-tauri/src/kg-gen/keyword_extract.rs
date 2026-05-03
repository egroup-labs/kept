use serde::Serialize;
use std::collections::HashMap;

const MAX_KEYWORDS: usize = 8;

const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "above",
    "after",
    "again",
    "against",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "are",
    "aren't",
    "as",
    "at",
    "be",
    "because",
    "been",
    "before",
    "being",
    "below",
    "between",
    "both",
    "but",
    "by",
    "can",
    "can't",
    "cannot",
    "could",
    "couldn't",
    "did",
    "didn't",
    "do",
    "does",
    "doesn't",
    "doing",
    "don't",
    "down",
    "during",
    "each",
    "even",
    "few",
    "for",
    "from",
    "further",
    "get",
    "got",
    "had",
    "hadn't",
    "has",
    "hasn't",
    "have",
    "haven't",
    "having",
    "he",
    "her",
    "here",
    "hers",
    "herself",
    "him",
    "himself",
    "his",
    "how",
    "however",
    "i",
    "i'd",
    "i'll",
    "i'm",
    "i've",
    "if",
    "in",
    "into",
    "is",
    "isn't",
    "it",
    "it's",
    "its",
    "itself",
    "just",
    "know",
    "let",
    "let's",
    "like",
    "make",
    "me",
    "might",
    "more",
    "most",
    "much",
    "must",
    "my",
    "myself",
    "need",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "one",
    "only",
    "or",
    "other",
    "ought",
    "our",
    "ours",
    "ourselves",
    "out",
    "over",
    "own",
    "same",
    "say",
    "she",
    "should",
    "shouldn't",
    "so",
    "some",
    "such",
    "take",
    "than",
    "that",
    "that's",
    "the",
    "their",
    "theirs",
    "them",
    "themselves",
    "then",
    "there",
    "there's",
    "these",
    "they",
    "they'd",
    "they'll",
    "they're",
    "they've",
    "think",
    "this",
    "those",
    "through",
    "to",
    "too",
    "try",
    "under",
    "until",
    "up",
    "us",
    "use",
    "used",
    "using",
    "very",
    "want",
    "was",
    "wasn't",
    "way",
    "we",
    "we'd",
    "we'll",
    "we're",
    "we've",
    "well",
    "were",
    "weren't",
    "what",
    "what's",
    "when",
    "when's",
    "where",
    "where's",
    "which",
    "while",
    "who",
    "who's",
    "whom",
    "why",
    "why's",
    "will",
    "with",
    "won't",
    "would",
    "wouldn't",
    "you",
    "you'd",
    "you'll",
    "you're",
    "you've",
    "your",
    "yours",
    "yourself",
    "yourselves",
];

#[derive(Debug, Serialize, Clone)]
pub struct KeywordEntry {
    pub term: String,
    pub source: String,
    pub count: u32,
    pub tfidf: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConversationKeywords {
    pub conv_id: String,
    pub title: String,
    pub platform: String,
    pub keywords: Vec<KeywordEntry>,
    /// Individual user prompts, one per turn, in conversation order.
    pub user_prompts: Vec<String>,
}

fn normalize_token(token: &str) -> String {
    let s = token.to_lowercase();
    let trimmed = s.trim_matches(|c: char| !c.is_alphanumeric());
    trimmed.to_string()
}

fn is_stopword(word: &str) -> bool {
    if word.len() < 3 {
        return true;
    }
    STOPWORDS.contains(&word)
}

/// File extensions and code-related suffixes to reject.
const CODE_EXTENSIONS: &[&str] = &[
    ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".css",
    ".scss", ".html", ".json", ".yaml", ".yml", ".toml", ".xml", ".md", ".sh", ".bat", ".rb",
    ".php", ".swift", ".kt", ".lua", ".sql", ".wasm",
];

/// LaTeX commands and markup noise.
const LATEX_NOISE: &[&str] = &[
    "citep",
    "citet",
    "cite",
    "textbf",
    "textit",
    "emph",
    "mathcal",
    "mathbb",
    "mathrm",
    "frac",
    "sqrt",
    "begin",
    "end",
    "hline",
    "label",
    "ref",
    "caption",
    "centering",
    "includegraphics",
    "usepackage",
    "documentclass",
    "newcommand",
    "renewcommand",
    "bibitem",
    "bibliography",
    "appendix",
    "theta",
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "lambda",
    "sigma",
    "omega",
    "phi",
    "psi",
    "rho",
    "tau",
    "zeta",
    "eta",
    "kappa",
    "mu",
    "nu",
    "xi",
    "pi",
];

/// Generic conversational and coding words that carry no semantic specificity.
/// These leak through standard stopword lists but are meaningless as graph entities.
const GENERIC_NOISE: &[&str] = &[
    // Conversational filler
    "actually", "already", "always", "another", "anything", "around", "back", "based",
    "basically", "better", "call", "called", "case", "change", "check", "come", "comes",
    "consider", "correct", "correctly", "could", "currently", "different", "does", "done",
    "each", "either", "else", "end", "enough", "ensure", "entire", "especially",
    "even", "every", "everything", "exactly", "example", "expect", "expected", "explain",
    "feel", "find", "fine", "first", "follow", "following", "found", "give", "given",
    "going", "good", "great", "guess", "happen", "happens", "help", "here", "idea",
    "important", "include", "included", "includes", "including", "instead", "issue",
    "issues", "keep", "kind", "last", "leave", "left", "less", "line", "lines",
    "little", "long", "look", "looking", "looks", "made", "main", "many", "matter",
    "maybe", "mean", "means", "mentioned", "might", "move", "name", "named", "names",
    "needed", "next", "nice", "note", "nothing", "number", "okay", "open", "order",
    "part", "pass", "passed", "people", "perhaps", "place", "please", "point", "possible",
    "pretty", "problem", "provide", "provided", "pull", "push", "put", "question",
    "quite", "rather", "read", "really", "reason", "related", "result", "results",
    "right", "running", "said", "second", "see", "seem", "seems", "sense", "set",
    "several", "show", "shows", "side", "similar", "simple", "simply", "since",
    "single", "small", "something", "sort", "specific", "specifically", "start",
    "started", "state", "step", "steps", "still", "stop", "stuff", "sure", "tell",
    "telling", "terms", "test", "testing", "thank", "thanks", "thing", "things",
    "thought", "time", "times", "together", "told", "top", "turn", "two", "type",
    "types", "typically", "understand", "unless", "update", "updated", "value",
    "values", "version", "want", "wanted", "wants", "whole", "without", "work",
    "working", "works", "write", "writing", "wrong", "yes",
    // Programming generic terms (too vague alone)
    "add", "added", "adding", "also", "args", "argument", "array", "assign", "attribute",
    "block", "body", "bool", "boolean", "build", "built", "button", "byte", "bytes",
    "catch", "class", "click", "close", "code", "coding", "command", "comment", "compile",
    "component", "config", "configuration", "console", "const", "constructor", "content",
    "context", "convert", "copy", "count", "create", "created", "creating", "custom",
    "data", "debug", "default", "define", "defined", "definition", "delete", "deploy",
    "developer", "directory", "display", "document", "element", "empty", "enable",
    "entry", "error", "errors", "event", "execute", "exist", "exists", "export",
    "expression", "extension", "extract", "false", "feature", "field", "fields", "file",
    "files", "filter", "fix", "fixed", "flag", "folder", "format", "function",
    "functions", "generate", "global", "group", "handle", "handler", "header", "headers",
    "hold", "http", "https", "implement", "implementation", "import", "index", "info",
    "init", "initial", "initialize", "input", "inputs", "insert", "install", "instance",
    "interface", "internal", "item", "items", "json", "just", "key", "keys", "length",
    "level", "library", "link", "list", "load", "loaded", "local", "location", "log",
    "logic", "loop", "make", "manage", "manager", "map", "mark", "match", "message",
    "messages", "method", "methods", "missing", "mode", "model", "models", "module",
    "modules", "move", "multiple", "need", "new", "node", "nodes", "none", "null",
    "object", "objects", "option", "options", "original", "output", "outputs", "package",
    "page", "param", "parameter", "parameters", "params", "parent", "parse", "parsed",
    "parser", "path", "pattern", "perform", "process", "processing", "program",
    "project", "prompt", "prop", "property", "props", "query", "receive", "record",
    "reference", "remove", "render", "replace", "repo", "request", "requests",
    "require", "required", "resolve", "response", "responses", "rest", "return",
    "returned", "returns", "route", "run", "running", "runtime", "save", "saved",
    "script", "search", "section", "select", "send", "server", "service", "setting",
    "settings", "setup", "share", "shared", "size", "source", "spec", "split",
    "standard", "static", "status", "store", "stored", "string", "strings", "struct",
    "structure", "style", "submit", "support", "supported", "switch", "sync", "system",
    "table", "tag", "tags", "target", "task", "template", "text", "thread", "throw",
    "token", "tokens", "tool", "total", "track", "trigger", "true", "try", "turn",
    "undefined", "user", "users", "util", "valid", "validate", "variable", "variables",
    "view", "wait", "warning", "wrap", "wrapper", "yaml",
];

/// Returns true if a term looks like code noise rather than a meaningful concept.
fn is_code_noise(term: &str) -> bool {
    // File extensions
    for ext in CODE_EXTENSIONS {
        if term.ends_with(ext) {
            return true;
        }
    }

    // Contains dots internally (e.g. "os.getenv", "this.tokenkey", "chrome.storage.local.set")
    if term.contains('.') {
        return true;
    }

    // Contains underscores (e.g. "rare_term", "update_generic", "snake_case_identifier")
    if term.contains('_') {
        return true;
    }

    // LaTeX noise
    if LATEX_NOISE.contains(&term) {
        return true;
    }

    // Looks like a hex hash or long numeric string
    if term.len() >= 6 && term.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }

    // Too short — no single word under 4 chars is specific enough
    if term.len() <= 3 {
        return true;
    }

    // Generic conversational/coding terms
    if GENERIC_NOISE.contains(&term) {
        return true;
    }

    // Pure numbers
    if term.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }

    false
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| {
        c.is_whitespace()
            || c == ','
            || c == ';'
            || c == ':'
            || c == '('
            || c == ')'
            || c == '['
            || c == ']'
            || c == '{'
            || c == '}'
            || c == '"'
            || c == '\''
            || c == '/'
            || c == '\\'
            || c == '|'
            || c == '!'
            || c == '?'
    })
    .map(normalize_token)
    .filter(|t| !t.is_empty() && !is_stopword(t) && !is_code_noise(t))
    .collect()
}

const USER_PREFIXES: &[&str] = &[
    "### You",
    "### User",
    "## You",
    "## User",
    "**You:**",
    "**User:**",
];
const ASSISTANT_PREFIXES: &[&str] = &[
    "### Assistant",
    "### ChatGPT",
    "### Claude",
    "### Gemini",
    "### Grok",
    "### Kimi",
    "## Assistant",
    "## ChatGPT",
    "**Assistant:**",
    "**ChatGPT:**",
];

/// Concatenated user text for tokenization.
fn extract_user_text(body: &str) -> String {
    let mut result = String::new();
    let mut in_user_section = false;

    for line in body.lines() {
        let trimmed = line.trim();
        if USER_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
            in_user_section = true;
            continue;
        }
        if ASSISTANT_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
            in_user_section = false;
            continue;
        }
        if in_user_section {
            result.push_str(trimmed);
            result.push('\n');
        }
    }
    result
}

/// Individual user prompts as separate strings, one per turn.
fn extract_user_prompts(body: &str) -> Vec<String> {
    let mut prompts = Vec::new();
    let mut current = String::new();
    let mut in_user_section = false;

    for line in body.lines() {
        let trimmed = line.trim();
        if USER_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
            if !current.trim().is_empty() {
                prompts.push(current.trim().to_string());
            }
            current = String::new();
            in_user_section = true;
            continue;
        }
        if ASSISTANT_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
            if in_user_section && !current.trim().is_empty() {
                prompts.push(current.trim().to_string());
            }
            current = String::new();
            in_user_section = false;
            continue;
        }
        if in_user_section {
            current.push_str(trimmed);
            current.push('\n');
        }
    }
    // Flush last turn
    if in_user_section && !current.trim().is_empty() {
        prompts.push(current.trim().to_string());
    }
    prompts
}

fn extract_backtick_terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut in_fenced_block = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fenced_block = !in_fenced_block;
            continue;
        }
        if in_fenced_block {
            continue;
        }

        // Extract inline backtick terms from this line
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '`' {
                let mut term = String::new();
                for inner in chars.by_ref() {
                    if inner == '`' {
                        break;
                    }
                    term.push(inner);
                }
                let normalized = normalize_token(&term);
                if !normalized.is_empty()
                    && !is_stopword(&normalized)
                    && !is_code_noise(&normalized)
                {
                    terms.push(normalized);
                }
            }
        }
    }

    terms
}

fn extract_capitalized_phrases(text: &str) -> Vec<String> {
    let mut phrases = Vec::new();

    for line in text.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        let mut current_phrase: Vec<String> = Vec::new();

        for word in &words {
            // Strip leading/trailing punctuation to check capitalization
            let cleaned = word.trim_matches(|c: char| !c.is_alphanumeric());
            if cleaned.is_empty() {
                if current_phrase.len() >= 2 {
                    phrases.push(
                        current_phrase
                            .iter()
                            .map(|w| w.to_lowercase())
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
                current_phrase.clear();
                continue;
            }

            let first_char = cleaned.chars().next().unwrap();
            if first_char.is_uppercase() && cleaned.len() > 1 && current_phrase.len() < 4 {
                current_phrase.push(cleaned.to_string());
            } else {
                if current_phrase.len() >= 2 {
                    phrases.push(
                        current_phrase
                            .iter()
                            .map(|w| w.to_lowercase())
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
                current_phrase.clear();
            }
        }

        // Flush remaining phrase at end of line
        if current_phrase.len() >= 2 {
            phrases.push(
                current_phrase
                    .iter()
                    .map(|w| w.to_lowercase())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
    }

    phrases
}

pub fn extract_keywords_from_corpus(
    docs: &[(&str, &str, &str, &str)],
) -> Vec<ConversationKeywords> {
    let n = docs.len() as f64;

    // Per-document term info: (term_counts, term_source)
    // term_source tracks where the term was first seen
    struct DocTerms {
        counts: HashMap<String, u32>,
        sources: HashMap<String, String>,
    }

    // Pass 1: Build per-document term frequencies and document frequency map
    let mut all_doc_terms: Vec<DocTerms> = Vec::with_capacity(docs.len());
    let mut doc_freq: HashMap<String, u32> = HashMap::new();

    for &(_conv_id, title, _platform, body) in docs {
        let mut doc = DocTerms {
            counts: HashMap::new(),
            sources: HashMap::new(),
        };

        // Tokenize title
        let title_tokens = tokenize(title);
        for token in &title_tokens {
            *doc.counts.entry(token.clone()).or_insert(0) += 1;
            doc.sources
                .entry(token.clone())
                .or_insert_with(|| "title".to_string());
        }

        // Extract and tokenize user messages
        let user_text = extract_user_text(body);
        let user_tokens = tokenize(&user_text);
        for token in &user_tokens {
            *doc.counts.entry(token.clone()).or_insert(0) += 1;
            doc.sources
                .entry(token.clone())
                .or_insert_with(|| "user_message".to_string());
        }

        // Extract backtick terms from user text
        let backtick_terms = extract_backtick_terms(&user_text);
        for term in &backtick_terms {
            *doc.counts.entry(term.clone()).or_insert(0) += 1;
            doc.sources
                .entry(term.clone())
                .or_insert_with(|| "user_message".to_string());
        }

        // Extract capitalized phrases from user text
        let cap_phrases = extract_capitalized_phrases(&user_text);
        for phrase in &cap_phrases {
            *doc.counts.entry(phrase.clone()).or_insert(0) += 1;
            doc.sources
                .entry(phrase.clone())
                .or_insert_with(|| "user_message".to_string());
        }

        // Update document frequency for all unique terms in this doc
        for term in doc.counts.keys() {
            *doc_freq.entry(term.clone()).or_insert(0) += 1;
        }

        all_doc_terms.push(doc);
    }

    // Pass 2: Score with TF-IDF, sort, truncate
    let mut results = Vec::with_capacity(docs.len());

    for (i, &(conv_id, title, platform, body)) in docs.iter().enumerate() {
        let doc = &all_doc_terms[i];
        // Filter aggressively: only terms that appear in 2+ docs (have linking
        // value) but not in >50% of docs (too generic to be meaningful).
        let max_df = (n * 0.5).max(2.0) as u32;
        let mut keywords: Vec<KeywordEntry> = doc
            .counts
            .iter()
            .filter_map(|(term, &count)| {
                let df = *doc_freq.get(term).unwrap_or(&1);
                // Must appear in at least 2 docs to have connection value
                if df < 2 {
                    return None;
                }
                // Must not appear in >50% of docs (too common)
                if df > max_df {
                    return None;
                }
                let tf = count as f64;
                let idf = (n / df as f64).ln();
                let tfidf = tf * idf;
                // Minimum TF-IDF threshold
                if tfidf < 1.0 {
                    return None;
                }
                Some(KeywordEntry {
                    term: term.clone(),
                    source: doc
                        .sources
                        .get(term)
                        .cloned()
                        .unwrap_or_else(|| "unknown".to_string()),
                    count,
                    tfidf,
                })
            })
            .collect();

        keywords.sort_by(|a, b| {
            b.tfidf
                .partial_cmp(&a.tfidf)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        keywords.truncate(MAX_KEYWORDS);

        let user_prompts = extract_user_prompts(body);

        results.push(ConversationKeywords {
            conv_id: conv_id.to_string(),
            title: title.to_string(),
            platform: platform.to_string(),
            keywords,
            user_prompts,
        });
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_token() {
        assert_eq!(normalize_token("Hello!"), "hello");
        assert_eq!(normalize_token("**React.js**"), "react.js");
        assert_eq!(normalize_token("---"), "");
        assert_eq!(normalize_token("GPU"), "gpu");
    }

    #[test]
    fn test_is_stopword() {
        assert!(is_stopword("the"));
        assert!(is_stopword("is"));
        assert!(is_stopword("at")); // < 3 chars
        assert!(!is_stopword("algorithm"));
        assert!(!is_stopword("python"));
    }

    #[test]
    fn test_is_code_noise() {
        // File extensions
        assert!(is_code_noise("autoreload.py"));
        assert!(is_code_noise("index.css"));
        assert!(is_code_noise("auth.js"));
        // Dots internally (code identifiers)
        assert!(is_code_noise("os.getenv"));
        assert!(is_code_noise("this.tokenkey"));
        assert!(is_code_noise("chrome.storage.local.set"));
        // Underscores (snake_case identifiers)
        assert!(is_code_noise("update_generic"));
        assert!(is_code_noise("rare_term"));
        // LaTeX
        assert!(is_code_noise("citep"));
        assert!(is_code_noise("mathcal"));
        assert!(is_code_noise("phi"));
        // Hex hashes
        assert!(is_code_noise("a1b2c3d4e5"));
        // Meaningful terms should pass through
        assert!(!is_code_noise("react"));
        assert!(!is_code_noise("tensorflow"));
        assert!(!is_code_noise("blockchain"));
        assert!(!is_code_noise("trading"));
        assert!(!is_code_noise("algorithm"));
    }

    #[test]
    fn test_tokenize_basic() {
        let tokens = tokenize("Adam Trading Algorithm Design");
        assert!(tokens.contains(&"adam".to_string()));
        assert!(tokens.contains(&"trading".to_string()));
        assert!(tokens.contains(&"algorithm".to_string()));
        assert!(tokens.contains(&"design".to_string()));
    }

    #[test]
    fn test_tokenize_filters_stopwords() {
        let tokens = tokenize("What is the best way to use React");
        assert!(!tokens.contains(&"what".to_string()));
        assert!(!tokens.contains(&"the".to_string()));
        assert!(!tokens.contains(&"is".to_string()));
        assert!(tokens.contains(&"best".to_string()));
        assert!(tokens.contains(&"react".to_string()));
    }

    #[test]
    fn test_extract_user_text() {
        let markdown = "\
### You
What is Rust?

### Assistant
Rust is a systems programming language.

### You
How does ownership work?

### Assistant
Ownership is a set of rules.";

        let user_text = extract_user_text(markdown);
        assert!(user_text.contains("What is Rust?"));
        assert!(user_text.contains("How does ownership work?"));
        assert!(!user_text.contains("Rust is a systems programming language."));
        assert!(!user_text.contains("Ownership is a set of rules."));
    }

    #[test]
    fn test_extract_backtick_terms() {
        let text = "I used `useState` and `useEffect` hooks in `React` for state management.";
        let terms = extract_backtick_terms(text);
        assert!(terms.contains(&"usestate".to_string()));
        assert!(terms.contains(&"useeffect".to_string()));
        assert!(terms.contains(&"react".to_string()));
    }

    #[test]
    fn test_extract_capitalized_phrases() {
        let text = "Natural Language Processing and Machine Learning are important fields.";
        let phrases = extract_capitalized_phrases(text);
        assert!(phrases.contains(&"natural language processing".to_string()));
        assert!(phrases.contains(&"machine learning".to_string()));
    }

    #[test]
    fn test_tfidf_scoring() {
        // Build a 10-doc corpus where "rare_term" appears in doc 0 only (df=1)
        // and "common_term" appears in docs 0..=8 (df=9)
        let mut bodies: Vec<String> = Vec::new();
        for i in 0..10 {
            let mut body = String::from("### You\n");
            if i == 0 {
                body.push_str("rareword commonword\n");
            } else if i < 9 {
                body.push_str("commonword\n");
            } else {
                body.push_str("otherstuff\n");
            }
            body.push_str("### Assistant\nReply.\n");
            bodies.push(body);
        }

        let docs: Vec<(&str, &str, &str, &str)> = bodies
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let id: &str = match i {
                    0 => "doc0",
                    1 => "doc1",
                    2 => "doc2",
                    3 => "doc3",
                    4 => "doc4",
                    5 => "doc5",
                    6 => "doc6",
                    7 => "doc7",
                    8 => "doc8",
                    _ => "doc9",
                };
                (id, "Title", "test", b.as_str())
            })
            .collect();

        let results = extract_keywords_from_corpus(&docs);
        let doc0 = &results[0];

        let rare = doc0.keywords.iter().find(|k| k.term == "rareword");
        let common = doc0.keywords.iter().find(|k| k.term == "commonword");

        assert!(rare.is_some(), "rareword should be in doc0 keywords");
        assert!(common.is_some(), "commonword should be in doc0 keywords");
        assert!(
            rare.unwrap().tfidf > common.unwrap().tfidf,
            "rareword (df=1) should have higher tfidf than commonword (df=9)"
        );
    }

    #[test]
    fn test_extract_keywords_from_corpus() {
        let doc1_body = "\
### You
How do I implement a trading algorithm?

### Assistant
You can use Python or Rust for algorithmic trading.";

        let doc2_body = "\
### You
Help me with React and TypeScript components.

### Assistant
Sure, here is a React component in TypeScript.";

        let doc3_body = "\
### You
What are neural networks?

### Assistant
Neural networks are computational models.";

        let docs = vec![
            ("conv1", "Adam Trading Strategy", "chatgpt", doc1_body),
            ("conv2", "React TypeScript Guide", "claude", doc2_body),
            ("conv3", "Deep Learning Basics", "gemini", doc3_body),
        ];

        let results = extract_keywords_from_corpus(&docs);
        assert_eq!(results.len(), 3);

        // conv1 should have "adam" from title
        let conv1 = &results[0];
        assert_eq!(conv1.conv_id, "conv1");
        let adam_kw = conv1.keywords.iter().find(|k| k.term == "adam");
        assert!(adam_kw.is_some(), "conv1 should have 'adam' keyword");
        assert_eq!(adam_kw.unwrap().source, "title");
        assert!(adam_kw.unwrap().tfidf > 0.0);

        // conv2 should have "react" and "typescript"
        let conv2 = &results[1];
        assert_eq!(conv2.conv_id, "conv2");
        let react_kw = conv2.keywords.iter().find(|k| k.term == "react");
        assert!(react_kw.is_some(), "conv2 should have 'react' keyword");
        let ts_kw = conv2.keywords.iter().find(|k| k.term == "typescript");
        assert!(ts_kw.is_some(), "conv2 should have 'typescript' keyword");
    }

    #[test]
    #[ignore] // run with: cargo test test_real_vault -- --ignored --nocapture
    fn test_real_vault() {
        let vault_dir = dirs::home_dir().unwrap().join(".kept/vault");
        if !vault_dir.exists() {
            eprintln!("No vault at {:?}, skipping", vault_dir);
            return;
        }
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
                // Minimal frontmatter title extraction
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
        let doc_refs: Vec<(&str, &str, &str, &str)> = docs
            .iter()
            .map(|(a, b, c, d)| (a.as_str(), b.as_str(), c.as_str(), d.as_str()))
            .collect();
        let results = extract_keywords_from_corpus(&doc_refs);
        eprintln!(
            "\n=== Extracted keywords from {} conversations ===\n",
            results.len()
        );
        for conv in &results {
            if conv.keywords.is_empty() {
                continue;
            }
            eprintln!(
                "[{}] {} ({})",
                conv.platform,
                conv.title,
                conv.keywords.len()
            );
            for kw in conv.keywords.iter().take(10) {
                eprintln!(
                    "  {:6.2}  {:>2}x  ({:12})  {}",
                    kw.tfidf, kw.count, kw.source, kw.term
                );
            }
            let n_prompts = conv.user_prompts.len();
            eprintln!("  --- user prompts ({}) ---", n_prompts);
            // Show first 2 and last 3 (with dedup if conversation is short)
            let head = 2.min(n_prompts);
            let tail_start = n_prompts.saturating_sub(3).max(head);
            for j in 0..head {
                let p = &conv.user_prompts[j];
                let truncated: String = p.chars().take(1000).collect();
                let suffix = if p.len() > 1000 { "..." } else { "" };
                eprintln!("  [{}] {}{}", j + 1, truncated, suffix);
            }
            if tail_start > head {
                eprintln!("  ... ({} more) ...", tail_start - head);
            }
            for j in tail_start..n_prompts {
                let p = &conv.user_prompts[j];
                let truncated: String = p.chars().take(1000).collect();
                let suffix = if p.len() > 1000 { "..." } else { "" };
                eprintln!("  [{}] {}{}", j + 1, truncated, suffix);
            }
            eprintln!();
        }
    }

    #[test]
    fn test_tfidf_ranks_specific_terms_higher() {
        // "python" appears in all 3 docs (common), "tensorflow" in only 1 (rare)
        let docs = vec![
            (
                "c1",
                "Python ML",
                "claude",
                "### You\n\nUsing Python with TensorFlow for deep learning.\n",
            ),
            (
                "c2",
                "Python Web",
                "chatgpt",
                "### You\n\nBuilding a Python Flask web server.\n",
            ),
            (
                "c3",
                "Python Data",
                "claude",
                "### You\n\nPython pandas for data analysis.\n",
            ),
        ];
        let results = extract_keywords_from_corpus(&docs);
        let c1 = results.iter().find(|r| r.conv_id == "c1").unwrap();

        let tf_kw = c1.keywords.iter().find(|k| k.term == "tensorflow");
        let py_kw = c1.keywords.iter().find(|k| k.term == "python");
        assert!(tf_kw.is_some(), "tensorflow should be extracted");
        assert!(py_kw.is_some(), "python should be extracted");
        // tensorflow (df=1) should score higher than python (df=3)
        assert!(
            tf_kw.unwrap().tfidf > py_kw.unwrap().tfidf,
            "rare term 'tensorflow' should have higher tfidf than common 'python'"
        );
    }
}
