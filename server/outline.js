import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

/**
 * In-memory outline cache per absolute file path.
 * Map<string, { mtimeMs: number, size: number, outline: string, linesCount: number }>
 */
const outlineCache = new Map();

/**
 * Generate lightweight outline for JS/TS source code:
 * extracts function/class/const/let/var/export signature lines without function bodies.
 */
export function generateJsOutline(content) {
  const lines = content.split(/\r?\n/);
  const outlineLines = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Skip empty lines, comments, and closing braces
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    // Only match top-level declarations or exported members (avoid local variables in function bodies)
    const isTopLevel = !rawLine.startsWith(' ') && !rawLine.startsWith('\t');
    const isExport = trimmed.startsWith('export ');
    if (!isTopLevel && !isExport) {
      continue;
    }

    const isFunction = /^(export\s+)?(async\s+)?function(\s*\*|\s+[\w$]+)?\s*\(/.test(trimmed);
    const isClass = /^(export\s+)?class\s+[\w$]+/.test(trimmed);
    const isConstLetVar = /^(export\s+)?(const|let|var)\s+[\w$]+/.test(trimmed);
    const isArrowFunc = /^(export\s+)?(const|let|var)\s+[\w$]+\s*=\s*(async\s*)?\([^)]*\)\s*=>/.test(trimmed);

    if (isFunction || isClass || isArrowFunc || (isExport && isConstLetVar)) {
      // Clean signature line: remove trailing opening brace, trailing semicolon, or implementation
      let sig = trimmed;
      const braceIdx = sig.indexOf('{');
      if (braceIdx !== -1) {
        sig = sig.slice(0, braceIdx).trim();
      }
      if (sig.endsWith(';')) {
        sig = sig.slice(0, -1).trim();
      }
      if (sig) {
        outlineLines.push(sig);
      }
    } else if (isConstLetVar && !trimmed.includes('{') && !trimmed.includes('[')) {
      // Simple scalar / configuration declarations (e.g. const MAX_SPEED = 100)
      let sig = trimmed;
      if (sig.length > 70) {
        const eqIdx = sig.indexOf('=');
        if (eqIdx !== -1) {
          sig = sig.slice(0, eqIdx).trim() + ' = ...';
        }
      }
      outlineLines.push(sig);
    }
  }

  return outlineLines.length > 0
    ? outlineLines.join('\n')
    : '// (No top-level functions or exports detected)';
}

/**
 * Generate lightweight outline for HTML:
 * extracts structural tags with id/class and script/link resources.
 */
export function generateHtmlOutline(content) {
  const lines = content.split(/\r?\n/);
  const outlineLines = [];
  const tagRegex = /<([a-zA-Z0-9\-]+)([^>]*)>/g;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let match;
    while ((match = tagRegex.exec(rawLine)) !== null) {
      const tagName = match[1].toLowerCase();
      const attrs = match[2];

      // We care about scripts, links, canvas, dialogs, headers, and any element with an id or class
      const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
      const classMatch = attrs.match(/\bclass=["']([^"']+)["']/i);
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
      const relMatch = attrs.match(/\brel=["']([^"']+)["']/i);
      const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);

      if (idMatch || classMatch || tagName === 'script' || tagName === 'canvas' || tagName === 'title' || (tagName === 'link' && relMatch)) {
        let desc = `<${tagName}`;
        if (relMatch) desc += ` rel="${relMatch[1]}"`;
        if (hrefMatch) desc += ` href="${hrefMatch[1]}"`;
        if (srcMatch) desc += ` src="${srcMatch[1]}"`;
        if (idMatch) desc += ` id="${idMatch[1]}"`;
        if (classMatch) desc += ` class="${classMatch[1]}"`;
        desc += '>';
        outlineLines.push(desc);
      }
    }
  }

  return outlineLines.length > 0
    ? outlineLines.join('\n')
    : '// (No tagged HTML elements or scripts detected)';
}

/**
 * Generate lightweight outline for GDScript (.gd):
 * extracts class_name, extends, @export vars, signals, and public funcs.
 */
export function generateGdScriptOutline(content) {
  const lines = content.split(/\r?\n/);
  const outlineLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('class_name ') ||
        trimmed.startsWith('extends ') ||
        trimmed.startsWith('@export ') ||
        trimmed.startsWith('export ') ||
        trimmed.startsWith('signal ') ||
        (trimmed.startsWith('func ') && !trimmed.startsWith('func _'))) {
      let sig = trimmed;
      if (sig.endsWith(':')) sig = sig.slice(0, -1).trim();
      outlineLines.push(sig);
    }
  }

  return outlineLines.length > 0
    ? outlineLines.join('\n')
    : '// (No GDScript declarations detected)';
}

/**
 * Master outline generator given a file path and content.
 */
export function generateFileOutline(filePath, content) {
  const ext = extname(filePath).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
    return generateJsOutline(content);
  }
  if (['.html', '.htm'].includes(ext)) {
    return generateHtmlOutline(content);
  }
  if (['.gd'].includes(ext)) {
    return generateGdScriptOutline(content);
  }
  // Fallback for scenes/other files: return first non-empty lines summary
  const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith(';'));
  return lines.slice(0, 15).join('\n') + (lines.length > 15 ? '\n// ...' : '');
}

/**
 * Get or regenerate cached outline for a file on disk.
 * Cache validates against file mtime and size.
 */
export function getCachedFileOutline(projectPath, relativePath) {
  const absPath = resolve(projectPath, relativePath);
  if (!existsSync(absPath)) {
    return null;
  }

  const stat = statSync(absPath);
  const cached = outlineCache.get(absPath);

  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  const content = readFileSync(absPath, 'utf-8');
  const linesCount = content.split(/\r?\n/).length;
  const outline = generateFileOutline(relativePath, content);

  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    linesCount,
    outline
  };

  outlineCache.set(absPath, entry);
  return entry;
}

/**
 * Clear the outline cache (useful during tests or full reloads).
 */
export function clearOutlineCache() {
  outlineCache.clear();
}

/**
 * Locate a specific line number or symbol in file content and extract
 * a focused surrounding snippet.
 */
export function extractScopedSnippet(content, queryOrText, filePath = '') {
  if (!content || !queryOrText) return null;
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return null;

  let targetLine = -1;
  if (typeof queryOrText === 'number' && queryOrText >= 1 && queryOrText <= lines.length) {
    targetLine = Math.floor(queryOrText);
  }

  // 1. Check for file-specific line number: "scene-manager.js:1212" or "scene-manager.js line 1212"
  if (filePath) {
    const baseName = filePath.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fileSpecificMatch = String(queryOrText).match(new RegExp(`(?:${baseName}|${filePath})[:\\s]+(?:line\\s+)?(\\d+)`, 'i'));
    if (fileSpecificMatch) {
      const num = parseInt(fileSpecificMatch[1], 10);
      if (num >= 1 && num <= lines.length) {
        targetLine = num;
      }
    }
  }

  // 2. Check for explicit line number with colon or 'line': "line 42", ":42:15", ":42"
  if (targetLine === -1) {
    const lineMatch = String(queryOrText).match(/(?:line\s+(\d+)|:(\d+):\d+|:(\d+)\b)/i);
    if (lineMatch) {
      const num = parseInt(lineMatch[1] || lineMatch[2] || lineMatch[3], 10);
      if (num >= 1 && num <= lines.length) {
        targetLine = num;
      }
    }
  }

  // 3. Fallback to short query line match (e.g. for unit test '42' or 'line 42')
  if (targetLine === -1) {
    const shortLineMatch = String(queryOrText).match(/\b(?:line\s*|:)?(\d+)\b/i);
    if (shortLineMatch && String(queryOrText).trim().length <= 35) {
      const num = parseInt(shortLineMatch[1], 10);
      if (num >= 1 && num <= lines.length) {
        targetLine = num;
      }
    }
  }

  // 4. If no valid line number, search for function/identifier name
  let matchedSymbol = null;
  if (targetLine === -1) {
    const skipWords = new Set([
      'error', 'uncaught', 'typeerror', 'referenceerror', 'syntaxerror',
      'failed', 'cannot', 'read', 'properties', 'undefined', 'null',
      'function', 'class', 'file', 'line', 'const', 'let', 'var',
      'in', 'at', 'on', 'to', 'of', 'for', 'the', 'is', 'with', 'from', 'around', 'and', 'or', 'not'
    ]);
    const words = (String(queryOrText).match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [])
      .filter(w => w.length > 2 && !skipWords.has(w.toLowerCase()));

    // Try matching declaration lines first: function/class/export/var/func
    for (const word of words) {
      const declRegex = new RegExp(`\\b(function|class|const|let|var|func)\\s+${word}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (declRegex.test(lines[i])) {
          targetLine = i + 1;
          matchedSymbol = word;
          break;
        }
      }
      if (targetLine !== -1) break;
    }

    // Fallback: match whole word identifier anywhere in code
    if (targetLine === -1) {
      for (const word of words) {
        const wordRegex = new RegExp(`\\b${word}\\b`);
        for (let i = 0; i < lines.length; i++) {
          if (wordRegex.test(lines[i])) {
            targetLine = i + 1;
            matchedSymbol = word;
            break;
          }
        }
        if (targetLine !== -1) break;
      }
    }
  }

  if (targetLine === -1) {
    return null;
  }

  // Extract window around target line (±15 lines)
  const startLine = Math.max(1, targetLine - 15);
  const endLine = Math.min(lines.length, targetLine + 15);

  const snippetLines = [];
  const rawSliceLines = [];

  // If target line is deep in the file (> 60), also include the class/module header & constructor (first 35 lines)
  let headerSnippet = '';
  if (targetLine > 60) {
    const headerEnd = Math.min(35, startLine - 1);
    if (headerEnd > 5) {
      const headerLines = [];
      for (let i = 1; i <= headerEnd; i++) {
        headerLines.push(`   ${String(i).padStart(4, ' ')} | ${lines[i - 1]}`);
      }
      headerSnippet = `// --- File Header & Constructor (lines 1–${headerEnd}) ---\n${headerLines.join('\n')}\n// ... [skipped lines ${headerEnd + 1}–${startLine - 1}] ...\n\n`;
    }
  }

  for (let i = startLine; i <= endLine; i++) {
    const prefix = i === targetLine ? ' > ' : '   ';
    snippetLines.push(`${prefix}${String(i).padStart(4, ' ')} | ${lines[i - 1]}`);
    rawSliceLines.push(lines[i - 1]);
  }

  return {
    targetLine,
    startLine,
    endLine,
    matchedSymbol,
    snippet: headerSnippet + snippetLines.join('\n'),
    verbatimSlice: rawSliceLines.join('\n')
  };
}

/**
 * Threshold for identifying oversized files.
 */
export const OVERSIZED_LINE_THRESHOLD = 800;

export function checkOversizedFile(content, threshold = OVERSIZED_LINE_THRESHOLD) {
  const linesCount = (content || '').split(/\r?\n/).length;
  return {
    isOversized: linesCount >= threshold,
    linesCount,
    threshold
  };
}
