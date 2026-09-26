/**
 * public/js/clipboard/clipboard.js
 * 1-Click Paste & AI clipboard bridge with surgical patch detection and undo recording.
 */

import { showToast } from '../shared/toast.js';
import { state } from '../state.js';
import { updateHistoryUI } from '../history/history.js';

let lastClipboardErrorText = '';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function handleQuickPaste(callbacks = {}) {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('⚠️ No project loaded. Please open or extract a project first.', 'warn');
    return;
  }

  let clipboardText = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      clipboardText = await navigator.clipboard.readText();
    }
  } catch (err) {
    console.warn('Clipboard readText failed (browser permission):', err);
  }

  const trimmed = clipboardText ? clipboardText.trim() : '';
  if (!trimmed) {
    showToast('⚠️ Clipboard is empty or permission denied. Copy your AI response (Ctrl+C) first, or press Ctrl+V directly on ContextForge.', 'warn');
    return;
  }

  await applyClipboardContentDirectly(trimmed, callbacks);
}

export async function applyClipboardContentDirectly(content, callbacks = {}) {
  const projectPath = state.projectPath;
  if (!projectPath || !content) return;

  const btnAddFromClipboard = document.getElementById('btn-add-from-clipboard');
  if (btnAddFromClipboard) {
    btnAddFromClipboard.disabled = true;
    btnAddFromClipboard.innerHTML = '⏳ Applying...';
  }

  try {
    const res = await fetch('/add-from-clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, content, applyAnyway: true })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`⚠️ Paste & Run error: ${data.error || res.statusText}`, 'error');
      return;
    }

    if (callbacks.onApplySuccess) {
      await callbacks.onApplySuccess(data);
    }
    await updateHistoryUI();

    const patchTag = data.patchId ? `[${data.patchId}] ` : '';
    if (data.type === 'edit') {
      if (data.verified && data.syntaxValid === false) {
        const fileErr = data.syntaxError ? ` (${data.syntaxError.file})` : '';
        showToast(`⚠️ ${patchTag}Patch applied, but syntax error detected${fileErr}! Press ↺ Undo (Ctrl+Z) to rollback.`, 'error');
      } else {
        const verifiedTag = data.verified && data.syntaxValid ? ' (Syntax verified ✓)' : '';
        const msg = `✓ ${patchTag}Applied ${data.count} surgical edits across ${data.files.length} file(s).${verifiedTag}`;
        showToast(msg, 'success');
      }
    } else {
      const msg = `✓ ${patchTag}Added ${data.count} files.`;
      showToast(msg, 'success');
    }
  } catch (err) {
    showToast(`⚠️ Error applying clipboard: ${err.message}`, 'error');
  } finally {
    if (btnAddFromClipboard) {
      btnAddFromClipboard.disabled = false;
      btnAddFromClipboard.innerHTML = '⚡ Paste & Run';
    }
  }
}

export function openClipboardModal(initialText = '', initialError = '', callbacks = {}) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const projectPath = state.projectPath;
  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 620px;">
        <div class="modal-header">
          <div class="modal-title">📋 Add from Clipboard</div>
          <button class="panel-close" id="btn-close-clipboard-modal">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:0.8rem; color:var(--text);">
            Target project: <code style="font-size:0.75rem; color:var(--primary); font-family:'JetBrains Mono',monospace;">${esc(projectPath || 'No project loaded')}</code>
          </p>
          <p style="font-size:0.78rem; color:var(--dim);">
            Paste the AI response from ChatGPT / Claude / Gemini below. Auto-detects <code>### FILE:</code> (full files) and <code>### EDIT:</code> (surgical patches).
          </p>
          <textarea id="clipboard-import-area" class="modal-textarea" placeholder="Paste response containing ### FILE: or ### EDIT: blocks here...&#10;&#10;Format 1 (Full file):&#10;### FILE: src/player.js&#10;\`\`\`javascript&#10;export class Player { ... }&#10;\`\`\`&#10;&#10;Format 2 (Surgical patch):&#10;### EDIT: src/player.js&#10;<<<<<<< FIND&#10;this.speed = 10;&#10;=======&#10;this.speed = 20;&#10;>>>>>>> REPLACE" style="height:210px;">${esc(initialText || '')}</textarea>
          <div id="clipboard-import-status" class="paste-status ${initialError ? 'error' : ''}">
            ${initialError ? `
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.35rem;">
                <span style="font-weight:600; font-size:0.75rem;">⚠️ Patch Error:</span>
                <button type="button" class="secondary" id="btn-copy-clipboard-err" style="font-size:0.72rem; height:22px; padding:0 0.5rem; background:rgba(239,68,68,0.25); border-color:#ef4444; color:#fff; font-weight:600; cursor:pointer;">📋 Copy Error</button>
              </div>
              <pre id="clipboard-error-content" style="white-space:pre-wrap; font-family:'JetBrains Mono',monospace; font-size:0.75rem; text-align:left; margin:0;">${esc(initialError)}</pre>
            ` : ''}
          </div>
        </div>
        <div class="modal-footer" style="justify-content:space-between;">
          <button class="secondary" type="button" id="btn-paste-clipboard-area" title="Paste text from clipboard">📋 Paste from clipboard</button>
          <div style="display:flex; gap:0.4rem;">
            <button class="secondary" id="btn-cancel-clipboard-modal">Cancel</button>
            <button id="btn-submit-clipboard">⚡ Apply & Run</button>
          </div>
        </div>
      </div>
    </div>
  `;

  if (initialError) {
    lastClipboardErrorText = initialError;
  }

  // Auto-focus textarea for instant Ctrl+V
  setTimeout(() => {
    const area = document.getElementById('clipboard-import-area');
    if (area) {
      area.focus();
      if (!initialText) area.select();
    }
  }, 50);

  const closeFn = () => { modalRoot.innerHTML = ''; };
  document.getElementById('btn-close-clipboard-modal')?.addEventListener('click', closeFn);
  document.getElementById('btn-cancel-clipboard-modal')?.addEventListener('click', closeFn);

  document.getElementById('btn-copy-clipboard-err')?.addEventListener('click', async () => {
    const el = document.getElementById('clipboard-error-content');
    const textToCopy = el ? (el.innerText || el.textContent) : lastClipboardErrorText;
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      const btn = document.getElementById('btn-copy-clipboard-err');
      if (btn) btn.textContent = '✓ Copied!';
      showToast('Error message copied to clipboard', 'success');
      setTimeout(() => {
        const b = document.getElementById('btn-copy-clipboard-err');
        if (b) b.textContent = '📋 Copy Error';
      }, 2500);
    } catch (_) {
      showToast('Failed to copy', 'error');
    }
  });

  document.getElementById('btn-paste-clipboard-area')?.addEventListener('click', async () => {
    const area = document.getElementById('clipboard-import-area');
    if (!area) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        area.value = text;
        showToast('Pasted clipboard into text area', 'info');
      }
    } catch (_) {
      showToast('Press Ctrl+V to paste', 'info');
    }
  });

  document.getElementById('btn-submit-clipboard')?.addEventListener('click', async () => {
    const area = document.getElementById('clipboard-import-area');
    const content = area ? area.value.trim() : '';
    if (!content) {
      showToast('Please paste content first', 'warn');
      return;
    }
    closeFn();
    await applyClipboardContentDirectly(content, callbacks);
  });
}
