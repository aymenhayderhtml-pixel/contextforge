/**
 * contextforge/runtime.js
 * In-game client runtime for ContextForge Modeling & Layout synchronization.
 *
 * Included by target games to bridge Three.js scene state with ContextForge editor.
 * Inactive unless URL contains ?cf=1.
 */

export function installContextForge(options = {}) {
  // Only activate when URL contains ?cf=1
  if (typeof window === 'undefined') return;
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('cf') !== '1') return;

  if (window.__CONTEXTFORGE_RUNTIME__) {
    return window.__CONTEXTFORGE_RUNTIME__;
  }

  const { THREE, scene, getCamera, renderer, GLTFLoader } = options;
  if (!scene) {
    console.warn('[ContextForge Runtime] installContextForge called without a valid scene object.');
    return;
  }

  // --------------------------------------------------------------------------
  // Object Identification
  // Rule: Full name path from scene root, joined with '/'.
  // Use userData.cfId first. Siblings with same name get #2, #3...
  // Unnamed objects use their child index.
  // --------------------------------------------------------------------------
  function getNodeSegment(node, parent) {
    if (!parent || !parent.children) {
      const n = node.name && typeof node.name === 'string' ? node.name.trim() : '';
      return n || '0';
    }
    const idx = parent.children.indexOf(node);
    const name = node.name && typeof node.name === 'string' ? node.name.trim() : '';
    if (!name) {
      return String(idx >= 0 ? idx : 0);
    }
    let sameNameCount = 0;
    for (let i = 0; i <= idx; i++) {
      const sib = parent.children[i];
      const sibName = sib.name && typeof sib.name === 'string' ? sib.name.trim() : '';
      if (sibName === name) {
        sameNameCount++;
      }
    }
    return sameNameCount > 1 ? `${name}#${sameNameCount}` : name;
  }

  function getObjectId(obj, root) {
    if (obj.userData && obj.userData.cfId) return obj.userData.cfId;
    if (!obj || obj === root) return obj?.name && obj.name.trim() !== '' ? obj.name.trim() : 'Scene';

    const segments = [];
    let curr = obj;
    while (curr && curr.parent && curr !== root) {
      const seg = getNodeSegment(curr, curr.parent);
      segments.unshift(seg);
      curr = curr.parent;
    }
    return segments.join('/');
  }

  function findObjectById(id, root) {
    if (!id || !root) return null;
    let match = null;
    root.traverse((node) => {
      if (match) return;
      if (node.userData?.cfId === id || node.name === id) {
        match = node;
      }
    });
    if (match) return match;

    // Segment traversal from scene root
    const segments = id.split('/');
    let curr = root;
    for (const seg of segments) {
      if (!curr || !curr.children) return null;
      let next = null;
      for (let i = 0; i < curr.children.length; i++) {
        const child = curr.children[i];
        if (child.userData?.cfId === seg || getNodeSegment(child, curr) === seg || child.name === seg) {
          next = child;
          break;
        }
      }
      if (!next) return null;
      curr = next;
    }
    return curr;
  }

  // --------------------------------------------------------------------------
  // Layout Application
  // Format: {version:1, objects:{[id]:{position:[x,y,z], rotation:[x,y,z], scale:[x,y,z], visible:bool, ...}}}
  // --------------------------------------------------------------------------
  let currentLayout = null;

  function applyLayout(layout) {
    if (!layout || !layout.objects) return;
    currentLayout = layout;

    for (const [id, data] of Object.entries(layout.objects)) {
      if (id.startsWith('path:')) continue;
      const obj = findObjectById(id, scene);
      if (!obj) continue;

      if (Array.isArray(data.position) && data.position.length >= 3) {
        obj.position.set(data.position[0], data.position[1], data.position[2]);
      }
      if (Array.isArray(data.rotation) && data.rotation.length >= 3) {
        obj.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
      }
      if (Array.isArray(data.scale) && data.scale.length >= 3) {
        obj.scale.set(data.scale[0], data.scale[1], data.scale[2]);
      }
      if (typeof data.visible === 'boolean') {
        obj.visible = data.visible;
      }
      obj.updateMatrixWorld?.(true);
    }
  }

  // Initial load of layout.json if available from server
  fetch('/contextforge/layout.json')
    .then((res) => {
      if (res.ok) return res.json();
      return null;
    })
    .then((layout) => {
      if (layout) {
        applyLayout(layout);
        // Rescan every 500 ms for 3 seconds to catch objects added asynchronously
        for (let i = 1; i <= 6; i++) {
          setTimeout(() => applyLayout(layout), i * 500);
        }
      }
    })
    .catch(() => {});

  // --------------------------------------------------------------------------
  // Renderer Settings
  // --------------------------------------------------------------------------
  function getRendererSettings() {
    if (!renderer) return {};
    const sm = renderer.shadowMap || {};
    return {
      outputColorSpace: renderer.outputColorSpace || (renderer.outputEncoding === 3001 ? 'srgb' : 'linear'),
      outputEncoding: renderer.outputEncoding || (renderer.outputColorSpace === 'srgb' ? 3001 : 3000),
      toneMapping: renderer.toneMapping,
      toneMappingExposure: renderer.toneMappingExposure,
      shadowMap: {
        enabled: Boolean(sm.enabled),
        type: typeof sm.type === 'number' ? sm.type : 2
      },
      environmentIntensity: scene?.environmentIntensity !== undefined
        ? scene.environmentIntensity
        : (scene?.environment && typeof scene.environment.intensity === 'number' ? scene.environment.intensity : undefined)
    };
  }

  // --------------------------------------------------------------------------
  // Scene Snapshot Serialization
  // --------------------------------------------------------------------------
  function serializeScene(root) {
    const stashedChildren = new Map();
    const modifiedGeoms = [];
    const textureMap = new Map();

    root.traverse((node) => {
      // Assign or verify cfId
      if (!node.userData) node.userData = {};
      node.userData.cfId = getObjectId(node, root);
      node.userData.cfDisplayName = node.userData.cfId.split('/').pop();
      node.userData.cfHasName = Boolean(node.name && typeof node.name === 'string' && node.name.trim() !== '');

      // For any object with userData.cfModel, skip its children and send the path only
      if (node.userData && node.userData.cfModel) {
        stashedChildren.set(node, node.children);
        node.children = [];
      }

      // Preserve translated geometries (like Tree_Trunks Cylinder and Tree_Leaves Cone)
      // Parameterized geometries lose custom translate()/rotate() during toJSON() unless serialized as BufferGeometry
      if (node.geometry && node.geometry.parameters && node.geometry.type !== 'BufferGeometry') {
        modifiedGeoms.push({
          geom: node.geometry,
          origType: node.geometry.type,
          origParams: node.geometry.parameters
        });
        node.geometry.type = 'BufferGeometry';
        delete node.geometry.parameters;
      }

      // Track textures to ensure data URLs and color space survive
      if (node.isMesh && node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const mat of mats) {
          if (!mat) continue;
          for (const key of ['map', 'lightMap', 'bumpMap', 'normalMap', 'specularMap', 'envMap', 'roughnessMap', 'metalnessMap']) {
            const tex = mat[key];
            if (tex && tex.isTexture) {
              let dataUrl = null;
              if (tex.image) {
                if (typeof tex.image.toDataURL === 'function') {
                  try {
                    dataUrl = tex.image.toDataURL('image/png');
                  } catch (_) {}
                } else if (typeof tex.image.src === 'string' && tex.image.src.startsWith('data:')) {
                  dataUrl = tex.image.src;
                }
              }
              const colorSpace = tex.colorSpace || (tex.encoding === 3001 ? 'srgb' : 'linear');
              const encoding = tex.encoding || (tex.colorSpace === 'srgb' ? 3001 : 3000);
              textureMap.set(tex.uuid, {
                dataUrl,
                colorSpace,
                encoding,
                imageUuid: tex.image?.uuid
              });
            }
          }
        }
      }
    });

    let json;
    try {
      json = root.toJSON();
    } catch (err) {
      console.warn('[ContextForge Runtime] scene.toJSON() warning:', err);
      json = { metadata: { version: 4.5, type: 'Object' }, object: { uuid: root.uuid, name: root.name || 'Scene', children: [] } };
    } finally {
      // Restore any detached children
      for (const [node, children] of stashedChildren.entries()) {
        node.children = children;
      }
      // Restore geometry types and parameters
      for (const item of modifiedGeoms) {
        item.geom.type = item.origType;
        item.geom.parameters = item.origParams;
      }
    }

    // Enhance serialized JSON: preserve data URLs and colorSpace
    if (json && typeof json === 'object') {
      if (!Array.isArray(json.images)) json.images = [];
      if (!Array.isArray(json.textures)) json.textures = [];

      for (const [texUuid, info] of textureMap.entries()) {
        const texObj = json.textures.find((t) => t.uuid === texUuid);
        if (texObj) {
          texObj.colorSpace = info.colorSpace;
          texObj.encoding = info.encoding;
          if (info.dataUrl) {
            let imgObj = json.images.find((i) => i.uuid === texObj.image);
            if (!imgObj) {
              const newUuid = texObj.image || info.imageUuid || `img_${texUuid}`;
              texObj.image = newUuid;
              json.images.push({ uuid: newUuid, url: info.dataUrl });
            } else if (!imgObj.url || typeof imgObj.url !== 'string' || !imgObj.url.startsWith('data:')) {
              imgObj.url = info.dataUrl;
            }
          }
        }
      }

      // Check Road material: ensure fallback has visible dark asphalt look (#3c4149) if texture fails to load
      root.traverse((node) => {
        if (node.isMesh && (node.name === 'Road' || node.userData?.cfId?.includes('Road')) && node.material) {
          const mat = Array.isArray(node.material) ? node.material[0] : node.material;
          if (mat) {
            const matObj = json.materials?.find((m) => m.uuid === mat.uuid);
            if (matObj) {
              matObj.color = 0x3c4149;
            }
          }
        }
      });
    }

    return json;
  }

  // --------------------------------------------------------------------------
  // EDIT MODE vs PLAY MODE
  // Wraps requestAnimationFrame to freeze game logic while rendering the scene
  // with the last active camera so edits show live in the game tab.
  // --------------------------------------------------------------------------
  let currentMode = 'edit'; // starts in edit mode so initial scene is frozen for inspection
  const originalRAF = window.requestAnimationFrame.bind(window);
  const queuedGameCallbacks = [];
  let isEditRendering = false;

  function runEditRender() {
    if (currentMode !== 'edit') {
      isEditRendering = false;
      return;
    }
    try {
      const cam = typeof getCamera === 'function' ? getCamera() : null;
      if (renderer && scene && cam) {
        renderer.render(scene, cam);
      }
    } catch (_) {}
    originalRAF(runEditRender);
  }

  window.requestAnimationFrame = function (callback) {
    if (currentMode === 'edit') {
      queuedGameCallbacks.push(callback);
      if (!isEditRendering) {
        isEditRendering = true;
        originalRAF(runEditRender);
      }
      return -1;
    }
    return originalRAF(callback);
  };

  function setMode(newMode) {
    if (newMode === currentMode) return;
    currentMode = newMode;
    console.log(`[ContextForge Runtime] Mode changed to: ${currentMode}`);

    if (currentMode === 'play') {
      isEditRendering = false;
      // Flush queued game callbacks so simulation loop resumes immediately
      const cbs = queuedGameCallbacks.splice(0);
      cbs.forEach((cb) => {
        try {
          originalRAF(cb);
        } catch (_) {}
      });
    } else if (currentMode === 'edit') {
      if (!isEditRendering) {
        isEditRendering = true;
        originalRAF(runEditRender);
      }
    }
  }

  // --------------------------------------------------------------------------
  // WebSocket Connection to /cf
  // --------------------------------------------------------------------------
  let ws = null;
  let reconnectTimer = null;

  function connectWS() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsHost = location.host;
    if (location.port && (location.port.startsWith('517') || location.port === '3001')) {
      wsHost = 'localhost:3000';
    }
    const wsUrl = `${protocol}//${wsHost}/cf?role=game`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reconnectTimer = setTimeout(connectWS, 1200);
      return;
    }

    ws.onopen = () => {
      console.log('[ContextForge Runtime] Connected to /cf WebSocket');
      // On connect send snapshot
      const snapshot = serializeScene(scene);
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'snapshot',
          scene: snapshot,
          renderer: getRendererSettings()
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'xform') {
          const obj = findObjectById(msg.id, scene);
          if (obj) {
            if (Array.isArray(msg.position)) {
              obj.position.set(msg.position[0], msg.position[1], msg.position[2]);
            }
            if (Array.isArray(msg.rotation)) {
              obj.rotation.set(msg.rotation[0], msg.rotation[1], msg.rotation[2]);
            }
            if (Array.isArray(msg.scale)) {
              obj.scale.set(msg.scale[0], msg.scale[1], msg.scale[2]);
            }
            if (typeof msg.visible === 'boolean') {
              obj.visible = msg.visible;
            }
            obj.updateMatrixWorld?.(true);
          }
        } else if (msg.type === 'set_mode') {
          setMode(msg.mode || 'edit');
        } else if (msg.type === 'req_snapshot') {
          const snapshot = serializeScene(scene);
          ws.send(
            JSON.stringify({
              version: 1,
              type: 'snapshot',
              scene: snapshot,
              renderer: getRendererSettings()
            })
          );
        } else if (msg.type === 'apply_layout') {
          if (msg.layout) {
            applyLayout(msg.layout);
          }
        } else if (msg.type === 'reload') {
          console.log('[ContextForge Runtime] Reloading game tab due to file change');
          window.location.reload();
        }
      } catch (err) {
        console.warn('[ContextForge Runtime] onmessage error:', err);
      }
    };

    ws.onclose = () => {
      ws = null;
      reconnectTimer = setTimeout(connectWS, 1500);
    };

    ws.onerror = () => {
      if (ws) ws.close();
    };
  }

  connectWS();

  const runtimeInstance = {
    version: 1,
    scene,
    getMode: () => currentMode,
    setMode,
    applyLayout,
    sendSnapshot: () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ version: 1, type: 'snapshot', scene: serializeScene(scene), renderer: getRendererSettings() }));
      }
    },
    findObjectById: (id) => findObjectById(id, scene)
  };

  window.__CONTEXTFORGE_RUNTIME__ = runtimeInstance;
  return runtimeInstance;
}
