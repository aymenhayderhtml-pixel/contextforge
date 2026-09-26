/**
 * public/js/history/history.js
 * 20-step undo/redo transaction history engine on the client.
 */

import { showToast } from '../shared/toast.js';
import { state, notifyStateChange } from '../state.js';

export async function performUndo(callbacks = {}) {
  const projectPath = state.projectPath;
  if (!projectPath) return;

  try {
    const res = await fetch('/history/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath })
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Nothing to undo', 'warn');
      return;
    }
    showToast(`↺ Undid: ${data.description}`, 'success');
    if (callbacks.onUndo) await callbacks.onUndo(data);
    await updateHistoryUI();
  } catch (err) {
    showToast('Undo failed: ' + err.message, 'error');
  }
}

export async function performRedo(callbacks = {}) {
  const projectPath = state.projectPath;
  if (!projectPath) return;

  try {
    const res = await fetch('/history/redo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath })
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Nothing to redo', 'warn');
      return;
    }
    showToast(`↻ Redid: ${data.description}`, 'success');
    if (callbacks.onRedo) await callbacks.onRedo(data);
    await updateHistoryUI();
  } catch (err) {
    showToast('Redo failed: ' + err.message, 'error');
  }
}

export async function updateHistoryUI() {
  const projectPath = state.projectPath;
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const menuUndo = document.getElementById('menu-undo');
  const menuRedo = document.getElementById('menu-redo');

  if (!projectPath) {
    if (btnUndo) btnUndo.disabled = true;
    if (btnRedo) btnRedo.disabled = true;
    return;
  }

  try {
    const res = await fetch(`/history/status?projectPath=${encodeURIComponent(projectPath)}`);
    const data = await res.json();
    if (!data.success) return;

    state.history = {
      canUndo: data.canUndo,
      canRedo: data.canRedo,
      undoCount: data.undoCount,
      redoCount: data.redoCount,
      lastUndoDescription: data.nextUndoDesc,
      lastRedoDescription: data.nextRedoDesc
    };
    notifyStateChange('history', state.history);

    if (btnUndo) {
      btnUndo.disabled = !data.canUndo;
      btnUndo.title = data.canUndo ? `Undo (Ctrl+Z): ${data.nextUndoDesc}` : 'Undo (Ctrl+Z) - No changes';
    }
    if (btnRedo) {
      btnRedo.disabled = !data.canRedo;
      btnRedo.title = data.canRedo ? `Redo (Ctrl+Y): ${data.nextRedoDesc}` : 'Redo (Ctrl+Y) - No changes';
    }
    if (menuUndo) {
      menuUndo.style.opacity = data.canUndo ? '1' : '0.4';
      menuUndo.title = data.canUndo ? `Undo: ${data.nextUndoDesc}` : 'Undo (No history)';
    }
    if (menuRedo) {
      menuRedo.style.opacity = data.canRedo ? '1' : '0.4';
      menuRedo.title = data.canRedo ? `Redo: ${data.nextRedoDesc}` : 'Redo (No history)';
    }
  } catch (_) {}
}

export async function getHistoryStatus(projectPath) {
  if (!projectPath) return null;
  try {
    const res = await fetch(`/history/status?projectPath=${encodeURIComponent(projectPath)}`);
    if (res.ok) {
      return await res.json();
    }
  } catch (_) {}
  return null;
}


export function initHistoryShortcuts(callbacks = {}) {
  window.addEventListener('keydown', (e) => {
    // Ignore keystrokes inside text inputs or textareas unless target is active
    const targetTag = e.target ? e.target.tagName.toLowerCase() : '';
    if (targetTag === 'input' || targetTag === 'textarea') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) {
        e.preventDefault();
        performRedo(callbacks);
      } else {
        e.preventDefault();
        performUndo(callbacks);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      performRedo(callbacks);
    }
  });
}

export const executeUndo = performUndo;
export const executeRedo = performRedo;

