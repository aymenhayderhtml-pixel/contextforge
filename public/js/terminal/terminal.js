/**
 * public/js/terminal/terminal.js
 * Terminal and diagnostics manager on the frontend.
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

export async function fetchConsoleLogs(projectPath = state.projectPath, forceCheck = false) {
  if (!projectPath) return { logs: [], redLogs: [], errorCount: 0, totalCount: 0 };
  try {
    const res = await fetch(`/console-logs?projectPath=${encodeURIComponent(projectPath)}${forceCheck ? '&check=true' : ''}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        return {
          logs: data.logs || [],
          redLogs: data.redLogs || [],
          errorCount: data.errorCount || 0,
          totalCount: data.totalCount || 0
        };
      }
    }
  } catch (err) {
    console.warn('Failed to fetch console logs:', err);
  }
  return { logs: [], redLogs: [], errorCount: 0, totalCount: 0 };
}

export async function updateConsoleBadge(overrideCount) {
  const badge = document.getElementById('console-badge');
  if (!badge) return;
  if (typeof overrideCount === 'number') {
    if (overrideCount > 0) {
      badge.style.display = 'inline-block';
      badge.textContent = overrideCount > 99 ? '99+' : String(overrideCount);
    } else {
      badge.style.display = 'none';
    }
    return;
  }
  const projectPath = state.projectPath;
  if (!projectPath) {
    badge.style.display = 'none';
    return;
  }
  const data = await fetchConsoleLogs(projectPath, false);
  if (data.errorCount > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = data.errorCount > 99 ? '99+' : String(data.errorCount);
  } else {
    badge.style.display = 'none';
  }
}

export async function openConsoleModal() {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please open or extract a project first to view console logs.', 'warn');
    return;
  }

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  let consoleFilter = 'all';
  let consoleData = await fetchConsoleLogs(projectPath, false);

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 780px; max-height: 85vh; display:flex; flex-direction:column;">
        <div class="modal-header">
          <div>
            <div class="modal-title">📟 Project & Engine Console</div>
            <div style="font-size:0.75rem; color:var(--dim); font-family:'JetBrains Mono',monospace;">${esc(projectPath)}</div>
          </div>
          <button class="panel-close" id="btn-close-console-modal">✕</button>
        </div>
        <div class="modal-body" style="display:flex; flex-direction:column; gap:0.5rem; flex:1; min-height:0;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div id="full-console-badge" style="font-size:0.75rem;"></div>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <div class="pill-mode-group">
                <button type="button" class="pill-mode-btn active" id="full-btn-filter-all" data-mode="all">All</button>
                <button type="button" class="pill-mode-btn" id="full-btn-filter-red" data-mode="red" style="color:#ef4444; font-weight:600;">Red only</button>
              </div>
              <button type="button" class="secondary" id="full-btn-refresh" style="font-size:0.72rem; padding:0.25rem 0.6rem;">🔄 Check & Refresh</button>
              <button type="button" class="secondary" id="full-btn-clear" style="font-size:0.72rem; padding:0.25rem 0.6rem;">🗑 Clear</button>
            </div>
          </div>
          <div id="full-console-view" style="background:#0d1117; color:#c9d1d9; border:1px solid var(--border); border-radius:6px; font-family:'JetBrains Mono',monospace; font-size:0.75rem; flex:1; min-height:280px; max-height:420px; overflow-y:auto; padding:0.6rem 0.8rem; white-space:pre-wrap; line-height:1.45;">
            Loading console output...
          </div>
        </div>
        <div class="modal-footer" style="justify-content:space-between;">
          <div style="font-size:0.72rem; color:var(--dim);">Tip: Red errors are automatically included in AI Issue prompts.</div>
          <button class="secondary" id="btn-done-console-modal">Done</button>
        </div>
      </div>
    </div>
  `;

  const closeFn = () => { modalRoot.innerHTML = ''; };
  document.getElementById('btn-close-console-modal')?.addEventListener('click', closeFn);
  document.getElementById('btn-done-console-modal')?.addEventListener('click', closeFn);

  function renderView() {
    const view = document.getElementById('full-console-view');
    const badge = document.getElementById('full-console-badge');
    if (!view) return;

    if (consoleFilter === 'red') {
      if (!consoleData.redLogs || consoleData.redLogs.length === 0) {
        view.innerHTML = '<div style="color:var(--dim); font-style:italic;">No red errors in console output.</div>';
      } else {
        view.innerHTML = consoleData.redLogs.map(l => `<div style="color:#ff6b6b; font-weight:600; padding:1px 0;">${esc(l.text)}</div>`).join('');
      }
    } else {
      if (!consoleData.logs || consoleData.logs.length === 0) {
        view.innerHTML = '<div style="color:var(--dim); font-style:italic;">Console is empty. Click "🔄 Check & Refresh" to run an engine check.</div>';
      } else {
        view.innerHTML = consoleData.logs.map(l => {
          const color = l.isError ? '#ff6b6b; font-weight:600;' : '#c9d1d9;';
          return `<div style="color:${color} padding:1px 0;">${esc(l.text)}</div>`;
        }).join('');
      }
    }

    if (badge) {
      const errCount = (consoleData.redLogs || []).length;
      const total = (consoleData.logs || []).length;
      badge.innerHTML = `<span style="color:${errCount > 0 ? '#ef4444' : 'var(--dim)'}; font-weight:600;">${errCount} error${errCount === 1 ? '' : 's'}</span> <span style="color:var(--dim);">(${total} total lines)</span>`;
    }
  }

  renderView();

  document.getElementById('full-btn-filter-all')?.addEventListener('click', () => {
    consoleFilter = 'all';
    document.getElementById('full-btn-filter-all')?.classList.add('active');
    document.getElementById('full-btn-filter-red')?.classList.remove('active');
    renderView();
  });

  document.getElementById('full-btn-filter-red')?.addEventListener('click', () => {
    consoleFilter = 'red';
    document.getElementById('full-btn-filter-red')?.classList.add('active');
    document.getElementById('full-btn-filter-all')?.classList.remove('active');
    renderView();
  });

  document.getElementById('full-btn-refresh')?.addEventListener('click', async () => {
    consoleData = await fetchConsoleLogs(projectPath, true);
    renderView();
    updateConsoleBadge(consoleData.errorCount);
  });

  document.getElementById('full-btn-clear')?.addEventListener('click', async () => {
    await fetch(`/console-logs?projectPath=${encodeURIComponent(projectPath)}&clear=true`);
    consoleData = { logs: [], redLogs: [], errorCount: 0, totalCount: 0 };
    renderView();
    updateConsoleBadge(0);
    showToast('Console cleared', 'info');
  });
}
