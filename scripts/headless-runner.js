#!/usr/bin/env node
/**
 * scripts/headless-runner.js
 *
 * Lightweight CLI & programmatic driver for ContextForge.
 * Enables automated test runners, subagents, and scripts to execute the full
 * project loop headlessly:
 *   init-project -> extract -> rank-files -> scoped-context -> apply-patch -> verify -> undo
 *
 * Usage from CLI:
 *   node scripts/headless-runner.js --help
 *   node scripts/headless-runner.js extract --project /path/to/project
 *   node scripts/headless-runner.js run-loop --project /path/to/project --issue "Description"
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_SERVER = process.env.CONTEXTFORGE_URL || 'http://localhost:3000';

/**
 * Make an HTTP request to the ContextForge server.
 */
export async function apiRequest(endpoint, method = 'GET', body = null, baseUrl = DEFAULT_SERVER) {
  const url = new URL(endpoint, baseUrl);
  const isPost = method === 'POST';

  return new Promise((resolve, reject) => {
    const postData = isPost && body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {
          json = { raw: data };
        }

        if (res.statusCode >= 400 && !json.isContextInsufficient && !json.preCheckFailed) {
          const err = new Error(json.error || `HTTP ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          err.response = json;
          return reject(err);
        }
        resolve({ statusCode: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Headless Driver Client
 */
export class HeadlessClient {
  constructor(baseUrl = DEFAULT_SERVER) {
    this.baseUrl = baseUrl;
  }

  async initProject(targetFolder, engine, projectName) {
    const res = await apiRequest('/init-project', 'POST', { targetFolder, engine, projectName }, this.baseUrl);
    return res.data;
  }

  async extract(projectPath) {
    const res = await apiRequest('/extract', 'POST', { projectPath }, this.baseUrl);
    return res.data;
  }

  async getManifest() {
    const res = await apiRequest('/manifest', 'GET', null, this.baseUrl);
    return res.data;
  }

  async getFileTree(projectPath) {
    const res = await apiRequest(`/file-tree?projectPath=${encodeURIComponent(projectPath)}`, 'GET', null, this.baseUrl);
    return res.data;
  }

  async getFileContent(projectPath, filePath) {
    const res = await apiRequest(`/file-content?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`, 'GET', null, this.baseUrl);
    return res.data;
  }

  async saveFile(projectPath, filePath, content) {
    const res = await apiRequest('/save-file', 'POST', { projectPath, filePath, content }, this.baseUrl);
    return res.data;
  }

  async rankRelevantFiles(projectPath, issueDescription, consoleLogs = '') {
    const res = await apiRequest('/rank-relevant-files', 'POST', { projectPath, issueDescription, consoleLogs }, this.baseUrl);
    return res.data;
  }

  async getScopedContext(opts) {
    const res = await apiRequest('/scoped-context', 'POST', opts, this.baseUrl);
    return res.data;
  }

  async previewDiff(projectPath, patchContent) {
    const res = await apiRequest('/preview-diff', 'POST', { projectPath, content: patchContent }, this.baseUrl);
    return res.data;
  }

  async applyPatch(projectPath, patchContent, opts = {}) {
    const res = await apiRequest('/add-from-clipboard', 'POST', {
      projectPath,
      content: patchContent,
      preCheckSyntax: opts.preCheckSyntax !== false,
      applyAnyway: opts.applyAnyway === true
    }, this.baseUrl);
    return res.data;
  }

  async undo(projectPath) {
    const res = await apiRequest('/history/undo', 'POST', { projectPath }, this.baseUrl);
    return res.data;
  }

  async getConsoleLogs(projectPath, forceCheck = false, clear = false) {
    const res = await apiRequest(`/console-logs?projectPath=${encodeURIComponent(projectPath)}&check=${forceCheck}&clear=${clear}`, 'GET', null, this.baseUrl);
    return res.data;
  }

  async compareVerification(projectPath, prePatchErrors, postPatchErrors) {
    const res = await apiRequest('/compare-verification', 'POST', { projectPath, prePatchErrors, postPatchErrors }, this.baseUrl);
    return res.data;
  }

  async lock(nodeId, holder) {
    const res = await apiRequest('/lock', 'POST', { nodeId, holder }, this.baseUrl);
    return res.data;
  }

  async unlock(nodeId, holder, force = false) {
    const res = await apiRequest('/unlock', 'POST', { nodeId, holder, force }, this.baseUrl);
    return res.data;
  }

  /**
   * Run the complete loop headlessly:
   * extract -> rank relevant files -> compile handoff prompt.
   */
  async runInvestigation(projectPath, issueDescription, consoleLogs = '') {
    const manifest = await this.extract(projectPath);
    const ranking = await this.rankRelevantFiles(projectPath, issueDescription, consoleLogs);
    const topFiles = (ranking.files || []).filter(f => f.score >= 70).map(f => f.file);
    const targetFile = topFiles.length > 0 ? topFiles[0] : (manifest.nodes[0] ? manifest.nodes[0].id : '');

    const handoff = await this.getScopedContext({
      projectPath,
      targetFile,
      issueDescription,
      attachedFiles: topFiles,
      consoleLogs
    });

    return {
      manifest,
      ranking: ranking.files || [],
      targetFile,
      handoff
    };
  }
}

// CLI entrypoint if executed directly
if (process.argv[1] && process.argv[1].endsWith('headless-runner.js')) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const client = new HeadlessClient(process.env.CONTEXTFORGE_URL || 'http://localhost:3000');

  (async () => {
    try {
      if (!cmd || cmd === '--help' || cmd === '-h') {
        console.log(`ContextForge Headless Runner CLI
Commands:
  extract       --project <path>
  investigate   --project <path> --issue "<text>" [--logs "<logs>"]
  apply         --project <path> --patch "<text or file>"
  undo          --project <path>
  test-ping     Verify server connectivity
`);
        process.exit(0);
      }

      if (cmd === 'test-ping') {
        const res = await apiRequest('/manifest', 'GET', null, client.baseUrl);
        console.log('ContextForge server is reachable. Status:', res.statusCode);
        process.exit(0);
      }

      const project = getArg('--project');
      if (!project && cmd !== 'test-ping') {
        console.error('Error: Missing --project <path>');
        process.exit(1);
      }

      if (cmd === 'extract') {
        const manifest = await client.extract(project);
        console.log(`Extracted manifest successfully: ${manifest.nodes.length} nodes, ${manifest.edges.length} edges.`);
      } else if (cmd === 'investigate') {
        const issue = getArg('--issue') || 'Diagnostic check';
        const logs = getArg('--logs') || '';
        const res = await client.runInvestigation(project, issue, logs);
        console.log(`Investigation complete. Target file: ${res.targetFile}`);
        console.log(`Compiled Prompt (${res.handoff.tokens} tokens, ${res.handoff.savingsPercent}% savings):`);
        console.log('----------------------------------------------------');
        console.log(res.handoff.prompt.slice(0, 300) + '...\n[truncated]');
      } else if (cmd === 'apply') {
        const patchArg = getArg('--patch');
        if (!patchArg) {
          console.error('Error: Missing --patch "<content or filePath>"');
          process.exit(1);
        }
        let patchContent = patchArg;
        if (existsSync(patchArg)) {
          patchContent = readFileSync(patchArg, 'utf-8');
        }
        const force = args.includes('--force') || args.includes('--apply-anyway');
        const res = await client.applyPatch(project, patchContent, { applyAnyway: force });
        console.log('Patch apply result:', res);
      } else if (cmd === 'undo') {
        const res = await client.undo(project);
        console.log('Undo result:', res);
      } else {
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
      }
    } catch (err) {
      console.error('Headless runner error:', err.message);
      process.exit(1);
    }
  })();
}
