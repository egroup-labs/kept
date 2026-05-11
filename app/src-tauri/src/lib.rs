mod chat;
#[path = "kg-gen/mod.rs"]
mod kg_gen;
use crate::kg_gen::kggen::KgDatabase;
mod claude;
mod commands;
mod config;
mod db;
mod export;
mod models;
mod server;
mod state;
mod tools;
mod vault;

use commands::{CodeConsentState, DbState, GraphCacheState, KgState, TokenState};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn dump_kg_json() {
    let db_path = config::kg_db_path().expect("Could not determine KG database path");
    let db = KgDatabase::init(&db_path.to_string_lossy()).expect("Failed to open KG database");
    let graph = db.get_full_graph(300).expect("Failed to get graph");
    let stats = db.get_stats().expect("Failed to get stats");
    eprintln!(
        "Stats: entities={}, conversations={}, projects={}, triples={}",
        stats.entity_count, stats.conversation_count, stats.project_count, stats.triple_count
    );
    eprintln!(
        "Graph: {} nodes, {} edges",
        graph.nodes.len(),
        graph.edges.len()
    );
    println!("{}", serde_json::to_string_pretty(&graph).unwrap());
}
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, UserAttentionType,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    // Check if this is a fresh install (no token file yet)
    let _is_first_run = config::token_path().map(|p| !p.exists()).unwrap_or(true);

    // Initialize ~/.kept/ directory structure
    if let Err(e) = config::init_kept_dirs() {
        eprintln!("Failed to initialize Kept directories: {}", e);
    }

    // Initialize SQLite database (single instance shared between Tauri and HTTP server)
    let database: Option<Arc<db::Database>> = match db::Database::init() {
        Ok(db) => Some(Arc::new(db)),
        Err(e) => {
            eprintln!("Failed to initialize database: {}", e);
            None
        }
    };

    // Reindex vault in the background so the DB is always in sync with files on disk.
    // This is cheap for unchanged vaults (skipped by content hash) and ensures
    // externally-edited files (e.g. via Obsidian) are picked up.
    if let Some(ref db) = database {
        let db_clone = Arc::clone(db);
        std::thread::spawn(move || match commands::reindex_vault(&db_clone) {
            Ok(msg) => log::info!("Startup reindex: {}", msg),
            Err(e) => eprintln!("Startup reindex failed: {}", e),
        });
    }

    // Initialize KG (CozoDB) database
    let kg_db_path = config::kg_db_path().unwrap_or_else(|e| {
        eprintln!("Failed to determine KG database path: {}", e);
        std::path::PathBuf::from(".kept/kg.db")
    });
    let kg_database = match KgDatabase::init(&kg_db_path.to_string_lossy()) {
        Ok(kg) => Some(kg),
        Err(e) => {
            eprintln!("Failed to initialize KG database: {}", e);
            None
        }
    };

    // Read auth token for the HTTP server
    let token = config::read_token().unwrap_or_default();
    let updater_token = token.clone();
    let token_state = Arc::new(Mutex::new(token));

    // Share a single KG database instance between Tauri commands and the HTTP server
    let kg_arc: Option<Arc<KgDatabase>> = kg_database.map(Arc::new);

    let server_token = Arc::clone(&token_state);
    let server_db = database.clone();
    let server_kg = kg_arc.clone();
    let digest_db = database.clone();
    let digest_kg = kg_arc.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_opener::init())
        .plugin({
            let mut builder = tauri_plugin_updater::Builder::new();
            if !updater_token.is_empty() {
                builder = builder
                    .header("Authorization", format!("Bearer {}", updater_token))
                    .expect("Failed to set updater auth header");
            }
            builder.build()
        })
        .plugin(tauri_plugin_process::init())
        .manage(DbState(Mutex::new(database)))
        .manage(KgState(Mutex::new(kg_arc)))
        .manage(GraphCacheState(Mutex::new(HashMap::new())))
        .manage(TokenState(token_state))
        .manage(CodeConsentState(Arc::new(Mutex::new(HashMap::new()))))
        .manage(commands::AgentCancelState(Mutex::new(HashMap::new())))
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let server_token = Arc::clone(&server_token);
            let server_db = server_db.clone();
            let server_kg = server_kg.clone();

            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(async {
                    let db = match server_db {
                        Some(db) => db,
                        None => {
                            eprintln!("Cannot start HTTP server: database not initialized");
                            return;
                        }
                    };
                    if let Err(e) =
                        server::start_server(app_handle, db, server_kg, server_token).await
                    {
                        eprintln!("HTTP server error: {}", e);
                    }
                });
            });

            // Digest workers: (1) periodic idle summarizer — runs every 60s,
            // finds conversations inactive 5+ min and summarizes them (status='pending').
            // (2) startup batch promoter — flips pending→active if the configurable
            // interval has elapsed since the last promotion.
            let worker_db = digest_db.clone();
            let worker_kg = digest_kg.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(10));
                let db = match worker_db { Some(d) => d, None => return };
                let kg = match worker_kg { Some(k) => k, None => return };

                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("Digest workers: failed to create runtime: {}", e);
                        return;
                    }
                };

                rt.block_on(async {
                    // Startup batch promotion (gated by interval)
                    match commands::run_digest_batch_promotion(db.clone(), kg.clone()).await {
                        Ok((ran, n)) if ran => log::info!("Digest startup promotion: {} items", n),
                        Ok(_) => log::info!("Digest startup promotion: skipped (interval gate)"),
                        Err(e) => log::warn!("Digest startup promotion failed: {}", e),
                    }

                    // Periodic idle summarizer — forever (until process exit).
                    //
                    // Circuit breaker: when consecutive ticks come back
                    // dominated by 429 rate-limit errors, the loop is paused
                    // for an hour. Without this, a user on a low-tier API key
                    // (Anthropic tier 1 = 30K input TPM) gets their key billed
                    // every minute even though most calls fail — every call
                    // that *does* sneak past the rate limit is a real billed
                    // request, and we've seen this drain a $25 cap overnight.
                    const RATE_LIMIT_STREAK_LIMIT: u32 = 3;
                    const RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60 * 60);
                    let mut rate_limit_streak: u32 = 0;
                    let mut cooldown_until: Option<std::time::Instant> = None;
                    loop {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        if let Some(until) = cooldown_until {
                            if std::time::Instant::now() < until {
                                continue;
                            }
                            log::info!("Idle summarizer: rate-limit cooldown elapsed, resuming");
                            cooldown_until = None;
                            rate_limit_streak = 0;
                        }
                        match commands::run_idle_summarizer(db.clone(), kg.clone()).await {
                            Ok(stats) => {
                                let attempted = stats.ok
                                    + stats.rate_limited
                                    + stats.other_failed
                                    + stats.skipped;
                                if attempted == 0 {
                                    rate_limit_streak = 0;
                                } else if stats.rate_limited > 0 && stats.ok == 0 {
                                    rate_limit_streak += 1;
                                    log::warn!(
                                        "Idle summarizer: tick rate-limited \
                                         ({} rl / {} other / {} skipped), streak {}/{}",
                                        stats.rate_limited,
                                        stats.other_failed,
                                        stats.skipped,
                                        rate_limit_streak,
                                        RATE_LIMIT_STREAK_LIMIT
                                    );
                                    if rate_limit_streak >= RATE_LIMIT_STREAK_LIMIT {
                                        log::warn!(
                                            "Idle summarizer: pausing for {}s after \
                                             {} consecutive rate-limited ticks",
                                            RATE_LIMIT_COOLDOWN.as_secs(),
                                            rate_limit_streak
                                        );
                                        cooldown_until =
                                            Some(std::time::Instant::now() + RATE_LIMIT_COOLDOWN);
                                    }
                                } else {
                                    if stats.ok > 0 || stats.skipped > 0 {
                                        log::info!(
                                            "Idle summarizer: ok={} rl={} other={} skipped={}",
                                            stats.ok,
                                            stats.rate_limited,
                                            stats.other_failed,
                                            stats.skipped
                                        );
                                    }
                                    rate_limit_streak = 0;
                                }
                            }
                            Err(e) => log::warn!("Idle summarizer tick failed: {}", e),
                        }
                    }
                });
            });

            // Disable WebKitGTK content dragging by injecting a capture-phase
            // dragstart blocker before any page JS runs.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(
                    "document.addEventListener('dragstart',function(e){if(e.target.closest('[data-drag-handle]'))return;e.preventDefault();},true);\
                     document.addEventListener('drag',function(e){if(e.target.closest('[data-drag-handle]'))return;e.preventDefault();},true);",
                );
            }

            // Surface the window explicitly on launch. Without this, some WMs keep
            // the freshly created transparent frameless window behind other apps.
            let startup_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(60));
                if let Some(window) = startup_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
                    let _ = window.set_always_on_top(true);
                    std::thread::sleep(Duration::from_millis(420));
                    let _ = window.set_always_on_top(false);
                    let _ = window.request_user_attention(None);
                    let _ = window.set_focus();
                }
            });

            // System tray
            let show = MenuItemBuilder::with_id("show", "Show Kept").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            TrayIconBuilder::new()
                .tooltip("Kept")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_vault_tree,
            commands::cmd_get_conversation,
            commands::cmd_list_conversations,
            commands::cmd_search,
            commands::cmd_reindex,
            commands::cmd_get_token,
            commands::cmd_extension_status,
            commands::cmd_extension_zip,
            commands::cmd_request_extension_sync,
            commands::cmd_stop_extension_sync,
            commands::cmd_refresh_token,
            commands::cmd_get_config,
            commands::cmd_set_config,
            commands::cmd_vault_path,
            commands::cmd_export_validate,
            commands::cmd_export_to_obsidian,
            commands::cmd_clipboard_text,
            commands::cmd_read_file_base64,
            commands::cmd_kb_add_paths,
            commands::cmd_kb_remove_path,
            commands::cmd_kb_list_files,
            commands::cmd_kb_read_file,
            commands::cmd_kb_search,
            commands::cmd_kb_grep,
            commands::cmd_vault_stats,
            commands::cmd_open_vault,
            commands::cmd_migrate_downloads,
            commands::cmd_kg_reset_db,
            commands::cmd_kg_summary,
            commands::cmd_kg_stats,
            commands::cmd_kg_get_graph,
            commands::cmd_kg_search,
            commands::cmd_kg_get_neighbors,
            commands::cmd_kg_index_vault,
            commands::cmd_kg_extract_keywords,
            commands::cmd_kg_discover_topics,
            commands::cmd_kg_get_topics,
            commands::cmd_kg_get_topic_conversations,
            commands::cmd_kg_classify_new_conversations,
            commands::cmd_kg_get_topic_graph,
            commands::cmd_kg_get_projects,
            commands::cmd_delete_conversation,
            commands::cmd_rename_conversation,
            commands::cmd_kg_create_project,
            commands::cmd_kg_link_conversation,
            commands::cmd_kg_unlink_conversation,
            commands::cmd_kg_update_project,
            commands::cmd_kg_delete_project,
            chat::cmd_suggest_project_conversations,
            commands::cmd_generate_digest,
            commands::cmd_get_digest_items,
            commands::cmd_update_digest_item,
            commands::cmd_bulk_update_digest_items,
            commands::cmd_refresh_digest,
            commands::cmd_get_suggested_projects,
            commands::cmd_create_project_from_digest,
            commands::cmd_link_conversation_to_project,
            commands::cmd_create_project_with_conversation,
            commands::cmd_mark_digest_items_seen,
            commands::cmd_trigger_digest_auto_pass,
            chat::cmd_agent_chat,
            chat::cmd_agent_cancel,
            chat::cmd_generate_title,
            chat::cmd_save_kept_chat,
            commands::cmd_claude_scan_projects,
            commands::cmd_claude_get_scan_config,
            commands::cmd_claude_set_scan_config,
            commands::cmd_claude_read_instructions,
            commands::cmd_claude_list_skills,
            commands::cmd_claude_list_memory,
            commands::cmd_claude_read_settings,
            commands::cmd_claude_write_file,
            commands::cmd_claude_delete_skill,
            commands::cmd_claude_scan_all_skills,
            commands::cmd_claude_scan_all_memory,
            commands::cmd_claude_copy_file,
            commands::cmd_claude_diff_file,
            commands::cmd_claude_get_templates,
            commands::cmd_claude_set_templates,
            commands::cmd_list_models,
            commands::cmd_check_providers,
            commands::cmd_clear_vault,
            commands::cmd_reveal_file,
            commands::cmd_validate_path,
            commands::cmd_respond_code_consent,
            commands::cmd_idle_summarizer_status,
            commands::cmd_resume_idle_summarizer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
