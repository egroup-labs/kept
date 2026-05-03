import DOMPurify from 'dompurify';
import type { ClaudeProject, ClaudeSkillWithProject as _ClaudeSkillWithProject, ClaudeFileWithProject as _ClaudeFileWithProject, ClaudeTemplate } from '../lib/types';
import {
  claudeScanProjects,
  claudeGetScanConfig,
  claudeSetScanConfig,
  claudeReadInstructions,
  claudeListSkills,
  claudeListMemory,
  claudeReadSettings,
  claudeWriteFile,
  claudeDeleteSkill,
  claudeScanAllSkills,
  claudeScanAllMemory,
  claudeCopyFile,
  claudeDiffFile,
  claudeGetTemplates,
  claudeSetTemplates,
} from '../lib/tauri-api';

type SubTab = 'instructions' | 'skills' | 'memory' | 'settings';

export function createClaudeView(container: HTMLElement) {
  const wrapper = document.createElement('div');
  wrapper.className = 'claude-view';
  container.appendChild(wrapper);

  showProjectList();

  // ── Project List ────────────────────────────────────────────────────────

  async function showProjectList() {
    wrapper.innerHTML = '';

    let projects: ClaudeProject[] = [];
    try {
      projects = await claudeScanProjects();
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'error-state';
      errEl.textContent = `Error scanning projects: ${err}`;
      wrapper.appendChild(errEl);
      return;
    }

    // ── Summary Cards ──
    const summaryRow = document.createElement('div');
    summaryRow.className = 'claude-summary-row';

    const totalSkills = projects.reduce((s, p) => s + p.skill_count, 0);
    const totalMemory = projects.reduce((s, p) => s + p.memory_file_count, 0);
    const projectsWithSkills = projects.filter(p => p.skill_count > 0).length;
    const projectsWithMemory = projects.filter(p => p.memory_file_count > 0).length;
    const globalCount = projects.filter(p => p.is_global).length;
    const localCount = projects.length - globalCount;
    const warnings = projects.filter(p => !p.has_claude_md && !p.has_dot_claude_md);

    summaryRow.appendChild(createSummaryCard('Projects', `${projects.length}`, `${globalCount} global, ${localCount} local`));
    summaryRow.appendChild(createSummaryCard('Skills', `${totalSkills}`, `across ${projectsWithSkills} project${projectsWithSkills !== 1 ? 's' : ''}`));
    summaryRow.appendChild(createSummaryCard('Memory Files', `${totalMemory}`, `across ${projectsWithMemory} project${projectsWithMemory !== 1 ? 's' : ''}`));

    const warningCard = createSummaryCard('Warnings', `${warnings.length}`, warnings.length > 0 ? 'missing CLAUDE.md' : 'all good');
    if (warnings.length > 0) warningCard.classList.add('claude-summary-warn');
    warningCard.style.cursor = warnings.length > 0 ? 'pointer' : 'default';
    warningCard.addEventListener('click', () => {
      if (warnings.length > 0) {
        const first = wrapper.querySelector('.claude-project-card.has-warning');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    summaryRow.appendChild(warningCard);
    wrapper.appendChild(summaryRow);

    // ── Toolbar ──
    const toolbar = document.createElement('div');
    toolbar.className = 'claude-toolbar';

    const toolbarTitle = document.createElement('span');
    toolbarTitle.className = 'claude-toolbar-title';
    toolbarTitle.textContent = 'Projects';
    toolbar.appendChild(toolbarTitle);

    const toolbarBtns = document.createElement('div');
    toolbarBtns.className = 'claude-toolbar-btns';

    const editPathsBtn = document.createElement('button');
    editPathsBtn.className = 'claude-btn claude-btn-small';
    editPathsBtn.textContent = 'Scan Paths';
    editPathsBtn.addEventListener('click', async () => {
      const config = await claudeGetScanConfig();
      showScanPathsDialog(config.scan_paths);
    });
    toolbarBtns.appendChild(editPathsBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'claude-btn claude-btn-primary claude-btn-small';
    addBtn.textContent = '+ Add Project';
    addBtn.addEventListener('click', showAddProjectDialog);
    toolbarBtns.appendChild(addBtn);

    toolbar.appendChild(toolbarBtns);
    wrapper.appendChild(toolbar);

    // ── Project Grid ──
    const grid = document.createElement('div');
    grid.className = 'claude-project-grid';

    if (projects.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'claude-empty';
      empty.textContent = 'No Claude Code projects found. Configure scan paths or add a project manually.';
      grid.appendChild(empty);
    } else {
      for (const project of projects) {
        grid.appendChild(createProjectCard(project, warnings));
      }
    }
    wrapper.appendChild(grid);

    // ── Cross-Project Browser ──
    const browserSection = document.createElement('div');
    browserSection.className = 'claude-browser-section';

    const browserTabs = document.createElement('div');
    browserTabs.className = 'claude-browser-tabs';

    const browserContent = document.createElement('div');
    browserContent.className = 'claude-browser-content';

    type BrowserTab = 'skills' | 'memory' | 'templates';
    let activeBrowserTab: BrowserTab = 'skills';
    const browserTabDefs: { key: BrowserTab; label: string }[] = [
      { key: 'skills', label: 'All Skills' },
      { key: 'memory', label: 'All Memory' },
      { key: 'templates', label: 'Templates' },
    ];

    for (const def of browserTabDefs) {
      const btn = document.createElement('button');
      btn.className = 'claude-sub-tab';
      btn.textContent = def.label;
      if (def.key === activeBrowserTab) btn.classList.add('active');
      btn.addEventListener('click', () => {
        activeBrowserTab = def.key;
        browserTabs.querySelectorAll('.claude-sub-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadBrowserTab(activeBrowserTab, browserContent, projects);
      });
      browserTabs.appendChild(btn);
    }

    browserSection.appendChild(browserTabs);
    browserSection.appendChild(browserContent);
    wrapper.appendChild(browserSection);

    loadBrowserTab(activeBrowserTab, browserContent, projects);
  }

  function createSummaryCard(title: string, value: string, subtitle: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'claude-summary-card';

    const valueEl = document.createElement('div');
    valueEl.className = 'claude-summary-value';
    valueEl.textContent = value;
    card.appendChild(valueEl);

    const titleEl = document.createElement('div');
    titleEl.className = 'claude-summary-title';
    titleEl.textContent = title;
    card.appendChild(titleEl);

    const subEl = document.createElement('div');
    subEl.className = 'claude-summary-subtitle';
    subEl.textContent = subtitle;
    card.appendChild(subEl);

    return card;
  }

  function createProjectCard(project: ClaudeProject, warnings: ClaudeProject[]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'claude-project-card';
    const isWarning = warnings.some(w => w.path === project.path);
    if (isWarning) card.classList.add('has-warning');
    card.addEventListener('click', () => showProjectDetail(project));

    const nameRow = document.createElement('div');
    nameRow.className = 'claude-card-name';
    if (project.is_global) {
      const icon = document.createElement('span');
      icon.textContent = '\u2605 ';
      nameRow.appendChild(icon);
    }
    const nameText = document.createElement('span');
    nameText.textContent = project.name;
    nameRow.appendChild(nameText);

    if (isWarning) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'claude-warning-badge';
      warnBadge.textContent = '\u26A0';
      nameRow.appendChild(warnBadge);
    }
    card.appendChild(nameRow);

    if (!project.is_global) {
      const pathEl = document.createElement('div');
      pathEl.className = 'claude-card-path';
      pathEl.textContent = project.path;
      card.appendChild(pathEl);
    }

    const dots = document.createElement('div');
    dots.className = 'claude-health-dots';
    dots.appendChild(createHealthDot('CLAUDE.md', project.has_claude_md || project.has_dot_claude_md));
    dots.appendChild(createHealthDot('Settings', project.has_settings));
    dots.appendChild(createHealthDot(`${project.skill_count} skill${project.skill_count !== 1 ? 's' : ''}`, project.skill_count > 0));
    dots.appendChild(createHealthDot(`${project.memory_file_count} memory`, project.memory_file_count > 0));
    card.appendChild(dots);

    return card;
  }

  function createHealthDot(label: string, present: boolean): HTMLElement {
    const dot = document.createElement('span');
    dot.className = `claude-health-dot ${present ? 'present' : 'missing'}`;
    dot.textContent = `${present ? '\u25CF' : '\u25CB'} ${label}`;
    return dot;
  }

  async function loadBrowserTab(tab: 'skills' | 'memory' | 'templates', container: HTMLElement, projects: ClaudeProject[]) {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'claude-loading';
    loading.textContent = 'Loading...';
    container.appendChild(loading);

    try {
      switch (tab) {
        case 'skills':
          await renderBrowserSkills(container, projects);
          break;
        case 'memory':
          await renderBrowserMemory(container, projects);
          break;
        case 'templates':
          await renderBrowserTemplates(container, projects);
          break;
      }
    } catch (err) {
      container.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className = 'error-state';
      errEl.textContent = `Error: ${err}`;
      container.appendChild(errEl);
    }
  }

  async function renderBrowserSkills(container: HTMLElement, projects: ClaudeProject[]) {
    const allSkills = await claudeScanAllSkills();
    container.innerHTML = '';

    // Toolbar: search + filter
    const toolbar = document.createElement('div');
    toolbar.className = 'claude-browser-toolbar';

    const searchInput = document.createElement('input');
    searchInput.className = 'claude-browser-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search skills...';
    toolbar.appendChild(searchInput);

    const filterSelect = document.createElement('select');
    filterSelect.className = 'claude-browser-filter';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Projects';
    filterSelect.appendChild(allOption);
    const uniqueProjects = [...new Set(allSkills.map(s => s.project_name))];
    for (const pName of uniqueProjects) {
      const opt = document.createElement('option');
      opt.value = pName;
      opt.textContent = pName;
      filterSelect.appendChild(opt);
    }
    toolbar.appendChild(filterSelect);
    container.appendChild(toolbar);

    // Table
    const table = document.createElement('table');
    table.className = 'claude-browser-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Name</th><th>Project</th><th>Description</th><th></th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    container.appendChild(table);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'claude-browser-footer';
    container.appendChild(footer);

    function renderRows() {
      const query = searchInput.value.toLowerCase();
      const filterProject = filterSelect.value;

      const filtered = allSkills.filter(s => {
        const matchesSearch = !query ||
          (s.skill.name || '').toLowerCase().includes(query) ||
          (s.skill.description || '').toLowerCase().includes(query) ||
          s.skill.filename.toLowerCase().includes(query) ||
          s.skill.content.toLowerCase().includes(query);
        const matchesFilter = !filterProject || s.project_name === filterProject;
        return matchesSearch && matchesFilter;
      });

      tbody.innerHTML = '';
      const projectCount = new Set(filtered.map(s => s.project_name)).size;

      for (const item of filtered) {
        const tr = document.createElement('tr');
        tr.innerHTML = DOMPurify.sanitize(`
          <td class="claude-browser-name">${item.skill.name || item.skill.filename}</td>
          <td class="claude-browser-project">${item.project_name}</td>
          <td class="claude-browser-desc">${item.skill.description || ''}</td>
          <td class="claude-browser-actions"></td>
        `);

        // Copy dropdown in actions cell
        const actionsCell = tr.querySelector('.claude-browser-actions')!;
        const copyContainer = document.createElement('div');
        copyContainer.className = 'claude-copy-dropdown';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'claude-btn claude-btn-small';
        copyBtn.textContent = 'Copy \u25BE';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCopyMenu(copyContainer, item.project_path, `.claude/commands/${item.skill.filename}`, projects);
        });
        copyContainer.appendChild(copyBtn);
        actionsCell.appendChild(copyContainer);

        // Expand row on click
        let expanded = false;
        let expandedRow: HTMLTableRowElement | null = null;
        tr.addEventListener('click', () => {
          if (expanded && expandedRow) {
            expandedRow.remove();
            expandedRow = null;
            expanded = false;
            return;
          }
          expanded = true;
          expandedRow = document.createElement('tr');
          const expandedCell = document.createElement('td');
          expandedCell.colSpan = 4;
          expandedCell.className = 'claude-browser-expanded';

          const editor = document.createElement('textarea');
          editor.className = 'claude-editor';
          editor.value = item.skill.content;
          expandedCell.appendChild(editor);

          const btns = document.createElement('div');
          btns.className = 'claude-browser-expanded-btns';

          const saveBtn = document.createElement('button');
          saveBtn.className = 'claude-btn claude-btn-primary';
          saveBtn.textContent = 'Save';
          saveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await claudeWriteFile(item.project_path, `.claude/commands/${item.skill.filename}`, editor.value);
              item.skill.content = editor.value;
              saveBtn.textContent = 'Saved!';
              setTimeout(() => saveBtn.textContent = 'Save', 1500);
            } catch (err) {
              alert(`Failed to save: ${err}`);
            }
          });
          btns.appendChild(saveBtn);

          const diffBtn = document.createElement('button');
          diffBtn.className = 'claude-btn claude-btn-small';
          diffBtn.textContent = 'Diff';
          diffBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showDiffPicker(expandedCell, item.project_path, `.claude/commands/${item.skill.filename}`, projects);
          });
          btns.appendChild(diffBtn);

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'claude-btn claude-btn-danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete skill "${item.skill.name || item.skill.filename}" from ${item.project_name}?`)) return;
            try {
              await claudeDeleteSkill(item.project_path, item.skill.filename);
              renderBrowserSkills(container, projects);
            } catch (err) {
              alert(`Failed to delete: ${err}`);
            }
          });
          btns.appendChild(deleteBtn);

          expandedCell.appendChild(btns);
          expandedRow.appendChild(expandedCell);
          tr.after(expandedRow);
        });

        tbody.appendChild(tr);
      }

      footer.textContent = `Showing ${filtered.length} skill${filtered.length !== 1 ? 's' : ''} across ${projectCount} project${projectCount !== 1 ? 's' : ''}`;
    }

    searchInput.addEventListener('input', renderRows);
    filterSelect.addEventListener('change', renderRows);
    renderRows();
  }
  async function renderBrowserMemory(container: HTMLElement, projects: ClaudeProject[]) {
    const allMemory = await claudeScanAllMemory();
    container.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'claude-browser-toolbar';

    const searchInput = document.createElement('input');
    searchInput.className = 'claude-browser-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search memory files...';
    toolbar.appendChild(searchInput);

    const filterSelect = document.createElement('select');
    filterSelect.className = 'claude-browser-filter';
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Projects';
    filterSelect.appendChild(allOption);
    const uniqueProjects = [...new Set(allMemory.map(m => m.project_name))];
    for (const pName of uniqueProjects) {
      const opt = document.createElement('option');
      opt.value = pName;
      opt.textContent = pName;
      filterSelect.appendChild(opt);
    }
    toolbar.appendChild(filterSelect);
    container.appendChild(toolbar);

    const table = document.createElement('table');
    table.className = 'claude-browser-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Name</th><th>Project</th><th>Size</th><th>Modified</th><th></th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    container.appendChild(table);

    const footer = document.createElement('div');
    footer.className = 'claude-browser-footer';
    container.appendChild(footer);

    function renderRows() {
      const query = searchInput.value.toLowerCase();
      const filterProject = filterSelect.value;

      const filtered = allMemory.filter(m => {
        const matchesSearch = !query ||
          m.file.name.toLowerCase().includes(query) ||
          m.file.content.toLowerCase().includes(query);
        const matchesFilter = !filterProject || m.project_name === filterProject;
        return matchesSearch && matchesFilter;
      });

      tbody.innerHTML = '';
      const projectCount = new Set(filtered.map(m => m.project_name)).size;

      for (const item of filtered) {
        const sizeKb = (item.file.size / 1024).toFixed(1);
        const modified = item.file.modified ? new Date(item.file.modified).toLocaleDateString() : '-';

        const tr = document.createElement('tr');
        tr.innerHTML = DOMPurify.sanitize(`
          <td class="claude-browser-name">${item.file.name}</td>
          <td class="claude-browser-project">${item.project_name}</td>
          <td>${sizeKb} KB</td>
          <td>${modified}</td>
          <td class="claude-browser-actions"></td>
        `);

        const actionsCell = tr.querySelector('.claude-browser-actions')!;
        const copyContainer = document.createElement('div');
        copyContainer.className = 'claude-copy-dropdown';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'claude-btn claude-btn-small';
        copyBtn.textContent = 'Copy \u25BE';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCopyMenu(copyContainer, item.project_path, item.file.relative_path, projects);
        });
        copyContainer.appendChild(copyBtn);
        actionsCell.appendChild(copyContainer);

        let expanded = false;
        let expandedRow: HTMLTableRowElement | null = null;
        tr.addEventListener('click', () => {
          if (expanded && expandedRow) {
            expandedRow.remove();
            expandedRow = null;
            expanded = false;
            return;
          }
          expanded = true;
          expandedRow = document.createElement('tr');
          const expandedCell = document.createElement('td');
          expandedCell.colSpan = 5;
          expandedCell.className = 'claude-browser-expanded';

          const editor = document.createElement('textarea');
          editor.className = 'claude-editor';
          editor.value = item.file.content;
          expandedCell.appendChild(editor);

          const btns = document.createElement('div');
          btns.className = 'claude-browser-expanded-btns';

          const saveBtn = document.createElement('button');
          saveBtn.className = 'claude-btn claude-btn-primary';
          saveBtn.textContent = 'Save';
          saveBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await claudeWriteFile(item.project_path, item.file.relative_path, editor.value);
              item.file.content = editor.value;
              saveBtn.textContent = 'Saved!';
              setTimeout(() => saveBtn.textContent = 'Save', 1500);
            } catch (err) {
              alert(`Failed to save: ${err}`);
            }
          });
          btns.appendChild(saveBtn);

          const diffBtn = document.createElement('button');
          diffBtn.className = 'claude-btn claude-btn-small';
          diffBtn.textContent = 'Diff';
          diffBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showDiffPicker(expandedCell, item.project_path, item.file.relative_path, projects);
          });
          btns.appendChild(diffBtn);

          expandedCell.appendChild(btns);
          expandedRow.appendChild(expandedCell);
          tr.after(expandedRow);
        });

        tbody.appendChild(tr);
      }

      footer.textContent = `Showing ${filtered.length} memory file${filtered.length !== 1 ? 's' : ''} across ${projectCount} project${projectCount !== 1 ? 's' : ''}`;
    }

    searchInput.addEventListener('input', renderRows);
    filterSelect.addEventListener('change', renderRows);
    renderRows();
  }
  async function renderBrowserTemplates(container: HTMLElement, projects: ClaudeProject[]) {
    let templates = await claudeGetTemplates();
    container.innerHTML = '';

    const headerRow = document.createElement('div');
    headerRow.className = 'claude-section-header';
    const newBtn = document.createElement('button');
    newBtn.className = 'claude-btn claude-btn-primary';
    newBtn.textContent = '+ New Template';
    newBtn.addEventListener('click', () => showNewTemplateDialog(container, projects));
    headerRow.appendChild(newBtn);
    container.appendChild(headerRow);

    if (templates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'claude-empty';
      empty.textContent = 'No templates yet. Create one to bundle skills and memory files for easy reuse.';
      container.appendChild(empty);
      return;
    }

    for (const template of templates) {
      const card = document.createElement('div');
      card.className = 'claude-template-card';

      const nameEl = document.createElement('div');
      nameEl.className = 'claude-template-name';
      nameEl.textContent = template.name;
      card.appendChild(nameEl);

      const skillEntries = template.entries.filter(e => e.relative_path.includes('/commands/'));
      const memoryEntries = template.entries.filter(e => e.relative_path.includes('/memory/'));
      const meta = document.createElement('div');
      meta.className = 'claude-template-meta';
      const parts: string[] = [];
      if (skillEntries.length > 0) parts.push(`${skillEntries.length} skill${skillEntries.length !== 1 ? 's' : ''}`);
      if (memoryEntries.length > 0) parts.push(`${memoryEntries.length} memory file${memoryEntries.length !== 1 ? 's' : ''}`);
      meta.textContent = parts.join(', ') || 'Empty template';
      card.appendChild(meta);

      const list = document.createElement('ul');
      list.className = 'claude-template-entries';
      for (const entry of template.entries) {
        const li = document.createElement('li');
        const fileName = entry.relative_path.split('/').pop() || entry.relative_path;
        const type = entry.relative_path.includes('/commands/') ? 'skill' : 'memory';
        li.textContent = `${fileName} (${type})`;
        list.appendChild(li);
      }
      card.appendChild(list);

      const btns = document.createElement('div');
      btns.className = 'claude-template-btns';

      const applyContainer = document.createElement('div');
      applyContainer.className = 'claude-copy-dropdown';
      const applyBtn = document.createElement('button');
      applyBtn.className = 'claude-btn claude-btn-primary claude-btn-small';
      applyBtn.textContent = 'Apply to Project \u25BE';
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleApplyMenu(applyContainer, template, projects);
      });
      applyContainer.appendChild(applyBtn);
      btns.appendChild(applyContainer);

      const editBtn = document.createElement('button');
      editBtn.className = 'claude-btn claude-btn-small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => showEditTemplateDialog(container, projects, template));
      btns.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'claude-btn claude-btn-danger claude-btn-small';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete template "${template.name}"?`)) return;
        templates = templates.filter(t => t.name !== template.name);
        await claudeSetTemplates(templates);
        renderBrowserTemplates(container, projects);
      });
      btns.appendChild(deleteBtn);

      card.appendChild(btns);
      container.appendChild(card);
    }
  }

  function toggleCopyMenu(container: HTMLElement, sourceProject: string, relativePath: string, projects: ClaudeProject[]) {
    const existing = container.querySelector('.claude-copy-menu');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.className = 'claude-copy-menu';

    for (const project of projects) {
      if (project.path === sourceProject) continue;
      const menuItem = document.createElement('button');
      menuItem.className = 'claude-copy-menu-item';
      menuItem.textContent = project.name;
      menuItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await claudeCopyFile(sourceProject, relativePath, project.path);
          menu.remove();
          alert(`Copied to ${project.name}`);
        } catch (err) {
          alert(`Failed to copy: ${err}`);
        }
      });
      menu.appendChild(menuItem);
    }

    container.appendChild(menu);

    const close = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  function toggleApplyMenu(container: HTMLElement, template: ClaudeTemplate, projects: ClaudeProject[]) {
    const existing = container.querySelector('.claude-copy-menu');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.className = 'claude-copy-menu';

    for (const project of projects) {
      const menuItem = document.createElement('button');
      menuItem.className = 'claude-copy-menu-item';
      menuItem.textContent = project.name;
      menuItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        let copied = 0;
        let skipped = 0;
        for (const entry of template.entries) {
          try {
            await claudeCopyFile(entry.source_project, entry.relative_path, project.path);
            copied++;
          } catch {
            skipped++;
          }
        }
        menu.remove();
        alert(`Applied "${template.name}" to ${project.name}: ${copied} copied, ${skipped} skipped.`);
      });
      menu.appendChild(menuItem);
    }

    container.appendChild(menu);
    const close = (e: MouseEvent) => {
      if (!container.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  async function showNewTemplateDialog(browserContainer: HTMLElement, projects: ClaudeProject[]) {
    const allSkills = await claudeScanAllSkills();
    const allMemory = await claudeScanAllMemory();

    const dialog = document.createElement('div');
    dialog.className = 'claude-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'claude-dialog';
    box.style.maxWidth = '500px';

    const title = document.createElement('h3');
    title.textContent = 'New Template';
    box.appendChild(title);

    const nameInput = document.createElement('input');
    nameInput.className = 'claude-input';
    nameInput.placeholder = 'Template name';
    box.appendChild(nameInput);

    const hint = document.createElement('p');
    hint.className = 'claude-hint';
    hint.textContent = 'Select files to include:';
    hint.style.marginTop = '12px';
    box.appendChild(hint);

    const checkboxList = document.createElement('div');
    checkboxList.style.maxHeight = '300px';
    checkboxList.style.overflowY = 'auto';
    checkboxList.style.marginBottom = '12px';

    interface CheckboxItem { label: string; sourceProject: string; relativePath: string; checked: boolean; }
    const items: CheckboxItem[] = [];

    for (const s of allSkills) {
      items.push({
        label: `${s.skill.name || s.skill.filename} (${s.project_name})`,
        sourceProject: s.project_path,
        relativePath: `.claude/commands/${s.skill.filename}`,
        checked: false,
      });
    }
    for (const m of allMemory) {
      items.push({
        label: `${m.file.name} (${m.project_name})`,
        sourceProject: m.project_path,
        relativePath: m.file.relative_path,
        checked: false,
      });
    }

    for (const item of items) {
      const row = document.createElement('label');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '4px 0';
      row.style.fontSize = '13px';
      row.style.cursor = 'pointer';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.addEventListener('change', () => item.checked = checkbox.checked);
      row.appendChild(checkbox);

      const text = document.createTextNode(item.label);
      row.appendChild(text);

      checkboxList.appendChild(row);
    }
    box.appendChild(checkboxList);

    const btnRow = document.createElement('div');
    btnRow.className = 'claude-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'claude-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dialog.remove());
    btnRow.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'claude-btn claude-btn-primary';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { alert('Please enter a template name.'); return; }
      const selected = items.filter(i => i.checked);
      if (selected.length === 0) { alert('Please select at least one file.'); return; }

      const newTemplate: ClaudeTemplate = {
        name,
        entries: selected.map(i => ({ source_project: i.sourceProject, relative_path: i.relativePath })),
      };

      const templates = await claudeGetTemplates();
      templates.push(newTemplate);
      await claudeSetTemplates(templates);

      dialog.remove();
      renderBrowserTemplates(browserContainer, projects);
    });
    btnRow.appendChild(createBtn);

    box.appendChild(btnRow);
    dialog.appendChild(box);
    wrapper.appendChild(dialog);
  }

  async function showEditTemplateDialog(browserContainer: HTMLElement, projects: ClaudeProject[], template: ClaudeTemplate) {
    const allSkills = await claudeScanAllSkills();
    const allMemory = await claudeScanAllMemory();

    const dialog = document.createElement('div');
    dialog.className = 'claude-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'claude-dialog';
    box.style.maxWidth = '500px';

    const title = document.createElement('h3');
    title.textContent = `Edit: ${template.name}`;
    box.appendChild(title);

    const nameInput = document.createElement('input');
    nameInput.className = 'claude-input';
    nameInput.value = template.name;
    box.appendChild(nameInput);

    const hint = document.createElement('p');
    hint.className = 'claude-hint';
    hint.textContent = 'Select files to include:';
    hint.style.marginTop = '12px';
    box.appendChild(hint);

    const checkboxList = document.createElement('div');
    checkboxList.style.maxHeight = '300px';
    checkboxList.style.overflowY = 'auto';
    checkboxList.style.marginBottom = '12px';

    interface CheckboxItem { label: string; sourceProject: string; relativePath: string; checked: boolean; }
    const items: CheckboxItem[] = [];

    for (const s of allSkills) {
      const rp = `.claude/commands/${s.skill.filename}`;
      const isIncluded = template.entries.some(e => e.source_project === s.project_path && e.relative_path === rp);
      items.push({ label: `${s.skill.name || s.skill.filename} (${s.project_name})`, sourceProject: s.project_path, relativePath: rp, checked: isIncluded });
    }
    for (const m of allMemory) {
      const isIncluded = template.entries.some(e => e.source_project === m.project_path && e.relative_path === m.file.relative_path);
      items.push({ label: `${m.file.name} (${m.project_name})`, sourceProject: m.project_path, relativePath: m.file.relative_path, checked: isIncluded });
    }

    for (const item of items) {
      const row = document.createElement('label');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.padding = '4px 0';
      row.style.fontSize = '13px';
      row.style.cursor = 'pointer';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.checked;
      checkbox.addEventListener('change', () => item.checked = checkbox.checked);
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(item.label));
      checkboxList.appendChild(row);
    }
    box.appendChild(checkboxList);

    const btnRow = document.createElement('div');
    btnRow.className = 'claude-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'claude-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dialog.remove());
    btnRow.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'claude-btn claude-btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { alert('Please enter a template name.'); return; }
      const selected = items.filter(i => i.checked);

      const templates = await claudeGetTemplates();
      const idx = templates.findIndex(t => t.name === template.name);
      if (idx >= 0) {
        templates[idx] = { name, entries: selected.map(i => ({ source_project: i.sourceProject, relative_path: i.relativePath })) };
      }
      await claudeSetTemplates(templates);
      dialog.remove();
      renderBrowserTemplates(browserContainer, projects);
    });
    btnRow.appendChild(saveBtn);

    box.appendChild(btnRow);
    dialog.appendChild(box);
    wrapper.appendChild(dialog);
  }

  async function showDiffPicker(container: HTMLElement, sourceProject: string, relativePath: string, projects: ClaudeProject[]) {
    const existingDiff = container.querySelector('.claude-diff-container');
    if (existingDiff) { existingDiff.remove(); return; }

    const otherProjects = projects.filter(p => p.path !== sourceProject);
    if (otherProjects.length === 0) {
      alert('No other projects to diff against.');
      return;
    }

    if (otherProjects.length === 1) {
      await renderDiff(container, sourceProject, otherProjects[0].path, otherProjects[0].name, relativePath);
    } else {
      const picker = document.createElement('select');
      picker.className = 'claude-browser-filter';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Compare with...';
      picker.appendChild(defaultOpt);
      for (const p of otherProjects) {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.name;
        picker.appendChild(opt);
      }
      picker.addEventListener('change', async () => {
        picker.remove();
        const targetPath = picker.value;
        const target = otherProjects.find(p => p.path === targetPath);
        if (target) await renderDiff(container, sourceProject, target.path, target.name, relativePath);
      });
      container.appendChild(picker);
    }
  }

  async function renderDiff(container: HTMLElement, projectA: string, projectB: string, projectBName: string, relativePath: string) {
    try {
      const [contentA, contentB] = await claudeDiffFile(projectA, projectB, relativePath);

      const diffContainer = document.createElement('div');
      diffContainer.className = 'claude-diff-container';

      const paneA = document.createElement('div');
      paneA.className = 'claude-diff-pane';
      const headerA = document.createElement('div');
      headerA.className = 'claude-diff-pane-header';
      headerA.textContent = 'Current';
      paneA.appendChild(headerA);
      renderDiffLines(contentA, contentB, paneA);

      const paneB = document.createElement('div');
      paneB.className = 'claude-diff-pane';
      const headerB = document.createElement('div');
      headerB.className = 'claude-diff-pane-header';
      headerB.textContent = projectBName;
      paneB.appendChild(headerB);
      renderDiffLines(contentB, contentA, paneB);

      diffContainer.appendChild(paneA);
      diffContainer.appendChild(paneB);
      container.appendChild(diffContainer);
    } catch (err) {
      alert(`Diff failed: ${err}`);
    }
  }

  function renderDiffLines(content: string, other: string, pane: HTMLElement) {
    const lines = content.split('\n');
    const otherLines = new Set(other.split('\n'));

    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'claude-diff-line';
      if (line.trim() && !otherLines.has(line)) {
        lineEl.classList.add('removed');
      }
      lineEl.textContent = line || ' ';
      pane.appendChild(lineEl);
    }
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────

  async function showScanPathsDialog(currentPaths: string[]) {
    const dialog = document.createElement('div');
    dialog.className = 'claude-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'claude-dialog';

    const dialogTitle = document.createElement('h3');
    dialogTitle.textContent = 'Edit Scan Paths';
    box.appendChild(dialogTitle);

    const hint = document.createElement('p');
    hint.className = 'claude-hint';
    hint.textContent = 'One directory path per line. Kept will scan each for subdirectories containing .claude/ or CLAUDE.md.';
    box.appendChild(hint);

    const textarea = document.createElement('textarea');
    textarea.className = 'claude-textarea';
    textarea.rows = 5;
    textarea.value = currentPaths.join('\n');
    box.appendChild(textarea);

    const btnRow = document.createElement('div');
    btnRow.className = 'claude-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'claude-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dialog.remove());
    btnRow.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'claude-btn claude-btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const paths = textarea.value
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      try {
        const config = await claudeGetScanConfig();
        await claudeSetScanConfig({ scan_paths: paths, pinned_projects: config.pinned_projects });
        dialog.remove();
        showProjectList();
      } catch (err) {
        alert(`Failed to save: ${err}`);
      }
    });
    btnRow.appendChild(saveBtn);

    box.appendChild(btnRow);
    dialog.appendChild(box);
    wrapper.appendChild(dialog);
  }

  async function showAddProjectDialog() {
    const dialog = document.createElement('div');
    dialog.className = 'claude-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'claude-dialog';

    const dialogTitle = document.createElement('h3');
    dialogTitle.textContent = 'Add Project';
    box.appendChild(dialogTitle);

    const hint = document.createElement('p');
    hint.className = 'claude-hint';
    hint.textContent = 'Enter the full path to a project directory:';
    box.appendChild(hint);

    const input = document.createElement('input');
    input.className = 'claude-input';
    input.type = 'text';
    input.placeholder = 'C:/Users/you/Projects/my-project';
    box.appendChild(input);

    const btnRow = document.createElement('div');
    btnRow.className = 'claude-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'claude-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dialog.remove());
    btnRow.appendChild(cancelBtn);

    const addBtn = document.createElement('button');
    addBtn.className = 'claude-btn claude-btn-primary';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', async () => {
      const path = input.value.trim();
      if (!path) return;
      try {
        const config = await claudeGetScanConfig();
        if (!config.pinned_projects.includes(path)) {
          config.pinned_projects.push(path);
          await claudeSetScanConfig(config);
        }
        dialog.remove();
        showProjectList();
      } catch (err) {
        alert(`Failed to add project: ${err}`);
      }
    });
    btnRow.appendChild(addBtn);

    box.appendChild(btnRow);
    dialog.appendChild(box);
    wrapper.appendChild(dialog);
  }

  // ── Project Detail View ─────────────────────────────────────────────────

  async function showProjectDetail(project: ClaudeProject) {
    wrapper.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'claude-detail-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'claude-btn claude-btn-back';
    backBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:inline-block;vertical-align:middle;margin-right:2px"><path d="M10 4L6 8L10 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Back';
    backBtn.addEventListener('click', () => showProjectList());
    header.appendChild(backBtn);

    const nameEl = document.createElement('h2');
    nameEl.className = 'claude-detail-name';
    nameEl.textContent = project.name;
    header.appendChild(nameEl);

    if (!project.is_global) {
      const pathEl = document.createElement('div');
      pathEl.className = 'claude-detail-path';
      pathEl.textContent = project.path;
      header.appendChild(pathEl);
    }

    wrapper.appendChild(header);

    const tabBar = document.createElement('div');
    tabBar.className = 'claude-tab-bar';
    const tabs: SubTab[] = ['instructions', 'skills', 'memory', 'settings'];
    const tabLabels: Record<SubTab, string> = {
      instructions: 'Instructions',
      skills: 'Skills',
      memory: 'Memory',
      settings: 'Settings',
    };
    const tabContent = document.createElement('div');
    tabContent.className = 'claude-tab-content';

    let activeTab: SubTab = 'instructions';

    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'claude-sub-tab';
      btn.textContent = tabLabels[tab];
      if (tab === activeTab) btn.classList.add('active');
      btn.addEventListener('click', () => {
        activeTab = tab;
        tabBar.querySelectorAll('.claude-sub-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        loadTabContent(project, tab, tabContent);
      });
      tabBar.appendChild(btn);
    }

    wrapper.appendChild(tabBar);
    wrapper.appendChild(tabContent);

    loadTabContent(project, activeTab, tabContent);
  }

  async function loadTabContent(project: ClaudeProject, tab: SubTab, container: HTMLElement) {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'claude-loading';
    loading.textContent = 'Loading...';
    container.appendChild(loading);

    try {
      switch (tab) {
        case 'instructions':
          await renderInstructions(project, container);
          break;
        case 'skills':
          await renderSkills(project, container);
          break;
        case 'memory':
          await renderMemory(project, container);
          break;
        case 'settings':
          await renderSettings(project, container);
          break;
      }
    } catch (err) {
      container.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className = 'error-state';
      errEl.textContent = `Error: ${err}`;
      container.appendChild(errEl);
    }
  }

  // ── Instructions Tab ────────────────────────────────────────────────────

  async function renderInstructions(project: ClaudeProject, container: HTMLElement) {
    const files = await claudeReadInstructions(project.path);
    container.innerHTML = '';

    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'claude-empty';
      empty.textContent = 'No CLAUDE.md files found.';

      const createBtn = document.createElement('button');
      createBtn.className = 'claude-btn claude-btn-primary';
      createBtn.textContent = 'Create CLAUDE.md';
      createBtn.style.marginTop = '12px';
      createBtn.addEventListener('click', async () => {
        await claudeWriteFile(project.path, 'CLAUDE.md', '# Project Instructions\n\n');
        loadTabContent(project, 'instructions', container);
      });

      container.appendChild(empty);
      container.appendChild(createBtn);
      return;
    }

    for (const file of files) {
      const section = document.createElement('div');
      section.className = 'claude-file-section';

      const fileHeader = document.createElement('div');
      fileHeader.className = 'claude-file-header';

      const fileName = document.createElement('span');
      fileName.className = 'claude-file-name';
      fileName.textContent = file.name;
      fileHeader.appendChild(fileName);

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'claude-btn claude-btn-small';
      toggleBtn.textContent = 'Edit';
      fileHeader.appendChild(toggleBtn);

      section.appendChild(fileHeader);

      const structuredView = document.createElement('div');
      structuredView.className = 'claude-structured-view';
      renderStructuredMarkdown(file.content, structuredView);
      section.appendChild(structuredView);

      const rawView = document.createElement('div');
      rawView.className = 'claude-raw-view';
      rawView.style.display = 'none';

      const editor = document.createElement('textarea');
      editor.className = 'claude-editor';
      editor.value = file.content;
      rawView.appendChild(editor);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'claude-btn claude-btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        try {
          await claudeWriteFile(project.path, file.relative_path, editor.value);
          file.content = editor.value;
          renderStructuredMarkdown(editor.value, structuredView);
          saveBtn.textContent = 'Saved!';
          setTimeout(() => (saveBtn.textContent = 'Save'), 1500);
        } catch (err) {
          alert(`Failed to save: ${err}`);
        }
      });
      rawView.appendChild(saveBtn);

      section.appendChild(rawView);

      let showingRaw = false;
      toggleBtn.addEventListener('click', () => {
        showingRaw = !showingRaw;
        structuredView.style.display = showingRaw ? 'none' : 'block';
        rawView.style.display = showingRaw ? 'block' : 'none';
        toggleBtn.textContent = showingRaw ? 'Structured' : 'Edit';
      });

      container.appendChild(section);
    }
  }

  function renderStructuredMarkdown(content: string, container: HTMLElement) {
    container.innerHTML = '';
    const sections = parseMarkdownSections(content);

    for (const section of sections) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'claude-section';

      if (section.heading) {
        const heading = document.createElement('div');
        heading.className = 'claude-section-heading';
        heading.textContent = section.heading;
        sectionEl.appendChild(heading);
      }

      const body = document.createElement('div');
      body.className = 'claude-section-body';
      body.textContent = section.body.trim();
      sectionEl.appendChild(body);

      container.appendChild(sectionEl);
    }
  }

  function parseMarkdownSections(content: string): { heading: string | null; body: string }[] {
    const lines = content.split('\n');
    const sections: { heading: string | null; body: string }[] = [];
    let currentHeading: string | null = null;
    let currentBody: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)/);
      if (headingMatch) {
        if (currentHeading !== null || currentBody.length > 0) {
          sections.push({ heading: currentHeading, body: currentBody.join('\n') });
        }
        currentHeading = headingMatch[1];
        currentBody = [];
      } else {
        currentBody.push(line);
      }
    }

    if (currentHeading !== null || currentBody.length > 0) {
      sections.push({ heading: currentHeading, body: currentBody.join('\n') });
    }

    return sections;
  }

  // ── Skills Tab ──────────────────────────────────────────────────────────

  async function renderSkills(project: ClaudeProject, container: HTMLElement) {
    const skills = await claudeListSkills(project.path);
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'claude-section-header';
    const newBtn = document.createElement('button');
    newBtn.className = 'claude-btn claude-btn-primary';
    newBtn.textContent = '+ New Skill';
    newBtn.addEventListener('click', () => showNewSkillDialog(project, container));
    header.appendChild(newBtn);
    container.appendChild(header);

    if (skills.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'claude-empty';
      empty.textContent = 'No skills found in .claude/commands/';
      container.appendChild(empty);
      return;
    }

    for (const skill of skills) {
      const card = document.createElement('div');
      card.className = 'claude-skill-card';

      const nameRow = document.createElement('div');
      nameRow.className = 'claude-skill-name';
      nameRow.textContent = skill.name || skill.filename;
      card.appendChild(nameRow);

      if (skill.description) {
        const desc = document.createElement('div');
        desc.className = 'claude-skill-desc';
        desc.textContent = skill.description;
        card.appendChild(desc);
      }

      const filenameEl = document.createElement('div');
      filenameEl.className = 'claude-skill-filename';
      filenameEl.textContent = skill.filename;
      card.appendChild(filenameEl);

      const contentEl = document.createElement('div');
      contentEl.className = 'claude-skill-content';
      contentEl.style.display = 'none';

      const editor = document.createElement('textarea');
      editor.className = 'claude-editor';
      editor.value = skill.content;
      contentEl.appendChild(editor);

      const btnRow = document.createElement('div');
      btnRow.className = 'claude-skill-btns';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'claude-btn claude-btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        try {
          await claudeWriteFile(project.path, `.claude/commands/${skill.filename}`, editor.value);
          saveBtn.textContent = 'Saved!';
          setTimeout(() => (saveBtn.textContent = 'Save'), 1500);
        } catch (err) {
          alert(`Failed to save: ${err}`);
        }
      });
      btnRow.appendChild(saveBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'claude-btn claude-btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete skill "${skill.name || skill.filename}"?`)) return;
        try {
          await claudeDeleteSkill(project.path, skill.filename);
          renderSkills(project, container);
        } catch (err) {
          alert(`Failed to delete: ${err}`);
        }
      });
      btnRow.appendChild(deleteBtn);

      contentEl.appendChild(btnRow);
      card.appendChild(contentEl);

      let expanded = false;
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        expanded = !expanded;
        contentEl.style.display = expanded ? 'block' : 'none';
      });

      container.appendChild(card);
    }
  }

  function showNewSkillDialog(project: ClaudeProject, container: HTMLElement) {
    const dialog = document.createElement('div');
    dialog.className = 'claude-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'claude-dialog';

    const dialogTitle = document.createElement('h3');
    dialogTitle.textContent = 'New Skill';
    box.appendChild(dialogTitle);

    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Filename (e.g. my-skill.md):';
    box.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.className = 'claude-input';
    nameInput.placeholder = 'my-skill.md';
    box.appendChild(nameInput);

    const contentLabel = document.createElement('label');
    contentLabel.textContent = 'Content:';
    contentLabel.style.marginTop = '8px';
    box.appendChild(contentLabel);

    const contentInput = document.createElement('textarea');
    contentInput.className = 'claude-textarea';
    contentInput.rows = 10;
    contentInput.value = '---\nname: \ndescription: \n---\n\n';
    box.appendChild(contentInput);

    const btnRow = document.createElement('div');
    btnRow.className = 'claude-dialog-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'claude-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dialog.remove());
    btnRow.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'claude-btn claude-btn-primary';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', async () => {
      let filename = nameInput.value.trim();
      if (!filename) return;
      if (!filename.endsWith('.md')) filename += '.md';
      try {
        await claudeWriteFile(project.path, `.claude/commands/${filename}`, contentInput.value);
        dialog.remove();
        renderSkills(project, container);
      } catch (err) {
        alert(`Failed to create skill: ${err}`);
      }
    });
    btnRow.appendChild(createBtn);

    box.appendChild(btnRow);
    dialog.appendChild(box);
    wrapper.appendChild(dialog);
  }

  // ── Memory Tab ──────────────────────────────────────────────────────────

  async function renderMemory(project: ClaudeProject, container: HTMLElement) {
    const files = await claudeListMemory(project.path);
    container.innerHTML = '';

    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'claude-empty';
      empty.textContent = 'No memory files found.';
      container.appendChild(empty);
      return;
    }

    for (const file of files) {
      const section = document.createElement('div');
      section.className = 'claude-memory-card';

      const headerEl = document.createElement('div');
      headerEl.className = 'claude-memory-header';

      const nameEl = document.createElement('span');
      nameEl.className = 'claude-memory-name';
      nameEl.textContent = file.name;
      headerEl.appendChild(nameEl);

      const metaEl = document.createElement('span');
      metaEl.className = 'claude-memory-meta';
      const sizeKb = (file.size / 1024).toFixed(1);
      metaEl.textContent = `${sizeKb} KB`;
      if (file.modified) {
        metaEl.textContent += ` \u00b7 ${new Date(file.modified).toLocaleDateString()}`;
      }
      headerEl.appendChild(metaEl);

      section.appendChild(headerEl);

      const pathEl = document.createElement('div');
      pathEl.className = 'claude-memory-path';
      pathEl.textContent = file.relative_path;
      section.appendChild(pathEl);

      const contentEl = document.createElement('div');
      contentEl.className = 'claude-memory-content';
      contentEl.style.display = 'none';

      const editor = document.createElement('textarea');
      editor.className = 'claude-editor';
      editor.value = file.content;
      contentEl.appendChild(editor);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'claude-btn claude-btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        try {
          await claudeWriteFile(project.path, file.relative_path, editor.value);
          saveBtn.textContent = 'Saved!';
          setTimeout(() => (saveBtn.textContent = 'Save'), 1500);
        } catch (err) {
          alert(`Failed to save: ${err}`);
        }
      });
      contentEl.appendChild(saveBtn);
      section.appendChild(contentEl);

      let expanded = false;
      section.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        expanded = !expanded;
        contentEl.style.display = expanded ? 'block' : 'none';
      });

      container.appendChild(section);
    }
  }

  // ── Settings Tab ────────────────────────────────────────────────────────

  async function renderSettings(project: ClaudeProject, container: HTMLElement) {
    const files = await claudeReadSettings(project.path);
    container.innerHTML = '';

    if (files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'claude-empty';
      empty.textContent = 'No .claude/settings.json or settings.local.json found.';

      const createBtn = document.createElement('button');
      createBtn.className = 'claude-btn claude-btn-primary';
      createBtn.textContent = 'Create settings.json';
      createBtn.style.marginTop = '12px';
      createBtn.addEventListener('click', async () => {
        await claudeWriteFile(project.path, '.claude/settings.json', '{\n  \n}\n');
        renderSettings(project, container);
      });

      container.appendChild(empty);
      container.appendChild(createBtn);
      return;
    }

    for (const file of files) {
      const section = document.createElement('div');
      section.className = 'claude-file-section';

      const fileHeader = document.createElement('div');
      fileHeader.className = 'claude-file-header';

      const fileName = document.createElement('span');
      fileName.className = 'claude-file-name';
      fileName.textContent = file.name;
      fileHeader.appendChild(fileName);

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'claude-btn claude-btn-small';
      toggleBtn.textContent = 'Edit';
      fileHeader.appendChild(toggleBtn);

      section.appendChild(fileHeader);

      // Structured view
      const structuredView = document.createElement('div');
      structuredView.className = 'claude-settings-structured';
      try {
        const parsed = JSON.parse(file.content);
        renderSettingsForm(parsed, structuredView);
      } catch {
        const hint = document.createElement('div');
        hint.className = 'claude-hint';
        hint.textContent = 'Could not parse as JSON. Use raw editor.';
        structuredView.appendChild(hint);
      }
      section.appendChild(structuredView);

      // Raw editor (hidden by default)
      const rawView = document.createElement('div');
      rawView.className = 'claude-raw-view';
      rawView.style.display = 'none';

      const editor = document.createElement('textarea');
      editor.className = 'claude-editor claude-editor-tall';
      editor.value = file.content;
      rawView.appendChild(editor);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'claude-btn claude-btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        try {
          JSON.parse(editor.value);
        } catch {
          alert('Invalid JSON. Please fix syntax errors before saving.');
          return;
        }
        try {
          await claudeWriteFile(project.path, file.relative_path, editor.value);
          file.content = editor.value;
          structuredView.innerHTML = '';
          try {
            renderSettingsForm(JSON.parse(editor.value), structuredView);
          } catch { /* leave empty */ }
          saveBtn.textContent = 'Saved!';
          setTimeout(() => (saveBtn.textContent = 'Save'), 1500);
        } catch (err) {
          alert(`Failed to save: ${err}`);
        }
      });
      rawView.appendChild(saveBtn);
      section.appendChild(rawView);

      let showingRaw = false;
      toggleBtn.addEventListener('click', () => {
        showingRaw = !showingRaw;
        structuredView.style.display = showingRaw ? 'none' : 'block';
        rawView.style.display = showingRaw ? 'block' : 'none';
        toggleBtn.textContent = showingRaw ? 'Structured' : 'Edit';
      });

      container.appendChild(section);
    }
  }

  function renderSettingsForm(settings: Record<string, unknown>, container: HTMLElement) {
    container.innerHTML = '';
    for (const [key, value] of Object.entries(settings)) {
      const row = document.createElement('div');
      row.className = 'claude-settings-row';

      const label = document.createElement('span');
      label.className = 'claude-settings-key';
      label.textContent = key;
      row.appendChild(label);

      const val = document.createElement('span');
      val.className = 'claude-settings-value';
      if (typeof value === 'object' && value !== null) {
        val.textContent = JSON.stringify(value, null, 2);
        val.style.whiteSpace = 'pre';
        val.style.fontFamily = 'monospace';
      } else {
        val.textContent = String(value);
      }
      row.appendChild(val);

      container.appendChild(row);
    }
  }
}
