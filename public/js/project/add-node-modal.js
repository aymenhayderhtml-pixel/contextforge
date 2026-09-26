/**
 * public/js/project/add-node-modal.js
 * Modal dialog for "+ Add Node" flow (T023 / T067).
 * Calls POST /scaffold to lock the node, write engine boilerplate,
 * generate an AI prompt, and re-extract the graph.
 */

import { state } from '../state.js';
import { showToast } from '../shared/toast.js';
import { doExtract } from '../app.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function closeAddNodeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

export function openAddNodeModal() {
  const root = document.getElementById('modal-root');
  if (!root) return;

  const currentEngine = (state.manifest && state.manifest.engine) ? state.manifest.engine : 'js';
  const defaultType = currentEngine === 'godot' ? 'scene' : 'module';
  const defaultHolder = localStorage.getItem('cf_session_holder') || 'agent-1';

  root.innerHTML = `
    <div class="modal-backdrop" id="add-node-backdrop">
      <div class="modal-box" style="max-width: 520px;">
        <div class="modal-header">
          <h2>+ Add Node / Module</h2>
          <button class="panel-close" id="btn-close-add-node">✕</button>
        </div>
        <div class="modal-body" id="add-node-body">
          <p style="font-size:0.8rem; color:var(--dim); margin-bottom:1rem;">
            Scaffold a new scene or module, claim its task lock, and generate an AI implementation prompt.
          </p>

          <div style="display:flex; flex-direction:column; gap:0.75rem;">
            <div>
              <label style="font-size:0.78rem; font-weight:600; display:block; margin-bottom:4px;">Engine</label>
              <select id="scaffold-engine" class="modal-input" style="width:100%;">
                <option value="js" ${currentEngine === 'js' ? 'selected' : ''}>JavaScript / Three.js</option>
                <option value="godot" ${currentEngine === 'godot' ? 'selected' : ''}>Godot 4.x</option>
              </select>
            </div>

            <div>
              <label style="font-size:0.78rem; font-weight:600; display:block; margin-bottom:4px;">Type</label>
              <select id="scaffold-type" class="modal-input" style="width:100%;">
                ${currentEngine === 'godot' ? `
                  <option value="scene" selected>Scene (.tscn)</option>
                  <option value="script">Script (.gd)</option>
                ` : `
                  <option value="module" selected>ES Module (.js)</option>
                `}
              </select>
            </div>

            <div>
              <label style="font-size:0.78rem; font-weight:600; display:block; margin-bottom:4px;">Node ID / Relative Path</label>
              <input type="text" id="scaffold-node-id" class="modal-input" style="width:100%; box-sizing:border-box;"
                placeholder="${currentEngine === 'godot' ? 'scenes/NewLevel.tscn' : 'src/new-feature.js'}" />
              <div id="scaffold-path-hint" style="font-size:0.7rem; color:var(--dim); margin-top:3px;">
                ${currentEngine === 'godot' ? 'Must end with .tscn or .gd' : 'Must end with .js'}
              </div>
            </div>

            <div>
              <label style="font-size:0.78rem; font-weight:600; display:block; margin-bottom:4px;">Session Holder Name</label>
              <input type="text" id="scaffold-holder" class="modal-input" style="width:100%; box-sizing:border-box;"
                value="${esc(defaultHolder)}" placeholder="e.g. agent-1, dev-session" />
            </div>

            <div id="scaffold-error" style="color:#f87171; font-size:0.78rem; display:none;"></div>
          </div>
        </div>
        <div class="modal-footer" id="add-node-footer">
          <button type="button" class="secondary" id="btn-cancel-add-node">Cancel</button>
          <button type="button" id="btn-submit-add-node" style="background:#238636; color:#fff; border:none; padding:0.4rem 1rem; border-radius:4px; font-weight:600; cursor:pointer;">
            ✨ Scaffold & Lock
          </button>
        </div>
      </div>
    </div>
  `;

  // Attach event handlers
  document.getElementById('btn-close-add-node')?.addEventListener('click', closeAddNodeModal);
  document.getElementById('btn-cancel-add-node')?.addEventListener('click', closeAddNodeModal);
  document.getElementById('add-node-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'add-node-backdrop') closeAddNodeModal();
  });

  const selEngine = document.getElementById('scaffold-engine');
  const selType = document.getElementById('scaffold-type');
  const inputId = document.getElementById('scaffold-node-id');
  const hintEl = document.getElementById('scaffold-path-hint');

  selEngine?.addEventListener('change', () => {
    const eng = selEngine.value;
    if (eng === 'godot') {
      selType.innerHTML = `
        <option value="scene" selected>Scene (.tscn)</option>
        <option value="script">Script (.gd)</option>
      `;
      inputId.placeholder = 'scenes/NewLevel.tscn';
      if (hintEl) hintEl.textContent = 'Must end with .tscn or .gd';
    } else {
      selType.innerHTML = `
        <option value="module" selected>ES Module (.js)</option>
      `;
      inputId.placeholder = 'src/new-feature.js';
      if (hintEl) hintEl.textContent = 'Must end with .js';
    }
  });

  selType?.addEventListener('change', () => {
    const t = selType.value;
    if (t === 'scene') inputId.placeholder = 'scenes/NewLevel.tscn';
    else if (t === 'script') inputId.placeholder = 'scripts/NewScript.gd';
    else inputId.placeholder = 'src/new-module.js';
  });

  document.getElementById('btn-submit-add-node')?.addEventListener('click', async () => {
    const engine = selEngine.value;
    const type = selType.value;
    const nodeId = inputId.value.trim();
    const holder = document.getElementById('scaffold-holder').value.trim() || 'agent-1';
    const errorEl = document.getElementById('scaffold-error');

    if (!nodeId) {
      if (errorEl) {
        errorEl.textContent = 'Please enter a Node ID path.';
        errorEl.style.display = 'block';
      }
      return;
    }

    localStorage.setItem('cf_session_holder', holder);

    const btnSubmit = document.getElementById('btn-submit-add-node');
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.textContent = 'Scaffolding...';
    }

    try {
      const res = await fetch('/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, engine, type, holder })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to scaffold node');
      }

      showToast(`✓ Scaffolded ${data.nodeId} (locked by "${holder}")`, 'success');

      // Show generated prompt
      const modalBody = document.getElementById('add-node-body');
      const modalFooter = document.getElementById('add-node-footer');
      if (modalBody && modalFooter) {
        modalBody.innerHTML = `
          <div style="font-size:0.82rem; color:#4ade80; font-weight:600; margin-bottom:8px;">
            ✓ File created and locked successfully!
          </div>
          <p style="font-size:0.75rem; color:var(--dim); margin-bottom:6px;">
            Copy this implementation prompt for your AI assistant:
          </p>
          <textarea id="scaffold-prompt-output" readonly style="width:100%; height:140px; font-family:'JetBrains Mono',monospace; font-size:0.72rem; background:rgba(0,0,0,0.3); color:#e6edf3; border:1px solid var(--border); border-radius:4px; padding:0.5rem; box-sizing:border-box;">${esc(data.prompt)}</textarea>
        `;
        modalFooter.innerHTML = `
          <button type="button" class="secondary" id="btn-close-scaffold-done">Done</button>
          <button type="button" id="btn-copy-scaffold-done" style="background:#238636; color:#fff; border:none; padding:0.4rem 1rem; border-radius:4px; font-weight:600; cursor:pointer;">
            📋 Copy Prompt
          </button>
        `;

        document.getElementById('btn-copy-scaffold-done')?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(data.prompt);
            showToast('✓ AI prompt copied to clipboard!', 'success');
          } catch (_) {
            showToast('Prompt ready in textarea', 'info');
          }
        });

        document.getElementById('btn-close-scaffold-done')?.addEventListener('click', () => {
          closeAddNodeModal();
          if (state.projectPath) {
            doExtract(state.projectPath);
          }
        });
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      }
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = '✨ Scaffold & Lock';
      }
    }
  });
}
