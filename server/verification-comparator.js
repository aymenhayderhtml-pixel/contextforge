/**
 * server/verification-comparator.js
 * Structured comparison engine for multi-turn debugging verification.
 *
 * Compares error state before and after patch application to determine:
 * - SAME_ERROR: The same error persisted
 * - ERROR_RESOLVED: Previous error cleared and no new errors found
 * - NEW_ERROR: A new error was introduced
 * - FEWER_ERRORS: Error count decreased
 * - MORE_ERRORS: Error count increased
 * - NO_RUNTIME_DATA: No previous runtime error data was provided
 */

/**
 * Normalizes error text into comparable signature fingerprints.
 * Strips volatile line numbers, timestamps, and column offsets.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractErrorFingerprints(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const fingerprints = [];

  for (const line of lines) {
    // Check if line looks like an error, warning, or exception
    const isErr = /error|uncaught|exception|failed|syntaxerror|typeerror|referenceerror|rangeerror/i.test(line);
    if (isErr) {
      // Normalize out file paths and line:col offsets for fuzzy comparison
      const normalized = line
        .replace(/\b(?:file:\/\/\/|\/|[A-Za-z]:[\\/])\S+\/([^/:\s]+):(\d+)(?::\d+)?/g, '$1:$2')
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '')
        .trim();
      fingerprints.push(normalized);
    }
  }

  // If no explicit error keyword lines, but text exists, return full trimmed text as single fingerprint
  if (fingerprints.length === 0 && lines.length > 0) {
    fingerprints.push(lines[0]);
  }

  return fingerprints;
}

/**
 * Compares two verification/error states.
 *
 * @param {object} params
 * @param {string} [params.previousError=''] The error string from before patch
 * @param {string} [params.currentError=''] The current error string or console log
 * @param {boolean} [params.syntaxValid=true] Whether syntax check passed
 * @param {object|null} [params.syntaxError=null] Syntax error details if syntaxValid=false
 * @returns {object} Comparison result
 */
export function compareVerification({
  previousError = '',
  currentError = '',
  syntaxValid = true,
  syntaxError = null
} = {}) {
  // If syntax check failed on disk
  if (!syntaxValid && syntaxError) {
    return {
      comparison: 'NEW_ERROR',
      message: `Syntax error introduced in ${syntaxError.file}: ${syntaxError.message}`,
      resolvedErrors: [],
      unresolvedErrors: [],
      introducedErrors: [syntaxError.message],
      errorCountDelta: 1
    };
  }

  const prevFp = extractErrorFingerprints(previousError);
  const currFp = extractErrorFingerprints(currentError);

  if (prevFp.length === 0 && currFp.length === 0) {
    return {
      comparison: 'NO_RUNTIME_DATA',
      message: 'No runtime errors found before or after patch application.',
      resolvedErrors: [],
      unresolvedErrors: [],
      introducedErrors: [],
      errorCountDelta: 0
    };
  }

  if (prevFp.length === 0 && currFp.length > 0) {
    return {
      comparison: 'NEW_ERROR',
      message: `New runtime error observed: ${currFp[0]}`,
      resolvedErrors: [],
      unresolvedErrors: [],
      introducedErrors: currFp,
      errorCountDelta: currFp.length
    };
  }

  if (prevFp.length > 0 && currFp.length === 0) {
    return {
      comparison: 'ERROR_RESOLVED',
      message: `Error resolved: ${prevFp[0]} (0 errors remaining).`,
      resolvedErrors: prevFp,
      unresolvedErrors: [],
      introducedErrors: [],
      errorCountDelta: -prevFp.length
    };
  }

  // Both have errors — check overlap
  const resolved = [];
  const unresolved = [];
  const introduced = [];

  for (const p of prevFp) {
    const stillPresent = currFp.some(c => c === p || c.includes(p) || p.includes(c));
    if (stillPresent) {
      unresolved.push(p);
    } else {
      resolved.push(p);
    }
  }

  for (const c of currFp) {
    const wasPresent = prevFp.some(p => p === c || p.includes(c) || c.includes(p));
    if (!wasPresent) {
      introduced.push(c);
    }
  }

  const delta = currFp.length - prevFp.length;

  if (introduced.length > 0 && unresolved.length === 0) {
    return {
      comparison: 'NEW_ERROR',
      message: `Original error cleared, but new error introduced: ${introduced[0]}`,
      resolvedErrors: resolved,
      unresolvedErrors: [],
      introducedErrors: introduced,
      errorCountDelta: delta
    };
  }

  if (introduced.length > 0 && unresolved.length > 0) {
    return {
      comparison: 'NEW_ERROR',
      message: `Original error still occurs, plus new error introduced: ${introduced[0]}`,
      resolvedErrors: resolved,
      unresolvedErrors: unresolved,
      introducedErrors: introduced,
      errorCountDelta: delta
    };
  }

  if (delta < 0) {
    return {
      comparison: 'FEWER_ERRORS',
      message: `Error count reduced from ${prevFp.length} to ${currFp.length}.`,
      resolvedErrors: resolved,
      unresolvedErrors: unresolved,
      introducedErrors: [],
      errorCountDelta: delta
    };
  }

  if (delta > 0) {
    return {
      comparison: 'MORE_ERRORS',
      message: `Error count increased from ${prevFp.length} to ${currFp.length}.`,
      resolvedErrors: resolved,
      unresolvedErrors: unresolved,
      introducedErrors: introduced,
      errorCountDelta: delta
    };
  }

  return {
    comparison: 'SAME_ERROR',
    message: `Same error persisted: ${unresolved[0] || currFp[0]}`,
    resolvedErrors: resolved,
    unresolvedErrors: unresolved,
    introducedErrors: [],
    errorCountDelta: 0
  };
}
