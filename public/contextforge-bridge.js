/**
 * ContextForge Browser Diagnostics Bridge
 * Intercepts runtime errors, unhandled promise rejections, and console.error calls in HTML games,
 * forwarding them to ContextForge's Terminal drawer and Console Manager like Godot.
 */
(function() {
  if (window.__CF_BRIDGE_INITIALIZED__) return;
  window.__CF_BRIDGE_INITIALIZED__ = true;

  let scriptTag = document.currentScript;
  if (!scriptTag) {
    scriptTag = document.querySelector('script[src*="contextforge-bridge"]');
  }
  const projectPath = (scriptTag && scriptTag.getAttribute('data-project')) || window.__CF_PROJECT_PATH__ || '';
  const serverOrigin = (scriptTag && scriptTag.getAttribute('data-server')) || (window.location.origin.includes(':3000') ? window.location.origin : 'http://localhost:3000');

  const recentErrors = new Map();

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
        .filter(l => !l.includes('contextforge-bridge.js') && !l.includes('formatError'))
        .slice(1, 8)
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

  function sendLogThrottled(payload) {
    const key = `${payload.level || 'info'}:${payload.rawMessage || payload.message}:${payload.source || ''}:${payload.lineno || ''}`;
    const now = Date.now();
    const existing = recentErrors.get(key);

    if (existing && (now - existing.firstTime < 1500)) {
      existing.count++;
      if (!existing.timer) {
        existing.timer = setTimeout(() => {
          if (existing.count > 1) {
            sendLog({
              ...payload,
              message: `[Repeated ${existing.count} times] ${payload.message}`
            });
          }
          recentErrors.delete(key);
        }, 1500);
      }
      return;
    }

    recentErrors.set(key, { firstTime: now, count: 1, timer: null });
    sendLog(payload);
  }

  // Intercept window uncaught errors (TypeError, ReferenceError, SyntaxError, etc.)
  window.addEventListener('error', function(event) {
    const message = event.message || (event.error ? event.error.message : 'Unknown error');
    const stack = event.error ? event.error.stack : '';
    const formatted = formatError('error', message, stack, event.filename, event.lineno, event.colno);
    sendLogThrottled({
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
    sendLogThrottled({
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
    const errObj = args.find(a => a instanceof Error);
    const message = args.map(a => typeof a === 'object' ? (a instanceof Error ? a.message : JSON.stringify(a)) : String(a)).join(' ');
    const stack = errObj ? errObj.stack : (new Error()).stack;
    const formatted = formatError('error', message, stack);
    sendLogThrottled({
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
    sendLogThrottled({
      projectPath,
      level: 'warn',
      message: `CONSOLE WARN: ${message}`,
      rawMessage: message
    });
  };

  console.log('[ContextForge Bridge] Active — browser errors will route to ContextForge Terminal');
})();
