#![allow(dead_code)]
use cozo::{DataValue, DbInstance, NamedRows, ScriptMutability};
use std::collections::BTreeMap;

use crate::models::{GraphData, GraphEdge, GraphNode, KgStats};

pub struct KgDatabase {
    db: DbInstance,
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Escape a string value for a CozoScript inline data literal.
fn esc(s: &str) -> String {
    s.replace('\\', r"\\")
        .replace('"', r#"\""#)
        .replace('\n', " ")
        .replace('\r', "")
}

fn dv_str(v: &DataValue) -> String {
    // CozoDB serializes DataValue::Str as {"Str": "value"} (external tagging).
    // Handle both a plain JSON string and the tagged-object form.
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Object(map)) => map
            .get("Str")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn dv_i64(v: &DataValue) -> i64 {
    // CozoDB serializes DataValue::Num as {"Num": {"Int": n}} or {"Num": n}.
    match serde_json::to_value(v) {
        Ok(serde_json::Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().map(|f| f as i64).unwrap_or(0)),
        Ok(serde_json::Value::Object(map)) => {
            let num = map.get("Num");
            match num {
                Some(serde_json::Value::Number(n)) => n
                    .as_i64()
                    .unwrap_or_else(|| n.as_f64().map(|f| f as i64).unwrap_or(0)),
                Some(serde_json::Value::Object(inner)) => {
                    if let Some(serde_json::Value::Number(n)) = inner.get("Int") {
                        n.as_i64().unwrap_or(0)
                    } else if let Some(serde_json::Value::Number(n)) = inner.get("Float") {
                        n.as_f64().map(|f| f as i64).unwrap_or(0)
                    } else {
                        0
                    }
                }
                _ => 0,
            }
        }
        _ => 0,
    }
}

/// Decode an embedding stored as a JSON string column.
fn dv_embedding(v: &DataValue) -> Vec<f64> {
    let s = dv_str(v);
    serde_json::from_str::<Vec<f64>>(&s).unwrap_or_default()
}

/// Convert a raw vault filename like "2026-02-20_basics-of-rl.md" into a readable display title.
/// Returns the string unchanged if it doesn't look like a timestamped vault filename.
fn pretty_conv_title(raw: &str) -> String {
    // Not a markdown filename — already a real title
    if !raw.ends_with(".md") {
        return raw.to_string();
    }
    // Strip .md
    let s = &raw[..raw.len() - 3];
    // Strip leading YYYY-MM-DD_ or YYYY-MM-DD-
    let s = if s.len() > 11 {
        let prefix = &s[..10];
        let is_date = prefix.chars().enumerate().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        });
        if is_date {
            let rest = &s[10..];
            if rest.starts_with('_') || rest.starts_with('-') {
                &rest[1..]
            } else {
                rest
            }
        } else {
            s
        }
    } else {
        s
    };
    // Replace _ and - with spaces, capitalize first letter
    let clean: String = s
        .chars()
        .map(|c| if c == '_' || c == '-' { ' ' } else { c })
        .collect();
    let mut chars = clean.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn pretty_provider_name(platform: &str) -> String {
    match platform {
        "chatgpt" => "ChatGPT".to_string(),
        "claude" => "Claude".to_string(),
        "gemini" => "Gemini".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            }
        }
    }
}

// ── KgDatabase ────────────────────────────────────────────────────────────────

impl KgDatabase {
    pub fn init(db_path: &str) -> Result<Self, String> {
        // CozoDB with RocksDB backend — robust under write pressure, no corruption.
        // Try to open; on ANY failure wipe and recreate.
        // The KG is always rebuildable from the vault, so data loss is acceptable.
        let db = match DbInstance::new("rocksdb", db_path, "{}") {
            Ok(d) => d,
            Err(e) => {
                eprintln!("KG database open failed, wiping and recreating: {:?}", e);
                let _ = std::fs::remove_dir_all(db_path);
                DbInstance::new("rocksdb", db_path, "{}")
                    .map_err(|e| format!("Failed to open KG database: {:?}", e))?
            }
        };
        let kg = KgDatabase { db };
        if let Err(schema_err) = kg.init_schema() {
            eprintln!(
                "KG schema init failed, wiping and recreating: {}",
                schema_err
            );
            drop(kg);
            let _ = std::fs::remove_dir_all(db_path);
            let db2 = DbInstance::new("rocksdb", db_path, "{}")
                .map_err(|e| format!("Failed to open fresh KG database: {:?}", e))?;
            let kg2 = KgDatabase { db: db2 };
            kg2.init_schema()?;
            return Ok(kg2);
        }
        Ok(kg)
    }

    fn run_mut(&self, script: &str) -> Result<NamedRows, String> {
        self.db
            .run_script(script, Default::default(), ScriptMutability::Mutable)
            .map_err(|e| format!("CozoDB mutation error: {:?}", e))
    }

    fn run_mut_params(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
    ) -> Result<NamedRows, String> {
        self.db
            .run_script(script, params, ScriptMutability::Mutable)
            .map_err(|e| format!("CozoDB mutation error: {:?}", e))
    }

    fn run_query(
        &self,
        script: &str,
        params: BTreeMap<String, DataValue>,
    ) -> Result<NamedRows, String> {
        self.db
            .run_script(script, params, ScriptMutability::Immutable)
            .map_err(|e| format!("CozoDB query error: {:?}", e))
    }

    fn run_q(&self, script: &str) -> Result<NamedRows, String> {
        self.run_query(script, Default::default())
    }

    /// Create tables idempotently; "already exists" errors are silently ignored.
    /// kg_triple uses `rel` instead of `relation` to avoid a CozoDB reserved-word conflict.
    fn init_schema(&self) -> Result<(), String> {
        let ddls = [
            ":create kg_entity  { id: String => name: String, frequency: Int, embedding: String, entity_type: String }",
            ":create kg_synonym { entity_id: String, synonym: String }",
            ":create kg_triple  { from_id: String, rel: String, to_id: String => weight: Int }",
            ":create kg_mention { entity_id: String, conv_id: String => mention_count: Int, conv_title: String, file_path: String, platform: String }",
            // ── New tables for summarization + project tracking ──
            ":create kg_summary { conv_id: String => summary: String, project_hint: String, phase: String, key_decisions: String, key_topics: String, embedding: String }",
            ":create kg_project { id: String => name: String, description: String, embedding: String }",
            ":create kg_project_conv { project_id: String, conv_id: String => phase: String, order_hint: Int }",
            ":create kg_digest { id: String => content: String, generated_at: String, conv_hash: String }",
            // ── Topic-based graph layout ──
            ":create kg_topic { id: String => name: String, description: String }",
            ":create kg_topic_conv { topic_id: String, conv_id: String }",
        ];
        for ddl in &ddls {
            if let Err(e) = self
                .db
                .run_script(ddl, Default::default(), ScriptMutability::Mutable)
            {
                let err_msg = format!("{:?}", e);
                // Suppress "already exists" errors (idempotent DDL), log all others
                if !err_msg.contains("already exists")
                    && !err_msg.contains("stored_relation_conflict")
                {
                    eprintln!("KG DDL error for '{}': {}", ddl, err_msg);
                }
            }
        }
        // Verify DB is actually usable by counting rows in each stored relation.
        // If any fail (e.g. corrupt metadata), init() will wipe and reinitialize.
        self.db
            .run_script(
                "?[id] := *kg_entity[id, _, _, _, _] :limit 0",
                Default::default(),
                ScriptMutability::Immutable,
            )
            .map_err(|e| format!("DB health check failed: {:?}", e))?;
        self.db
            .run_script(
                "?[a] := *kg_triple[a, _, _, _] :limit 0",
                Default::default(),
                ScriptMutability::Immutable,
            )
            .map_err(|e| format!("DB health check failed: {:?}", e))?;
        self.db
            .run_script(
                "?[a] := *kg_mention[a, _, _, _, _, _] :limit 0",
                Default::default(),
                ScriptMutability::Immutable,
            )
            .map_err(|e| format!("DB health check failed: {:?}", e))?;
        self.db
            .run_script(
                "?[a] := *kg_synonym[a, _] :limit 0",
                Default::default(),
                ScriptMutability::Immutable,
            )
            .map_err(|e| format!("DB health check failed: {:?}", e))?;
        // New tables — non-fatal health checks (they may not exist on first upgrade)
        let _ = self.db.run_script(
            "?[a] := *kg_summary[a, _, _, _, _, _, _] :limit 0",
            Default::default(),
            ScriptMutability::Immutable,
        );
        let _ = self.db.run_script(
            "?[a] := *kg_project[a, _, _, _] :limit 0",
            Default::default(),
            ScriptMutability::Immutable,
        );
        let _ = self.db.run_script(
            "?[a] := *kg_project_conv[a, _, _, _] :limit 0",
            Default::default(),
            ScriptMutability::Immutable,
        );
        let _ = self.db.run_script(
            "?[a] := *kg_digest[a, _, _, _] :limit 0",
            Default::default(),
            ScriptMutability::Immutable,
        );
        let _ = self.db.run_script(
            "?[a] := *kg_topic[a, _, _] :limit 0",
            Default::default(),
            ScriptMutability::Immutable,
        );
        let _ = self.db.run_script(
            "?[a, b] := *kg_topic_conv[a, b] :limit 0",
            Default::default(),
            ScriptMutability::Immutable,
        );
        Ok(())
    }

    // ── write ─────────────────────────────────────────────────────────────────

    /// Delete all KG data (for a full re-index).
    /// Variable names in the query head MUST match the extractor column names exactly —
    /// CozoDB uses name-based (not positional) mapping in the extractor block.
    pub fn clear_all(&self) -> Result<(), String> {
        self.run_mut("?[id] := *kg_entity[id, _, _, _, _] :delete kg_entity { id }")?;
        self.run_mut("?[entity_id, synonym] := *kg_synonym[entity_id, synonym] :delete kg_synonym { entity_id, synonym }")?;
        self.run_mut("?[from_id, rel, to_id] := *kg_triple[from_id, rel, to_id, _] :delete kg_triple { from_id, rel, to_id }")?;
        self.run_mut("?[entity_id, conv_id] := *kg_mention[entity_id, conv_id, _, _, _, _] :delete kg_mention { entity_id, conv_id }")?;
        // New tables
        let _ = self.run_mut(
            "?[conv_id] := *kg_summary[conv_id, _, _, _, _, _, _] :delete kg_summary { conv_id }",
        );
        let _ = self.run_mut("?[id] := *kg_project[id, _, _, _] :delete kg_project { id }");
        let _ = self.run_mut("?[project_id, conv_id] := *kg_project_conv[project_id, conv_id, _, _] :delete kg_project_conv { project_id, conv_id }");
        let _ = self.run_mut("?[id] := *kg_digest[id, _, _, _] :delete kg_digest { id }");
        let _ = self.run_mut("?[id] := *kg_topic[id, _, _] :delete kg_topic { id }");
        let _ = self.run_mut("?[topic_id, conv_id] := *kg_topic_conv[topic_id, conv_id] :delete kg_topic_conv { topic_id, conv_id }");
        Ok(())
    }

    /// Upsert an entity, incrementing its frequency. Embedding stored as JSON string.
    pub fn upsert_entity(
        &self,
        id: &str,
        name: &str,
        embedding: &[f64],
        entity_type: &str,
    ) -> Result<(), String> {
        let freq = self.entity_frequency(id)? + 1;
        let emb_json = serde_json::to_string(embedding).unwrap_or_else(|_| "[]".to_string());
        let etype = if entity_type.is_empty() {
            "concept"
        } else {
            entity_type
        };
        let mut p = BTreeMap::new();
        p.insert("id".to_string(), DataValue::Str(id.into()));
        p.insert("name".to_string(), DataValue::Str(name.into()));
        p.insert("freq".to_string(), DataValue::from(freq));
        p.insert("emb".to_string(), DataValue::Str(emb_json.into()));
        p.insert("etype".to_string(), DataValue::Str(etype.into()));
        self.run_mut_params(
            "?[id, name, frequency, embedding, entity_type] <- [[$id, $name, $freq, $emb, $etype]] :put kg_entity { id => name, frequency, embedding, entity_type }",
            p,
        )?;
        Ok(())
    }

    pub fn entity_frequency(&self, id: &str) -> Result<i64, String> {
        let mut p = BTreeMap::new();
        p.insert("id".to_string(), DataValue::Str(id.into()));
        let rows = self.run_query("?[freq] := *kg_entity[$id, _, freq, _, _]", p)?;
        Ok(rows
            .rows
            .first()
            .and_then(|r| r.first())
            .map(dv_i64)
            .unwrap_or(0))
    }

    pub fn add_synonym(&self, canonical_id: &str, synonym: &str) -> Result<(), String> {
        let mut p = BTreeMap::new();
        p.insert("eid".to_string(), DataValue::Str(canonical_id.into()));
        p.insert("syn".to_string(), DataValue::Str(synonym.into()));
        // Non-fatal: ignore extractor issues on key-only relations
        let _ = self.run_mut_params(
            "?[entity_id, synonym] <- [[$eid, $syn]] :put kg_synonym { entity_id, synonym }",
            p,
        );
        Ok(())
    }

    pub fn upsert_triple(&self, from_id: &str, relation: &str, to_id: &str) -> Result<(), String> {
        let weight = self.triple_weight(from_id, relation, to_id)? + 1;
        let mut p = BTreeMap::new();
        p.insert("from_id".to_string(), DataValue::Str(from_id.into()));
        p.insert("rel".to_string(), DataValue::Str(relation.into()));
        p.insert("to_id".to_string(), DataValue::Str(to_id.into()));
        p.insert("weight".to_string(), DataValue::from(weight));
        self.run_mut_params(
            "?[from_id, rel, to_id, weight] <- [[$from_id, $rel, $to_id, $weight]] :put kg_triple { from_id, rel, to_id => weight }",
            p,
        )?;
        Ok(())
    }

    pub fn remove_triple(&self, from_id: &str, relation: &str, to_id: &str) -> Result<(), String> {
        let mut p = BTreeMap::new();
        p.insert("from_id".to_string(), DataValue::Str(from_id.into()));
        p.insert("rel".to_string(), DataValue::Str(relation.into()));
        p.insert("to_id".to_string(), DataValue::Str(to_id.into()));
        self.run_mut_params(
            "?[from_id, rel, to_id] <- [[$from_id, $rel, $to_id]] :rm kg_triple { from_id, rel, to_id }",
            p,
        )?;
        Ok(())
    }

    pub fn remove_entity(&self, entity_id: &str) -> Result<(), String> {
        let eid = DataValue::Str(entity_id.into());
        let mut p = BTreeMap::new();
        p.insert("eid".to_string(), eid);
        // Remove synonyms
        self.run_mut_params(
            "?[entity_id, synonym] := *kg_synonym[entity_id, synonym], entity_id = $eid :rm kg_synonym { entity_id, synonym }",
            p.clone(),
        ).ok();
        // Remove mentions
        self.run_mut_params(
            "?[entity_id, conv_id] := *kg_mention[entity_id, conv_id, _, _, _, _], entity_id = $eid :rm kg_mention { entity_id, conv_id }",
            p.clone(),
        ).ok();
        // Remove triples (both directions)
        self.run_mut_params(
            "?[from_id, rel, to_id] := *kg_triple[from_id, rel, to_id, _], from_id = $eid :rm kg_triple { from_id, rel, to_id }",
            p.clone(),
        ).ok();
        self.run_mut_params(
            "?[from_id, rel, to_id] := *kg_triple[from_id, rel, to_id, _], to_id = $eid :rm kg_triple { from_id, rel, to_id }",
            p.clone(),
        ).ok();
        // Remove entity itself
        self.run_mut_params("?[id] <- [[$eid]] :rm kg_entity { id }", p)?;
        Ok(())
    }

    fn triple_weight(&self, from_id: &str, relation: &str, to_id: &str) -> Result<i64, String> {
        let mut p = BTreeMap::new();
        p.insert("a".to_string(), DataValue::Str(from_id.into()));
        p.insert("r".to_string(), DataValue::Str(relation.into()));
        p.insert("b".to_string(), DataValue::Str(to_id.into()));
        let rows = self.run_query("?[w] := *kg_triple[$a, $r, $b, w]", p)?;
        Ok(rows
            .rows
            .first()
            .and_then(|r| r.first())
            .map(dv_i64)
            .unwrap_or(0))
    }

    pub fn upsert_mention(
        &self,
        entity_id: &str,
        conv_id: &str,
        conv_title: &str,
        file_path: &str,
        platform: &str,
    ) -> Result<(), String> {
        let count = self.mention_count(entity_id, conv_id)? + 1;
        let mut p = BTreeMap::new();
        p.insert("entity_id".to_string(), DataValue::Str(entity_id.into()));
        p.insert("conv_id".to_string(), DataValue::Str(conv_id.into()));
        p.insert("count".to_string(), DataValue::from(count));
        p.insert("conv_title".to_string(), DataValue::Str(conv_title.into()));
        p.insert("file_path".to_string(), DataValue::Str(file_path.into()));
        p.insert("platform".to_string(), DataValue::Str(platform.into()));
        self.run_mut_params(
            "?[entity_id, conv_id, mention_count, conv_title, file_path, platform] <- [[$entity_id, $conv_id, $count, $conv_title, $file_path, $platform]] :put kg_mention { entity_id, conv_id => mention_count, conv_title, file_path, platform }",
            p,
        )?;
        Ok(())
    }

    fn mention_count(&self, entity_id: &str, conv_id: &str) -> Result<i64, String> {
        let mut p = BTreeMap::new();
        p.insert("eid".to_string(), DataValue::Str(entity_id.into()));
        p.insert("cid".to_string(), DataValue::Str(conv_id.into()));
        let rows = self.run_query("?[cnt] := *kg_mention[$eid, $cid, cnt, _, _, _]", p)?;
        Ok(rows
            .rows
            .first()
            .and_then(|r| r.first())
            .map(dv_i64)
            .unwrap_or(0))
    }

    // ── summary / project write ───────────────────────────────────────────────

    /// Store the LLM-generated summary for a conversation.
    pub fn upsert_summary(
        &self,
        conv_id: &str,
        summary: &str,
        project_hint: &str,
        phase: &str,
        key_decisions: &[String],
        key_topics: &[String],
        embedding: &[f64],
    ) -> Result<(), String> {
        let decisions_json =
            serde_json::to_string(key_decisions).unwrap_or_else(|_| "[]".to_string());
        let topics_json = serde_json::to_string(key_topics).unwrap_or_else(|_| "[]".to_string());
        let emb_json = serde_json::to_string(embedding).unwrap_or_else(|_| "[]".to_string());
        let mut p = BTreeMap::new();
        p.insert("conv_id".to_string(), DataValue::Str(conv_id.into()));
        p.insert("summary".to_string(), DataValue::Str(summary.into()));
        p.insert(
            "project_hint".to_string(),
            DataValue::Str(project_hint.into()),
        );
        p.insert("phase".to_string(), DataValue::Str(phase.into()));
        p.insert(
            "key_decisions".to_string(),
            DataValue::Str(decisions_json.into()),
        );
        p.insert("key_topics".to_string(), DataValue::Str(topics_json.into()));
        p.insert("embedding".to_string(), DataValue::Str(emb_json.into()));
        self.run_mut_params(
            "?[conv_id, summary, project_hint, phase, key_decisions, key_topics, embedding] <- [[$conv_id, $summary, $project_hint, $phase, $key_decisions, $key_topics, $embedding]] :put kg_summary { conv_id => summary, project_hint, phase, key_decisions, key_topics, embedding }",
            p,
        )?;
        Ok(())
    }

    /// Get the key_topics list for a conversation (parsed from stored JSON string).
    /// Returns an empty Vec if the conversation isn't summarized.
    pub fn get_summary_topics(&self, conv_id: &str) -> Result<Vec<String>, String> {
        let mut p = BTreeMap::new();
        p.insert("cid".to_string(), DataValue::Str(conv_id.into()));
        let rows = self.run_query(
            "?[key_topics] := *kg_summary[$cid, _, _, _, _, key_topics, _]",
            p,
        )?;
        if let Some(row) = rows.rows.first() {
            if let Some(v) = row.first() {
                let raw = dv_str(v);
                let parsed: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
                return Ok(parsed);
            }
        }
        Ok(Vec::new())
    }

    /// Get summary data for a conversation (returns None if not summarized).
    pub fn get_summary(&self, conv_id: &str) -> Result<Option<(String, String, String)>, String> {
        let mut p = BTreeMap::new();
        p.insert("cid".to_string(), DataValue::Str(conv_id.into()));
        let rows = self.run_query(
            "?[summary, project_hint, phase] := *kg_summary[$cid, summary, project_hint, phase, _, _, _]", p,
        )?;
        if let Some(row) = rows.rows.first() {
            if row.len() >= 3 {
                return Ok(Some((dv_str(&row[0]), dv_str(&row[1]), dv_str(&row[2]))));
            }
        }
        Ok(None)
    }

    /// Get all summary embeddings for project clustering.
    pub fn get_all_summary_embeddings(
        &self,
    ) -> Result<Vec<(String, String, String, Vec<f64>)>, String> {
        let rows = self.run_q(
            "?[conv_id, project_hint, phase, embedding] := *kg_summary[conv_id, _, project_hint, phase, _, _, embedding]",
        )?;
        Ok(rows
            .rows
            .iter()
            .filter_map(|row| {
                if row.len() < 4 {
                    return None;
                }
                let conv_id = dv_str(&row[0]);
                let project_hint = dv_str(&row[1]);
                let phase = dv_str(&row[2]);
                let emb = dv_embedding(&row[3]);
                if emb.is_empty() {
                    return None;
                }
                Some((conv_id, project_hint, phase, emb))
            })
            .collect())
    }

    /// Insert or update a project.
    pub fn upsert_project(
        &self,
        id: &str,
        name: &str,
        description: &str,
        embedding: &[f64],
    ) -> Result<(), String> {
        let emb_json = serde_json::to_string(embedding).unwrap_or_else(|_| "[]".to_string());
        let mut p = BTreeMap::new();
        p.insert("id".to_string(), DataValue::Str(id.into()));
        p.insert("name".to_string(), DataValue::Str(name.into()));
        p.insert("desc".to_string(), DataValue::Str(description.into()));
        p.insert("emb".to_string(), DataValue::Str(emb_json.into()));
        self.run_mut_params(
            "?[id, name, description, embedding] <- [[$id, $name, $desc, $emb]] :put kg_project { id => name, description, embedding }",
            p,
        )?;
        Ok(())
    }

    /// Delete a project and its conversation links.
    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let mut p = BTreeMap::new();
        p.insert("id".to_string(), DataValue::Str(id.into()));
        // Remove conversation links first
        self.run_mut_params(
            "?[project_id, conv_id] := *kg_project_conv[project_id, conv_id, _, _], project_id = $id :rm kg_project_conv { project_id, conv_id }",
            p.clone(),
        )?;
        // Remove the project itself
        self.run_mut_params("?[id] <- [[$id]] :rm kg_project { id }", p)?;
        Ok(())
    }

    /// Unlink a conversation from a project.
    pub fn unlink_project_conv(&self, project_id: &str, conv_id: &str) -> Result<(), String> {
        let mut p = BTreeMap::new();
        p.insert("project_id".to_string(), DataValue::Str(project_id.into()));
        p.insert("conv_id".to_string(), DataValue::Str(conv_id.into()));
        self.run_mut_params(
            "?[project_id, conv_id] <- [[$project_id, $conv_id]] :rm kg_project_conv { project_id, conv_id }",
            p,
        )?;
        Ok(())
    }

    /// Link a conversation to a project.
    pub fn link_project_conv(
        &self,
        project_id: &str,
        conv_id: &str,
        phase: &str,
        order_hint: i64,
    ) -> Result<(), String> {
        let mut p = BTreeMap::new();
        p.insert("project_id".to_string(), DataValue::Str(project_id.into()));
        p.insert("conv_id".to_string(), DataValue::Str(conv_id.into()));
        p.insert("phase".to_string(), DataValue::Str(phase.into()));
        p.insert("order_hint".to_string(), DataValue::from(order_hint));
        self.run_mut_params(
            "?[project_id, conv_id, phase, order_hint] <- [[$project_id, $conv_id, $phase, $order_hint]] :put kg_project_conv { project_id, conv_id => phase, order_hint }",
            p,
        )?;
        Ok(())
    }

    /// Get the project (id, name) for each given conversation_id, if any.
    /// Returns a map of conv_id → (project_id, project_name).
    pub fn get_projects_for_conversations(
        &self,
        conv_ids: &[String],
    ) -> Result<std::collections::HashMap<String, (String, String)>, String> {
        let mut out: std::collections::HashMap<String, (String, String)> = Default::default();
        if conv_ids.is_empty() {
            return Ok(out);
        }
        // Build set for fast lookup
        let want: std::collections::HashSet<&str> =
            conv_ids.iter().map(|s| s.as_str()).collect();

        // Fetch all project names keyed by id
        let proj_rows =
            self.run_q("?[id, name] := *kg_project[id, name, _, _]")?;
        let mut proj_names: std::collections::HashMap<String, String> = Default::default();
        for row in &proj_rows.rows {
            if row.len() < 2 {
                continue;
            }
            proj_names.insert(dv_str(&row[0]), dv_str(&row[1]));
        }

        // Fetch all links and filter by wanted conversations
        let link_rows =
            self.run_q("?[project_id, conv_id] := *kg_project_conv[project_id, conv_id, _, _]")?;
        for row in &link_rows.rows {
            if row.len() < 2 {
                continue;
            }
            let pid = dv_str(&row[0]);
            let cid = dv_str(&row[1]);
            if want.contains(cid.as_str()) {
                if let Some(name) = proj_names.get(&pid) {
                    out.insert(cid, (pid, name.clone()));
                }
            }
        }
        Ok(out)
    }

    /// Get all projects with their conversation count.
    pub fn get_projects(&self) -> Result<Vec<(String, String, String, i64)>, String> {
        // Fetch all projects
        let proj_rows =
            self.run_q("?[id, name, description] := *kg_project[id, name, description, _]")?;
        let link_rows =
            self.run_q("?[project_id, conv_id] := *kg_project_conv[project_id, conv_id, _, _]")?;
        // Count conversations per project
        let mut conv_counts: std::collections::HashMap<String, i64> = Default::default();
        for row in &link_rows.rows {
            if row.len() < 2 {
                continue;
            }
            *conv_counts.entry(dv_str(&row[0])).or_insert(0) += 1;
        }
        Ok(proj_rows
            .rows
            .iter()
            .filter_map(|row| {
                if row.len() < 3 {
                    return None;
                }
                let id = dv_str(&row[0]);
                let count = conv_counts.get(&id).copied().unwrap_or(0);
                Some((id, dv_str(&row[1]), dv_str(&row[2]), count))
            })
            .collect())
    }

    /// Get the timeline of conversations in a project, ordered by order_hint.
    pub fn get_project_timeline(
        &self,
        project_id: &str,
    ) -> Result<Vec<(String, String, i64)>, String> {
        let mut p = BTreeMap::new();
        p.insert("pid".to_string(), DataValue::Str(project_id.into()));
        let rows = self.run_query(
            "?[conv_id, phase, order_hint] := *kg_project_conv[$pid, conv_id, phase, order_hint]",
            p,
        )?;
        let mut timeline: Vec<(String, String, i64)> = rows
            .rows
            .iter()
            .filter_map(|row| {
                if row.len() < 3 {
                    return None;
                }
                Some((dv_str(&row[0]), dv_str(&row[1]), dv_i64(&row[2])))
            })
            .collect();
        timeline.sort_by_key(|t| t.2);
        Ok(timeline)
    }

    /// Store a cached digest.
    pub fn upsert_digest(
        &self,
        content: &str,
        generated_at: &str,
        conv_hash: &str,
    ) -> Result<(), String> {
        let script = format!(
            r#"?[id, content, generated_at, conv_hash] <- [["latest","{}","{}","{}"]] :put kg_digest {{ id => content, generated_at, conv_hash }}"#,
            esc(content),
            esc(generated_at),
            esc(conv_hash),
        );
        self.run_mut(&script)?;
        Ok(())
    }

    /// Get the cached digest (returns None if no digest cached).
    pub fn get_digest(&self) -> Result<Option<(String, String, String)>, String> {
        let rows = self.run_q(
            r#"?[content, generated_at, conv_hash] := *kg_digest["latest", content, generated_at, conv_hash]"#,
        )?;
        if let Some(row) = rows.rows.first() {
            if row.len() >= 3 {
                return Ok(Some((dv_str(&row[0]), dv_str(&row[1]), dv_str(&row[2]))));
            }
        }
        Ok(None)
    }

    /// Get all indexed conversation IDs (for incremental skip check in one query).
    pub fn all_indexed_conv_ids(&self) -> Result<std::collections::HashSet<String>, String> {
        let rows = self.run_q("?[c] := *kg_mention[_, c, _, _, _, _]")?;
        Ok(rows
            .rows
            .iter()
            .filter_map(|r| {
                if r.is_empty() {
                    None
                } else {
                    Some(dv_str(&r[0]))
                }
            })
            .collect())
    }

    /// Bulk write all entities, mentions, triples, and summaries in minimal CozoDB operations.
    /// Uses DataValue parameters to avoid string escaping issues with special characters.
    pub fn bulk_write(
        &self,
        entities: &[(String, String, i64, String)], // (id, name, frequency, entity_type)
        mentions: &[(String, String, String, String, String)], // (eid, cid, title, path, platform)
        triples: &[(String, String, String)],       // (from_id, rel, to_id)
        summaries: &[(&str, &str, &str, &str, &[String])], // (cid, summary, hint, phase, topics)
    ) -> Result<(), String> {
        const CHUNK: usize = 200;

        // Entities — use DataValue::List for safe parameter binding
        for chunk in entities.chunks(CHUNK) {
            let data: Vec<DataValue> = chunk
                .iter()
                .map(|(id, name, freq, etype)| {
                    let t = if etype.is_empty() {
                        "concept"
                    } else {
                        etype.as_str()
                    };
                    DataValue::List(vec![
                        DataValue::Str(id.as_str().into()),
                        DataValue::Str(name.as_str().into()),
                        DataValue::from(*freq),
                        DataValue::Str("[]".into()),
                        DataValue::Str(t.into()),
                    ])
                })
                .collect();
            let mut params = BTreeMap::new();
            params.insert("data".to_string(), DataValue::List(data));
            self.run_mut_params(
                "?[id, name, frequency, embedding, entity_type] <- $data :put kg_entity { id => name, frequency, embedding, entity_type }",
                params,
            )?;
        }

        // Mentions
        for chunk in mentions.chunks(CHUNK) {
            let data: Vec<DataValue> = chunk
                .iter()
                .map(|(eid, cid, title, path, plat)| {
                    DataValue::List(vec![
                        DataValue::Str(eid.as_str().into()),
                        DataValue::Str(cid.as_str().into()),
                        DataValue::from(1i64),
                        DataValue::Str(title.as_str().into()),
                        DataValue::Str(path.as_str().into()),
                        DataValue::Str(plat.as_str().into()),
                    ])
                })
                .collect();
            let mut params = BTreeMap::new();
            params.insert("data".to_string(), DataValue::List(data));
            self.run_mut_params(
                "?[entity_id, conv_id, mention_count, conv_title, file_path, platform] <- $data :put kg_mention { entity_id, conv_id => mention_count, conv_title, file_path, platform }",
                params,
            )?;
        }

        // Triples
        for chunk in triples.chunks(CHUNK) {
            let data: Vec<DataValue> = chunk
                .iter()
                .map(|(from, rel, to)| {
                    DataValue::List(vec![
                        DataValue::Str(from.as_str().into()),
                        DataValue::Str(rel.as_str().into()),
                        DataValue::Str(to.as_str().into()),
                        DataValue::from(1i64),
                    ])
                })
                .collect();
            let mut params = BTreeMap::new();
            params.insert("data".to_string(), DataValue::List(data));
            self.run_mut_params(
                "?[from_id, rel, to_id, weight] <- $data :put kg_triple { from_id, rel, to_id => weight }",
                params,
            )?;
        }

        // Summaries
        for chunk in summaries.chunks(CHUNK) {
            let data: Vec<DataValue> = chunk
                .iter()
                .map(|(cid, summary, hint, phase, topics)| {
                    let topics_json =
                        serde_json::to_string(topics).unwrap_or_else(|_| "[]".to_string());
                    DataValue::List(vec![
                        DataValue::Str((*cid).into()),
                        DataValue::Str((*summary).into()),
                        DataValue::Str((*hint).into()),
                        DataValue::Str((*phase).into()),
                        DataValue::Str("[]".into()),
                        DataValue::Str(topics_json.into()),
                        DataValue::Str("[]".into()),
                    ])
                })
                .collect();
            let mut params = BTreeMap::new();
            params.insert("data".to_string(), DataValue::List(data));
            self.run_mut_params(
                "?[conv_id, summary, project_hint, phase, key_decisions, key_topics, embedding] <- $data :put kg_summary { conv_id => summary, project_hint, phase, key_decisions, key_topics, embedding }",
                params,
            )?;
        }

        Ok(())
    }

    /// Get all conversation summaries with full data for digest generation.
    pub fn get_all_summaries(
        &self,
    ) -> Result<Vec<(String, String, String, String, String, String)>, String> {
        let rows = self.run_q(
            "?[conv_id, summary, project_hint, phase, key_decisions, key_topics] := *kg_summary[conv_id, summary, project_hint, phase, key_decisions, key_topics, _]",
        )?;
        Ok(rows
            .rows
            .iter()
            .filter_map(|row| {
                if row.len() < 6 {
                    return None;
                }
                Some((
                    dv_str(&row[0]),
                    dv_str(&row[1]),
                    dv_str(&row[2]),
                    dv_str(&row[3]),
                    dv_str(&row[4]),
                    dv_str(&row[5]),
                ))
            })
            .collect())
    }

    // ── read ──────────────────────────────────────────────────────────────────

    /// Check if a conversation has already been indexed (has any mentions in the KG).
    /// Uses an inline literal instead of a parameter because CozoDB's param binding
    /// on a non-first compound-key column is unreliable.
    pub fn is_conv_indexed(&self, conv_id: &str) -> Result<bool, String> {
        let script = format!(
            r#"?[eid] := *kg_mention[eid, c, _, _, _, _], c = "{}" :limit 1"#,
            esc(conv_id)
        );
        let rows = self.run_q(&script)?;
        Ok(!rows.rows.is_empty())
    }

    /// Fetch all synonym rows and group by entity_id. Non-fatal — returns empty map on error.
    fn get_synonyms_map(&self) -> std::collections::HashMap<String, Vec<String>> {
        match self.run_q("?[entity_id, synonym] := *kg_synonym[entity_id, synonym]") {
            Ok(rows) => {
                let mut map: std::collections::HashMap<String, Vec<String>> = Default::default();
                for row in &rows.rows {
                    if row.len() < 2 {
                        continue;
                    }
                    map.entry(dv_str(&row[0]))
                        .or_default()
                        .push(dv_str(&row[1]));
                }
                map
            }
            Err(_) => Default::default(),
        }
    }

    /// Scan kg_triple once; return a map of entity_id → count of *distinct* entity neighbors.
    fn get_neighbor_counts(&self) -> std::collections::HashMap<String, i64> {
        let mut neighbors: std::collections::HashMap<String, std::collections::HashSet<String>> =
            Default::default();
        if let Ok(rows) = self.run_q("?[from_id, to_id] := *kg_triple[from_id, _, to_id, _]") {
            for row in &rows.rows {
                if row.len() < 2 {
                    continue;
                }
                let from = dv_str(&row[0]);
                let to = dv_str(&row[1]);
                neighbors
                    .entry(from.clone())
                    .or_default()
                    .insert(to.clone());
                neighbors.entry(to).or_default().insert(from);
            }
        }
        neighbors
            .into_iter()
            .map(|(k, v)| (k, v.len() as i64))
            .collect()
    }

    /// Scan kg_mention once; return a map of entity_id → count of distinct conversation threads.
    fn get_thread_counts(&self) -> std::collections::HashMap<String, i64> {
        let mut counts: std::collections::HashMap<String, i64> = Default::default();
        if let Ok(rows) =
            self.run_q("?[entity_id, conv_id] := *kg_mention[entity_id, conv_id, _, _, _, _]")
        {
            for row in &rows.rows {
                if row.len() < 2 {
                    continue;
                }
                *counts.entry(dv_str(&row[0])).or_insert(0) += 1;
            }
        }
        counts
    }

    pub fn get_stats(&self) -> Result<KgStats, String> {
        let entity_count = self
            .run_q("?[id] := *kg_entity[id, _, _, _, _]")?
            .rows
            .len() as i64;
        let triple_count = self
            .run_q("?[f, r, t] := *kg_triple[f, r, t, _]")?
            .rows
            .len() as i64;
        let conversation_count = self
            .run_q("?[cid] := *kg_mention[_, cid, _, _, _, _]")?
            .rows
            .len() as i64;
        let project_count = self
            .run_q("?[id] := *kg_project[id, _, _, _]")
            .map(|r| r.rows.len() as i64)
            .unwrap_or(0);

        // Sort in Rust — CozoDB 0.7.6 has a panic bug in sort.rs when using :order on
        // queries whose result rows don't match the stored relation's column count.
        let raw = self.run_q("?[name, freq] := *kg_entity[_, name, freq, _, _]")?;
        let mut top_entities: Vec<(String, i64)> = raw
            .rows
            .iter()
            .filter_map(|r| {
                if r.len() < 2 {
                    return None;
                }
                Some((dv_str(&r[0]), dv_i64(&r[1])))
            })
            .collect();
        top_entities.sort_by(|a, b| b.1.cmp(&a.1));
        top_entities.truncate(10);

        Ok(KgStats {
            entity_count,
            triple_count,
            conversation_count,
            project_count,
            top_entities,
        })
    }

    /// Hybrid search: text substring match on each keyword + cosine similarity on query embedding.
    /// Scores entities by (keyword_hits + embedding_similarity), returns top-limit subgraph.
    pub fn search_subgraph(
        &self,
        keywords: &[String],
        query_embedding: &[f64],
        emb_threshold: f64,
        limit: usize,
    ) -> Result<GraphData, String> {
        // Fetch all entities with their stored embeddings in one pass
        let all_rows =
            self.run_q("?[id, name, freq, emb] := *kg_entity[id, name, freq, emb, _]")?;

        let mut scored: Vec<(f64, String, Vec<DataValue>)> = Vec::new();

        for row in &all_rows.rows {
            if row.len() < 4 {
                continue;
            }
            let id = dv_str(&row[0]);

            // Text score: count of keywords that are substrings of the entity id
            // (id is already lowercase/normalized, so case-insensitive by construction)
            let text_hits = keywords
                .iter()
                .filter(|kw| !kw.is_empty() && id.contains(kw.as_str()))
                .count() as f64;

            // Embedding score
            let emb_score = if !query_embedding.is_empty() {
                let stored = dv_embedding(&row[3]);
                if stored.is_empty() {
                    0.0
                } else {
                    cosine_similarity(query_embedding, &stored)
                }
            } else {
                0.0
            };

            if text_hits > 0.0 || emb_score >= emb_threshold {
                // Combined score weights: text hits take priority, embedding adds nuance
                let score = text_hits * 2.0 + emb_score;
                // Pass [id, name, freq] to build_subgraph (same shape as other callers)
                let short_row = vec![row[0].clone(), row[1].clone(), row[2].clone()];
                scored.push((score, id, short_row));
            }
        }

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        if scored.is_empty() {
            return Ok(GraphData {
                nodes: vec![],
                edges: vec![],
            });
        }

        let ids: Vec<String> = scored.iter().map(|(_, id, _)| id.clone()).collect();
        let entity_rows: Vec<Vec<DataValue>> = scored.into_iter().map(|(_, _, row)| row).collect();
        self.build_subgraph(&ids, &entity_rows)
    }

    pub fn get_full_graph(&self, limit: usize) -> Result<GraphData, String> {
        // Fetch all, sort by frequency in Rust (avoids CozoDB 0.7.6 sort.rs panic bug).
        let all = self.run_q(
            "?[id, name, freq, entity_type] := *kg_entity[id, name, freq, _, entity_type]",
        )?;
        if all.rows.is_empty() {
            return Ok(GraphData {
                nodes: vec![],
                edges: vec![],
            });
        }
        let mut rows = all.rows;
        rows.sort_by(|a, b| {
            let fa = if a.len() > 2 { dv_i64(&a[2]) } else { 0 };
            let fb = if b.len() > 2 { dv_i64(&b[2]) } else { 0 };
            fb.cmp(&fa)
        });
        rows.truncate(limit);
        let ids: Vec<String> = rows
            .iter()
            .filter_map(|r| {
                if r.is_empty() {
                    None
                } else {
                    Some(dv_str(&r[0]))
                }
            })
            .collect();
        self.build_subgraph(&ids, &rows)
    }

    fn build_subgraph(
        &self,
        entity_ids: &[String],
        _entity_rows: &[Vec<DataValue>],
    ) -> Result<GraphData, String> {
        let mut nodes: Vec<GraphNode> = Vec::new();
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut seen_convs: std::collections::HashSet<String> = Default::default();

        let id_set: std::collections::HashSet<&str> =
            entity_ids.iter().map(|s| s.as_str()).collect();

        // ── Phase lookup ──
        let mut phase_map: std::collections::HashMap<String, String> = Default::default();
        if let Ok(summaries) =
            self.run_q("?[conv_id, phase] := *kg_summary[conv_id, _, _, phase, _, _, _]")
        {
            for row in &summaries.rows {
                if row.len() < 2 {
                    continue;
                }
                let phase = dv_str(&row[1]);
                if !phase.is_empty() {
                    phase_map.insert(dv_str(&row[0]), phase);
                }
            }
        }

        // ── Bulk: fetch ALL mentions, build conversation nodes & entity→convs map ──
        let all_mentions = self.run_q(
            "?[entity_id, conv_id, conv_title, file_path, platform] := *kg_mention[entity_id, conv_id, _, conv_title, file_path, platform]"
        )?;

        let mut entity_to_convs: std::collections::HashMap<
            String,
            std::collections::HashSet<String>,
        > = Default::default();
        let mut seen_providers: std::collections::HashSet<String> = Default::default();

        for row in &all_mentions.rows {
            if row.len() < 5 {
                continue;
            }
            let entity_id = dv_str(&row[0]);
            if !id_set.contains(entity_id.as_str()) {
                continue;
            }
            let conv_id = dv_str(&row[1]);
            let platform = dv_str(&row[4]);

            if seen_convs.insert(conv_id.clone()) {
                let conv_phase = phase_map.get(&conv_id).cloned();
                nodes.push(GraphNode {
                    id: conv_id.clone(),
                    name: pretty_conv_title(&dv_str(&row[2])),
                    node_type: "conversation".to_string(),
                    frequency: None,
                    file_path: Some(dv_str(&row[3])),
                    platform: Some(platform.clone()),
                    synonyms: None,
                    neighbor_count: None,
                    thread_count: None,
                    entity_type: None,
                    description: None,
                    phase: conv_phase,
                });
            }

            entity_to_convs
                .entry(entity_id)
                .or_default()
                .insert(conv_id.clone());

            if !platform.is_empty() {
                seen_providers.insert(platform);
            }
        }

        // ── Build conversation-to-conversation edges from shared entities ──
        let mut conv_pair_weights: std::collections::HashMap<(String, String), i64> =
            Default::default();
        for conv_ids in entity_to_convs.values() {
            let convs: Vec<&String> = conv_ids.iter().collect();
            for i in 0..convs.len() {
                for j in (i + 1)..convs.len() {
                    let (a, b) = if convs[i] < convs[j] {
                        (convs[i].clone(), convs[j].clone())
                    } else {
                        (convs[j].clone(), convs[i].clone())
                    };
                    *conv_pair_weights.entry((a, b)).or_insert(0) += 1;
                }
            }
        }
        // Only include keyword edges where conversations share 2+ keywords
        // (single shared keyword is too weak a signal)
        for ((a, b), weight) in &conv_pair_weights {
            if *weight >= 2 {
                edges.push(GraphEdge {
                    source: a.clone(),
                    target: b.clone(),
                    relation: "shared_keywords".to_string(),
                    weight: *weight,
                });
            }
        }

        // ── Provider nodes ──
        let conv_nodes: Vec<(String, Option<String>)> = nodes
            .iter()
            .filter(|n| n.node_type == "conversation")
            .map(|n| (n.id.clone(), n.platform.clone()))
            .collect();

        for platform in &seen_providers {
            let provider_id = format!("provider:{}", platform);
            nodes.push(GraphNode {
                id: provider_id.clone(),
                name: pretty_provider_name(platform),
                node_type: "provider".to_string(),
                frequency: None,
                file_path: None,
                platform: Some(platform.clone()),
                synonyms: None,
                neighbor_count: None,
                thread_count: None,
                entity_type: None,
                description: None,
                phase: None,
            });
            for (conv_id, conv_platform) in &conv_nodes {
                if conv_platform.as_deref() == Some(platform.as_str()) {
                    edges.push(GraphEdge {
                        source: provider_id.clone(),
                        target: conv_id.clone(),
                        relation: "hosts".to_string(),
                        weight: 1,
                    });
                }
            }
        }

        // ── Bulk: attach project nodes ──
        let conv_ids_in_graph: std::collections::HashSet<String> = nodes
            .iter()
            .filter(|n| n.node_type == "conversation")
            .map(|n| n.id.clone())
            .collect();

        if !conv_ids_in_graph.is_empty() {
            let all_proj_convs =
                self.run_q("?[project_id, conv_id] := *kg_project_conv[project_id, conv_id, _, _]");
            let all_projects =
                self.run_q("?[id, name, description] := *kg_project[id, name, description, _]");

            let mut project_details: std::collections::HashMap<String, (String, String)> =
                Default::default();
            if let Ok(proj_rows) = &all_projects {
                for row in &proj_rows.rows {
                    if row.len() < 3 {
                        continue;
                    }
                    project_details.insert(dv_str(&row[0]), (dv_str(&row[1]), dv_str(&row[2])));
                }
            }

            let mut seen_projects: std::collections::HashSet<String> = Default::default();
            let mut seen_proj_edges: std::collections::HashSet<(String, String)> =
                Default::default();
            if let Ok(pc_rows) = &all_proj_convs {
                for row in &pc_rows.rows {
                    if row.len() < 2 {
                        continue;
                    }
                    let pid = dv_str(&row[0]);
                    let cid = dv_str(&row[1]);
                    if !conv_ids_in_graph.contains(&cid) {
                        continue;
                    }
                    if seen_projects.insert(pid.clone()) {
                        if let Some((name, description)) = project_details.get(&pid) {
                            nodes.push(GraphNode {
                                id: pid.clone(),
                                name: name.clone(),
                                node_type: "project".to_string(),
                                frequency: None,
                                file_path: None,
                                platform: None,
                                synonyms: None,
                                neighbor_count: None,
                                thread_count: None,
                                entity_type: None,
                                description: Some(description.clone()),
                                phase: None,
                            });
                        }
                    }
                    if seen_proj_edges.insert((pid.clone(), cid.clone())) {
                        edges.push(GraphEdge {
                            source: pid,
                            target: cid,
                            relation: "contains".to_string(),
                            weight: 1,
                        });
                    }
                }
            }
        }

        // ── Bulk: attach topic hub nodes ──
        if !conv_ids_in_graph.is_empty() {
            let all_topic_convs =
                self.run_q("?[topic_id, conv_id] := *kg_topic_conv[topic_id, conv_id]");
            let all_topics =
                self.run_q("?[id, name, description] := *kg_topic[id, name, description]");

            let mut topic_details: std::collections::HashMap<String, (String, String)> =
                Default::default();
            if let Ok(topic_rows) = &all_topics {
                for row in &topic_rows.rows {
                    if row.len() < 3 {
                        continue;
                    }
                    topic_details.insert(dv_str(&row[0]), (dv_str(&row[1]), dv_str(&row[2])));
                }
            }

            let mut seen_topics: std::collections::HashSet<String> = Default::default();
            let mut seen_topic_edges: std::collections::HashSet<(String, String)> =
                Default::default();
            if let Ok(tc_rows) = &all_topic_convs {
                for row in &tc_rows.rows {
                    if row.len() < 2 {
                        continue;
                    }
                    let tid = dv_str(&row[0]);
                    let cid = dv_str(&row[1]);
                    if !conv_ids_in_graph.contains(&cid) {
                        continue;
                    }
                    let topic_node_id = format!("topic:{}", tid);
                    if seen_topics.insert(tid.clone()) {
                        if let Some((name, description)) = topic_details.get(&tid) {
                            nodes.push(GraphNode {
                                id: topic_node_id.clone(),
                                name: name.clone(),
                                node_type: "topic".to_string(),
                                frequency: None,
                                file_path: None,
                                platform: None,
                                synonyms: None,
                                neighbor_count: None,
                                thread_count: None,
                                entity_type: None,
                                description: Some(description.clone()),
                                phase: None,
                            });
                        }
                    }
                    if seen_topic_edges.insert((topic_node_id.clone(), cid.clone())) {
                        edges.push(GraphEdge {
                            source: topic_node_id,
                            target: cid,
                            relation: "belongs_to".to_string(),
                            weight: 2,
                        });
                    }
                }
            }
        }

        Ok(GraphData { nodes, edges })
    }

    /// Return all conversation nodes connected to `node_id` via shared entities
    /// (one hop). For provider nodes, returns all conversations on that platform.
    pub fn get_node_neighbors(&self, node_id: &str) -> Result<GraphData, String> {
        let mut nodes: Vec<GraphNode> = Vec::new();
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut seen_convs: std::collections::HashSet<String> = Default::default();

        // Phase lookup
        let mut phase_map: std::collections::HashMap<String, String> = Default::default();
        if let Ok(summaries) =
            self.run_q("?[conv_id, phase] := *kg_summary[conv_id, _, _, phase, _, _, _]")
        {
            for row in &summaries.rows {
                if row.len() < 2 {
                    continue;
                }
                let phase = dv_str(&row[1]);
                if !phase.is_empty() {
                    phase_map.insert(dv_str(&row[0]), phase);
                }
            }
        }

        // Provider node — return all conversations on that platform
        if let Some(platform) = node_id.strip_prefix("provider:") {
            let all_mentions = self.run_q(
                "?[conv_id, conv_title, file_path, plat] := *kg_mention[_, conv_id, _, conv_title, file_path, plat]"
            )?;
            for row in &all_mentions.rows {
                if row.len() < 4 {
                    continue;
                }
                let plat = dv_str(&row[3]);
                if plat != platform {
                    continue;
                }
                let conv_id = dv_str(&row[0]);
                if seen_convs.insert(conv_id.clone()) {
                    nodes.push(GraphNode {
                        id: conv_id.clone(),
                        name: pretty_conv_title(&dv_str(&row[1])),
                        node_type: "conversation".to_string(),
                        frequency: None,
                        file_path: Some(dv_str(&row[2])),
                        platform: Some(plat),
                        synonyms: None,
                        neighbor_count: None,
                        thread_count: None,
                        entity_type: None,
                        description: None,
                        phase: phase_map.get(&conv_id).cloned(),
                    });
                    edges.push(GraphEdge {
                        source: node_id.to_string(),
                        target: conv_id,
                        relation: "hosts".to_string(),
                        weight: 1,
                    });
                }
            }
            return Ok(GraphData { nodes, edges });
        }

        // Topic node — return all conversations assigned to this topic
        if let Some(topic_id) = node_id.strip_prefix("topic:") {
            let mut tp = BTreeMap::new();
            tp.insert("tid".to_string(), DataValue::Str(topic_id.into()));
            let topic_convs = self.run_query("?[conv_id] := *kg_topic_conv[$tid, conv_id]", tp)?;
            let conv_paths: Vec<String> = topic_convs
                .rows
                .iter()
                .filter_map(|r| {
                    if r.is_empty() {
                        None
                    } else {
                        Some(dv_str(&r[0]))
                    }
                })
                .collect();
            // Look up conversation details from mentions
            let all_mentions = self.run_q(
                "?[conv_id, conv_title, file_path, platform] := *kg_mention[_, conv_id, _, conv_title, file_path, platform]"
            )?;
            let conv_set: std::collections::HashSet<&str> =
                conv_paths.iter().map(|s| s.as_str()).collect();
            for row in &all_mentions.rows {
                if row.len() < 4 {
                    continue;
                }
                let conv_id = dv_str(&row[0]);
                if !conv_set.contains(conv_id.as_str()) {
                    continue;
                }
                if seen_convs.insert(conv_id.clone()) {
                    nodes.push(GraphNode {
                        id: conv_id.clone(),
                        name: pretty_conv_title(&dv_str(&row[1])),
                        node_type: "conversation".to_string(),
                        frequency: None,
                        file_path: Some(dv_str(&row[2])),
                        platform: Some(dv_str(&row[3])),
                        synonyms: None,
                        neighbor_count: None,
                        thread_count: None,
                        entity_type: None,
                        description: None,
                        phase: phase_map.get(&conv_id).cloned(),
                    });
                    edges.push(GraphEdge {
                        source: node_id.to_string(),
                        target: conv_id,
                        relation: "belongs_to".to_string(),
                        weight: 2,
                    });
                }
            }
            return Ok(GraphData { nodes, edges });
        }

        // Conversation node — find other conversations that share entities
        let mut p = BTreeMap::new();
        p.insert("cid".to_string(), DataValue::Str(node_id.into()));

        // Get all entities mentioned in this conversation
        let entity_rows = self.run_query(
            "?[entity_id] := *kg_mention[entity_id, $cid, _, _, _, _]",
            p,
        )?;
        let entity_ids: Vec<String> = entity_rows
            .rows
            .iter()
            .filter_map(|r| {
                if r.is_empty() {
                    None
                } else {
                    Some(dv_str(&r[0]))
                }
            })
            .collect();

        if entity_ids.is_empty() {
            return Ok(GraphData { nodes, edges });
        }

        // For each entity, find all other conversations that also mention it
        let all_mentions = self.run_q(
            "?[entity_id, conv_id, conv_title, file_path, platform] := *kg_mention[entity_id, conv_id, _, conv_title, file_path, platform]"
        )?;
        let entity_set: std::collections::HashSet<&str> =
            entity_ids.iter().map(|s| s.as_str()).collect();

        let mut neighbor_weights: std::collections::HashMap<String, i64> = Default::default();
        for row in &all_mentions.rows {
            if row.len() < 5 {
                continue;
            }
            let eid = dv_str(&row[0]);
            if !entity_set.contains(eid.as_str()) {
                continue;
            }
            let conv_id = dv_str(&row[1]);
            if conv_id == node_id {
                continue;
            }
            *neighbor_weights.entry(conv_id.clone()).or_insert(0) += 1;
            if seen_convs.insert(conv_id.clone()) {
                nodes.push(GraphNode {
                    id: conv_id.clone(),
                    name: pretty_conv_title(&dv_str(&row[2])),
                    node_type: "conversation".to_string(),
                    frequency: None,
                    file_path: Some(dv_str(&row[3])),
                    platform: Some(dv_str(&row[4])),
                    synonyms: None,
                    neighbor_count: None,
                    thread_count: None,
                    entity_type: None,
                    description: None,
                    phase: phase_map.get(&conv_id).cloned(),
                });
            }
        }

        for (conv_id, weight) in &neighbor_weights {
            let (a, b) = if node_id < conv_id.as_str() {
                (node_id.to_string(), conv_id.clone())
            } else {
                (conv_id.clone(), node_id.to_string())
            };
            edges.push(GraphEdge {
                source: a,
                target: b,
                relation: "shared_keywords".to_string(),
                weight: *weight,
            });
        }

        Ok(GraphData { nodes, edges })
    }

    // ── Topic-based graph ─────────────────────────────────────────────────────

    /// Store discovered topics, replacing any previously cached ones.
    pub fn store_topics(&self, topics: &[super::topic_discovery::Topic]) -> Result<(), String> {
        // Clear existing topics and assignments
        let _ = self.run_mut("?[id] := *kg_topic[id, _, _] :delete kg_topic { id }");
        let _ = self.run_mut(
            "?[topic_id, conv_id] := *kg_topic_conv[topic_id, conv_id] :delete kg_topic_conv { topic_id, conv_id }",
        );
        // Insert topics
        for topic in topics {
            let mut p = BTreeMap::new();
            p.insert("id".to_string(), DataValue::Str(topic.id.clone().into()));
            p.insert(
                "name".to_string(),
                DataValue::Str(topic.name.clone().into()),
            );
            p.insert(
                "desc".to_string(),
                DataValue::Str(topic.description.clone().into()),
            );
            self.run_mut_params(
                "?[id, name, description] <- [[$id, $name, $desc]] :put kg_topic { id => name, description }",
                p,
            )?;
        }
        Ok(())
    }

    /// Store topic↔conversation assignments.
    pub fn store_topic_assignments(
        &self,
        assignments: &[super::topic_discovery::TopicAssignment],
        conversations: &[super::keyword_extract::ConversationKeywords],
    ) -> Result<(), String> {
        for assignment in assignments {
            for &idx in &assignment.conversation_indices {
                if idx >= conversations.len() {
                    continue;
                }
                let conv_id = &conversations[idx].conv_id;
                let mut p = BTreeMap::new();
                p.insert(
                    "tid".to_string(),
                    DataValue::Str(assignment.topic_id.clone().into()),
                );
                p.insert("cid".to_string(), DataValue::Str(conv_id.clone().into()));
                let _ = self.run_mut_params(
                    "?[topic_id, conv_id] <- [[$tid, $cid]] :put kg_topic_conv { topic_id, conv_id }",
                    p,
                );
            }
        }
        Ok(())
    }

    /// Check if topic assignments are already cached.
    pub fn has_cached_topics(&self) -> bool {
        self.run_q("?[id] := *kg_topic[id, _, _] :limit 1")
            .map(|r| !r.rows.is_empty())
            .unwrap_or(false)
    }

    /// Return all cached topics.
    pub fn get_cached_topics(&self) -> Result<Vec<super::topic_discovery::Topic>, String> {
        let rows = self.run_q("?[id, name, description] := *kg_topic[id, name, description]")?;
        let mut topics = Vec::new();
        for row in &rows.rows {
            if row.len() < 3 {
                continue;
            }
            topics.push(super::topic_discovery::Topic {
                id: dv_str(&row[0]),
                name: dv_str(&row[1]),
                description: dv_str(&row[2]),
                keywords: vec![],
            });
        }
        Ok(topics)
    }

    /// Return all conversation paths that are assigned to any topic.
    pub fn get_all_classified_paths(&self) -> Result<std::collections::HashSet<String>, String> {
        let rows = self.run_q("?[conv_id] := *kg_topic_conv[_, conv_id]")?;
        let mut paths = std::collections::HashSet::new();
        for row in &rows.rows {
            if !row.is_empty() {
                paths.insert(dv_str(&row[0]));
            }
        }
        Ok(paths)
    }

    /// Get the topic names for each given conversation_id.
    /// Returns a map of conv_id → Vec<topic_name> (a conversation may be in multiple topics).
    pub fn get_topics_for_conversations(
        &self,
        conv_ids: &[String],
    ) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
        let mut out: std::collections::HashMap<String, Vec<String>> = Default::default();
        if conv_ids.is_empty() {
            return Ok(out);
        }
        let want: std::collections::HashSet<&str> = conv_ids.iter().map(|s| s.as_str()).collect();

        // Fetch all topic names keyed by id
        let topic_rows =
            self.run_q("?[id, name] := *kg_topic[id, name, _]")?;
        let mut topic_names: std::collections::HashMap<String, String> = Default::default();
        for row in &topic_rows.rows {
            if row.len() < 2 {
                continue;
            }
            topic_names.insert(dv_str(&row[0]), dv_str(&row[1]));
        }

        // Fetch all topic↔conv links, filter by wanted convs
        let link_rows =
            self.run_q("?[topic_id, conv_id] := *kg_topic_conv[topic_id, conv_id]")?;
        for row in &link_rows.rows {
            if row.len() < 2 {
                continue;
            }
            let topic_id = dv_str(&row[0]);
            let conv_id = dv_str(&row[1]);
            if want.contains(conv_id.as_str()) {
                if let Some(name) = topic_names.get(&topic_id) {
                    out.entry(conv_id).or_default().push(name.clone());
                }
            }
        }
        Ok(out)
    }

    /// Return file paths of conversations assigned to a specific topic.
    pub fn get_topic_conversation_paths(&self, topic_id: &str) -> Result<Vec<String>, String> {
        let mut p = BTreeMap::new();
        p.insert("tid".to_string(), DataValue::Str(topic_id.into()));
        let rows = self.run_query("?[conv_id] := *kg_topic_conv[tid, conv_id], tid = $tid", p)?;
        let mut paths = Vec::new();
        for row in &rows.rows {
            if !row.is_empty() {
                paths.push(dv_str(&row[0]));
            }
        }
        Ok(paths)
    }

    /// Build a graph using topics as hub nodes instead of providers.
    pub fn build_topic_graph(&self) -> Result<GraphData, String> {
        let mut nodes: Vec<GraphNode> = Vec::new();
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut seen_convs: std::collections::HashSet<String> = Default::default();

        // Fetch all topics
        let topic_rows =
            self.run_q("?[id, name, description] := *kg_topic[id, name, description]")?;
        if topic_rows.rows.is_empty() {
            return Ok(GraphData {
                nodes: vec![],
                edges: vec![],
            });
        }

        // Fetch all topic↔conversation assignments
        let assign_rows =
            self.run_q("?[topic_id, conv_id] := *kg_topic_conv[topic_id, conv_id]")?;

        // Build a map: topic_id → set of conv_ids
        let mut topic_convs: std::collections::HashMap<String, Vec<String>> = Default::default();
        for row in &assign_rows.rows {
            if row.len() < 2 {
                continue;
            }
            let topic_id = dv_str(&row[0]);
            let conv_id = dv_str(&row[1]);
            topic_convs.entry(topic_id).or_default().push(conv_id);
        }

        // Fetch conversation metadata from mentions
        let all_mentions = self.run_q(
            "?[conv_id, conv_title, file_path, platform] := *kg_mention[_, conv_id, _, conv_title, file_path, platform]"
        )?;
        let mut conv_meta: std::collections::HashMap<String, (String, String, String)> =
            Default::default();
        for row in &all_mentions.rows {
            if row.len() < 4 {
                continue;
            }
            let conv_id = dv_str(&row[0]);
            conv_meta
                .entry(conv_id)
                .or_insert_with(|| (dv_str(&row[1]), dv_str(&row[2]), dv_str(&row[3])));
        }

        // Phase lookup
        let mut phase_map: std::collections::HashMap<String, String> = Default::default();
        if let Ok(summaries) =
            self.run_q("?[conv_id, phase] := *kg_summary[conv_id, _, _, phase, _, _, _]")
        {
            for row in &summaries.rows {
                if row.len() < 2 {
                    continue;
                }
                let phase = dv_str(&row[1]);
                if !phase.is_empty() {
                    phase_map.insert(dv_str(&row[0]), phase);
                }
            }
        }

        // Create topic hub nodes and connect them to conversations
        for row in &topic_rows.rows {
            if row.len() < 3 {
                continue;
            }
            let topic_id = dv_str(&row[0]);
            let topic_name = dv_str(&row[1]);
            let topic_desc = dv_str(&row[2]);
            let topic_node_id = format!("topic:{}", topic_id);

            nodes.push(GraphNode {
                id: topic_node_id.clone(),
                name: topic_name,
                node_type: "topic".to_string(),
                frequency: None,
                file_path: None,
                platform: None,
                synonyms: None,
                neighbor_count: None,
                thread_count: None,
                entity_type: None,
                description: Some(topic_desc),
                phase: None,
            });

            if let Some(conv_ids) = topic_convs.get(&topic_id) {
                for conv_id in conv_ids {
                    // Create conversation node if not yet seen
                    if seen_convs.insert(conv_id.clone()) {
                        if let Some((title, file_path, platform)) = conv_meta.get(conv_id) {
                            nodes.push(GraphNode {
                                id: conv_id.clone(),
                                name: pretty_conv_title(title),
                                node_type: "conversation".to_string(),
                                frequency: None,
                                file_path: Some(file_path.clone()),
                                platform: Some(platform.clone()),
                                synonyms: None,
                                neighbor_count: None,
                                thread_count: None,
                                entity_type: None,
                                description: None,
                                phase: phase_map.get(conv_id).cloned(),
                            });
                        }
                    }
                    // Edge: topic → conversation
                    edges.push(GraphEdge {
                        source: topic_node_id.clone(),
                        target: conv_id.clone(),
                        relation: "belongs_to".to_string(),
                        weight: 1,
                    });
                }
            }
        }

        // Build conv-to-conv edges from shared topic membership
        let mut conv_topic_map: std::collections::HashMap<String, Vec<String>> = Default::default();
        for (topic_id, conv_ids) in &topic_convs {
            for conv_id in conv_ids {
                conv_topic_map
                    .entry(conv_id.clone())
                    .or_default()
                    .push(topic_id.clone());
            }
        }
        let conv_list: Vec<&String> = seen_convs.iter().collect();
        let mut conv_pair_seen: std::collections::HashSet<(String, String)> = Default::default();
        for i in 0..conv_list.len() {
            for j in (i + 1)..conv_list.len() {
                let a = conv_list[i];
                let b = conv_list[j];
                let topics_a = conv_topic_map.get(a).map(|v| v.as_slice()).unwrap_or(&[]);
                let topics_b = conv_topic_map.get(b).map(|v| v.as_slice()).unwrap_or(&[]);
                let shared: usize = topics_a.iter().filter(|t| topics_b.contains(t)).count();
                if shared > 0 {
                    let (ea, eb) = if a < b {
                        (a.clone(), b.clone())
                    } else {
                        (b.clone(), a.clone())
                    };
                    if conv_pair_seen.insert((ea.clone(), eb.clone())) {
                        edges.push(GraphEdge {
                            source: ea,
                            target: eb,
                            relation: "shared_keywords".to_string(),
                            weight: shared as i64,
                        });
                    }
                }
            }
        }

        Ok(GraphData { nodes, edges })
    }
}

fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}
