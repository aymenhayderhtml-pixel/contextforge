/**
 * public/js/workstation/workspace-pane.js
 * Center Pane: AI Handoff Prompt Inspection (State A) & AI Response/Patch Applier (State B).
 */

import { state, notifyStateChange } from '../state.js';
import { showToast } from '../shared/toast.js';
import { updateHistoryUI } from '../history/history.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let activeWorkspaceTab = 'handoff'; // 'handoff' | 'patch'
let currentHandoff = null; // { prompt, tokens, savingsPercent, oversizedFiles, attachedFiles }
let verificationResult = null; // { success, syntaxValid, files, count, patchId, syntaxError, comparison }
let targetAiModel = 'markdown'; // 'markdown' | 'claude' | 'chatgpt' | 'gemini' | 'deepseek'

let callbacks = {
  onApplySuccess: null,
  onContinueDebugging: null,
  onRecompile: null
};

export function initWorkspacePane(container, cbs = {}) {
  if (!container) return;
  callbacks = { ...callbacks, ...cbs };
  renderWorkspacePane(container);
}

export function setHandoffData(handoff) {
  currentHandoff = handoff;
  if (state.workstation) {
    state.workstation.activeHandoff = handoff;
  }
  const container = document.getElementById('ws-pane-workspace');
  if (container) {
    renderWorkspacePane(container);
  }
}

export function setVerificationResult(result) {
  verificationResult = result;
  if (state.workstation) {
    state.workstation.lastVerification = result;
  }
  const container = document.getElementById('ws-pane-workspace');
  if (container) {
    renderWorkspacePane(container);
  }
}

export function switchWorkspaceState(tabName) {
  if (tabName === 'handoff' || tabName === 'patch') {
    activeWorkspaceTab = tabName;
    const container = document.getElementById('ws-pane-workspace');
    if (container) {
      renderWorkspacePane(container);
    }
  }
}

export function renderWorkspacePane(container) {
  if (!container) return;

  const isHandoff = activeWorkspaceTab === 'handoff';

  container.innerHTML = `
    <div class="ws-pane-header">
      <div class="ws-pane-title">
        <span>🤖 AI Workspace</span>
      </div>
      <div class="ws-workspace-tabs" id="ws-workspace-tab-group">
        <button type="button" class="ws-tab-btn ${isHandoff ? 'active' : ''}" data-tab="handoff">
          📤 Handoff Prompt
        </button>
        <button type="button" class="ws-tab-btn ${!isHandoff ? 'active' : ''}" data-tab="patch">
          📥 Apply Patch
        </button>
      </div>
    </div>

    <div class="ws-pane-body" style="padding: 0.6rem;">
      <div id="ws-session-stepper" style="margin-bottom:0.5rem;"></div>
      ${isHandoff ? renderStateAHandoff() : renderStateBPatch()}
    </div>
  `;

  const stepperEl = container.querySelector('#ws-session-stepper');
  if (stepperEl) {
    import('./session-stepper.js').then(m => m.renderSessionStepper(stepperEl));
  }

  attachWorkspaceEvents(container);
}

function renderStateAHandoff() {
  const prompt = currentHandoff ? currentHandoff.prompt || '' : '';
  const tokens = currentHandoff ? currentHandoff.tokens || 0 : 0;
  const savings = currentHandoff ? currentHandoff.savingsPercent || 0 : 0;
  const filesCount = currentHandoff && currentHandoff.attachedFiles ? currentHandoff.attachedFiles.length : 0;

  return `
    <div style="display:flex; flex-direction:column; height:100%; gap:0.5rem;">
      <!-- Stats & Options Bar -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.4rem; padding-bottom:0.2rem;">
        <div style="display:flex; align-items:center; gap:0.5rem; font-size:0.72rem;">
          <span style="font-weight:600; color:var(--text);">Tokens:</span>
          <span style="font-family:'JetBrains Mono',monospace; color:var(--primary); font-weight:700;">~${tokens.toLocaleString()}</span>
          ${savings > 0 ? `<span style="color:#3fb950; font-weight:600; background:rgba(63,185,80,0.1); padding:1px 5px; border-radius:3px;">${savings}% saved</span>` : ''}
          <span style="color:var(--dim); font-size:0.68rem;">(${filesCount} file${filesCount === 1 ? '' : 's'})</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.35rem;">
          <label style="font-size:0.7rem; color:var(--dim);">Format:</label>
          <select id="ws-target-model-select" class="ws-select" style="font-size:0.7rem; padding:1px 4px; height:22px;">
            <option value="markdown" ${targetAiModel === 'markdown' ? 'selected' : ''}>Standard Markdown</option>
            <option value="claude" ${targetAiModel === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
            <option value="chatgpt" ${targetAiModel === 'chatgpt' ? 'selected' : ''}>ChatGPT (OpenAI)</option>
            <option value="gemini" ${targetAiModel === 'gemini' ? 'selected' : ''}>Gemini (Google)</option>
            <option value="deepseek" ${targetAiModel === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
          </select>
        </div>
      </div>

      <!-- Prompt Preview Area -->
      <div style="flex:1; display:flex; flex-direction:column; min-height:220px; position:relative;">
        <textarea id="ws-prompt-display" class="ws-prompt-view" style="width:100%; height:100%; resize:none;" readonly placeholder="Click '⚡ Compile AI Handoff' on the left to compile surgical context...">${esc(prompt)}</textarea>
      </div>

      <!-- Action Toolbar -->
      <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; padding-top:0.3rem; border-top:1px solid var(--border);">
        <div style="display:flex; gap:0.35rem;">
          <button type="button" class="secondary" id="btn-ws-export-prompt" title="Download prompt as markdown file" style="font-size:0.72rem; padding:0.25rem 0.55rem;">
            💾 Export .md
          </button>
          <button type="button" class="secondary" id="btn-ws-recompile" title="Re-compile context with current settings" style="font-size:0.72rem; padding:0.25rem 0.55rem;">
            🔄 Re-compile
          </button>
        </div>
        <div style="display:flex; gap:0.4rem; align-items:center;">
          <button type="button" class="secondary" id="btn-ws-go-patch" style="font-size:0.72rem; padding:0.25rem 0.55rem; color:var(--primary); border-color:var(--border-focus);">
            Paste Patch →
          </button>
          <button type="button" class="primary" id="btn-ws-copy-prompt" style="font-size:0.75rem; padding:0.25rem 0.75rem; font-weight:600;">
            📋 Copy Prompt
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderStateBPatch() {
  const rawText = state.workstation ? state.workstation.rawAiResponse || '' : '';
  const blockStats = detectPatchBlocks(rawText);

  let bannerHtml = '';
  if (verificationResult) {
    bannerHtml = renderVerificationBanner(verificationResult);
  }

  return `
    <div style="display:flex; flex-direction:column; height:100%; gap:0.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size:0.72rem; color:var(--dim);">
          Paste external AI reply containing <code style="color:var(--primary); font-family:'JetBrains Mono',monospace;">### FILE:</code> or <code style="color:var(--primary); font-family:'JetBrains Mono',monospace;">### EDIT:</code>
        </div>
        <div style="display:flex; gap:0.35rem;">
          <button type="button" class="secondary" id="btn-ws-paste-clipboard" style="font-size:0.7rem; padding:2px 6px;">
            📋 Paste Clipboard
          </button>
          <button type="button" class="secondary" id="btn-ws-clear-patch" style="font-size:0.7rem; padding:2px 6px;">
            🗑 Clear
          </button>
        </div>
      </div>

      <!-- Live Detection Indicator -->
      <div id="ws-patch-detection-bar" style="display:flex; align-items:center; justify-content:space-between; padding:0.25rem 0.5rem; background:rgba(0,0,0,0.25); border:1px solid var(--border); border-radius:4px; font-size:0.72rem;">
        <span style="display:flex; align-items:center; gap:0.35rem;">
          <span style="font-weight:600;">Patch Blocks:</span>
          ${blockStats.total > 0
            ? `<span style="color:#3fb950; font-weight:700;">${blockStats.edits} EDIT, ${blockStats.files} FILE in ${blockStats.distinctFiles.size} file(s)</span>`
            : `<span style="color:var(--dim); font-style:italic;">None detected yet</span>`}
        </span>
        <span style="font-size:0.68rem; color:var(--dim);">Format: Surgical Diff or Full File</span>
      </div>

      <!-- Textarea for AI response -->
      <div style="flex:1; display:flex; flex-direction:column; min-height:160px;">
        <textarea id="ws-ai-response-area" class="ws-textarea" style="width:100%; height:100%; resize:none; font-family:'JetBrains Mono',monospace; font-size:0.72rem; line-height:1.35;" placeholder="Paste external AI response here...

Example format:
### EDIT: src/player.js
<<<<<<< FIND
  this.velocity.y = 0;
=======
  this.velocity.y = jumpForce;
>>>>>>> REPLACE">${esc(rawText)}</textarea>
      </div>

      <!-- Verification Result Banner (if any) -->
      ${bannerHtml}

      <!-- Bottom Actions -->
      <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; padding-top:0.3rem; border-top:1px solid var(--border);">
        <button type="button" class="secondary" id="btn-ws-back-handoff" style="font-size:0.72rem; padding:0.25rem 0.55rem;">
          ← Back to Prompt
        </button>
        <div style="display:flex; gap:0.4rem; align-items:center;">
          ${verificationResult ? `
            <button type="button" class="secondary" id="btn-ws-continue-debugging" style="font-size:0.74rem; padding:0.25rem 0.65rem; color:var(--primary); font-weight:600; border-color:var(--primary);" title="Start next iteration using remaining or new errors">
              Continue Debugging ↻
            </button>
          ` : ''}
          <button type="button" class="primary" id="btn-ws-apply-patch" style="font-size:0.75rem; padding:0.25rem 0.75rem; font-weight:600; background:#238636; border-color:#2ea043;">
            ⚡ Apply Patch & Verify
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderVerificationBanner(v) {
  if (!v) return '';

  let bannerClass = 'success';
  let icon = '✓';
  let title = 'Patch applied successfully';

  if (!v.success) {
    bannerClass = 'error';
    icon = '✕';
    title = v.error || 'Failed to apply patch';
  } else if (v.syntaxValid === false) {
    bannerClass = 'error';
    icon = '⚠️';
    title = `Applied, but syntax error in ${v.syntaxError ? v.syntaxError.file : 'file'}`;
  } else if (v.comparison && v.comparison.comparison === 'NEW_ERROR') {
    bannerClass = 'warning';
    icon = '⚠️';
    title = `Patch applied, but new runtime error introduced!`;
  } else if (v.comparison && v.comparison.comparison === 'SAME_ERROR') {
    bannerClass = 'warning';
    icon = '⚠️';
    title = `Patch applied, but previous error is still occurring.`;
  } else if (v.comparison && v.comparison.comparison === 'ERROR_RESOLVED') {
    bannerClass = 'success';
    icon = '✓';
    title = `Error successfully resolved! 0 errors detected.`;
  }

  const tag = v.patchId ? `[${v.patchId}] ` : '';
  const fileCount = v.files ? v.files.length : 0;
  const count = v.count || 0;

  return `
    <div class="ws-verify-banner ${bannerClass}" style="margin-top:0.2rem;">
      <span style="font-size:1rem;">${icon}</span>
      <div style="flex:1;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span>${esc(tag)}${esc(title)}</span>
          <span style="font-size:0.68rem; opacity:0.85;">${count} edit(s) across ${fileCount} file(s)</span>
        </div>
        ${v.comparison && v.comparison.message ? `
          <div style="font-size:0.68rem; margin-top:2px; opacity:0.9;">
            ${esc(v.comparison.message)}
          </div>
        ` : ''}
        ${v.syntaxError && v.syntaxError.message ? `
          <div style="font-family:'JetBrains Mono',monospace; font-size:0.68rem; margin-top:2px; color:#ffb3ba;">
            ${esc(v.syntaxError.message)}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function detectPatchBlocks(content) {
  if (!content) return { total: 0, edits: 0, files: 0, distinctFiles: new Set() };
  const lines = content.split('\n');
  let edits = 0;
  let files = 0;
  const distinctFiles = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('### EDIT:') || trimmed.startsWith('EDIT:')) {
      edits++;
      const p = trimmed.replace(/^#*\s*EDIT:\s*/, '').trim();
      if (p) distinctFiles.add(p);
    } else if (trimmed.startsWith('### FILE:') || trimmed.startsWith('FILE:')) {
      files++;
      const p = trimmed.replace(/^#*\s*FILE:\s*/, '').trim();
      if (p) distinctFiles.add(p);
    }
  }

  return { total: edits + files, edits, files, distinctFiles };
}

function attachWorkspaceEvents(container) {
  // Tab Switcher
  container.querySelectorAll('#ws-workspace-tab-group .ws-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchWorkspaceState(btn.getAttribute('data-tab'));
    });
  });

  if (activeWorkspaceTab === 'handoff') {
    // Model Select
    const modelSelect = container.querySelector('#ws-target-model-select');
    modelSelect?.addEventListener('change', () => {
      targetAiModel = modelSelect.value;
    });

    // Copy Prompt
    const btnCopy = container.querySelector('#btn-ws-copy-prompt');
    btnCopy?.addEventListener('click', async () => {
      const promptArea = container.querySelector('#ws-prompt-display');
      if (!promptArea || !promptArea.value.trim()) {
        showToast('No prompt to copy. Compile context first.', 'warn');
        return;
      }
      try {
        await navigator.clipboard.writeText(promptArea.value);
        btnCopy.textContent = '✓ Copied!';
        btnCopy.style.background = '#238636';
        showToast('✓ AI Prompt copied to clipboard!', 'success');
        setTimeout(() => {
          if (btnCopy) {
            btnCopy.textContent = '📋 Copy Prompt';
            btnCopy.style.background = '';
          }
        }, 2000);
      } catch (err) {
        promptArea.select();
        document.execCommand('copy');
        showToast('✓ AI Prompt copied!', 'success');
      }
    });

    // Export .md
    container.querySelector('#btn-ws-export-prompt')?.addEventListener('click', () => {
      const promptArea = container.querySelector('#ws-prompt-display');
      if (!promptArea || !promptArea.value.trim()) {
        showToast('No prompt content to export.', 'warn');
        return;
      }
      const blob = new Blob([promptArea.value], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contextforge-fix-${Date.now()}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Exported prompt as markdown.', 'info');
    });

    // Recompile
    container.querySelector('#btn-ws-recompile')?.addEventListener('click', () => {
      if (callbacks.onRecompile) {
        callbacks.onRecompile();
      }
    });

    // Switch to patch
    container.querySelector('#btn-ws-go-patch')?.addEventListener('click', () => {
      switchWorkspaceState('patch');
    });

  } else {
    // State B Patch events
    const textarea = container.querySelector('#ws-ai-response-area');
    textarea?.addEventListener('input', () => {
      if (state.workstation) {
        state.workstation.rawAiResponse = textarea.value;
      }
      updatePatchDetectionBar(container, textarea.value);
    });

    // Paste from clipboard
    container.querySelector('#btn-ws-paste-clipboard')?.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            textarea.value = text;
            if (state.workstation) state.workstation.rawAiResponse = text;
            updatePatchDetectionBar(container, text);
            showToast('Pasted from clipboard.', 'info');
          }
        }
      } catch (err) {
        showToast('Clipboard access denied. Please paste manually.', 'warn');
      }
    });

    // Clear
    container.querySelector('#btn-ws-clear-patch')?.addEventListener('click', () => {
      if (textarea) textarea.value = '';
      if (state.workstation) state.workstation.rawAiResponse = '';
      updatePatchDetectionBar(container, '');
    });

    // Back to handoff
    container.querySelector('#btn-ws-back-handoff')?.addEventListener('click', () => {
      switchWorkspaceState('handoff');
    });

    // Apply patch
    const btnApply = container.querySelector('#btn-ws-apply-patch');
    btnApply?.addEventListener('click', async () => {
      await handleApplyPatch(container);
    });

    // Continue Debugging
    container.querySelector('#btn-ws-continue-debugging')?.addEventListener('click', () => {
      if (callbacks.onContinueDebugging) {
        callbacks.onContinueDebugging(verificationResult);
      }
    });
  }
}

function updatePatchDetectionBar(container, content) {
  const bar = container.querySelector('#ws-patch-detection-bar');
  if (!bar) return;
  const stats = detectPatchBlocks(content);

  bar.innerHTML = `
    <span style="display:flex; align-items:center; gap:0.35rem;">
      <span style="font-weight:600;">Patch Blocks:</span>
      ${stats.total > 0
        ? `<span style="color:#3fb950; font-weight:700;">${stats.edits} EDIT, ${stats.files} FILE in ${stats.distinctFiles.size} file(s)</span>`
        : `<span style="color:var(--dim); font-style:italic;">None detected yet</span>`}
    </span>
    <span style="font-size:0.68rem; color:var(--dim);">Format: Surgical Diff or Full File</span>
  `;
}

async function handleApplyPatch(container) {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('No project loaded. Please load or extract a project first.', 'warn');
    return;
  }

  const textarea = container.querySelector('#ws-ai-response-area');
  const content = textarea ? textarea.value.trim() : '';

  if (!content) {
    showToast('Please paste AI response text containing ### EDIT: or ### FILE: blocks.', 'warn');
    return;
  }

  const btnApply = container.querySelector('#btn-ws-apply-patch');
  if (btnApply) {
    btnApply.disabled = true;
    btnApply.textContent = '⏳ Applying...';
  }

  try {
    const res = await fetch('/add-from-clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, content })
    });
    const data = await res.json();

    if (!res.ok) {
      setVerificationResult({
        success: false,
        error: data.error || res.statusText
      });
      showToast(`Patch failed: ${data.error || res.statusText}`, 'error');
      return;
    }

    // Call comparison endpoint if available
    let comparison = null;
    try {
      const prevError = state.workstation && state.workstation.consoleLogs;
      const compRes = await fetch('/compare-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          previousError: prevError || '',
          syntaxValid: data.syntaxValid,
          syntaxError: data.syntaxError
        })
      });
      if (compRes.ok) {
        comparison = await compRes.json();
      }
    } catch (e) {
      console.warn('Verification comparison check failed:', e);
    }

    const vResult = {
      ...data,
      comparison
    };

    setVerificationResult(vResult);
    await updateHistoryUI();

    if (callbacks.onApplySuccess) {
      await callbacks.onApplySuccess(vResult);
    }

    const patchTag = data.patchId ? `[${data.patchId}] ` : '';
    if (data.syntaxValid === false) {
      showToast(`⚠️ ${patchTag}Patch applied with syntax error! Check console or undo.`, 'error');
    } else {
      showToast(`✓ ${patchTag}Applied surgical edits successfully!`, 'success');
    }

  } catch (err) {
    setVerificationResult({
      success: false,
      error: err.message
    });
    showToast(`Error applying patch: ${err.message}`, 'error');
  } finally {
    if (btnApply) {
      btnApply.disabled = false;
      btnApply.textContent = '⚡ Apply Patch & Verify';
    }
  }
}
