/**
 * public/js/workstation/workstation.js
 * Master orchestrator for the ContextForge 3-Pane Debugging Workstation.
 */

import { state, notifyStateChange } from '../state.js';
import { showToast } from '../shared/toast.js';
import { initProblemPane, getProblemPayload, refreshConsoleEvidence } from './problem-pane.js';
import {
  initWorkspacePane,
  setHandoffData,
  setVerificationResult,
  switchWorkspaceState
} from './workspace-pane.js';
import {
  initInspectorPane,
  setInspectorRankedFiles,
  renderInspectorPane
} from './inspector-pane.js';
import { initSessionStepper, setSessionSteps } from './session-stepper.js';
import { showModelingView, hideModelingView } from '../modeling/modeling-view.js';
import { renderGraph, fitToView, handleResize } from '../graph/render.js';

let isInitialized = false;
let currentIteration = 1;
let currentSessionId = null;

export function initWorkstation() {
  const container = document.getElementById('workstation-container');
  const btnGraph = document.getElementById('btn-view-graph');
  const btnWorkstation = document.getElementById('btn-view-workstation');
  const btnModel = document.getElementById('btn-view-model');

  if (!container) return;

  // Bind view toggle buttons
  btnGraph?.addEventListener('click', () => switchViewMode('graph'));
  btnWorkstation?.addEventListener('click', () => switchViewMode('workstation'));
  btnModel?.addEventListener('click', () => switchViewMode('model'));

  // Initialize the 3 panes
  const leftPane = document.getElementById('ws-pane-problem');
  const centerPane = document.getElementById('ws-pane-workspace');
  const rightPane = document.getElementById('ws-pane-inspector');

  initProblemPane(leftPane, {
    onCompile: (opts) => compileWorkstationHandoff(false, Boolean(opts?.copyToClipboard))
  });

  initWorkspacePane(centerPane, {
    onApplySuccess: (result) => handlePatchApplied(result),
    onContinueDebugging: (result) => handleContinueDebugging(result),
    onRecompile: (opts) => compileWorkstationHandoff(false, Boolean(opts?.copyToClipboard))
  });

  initInspectorPane(rightPane, {
    onSelectionChange: () => {
      // Re-evaluate prompt when file selection or mode changes
      if (state.workstation && state.workstation.activeHandoff) {
        compileWorkstationHandoff(true);
      }
    }
  });

  // Initialize session stepper at top of center pane
  const stepperContainer = centerPane?.querySelector('#ws-session-stepper');
  if (stepperContainer) {
    initSessionStepper(stepperContainer, {
      onStepClick: (step, idx) => handleStepNavigation(step, idx)
    });
  }

  initSplitMode();

  isInitialized = true;
}

export function isSplitModeActive() {
  const saved = localStorage.getItem('contextforge_split_mode');
  if (saved !== null) {
    return saved === 'true';
  }
  return window.innerWidth <= 960;
}

export function updateSplitModeUI(enable) {
  const container = document.getElementById('workstation-container');
  const btnSplit = document.getElementById('btn-toggle-split');
  if (!container) return;
  if (enable) {
    container.classList.add('split-screen-mode');
    btnSplit?.classList.add('active');
    btnSplit?.setAttribute('aria-pressed', 'true');
  } else {
    container.classList.remove('split-screen-mode');
    btnSplit?.classList.remove('active');
    btnSplit?.setAttribute('aria-pressed', 'false');
  }
  if (state.workstation) {
    state.workstation.isSplitMode = enable;
  }
}

export function minimizeWorkstation() {
  const container = document.getElementById('workstation-container');
  const btnExpandWs = document.getElementById('btn-expand-workstation');
  if (!container) return;
  container.classList.add('minimized-right');
  if (btnExpandWs && state.viewMode === 'workstation') {
    btnExpandWs.style.display = 'block';
  }
}

export function expandWorkstation() {
  const container = document.getElementById('workstation-container');
  const btnExpandWs = document.getElementById('btn-expand-workstation');
  if (!container) return;
  container.classList.remove('minimized-right');
  if (btnExpandWs) btnExpandWs.style.display = 'none';
}

export function getSidebarMinimized() {
  try {
    return localStorage.getItem('cf_sidebar_minimized') === 'true';
  } catch (_) {
    return false;
  }
}

export function setSidebarMinimized(val) {
  try {
    localStorage.setItem('cf_sidebar_minimized', val ? 'true' : 'false');
  } catch (_) {}
}

export function updateSidebarVisibility() {
  const leftSidebar = document.getElementById('left-sidebar');
  const btnExpandSidebar = document.getElementById('btn-expand-sidebar');
  if (state.viewMode !== 'graph') {
    if (leftSidebar) leftSidebar.style.display = 'none';
    if (btnExpandSidebar) btnExpandSidebar.style.display = 'none';
    return;
  }
  const isMin = getSidebarMinimized();
  if (isMin) {
    if (leftSidebar) leftSidebar.style.display = 'none';
    if (btnExpandSidebar) btnExpandSidebar.style.display = 'block';
  } else {
    if (leftSidebar) leftSidebar.style.display = 'flex';
    if (btnExpandSidebar) btnExpandSidebar.style.display = 'none';
  }
}

export function minimizeLeftSidebar() {
  setSidebarMinimized(true);
  updateSidebarVisibility();
}

export function expandLeftSidebar() {
  setSidebarMinimized(false);
  updateSidebarVisibility();
}

export function initSplitMode() {
  const btnSplit = document.getElementById('btn-toggle-split');
  const isSplit = isSplitModeActive();
  updateSplitModeUI(isSplit);

  const btnExpandWs = document.getElementById('btn-expand-workstation');
  btnExpandWs?.addEventListener('click', expandWorkstation);

  btnSplit?.addEventListener('click', () => {
    const container = document.getElementById('workstation-container');
    const currentlySplit = container?.classList.contains('split-screen-mode');
    const nextState = !currentlySplit;
    localStorage.setItem('contextforge_split_mode', String(nextState));
    updateSplitModeUI(nextState);
    if (!nextState) {
      expandWorkstation();
    }
  });

  window.addEventListener('resize', () => {
    const saved = localStorage.getItem('contextforge_split_mode');
    if (saved === null) {
      updateSplitModeUI(window.innerWidth <= 960);
    }
  });
}

export function switchViewMode(mode) {
  try {
    localStorage.setItem('cf_view_mode', mode);
  } catch (_) {}

  const graphContainer = document.getElementById('graph-container');
  const wsContainer = document.getElementById('workstation-container');
  const modelingContainer = document.getElementById('modeling-container');
  const btnGraph = document.getElementById('btn-view-graph');
  const btnWs = document.getElementById('btn-view-workstation');
  const btnModel = document.getElementById('btn-view-model');
  const sidePanel = document.getElementById('side-panel');
  const btnExpandWs = document.getElementById('btn-expand-workstation');

  if (mode === 'workstation') {
    state.viewMode = 'workstation';
    document.body.classList.add('mode-workstation');
    document.body.classList.remove('mode-modeling');
    document.body.classList.remove('mode-graph');
    if (graphContainer) graphContainer.style.display = 'none';
    if (wsContainer) wsContainer.style.display = 'grid';
    if (modelingContainer) modelingContainer.style.display = 'none';
    if (sidePanel) sidePanel.style.display = 'none';

    btnGraph?.classList.remove('active');
    btnModel?.classList.remove('active');
    btnWs?.classList.add('active');

    expandWorkstation();
    hideModelingView();
    updateSplitModeUI(isSplitModeActive());

    // Refresh console logs and panes if project is loaded
    if (state.projectPath) {
      const leftPane = document.getElementById('ws-pane-problem');
      refreshConsoleEvidence(leftPane, false);
      const rightPane = document.getElementById('ws-pane-inspector');
      renderInspectorPane(rightPane);
    }
  } else if (mode === 'model') {
    state.viewMode = 'model';
    document.body.classList.remove('mode-workstation');
    document.body.classList.add('mode-modeling');
    document.body.classList.remove('mode-graph');
    if (graphContainer) graphContainer.style.display = 'none';
    if (wsContainer) wsContainer.style.display = 'none';
    if (modelingContainer) modelingContainer.style.display = 'flex';
    if (sidePanel) sidePanel.style.display = 'none';
    if (btnExpandWs) btnExpandWs.style.display = 'none';

    btnGraph?.classList.remove('active');
    btnWs?.classList.remove('active');
    btnModel?.classList.add('active');

    showModelingView();
  } else {
    state.viewMode = 'graph';
    document.body.classList.remove('mode-workstation');
    document.body.classList.remove('mode-modeling');
    document.body.classList.add('mode-graph');
    if (wsContainer) wsContainer.style.display = 'none';
    if (modelingContainer) modelingContainer.style.display = 'none';
    if (graphContainer) graphContainer.style.display = 'block';
    if (btnExpandWs) btnExpandWs.style.display = 'none';

    btnWs?.classList.remove('active');
    btnModel?.classList.remove('active');
    btnGraph?.classList.add('active');

    hideModelingView();

    // Check if graph SVG exists and has valid dimensions, else render
    const svgEl = document.querySelector('#graph-container svg');
    const hasValidSvg = svgEl && svgEl.clientWidth > 0 && svgEl.clientHeight > 0;
    if (state.manifest && !hasValidSvg) {
      renderGraph();
    } else {
      handleResize();
      if (state.simulation) {
        state.simulation.alpha(0.08).restart();
      }
    }

    // Auto-recenter nodes in graph viewport
    setTimeout(() => {
      handleResize();
      fitToView();
    }, 60);
    setTimeout(() => {
      fitToView();
    }, 280);
  }

  updateSidebarVisibility();
  notifyStateChange('viewMode', mode);
}

export async function compileWorkstationHandoff(isQuiet = false, copyToClipboard = false) {
  let projectPath = (state.projectPath || '').trim();
  if (!projectPath) {
    const inputPath = document.getElementById('project-path')?.value.trim();
    if (inputPath) {
      projectPath = inputPath;
      state.projectPath = inputPath;
    }
  }
  if (!projectPath) {
    showToast('Please open or extract a project first.', 'warn');
    return;
  }

  const payload = getProblemPayload();
  const ws = state.workstation;

  const hasDesc = payload.description && payload.description.trim().length > 0;
  const hasError = (payload.consoleLogs && payload.consoleLogs.trim().length > 0) || Boolean(ws?.activeSyntaxError);

  if (!hasDesc && !hasError) {
    showToast('⚠️ Please enter an issue description or capture a runtime error before compiling a fix handoff.', 'warn');
    const inputProblem = document.getElementById('ws-input-problem');
    if (inputProblem) {
      inputProblem.focus();
      inputProblem.classList.add('highlight-attention');
      setTimeout(() => inputProblem.classList.remove('highlight-attention'), 1500);
    }
    if (ws) ws.targetLine = null;
    return;
  }

  const btnCompile = document.getElementById('btn-ws-compile-handoff');
  const btnHeroFix = document.getElementById('btn-ws-hero-fix');
  if (btnCompile) {
    btnCompile.disabled = true;
    btnCompile.textContent = '⏳ Compiling...';
  }
  if (btnHeroFix) {
    btnHeroFix.disabled = true;
    btnHeroFix.textContent = '⏳ Compiling...';
  }

  try {
    // 1. Rank files if not already done or if description changed
    let ranked = [];
    try {
      const rankRes = await fetch('/rank-relevant-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          issueDescription: payload.description,
          consoleLogs: payload.consoleLogs
        })
      });
      if (rankRes.ok) {
        const rankData = await rankRes.json();
        if (rankData.success && Array.isArray(rankData.files)) {
          ranked = rankData.files;

          // Auto-select files: if no files selected OR currently selected files don't contain any top error files
          const topFiles = ranked.filter(f => f.score >= 90);
          const hasTopErrorFile = topFiles.some(f => ws.selectedFiles && ws.selectedFiles.has(f.file));
          if (!ws.selectedFiles || ws.selectedFiles.size === 0 || (!hasTopErrorFile && topFiles.length > 0)) {
            ws.selectedFiles = new Set();
            if (topFiles.length > 0) {
              topFiles.forEach(f => ws.selectedFiles.add(f.file));
            } else if (ranked.length > 0) {
              ranked.slice(0, 3).forEach(f => ws.selectedFiles.add(f.file));
            }
          }

          // Safety net: NEVER allow a 0-file context handoff!
          if (!ws.selectedFiles || ws.selectedFiles.size === 0) {
            ws.selectedFiles = new Set();
            const { projectDiskFiles } = await import('../sidebar/tree.js');
            const available = (projectDiskFiles && projectDiskFiles.length > 0)
              ? projectDiskFiles.map(f => f.path)
              : (state.manifest?.nodes ? state.manifest.nodes.map(n => n.id) : []);

            const defaultPrimaries = [
              'src/main.js', 'src/game.js', 'src/weapons.js', 'src/scene-manager.js', 'src/ui.js', 'src/loot.js', 'src/style.css',
              'main.gd', 'player.gd', 'world.gd', 'game.gd'
            ];
            for (const p of defaultPrimaries) {
              if (available.includes(p)) {
                ws.selectedFiles.add(p);
                if (ws.selectedFiles.size >= 4) break;
              }
            }
            if (ws.selectedFiles.size === 0 && available.length > 0) {
              available.filter(f => f.endsWith('.js') || f.endsWith('.gd') || f.endsWith('.ts') || f.endsWith('.html'))
                .slice(0, 3)
                .forEach(f => ws.selectedFiles.add(f));
            }
          }
          setInspectorRankedFiles(ranked);
          const rightPane = document.getElementById('ws-pane-inspector');
          if (rightPane) renderInspectorPane(rightPane);
        }
      }
    } catch (err) {
      console.warn('File ranking failed:', err);
    }

    const attachedFiles = ws.selectedFiles ? Array.from(ws.selectedFiles) : [];
    const targetFile = attachedFiles.length > 0 ? attachedFiles[0] : '';

    // 2. Call /scoped-context compiler
    const res = await fetch('/scoped-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath,
        targetFile,
        issueDescription: payload.description,
        attachedFiles,
        fileModes: ws.fileModes || {},
        consoleLogs: payload.consoleLogs,
        consoleMode: ws.consoleFilter || 'red',
        screenshotBase64: payload.screenshotBase64,
        strategy: payload.strategy,
        category: payload.category
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Context compilation returned unsuccessful.');
    }

    const handoffData = {
      prompt: data.prompt,
      tokens: data.tokens,
      savingsPercent: data.savingsPercent,
      oversizedFiles: data.oversizedFiles,
      attachedFiles
    };

    setHandoffData(handoffData);
    switchWorkspaceState('handoff');

    // Update stepper
    updateTimelineSteps('handoff');

    if (copyToClipboard && data.prompt) {
      try {
        await navigator.clipboard.writeText(data.prompt);
        showToast(`✓ Context compiled & copied to clipboard (~${data.tokens.toLocaleString()} tokens)!`, 'success');
      } catch (_) {
        if (!isQuiet) {
          showToast(`✓ Context compiled (~${data.tokens.toLocaleString()} tokens, ${data.savingsPercent}% saved)!`, 'success');
        }
      }
    } else if (!isQuiet) {
      showToast(`✓ Context compiled (~${data.tokens.toLocaleString()} tokens, ${data.savingsPercent}% saved)!`, 'success');
    }

    // Auto-record session iteration in sidecar if session exists
    await recordSessionIteration({
      iterationIndex: currentIteration,
      problem: payload,
      attachedFiles,
      prompt: data.prompt,
      tokens: data.tokens
    });

  } catch (err) {
    console.error('Workstation compile error:', err);
    showToast(`Compilation failed: ${err.message}`, 'error');
  } finally {
    if (btnCompile) {
      btnCompile.disabled = false;
      btnCompile.textContent = '🔥 Fix This Issue';
    }
    if (btnHeroFix) {
      btnHeroFix.disabled = false;
      btnHeroFix.textContent = '🔥 Fix This Issue';
    }
  }
}

async function handlePatchApplied(result) {
  // Update timeline
  updateTimelineSteps('verify');

  // Refresh runtime error in problem pane
  const leftPane = document.getElementById('ws-pane-problem');
  if (leftPane) {
    try {
      await refreshConsoleEvidence(leftPane, true);
    } catch (_) {}
  }

  // Refresh right pane inspector
  const rightPane = document.getElementById('ws-pane-inspector');
  renderInspectorPane(rightPane);

  // Auto-record patch result to session
  await recordSessionIteration({
    iterationIndex: currentIteration,
    patchApplied: {
      patchId: result.patchId,
      count: result.count,
      files: result.files,
      timestamp: new Date().toISOString()
    },
    verification: {
      success: result.success,
      syntaxValid: result.syntaxValid,
      comparison: result.comparison
    }
  });
}

function handleContinueDebugging(prevResult) {
  currentIteration++;

  // Derive error summary
  let remainingProblem = '';
  if (prevResult && prevResult.comparison && prevResult.comparison.introducedErrors?.length > 0) {
    remainingProblem = `Iteration #${currentIteration}: Fixing introduced error:\n${prevResult.comparison.introducedErrors.join('\n')}`;
  } else if (prevResult && prevResult.syntaxError) {
    remainingProblem = `Iteration #${currentIteration}: Fixing syntax error in ${prevResult.syntaxError.file}:\n${prevResult.syntaxError.message}`;
  } else {
    remainingProblem = `Iteration #${currentIteration}: Next refinement step`;
  }

  // Pre-populate problem description
  if (state.workstation) {
    state.workstation.problemText = remainingProblem;
    const inputProblem = document.getElementById('ws-input-problem');
    if (inputProblem) inputProblem.value = remainingProblem;
  }

  // Reset verification in UI
  setVerificationResult(null);

  // Switch to handoff state
  switchWorkspaceState('handoff');

  // Update stepper
  updateTimelineSteps('handoff', `Handoff #${currentIteration}`);

  showToast(`Iteration #${currentIteration} ready. Review problem and compile handoff.`, 'info');
}

function updateTimelineSteps(activeStepId, customHandoffLabel = '') {
  const steps = [
    { id: 'problem', label: '🐞 Issue', icon: '🐞' },
    { id: 'handoff', label: customHandoffLabel || `📤 Handoff #${currentIteration}`, icon: '📤' },
    { id: 'patch', label: `⚡ Patch #${currentIteration}`, icon: '⚡' },
    { id: 'verify', label: '🔬 Verify', icon: '🔬' }
  ];

  let activeIndex = 0;
  if (activeStepId === 'problem') activeIndex = 0;
  else if (activeStepId === 'handoff') activeIndex = 1;
  else if (activeStepId === 'patch') activeIndex = 2;
  else if (activeStepId === 'verify') activeIndex = 3;

  setSessionSteps(steps, activeIndex);
}

function handleStepNavigation(step, idx) {
  if (step.id === 'problem') {
    // Focus problem description
    document.getElementById('ws-input-problem')?.focus();
  } else if (step.id === 'handoff') {
    switchWorkspaceState('handoff');
  } else if (step.id === 'patch' || step.id === 'verify') {
    switchWorkspaceState('patch');
  }
}

async function recordSessionIteration(iterData) {
  if (!state.projectPath) return;

  try {
    if (!currentSessionId) {
      // Create session on server
      const res = await fetch('/debug-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: state.projectPath,
          title: `Debug Session — Iteration #${currentIteration}`,
          category: state.workstation?.issueCategory || 'runtime_error',
          strategy: state.workstation?.contextStrategy || 'balanced'
        })
      });
      if (res.ok) {
        const d = await res.json();
        currentSessionId = d.session?.id || null;
      }
    }

    if (currentSessionId) {
      await fetch(`/debug-sessions/${encodeURIComponent(currentSessionId)}/iteration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: state.projectPath,
          iteration: iterData
        })
      });
    }
  } catch (err) {
    console.warn('Session persistence error:', err);
  }
}
