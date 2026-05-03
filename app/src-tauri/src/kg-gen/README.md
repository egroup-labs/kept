# kg-gen — Knowledge Graph Module

The `kg-gen` module builds, stores, and queries a local knowledge graph derived from
the Kept vault. Each conversation is parsed by an LLM, which extracts named entities
and relationships. These are deduplicated via embedding-based similarity and stored in
a CozoDB (sled backend) database at `~/.kept/kg.db/`.

---

## Files

| File | Purpose |
|---|---|
| `mod.rs` | Re-exports the three sub-modules |
| `kggen.rs` | `KgDatabase` struct — all DB read/write logic |
| `triplets.rs` | Entity name normalisation and stable ID derivation |
| `embedder.rs` | Ollama embedding API client + cosine similarity |

---

## Architecture

```
Vault files (Markdown)
        │
        ▼
cmd_kg_index_vault (commands.rs)
  │  reads vault tree
  │  per conversation:
  │    1. split into ≤2000-char chunks (up to 8000 chars total)
  │    2. LLM extraction → entities + triples
  │    3. per entity: get embedding → deduplicate → upsert
  │    4. upsert triples + mention records
  │  emits kg_index_progress / kg_index_log Tauri events
        │
        ▼
KgDatabase (kggen.rs)  ←→  CozoDB sled DB (~/.kept/kg.db/)
        │
        ▼
Tauri commands → frontend D3 graph
```

---

## Database Schema

Four stored relations in CozoDB:

```
kg_entity  { id: String => name: String, frequency: Int, embedding: String }
kg_synonym { entity_id: String, synonym: String }
kg_triple  { from_id: String, rel: String, to_id: String => weight: Int }
kg_mention { entity_id: String, conv_id: String => mention_count: Int,
             conv_title: String, file_path: String, platform: String }
```

**Notes:**
- `kg_entity.id` is a normalized stable key (e.g. `machine_learning`), not a UUID.
  Multiple surface forms (e.g. "Machine Learning", "ML") can map to the same id
  via synonym records.
- `kg_entity.embedding` stores the Ollama embedding as a JSON-encoded `Vec<f64>`
  string column. CozoDB does not have a native vector type.
- `kg_triple` uses the column name `rel` instead of `relation` because `relation` is
  a reserved word in CozoScript.
- `kg_triple.weight` and `kg_mention.mention_count` are incremented on every upsert,
  giving a co-occurrence frequency signal.
- The schema is created idempotently at startup; "already exists" DDL errors are
  silently ignored.
- A health-check query is run after DDL to detect corrupt databases; a corrupt DB is
  automatically wiped and reinitialized.

---

## Entity ID + Normalization (`triplets.rs`)

Two pure functions:

### `normalize_entity_name(name: &str) -> String`
Lowercases the name, replaces all non-alphanumeric characters with spaces, and
collapses consecutive whitespace.

```
"React.js"  →  "react js"
"GPT-4"     →  "gpt 4"
"TypeScript" →  "typescript"
```

### `entity_id_from_name(normalized: &str) -> String`
Converts a normalized name to a stable storage key by replacing spaces with
underscores and stripping anything not alphanumeric or `_`.

```
"machine learning"  →  "machine_learning"
"react js"          →  "react_js"
"gpt 4"             →  "gpt_4"
```

These two functions together produce a stable, human-readable primary key that
survives minor surface-form variations.

---

## Embedding + Deduplication (`embedder.rs`)

### `get_embedding(text, ollama_url, embed_model) -> Result<Vec<f64>>`
POST to `{ollama_url}/api/embeddings` with `{"model": model, "prompt": text}`.
Default model: `qwen3-embedding:0.6b` (configurable via `AppConfig.ollama_embed_model`).
Returns the raw `embedding` vector from the Ollama response.

### `cosine_similarity(a: &[f64], b: &[f64]) -> f64`
Standard dot-product / (‖a‖ · ‖b‖). Returns 0.0 on length mismatch or zero norms.

### `find_similar_entity(new_embedding, existing, threshold) -> Option<String>`
Scans `existing: &[(entity_id, embedding)]` and returns the `entity_id` with the
highest cosine similarity ≥ `threshold`. If no entry exceeds the threshold, returns
`None` (the entity is new).

**Deduplication flow during indexing:**
1. Fetch all existing entity embeddings from the DB once before the indexing loop.
2. For each newly extracted entity:
   - Get its embedding from Ollama.
   - Call `find_similar_entity` against the in-memory cache.
   - If a match is found: record the new surface form as a synonym; increment the
     canonical entity's frequency.
   - If no match: insert as a new entity; add its embedding to the in-memory cache
     so subsequent entities in the same batch can match it.
3. If embedding is unavailable (Ollama not running, network error): fall back to
   inserting without deduplication (empty embedding stored as placeholder).

The default merge threshold is **0.95** (very strict). Users can lower it in the
Knowledge Graph panel to merge more aggressively.

---

## KgDatabase (`kggen.rs`)

### Initialization

```rust
KgDatabase::init(db_path: &str) -> Result<Self, String>
```

Opens (or creates) the sled database. Automatic recovery strategy:
1. If `DbInstance::new` fails (corrupt sled files) → wipe directory, reopen fresh.
2. If `init_schema` fails (corrupt table metadata) → wipe directory, reopen fresh.
3. Run health-check queries on all four tables to verify usability before returning.

### Write methods

| Method | Description |
|---|---|
| `clear_all()` | Delete all rows from all four tables (used by force re-index) |
| `upsert_entity(id, name, embedding)` | Insert or update entity, incrementing frequency |
| `add_synonym(canonical_id, synonym)` | Record an alternate surface form |
| `upsert_triple(from_id, relation, to_id)` | Insert or update a directed relationship, incrementing weight |
| `upsert_mention(entity_id, conv_id, title, file_path, platform)` | Record that an entity was mentioned in a conversation |

All upserts read the current value first (frequency / weight / count) and write
`current + 1`. CozoDB's `:put` semantics replace the value column on key collision,
so this manual increment is required.

### Read methods

| Method | Description |
|---|---|
| `is_conv_indexed(conv_id)` | Returns true if any mention row exists for this conversation |
| `get_all_entity_embeddings()` | Returns `Vec<(entity_id, Vec<f64>)>` for all entities that have a stored embedding |
| `get_stats()` | Returns entity/triple/conversation counts + top-10 entities by frequency |
| `get_full_graph(limit)` | Top-`limit` entities by frequency + all triples between them + their conversation mentions |
| `search_subgraph(keywords, query_embedding, emb_threshold, limit)` | Hybrid text+embedding search, returns matching entity subgraph |
| `get_node_neighbors(node_id)` | One-hop expansion: all nodes directly connected to a given entity or conversation node |

### Internal helpers

| Helper | Description |
|---|---|
| `get_synonyms_map()` | Full scan of `kg_synonym`; returns `HashMap<entity_id, Vec<String>>` |
| `get_neighbor_counts()` | Full scan of `kg_triple`; returns distinct entity-neighbor count per entity |
| `get_thread_counts()` | Full scan of `kg_mention`; returns distinct conversation count per entity |
| `build_subgraph(ids, rows)` | Given a set of entity IDs + their DB rows, assembles the `GraphData` result including triples between them and their conversation nodes |
| `pretty_conv_title(raw)` | Strips `YYYY-MM-DD_` date prefix and `.md` extension from vault filenames to produce a readable display title |
| `esc(s)` | Escapes `\`, `"`, and newlines for safe inline CozoScript string literals |
| `dv_str(v)` | Decodes a `DataValue` to `String`, handling both plain-string and `{"Str": "..."}` tagged forms |
| `dv_i64(v)` | Decodes a `DataValue` to `i64`, handling `{"Num": {"Int": n}}` and other CozoDB 0.7.6 numeric forms |
| `dv_embedding(v)` | Decodes a `DataValue` embedding column (JSON string) to `Vec<f64>` |

### Hybrid search

`search_subgraph` scores entities by combining two signals:

```
score = (keyword_hits × 2.0) + cosine_similarity(query_embedding, stored_embedding)
```

- **keyword_hits**: number of whitespace/comma-split query tokens that appear as
  substrings of the entity's normalized ID. The entity ID is already lowercase, so
  this is case-insensitive by construction.
- **cosine_similarity**: similarity between the Ollama embedding of the full query
  string and the stored entity embedding. Only entities above `emb_threshold` (default
  0.70) contribute via this signal.
- Text hits are weighted 2× to ensure direct keyword matches rank above pure
  semantic neighbours.
- If Ollama is unavailable, the embedding is empty and search falls back to
  text-only.

### CozoDB quirks and workarounds

- **`:order` sort bug**: CozoDB 0.7.6 panics in `sort.rs` when sorting result rows
  whose column count doesn't match the stored relation's arity. All sorting is done
  in Rust after fetching unsorted results.
- **Multi-rule newlines**: Rust `\` line continuation strips newlines, breaking
  CozoDB's multi-rule query syntax. Affected queries are split into separate
  `run_query` calls (e.g. forward and backward triple traversal).
- **Parameter binding on non-first compound keys**: CozoDB's `$param` binding is
  unreliable when the bound column is not the first key column of a stored relation.
  Affected queries use inline escaped string literals instead.
- **`DataValue` serialization**: The Rust SDK serializes `DataValue` as
  `{"Str": "value"}` or `{"Num": {"Int": n}}` depending on context. `dv_str` and
  `dv_i64` handle both the tagged-object form and the plain JSON scalar form.

---

## Tauri Commands (in `commands.rs`)

| Command | Signature | Description |
|---|---|---|
| `cmd_kg_index_vault` | `(force_reindex?, ollama_model?, merge_threshold?, provider?) → String` | Index all vault conversations; emits `kg_index_progress` and `kg_index_log` events |
| `cmd_kg_get_graph` | `(limit?) → GraphData` | Full graph: top entities by frequency |
| `cmd_kg_search` | `(query, limit?) → GraphData` | Hybrid text+embedding subgraph search |
| `cmd_kg_get_neighbors` | `(node_id) → GraphData` | One-hop neighborhood expansion |
| `cmd_kg_stats` | `() → KgStats` | Entity/triple/conversation counts + top entities |
| `cmd_kg_summary` | `() → String` | Human-readable stats text |
| `cmd_kg_reset_db` | `() → String` | Wipe and reinitialize the KG database |

### Indexing pipeline (per conversation)

1. Read vault tree; collect all `(platform, title, file_path)` tuples.
2. Emit `kg_index_progress { current, total, title, status: "extracting" }`.
3. Read the conversation Markdown file.
4. In incremental mode (`force_reindex = false`): check `is_conv_indexed`; skip if
   already indexed, emit `status: "skipped"`.
5. Parse frontmatter for a display title; fall back to cleaned filename.
6. Split the first 8000 characters into ≤2000-char chunks.
7. For each chunk: call the LLM extraction function for the selected provider
   (`call_ollama_extract`, `call_openai_extract`, or `call_anthropic_extract`).
   Expected JSON response: `{"entities": [...], "relationships": [{from, relation, to}]}`.
8. Deduplicate entity names (case-insensitive) and triple tuples across chunks.
9. For each entity: embed → deduplicate against in-memory cache → upsert.
10. For each triple: normalize both endpoint names to canonical IDs → upsert.
11. For each entity: upsert mention record linking it to this conversation.

### LLM providers

The indexing command accepts a `provider` parameter:

| Provider | Function | Auth |
|---|---|---|
| `ollama` (default) | `call_ollama_extract` | None (local HTTP) |
| `openai` | `call_openai_extract` | `AppConfig.openai_api_key` |
| `anthropic` | `call_anthropic_extract` | `AppConfig.anthropic_api_key` |

All three functions send the same structured extraction prompt and parse a JSON
response of the form `{"entities": [...], "relationships": [...]}`. Non-JSON or
partial responses are handled gracefully — the chunk is skipped with a warning log.

---

## GraphData types (in `models.rs`)

```rust
GraphNode {
    id: String,
    name: String,
    node_type: String,      // "entity" | "conversation"
    frequency: Option<i64>, // entity only — how many times extracted
    file_path: Option<String>, // conversation only
    platform: Option<String>,  // conversation only
    synonyms: Option<Vec<String>>, // entity only — alternate surface forms
    neighbor_count: Option<i64>,   // entity only — distinct entity neighbors
    thread_count: Option<i64>,     // entity only — distinct conversations mentioning it
}

GraphEdge {
    source: String,
    target: String,
    relation: String, // e.g. "used_for", "mentioned_in"
    weight: i64,      // co-occurrence count
}

GraphData { nodes: Vec<GraphNode>, edges: Vec<GraphEdge> }
```

Conversation → entity edges use the synthetic relation `"mentioned_in"` with weight 1.

---

## Configuration (`AppConfig` fields)

| Field | Default | Description |
|---|---|---|
| `ollama_model` | `"qwen3-vl:2b"` | Chat model used for entity extraction |
| `ollama_embed_model` | `"qwen3-embedding:0.6b"` | Embedding model used for deduplication and search |

Both are overridable from the Knowledge Graph panel's provider/model dropdowns.
The merge threshold (0.80–1.00) is also configurable per-session from that panel.
