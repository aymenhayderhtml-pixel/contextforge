/**
 * public/js/workstation/inspector-pane.js
 * Right Pane: Quiet Context Inspector & Collapsible Deep Inspection Details.
 */

import { state } from '../state.js';
import { projectDiskFiles } from '../sidebar/tree.js';
import { getHistoryStatus, performUndo, performRedo } from '../history/history.js';
import { showToast } from '../shared/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let isDetailsOpen = false;
let rankedFilesData = [];
let onFileSelectionChange = null;
const wsCollapsedFolders = new Set();
let wsFileSearchFilter = '';

export function initInspectorPane(container, { onSelectionChange }) {
  if (!container) return;
  onFileSelectionChange = onSelectionChange;
  renderInspectorPane(container);
}

export function setInspectorRankedFiles(files) {
  rankedFilesData = Array.isArray(files) ? files : [];
  const container = document.getElementById('ws-pane-inspector');
  if (container) renderInspectorPane(container);
}

export function renderInspectorPane(container) {
  if (!container) return;

  const ws = state.workstation;
  const availableFiles = (projectDiskFiles && projectDiskFiles.length > 0)
    ? projectDiskFiles.map(f => f.path)
    : (state.manifest?.nodes ? state.manifest.nodes.map(n => n.id) : []);

  if (ws && ws.selectedFiles) {
    const cleanSet = new Set();
    ws.selectedFiles.forEach(file => {
      if (file.startsWith('this.') || file.startsWith('window.') || file.startsWith('console.')) return;
      if (availableFiles.length === 0 || availableFiles.includes(file)) {
        cleanSet.add(file);
      } else {
        const base = file.split('/').pop().toLowerCase();
        const match = availableFiles.find(p => p.split('/').pop().toLowerCase() === base);
        if (match) cleanSet.add(match);
      }
    });
    ws.selectedFiles = cleanSet;
  }

  const attachedFiles = ws?.selectedFiles ? Array.from(ws.selectedFiles) : [];

  container.innerHTML = `
    <div class="ws-pane-header">
      <div class="ws-pane-title">
        <span>📁 Context</span>
      </div>
      <button type="button" class="ws-header-link" id="btn-toggle-adv-inspector" title="View files, dependencies and history">
        ${isDetailsOpen ? 'Quiet View ▴' : 'View Details ▾'}
      </button>
    </div>

    <div class="ws-pane-body" style="padding: 0.75rem;">
      <!-- Quiet Attached Files List -->
      <div class="ws-card">
        <div class="ws-card-title" style="margin-bottom:0.4rem;">
          <span>Included in Handoff</span>
          <span style="font-size:0.68rem; color:var(--dim); font-weight:normal;">
            ${attachedFiles.length} file${attachedFiles.length === 1 ? '' : 's'} attached
          </span>
        </div>

        <div id="ws-quiet-files-list" class="ws-quiet-list">
          ${renderQuietAttachedFiles(attachedFiles)}
        </div>
      </div>

      <!-- Evidence Checklist -->
      <div class="ws-card">
        <div class="ws-card-title" style="margin-bottom:0.35rem;">
          <span>Evidence Package</span>
        </div>
        <div class="ws-checklist">
          <div class="ws-check-item"><span>✓</span> <span>Stack trace & error context</span></div>
          <div class="ws-check-item"><span>✓</span> <span>Exact source around failure</span></div>
          <div class="ws-check-item"><span>✓</span> <span>Caller & callee signatures</span></div>
          <div class="ws-check-item"><span>✓</span> <span>Surgical patch format contract</span></div>
        </div>
      </div>

      <!-- Collapsible Detailed Inspector Drawer -->
      ${isDetailsOpen ? renderDetailedDrawer(availableFiles) : ''}
    </div>
  `;

  attachInspectorEvents(container, availableFiles);
}

function renderQuietAttachedFiles(attachedFiles) {
  if (!attachedFiles || attachedFiles.length === 0) {
    return `
      <div style="font-size:0.72rem; color:var(--dim); padding:0.25rem 0; font-style:italic;">
        Click <strong>Fix This Issue</strong> to automatically select relevant files.
      </div>
    `;
  }

  return attachedFiles.map((file, idx) => {
    let role = idx === 0 ? 'Error source' : (idx === 1 ? 'Caller / Dependency' : 'Related module');
    const matched = rankedFilesData.find(f => f.file === file);
    if (matched && matched.reason) {
      role = matched.reason;
    }

    return `
      <div class="ws-quiet-file-row">
        <span style="color:#3fb950; font-weight:700; font-size:0.85rem; line-height:1;">✓</span>
        <div class="ws-quiet-file-meta">
          <div class="ws-quiet-file-name" title="${esc(file)}">${esc(file)}</div>
          <div class="ws-quiet-file-role">${esc(role)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderDetailedDrawer(availableFiles) {
  const ws = state.workstation;
  const filter = (wsFileSearchFilter || '').trim().toLowerCase();
  const groups = new Map();

  for (const f of availableFiles) {
    const fLower = f.toLowerCase();
    if (filter && !fLower.includes(filter)) continue;

    const parts = f.replace(/\\/g, '/').split('/');
    const folder = parts.length > 1 ? parts[0] : '(root)';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(f);
  }

  const foldersHtml = Array.from(groups.entries()).map(([folder, items]) => {
    const isCollapsed = !filter && wsCollapsedFolders.has(folder);
    const arrow = isCollapsed ? '▸' : '▾';
    const icon = isCollapsed ? '📁' : '📂';

    const itemsHtml = items.map(f => {
      const isChecked = ws?.selectedFiles?.has(f);
      const mode = ws?.fileModes?.[f] || 'scoped';

      return `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:0.3rem; padding:2px 4px 2px 14px; font-size:0.72rem;">
          <label style="display:flex; align-items:center; gap:0.3rem; overflow:hidden; cursor:pointer; flex:1;">
            <input type="checkbox" class="ws-file-chk" value="${esc(f)}" ${isChecked ? 'checked' : ''}>
            <span style="font-family:'JetBrains Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${esc(f)}
            </span>
          </label>
          <div class="pill-mode-group" data-file="${esc(f)}">
            <button type="button" class="pill-mode-btn ${mode === 'scoped' ? 'active' : ''}" data-mode="scoped" style="font-size:0.65rem; padding:1px 4px;">Scoped</button>
            <button type="button" class="pill-mode-btn ${mode === 'full' ? 'active full' : 'full'}" data-mode="full" style="font-size:0.65rem; padding:1px 4px;">Full</button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="ws-tree-folder" style="margin-bottom:0.25rem;">
        <div class="ws-folder-toggle" data-folder="${esc(folder)}" style="display:flex; align-items:center; gap:0.25rem; font-weight:600; cursor:pointer; padding:2px 4px; border-radius:3px; user-select:none; color:var(--text); font-size:0.72rem;">
          <span class="ws-folder-arrow" style="font-size:0.6rem; color:var(--dim); width:12px; display:inline-flex; justify-content:center;">${arrow}</span>
          <span class="ws-folder-icon">${icon}</span>
          <span style="overflow:hidden; text-overflow:ellipsis;">${esc(folder)}</span>
          <span style="font-size:0.65rem; color:var(--muted); margin-left:auto;">(${items.length})</span>
        </div>
        <div class="ws-folder-items" data-folder="${esc(folder)}" style="display:${isCollapsed ? 'none' : 'block'};">
          ${itemsHtml}
        </div>
      </div>
    `;
  }).join('') || '<div style="color:var(--dim); font-size:0.72rem; padding:4px;">No matching files</div>';

  return `
    <div class="ws-collapsible-drawer" id="ws-adv-inspector-drawer">
      <div style="font-weight:700; font-size:0.74rem; color:var(--primary); margin-bottom:0.4rem;">
        ⚙️ Detailed File Browser & Policy
      </div>

      <div style="margin-bottom:0.35rem;">
        <input type="text" id="ws-filter-tree-input" class="sidebar-search" value="${esc(wsFileSearchFilter)}" placeholder="🔍 Filter files (e.g. .js, src)..." style="width:100%; box-sizing:border-box; margin:0;">
      </div>

      <div id="ws-files-tree-list" style="max-height:180px; overflow-y:auto; font-family:'JetBrains Mono',monospace; font-size:0.72rem; display:flex; flex-direction:column; gap:2px; margin-bottom:0.5rem;">
        ${foldersHtml}
      </div>

      <!-- History Rollback in Details -->
      <div style="border-top:1px solid var(--border); padding-top:0.4rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="font-weight:600; font-size:0.7rem; color:var(--text);">Transaction History:</span>
          <div style="display:flex; gap:0.3rem;">
            <button type="button" class="secondary" id="btn-ws-undo" style="font-size:0.68rem; padding:1px 5px;">↺ Undo</button>
            <button type="button" class="secondary" id="btn-ws-redo" style="font-size:0.68rem; padding:1px 5px;">↻ Redo</button>
          </div>
        </div>
        <div id="ws-history-summary" style="font-size:0.68rem; color:var(--dim); font-family:'JetBrains Mono',monospace;">
          No transactions yet.
        </div>
      </div>
    </div>
  `;
}

function attachInspectorEvents(container) {
  // Toggle Details Link
  container.querySelector('#btn-toggle-adv-inspector')?.addEventListener('click', () => {
    isDetailsOpen = !isDetailsOpen;
    renderInspectorPane(container);
  });

  if (isDetailsOpen) {
    // Search input
    const filterInput = container.querySelector('#ws-filter-tree-input');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        wsFileSearchFilter = filterInput.value;
        renderInspectorPane(container);
        const reInput = container.querySelector('#ws-filter-tree-input');
        if (reInput) {
          reInput.focus();
          reInput.setSelectionRange(reInput.value.length, reInput.value.length);
        }
      });
    }

    // Folder collapse/expand
    container.querySelectorAll('.ws-folder-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const folder = el.getAttribute('data-folder');
        const itemsEl = container.querySelector(`.ws-folder-items[data-folder="${folder}"]`);
        if (!itemsEl) return;
        const isHidden = itemsEl.style.display === 'none';
        if (isHidden) {
          wsCollapsedFolders.delete(folder);
          itemsEl.style.display = 'block';
          const arrow = el.querySelector('.ws-folder-arrow');
          const icon = el.querySelector('.ws-folder-icon');
          if (arrow) arrow.textContent = '▾';
          if (icon) icon.textContent = '📂';
        } else {
          wsCollapsedFolders.add(folder);
          itemsEl.style.display = 'none';
          const arrow = el.querySelector('.ws-folder-arrow');
          const icon = el.querySelector('.ws-folder-icon');
          if (arrow) arrow.textContent = '▸';
          if (icon) icon.textContent = '📁';
        }
      });
    });

    // Checkboxes
    container.querySelectorAll('.ws-file-chk').forEach(cb => {
      cb.addEventListener('change', () => {
        if (!state.workstation.selectedFiles) state.workstation.selectedFiles = new Set();
        if (cb.checked) {
          state.workstation.selectedFiles.add(cb.value);
        } else {
          state.workstation.selectedFiles.delete(cb.value);
        }
        if (onFileSelectionChange) onFileSelectionChange();
        renderInspectorPane(container);
      });
    });

    // Scoped / Full pills
    container.querySelectorAll('.pill-mode-group[data-file]').forEach(group => {
      const file = group.getAttribute('data-file');
      const btns = group.querySelectorAll('.pill-mode-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          btns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          if (!state.workstation.fileModes) state.workstation.fileModes = {};
          state.workstation.fileModes[file] = btn.getAttribute('data-mode');
          if (onFileSelectionChange) onFileSelectionChange();
        });
      });
    });

    // History Undo / Redo
    container.querySelector('#btn-ws-undo')?.addEventListener('click', async () => {
      await performUndo();
      updateVerifyHistorySummary(container);
    });
    container.querySelector('#btn-ws-redo')?.addEventListener('click', async () => {
      await performRedo();
      updateVerifyHistorySummary(container);
    });

    updateVerifyHistorySummary(container);
  }
}

async function updateVerifyHistorySummary(container) {
  const el = container.querySelector('#ws-history-summary');
  if (!el || !state.projectPath) return;

  const status = await getHistoryStatus(state.projectPath);
  if (!status || !status.recentTransactions || status.recentTransactions.length === 0) {
    el.textContent = 'No file modifications recorded yet.';
    return;
  }

  el.innerHTML = status.recentTransactions.slice(-2).reverse().map(tx => `
    <div style="padding:1px 0;">
      <span style="color:var(--primary); font-weight:600;">${esc(tx.patchId)}:</span>
      <span style="color:var(--text);">${esc(tx.description)}</span>
    </div>
  `).join('');
}
