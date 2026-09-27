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
  findTargetMatch,
  getProjectFileTree
} from '../project-init.js';
import { recordHistoryStep } from '../history-manager.js';
import { verifyFilesSyntax, validateContentSyntax } from '../console-manager.js';
import { generateUnifiedDiff } from '../diff-generator.js';

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
 * POST /preview-diff
 * Computes an in-memory diff between disk files and the pasted patch without modifying disk (T080).
 * Body: { projectPath: "...", content: "..." }
 */
router.post('/preview-diff', (req, res) => {
  try {
    const { projectPath, content } = req.body;
    const target = cleanAndResolvePath(projectPath || serverState.currentProjectPath);
    if (!target) {
      return res.status(400).json({ error: 'No project currently loaded. Please extract or specify a project path.' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing clipboard content' });
    }

    const editBlocks = parseAiEditBlocks(content);
    const fileBlocks = parseAiFileBlocks(content);

    if (editBlocks.length === 0 && fileBlocks.length === 0) {
      return res.status(400).json({
        error: "Zero blocks found matching '### FILE:' or '### EDIT:' formats to preview."
      });
    }

    const diffResults = [];
    const unmatched = [];

    if (editBlocks.length > 0) {
      const editsByFile = new Map();
      for (const edit of editBlocks) {
        const norm = edit.path.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!editsByFile.has(norm)) editsByFile.set(norm, []);
        editsByFile.get(norm).push(edit);
      }

      for (const [relPath, fileEdits] of editsByFile.entries()) {
        const absPath = join(target, relPath);
        const originalContent = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
        let simulatedContent = originalContent.replace(/\r\n/g, '\n');

        for (let i = 0; i < fileEdits.length; i++) {
          const edit = fileEdits[i];
          const matchResult = findTargetMatch(simulatedContent, edit.find);
          if (matchResult.success && matchResult.target) {
            simulatedContent = simulatedContent.replace(matchResult.target, edit.replace.replace(/\r\n/g, '\n'));
          } else {
            unmatched.push({
              file: relPath,
              index: i + 1,
              find: edit.find,
              reason: matchResult.reason || 'could not find exact FIND text'
            });
          }
        }

        const chunks = generateUnifiedDiff(originalContent, simulatedContent);
        const additions = chunks.filter(c => c.type === 'add').length;
        const deletions = chunks.filter(c => c.type === 'delete').length;

        diffResults.push({
          file: relPath,
          exists: existsSync(absPath),
          isNewFile: !existsSync(absPath),
          type: 'edit',
          additions,
          deletions,
          chunks
        });
      }
    }

    if (fileBlocks.length > 0) {
      for (const fb of fileBlocks) {
        const relPath = fb.path.replace(/\\/g, '/').replace(/^\/+/, '');
        const absPath = join(target, relPath);
        const originalContent = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
        const newContent = fb.content.replace(/\r\n/g, '\n');

        const chunks = generateUnifiedDiff(originalContent, newContent);
        const additions = chunks.filter(c => c.type === 'add').length;
        const deletions = chunks.filter(c => c.type === 'delete').length;

        diffResults.push({
          file: relPath,
          exists: existsSync(absPath),
          isNewFile: !existsSync(absPath),
          type: 'file',
          additions,
          deletions,
          chunks
        });
      }
    }

    const previewType = (editBlocks.length > 0 && fileBlocks.length > 0)
      ? 'mixed'
      : (editBlocks.length > 0 ? 'edit' : 'file');

    return res.json({
      success: true,
      type: previewType,
      files: diffResults,
      editsCount: editBlocks.length,
      filesCount: fileBlocks.length,
      unmatched
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /add-from-clipboard
 * Parse browser AI response containing either ### FILE: blocks, ### EDIT: blocks, or both.
 * Auto-detects paste format:
 * - Contains "### EDIT:" -> applyAiEditBlocks (surgical patch)
 * - Contains "### FILE:" -> writeAiFilesToProject (full files)
 * - Contains BOTH -> mixed multi-file apply without dropping either format
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

    const options = {
      applyAnyway: req.body.applyAnyway === true || req.body.force === true,
      preCheckSyntax: req.body.preCheckSyntax !== false
    };

    const editBlocks = parseAiEditBlocks(content);
    const fileBlocks = parseAiFileBlocks(content);

    if (editBlocks.length === 0 && fileBlocks.length === 0) {
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

      return res.status(400).json({
        error: "Zero blocks found matching '### FILE:' or '### EDIT:' formats.\n\n" +
          "Expected formats:\n" +
          "1) Surgical Patch (preferred for existing files):\n" +
          "### EDIT: relative/path/to/file.ext\n" +
          "<<<<<<< FIND\n<exact original code snippet>\n=======\n<replacement code>\n>>>>>>> REPLACE\n\n" +
          "2) Full File (for new files):\n" +
          "### FILE: relative/path/to/file.ext\n```\n<full file contents>\n```"
      });
    }

    const editFiles = [...new Set(editBlocks.map(e => e.path.replace(/\\/g, '/').replace(/^\/+/, '')))];
    const filePaths = [...new Set(fileBlocks.map(f => f.path.replace(/\\/g, '/').replace(/^\/+/, '')))];
    const allFilesToModify = [...new Set([...editFiles, ...filePaths])];

    for (const rel of allFilesToModify) {
      if (rel.includes('..')) {
        return res.status(400).json({ error: `Invalid file path with directory traversal: "${rel}"` });
      }
    }

    const beforeSnapshot = allFilesToModify.map(rel => {
      const abs = join(target, rel);
      const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
      return { path: rel, before };
    });

    // Pre-check file blocks syntax before disk modification
    if (fileBlocks.length > 0 && options.preCheckSyntax !== false && !options.applyAnyway) {
      for (const fb of fileBlocks) {
        const norm = fb.path.replace(/\\/g, '/').replace(/^\/+/, '');
        const syntaxRes = validateContentSyntax(norm, fb.content);
        if (!syntaxRes.valid) {
          return res.status(422).json({
            success: false,
            preCheckFailed: true,
            canApplyAnyway: true,
            files: [norm],
            syntaxError: {
              file: norm,
              message: syntaxRes.error,
              line: syntaxRes.line
            },
            error: `Pre-save syntax check failed for "${norm}": ${syntaxRes.error}. Broken code was NOT written to disk.`
          });
        }
      }
    }

    let editResult = null;
    if (editBlocks.length > 0) {
      editResult = applyAiEditBlocks(target, content, options);
      if (editResult.preCheckFailed) {
        return res.status(422).json(editResult);
      }
    }

    let fileResult = null;
    if (fileBlocks.length > 0) {
      fileResult = writeAiFilesToProject(target, content, options);
      if (fileResult.preCheckFailed) {
        return res.status(422).json(fileResult);
      }
    }

    const filesSnapshot = beforeSnapshot.map(item => {
      const abs = join(target, item.path);
      const after = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
      return { path: item.path, before: item.before, after };
    });

    const isMixed = editBlocks.length > 0 && fileBlocks.length > 0;
    const txType = isMixed ? 'mixed' : (editBlocks.length > 0 ? 'edit' : 'file');

    let desc = '';
    if (isMixed) {
      desc = `Applied patch (${editResult.count} edit(s), ${fileResult.count} file(s) across ${allFilesToModify.length} file(s))`;
    } else if (editBlocks.length > 0) {
      desc = `Applied surgical patch (${(editResult.files || []).join(', ')})`;
    } else {
      desc = `Pasted ${fileBlocks.length} file${fileBlocks.length > 1 ? 's' : ''} from clipboard`;
    }

    const tx = recordHistoryStep(target, desc, filesSnapshot, {
      type: txType,
      editsCount: editResult?.count || 0,
      filesCount: fileResult?.count || 0
    });

    const verification = verifyFilesSyntax(target, allFilesToModify);

    const allWrittenFiles = [...new Set([...(editResult?.files || []), ...(fileResult?.files || [])])];
    const totalOps = (editResult?.total || editBlocks.length) + (fileResult?.count || fileBlocks.length);
    const appliedCount = (editResult?.appliedCount ?? editResult?.count ?? 0) + (fileResult?.count || 0);
    const alreadyAppliedCount = editResult?.alreadyAppliedCount || 0;
    const editsCount = editResult?.count || 0;
    const filesCount = fileResult?.count || 0;

    let message = '';
    if (isMixed) {
      message = `✓ Successfully applied ${editsCount} edit(s) and wrote ${filesCount} file(s) across ${allWrittenFiles.length} file(s).`;
    } else if (editBlocks.length > 0) {
      message = editResult.message;
    } else {
      message = `✓ Successfully wrote ${filesCount} file(s).`;
    }

    return res.json({
      success: true,
      partial: Boolean(editResult?.partial),
      alreadyApplied: Boolean(editResult?.alreadyApplied && fileBlocks.length === 0),
      type: txType,
      count: appliedCount + alreadyAppliedCount,
      appliedCount,
      alreadyAppliedCount,
      total: totalOps,
      editsCount,
      filesCount,
      files: allWrittenFiles,
      appliedEdits: editResult?.appliedEdits || [],
      alreadyAppliedEdits: editResult?.alreadyAppliedEdits || [],
      failedBlocks: editResult?.failedBlocks || [],
      patchId: tx ? tx.patchId : null,
      canUndo: true,
      verified: true,
      syntaxValid: verification.valid,
      syntaxError: verification.error ? { file: verification.file, message: verification.error } : null,
      message
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
