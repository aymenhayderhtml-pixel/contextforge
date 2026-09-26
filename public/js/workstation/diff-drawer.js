/**
 * public/js/workstation/diff-drawer.js
 * Interactive Diff Preview Drawer (T080).
 * Displays line-by-line visual diff (+ additions in green, - deletions in red)
 * with 1-click confirmation before writing to disk.
 */

import { showToast } from '../shared/toast.js';

let drawerElement = null;

function ensureDrawerInDom() {
  if (!drawerElement) {
    drawerElement = document.createElement('div');
    drawerElement.id = 'ws-diff-drawer';
    drawerElement.className = 'ws-diff-drawer';
    drawerElement.style.display = 'none';
    document.body.appendChild(drawerElement);
  }
  return drawerElement;
}

export function closeDiffDrawer() {
  if (drawerElement) {
    drawerElement.style.display = 'none';
    drawerElement.innerHTML = '';
  }
}

export async function openDiffDrawer({ projectPath, content, onApply }) {
  if (!projectPath || !content || !content.trim()) {
    showToast('Please paste a patch before opening Diff Preview.', 'warn');
    return;
  }

  const drawer = ensureDrawerInDom();
  drawer.style.display = 'flex';
  drawer.innerHTML = `
    <div class="ws-diff-drawer-header">
      <div style="font-weight:600; font-size:0.95rem; display:flex; align-items:center; gap:0.5rem;">
        <span>🔍 Diff Preview</span>
        <span style="font-size:0.75rem; color:var(--dim); font-weight:normal;">(In-Memory Simulation)</span>
      </div>
      <button type="button" class="secondary btn-close-diff-drawer" style="padding:0.2rem 0.5rem; font-size:0.8rem; cursor:pointer;">✕ Close</button>
    </div>
    <div class="ws-diff-drawer-body" style="padding:1rem; overflow-y:auto; flex:1;">
      <div style="color:var(--dim); font-size:0.85rem;">⏳ Computing line diffs from project files...</div>
    </div>
  `;

  drawer.querySelector('.btn-close-diff-drawer')?.addEventListener('click', closeDiffDrawer);

  try {
    const res = await fetch('/preview-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, content })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      drawer.querySelector('.ws-diff-drawer-body').innerHTML = `
        <div style="padding:1rem; color:#ff7b72; font-size:0.85rem;">
          ✕ ${escapeHtml(data.error || 'Failed to compute diff preview')}
        </div>
      `;
      return;
    }

    const files = data.files || [];
    let bodyHtml = '';

    if (files.length === 0) {
      bodyHtml = '<div style="color:var(--dim); font-size:0.85rem;">No file changes detected.</div>';
    } else {
      files.forEach((f) => {
        const addCount = f.additions || 0;
        const delCount = f.deletions || 0;

        bodyHtml += `
          <div class="diff-file-card" style="margin-bottom:1rem; border:1px solid var(--border); border-radius:6px; overflow:hidden; background:var(--bg-card, #161b22);">
            <div class="diff-file-header" style="background:rgba(255,255,255,0.03); padding:0.45rem 0.75rem; font-size:0.8rem; font-family:'JetBrains Mono',monospace; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border);">
              <span style="font-weight:600; color:var(--text);">${escapeHtml(f.file)}</span>
              <div style="font-size:0.75rem; display:flex; gap:0.5rem;">
                <span style="color:#3fb950;">+${addCount}</span>
                <span style="color:#f85149;">-${delCount}</span>
              </div>
            </div>
            <div class="diff-lines-container" style="font-family:'JetBrains Mono',monospace; font-size:0.75rem; line-height:1.45; overflow-x:auto;">
        `;

        if (!f.chunks || f.chunks.length === 0) {
          bodyHtml += `<div style="padding:0.5rem 0.75rem; color:var(--dim); font-style:italic;">No line changes in file</div>`;
        } else {
          f.chunks.forEach((chunk) => {
            const isAdd = chunk.type === 'add';
            const isDel = chunk.type === 'delete';
            const bg = isAdd ? 'rgba(46, 160, 67, 0.18)' : isDel ? 'rgba(248, 81, 73, 0.18)' : 'transparent';
            const color = isAdd ? '#7ee787' : isDel ? '#ffa198' : 'var(--dim)';
            const prefix = isAdd ? '+' : isDel ? '-' : ' ';
            const oldN = chunk.oldNum ? String(chunk.oldNum).padStart(4, ' ') : '    ';
            const newN = chunk.newNum ? String(chunk.newNum).padStart(4, ' ') : '    ';

            bodyHtml += `
              <div style="display:flex; background:${bg}; color:${color}; white-space:pre; padding:1px 4px;">
                <span style="user-select:none; color:rgba(255,255,255,0.25); width:5rem; display:inline-block; font-size:0.68rem;">${oldN} ${newN}</span>
                <span style="user-select:none; width:1.2rem; text-align:center;">${prefix}</span>
                <span style="flex:1;">${escapeHtml(chunk.line)}</span>
              </div>
            `;
          });
        }

        bodyHtml += `
            </div>
          </div>
        `;
      });
    }

    if (data.unmatched && data.unmatched.length > 0) {
      bodyHtml += `
        <div style="margin-top:1rem; padding:0.75rem; border-radius:6px; background:rgba(210, 153, 34, 0.15); border:1px solid rgba(210, 153, 34, 0.4); font-size:0.8rem;">
          <div style="font-weight:600; color:#e3b341; margin-bottom:0.3rem;">⚠️ Unmatched Edit Blocks (${data.unmatched.length}):</div>
          ${data.unmatched.map(u => `
            <div style="font-family:'JetBrains Mono',monospace; font-size:0.75rem; margin-top:0.25rem;">
              • Block ${u.index} (${escapeHtml(u.file)}): ${escapeHtml(u.reason)}
            </div>
          `).join('')}
        </div>
      `;
    }

    const drawerBody = drawer.querySelector('.ws-diff-drawer-body');
    if (drawerBody) {
      drawerBody.innerHTML = bodyHtml;
    }

    // Footer actions
    let footer = drawer.querySelector('.ws-diff-drawer-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'ws-diff-drawer-footer';
      footer.style.padding = '0.75rem 1rem';
      footer.style.borderTop = '1px solid var(--border)';
      footer.style.display = 'flex';
      footer.style.justifyContent = 'flex-end';
      footer.style.gap = '0.5rem';
      drawer.appendChild(footer);
    }

    footer.innerHTML = `
      <button type="button" class="secondary btn-close-diff-drawer" style="padding:0.35rem 0.8rem; font-size:0.8rem; cursor:pointer;">Cancel</button>
      <button type="button" id="btn-diff-drawer-apply" style="padding:0.35rem 1rem; font-size:0.8rem; background:#238636; color:#fff; border:1px solid rgba(255,255,255,0.15); border-radius:4px; font-weight:600; cursor:pointer;">
        ▶ Apply Patch & Verify
      </button>
    `;

    footer.querySelector('.btn-close-diff-drawer')?.addEventListener('click', closeDiffDrawer);
    footer.querySelector('#btn-diff-drawer-apply')?.addEventListener('click', async () => {
      closeDiffDrawer();
      if (onApply) await onApply();
    });
  } catch (err) {
    const drawerBody = drawer.querySelector('.ws-diff-drawer-body');
    if (drawerBody) {
      drawerBody.innerHTML = `
        <div style="padding:1rem; color:#ff7b72; font-size:0.85rem;">
          ✕ Error: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
