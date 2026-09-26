/**
 * public/js/app.js
 * ContextForge Client Orchestration Entrypoint.
 * Bootstraps modules, binds top-level event handlers, and coordinates subsystems.
 */

import { state, subscribe, notifyStateChange } from './state.js';
import { showToast } from './shared/toast.js';
import { performUndo, performRedo, updateHistoryUI, initHistoryShortcuts } from './history/history.js';
import { handleQuickPaste, applyClipboardContentDirectly, openClipboardModal } from './clipboard/clipboard.js';
import { openConsoleModal, updateConsoleBadge, fetchConsoleLogs } from './terminal/terminal.js';
import {
  ensureDevServerRunning,
  stopManagedDevServer,
  checkAndSetupPreviewPanel,
  togglePreviewPanel,
  reloadPreviewIframe,
  runHtmlFile,
  playGameInNewTab,
  updateDevServerUiState
} from './preview/preview.js';
import { updateSidebarTree, selectFile, saveRawFile, projectDiskFiles } from './sidebar/tree.js';
import { openIssueReportModal, copyIssuePrompt } from './issue/issue-modal.js';
import {
  openNewProjectModal,
  selectProjectEngine,
  renderNewProjectStep1,
  renderNewProjectStep2,
  renderNewProjectStep3,
  pasteClipboardToStep3,
  submitNewProject,
  copyScaffoldPrompt,
  openProgressModal
} from './project/wizard.js';
import { selectNode, closePanel, forceUnlock, initPanelResizer } from './panel/detail-panel.js';
import {
  renderGraph,
  fitToView,
  searchAndCenterFirstMatch,
  handleSearchInput,
  handleResize,
  highlightNode,
  applyGraphFilters,
  simulation,
  currentZoom,
  currentSvg,
  pinnedNodePositions
} from './graph/render.js';
import { initWorkstation, switchViewMode } from './workstation/workstation.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basename(path) {
  return (path || '').split('/').pop();
}

// ── Extraction and Lock Polling ──
export async function fetchLocks() {
  try {
    const res = await fetch('/locks');
    if (res.ok) {
      state.currentLocks = await res.json();
      notifyStateChange('currentLocks', state.currentLocks);
      renderGraph();
    }
  } catch (_) {}
}

export async function doExtract(projectPath) {
  const pathInput = document.getElementById('project-path');
  const statusEl = document.getElementById('status');
  const btnExtract = document.getElementById('btn-extract');
  const btnReExtract = document.getElementById('btn-re-extract');
  const btnAddNode = document.getElementById('btn-add-node');

  if (pathInput) {
    pathInput.value = projectPath;
    pathInput.title = projectPath;
  }

  closePanel();

  if (statusEl) {
    statusEl.textContent = 'Extracting...';
    statusEl.style.color = '#8b9bb4';
  }
  if (btnExtract) btnExtract.disabled = true;
  if (btnReExtract) btnReExtract.disabled = true;
  if (btnAddNode) btnAddNode.disabled = true;

  try {
    const res = await fetch('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const manifest = await res.json();
    state.manifest = manifest;
    state.projectPath = manifest.project_root;
    notifyStateChange('manifest', manifest);
    notifyStateChange('projectPath', manifest.project_root);

    addRecentProject(manifest.project_root);

    if (statusEl) {
      statusEl.textContent = `${manifest.nodes.length} nodes, ${manifest.edges.length} edges — ${basename(manifest.project_root)}`;
      statusEl.style.color = '#8b9bb4';
    }
    if (btnReExtract) btnReExtract.disabled = false;
    if (btnAddNode) btnAddNode.disabled = false;

    await fetchLocks();
    updateSidebarTree();
    checkAndSetupPreviewPanel();
    renderGraph();
    setTimeout(fitToView, 350);
    updateConsoleBadge();

    // Dev server status check
    fetch(`/dev-server/status?projectPath=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(st => {
        if (st && st.running) {
          state.activeDevServer = { projectPath, url: st.url, pid: st.pid };
          updateDevServerUiState(true, st.url);
        } else {
          state.activeDevServer = null;
          updateDevServerUiState(false);
        }
      }).catch(() => {});

  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = '#f87171';
    }
  } finally {
    if (btnExtract) btnExtract.disabled = false;
  }
}

// ── Recent Projects Management ──
export function getRecentProjects() {
  try {
    return JSON.parse(localStorage.getItem('cf_recent_projects') || '[]');
  } catch (_) {
    return [];
  }
}

export function addRecentProject(path) {
  if (!path) return;
  let recents = getRecentProjects().filter(p => p !== path);
  recents.unshift(path);
  if (recents.length > 8) recents = recents.slice(0, 8);
  try {
    localStorage.setItem('cf_recent_projects', JSON.stringify(recents));
  } catch (_) {}
  renderRecentProjectsMenu();
}

export function renderRecentProjectsMenu() {
  const container = document.getElementById('recent-projects-list');
  if (!container) return;
  const recents = getRecentProjects();
  if (recents.length === 0) {
    container.innerHTML = '<div class="dropdown-item" style="color:var(--dim); font-size:0.7rem;">No recent projects</div>';
    return;
  }
  container.innerHTML = recents.map(p => `
    <div class="dropdown-item recent-proj-item" data-path="${esc(p)}" style="font-size:0.72rem; font-family:'JetBrains Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(p)}">
      ${esc(basename(p))} <span style="color:var(--dim); font-size:0.65rem;">(${esc(p)})</span>
    </div>
  `).join('');

  container.querySelectorAll('.recent-proj-item').forEach(el => {
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-path');
      const filesMenu = document.getElementById('files-menu');
      if (filesMenu) filesMenu.style.display = 'none';
      if (p) doExtract(p);
    });
  });
}

// ── Bottom Terminal Panel Drawer Orchestration ──
let terminalPollInterval = null;
let bottomTerminalFilter = 'red';
let bottomTerminalLogs = { logs: [], redLogs: [] };
let appTerminalLogs = [];

export function openBottomTerminal(forceExpand = true) {
  const panel = document.getElementById('bottom-terminal-panel');
  const collapseBtn = document.getElementById('btn-term-collapse');
  if (!panel) return;
  panel.style.display = 'flex';
  if (forceExpand) {
    panel.classList.remove('collapsed');
    if (collapseBtn) collapseBtn.textContent = '▾';
  }
  fetchBottomTerminalLogs(true);
  if (terminalPollInterval) clearInterval(terminalPollInterval);
  terminalPollInterval = setInterval(() => {
    if (panel.style.display !== 'none') {
      fetchBottomTerminalLogs(false);
    } else {
      clearInterval(terminalPollInterval);
      terminalPollInterval = null;
    }
  }, 1500);
}

export function closeBottomTerminal() {
  const panel = document.getElementById('bottom-terminal-panel');
  if (!panel) return;
  panel.style.display = 'none';
  if (terminalPollInterval) {
    clearInterval(terminalPollInterval);
    terminalPollInterval = null;
  }
}

export function toggleBottomTerminal() {
  const panel = document.getElementById('bottom-terminal-panel');
  const collapseBtn = document.getElementById('btn-term-collapse');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  const isCollapsed = panel.classList.contains('collapsed');
  if (isHidden) {
    openBottomTerminal(true);
  } else if (isCollapsed) {
    panel.classList.remove('collapsed');
    if (collapseBtn) collapseBtn.textContent = '▾';
  } else {
    closeBottomTerminal();
  }
}

export async function fetchAppLogs() {
  try {
    const res = await fetch('/app-logs');
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.logs)) {
        appTerminalLogs = data.logs;
        if (bottomTerminalFilter === 'app') {
          renderBottomTerminal();
        }
      }
    }
  } catch (_) {}
}

export function renderBottomTerminal() {
  const view = document.getElementById('terminal-output-view');
  const errorPill = document.getElementById('terminal-error-pill');
  if (!view) return;

  if (bottomTerminalFilter === 'app') {
    if (!appTerminalLogs || appTerminalLogs.length === 0) {
      view.innerHTML = '<div style="color:var(--dim); font-style:italic;">No ContextForge application logs recorded yet.</div>';
    } else {
      view.innerHTML = appTerminalLogs.map(l => {
        let badgeColor = '#38bdf8';
        let badgeText = 'INFO';
        if (l.level === 'warn') { badgeColor = '#fbbf24'; badgeText = 'WARN'; }
        else if (l.level === 'error') { badgeColor = '#ef4444'; badgeText = 'ERROR'; }
        else if (l.level === 'success') { badgeColor = '#34d399'; badgeText = 'OK'; }

        return `<div style="padding:2px 0; font-family:'JetBrains Mono',monospace;">` +
          `<span style="color:#64748b; font-size:0.68rem; margin-right:6px;">[${esc(l.timestamp)}]</span>` +
          `<span style="color:${badgeColor}; font-weight:700; font-size:0.68rem; margin-right:8px; border:1px solid ${badgeColor}40; border-radius:3px; padding:0 3px;">${badgeText}</span>` +
          `<span style="color:#e2e8f0;">${esc(l.text)}</span>` +
          `</div>`;
      }).join('');
    }
    if (errorPill) errorPill.style.display = 'none';
    view.scrollTop = view.scrollHeight;
    return;
  }

  const list = bottomTerminalFilter === 'red' ? (bottomTerminalLogs.redLogs || []) : (bottomTerminalLogs.logs || []);
  if (!list || list.length === 0) {
    view.innerHTML = bottomTerminalFilter === 'red'
      ? '<div style="color:var(--dim); font-style:italic;">No red errors detected in terminal. (Click "All" to view normal output).</div>'
      : '<div style="color:var(--dim); font-style:italic;">Terminal is empty.</div>';
  } else {
    view.innerHTML = list.map(l => {
      const color = l.isError ? '#ff6b6b; font-weight:600;' : '#8b949e;';
      return `<div style="color:${color} padding:1px 0; font-family:'JetBrains Mono',monospace;">${esc(l.text)}</div>`;
    }).join('');
  }

  if (errorPill) {
    const errCount = (bottomTerminalLogs.redLogs || []).length;
    if (errCount > 0) {
      errorPill.style.display = 'inline-block';
      errorPill.textContent = `🔴 ${errCount} error${errCount === 1 ? '' : 's'}`;
    } else {
      errorPill.style.display = 'none';
    }
  }

  view.scrollTop = view.scrollHeight;
}

export async function fetchBottomTerminalLogs(forceCheck = false) {
  if (bottomTerminalFilter === 'app') {
    await fetchAppLogs();
    return;
  }
  const projectPath = state.projectPath;
  if (!projectPath) return;

  const shouldCheck = forceCheck || (!bottomTerminalLogs.logs || bottomTerminalLogs.logs.length === 0);
  try {
    const res = await fetch(`/console-logs?projectPath=${encodeURIComponent(projectPath)}${shouldCheck ? '&check=true' : ''}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        bottomTerminalLogs = { logs: data.logs || [], redLogs: data.redLogs || [] };
        renderBottomTerminal();
        updateConsoleBadge(bottomTerminalLogs.redLogs.length);
      }
    }
  } catch (_) {}
}

// ── Global Event Wiring ──
export function initApp() {
  initPanelResizer();
  initHistoryShortcuts();
  renderRecentProjectsMenu();

  // Terminal drag resizer
  const termResizer = document.getElementById('terminal-panel-resizer');
  const bottomPanel = document.getElementById('bottom-terminal-panel');
  let isResizingTerminal = false;
  let termStartY = 0;
  let termStartHeight = 0;

  if (termResizer) {
    termResizer.addEventListener('mousedown', (e) => {
      isResizingTerminal = true;
      termResizer.classList.add('resizing');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      termStartY = e.clientY;
      termStartHeight = bottomPanel ? bottomPanel.offsetHeight : 220;
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!isResizingTerminal || !bottomPanel) return;
    const deltaY = termStartY - e.clientY;
    const newHeight = Math.max(90, Math.min(window.innerHeight * 0.75, termStartHeight + deltaY));
    bottomPanel.style.height = `${newHeight}px`;
    bottomPanel.classList.remove('collapsed');
  });

  window.addEventListener('mouseup', () => {
    if (isResizingTerminal) {
      isResizingTerminal = false;
      if (termResizer) termResizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // Window resize for D3 graph
  window.addEventListener('resize', handleResize);

  // Files menu toggle
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const filesMenu = document.getElementById('files-menu');
  const recentParent = document.getElementById('menu-recent-parent');
  const recentTrigger = document.getElementById('menu-recent-trigger');

  if (btnSidebarToggle && filesMenu) {
    btnSidebarToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = filesMenu.style.display === 'block';
      filesMenu.style.display = isVisible ? 'none' : 'block';
      if (isVisible && recentParent) {
        recentParent.classList.remove('open');
      }
    });
    document.addEventListener('click', (e) => {
      if (!filesMenu.contains(e.target) && !btnSidebarToggle.contains(e.target)) {
        filesMenu.style.display = 'none';
        if (recentParent) recentParent.classList.remove('open');
      }
    });
  }

  // Open project from dropdown
  document.getElementById('menu-open-project')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    const input = document.getElementById('project-path');
    if (input) {
      input.focus();
      input.select();
      showToast('Enter or paste project folder path and press Enter or Extract', 'info');
    }
  });

  // Toggle file tree from dropdown
  document.getElementById('menu-toggle-tree')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    const sidebar = document.getElementById('left-sidebar');
    if (sidebar) {
      const isCollapsed = sidebar.classList.toggle('collapsed');
      showToast(isCollapsed ? 'File tree collapsed' : 'File tree expanded', 'info');
    }
  });

  // Context for AI (README) from dropdown
  document.getElementById('menu-ai-context')?.addEventListener('click', async () => {
    if (filesMenu) filesMenu.style.display = 'none';
    if (!state.projectPath) {
      showToast('Please open or extract a project first.', 'warn');
      return;
    }
    try {
      const res = await fetch('/package-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: state.projectPath, mode: 'outline' })
      });
      if (res.ok) {
        const d = await res.json();
        if (d.prompt) {
          await navigator.clipboard.writeText(d.prompt);
          showToast('✓ Copied Project AI Context & Architecture to clipboard!', 'success');
        }
      }
    } catch (_) {
      showToast('Could not package AI context', 'warn');
    }
  });

  // Unconnected nodes dropdown toggle
  const unconnectedHeader = document.getElementById('unconnected-header');
  const unconnectedToggle = document.getElementById('unconnected-toggle');
  const unconnectedBody = document.getElementById('unconnected-body');
  const handleUnconnectedToggle = () => {
    if (!unconnectedBody) return;
    const isHidden = unconnectedBody.style.display === 'none';
    unconnectedBody.style.display = isHidden ? 'block' : 'none';
    if (unconnectedToggle) unconnectedToggle.textContent = isHidden ? '▴' : '▾';
  };
  unconnectedHeader?.addEventListener('click', handleUnconnectedToggle);

  // Legend dropdown toggle
  const legendHeader = document.getElementById('legend-header');
  const legendToggle = document.getElementById('legend-toggle');
  const legendBody = document.getElementById('legend-body');
  const handleLegendToggle = () => {
    if (!legendBody) return;
    const isHidden = legendBody.style.display === 'none';
    legendBody.style.display = isHidden ? 'block' : 'none';
    if (legendToggle) legendToggle.textContent = isHidden ? '▴' : '▾';
  };
  legendHeader?.addEventListener('click', handleLegendToggle);

  // Robust Recent Projects Submenu UX: Hover grace timer + Click toggle
  if (recentParent && recentTrigger) {
    let recentCloseTimer = null;
    recentParent.addEventListener('mouseenter', () => {
      if (recentCloseTimer) clearTimeout(recentCloseTimer);
      recentParent.classList.add('open');
    });
    recentParent.addEventListener('mouseleave', () => {
      recentCloseTimer = setTimeout(() => {
        recentParent.classList.remove('open');
      }, 350); // 350ms grace timeout so diagonal mouse movement never drops submenu
    });
    recentTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      recentParent.classList.toggle('open');
    });
  }

  // Top action buttons
  document.getElementById('btn-extract')?.addEventListener('click', () => {
    const p = document.getElementById('project-path')?.value.trim();
    if (p) doExtract(p);
  });
  document.getElementById('btn-re-extract')?.addEventListener('click', () => {
    if (state.projectPath) doExtract(state.projectPath);
  });
  const pathInput = document.getElementById('project-path');
  if (pathInput) {
    pathInput.title = pathInput.value;
    pathInput.addEventListener('input', () => {
      pathInput.title = pathInput.value;
    });
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = e.target.value.trim();
        if (p) doExtract(p);
      }
    });
  }

  document.getElementById('btn-add-from-clipboard')?.addEventListener('click', handleQuickPaste);
  document.getElementById('menu-add-clipboard')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    openClipboardModal();
  });

  document.getElementById('btn-undo')?.addEventListener('click', performUndo);
  document.getElementById('btn-redo')?.addEventListener('click', performRedo);
  document.getElementById('menu-undo')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    performUndo();
  });
  document.getElementById('menu-redo')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    performRedo();
  });

  document.getElementById('btn-report-issue')?.addEventListener('click', () => openIssueReportModal(state.selectedNodeId || ''));
  document.getElementById('menu-report-issue')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    openIssueReportModal(state.selectedNodeId || '');
  });

  document.getElementById('btn-console')?.addEventListener('click', toggleBottomTerminal);
  document.getElementById('menu-console')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    openBottomTerminal(true);
  });

  document.getElementById('btn-play-game')?.addEventListener('click', playGameInNewTab);
  document.getElementById('menu-play-game')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    playGameInNewTab();
  });

  document.getElementById('btn-new-project')?.addEventListener('click', openNewProjectModal);
  document.getElementById('menu-new-project')?.addEventListener('click', () => {
    if (filesMenu) filesMenu.style.display = 'none';
    openNewProjectModal();
  });
  document.getElementById('btn-sidebar-new-project')?.addEventListener('click', openNewProjectModal);

  document.getElementById('btn-toggle-progress')?.addEventListener('click', openProgressModal);

  // Search and Graph controls
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', handleSearchInput);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchAndCenterFirstMatch();
    });
  }

  const btnFitView = document.getElementById('btn-fit-view');
  if (btnFitView) btnFitView.addEventListener('click', fitToView);

  const btnFocusMode = document.getElementById('btn-focus-mode');
  if (btnFocusMode) {
    btnFocusMode.addEventListener('click', () => {
      btnFocusMode.classList.toggle('active');
      applyGraphFilters();
    });
  }

  const btnResetLayout = document.getElementById('btn-reset-layout');
  if (btnResetLayout) {
    btnResetLayout.addEventListener('click', () => {
      pinnedNodePositions.clear();
      if (state.manifest) {
        state.manifest.nodes.forEach(n => { delete n.fx; delete n.fy; });
        renderGraph();
        setTimeout(fitToView, 500);
      }
    });
  }

  // Terminal buttons
  document.getElementById('btn-term-filter-all')?.addEventListener('click', () => {
    bottomTerminalFilter = 'all';
    document.getElementById('btn-term-filter-all')?.classList.add('active');
    document.getElementById('btn-term-filter-red')?.classList.remove('active');
    document.getElementById('btn-term-filter-cf')?.classList.remove('active');
    renderBottomTerminal();
  });
  document.getElementById('btn-term-filter-red')?.addEventListener('click', () => {
    bottomTerminalFilter = 'red';
    document.getElementById('btn-term-filter-red')?.classList.add('active');
    document.getElementById('btn-term-filter-all')?.classList.remove('active');
    document.getElementById('btn-term-filter-cf')?.classList.remove('active');
    renderBottomTerminal();
  });
  document.getElementById('btn-term-filter-cf')?.addEventListener('click', () => {
    bottomTerminalFilter = 'app';
    document.getElementById('btn-term-filter-cf')?.classList.add('active');
    document.getElementById('btn-term-filter-all')?.classList.remove('active');
    document.getElementById('btn-term-filter-red')?.classList.remove('active');
    fetchAppLogs();
  });
  document.getElementById('btn-term-copy')?.addEventListener('click', async () => {
    const list = bottomTerminalFilter === 'app'
      ? appTerminalLogs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.text}`)
      : (bottomTerminalFilter === 'red' ? (bottomTerminalLogs.redLogs || []) : (bottomTerminalLogs.logs || [])).map(l => l.text);
    if (list.length > 0) {
      await navigator.clipboard.writeText(list.join('\n'));
      showToast('✓ Copied terminal logs');
    }
  });
  document.getElementById('btn-term-clear')?.addEventListener('click', async () => {
    if (bottomTerminalFilter === 'app') {
      await fetch('/app-logs/clear', { method: 'POST' });
      appTerminalLogs = [];
      renderBottomTerminal();
      showToast('ContextForge console cleared');
    } else {
      if (state.projectPath) {
        await fetch(`/console-logs?projectPath=${encodeURIComponent(state.projectPath)}&clear=true`);
        bottomTerminalLogs = { logs: [], redLogs: [] };
        renderBottomTerminal();
        updateConsoleBadge(0);
        showToast('Project console cleared');
      }
    }
  });
  document.getElementById('btn-term-collapse')?.addEventListener('click', () => {
    const panel = document.getElementById('bottom-terminal-panel');
    const btn = document.getElementById('btn-term-collapse');
    if (!panel) return;
    const isCol = panel.classList.toggle('collapsed');
    if (btn) btn.textContent = isCol ? '▴' : '▾';
  });
  document.getElementById('btn-term-close')?.addEventListener('click', closeBottomTerminal);

  // Live diagnostics bridge receiver
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CF_CONSOLE_LOG') {
      const { level, message } = event.data;
      const isError = level === 'error';
      if (!bottomTerminalLogs.logs) bottomTerminalLogs.logs = [];
      if (!bottomTerminalLogs.redLogs) bottomTerminalLogs.redLogs = [];
      const entry = {
        id: Date.now() + Math.random(),
        text: message,
        isError,
        timestamp: new Date().toLocaleTimeString()
      };
      bottomTerminalLogs.logs.push(entry);
      if (isError) {
        bottomTerminalLogs.redLogs.push(entry);
        openBottomTerminal(true);
      }
      renderBottomTerminal();
      updateConsoleBadge(bottomTerminalLogs.redLogs.length);
    }
  });

  // Initialize 3-Pane Workstation
  initWorkstation();

  // Auto-extract last used project
  const recents = getRecentProjects();
  if (recents.length > 0) {
    const input = document.getElementById('project-path');
    if (input && !input.value) {
      input.value = recents[0];
      input.title = recents[0];
      doExtract(recents[0]);
    }
  }
}

// Expose on window.ContextForge for inline HTML handlers & tests
window.ContextForge = {
  state,
  subscribe,
  notifyStateChange,
  showToast,
  performUndo,
  performRedo,
  updateHistoryUI,
  handleQuickPaste,
  applyClipboardContentDirectly,
  openClipboardModal,
  openConsoleModal,
  updateConsoleBadge,
  fetchConsoleLogs,
  ensureDevServerRunning,
  stopManagedDevServer,
  togglePreviewPanel,
  reloadPreviewIframe,
  runHtmlFile,
  playGameInNewTab,
  updateDevServerUiState,
  updateSidebarTree,
  selectFile,
  saveRawFile,
  openIssueReportModal,
  copyIssuePrompt,
  openNewProjectModal,
  selectProjectEngine,
  renderNewProjectStep1,
  renderNewProjectStep2,
  renderNewProjectStep3,
  pasteClipboardToStep3,
  submitNewProject,
  copyScaffoldPrompt,
  openProgressModal,
  selectNode,
  closePanel,
  forceUnlock,
  renderGraph,
  fitToView,
  searchAndCenterFirstMatch,
  highlightNode,
  applyGraphFilters,
  doExtract,
  fetchLocks,
  openBottomTerminal,
  closeBottomTerminal,
  toggleBottomTerminal,
  initWorkstation,
  switchViewMode,
  projectDiskFiles
};

// Bootstrap when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
