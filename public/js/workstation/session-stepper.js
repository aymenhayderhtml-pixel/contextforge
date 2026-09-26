/**
 * public/js/workstation/session-stepper.js
 * Timeline breadcrumb stepper tracking multi-turn iterations (Problem -> Handoff -> Patch -> Verify).
 */

let currentSteps = [];
let currentActiveIndex = 0;
let onStepClickCallback = null;

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function initSessionStepper(container, { onStepClick } = {}) {
  if (!container) return;
  onStepClickCallback = onStepClick;
  renderSessionStepper(container);
}

export function setSessionSteps(steps = [], activeIndex = 0) {
  currentSteps = steps;
  currentActiveIndex = activeIndex;
  const container = document.getElementById('ws-session-stepper');
  if (container) {
    renderSessionStepper(container);
  }
}

export function renderSessionStepper(container) {
  if (!container) return;

  if (!currentSteps || currentSteps.length === 0) {
    currentSteps = [
      { id: 'problem', label: '🐞 Issue', icon: '🐞', status: 'active' },
      { id: 'handoff', label: '📤 Handoff', icon: '📤', status: 'pending' },
      { id: 'patch', label: '⚡ Patch', icon: '⚡', status: 'pending' },
      { id: 'verify', label: '🔬 Verify', icon: '🔬', status: 'pending' }
    ];
    currentActiveIndex = 0;
  }

  const nodesHtml = currentSteps.map((step, idx) => {
    const isActive = idx === currentActiveIndex;
    const isCompleted = idx < currentActiveIndex;
    let badgeClass = '';
    if (isActive) badgeClass = 'active';
    else if (isCompleted) badgeClass = 'completed';

    const arrow = idx < currentSteps.length - 1 ? '<span class="ws-step-arrow">➔</span>' : '';

    return `
      <div class="ws-step-node ${badgeClass}" data-step-index="${idx}" title="${esc(step.label)}">
        <span>${step.icon || ''}</span>
        <span>${esc(step.label)}</span>
      </div>
      ${arrow}
    `;
  }).join('');

  container.innerHTML = `
    <div class="ws-timeline-stepper">
      <div style="font-weight:700; font-size:0.68rem; color:var(--primary); margin-right:0.35rem; display:flex; align-items:center; gap:0.25rem;">
        <span>TIMELINE</span>
      </div>
      <div style="display:flex; align-items:center; gap:0.35rem; flex:1; overflow-x:auto;">
        ${nodesHtml}
      </div>
    </div>
  `;

  container.querySelectorAll('.ws-step-node').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.getAttribute('data-step-index'), 10);
      currentActiveIndex = idx;
      renderSessionStepper(container);
      if (onStepClickCallback) {
        onStepClickCallback(currentSteps[idx], idx);
      }
    });
  });
}
