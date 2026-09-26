/**
 * public/js/workstation/workspace-pane.js
 * Center Pane: Streamlined AI Handoff & Patch Applier Workflow.
 *
 * Flow: Ready to Investigate -> Copy Handoff -> Paste Response -> Apply & Verify -> Continue Debugging.
 */

import { state, notifyStateChange } from '../state.js';
import { showToast } from '../shared/toast.js';
import { updateHistoryUI, performUndo } from '../history/history.js';
import { projectDiskFiles } from '../sidebar/tree.js';
import { openDiffDrawer } from './diff-drawer.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractValidProjectFiles(text) {
  const rawMatches = [...text.matchAll(/(?:`|'|"|\b)([a-zA-Z0-9_./-]+\.(?:js|ts|jsx|tsx|gd|html|css|json|tscn|md|py|vue|svelte))\b/g)].map(m => m[1]);
  const available = (projectDiskFiles && projectDiskFiles.length > 0)
    ? projectDiskFiles.map(f => f.path)
    : (state.manifest?.nodes ? state.manifest.nodes.map(n => n.id) : []);

  const result = new Set();
  for (const raw of rawMatches) {
    if (raw.startsWith('this.') || raw.startsWith('window.') || raw.startsWith('console.')) continue;
    if (available.includes(raw)) {
      result.add(raw);
    } else {
      const base = raw.split('/').pop().toLowerCase();
      const matched = available.find(p => p.split('/').pop().toLowerCase() === base);
      if (matched) {
        result.add(matched);
      }
    }
  }
  return Array.from(result);
}

let isAdvancedOpen = false;
let currentHandoff = null;
let verificationResult = null;
let targetAiModel = 'markdown';

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

export function switchWorkspaceState() {
  const container = document.getElementById('ws-pane-workspace');
  if (container) renderWorkspacePane(container);
}

export function renderWorkspacePane(container) {
  if (!container) return;

  const hasHandoff = Boolean(currentHandoff && currentHandoff.prompt);

  container.innerHTML = `
    <div class="ws-pane-header">
      <div class="ws-pane-title">
        <span>🤖 AI Workspace</span>
      </div>
      <button type="button" class="ws-header-link" id="btn-toggle-adv-workspace">
        ⚙️ Advanced ${isAdvancedOpen ? '▴' : '▾'}
      </button>
    </div>

    <div class="ws-pane-body" style="padding: 0.75rem;">
      ${!hasHandoff ? renderReadyHero() : renderHandoffWorkflow()}
    </div>
  `;

  attachWorkspaceEvents(container);
}

function renderReadyHero() {
  return `
    <div class="ws-empty-hero">
      <div class="ws-hero-icon">🤖</div>
      <div class="ws-hero-title">Ready to investigate</div>
      <div class="ws-hero-desc">
        Click below to inspect runtime errors, locate the broken code, and compile a surgical AI fix handoff.
      </div>

      <div class="ws-checklist" style="margin: 0.9rem auto; max-width: 250px;">
        <div><span>✓</span> <span>Error location & stack trace</span></div>
        <div><span>✓</span> <span>Exact source snippet around bug</span></div>
        <div><span>✓</span> <span>Related caller & callee files</span></div>
        <div><span>✓</span> <span>Dependency topology</span></div>
      </div>

      <button type="button" class="ws-big-primary-btn" id="btn-ws-hero-fix" style="max-width:240px; margin: 0.5rem auto 0 auto;">
        🔥 Fix This Issue
      </button>
    </div>
  `;
}

function renderHandoffWorkflow() {
  const prompt = currentHandoff?.prompt || '';
  const attachedCount = currentHandoff?.attachedFiles?.length || 0;
  const rawText = state.workstation?.rawAiResponse || '';

  // Extract first few lines for compact preview
  const promptLines = prompt.split('\n');
  const previewLines = promptLines.slice(0, 8).join('\n') + (promptLines.length > 8 ? '\n...' : '');

  let bannerHtml = '';
  if (verificationResult) {
    bannerHtml = renderVerificationBanner(verificationResult);
  }

  return `
    <div style="display:flex; flex-direction:column; height:100%; gap:0.6rem;">
      <!-- Section 1: Generated AI Handoff -->
      <div class="ws-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <div style="font-weight:700; font-size:0.78rem; color:var(--primary); display:flex; align-items:center; gap:0.35rem;">
            <span>🤖 AI HANDOFF</span>
            <span style="font-size:0.68rem; font-weight:normal; color:var(--dim);">(${attachedCount} file${attachedCount === 1 ? '' : 's'} included)</span>
          </div>
          <button type="button" class="ws-action-copy-btn" id="btn-ws-copy-prompt">
            📋 Copy AI Handoff
          </button>
        </div>

        <div class="ws-prompt-snippet-box" style="height:90px; margin-top:4px;">${esc(previewLines)}</div>

        <!-- Advanced Drawer -->
        ${isAdvancedOpen ? `
          <div class="ws-collapsible-drawer" id="ws-adv-workspace-drawer" style="margin-top:0.4rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:0.7rem; color:var(--dim);">Target Model Format:</span>
              <select id="ws-target-model-select" style="font-size:0.7rem; background:#0d1117; color:var(--text); border:1px solid var(--border); border-radius:3px; padding:1px 4px;">
                <option value="markdown" ${targetAiModel === 'markdown' ? 'selected' : ''}>Standard Markdown</option>
                <option value="claude" ${targetAiModel === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
                <option value="chatgpt" ${targetAiModel === 'chatgpt' ? 'selected' : ''}>ChatGPT (OpenAI)</option>
                <option value="gemini" ${targetAiModel === 'gemini' ? 'selected' : ''}>Gemini (Google)</option>
                <option value="deepseek" ${targetAiModel === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
              </select>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.7rem; color:var(--dim); padding-top:2px;">
              <span>Tokens: ~${(currentHandoff?.tokens || 0).toLocaleString()} (${currentHandoff?.savingsPercent || 0}% saved)</span>
              <button type="button" class="secondary" id="btn-ws-export-prompt" style="font-size:0.68rem; height:18px; padding:0 5px;">💾 Export .md</button>
            </div>
          </div>
        ` : ''}
      </div>

      <!-- Section 2: Paste AI Response & 1-Click Apply -->
      <div class="ws-card" style="flex:1; display:flex; flex-direction:column;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <label style="font-weight:700; font-size:0.76rem; color:var(--text);" for="ws-ai-response-area">
            Paste AI response:
          </label>
          <button type="button" class="ws-mini-link" id="btn-ws-paste-clipboard">
            📋 Paste Clipboard
          </button>
        </div>

        <textarea id="ws-ai-response-area" class="ws-textarea" style="flex:1; min-height:120px; font-family:'JetBrains Mono',monospace; font-size:0.72rem; line-height:1.35;" placeholder="Paste the fix from Claude, ChatGPT, Gemini, or DeepSeek here...

Example:
### EDIT: src/scene-manager.js
<<<<<<< FIND
  this.projectiles = undefined;
=======
  this.projectiles = [];
>>>>>>> REPLACE">${esc(rawText)}</textarea>

        <!-- Verification Result Banner -->
        ${bannerHtml}

        <!-- Bottom Action Bar -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
          <button type="button" class="secondary" id="btn-ws-clear-patch" style="font-size:0.7rem; padding:0.2rem 0.55rem;">
            Clear
          </button>

          <div style="display:flex; gap:0.4rem; align-items:center;">
            <button type="button" class="secondary" id="btn-ws-preview-diff" style="font-size:0.75rem; font-weight:600; padding:0.4rem 0.75rem; border-radius:4px; border:1px solid var(--border); color:var(--text); cursor:pointer;" title="Preview visual line diff before writing to disk">
              🔍 Preview Diff
            </button>
            ${verificationResult && (verificationResult.syntaxValid === false || (verificationResult.comparison && verificationResult.comparison.comparison !== 'ERROR_RESOLVED')) ? `
              <button type="button" class="secondary" id="btn-ws-continue-debugging" style="font-size:0.75rem; font-weight:700; color:var(--primary); border-color:var(--primary);" title="Compile next iteration with remaining errors">
                Continue Debugging →
              </button>
            ` : ''}

            <button type="button" class="ws-big-apply-btn" id="btn-ws-apply-patch">
              ⚡ Apply & Verify Fix
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderVerificationBanner(v) {
  if (!v || v.isContextInsufficient) return '';

  if (v.undone) {
    return `
      <div class="ws-verify-banner" style="margin-top:0.35rem; background:rgba(56, 139, 253, 0.15); border-left:3px solid #58a6ff; color:#79c0ff; display:flex; align-items:center; gap:0.5rem; padding:0.5rem 0.75rem; border-radius:4px;">
        <span style="font-size:1.1rem;">↺</span>
        <div style="flex:1; overflow:hidden;">
          <div style="font-weight:600;">${esc(v.message || 'Patch reverted successfully')}</div>
          <div style="font-size:0.68rem; margin-top:2px; opacity:0.85;">All modified files have been restored to their pre-patch state.</div>
        </div>
      </div>
    `;
  }

  let bannerClass = 'success';
  let icon = '✓';
  let title = 'Patch applied cleanly';

  if (!v.success) {
    bannerClass = 'error';
    icon = v.preCheckFailed ? '🛑' : '✕';
    title = v.preCheckFailed
      ? `Pre-save syntax check failed: ${v.syntaxError ? v.syntaxError.file : 'file'}`
      : (v.error || 'Failed to apply patch');
  } else if (v.alreadyApplied) {
    bannerClass = 'success';
    icon = '✓';
    title = v.message || 'Already applied (duplicate patch — files are already up to date)';
  } else if (v.partial) {
    bannerClass = 'warning';
    icon = '⚠️';
    title = v.message || `Applied ${v.count} of ${v.total} edits (some blocks did not match)`;
  } else if (v.syntaxValid === false) {
    bannerClass = 'error';
    icon = '⚠️';
    title = `Syntax error in ${v.syntaxError ? v.syntaxError.file : 'file'}`;
  } else if (v.comparison?.comparison === 'NEW_ERROR') {
    bannerClass = 'warning';
    icon = '⚠️';
    title = 'Patch applied, but new error observed';
  } else if (v.comparison?.comparison === 'SAME_ERROR') {
    bannerClass = 'warning';
    icon = '⚠️';
    title = 'Patch applied, but error still occurs';
  } else if (v.comparison?.comparison === 'ERROR_RESOLVED') {
    bannerClass = 'success';
    icon = '✓';
    title = 'Issue resolved! Syntax verified ✓';
  }

  const patchTag = v.patchId ? `[${v.patchId}] ` : '';
  const count = v.count || 0;
  const fileCount = v.files ? v.files.length : 0;
  const canUndo = Boolean(!v.undone && (v.canUndo || v.patchId || (v.files && v.files.length > 0 && v.success)));

  return `
    <div class="ws-verify-banner ${bannerClass}" style="margin-top:0.35rem;">
      <span style="font-size:1.1rem;">${icon}</span>
      <div style="flex:1; overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
          <span style="font-weight:600;">${esc(patchTag)}${esc(title)}</span>
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:0.68rem; opacity:0.85;">${count} edit(s) in ${fileCount} file(s)</span>
            ${v.preCheckFailed ? `
              <button type="button" id="btn-ws-apply-anyway" class="secondary" style="font-size:0.68rem; padding:0.15rem 0.45rem; border-radius:3px; background:rgba(234, 179, 8, 0.25); border:1px solid rgba(234, 179, 8, 0.4); color:#fde047; cursor:pointer;" title="Bypass syntax check and write to disk anyway">
                ⚠️ Apply Anyway
              </button>
              <button type="button" id="btn-ws-reject-patch" class="secondary" style="font-size:0.68rem; padding:0.15rem 0.45rem; border-radius:3px; background:rgba(218, 54, 51, 0.25); border:1px solid rgba(248, 81, 73, 0.4); color:#ff7b72; cursor:pointer;" title="Reject broken patch without writing to disk">
                ✕ Reject Broken Patch
              </button>
            ` : ''}
            ${canUndo ? `
              <button type="button" id="btn-ws-undo-patch" class="secondary" style="font-size:0.68rem; padding:0.15rem 0.45rem; border-radius:3px; background:rgba(218, 54, 51, 0.25); border:1px solid rgba(248, 81, 73, 0.4); color:#ff7b72; cursor:pointer;" title="Undo this patch and restore previous file contents">
                ↺ Undo Patch
              </button>
            ` : ''}
            <button type="button" id="btn-ws-copy-verify-banner" class="secondary" style="font-size:0.68rem; padding:0.15rem 0.45rem; border-radius:3px; background:rgba(0,0,0,0.35); border:1px solid currentColor; cursor:pointer;" title="Copy patch result and unmatched blocks to clipboard">
              📋 Copy
            </button>
          </div>
        </div>
        ${v.comparison?.message ? `
          <div style="font-size:0.68rem; margin-top:2px; opacity:0.9;">
            ${esc(v.comparison.message)}
          </div>
        ` : ''}
        ${v.syntaxError?.message ? `
          <div style="font-family:'JetBrains Mono',monospace; font-size:0.68rem; margin-top:2px; color:#ffb3ba;">
            ${esc(v.syntaxError.message)}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function attachWorkspaceEvents(container) {
  // 1-Click Undo Patch
  const btnUndoPatch = container.querySelector('#btn-ws-undo-patch');
  btnUndoPatch?.addEventListener('click', async () => {
    btnUndoPatch.disabled = true;
    btnUndoPatch.textContent = '↺ Reverting...';
    let undoneSuccess = false;
    await performUndo({
      onUndo: async (data) => {
        undoneSuccess = true;
        setVerificationResult({
          undone: true,
          success: true,
          message: `↺ Undid ${data.patchId || 'patch'}: reverted ${data.restoredFiles?.length || 0} file(s)`
        });
        showToast(`✓ Reverted ${data.patchId || 'patch'} cleanly.`, 'success');
      }
    });
    if (!undoneSuccess && btnUndoPatch) {
      btnUndoPatch.disabled = false;
      btnUndoPatch.textContent = '↺ Undo Patch';
    }
  });

  // Apply Anyway (bypass pre-save syntax check) (T077)
  container.querySelector('#btn-ws-apply-anyway')?.addEventListener('click', async () => {
    await handleApplyPatch(container, { applyAnyway: true });
  });

  // Reject Broken Patch (T077)
  container.querySelector('#btn-ws-reject-patch')?.addEventListener('click', () => {
    setVerificationResult({
      rejected: true,
      success: false,
      message: '✕ Broken patch rejected — no disk changes were made.'
    });
    showToast('Broken patch rejected. Disk unchanged.', 'info');
  });

  // Copy verification banner details
  const btnCopyVerify = container.querySelector('#btn-ws-copy-verify-banner');
  btnCopyVerify?.addEventListener('click', async () => {
    if (!verificationResult) return;
    const v = verificationResult;
    const patchTag = v.patchId ? `[${v.patchId}] ` : '';
    const title = v.message || v.error || 'Patch result';

    let textToCopy = `${patchTag}${title}`;
    if (v.comparison?.message) {
      textToCopy += `\n${v.comparison.message}`;
    }
    if (v.syntaxError?.message) {
      textToCopy += `\nSyntax error in ${v.syntaxError.file || 'file'}: ${v.syntaxError.message}`;
    }
    if (v.failedBlocks && v.failedBlocks.length > 0) {
      textToCopy += `\n\nUNMATCHED EDIT BLOCKS (${v.failedBlocks.length}):`;
      v.failedBlocks.forEach((fb, idx) => {
        textToCopy += `\n\n--- Block ${idx + 1} (${fb.path}) ---`;
        textToCopy += `\nReason: ${fb.reason || 'Could not find exact FIND text'}`;
        if (fb.find) {
          textToCopy += `\n<<<<<<< FIND\n${fb.find}\n=======`;
        }
      });
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      btnCopyVerify.textContent = '✓ Copied!';
      showToast('✓ Patch details and unmatched blocks copied to clipboard!', 'success');
      setTimeout(() => {
        if (btnCopyVerify) btnCopyVerify.textContent = '📋 Copy';
      }, 2000);
    } catch (_) {
      showToast('Could not copy to clipboard', 'warn');
    }
  });

  // Advanced Toggle
  container.querySelector('#btn-toggle-adv-workspace')?.addEventListener('click', () => {
    isAdvancedOpen = !isAdvancedOpen;
    renderWorkspacePane(container);
  });

  // Hero Fix Button
  container.querySelector('#btn-ws-hero-fix')?.addEventListener('click', () => {
    if (callbacks.onRecompile) callbacks.onRecompile();
  });

  // Copy Prompt
  const btnCopy = container.querySelector('#btn-ws-copy-prompt');
  btnCopy?.addEventListener('click', async () => {
    const prompt = currentHandoff?.prompt || '';
    if (!prompt.trim()) {
      showToast('No prompt compiled yet.', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      btnCopy.textContent = '✓ Copied!';
      btnCopy.style.background = '#238636';
      showToast('✓ AI Handoff copied to clipboard! Paste it into your AI assistant.', 'success');
      setTimeout(() => {
        if (btnCopy) {
          btnCopy.textContent = '📋 Copy AI Handoff';
          btnCopy.style.background = '';
        }
      }, 2000);
    } catch (_) {
      showToast('✓ AI Handoff ready.', 'info');
    }
  });

  // Export .md
  container.querySelector('#btn-ws-export-prompt')?.addEventListener('click', () => {
    const prompt = currentHandoff?.prompt || '';
    if (!prompt.trim()) return;
    const blob = new Blob([prompt], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contextforge-handoff-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Exported prompt as markdown.', 'info');
  });

  // Target model select
  const modelSelect = container.querySelector('#ws-target-model-select');
  modelSelect?.addEventListener('change', () => {
    targetAiModel = modelSelect.value;
  });

  // AI Response Area
  const textarea = container.querySelector('#ws-ai-response-area');
  textarea?.addEventListener('input', () => {
    if (state.workstation) {
      state.workstation.rawAiResponse = textarea.value;
    }
  });

  // Paste from clipboard
  container.querySelector('#btn-ws-paste-clipboard')?.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          if (textarea) textarea.value = text;
          if (state.workstation) state.workstation.rawAiResponse = text;
          if (text.toUpperCase().includes('CONTEXT INSUFFICIENT')) {
            await handleApplyPatch(container);
          } else {
            showToast('Pasted AI response from clipboard.', 'info');
          }
        }
      }
    } catch (_) {
      showToast('Clipboard access denied. Please paste manually.', 'warn');
    }
  });

  // Clear button
  container.querySelector('#btn-ws-clear-patch')?.addEventListener('click', () => {
    if (textarea) textarea.value = '';
    if (state.workstation) state.workstation.rawAiResponse = '';
    setVerificationResult(null);
  });

  // Preview Diff Drawer (T080)
  container.querySelector('#btn-ws-preview-diff')?.addEventListener('click', async () => {
    const textarea = container.querySelector('#ws-ai-response-area');
    const content = textarea ? textarea.value.trim() : '';
    await openDiffDrawer({
      projectPath: state.projectPath,
      content,
      onApply: async () => {
        await handleApplyPatch(container);
      }
    });
  });

  // Apply Patch & Verify
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

  // Expand Context & Recompile
  container.querySelector('#btn-ws-expand-context')?.addEventListener('click', async () => {
    const ws = state.workstation;
    if (!ws) return;

    const available = (projectDiskFiles && projectDiskFiles.length > 0)
      ? projectDiskFiles.map(f => f.path)
      : (state.manifest?.nodes ? state.manifest.nodes.map(n => n.id) : []);

    const sanitized = new Set();
    if (ws.selectedFiles) {
      ws.selectedFiles.forEach(file => {
        if (file.startsWith('this.') || file.startsWith('window.') || file.startsWith('console.')) return;
        if (available.length === 0 || available.includes(file)) {
          sanitized.add(file);
        } else {
          const base = file.split('/').pop().toLowerCase();
          const match = available.find(p => p.split('/').pop().toLowerCase() === base);
          if (match) sanitized.add(match);
        }
      });
    }

    if (verificationResult?.requestedFiles && verificationResult.requestedFiles.length > 0) {
      verificationResult.requestedFiles.forEach(file => {
        if (available.length === 0 || available.includes(file)) {
          sanitized.add(file);
        } else {
          const base = file.split('/').pop().toLowerCase();
          const match = available.find(p => p.split('/').pop().toLowerCase() === base);
          if (match) sanitized.add(match);
        }
      });
    }

    ws.selectedFiles = sanitized;
    if (!ws.fileModes) ws.fileModes = {};
    ws.selectedFiles.forEach(file => {
      ws.fileModes[file] = 'full';
    });

    ws.contextStrategy = 'deep';
    setVerificationResult(null);

    const textarea = container.querySelector('#ws-ai-response-area');
    if (textarea) textarea.value = '';
    if (state.workstation) state.workstation.rawAiResponse = '';

    showToast('Expanding to full file context...', 'info');
    if (callbacks.onRecompile) {
      await callbacks.onRecompile();
    }

    const updatedPrompt = state.workstation?.activeHandoff?.prompt;
    if (updatedPrompt && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(updatedPrompt);
        showToast('✓ Expanded AI Handoff copied to clipboard! Paste into your AI assistant.', 'success');
      } catch (_) {}
    }
  });
}

async function handleApplyPatch(container, options = {}) {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please open or extract a project first.', 'warn');
    return;
  }

  const textarea = container.querySelector('#ws-ai-response-area');
  const content = textarea ? textarea.value.trim() : '';

  if (!content) {
    showToast('Please paste the AI response containing ### EDIT: or ### FILE: blocks.', 'warn');
    return;
  }

  // Intercept CONTEXT INSUFFICIENT response directly -> AUTOMATICALLY expand & recompile!
  if (content.toUpperCase().includes('CONTEXT INSUFFICIENT')) {
    const ws = state.workstation;
    const validFiles = extractValidProjectFiles(content);

    const available = (projectDiskFiles && projectDiskFiles.length > 0)
      ? projectDiskFiles.map(f => f.path)
      : (state.manifest?.nodes ? state.manifest.nodes.map(n => n.id) : []);

    const sanitized = new Set();
    if (ws.selectedFiles) {
      ws.selectedFiles.forEach(file => {
        if (file.startsWith('this.') || file.startsWith('window.') || file.startsWith('console.')) return;
        if (available.length === 0 || available.includes(file)) {
          sanitized.add(file);
        } else {
          const base = file.split('/').pop().toLowerCase();
          const match = available.find(p => p.split('/').pop().toLowerCase() === base);
          if (match) sanitized.add(match);
        }
      });
    }

    if (validFiles.length > 0) {
      validFiles.forEach(file => sanitized.add(file));
    }

    ws.selectedFiles = sanitized;
    if (!ws.fileModes) ws.fileModes = {};
    ws.selectedFiles.forEach(file => {
      ws.fileModes[file] = 'full';
    });

    ws.contextStrategy = 'deep';
    setVerificationResult(null);

    if (textarea) textarea.value = '';
    if (ws) ws.rawAiResponse = '';

    showToast('⚡ AI asked for more context — auto-expanded to full files & recompiling...', 'info');

    if (callbacks.onRecompile) {
      await callbacks.onRecompile();
    }

    const updatedPrompt = state.workstation?.activeHandoff?.prompt;
    if (updatedPrompt && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(updatedPrompt);
        showToast('✓ Auto-expanded AI Handoff copied to clipboard! Paste it into your AI assistant.', 'success');
      } catch (_) {}
    }
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
      body: JSON.stringify({
        projectPath,
        content,
        applyAnyway: options.applyAnyway === true
      })
    });
    const data = await res.json();

    if (data.isContextInsufficient) {
      setVerificationResult(data);
      return;
    }

    if (data.preCheckFailed) {
      setVerificationResult(data);
      showToast('🛑 Pre-save syntax check failed! Broken code was NOT written to disk.', 'error');
      return;
    }

    if (!res.ok) {
      setVerificationResult({
        success: false,
        error: data.error || res.statusText
      });
      showToast(`Patch failed: ${data.error || res.statusText}`, 'error');
      return;
    }

    // Check verification comparison
    let comparison = null;
    try {
      const prevError = state.workstation?.consoleLogs || '';
      const compRes = await fetch('/compare-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          previousError: prevError,
          syntaxValid: data.syntaxValid,
          syntaxError: data.syntaxError
        })
      });
      if (compRes.ok) {
        comparison = await compRes.json();
      }
    } catch (_) {}

    const vResult = { ...data, comparison };
    setVerificationResult(vResult);
    await updateHistoryUI();

    // Auto-clear the textarea so the user doesn't have to Ctrl+A and Delete
    if (textarea) textarea.value = '';
    if (state.workstation) {
      state.workstation.rawAiResponse = '';
      if (data.syntaxValid === false) {
        state.workstation.activeSyntaxError = data.syntaxError;
      } else {
        state.workstation.activeSyntaxError = null;
      }
    }

    if (callbacks.onApplySuccess) {
      await callbacks.onApplySuccess(vResult);
    }

    const patchTag = data.patchId ? `[${data.patchId}] ` : '';
    if (data.alreadyApplied) {
      showToast(`✓ Duplicate patch — files are already up to date!`, 'success');
    } else if (data.syntaxValid === false) {
      showToast(`⚠️ ${patchTag}Patch applied with syntax error! Check console or undo.`, 'error');
    } else {
      showToast(`✓ ${patchTag}Applied surgical edits successfully!`, 'success');
    }

  } catch (err) {
    setVerificationResult({ success: false, error: err.message });
    showToast(`Error applying patch: ${err.message}`, 'error');
  } finally {
    if (btnApply) {
      btnApply.disabled = false;
      btnApply.textContent = '⚡ Apply & Verify Fix';
    }
  }
}
