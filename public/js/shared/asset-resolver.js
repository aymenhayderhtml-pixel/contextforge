/**
 * public/js/shared/asset-resolver.js
 * Ground-truth node resolution for 3D preview raycast clicks and sidebar asset selection.
 * Handles relative web paths, leading slashes, Windows backslashes, Godot res:// paths,
 * and suffix/basename fallbacks.
 */

/**
 * Normalizes an asset path/id for resilient comparison.
 * @param {string} p
 * @returns {string}
 */
export function normalizeAssetPath(p) {
  if (!p || typeof p !== 'string') return '';
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^res:\/\//, '')
    .replace(/^\.?\//, '');
}

/**
 * Extracts the file basename from a path.
 * @param {string} p
 * @returns {string}
 */
export function getAssetBasename(p) {
  const norm = normalizeAssetPath(p);
  const parts = norm.split('/');
  return parts[parts.length - 1] || norm;
}

/**
 * Resolves a raw asset ID or disk file path against manifest nodes.
 * Prioritizes exact matches, then normalized path matches, then type='asset' suffix matches,
 * and finally basename matches.
 *
 * @param {object} manifest - ContextForge manifest object containing .nodes array
 * @param {string} rawAssetId - Asset ID reported from preview click or sidebar file path
 * @returns {object|null} Matched manifest node, or null
 */
export function resolveAssetNode(manifest, rawAssetId) {
  if (!manifest || !Array.isArray(manifest.nodes) || !rawAssetId) return null;
  const raw = String(rawAssetId).trim();
  if (!raw) return null;

  const normalized = normalizeAssetPath(raw);
  const base = getAssetBasename(raw).toLowerCase();

  // 1. Exact match on raw ID
  let match = manifest.nodes.find(n => n.id === raw);
  if (match) return match;

  // 2. Exact match on normalized path
  match = manifest.nodes.find(n => normalizeAssetPath(n.id) === normalized);
  if (match) return match;

  // 3. Suffix match on asset nodes (type === 'asset')
  const assetNodes = manifest.nodes.filter(n => n.type === 'asset');
  match = assetNodes.find(n => {
    const nNorm = normalizeAssetPath(n.id);
    return nNorm.endsWith(normalized) || normalized.endsWith(nNorm);
  });
  if (match) return match;

  // 4. Suffix match on any node
  match = manifest.nodes.find(n => {
    const nNorm = normalizeAssetPath(n.id);
    return nNorm.endsWith(normalized) || normalized.endsWith(nNorm);
  });
  if (match) return match;

  // 5. Basename match on asset nodes
  match = assetNodes.find(n => getAssetBasename(n.id).toLowerCase() === base);
  if (match) return match;

  // 6. Basename match on any node
  match = manifest.nodes.find(n => getAssetBasename(n.id).toLowerCase() === base);
  if (match) return match;

  return null;
}
