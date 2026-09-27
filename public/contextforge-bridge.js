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

  // ─────────────────────────── Live Preview Click / Raycast Selection (T128) ───────────────

  function sendBridgeMessage(payload) {
    try {
      if (window.opener && window.opener !== window) {
        window.opener.postMessage(payload, '*');
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch (_) {}
  }

  function raycastAndSelect(normalizedCoords, sourceEvent) {
    const game = window.__CONTEXTFORGE_GAME__;
    if (!game || !game.scene) {
      sendBridgeMessage({
        type: 'CF_PREVIEW_CLICK_MISSING_SCENE',
        projectPath,
        message: 'No exposed Three.js scene found on window.__CONTEXTFORGE_GAME__. Project may need convention instrumentation (T127).'
      });
      return null;
    }

    const scene = game.scene;
    const camera = game.camera;
    let intersects = [];

    // 1. Allow custom raycast override if game provides it
    if (typeof game.raycast === 'function') {
      intersects = game.raycast(normalizedCoords.x, normalizedCoords.y, sourceEvent) || [];
    } else {
      const THREE = game.THREE || window.THREE;
      if (THREE && THREE.Raycaster && camera) {
        const raycaster = new THREE.Raycaster();
        const coords = THREE.Vector2
          ? new THREE.Vector2(normalizedCoords.x, normalizedCoords.y)
          : { x: normalizedCoords.x, y: normalizedCoords.y };
        raycaster.setFromCamera(coords, camera);
        intersects = raycaster.intersectObjects(scene.children || [], true) || [];
      } else if (scene && typeof scene.raycast === 'function') {
        intersects = scene.raycast(normalizedCoords, camera) || [];
      }
    }

    if (!intersects || intersects.length === 0) {
      sendBridgeMessage({
        type: 'CF_PREVIEW_CLICK_MISSED',
        projectPath,
        coords: normalizedCoords
      });
      return null;
    }

    // 2. Identify the closest hit object
    const hit = intersects[0];
    const hitObject = hit.object || hit;

    // 3. Walk up parent chain to resolve manifest asset id
    let current = hitObject;
    let resolvedAssetId = null;
    let taggedRoot = null;

    while (current) {
      const uData = current.userData;
      const candidateId = (uData && (uData.cfAssetId || uData.assetId || uData.manifestAssetId)) || current._cfAssetId;
      if (candidateId) {
        resolvedAssetId = candidateId;
        taggedRoot = current;
        break;
      }
      current = current.parent;
    }

    if (resolvedAssetId) {
      const payload = {
        type: 'CF_ASSET_SELECTED',
        assetId: resolvedAssetId,
        objectName: (taggedRoot && taggedRoot.name) || hitObject.name || '',
        hitPoint: hit.point ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null,
        projectPath
      };

      sendBridgeMessage(payload);

      sendLog({
        projectPath,
        level: 'info',
        message: `[Live Preview] Click-to-select: ${resolvedAssetId} (object: "${payload.objectName}")`,
        rawMessage: `Asset selected: ${resolvedAssetId}`,
        assetId: resolvedAssetId
      });

      return payload;
    } else {
      sendBridgeMessage({
        type: 'CF_ASSET_UNTAGGED',
        projectPath,
        objectName: hitObject.name || 'unnamed',
        coords: normalizedCoords
      });
      return null;
    }
  }

  function handleCanvasClick(event) {
    const game = window.__CONTEXTFORGE_GAME__;
    const canvas = (game && game.renderer && game.renderer.domElement) ||
                   document.querySelector('canvas') ||
                   event.target;

    const rect = canvas && typeof canvas.getBoundingClientRect === 'function'
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth || 800, height: window.innerHeight || 600 };

    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) {
      return null;
    }

    const width = rect.width || 1;
    const height = rect.height || 1;
    const x = ((event.clientX - rect.left) / width) * 2 - 1;
    const y = -((event.clientY - rect.top) / height) * 2 + 1;

    return raycastAndSelect({ x, y }, event);
  }

  // Pointer drag vs click disambiguation (don't trigger selection on camera orbit/drag)
  let pointerDownPos = null;

  window.addEventListener('pointerdown', function(e) {
    pointerDownPos = { x: e.clientX, y: e.clientY, time: Date.now() };
  }, true);

  window.addEventListener('click', function(e) {
    if (pointerDownPos) {
      const dx = Math.abs(e.clientX - pointerDownPos.x);
      const dy = Math.abs(e.clientY - pointerDownPos.y);
      const dt = Date.now() - pointerDownPos.time;
      if (dx > 8 || dy > 8 || dt > 1000) {
        return;
      }
    }
    handleCanvasClick(e);
  }, true);

  // Expose bridge helper for inspection and tests
  window.__CONTEXTFORGE_BRIDGE__ = {
    raycastAndSelect,
    handleCanvasClick,
    sendBridgeMessage,
    sendLog
  };

  console.log('[ContextForge Bridge] Active — browser errors and click-to-select raycaster enabled');
})();
