import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from './paths.js';
import { getProjectFileTree } from './project-init.js';

/**
 * Score and rank files in project for relevance against an issue description and console logs.
 *
 * Scoring:
 * - 100: Exact file and line in error stack top
 * - 95: File appearing in error log or call stack
 * - 80: Exact symbol or keyword match in file
 * - 75: Direct dependency / dependent in manifest
 * - 40: Keyword in filename
 *
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {string} [opts.issueDescription]
 * @param {string} [opts.consoleLogs]
 * @param {object} [opts.manifest]
 * @returns {Array<{ file: string, score: number, reason: string, isTop: boolean }>}
 */
export function rankRelevantFiles({ projectPath, issueDescription = '', consoleLogs = '', manifest = null }) {
  if (!projectPath || !existsSync(projectPath)) return [];

  const candidates = new Map();
  const addScore = (file, score, reason) => {
    const norm = file.replace(/\\/g, '/').replace(/^\/+/, '');
    const current = candidates.get(norm) || { file: norm, score: 0, reasons: [] };
    if (score > current.score) {
      current.score = score;
    }
    if (!current.reasons.includes(reason)) {
      current.reasons.push(reason);
    }
    candidates.set(norm, current);
  };

  const combinedLogs = (typeof consoleLogs === 'string' ? consoleLogs : '') + '\n' + issueDescription;

  // 1. Stack trace & console parsing
  const stackRegex = /(?:res:\/\/|at\s+|[\s('"])([a-zA-Z0-9_./-]+\.(?:gd|js|ts|html|tscn|json))(?::(\d+))?/g;
  let match;
  let isFirstStackMatch = true;
  while ((match = stackRegex.exec(combinedLogs)) !== null) {
    const rawFile = match[1].replace(/^res:\/\//, '');
    const lineNum = match[2];
    const absPath = resolveProjectPath(projectPath, rawFile);
    if (absPath && existsSync(absPath)) {
      if (isFirstStackMatch) {
        addScore(rawFile, 100, lineNum ? `Error origin line ${lineNum}` : 'Primary error location in console');
        isFirstStackMatch = false;
      } else {
        addScore(rawFile, 95, lineNum ? `Active stack frame line ${lineNum}` : 'Referenced in error stack');
      }
    }
  }

  // 2. Keyword tokens from issue description
  const tokens = issueDescription
    .toLowerCase()
    .split(/[^a-zA-Z0-9_.-]+/)
    .filter(t => t.length >= 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'when', 'what'].includes(t));

  const allFiles = getProjectFileTree(projectPath);
  for (const item of allFiles) {
    const relFile = typeof item === 'string' ? item : (item && item.path ? item.path : '');
    if (!relFile) continue;
    const lowerRel = relFile.toLowerCase();
    for (const token of tokens) {
      if (lowerRel.includes(token)) {
        addScore(relFile, 40, `Filename matches keyword "${token}"`);
      }
    }
  }

  // 3. Static manifest dependency boost
  if (manifest && manifest.nodes) {
    const topCandidates = [...candidates.entries()].filter(([_, c]) => c.score >= 90).map(([f]) => f);
    for (const topFile of topCandidates) {
      const topNode = manifest.nodes.find(n => n.id === topFile);
      if (topNode) {
        for (const depId of (topNode.depends_on || [])) {
          addScore(depId, 75, `Direct dependency of ${topFile}`);
        }
        for (const depBy of (topNode.depended_on_by || [])) {
          addScore(depBy, 70, `Caller / Dependent of ${topFile}`);
        }
      }
    }
  }

  // Sort descending by score
  const results = [...candidates.values()]
    .map(c => ({
      file: c.file,
      score: c.score,
      reason: c.reasons.join(', '),
      isTop: c.score >= 95
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  return results;
}

/**
 * Build the strict surgical patch instruction block.
 */
export function getStrictPatchContract() {
  return `CRITICAL FORMAT REQUIREMENT:
Respond ONLY with a PATCH using surgical edit blocks in this exact format:
### EDIT: relative/path.ext
<<<<<<< FIND
<exact original code snippet, unmodified, enough lines to be unique in the file>
=======
<replacement code>
>>>>>>> REPLACE

STRICT SURGICAL PATCH CONTRACT:
1. Every FIND section must be an EXACT, character-for-character substring of the supplied source code.
2. Do NOT normalize whitespace or re-indent.
3. Do NOT paraphrase or omit lines.
4. Do NOT guess or invent original code that was not provided in the context.
If the supplied context is insufficient, respond with "CONTEXT INSUFFICIENT" and name the required file/symbol.

RULES:
- Only include the lines that need to change in FIND, with enough surrounding context to make it uniquely identifiable in the file. Do not repeat the whole file.
- Output ONLY edit blocks in this format — no explanation before, between, or after them.
- Never truncate replacement code or write placeholders like '// rest stays the same'.`;
}
