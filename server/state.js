/**
 * Shared in-memory server state across route controllers.
 */
export const serverState = {
  /** @type {object|null} The current manifest in memory */
  currentManifest: null,

  /** @type {string|null} The project path the current manifest was extracted from */
  currentProjectPath: null,

  /** @type {{ pid: number, child: any, target: string, isPaused: boolean }|null} Active Godot runtime process */
  activeGodotProcess: null,

  /** @type {Map<string, { status: string, holder: string, locked_at: string }>} */
  locks: new Map()
};

/** Stale-lock timeout in milliseconds (30 minutes) */
export const STALE_LOCK_MS = 30 * 60 * 1000;

/**
 * Check if a lock is stale.
 * @param {{ locked_at: string }} lock
 * @returns {boolean}
 */
export function isLockStale(lock) {
  if (!lock || !lock.locked_at) return false;
  const lockedTime = new Date(lock.locked_at).getTime();
  if (!Number.isFinite(lockedTime)) return true;
  return Date.now() - lockedTime > STALE_LOCK_MS;
}

/**
 * Get current lock state for a node with auto-stale release.
 * @param {string} nodeId
 * @returns {{ status: string, holder: string, locked_at: string }}
 */
export function getLockState(nodeId) {
  const existing = serverState.locks.get(nodeId);
  if (!existing || existing.status === 'free') {
    return { status: 'free', holder: '', locked_at: '' };
  }
  if (isLockStale(existing)) {
    serverState.locks.set(nodeId, { status: 'free', holder: '', locked_at: '' });
    return { status: 'free', holder: '', locked_at: '' };
  }
  return existing;
}
