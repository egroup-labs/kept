export interface Frontmatter {
  id?: string;
  platform?: string;
  title?: string;
  synced?: string;
  created_at?: string;
  updated_at?: string;
  messages?: number;
  model?: string;
  tags?: string[];
}

export interface ToolCallRecord {
  name: string;
  arguments: unknown;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
}

const THINKING_RE = /<!--\s*kept:thinking\s*-->\s*([\s\S]*?)\s*<!--\s*\/kept:thinking\s*-->/;
const TOOLS_RE = /<!--\s*kept:tools\s*-->\s*([\s\S]*?)\s*<!--\s*\/kept:tools\s*-->/;

/** Split `key=jsonVal, key=jsonVal` respecting double-quoted strings. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inStr = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { buf += ch; escape = false; continue; }
    if (ch === '\\' && inStr) { buf += ch; escape = true; continue; }
    if (ch === '"') { inStr = !inStr; buf += ch; continue; }
    if (ch === ',' && !inStr) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseToolLine(line: string): ToolCallRecord | null {
  const m = line.replace(/^\s*-\s*/, '').match(/^([A-Za-z_][\w]*)\(([\s\S]*)\)\s*$/);
  if (!m) return null;
  const [, name, raw] = m;
  const args: Record<string, unknown> = {};
  for (const part of splitArgs(raw)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { args[k] = JSON.parse(v); }
    catch { args[k] = v; }
  }
  return { name, arguments: args };
}

function extractAndStrip(content: string): {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
} {
  let body = content;
  let reasoning: string | undefined;
  let toolCalls: ToolCallRecord[] | undefined;

  const tm = body.match(THINKING_RE);
  if (tm) {
    reasoning = tm[1].trim();
    body = body.replace(tm[0], '');
  }
  const lm = body.match(TOOLS_RE);
  if (lm) {
    toolCalls = lm[1]
      .split(/\r?\n/)
      .map((l) => parseToolLine(l))
      .filter((x): x is ToolCallRecord => x !== null);
    if (toolCalls.length === 0) toolCalls = undefined;
    body = body.replace(lm[0], '');
  }

  return { content: body.trim(), reasoning, toolCalls };
}

/** Split the markdown body into individual messages by ### User / ### Assistant headers */
export function parseMessages(body: string): { title: string | null; messages: ConversationMessage[] } {
  const messages: ConversationMessage[] = [];

  let cleaned = body;
  let title: string | null = null;
  const titleMatch = cleaned.match(/^#\s+(.+)\n/);
  if (titleMatch) {
    title = titleMatch[1];
    cleaned = cleaned.slice(titleMatch[0].length);
  }

  const parts = cleaned.split(/^###\s+(You|Assistant|tool)(?:\s.*)?$/im);

  for (let i = 1; i < parts.length; i += 2) {
    const rawRole = parts[i].toLowerCase();
    const role = (rawRole === 'you' ? 'user' : rawRole === 'tool' ? 'assistant' : rawRole) as 'user' | 'assistant';
    const raw = (parts[i + 1] || '').trim().replace(/^-{3,}\s*|\s*-{3,}$/g, '').trim();
    if (!raw) continue;

    if (role === 'assistant') {
      const { content, reasoning, toolCalls } = extractAndStrip(raw);
      if (!content && !reasoning && !toolCalls) continue;
      messages.push({ role, content, reasoning, toolCalls });
    } else {
      messages.push({ role, content: raw });
    }
  }

  return { title, messages };
}

export function parseFrontmatter(markdown: string): { frontmatter: Frontmatter; body: string } {
  const fm: Frontmatter = {};

  if (!markdown.startsWith('---')) {
    return { frontmatter: fm, body: markdown };
  }

  const rest = markdown.slice(3);
  const endIdx = rest.indexOf('---');
  if (endIdx === -1) {
    return { frontmatter: fm, body: markdown };
  }

  const fmBlock = rest.slice(0, endIdx);
  const body = rest.slice(endIdx + 3).trim();

  for (const line of fmBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');

    switch (key) {
      case 'id': fm.id = val; break;
      case 'platform': fm.platform = val; break;
      case 'title': fm.title = val; break;
      case 'synced': fm.synced = val; break;
      case 'created_at': fm.created_at = val; break;
      case 'updated_at': fm.updated_at = val; break;
      case 'messages': fm.messages = parseInt(val, 10); break;
      case 'model': fm.model = val; break;
    }
  }

  return { frontmatter: fm, body };
}
