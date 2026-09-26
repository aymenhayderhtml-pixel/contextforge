import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_HISTORY_STEPS = 20;

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let cleaned = p.trim();
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return resolve(cleaned).replace(/\\/g, '/');
}

/**
 * Map<string, {
 *   undoStack: Array<HistoryStep>,
 *   redoStack: Array<HistoryStep>,
 *   patchCounter: number
 * }>
 */
const projectHistories = new Map();

function getProjectHistory(projectPath) {
  const norm = normalizePath(projectPath);
  if (!norm) return null;
  if (!projectHistories.has(norm)) {
    projectHistories.set(norm, {
      undoStack: [],
      redoStack: [],
      patchCounter: 0
    });
  }
  return projectHistories.get(norm);
}

/**
 * Record a file modification transaction in the project's history stack.
 * @param {string} projectPath
 * @param {string} description
 * @param {Array<{ path: string, before: string|null, after: string|null }>} files
 * @param {object} [metadata]
 */
export function recordHistoryStep(projectPath, description, files, metadata = {}) {
  const norm = normalizePath(projectPath);
  const history = getProjectHistory(norm);
  if (!history || !files || files.length === 0) return null;

  // Filter to actual modified files
  const changedFiles = files.filter(f => f.before !== f.after);
  if (changedFiles.length === 0) return null;

  history.patchCounter++;
  const patchId = `PATCH #${String(history.patchCounter).padStart(3, '0')}`;

  const step = {
    id: Date.now(),
    patchId,
    timestamp: Date.now(),
    description: description || `Modified ${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''}`,
    files: changedFiles,
    metadata: {
      ...metadata,
      filesCount: changedFiles.length,
      paths: changedFiles.map(f => f.path)
    }
  };

  history.undoStack.push(step);
  if (history.undoStack.length > MAX_HISTORY_STEPS) {
    history.undoStack.shift();
  }
  history.redoStack = []; // Any new file modification invalidates the redo branch

  return step;
}

/**
 * Undo the most recent transaction.
 * @param {string} projectPath
 */
export function undo(projectPath) {
  const norm = normalizePath(projectPath);
  const history = getProjectHistory(norm);
  if (!history || history.undoStack.length === 0) {
    return { success: false, error: 'Nothing to undo' };
  }

  const step = history.undoStack.pop();
  const restoredFiles = [];

  for (const file of step.files) {
    const absPath = join(norm, file.path);
    if (file.before === null) {
      // File was newly created by this step -> remove it
      if (existsSync(absPath)) {
        try { unlinkSync(absPath); } catch (_) {}
      }
    } else {
      // Restore previous content
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(absPath, file.before, 'utf-8');
    }
    restoredFiles.push(file.path);
  }

  history.redoStack.push(step);

  return {
    success: true,
    patchId: step.patchId,
    description: step.description,
    restoredFiles,
    canUndo: history.undoStack.length > 0,
    canRedo: true,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length
  };
}

/**
 * Redo the most recently undone transaction.
 * @param {string} projectPath
 */
export function redo(projectPath) {
  const norm = normalizePath(projectPath);
  const history = getProjectHistory(norm);
  if (!history || history.redoStack.length === 0) {
    return { success: false, error: 'Nothing to redo' };
  }

  const step = history.redoStack.pop();
  const reappliedFiles = [];

  for (const file of step.files) {
    const absPath = join(norm, file.path);
    if (file.after === null) {
      if (existsSync(absPath)) {
        try { unlinkSync(absPath); } catch (_) {}
      }
    } else {
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(absPath, file.after, 'utf-8');
    }
    reappliedFiles.push(file.path);
  }

  history.undoStack.push(step);

  return {
    success: true,
    patchId: step.patchId,
    description: step.description,
    reappliedFiles,
    canUndo: true,
    canRedo: history.redoStack.length > 0,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length
  };
}

/**
 * Returns current undo/redo status and transaction list for the project.
 * @param {string} projectPath
 */
export function getHistoryStatus(projectPath) {
  const norm = normalizePath(projectPath);
  const history = getProjectHistory(norm);
  if (!history) {
    return {
      canUndo: false,
      canRedo: false,
      undoCount: 0,
      redoCount: 0,
      nextUndoDesc: '',
      nextRedoDesc: '',
      recentTransactions: []
    };
  }

  const nextUndo = history.undoStack.length > 0 ? history.undoStack[history.undoStack.length - 1] : null;
  const nextRedo = history.redoStack.length > 0 ? history.redoStack[history.redoStack.length - 1] : null;

  return {
    canUndo: history.undoStack.length > 0,
    canRedo: history.redoStack.length > 0,
    undoCount: history.undoStack.length,
    redoCount: history.redoStack.length,
    nextUndoDesc: nextUndo ? `${nextUndo.patchId}: ${nextUndo.description}` : '',
    nextRedoDesc: nextRedo ? `${nextRedo.patchId}: ${nextRedo.description}` : '',
    recentTransactions: history.undoStack.slice(-5).map(s => ({
      patchId: s.patchId,
      description: s.description,
      files: s.files.map(f => f.path),
      timestamp: s.timestamp
    }))
  };
}

/**
 * Clear history (for testing or reset).
 * @param {string} projectPath
 */
export function clearHistory(projectPath) {
  const norm = normalizePath(projectPath);
  if (norm) {
    projectHistories.delete(norm);
  }
}
