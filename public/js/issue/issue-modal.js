/**
 * public/js/issue/issue-modal.js
 * Issue reporting modal and surgical AI patch prompt compiler.
 */

import { state } from '../state.js';
import { showToast } from '../shared/toast.js';
import { projectDiskFiles } from '../sidebar/tree.js';
import { fetchConsoleLogs } from '../terminal/terminal.js';
import { applyClipboardContentDirectly, openClipboardModal } from '../clipboard/clipboard.js';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function openIssueReportModal(preselectedFile = '') {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please extract a project first before reporting an issue.', 'warn');
    return;
  }

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const rawAvailableFiles = (projectDiskFiles && projectDiskFiles.length > 0)
    ? projectDiskFiles.map(f => f.path)
    : (state.manifest && state.manifest.nodes ? state.manifest.nodes.map(n => n.id) : []);

  const selectedFiles = new Set();
  let userManuallySelected = false;
  let showAllFiles = false;

  if (preselectedFile) {
    selectedFiles.add(preselectedFile);
    userManuallySelected = true;
  } else if (state.selectedNodeId) {
    selectedFiles.add(state.selectedNodeId);
  }

  const fileModes = {};
  rawAvailableFiles.forEach(f => {
    fileModes[f] = 'scoped';
  });

  modalRoot.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content" style="max-width: 720px; max-height: 92vh;">
        <div class="modal-header">
          <div class="modal-title">🐞 Report Issue & Compile AI Fix Context</div>
          <button class="panel-close" id="btn-close-issue-modal">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="issue-description" style="font-weight:600; color:var(--text); font-size:0.78rem;">
              What is wrong? Describe the bug or paste error message:
            </label>
            <textarea id="issue-description" class="modal-textarea" style="height:65px; min-height:50px;" placeholder="e.g. Uncaught TypeError: Cannot read properties of undefined in src/player.js line 42..."></textarea>
          </div>

          <div class="form-group" style="margin-top:0.35rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
              <label style="font-weight:600; color:var(--text); font-size:0.78rem; display:flex; align-items:center; gap:0.4rem;">
                <span>📟 Console & Compiler Runtime Evidence</span>
                <span id="issue-console-badge" style="font-size:0.7rem; color:var(--dim); font-weight:normal;"></span>
              </label>
              <div style="display:flex; align-items:center; gap:0.45rem;">
                <label style="font-size:0.72rem; color:var(--dim); display:flex; align-items:center; gap:0.25rem; cursor:pointer;" title="Attach console output to prompt">
                  <input type="checkbox" id="issue-include-console" checked>
                  <span>Add to prompt</span>
                </label>
                <div class="pill-mode-group" id="console-filter-group">
                  <button type="button" class="pill-mode-btn" id="btn-console-filter-all" data-mode="all" title="Show all output">All</button>
                  <button type="button" class="pill-mode-btn active" id="btn-console-filter-red" data-mode="red" title="Show only red error lines" style="color:#ef4444; font-weight:600;">Red only</button>
                </div>
                <button type="button" class="secondary" id="btn-refresh-console" style="font-size:0.7rem; height:20px; padding:0 0.45rem;" title="Run check / refresh console">🔄 Check</button>
              </div>
            </div>
            <div id="issue-console-box" style="background:#0d1117; color:#c9d1d9; border:1px solid var(--border); border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:0.72rem; max-height:95px; overflow-y:auto; padding:0.4rem 0.6rem; white-space:pre-wrap; line-height:1.35;">
              Checking console output...
            </div>
          </div>

          <div id="issue-oversized-banner" style="display:none;" class="oversized-banner"></div>

          <div class="form-group" style="margin-top:0.35rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
              <label style="font-weight:600; color:var(--text); font-size:0.78rem; display:flex; align-items:center; gap:0.4rem;">
                <span>🔍 Relevant Files</span>
                <span id="issue-file-stats" style="font-size:0.7rem; color:var(--dim); font-weight:normal;"></span>
              </label>
              <div style="display:flex; gap:0.35rem; align-items:center;">
                <button type="button" class="secondary" id="btn-toggle-files-view" style="font-size:0.68rem; height:20px; padding:0 0.45rem;" title="Toggle between relevant files and all project files">Show All</button>
                <button type="button" class="secondary" id="btn-select-top-files" style="font-size:0.68rem; height:20px; padding:0 0.45rem;">Reset Top</button>
              </div>
            </div>
            <div id="issue-files-list" style="max-height:95px; overflow-y:auto; background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:0.35rem 0.55rem; display:flex; flex-direction:column; gap:0.3rem;">
              <div style="color:var(--dim); font-size:0.75rem;">Ranking project files...</div>
            </div>
          </div>

          <div class="context-confidence-bar" id="issue-confidence-bar" style="margin-top:0.35rem;">
            <span style="font-weight:600; font-size:0.72rem;">Context Confidence:</span>
            <div class="confidence-track">
              <div class="confidence-fill" id="confidence-fill" style="width: 50%;"></div>
            </div>
            <span id="confidence-label" style="font-size:0.72rem; font-weight:600; color:var(--dim);">Evaluating...</span>
          </div>

          <div class="form-group" style="margin-top:0.35rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem;">
              <label for="issue-prompt-area" style="font-weight:600; color:var(--text); font-size:0.78rem;">
                Generated AI Surgical Patch Prompt:
              </label>
              <div id="issue-prompt-savings" style="font-size:0.72rem; color:var(--dim);">
                Calculating prompt size...
              </div>
            </div>
            <textarea id="issue-prompt-area" class="modal-textarea" readonly style="height:140px; font-size:0.73rem;"></textarea>
          </div>

          <div style="font-size:0.74rem; color:var(--dim); padding:0.35rem 0.55rem; background:var(--bg); border:1px solid var(--border); border-radius:4px; display:flex; align-items:center; gap:0.4rem;">
            <span>💡</span>
            <span>Copy this prompt into your coding AI. When it replies with <code>### EDIT: relative/path.ext</code> (using <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; FIND</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE</code>), click <strong>📋 Paste Fix & Apply</strong> below!</span>
          </div>
          <div id="issue-prompt-status" class="paste-status"></div>
        </div>
        <div class="modal-footer" style="justify-content:space-between; align-items:center;">
          <button class="secondary" id="btn-cancel-issue-modal">Close</button>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <button class="secondary" id="btn-paste-fix-modal" style="background:#132337; border-color:#38bdf8; color:#38bdf8; font-weight:600; display:inline-flex; align-items:center; gap:0.35rem;" title="Paste AI fix from clipboard and apply immediately">
              <span>📋 Paste Fix & Apply</span>
            </button>
            <button id="btn-copy-issue-prompt">📋 Copy Issue Prompt</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const closeFn = () => { modalRoot.innerHTML = ''; };
  document.getElementById('btn-close-issue-modal')?.addEventListener('click', closeFn);
  document.getElementById('btn-cancel-issue-modal')?.addEventListener('click', closeFn);

  const descArea = document.getElementById('issue-description');
  const filesListEl = document.getElementById('issue-files-list');
  const fileStatsEl = document.getElementById('issue-file-stats');
  const promptArea = document.getElementById('issue-prompt-area');
  const savingsEl = document.getElementById('issue-prompt-savings');
  const oversizedEl = document.getElementById('issue-oversized-banner');
  const issueConsoleBox = document.getElementById('issue-console-box');
  const issueConsoleBadge = document.getElementById('issue-console-badge');
  const includeConsoleChk = document.getElementById('issue-include-console');
  const btnFilterAll = document.getElementById('btn-console-filter-all');
  const btnFilterRed = document.getElementById('btn-console-filter-red');
  const btnRefreshConsole = document.getElementById('btn-refresh-console');
  const btnToggleFiles = document.getElementById('btn-toggle-files-view');
  const btnSelectTop = document.getElementById('btn-select-top-files');
  const confidenceFill = document.getElementById('confidence-fill');
  const confidenceLabel = document.getElementById('confidence-label');
  const btnPasteFix = document.getElementById('btn-paste-fix-modal');

  let consoleFilter = 'red';
  let consoleData = { logs: [], redLogs: [] };
  let rankedFiles = [];
  let debounceTimer = null;

  function renderConsoleBox() {
    if (!issueConsoleBox) return;
    if (consoleFilter === 'red') {
      if (!consoleData.redLogs || consoleData.redLogs.length === 0) {
        issueConsoleBox.innerHTML = '<div style="color:var(--dim); font-style:italic;">No red errors detected in console. (Click "All" to view normal output, or "🔄 Check" to run compiler check).</div>';
      } else {
        issueConsoleBox.innerHTML = consoleData.redLogs.map(l =>
          `<div style="color:#ff6b6b; font-weight:600; padding:1px 0;">${esc(l.text)}</div>`
        ).join('');
      }
    } else {
      if (!consoleData.logs || consoleData.logs.length === 0) {
        issueConsoleBox.innerHTML = '<div style="color:var(--dim); font-style:italic;">Console is empty. Click "🔄 Check" to run engine check.</div>';
      } else {
        issueConsoleBox.innerHTML = consoleData.logs.map(l => {
          const color = l.isError ? '#ff6b6b; font-weight:600;' : '#8b949e;';
          return `<div style="color:${color} padding:1px 0;">${esc(l.text)}</div>`;
        }).join('');
      }
    }

    if (issueConsoleBadge) {
      const errCount = (consoleData.redLogs || []).length;
      if (errCount > 0) {
        issueConsoleBadge.innerHTML = `<span style="color:#ef4444; font-weight:600;">🔴 ${errCount} error${errCount === 1 ? '' : 's'}</span>`;
      } else {
        issueConsoleBadge.innerHTML = `<span style="color:var(--green);">✓ 0 errors</span>`;
      }
    }
  }

  function getConsolePayload() {
    if (!includeConsoleChk || !includeConsoleChk.checked) return '';
    if (consoleFilter === 'red' && consoleData.redLogs && consoleData.redLogs.length > 0) {
      return consoleData.redLogs.map(l => l.text).join('\n');
    } else if (consoleData.logs && consoleData.logs.length > 0) {
      return consoleData.logs.map(l => l.text).join('\n');
    }
    return '';
  }

  async function fetchRankings() {
    const issueDescription = descArea ? descArea.value.trim() : '';
    const consoleLogs = getConsolePayload();

    try {
      const res = await fetch('/rank-relevant-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, issueDescription, consoleLogs })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.files)) {
          const rankedMap = new Map(data.files.map(f => [f.file, f]));
          const allKnown = new Set([...rawAvailableFiles, ...data.files.map(f => f.file)]);

          rankedFiles = Array.from(allKnown).map(filePath => {
            const item = rankedMap.get(filePath);
            return {
              file: filePath,
              score: item ? item.score : 0,
              reason: item ? item.reason : '',
              isTop: item ? item.isTop : false
            };
          }).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

          // Auto-select files if user hasn't explicitly customized yet
          if (!userManuallySelected) {
            selectedFiles.clear();
            const topItems = rankedFiles.filter(f => f.score >= 90);
            if (topItems.length > 0) {
              topItems.forEach(f => selectedFiles.add(f.file));
            } else if (rankedFiles.length > 0) {
              selectedFiles.add(rankedFiles[0].file);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to rank files:', err);
    }

    renderFilesList();
    await updatePrompt();
  }

  function renderFilesList() {
    if (!filesListEl) return;
    if (rankedFiles.length === 0) {
      filesListEl.innerHTML = '<div style="color:var(--dim); font-size:0.75rem;">No files found</div>';
      return;
    }

    // Minimized default: show only relevant files (score > 0) or checked files
    const relevantFiles = rankedFiles.filter(item => item.score > 0 || selectedFiles.has(item.file));
    const filesToDisplay = (showAllFiles || relevantFiles.length === 0)
      ? rankedFiles
      : relevantFiles;

    let itemsHtml = filesToDisplay.map(item => {
      const isChecked = selectedFiles.has(item.file);
      const mode = fileModes[item.file] || 'scoped';
      let badgeHtml = '';
      if (item.score >= 90) {
        badgeHtml = `<span class="badge-relevance badge-high">${item.score}% Relevance</span>`;
      } else if (item.score >= 60) {
        badgeHtml = `<span class="badge-relevance badge-med">${item.score}% Match</span>`;
      } else if (item.score > 0) {
        badgeHtml = `<span class="badge-relevance badge-low">${item.score}%</span>`;
      }

      const reasonHtml = item.reason ? `<span class="relevance-reason" title="${esc(item.reason)}">${esc(item.reason)}</span>` : '';

      return `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:0.45rem; font-size:0.75rem; padding:1px 0;">
          <label style="display:flex; align-items:center; gap:0.45rem; cursor:pointer; flex:1; overflow:hidden;">
            <input type="checkbox" class="issue-file-chk" value="${esc(item.file)}" ${isChecked ? 'checked' : ''}>
            <span style="font-family:'JetBrains Mono',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:${isChecked ? '600' : 'normal'};">
              ${esc(item.file)}
            </span>
            ${badgeHtml}
            ${reasonHtml}
          </label>
          <div class="pill-mode-group" data-file="${esc(item.file)}">
            <button type="button" class="pill-mode-btn ${mode === 'scoped' ? 'active' : ''}" data-mode="scoped" title="Send outline & focused slice">Scoped</button>
            <button type="button" class="pill-mode-btn ${mode === 'full' ? 'active full' : 'full'}" data-mode="full" title="Send entire file source">Full</button>
          </div>
        </div>
      `;
    }).join('');

    if (!showAllFiles && rankedFiles.length > relevantFiles.length) {
      const hiddenCount = rankedFiles.length - relevantFiles.length;
      itemsHtml += `
        <div style="text-align:center; padding:0.2rem 0; border-top:1px dashed var(--border); margin-top:0.2rem;">
          <button type="button" class="secondary" id="btn-show-hidden-files" style="font-size:0.68rem; height:18px; padding:0 0.5rem; background:transparent; border:none; color:var(--primary); cursor:pointer;">
            + Show ${hiddenCount} more project files...
          </button>
        </div>
      `;
    }

    filesListEl.innerHTML = itemsHtml;

    // Reattach listeners to generated checkboxes and pill buttons
    filesListEl.querySelectorAll('.issue-file-chk').forEach(cb => {
      cb.addEventListener('change', () => {
        userManuallySelected = true;
        if (cb.checked) {
          selectedFiles.add(cb.value);
        } else {
          selectedFiles.delete(cb.value);
        }
        updatePrompt();
      });
    });

    filesListEl.querySelectorAll('.pill-mode-group[data-file]').forEach(group => {
      const file = group.getAttribute('data-file');
      const btns = group.querySelectorAll('.pill-mode-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          btns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          fileModes[file] = btn.getAttribute('data-mode');
          updatePrompt();
        });
      });
    });

    document.getElementById('btn-show-hidden-files')?.addEventListener('click', () => {
      showAllFiles = true;
      if (btnToggleFiles) btnToggleFiles.textContent = 'Only Relevant';
      renderFilesList();
    });

    if (fileStatsEl) {
      fileStatsEl.textContent = `${selectedFiles.size} selected (${relevantFiles.length} relevant)`;
    }
    if (btnToggleFiles) {
      btnToggleFiles.textContent = showAllFiles ? 'Only Relevant' : `Show All (${rankedFiles.length})`;
    }
  }

  function updateConfidenceBar(topScore, selectedCount) {
    if (!confidenceFill || !confidenceLabel) return;
    let score = topScore || 0;
    if (selectedCount === 0) score = 0;

    confidenceFill.style.width = `${Math.min(100, Math.max(10, score))}%`;

    if (score >= 90) {
      confidenceFill.style.background = '#238636';
      confidenceLabel.style.color = '#3fb950';
      confidenceLabel.textContent = `${score}% (High Precision Context)`;
    } else if (score >= 70) {
      confidenceFill.style.background = '#d29922';
      confidenceLabel.style.color = '#f0b72f';
      confidenceLabel.textContent = `${score}% (Moderate Relevance)`;
    } else if (score > 0) {
      confidenceFill.style.background = '#1f6feb';
      confidenceLabel.style.color = '#58a6ff';
      confidenceLabel.textContent = `${score}% (General Project Outline)`;
    } else {
      confidenceFill.style.background = '#30363d';
      confidenceLabel.style.color = 'var(--dim)';
      confidenceLabel.textContent = `No files attached`;
    }
  }

  async function updatePrompt() {
    const attachedFiles = Array.from(selectedFiles);
    const targetFile = attachedFiles.length > 0 ? attachedFiles[0] : '';
    const issueDescription = descArea ? descArea.value.trim() : '';
    const consolePayload = getConsolePayload();

    const topSelected = rankedFiles.find(f => selectedFiles.has(f.file));
    const highestScore = topSelected ? topSelected.score : 0;
    updateConfidenceBar(highestScore, attachedFiles.length);

    const relevantCount = rankedFiles.filter(item => item.score > 0 || selectedFiles.has(item.file)).length;
    if (fileStatsEl) {
      fileStatsEl.textContent = `${attachedFiles.length} selected (${relevantCount} relevant)`;
    }

    try {
      const res = await fetch('/scoped-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          targetFile,
          issueDescription,
          attachedFiles,
          fileModes,
          consoleLogs: consolePayload,
          consoleMode: consoleFilter
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (promptArea) promptArea.value = data.prompt;
          if (savingsEl) {
            savingsEl.innerHTML = `<span>Tokens: ~${data.tokens.toLocaleString()}</span> ${data.savingsPercent > 0 ? `<span style="color:var(--green); font-weight:600; margin-left:0.35rem;">(${data.savingsPercent}% saved vs full)</span>` : ''}`;
          }

          if (oversizedEl) {
            if (data.oversizedFiles && data.oversizedFiles.length > 0) {
              const names = data.oversizedFiles.map(o => `${o.file} (${o.linesCount} lines)`).join(', ');
              oversizedEl.style.display = 'flex';
              oversizedEl.innerHTML = `<span>⚠️ Oversized file detected: ${esc(names)}. Scoped outline mode enabled to conserve context budget.</span>`;
            } else {
              oversizedEl.style.display = 'none';
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to update prompt:', err);
    }
  }

  async function loadConsole(force = false) {
    consoleData = await fetchConsoleLogs(projectPath, force);
    if (consoleData.redLogs.length > 0) {
      consoleFilter = 'red';
      btnFilterRed?.classList.add('active');
      btnFilterAll?.classList.remove('active');
      if (includeConsoleChk) includeConsoleChk.checked = true;
    }
    renderConsoleBox();
    await fetchRankings();
  }

  btnFilterAll?.addEventListener('click', () => {
    consoleFilter = 'all';
    btnFilterAll.classList.add('active');
    btnFilterRed?.classList.remove('active');
    renderConsoleBox();
    fetchRankings();
  });

  btnFilterRed?.addEventListener('click', () => {
    consoleFilter = 'red';
    btnFilterRed.classList.add('active');
    btnFilterAll?.classList.remove('active');
    renderConsoleBox();
    fetchRankings();
  });

  btnRefreshConsole?.addEventListener('click', () => loadConsole(true));
  includeConsoleChk?.addEventListener('change', () => fetchRankings());

  descArea?.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      fetchRankings();
    }, 350);
  });

  btnSelectTop?.addEventListener('click', () => {
    userManuallySelected = false;
    selectedFiles.clear();
    const tops = rankedFiles.filter(f => f.score >= 90);
    if (tops.length > 0) {
      tops.forEach(f => selectedFiles.add(f.file));
    } else if (rankedFiles.length > 0) {
      selectedFiles.add(rankedFiles[0].file);
    }
    renderFilesList();
    updatePrompt();
  });

  btnToggleFiles?.addEventListener('click', () => {
    showAllFiles = !showAllFiles;
    renderFilesList();
  });

  // 1-Click Paste Fix & Apply button inside Issue modal
  btnPasteFix?.addEventListener('click', async () => {
    if (btnPasteFix) {
      btnPasteFix.disabled = true;
      btnPasteFix.textContent = '⏳ Applying...';
    }
    try {
      let clipboardText = '';
      if (navigator.clipboard && navigator.clipboard.readText) {
        try {
          clipboardText = await navigator.clipboard.readText();
        } catch (_) {}
      }
      const trimmed = clipboardText ? clipboardText.trim() : '';
      const hasAiBlocks = trimmed && (
        trimmed.includes('### FILE:') ||
        trimmed.includes('FILE:') ||
        trimmed.includes('### EDIT:') ||
        trimmed.includes('EDIT:') ||
        trimmed.includes('<<<<<<<')
      );

      if (hasAiBlocks) {
        await applyClipboardContentDirectly(trimmed, {
          onApplySuccess: async (data) => {
            await loadConsole(true);
          }
        });
      } else {
        openClipboardModal(trimmed, '', {
          onApplySuccess: async () => {
            await loadConsole(true);
          }
        });
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (btnPasteFix) {
        btnPasteFix.disabled = false;
        btnPasteFix.innerHTML = '<span>📋 Paste Fix & Apply</span>';
      }
    }
  });

  document.getElementById('btn-copy-issue-prompt')?.addEventListener('click', copyIssuePrompt);

  await loadConsole(false);
}

export async function copyIssuePrompt() {
  const area = document.getElementById('issue-prompt-area');
  const btn = document.getElementById('btn-copy-issue-prompt');
  const statusEl = document.getElementById('issue-prompt-status');
  if (!area || !area.value) {
    showToast('Prompt is empty', 'warn');
    return;
  }

  try {
    await navigator.clipboard.writeText(area.value);
    if (btn) btn.textContent = '✓ Copied!';
    showToast('✓ Issue prompt copied to clipboard!', 'success');
    if (statusEl) {
      statusEl.className = 'paste-status';
      statusEl.textContent = 'Copied prompt to clipboard! Paste it into your external coding AI.';
    }
    setTimeout(() => { if (btn) btn.textContent = '📋 Copy Issue Prompt'; }, 2500);
  } catch (err) {
    area.select();
    document.execCommand('copy');
    if (btn) btn.textContent = '✓ Copied!';
  }
}
