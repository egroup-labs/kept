import type { ConversationMeta, VaultNode, SearchResult, AppConfig, TitleRequest, AgentChatRequest, AgentChatResponse, GraphData, KgStats, ProjectData, ExtensionStatus, DigestData, ConversationKeywords, Topic, ClaudeProject, ClaudeFile, ClaudeSkill, ClaudeScanConfig, ClaudeSkillWithProject, ClaudeFileWithProject, ClaudeTemplate, IngestPayload, ProviderStatus, AvailableModel, KbFileEntry, SuggestProjectResponse, ObsidianValidation, ObsidianExportResult } from './types';
import {
  MOCK_VAULT_TREE,
  MOCK_CONVERSATION,
  MOCK_SEARCH_RESULTS,
  MOCK_TOKEN,
  MOCK_CONFIG,
  MOCK_VAULT_PATH,
} from './mock-data';

// Detect if running inside Tauri
export const isTauri = !!(window as any).__TAURI_INTERNALS__;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  }
  // Mock fallback for browser dev
  return mockInvoke(cmd, args) as T;
}

// ── Seeded PRNG for deterministic mock graphs ──
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateMockGraph(): GraphData {
  const rand = mulberry32(42);

  const PLATFORMS = ['chatgpt', 'claude', 'gemini'] as const;

  // Topic clusters — conversations are grouped by shared topics
  const clusters = [
    { theme: 'Machine Learning', count: 8 },
    { theme: 'Distributed Systems', count: 6 },
    { theme: 'Compiler Design', count: 5 },
    { theme: 'Cryptography', count: 5 },
    { theme: 'UI Framework', count: 6 },
    { theme: 'Database Internals', count: 5 },
    { theme: 'Networking', count: 4 },
    { theme: 'Graphics Pipeline', count: 4 },
    { theme: 'Natural Language', count: 5 },
    { theme: 'Computer Vision', count: 4 },
  ];

  const WORDS_A = ['Adaptive', 'Batched', 'Concurrent', 'Dynamic', 'Elastic', 'Federated', 'Generative', 'Hierarchical',
    'Incremental', 'Joint', 'Kernel', 'Lazy', 'Memoized', 'Nested', 'Optimized', 'Parallel', 'Quantized', 'Recursive',
    'Streaming', 'Topological'];
  const WORDS_B = ['aggregation', 'allocation', 'bundling', 'caching', 'decomposition', 'encoding', 'factorization',
    'gradient', 'hashing', 'indexing', 'joining', 'linking', 'mapping', 'normalization', 'ordering', 'partitioning',
    'querying', 'traversal'];

  function pickTitle(theme: string): string {
    const a = WORDS_A[Math.floor(rand() * WORDS_A.length)];
    const b = WORDS_B[Math.floor(rand() * WORDS_B.length)];
    return `${theme}: ${a} ${b}`;
  }

  const nodes: GraphData['nodes'] = [];
  const edges: GraphData['edges'] = [];
  const clusterConvIds: string[][] = [];

  // Generate conversation nodes per cluster
  let convIdx = 0;
  for (const cluster of clusters) {
    const ids: string[] = [];
    for (let i = 0; i < cluster.count; i++) {
      const id = `conv-${convIdx}`;
      const platform = PLATFORMS[Math.floor(rand() * PLATFORMS.length)];
      nodes.push({
        id,
        name: pickTitle(cluster.theme),
        node_type: 'conversation',
        file_path: `/mock/conv-${convIdx}.md`,
        platform,
      });
      ids.push(id);
      convIdx++;
    }
    clusterConvIds.push(ids);
  }

  // Intra-cluster conv-to-conv edges (shared topics within a theme)
  for (const ids of clusterConvIds) {
    const edgeCount = Math.floor(ids.length * 1.5);
    for (let i = 0; i < edgeCount; i++) {
      const a = ids[Math.floor(rand() * ids.length)];
      const b = ids[Math.floor(rand() * ids.length)];
      if (a !== b && a < b) {
        edges.push({
          source: a, target: b,
          relation: 'shared_topics',
          weight: 1 + Math.floor(rand() * 4),
        });
      }
    }
  }

  // Inter-cluster bridges (conversations that span topics)
  for (let ci = 0; ci < clusterConvIds.length; ci++) {
    for (let cj = ci + 1; cj < clusterConvIds.length; cj++) {
      const bridgeCount = 1 + Math.floor(rand() * 3);
      for (let b = 0; b < bridgeCount; b++) {
        const a = clusterConvIds[ci][Math.floor(rand() * clusterConvIds[ci].length)];
        const t = clusterConvIds[cj][Math.floor(rand() * clusterConvIds[cj].length)];
        if (a < t) {
          edges.push({ source: a, target: t, relation: 'shared_topics', weight: 1 });
        } else {
          edges.push({ source: t, target: a, relation: 'shared_topics', weight: 1 });
        }
      }
    }
  }

  // Add provider nodes
  const platformSet = new Set<string>();
  for (const n of nodes) if (n.platform) platformSet.add(n.platform);
  for (const platform of platformSet) {
    const providerId = `provider:${platform}`;
    const prettyName = platform === 'chatgpt' ? 'ChatGPT' : platform === 'claude' ? 'Claude' : 'Gemini';
    nodes.push({
      id: providerId, name: prettyName,
      node_type: 'provider', platform,
    });
    for (const n of nodes) {
      if (n.node_type === 'conversation' && n.platform === platform) {
        edges.push({
          source: providerId, target: n.id,
          relation: 'hosts', weight: 1,
        });
      }
    }
  }

  // Update neighbor_count based on actual edge connections
  const neighborMap = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!neighborMap.has(e.source)) neighborMap.set(e.source, new Set());
    if (!neighborMap.has(e.target)) neighborMap.set(e.target, new Set());
    neighborMap.get(e.source)!.add(e.target);
    neighborMap.get(e.target)!.add(e.source);
  }
  for (const n of nodes) {
    n.neighbor_count = neighborMap.get(n.id)?.size ?? 0;
  }

  return { nodes, edges };
}

function generateMockTopicGraph(): GraphData {
  const rand = mulberry32(99);
  const graph = generateMockGraph();

  // Remove provider nodes and "hosts" edges
  const convNodes = graph.nodes.filter(n => n.node_type === 'conversation');
  const convEdges = graph.edges.filter(e => e.relation === 'shared_topics');

  // Create topic hub nodes
  const topics = [
    { id: 'topic:machine-learning', name: 'Machine Learning' },
    { id: 'topic:distributed-systems', name: 'Distributed Systems' },
    { id: 'topic:compiler-design', name: 'Compiler Design' },
    { id: 'topic:cryptography', name: 'Cryptography' },
    { id: 'topic:ui-frameworks', name: 'UI Frameworks' },
    { id: 'topic:databases', name: 'Database Internals' },
    { id: 'topic:networking', name: 'Networking' },
    { id: 'topic:graphics', name: 'Graphics Pipeline' },
    { id: 'topic:nlp', name: 'Natural Language Processing' },
    { id: 'topic:computer-vision', name: 'Computer Vision' },
  ];

  const topicNodes: GraphData['nodes'] = topics.map(t => ({
    id: t.id,
    name: t.name,
    node_type: 'topic',
    description: `Conversations about ${t.name.toLowerCase()}.`,
  }));

  const topicEdges: GraphData['edges'] = [];
  // Assign each conversation to 1-2 topics
  for (const conv of convNodes) {
    const primaryTopic = topics[Math.floor(rand() * topics.length)];
    topicEdges.push({
      source: primaryTopic.id,
      target: conv.id,
      relation: 'belongs_to',
      weight: 1,
    });
    if (rand() > 0.6) {
      const secondTopic = topics[Math.floor(rand() * topics.length)];
      if (secondTopic.id !== primaryTopic.id) {
        topicEdges.push({
          source: secondTopic.id,
          target: conv.id,
          relation: 'belongs_to',
          weight: 1,
        });
      }
    }
  }

  const allNodes = [...convNodes, ...topicNodes];
  const allEdges = [...convEdges, ...topicEdges];

  // Update neighbor counts
  const neighborMap = new Map<string, Set<string>>();
  for (const e of allEdges) {
    if (!neighborMap.has(e.source)) neighborMap.set(e.source, new Set());
    if (!neighborMap.has(e.target)) neighborMap.set(e.target, new Set());
    neighborMap.get(e.source)!.add(e.target);
    neighborMap.get(e.target)!.add(e.source);
  }
  for (const n of allNodes) {
    n.neighbor_count = neighborMap.get(n.id)?.size ?? 0;
  }

  return { nodes: allNodes, edges: allEdges };
}

function generateMockStats(): KgStats {
  const graph = generateMockGraph();
  const convNodes = graph.nodes.filter(n => n.node_type === 'conversation');
  const providerNodes = graph.nodes.filter(n => n.node_type === 'provider');
  // Use conversations sorted by connection count as "top entities"
  const sorted = [...convNodes].sort((a, b) => (b.neighbor_count ?? 0) - (a.neighbor_count ?? 0));
  const topEntities: [string, number][] = sorted.slice(0, 10).map(n => [n.name, n.neighbor_count ?? 0]);
  return {
    entity_count: providerNodes.length,
    triple_count: graph.edges.filter(e => e.relation === 'shared_topics').length,
    conversation_count: convNodes.length,
    project_count: 4,
    top_entities: topEntities,
  };
}

function mockInvoke(cmd: string, _args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'cmd_vault_tree': return MOCK_VAULT_TREE;
    case 'cmd_get_conversation': return MOCK_CONVERSATION;
    case 'cmd_list_conversations': return [];
    case 'cmd_kg_summary': return 'Nodes: 128\nEdges: 342\nClusters: 7\n(mock summary)';
    case 'cmd_search': return MOCK_SEARCH_RESULTS;
    case 'cmd_reindex': return 'Reindexed 8 conversations.';
    case 'cmd_clear_vault': return 'Cleared 8 conversations';
    case 'cmd_get_token': return MOCK_TOKEN;
    case 'cmd_extension_status': return { connected: false, last_seen_ms: null };
    case 'cmd_extension_zip': return '~/.kept/kept-extension.zip';
    case 'cmd_request_extension_sync': return undefined;
    case 'cmd_stop_extension_sync': return undefined;
    case 'cmd_clipboard_text': return '';
    case 'cmd_kb_add_paths': return [];
    case 'cmd_kb_remove_path': return undefined;
    case 'cmd_kb_list_files': return [];
    case 'cmd_kb_read_file': return '';
    case 'cmd_read_file_base64': return 'iVBORw0KGgo=';
    case 'cmd_kb_search': return '';
    case 'cmd_kb_grep': return '';
    case 'cmd_refresh_token': return 'Opened connection page. (mock)';
    case 'cmd_get_config': return MOCK_CONFIG;
    case 'cmd_set_config': return undefined;
    case 'cmd_validate_path': return true;
    case 'cmd_vault_path': return MOCK_VAULT_PATH;
    case 'cmd_open_vault': return undefined;
    case 'cmd_vault_stats': return {
      conversations_bytes: 14_680_064,
      assets_bytes: 52_428_800,
      database_bytes: 3_145_728,
      kg_bytes: 8_388_608,
      conversation_count: 247,
      asset_count: 89,
    };
    case 'cmd_generate_title': return 'Mock Chat Title';
    case 'cmd_agent_chat': return {
      content: 'I\'m Kept, your conversation archivist. This is a mock response — the agent requires the Tauri backend and an API key configured in Settings.',
      tool_executions: [],
      iterations: 1,
    };
    case 'cmd_save_kept_chat': return '/mock/vault/kept/2026-03-10_mock-chat.md';
    case 'cmd_respond_code_consent': return undefined;
    case 'cmd_migrate_downloads': return 'Migrated 0 files (mock).';
    case 'cmd_kg_stats': return generateMockStats();
    case 'cmd_kg_get_graph': return generateMockGraph();
    case 'cmd_kg_search': return {
      nodes: [
        { id: 'conv-bn', name: 'BN Inference Tensor Network', node_type: 'conversation', file_path: '/mock/bn-inference-tensor-network.md', platform: 'chatgpt' },
        { id: 'conv-tensor', name: 'Tensor Decomposition Methods', node_type: 'conversation', file_path: '/mock/tensor-decomposition.md', platform: 'claude' },
        { id: 'provider:chatgpt', name: 'ChatGPT', node_type: 'provider', platform: 'chatgpt' },
        { id: 'provider:claude', name: 'Claude', node_type: 'provider', platform: 'claude' },
      ],
      edges: [
        { source: 'conv-bn', target: 'conv-tensor', relation: 'shared_topics', weight: 3 },
        { source: 'provider:chatgpt', target: 'conv-bn', relation: 'hosts', weight: 1 },
        { source: 'provider:claude', target: 'conv-tensor', relation: 'hosts', weight: 1 },
      ],
    };

    case 'cmd_kg_index_vault': return _args?.forceReindex
      ? 'KG cleared. (mock)'
      : 'Indexed 50 conversations: 9 topics, 54 links, 325 entities, 2600 mentions. (mock)';
    case 'cmd_kg_extract_keywords': return [
      {
        conv_id: '/mock/adam-trading.md',
        title: 'Adam Trading Algorithm Design',
        platform: 'claude',
        keywords: [
          { term: 'adam', source: 'title', count: 3, tfidf: 4.2 },
          { term: 'trading algorithm', source: 'title', count: 1, tfidf: 3.8 },
          { term: 'backtesting', source: 'user_message', count: 2, tfidf: 3.5 },
          { term: 'optimizer', source: 'user_message', count: 1, tfidf: 2.1 },
        ],
      },
      {
        conv_id: '/mock/react-setup.md',
        title: 'React App Setup',
        platform: 'chatgpt',
        keywords: [
          { term: 'react', source: 'title', count: 4, tfidf: 2.8 },
          { term: 'typescript', source: 'user_message', count: 2, tfidf: 3.1 },
          { term: 'webpack', source: 'user_message', count: 1, tfidf: 4.0 },
        ],
      },
    ];
    case 'cmd_kg_discover_topics': return [
      {
        id: 'algorithmic-trading',
        name: 'Algorithmic Trading',
        description: 'Development and backtesting of quantitative trading strategies using mathematical frameworks. Covers portfolio optimization, risk attribution, performance analysis, and implementation of trading algorithms with techniques like Adam optimizer and regime detection.',
        keywords: ['backtesting', 'portfolio optimization', 'quantitative finance', 'trading strategy', 'risk management', 'position sizing'],
      },
      {
        id: 'web-development',
        name: 'Web Development',
        description: 'Building web applications and user interfaces with modern frontend frameworks. Includes React component architecture, state management, CSS styling, responsive design, and browser extension development.',
        keywords: ['react', 'typescript', 'css', 'frontend', 'components', 'chrome extension', 'responsive design'],
      },
      {
        id: 'machine-learning',
        name: 'Machine Learning',
        description: 'Research and implementation of machine learning models, neural networks, and AI systems. Covers topics from sparse autoencoders to federated learning, model interpretability, and molecular representation learning.',
        keywords: ['neural networks', 'deep learning', 'model training', 'interpretability', 'autoencoders', 'transformers'],
      },
    ];
    case 'cmd_kg_get_topics': return [];
    case 'cmd_kg_get_topic_conversations': return [];
    case 'cmd_kg_classify_new_conversations': return 0;
    case 'cmd_kg_get_topic_graph': return generateMockTopicGraph();
    case 'cmd_kg_get_neighbors': return {
      nodes: [
        { id: 'conv-tensor', name: 'Tensor Decomposition Methods', node_type: 'conversation', file_path: '/mock/tensor-decomposition.md', platform: 'chatgpt' },
        { id: 'conv-optim', name: 'Optimization Techniques', node_type: 'conversation', file_path: '/mock/optimization.md', platform: 'claude' },
      ],
      edges: [
        { source: (_args?.nodeId as string) ?? 'conv-0', target: 'conv-tensor', relation: 'shared_topics', weight: 3 },
        { source: (_args?.nodeId as string) ?? 'conv-0', target: 'conv-optim', relation: 'shared_topics', weight: 2 },
      ],
    };
    case 'cmd_kg_create_project': return {
      id: `proj_${Date.now()}`,
      name: String(_args?.name ?? ''),
      description: String(_args?.description ?? ''),
      conversation_count: 0,
      conversations: [],
    };
    case 'cmd_delete_conversation': return undefined;
    case 'cmd_rename_conversation': return undefined;
    case 'cmd_kg_link_conversation': return undefined;
    case 'cmd_kg_unlink_conversation': return undefined;
    case 'cmd_kg_update_project': return undefined;
    case 'cmd_kg_delete_project': return undefined;
    case 'cmd_suggest_project_conversations': return {
      recommendations: [
        { conversation_id: 'conv-1', file_path: '/mock/conv1.md', title: 'Mock Conversation', reason: 'Relevant topic' },
      ],
      summary: 'Found 1 relevant conversation.',
    };
    case 'cmd_kg_get_projects': return [
      {
        id: 'proj_infer',
        name: 'BN Tensor Inference',
        description: 'Accelerate Bayesian network inference using tensor networks and batched primitives.',
        phase: 'Implementation',
        conversation_count: 3,
        conversations: [{ conv_id: 'conv-bn', file_path: '/mock/bn-inference-tensor-network.md', phase: 'Implementation' }]
      },
      {
        id: 'proj_codegen',
        name: 'Hybrid Codegen',
        description: 'Finalize C++ operations mapping to ATen backend and standardizing module nomenclature.',
        phase: 'Debugging',
        conversation_count: 5,
        conversations: [{ conv_id: 'conv-cxx', file_path: '/mock/hybrid-codegen.md', phase: 'Debugging' }]
      },
      {
        id: 'proj_ui',
        name: 'Anthropic App UI',
        description: 'Redesign native interface to echo Anthropic\'s minimal design and structure.',
        phase: 'Ideation',
        conversation_count: 2,
        conversations: [{ conv_id: 'conv-redesign', file_path: '/mock/anthropic-app-ui.md', phase: 'Ideation' }]
      },
      {
        id: 'proj_knowledge',
        name: 'Knowledge Aggregation',
        description: 'Exploration project to extract conceptual graphs and summarize threads over time.',
        phase: 'Ideation',
        conversation_count: 1,
        conversations: [{ conv_id: 'conv-graph', file_path: '/mock/knowledge-aggregation.md', phase: 'Ideation' }]
      }
    ];
    case 'cmd_generate_digest': return {
      content: '## What you\'ve been up to\nThis week you had 8 conversations across Claude and ChatGPT, focusing on tensor inference and UI redesign.\n\n## Project Progress\n- **BN Tensor Inference**: ideation \u2192 design \u2192 implementation (3 conversations)\n- **Anthropic App UI**: ideation (2 conversations)\n\n## Don\'t forget\n- **Knowledge Aggregation** \u2014 last active 12 days ago. You were in the ideation phase exploring conceptual graphs. Consider picking this back up.\n\n## This week\'s highlights\n- Decided to use CP decomposition over Tucker for tensor factorization\n- Completed the new sidebar component for the app redesign',
      generated_at: new Date().toISOString(),
      from_cache: false,
    };
    case 'cmd_get_digest_items':
    case 'cmd_refresh_digest': return [
      { conversation_id: 'conv-1', platform: 'claude', title: 'Optimizing database queries for large datasets', model: 'claude-3.5-sonnet', message_count: 12, file_path: '/mock/claude/optimizing-db-queries.md', preview: 'How can I optimize this SQL query that joins 3 tables?', updated_at: '2026-03-20T14:00:00Z', created_at: '2026-03-20T10:00:00Z', status: 'active', reason: 'unfinished', summary: 'You were exploring index strategies for a multi-table join. The last message asked about composite indexes vs partial indexes.', last_role: 'user', days_inactive: 19, snoozed_until: null, project_id: 'proj-db', project_name: 'Database Optimization', project_hint: null, key_topics: ['sql', 'indexes', 'joins'], is_unresolved: true, attention_reason: 'Open question about composite vs partial indexes', seen_at: '2026-03-20T15:00:00Z', topics: ['Databases', 'Backend'] },
      { conversation_id: 'conv-2', platform: 'chatgpt', title: 'React state management patterns', model: 'gpt-4o', message_count: 8, file_path: '/mock/chatgpt/react-state-mgmt.md', preview: 'What are the best practices for state management in React 19?', updated_at: '2026-03-15T09:30:00Z', created_at: '2026-03-15T09:00:00Z', status: 'active', reason: 'stale', summary: 'Discussion about Zustand vs Jotai for a medium-sized app. Left off comparing bundle sizes.', last_role: 'assistant', days_inactive: 24, snoozed_until: null, project_id: null, project_name: null, project_hint: 'Kept UI Redesign', key_topics: ['react', 'zustand', 'jotai', 'state'], is_unresolved: true, attention_reason: 'Left mid-comparison of bundle sizes', seen_at: null, topics: ['Web Dev', 'Frontend'] },
      { conversation_id: 'conv-3', platform: 'claude', title: 'Rust error handling best practices', model: 'claude-3.5-sonnet', message_count: 2, file_path: '/mock/claude/rust-error-handling.md', preview: 'What is the idiomatic way to handle errors in Rust async code?', updated_at: '2026-04-01T16:00:00Z', created_at: '2026-04-01T16:00:00Z', status: 'active', reason: 'low_messages', summary: null, last_role: 'user', days_inactive: 7, snoozed_until: null, project_id: null, project_name: null, project_hint: null, key_topics: null, is_unresolved: null, attention_reason: null, seen_at: null, topics: null },
      { conversation_id: 'conv-4', platform: 'gemini', title: 'Knowledge graph design for personal notes', model: 'gemini-2.0-flash', message_count: 15, file_path: '/mock/gemini/kg-design.md', preview: 'I want to build a knowledge graph from my notes', updated_at: '2026-03-10T11:00:00Z', created_at: '2026-03-08T14:00:00Z', status: 'active', reason: 'stale', summary: 'Explored entity extraction pipelines and graph schemas. Was about to prototype with CozoDB.', last_role: 'assistant', days_inactive: 29, snoozed_until: null, project_id: null, project_name: null, project_hint: 'Kept UI Redesign', key_topics: ['knowledge graph', 'cozodb', 'entity extraction'], is_unresolved: true, attention_reason: 'Prototype planned but never started', seen_at: '2026-03-11T09:00:00Z', topics: ['Knowledge Graph'] },
      { conversation_id: 'conv-5', platform: 'claude', title: 'Sidebar animation timing', model: 'claude-3.5-sonnet', message_count: 6, file_path: '/mock/claude/sidebar-anim.md', preview: 'The sidebar navigation animation feels sluggish', updated_at: '2026-03-14T10:00:00Z', created_at: '2026-03-14T09:30:00Z', status: 'active', reason: 'stale', summary: 'Tuning cubic-bezier curves for the sidebar hover state.', last_role: 'assistant', days_inactive: 25, snoozed_until: null, project_id: null, project_name: null, project_hint: 'Kept UI Redesign', key_topics: ['animation', 'cubic-bezier', 'sidebar'], is_unresolved: true, attention_reason: 'Hover state timing still unpolished', seen_at: null, topics: ['Web Dev'] },
    ] as import('./types').DigestItem[];
    case 'cmd_update_digest_item': return undefined;
    case 'cmd_bulk_update_digest_items': return (_args as { conversationIds?: string[] })?.conversationIds?.length ?? 0;
    case 'cmd_get_suggested_projects': return [
      {
        suggested_name: 'Kept UI Redesign',
        suggested_description: 'Discussion about Zustand vs Jotai for a medium-sized app. Explored entity extraction pipelines and graph schemas.',
        conversation_ids: ['conv-2', 'conv-4', 'conv-5'],
        conversation_titles: ['React state management patterns', 'Knowledge graph design for personal notes', 'Sidebar animation timing'],
      },
    ] as import('./types').SuggestedProject[];
    case 'cmd_create_project_from_digest': return 'proj-mock-new';
    case 'cmd_link_conversation_to_project': return undefined;
    case 'cmd_create_project_with_conversation': return 'proj-mock-single';
    case 'cmd_mark_digest_items_seen': return (_args as { conversationIds?: string[] })?.conversationIds?.length ?? 0;
    case 'cmd_trigger_digest_auto_pass': return [false, 0, 0];
    case 'cmd_claude_scan_projects': return [
      { name: 'Global', path: 'C:/Users/mock/.claude', is_global: true, has_claude_md: true, has_dot_claude_md: false, has_settings: true, skill_count: 3, memory_file_count: 2 },
      { name: 'Kept', path: 'C:/Users/mock/Projects/Kept', is_global: false, has_claude_md: true, has_dot_claude_md: false, has_settings: true, skill_count: 5, memory_file_count: 4 },
      { name: 'my-api', path: 'C:/Users/mock/Projects/my-api', is_global: false, has_claude_md: false, has_dot_claude_md: true, has_settings: false, skill_count: 1, memory_file_count: 0 },
    ];
    case 'cmd_claude_get_scan_config': return { scan_paths: ['C:/Users/mock/Projects'], pinned_projects: [] };
    case 'cmd_claude_set_scan_config': return undefined;
    case 'cmd_claude_read_instructions': return [
      { name: 'CLAUDE.md', relative_path: 'CLAUDE.md', content: '# Project Instructions\n\n## Environment\n\n- Platform: win32\n- Shell: bash\n\n## Coding Style\n\n- Use TypeScript strict mode\n- Prefer functional patterns\n- Write tests for all new code\n\n## Architecture\n\n- Tauri 2 desktop app\n- Vanilla TypeScript frontend\n- Rust backend\n', size: 245, modified: '2026-03-01T10:00:00Z' },
    ];
    case 'cmd_claude_list_skills': return [
      { filename: 'commit.md', name: 'commit', description: 'Create a git commit with conventional format', content: '---\nname: commit\ndescription: Create a git commit with conventional format\n---\n\nCreate a commit following conventional commits...' },
      { filename: 'review.md', name: 'review', description: 'Review code changes', content: '---\nname: review\ndescription: Review code changes\n---\n\nReview the current diff...' },
    ];
    case 'cmd_claude_list_memory': return [
      { name: 'MEMORY.md', relative_path: '.claude/projects/mock/memory/MEMORY.md', content: '# Memory\n\n- Project uses Tauri 2\n- Prefer vanilla TS over frameworks\n', size: 85, modified: '2026-03-02T15:00:00Z' },
      { name: 'debugging.md', relative_path: '.claude/projects/mock/memory/debugging.md', content: '# Debugging Notes\n\n- cargo check before cargo build\n', size: 52, modified: '2026-03-01T12:00:00Z' },
    ];
    case 'cmd_claude_read_settings': return [
      { name: 'settings.json', relative_path: '.claude/settings.json', content: '{\n  "permissions": {\n    "allow": ["Read", "Write", "Bash"]\n  },\n  "allowedTools": ["Read", "Write", "Bash", "Glob", "Grep"]\n}', size: 120, modified: '2026-03-01T10:00:00Z' },
      { name: 'settings.local.json', relative_path: '.claude/settings.local.json', content: '{\n  "permissions": {\n    "allow": ["Bash(cargo check:*)"]\n  }\n}', size: 60, modified: '2026-03-02T15:00:00Z' },
    ];
    case 'cmd_claude_write_file': return undefined;
    case 'cmd_claude_delete_skill': return undefined;
    case 'cmd_claude_scan_all_skills': return [
      { project_name: 'Global', project_path: 'C:/Users/mock/.claude', skill: { filename: 'commit.md', name: 'commit', description: 'Create a git commit with conventional format', content: '---\nname: commit\ndescription: Create a git commit with conventional format\n---\n\nCreate a commit following conventional commits...' } },
      { project_name: 'Global', project_path: 'C:/Users/mock/.claude', skill: { filename: 'review.md', name: 'review', description: 'Review code changes', content: '---\nname: review\ndescription: Review code changes\n---\n\nReview the current diff...' } },
      { project_name: 'Kept', project_path: 'C:/Users/mock/Projects/Kept', skill: { filename: 'review-component.md', name: 'Review Component', description: 'Review a frontend component for patterns and accessibility', content: '---\nname: Review Component\ndescription: Review a frontend component for patterns and accessibility\n---\n\nReview the component...' } },
      { project_name: 'Kept', project_path: 'C:/Users/mock/Projects/Kept', skill: { filename: 'add-tauri-command.md', name: 'Add Tauri Command', description: 'Scaffold a new Tauri command with all wiring', content: '---\nname: Add Tauri Command\ndescription: Scaffold a new Tauri command with all wiring\n---\n\nFollow this checklist...' } },
      { project_name: 'my-api', project_path: 'C:/Users/mock/Projects/my-api', skill: { filename: 'deploy.md', name: 'deploy', description: 'Deploy to production', content: '---\nname: deploy\ndescription: Deploy to production\n---\n\nRun deployment pipeline...' } },
    ];
    case 'cmd_claude_scan_all_memory': return [
      { project_name: 'Global', project_path: 'C:/Users/mock/.claude', file: { name: 'MEMORY.md', relative_path: '.claude/projects/mock/memory/MEMORY.md', content: '# Memory\n\n- Global preferences here\n', size: 40, modified: '2026-03-02T15:00:00Z' } },
      { project_name: 'Kept', project_path: 'C:/Users/mock/Projects/Kept', file: { name: 'MEMORY.md', relative_path: '.claude/projects/mock/memory/MEMORY.md', content: '# Memory\n\n- Project uses Tauri 2\n- Prefer vanilla TS\n', size: 85, modified: '2026-03-02T15:00:00Z' } },
      { project_name: 'Kept', project_path: 'C:/Users/mock/Projects/Kept', file: { name: 'debugging.md', relative_path: '.claude/projects/mock/memory/debugging.md', content: '# Debugging\n\n- cargo check before build\n', size: 52, modified: '2026-03-01T12:00:00Z' } },
    ];
    case 'cmd_claude_copy_file': return undefined;
    case 'cmd_claude_diff_file': return ['# File content from Project A\n\nSome shared content.\nLine unique to A.\n', '# File content from Project B\n\nSome shared content.\nLine unique to B.\n'];
    case 'cmd_claude_get_templates': return [
      { name: 'My Standard Setup', entries: [
        { source_project: 'C:/Users/mock/Projects/Kept', relative_path: '.claude/commands/review-component.md' },
        { source_project: 'C:/Users/mock/Projects/Kept', relative_path: '.claude/commands/add-tauri-command.md' },
      ] },
    ];
    case 'cmd_claude_set_templates': return undefined;
    case 'cmd_list_models': {
      const provider = (_args?.provider as string) ?? '';
      switch (provider) {
        case 'openai': return [
          { id: 'gpt-4o', provider: 'openai', display_name: 'GPT-4o', owned_by: 'openai' },
          { id: 'gpt-4o-mini', provider: 'openai', display_name: 'GPT-4o Mini', owned_by: 'openai' },
          { id: 'o3-mini', provider: 'openai', display_name: 'o3 Mini', owned_by: 'openai' },
          { id: 'gpt-4-turbo', provider: 'openai', display_name: 'GPT-4 Turbo', owned_by: 'openai' },
        ];
        case 'anthropic': return [
          { id: 'claude-sonnet-4-6', provider: 'anthropic', display_name: 'Sonnet 4.6', owned_by: 'anthropic' },
          { id: 'claude-sonnet-4-5', provider: 'anthropic', display_name: 'Sonnet 4.5', owned_by: 'anthropic' },
          { id: 'claude-haiku-3-5', provider: 'anthropic', display_name: 'Haiku 3.5', owned_by: 'anthropic' },
          { id: 'claude-opus-4', provider: 'anthropic', display_name: 'Opus 4', owned_by: 'anthropic' },
        ];
        case 'openrouter': return [
          { id: 'anthropic/claude-sonnet-4-6', provider: 'openrouter', display_name: 'Claude Sonnet 4.6', owned_by: 'anthropic' },
          { id: 'openai/gpt-4o', provider: 'openrouter', display_name: 'GPT-4o', owned_by: 'openai' },
          { id: 'google/gemini-2.5-pro', provider: 'openrouter', display_name: 'Gemini 2.5 Pro', owned_by: 'google' },
          { id: 'deepseek/deepseek-chat-v3-0324', provider: 'openrouter', display_name: 'DeepSeek V3', owned_by: 'deepseek' },
          { id: 'meta-llama/llama-4-maverick', provider: 'openrouter', display_name: 'Llama 4 Maverick', owned_by: 'meta-llama' },
        ];
        case 'ollama': return [
          { id: 'gemma3:1b', provider: 'ollama', display_name: 'Gemma3 1B' },
          { id: 'llama3:8b', provider: 'ollama', display_name: 'Llama3 8B' },
          { id: 'nomic-embed-text', provider: 'ollama', display_name: 'Nomic Embed Text' },
        ];
        default: return [];
      }
    }
    case 'cmd_reveal_file': return undefined;
    case 'cmd_check_providers': return [
      { provider: 'openai', available: true },
      { provider: 'anthropic', available: true },
      { provider: 'openrouter', available: false },
      { provider: 'ollama', available: true },
    ];
    case 'cmd_export_validate': {
      const path = (_args?.path as string) ?? '';
      return {
        exists: path.length > 0,
        is_vault: path.toLowerCase().includes('obsidian'),
      } as ObsidianValidation;
    }
    case 'cmd_export_to_obsidian':
      return { files_copied: 42, duration_ms: 137 } as ObsidianExportResult;
    default: return null;
  }
}

export async function getVaultTree(): Promise<VaultNode[]> {
  return invoke('cmd_vault_tree');
}

export async function getConversation(filePath: string): Promise<string> {
  return invoke('cmd_get_conversation', { filePath });
}

export async function listConversations(platform?: string): Promise<ConversationMeta[]> {
  return invoke('cmd_list_conversations', { platform: platform || null });
}

export async function search(query: string, limit?: number): Promise<SearchResult[]> {
  return invoke('cmd_search', { query, limit: limit || 50 });
}

export async function reindex(): Promise<string> {
  return invoke('cmd_reindex');
}

export async function clearVault(): Promise<string> {
  return invoke('cmd_clear_vault');
}

export async function getToken(): Promise<string> {
  return invoke('cmd_get_token');
}

export async function getExtensionStatus(): Promise<ExtensionStatus> {
  return invoke('cmd_extension_status');
}

export async function getExtensionZip(): Promise<string> {
  return invoke('cmd_extension_zip');
}

export async function requestExtensionSync(providers: string[], limit: number): Promise<void> {
  return invoke('cmd_request_extension_sync', { providers: providers.join(","), limit });
}

export async function stopExtensionSync(): Promise<void> {
  return invoke('cmd_stop_extension_sync');
}

export async function refreshToken(): Promise<string> {
  return invoke('cmd_refresh_token');
}

export async function getClipboardText(): Promise<string> {
  return invoke('cmd_clipboard_text');
}

export async function kbAddPaths(paths: string[]): Promise<string[]> {
  return invoke('cmd_kb_add_paths', { paths });
}

export async function kbRemovePath(path: string): Promise<void> {
  return invoke('cmd_kb_remove_path', { path });
}

export async function kbListFiles(): Promise<KbFileEntry[]> {
  return invoke('cmd_kb_list_files');
}

export async function kbReadFile(path: string): Promise<string> {
  return invoke('cmd_kb_read_file', { path });
}

export async function readFileBase64(path: string): Promise<string> {
  return invoke('cmd_read_file_base64', { path });
}

export async function getConfig(): Promise<AppConfig> {
  return invoke('cmd_get_config');
}

export async function setConfig(config: AppConfig): Promise<void> {
  return invoke('cmd_set_config', { config });
}

// ── Obsidian export ────────────────────────────────────────

export async function exportValidate(path: string): Promise<ObsidianValidation> {
  return invoke('cmd_export_validate', { path });
}

export async function exportToObsidian(path: string): Promise<ObsidianExportResult> {
  return invoke('cmd_export_to_obsidian', { path });
}

export async function validatePath(path: string): Promise<boolean> {
  return invoke('cmd_validate_path', { path });
}

export async function getVaultPath(): Promise<string> {
  return invoke('cmd_vault_path');
}

export async function getVaultStats(): Promise<import('./types').VaultStats> {
  return invoke('cmd_vault_stats');
}

export async function openVault(): Promise<void> {
  return invoke('cmd_open_vault');
}

export async function generateTitle(request: TitleRequest): Promise<string> {
  return invoke('cmd_generate_title', { request });
}

export async function agentChat(request: AgentChatRequest): Promise<AgentChatResponse> {
  return invoke('cmd_agent_chat', { request });
}

export async function saveKeptChat(payload: IngestPayload): Promise<string> {
  return invoke('cmd_save_kept_chat', { payload });
}

export async function migrateDownloads(): Promise<string> {
  return invoke('cmd_migrate_downloads');
}

export async function cmdKgSummary(): Promise<string> {
  return invoke('cmd_kg_summary');
}

export async function cmdKgStats(): Promise<KgStats> {
  return invoke('cmd_kg_stats');
}

export async function cmdKgGetGraph(limit?: number): Promise<GraphData> {
  return invoke('cmd_kg_get_graph', { limit: limit ?? null });
}

export async function cmdKgSearch(query: string, limit?: number): Promise<GraphData> {
  return invoke('cmd_kg_search', { query, limit: limit ?? null });
}

export async function cmdKgIndexVault(
  forceReindex = false,
  provider?: string,
  model?: string,
): Promise<string> {
  return invoke('cmd_kg_index_vault', {
    forceReindex,
    provider: provider ?? null,
    model: model ?? null,
  });
}

export async function cmdKgExtractKeywords(): Promise<ConversationKeywords[]> {
  return invoke('cmd_kg_extract_keywords');
}

export async function cmdKgDiscoverTopics(provider: string, model: string): Promise<Topic[]> {
  return invoke('cmd_kg_discover_topics', { provider, model });
}

export async function cmdKgGetTopics(): Promise<Topic[]> {
  return invoke('cmd_kg_get_topics');
}

export async function cmdKgGetTopicConversations(topicId: string): Promise<string[]> {
  return invoke('cmd_kg_get_topic_conversations', { topicId });
}

export async function cmdKgClassifyNewConversations(): Promise<number> {
  return invoke('cmd_kg_classify_new_conversations');
}

export async function cmdKgGetTopicGraph(provider?: string, model?: string): Promise<GraphData> {
  return invoke('cmd_kg_get_topic_graph', {
    provider: provider ?? null,
    model: model ?? null,
  });
}

export async function cmdKgGetNeighbors(nodeId: string): Promise<GraphData> {
  return invoke('cmd_kg_get_neighbors', { nodeId });
}

export async function cmdKgResetDb(): Promise<string> {
  return invoke('cmd_kg_reset_db');
}

export async function cmdKgGetProjects(): Promise<ProjectData[]> {
  return invoke('cmd_kg_get_projects');
}

export async function cmdKgCreateProject(name: string, description: string): Promise<ProjectData> {
  return invoke('cmd_kg_create_project', { name, description });
}

export async function deleteConversation(filePath: string): Promise<void> {
  return invoke('cmd_delete_conversation', { filePath });
}

export async function renameConversation(filePath: string, newTitle: string): Promise<void> {
  return invoke('cmd_rename_conversation', { filePath, newTitle });
}

export async function cmdKgUpdateProject(projectId: string, name: string, description: string): Promise<void> {
  return invoke('cmd_kg_update_project', { projectId, name, description });
}

export async function cmdKgDeleteProject(projectId: string): Promise<void> {
  return invoke('cmd_kg_delete_project', { projectId });
}

export async function cmdKgUnlinkConversation(projectId: string, conversationId: string): Promise<void> {
  return invoke('cmd_kg_unlink_conversation', { projectId, conversationId });
}

export async function cmdKgLinkConversation(projectId: string, conversationId: string, phase: string): Promise<void> {
  return invoke('cmd_kg_link_conversation', { projectId, conversationId, phase });
}

export async function cmdSuggestProjectConversations(projectId: string, name: string, description: string): Promise<SuggestProjectResponse> {
  return invoke('cmd_suggest_project_conversations', { projectId, name, description });
}

export async function cmdGenerateDigest(forceRefresh = false, provider?: string): Promise<DigestData> {
  return invoke('cmd_generate_digest', {
    forceRefresh,
    provider: provider ?? null,
  });
}

// ── Digest Items ────────────────────────────────────────────────────────────

export async function getDigestItems(withSummaries = false): Promise<import('./types').DigestItem[]> {
  return invoke('cmd_get_digest_items', { withSummaries });
}

export async function updateDigestItem(
  conversationId: string,
  action: 'dismiss' | 'snooze',
  snoozeDays?: number,
): Promise<void> {
  return invoke('cmd_update_digest_item', {
    conversationId,
    action,
    snoozeDays: snoozeDays ?? null,
  });
}

export async function bulkUpdateDigestItems(
  conversationIds: string[],
  action: 'dismiss' | 'snooze',
  snoozeDays?: number,
): Promise<number> {
  return invoke('cmd_bulk_update_digest_items', {
    conversationIds,
    action,
    snoozeDays: snoozeDays ?? null,
  });
}

export async function refreshDigest(withSummaries = false): Promise<import('./types').DigestItem[]> {
  return invoke('cmd_refresh_digest', { withSummaries });
}

export async function getSuggestedProjects(): Promise<import('./types').SuggestedProject[]> {
  return invoke('cmd_get_suggested_projects');
}

export async function createProjectFromDigest(
  name: string,
  description: string,
  conversationIds: string[],
): Promise<string> {
  return invoke('cmd_create_project_from_digest', {
    name,
    description,
    conversationIds,
  });
}

export async function linkConversationToProject(
  projectId: string,
  conversationId: string,
): Promise<void> {
  return invoke('cmd_link_conversation_to_project', {
    projectId,
    conversationId,
  });
}

export async function createProjectWithConversation(
  name: string,
  description: string,
  conversationId: string,
): Promise<string> {
  return invoke('cmd_create_project_with_conversation', {
    name,
    description,
    conversationId,
  });
}

export async function markDigestItemsSeen(
  conversationIds: string[],
): Promise<number> {
  return invoke('cmd_mark_digest_items_seen', { conversationIds });
}

/**
 * Trigger the backend auto-summarize pass if the gate allows it.
 * Returns [ran, candidates, summariesGenerated].
 */
export async function triggerDigestAutoPass(): Promise<[boolean, number, number]> {
  return invoke('cmd_trigger_digest_auto_pass');
}

// ── Model Management ────────────────────────────────────────────────────────

export async function listModels(provider: string, apiKey?: string): Promise<AvailableModel[]> {
  return invoke('cmd_list_models', { provider, apiKey });
}

export async function checkProviders(): Promise<ProviderStatus[]> {
  return invoke('cmd_check_providers');
}

// ── Claude Code Manager ─────────────────────────────────────────────────────

export async function claudeScanProjects(): Promise<ClaudeProject[]> {
  return invoke('cmd_claude_scan_projects');
}

export async function claudeGetScanConfig(): Promise<ClaudeScanConfig> {
  return invoke('cmd_claude_get_scan_config');
}

export async function claudeSetScanConfig(scanConfig: ClaudeScanConfig): Promise<void> {
  return invoke('cmd_claude_set_scan_config', { scanConfig });
}

export async function claudeReadInstructions(projectPath: string): Promise<ClaudeFile[]> {
  return invoke('cmd_claude_read_instructions', { projectPath });
}

export async function claudeListSkills(projectPath: string): Promise<ClaudeSkill[]> {
  return invoke('cmd_claude_list_skills', { projectPath });
}

export async function claudeListMemory(projectPath: string): Promise<ClaudeFile[]> {
  return invoke('cmd_claude_list_memory', { projectPath });
}

export async function claudeReadSettings(projectPath: string): Promise<ClaudeFile[]> {
  return invoke('cmd_claude_read_settings', { projectPath });
}

export async function claudeWriteFile(projectPath: string, relativePath: string, content: string): Promise<void> {
  return invoke('cmd_claude_write_file', { projectPath, relativePath, content });
}

export async function claudeDeleteSkill(projectPath: string, filename: string): Promise<void> {
  return invoke('cmd_claude_delete_skill', { projectPath, filename });
}

export async function claudeScanAllSkills(): Promise<ClaudeSkillWithProject[]> {
  return invoke('cmd_claude_scan_all_skills');
}

export async function claudeScanAllMemory(): Promise<ClaudeFileWithProject[]> {
  return invoke('cmd_claude_scan_all_memory');
}

export async function claudeCopyFile(sourceProject: string, relativePath: string, targetProject: string): Promise<void> {
  return invoke('cmd_claude_copy_file', { sourceProject, relativePath, targetProject });
}

export async function claudeDiffFile(projectA: string, projectB: string, relativePath: string): Promise<[string, string]> {
  return invoke('cmd_claude_diff_file', { projectA, projectB, relativePath });
}

export async function claudeGetTemplates(): Promise<ClaudeTemplate[]> {
  return invoke('cmd_claude_get_templates');
}

export async function claudeSetTemplates(templates: ClaudeTemplate[]): Promise<void> {
  return invoke('cmd_claude_set_templates', { templates });
}

/** Open the parent directory of a file in the system file explorer. */
export async function revealFile(path: string): Promise<void> {
  return invoke('cmd_reveal_file', { path });
}
