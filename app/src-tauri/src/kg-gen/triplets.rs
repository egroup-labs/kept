/// Normalize an entity name for use as a stable ID key:
/// lowercase, replace non-alphanumeric with spaces, collapse whitespace.
pub fn normalize_entity_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' {
                c.to_lowercase().next().unwrap_or(c)
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Derive a stable entity ID from a normalized entity name.
/// Replaces spaces with underscores, keeps alphanumeric and underscores only.
pub fn entity_id_from_name(normalized: &str) -> String {
    normalized
        .chars()
        .map(|c| if c == ' ' { '_' } else { c })
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize() {
        assert_eq!(normalize_entity_name("React.js"), "react js");
        assert_eq!(normalize_entity_name("TypeScript"), "typescript");
        assert_eq!(
            normalize_entity_name("machine learning"),
            "machine learning"
        );
        assert_eq!(normalize_entity_name("GPT-4"), "gpt 4");
    }

    #[test]
    fn test_entity_id() {
        assert_eq!(entity_id_from_name("machine learning"), "machine_learning");
        assert_eq!(entity_id_from_name("react js"), "react_js");
        assert_eq!(entity_id_from_name("gpt 4"), "gpt_4");
    }
}
