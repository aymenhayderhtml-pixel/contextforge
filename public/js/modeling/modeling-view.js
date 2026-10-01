/**
 * public/js/modeling/modeling-view.js
 * ContextForge Modeling Workspace & Live Game Synchronizer.
 *
 * Implements Phase 1:
 * - Static server + WebSocket (/cf) connection management
 * - Play button (popup with ?cf=1)
 * - Live Three.js scene snapshot in viewport
 * - 280px Outliner with search, collapsible tree, type icons, eye toggle, multi-select
 * - Gizmo Move/Rotate/Scale (W/E/R), World/Local (Q), Snapping
 * - Focus selected object with 'F'
 * - Orange selection outline and bounding box helper
 * - 30 Hz live drag push to game tab + final commit on release
 * - 320px Inspector with drag-to-scrub numeric fields, per-field reset, scale lock (ON by default), reset transform
 * - Undo/Redo (Ctrl+Z / Ctrl+Y)
 * - Save layout to <project>/contextforge/layout.json (atomic with .bak)
 * - Install Hook helper with diff preview
 * - Status bar (object count, selected id, unsaved text, last error)
 */

import { state, subscribe } from '../state.js';
import { showToast } from '../shared/toast.js';

export function getActiveProjectPath() {
  const inputEl = document.getElementById('project-path');
  const pathFromInput = inputEl ? inputEl.value.trim() : '';
  return state.projectPath || state.currentProjectPath || pathFromInput || '';
}

// Three.js Core
let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let gridHelper = null;
let axesHelper = null;
let userGroup = null;
let boxHelper = null;
let raycaster = null;
let mouse = null;
let transformControls = null;
let editorLightGroup = null;

// Lifecycle & State
let isInitialized = false;
let isRendering = false;
let animFrameId = null;
let isTransformDragging = false;
let wasTransformDragging = false;
let currentGizmoMode = 'translate';
let currentGizmoSpace = 'world';
let isSnapEnabled = false;
let currentSnapStep = 0.5;
let scaleLockEnabled = true;

// Problem 1 & 2 Toolbar & Outliner state
let showEnvironment = false; // default OFF
let isWireframeActive = false;
let filterMeshesOnly = false;
let filterNamedOnly = false;
let lastBuiltCount = 0;
let lastSkippedCount = 0;

// Object & Selection Model
let userObjects = []; // [{ id, name, displayName, rawName, hasCustomName, type, mesh, visible, isEnvironment, isUnnamed, parentId, children, isExpanded }]
let selectedObjectId = null;
let selectedObjectIds = new Set();
let objectMap = new Map(); // id -> object entry
let dragStartTransform = null;
const dragStartMap = new Map(); // id -> { position, rotation, scale }
const modifiedObjectIds = new Set();
const prefixGroupExpanded = new Map(); // prefix -> boolean
let lastTransformBroadcastTime = 0;

// Undo / Redo Stacks
const undoStack = [];
const redoStack = [];
let hasUnsavedChanges = false;
let currentLayout = { version: 1, objects: {} };

// WebSocket & Remote Session State
let activeWs = null;
let wsReconnectTimer = null;
let isGameConnected = false;
// Play by default. Edit Mode parks the game's requestAnimationFrame loop
// (server/runtime.js), so a game that needs a keypress or click on its first
// screen (menus, car selection) would appear completely dead until the user
// found the mode toggle. The game stays inspectable in Play Mode — snapshots
// keep flowing and Edit Mode is one click away.
let currentGameMode = 'play'; // 'edit' or 'play'
let lastLoadedServerInfo = null;

// Driven-ID config (loaded from <project>/contextforge/config.json via /modeling/config)
let cfConfig = { drivenIds: ['Kart_Player', 'Kart_AI_*'] };

// Editor's own THREE.REVISION string (e.g. "128")
let EDITOR_THREE_REVISION = null;

// --------------------------------------------------------------------------
// Snapshot policy
//
// Live snapshots must never disturb the editor. A full snapshot (which clears
// and rebuilds the scene) is only applied on connect, on an explicit Resync, or
// when the game's id set actually changes. Everything else updates in place.
// --------------------------------------------------------------------------
let lastKnownIdSetHash = null;   // hash of the ids the editor currently shows
let pendingSceneChanged = false; // game object set drifted while in Edit mode
let idSetPollTimer = null;      // 1 s poll asking the game for a cheap id list
let forceResyncOnNextSnapshot = false; // set by the Resync button
const SNAPSHOT_ID_POLL_MS = 1000;

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------
export function initModelingView() {
  const container = document.getElementById('modeling-container');
  if (!container || isInitialized) return;

  const viewport = document.getElementById('modeling-viewport');
  const canvas = document.getElementById('modeling-canvas');
  if (!viewport || !canvas) return;

  if (typeof window.THREE === 'undefined') {
    console.warn('[Modeling] THREE.js is not loaded yet');
    return;
  }

  const THREE = window.THREE;

  // Scene (dark editor background #0b0f14, null fog)
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  scene.fog = null;

  // Camera (near = 0.1, far = 5000)
  const aspect = viewport.clientWidth / (viewport.clientHeight || 1);
  camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 5000);
  camera.position.set(12, 10, 18);
  camera.lookAt(0, 1, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance'
  });
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap || 2;
  if (THREE.SRGBColorSpace) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  if (THREE.sRGBEncoding) {
    renderer.outputEncoding = THREE.sRGBEncoding;
  }

  // OrbitControls
  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1, 0);
  }

  // Editor Lighting Rig: only active if snapshot has 0 lights
  editorLightGroup = new THREE.Group();
  editorLightGroup.name = 'EditorLightingRig';

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  hemiLight.position.set(0, 50, 0);
  editorLightGroup.add(hemiLight);

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight1.position.set(20, 40, 20);
  dirLight1.castShadow = true;
  editorLightGroup.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x90caf9, 0.6);
  dirLight2.position.set(-20, 20, -20);
  editorLightGroup.add(dirLight2);

  scene.add(editorLightGroup);

  // Ground Grid & Axes
  gridHelper = new THREE.GridHelper(40, 40, 0x38bdf8, 0x27272a);
  gridHelper.position.y = 0;
  scene.add(gridHelper);

  axesHelper = new THREE.AxesHelper(2);
  scene.add(axesHelper);

  // User Objects Root Group
  userGroup = new THREE.Group();
  userGroup.name = 'UserSceneRoot';
  scene.add(userGroup);

  // Selection Bounding Box Helper (Orange Outline #EA580C)
  boxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xea580c);
  boxHelper.visible = false;
  scene.add(boxHelper);

  // TransformControls Gizmo
  if (THREE.TransformControls) {
    transformControls = new THREE.TransformControls(camera, renderer.domElement);
    transformControls.size = 0.85;
    transformControls.visible = false;
    transformControls.enabled = false;
    scene.add(transformControls);

    transformControls.addEventListener('dragging-changed', (event) => {
      isTransformDragging = Boolean(event.value);
      if (isTransformDragging) {
        wasTransformDragging = true;
        if (controls) controls.enabled = false;

        // Capture drag start state for all selected objects
        dragStartMap.clear();
        selectedObjectIds.forEach((id) => {
          const entry = objectMap.get(id);
          if (entry && entry.mesh) {
            dragStartMap.set(id, {
              position: entry.mesh.position.clone(),
              rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
              scale: entry.mesh.scale.clone()
            });
          }
        });
        const activeObj = getSelectedObject();
        if (activeObj && activeObj.mesh && !dragStartMap.has(activeObj.id)) {
          dragStartMap.set(activeObj.id, {
            position: activeObj.mesh.position.clone(),
            rotation: [activeObj.mesh.rotation.x, activeObj.mesh.rotation.y, activeObj.mesh.rotation.z],
            scale: activeObj.mesh.scale.clone()
          });
        }
      } else {
        setTimeout(() => { wasTransformDragging = false; }, 80);
        if (controls) controls.enabled = true;

        // Drag released: commit all selected objects
        selectedObjectIds.forEach((id) => {
          modifiedObjectIds.add(id);
          const entry = objectMap.get(id);
          const start = dragStartMap.get(id);
          if (entry && entry.mesh) {
            const finalPos = entry.mesh.position.toArray();
            const finalRot = [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z];
            const finalScale = entry.mesh.scale.toArray();

            sendTransformDelta(entry.id, finalPos, finalRot, finalScale, entry.visible);

            if (start) {
              pushUndoAction({
                id: entry.id,
                prev: {
                  position: start.position.toArray(),
                  rotation: start.rotation,
                  scale: start.scale.toArray()
                },
                next: { position: finalPos, rotation: finalRot, scale: finalScale }
              });
            }
          }
        });
        dragStartMap.clear();
        markUnsavedChanges();
        syncInspectorFromTransform();
      }
    });

    transformControls.addEventListener('change', () => {
      if (boxHelper && boxHelper.visible) {
        boxHelper.update();
      }
      syncInspectorFromTransform();

      // Multi-transform synchronization during drag: apply delta to all members
      if (isTransformDragging && selectedObjectIds.size > 1 && selectedObjectId && dragStartMap.has(selectedObjectId)) {
        const primary = objectMap.get(selectedObjectId);
        const startPrimary = dragStartMap.get(selectedObjectId);
        if (primary && primary.mesh && startPrimary) {
          const deltaPos = primary.mesh.position.clone().sub(startPrimary.position);
          const deltaRotX = primary.mesh.rotation.x - startPrimary.rotation[0];
          const deltaRotY = primary.mesh.rotation.y - startPrimary.rotation[1];
          const deltaRotZ = primary.mesh.rotation.z - startPrimary.rotation[2];
          const scaleRatioX = startPrimary.scale.x !== 0 ? primary.mesh.scale.x / startPrimary.scale.x : 1;
          const scaleRatioY = startPrimary.scale.y !== 0 ? primary.mesh.scale.y / startPrimary.scale.y : 1;
          const scaleRatioZ = startPrimary.scale.z !== 0 ? primary.mesh.scale.z / startPrimary.scale.z : 1;

          selectedObjectIds.forEach((id) => {
            if (id === selectedObjectId) return;
            const entry = objectMap.get(id);
            const start = dragStartMap.get(id);
            if (entry && entry.mesh && start) {
              entry.mesh.position.copy(start.position).add(deltaPos);
              entry.mesh.rotation.set(
                start.rotation[0] + deltaRotX,
                start.rotation[1] + deltaRotY,
                start.rotation[2] + deltaRotZ
              );
              entry.mesh.scale.set(
                start.scale.x * scaleRatioX,
                start.scale.y * scaleRatioY,
                start.scale.z * scaleRatioZ
              );
              entry.mesh.updateMatrixWorld(true);
            }
          });
        }
      }

      // Throttled 30 Hz live broadcast to game tab during drag
      if (isTransformDragging) {
        const now = performance.now();
        if (now - lastTransformBroadcastTime >= 33.33) {
          lastTransformBroadcastTime = now;
          selectedObjectIds.forEach((id) => {
            const entry = objectMap.get(id);
            if (entry && entry.mesh) {
              sendTransformDelta(
                entry.id,
                entry.mesh.position.toArray(),
                [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
                entry.mesh.scale.toArray(),
                entry.visible
              );
            }
          });
        }
      }
    });
  }

  // Raycaster & Mouse for 3D selection
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  setupViewportEvents(canvas, viewport);
  setupToolbarEvents();
  setupKeyboardShortcuts();
  setupInspectorEvents();
  setupOutlinerSearch();

  // Resize handling
  window.addEventListener('resize', handleResize);
  const resizeObserver = new ResizeObserver(() => handleResize());
  resizeObserver.observe(viewport);

  isInitialized = true;
  updateUIState();
  updateUndoRedoButtons();

  // Subscribe to project path changes and input events
  try {
    subscribe((newPath) => {
      updateDisconnectedCard();
      checkActiveServerStatus();
    });
  } catch (_) {}

  const projInput = document.getElementById('project-path');
  if (projInput) {
    projInput.addEventListener('input', () => {
      updateDisconnectedCard();
    });
    projInput.addEventListener('change', () => {
      updateDisconnectedCard();
      checkActiveServerStatus();
    });
  }

  // Expose modeling helper on window for test and debugging
  window.__modeling = {
    selectObject,
    getUserObjects: () => userObjects,
    getObjectMap: () => objectMap,
    getSelectedObjectId: () => selectedObjectId,
    saveLayout,
    autoFrameCamera,
    getCamera: () => camera,
    getControls: () => controls,
    // model + animation surface (used by the Phase 2/3 tests)
    swapSelectedModel,
    updateModelParam,
    getModelSpecForEntry,
    loadAnimClipsForEntry,
    previewClip,
    pauseAnimPreview,
    stopAnimPreview,
    scrubAnimPreview,
    setAnimPreviewSpeed,
    getAnimPreviewState,
    updateAnimParam,
    broadcastSetAnim,
    openInBlender,
    openSettingsModal,
    loadCfSettings,
    saveCfSettings
  };

  // Check if project server is already running for current project
  checkActiveServerStatus();
}

function handleResize() {
  const viewport = document.getElementById('modeling-viewport');
  if (!viewport || !camera || !renderer) return;
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (w === 0 || h === 0) return;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  if (!isRendering) return;
  animFrameId = requestAnimationFrame(animate);

  if (controls && controls.enabled) {
    controls.update();
  }

  // Advance the editor's own preview mixer. This is preview only: it never
  // writes to the layout, and the game keeps its own independent mixers.
  tickAnimPreview();

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

export function showModelingView() {
  isRendering = true;
  handleResize();
  updateUIState();
  checkActiveServerStatus();

  if (transformControls && selectedObjectId) {
    const obj = objectMap.get(selectedObjectId);
    if (obj && obj.mesh) {
      transformControls.attach(obj.mesh);
      transformControls.visible = obj.visible !== false;
      transformControls.enabled = obj.visible !== false;
    }
  }

  if (!animFrameId) {
    animate();
  }
}

export function hideModelingView() {
  isRendering = false;
  if (transformControls) {
    transformControls.enabled = false;
  }
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

// --------------------------------------------------------------------------
// Object ID & Hierarchy Management
// Rule: Object ID = full name path from scene root, joined with '/'.
// Use userData.cfId first. Siblings with same name get #2, #3...
// Unnamed objects use their child index. No path:N ids.
// --------------------------------------------------------------------------
export function getNodeSegment(node, parent) {
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

export function computeObjectId(obj, root) {
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

// --------------------------------------------------------------------------
// Driven-ID Helpers
// Driven objects: game code owns their position & rotation.
// The editor only allows scale and visibility changes.
// --------------------------------------------------------------------------
function matchesPattern(str, pattern) {
  if (!str || !pattern) return false;
  if (pattern === str) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }
  return false;
}

function isDrivenId(id) {
  if (!id || !cfConfig || !Array.isArray(cfConfig.drivenIds)) return false;
  const segments = id.split('/');
  const lastName = segments[segments.length - 1];
  return cfConfig.drivenIds.some(
    (pat) => matchesPattern(id, pat) || matchesPattern(lastName, pat)
  );
}

async function loadCfConfig() {
  const projectPath = getActiveProjectPath();
  if (!projectPath) return;
  try {
    const res = await fetch(`/modeling/config?projectPath=${encodeURIComponent(projectPath)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.config && Array.isArray(data.config.drivenIds)) {
        cfConfig = data.config;
      }
    }
  } catch (_) {}
}

async function saveCfConfig(newConfig) {
  const projectPath = getActiveProjectPath();
  if (!projectPath) return;
  try {
    const res = await fetch('/modeling/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, config: newConfig })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) cfConfig = newConfig;
    }
  } catch (_) {}
}

function getSelectedObject() {
  if (!selectedObjectId) return null;
  return objectMap.get(selectedObjectId) || null;
}


// --------------------------------------------------------------------------
// Renderer Settings Application
// --------------------------------------------------------------------------
export function applyRendererSettings(settings) {
  if (!settings || !renderer) return;
  const THREE = window.THREE;

  // Store editor revision (once)
  if (!EDITOR_THREE_REVISION && THREE && THREE.REVISION) {
    EDITOR_THREE_REVISION = String(THREE.REVISION);
  }

  // Revision mismatch warning
  if (settings.threeRevision && EDITOR_THREE_REVISION && settings.threeRevision !== EDITOR_THREE_REVISION) {
    showErrorInStatusBar(
      `⚠ Three.js version mismatch: game r${settings.threeRevision} vs editor r${EDITOR_THREE_REVISION} — colors may differ`
    );
  }

  // outputColorSpace / outputEncoding
  if (settings.outputColorSpace === 'srgb' || settings.outputEncoding === 3001) {
    if (THREE.SRGBColorSpace) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    if (THREE.sRGBEncoding) {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }
  } else if (settings.outputColorSpace === 'linear' || settings.outputEncoding === 3000) {
    if (THREE.LinearSRGBColorSpace) {
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    }
    if (THREE.LinearEncoding) {
      renderer.outputEncoding = THREE.LinearEncoding;
    }
  }

  // toneMapping — use game's exact value
  if (typeof settings.toneMapping === 'number') {
    renderer.toneMapping = settings.toneMapping;
  }

  // toneMappingExposure — use game's exact value (no extra boost)
  if (typeof settings.toneMappingExposure === 'number') {
    renderer.toneMappingExposure = settings.toneMappingExposure;
  }

  // shadowMap
  if (settings.shadowMap) {
    if (typeof settings.shadowMap.enabled === 'boolean') {
      renderer.shadowMap.enabled = settings.shadowMap.enabled;
    }
    if (typeof settings.shadowMap.type === 'number') {
      renderer.shadowMap.type = settings.shadowMap.type;
    }
  }

  // scene.environment intensity
  if (typeof settings.environmentIntensity === 'number') {
    if (scene.environmentIntensity !== undefined) {
      scene.environmentIntensity = settings.environmentIntensity;
    }
    if (scene.environment && typeof scene.environment.intensity === 'number') {
      scene.environment.intensity = settings.environmentIntensity;
    }
  }

  // No environment map in editor
  scene.environment = null;
}

// --------------------------------------------------------------------------
// Scene Rebuilding from Game Snapshot
// --------------------------------------------------------------------------
export function loadSceneFromGame(sceneJson, rendererSettings = null) {
  if (!sceneJson || !scene) return;
  const THREE = window.THREE;
  if (!THREE || !THREE.ObjectLoader) return;

  try {
    // Problem 1: Force dark editor background (#0b0f14) and clear fog
    scene.background = new THREE.Color(0x0b0f14);
    scene.fog = null;

    if (rendererSettings) {
      applyRendererSettings(rendererSettings);
    }

    const loader = new THREE.ObjectLoader();
    const importedRoot = loader.parse(sceneJson);
    if (!importedRoot) return;

    // Clear game background / skybox / fog from imported copy
    if (importedRoot.background) importedRoot.background = null;
    if (importedRoot.fog) importedRoot.fog = null;

    // Double lighting:
    // Only add the editor's own lights if the snapshot has zero lights. Otherwise use the game's lights as they are.
    let snapshotLightCount = 0;
    importedRoot.traverse((node) => {
      if (node.isLight) snapshotLightCount++;
    });

    if (snapshotLightCount > 0) {
      if (editorLightGroup && editorLightGroup.parent) {
        scene.remove(editorLightGroup);
      }
    } else {
      if (editorLightGroup && !editorLightGroup.parent) {
        scene.add(editorLightGroup);
      }
    }

    // Clear previous scene objects
    while (userGroup.children.length > 0) {
      const child = userGroup.children[0];
      userGroup.remove(child);
      disposeHierarchy(child);
    }

    userObjects = [];
    objectMap.clear();
    selectedObjectId = null;
    selectedObjectIds.clear();

    if (boxHelper) {
      boxHelper.visible = false;
    }
    if (transformControls) {
      transformControls.detach();
      transformControls.visible = false;
      transformControls.enabled = false;
    }

    // Material fallback & Texture loading handling:
    // "Check that textures survive scene.toJSON(). For canvas-generated textures, make sure the image is serialized (data URL) and colorSpace is kept. Give the road a visible dark asphalt look. Right now it is white. If a texture fails to load, use the material's own color, not white or grey."
    importedRoot.traverse((node) => {
      // Fix for InstancedMesh (e.g. Tree_Trunks and Tree_Leaves)
      if (node.isInstancedMesh && node.instanceMatrix) {
        node.instanceMatrix.needsUpdate = true;
        node.frustumCulled = false;
      }

      if (node.isMesh) {
        if (!node.material) {
          node.material = new THREE.MeshStandardMaterial({
            color: 0x888888,
            roughness: 0.5,
            metalness: 0.1
          });
        } else {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          mats.forEach((m) => {
            if (!m) return;

            // Ensure colorSpace and encoding on textures
            for (const key of ['map', 'lightMap', 'bumpMap', 'normalMap', 'specularMap', 'envMap']) {
              const tex = m[key];
              if (tex && tex.isTexture) {
                // r160 stores texture color space in `colorSpace`; older snapshots
                // may only carry the legacy numeric `encoding`. Normalize both.
                if (!tex.colorSpace || tex.colorSpace === THREE.NoColorSpace) {
                  const isLegacySRGB = tex.encoding === 3001;
                  const isLegacyLinear = tex.encoding === 3000;
                  if (isLegacySRGB || isLegacyLinear) {
                    tex.colorSpace = isLegacySRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
                  } else if (key === 'map' || key === 'emissiveMap' || key === 'specularMap') {
                    // Color maps carry authored sRGB data by convention.
                    tex.colorSpace = THREE.SRGBColorSpace;
                  }
                }
                if (tex.image instanceof HTMLImageElement) {
                  if (tex.image.complete && tex.image.naturalWidth > 0) {
                    tex.needsUpdate = true;
                  } else {
                    tex.image.addEventListener('load', () => {
                      tex.needsUpdate = true;
                      if (renderer && scene && camera) {
                        renderer.render(scene, camera);
                      }
                    });
                  }
                }
              }
            }

            // Road fallback: only tint when the texture is genuinely absent.
            // Data-URL textures load asynchronously, so `image.complete` is false
            // at build time even though the texture arrives moments later. Tinting
            // on that transient state multiplies the texture by a dark color and
            // makes the road far darker than the game. When a texture IS present,
            // leave the material color untouched so it matches the game exactly.
            const isRoad = node.name === 'Road' || (node.userData?.cfId && node.userData.cfId.includes('Road'));
            if (isRoad && !m.map) {
              m.color.setHex(0x3c4149);
            }
          });
        }
      }
    });

    // Transfer children from importedRoot into userGroup
    const children = [...importedRoot.children];
    children.forEach((child) => {
      userGroup.add(child);
    });

    // No color correction: editor Three.js matches the game's revision, so
    // ColorManagement and color space handling are identical on both sides.

    let builtCount = 0;
    let skippedCount = 0;

    function getDisplayName(node) {
      if (node.userData?.cfDisplayName) return node.userData.cfDisplayName;
      if (node.name && typeof node.name === 'string' && node.name.trim() !== '') {
        return node.name.trim();
      }
      const typeStr = node.type || (node.isMesh ? 'Mesh' : (node.isGroup ? 'Group' : 'Object3D'));
      let geomStr = '';
      if (node.geometry && node.geometry.type) {
        geomStr = node.geometry.type;
      }
      let colorStr = '';
      const mat = Array.isArray(node.material) ? node.material[0] : node.material;
      if (mat && mat.color && typeof mat.color.getHexString === 'function') {
        colorStr = '#' + mat.color.getHexString();
      }
      const parts = [typeStr, geomStr, colorStr].filter(Boolean);
      return parts.join(' · ');
    }

    // Traverse userGroup and index all objects
    function indexNode(node, parentId = null) {
      const id = node.userData?.cfId || computeObjectId(node, userGroup);
      const lastSegment = id.split('/').pop();
      const displayName = lastSegment;
      const hasCustomName = Boolean(node.name && typeof node.name === 'string' && node.name.trim() !== '');
      const isUnnamed = !hasCustomName;

      let type = 'group';
      if (node.isPoints || (node.name && node.name.toLowerCase().includes('particle')) || id.toLowerCase().includes('particle')) {
        type = 'particles';
      } else if (node.isMesh) {
        type = 'mesh';
      } else if (node.isLight) {
        type = 'light';
      } else if (node.isCamera) {
        type = 'camera';
      } else if (node.isGroup) {
        type = 'group';
      } else if (node.isScene) {
        type = 'scene';
      }

      // Rule: Apply the filter per Mesh, never per Group.
      // Environment OFF hides only: Sky, Clouds, and any single Mesh larger than 200 units on any axis (Ground).
      // Road, Curbs, Trees, Buildings, ItemBoxes, Coins and Karts stay visible.
      let isEnvironment = false;
      let boxSize = null;

      if (node.isMesh) {
        const nameLower = (node.name || '').toLowerCase();
        const idLower = id.toLowerCase();

        const isProtected =
          nameLower.includes('road') || idLower.includes('road') ||
          nameLower.includes('curb') || idLower.includes('curb') ||
          nameLower.includes('tree') || idLower.includes('tree') ||
          nameLower.includes('building') || idLower.includes('building') ||
          nameLower.includes('item') || idLower.includes('item') ||
          nameLower.includes('box') || idLower.includes('box') ||
          nameLower.includes('coin') || idLower.includes('coin') ||
          nameLower.includes('kart') || idLower.includes('kart') ||
          nameLower.includes('player') || idLower.includes('player') ||
          nameLower.includes('start') || idLower.includes('start');

        if (!isProtected) {
          const isSky = nameLower.includes('sky') || idLower.includes('sky');
          const isCloud = nameLower.includes('cloud') || idLower.includes('cloud');

          if (isSky || isCloud) {
            isEnvironment = true;
          } else {
            const b = new THREE.Box3().setFromObject(node);
            if (!b.isEmpty()) {
              boxSize = new THREE.Vector3();
              b.getSize(boxSize);
              if (boxSize.x > 200 || boxSize.y > 200 || boxSize.z > 200) {
                isEnvironment = true;
              }
            }
          }
        }
      }

      if (isEnvironment) {
        skippedCount++;
        if (!showEnvironment && node.isMesh) {
          node.visible = false;
        }
      } else {
        builtCount++;
      }

      const entry = {
        id,
        name: displayName,
        displayName,
        rawName: node.name || '',
        hasCustomName,
        isUnnamed,
        type,
        mesh: node,
        visible: node.visible !== false,
        isEnvironment,
        boxSize,
        parentId,
        children: [],
        isExpanded: false // groups collapsed by default
      };

      node.userData = node.userData || {};
      node.userData.cfId = id;
      node.userData.cfDisplayName = displayName;

      userObjects.push(entry);
      objectMap.set(id, entry);

      if (node.children && node.children.length > 0) {
        node.children.forEach((c) => {
          const childEntry = indexNode(c, id);
          if (childEntry) entry.children.push(childEntry);
        });
      }
      return entry;
    }

    userGroup.children.forEach((rootChild) => {
      indexNode(rootChild, null);
    });

    lastBuiltCount = builtCount;
    lastSkippedCount = skippedCount;

    // Apply layout overrides if loaded
    loadAndApplyLayoutToScene();

    // Rebuild Outliner Tree & Update Inspector
    renderOutlinerTree();
    updateStatusBar();
    hideLoadingState();

    // Auto-frame camera
    autoFrameCamera();

    // Hide empty notice if we have objects
    const emptyNotice = document.getElementById('modeling-empty-notice');
    if (emptyNotice) {
      emptyNotice.style.display = userObjects.length === 0 ? 'flex' : 'none';
    }

    // No default selection on load: Inspector shows 'Select an object to edit'
    selectObject(null);
  } catch (err) {
    console.error('[Modeling] Error loading scene snapshot:', err);
    showErrorInStatusBar(`Snapshot load error: ${err.message}`);
    hideLoadingState();
  }
}

/**
 * Auto-frame camera:
 * Frames camera on the union bounding box of Kart_Player and all Kart_AI_* objects,
 * plus 25% padding, at a 3/4 view from above and behind.
 * If no karts exist, frames all visible meshes (never clouds or sky).
 */
export function autoFrameCamera(force = false) {
  if (!camera || !scene || userObjects.length === 0) return;
  const THREE = window.THREE;

  // 1. Look for Kart_Player and Kart_AI_* objects
  const kartEntries = userObjects.filter(
    (e) =>
      e.mesh &&
      (e.id === 'Kart_Player' ||
       e.id.startsWith('Kart_AI') ||
       (e.rawName && (e.rawName === 'Kart_Player' || e.rawName.startsWith('Kart_AI'))))
  );

  const box = new THREE.Box3();
  let hasKarts = false;

  kartEntries.forEach((kart) => {
    const b = new THREE.Box3().setFromObject(kart.mesh);
    if (!b.isEmpty()) {
      box.union(b);
      hasKarts = true;
    }
  });

  let viewDir;

  if (hasKarts && !box.isEmpty()) {
    // 25% padding
    const center = new THREE.Vector3();
    box.getCenter(center);
    box.min.sub(center).multiplyScalar(1.25).add(center);
    box.max.sub(center).multiplyScalar(1.25).add(center);

    // 3/4 view from above and behind
    const primaryKart = kartEntries.find((k) => k.id === 'Kart_Player') || kartEntries[0];
    let forward = new THREE.Vector3(0, 0, 1);
    if (primaryKart && primaryKart.mesh) {
      forward.applyEuler(primaryKart.mesh.rotation).normalize();
    }
    if (forward.lengthSq() < 0.001) forward.set(0, 0, 1);

    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(up, forward).normalize();
    if (side.lengthSq() < 0.001) side.set(1, 0, 0);

    // 3/4 view from above and behind:
    // -forward (behind), +side * 0.75 (3/4 lateral angle), +up * 0.75 (above)
    viewDir = new THREE.Vector3()
      .addScaledVector(forward, -1.0)
      .addScaledVector(side, 0.75)
      .addScaledVector(up, 0.75)
      .normalize();
  } else {
    // If no karts exist, frame all visible meshes (never frame clouds or sky).
    // Any Object3D can own geometry (a car is usually a Group holding Mesh
    // children), so measure the node itself rather than filtering on
    // type === 'mesh', which would skip every grouped model.
    box.makeEmpty();
    userObjects.forEach((entry) => {
      if (!entry.mesh || !entry.visible) return;
      if (entry.type === 'light' || entry.type === 'camera') return;
      if (entry.isEnvironment) return; // ignores clouds, sky, ground plane > 200
      const nameLower = (entry.rawName || '').toLowerCase();
      const idLower = (entry.id || '').toLowerCase();
      if (nameLower.includes('sky') || idLower.includes('sky') || nameLower.includes('cloud') || idLower.includes('cloud')) return;

      const b = new THREE.Box3().setFromObject(entry.mesh);
      if (!b.isEmpty()) {
        box.union(b);
      }
    });

    if (box.isEmpty()) return;
    viewDir = new THREE.Vector3(1, 0.75, 1.25).normalize();
  }

  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 2);

  const fov = camera.fov * (Math.PI / 180);
  let cameraDistance = (maxDim / 2) / Math.tan(fov / 2);
  cameraDistance /= 0.70; // 70% fill of view

  camera.position.copy(center).addScaledVector(viewDir, Math.max(cameraDistance, 6));
  camera.near = 0.1;
  camera.far = 5000;
  camera.lookAt(center);
  camera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

/**
 * Toolbar toggle 'Environment' (default OFF)
 * Hides only: Sky, Clouds, and any single Mesh larger than 200 units on any axis (Ground).
 * Applied per Mesh, never per Group.
 */
export function toggleEnvironment() {
  showEnvironment = !showEnvironment;
  const btn = document.getElementById('btn-modeling-env');
  if (btn) btn.classList.toggle('active', showEnvironment);

  userObjects.forEach((entry) => {
    // Apply filter per Mesh, never per Group
    if (entry.type === 'mesh' && entry.isEnvironment && entry.mesh) {
      entry.mesh.visible = showEnvironment;
      entry.visible = showEnvironment;
    }
  });

  renderOutlinerTree();
  updateStatusBar();
  showToast(showEnvironment ? 'Environment visible' : 'Environment hidden', 'info');
}

/**
 * Problem 1: Wireframe toggle
 */
export function toggleWireframe() {
  isWireframeActive = !isWireframeActive;
  const btn = document.getElementById('btn-modeling-wireframe');
  if (btn) btn.classList.toggle('active', isWireframeActive);

  if (userGroup) {
    userGroup.traverse((node) => {
      if (node.isMesh && node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((m) => {
          m.wireframe = isWireframeActive;
        });
      }
    });
  }
  showToast(isWireframeActive ? 'Wireframe enabled' : 'Wireframe disabled', 'info');
}

/**
 * Problem 1: Frame All
 */
export function frameAll() {
  autoFrameCamera(true);
  showToast('Framed scene view', 'info');
}

// --------------------------------------------------------------------------
// Snapshot policy helpers
// --------------------------------------------------------------------------

/** Stable order-independent hash of an id list, so we can compare id sets. */
function hashIdSet(ids) {
  const sorted = [...ids].sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      const c = id.charCodeAt(i);
      h1 = ((h1 ^ c) * 0x01000193) >>> 0;
      h2 = ((h2 + c + 0x9e3779b9) * 0x85ebca6b) >>> 0;
    }
    h1 = ((h1 ^ 0x5c) * 0x01000193) >>> 0;
  }
  return `${h1.toString(36)}-${h2.toString(36)}`;
}

/** The ids currently indexed in the editor. */
function currentEditorIdSet() {
  return new Set(objectMap.keys());
}

function updateSceneChangedIndicator() {
  const item = document.getElementById('modeling-status-scenechanged');
  const btn = document.getElementById('btn-scene-changed-resync');
  if (item) item.style.display = pendingSceneChanged ? 'flex' : 'none';
  if (btn) btn.style.display = pendingSceneChanged ? 'inline-block' : 'none';
}

function clearSceneChangedIndicator() {
  pendingSceneChanged = false;
  updateSceneChangedIndicator();
}

/**
 * Applies a full snapshot. Selection, gizmo, camera, expanded groups and outliner
 * scroll are all restored afterwards, so a rebuild never disturbs the editor.
 */
function applyFullSnapshot(msg) {
  const preserved = captureEditorState();
  loadSceneFromGame(msg.scene, msg.renderer);
  restoreEditorState(preserved);
}

function captureEditorState() {
  const outliner = document.getElementById('modeling-outliner-list');
  return {
    selectedObjectId,
    selectedObjectIds: new Set(selectedObjectIds),
    gizmoMode: currentGizmoMode,
    gizmoSpace: currentGizmoSpace,
    cameraPosition: camera ? camera.position.toArray() : null,
    cameraQuaternion: camera ? camera.quaternion.toArray() : null,
    cameraZoom: camera ? camera.zoom : null,
    cameraNear: camera ? camera.near : null,
    cameraFar: camera ? camera.far : null,
    controlsTarget: controls ? controls.target.toArray() : null,
    prefixGroupExpanded: new Map(prefixGroupExpanded),
    outlinerScrollTop: outliner ? outliner.scrollTop : 0
  };
}

function restoreEditorState(state) {
  if (!state) return;

  // Expanded groups, including per-prefix groups kept outside the object tree.
  prefixGroupExpanded.clear();
  for (const [k, v] of state.prefixGroupExpanded) prefixGroupExpanded.set(k, v);
  for (const entry of objectMap.values()) {
    const prefix = (entry.name || '').split(' ')[0];
    if (prefixGroupExpanded.has(prefix)) {
      entry.isExpanded = prefixGroupExpanded.get(prefix);
    }
  }

  // Camera: never auto-frame over a user's viewpoint.
  if (camera && state.cameraPosition) {
    camera.position.fromArray(state.cameraPosition);
    camera.quaternion.fromArray(state.cameraQuaternion);
    if (state.cameraZoom !== null) camera.zoom = state.cameraZoom;
    if (state.cameraNear !== null) camera.near = state.cameraNear;
    if (state.cameraFar !== null) camera.far = state.cameraFar;
    camera.updateProjectionMatrix();
  }
  if (controls && state.controlsTarget) {
    controls.target.fromArray(state.controlsTarget);
    controls.update();
  }

  // Selection + gizmo.
  if (state.selectedObjectId && objectMap.has(state.selectedObjectId)) {
    selectObject(state.selectedObjectId);
  }
  // setGizmoMode updates both the gizmo and its toolbar buttons.
  if (state.gizmoMode && state.gizmoMode !== currentGizmoMode) setGizmoMode(state.gizmoMode);
  // Space is a toggle; click it only if the restored value differs.
  if (state.gizmoSpace && state.gizmoSpace !== currentGizmoSpace) toggleGizmoSpace();

  renderOutlinerTree();
  renderInspector();
  updateStatusBar();

  const outliner = document.getElementById('modeling-outliner-list');
  if (outliner && state.outlinerScrollTop) {
    outliner.scrollTop = state.outlinerScrollTop;
  }
}

/**
 * Patches an existing snapshot's objects into the live scene by id, without
 * rebuilding anything. Used in Play mode so karts, camera and selection survive.
 */
function applySnapshotInPlace(msg) {
  const json = msg.scene;
  if (!json || !json.object) return;
  const THREE = window.THREE;
  const worldM = new THREE.Matrix4();
  const localM = new THREE.Matrix4();
  const invParent = new THREE.Matrix4();

  // Walk the serialized tree, matching each node to an existing editor object by
  // the cfId the runtime stamps into userData. Nothing is created or destroyed.
  const walk = (nodeJson, parentMesh) => {
    if (!nodeJson) return;
    const id = (nodeJson.userData || {}).cfId;
    const entry = id ? objectMap.get(id) : null;
    const mesh = entry && entry.mesh ? entry.mesh : parentMesh;

    if (mesh && nodeJson.matrix) {
      worldM.fromArray(nodeJson.matrix);
      if (parentMesh && parentMesh !== mesh) {
        parentMesh.updateMatrixWorld(true);
        invParent.copy(parentMesh.matrixWorld).invert();
        localM.multiplyMatrices(invParent, worldM);
      } else {
        localM.copy(worldM);
      }
      localM.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.updateMatrixWorld(true);

      if (entry) {
        if (nodeJson.visible !== undefined) {
          entry.visible = nodeJson.visible !== false;
          mesh.visible = entry.visible;
        }
        if (selectedObjectId === entry.id) {
          syncInspectorFromTransform();
          if (boxHelper) boxHelper.update();
        }
      }
    }
    for (const child of nodeJson.children || []) walk(child, mesh);
  };

  walk(json.object, null);
}

/** Applies a serialized world matrix to `mesh` as a local transform. */
function applyMatrixToLocal(mesh, matrixArr, parentMesh) {
  const THREE = window.THREE;
  const m = new THREE.Matrix4().fromArray(matrixArr);
  if (parentMesh && parentMesh !== mesh) {
    parentMesh.updateMatrixWorld(true);
    m.premultiply(new THREE.Matrix4().copy(parentMesh.matrixWorld).invert());
  }
  m.decompose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.updateMatrixWorld(true);
}

/**
 * Entry point for every incoming snapshot. Decides between a full rebuild and
 * an in-place patch, and never disturbs the editor in Edit mode.
 */
function handleIncomingSnapshot(msg) {
  const incomingHash = msg.idHash || null;

  // Explicit resync: the user asked for it, so always rebuild.
  if (forceResyncOnNextSnapshot) {
    forceResyncOnNextSnapshot = false;
    applyFullSnapshot(msg);
    lastKnownIdSetHash = incomingHash || hashIdSet(currentEditorIdSet());
    clearSceneChangedIndicator();
    return;
  }

  // Play mode: patch live transforms in place; never rebuild.
  if (currentGameMode === 'play') {
    applySnapshotInPlace(msg);
    return;
  }

  // Edit mode: only rebuild if we have nothing yet.
  if (userObjects.length === 0) {
    applyFullSnapshot(msg);
    lastKnownIdSetHash = incomingHash || hashIdSet(currentEditorIdSet());
    clearSceneChangedIndicator();
    return;
  }

  if (!incomingHash) {
    // Older runtime without a hash: remember what we show and leave the scene
    // alone. Rebuilding on every snapshot is exactly what we must avoid.
    lastKnownIdSetHash = lastKnownIdSetHash || hashIdSet(currentEditorIdSet());
    return;
  }

  if (incomingHash === lastKnownIdSetHash) {
    // Same object set: ignore entirely. The editor must not move.
    return;
  }

  // Object set changed while editing: flag it, but do NOT replace the scene.
  lastKnownIdSetHash = incomingHash;
  pendingSceneChanged = true;
  updateSceneChangedIndicator();
}

/** Handles the cheap 1 s id-set poll. */
function handleIncomingIdSet(msg) {
  if (!msg || !Array.isArray(msg.ids)) return;
  const hash = msg.hash || hashIdSet(msg.ids);
  if (lastKnownIdSetHash === null) {
    lastKnownIdSetHash = hash;
    return;
  }
  if (hash === lastKnownIdSetHash) return;
  // Drift detected. In Play mode we can safely rebuild; in Edit mode we only
  // offer a button, per the snapshot policy.
  lastKnownIdSetHash = hash;
  if (currentGameMode === 'play') {
    requestGameSceneSync();
  } else {
    pendingSceneChanged = true;
    updateSceneChangedIndicator();
  }
}

/** Starts the 1 s id-set poll. */
function startIdSetPolling() {
  if (idSetPollTimer) return;
  idSetPollTimer = setInterval(() => {
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ version: 1, type: 'req_id_set' }));
    }
  }, SNAPSHOT_ID_POLL_MS);
}

function stopIdSetPolling() {
  if (idSetPollTimer) {
    clearInterval(idSetPollTimer);
    idSetPollTimer = null;
  }
}

/** Wires the Animation section: clip preview, transport, bindings, Blender. */
function bindAnimationInspectorHandlers(entry) {
  if (!entry) return;

  // --- clip list: click a clip to preview it (editor only) ---
  document.querySelectorAll('#anim-clip-list .anim-clip-item').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-clip');
      if (!name) return;
      const ok = previewClip(entry.id, name);
      if (ok) {
        // Reflect the chosen clip in the list without a full re-render, so the
        // preview keeps running.
        document.querySelectorAll('#anim-clip-list .anim-clip-item').forEach((b) => {
          b.style.borderColor = b === btn ? 'var(--accent)' : '';
        });
        const pp = document.getElementById('prop-anim-playpause');
        if (pp) pp.textContent = '❚❚ Pause';
      }
    });
  });

  const playPause = document.getElementById('prop-anim-playpause');
  if (playPause) {
    playPause.addEventListener('click', () => {
      const st = getAnimPreviewState(entry.id);
      if (!st) { previewClip(entry.id, (animClipCache.get(entry.id) || [])[0]?.name); renderInspector(); return; }
      if (st.playing) { pauseAnimPreview(entry.id); playPause.textContent = '▶ Play'; }
      else { previewClip(entry.id, st.current || (animClipCache.get(entry.id) || [])[0]?.name); playPause.textContent = '❚❚ Pause'; }
    });
  }

  const stopBtn = document.getElementById('prop-anim-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      stopAnimPreview(entry.id);
      if (playPause) playPause.textContent = '▶ Play';
      const bar = document.getElementById('prop-anim-scrub');
      if (bar) bar.value = '0';
      const t = document.getElementById('prop-anim-time');
      if (t) t.textContent = '0.00s / 0.00s';
    });
  }

  const scrub = document.getElementById('prop-anim-scrub');
  if (scrub) {
    scrub.addEventListener('input', () => {
      const st = getAnimPreviewState(entry.id);
      if (!st || !st.duration) return;
      const t = (Number(scrub.value) / 1000) * st.duration;
      scrubAnimPreview(entry.id, t);
      const timeEl = document.getElementById('prop-anim-time');
      if (timeEl) timeEl.textContent = `${t.toFixed(2)}s / ${st.duration.toFixed(2)}s`;
    });
  }

  const speed = document.getElementById('prop-anim-speed');
  if (speed) {
    speed.addEventListener('change', () => {
      let v = parseFloat(speed.value);
      if (!isFinite(v)) v = 1;
      v = Math.min(3, Math.max(0.1, v));
      speed.value = String(v);
      setAnimPreviewSpeed(entry.id, v);
      // Persist it with the rest of the animation spec.
      updateAnimParam(entry.id, { speed: v });
    });
  }

  const loop = document.getElementById('prop-anim-loop');
  if (loop) {
    loop.addEventListener('change', () => {
      updateAnimParam(entry.id, { loop: loop.checked });
    });
  }

  const idleSel = document.getElementById('prop-anim-idle');
  const moveSel = document.getElementById('prop-anim-move');
  const bind = () => {
    const bindings = {};
    if (idleSel && idleSel.value) bindings.idle = idleSel.value;
    if (moveSel && moveSel.value) bindings.move = moveSel.value;
    updateAnimParam(entry.id, { bindings });
  };
  if (idleSel) idleSel.addEventListener('change', bind);
  if (moveSel) moveSel.addEventListener('change', bind);

  const crossfade = document.getElementById('prop-anim-crossfade');
  if (crossfade) {
    crossfade.addEventListener('change', () => {
      let v = parseFloat(crossfade.value);
      if (!isFinite(v) || v < 0) v = 0;
      v = Math.min(3, v);
      crossfade.value = String(v);
      updateAnimParam(entry.id, { crossfade: v });
    });
  }

  const autoBox = document.getElementById('prop-anim-auto');
  if (autoBox) {
    autoBox.addEventListener('change', () => {
      updateAnimParam(entry.id, { auto: autoBox.checked });
    });
  }

  const playInGame = document.getElementById('prop-anim-play-in-game');
  if (playInGame) {
    playInGame.addEventListener('click', () => {
      broadcastSetAnim(entry.id, getAnimSpecForEntry(entry), siblingModelWrites.has(entry.id) ? siblingGlobIdFor(entry.name) : null);
      showToast('Animation sent to the game', 'success');
    });
  }

  const blenderBtn = document.getElementById('prop-anim-open-blender');
  if (blenderBtn) {
    blenderBtn.addEventListener('click', () => openInBlender());
  }
}

// --------------------------------------------------------------------------
// Blender integration + settings
// --------------------------------------------------------------------------

/** The model file for the current selection, as a project-relative path. */
function selectedModelRelPath() {
  const entry = getSelectedObject();
  if (!entry) return null;
  const spec = getModelSpecForEntry(entry);
  return spec && spec.path ? spec.path : null;
}

/** Launches Blender on the selected model via the server. */
export async function openInBlender() {
  const projectPath = getActiveProjectPath();
  const filePath = selectedModelRelPath();
  if (!projectPath || !filePath) {
    showErrorInStatusBar('Select an object with a swapped model first');
    return { ok: false };
  }
  try {
    const res = await fetch('/modeling/open-blender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, filePath })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The server sends the exact user-facing message, e.g. the Blender
      // not-found string. Show it verbatim.
      const msg = data.error || `Could not open Blender (${res.status})`;
      showErrorInStatusBar(msg);
      showToast(msg, 'error');
      return { ok: false, error: msg };
    }
    clearEditorModelError();
    showToast(`Opened ${filePath} in Blender`, 'success');
    return { ok: true, ...data };
  } catch (err) {
    showErrorInStatusBar(`Could not open Blender: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

let cfSettingsCache = { blenderPath: 'blender' };

export async function loadCfSettings() {
  try {
    const res = await fetch('/modeling/settings');
    if (res.ok) cfSettingsCache = await res.json();
  } catch (_) { /* keep defaults */ }
  return cfSettingsCache;
}

export async function saveCfSettings(patch) {
  const res = await fetch('/modeling/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  if (res.ok) cfSettingsCache = await res.json();
  return cfSettingsCache;
}

/** Renders the Settings modal with the Blender path field. */
export async function openSettingsModal() {
  const settings = await loadCfSettings();
  const backdrop = document.createElement('div');
  backdrop.className = 'modeling-modal-backdrop';
  backdrop.id = 'cf-settings-modal';
  backdrop.innerHTML = `
    <div class="modeling-modal" style="max-width:520px;">
      <div class="modeling-modal-header">
        <h3>Settings</h3>
        <button type="button" class="modeling-tool-btn" id="cf-settings-close">Close</button>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:14px;">
        <div style="display:flex;flex-direction:column;gap:5px;">
          <label for="cf-blender-path" style="font-size:0.8rem;color:var(--text);">Blender executable path</label>
          <input type="text" id="cf-blender-path" value="${escapeHtml(settings.blenderPath || 'blender')}"
            placeholder="blender"
            style="background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-size:0.8rem;font-family:monospace;" />
          <div style="font-size:0.68rem;color:var(--dim);line-height:1.4;">
            Used by "Open in Blender" on a model. A bare name like <code>blender</code> is resolved from PATH.
            Windows example: <code>C:\Program Files\Blender Foundation\Blender 4.2\blender.exe</code>
          </div>
        </div>
        <div id="cf-settings-status" style="font-size:0.72rem;color:var(--dim);min-height:1.1em;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="modeling-tool-btn" id="cf-settings-save">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('#cf-settings-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  backdrop.querySelector('#cf-settings-save')?.addEventListener('click', async () => {
    const val = backdrop.querySelector('#cf-blender-path')?.value ?? 'blender';
    const status = backdrop.querySelector('#cf-settings-status');
    try {
      await saveCfSettings({ blenderPath: val.trim() || 'blender' });
      if (status) { status.style.color = 'var(--accent)'; status.textContent = 'Saved'; }
      showToast('Settings saved', 'success');
      setTimeout(close, 350);
    } catch (err) {
      if (status) { status.style.color = '#EF4444'; status.textContent = err.message; }
    }
  });
  return backdrop;
}

/** The animation block to persist for an entry, with defaults filled in. */
function getAnimSpecForEntry(entry) {
  const spec = getModelSpecForEntry(entry);
  if (!spec || !spec.path) return null;
  const a = spec.animation || {};
  return {
    bindings: a.bindings && typeof a.bindings === 'object' ? a.bindings : {},
    loop: a.loop !== false,
    speed: typeof a.speed === 'number' ? a.speed : 1,
    crossfade: typeof a.crossfade === 'number' ? a.crossfade : 0.2,
    auto: a.auto !== false
  };
}

/**
 * Updates the animation spec for an entry and broadcasts it. Unlike the model
 * params this does not rebuild the model, only the mixer's behaviour.
 */
export function updateAnimParam(entryId, patch) {
  const entry = objectMap.get(entryId);
  if (!entry) return false;
  const prev = getModelSpecForEntry(entry);
  if (!prev || !prev.path) return false;
  const spec = { ...prev, animation: { ...getAnimSpecForEntry(entry), ...patch } };
  modelStateStore.set(entryId, spec);
  const glob = siblingModelWrites.has(entryId) ? siblingGlobIdFor(entry.name) : null;
  if (currentLayout && currentLayout.objects) {
    if (glob) {
      // Keep the sibling record in step, or Save would write the stale spec (with
      // the default empty bindings) back over the glob.
      siblingModelWrites.set(entryId, spec);
      currentLayout.objects[glob] = { ...(currentLayout.objects[glob] || {}), model: spec };
    } else {
      currentLayout.objects[entryId] = { ...(currentLayout.objects[entryId] || {}), model: spec };
    }
  } else if (glob) {
    siblingModelWrites.set(entryId, spec);
  }
  pushUndoAction({ type: 'model', id: entryId, prev: { model: prev }, next: { model: { ...spec } } });
  markUnsavedChanges();
  broadcastSetAnim(entryId, spec.animation, glob);
  return true;
}

/** Sends the animation spec to the game over the WebSocket. */
function broadcastSetAnim(id, animation, globId) {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
  try {
    activeWs.send(JSON.stringify({
      version: 1, type: 'set_anim', id, animation, siblings: globId || undefined
    }));
  } catch (_) {}
}

/**
 * A model file changed on disk. Reloads it in the editor with a cache-busting
 * ?v=<mtime>, and tells the game to do the same. The selected object, its
 * transform and its animation bindings are all preserved.
 */
async function handleModelChanged(msg) {
  const path = msg && msg.path;
  if (!path) return;
  const version = msg.mtime || Date.now();
  let reloaded = 0;
  try {
    // Drop the editor's cached gltf for this path so the new bytes are re-read.
    for (const k of Array.from(modelCache.keys())) {
      if (k === path || k.startsWith(path + '?')) modelCache.delete(k);
    }

    // Re-apply the model to every entry that uses this path. The scene, the
    // selection and the transforms are left exactly as they are.
    for (const [id, spec] of Array.from(modelStateStore.entries())) {
      if (!spec || spec.path !== path) continue;
      const entry = objectMap.get(id);
      if (!entry) continue;
      const wasSelected = selectedObjectId === id;
      await applyModelToEntry(entry, { ...spec, __v: version });
      if (wasSelected) {
        // selectObject re-attaches the gizmo and box helper after the rebuild.
        selectObject(id);
      }
      reloaded++;
    }

    // Glob-written models live on entries that may not be in modelStateStore.
    for (const e of userObjects) {
      const spec = getModelSpecForEntry(e);
      if (!spec || spec.path !== path) continue;
      if (modelStateStore.has(e.id)) continue;
      await applyModelToEntry(e, { ...spec, __v: version });
      reloaded++;
    }

    // Refresh the clip list for anything still selected.
    for (const e of userObjects) {
      if (selectedObjectId === e.id && getModelSpecForEntry(e)?.path === path) {
        animClipCache.delete(e.id);
        disposeAnimPreview(e.id);
      }
    }
    if (selectedObjectId) renderInspector();
  } catch (err) {
    // A failure to reload one model must not stop the game being told.
    console.warn('[Modeling] model reload failed:', err);
    reportEditorModelError(`Reload failed: ${err.message}`);
  }

  // Ask the game to do the same, with the same cache-buster. Done last and
  // outside the try, so it always runs.
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(JSON.stringify({
        version: 1, type: 'reload_model', path, version
      }));
    } catch (_) {}
  }
  showToast(`Reloaded ${path.split('/').pop()}`, 'info');
  return reloaded;
}

export function requestGameSceneSync() {
  forceResyncOnNextSnapshot = true;
  clearSceneChangedIndicator();
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ version: 1, type: 'req_snapshot' }));
    showToast('Requested scene snapshot from game', 'info');
  } else {
    // Fallback to HTTP query
    const targetProject = getActiveProjectPath();
    if (!targetProject) return;
    fetch(`/game-scene-snapshot?projectPath=${encodeURIComponent(targetProject)}`)
      .then((res) => {
        if (!res.ok) throw new Error('No snapshot available');
        return res.json();
      })
      .then((data) => {
        if (data && data.sceneJson) {
          forceResyncOnNextSnapshot = false;
          applyFullSnapshot({ scene: data.sceneJson });
        }
      })
      .catch(() => {});
  }
}

// --------------------------------------------------------------------------
// WebSocket Connection to /cf
// --------------------------------------------------------------------------
export function connectToGameWebSocket(wsUrl) {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  if (activeWs) {
    try { activeWs.close(); } catch (_) {}
    activeWs = null;
  }

  setConnectionPill('connecting');

  let finalUrl = wsUrl;
  if (!finalUrl.includes('role=')) {
    finalUrl += (finalUrl.includes('?') ? '&' : '?') + 'role=editor';
  }

  try {
    activeWs = new WebSocket(finalUrl);
  } catch (err) {
    setConnectionPill('disconnected');
    scheduleWsReconnect(wsUrl);
    return;
  }

  activeWs.onopen = () => {
    console.log('[Modeling] Connected to editor WebSocket at', wsUrl);
    // Request fresh snapshot upon connect. This is one of only three cases that
    // legitimately rebuilds the scene.
    forceResyncOnNextSnapshot = true;
    activeWs.send(JSON.stringify({ version: 1, type: 'req_snapshot' }));
    // Re-assert the mode on every connect. A reconnect re-adds this editor to
    // the server's editor set, but the game may have been left in Edit Mode by
    // a previous session — sending it here keeps the game from staying parked.
    activeWs.send(JSON.stringify({ version: 1, type: 'set_mode', mode: currentGameMode }));
    startIdSetPolling();
  };

  activeWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (!msg) return;

      if (msg.type === 'status') {
        isGameConnected = Boolean(msg.connected);
        setConnectionPill(isGameConnected ? 'connected' : 'disconnected');
        updateDisconnectedCard();
      } else if (msg.type === 'snapshot') {
        isGameConnected = true;
        setConnectionPill('connected');
        updateDisconnectedCard();
        // A snapshot is only a hint that the scene may have changed. Decide
        // whether to rebuild (Edit) or patch in place (Play).
        handleIncomingSnapshot(msg);
      } else if (msg.type === 'id_set') {
        // Cheap 1 s poll carrying only the game's id list + hash.
        handleIncomingIdSet(msg);
      } else if (msg.type === 'model_changed') {
        // A model file changed on disk. Reload it in place, keeping the current
        // transform, animation state and selection.
        handleModelChanged(msg);
      } else if (msg.type === 'model_error') {
        // The game could not load/apply a model (missing file, parse error, heavy mesh).
        showErrorInStatusBar(`⚠ ${msg.message || 'Model error'}`);
      } else if (msg.type === 'xform') {
        // Remote transform received
        const obj = objectMap.get(msg.id);
        if (obj && obj.mesh) {
          if (Array.isArray(msg.position)) obj.mesh.position.fromArray(msg.position);
          if (Array.isArray(msg.rotation)) obj.mesh.rotation.set(msg.rotation[0], msg.rotation[1], msg.rotation[2]);
          if (Array.isArray(msg.scale)) obj.mesh.scale.fromArray(msg.scale);
          if (typeof msg.visible === 'boolean') obj.visible = msg.visible;
          obj.mesh.updateMatrixWorld(true);
          if (selectedObjectId === msg.id) {
            syncInspectorFromTransform();
            if (boxHelper) boxHelper.update();
          }
        }
      }
    } catch (err) {
      console.warn('[Modeling] WS message parse error:', err);
    }
  };

  activeWs.onclose = () => {
    activeWs = null;
    isGameConnected = false;
    setConnectionPill('disconnected');
    updateDisconnectedCard();
    scheduleWsReconnect(wsUrl);
  };

  activeWs.onerror = () => {
    if (activeWs) activeWs.close();
  };
}

function scheduleWsReconnect(wsUrl) {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    // Only reconnect if project server is still active
    if (lastLoadedServerInfo && lastLoadedServerInfo.running) {
      connectToGameWebSocket(wsUrl || lastLoadedServerInfo.wsUrl);
    }
  }, 2000);
}

function sendTransformDelta(id, position, rotation, scale, visible = true) {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
  activeWs.send(
    JSON.stringify({
      version: 1,
      type: 'xform',
      id,
      position,
      rotation,
      scale,
      visible
    })
  );
}

// --------------------------------------------------------------------------
// Play Button, Server Launch & Popup
// Requirement: Call window.open('about:blank') synchronously in click handler!
// --------------------------------------------------------------------------
export async function launchGameSession() {
  const projectPath = getActiveProjectPath();
  if (!projectPath) {
    showToast('Please select a project folder first', 'warning');
    return;
  }

  // Detect Godot project: launch natively rather than starting a web server with no index.html
  let isGodot = state.manifest?.engine === 'godot' ||
    (state.manifest?.nodes && state.manifest.nodes.some(n => n.engine === 'godot'));
  if (!isGodot) {
    try {
      const stRes = await fetch(`/dev-server/status?projectPath=${encodeURIComponent(projectPath)}`);
      const st = await stRes.json();
      if (st?.isGodot) isGodot = true;
    } catch (_) {}
  }

  if (isGodot) {
    showToast('Launching Godot game natively (3D web sync is designed for Three.js web games)...', 'info');
    const { playGameInNewTab } = await import('../preview/preview.js');
    await playGameInNewTab();
    return;
  }

  // Synchronously open blank window to avoid popup blocker
  const popup = window.open('about:blank', '_blank');

  showLoadingState('Starting Project Server...');
  clearErrorInStatusBar();

  try {
    const res = await fetch('/modeling/server/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to start game server');
    }

    lastLoadedServerInfo = data;
    const gameUrl = `${data.url}?cf=1`;

    if (popup) {
      popup.location.href = gameUrl;
    }

    // Connect editor to the WebSocket at /cf
    connectToGameWebSocket(data.wsUrl);
    loadCfConfig(); // Load driven-ID config for this project
    showToast(`Game opened at ${data.url}`, 'success');
  } catch (err) {
    if (popup) popup.close();
    hideLoadingState();
    showErrorInStatusBar(`Play failed: ${err.message}`);
    showToast(`Failed to launch game: ${err.message}`, 'error');
  }
}

async function checkActiveServerStatus() {
  const projectPath = getActiveProjectPath();
  updateDisconnectedCard();

  // If editor is not connected to any WebSocket, connect to main ContextForge server at /cf
  if (!activeWs || activeWs.readyState === WebSocket.CLOSED) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    connectToGameWebSocket(`${proto}//${host}/cf?role=editor`);
  }

  if (!projectPath) return;

  try {
    const res = await fetch(`/modeling/server/status?projectPath=${encodeURIComponent(projectPath)}`);
    if (!res.ok) return;
    const data = await res.json();
    lastLoadedServerInfo = data;

    if (data.running && data.wsUrl) {
      connectToGameWebSocket(data.wsUrl);
      loadCfConfig(); // Reload driven-ID config for this project
    }
  } catch (_) {}
}

// --------------------------------------------------------------------------
// Edit Mode vs Play Mode Toggle
// --------------------------------------------------------------------------
export function toggleGameMode() {
  const newMode = currentGameMode === 'edit' ? 'play' : 'edit';
  setGameMode(newMode);
}

export function setGameMode(mode) {
  currentGameMode = mode;
  const toggleBtn = document.getElementById('btn-modeling-mode-toggle');

  if (toggleBtn) {
    // The label states the ACTION the click performs, not the mode already in
    // effect. Labelling it with the current mode ("Edit Mode" while frozen)
    // reads as though clicking enters Edit, when it actually leaves it.
    if (currentGameMode === 'edit') {
      toggleBtn.innerHTML = '▶️ Play Mode';
      toggleBtn.classList.remove('accent');
      toggleBtn.title = 'Currently frozen for editing — click to run the game simulation';
    } else {
      toggleBtn.innerHTML = '✏️ Edit Mode';
      toggleBtn.classList.add('accent');
      toggleBtn.title = 'Currently running — click to freeze the simulation for editing';
    }
  }

  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ version: 1, type: 'set_mode', mode: currentGameMode }));
  }
  showToast(`Switched to ${currentGameMode.toUpperCase()} mode`, 'info');
}

// --------------------------------------------------------------------------
// Selection, Gizmo & Focus ('F')
// --------------------------------------------------------------------------
export function selectObject(id, isMulti = false) {
  if (!id) {
    selectedObjectId = null;
    selectedObjectIds.clear();
    if (transformControls) {
      transformControls.detach();
      transformControls.visible = false;
      transformControls.enabled = false;
    }
    if (boxHelper) boxHelper.visible = false;
    renderInspector();
    updateOutlinerSelection();
    updateStatusBar();
    return;
  }

  const entry = objectMap.get(id);
  if (!entry || !entry.mesh) return;

  if (isMulti) {
    if (selectedObjectIds.has(id)) {
      selectedObjectIds.delete(id);
      if (selectedObjectId === id) {
        selectedObjectId = Array.from(selectedObjectIds).pop() || null;
      }
    } else {
      selectedObjectIds.add(id);
      selectedObjectId = id;
    }
  } else {
    selectedObjectIds.clear();
    selectedObjectIds.add(id);
    selectedObjectId = id;
  }

  const primaryObj = getSelectedObject();
  if (primaryObj && primaryObj.mesh && transformControls) {
    transformControls.attach(primaryObj.mesh);
    const isVis = primaryObj.visible !== false;
    transformControls.visible = isVis;
    transformControls.enabled = isVis;

    if (boxHelper) {
      boxHelper.setFromObject(primaryObj.mesh);
      boxHelper.visible = isVis;
    }

    // If inside collapsed parent groups, expand them so the row exists
    let parent = entry.parentId ? objectMap.get(entry.parentId) : null;
    let expandedAny = false;
    while (parent) {
      if (!parent.isExpanded) {
        parent.isExpanded = true;
        expandedAny = true;
      }
      parent = parent.parentId ? objectMap.get(parent.parentId) : null;
    }
    for (const [prefix, isExp] of prefixGroupExpanded.entries()) {
      if (entry.id.startsWith(prefix) || (entry.rawName && entry.rawName.startsWith(prefix))) {
        if (!isExp) {
          prefixGroupExpanded.set(prefix, true);
          expandedAny = true;
        }
      }
    }
    if (expandedAny) {
      renderOutlinerTree();
    }

    // Scroll selected row into view
    setTimeout(() => {
      const listEl = document.getElementById('modeling-outliner-list');
      if (listEl) {
        const row = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (row) {
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }, 40);
  }

  renderInspector();
  updateOutlinerSelection();
  updateStatusBar();
}

export function focusSelectedObject() {
  const activeObj = getSelectedObject();
  if (!activeObj || !activeObj.mesh || !camera || !controls) {
    autoFrameCamera();
    return;
  }

  const THREE = window.THREE;
  const box = new THREE.Box3().setFromObject(activeObj.mesh);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1.2);
  const fov = camera.fov * (Math.PI / 180);
  const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) / 0.70;

  const direction = camera.position.clone().sub(controls.target).normalize();
  if (direction.lengthSq() < 0.001) direction.set(1, 0.75, 1).normalize();

  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, Math.max(cameraDistance, 2));
  camera.lookAt(center);
  controls.update();

  if (boxHelper) {
    boxHelper.setFromObject(activeObj.mesh);
    boxHelper.update();
  }
}

export function setGizmoMode(mode) {
  currentGizmoMode = mode;
  if (transformControls) {
    transformControls.setMode(mode);
  }
  document.querySelectorAll('#modeling-transform-mode-group .modeling-tool-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-gizmo-mode') === mode);
  });
}

export function toggleGizmoSpace() {
  currentGizmoSpace = currentGizmoSpace === 'world' ? 'local' : 'world';
  if (transformControls) {
    transformControls.setSpace(currentGizmoSpace);
  }
  const btn = document.getElementById('btn-gizmo-space');
  if (btn) {
    btn.innerHTML = currentGizmoSpace === 'world' ? '🌐 World' : '📦 Local';
    btn.title = `Coordinate Space: ${currentGizmoSpace.toUpperCase()} (Q)`;
  }
}

export function setGizmoSnap(enabled, step = currentSnapStep) {
  isSnapEnabled = enabled;
  currentSnapStep = step;
  if (!transformControls) return;

  const THREE = window.THREE;
  if (isSnapEnabled) {
    transformControls.setTranslationSnap(currentSnapStep);
    transformControls.setRotationSnap(THREE.MathUtils.degToRad(currentSnapStep * 15 || 15));
    transformControls.setScaleSnap(currentSnapStep * 0.1 || 0.1);
  } else {
    transformControls.setTranslationSnap(null);
    transformControls.setRotationSnap(null);
    transformControls.setScaleSnap(null);
  }

  const snapBtn = document.getElementById('btn-modeling-snap');
  if (snapBtn) {
    snapBtn.classList.toggle('active', isSnapEnabled);
  }
}

// --------------------------------------------------------------------------
// Outliner Tree View (280px left panel)
// --------------------------------------------------------------------------
let outlinerFilterQuery = '';
let outlinerScrollBound = false;

function getNamePrefix(name) {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  // Match prefix before _01, _1, -01, #1, 01, etc.
  const match = trimmed.match(/^(.*?)[\s_#-]*\d+$/);
  if (match && match[1] && match[1].length >= 2) {
    return match[1].replace(/[\s_#-]+$/, '');
  }
  const hashMatch = trimmed.match(/^(.*?)#\d+$/);
  if (hashMatch && hashMatch[1]) {
    return hashMatch[1];
  }
  return trimmed;
}

function groupSiblings(items) {
  const result = [];
  let i = 0;
  while (i < items.length) {
    const current = items[i];
    const prefix = getNamePrefix(current.displayName);
    let count = 1;
    const group = [current];

    while (
      i + count < items.length &&
      prefix &&
      !/^\d+$/.test(prefix) &&
      getNamePrefix(items[i + count].displayName) === prefix
    ) {
      group.push(items[i + count]);
      count++;
    }

    if (count > 1) {
      const isExpanded = prefixGroupExpanded.get(prefix) || false;
      result.push({
        isPrefixGroup: true,
        prefix,
        displayName: prefix,
        name: prefix,
        type: current.type,
        count,
        items: group,
        id: current.id,
        isExpanded,
        isEnvironment: group.every((g) => g.isEnvironment),
        isUnnamed: group.every((g) => g.isUnnamed),
        visible: group.some((g) => g.visible)
      });
      i += count;
    } else {
      result.push(current);
      i++;
    }
  }
  return result;
}

const SVG_EYE_OPEN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const SVG_EYE_SLASHED = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

function getNodeVisibilityState(entry) {
  if (entry.isPrefixGroup && entry.items) {
    let visCount = 0;
    entry.items.forEach((it) => {
      const state = getNodeVisibilityState(it);
      if (state === 'all-visible') visCount++;
    });
    if (visCount === 0) return 'all-hidden';
    if (visCount === entry.items.length) return 'all-visible';
    return 'partially-hidden';
  }

  if (!entry.children || entry.children.length === 0) {
    return entry.visible !== false ? 'all-visible' : 'all-hidden';
  }

  let totalLeafs = 0;
  let visibleLeafs = 0;

  function countLeafs(node) {
    if (!node.children || node.children.length === 0) {
      totalLeafs++;
      if (node.visible !== false) visibleLeafs++;
      return;
    }
    node.children.forEach(countLeafs);
  }

  entry.children.forEach(countLeafs);

  if (totalLeafs === 0) {
    return entry.visible !== false ? 'all-visible' : 'all-hidden';
  }
  if (visibleLeafs === 0) return 'all-hidden';
  if (visibleLeafs === totalLeafs) return 'all-visible';
  return 'partially-hidden';
}

function setHierarchyVisibility(entry, visible) {
  if (entry.isPrefixGroup && entry.items) {
    entry.items.forEach((it) => setHierarchyVisibility(it, visible));
    return;
  }
  entry.visible = visible;
  if (entry.mesh) entry.mesh.visible = visible;
  if (entry.children && entry.children.length > 0) {
    entry.children.forEach((c) => setHierarchyVisibility(c, visible));
  }
  sendTransformDelta(
    entry.id,
    entry.mesh ? entry.mesh.position.toArray() : [0, 0, 0],
    entry.mesh ? [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z] : [0, 0, 0],
    entry.mesh ? entry.mesh.scale.toArray() : [1, 1, 1],
    visible
  );
  markUnsavedChanges();
}

export function renderOutlinerTree() {
  const listEl = document.getElementById('modeling-outliner-list');
  const countBadge = document.getElementById('modeling-object-count');
  const bannerEl = document.getElementById('modeling-naming-banner');
  const bannerText = document.getElementById('modeling-naming-banner-text');
  if (!listEl) return;

  if (countBadge) {
    countBadge.textContent = `${userObjects.length} objects`;
  }

  // Update yellow warning banner (one banner at top, no per-row icons)
  const unnamedCount = userObjects.filter((o) => o.isUnnamed).length;
  if (bannerEl && bannerText) {
    if (unnamedCount > 0) {
      bannerEl.style.display = 'flex';
      bannerText.textContent = `${unnamedCount} objects have no name. Naming them makes layout saves stable.`;
    } else {
      bannerEl.style.display = 'none';
    }
  }

  if (userObjects.length === 0) {
    listEl.innerHTML = `
      <li style="font-size:0.72rem; color:var(--dim); font-style:italic; padding:12px 10px; text-align:center;">
        No game scene loaded. Press Play to connect.
      </li>
    `;
    return;
  }

  const filter = outlinerFilterQuery.toLowerCase().trim();
  const visibleRows = [];

  function collectRows(entries, depth = 0) {
    const grouped = groupSiblings(entries);
    for (const item of grouped) {
      if (item.isPrefixGroup) {
        if (filterMeshesOnly && item.items.every((it) => it.type !== 'mesh')) continue;
        if (filterNamedOnly && item.isUnnamed) continue;
        if (
          filter &&
          !item.displayName.toLowerCase().includes(filter) &&
          !item.items.some((it) => it.displayName.toLowerCase().includes(filter))
        ) {
          continue;
        }

        // Push group header row
        visibleRows.push({ ...item, depth });

        // If expandable prefix group is open, render individual member rows
        if (item.isExpanded) {
          for (const member of item.items) {
            visibleRows.push({ ...member, depth: depth + 1, isGroupMember: true, groupPrefix: item.prefix });
            if (member.children && member.children.length > 0 && member.isExpanded) {
              collectRows(member.children, depth + 2);
            }
          }
        }
      } else {
        const matchesFilter =
          !filter ||
          item.displayName.toLowerCase().includes(filter) ||
          item.id.toLowerCase().includes(filter);
        const matchesMeshes = !filterMeshesOnly || item.type === 'mesh';
        const matchesNamed = !filterNamedOnly || !item.isUnnamed;

        if (matchesFilter && matchesMeshes && matchesNamed) {
          visibleRows.push({ ...item, depth });
        }

        if (item.children && item.children.length > 0 && item.isExpanded) {
          collectRows(item.children, depth + 1);
        }
      }
    }
  }

  const roots = userObjects.filter((o) => !o.parentId);
  collectRows(roots, 0);

  // Virtualized rendering
  const ROW_HEIGHT = 26;
  function renderVirtualSlice() {
    const scrollTop = listEl.scrollTop || 0;
    const clientHeight = listEl.clientHeight || 400;
    const totalCount = visibleRows.length;

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8);
    const endIdx = Math.min(totalCount, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + 8);

    listEl.innerHTML = '';

    if (startIdx > 0) {
      const topSpacer = document.createElement('li');
      topSpacer.style.height = `${startIdx * ROW_HEIGHT}px`;
      topSpacer.style.listStyle = 'none';
      topSpacer.style.pointerEvents = 'none';
      listEl.appendChild(topSpacer);
    }

    for (let idx = startIdx; idx < endIdx; idx++) {
      const entry = visibleRows[idx];
      const li = document.createElement('li');
      li.className = 'modeling-tree-node';
      li.setAttribute('data-id', entry.id);
      li.style.paddingLeft = `${entry.depth * 14 + 6}px`;
      li.style.height = `${ROW_HEIGHT}px`;
      li.style.boxSizing = 'border-box';

      const isSelected = entry.isPrefixGroup
        ? entry.items.some((i) => i.id === selectedObjectId)
        : entry.id === selectedObjectId;
      const isMultiSelected = entry.isPrefixGroup
        ? entry.items.every((i) => selectedObjectIds.has(i.id))
        : selectedObjectIds.has(entry.id);

      if (isSelected) {
        li.classList.add('selected');
      } else if (isMultiSelected) {
        li.classList.add('multi-selected');
      }

      // Type Icon matching the type
      let typeIcon = '📦';
      if (
        entry.type === 'particles' ||
        entry.id.toLowerCase().includes('particle') ||
        (entry.rawName && entry.rawName.toLowerCase().includes('particle'))
      ) {
        typeIcon = '✨'; // Points icon for particles, not a folder icon
      } else if (entry.type === 'mesh') {
        typeIcon = '🧊';
      } else if (entry.type === 'light') {
        typeIcon = '💡';
      } else if (entry.type === 'camera') {
        typeIcon = '📷';
      } else if (entry.type === 'group' || entry.isPrefixGroup) {
        typeIcon = '📁';
      }

      // Expand/Collapse Chevron (expandable group or parent)
      let chevronHtml = '';
      if (entry.isPrefixGroup) {
        chevronHtml = `<span class="modeling-tree-chevron" style="cursor:pointer; font-size:0.6rem; width:14px; display:inline-block; user-select:none;">${entry.isExpanded ? '▼' : '▶'}</span>`;
      } else if (entry.children && entry.children.length > 0) {
        chevronHtml = `<span class="modeling-tree-chevron" style="cursor:pointer; font-size:0.6rem; width:14px; display:inline-block; user-select:none;">${entry.isExpanded ? '▼' : '▶'}</span>`;
      } else {
        chevronHtml = `<span style="width:14px; display:inline-block;"></span>`;
      }

      // Eye toggle: proper eye icon for hidden state, half-dimmed eye if only some children are hidden
      const visState = getNodeVisibilityState(entry);
      let eyeSvg = SVG_EYE_OPEN;
      let eyeClass = '';
      if (visState === 'all-hidden') {
        eyeSvg = SVG_EYE_SLASHED;
        eyeClass = 'hidden-obj';
      } else if (visState === 'partially-hidden') {
        eyeSvg = SVG_EYE_OPEN;
        eyeClass = 'partially-hidden';
      }

      // Repeat badge if prefix group
      const repeatBadge = entry.isPrefixGroup
        ? `<span class="modeling-repeat-badge" style="font-size:0.68rem; background:rgba(255,255,255,0.08); padding:1px 5px; border-radius:4px; margin-left:4px; color:var(--accent);">×${entry.count}</span>`
        : '';

      li.innerHTML = `
        ${chevronHtml}
        <span class="modeling-tree-icon">${typeIcon}</span>
        <span class="modeling-tree-label" title="${escapeHtml(entry.id)}">${escapeHtml(entry.displayName || entry.name)}</span>
        ${repeatBadge}
        <button type="button" class="modeling-eye-btn ${eyeClass}" title="Toggle Visibility">${eyeSvg}</button>
      `;

      // Chevron click toggles expansion
      const chevronEl = li.querySelector('.modeling-tree-chevron');
      if (chevronEl) {
        chevronEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (entry.isPrefixGroup) {
            entry.isExpanded = !entry.isExpanded;
            prefixGroupExpanded.set(entry.prefix, entry.isExpanded);
          } else {
            entry.isExpanded = !entry.isExpanded;
          }
          renderOutlinerTree();
        });
      }

      // Click handler for selection
      li.addEventListener('click', (e) => {
        if (e.target.closest('.modeling-eye-btn') || e.target.closest('.modeling-tree-chevron')) return;
        if (entry.isPrefixGroup) {
          // Clicking the group selects all of its members
          selectObject(entry.items[0].id, false);
          selectedObjectIds.clear();
          entry.items.forEach((it) => selectedObjectIds.add(it.id));
          updateOutlinerSelection();
          updateStatusBar();
        } else {
          selectObject(entry.id, e.ctrlKey || e.metaKey);
        }
      });

      // Eye toggle handler
      const eyeBtn = li.querySelector('.modeling-eye-btn');
      if (eyeBtn) {
        eyeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetVis = visState !== 'all-visible';
          if (entry.isPrefixGroup) {
            entry.items.forEach((it) => setHierarchyVisibility(it, targetVis));
          } else if (entry.children && entry.children.length > 0) {
            setHierarchyVisibility(entry, targetVis);
          } else {
            toggleObjectVisibility(entry.id);
          }
          renderOutlinerTree();
        });
      }

      listEl.appendChild(li);
    }

    if (totalCount > endIdx) {
      const bottomSpacer = document.createElement('li');
      bottomSpacer.style.height = `${(totalCount - endIdx) * ROW_HEIGHT}px`;
      bottomSpacer.style.listStyle = 'none';
      bottomSpacer.style.pointerEvents = 'none';
      listEl.appendChild(bottomSpacer);
    }
  }

  renderVirtualSlice();

  if (!outlinerScrollBound) {
    outlinerScrollBound = true;
    listEl.addEventListener('scroll', () => {
      renderVirtualSlice();
    });
  }
}

function updateOutlinerSelection() {
  document.querySelectorAll('#modeling-outliner-list .modeling-tree-node').forEach((node) => {
    const id = node.getAttribute('data-id');
    node.classList.toggle('selected', id === selectedObjectId);
    node.classList.toggle('multi-selected', selectedObjectIds.has(id) && id !== selectedObjectId);
  });
}

function toggleObjectVisibility(id) {
  const entry = objectMap.get(id);
  if (!entry || !entry.mesh) return;

  entry.visible = !entry.visible;
  entry.mesh.visible = entry.visible;

  if (selectedObjectId === id && transformControls) {
    transformControls.visible = entry.visible;
    transformControls.enabled = entry.visible;
    if (boxHelper) boxHelper.visible = entry.visible;
  }

  // Send visibility update to game tab
  sendTransformDelta(
    entry.id,
    entry.mesh.position.toArray(),
    [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
    entry.mesh.scale.toArray(),
    entry.visible
  );

  markUnsavedChanges();
  renderOutlinerTree();
}

function setupOutlinerSearch() {
  const searchInput = document.getElementById('modeling-outliner-search');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    outlinerFilterQuery = e.target.value || '';
    renderOutlinerTree();
  });
}

// --------------------------------------------------------------------------
// Right Panel: Inspector (360px)
// Transform fields, Scrub, Reset, Scale Lock, Model, Animation (Phase 3)
// --------------------------------------------------------------------------
function formatNum(num) {
  if (typeof num !== 'number' || isNaN(num)) return '0';
  let fixed = Number(num).toFixed(2);
  fixed = fixed.replace(/(\.[0-9]*[1-9])0+$/, '$1').replace(/\.00$/, '');
  if (fixed === '-0') fixed = '0';
  return fixed;
}

function renderInspector() {
  const formEl = document.getElementById('modeling-inspector-form');
  const badgeEl = document.getElementById('modeling-inspector-id');
  if (!formEl) return;

  const activeObj = getSelectedObject();
  if (!activeObj || !activeObj.mesh) {
    if (badgeEl) badgeEl.textContent = 'None';
    formEl.innerHTML = `
      <div style="padding: 28px 16px; text-align: center;">
        <div style="font-size: 0.85rem; font-weight: 500; color: var(--fg); margin-bottom: 6px;">Select an object to edit</div>
        <div style="font-size: 0.72rem; color: var(--dim); line-height: 1.4;">Click any object in the 3D viewport or scene outliner to inspect and modify its transform.</div>
      </div>
    `;
    return;
  }

  const displayName = activeObj.displayName || activeObj.name;
  if (badgeEl) {
    badgeEl.textContent = displayName;
    badgeEl.title = activeObj.id;
  }

  const THREE = window.THREE;
  const pos = activeObj.mesh.position;
  const rotDeg = {
    x: THREE.MathUtils.radToDeg(activeObj.mesh.rotation.x),
    y: THREE.MathUtils.radToDeg(activeObj.mesh.rotation.y),
    z: THREE.MathUtils.radToDeg(activeObj.mesh.rotation.z)
  };
  const sca = activeObj.mesh.scale;

  // Driven objects: position & rotation are owned by game code
  const driven = isDrivenId(activeObj.id);
  const posRotDisabled = driven ? 'disabled' : '';
  const posRotTitle = driven ? ' title="Position is set by game code"' : '';
  const posRotStyle = driven ? ' style="opacity:0.4; pointer-events:none;"' : '';

  // Update gizmo if driven (no translate/rotate gizmo for driven objects)
  if (driven && (currentGizmoMode === 'translate' || currentGizmoMode === 'rotate')) {
    if (transformControls) {
      transformControls.visible = false;
      transformControls.enabled = false;
    }
  }

  // ---- Model section state ----
  const modelSpec = getModelSpecForEntry(activeObj);
  const modelIsInstanced = isInstancedEntry(activeObj);
  const modelSwapDisabled = modelIsInstanced;
  const modelSwapTooltip = modelIsInstanced ? 'Instanced objects cannot be swapped' : '';
  const modelSwapTooltipNormal = "Replace this object's mesh with a .glb/.gltf (the original is kept, not deleted)";
  // Scale is unavailable for instanced objects.
  const modelScaleDisabled = modelIsInstanced;
  const modelAssetLabel = modelSpec?.path ? modelSpec.path : displayName;
  const modelScaleVal = (typeof modelSpec?.scale === 'number' && isFinite(modelSpec.scale)) ? modelSpec.scale : 1;
  const modelScaleText = modelScaleVal.toFixed(2);
  const modelScaleSlider = scaleToSlider(modelScaleVal);
  const modelOffset = Array.isArray(modelSpec?.offset) ? modelSpec.offset : [0, 0, 0];
  const modelRotation = Array.isArray(modelSpec?.rotation) ? modelSpec.rotation : [0, 0, 0];
  const siblingGlob = siblingGlobIdFor(activeObj.name);
  const modelSiblingsChecked = Boolean(siblingGlob) && (siblingModelWrites.has(activeObj.id) || !!(currentLayout?.objects?.[siblingGlob]?.model));
  const modelWrongUpAxis = Boolean(activeObj.__cfWrongUpAxis);

  // ---- Animation section state ----
  // Clips are loaded async (the gltf may not be parsed yet). While that is in
  // flight we render without a list, then re-render once the clips arrive.
  const animSpec = modelSpec?.animation || null;
  const animPreviewState = getAnimPreviewState(activeObj.id);
  const animCached = animClipCache.get(activeObj.id);
  const animClips = animCached || [];
  const animNoClips = Boolean(animCached && animCached.length === 0);
  const animSkinned = isSkinnedModel(activeObj);

  if (modelSpec?.path && !animCached && !animClipLoading.has(activeObj.id)) {
    animClipLoading.add(activeObj.id);
    loadAnimClipsForEntry(activeObj).then(() => {
      animClipLoading.delete(activeObj.id);
      if (selectedObjectId === activeObj.id) renderInspector();
    }).catch(() => animClipLoading.delete(activeObj.id));
  }

  formEl.innerHTML = `
    <!-- Transform Section -->
    <div class="modeling-inspector-section">
      <div class="modeling-section-subhead">
        <span>Transform</span>
        <button type="button" class="modeling-tool-btn" id="prop-btn-reset-xform" title="Reset all transforms to default (0,0,0 / 1,1,1)">
          ↺ Reset Transform
        </button>
      </div>

      <!-- Position -->
      <div class="modeling-prop-row"${posRotStyle}>
        <span class="modeling-prop-label">Position</span>
        <div class="modeling-vec3-inputs">
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-x" data-scrub-field="posX"${posRotTitle}>X</span>
            <input type="number" step="any" class="modeling-axis-field" id="prop-pos-x" value="${formatNum(pos.x)}"${posRotTitle} ${posRotDisabled}>
          </div>
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-y" data-scrub-field="posY"${posRotTitle}>Y</span>
            <input type="number" step="any" class="modeling-axis-field" id="prop-pos-y" value="${formatNum(pos.y)}"${posRotTitle} ${posRotDisabled}>
          </div>
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-z" data-scrub-field="posZ"${posRotTitle}>Z</span>
            <input type="number" step="any" class="modeling-axis-field" id="prop-pos-z" value="${formatNum(pos.z)}"${posRotTitle} ${posRotDisabled}>
          </div>
        </div>
      </div>

      <!-- Rotation -->
      <div class="modeling-prop-row"${posRotStyle}>
        <span class="modeling-prop-label">Rotation °</span>
        <div class="modeling-vec3-inputs">
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-x" data-scrub-field="rotX"${posRotTitle}>X</span>
            <input type="number" step="any" class="modeling-axis-field" id="prop-rot-x" value="${formatNum(rotDeg.x)}"${posRotTitle} ${posRotDisabled}>
          </div>
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-y" data-scrub-field="rotY"${posRotTitle}>Y</span>
            <input type="number" step="any" class="modeling-axis-field" id="prop-rot-y" value="${formatNum(rotDeg.y)}"${posRotTitle} ${posRotDisabled}>
          </div>
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-z" data-scrub-field="rotZ"${posRotTitle}>Z</span>
            <input type="number" step="any" class="modeling-axis-field" id="prop-rot-z" value="${formatNum(rotDeg.z)}"${posRotTitle} ${posRotDisabled}>
          </div>
        </div>
      </div>


      <!-- Scale -->
      <div class="modeling-prop-row">
        <span class="modeling-prop-label">Scale</span>
        <div class="modeling-vec3-inputs">
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-x" data-scrub-field="scaX" title="Drag to scrub Scale X, double-click to type">X</span>
            <input type="number" step="any" min="0.0001" class="modeling-axis-field" id="prop-scale-x" value="${formatNum(sca.x)}" title="Double-click to type">
          </div>
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-y" data-scrub-field="scaY" title="Drag to scrub Scale Y, double-click to type">Y</span>
            <input type="number" step="any" min="0.0001" class="modeling-axis-field" id="prop-scale-y" value="${formatNum(sca.y)}" title="Double-click to type">
          </div>
          <div class="modeling-axis-input">
            <span class="modeling-axis-label axis-z" data-scrub-field="scaZ" title="Drag to scrub Scale Z, double-click to type">Z</span>
            <input type="number" step="any" min="0.0001" class="modeling-axis-field" id="prop-scale-z" value="${formatNum(sca.z)}" title="Double-click to type">
          </div>
        </div>
      </div>

      <!-- Scale Lock Toggle (ON by default) -->
      <div class="modeling-prop-row" style="justify-content:flex-end;">
        <button type="button" class="modeling-tool-btn ${scaleLockEnabled ? 'active' : ''}" id="btn-scale-lock" title="Lock uniform scale proportion (ON by default)">
          ${scaleLockEnabled ? '🔒 Proportional Scale (ON)' : '🔓 Scale Independent'}
        </button>
      </div>
    </div>

    <!-- Model Section -->
    <div class="modeling-inspector-section" id="modeling-model-section">
      <div class="modeling-section-subhead">
        <span>Model</span>
        <span id="model-tri-count" style="font-size:0.68rem;color:var(--dim);"></span>
      </div>

      <div class="modeling-prop-row">
        <span class="modeling-prop-label">Asset:</span>
        <span id="prop-model-asset" style="font-family:monospace; font-size:0.72rem; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(modelAssetLabel)}">
          ${escapeHtml(modelAssetLabel)}
        </span>
      </div>

      <div class="modeling-prop-row">
        <span class="modeling-prop-label">Fit:</span>
        <select class="modeling-select" id="prop-fit-select" ${modelSwapDisabled ? 'disabled' : ''}>
          <option value="fit-bounds" ${modelSpec?.fit !== 'keep-size' ? 'selected' : ''}>Fit bounds</option>
          <option value="keep-size" ${modelSpec?.fit === 'keep-size' ? 'selected' : ''}>Keep size</option>
        </select>
      </div>

      <div class="modeling-prop-row" style="flex-direction:column;align-items:stretch;gap:5px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="modeling-prop-label">Scale:</span>
          <input type="number" id="prop-model-scale-num" step="0.05" min="0.1" max="10"
            value="${modelScaleText}"
            ${modelScaleDisabled ? 'disabled' : ''}
            style="width:72px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 5px;font-size:0.72rem;" />
        </div>
        <input type="range" id="prop-model-scale" min="0" max="1000" step="1"
          value="${modelScaleSlider}"
          ${modelScaleDisabled ? 'disabled' : ''}
          title="0.1x to 10x (logarithmic)" />
      </div>

      <div class="modeling-prop-row" style="flex-direction:column;align-items:stretch;gap:5px;">
        <span class="modeling-prop-label">Offset:</span>
        <div style="display:flex;gap:5px;">
          <input type="number" class="modeling-axis-field" id="prop-model-off-x" step="0.05" value="${modelOffset[0]}" ${modelScaleDisabled ? 'disabled' : ''} title="Offset X" />
          <input type="number" class="modeling-axis-field" id="prop-model-off-y" step="0.05" value="${modelOffset[1]}" ${modelScaleDisabled ? 'disabled' : ''} title="Offset Y" />
          <input type="number" class="modeling-axis-field" id="prop-model-off-z" step="0.05" value="${modelOffset[2]}" ${modelScaleDisabled ? 'disabled' : ''} title="Offset Z" />
        </div>
      </div>

      <div class="modeling-prop-row" style="flex-direction:column;align-items:stretch;gap:5px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="modeling-prop-label">Rotation Y:</span>
          <input type="number" id="prop-model-rot-y" step="1" min="0" max="360" value="${modelRotation[1]}"
            ${modelScaleDisabled ? 'disabled' : ''}
            style="width:72px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 5px;font-size:0.72rem;" />
        </div>
        <input type="range" id="prop-model-rot-y-slider" min="0" max="360" step="1" value="${modelRotation[1]}"
          ${modelScaleDisabled ? 'disabled' : ''} />
      </div>

      <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;">
        <button type="button" class="modeling-tool-btn" id="prop-btn-swap"
          title="${modelSwapDisabled ? modelSwapTooltip : modelSwapTooltipNormal}"
          ${modelSwapDisabled ? 'disabled' : ''}>
          🔄 Swap Model
        </button>
        <button type="button" class="modeling-tool-btn" id="prop-btn-fix-upaxis"
          title="The model's up axis looks wrong (height is smaller than width and length). Rotate it 90°."
          style="display:${modelWrongUpAxis ? 'block' : 'none'};">
          ⟳ Rotate 90° to fix up-axis
        </button>
        <button type="button" class="modeling-tool-btn" id="prop-btn-refit-model"
          title="Re-derive the fit-bounds reference from the original geometry (the reference is normally cached once)"
          ${modelScaleDisabled || !modelSpec ? 'disabled' : ''}>
          ⤢ Refit
        </button>
        <button type="button" class="modeling-tool-btn" id="prop-btn-reset-model"
          title="Remove the swapped model and show the original again"
          ${modelSwapDisabled ? 'disabled' : ''}>
          ↺ Reset to Original
        </button>
      </div>

      <div class="modeling-prop-row" style="margin-top:10px;">
        <label style="display:flex;align-items:center;gap:7px;cursor:${siblingGlob ? 'pointer' : 'not-allowed'};font-size:0.75rem;color:var(--dim);">
          <input type="checkbox" id="prop-model-siblings" ${siblingGlob ? '' : 'disabled'} ${modelSiblingsChecked ? 'checked' : ''}
            title="${siblingGlob ? `Apply this model to every ${siblingGlob} object` : 'Only numbered sibling families (e.g. Kart_AI_*) support this'}">
          Apply to all matching siblings
        </label>
      </div>
      ${siblingGlob ? `<div style="font-size:0.68rem;color:var(--dim);margin-top:3px;">Writes to <code>${escapeHtml(siblingGlob)}</code> in layout.json</div>` : ''}

      <!-- Driven by game code toggle -->
      <div class="modeling-prop-row" style="margin-top:10px;">
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.75rem;color:var(--dim);">
          <input type="checkbox" id="prop-driven-toggle" ${driven ? 'checked' : ''}
            title="When ON, game code sets position &amp; rotation — only scale &amp; visibility are editable">
          Driven by game code
        </label>
      </div>
    </div>

    <!-- Animation Section -->
    <div class="modeling-inspector-section" id="modeling-anim-section">
      <div class="modeling-section-subhead">
        <span>Animation</span>
        <span id="anim-clip-count" style="font-size:0.68rem;color:var(--dim);"></span>
      </div>

      ${!modelSpec?.path
        ? `<div style="font-size:0.72rem;color:var(--dim);font-style:italic;">Swap a model first to animate it.</div>`
        : animNoClips
        ? `<div class="modeling-anim-note" id="anim-note-noclips">No animations in this file</div>`
        : !animSkinned
        ? `<div class="modeling-anim-note" id="anim-note-nosskin">Not skinned: only object-level clips can play</div>`
        : ''}

      ${modelSpec?.path && !animNoClips ? `
        <div class="modeling-prop-row" style="flex-direction:column;align-items:stretch;gap:4px;margin-top:4px;">
          <span class="modeling-prop-label">Clips:</span>
          <div id="anim-clip-list" style="display:flex;flex-direction:column;gap:3px;max-height:150px;overflow-y:auto;">
            ${(animClips.length ? animClips : []).map((c) => `
              <button type="button" class="modeling-tool-btn anim-clip-item ${animPreviewState?.current === c.name ? 'active' : ''}"
                data-clip="${escapeHtml(c.name)}"
                style="justify-content:space-between;font-size:0.72rem;${animPreviewState?.current === c.name ? 'border-color:var(--accent);' : ''}"
                title="Preview this clip in the editor (does not affect the game)">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name)}</span>
                <span style="color:var(--dim);font-size:0.66rem;flex-shrink:0;margin-left:6px;">${c.duration.toFixed(2)}s · ${c.tracks} tracks</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="modeling-prop-row" style="flex-direction:column;align-items:stretch;gap:5px;margin-top:8px;">
          <div style="display:flex;gap:5px;align-items:center;">
            <button type="button" class="modeling-tool-btn" id="prop-anim-playpause" title="Play / pause the preview"
              style="flex:1;">${animPreviewState?.playing ? '❚❚ Pause' : '▶ Play'}</button>
            <button type="button" class="modeling-tool-btn" id="prop-anim-stop" title="Stop and rewind the preview" style="flex:1;">■ Stop</button>
          </div>
          <input type="range" id="prop-anim-scrub" min="0" max="1000" step="1"
            value="${animPreviewState && animPreviewState.duration ? Math.round((animPreviewState.time / animPreviewState.duration) * 1000) : 0}"
            ${!animPreviewState ? 'disabled' : ''} title="Scrub through the clip" />
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span id="prop-anim-time" style="font-size:0.68rem;color:var(--dim);font-family:monospace;">
              ${animPreviewState ? `${animPreviewState.time.toFixed(2)}s / ${animPreviewState.duration.toFixed(2)}s` : '0.00s / 0.00s'}
            </span>
            <div style="display:flex;align-items:center;gap:5px;">
              <label style="display:flex;align-items:center;gap:4px;font-size:0.7rem;color:var(--dim);cursor:pointer;">
                Loop
                <input type="checkbox" id="prop-anim-loop" ${animPreviewState?.loop !== false ? 'checked' : ''} />
              </label>
              <input type="number" id="prop-anim-speed" step="0.1" min="0.1" max="3"
                value="${animPreviewState?.speed ?? 1}"
                style="width:56px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:0.7rem;"
                title="Playback speed, 0.1x to 3x" />
            </div>
          </div>
        </div>

        <div class="modeling-prop-row" style="margin-top:10px;">
          <span class="modeling-prop-label">Idle clip:</span>
          <select class="modeling-select" id="prop-anim-idle">
            <option value="">None</option>
            ${animClips.map((c) => `<option value="${escapeHtml(c.name)}" ${animSpec?.bindings?.idle === c.name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="modeling-prop-row" style="margin-top:5px;">
          <span class="modeling-prop-label">Move clip:</span>
          <select class="modeling-select" id="prop-anim-move">
            <option value="">None</option>
            ${animClips.map((c) => `<option value="${escapeHtml(c.name)}" ${animSpec?.bindings?.move === c.name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="modeling-prop-row" style="margin-top:5px;">
          <span class="modeling-prop-label">Crossfade:</span>
          <input type="number" class="modeling-axis-field" id="prop-anim-crossfade" step="0.05" min="0" max="3"
            value="${animSpec?.crossfade ?? 0.2}" title="Seconds to blend between clips" />
          <span style="color:var(--dim);font-size:0.68rem;">s</span>
        </div>
        <div class="modeling-prop-row" style="margin-top:8px;">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:0.75rem;color:var(--dim);">
            <input type="checkbox" id="prop-anim-auto" ${animSpec ? (animSpec.auto !== false) : true} checked
              title="Pick Idle or Move automatically from how fast the object is moving (enter move at 0.5 u/s, leave at 0.3 u/s)">
            Auto state
          </label>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;">
          <button type="button" class="modeling-tool-btn" id="prop-anim-play-in-game"
            title="Send these animation settings to the running game">
            ▶ Play in game
          </button>
          <button type="button" class="modeling-tool-btn" id="prop-anim-open-blender"
            title="Open this model file in Blender">
            🧊 Open in Blender
          </button>
          <div style="font-size:0.66rem;color:var(--dim);line-height:1.35;">
            Export as glTF Binary with Animation and Skinning enabled.
          </div>
        </div>
      ` : ''}
    </div>

    <!-- Hidden compatibility button for test -->
    <div style="display:none;">
      <button type="button" id="prop-btn-save-code"></button>
    </div>
  `;

  bindInspectorInputHandlers(activeObj);
  bindAnimationInspectorHandlers(activeObj);
}

export function syncInspectorFromTransform() {
  const activeObj = getSelectedObject();
  if (!activeObj || !activeObj.mesh) return;

  const THREE = window.THREE;
  const pos = activeObj.mesh.position;
  const rot = activeObj.mesh.rotation;
  const sca = activeObj.mesh.scale;

  const posX = document.getElementById('prop-pos-x');
  const posY = document.getElementById('prop-pos-y');
  const posZ = document.getElementById('prop-pos-z');
  if (posX) posX.value = formatNum(pos.x);
  if (posY) posY.value = formatNum(pos.y);
  if (posZ) posZ.value = formatNum(pos.z);

  const rotX = document.getElementById('prop-rot-x');
  const rotY = document.getElementById('prop-rot-y');
  const rotZ = document.getElementById('prop-rot-z');
  if (rotX) rotX.value = formatNum(THREE.MathUtils.radToDeg(rot.x));
  if (rotY) rotY.value = formatNum(THREE.MathUtils.radToDeg(rot.y));
  if (rotZ) rotZ.value = formatNum(THREE.MathUtils.radToDeg(rot.z));

  const scaX = document.getElementById('prop-scale-x');
  const scaY = document.getElementById('prop-scale-y');
  const scaZ = document.getElementById('prop-scale-z');
  if (scaX) scaX.value = formatNum(sca.x);
  if (scaY) scaY.value = formatNum(sca.y);
  if (scaZ) scaZ.value = formatNum(sca.z);
}

function bindInspectorInputHandlers(entry) {
  const THREE = window.THREE;

  function commitInputTransform(oldState) {
    entry.mesh.updateMatrixWorld(true);
    if (boxHelper) boxHelper.update();
    const nextState = {
      position: entry.mesh.position.toArray(),
      rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
      scale: entry.mesh.scale.toArray()
    };
    modifiedObjectIds.add(entry.id);
    pushUndoAction({ id: entry.id, prev: oldState, next: nextState });
    markUnsavedChanges();
    sendTransformDelta(entry.id, nextState.position, nextState.rotation, nextState.scale, entry.visible);
  }

  const scrubFieldToInputId = {
    posX: 'prop-pos-x',
    posY: 'prop-pos-y',
    posZ: 'prop-pos-z',
    rotX: 'prop-rot-x',
    rotY: 'prop-rot-y',
    rotZ: 'prop-rot-z',
    scaX: 'prop-scale-x',
    scaY: 'prop-scale-y',
    scaZ: 'prop-scale-z'
  };

  // Double-click to type on inputs (and select all text)
  ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-x', 'scale-y', 'scale-z'].forEach((fKey) => {
    const input = document.getElementById(`prop-${fKey}`);
    if (!input) return;

    input.addEventListener('dblclick', () => {
      input.focus();
      input.select();
    });

    input.addEventListener('focus', () => {
      input.select();
    });

    input.addEventListener('change', () => {
      const oldState = {
        position: entry.mesh.position.toArray(),
        rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
        scale: entry.mesh.scale.toArray()
      };

      if (fKey.startsWith('pos-')) {
        const x = parseFloat(document.getElementById('prop-pos-x')?.value) || 0;
        const y = parseFloat(document.getElementById('prop-pos-y')?.value) || 0;
        const z = parseFloat(document.getElementById('prop-pos-z')?.value) || 0;
        entry.mesh.position.set(x, y, z);
      } else if (fKey.startsWith('rot-')) {
        const x = THREE.MathUtils.degToRad(parseFloat(document.getElementById('prop-rot-x')?.value) || 0);
        const y = THREE.MathUtils.degToRad(parseFloat(document.getElementById('prop-rot-y')?.value) || 0);
        const z = THREE.MathUtils.degToRad(parseFloat(document.getElementById('prop-rot-z')?.value) || 0);
        entry.mesh.rotation.set(x, y, z);
      } else if (fKey.startsWith('scale-')) {
        let x = parseFloat(document.getElementById('prop-scale-x')?.value) || 1;
        let y = parseFloat(document.getElementById('prop-scale-y')?.value) || 1;
        let z = parseFloat(document.getElementById('prop-scale-z')?.value) || 1;

        if (scaleLockEnabled) {
          const oldX = oldState.scale[0] || 1;
          const ratio = x / oldX;
          y = oldState.scale[1] * ratio;
          z = oldState.scale[2] * ratio;
        }
        entry.mesh.scale.set(x, y, z);
        syncInspectorFromTransform();
      }

      commitInputTransform(oldState);
    });
  });

  // Drag the X/Y/Z letter to scrub, double-click to type
  document.querySelectorAll('[data-scrub-field]').forEach((label) => {
    const fieldKey = label.getAttribute('data-scrub-field');
    const inputId = scrubFieldToInputId[fieldKey];
    const targetInput = document.getElementById(inputId);

    label.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (targetInput) {
        targetInput.focus();
        targetInput.select();
      }
    });

    let startX = 0;
    let initialVal = 0;
    let startTransform = null;

    const onMouseMove = (e) => {
      const delta = (e.clientX - startX) * 0.05;
      const isRot = fieldKey.startsWith('rot');
      const stepMult = isRot ? 1.0 : 0.05;
      const newVal = initialVal + (e.clientX - startX) * stepMult;

      if (fieldKey === 'posX') entry.mesh.position.x = newVal;
      else if (fieldKey === 'posY') entry.mesh.position.y = newVal;
      else if (fieldKey === 'posZ') entry.mesh.position.z = newVal;
      else if (fieldKey === 'rotX') entry.mesh.rotation.x = THREE.MathUtils.degToRad(newVal);
      else if (fieldKey === 'rotY') entry.mesh.rotation.y = THREE.MathUtils.degToRad(newVal);
      else if (fieldKey === 'rotZ') entry.mesh.rotation.z = THREE.MathUtils.degToRad(newVal);
      else if (fieldKey === 'scaX') {
        const s = Math.max(0.001, newVal);
        if (scaleLockEnabled && startTransform.scale[0] > 0) {
          const ratio = s / startTransform.scale[0];
          entry.mesh.scale.set(s, startTransform.scale[1] * ratio, startTransform.scale[2] * ratio);
        } else {
          entry.mesh.scale.x = s;
        }
      } else if (fieldKey === 'scaY') {
        const s = Math.max(0.001, newVal);
        if (scaleLockEnabled && startTransform.scale[1] > 0) {
          const ratio = s / startTransform.scale[1];
          entry.mesh.scale.set(startTransform.scale[0] * ratio, s, startTransform.scale[2] * ratio);
        } else {
          entry.mesh.scale.y = s;
        }
      } else if (fieldKey === 'scaZ') {
        const s = Math.max(0.001, newVal);
        if (scaleLockEnabled && startTransform.scale[2] > 0) {
          const ratio = s / startTransform.scale[2];
          entry.mesh.scale.set(startTransform.scale[0] * ratio, startTransform.scale[1] * ratio, s);
        } else {
          entry.mesh.scale.z = s;
        }
      }
      syncInspectorFromTransform();
      entry.mesh.updateMatrixWorld(true);
      if (boxHelper) boxHelper.update();

      // Throttled live broadcast
      sendTransformDelta(
        entry.id,
        entry.mesh.position.toArray(),
        [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
        entry.mesh.scale.toArray(),
        entry.visible
      );
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      if (startTransform) {
        commitInputTransform(startTransform);
      }
    };

    label.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startTransform = {
        position: entry.mesh.position.toArray(),
        rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
        scale: entry.mesh.scale.toArray()
      };

      if (fieldKey === 'posX') initialVal = entry.mesh.position.x;
      else if (fieldKey === 'posY') initialVal = entry.mesh.position.y;
      else if (fieldKey === 'posZ') initialVal = entry.mesh.position.z;
      else if (fieldKey === 'rotX') initialVal = THREE.MathUtils.radToDeg(entry.mesh.rotation.x);
      else if (fieldKey === 'rotY') initialVal = THREE.MathUtils.radToDeg(entry.mesh.rotation.y);
      else if (fieldKey === 'rotZ') initialVal = THREE.MathUtils.radToDeg(entry.mesh.rotation.z);
      else if (fieldKey === 'scaX') initialVal = entry.mesh.scale.x;
      else if (fieldKey === 'scaY') initialVal = entry.mesh.scale.y;
      else if (fieldKey === 'scaZ') initialVal = entry.mesh.scale.z;

      document.body.style.cursor = 'ew-resize';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  });

  // Per-field reset buttons
  document.querySelectorAll('[data-reset-axis]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const axis = btn.getAttribute('data-reset-axis');
      const oldState = {
        position: entry.mesh.position.toArray(),
        rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
        scale: entry.mesh.scale.toArray()
      };

      if (axis === 'posX') entry.mesh.position.x = 0;
      else if (axis === 'posY') entry.mesh.position.y = 0;
      else if (axis === 'posZ') entry.mesh.position.z = 0;
      else if (axis === 'rotX') entry.mesh.rotation.x = 0;
      else if (axis === 'rotY') entry.mesh.rotation.y = 0;
      else if (axis === 'rotZ') entry.mesh.rotation.z = 0;
      else if (axis === 'scaX') entry.mesh.scale.x = 1;
      else if (axis === 'scaY') entry.mesh.scale.y = 1;
      else if (axis === 'scaZ') entry.mesh.scale.z = 1;

      syncInspectorFromTransform();
      commitInputTransform(oldState);
    });
  });

  // Scale lock toggle button
  const scaleLockBtn = document.getElementById('btn-scale-lock');
  if (scaleLockBtn) {
    scaleLockBtn.addEventListener('click', () => {
      scaleLockEnabled = !scaleLockEnabled;
      scaleLockBtn.classList.toggle('active', scaleLockEnabled);
      scaleLockBtn.innerHTML = scaleLockEnabled ? '🔒 Proportional Scale (ON)' : '🔓 Scale Independent';
    });
  }

  // Reset all transform button
  const resetAllBtn = document.getElementById('prop-btn-reset-xform');
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      const oldState = {
        position: entry.mesh.position.toArray(),
        rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
        scale: entry.mesh.scale.toArray()
      };
      entry.mesh.position.set(0, 0, 0);
      entry.mesh.rotation.set(0, 0, 0);
      entry.mesh.scale.set(1, 1, 1);
      syncInspectorFromTransform();
      commitInputTransform(oldState);
    });
  }

  // "Driven by game code" toggle — adds/removes name pattern in config.drivenIds
  const drivenToggle = document.getElementById('prop-driven-toggle');
  if (drivenToggle) {
    drivenToggle.addEventListener('change', async () => {
      const id = entry.id;
      const segments = id.split('/');
      const lastName = segments[segments.length - 1];
      // Use the last segment as the pattern (with wildcard for numbered siblings if desired)
      const pattern = lastName;
      const newConfig = { ...cfConfig, drivenIds: [...(cfConfig.drivenIds || [])] };

      if (drivenToggle.checked) {
        // Add pattern if not already present
        if (!newConfig.drivenIds.includes(pattern)) {
          newConfig.drivenIds.push(pattern);
        }
      } else {
        // Remove exact pattern
        newConfig.drivenIds = newConfig.drivenIds.filter((p) => p !== pattern && p !== id);
      }

      await saveCfConfig(newConfig);
      // Re-render inspector to reflect new driven state
      renderInspector();
    });
  }

  bindModelInspectorHandlers(entry);
}

/** Wires the Model section controls (swap, fit, scale, offset, rotation, reset). */
function bindModelInspectorHandlers(entry) {
  const fileInput = document.getElementById('model-swap-file-input');
  const swapBtn = document.getElementById('prop-btn-swap');
  const resetBtn = document.getElementById('prop-btn-reset-model');
  const fitSelect = document.getElementById('prop-fit-select');
  const scaleSlider = document.getElementById('prop-model-scale');
  const scaleNum = document.getElementById('prop-model-scale-num');
  const offX = document.getElementById('prop-model-off-x');
  const offY = document.getElementById('prop-model-off-y');
  const offZ = document.getElementById('prop-model-off-z');
  const rotY = document.getElementById('prop-model-rot-y');
  const rotYSlider = document.getElementById('prop-model-rot-y-slider');
  const fixUpBtn = document.getElementById('prop-btn-fix-upaxis');
  const siblingsBox = document.getElementById('prop-model-siblings');

  if (swapBtn && fileInput) {
    swapBtn.addEventListener('click', () => fileInput.click());
  }

  if (fileInput) {
    fileInput.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ''; // allow re-picking the same file
      if (!file) return;
      const useSiblings = Boolean(siblingsBox && siblingsBox.checked);
      const fit = fitSelect ? fitSelect.value : 'fit-bounds';
      const res = await swapSelectedModel(file, { siblings: useSiblings, fit });
      if (res && typeof res === 'object') {
        entry.__cfWrongUpAxis = Boolean(res.wrongUpAxis);
        showToast(`Model swapped (${res.triangles.toLocaleString()} triangles)`, 'success');
      }
      renderInspector();
    };
  }

  if (fitSelect) {
    fitSelect.addEventListener('change', () => {
      updateModelParam(entry.id, 'fit', fitSelect.value, { siblings: siblingModelWrites.has(entry.id) });
    });
  }

  if (scaleSlider) {
    scaleSlider.addEventListener('input', () => {
      const v = sliderToScale(Number(scaleSlider.value));
      if (scaleNum) scaleNum.value = v.toFixed(2);
      updateModelParam(entry.id, 'scale', Number(v.toFixed(4)), { siblings: siblingModelWrites.has(entry.id) });
    });
  }
  if (scaleNum) {
    const commit = () => {
      let v = parseFloat(scaleNum.value);
      if (!isFinite(v)) v = 1;
      v = Math.min(MODEL_SCALE_MAX, Math.max(MODEL_SCALE_MIN, v));
      scaleNum.value = v.toFixed(2);
      if (scaleSlider) scaleSlider.value = String(scaleToSlider(v));
      updateModelParam(entry.id, 'scale', v, { siblings: siblingModelWrites.has(entry.id) });
    };
    scaleNum.addEventListener('change', commit);
  }

  const commitOffset = () => {
    const arr = [
      parseFloat(offX?.value) || 0,
      parseFloat(offY?.value) || 0,
      parseFloat(offZ?.value) || 0
    ];
    updateModelParam(entry.id, 'offset', arr, { siblings: siblingModelWrites.has(entry.id) });
  };
  [offX, offY, offZ].forEach((el) => el && el.addEventListener('change', commitOffset));

  const commitRotY = () => {
    const spec = getModelSpecForEntry(entry);
    const rot = Array.isArray(spec?.rotation) ? [...spec.rotation] : [0, 0, 0];
    rot[1] = Math.min(360, Math.max(0, parseFloat(rotY?.value) || 0));
    updateModelParam(entry.id, 'rotation', rot, { siblings: siblingModelWrites.has(entry.id) });
  };
  if (rotY) rotY.addEventListener('change', commitRotY);
  if (rotYSlider) {
    rotYSlider.addEventListener('input', () => {
      if (rotY) rotY.value = rotYSlider.value;
      commitRotY();
    });
  }

  const refitBtn = document.getElementById('prop-btn-refit-model');
  if (refitBtn) {
    refitBtn.addEventListener('click', async () => {
      // Drop the cached reference on both sides, then re-apply unchanged.
      if (entry.mesh && entry.mesh.userData) delete entry.mesh.userData.cfRefBox;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ version: 1, type: 'refit', id: entry.id }));
      }
      const spec = getModelSpecForEntry(entry);
      if (spec) {
        const withFlag = { ...spec, __refit: true };
        await applyModelToEntry(entry, withFlag);
        entry.model = withFlag;
        modelStateStore.set(entry.id, withFlag);
        markUnsavedChanges();
        renderInspector();
      }
      showToast('Re-fitted model to the original bounds', 'info');
    });
  }

  if (fixUpBtn) {
    fixUpBtn.addEventListener('click', async () => {
      await fixModelUpAxis(entry.id);
      entry.__cfWrongUpAxis = false;
      renderInspector();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (resetSelectedModel()) {
        entry.__cfWrongUpAxis = false;
        showToast('Model reset to original', 'info');
      }
      renderInspector();
    });
  }

  if (siblingsBox) {
    siblingsBox.addEventListener('change', () => {
      // Turning the checkbox on re-applies the current model to all siblings.
      if (siblingsBox.checked && getModelSpecForEntry(entry)) {
        const glob = siblingGlobIdFor(entry.name);
        if (glob) {
          userObjects.forEach((e) => {
            if (e.id === entry.id || isInstancedEntry(e)) return;
            if (matchesPatternGlob(e.name, glob) || matchesPatternGlob(e.id, glob)) {
              e.model = getModelSpecForEntry(entry);
              applyModelToEntry(e, getModelSpecForEntry(entry));
            }
          });
          if (currentLayout && currentLayout.objects) {
            currentLayout.objects[glob] = { ...(currentLayout.objects[glob] || {}), model: getModelSpecForEntry(entry) };
          }
        }
      }
    });
  }
}

function setupInspectorEvents() {
  // Empty initial setup
}

// --------------------------------------------------------------------------
// Undo / Redo System
// --------------------------------------------------------------------------
function pushUndoAction(action) {
  undoStack.push(action);
  redoStack.length = 0; // Clear redo stack on new action
  updateUndoRedoButtons();
}

export function undo() {
  if (undoStack.length === 0) return;
  const action = undoStack.pop();
  const entry = objectMap.get(action.id);

  if (action.type === 'model') {
    applyModelUndoAction(action, 'undo');
  } else if (entry && entry.mesh) {
    entry.mesh.position.fromArray(action.prev.position);
    entry.mesh.rotation.set(action.prev.rotation[0], action.prev.rotation[1], action.prev.rotation[2]);
    entry.mesh.scale.fromArray(action.prev.scale);
    entry.mesh.updateMatrixWorld(true);

    if (boxHelper) boxHelper.update();
    if (selectedObjectId === action.id) {
      syncInspectorFromTransform();
    }

    sendTransformDelta(action.id, action.prev.position, action.prev.rotation, action.prev.scale, entry.visible);
  }

  redoStack.push(action);
  markUnsavedChanges();
  updateUndoRedoButtons();
  showToast(`Undo: reverted ${entry ? entry.name : action.id}`, 'info');
}

export function redo() {
  if (redoStack.length === 0) return;
  const action = redoStack.pop();
  const entry = objectMap.get(action.id);

  if (action.type === 'model') {
    applyModelUndoAction(action, 'redo');
  } else if (entry && entry.mesh) {
    entry.mesh.position.fromArray(action.next.position);
    entry.mesh.rotation.set(action.next.rotation[0], action.next.rotation[1], action.next.rotation[2]);
    entry.mesh.scale.fromArray(action.next.scale);
    entry.mesh.updateMatrixWorld(true);

    if (boxHelper) boxHelper.update();
    if (selectedObjectId === action.id) {
      syncInspectorFromTransform();
    }

    sendTransformDelta(action.id, action.next.position, action.next.rotation, action.next.scale, entry.visible);
  }

  undoStack.push(action);
  markUnsavedChanges();
  updateUndoRedoButtons();
  showToast(`Redo: restored ${entry ? entry.name : action.id}`, 'info');
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-modeling-undo');
  const redoBtn = document.getElementById('btn-modeling-redo');

  if (undoBtn) {
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.title = undoStack.length > 0 ? `Undo last edit (${undoStack.length} in stack) [Ctrl+Z]` : 'Nothing to undo';
  }
  if (redoBtn) {
    redoBtn.disabled = redoStack.length === 0;
    redoBtn.title = redoStack.length > 0 ? `Redo edit (${redoStack.length} in stack) [Ctrl+Y]` : 'Nothing to redo';
  }
}

// --------------------------------------------------------------------------
// Save & Load Layout
// Format: {version:1, objects:{[id]:{position:[x,y,z], rotation:[x,y,z], scale:[x,y,z], visible:bool, ...}}}
// --------------------------------------------------------------------------
export async function saveLayout() {
  const projectPath = getActiveProjectPath();
  if (!projectPath) {
    showToast('No project selected to save layout', 'warning');
    return;
  }

  // Retain existing valid non-path overrides
  const objectsRecord = {};
  if (currentLayout && currentLayout.objects) {
    for (const [id, val] of Object.entries(currentLayout.objects)) {
      if (!id.startsWith('path:')) {
        objectsRecord[id] = val;
      }
    }
  }

  // Save all explicitly modified objects
  modifiedObjectIds.forEach((id) => {
    const entry = objectMap.get(id);
    if (!entry || !entry.mesh) return;
    objectsRecord[entry.id] = {
      position: entry.mesh.position.toArray(),
      rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
      scale: entry.mesh.scale.toArray(),
      visible: entry.visible !== false
    };
  });

  // Persist every swapped model, including ids whose scene entry was rebuilt
  // by a live snapshot after the swap. The one-shot __refit and the __v
  // cache-buster are runtime state and must never reach layout.json.
  const persistableModel = (spec) => {
    if (!spec) return spec;
    const { __refit, __v, ...rest } = spec;
    return rest;
  };
  modelStateStore.forEach((spec, id) => {
    if (!objectsRecord[id]) objectsRecord[id] = { visible: true };
    objectsRecord[id].model = persistableModel(spec);
  });
  // Sibling glob writes (e.g. Coin_*) go in under their glob id.
  siblingModelWrites.forEach((spec, id) => {
    const glob = siblingGlobIdFor(objectMap.get(id)?.name);
    if (glob) objectsRecord[glob] = { ...(objectsRecord[glob] || {}), model: persistableModel(spec) };
  });

  // If no objects were explicitly modified in this session, but an object is currently selected, save it
  if (modifiedObjectIds.size === 0 && selectedObjectId) {
    const entry = objectMap.get(selectedObjectId);
    if (entry && entry.mesh) {
      objectsRecord[entry.id] = {
        position: entry.mesh.position.toArray(),
        rotation: [entry.mesh.rotation.x, entry.mesh.rotation.y, entry.mesh.rotation.z],
        scale: entry.mesh.scale.toArray(),
        visible: entry.visible !== false
      };
    }
  }

  // Driven objects: strip position and rotation — game code owns those
  let drivenStripped = 0;
  for (const [id, data] of Object.entries(objectsRecord)) {
    if (isDrivenId(id)) {
      if (data.position !== undefined) { delete data.position; drivenStripped++; }
      if (data.rotation !== undefined) { delete data.rotation; drivenStripped++; }
    }
  }
  if (drivenStripped > 0) {
    showToast(`Stripped position/rotation from ${drivenStripped} driven object field(s)`, 'info');
  }

  const layoutPayload = {
    version: 1,
    objects: objectsRecord
  };

  try {
    const res = await fetch('/modeling/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, layout: layoutPayload })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to save layout');
    }

    currentLayout = layoutPayload;
    clearUnsavedChanges();
    showToast('Layout saved to contextforge/layout.json', 'success');
  } catch (err) {
    showErrorInStatusBar(`Save failed: ${err.message}`);
    showToast(`Failed to save layout: ${err.message}`, 'error');
  }
}

async function loadAndApplyLayoutToScene() {
  const projectPath = getActiveProjectPath();
  if (!projectPath) return;

  try {
    const res = await fetch(`/modeling/layout?projectPath=${encodeURIComponent(projectPath)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.layout && data.layout.objects) {
      currentLayout = data.layout;

      // Drop old path:N keys by dropping them and showing a status-bar note
      let droppedCount = 0;
      for (const k of Object.keys(currentLayout.objects)) {
        if (k.startsWith('path:')) {
          delete currentLayout.objects[k];
          droppedCount++;
        }
      }

      if (droppedCount > 0) {
        showMigrationNoteInStatusBar(`Migrated layout: dropped ${droppedCount} legacy path-based keys`);
        showToast(`Migrated layout: dropped ${droppedCount} legacy path:N keys`, 'info');
        // Persist cleaned layout
        fetch('/modeling/layout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath, layout: currentLayout })
        }).catch(() => {});
      }

      applyLayoutToIndexedObjects(currentLayout);
    }
  } catch (_) {}
}

function showMigrationNoteInStatusBar(noteText) {
  const item = document.getElementById('modeling-status-migration');
  const textEl = document.getElementById('status-migration-text');
  if (item && textEl) {
    textEl.textContent = noteText;
    item.style.display = 'flex';
  }
}

function applyLayoutToIndexedObjects(layout) {
  if (!layout || !layout.objects) return;
  appliedModels.clear();
  for (const [id, val] of Object.entries(layout.objects)) {
    // A glob id (Kart_AI_*) applies to every matching object in the scene.
    let targets = [];
    if (id.includes('*')) {
      const glob = siblingGlobIdFor(id.replace(/\*$/, '0')) || id;
      targets = userObjects.filter((e) =>
        matchesPatternGlob(e.name, glob) || matchesPatternGlob(e.id, glob) || matchesPatternGlob(e.id, id)
      );
    } else {
      const entry = objectMap.get(id);
      if (entry) targets = [entry];
    }

    for (const entry of targets) {
      if (!entry || !entry.mesh) continue;

      if (Array.isArray(val.position)) entry.mesh.position.fromArray(val.position);
      if (Array.isArray(val.rotation)) entry.mesh.rotation.set(val.rotation[0], val.rotation[1], val.rotation[2]);
      if (Array.isArray(val.scale)) entry.mesh.scale.fromArray(val.scale);
      if (typeof val.visible === 'boolean') {
        entry.visible = val.visible;
        entry.mesh.visible = val.visible;
      }
      if (val.model) {
        if (isInstancedEntry(entry)) continue;
        entry.model = val.model;
        applyModelToEntry(entry, val.model);
      }
      entry.mesh.updateMatrixWorld(true);
    }
  }
}

function markUnsavedChanges() {
  hasUnsavedChanges = true;
  const saveBtn = document.getElementById('btn-modeling-save');
  const dot = document.getElementById('modeling-save-dot');
  const unsavedText = document.getElementById('status-unsaved-text');

  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.title = 'Save layout changes to contextforge/layout.json (Ctrl+S)';
  }
  if (dot) dot.style.display = 'inline-block';
  if (unsavedText) {
    unsavedText.textContent = '● Unsaved changes';
    unsavedText.parentElement.classList.add('unsaved');
  }
}

function clearUnsavedChanges() {
  hasUnsavedChanges = false;
  const saveBtn = document.getElementById('btn-modeling-save');
  const dot = document.getElementById('modeling-save-dot');
  const unsavedText = document.getElementById('status-unsaved-text');

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.title = 'No unsaved changes to save';
  }
  if (dot) dot.style.display = 'none';
  if (unsavedText) {
    unsavedText.textContent = '✓ All changes saved';
    unsavedText.parentElement.classList.remove('unsaved');
  }
}

// --------------------------------------------------------------------------
// Install Hook Feature with Unified Diff Modal
// --------------------------------------------------------------------------
export async function showInstallHookModal() {
  const projectPath = getActiveProjectPath();
  if (!projectPath) {
    showToast('Please select a project folder first', 'warning');
    return;
  }

  showLoadingState('Checking hook status in main.js...');
  try {
    const res = await fetch('/modeling/hook/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath })
    });
    const data = await res.json();
    hideLoadingState();

    if (data.installed) {
      showToast(`ContextForge runtime hook is already installed in ${data.targetFile}!`, 'success');
      return;
    }

    renderDiffModal(data);
  } catch (err) {
    hideLoadingState();
    showToast(`Failed to check hook: ${err.message}`, 'error');
  }
}

function renderDiffModal(diffData) {
  let modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'modeling-modal-backdrop';
  backdrop.id = 'modeling-diff-modal';

  backdrop.innerHTML = `
    <div class="modeling-modal-content">
      <div class="modeling-modal-header">
        <span class="modeling-modal-title">⚡ Install ContextForge Runtime Hook</span>
        <button type="button" class="modeling-tool-btn" id="btn-modal-close" style="height:22px; padding:0 6px;">✕</button>
      </div>
      <div class="modeling-modal-body">
        <p style="margin-bottom:10px; color:var(--text);">
          To enable live 3D scene editing, ContextForge will copy <code>contextforge/runtime.js</code> into your project and inject the hook call into <code>${escapeHtml(diffData.targetFile)}</code> before the game loop starts.
        </p>
        <p style="margin-bottom:8px; font-weight:600; color:var(--dim);">Proposed Diff:</p>
        <div class="diff-preview-box">${escapeHtml(diffData.diff)}</div>
      </div>
      <div class="modeling-modal-footer">
        <button type="button" class="modeling-tool-btn" id="btn-modal-cancel">Cancel</button>
        <button type="button" class="modeling-tool-btn primary" id="btn-modal-confirm">Confirm & Install Hook</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
  };

  backdrop.querySelector('#btn-modal-close').addEventListener('click', close);
  backdrop.querySelector('#btn-modal-cancel').addEventListener('click', close);

  backdrop.querySelector('#btn-modal-confirm').addEventListener('click', async () => {
    const confirmBtn = backdrop.querySelector('#btn-modal-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Installing...';

    try {
      const res = await fetch('/modeling/hook/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: getActiveProjectPath() })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Installation failed');
      }

      close();
      showToast(`ContextForge runtime installed in ${data.targetFile}!`, 'success');
    } catch (err) {
      showToast(`Install failed: ${err.message}`, 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm & Install Hook';
    }
  });
}

// --------------------------------------------------------------------------
// UI Events, Toolbars & Viewport Interactions
// --------------------------------------------------------------------------
function setupToolbarEvents() {
  // Play
  document.getElementById('btn-modeling-play')?.addEventListener('click', launchGameSession);
  document.getElementById('btn-card-play')?.addEventListener('click', launchGameSession);

  // Install Hook
  document.getElementById('btn-modeling-install-hook')?.addEventListener('click', () => {
    const moreMenu = document.getElementById('modeling-more-menu');
    if (moreMenu) moreMenu.style.display = 'none';
    showInstallHookModal();
  });
  document.getElementById('btn-card-install-hook')?.addEventListener('click', showInstallHookModal);

  // Mode Toggle
  document.getElementById('btn-modeling-mode-toggle')?.addEventListener('click', toggleGameMode);

  // Gizmo Modes
  document.getElementById('btn-gizmo-translate')?.addEventListener('click', () => setGizmoMode('translate'));
  document.getElementById('btn-gizmo-rotate')?.addEventListener('click', () => setGizmoMode('rotate'));
  document.getElementById('btn-gizmo-scale')?.addEventListener('click', () => setGizmoMode('scale'));

  // Coordinate Space
  document.getElementById('btn-gizmo-space')?.addEventListener('click', toggleGizmoSpace);

  // Snapping
  const snapBtn = document.getElementById('btn-modeling-snap');
  const snapStepInput = document.getElementById('modeling-snap-step');

  if (snapBtn) {
    snapBtn.addEventListener('click', () => {
      setGizmoSnap(!isSnapEnabled, currentSnapStep);
    });
  }

  if (snapStepInput) {
    snapStepInput.addEventListener('change', (e) => {
      const val = parseFloat(e.target.value) || 0.5;
      setGizmoSnap(isSnapEnabled, val);
    });
  }

  // Environment Toggle (default OFF)
  const envBtn = document.getElementById('btn-modeling-env');
  if (envBtn) {
    envBtn.addEventListener('click', () => {
      toggleEnvironment();
      envBtn.classList.toggle('active', showEnvironment);
    });
  }

  // Wireframe Toggle
  const wireframeBtn = document.getElementById('btn-modeling-wireframe');
  if (wireframeBtn) {
    wireframeBtn.addEventListener('click', () => {
      toggleWireframe();
      wireframeBtn.classList.toggle('active', isWireframeActive);
    });
  }

  // Frame All
  const frameAllBtn = document.getElementById('btn-modeling-frame-all');
  if (frameAllBtn) {
    frameAllBtn.addEventListener('click', () => {
      frameAll();
    });
  }

  // More Menu (⋯)
  const moreBtn = document.getElementById('btn-modeling-more');
  const moreMenu = document.getElementById('modeling-more-menu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = moreMenu.style.display === 'none' || !moreMenu.style.display;
      moreMenu.style.display = isHidden ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => {
      if (!moreBtn.contains(e.target) && !moreMenu.contains(e.target)) {
        moreMenu.style.display = 'none';
      }
    });
  }

  // Outliner Filter Chips
  const chipMeshes = document.getElementById('chip-meshes-only');
  if (chipMeshes) {
    chipMeshes.addEventListener('click', () => {
      filterMeshesOnly = !filterMeshesOnly;
      chipMeshes.classList.toggle('active', filterMeshesOnly);
      renderOutlinerTree();
    });
  }

  const chipNamed = document.getElementById('chip-named-only');
  if (chipNamed) {
    chipNamed.addEventListener('click', () => {
      filterNamedOnly = !filterNamedOnly;
      chipNamed.classList.toggle('active', filterNamedOnly);
      renderOutlinerTree();
    });
  }

  // Copy Naming Prompt Button in Outliner Banner
  const copyNamingBtn = document.getElementById('btn-copy-naming-prompt');
  if (copyNamingBtn) {
    copyNamingBtn.addEventListener('click', () => {
      const promptText = `Please update the Three.js objects in this project so that every Mesh and Group has a unique, descriptive .name property (e.g. mesh.name = 'KartBody', 'Wheel_FL', 'TrackGround', 'Tree_Oak_01'). Naming all objects ensures layouts and properties can be stably identified and saved in ContextForge.`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(promptText).then(() => {
          showToast('Naming prompt copied to clipboard!', 'success');
        }).catch(() => {
          showToast('Failed to copy to clipboard', 'error');
        });
      } else {
        showToast('Clipboard not available', 'error');
      }
    });
  }

  // Undo / Redo
  document.getElementById('btn-modeling-undo')?.addEventListener('click', undo);
  document.getElementById('btn-modeling-redo')?.addEventListener('click', redo);

  // Resync
  document.getElementById('btn-modeling-resync')?.addEventListener('click', () => {
    if (moreMenu) moreMenu.style.display = 'none';
    requestGameSceneSync();
  });
  document.getElementById('btn-model-sync-game')?.addEventListener('click', requestGameSceneSync);

  // "Scene changed — Resync" status-bar button
  document.getElementById('btn-scene-changed-resync')?.addEventListener('click', () => {
    requestGameSceneSync();
  });

  // Settings modal (Blender path, etc.)
  document.getElementById('btn-modeling-settings')?.addEventListener('click', () => {
    if (moreMenu) moreMenu.style.display = 'none';
    openSettingsModal();
  });

  // Save
  document.getElementById('btn-modeling-save')?.addEventListener('click', saveLayout);

  // Viewport Overlay buttons
  const gridBtn = document.getElementById('btn-model-toggle-grid');
  if (gridBtn) {
    gridBtn.addEventListener('click', () => {
      if (gridHelper) {
        gridHelper.visible = !gridHelper.visible;
        gridBtn.classList.toggle('active', gridHelper.visible);
      }
    });
  }

  const focusBtn = document.getElementById('btn-model-focus');
  if (focusBtn) {
    focusBtn.addEventListener('click', focusSelectedObject);
  }
}

function setupViewportEvents(canvas, viewport) {
  // Raycast click to select
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // Only left click selects
    if (wasTransformDragging || isTransformDragging) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(userGroup.children, true);

    if (intersects.length > 0) {
      let picked = intersects[0].object;
      // Walk up to first recognized user object
      while (picked && picked !== userGroup && !objectMap.has(picked.userData?.cfId) && !objectMap.has(picked.name)) {
        picked = picked.parent;
      }
      if (picked && picked !== userGroup) {
        const id = picked.userData?.cfId || picked.name || computeObjectId(picked, userGroup);
        selectObject(id, e.ctrlKey || e.metaKey);
        return;
      }
    }

    if (!e.ctrlKey && !e.metaKey) {
      selectObject(null);
    }
  });
}

export function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // Ignore when typing in an input
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const container = document.getElementById('modeling-container');
    if (!container || container.style.display === 'none') return;

    // Ctrl+S: Save Layout
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveLayout();
      return;
    }

    // Ctrl+Z: Undo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }

    // Ctrl+Y or Ctrl+Shift+Z: Redo
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redo();
      return;
    }

    // W: Translate
    if (e.key.toLowerCase() === 'w') {
      setGizmoMode('translate');
    }
    // E: Rotate
    else if (e.key.toLowerCase() === 'e') {
      setGizmoMode('rotate');
    }
    // R: Scale
    else if (e.key.toLowerCase() === 'r') {
      setGizmoMode('scale');
    }
    // Q: Coordinate space
    else if (e.key.toLowerCase() === 'q') {
      toggleGizmoSpace();
    }
    // F: Focus selected
    else if (e.key.toLowerCase() === 'f') {
      focusSelectedObject();
    }
  });
}

// --------------------------------------------------------------------------
// Status Bar & Pill Helpers
// --------------------------------------------------------------------------
function setConnectionPill(status) {
  const pill = document.getElementById('modeling-conn-pill');
  const text = document.getElementById('modeling-conn-text');
  if (!pill || !text) return;

  pill.className = `conn-pill ${status}`;
  if (status === 'connected') {
    text.textContent = 'Connected';
    pill.title = 'Game session active and live over WebSocket';
  } else if (status === 'connecting') {
    text.textContent = 'Connecting...';
    pill.title = 'Connecting to game WebSocket...';
  } else {
    text.textContent = 'No Game';
    pill.title = 'No active game session connected. Press Play to start.';
  }
}

function updateStatusBar() {
  const countEl = document.getElementById('status-objcount-text');
  const selectedEl = document.getElementById('status-selected-text');

  if (countEl) {
    if (lastBuiltCount > 0 || lastSkippedCount > 0) {
      countEl.textContent = `${lastBuiltCount} built (${lastSkippedCount} env/skipped)`;
    } else {
      countEl.textContent = `${userObjects.length} objects`;
    }
  }
  if (selectedEl) {
    const activeObj = getSelectedObject();
    if (activeObj) {
      const name = activeObj.displayName || activeObj.name;
      selectedEl.textContent = `Selected: ${name}`;
    } else if (selectedObjectIds.size > 1) {
      selectedEl.textContent = `Selected: ${selectedObjectIds.size} objects`;
    } else {
      selectedEl.textContent = 'Selected: None';
    }
  }
}

function showErrorInStatusBar(errText) {
  const errorItem = document.getElementById('modeling-status-error');
  const errorTextEl = document.getElementById('status-error-text');
  if (errorItem && errorTextEl) {
    errorItem.style.display = 'flex';
    errorTextEl.textContent = errText;
  }
}

function clearErrorInStatusBar() {
  const errorItem = document.getElementById('modeling-status-error');
  if (errorItem) errorItem.style.display = 'none';
}

function updateDisconnectedCard() {
  const card = document.getElementById('modeling-disconnected-card');
  const pathEl = document.getElementById('modeling-card-project-path');
  const descEl = card?.querySelector('.modeling-card-desc');
  const btnInstall = document.getElementById('btn-card-install-hook');

  const p = getActiveProjectPath();
  if (pathEl) {
    pathEl.textContent = p || 'No project selected';
  }
  if (card) {
    card.style.display = isGameConnected ? 'none' : 'flex';
  }

  const isGodot = state.manifest?.engine === 'godot' ||
    (state.manifest?.nodes && state.manifest.nodes.some(n => n.engine === 'godot'));

  if (isGodot) {
    if (descEl) {
      descEl.innerHTML = `<strong>Native Godot Project</strong><br>Press <strong>▶ Play</strong> to run your Godot game natively. Note: 3D live viewport synchronization (<code>?cf=1</code>) is designed for Three.js web games.`;
    }
    if (btnInstall) {
      btnInstall.style.display = 'none';
    }
  } else {
    if (descEl) {
      descEl.innerHTML = `Press <strong>▶ Play</strong> in the toolbar above to launch the game with the ContextForge runtime (<code>?cf=1</code>) to inspect and edit 3D objects live.`;
    }
    if (btnInstall) {
      btnInstall.style.display = 'inline-flex';
    }
  }
}

function showLoadingState(title = 'Loading...') {
  const overlay = document.getElementById('modeling-loading-overlay');
  const titleEl = document.getElementById('modeling-loading-title');
  if (overlay) {
    overlay.style.display = 'flex';
  }
  if (titleEl) {
    titleEl.textContent = title;
  }
}

function hideLoadingState() {
  const overlay = document.getElementById('modeling-loading-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

function updateUIState() {
  updateDisconnectedCard();
  updateStatusBar();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --------------------------------------------------------------------------
// Backward-Compatibility Exports for Existing Test Suite
// --------------------------------------------------------------------------
export function addObject(type, customName = null, meshInstance = null) {
  return null;
}
export function removeObject(id) {}
export function clearAllObjects() {}
export function populateProjectAssets() {}
export function broadcastTransformUpdate(obj) {
  if (!obj) return;
  sendTransformDelta(
    obj.id,
    obj.mesh.position.toArray(),
    [obj.mesh.rotation.x, obj.mesh.rotation.y, obj.mesh.rotation.z],
    obj.mesh.scale.toArray(),
    obj.visible
  );
}
export function getGizmoMode() { return currentGizmoMode; }
export function getGizmoSpace() { return currentGizmoSpace; }
export function disposeHierarchy(root) {
  if (!root) return;
  root.traverse?.((node) => {
    if (node.geometry && typeof node.geometry.dispose === 'function') {
      node.geometry.dispose();
    }
    if (node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach((m) => {
        if (typeof m.dispose === 'function') m.dispose();
      });
    }
  });
}
// --------------------------------------------------------------------------
// Phase 2 — Model Swap (non-destructive)
//
// The original object is never deleted. Swapping hides the original's visual
// children (game code keeps animating them) and attaches the new mesh as a
// child named CF_Model. Reset removes CF_Model and restores visibility.
// --------------------------------------------------------------------------
const CF_MODEL_NAME = 'CF_Model';

// Logarithmic scale slider mapping: 0.1x .. 10x
const MODEL_SCALE_MIN = 0.1;
const MODEL_SCALE_MAX = 10;
function sliderToScale(v) {
  const t = Math.min(1, Math.max(0, v / 1000));
  return MODEL_SCALE_MIN * Math.pow(MODEL_SCALE_MAX / MODEL_SCALE_MIN, t);
}
function scaleToSlider(s) {
  const clamped = Math.min(MODEL_SCALE_MAX, Math.max(MODEL_SCALE_MIN, s || 1));
  return Math.round((Math.log(clamped / MODEL_SCALE_MIN) / Math.log(MODEL_SCALE_MAX / MODEL_SCALE_MIN)) * 1000);
}

// relative path -> Promise<gltf>, so each file is fetched and parsed once.
const modelCache = new Map();
// id -> applied model spec, so we do not rebuild every frame.
const appliedModels = new Map();
// Durable id -> spec. The editor receives periodic live snapshots that rebuild
// the scene and drop per-entry state, so model choices are kept here instead.
const modelStateStore = new Map();
// Object ids whose model came from a sibling glob write (so Save keeps it).
let siblingModelWrites = new Map();

function modelSpecSignature(spec) {
  if (!spec) return 'null';
  // refit and __v are one-shot/runtime flags; they must change the signature so
  // Refit re-derives and a cache-busted reload actually rebuilds.
  return JSON.stringify([
    spec.path, spec.fit, spec.scale, spec.offset, spec.rotation,
    !!spec.__refit, spec.__v || null,
    spec.animation ? JSON.stringify(spec.animation) : null
  ]);
}

function reportEditorModelError(message) {
  showErrorInStatusBar(`Model: ${message}`);
}

function clearEditorModelError() {
  clearErrorInStatusBar();
}

/** True when the object is an InstancedMesh (swap and scale are not available). */
function isInstancedEntry(entry) {
  return Boolean(entry && entry.mesh && entry.mesh.isInstancedMesh);
}

/**
 * A name like "Kart_AI_2", "Coin_0", "ItemBox_3" is a numbered sibling family.
 * Returns the glob id (e.g. "Kart_AI_*") or null.
 */
function siblingGlobIdFor(name) {
  if (!name) return null;
  const m = String(name).match(/^(.*)_\d+$/);
  if (!m || !m[1]) return null;
  return `${m[1]}_*`;
}

function resolveModelUrl(relPath, version) {
  // Model files live in the target project, not in the editor's own static root.
  // ContextForge serves them through the project server on /project-raw-file.
  // `version` appends ?v=<mtime> so a changed file is re-fetched, not cached.
  const bust = version ? `&v=${encodeURIComponent(version)}` : '';
  const projectPath = getActiveProjectPath();
  if (projectPath) {
    return `/project-raw-file?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(relPath)}${bust}`;
  }
  const base = new URL(String(relPath).replace(/^\//, ''), window.location.href).href;
  return version ? `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}` : base;
}

function loadGltfOnce(relPath, version) {
  const key = version ? `${relPath}?v=${version}` : relPath;
  if (modelCache.has(key)) return modelCache.get(key);
  const p = (async () => {
    const loader = new window.THREE.GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.load(resolveModelUrl(relPath, version), resolve, undefined, (err) => {
        reject(new Error(`failed to load "${relPath}" (${err?.message || 'load error'})`));
      });
    });
  })();
  p.catch(() => modelCache.delete(key));
  modelCache.set(key, p);
  return p;
}

function cloneGltfScene(gltf) {
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) throw new Error('model contains no scene');
  const SU = window.THREE.SkeletonUtils || window.SkeletonUtils;
  if (SU && typeof SU.clone === 'function' && (gltf.animations?.length || hasSkin(root))) {
    return SU.clone(root);
  }
  return root.clone(true);
}

function hasSkin(obj) {
  let found = false;
  obj.traverse((n) => { if (n.isSkinnedMesh) found = true; });
  return found;
}

function setShadowsDeep(obj) {
  obj.traverse((n) => {
    if (n.isMesh) {
      n.castShadow = true;
      n.receiveShadow = true;
      // A skinned mesh animates its vertices on the GPU, so its CPU-side bounds
      // go stale and it gets culled. Disable culling for those.
      if (n.isSkinnedMesh) n.frustumCulled = false;
    }
  });
}

function countTriangles(obj) {
  let tris = 0;
  obj.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    const g = n.geometry;
    const c = g.index ? g.index.count : (g.attributes?.position?.count || 0);
    tris += Math.floor(c / 3);
  });
  return tris;
}

/** True when the model looks like it is lying down (height is the smallest axis). */
function looksLikeWrongUpAxis(obj) {
  const THREE = window.THREE;
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x < 1e-6 || size.y < 1e-6 || size.z < 1e-6) return false;
  return size.y < size.x && size.y < size.z;
}

function centerAndScaleModel(newModel, targetBox) {
  // Keeps the historical export contract: returns the model, transformed so its
  // pivot is at the bottom centre of its box and (optionally) fit to the target.
  const THREE = window.THREE;
  const box = new THREE.Box3().setFromObject(newModel);
  const size = new THREE.Vector3();
  box.getSize(size);

  if (targetBox) {
    const tSize = new THREE.Vector3();
    targetBox.getSize(tSize);
    const cand = [];
    if (size.y > 1e-6) cand.push(tSize.y / size.y);
    if (size.x > 1e-6) cand.push(tSize.x / size.x);
    if (size.z > 1e-6) cand.push(tSize.z / size.z);
    const u = cand.length ? Math.min(...cand) : 1;
    if (isFinite(u) && u > 0) newModel.scale.setScalar(u);
  }

  const box2 = new THREE.Box3().setFromObject(newModel);
  const min2 = box2.min, max2 = box2.max;
  newModel.position.set(-(min2.x + max2.x) / 2, -min2.y, -(min2.z + max2.z) / 2);
  newModel.updateMatrixWorld(true);
  return newModel;
}

/** Applies a model spec to one scene object, non-destructively. */
async function applyModelToEntry(entry, spec) {
  const THREE = window.THREE;
  const host = entry.mesh;
  if (!host) return false;

  const sig = modelSpecSignature(spec);
  if (appliedModels.get(entry.id) === sig) return true;
  appliedModels.delete(entry.id);

  if (!spec || !spec.path) {
    removeCFModelFromHost(host);
    restoreOriginalVisibility(host);
    return true;
  }

  if (isInstancedEntry(entry)) {
    reportEditorModelError('Instanced objects cannot be swapped');
    return false;
  }

  // Remove any previous CF_Model before adding the new one. Without this a
  // re-apply (hot reload, or changing a param after a swap) leaves the old
  // model in the graph, and getObjectByName keeps returning the stale copy.
  removeCFModelFromHost(host);

  let gltf, cloned;
  try {
    gltf = await loadGltfOnce(spec.path, spec.__v);
    cloned = cloneGltfScene(gltf);
  } catch (err) {
    removeCFModelFromHost(host);
    restoreOriginalVisibility(host);
    reportEditorModelError(`${entry.id}: ${err.message}`);
    return false;
  }

  setShadowsDeep(cloned);
  placeModelForSpec(cloned, host, spec);
  cloned.name = CF_MODEL_NAME;
  cloned.userData.__cfModel = true;

  hideOriginalVisuals(host);
  host.add(cloned);
  host.updateMatrixWorld(true);

  const tris = countTriangles(cloned);
  if (tris > 200000) {
    showErrorInStatusBar(
      `⚠ "${spec.path}" has ${tris.toLocaleString()} triangles (over 200k) — the game may run slowly`
    );
  }
  appliedModels.set(entry.id, sig);

  // Report the clip list so the Animation section can populate immediately, and
  // prime the preview mixer's actions.
  const clips = (gltf.animations || []).map((c) => ({
    name: c.name, duration: c.duration, tracks: c.tracks.length
  }));
  animClipCache.set(entry.id, clips);
  ensureAnimPreviewActions(entry, gltf.animations || []);

  return {
    triangles: tris,
    wrongUpAxis: looksLikeWrongUpAxis(cloned),
    clips,
    skinned: isSkinnedModel(entry)
  };
}

/** Creates one preview action per clip for an entry's CF_Model. */
function ensureAnimPreviewActions(entry, glips) {
  const p = ensureAnimPreview(entry);
  if (!p) return;
  p.clips = (glips || []).map((c) => ({ name: c.name, duration: c.duration, tracks: c.tracks.length }));
  for (const c of (glips || [])) {
    if (p.actions.has(c.name)) continue;
    const a = p.mixer.clipAction(new window.THREE.AnimationClip(c.name, c.duration, c.tracks, c.blendMode));
    a.enabled = true;
    a.setLoop(window.THREE.LoopRepeat, Infinity);
    p.actions.set(c.name, a);
  }
}

// Name fragments identifying non-body parts (wheels, driver, particles, ...).
// These must not influence the fit-bounds reference box.
const NON_BODY_NAME_PARTS = [
  'wheel', 'tire', 'tyre', 'hub', 'spoke', 'driver', 'shadow', 'puff', 'smoke',
  'particle', 'exhaust', 'glow', 'spark', 'dust', 'trail', 'starring'
];

function isNonBodyPart(node) {
  const n = String(node.name || '').toLowerCase();
  if (!n) return false;
  for (const part of NON_BODY_NAME_PARTS) if (n.includes(part)) return true;
  return false;
}

/**
 * True when `node` sits inside a non-body subtree. Checking only the node's own
 * name is not enough: driver limbs are named "Headgear_Cap", "Arm_0" etc., so the
 * whole Kart_Driver group must be excluded, not just its root.
 */
function isInsideNonBodySubtree(node, hostObj) {
  let cur = node;
  while (cur && cur !== hostObj) {
    if (isNonBodyPart(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Reference box for fit-bounds, in the host's LOCAL space, from the original's
 * own visual children only (no CF_Model, nothing hidden by a swap, no
 * wheels/driver/particles). The host's translation is removed so the reference
 * does not move when the object drives around. Cached on userData.cfRefBox;
 * only re-derived on a fit-mode change or Refit.
 */
function computeRefBox(hostObj) {
  const THREE = window.THREE;
  hostObj.updateMatrixWorld(true);

  const hostLocal = new THREE.Matrix4().copy(hostObj.matrixWorld);
  hostLocal.setPosition(0, 0, 0);
  const invHostLocal = new THREE.Matrix4().copy(hostLocal).invert();

  const box = new THREE.Box3();
  const partBox = new THREE.Box3();
  let any = false;

  hostObj.traverse((node) => {
    if (node === hostObj) return;
    if (node.name === CF_MODEL_NAME) return;
    if (node.userData && node.userData.__cfHiddenByModel) return;
    if (isInsideNonBodySubtree(node, hostObj)) return;
    if (!node.isMesh && !node.isPoints && !node.isLine && !node.isSprite) return;
    const geom = node.geometry;
    if (!geom) return;
    if (geom.boundingBox === null) geom.computeBoundingBox();
    const gb = geom.boundingBox;
    if (!gb || !isFinite(gb.min.x) || !isFinite(gb.max.x)) return;

    partBox.copy(gb).applyMatrix4(node.matrixWorld).applyMatrix4(invHostLocal);
    if (!any) { box.copy(partBox); any = true; } else box.union(partBox);
  });

  if (!any) {
    box.setFromObject(hostObj);
    box.max.set(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    box.min.set(0, 0, 0);
  }
  // Size reference only: re-origin to the host so the cached value carries no
  // world position and stays comparable across loads.
  box.max.sub(box.min);
  box.min.set(0, 0, 0);
  return box;
}

function getRefBox(hostObj, forceRecompute = false) {
  const THREE = window.THREE;
  const ud = hostObj.userData || (hostObj.userData = {});
  if (forceRecompute || !ud.cfRefBox) {
    const b = computeRefBox(hostObj);
    ud.cfRefBox = { min: b.min.toArray(), max: b.max.toArray() };
  }
  const r = ud.cfRefBox;
  return new THREE.Box3(
    new THREE.Vector3(r.min[0], r.min[1], r.min[2]),
    new THREE.Vector3(r.max[0], r.max[1], r.max[2])
  );
}

function placeModelForSpec(modelRoot, hostObj, spec) {
  const THREE = window.THREE;
  const fit = spec.fit === 'keep-size' ? 'keep-size' : 'fit-bounds';
  let uniform = 1;

  if (fit === 'fit-bounds') {
    // Stable cached reference, so the scale does not drift as the object moves.
    const origBox = getRefBox(hostObj, spec.__refit === true);
    const origSize = new THREE.Vector3();
    origBox.getSize(origSize);
    const b = new THREE.Box3().setFromObject(modelRoot);
    const s = new THREE.Vector3();
    b.getSize(s);
    const cand = [];
    if (s.y > 1e-6) cand.push(origSize.y / s.y);
    if (s.x > 1e-6) cand.push(origSize.x / s.x);
    if (s.z > 1e-6) cand.push(origSize.z / s.z);
    uniform = cand.length ? Math.min(...cand) : 1;
    if (!isFinite(uniform) || uniform <= 0) uniform = 1;
  }

  const userScale = (typeof spec.scale === 'number' && isFinite(spec.scale) && spec.scale > 0) ? spec.scale : 1;
  const total = uniform * userScale;
  modelRoot.scale.setScalar(total);

  const b2 = new THREE.Box3().setFromObject(modelRoot);
  const min = b2.min.clone();
  const max = b2.max.clone();

  const off = Array.isArray(spec.offset) ? spec.offset : [0, 0, 0];
  modelRoot.position.set(
    (min.x + max.x) / 2 - off[0] * total,
    -min.y - off[1] * total,
    (min.z + max.z) / 2 - off[2] * total
  );
  const rot = Array.isArray(spec.rotation) ? spec.rotation : [0, 0, 0];
  modelRoot.rotation.set(
    THREE.MathUtils.degToRad(rot[0] || 0),
    THREE.MathUtils.degToRad(rot[1] || 0),
    THREE.MathUtils.degToRad(rot[2] || 0)
  );
  modelRoot.updateMatrixWorld(true);
  return { uniform, total };
}

function removeCFModelFromHost(host) {
  const existing = host.getObjectByName(CF_MODEL_NAME);
  if (existing) {
    host.remove(existing);
    try { disposeHierarchy(existing); } catch (_) {}
  }
}

function hideOriginalVisuals(host) {
  host.traverse((n) => {
    if (n.name === CF_MODEL_NAME) return;
    if (n.isMesh || n.isPoints || n.isLine || n.isSprite) {
      if (!n.userData.__cfHiddenByModel) n.userData.__cfHiddenByModel = true;
      n.visible = false;
    }
  });
}

function restoreOriginalVisibility(host) {
  host.traverse((n) => {
    if (n.userData.__cfHiddenByModel) {
      n.visible = true;
      delete n.userData.__cfHiddenByModel;
    }
  });
}

// --------------------------------------------------------------------------
// Animation (editor side)
//
// The editor's preview is entirely local: its own AnimationMixer over the
// editor's own CF_Model clone. It never writes to the layout and never touches
// the game, which keeps its own independent mixers. The only time the game is
// told anything is when the user presses "Play in game".
// --------------------------------------------------------------------------

// entryId -> { mixer, root, actions:Map, clips:[], current, playing, time, speed, loop }
const animPreview = new Map();
let animPreviewClock = null;
// entryId -> clip descriptors, so the inspector can render without re-parsing.
const animClipCache = new Map();
// entry ids currently fetching their clip list, to avoid duplicate loads.
const animClipLoading = new Set();

function disposeAnimPreview(entryId) {
  const p = animPreview.get(entryId);
  if (!p) return;
  try { p.mixer.stopAllAction(); p.mixer.uncacheRoot(p.root); } catch (_) {}
  animPreview.delete(entryId);
  stopAnimPreviewClock();
}

function stopAnimPreviewClock() {
  if (animPreviewClock) { clearInterval(animPreviewClock); animPreviewClock = null; }
}

function startAnimPreviewClock() {
  if (animPreviewClock) return;
  animPreviewClock = setInterval(tickAnimPreview, 33); // ~30 fps is plenty
}

/**
 * Creates (or reuses) the preview mixer for an entry's CF_Model.
 * Returns { clips, mixer, actions } so the inspector can list and drive clips.
 */
function ensureAnimPreview(entry) {
  if (!entry || !entry.mesh) return null;
  const cf = entry.mesh.getObjectByName(CF_MODEL_NAME);
  if (!cf) { disposeAnimPreview(entry.id); return null; }

  let p = animPreview.get(entry.id);
  if (p && p.root === cf) return p;

  if (p) { try { p.mixer.stopAllAction(); p.mixer.uncacheRoot(p.root); } catch (_) {} }
  p = {
    mixer: new window.THREE.AnimationMixer(cf),
    root: cf,
    actions: new Map(),
    clips: [],
    current: null,
    playing: false,
    speed: 1,
    loop: true
  };
  animPreview.set(entry.id, p);
  return p;
}

/** Fills the clip list for an entry (from the spec's cached gltf). */
export async function loadAnimClipsForEntry(entry) {
  const spec = getModelSpecForEntry(entry);
  if (!spec || !spec.path) return [];
  try {
    const gltf = await loadGltfOnce(spec.path, spec.__v);
    const clips = (gltf.animations || []).map((c) => ({
      name: c.name,
      duration: c.duration,
      tracks: c.tracks.length
    }));
    const p = ensureAnimPreview(entry);
    if (p) {
      p.clips = clips;
      for (const c of (gltf.animations || [])) {
        if (p.actions.has(c.name)) continue;
        const a = p.mixer.clipAction(new window.THREE.AnimationClip(c.name, c.duration, c.tracks, c.blendMode));
        a.enabled = true;
        a.setLoop(window.THREE.LoopRepeat, Infinity);
        p.actions.set(c.name, a);
      }
    }
    animClipCache.set(entry.id, clips);
    return clips;
  } catch (err) {
    reportEditorModelError(`Could not read clips: ${err.message}`);
    animClipCache.set(entry.id, []);
    return [];
  }
}

/** True when the entry's model has a skeleton (any SkinnedMesh or Bone). */
function isSkinnedModel(entry) {
  if (!entry || !entry.mesh) return false;
  const cf = entry.mesh.getObjectByName(CF_MODEL_NAME);
  if (!cf) return false;
  let skinned = false;
  cf.traverse((n) => { if (n.isSkinnedMesh || n.isBone) skinned = true; });
  return skinned;
}

/** Plays a clip in the editor preview only. */
export function previewClip(entryId, clipName, opts = {}) {
  const entry = objectMap.get(entryId);
  if (!entry) return false;
  const p = ensureAnimPreview(entry);
  if (!p) return false;
  const clip = p.clips.find((c) => c.name === clipName) || p.clips[0];
  if (!clip) return false;
  const action = p.actions.get(clip.name);
  if (!action) return false;
  if (opts.loop === false) action.setLoop(window.THREE.LoopOnce, 1);
  else action.setLoop(window.THREE.LoopRepeat, Infinity);
  action.reset().setEffectiveTimeScale(p.speed).setEffectiveWeight(1).play();
  p.current = clip.name;
  p.playing = true;
  startAnimPreviewClock();
  return true;
}

export function pauseAnimPreview(entryId) {
  const p = animPreview.get(entryId);
  if (!p) return false;
  p.playing = false;
  return true;
}

export function stopAnimPreview(entryId) {
  const p = animPreview.get(entryId);
  if (!p) return false;
  try { p.mixer.stopAllAction(); } catch (_) {}
  p.playing = false;
  p.current = null;
  return true;
}

export function scrubAnimPreview(entryId, seconds) {
  const p = animPreview.get(entryId);
  if (!p) return false;
  const action = p.current ? p.actions.get(p.current) : null;
  const dur = action ? action.getClip().duration : 0;
  if (!action || !dur) return false;
  action.time = Math.max(0, Math.min(dur, seconds));
  p.mixer.update(0);
  return true;
}

export function setAnimPreviewSpeed(entryId, speed) {
  const p = animPreview.get(entryId);
  if (!p) return false;
  p.speed = Math.min(3, Math.max(0.1, speed));
  for (const [, a] of p.actions) a.setEffectiveTimeScale(p.speed);
  return true;
}

export function getAnimPreviewState(entryId) {
  const p = animPreview.get(entryId);
  if (!p) return null;
  const action = p.current ? p.actions.get(p.current) : null;
  return {
    current: p.current,
    playing: p.playing,
    speed: p.speed,
    time: action ? action.time : 0,
    duration: action ? action.getClip().duration : 0
  };
}

/** Ticked from animate() and a 30 fps interval; keeps the scrub bar live. */
function tickAnimPreview() {
  if (!animPreview.size) return;
  const THREE = window.THREE;
  for (const [, p] of animPreview) {
    if (!p.playing || !p.mixer) continue;
    try { p.mixer.update(1 / 30); } catch (_) {}
  }
  // Reflect the running time in the scrub bar without a full re-render.
  const bar = document.getElementById('prop-anim-scrub');
  const timeEl = document.getElementById('prop-anim-time');
  if (bar && timeEl && selectedObjectId) {
    const st = getAnimPreviewState(selectedObjectId);
    if (st) {
      if (document.activeElement !== bar) bar.value = String(st.time);
      timeEl.textContent = `${st.time.toFixed(2)}s / ${st.duration.toFixed(2)}s`;
    }
  }
}

/** Returns the model spec for an object (from the current layout, or defaults). */
function getModelSpecForEntry(entry) {
  if (!entry) return null;
  if (modelStateStore.has(entry.id)) return modelStateStore.get(entry.id);
  if (siblingModelWrites.has(entry.id)) return siblingModelWrites.get(entry.id);
  const lay = currentLayout;
  if (lay && lay.objects) {
    const direct = lay.objects[entry.id];
    if (direct && direct.model) return direct.model;
    for (const [id, data] of Object.entries(lay.objects)) {
      if (!data || !data.model) continue;
      if (!id.includes('*')) continue;
      const glob = siblingGlobIdFor(entry.name) || entry.name;
      if (id === glob || matchesPatternGlob(entry.id, id) || matchesPatternGlob(entry.name, id)) {
        return data.model;
      }
    }
  }
  return null;
}

function matchesPatternGlob(str, pattern) {
  if (!str || !pattern) return false;
  if (str === pattern) return true;
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(str) || re.test(String(str).split('/').pop());
  }
  return false;
}

/**
 * Uploads a picked file into <project>/assets/models/ and returns the relative path.
 */
export async function loadModelFromFile(file) {
  if (!file) return { model: null, fileName: '' };
  const projectPath = getActiveProjectPath();
  if (!projectPath) {
    reportEditorModelError('No project selected');
    return { model: null, fileName: file.name };
  }

  // 50 MB guard before upload so the user gets a clear message, not a hang.
  if (file.size > 50 * 1024 * 1024) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    reportEditorModelError(`"${file.name}" is ${mb} MB, over the 50 MB limit.`);
    return { model: null, fileName: file.name };
  }

  // Stage the file in a temp location the server can copy from.
  const staged = await stageTempFile(file);
  try {
    const res = await fetch('/modeling/model/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, sourcePath: staged, fileName: file.name })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      reportEditorModelError(data.error || `Import failed (${res.status})`);
      return { model: null, fileName: file.name };
    }
    clearEditorModelError();
    return { model: data.path, fileName: file.name, bytes: data.bytes };
  } finally {
    try { fetch('/modeling/temp/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: staged }) }); } catch (_) {}
  }
}

/** Writes the picked file to a temp path and returns its absolute path. */
async function stageTempFile(file) {
  const buf = await file.arrayBuffer();
  const res = await fetch('/modeling/temp/write', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'model.glb')
    },
    body: buf
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.path) throw new Error(data.error || 'Failed to stage file');
  return data.path;
}

/**
 * Swaps the selected object's model. Non-destructive: hides the original's
 * visuals and adds CF_Model.
 */
export async function swapSelectedModel(file, options = {}) {
  const entry = objectMap.get(selectedObjectId);
  if (!entry || !entry.mesh) return null;
  if (isInstancedEntry(entry)) {
    reportEditorModelError('Instanced objects cannot be swapped');
    return null;
  }

  const prevSpec = getModelSpecForEntry(entry);
  let imported;
  try {
    imported = await loadModelFromFile(file);
  } catch (err) {
    reportEditorModelError(err.message);
    return null;
  }
  if (!imported || !imported.model) return null;

  const spec = {
    path: imported.model,
    fit: options.fit || prevSpec?.fit || 'fit-bounds',
    scale: options.scale ?? prevSpec?.scale ?? 1,
    offset: options.offset || prevSpec?.offset || [0, 0, 0],
    rotation: options.rotation || prevSpec?.rotation || [0, 0, 0],
    // Animation starts empty; the Animation section fills it in.
    animation: prevSpec?.animation
      ? { ...prevSpec.animation }
      : { bindings: {}, loop: true, speed: 1, crossfade: 0.2, auto: true }
  };

  const res = await applyModelToEntry(entry, spec);
  if (res === false) return null;

  // Record on the entry and (optionally) on the sibling glob for persistence.
  entry.model = spec;
  // Live snapshots rebuild the scene, so keep a durable copy that survives them.
  modelStateStore.set(entry.id, spec);
  modifiedObjectIds.add(entry.id);

  if (options.siblings) {
    const glob = siblingGlobIdFor(entry.name);
    if (glob) {
      siblingModelWrites.set(entry.id, spec);
      // Apply to every visible sibling in the scene, live.
      userObjects.forEach((e) => {
        if (e.id === entry.id) return;
        if (matchesPatternGlob(e.name, glob) || matchesPatternGlob(e.id, glob)) {
          if (isInstancedEntry(e)) return;
          e.model = spec;
          applyModelToEntry(e, spec);
        }
      });
      if (currentLayout && currentLayout.objects) {
        currentLayout.objects[glob] = { ...(currentLayout.objects[glob] || {}), model: spec };
      }
    }
  } else if (currentLayout && currentLayout.objects) {
    currentLayout.objects[entry.id] = { ...(currentLayout.objects[entry.id] || {}), model: spec };
  }

  // Undo/redo for swap
  pushUndoAction({
    type: 'model',
    id: entry.id,
    prev: { model: prevSpec ? { ...prevSpec } : null },
    next: { model: { ...spec } },
    siblings: options.siblings ? siblingGlobIdFor(entry.name) : null
  });

  broadcastSetModel(entry.id, spec, options.siblings ? siblingGlobIdFor(entry.name) : null, false);
  markUnsavedChanges();
  renderInspector();
  renderOutlinerTree();
  return res;
}

/** Removes CF_Model and restores the original. */
export function resetSelectedModel() {
  const entry = objectMap.get(selectedObjectId);
  if (!entry || !entry.mesh) return false;
  const prevSpec = getModelSpecForEntry(entry);
  if (!prevSpec && !entry.mesh.getObjectByName(CF_MODEL_NAME)) return false;

  const glob = siblingGlobIdFor(entry.name);
  const affected = [entry];
  if (siblingModelWrites.has(entry.id)) {
    userObjects.forEach((e) => {
      if (e.id !== entry.id && (matchesPatternGlob(e.name, glob) || matchesPatternGlob(e.id, glob))) {
        if (!isInstancedEntry(e)) affected.push(e);
      }
    });
  }

  affected.forEach((e) => {
    removeCFModelFromHost(e.mesh);
    restoreOriginalVisibility(e.mesh);
    appliedModels.delete(e.id);
    modelStateStore.delete(e.id);
    e.model = null;
  });
  siblingModelWrites.delete(entry.id);

  if (currentLayout && currentLayout.objects) {
    if (currentLayout.objects[entry.id]) delete currentLayout.objects[entry.id].model;
    if (glob && currentLayout.objects[glob]) delete currentLayout.objects[glob].model;
  }

  pushUndoAction({ type: 'model', id: entry.id, prev: { model: prevSpec ? { ...prevSpec } : null }, next: { model: null }, siblings: glob });
  broadcastSetModel(entry.id, null, siblingModelWrites.has(entry.id) ? glob : null, true);
  renderInspector();
  renderOutlinerTree();
  return true;
}

/** Sends a live model update to the game tab. */
function broadcastSetModel(id, spec, globId, clear) {
  if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
  try {
    activeWs.send(JSON.stringify({
      version: 1, type: 'set_model', id, model: spec, siblings: globId || undefined, clear: !!clear
    }));
  } catch (_) {}
}

/**
 * Updates one model parameter (scale/fit/offset/rotation) and pushes it live.
 * `key` is one of 'scale' | 'fit' | 'offset' | 'rotation'.
 */
export async function updateModelParam(id, key, value, options = {}) {
  const entry = objectMap.get(id);
  if (!entry || !entry.mesh) return false;
  if (isInstancedEntry(entry) && key === 'scale') return false;

  const prevSpec = getModelSpecForEntry(entry) ? { ...getModelSpecForEntry(entry) } : null;
  let spec = prevSpec ? { ...prevSpec } : { path: '', fit: 'fit-bounds', scale: 1, offset: [0, 0, 0], rotation: [0, 0, 0] };
  const fitChanged = key === 'fit' && spec.fit !== value;
  spec[key] = value;
  // Changing the fit mode re-derives the cached reference from the original.
  if (fitChanged && entry.mesh && entry.mesh.userData) {
    delete entry.mesh.userData.cfRefBox;
  }
  if (fitChanged) spec.__refit = true;

  if (!spec.path) return false; // nothing loaded yet

  const res = await applyModelToEntry(entry, spec);
  if (res === false) return false;
  entry.model = spec;
  // Keep the durable copy so Save still sees it after a live snapshot rebuild.
  modelStateStore.set(entry.id, spec);
  modifiedObjectIds.add(entry.id);

  const glob = options.siblings ? siblingGlobIdFor(entry.name) : (siblingModelWrites.has(entry.id) ? siblingGlobIdFor(entry.name) : null);
  if (glob) {
    siblingModelWrites.set(entry.id, spec);
    if (currentLayout && currentLayout.objects) {
      currentLayout.objects[glob] = { ...(currentLayout.objects[glob] || {}), model: spec };
    }
  } else if (currentLayout && currentLayout.objects) {
    currentLayout.objects[entry.id] = { ...(currentLayout.objects[entry.id] || {}), model: spec };
  }

  pushUndoAction({ type: 'model', id, prev: { model: prevSpec }, next: { model: { ...spec } }, siblings: glob });
  broadcastSetModel(id, spec, glob, false);
  return true;
}

/** Rotates the swapped model 90° about X to fix an incorrect up-axis. */
export async function fixModelUpAxis(id) {
  const entry = objectMap.get(id);
  if (!entry) return false;
  const spec = getModelSpecForEntry(entry);
  if (!spec) return false;
  const rot = Array.isArray(spec.rotation) ? [...spec.rotation] : [0, 0, 0];
  rot[0] = ((rot[0] + 90) % 360 + 360) % 360;
  return updateModelParam(id, 'rotation', rot, { siblings: siblingModelWrites.has(id) });
}

/** Applies an undo/redo model action. */
async function applyModelUndoAction(action, direction) {
  const target = direction === 'undo' ? action.prev : action.next;
  const spec = target.model;
  const entry = objectMap.get(action.id);
  if (!entry || !entry.mesh) return;

  if (!spec) {
    removeCFModelFromHost(entry.mesh);
    restoreOriginalVisibility(entry.mesh);
    appliedModels.delete(entry.id);
    modelStateStore.delete(entry.id);
    entry.model = null;
  } else {
    await applyModelToEntry(entry, spec);
    entry.model = spec;
    modelStateStore.set(entry.id, spec);
  }
  if (currentLayout && currentLayout.objects) {
    const rec = currentLayout.objects[entry.id] || {};
    if (spec) rec.model = spec; else delete rec.model;
    currentLayout.objects[entry.id] = rec;
  }
  if (action.siblings) {
    if (spec) {
      siblingModelWrites.set(entry.id, spec);
      if (currentLayout && currentLayout.objects) {
        currentLayout.objects[action.siblings] = { ...(currentLayout.objects[action.siblings] || {}), model: spec };
      }
    } else {
      siblingModelWrites.delete(entry.id);
      if (currentLayout && currentLayout.objects) delete currentLayout.objects[action.siblings];
    }
  }
  broadcastSetModel(entry.id, spec || null, action.siblings || null, !spec);
  renderInspector();
  renderOutlinerTree();
}

export function saveSelectedObjectToCode() {}
export function getObjectPriority() { return 1; }
