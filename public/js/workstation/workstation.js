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

let isInitialized = false;
let currentIteration = 1;
let currentSessionId = null;

export function initWorkstation() {
  const container = document.getElementById('workstation-container');
  const btnGraph = document.getElementById('btn-view-graph');
  const btnWorkstation = document.getElementById('btn-view-workstation');

  if (!container) return;

  // Bind view toggle buttons
  btnGraph?.addEventListener('click', () => switchViewMode('graph'));
  btnWorkstation?.addEventListener('click', () => switchViewMode('workstation'));

  // Initialize the 3 panes
  const leftPane = document.getElementById('ws-pane-problem');
  const centerPane = document.getElementById('ws-pane-workspace');
  const rightPane = document.getElementById('ws-pane-inspector');

  initProblemPane(leftPane, {
    onCompile: () => compileWorkstationHandoff()
  });

  initWorkspacePane(centerPane, {
    onApplySuccess: (result) => handlePatchApplied(result),
    onContinueDebugging: (result) => handleContinueDebugging(result),
    onRecompile: () => compileWorkstationHandoff()
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

  isInitialized = true;
}

export function switchViewMode(mode) {
  const graphContainer = document.getElementById('graph-container');
  const wsContainer = document.getElementById('workstation-container');
  const btnGraph = document.getElementById('btn-view-graph');
  const btnWs = document.getElementById('btn-view-workstation');
  const sidePanel = document.getElementById('side-panel');
  const leftSidebar = document.getElementById('left-sidebar');

  if (mode === 'workstation') {
    state.viewMode = 'workstation';
    document.body.classList.add('mode-workstation');
    if (graphContainer) graphContainer.style.display = 'none';
    if (wsContainer) wsContainer.style.display = 'grid';
    if (sidePanel) sidePanel.style.display = 'none';
    if (leftSidebar) leftSidebar.style.display = 'none';

    btnGraph?.classList.remove('active');
    btnWs?.classList.add('active');

    // Refresh console logs and panes if project is loaded
    if (state.projectPath) {
      const leftPane = document.getElementById('ws-pane-problem');
      refreshConsoleEvidence(leftPane, false);
      const rightPane = document.getElementById('ws-pane-inspector');
      renderInspectorPane(rightPane);
    }
  } else {
    state.viewMode = 'graph';
    document.body.classList.remove('mode-workstation');
    if (wsContainer) wsContainer.style.display = 'none';
    if (graphContainer) graphContainer.style.display = 'block';
    if (leftSidebar) leftSidebar.style.display = '';

    btnWs?.classList.remove('active');
    btnGraph?.classList.add('active');

    // Resume force simulation if needed
    if (state.simulation) {
      state.simulation.alpha(0.05).restart();
    }
  }

  notifyStateChange('viewMode', mode);
}

export async function compileWorkstationHandoff(isQuiet = false) {
  const projectPath = state.projectPath;
  if (!projectPath) {
    showToast('Please open or extract a project first.', 'warn');
    return;
  }

  const payload = getProblemPayload();
  const ws = state.workstation;

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
              ws.selectedFiles.add(ranked[0].file);
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

    if (!isQuiet) {
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
