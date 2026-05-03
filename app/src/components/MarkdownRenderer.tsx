import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";

/**
 * Pre-process markdown before passing to ReactMarkdown:
 * 1. Protect code blocks from math normalization
 * 2. Identify all legitimate math (\[…\], \(…\), $$…$$, $…$ with heuristic)
 * 3. Escape every remaining $ so remark-math never sees false positives
 * 4. Ensure --- renders as <hr> (not setext heading)
 */

const MATH_SIGNAL =
  /\\[a-zA-Z]+|[_^{}|]|[=<>±∞∑∫∏√≠≤≥≈∈∉⊂⊃∪∩∂∇]|[a-zA-Z]\s*\(|[+\-*/]\s*[a-zA-Z]|[a-zA-Z]\s*[+\-*/]/;
const CURRENCY_RE = /^\d[\d,. ]*[kKmMbBtT%]?$/;

/** Does this $…$ content look like math or like currency / prose? */
function looksLikeMath(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (MATH_SIGNAL.test(t)) return true;
  if (/^[a-zA-Zα-ωΑ-Ω]$/.test(t)) return true;
  if (CURRENCY_RE.test(t)) return false;
  return false;
}

function normalizeMarkdown(text: string): string {
  // Split by code spans / fenced blocks so we never touch code
  const CODE_FENCE = /(```[\s\S]*?```|`[^`\n]+`)/g;
  const parts = text.split(CODE_FENCE);

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // odd = code

    let chunk = parts[i];
    const regions: Array<{ start: number; end: number; text: string }> = [];

    // \[…\] → block math (always legit)
    for (const m of chunk.matchAll(/\\\[([\s\S]*?)\\\]/g)) {
      regions.push({ start: m.index!, end: m.index! + m[0].length, text: `$$${m[1]}$$` });
    }
    // \(…\) → inline math (always legit)
    for (const m of chunk.matchAll(/\\\(([\s\S]*?)\\\)/g)) {
      regions.push({ start: m.index!, end: m.index! + m[0].length, text: `$${m[1]}$` });
    }
    // $$…$$ → block math (always legit, skip if inside a \[…\] we already captured)
    for (const m of chunk.matchAll(/\$\$([\s\S]*?)\$\$/g)) {
      const s = m.index!, e = s + m[0].length;
      if (!regions.some(r => s >= r.start && s < r.end)) {
        regions.push({ start: s, end: e, text: m[0] });
      }
    }
    // $…$ → inline math, heuristic gate
    // Boundary rule: non-whitespace after opening $ and before closing $
    for (const m of chunk.matchAll(/\$(\S(?:[^\$\n]*?\S)?)\$/g)) {
      const s = m.index!, e = s + m[0].length;
      if (regions.some(r => s < r.end && e > r.start)) continue;
      if (looksLikeMath(m[1])) {
        regions.push({ start: s, end: e, text: m[0] });
      }
    }

    // Replace confirmed math with placeholders → escape stray $ → restore
    regions.sort((a, b) => b.start - a.start);
    const store: string[] = [];
    for (const r of regions) {
      store.push(r.text);
      chunk = chunk.slice(0, r.start) + `\x00M${store.length - 1}\x00` + chunk.slice(r.end);
    }
    chunk = chunk.replace(/\$/g, "\\$");
    chunk = chunk.replace(/\x00M(\d+)\x00/g, (_, idx) => store[parseInt(idx)]);

    // Normalize GFM table separators: pad dash groups to at least 3 dashes.
    // Models sometimes output `-|-|-` which GFM requires as `---|---|---`.
    chunk = chunk.replace(/^([|:\-\s]+)$/gm, (line) => {
      if (!line.includes('|') || !line.includes('-')) return line;
      return line.replace(/:?-+:?/g, (m) => {
        const left = m.startsWith(':') ? ':' : '';
        const right = m.endsWith(':') && m.length > 1 ? ':' : '';
        const dashLen = m.replace(/:/g, '').length;
        return left + '-'.repeat(Math.max(3, dashLen)) + right;
      });
    });

    // Normalize --- separators into thematic breaks.
    // Pass 1: --- at end of a text line ("question? ---") → split to own line
    // Exclude pipe before dashes to avoid breaking GFM table separator rows
    chunk = chunk.replace(/([^\s|])[ \t]+-{3,}[ \t]*$/gm, "$1\n\n---\n");
    // Pass 2: --- on its own line → ensure blank lines around it
    //         (also handles --- at end-of-string after .trim() strips trailing \n)
    chunk = chunk.replace(/(^|\n)-{3,}($|\n)/g, "$1\n\n---\n\n$2");

    parts[i] = chunk;
  }

  return parts.join("");
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const code = String(children).replace(/\n$/, "");
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "";

  // Handle ChatGPT unsupported blocks
  if (code === "This block is not supported on your current device yet.") {
    return <div className="unsupported-block">Interactive content not available in archive</div>;
  }

  const handleCopy = useCallback(() => {
    const text = (codeRef.current?.textContent ?? '').replace(/\n$/, '');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || "text"}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          {!copied && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      <pre>
        <code ref={codeRef} className={className}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function MarkdownImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="md-image-placeholder" title={src || "Image unavailable"}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span>Image unavailable</span>
      </span>
    );
  }
  return <img src={src} alt={alt} onError={() => setFailed(true)} {...props} />;
}

function MarkdownLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (href && !href.startsWith("#")) {
      import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href).catch(() => {}));
    }
  };
  return <a href={href} onClick={handleClick} {...props}>{children}</a>;
}

const components: Components = {
  code({ className, children, ...props }) {
    const isBlock = /language-/.test(className || "") ||
      (typeof children === "string" && children.includes("\n"));

    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    // react-markdown wraps code blocks in <pre>, but our CodeBlock already handles that
    return <>{children}</>;
  },
  img({ src, alt, ...props }) {
    return <MarkdownImage src={src} alt={alt} {...props} />;
  },
  a({ href, children, ...props }) {
    return <MarkdownLink href={href} {...props}>{children}</MarkdownLink>;
  },
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
  streaming?: boolean;
}

const remarkPlugins: PluggableList = [remarkGfm, remarkMath];
const rehypePlugins: PluggableList = [rehypeKatex, [rehypeHighlight, { ignoreMissing: true }]];
const streamingRehypePlugins: PluggableList = [rehypeKatex];

function stripTransientStreamingFence(content: string, streaming: boolean): string {
  if (!streaming) return content;
  const trimmedStart = content.trimStart();
  if (!trimmedStart.startsWith("```")) return content;
  const firstLineEnd = trimmedStart.indexOf("\n");
  if (firstLineEnd === -1) return "";
  const fenceLine = trimmedStart.slice(0, firstLineEnd).trim().toLowerCase();
  if (!/^```(text|md|markdown)?$/.test(fenceLine)) return content;
  const body = trimmedStart.slice(firstLineEnd + 1);
  return body.includes("```") ? content : body;
}

function isPathologicalTokenLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|)/.test(trimmed)) return false;
  if (trimmed.length > 34) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[^\s`]+$/.test(trimmed);
}

function joinPathologicalTokenLines(lines: string[]): string {
  return lines.reduce((acc, line) => {
    const next = line.trim();
    if (!acc) return next;
    const noSpace =
      /^[,.;:!?%)]/.test(next)
      || /^['’]/.test(next)
      || /[(\[{]$/.test(acc)
      || (/\d$/.test(acc) && /^\d/.test(next))
      || acc.endsWith("/")
      || next.startsWith("/");
    return `${acc}${noSpace ? "" : " "}${next}`;
  }, "");
}

function repairPathologicalTokenLinebreaks(content: string): string {
  const codeFenceOrInline = /(```[\s\S]*?```|`[^`\n]+`)/g;
  return content
    .split(codeFenceOrInline)
    .map((part, index) => {
      if (index % 2 === 1) return part;

      const lines = part.split(/\r?\n/);
      const repaired: string[] = [];
      let run: string[] = [];

      const flush = () => {
        if (run.length >= 6) {
          repaired.push(joinPathologicalTokenLines(run));
        } else {
          repaired.push(...run);
        }
        run = [];
      };

      for (const line of lines) {
        if (isPathologicalTokenLine(line)) {
          run.push(line);
        } else {
          flush();
          repaired.push(line);
        }
      }
      flush();
      return repaired.join("\n");
    })
    .join("");
}

function useStreamingContent(content: string, streaming: boolean): string {
  const [visible, setVisible] = useState(content);
  const latestRef = useRef(content);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = content;
    if (!streaming) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setVisible(content);
      return;
    }

    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setVisible(latestRef.current);
      }, 120);
    }
  }, [content, streaming]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return visible;
}

export default memo(function MarkdownRenderer({ content, className = "chat-markdown", streaming = false }: MarkdownRendererProps) {
  const visibleContent = useStreamingContent(content, streaming);
  const normalized = useMemo(
    () => normalizeMarkdown(repairPathologicalTokenLinebreaks(stripTransientStreamingFence(visibleContent, streaming))),
    [visibleContent, streaming],
  );

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={streaming ? streamingRehypePlugins : rehypePlugins}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});
