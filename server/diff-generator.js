/**
 * server/diff-generator.js
 * Generates unified line-by-line diff chunks for interactive diff preview (T080).
 */

/**
 * Compute line-by-line diff between two strings.
 * @param {string} before - Original text
 * @param {string} after - Modified text
 * @param {number} [contextLines=3] - Surrounding context lines
 * @returns {Array<{ type: 'context'|'add'|'delete', line: string, oldNum?: number, newNum?: number }>}
 */
export function generateUnifiedDiff(before, after, contextLines = 3) {
  const oldLines = (before || '').replace(/\r\n/g, '\n').split('\n');
  const newLines = (after || '').replace(/\r\n/g, '\n').split('\n');

  // Simple LCS line diff
  const n = oldLines.length;
  const m = newLines.length;

  // For small to medium files, standard DP matrix or greedy prefix/suffix trim
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (suffix < (n - prefix) && suffix < (m - prefix) && oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]) {
    suffix++;
  }

  const diff = [];

  // Prefix context
  const startContext = Math.max(0, prefix - contextLines);
  for (let i = startContext; i < prefix; i++) {
    diff.push({ type: 'context', line: oldLines[i], oldNum: i + 1, newNum: i + 1 });
  }

  // Deletions in middle
  for (let i = prefix; i < n - suffix; i++) {
    diff.push({ type: 'delete', line: oldLines[i], oldNum: i + 1 });
  }

  // Additions in middle
  for (let j = prefix; j < m - suffix; j++) {
    diff.push({ type: 'add', line: newLines[j], newNum: j + 1 });
  }

  // Suffix context
  const endContext = Math.min(n, n - suffix + contextLines);
  for (let i = n - suffix; i < endContext; i++) {
    const newIdx = m - (n - i);
    diff.push({ type: 'context', line: oldLines[i], oldNum: i + 1, newNum: newIdx + 1 });
  }

  return diff;
}
