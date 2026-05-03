/**
 * Temporary Dashboard page — wired in loosely for testing.
 * Will be replaced in the full redesign.
 */
import { useState } from "react";
import type { DigestData } from "../lib/types";
import MarkdownRenderer from "./MarkdownRenderer";

const MOCK_DIGEST: DigestData = {
  content: `## What you've been working on
This week you had 8 conversations across Claude and ChatGPT, focusing on tensor inference, knowledge graph architecture, and a full UI redesign for the Kept app.

## Project progress
- **BN Tensor Inference** — implementation phase, 3 conversations
  > Consider benchmarking CP decomposition against Tucker on your test dataset
- **Kept UI Redesign** — design phase, 2 conversations
  > Finalize the component hierarchy and start building the sidebar navigation
- **Knowledge Graph Pipeline** — ideation, 2 conversations
  > Prototype the entity extraction prompt with a small conversation sample

## Reminders
- **Knowledge Aggregation** — last active 12 days ago, was in ideation
  > You were exploring conceptual graph structures. Try mapping out the schema with a real dataset.

## Highlights
- Decided to use CP decomposition over Tucker for tensor factorization
- Completed the new sidebar component with animated swatch navigation
- Explored KDEEB edge bundling for knowledge graph visualization`,
  generated_at: new Date().toISOString(),
  from_cache: false,
};

interface DigestSection {
  title: string;
  body: string;
}

function parseDigestSections(md: string): DigestSection[] {
  return md
    .split(/^## /m)
    .filter(Boolean)
    .map((part) => {
      const nl = part.indexOf("\n");
      if (nl === -1) return { title: part.trim(), body: "" };
      return { title: part.slice(0, nl).trim(), body: part.slice(nl + 1).trim() };
    });
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export default function Dashboard() {
  const [digest] = useState<DigestData>(MOCK_DIGEST);

  const sections = parseDigestSections(digest.content);

  return (
    <div className="w-full max-w-4xl mx-auto px-6 py-8 font-sans">
      <div className="flex items-baseline justify-between mb-8">
        <h1 className="text-2xl font-semibold text-fg">Dashboard</h1>
      </div>

      <p className="text-xs text-fg-faint mb-6">
        {digest.from_cache ? `Cached ${timeAgo(digest.generated_at)}` : `Generated ${timeAgo(digest.generated_at)}`}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {sections.map((s) => (
          <div key={s.title} className="rounded-xl bg-surface border border-border-subtle p-5">
            <h3 className="text-sm font-semibold text-fg-secondary mb-3">{s.title}</h3>
            {s.body && (
              <div className="text-sm text-fg-muted leading-relaxed [&_strong]:text-fg-secondary [&_li]:mb-1 [&_ul]:list-disc [&_ul]:pl-4 [&_blockquote]:border-l-2 [&_blockquote]:border-fg-faint [&_blockquote]:pl-3 [&_blockquote]:text-fg-faint [&_blockquote]:italic">
                <MarkdownRenderer content={s.body} className="" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
