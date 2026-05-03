use serde::{Deserialize, Serialize};

/// Image payload from the extension (base64-encoded).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePayload {
    pub filename: String,
    pub base64_data: String,
    pub content_type: String,
}

/// One message in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

/// Incoming conversation from the extension. Mirrors the shape produced by
/// `extension/utils.js::sendToApp`. Unknown fields are tolerated so future
/// extension versions stay compatible.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestPayload {
    pub conversation_id: String,
    pub platform: String,
    pub title: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Pre-rendered markdown from the extension. When present, we save it
    /// verbatim (after math normalization) instead of rendering from messages.
    #[serde(default)]
    pub markdown: Option<String>,
    #[serde(default)]
    pub images: Option<Vec<ImagePayload>>,
}

/// Response returned to the extension after a successful ingest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestResponse {
    pub status: String,
    pub file_path: String,
    pub skipped: bool,
}

/// Persistent CLI configuration stored at ~/.kept-cli/config.toml.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliConfig {
    /// Directory where conversation markdown files are written. Defaults to
    /// `~/.kept-cli/vault/` when unset.
    #[serde(default)]
    pub vault_path: Option<String>,
    /// HTTP port the daemon listens on. Defaults to 18241 (which is what the
    /// browser extension expects). Override only if you know what you're doing.
    #[serde(default)]
    pub port: Option<u16>,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            vault_path: None,
            port: None,
        }
    }
}
