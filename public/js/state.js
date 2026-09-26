/**
 * public/js/state.js
 * Central shared observable client state.
 */

export const state = {
  /** @type {object|null} The current project manifest */
  manifest: null,

  /** @type {string} Active project filesystem root path */
  projectPath: '',

  /** @type {any} Active D3 force simulation */
  simulation: null,

  /** @type {string|null} ID of currently selected node */
  selectedNodeId: null,

  /** @type {Record<string, { status: string, holder: string, locked_at: string }>} Node lock state */
  currentLocks: {},

  /** @type {string} Active session holder identifier */
  currentSessionHolder: 'user',

  // Scaling & Navigation State (Phase 9 & 10)
  currentZoom: null,
  currentSvg: null,
  isFocusMode: false,
  searchQuery: '',
  clusterThreshold: 20,
  expandedFolders: new Set(),
  clusterEnabled: true,
  groupOrphansEnabled: true,
  pinnedNodePositions: new Map(),

  // Dev Server & Runtime State
  devServerState: 'stopped', // 'stopped' | 'setting-up' | 'running'
  devServerUrl: null,
  openGameTabs: [],

  // Undo / Redo Transaction History
  history: {
    canUndo: false,
    canRedo: false,
    undoCount: 0,
    redoCount: 0,
    lastUndoDescription: '',
    lastRedoDescription: ''
  }
};

/** Listeners for state change events */
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyStateChange(prop, value) {
  for (const listener of listeners) {
    try {
      listener(prop, value, state);
    } catch (err) {
      console.error('State change listener error:', err);
    }
  }
}
