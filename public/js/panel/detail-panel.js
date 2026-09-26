/**
 * public/js/panel/detail-panel.js
 * Side detail panel, node inspection, locks, asset slot contracts, and drag-drop validation.
 */

import { state, notifyStateChange } from '../state.js';
import { showToast } from '../shared/toast.js';
import { highlightNode } from '../graph/render.js';
import { openIssueReportModal } from '../issue/issue-modal.js';
import { runHtmlFile } from '../preview/preview.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escJsArg(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function basename(path) {
  return (path || '').split('/').pop();
}

export function closePanel() {
  const sidePanel = document.getElementById('side-panel');
  if (sidePanel) sidePanel.classList.remove('open');
  state.selectedNodeId = null;
  notifyStateChange('selectedNodeId', null);
  highlightNode(null);
}

export async function forceUnlock(nodeId) {
  try {
    const res = await fetch('/force-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId })
    });
    if (res.ok) {
      showToast(`✓ Unlocked ${nodeId}`);
      if (window.ContextForge && window.ContextForge.fetchLocks) {
        await window.ContextForge.fetchLocks();
      }
      selectNode(nodeId);
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed to unlock', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export function selectNode(nodeId) {
  const manifest = state.manifest;
  if (!manifest) return;
  const node = manifest.nodes.find(n => n.id === nodeId);
  if (!node) return;

  state.selectedNodeId = nodeId;
  notifyStateChange('selectedNodeId', nodeId);
  highlightNode(nodeId);

  const sidePanel = document.getElementById('side-panel');
  const panelContent = document.getElementById('panel-content');
  if (!panelContent || !sidePanel) return;

  sidePanel.classList.add('open');

  const c = node.contract || {};

  function listItems(arr, clickable = false) {
    if (!arr || arr.length === 0) return '<span class="panel-empty">none</span>';
    return '<ul class="panel-list">' +
      arr.map(item => {
        if (clickable) {
          return `<li class="clickable" onclick="window.ContextForge.selectNode('${escJsArg(item)}')">${esc(item)}</li>`;
        }
        return `<li>${esc(item)}</li>`;
      }).join('') + '</ul>';
  }

  const lock = state.currentLocks ? state.currentLocks[nodeId] : null;
  const lockHtml = lock ? `
    <div class="panel-section">
      <h3>🔒 Lock</h3>
      <span class="badge badge-lock">LOCKED</span>
      <ul class="panel-list">
        <li><strong>Holder:</strong> ${esc(lock.holder)}</li>
        <li><strong>Since:</strong> ${esc(new Date(lock.locked_at).toLocaleString())}</li>
      </ul>
      <button class="btn-force-unlock" id="btn-force-unlock-node">⚠ Force Unlock</button>
    </div>
  ` : '';

  const isHtml = nodeId.toLowerCase().endsWith('.html');

  panelContent.innerHTML = `
    <button class="panel-close" id="btn-panel-close-trigger">✕</button>
    <div class="panel-title">${esc(node.id)}</div>

    <div class="panel-section" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.4rem;">
      <div style="display:flex; gap:0.3rem; align-items:center;">
        <span class="badge badge-engine">${esc(node.engine || '')}</span>
        <span class="badge badge-type">${esc(node.type || '')}</span>
        ${lock ? '<span class="badge badge-lock">LOCKED</span>' : ''}
      </div>
      <div style="display:flex; gap:0.35rem; align-items:center;">
        ${isHtml ? `<button class="btn-run-file" id="btn-panel-run-html">▶ Run</button>` : ''}
        <button class="secondary" id="btn-panel-report-issue" style="font-size:0.75rem; height:24px; padding:0 0.5rem; display:inline-flex; align-items:center; gap:0.25rem;">🐞 Report Issue</button>
      </div>
    </div>

    <div class="panel-section">
      <button class="btn-package-context" id="btn-panel-package-context">
        📦 Package Context for Model
      </button>
    </div>

    ${lockHtml}

    <div class="panel-section">
      <h3>Exports</h3>
      ${listItems(c.exports)}
    </div>

    ${c.signals && c.signals.length > 0 ? `
      <div class="panel-section">
        <h3>Signals</h3>
        ${listItems(c.signals)}
      </div>
    ` : ''}

    ${c.requires && c.requires.length > 0 ? `
      <div class="panel-section">
        <h3>Requires</h3>
        ${listItems(c.requires)}
      </div>
    ` : ''}

    <div class="panel-section">
      <h3>Depends On</h3>
      ${listItems(node.depends_on, true)}
    </div>

    <div class="panel-section">
      <h3>Depended On By</h3>
      ${listItems(node.depended_on_by, true)}
    </div>

    ${node.type === 'asset' ? `
      <div class="panel-section">
        <h3>🎨 Asset Slot Contract</h3>
        <div class="slot-card">
          <div style="font-size:0.75rem; color:var(--dim); margin-bottom:0.4rem;">
            Slot: <strong style="color:var(--text);">${esc((node.slot && node.slot.slot) || (node.contract && node.contract.slot && node.contract.slot.slot) || basename(node.id))}</strong>
            <span class="slot-chip">${esc(((node.slot && node.slot.format) || (node.contract && node.contract.slot && node.contract.slot.format) || 'asset').toUpperCase())}</span>
            ${((node.slot && node.slot.rigged) || (node.contract && node.contract.slot && node.contract.slot.rigged)) ? '<span class="slot-chip">RIGGED</span>' : ''}
            ${((node.slot && node.slot.dimensions) || (node.contract && node.contract.slot && node.contract.slot.dimensions)) ? `<span class="slot-chip">${esc(node.slot?.dimensions || node.contract?.slot?.dimensions)}</span>` : ''}
          </div>

          ${((node.slot && node.slot.expected_animations) || (node.contract && node.contract.slot && node.contract.slot.expected_animations)) ? `
            <div style="margin-bottom:0.4rem;">
              <span style="font-size:0.72rem; color:var(--dim); display:block; margin-bottom:0.2rem;">Required Animations:</span>
              ${((node.slot && node.slot.expected_animations) || (node.contract.slot.expected_animations)).map(a => `<span class="slot-chip">🎬 ${esc(a)}</span>`).join('')}
            </div>
          ` : ''}

          <div class="drop-zone" id="asset-drop-zone">
            <div style="font-size:1.2rem; margin-bottom:0.2rem;">📥</div>
            <div>Drag & drop replacement asset here</div>
            <div style="font-size:0.7rem; color:var(--dim); margin-top:0.2rem;">Validated against slot requirements before swapping</div>
          </div>
          <div id="slot-validation-result"></div>
        </div>
      </div>
    ` : ''}
  `;

  document.getElementById('btn-panel-close-trigger')?.addEventListener('click', closePanel);
  document.getElementById('btn-force-unlock-node')?.addEventListener('click', () => forceUnlock(nodeId));
  document.getElementById('btn-panel-run-html')?.addEventListener('click', () => runHtmlFile(nodeId));
  document.getElementById('btn-panel-report-issue')?.addEventListener('click', () => openIssueReportModal(nodeId));
  document.getElementById('btn-panel-package-context')?.addEventListener('click', () => openPackageContextModal(nodeId));

  // Initialize drag & drop for assets
  const dropZone = document.getElementById('asset-drop-zone');
  if (dropZone) {
    initAssetDropZone(dropZone, node);
  }
}

export function initAssetDropZone(dropZone, node) {
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', async (e) => {
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const valResult = document.getElementById('slot-validation-result');
    if (valResult) {
      valResult.innerHTML = '<div style="font-size:0.75rem; color:var(--dim); margin-top:0.4rem;">Validating asset...</div>';
    }

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        const res = await fetch('/swap-asset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodeId: node.id,
            fileName: file.name,
            fileContent: base64,
            holder: 'user'
          })
        });

        const data = await res.json();
        if (data.validation && !data.validation.valid) {
          if (valResult) {
            valResult.innerHTML = `
              <div class="slot-validation-box invalid">
                <strong>❌ Contract Mismatch:</strong>
                <ul style="margin:0.2rem 0 0 1rem; padding:0;">
                  ${data.validation.errors.map(err => `<li>${esc(err)}</li>`).join('')}
                </ul>
              </div>
            `;
          }
          showToast('Asset failed validation contract', 'error');
        } else if (data.success) {
          if (valResult) {
            valResult.innerHTML = `
              <div class="slot-validation-box valid">
                <strong>✓ Swapped successfully!</strong>
                <div style="font-size:0.7rem; color:var(--dim); margin-top:0.2rem;">Complies with all slot contract rules.</div>
              </div>
            `;
          }
          showToast(`✓ Swapped ${basename(node.id)}`);
          if (window.ContextForge && window.ContextForge.doExtract) {
            window.ContextForge.doExtract(state.projectPath);
          }
        } else {
          if (valResult) {
            valResult.innerHTML = `<div class="slot-validation-box invalid">${esc(data.error || 'Swap failed')}</div>`;
          }
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      if (valResult) {
        valResult.innerHTML = `<div class="slot-validation-box invalid">Error: ${esc(err.message)}</div>`;
      }
    }
  });
}

export function openPackageContextModal(nodeId) {
  const manifest = state.manifest;
  if (!manifest) return;
  const node = manifest.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 640px;">
        <div class="modal-header">
          <div class="modal-title">📦 Context Bundle: ${esc(nodeId)}</div>
          <button class="panel-close" id="btn-close-package-modal">✕</button>
        </div>
        <div class="modal-body">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            <p style="font-size:0.8rem; color:var(--dim); margin:0;">
              Scoped context: target file in full + dependency signatures & interface outlines.
            </p>
            <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; cursor:pointer; color:var(--text); user-select:none;">
              <input type="checkbox" id="pkg-use-full-deps">
              <span>Include full dependency sources</span>
            </label>
          </div>

          <div id="pkg-oversized-nudge" style="display:none;" class="oversized-banner"></div>

          <textarea id="package-context-area" class="modal-textarea" readonly style="height:230px;">Loading context package...</textarea>

          <div id="pkg-stats-bar" style="font-size:0.75rem; color:var(--dim); display:flex; justify-content:space-between; align-items:center; margin-top:0.3rem;">
            <span>Estimated Size: calculating...</span>
          </div>
        </div>
        <div class="modal-footer" style="justify-content:space-between;">
          <button class="secondary" id="btn-done-package-modal">Close</button>
          <button id="btn-copy-package-context">📋 Copy Context</button>
        </div>
      </div>
    </div>
  `;

  const closeFn = () => { modalRoot.innerHTML = ''; };
  document.getElementById('btn-close-package-modal')?.addEventListener('click', closeFn);
  document.getElementById('btn-done-package-modal')?.addEventListener('click', closeFn);

  const area = document.getElementById('package-context-area');
  const statsBar = document.getElementById('pkg-stats-bar');
  const fullDepsCheckbox = document.getElementById('pkg-use-full-deps');
  const oversizedEl = document.getElementById('pkg-oversized-nudge');

  async function loadContext() {
    const useFull = fullDepsCheckbox && fullDepsCheckbox.checked;
    if (area) area.value = 'Generating context package...';
    try {
      const res = await fetch('/package-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, scoped: !useFull })
      });
      const data = await res.json();
      if (area && data.context) {
        area.value = data.context;
        if (statsBar) {
          statsBar.innerHTML = `
            <span>Size: <strong>${data.chars || area.value.length}</strong> chars (~${data.tokens || Math.round(area.value.length / 4)} tokens)</span>
            ${data.scoped ? '<span style="color:var(--green); font-weight:600;">✓ Scoped outlines active</span>' : '<span style="color:var(--dim);">Full sources attached</span>'}
          `;
        }
      }
    } catch (_) {}
  }

  fullDepsCheckbox?.addEventListener('change', loadContext);
  loadContext();

  document.getElementById('btn-copy-package-context')?.addEventListener('click', async () => {
    if (area) {
      await navigator.clipboard.writeText(area.value);
      showToast('✓ Copied package context');
    }
  });
}

export function initPanelResizer() {
  const panelResizer = document.getElementById('panel-resizer');
  const sidePanel = document.getElementById('side-panel');
  if (!panelResizer || !sidePanel) return;

  let isResizingPanel = false;
  let startX = 0;
  let startW = 0;

  panelResizer.addEventListener('mousedown', (e) => {
    isResizingPanel = true;
    startX = e.clientX;
    startW = sidePanel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isResizingPanel) return;
    const deltaX = startX - e.clientX;
    const newWidth = Math.max(260, Math.min(800, startW + deltaX));
    sidePanel.style.width = `${newWidth}px`;
    document.documentElement.style.setProperty('--panel-w', `${newWidth}px`);
  });

  window.addEventListener('mouseup', () => {
    if (isResizingPanel) {
      isResizingPanel = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}
