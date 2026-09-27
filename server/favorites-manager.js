/**
 * server/favorites-manager.js
 * Persistent, cross-project asset favorites library.
 * Stored outside any single project's directory (by default ~/.contextforge/favorites.json).
 * Supports starring assets with thumbnails, tags, and inspecting slot contracts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { inspectAssetFile } from './slot-contract.js';

/**
 * Returns the storage directory for cross-project favorites.
 * Respects CF_FAVORITES_DIR environment variable if provided.
 * @returns {string}
 */
export function getFavoritesDirectory() {
  if (process.env.CF_FAVORITES_DIR) {
    return process.env.CF_FAVORITES_DIR;
  }
  return join(homedir(), '.contextforge');
}

/**
 * Returns the path to the favorites.json file.
 * @returns {string}
 */
export function getFavoritesFilePath() {
  return join(getFavoritesDirectory(), 'favorites.json');
}

/**
 * Loads all stored favorites from disk.
 * @returns {Array<object>}
 */
export function loadFavorites() {
  const filePath = getFavoritesFilePath();
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[FavoritesManager] Error reading favorites.json:', err.message);
    return [];
  }
}

/**
 * Saves favorites array to disk.
 * @param {Array<object>} favorites
 */
export function saveFavorites(favorites) {
  const dir = getFavoritesDirectory();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = getFavoritesFilePath();
  writeFileSync(filePath, JSON.stringify(favorites, null, 2), 'utf-8');
}

/**
 * Adds an asset to the cross-project favorites library.
 * @param {object} item
 * @param {string} item.name
 * @param {string} [item.format]
 * @param {string[]} [item.tags]
 * @param {string} [item.thumbnail] - Base64 or SVG thumbnail data URI
 * @param {string|Buffer} [item.fileContent] - Base64 or raw content
 * @param {object} [item.assetInfo] - Pre-inspected asset info
 * @param {string} [item.sourceProject]
 * @returns {object} The created favorite record
 */
export function addFavorite(item) {
  if (!item || !item.name) {
    throw new Error('Favorite asset must have a name');
  }

  const favorites = loadFavorites();
  const id = item.id || `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let buffer;
  let fileContentBase64 = '';
  if (item.fileContent) {
    if (typeof item.fileContent === 'string') {
      const base64Prefix = /^data:[^;]+;base64,/;
      if (base64Prefix.test(item.fileContent)) {
        fileContentBase64 = item.fileContent.replace(base64Prefix, '');
        buffer = Buffer.from(fileContentBase64, 'base64');
      } else {
        fileContentBase64 = item.fileContent;
        try {
          buffer = Buffer.from(fileContentBase64, 'base64');
        } catch (_) {
          buffer = Buffer.from(fileContentBase64, 'utf-8');
        }
      }
    } else if (Buffer.isBuffer(item.fileContent)) {
      buffer = item.fileContent;
      fileContentBase64 = buffer.toString('base64');
    }
  }

  // Derive format from name if not given
  const ext = (item.format || item.name.split('.').pop() || 'asset').toLowerCase();

  // Inspect asset metadata if not provided and buffer is available
  let assetInfo = item.assetInfo;
  if (!assetInfo && buffer) {
    try {
      assetInfo = inspectAssetFile(buffer, item.name);
    } catch (_) {}
  }

  if (!assetInfo) {
    assetInfo = {
      format: ext,
      sizeBytes: buffer ? buffer.length : 0,
      rigged: Boolean(item.rigged),
      animations: Array.isArray(item.animations) ? item.animations : [],
      dimensions: item.dimensions || null
    };
  }

  const record = {
    id,
    name: item.name,
    format: ext,
    tags: Array.isArray(item.tags) ? item.tags.map(t => String(t).trim().toLowerCase()) : [],
    thumbnail: item.thumbnail || '',
    fileContent: fileContentBase64,
    fileSize: buffer ? buffer.length : (item.fileSize || 0),
    assetInfo,
    starred: item.starred !== false,
    sourceProject: item.sourceProject || '',
    createdAt: item.createdAt || new Date().toISOString()
  };

  // Replace existing if ID matches, else prepend
  const existingIdx = favorites.findIndex(f => f.id === id);
  if (existingIdx >= 0) {
    favorites[existingIdx] = record;
  } else {
    favorites.unshift(record);
  }

  saveFavorites(favorites);
  return record;
}

/**
 * Removes a favorite by ID.
 * @param {string} id
 * @returns {boolean}
 */
export function removeFavorite(id) {
  const favorites = loadFavorites();
  const filtered = favorites.filter(f => f.id !== id);
  if (filtered.length !== favorites.length) {
    saveFavorites(filtered);
    return true;
  }
  return false;
}

/**
 * Updates metadata on an existing favorite.
 * @param {string} id
 * @param {object} updates
 * @returns {object|null}
 */
export function updateFavorite(id, updates = {}) {
  const favorites = loadFavorites();
  const item = favorites.find(f => f.id === id);
  if (!item) return null;

  if (Array.isArray(updates.tags)) {
    item.tags = updates.tags.map(t => String(t).trim().toLowerCase());
  }
  if (updates.name !== undefined) {
    item.name = String(updates.name).trim();
  }
  if (updates.starred !== undefined) {
    item.starred = Boolean(updates.starred);
  }
  if (updates.thumbnail !== undefined) {
    item.thumbnail = updates.thumbnail;
  }

  saveFavorites(favorites);
  return item;
}

/**
 * Gets a single favorite by ID.
 * @param {string} id
 * @returns {object|null}
 */
export function getFavorite(id) {
  const favorites = loadFavorites();
  return favorites.find(f => f.id === id) || null;
}
