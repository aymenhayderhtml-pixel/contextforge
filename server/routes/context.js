import { Router } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { cleanAndResolvePath, resolveProjectPath } from '../paths.js';
import { serverState } from '../state.js';
import {
  generateFileOutline,
  getCachedFileOutline,
  extractScopedSnippet,
  OVERSIZED_LINE_THRESHOLD,
  checkOversizedFile
} from '../outline.js';
import { rankRelevantFiles, getStrictPatchContract } from '../context-compiler.js';

const router = Router();

/** Static conventions snippet included in every context package. */
const CONVENTIONS_SNIPPET = `
## Project Conventions
- Godot: @export vars are public contract. Prefix private funcs with _.
  Signals are the inter-scene communication mechanism.
- JS/Three.js: Named exports form the public contract. Use ES module imports.
- Every file's public interface (contract) is tracked. Do NOT change function
  signatures, signal names, or export names without updating dependents.
- If you add a new dependency, it must be importable/loadable from the project.
`.trim();

/**
 * Build an interface-only stub for a node (contract summary + signature outline, not full source).
 */
function buildStub(node, projectPath = serverState.currentProjectPath) {
  const lines = [`// --- Stub: ${node.id} (${node.engine}/${node.type}) ---`];

  if (node.contract.exports.length > 0) {
    lines.push(`// Exports: ${node.contract.exports.join(', ')}`);
  }
  if (node.contract.signals.length > 0) {
    lines.push(`// Signals: ${node.contract.signals.join(', ')}`);
  }
  if (node.contract.requires.length > 0) {
    lines.push(`// Requires: ${node.contract.requires.join(', ')}`);
  }

  if (projectPath) {
    const cached = getCachedFileOutline(projectPath, node.id);
    if (cached && cached.outline && !cached.outline.startsWith('// (No')) {
      lines.push('// Outline:');
      for (const sig of cached.outline.split('\n')) {
        lines.push(`//   ${sig}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * POST /package-context
 * Assemble a context bundle for handing a task to an AI model.
 * Body: { "nodeId": "scenes/Player.tscn", "scoped": true, "fullDepIds": [] }
 */
router.post('/package-context', (req, res) => {
  const { nodeId, scoped = true, fullDepIds = [] } = req.body;

  if (!nodeId) {
    return res.status(400).json({ error: 'Missing "nodeId" in request body' });
  }
  if (!serverState.currentManifest) {
    return res.status(400).json({ error: 'No manifest loaded. Extract a project first.' });
  }

  const node = serverState.currentManifest.nodes.find(n => n.id === nodeId);
  if (!node) {
    return res.status(404).json({ error: `Node "${nodeId}" not found in manifest` });
  }

  const parts = [];

  // 1. Target file's full content
  const targetPath = join(serverState.currentProjectPath, nodeId);
  let targetLines = 0;
  if (existsSync(targetPath)) {
    const content = readFileSync(targetPath, 'utf-8');
    targetLines = content.split(/\r?\n/).length;
    parts.push(`## Target File: ${nodeId}\n\`\`\`\n${content}\n\`\`\``);
  } else {
    parts.push(`## Target File: ${nodeId}\n(File does not exist yet — this is a new node)`);
  }

  // 2. Interface-only stubs of direct dependencies
  if (node.depends_on.length > 0) {
    parts.push('\n## Direct Dependencies (interface only)');
    for (const depId of node.depends_on) {
      const depNode = serverState.currentManifest.nodes.find(n => n.id === depId);
      const isFull = fullDepIds.includes(depId) || scoped === false;
      const depPath = join(serverState.currentProjectPath, depId);
      if (isFull && existsSync(depPath)) {
        parts.push(`// --- Full Source: ${depId} ---\n\`\`\`\n${readFileSync(depPath, 'utf-8')}\n\`\`\``);
      } else if (depNode) {
        parts.push(buildStub(depNode, serverState.currentProjectPath));
      } else {
        parts.push(`// --- Stub: ${depId} (not in manifest) ---`);
      }
    }
  }

  // 3. Interface-only stubs of dependents (what expects this node's contract)
  if (node.depended_on_by.length > 0) {
    parts.push('\n## Dependents (what expects this node\'s contract)');
    for (const depId of node.depended_on_by) {
      const depNode = serverState.currentManifest.nodes.find(n => n.id === depId);
      const isFull = fullDepIds.includes(depId) || scoped === false;
      const depPath = join(serverState.currentProjectPath, depId);
      if (isFull && existsSync(depPath)) {
        parts.push(`// --- Full Source: ${depId} ---\n\`\`\`\n${readFileSync(depPath, 'utf-8')}\n\`\`\``);
      } else if (depNode) {
        parts.push(buildStub(depNode, serverState.currentProjectPath));
      }
    }
  }

  // 4. Conventions
  parts.push(`\n${CONVENTIONS_SNIPPET}`);

  const context = parts.join('\n\n');
  const chars = context.length;
  const tokens = Math.round(chars / 4);

  res.json({
    nodeId,
    context,
    chars,
    tokens,
    targetLines,
    isOversized: targetLines >= OVERSIZED_LINE_THRESHOLD
  });
});

/**
 * GET /file-outline
 * Query: projectPath, filePath
 * Return lightweight cached outline and line metrics.
 */
router.get('/file-outline', (req, res) => {
  try {
    const { projectPath, filePath } = req.query;
    const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
    if (!target || !filePath) {
      return res.status(400).json({ success: false, error: 'Missing projectPath or filePath' });
    }
    const outlineData = getCachedFileOutline(target, filePath);
    if (!outlineData) {
      return res.status(404).json({ success: false, error: `File not found: ${filePath}` });
    }
    res.json({
      success: true,
      filePath,
      outline: outlineData.outline,
      linesCount: outlineData.linesCount,
      isOversized: outlineData.linesCount >= OVERSIZED_LINE_THRESHOLD,
      threshold: OVERSIZED_LINE_THRESHOLD
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /rank-relevant-files
 * Automatically rank candidate files from project based on error stack and issue text.
 * Body: { projectPath, issueDescription, consoleLogs }
 */
router.post('/rank-relevant-files', (req, res) => {
  try {
    const { projectPath, issueDescription, consoleLogs } = req.body;
    const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
    if (!target) {
      return res.status(400).json({ error: 'Missing projectPath' });
    }
    const ranked = rankRelevantFiles({
      projectPath: target,
      issueDescription,
      consoleLogs,
      manifest: serverState.currentManifest
    });
    return res.json({ success: true, files: ranked });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /scoped-context
 * Assembles scoped context prompt for issue reporting or task handoffs.
 * Body: { projectPath, targetFile, issueDescription, attachedFiles, fileModes, consoleLogs, consoleMode }
 */
router.post('/scoped-context', (req, res) => {
  try {
    const {
      projectPath,
      targetFile,
      issueDescription,
      attachedFiles = [],
      fileModes = {},
      consoleLogs = '',
      consoleMode = 'red_only'
    } = req.body;
    const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
    if (!target) {
      return res.status(400).json({ error: 'No project currently loaded. Please extract or specify a project path.' });
    }

    let formattedConsole = '';
    if (typeof consoleLogs === 'string' && consoleLogs.trim()) {
      formattedConsole = consoleLogs.trim();
    } else if (Array.isArray(consoleLogs) && consoleLogs.length > 0) {
      formattedConsole = consoleLogs.map(l => (typeof l === 'object' && l.text ? l.text : String(l))).join('\n');
    }

    const filesToProcess = attachedFiles.length > 0 ? [...attachedFiles] : (targetFile ? [targetFile] : []);

    // Auto-detect target file from console if not specified
    let effectiveTarget = targetFile;
    if (!effectiveTarget && formattedConsole) {
      const match = formattedConsole.match(/(?:res:\/\/|[\s('"])([a-zA-Z0-9_./-]+\.(?:gd|js|ts|html|tscn|json))(?::(\d+))?/);
      if (match) {
        const candidate = match[1].replace(/^res:\/\//, '');
        const candidateAbs = resolveProjectPath(target, candidate);
        if (candidateAbs && existsSync(candidateAbs)) {
          effectiveTarget = candidate;
          if (!filesToProcess.includes(candidate)) {
            filesToProcess.unshift(candidate);
          }
        }
      }
    }

    const isGodot = serverState.currentManifest && (serverState.currentManifest.engine === 'godot' || (serverState.currentManifest.nodes && serverState.currentManifest.nodes.some(n => n.engine === 'godot')));
    const engineName = isGodot ? 'Godot 4.x (GDScript)' : 'HTML5, Vite, and Three.js';
    const gameName = serverState.currentManifest ? basename(serverState.currentManifest.project_root) : (target ? basename(target) : 'My Game');

    const scopedSections = [];
    const fullSections = [];
    const oversizedFiles = [];

    for (const f of filesToProcess) {
      const absPath = resolveProjectPath(target, f);
      if (!absPath) continue;
      if (!existsSync(absPath)) continue;

      const rawContent = readFileSync(absPath, 'utf-8');
      const linesCount = rawContent.split(/\r?\n/).length;
      if (linesCount >= OVERSIZED_LINE_THRESHOLD) {
        oversizedFiles.push({ file: f, linesCount });
      }

      const mode = fileModes[f] || 'scoped';
      const outlineData = getCachedFileOutline(target, f);
      const outlineText = outlineData ? outlineData.outline : '// (No outline available)';

      // Full representation for baseline comparison
      fullSections.push(`### FILE: ${f}\n\`\`\`\n${rawContent}\n\`\`\``);

      if (mode === 'full') {
        scopedSections.push(`### FILE: ${f} (Full Source)\n\`\`\`\n${rawContent}\n\`\`\``);
      } else {
        // Scoped mode
        if (f === effectiveTarget || f === targetFile) {
          const queryText = (issueDescription || '') + '\n' + (formattedConsole || '');
          const snippet = extractScopedSnippet(rawContent, queryText);
          let targetSection = `### FILE: ${f} (Scoped Context)\n// --- Symbol Outline ---\n${outlineText}`;
          if (snippet) {
            targetSection += `\n\n// --- Focused snippet around line ${snippet.targetLine} (lines ${snippet.startLine}–${snippet.endLine}) ---\n\`\`\`\n${snippet.snippet}\n\`\`\``;
          } else {
            targetSection += '\n\n// (No specific line or symbol detected in description. Toggle to Full File if whole implementation is needed.)';
          }
          scopedSections.push(targetSection);
        } else {
          // Dependency file: outline only
          scopedSections.push(`### FILE: ${f} (Outline / Interface Only)\n\`\`\`\n${outlineText}\n\`\`\``);
        }
      }
    }

    const buildPrompt = (sections) => `I am working on the game "${gameName}" using ${engineName}.

ISSUE DESCRIPTION / ERROR:
${issueDescription || '[Describe what is wrong or paste the error message above]'}${formattedConsole ? `\n\nCONSOLE OUTPUT / ERROR LOG:\n\`\`\`\n${formattedConsole}\n\`\`\`` : ''}

CURRENT FILE CONTEXT:
${sections.length > 0 ? sections.join('\n\n') : '(No files attached)'}

Please provide a surgical patch to fix this issue.

${getStrictPatchContract()}`;

    const scopedPrompt = buildPrompt(scopedSections);
    const fullPrompt = buildPrompt(fullSections);

    const chars = scopedPrompt.length;
    const tokens = Math.round(chars / 4);
    const fullChars = fullPrompt.length;
    const fullTokens = Math.round(fullChars / 4);
    const savingsPercent = fullChars > 0 ? Math.max(0, Math.round(((fullChars - chars) / fullChars) * 100)) : 0;

    res.json({
      success: true,
      prompt: scopedPrompt,
      chars,
      tokens,
      fullChars,
      fullTokens,
      savingsPercent,
      oversizedFiles
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
