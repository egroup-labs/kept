/**
 * Temporary Coding (Claude Code Manager) page — wired in loosely for testing.
 * Will be replaced in the full redesign.
 */
import { useCallback, useEffect, useState } from "react";
import {
  claudeScanProjects,
  claudeReadInstructions,
  claudeListSkills,
  claudeListMemory,
  claudeReadSettings,
} from "../lib/tauri-api";
import type { ClaudeProject, ClaudeFile, ClaudeSkill } from "../lib/types";

type Tab = "instructions" | "skills" | "memory" | "settings";

function FileViewer({ file }: { file: ClaudeFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer hover:bg-surface-raised/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium text-fg-secondary truncate">{file.name}</span>
          <span className="text-xs text-fg-faint">{file.relative_path}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {file.modified && (
            <span className="text-xs text-fg-faint">
              {new Date(file.modified).toLocaleDateString()}
            </span>
          )}
          <span className="text-xs text-fg-faint">{(file.size / 1024).toFixed(1)}KB</span>
          <span className="text-fg-muted text-xs">{open ? "▼" : "▶"}</span>
        </div>
      </button>
      {open && (
        <pre className="px-4 py-3 text-xs text-fg-muted bg-base border-t border-border-subtle overflow-x-auto whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
          {file.content}
        </pre>
      )}
    </div>
  );
}

function SkillCard({ skill }: { skill: ClaudeSkill }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left cursor-pointer hover:bg-surface-raised/50 transition-colors"
      >
        <div className="min-w-0">
          <span className="text-sm font-medium text-fg-secondary">
            /{skill.name || skill.filename.replace(/\.md$/, "")}
          </span>
          {skill.description && (
            <span className="text-xs text-fg-faint ml-3">{skill.description}</span>
          )}
        </div>
        <span className="text-fg-muted text-xs shrink-0">{open ? "▼" : "▶"}</span>
      </button>
      {open && (
        <pre className="px-4 py-3 text-xs text-fg-muted bg-base border-t border-border-subtle overflow-x-auto whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
          {skill.content}
        </pre>
      )}
    </div>
  );
}

function ProjectDetail({ project }: { project: ClaudeProject }) {
  const [tab, setTab] = useState<Tab>("instructions");
  const [instructions, setInstructions] = useState<ClaudeFile[]>([]);
  const [skills, setSkills] = useState<ClaudeSkill[]>([]);
  const [memory, setMemory] = useState<ClaudeFile[]>([]);
  const [settings, setSettings] = useState<ClaudeFile[]>([]);
  const [loading, setLoading] = useState(false);

  const loadTab = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      switch (t) {
        case "instructions":
          setInstructions(await claudeReadInstructions(project.path));
          break;
        case "skills":
          setSkills(await claudeListSkills(project.path));
          break;
        case "memory":
          setMemory(await claudeListMemory(project.path));
          break;
        case "settings":
          setSettings(await claudeReadSettings(project.path));
          break;
      }
    } catch {
      // silently fail for temp UI
    } finally {
      setLoading(false);
    }
  }, [project.path]);

  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "instructions", label: "Instructions" },
    { key: "skills", label: "Skills", count: project.skill_count },
    { key: "memory", label: "Memory", count: project.memory_file_count },
    { key: "settings", label: "Settings" },
  ];

  return (
    <div>
      <div className="flex gap-1 mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer"
            style={{
              background: tab === t.key ? "var(--color-surface-raised)" : "transparent",
              color: tab === t.key ? "var(--color-fg-secondary)" : "var(--color-fg-faint)",
            }}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className="ml-1.5 text-fg-faint">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-fg-faint">Loading...</div>
      ) : (
        <div className="flex flex-col gap-2">
          {tab === "instructions" && (
            instructions.length === 0
              ? <p className="text-sm text-fg-faint py-4">No instructions found.</p>
              : instructions.map((f) => <FileViewer key={f.relative_path} file={f} />)
          )}
          {tab === "skills" && (
            skills.length === 0
              ? <p className="text-sm text-fg-faint py-4">No skills found.</p>
              : skills.map((s) => <SkillCard key={s.filename} skill={s} />)
          )}
          {tab === "memory" && (
            memory.length === 0
              ? <p className="text-sm text-fg-faint py-4">No memory files found.</p>
              : memory.map((f) => <FileViewer key={f.relative_path} file={f} />)
          )}
          {tab === "settings" && (
            settings.length === 0
              ? <p className="text-sm text-fg-faint py-4">No settings found.</p>
              : settings.map((f) => <FileViewer key={f.relative_path} file={f} />)
          )}
        </div>
      )}
    </div>
  );
}

export default function CodingManager() {
  const [projects, setProjects] = useState<ClaudeProject[]>([]);
  const [selected, setSelected] = useState<ClaudeProject | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    claudeScanProjects()
      .then((p) => {
        setProjects(p);
        if (p.length > 0) setSelected(p[0]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="w-full max-w-5xl mx-auto px-6 py-8 font-sans">
      <h1 className="text-2xl font-semibold text-fg mb-6">Coding</h1>

      {loading ? (
        <div className="text-sm text-fg-faint">Scanning projects...</div>
      ) : projects.length === 0 ? (
        <div className="text-sm text-fg-faint">No Claude Code projects found.</div>
      ) : (
        <div className="flex gap-6">
          {/* Project list */}
          <div className="w-48 shrink-0 flex flex-col gap-1">
            {projects.map((p) => (
              <button
                key={p.path}
                onClick={() => setSelected(p)}
                className="text-left px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer"
                style={{
                  background: selected?.path === p.path ? "var(--color-surface-raised)" : "transparent",
                  color: selected?.path === p.path ? "var(--color-fg)" : "var(--color-fg-muted)",
                }}
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--color-fg-faint)" }}>
                  {p.skill_count}s · {p.memory_file_count}m
                  {p.is_global && " · global"}
                </div>
              </button>
            ))}
          </div>

          {/* Detail panel */}
          <div className="flex-1 min-w-0">
            {selected && <ProjectDetail key={selected.path} project={selected} />}
          </div>
        </div>
      )}
    </div>
  );
}
