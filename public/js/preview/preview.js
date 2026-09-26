/**
 * public/js/preview/preview.js
 * Dev server management and web live preview iframe panel.
 */

import { state } from '../state.js';
import { showToast } from '../shared/toast.js';

let activeDevServer = null;
export let openGameTabs = [];

export function updateDevServerUiState(serverState, url) {
  const btnPlayGame = document.getElementById('btn-play-game');
  const menuPlayGame = document.getElementById('menu-play-game');
  const previewStatusIndicator = document.getElementById('preview-status-indicator');

  if (btnPlayGame) {
    if (serverState === 'setting-up') {
      btnPlayGame.textContent = '⏳ Setting up...';
      btnPlayGame.className = 'btn-play-top setting-up';
      btnPlayGame.disabled = true;
      btnPlayGame.title = 'Running npm install and starting dev server...';
    } else if (serverState === true) {
      const port = url ? (url.match(/:(\d+)/) ? url.match(/:(\d+)/)[1] : 'dev') : 'dev';
      btnPlayGame.textContent = `■ Stop (${port})`;
      btnPlayGame.className = 'btn-play-top running';
      btnPlayGame.disabled = false;
      btnPlayGame.title = `Dev server running at ${url || 'port ' + port} — click to stop`;
    } else {
      btnPlayGame.textContent = '▶ Play';
      btnPlayGame.className = 'btn-play-top';
      btnPlayGame.disabled = false;
      btnPlayGame.title = 'Find entrypoint (index.html / main.html) and play in a new tab';
    }
  }

  if (menuPlayGame) {
    menuPlayGame.textContent = serverState === true ? '■ Stop dev server' : '▶ Play game in new tab';
  }

  if (previewStatusIndicator) {
    if (serverState === 'setting-up') {
      previewStatusIndicator.textContent = '⏳ Starting...';
      previewStatusIndicator.style.color = '#f59e0b';
    } else if (serverState === true) {
      previewStatusIndicator.textContent = '● Running';
      previewStatusIndicator.style.color = 'var(--green)';
    } else {
      previewStatusIndicator.textContent = '○ Stopped';
      previewStatusIndicator.style.color = 'var(--dim)';
    }
  }
}

export async function ensureDevServerRunning(projectPath = state.projectPath) {
  const previewInput = document.getElementById('preview-url-input');
  const webPreviewIframe = document.getElementById('web-preview-iframe');
  let baseUrl = (previewInput ? previewInput.value.trim() : '') || 'http://localhost:5173';

  // First check if already responding
  try {
    const pingRes = await fetch(`/ping-dev-server?url=${encodeURIComponent(baseUrl)}`);
    const pingData = await pingRes.json();
    if (pingData && pingData.reachable) {
      activeDevServer = { projectPath, url: baseUrl, pid: null };
      updateDevServerUiState(true, baseUrl);
      return { success: true, url: baseUrl };
    }
  } catch (_) {}

  // If not running, perform setup
  updateDevServerUiState('setting-up');
  showToast('⚙ Setting up dev server (npm install & npm run dev)...', 'info');

  try {
    const res = await fetch('/dev-server/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to start dev server');
    }

    baseUrl = data.url || baseUrl;
    if (previewInput) previewInput.value = baseUrl;
    activeDevServer = { projectPath, url: baseUrl, pid: data.pid };
    updateDevServerUiState(true, baseUrl);

    if (webPreviewIframe) {
      try {
        webPreviewIframe.src = baseUrl;
      } catch (_) {}
    }

    return { success: true, url: baseUrl };
  } catch (err) {
    updateDevServerUiState(false);
    showToast(`Setup failed: ${err.message}. Start the dev server first (npm run dev)`, 'error');
    throw err;
  }
}

export async function stopManagedDevServer(projectPath = state.projectPath, fromTabClosed = false) {
  const target = projectPath || (activeDevServer ? activeDevServer.projectPath : state.projectPath);
  try {
    await fetch('/dev-server/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: target })
    });
  } catch (_) {}

  if (!fromTabClosed && openGameTabs.length > 0) {
    for (const tab of openGameTabs) {
      try {
        if (tab && !tab.closed) tab.close();
      } catch (_) {}
    }
    openGameTabs = [];
  }

  activeDevServer = null;
  updateDevServerUiState(false);
  const msg = fromTabClosed ? '✓ Game tab closed — npm dev server stopped' : '✓ Dev server stopped';
  showToast(msg, 'info');
}

export function togglePreviewPanel() {
  const webPreviewPanel = document.getElementById('web-preview-panel');
  const btnPreviewCollapse = document.getElementById('btn-preview-collapse');
  const btnTogglePreview = document.getElementById('btn-toggle-preview');
  if (!webPreviewPanel) return;

  const isCollapsed = webPreviewPanel.classList.toggle('collapsed');
  if (btnPreviewCollapse) {
    btnPreviewCollapse.textContent = isCollapsed ? '▴' : '▾';
  }
  if (btnTogglePreview) {
    btnTogglePreview.classList.toggle('active', !isCollapsed);
  }
}

export function reloadPreviewIframe() {
  const previewUrlInput = document.getElementById('preview-url-input');
  const webPreviewIframe = document.getElementById('web-preview-iframe');
  if (!previewUrlInput || !webPreviewIframe) return;

  let url = previewUrlInput.value.trim();
  if (!url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
    previewUrlInput.value = url;
  }
  webPreviewIframe.src = url;
  if (state.projectPath) {
    fetch('/preview-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: state.projectPath, url })
    }).catch(() => {});
  }
}

export async function runHtmlFile(filePath) {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please extract or open a project first.', 'warn');
    return;
  }

  let baseUrl = 'http://localhost:5173';
  try {
    const info = await ensureDevServerRunning(projectPath);
    baseUrl = info.url || baseUrl;
  } catch (_) {
    return;
  }

  const relPath = filePath.replace(/^\/+/, '');
  const fullUrl = relPath.toLowerCase() === 'index.html' ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/${relPath}`;
  const gameWindow = window.open(fullUrl, '_blank');
  showToast(`✓ Opened ${filePath} in new tab`, 'success');

  if (gameWindow) {
    openGameTabs.push(gameWindow);
    const pollTimer = setInterval(async () => {
      try {
        if (gameWindow.closed) {
          clearInterval(pollTimer);
          const idx = openGameTabs.indexOf(gameWindow);
          if (idx > -1) openGameTabs.splice(idx, 1);
          if (openGameTabs.length === 0 && activeDevServer) {
            await stopManagedDevServer(projectPath, true);
          }
        }
      } catch (_) {}
    }, 1000);
  }
}

export async function playGameInNewTab() {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please extract or open a project first.', 'warn');
    return;
  }

  if (activeDevServer && activeDevServer.projectPath === projectPath) {
    await stopManagedDevServer(projectPath, false);
    return;
  }

  await runHtmlFile('index.html');
}

// Beacon listeners to stop dev server on page unload
window.addEventListener('beforeunload', () => {
  if (activeDevServer && activeDevServer.projectPath) {
    try {
      const blob = new Blob([JSON.stringify({ projectPath: activeDevServer.projectPath })], { type: 'application/json' });
      navigator.sendBeacon('/dev-server/stop', blob);
    } catch (_) {}
  }
});
