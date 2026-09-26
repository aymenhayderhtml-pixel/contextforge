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
  const addScore = (file, score, reason, line = null) => {
    const norm = file.replace(/\\/g, '/').replace(/^\/+/, '');
    const current = candidates.get(norm) || { file: norm, score: 0, line: null, reasons: [] };
    if (score > current.score) {
      current.score = score;
    }
    if (line && !current.line) {
      current.line = parseInt(line, 10);
    }
    if (!current.reasons.includes(reason)) {
      current.reasons.push(reason);
    }
    candidates.set(norm, current);
  };

  const combinedLogs = (typeof consoleLogs === 'string' ? consoleLogs : '') + '\n' + issueDescription;

  // 1. Stack trace & console parsing
  const stackRegex = /(?:https?:\/\/[^/]+\/|res:\/\/|at\s+|[\s('\"@])([a-zA-Z0-9_./-]+\.(?:gd|js|ts|html|tscn|json))(?::(\d+))?/g;
  let match;
  let isFirstStackMatch = true;
  while ((match = stackRegex.exec(combinedLogs)) !== null) {
    const rawFile = match[1].replace(/^res:\/\//, '').replace(/^https?:\/\/[^/]+\//, '');
    const lineNum = match[2] ? parseInt(match[2], 10) : null;
    const absPath = resolveProjectPath(projectPath, rawFile);
    if (absPath && existsSync(absPath)) {
      if (isFirstStackMatch) {
        addScore(rawFile, 100, lineNum ? `Error origin line ${lineNum}` : 'Primary error location in console', lineNum);
        isFirstStackMatch = false;
      } else {
        addScore(rawFile, 95, lineNum ? `Active stack frame line ${lineNum}` : 'Referenced in error stack', lineNum);
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
      line: c.line || null,
      reason: c.reasons.join(', '),
      isTop: c.score >= 95
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  return results;
}

/**
 * Build the strict surgical patch instruction block embedded in AI handoffs.
 */
export function getStrictPatchContract() {
  return `================================================================================
CRITICAL FORMAT & COLLABORATION INSTRUCTIONS FOR THE AI:
================================================================================

1. MULTI-TURN ITERATIVE WORKFLOW (IT IS NOT A MUST TO ONE-SHOT!):
- This is an interactive pair-programming session. You do NOT have to one-shot or guess the entire fix in a single turn.
- Incremental, verified progress is preferred over risky assumptions. You can:
  a) Propose a step-1 fix or add targeted diagnostic logs (e.g. console.log / print) to inspect runtime state.
  b) Ask clarifying questions or request additional code/interfaces before committing to a larger change.
- The user will apply your code into ContextForge with 1 click, test it live in the game engine, and feed runtime verification and compiler errors straight back to you in the next turn.

2. SURGICAL CODE EDIT FORMAT (PREFERRED OVER REWRITING FULL FILES):
Whenever modifying existing files, return surgical patch blocks in this exact format:

### EDIT: relative/path.ext
<<<<<<< FIND
<exact original code snippet, unmodified, enough surrounding lines to be unique in the file>
=======
<complete replacement code>
>>>>>>> REPLACE

STRICT SURGICAL PATCH CONTRACT:
1. Exact Character Match: The FIND block must be an EXACT, character-for-character substring of the supplied source code (including exact whitespace, indentation, semicolons, and quotes). Do NOT re-indent or normalize whitespace in FIND.
2. Surrounding Anchors: Include 2 to 4 unchanged surrounding lines in FIND to ensure the patch engine finds the unique insertion point in the file. Do not repeat the whole file.
3. Complete Replacement: The REPLACE block must contain the full runnable replacement code. NEVER write lazy placeholders like "// rest stays the same" or "// ... existing code".
4. Multiple Edits: You can provide multiple ### EDIT: blocks across the same file or different files in a single reply.
5. New Files: If creating a brand new file from scratch that does not yet exist, use:
### FILE: relative/path.ext
\`\`\`language
// Complete runnable file content
\`\`\`

3. HOW TO REQUEST MORE CODE OR CONTEXT:
- If the supplied outline or focused snippet is insufficient to diagnose or fix the issue with certainty, DO NOT GUESS OR INVENT UNSEEN APIS!
- Simply respond with "CONTEXT INSUFFICIENT" and list the file path(s) and symbols you need:
  CONTEXT INSUFFICIENT: Need to inspect \`src/scene-manager.js\` (functions loadTrack and resetPosition) and \`src/track.js\` to check the collision boundary interface.
- ContextForge automatically parses your requested file paths, attaches their full code or focused snippets, and re-generates the context package for you immediately!`;
}
