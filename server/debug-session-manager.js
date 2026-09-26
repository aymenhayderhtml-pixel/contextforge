/**
 * server/debug-session-manager.js
 * Sidecar persistence layer for Debug Sessions (.contextforge.sessions.json).
 *
 * Persists multi-turn iterations, problem descriptions, generated prompts,
 * applied patches, and verification results across client refreshes.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanAndResolvePath } from './paths.js';

const SIDECAR_FILENAME = '.contextforge.sessions.json';

/**
 * Returns the absolute path to the session sidecar file for a project.
 * @param {string} projectPath
 * @returns {string}
 */
export function getSidecarPath(projectPath) {
  const resolved = cleanAndResolvePath(projectPath);
  return join(resolved, SIDECAR_FILENAME);
}

/**
 * Loads sessions from the project's sidecar file.
 * @param {string} projectPath
 * @returns {{ activeSessionId: string|null, sessions: Array<object> }}
 */
export function loadProjectSessions(projectPath) {
  try {
    const filePath = getSidecarPath(projectPath);
    if (!existsSync(filePath)) {
      return { activeSessionId: null, sessions: [] };
    }
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      activeSessionId: parsed.activeSessionId || null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch (err) {
    console.warn(`[debug-session-manager] Failed to load sessions for ${projectPath}:`, err.message);
    return { activeSessionId: null, sessions: [] };
  }
}

/**
 * Saves sessions data to the project's sidecar file.
 * @param {string} projectPath
 * @param {{ activeSessionId: string|null, sessions: Array<object> }} data
 */
export function saveProjectSessions(projectPath, data) {
  try {
    const filePath = getSidecarPath(projectPath);
    const toSave = {
      activeSessionId: data.activeSessionId || null,
      sessions: Array.isArray(data.sessions) ? data.sessions : []
    };
    writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`[debug-session-manager] Failed to write sessions for ${projectPath}:`, err.message);
    return false;
  }
}

/**
 * Creates and persists a new debug session.
 *
 * @param {string} projectPath
 * @param {object} params
 * @param {string} [params.title]
 * @param {string} [params.category='runtime_error']
 * @param {string} [params.strategy='balanced']
 * @param {object} [params.problem]
 * @returns {object} The created session
 */
export function createSession(projectPath, {
  title = '',
  category = 'runtime_error',
  strategy = 'balanced',
  problem = null
} = {}) {
  const store = loadProjectSessions(projectPath);
  const now = new Date().toISOString();
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const newSession = {
    id: sessionId,
    title: title || `Debug Session — ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    category,
    strategy,
    status: 'active', // 'active' | 'resolved' | 'abandoned'
    createdAt: now,
    updatedAt: now,
    iterations: []
  };

  if (problem) {
    newSession.iterations.push({
      iterationIndex: 1,
      timestamp: now,
      problem,
      attachedFiles: [],
      prompt: '',
      patchApplied: null,
      verification: null
    });
  }

  store.sessions.unshift(newSession);
  store.activeSessionId = sessionId;

  saveProjectSessions(projectPath, store);
  return newSession;
}

/**
 * Retrieves a single session by ID.
 * @param {string} projectPath
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getSession(projectPath, sessionId) {
  const store = loadProjectSessions(projectPath);
  return store.sessions.find(s => s.id === sessionId) || null;
}

/**
 * Updates properties of a session.
 * @param {string} projectPath
 * @param {string} sessionId
 * @param {object} updates
 * @returns {object|null}
 */
export function updateSession(projectPath, sessionId, updates = {}) {
  const store = loadProjectSessions(projectPath);
  const session = store.sessions.find(s => s.id === sessionId);
  if (!session) return null;

  Object.assign(session, updates, { updatedAt: new Date().toISOString() });
  saveProjectSessions(projectPath, store);
  return session;
}

/**
 * Appends or updates an iteration in a session.
 * @param {string} projectPath
 * @param {string} sessionId
 * @param {object} iterationData
 * @returns {object|null}
 */
export function addSessionIteration(projectPath, sessionId, iterationData) {
  const store = loadProjectSessions(projectPath);
  const session = store.sessions.find(s => s.id === sessionId);
  if (!session) return null;

  const idx = iterationData.iterationIndex || (session.iterations.length + 1);
  const existingIndex = session.iterations.findIndex(i => i.iterationIndex === idx);

  const merged = {
    iterationIndex: idx,
    timestamp: new Date().toISOString(),
    ...iterationData
  };

  if (existingIndex >= 0) {
    session.iterations[existingIndex] = {
      ...session.iterations[existingIndex],
      ...merged
    };
  } else {
    session.iterations.push(merged);
  }

  session.updatedAt = new Date().toISOString();
  saveProjectSessions(projectPath, store);
  return session;
}

/**
 * Lists all sessions for a project.
 * @param {string} projectPath
 * @returns {Array<object>}
 */
export function listSessions(projectPath) {
  const store = loadProjectSessions(projectPath);
  return store.sessions;
}
