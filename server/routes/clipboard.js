import { Router } from 'express';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { cleanAndResolvePath, resolveProjectPath } from '../paths.js';
import { serverState } from '../state.js';
import {
  scaffoldNewProject,
  parseProjectProgress,
  writeAiFilesToProject,
  parseAiFileBlocks,
  applyAiEditBlocks,
  parseAiEditBlocks,
  getProjectFileTree
} from '../project-init.js';
import { recordHistoryStep } from '../history-manager.js';
import { verifyFilesSyntax } from '../console-manager.js';

const router = Router();

/**
 * POST /init-project
 * Scaffold a new game project folder with engine boilerplate and AI-agent-loop docs (T050, T051).
 * Body: { targetFolder: "...", engine: "godot"|"js"|"mixed", projectName: "..." }
 */
router.post('/init-project', (req, res) => {
  try {
    const { targetFolder, engine, projectName } = req.body;
    const result = scaffoldNewProject({ targetFolder, engine, projectName });
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * GET /project-progress
 * Parse target project's TASKS.md checkbox states into phase progress stats (T052, T053).
 * Query: ?projectPath=...
 */
router.get('/project-progress', (req, res) => {
  const projectPath = req.query.projectPath || serverState.currentProjectPath;
  if (!projectPath) {
    return res.status(400).json({ error: 'Missing projectPath query param' });
  }

  const result = parseProjectProgress(projectPath);
  return res.json(result);
});

/**
 * POST /add-from-clipboard
 * Parse browser AI response containing either ### FILE: blocks or ### EDIT: blocks.
 * Auto-detects paste format:
 * - Contains "### EDIT:" -> applyAiEditBlocks (surgical patch)
 * - Contains "### FILE:" -> writeAiFilesToProject (full files)
 * Body: { projectPath: "...", content: "..." }
 */
router.post('/add-from-clipboard', (req, res) => {
  try {
    const { projectPath, content } = req.body;
    const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
    if (!target) {
      return res.status(400).json({ error: 'No project currently loaded. Please extract or specify a project path.' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing clipboard content' });
    }

    if (content.toUpperCase().includes('CONTEXT INSUFFICIENT')) {
      const rawMatches = [...content.matchAll(/(?:`|'|"|\b)([a-zA-Z0-9_./-]+\.(?:js|ts|jsx|tsx|gd|html|css|json|tscn|md|py|vue|svelte))\b/g)].map(m => m[1]);
      const allProjectFiles = getProjectFileTree(target);
      const resolvedFiles = new Set();

      for (const raw of rawMatches) {
        if (raw.startsWith('this.') || raw.startsWith('window.') || raw.startsWith('console.')) continue;
        const abs = resolveProjectPath(target, raw);
        if (abs && existsSync(abs)) {
          resolvedFiles.add(raw.replace(/\\/g, '/').replace(/^\/+/, ''));
        } else {
          const base = raw.split('/').pop().toLowerCase();
          const found = allProjectFiles.find(p => p.split('/').pop().toLowerCase() === base);
          if (found) {
            resolvedFiles.add(found);
          }
        }
      }

      return res.status(200).json({
        success: false,
        isContextInsufficient: true,
        requestedFiles: Array.from(resolvedFiles),
        message: content.trim()
      });
    }

    const editBlocks = parseAiEditBlocks(content);
    if (editBlocks.length > 0) {
      const filesToModify = [...new Set(editBlocks.map(e => e.path.replace(/\\/g, '/').replace(/^\/+/, '')))];
      const beforeSnapshot = filesToModify.map(rel => {
        const abs = join(target, rel);
        const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
        return { path: rel, before };
      });

      const result = applyAiEditBlocks(target, content);

      const filesSnapshot = beforeSnapshot.map(item => {
        const abs = join(target, item.path);
        const after = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
        return { path: item.path, before: item.before, after };
      });

      const tx = recordHistoryStep(target, `Applied surgical patch (${filesToModify.join(', ')})`, filesSnapshot, { type: 'edit' });
      const verification = verifyFilesSyntax(target, filesToModify);

      return res.json({
        ...result,
        patchId: tx ? tx.patchId : null,
        canUndo: true,
        verified: true,
        syntaxValid: verification.valid,
        syntaxError: verification.error ? { file: verification.file, message: verification.error } : null
      });
    }

    const fileBlocks = parseAiFileBlocks(content);
    if (fileBlocks.length > 0) {
      const filesToModify = [...new Set(fileBlocks.map(f => f.path.replace(/\\/g, '/').replace(/^\/+/, '')))];
      const beforeSnapshot = filesToModify.map(rel => {
        const abs = join(target, rel);
        const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
        return { path: rel, before };
      });

      const result = writeAiFilesToProject(target, content);

      const filesSnapshot = beforeSnapshot.map(item => {
        const abs = join(target, item.path);
        const after = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
        return { path: item.path, before: item.before, after };
      });

      const tx = recordHistoryStep(target, `Pasted ${fileBlocks.length} file${fileBlocks.length > 1 ? 's' : ''} from clipboard`, filesSnapshot, { type: 'file' });
      return res.json({ ...result, type: 'file', patchId: tx ? tx.patchId : null, canUndo: true });
    } else {
      return res.status(400).json({
        error: "Zero blocks found matching '### FILE:' or '### EDIT:' formats.\n\n" +
          "Expected formats:\n\n" +
          "1) Full File (Create/Overwrite):\n" +
          "### FILE: relative/path/to/file.ext\n" +
          "```\n" +
          "<complete file contents>\n" +
          "```\n\n" +
          "2) Surgical Edit (Patch):\n" +
          "### EDIT: relative/path/to/file.ext\n" +
          "<<<<<<< FIND\n" +
          "<exact original code snippet>\n" +
          "=======\n" +
          "<replacement code>\n" +
          ">>>>>>> REPLACE"
      });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
