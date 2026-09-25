/**
 * server/scaffold-validator.js — Validation for "+ Add Node" ID field (T031).
 *
 * Validates that node IDs match the expected path pattern for the engine and type,
 * contain no illegal characters, spaces, or traversal, and have appropriate extensions.
 */

/**
 * Validate and normalize a node ID for scaffolding.
 *
 * @param {string} nodeId - The raw node ID / path entered by the user
 * @param {string} engine - 'godot' | 'js'
 * @param {string} type - 'scene' | 'script' | 'module' | 'asset'
 * @param {string[]} [existingNodeIds=[]] - List of already existing node IDs in the project
 * @returns {{ valid: boolean, error?: string, normalizedId?: string }}
 */
export function validateNodeId(nodeId, engine, type, existingNodeIds = []) {
  if (!nodeId || typeof nodeId !== 'string') {
    return { valid: false, error: 'Node ID is required.' };
  }

  const trimmed = nodeId.trim().replace(/\\/g, '/');

  if (trimmed.length === 0) {
    return { valid: false, error: 'Node ID cannot be empty or whitespace.' };
  }

  // Reject paths containing whitespace (T031: bare spaces or names like "scene 1")
  if (/\s/.test(trimmed)) {
    return { valid: false, error: 'Node ID must not contain spaces. Use hyphens or underscores instead (e.g. scenes/boss_level.tscn).' };
  }

  // Reject path traversal and absolute paths
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    return { valid: false, error: 'Node ID must be a relative path, not an absolute path.' };
  }
  const parts = trimmed.split('/');
  if (parts.includes('..') || parts.includes('.')) {
    return { valid: false, error: 'Node ID must not contain path traversal (".", "..").' };
  }

  // Check for extension
  const fileName = parts[parts.length - 1];
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return { valid: false, error: 'Node ID is missing a file extension (e.g. .tscn, .gd, .js).' };
  }

  const ext = fileName.slice(lastDot + 1).toLowerCase();

  // Validate extension per engine & type
  if (engine === 'godot') {
    if (type === 'scene') {
      if (ext !== 'tscn') {
        return { valid: false, error: `Godot scenes must have a .tscn extension (got .${ext}).` };
      }
    } else if (type === 'script') {
      if (ext !== 'gd') {
        return { valid: false, error: `Godot scripts must have a .gd extension (got .${ext}).` };
      }
    }
  } else if (engine === 'js') {
    if (type === 'module') {
      if (!['js', 'mjs', 'ts'].includes(ext)) {
        return { valid: false, error: `JavaScript modules must have a .js, .mjs, or .ts extension (got .${ext}).` };
      }
    }
  }

  // Check duplicate
  if (existingNodeIds.includes(trimmed)) {
    return { valid: false, error: `Node "${trimmed}" already exists in the project.` };
  }

  return { valid: true, normalizedId: trimmed };
}
