/**
 * public/js/project/wizard.js
 * New Project Wizard (3-step flow) and Progress Dashboard.
 */

import { state, notifyStateChange } from '../state.js';
import { showToast } from '../shared/toast.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugifyName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'my-game';
}

function dirnameOf(p) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

export let newProjectState = {
  step: 1,
  engine: 'js',
  parentFolder: '',
  projectName: 'My Game',
  slug: 'my-game',
  targetFolder: '',
  filesCreated: [],
  gameIdea: ''
};

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

export function openNewProjectModal() {
  const defaultParent = state.projectPath ? dirnameOf(state.projectPath) : '';
  newProjectState = {
    step: 1,
    engine: 'js',
    parentFolder: defaultParent,
    projectName: 'My Game',
    slug: 'my-game',
    targetFolder: '',
    filesCreated: [],
    gameIdea: ''
  };
  renderNewProjectStep1();
}

export function selectProjectEngine(engine) {
  newProjectState.engine = engine;
  const cardHtml = document.getElementById('card-engine-html');
  const cardGodot = document.getElementById('card-engine-godot');
  if (cardHtml && cardGodot) {
    if (engine === 'js') {
      cardHtml.classList.add('selected');
      cardGodot.classList.remove('selected');
    } else {
      cardGodot.classList.add('selected');
      cardHtml.classList.remove('selected');
    }
  }
  const nextBtn = document.getElementById('btn-newproj-next1');
  if (nextBtn) nextBtn.disabled = false;
}

export function renderNewProjectStep1() {
  newProjectState.step = 1;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 520px;">
        <div class="modal-header">
          <div class="modal-title">✨ New Project — Step 1: Select Engine</div>
          <button class="panel-close" id="btn-modal-close-step1">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:0.8rem; color:var(--dim); margin-bottom:0.3rem;">
            Select the engine platform for your new project:
          </p>
          <div class="engine-card-grid">
            <div class="engine-card ${newProjectState.engine === 'js' ? 'selected' : ''}" id="card-engine-html">
              <div class="engine-card-icon">🌐</div>
              <div class="engine-card-title">HTML & Three.js</div>
              <div class="engine-card-desc">Vite + Three.js 3D web game with hot-reload and instant Web Live Preview.</div>
            </div>
            <div class="engine-card ${newProjectState.engine === 'godot' ? 'selected' : ''}" id="card-engine-godot">
              <div class="engine-card-icon">🤖</div>
              <div class="engine-card-title">Godot Engine 4.x</div>
              <div class="engine-card-desc">Godot 4.x project with Node2D scene, GDScript, and native editor launcher.</div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="secondary" id="btn-modal-cancel-step1">Cancel</button>
          <button id="btn-newproj-next1">Next: Location & Name →</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-modal-close-step1')?.addEventListener('click', closeModal);
  document.getElementById('btn-modal-cancel-step1')?.addEventListener('click', closeModal);
  document.getElementById('card-engine-html')?.addEventListener('click', () => selectProjectEngine('js'));
  document.getElementById('card-engine-godot')?.addEventListener('click', () => selectProjectEngine('godot'));
  document.getElementById('btn-newproj-next1')?.addEventListener('click', renderNewProjectStep2);
}

export function updateNewProjectPreview() {
  const parentInput = document.getElementById('new-proj-parent');
  const nameInput = document.getElementById('new-proj-name');
  const previewEl = document.getElementById('new-proj-preview-path');
  if (!parentInput || !nameInput || !previewEl) return;

  newProjectState.parentFolder = parentInput.value.trim();
  newProjectState.projectName = nameInput.value.trim() || 'My Game';
  newProjectState.slug = slugifyName(newProjectState.projectName);

  const parent = newProjectState.parentFolder ? newProjectState.parentFolder.replace(/\/+$/, '') : '<parent-folder>';
  const fullPath = parent + '/' + newProjectState.slug;
  previewEl.textContent = fullPath;
}

export async function browseParentFolder() {
  try {
    const res = await fetch('/browse-folder', { method: 'POST' });
    const data = await res.json();
    if (data.success && data.path) {
      const parentInput = document.getElementById('new-proj-parent');
      if (parentInput) {
        parentInput.value = data.path;
        updateNewProjectPreview();
      }
    }
  } catch (err) {
    console.warn('Folder picker failed:', err);
  }
}

export function renderNewProjectStep2() {
  newProjectState.step = 2;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const initialParent = newProjectState.parentFolder || (state.projectPath ? dirnameOf(state.projectPath) : '');
  const initialName = newProjectState.projectName || 'My Game';
  const slug = slugifyName(initialName);
  const initialPreview = (initialParent ? initialParent.replace(/\/+$/, '') : '<parent-folder>') + '/' + slug;

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 540px;">
        <div class="modal-header">
          <div class="modal-title">✨ New Project — Step 2: Location & Name</div>
          <button class="panel-close" id="btn-modal-close-step2">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="new-proj-parent">Parent Directory</label>
            <div style="display:flex; gap:0.4rem;">
              <input type="text" id="new-proj-parent" placeholder="/path/to/parent" value="${esc(initialParent)}" style="flex:1;">
              <button type="button" class="secondary" id="btn-browse-parent" style="white-space:nowrap;">📂 Browse...</button>
            </div>
          </div>
          <div class="form-group" style="margin-top:0.5rem;">
            <label for="new-proj-name">Project Name</label>
            <input type="text" id="new-proj-name" placeholder="e.g. Neon Horizon" value="${esc(initialName)}">
          </div>
          <div style="margin-top:0.6rem; padding:0.6rem 0.75rem; background:var(--bg); border:1px solid var(--border); border-radius:4px; font-size:0.75rem; color:var(--dim);">
            <div>Project folder to create:</div>
            <div id="new-proj-preview-path" style="font-family:'JetBrains Mono',monospace; color:var(--primary); font-weight:600; margin-top:0.25rem; word-break:break-all;">
              ${esc(initialPreview)}
            </div>
          </div>
          <div id="new-project-status" class="paste-status" style="margin-top:0.4rem;"></div>
        </div>
        <div class="modal-footer">
          <button class="secondary" id="btn-modal-back-step2">← Back</button>
          <button class="secondary" id="btn-modal-cancel-step2">Cancel</button>
          <button id="btn-submit-new-project">⚡ Create & Scaffold</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-modal-close-step2')?.addEventListener('click', closeModal);
  document.getElementById('btn-modal-cancel-step2')?.addEventListener('click', closeModal);
  document.getElementById('btn-modal-back-step2')?.addEventListener('click', renderNewProjectStep1);
  document.getElementById('btn-browse-parent')?.addEventListener('click', browseParentFolder);
  document.getElementById('new-proj-parent')?.addEventListener('input', updateNewProjectPreview);
  document.getElementById('new-proj-name')?.addEventListener('input', updateNewProjectPreview);
  document.getElementById('btn-submit-new-project')?.addEventListener('click', submitNewProject);
}

export async function submitNewProject() {
  const parentInput = document.getElementById('new-proj-parent');
  const nameInput = document.getElementById('new-proj-name');
  const statusEl = document.getElementById('new-project-status');
  const btnSubmit = document.getElementById('btn-submit-new-project');

  const parentFolder = parentInput ? parentInput.value.trim() : '';
  const projectName = nameInput ? nameInput.value.trim() : '';

  if (!parentFolder) {
    if (statusEl) {
      statusEl.className = 'paste-status error';
      statusEl.textContent = 'Please choose or enter a parent directory.';
    }
    return;
  }
  if (!projectName) {
    if (statusEl) {
      statusEl.className = 'paste-status error';
      statusEl.textContent = 'Please enter a project name.';
    }
    return;
  }

  const slug = slugifyName(projectName);
  const targetFolder = parentFolder.replace(/\/+$/, '') + '/' + slug;

  if (statusEl) {
    statusEl.className = 'paste-status';
    statusEl.textContent = 'Scaffolding project and generating agent docs...';
  }
  if (btnSubmit) btnSubmit.disabled = true;

  try {
    const res = await fetch('/init-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetFolder,
        engine: newProjectState.engine,
        projectName
      })
    });
    const data = await res.json();
    if (!res.ok) {
      if (statusEl) {
        statusEl.className = 'paste-status error';
        statusEl.textContent = data.error || res.statusText;
      }
      if (btnSubmit) btnSubmit.disabled = false;
      return;
    }

    newProjectState.targetFolder = targetFolder;
    newProjectState.projectName = projectName;
    newProjectState.slug = slug;
    newProjectState.filesCreated = data.filesCreated || [];

    renderNewProjectStep3();
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'paste-status error';
      statusEl.textContent = err.message;
    }
    if (btnSubmit) btnSubmit.disabled = false;
  }
}

export function generateScaffoldPrompt(stateObj) {
  const isGodot = stateObj.engine === 'godot';
  const engineName = isGodot ? 'Godot 4.x (GDScript)' : 'HTML5, Vite, and Three.js';
  const filesList = (stateObj.filesCreated || []).map(f => `- ${f}`).join('\n');
  const ideaText = stateObj.gameIdea && stateObj.gameIdea.trim() ? stateObj.gameIdea.trim() : '[describe your game idea above]';

  return `I am building a game titled "${stateObj.projectName}" using ${engineName}.

Game concept: ${ideaText}

Project root: ${stateObj.targetFolder}
Scaffolded base files:
${filesList}

Please generate the game implementation files.

CRITICAL FORMAT REQUIREMENT:
- Output ONLY file blocks in this format — no explanation before, between, or after them.
- Never truncate a file or write placeholders like '// rest stays the same' — always output the complete file contents.
- Every fenced code block must be closed.

Example:
### FILE: src/example.js
\`\`\`js
console.log("full file contents go here, never abbreviated");
\`\`\`

Now, output the complete game files following this exact format.`;
}

export function renderNewProjectStep3() {
  newProjectState.step = 3;
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const promptText = generateScaffoldPrompt(newProjectState);

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 640px; max-height: 90vh; overflow-y: auto;">
        <div class="modal-header">
          <div class="modal-title">✨ New Project — Step 3: AI Scaffold Prompt</div>
          <button class="panel-close" id="btn-modal-close-step3">✕</button>
        </div>
        <div class="modal-body" style="display:flex; flex-direction:column; gap:0.45rem;">
          <p style="font-size:0.8rem; color:var(--text); margin:0;">
            ✓ Project created at <code style="font-size:0.75rem; color:var(--primary); font-family:'JetBrains Mono',monospace;">${esc(newProjectState.targetFolder)}</code>
          </p>
          <div class="form-group" style="margin:0;">
            <label for="new-proj-idea" style="font-weight:600; font-size:0.78rem; color:var(--text);">
              Describe your game idea (1+ lines):
            </label>
            <textarea id="new-proj-idea" class="modal-textarea" style="height:48px; min-height:40px; font-family:'Inter',system-ui,sans-serif; font-size:0.78rem;" placeholder="e.g. A fast-paced 3D space shooter where the player dodges asteroids and collects fuel cells...">${esc(newProjectState.gameIdea || '')}</textarea>
          </div>
          <div class="form-group" style="margin:0;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.2rem;">
              <label for="scaffold-ai-prompt" style="font-size:0.78rem; color:var(--dim);">
                1. Copy prompt and paste into your AI (ChatGPT, Claude, Gemini):
              </label>
              <button type="button" id="btn-copy-scaffold-prompt-inline" class="preview-action-btn" style="height:20px; font-size:0.72rem; padding:0 0.45rem;">📋 Copy Prompt</button>
            </div>
            <textarea id="scaffold-ai-prompt" class="modal-textarea" readonly style="height:120px; font-size:0.74rem;">${esc(promptText)}</textarea>
          </div>
          <div class="form-group" style="margin:0;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.2rem;">
              <label for="step3-paste-reply" style="font-weight:600; font-size:0.78rem; color:var(--text); display:flex; align-items:center; gap:0.3rem;">
                <span>2. Paste AI reply here:</span>
              </label>
              <button type="button" id="btn-paste-step3" class="preview-action-btn" style="height:20px; font-size:0.72rem; padding:0 0.45rem;">📋 Paste from clipboard</button>
            </div>
            <textarea id="step3-paste-reply" class="modal-textarea" style="height:115px; font-family:'JetBrains Mono',monospace; font-size:0.74rem;" placeholder="Paste the response from your AI here... (e.g. ### FILE: src/main.js ...)"></textarea>
          </div>
          <div id="step3-status" class="paste-status" style="margin:0;"></div>
        </div>
        <div class="modal-footer" style="justify-content:space-between; align-items:center;">
          <button id="btn-copy-scaffold-prompt" class="secondary">📋 Copy Prompt</button>
          <button id="btn-finish-new-project">⚡ Open in ContextForge</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-modal-close-step3')?.addEventListener('click', finishNewProject);
  document.getElementById('btn-copy-scaffold-prompt')?.addEventListener('click', copyScaffoldPrompt);
  document.getElementById('btn-copy-scaffold-prompt-inline')?.addEventListener('click', copyScaffoldPrompt);
  document.getElementById('btn-paste-step3')?.addEventListener('click', pasteClipboardToStep3);
  document.getElementById('btn-finish-new-project')?.addEventListener('click', finishNewProject);

  const ideaInput = document.getElementById('new-proj-idea');
  if (ideaInput) {
    ideaInput.addEventListener('input', () => {
      newProjectState.gameIdea = ideaInput.value;
      const promptArea = document.getElementById('scaffold-ai-prompt');
      if (promptArea) {
        promptArea.value = generateScaffoldPrompt(newProjectState);
      }
    });
  }

  const replyArea = document.getElementById('step3-paste-reply');
  const btnFinish = document.getElementById('btn-finish-new-project');
  if (replyArea && btnFinish) {
    replyArea.addEventListener('input', () => {
      if (replyArea.value.trim().length > 0) {
        btnFinish.textContent = '⚡ Apply AI Code & Open';
        btnFinish.style.borderColor = 'var(--primary)';
      } else {
        btnFinish.textContent = '⚡ Open in ContextForge';
        btnFinish.style.borderColor = '';
      }
    });
  }
}

export async function pasteClipboardToStep3() {
  const replyArea = document.getElementById('step3-paste-reply');
  const btnFinish = document.getElementById('btn-finish-new-project');
  if (!replyArea) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      replyArea.value = text;
      if (btnFinish) {
        btnFinish.textContent = '⚡ Apply AI Code & Open';
        btnFinish.style.borderColor = 'var(--primary)';
      }
      showToast('✓ Pasted AI reply from clipboard');
    }
  } catch (_) {
    replyArea.focus();
    showToast('Clipboard access denied — press Ctrl+V to paste');
  }
}

export async function copyScaffoldPrompt() {
  const promptArea = document.getElementById('scaffold-ai-prompt');
  const btnCopy = document.getElementById('btn-copy-scaffold-prompt');
  const btnCopyInline = document.getElementById('btn-copy-scaffold-prompt-inline');
  const statusEl = document.getElementById('step3-status');
  if (!promptArea) return;

  try {
    await navigator.clipboard.writeText(promptArea.value);
    if (btnCopy) btnCopy.textContent = '✓ Copied!';
    if (btnCopyInline) btnCopyInline.textContent = '✓ Copied!';
    if (statusEl) {
      statusEl.className = 'paste-status';
      statusEl.textContent = 'Prompt copied! Paste it into ChatGPT/Claude/Gemini, then paste the reply below.';
    }
    setTimeout(() => {
      if (btnCopy) btnCopy.textContent = '📋 Copy Prompt';
      if (btnCopyInline) btnCopyInline.textContent = '📋 Copy Prompt';
    }, 2500);
  } catch (err) {
    promptArea.select();
    document.execCommand('copy');
    if (btnCopy) btnCopy.textContent = '✓ Copied!';
    if (btnCopyInline) btnCopyInline.textContent = '✓ Copied!';
  }
}

export async function finishNewProject() {
  const target = newProjectState.targetFolder;
  const replyArea = document.getElementById('step3-paste-reply');
  const statusEl = document.getElementById('step3-status');
  const btnFinish = document.getElementById('btn-finish-new-project');
  const content = replyArea ? replyArea.value.trim() : '';

  if (content && target) {
    if (statusEl) {
      statusEl.className = 'paste-status';
      statusEl.textContent = 'Applying AI generated files to project...';
    }
    if (btnFinish) btnFinish.disabled = true;

    try {
      const res = await fetch('/add-from-clipboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: target, content })
      });
      const data = await res.json();
      if (!res.ok) {
        if (statusEl) {
          statusEl.className = 'paste-status error';
          statusEl.innerHTML = `<pre style="white-space:pre-wrap; font-family:'JetBrains Mono',monospace; font-size:0.75rem; text-align:left;">${esc(data.error || res.statusText)}</pre>`;
        }
        if (btnFinish) btnFinish.disabled = false;
        return;
      }

      closeModal();
      state.projectPath = target;
      notifyStateChange('projectPath', target);
      if (window.ContextForge && window.ContextForge.doExtract) {
        await window.ContextForge.doExtract(target);
      }
      const count = data.files ? data.files.length : (data.count || 0);
      const msg = `✓ Project ready: applied ${count} AI file(s) into "${newProjectState.projectName}"`;
      showToast(msg);
      return;
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'paste-status error';
        statusEl.textContent = err.message;
      }
      if (btnFinish) btnFinish.disabled = false;
      return;
    }
  }

  closeModal();
  if (target) {
    state.projectPath = target;
    notifyStateChange('projectPath', target);
    if (window.ContextForge && window.ContextForge.doExtract) {
      await window.ContextForge.doExtract(target);
    }
    showToast(`✓ Project "${newProjectState.projectName}" ready`);
  }
}

// ── Progress Dashboard (Phase 13, T052, T053) ──
let progressPollInterval = null;

export async function openProgressModal() {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please extract a project first to view its progress dashboard.', 'warn');
    return;
  }

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 680px; max-height: 90vh;">
        <div class="modal-header">
          <div class="modal-title">📊 Project Progress Dashboard</div>
          <button class="panel-close" id="btn-close-progress-modal">✕</button>
        </div>
        <div class="modal-body" id="progress-modal-body">
          <div style="font-size:0.8rem; color:var(--dim);">Reading TASKS.md progress...</div>
        </div>
        <div class="modal-footer" style="justify-content:space-between; align-items:center;">
          <span id="progress-live-badge" style="font-size:0.72rem; color:var(--green); display:flex; align-items:center; gap:0.3rem;">
            <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--green); animation: pulse 1.5s infinite;"></span>
            Live Polling Active (every 3s)
          </span>
          <button class="secondary" id="btn-done-progress-modal">Close</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-close-progress-modal')?.addEventListener('click', closeProgressModal);
  document.getElementById('btn-done-progress-modal')?.addEventListener('click', closeProgressModal);

  await loadAndRenderProgress(projectPath);

  if (progressPollInterval) clearInterval(progressPollInterval);
  progressPollInterval = setInterval(() => {
    loadAndRenderProgress(projectPath);
  }, 3000);
}

export function closeProgressModal() {
  if (progressPollInterval) {
    clearInterval(progressPollInterval);
    progressPollInterval = null;
  }
  closeModal();
}

export async function loadAndRenderProgress(projectPath) {
  const bodyEl = document.getElementById('progress-modal-body');
  if (!bodyEl) return;

  try {
    const res = await fetch(`/project-progress?projectPath=${encodeURIComponent(projectPath)}`);
    if (!res.ok) {
      const err = await res.json();
      bodyEl.innerHTML = `<div class="paste-status error">Error: ${esc(err.error || res.statusText)}</div>`;
      return;
    }

    const data = await res.json();
    if (!data.hasTasks) {
      bodyEl.innerHTML = `
        <div style="padding:1.5rem; text-align:center; color:var(--dim);">
          <div style="font-size:1.5rem; margin-bottom:0.5rem;">📄</div>
          <div>No <code>TASKS.md</code> file found in this project.</div>
          <div style="font-size:0.75rem; margin-top:0.3rem;">Create a TASKS.md or use "+ New Project" to bootstrap task tracking.</div>
        </div>
      `;
      return;
    }

    let phasesHtml = '';
    for (const phase of data.phases) {
      const tasksHtml = phase.tasks.map(t => `
        <li class="phase-task-item ${t.completed ? 'completed' : ''}">
          <span class="${t.completed ? 'phase-task-check' : 'phase-task-uncheck'}">${t.completed ? '☑' : '☐'}</span>
          <span>${t.id ? `<strong>${esc(t.id)}:</strong> ` : ''}${esc(t.text)}</span>
        </li>
      `).join('');

      phasesHtml += `
        <div class="phase-card">
          <div class="phase-card-header">
            <span class="phase-card-title">${esc(phase.title)}</span>
            <span class="phase-card-badge">${phase.completed} / ${phase.total} (${phase.percent}%)</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width: ${phase.percent}%;"></div>
          </div>
          <ul class="phase-tasks-list">
            ${tasksHtml || '<li class="panel-empty">No tasks in this phase</li>'}
          </ul>
        </div>
      `;
    }

    bodyEl.innerHTML = `
      <div style="margin-bottom:1rem; background:rgba(255,255,255,0.03); padding:0.8rem; border-radius:6px; border:1px solid var(--border);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <span style="font-weight:600; font-size:0.95rem;">Overall Project Completion</span>
          <span style="font-weight:700; font-size:1.1rem; color:var(--green);">${data.percent}%</span>
        </div>
        <div class="progress-bar-container" style="height:12px;">
          <div class="progress-bar-fill" style="width: ${data.percent}%;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--dim); margin-top:0.4rem;">
          <span>${data.completedTasks} of ${data.totalTasks} tasks complete</span>
          <span>${data.phases.length} phases defined</span>
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:0.4rem;">
        ${phasesHtml}
      </div>
    `;
  } catch (err) {
    if (bodyEl) {
      bodyEl.innerHTML = `<div class="paste-status error">Network error reading progress: ${esc(err.message)}</div>`;
    }
  }
}
