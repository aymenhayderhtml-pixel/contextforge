/**
 * ContextForge Browser Diagnostics Bridge
 * Intercepts runtime errors, unhandled promise rejections, and console.error calls in HTML games,
 * forwarding them to ContextForge's Terminal drawer and Console Manager like Godot.
 */
(function() {
  if (window.__CF_BRIDGE_INITIALIZED__) return;
  window.__CF_BRIDGE_INITIALIZED__ = true;

  const scriptTag = document.currentScript;
  const projectPath = (scriptTag && scriptTag.getAttribute('data-project')) || window.__CF_PROJECT_PATH__ || '';
  const serverOrigin = (scriptTag && scriptTag.getAttribute('data-server')) || (window.location.origin.includes(':3000') ? window.location.origin : 'http://localhost:3000');

  function formatError(type, message, stack, filename, lineno, colno) {
    let cleanFile = filename ? filename.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\/+/, '') : '';
    let loc = cleanFile ? `${cleanFile}${lineno ? `:${lineno}` : ''}${colno ? `:${colno}` : ''}` : '';
    let header = type === 'error' ? 'SCRIPT ERROR' : 'CONSOLE WARN';
    let output = `${header}: ${message}`;
    if (loc) {
      output += `\n          at: (${loc})`;
    }
    if (stack) {
      const cleanStack = String(stack)
        .split('\n')
        .slice(1, 6)
        .map(l => '          ' + l.trim())
        .join('\n');
      if (cleanStack) output += `\n${cleanStack}`;
    }
    return output;
  }

  function sendLog(payload) {
    // 1. Post to opener or parent window if inside ContextForge tab or iframe
    try {
      const msg = { type: 'CF_CONSOLE_LOG', ...payload };
      if (window.opener && window.opener !== window) {
        window.opener.postMessage(msg, '*');
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
      }
    } catch (_) {}

    // 2. HTTP POST to ContextForge backend
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon && payload.isExit) {
        navigator.sendBeacon(`${serverOrigin}/client-log`, body);
      } else {
        fetch(`${serverOrigin}/client-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // Intercept window uncaught errors (TypeError, ReferenceError, SyntaxError, etc.)
  window.addEventListener('error', function(event) {
    const message = event.message || (event.error ? event.error.message : 'Unknown error');
    const stack = event.error ? event.error.stack : '';
    const formatted = formatError('error', message, stack, event.filename, event.lineno, event.colno);
    sendLog({
      projectPath,
      level: 'error',
      message: formatted,
      rawMessage: message,
      source: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack
    });
  });

  // Intercept unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason;
    const message = reason ? (reason.message || String(reason)) : 'Unhandled Promise Rejection';
    const stack = reason ? reason.stack : '';
    const formatted = formatError('error', 'Uncaught (in promise): ' + message, stack);
    sendLog({
      projectPath,
      level: 'error',
      message: formatted,
      rawMessage: message,
      stack
    });
  });

  // Intercept console.error
  const origError = console.error;
  console.error = function(...args) {
    origError.apply(console, args);
    const message = args.map(a => typeof a === 'object' ? (a instanceof Error ? a.stack : JSON.stringify(a)) : String(a)).join(' ');
    const stack = (new Error()).stack;
    const formatted = formatError('error', message, stack);
    sendLog({
      projectPath,
      level: 'error',
      message: formatted,
      rawMessage: message,
      stack
    });
  };

  // Intercept console.warn
  const origWarn = console.warn;
  console.warn = function(...args) {
    origWarn.apply(console, args);
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    sendLog({
      projectPath,
      level: 'warn',
      message: `CONSOLE WARN: ${message}`,
      rawMessage: message
    });
  };

  console.log('[ContextForge Bridge] Active — browser errors will route to ContextForge Terminal');
})();
