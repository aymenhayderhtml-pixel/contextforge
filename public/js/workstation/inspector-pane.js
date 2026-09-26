/**
 * public/js/workstation/inspector-pane.js
 * Right Pane: Project Files, Relevance Context, Dependencies, and Verification/History Inspector.
 */

import { state } from '../state.js';
import { projectDiskFiles } from '../sidebar/tree.js';
import { getHistoryStatus, executeUndo, executeRedo } from '../history/history.js';
import { showToast } from '../shared/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let activeInspectorTab = 'context'; // 'files' | 'context' | 'deps' | 'verify'
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
    : (state.manifest && state.manifest.nodes ? state.manifest.nodes.map(n => n.id) : []);

  container.innerHTML = `
    <div class="ws-pane-header" style="padding:0;">
      <div class="ws-inspector-nav" style="width:100%;">
        <button type="button" class="ws-inspector-tab ${activeInspectorTab === 'context' ? 'active' : ''}" data-tab="context">Context</button>
        <button type="button" class="ws-inspector-tab ${activeInspectorTab === 'files' ? 'active' : ''}" data-tab="files">Files</button>
        <button type="button" class="ws-inspector-tab ${activeInspectorTab === 'deps' ? 'active' : ''}" data-tab="deps">Deps</button>
        <button type="button" class="ws-inspector-tab ${activeInspectorTab === 'verify' ? 'active' : ''}" data-tab="verify">Verify</button>
      </div>
    </div>

    <div class="ws-pane-body" style="padding:0.6rem;">
      ${renderActiveTabContent(availableFiles)}
    </div>
  `;

  attachInspectorEvents(container);
}

function renderActiveTabContent(availableFiles) {
  const ws = state.workstation;

  if (activeInspectorTab === 'context') {
    const relevantItems = rankedFilesData.filter(f => f.score > 0 || ws.selectedFiles.has(f.file));
    const itemsToRender = relevantItems.length > 0 ? relevantItems : rankedFilesData.slice(0, 4);

    return `
      <div class="ws-card">
        <div class="ws-card-title">
          <span>🔍 Relevant Context Selection</span>
          <span style="font-size:0.68rem; color:var(--dim); font-weight:normal;">${ws.selectedFiles.size} attached</span>
        </div>
        <div style="font-size:0.7rem; color:var(--dim); margin-bottom:0.25rem;">
          Files scored by stack trace, symbol relevance & dependency topology:
        </div>
        <div style="display:flex; flex-direction:column; gap:0.35rem; max-height:220px; overflow-y:auto;">
          ${itemsToRender.map(item => {
            const isChecked = ws.selectedFiles.has(item.file);
            const mode = ws.fileModes[item.file] || 'scoped';
            let badgeHtml = '';
            if (item.score >= 90) badgeHtml = `<span class="badge-relevance badge-high">${item.score}% Relevance</span>`;
            else if (item.score >= 60) badgeHtml = `<span class="badge-relevance badge-med">${item.score}% Match</span>`;
            else if (item.score > 0) badgeHtml = `<span class="badge-relevance badge-low">${item.score}%</span>`;

            return `
              <div style="display:flex; align-items:center; justify-content:space-between; gap:0.4rem; font-size:0.74rem; background:rgba(255,255,255,0.02); padding:3px 5px; border-radius:3px;">
                <label style="display:flex; align-items:center; gap:0.35rem; cursor:pointer; flex:1; overflow:hidden;">
                  <input type="checkbox" class="ws-file-chk" value="${esc(item.file)}" ${isChecked ? 'checked' : ''}>
                  <span style="font-family:'JetBrains Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:${isChecked ? '600' : 'normal'};">
                    ${esc(item.file)}
                  </span>
                  ${badgeHtml}
                </label>
                <div class="pill-mode-group" data-file="${esc(item.file)}">
                  <button type="button" class="pill-mode-btn ${mode === 'scoped' ? 'active' : ''}" data-mode="scoped" title="Send outline & focused slice">Scoped</button>
                  <button type="button" class="pill-mode-btn ${mode === 'full' ? 'active full' : 'full'}" data-mode="full" title="Send entire file source">Full</button>
                </div>
              </div>
            `;
          }).join('') || '<div style="color:var(--dim); font-size:0.72rem;">No relevant files identified yet. Type issue or paste error log.</div>'}
        </div>
      </div>

      <div class="ws-card">
        <div class="ws-card-title">
          <span>📊 Token Budget & Savings</span>
        </div>
        <div id="ws-inspector-savings" style="font-size:0.72rem; color:var(--text); line-height:1.4;">
          Compile a handoff to evaluate token footprint.
        </div>
      </div>
    `;
  }

  if (activeInspectorTab === 'files') {
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

      const itemsHtml = items.map(f => `
        <div class="ws-file-item" data-path="${esc(f)}" style="padding:2px 4px 2px 14px; border-radius:3px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:background 0.1s ease;">
          📄 ${esc(f)}
        </div>
      `).join('');

      return `
        <div class="ws-tree-folder" style="margin-bottom:0.25rem;">
          <div class="ws-folder-toggle" data-folder="${esc(folder)}" style="display:flex; align-items:center; gap:0.25rem; font-weight:600; cursor:pointer; padding:2px 4px; border-radius:3px; user-select:none; color:var(--text);">
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
      <div class="ws-card" style="flex:1;">
        <div class="ws-card-title">
          <span>📁 Project Disk Files</span>
          <span style="font-size:0.68rem; color:var(--dim); font-weight:normal;">${availableFiles.length} files</span>
        </div>
        <div style="margin-bottom:0.35rem;">
          <input type="text" id="ws-filter-tree-input" class="sidebar-search" value="${esc(wsFileSearchFilter)}" placeholder="🔍 Filter files (e.g. .js, src)..." style="width:100%; box-sizing:border-box; margin:0;">
        </div>
        <div id="ws-files-tree-list" style="max-height:300px; overflow-y:auto; font-family:'JetBrains Mono',monospace; font-size:0.72rem; display:flex; flex-direction:column; gap:2px;">
          ${foldersHtml}
        </div>
      </div>
    `;
  }

  if (activeInspectorTab === 'deps') {
    const sel = state.selectedNodeId;
    const node = state.manifest && state.manifest.nodes ? state.manifest.nodes.find(n => n.id === sel) : null;

    return `
      <div class="ws-card">
        <div class="ws-card-title">
          <span>📦 Selected Target: ${esc(sel || 'None')}</span>
        </div>
        ${node ? `
          <div style="font-size:0.72rem; display:flex; flex-direction:column; gap:0.4rem;">
            <div>
              <strong style="color:var(--primary);">Depends On (${node.depends_on.length}):</strong>
              <div style="font-family:'JetBrains Mono',monospace; color:var(--dim); margin-top:2px;">
                ${node.depends_on.map(d => `<div>↳ ${esc(d)}</div>`).join('') || '(None)'}
              </div>
            </div>
            <div>
              <strong style="color:var(--green);">Depended On By (${node.depended_on_by.length}):</strong>
              <div style="font-family:'JetBrains Mono',monospace; color:var(--dim); margin-top:2px;">
                ${node.depended_on_by.map(d => `<div>↰ ${esc(d)}</div>`).join('') || '(None)'}
              </div>
            </div>
            <div>
              <strong style="color:var(--text);">Declared Exports:</strong>
              <div style="font-family:'JetBrains Mono',monospace; color:var(--dim); margin-top:2px;">
                ${(node.contract && node.contract.exports && node.contract.exports.length > 0)
                  ? node.contract.exports.map(e => `<div>• ${esc(e)}</div>`).join('')
                  : '(No public exports)'}
              </div>
            </div>
          </div>
        ` : `
          <div style="color:var(--dim); font-size:0.72rem; font-style:italic;">
            Click a file in the Context or Files tab to inspect its callers, callees, and public contracts.
          </div>
        `}
      </div>
    `;
  }

  if (activeInspectorTab === 'verify') {
    const lastV = ws.lastVerification;
    return `
      <div class="ws-card">
        <div class="ws-card-title">
          <span>🛡️ Patch Verification Engine</span>
        </div>
        ${lastV ? `
          <div class="ws-verify-banner ${lastV.status === 'ERROR_RESOLVED' || (lastV.valid && !lastV.status) ? 'success' : (lastV.status === 'SAME_ERROR' ? 'warning' : 'error')}">
            <span>${lastV.status === 'ERROR_RESOLVED' ? '✓' : '⚠️'}</span>
            <span>${esc(lastV.summary || (lastV.valid ? 'Syntax verified clean' : 'Syntax error'))}</span>
          </div>
        ` : `
          <div style="font-size:0.72rem; color:var(--dim); font-style:italic;">
            No patch has been applied yet in this session.
          </div>
        `}
      </div>

      <div class="ws-card">
        <div class="ws-card-title">
          <span>↺ 20-Step Undo/Redo History</span>
          <div style="display:flex; gap:0.25rem;">
            <button type="button" class="secondary" id="btn-ws-undo" style="font-size:0.68rem; height:20px; padding:0 0.45rem;">↺ Undo</button>
            <button type="button" class="secondary" id="btn-ws-redo" style="font-size:0.68rem; height:20px; padding:0 0.45rem;">↻ Redo</button>
          </div>
        </div>
        <div id="ws-history-summary" style="font-size:0.72rem; color:var(--dim);">
          Loading transactions...
        </div>
      </div>
    `;
  }

  return '';
}

function attachInspectorEvents(container) {
  // Tabs navigation
  container.querySelectorAll('.ws-inspector-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeInspectorTab = btn.getAttribute('data-tab');
      renderInspectorPane(container);
    });
  });

  // Context checkboxes
  container.querySelectorAll('.ws-file-chk').forEach(cb => {
    cb.addEventListener('change', () => {
      const ws = state.workstation;
      if (cb.checked) {
        ws.selectedFiles.add(cb.value);
      } else {
        ws.selectedFiles.delete(cb.value);
      }
      if (onFileSelectionChange) onFileSelectionChange();
    });
  });

  // Context Scoped vs Full pills
  container.querySelectorAll('.pill-mode-group[data-file]').forEach(group => {
    const file = group.getAttribute('data-file');
    const btns = group.querySelectorAll('.pill-mode-btn');
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.workstation.fileModes[file] = btn.getAttribute('data-mode');
        if (onFileSelectionChange) onFileSelectionChange();
      });
    });
  });

  // Files tab: Search filter input
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

  // Files tab: Folder collapse/expand toggle
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

  // File item click in Files tab
  container.querySelectorAll('.ws-file-item').forEach(el => {
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-path');
      state.selectedNodeId = p;
      activeInspectorTab = 'deps';
      renderInspectorPane(container);
    });
  });

  // History Undo / Redo in Verify tab
  container.querySelector('#btn-ws-undo')?.addEventListener('click', async () => {
    await executeUndo();
    renderInspectorPane(container);
  });
  container.querySelector('#btn-ws-redo')?.addEventListener('click', async () => {
    await executeRedo();
    renderInspectorPane(container);
  });

  if (activeInspectorTab === 'verify') {
    updateVerifyHistorySummary(container);
  }
}

async function updateVerifyHistorySummary(container) {
  const el = container.querySelector('#ws-history-summary');
  if (!el || !state.projectPath) return;

  const status = await getHistoryStatus(state.projectPath);
  if (!status || status.recentTransactions.length === 0) {
    el.textContent = 'No file modifications recorded yet.';
    return;
  }

  el.innerHTML = status.recentTransactions.slice(-3).reverse().map(tx => `
    <div style="padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.03);">
      <span style="color:var(--primary); font-weight:600;">${esc(tx.patchId)}:</span>
      <span style="color:var(--text);">${esc(tx.description)}</span>
    </div>
  `).join('');
}
