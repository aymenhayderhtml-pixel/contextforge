import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Strips enclosing quotes and resolves path.
 * @param {string} p
 * @returns {string}
 */
export function cleanAndResolvePath(p) {
  if (!p || typeof p !== 'string') return '';
  let cleaned = p.trim();
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return resolve(cleaned).replace(/\\/g, '/');
}

/**
 * Resolve a caller-supplied relative path against a project root and guarantee
 * the result stays inside that root. Returns null on traversal or absolute paths.
 * @param {string} projectPath
 * @param {string} relPath
 * @returns {string|null}
 */
export function resolveProjectPath(projectPath, relPath) {
  if (!projectPath || !relPath || typeof relPath !== 'string') return null;
  const root = resolve(projectPath);
  const normalizedRoot = resolve(projectPath, '.');
  const candidate = resolve(root, relPath.replace(/\\/g, '/').replace(/^\/+/, ''));
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + '/')) {
    return null;
  }
  return candidate;
}

/**
 * Detect which engines a project uses.
 * @param {string} projectPath
 * @returns {{ godot: boolean, js: boolean }}
 */
export function detectEngines(projectPath) {
  const hasGodot = existsSync(join(projectPath, 'project.godot'));
  const hasPackageJson = existsSync(join(projectPath, 'package.json'));
  const hasSrc = existsSync(join(projectPath, 'src'));
  const hasIndexHtml = existsSync(join(projectPath, 'index.html'));
  const js = hasPackageJson || hasIndexHtml || hasSrc;

  return { godot: hasGodot, js };
}

/**
 * Compute depended_on_by for all nodes from the edge set.
 * @param {Array} nodes
 * @param {Array} edges
 */
export function computeDependedOnBy(nodes, edges) {
  const reverseMap = new Map();
  for (const edge of edges) {
    if (!reverseMap.has(edge.to)) {
      reverseMap.set(edge.to, new Set());
    }
    reverseMap.get(edge.to).add(edge.from);
  }

  for (const node of nodes) {
    const dependents = reverseMap.get(node.id);
    node.depended_on_by = dependents ? [...dependents].sort() : [];
  }
}

/**
 * Recompute depended_on_by for every node from the current edge set, then drop
 * dangling depends_on / depended_on_by references.
 * @param {object} manifest
 */
export function recomputeManifestLinks(manifest) {
  const known = new Set(manifest.nodes.map(n => n.id));
  const byId = new Map(manifest.nodes.map(n => [n.id, n]));

  for (const node of manifest.nodes) {
    if (Array.isArray(node.depends_on)) {
      node.depends_on = node.depends_on.filter(id => known.has(id));
    }
  }

  computeDependedOnBy(manifest.nodes, manifest.edges);

  for (const node of manifest.nodes) {
    if (Array.isArray(node.depended_on_by)) {
      node.depended_on_by = node.depended_on_by.filter(id => known.has(id));
    }
  }

  manifest.edges = manifest.edges.filter(e => byId.has(e.from) && byId.has(e.to));
}
