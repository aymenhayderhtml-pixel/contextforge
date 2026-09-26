/**
 * public/js/sidebar/tree.js
 * Left sidebar tree mirroring project disk files and folder structure.
 */

import { state } from '../state.js';
import { showToast } from '../shared/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

function getNodeFolder(nodeId) {
  const parts = nodeId.replace(/\\/g, '/').split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

export let projectDiskFiles = [];

export async function updateSidebarTree(callbacks = {}) {
  const sidebarTree = document.getElementById('sidebar-tree');
  const sidebarSearch = document.getElementById('sidebar-search');
  if (!sidebarTree) return;

  const projectPath = state.projectPath;
  if (!projectPath) {
    sidebarTree.innerHTML = '';
    return;
  }

  try {
    const res = await fetch(`/file-tree?projectPath=${encodeURIComponent(projectPath)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.files)) {
        projectDiskFiles = data.files;
      }
    }
  } catch (_) {}

  let filesToRender = [];
  if (projectDiskFiles && projectDiskFiles.length > 0) {
    filesToRender = projectDiskFiles;
  } else if (state.manifest && state.manifest.nodes) {
    filesToRender = state.manifest.nodes.map(n => ({ path: n.id, name: basename(n.id), dir: getNodeFolder(n.id) }));
  }

  sidebarTree.innerHTML = '';
  if (filesToRender.length === 0) return;

  const filter = (sidebarSearch ? sidebarSearch.value : '').trim().toLowerCase();
  const groups = new Map();

  for (const f of filesToRender) {
    const fPath = f.path;
    const fName = basename(fPath).toLowerCase();
    const fLower = fPath.toLowerCase();

    if (filter && !fName.includes(filter) && !fLower.includes(filter)) {
      continue;
    }

    const folder = f.dir || getNodeFolder(fPath);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(f);
  }

  for (const [folder, items] of groups.entries()) {
    const li = document.createElement('li');
    li.className = 'tree-folder';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'tree-folder-title';
    titleDiv.innerHTML = `<span>📁</span> <span>${esc(folder)}</span> <span style="font-size:0.65rem; color:var(--muted); margin-left:auto;">(${items.length})</span>`;

    const ul = document.createElement('ul');
    ul.className = 'tree-folder-items';

    for (const item of items) {
      const itemLi = document.createElement('li');
      itemLi.className = 'tree-item';
      itemLi.setAttribute('data-id', item.path);
      if (item.path === state.selectedNodeId) itemLi.classList.add('selected');

      const ext = item.path.split('.').pop().toLowerCase();
      let dotColor = '#94a3b8';
      if (['tscn', 'scn'].includes(ext)) dotColor = '#f87171';
      else if (['gd'].includes(ext)) dotColor = '#a855f7';
      else if (['js', 'mjs', 'ts'].includes(ext)) dotColor = '#38bdf8';
      else if (['glb', 'gltf', 'png', 'jpg', 'svg'].includes(ext)) dotColor = '#34d399';
      else if (['html'].includes(ext)) dotColor = '#fbbf24';

      itemLi.innerHTML = `<span class="tree-dot" style="background:${dotColor}"></span> <span style="overflow:hidden; text-overflow:ellipsis;">${esc(basename(item.path))}</span>`;

      itemLi.addEventListener('click', (e) => {
        e.stopPropagation();
        selectFile(item.path, callbacks);
      });

      ul.appendChild(itemLi);
    }

    titleDiv.addEventListener('click', () => {
      const isVisible = ul.style.display !== 'none';
      ul.style.display = isVisible ? 'none' : 'block';
    });

    li.appendChild(titleDiv);
    li.appendChild(ul);
    sidebarTree.appendChild(li);
  }
}

export async function selectFile(filePath, callbacks = {}) {
  state.selectedNodeId = filePath;

  document.querySelectorAll('.tree-item').forEach(el => {
    const isMatch = el.getAttribute('data-id') === filePath;
    el.classList.toggle('selected', isMatch);
    if (isMatch) {
      const folderItems = el.closest('.tree-folder-items');
      if (folderItems) folderItems.style.display = 'block';
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  const sidePanel = document.getElementById('side-panel');
  const panelContent = document.getElementById('panel-content');
  if (!panelContent || !sidePanel) return;

  const ext = filePath.split('.').pop().toUpperCase();
  const isHtml = filePath.toLowerCase().endsWith('.html');
  const projectPath = state.projectPath;

  panelContent.innerHTML = `
    <button class="panel-close" id="btn-close-side-panel">✕</button>
    <div class="panel-title" style="word-break:break-all;">${esc(filePath)}</div>

    <div class="panel-section" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.4rem;">
      <div style="display:flex; gap:0.3rem; align-items:center;">
        <span class="badge" style="background:#242d40; color:var(--dim);">FILE</span>
        <span class="badge badge-engine">${esc(ext)}</span>
      </div>
      <div style="display:flex; gap:0.35rem; align-items:center;">
        ${isHtml ? `<button class="btn-run-file" id="btn-panel-run-file">▶ Run</button>` : ''}
        <button class="secondary" style="font-size:0.75rem; height:24px; padding:0 0.5rem;" id="btn-panel-report-issue">🐞 Report Issue</button>
      </div>
    </div>

    <div class="panel-section">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.3rem;">
        <h3>File Content</h3>
        <button id="btn-save-disk-file" class="secondary" style="font-size:0.7rem; height:22px; padding:0 0.5rem;">💾 Save</button>
      </div>
      <textarea id="raw-file-content" class="paste-back-textarea" style="height:380px; font-family:'JetBrains Mono',monospace; font-size:0.75rem;">Loading content...</textarea>
      <div id="file-save-status" class="paste-status" style="margin-top:0.3rem;"></div>
    </div>
  `;

  sidePanel.classList.add('open');

  document.getElementById('btn-close-side-panel')?.addEventListener('click', () => {
    sidePanel.classList.remove('open');
  });

  document.getElementById('btn-save-disk-file')?.addEventListener('click', () => {
    saveRawFile(filePath);
  });

  document.getElementById('btn-panel-report-issue')?.addEventListener('click', () => {
    if (callbacks.onReportIssue) callbacks.onReportIssue(filePath);
  });

  document.getElementById('btn-panel-run-file')?.addEventListener('click', () => {
    if (callbacks.onRunFile) callbacks.onRunFile(filePath);
  });

  try {
    const res = await fetch(`/file-content?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    const textarea = document.getElementById('raw-file-content');
    if (textarea) {
      if (res.ok && data.success) {
        textarea.value = data.content;
      } else {
        textarea.value = `// Error loading file: ${data.error || res.statusText}`;
      }
    }
  } catch (err) {
    const textarea = document.getElementById('raw-file-content');
    if (textarea) textarea.value = `// Network error: ${err.message}`;
  }
}

export async function saveRawFile(filePath) {
  const textarea = document.getElementById('raw-file-content');
  const statusEl = document.getElementById('file-save-status');
  if (!textarea) return;

  const content = textarea.value;
  const projectPath = state.projectPath;
  if (statusEl) {
    statusEl.className = 'paste-status';
    statusEl.textContent = 'Saving...';
  }

  try {
    const res = await fetch('/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, filePath, content })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (statusEl) {
        statusEl.className = 'paste-status';
        statusEl.textContent = '✓ Saved to disk';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
      }
      showToast(`✓ Saved ${filePath}`, 'success');
    } else {
      if (statusEl) {
        statusEl.className = 'paste-status error';
        statusEl.textContent = data.error || 'Failed to save';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'paste-status error';
      statusEl.textContent = err.message;
    }
  }
}
