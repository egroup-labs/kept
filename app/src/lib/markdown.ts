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

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Split the markdown body into individual messages by ### User / ### Assistant headers */
export function parseMessages(body: string): { title: string | null; messages: ConversationMessage[] } {
  const messages: ConversationMessage[] = [];

  // Remove leading title (# Title) if present
  let cleaned = body;
  let title: string | null = null;
  const titleMatch = cleaned.match(/^#\s+(.+)\n/);
  if (titleMatch) {
    title = titleMatch[1];
    cleaned = cleaned.slice(titleMatch[0].length);
  }

  // Split on ### You/Assistant/tool (with optional timestamp suffix like "— 2024-01-01T...")
  const parts = cleaned.split(/^###\s+(You|Assistant|tool)(?:\s.*)?$/im);

  // parts: ['preamble', 'You', 'content', 'Assistant', 'content', ...]
  for (let i = 1; i < parts.length; i += 2) {
    const rawRole = parts[i].toLowerCase();
    const role = (rawRole === 'you' ? 'user' : rawRole === 'tool' ? 'assistant' : rawRole) as 'user' | 'assistant';
    const content = (parts[i + 1] || '').trim().replace(/^-{3,}\s*|\s*-{3,}$/g, '').trim();
    if (content) {
      messages.push({ role, content });
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
