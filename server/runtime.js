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

  const { THREE, scene, getCamera, renderer } = options;
  const GLTFLoader = options.GLTFLoader || null;
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
  // Driven IDs (from config.json) never receive position or rotation updates.
  // --------------------------------------------------------------------------
  let currentLayout = null;
  let cfConfig = { drivenIds: ['Kart_Player', 'Kart_AI_*'] };

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
    if (!id || !Array.isArray(cfConfig.drivenIds)) return false;
    const segments = id.split('/');
    const lastName = segments[segments.length - 1];
    return cfConfig.drivenIds.some(
      (pat) => matchesPattern(id, pat) || matchesPattern(lastName, pat)
    );
  }

  // --------------------------------------------------------------------------
  // Model Swap (non-destructive)
  //
  // The original object is NEVER deleted. On swap we only hide its visual
  // children (game code keeps running and animating them) and attach the new
  // mesh as a child named CF_Model. Reset removes CF_Model and restores
  // visibility.
  // --------------------------------------------------------------------------
  const CF_MODEL_NAME = 'CF_Model';

  // path -> Promise<gltf>, so each file is fetched and parsed exactly once.
  const modelCache = new Map();
  // Errors are re-broadcast to the editor, so only report each one once.
  const reportedModelErrors = new Set();
  // id -> currently applied model signature, so we do not rebuild every frame.
  const appliedModelSig = new Map();

  function reportModelError(message) {
    if (reportedModelErrors.has(message)) return;
    reportedModelErrors.add(message);
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ version: 1, type: 'model_error', message }));
      }
    } catch (_) {}
    console.warn('[ContextForge Runtime] model error:', message);
  }

  /**
   * Reports a load failure once per (path, reason) rather than once per object,
   * so a glob write to 60 objects produces a single message.
   */
  function reportModelLoadError(id, relPath, detail) {
    const key = `load:${relPath}:${detail}`;
    if (reportedModelErrors.has(key)) return;
    reportModelError(`${id}: failed to load "${relPath}": ${detail}`);
  }

  function resolveModelPath(relPath, version) {
    // Model files live under <project>/assets/models/. In the game tab we are
    // served by the project's own dev server, whose origin IS the project root,
    // so a project-relative path resolves directly against it.
    // `version` is a cache-buster (?v=<mtime>) used after the file changes.
    const base = new URL(relPath.replace(/^\//, ''), location.href).href;
    if (!version) return base;
    return base + (base.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(version);
  }

  /**
   * Resolves a GLTFLoader. Tried in order:
   *   1. one passed in by the game (installContextForge option),
   *   2. a loader already on window (e.g. the editor's vendored bundle),
   *   3. the game's own node_modules, via its import map / dev server,
   *   4. ContextForge's vendored GLTFLoader, served by the project server at
   *      /__contextforge/vendor/GLTFLoader.js.
   * The game's source is never modified.
   */
  let gltfLoaderPromise = null;
  function getGLTFLoader() {
    if (typeof GLTFLoader === 'function') {
      noteLoaderSource('game-supplied (installContextForge option)');
      return Promise.resolve(GLTFLoader);
    }
    if (gltfLoaderPromise) return gltfLoaderPromise;
    gltfLoaderPromise = (async () => {
      if (window.GLTFLoader) { noteLoaderSource('window.GLTFLoader'); return window.GLTFLoader; }
      if (window.__CF_GLTF_LOADER__) { noteLoaderSource('window.__CF_GLTF_LOADER__'); return window.__CF_GLTF_LOADER__; }

      // 3. The game's own copy, via its import map / dev server.
      const candidates = [
        'three/examples/jsm/loaders/GLTFLoader.js',
        '/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
      ];
      for (const spec of candidates) {
        try {
          const mod = await import(/* @vite-ignore */ spec);
          if (mod && typeof mod.GLTFLoader === 'function') {
            noteLoaderSource(`game node_modules (${spec})`);
            return mod.GLTFLoader;
          }
        } catch (_) { /* try the next candidate */ }
      }

      // 4. ContextForge's vendored loader, injected as a classic script.
      //    ensureRuntimeCopied() writes it to <project>/contextforge/vendor/, so
      //    the project's own dev server serves it at /contextforge/vendor/.
      const VENDOR_URLS = [
        '/contextforge/vendor/GLTFLoader.js',
        '/__contextforge/vendor/GLTFLoader.js'
      ];
      for (const url of VENDOR_URLS) {
        const probe = await fetch(url, { method: 'GET' }).catch(() => null);
        // A dev server with no such route answers with its HTML index page, so
        // check the content type before trusting the response.
        if (!probe || !probe.ok) continue;
        if (!/javascript|ecmascript/i.test(probe.headers.get('content-type') || '')) continue;
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error('script failed to load'));
            document.head.appendChild(s);
          });
        } catch (_) { continue; }
        if (window.GLTFLoader) { noteLoaderSource(`ContextForge vendored (${url})`); return window.GLTFLoader; }
        if (window.__CF_GLTF_LOADER__) { noteLoaderSource(`ContextForge vendored (${url})`); return window.__CF_GLTF_LOADER__; }
      }

      throw new Error('GLTFLoader is not available in this game (no local copy and no ContextForge fallback)');
    })().catch((err) => { gltfLoaderPromise = null; throw err; });
    return gltfLoaderPromise;
  }

  // Records which loader source won, so the fallback can be verified in tests.
  function noteLoaderSource(source) {
    try { window.__CF_LOADER_SOURCE__ = source; } catch (_) {}
    console.log(`[ContextForge Runtime] GLTFLoader resolved from: ${source}`);
  }

  function loadGltfOnce(relPath, version) {
    // The version is part of the cache key so a changed file is re-fetched even
    // though the path is the same.
    const key = version ? `${relPath}?v=${version}` : relPath;
    if (modelCache.has(key)) return modelCache.get(key);
    const p = (async () => {
      const Loader = await getGLTFLoader();
      const url = resolveModelPath(relPath, version);
      const loader = new Loader();
      const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, async (err) => {
          // Dev servers often answer a missing file with an HTML fallback page,
          // which GLTFLoader reports as a confusing JSON parse error. Check the
          // status so the message names the real problem.
          let detail = err?.message || 'load error';
          try {
            const res = await fetch(url, { method: 'GET' });
            const ctype = res.headers.get('content-type') || '';
            if (res.status === 404) detail = 'file not found (404)';
            else if (!res.ok) detail = `HTTP ${res.status}`;
            else if (ctype.includes('text/html')) detail = 'file not found (server returned an HTML page)';
          } catch (_) { /* keep the original error */ }
          const e = new Error(detail);
          e.modelPath = relPath;
          reject(e);
        });
      });
      return gltf;
    })();
    // Do not cache failures: a later fix (or a file re-added) should retry.
    p.catch(() => modelCache.delete(key));
    modelCache.set(key, p);
    return p;
  }

  function countTriangles(rootObj) {
    let tris = 0;
    rootObj.traverse((n) => {
      if (!n.isMesh || !n.geometry) return;
      const g = n.geometry;
      const count = g.index ? g.index.count : (g.attributes?.position?.count || 0);
      tris += Math.floor(count / 3);
    });
    return tris;
  }

  function setShadows(rootObj) {
    rootObj.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
        // A skinned mesh's GPU-computed bounds are not available for culling in
        // the same frame, so it gets culled wrongly as soon as it animates.
        if (n.isSkinnedMesh) n.frustumCulled = false;
      }
    });
  }

  function disposeModelTree(obj) {
    obj.traverse((n) => {
      if (n.isMesh && n.geometry) n.geometry.dispose();
      const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
      for (const m of mats) {
        if (!m) continue;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
          if (m[k] && m[k].isTexture && m[k].userData.__cfCloned) m[k].dispose();
        }
        m.dispose();
      }
    });
  }

  /**
   * Resolves SkeletonUtils, which is what keeps a skinned clone's bones bound.
   * Order: the game's own copy, a global, then ContextForge's vendored build at
   * /contextforge/vendor/SkeletonUtils.js. The game's source is never modified.
   */
  let skeletonUtilsPromise = null;
  function getSkeletonUtils() {
    if (skeletonUtilsPromise) return skeletonUtilsPromise;
    skeletonUtilsPromise = (async () => {
      if (window.SkeletonUtils && typeof window.SkeletonUtils.clone === 'function') {
        return window.SkeletonUtils;
      }
      if (THREE && THREE.SkeletonUtils && typeof THREE.SkeletonUtils.clone === 'function') {
        return THREE.SkeletonUtils;
      }
      const specs = [
        'three/examples/jsm/utils/SkeletonUtils.js',
        '/node_modules/three/examples/jsm/utils/SkeletonUtils.js'
      ];
      for (const spec of specs) {
        try {
          const mod = await import(/* @vite-ignore */ spec);
          if (mod && typeof mod.clone === 'function') return mod;
        } catch (_) { /* try the next */ }
      }
      for (const url of ['/contextforge/vendor/SkeletonUtils.js', '/__contextforge/vendor/SkeletonUtils.js']) {
        const probe = await fetch(url).catch(() => null);
        if (!probe || !probe.ok) continue;
        if (!/javascript|ecmascript/i.test(probe.headers.get('content-type') || '')) continue;
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url; s.onload = resolve;
            s.onerror = () => reject(new Error('script failed'));
            document.head.appendChild(s);
          });
        } catch (_) { continue; }
        if (window.SkeletonUtils && typeof window.SkeletonUtils.clone === 'function') {
          return window.SkeletonUtils;
        }
      }
      return null;
    })().catch(() => null);
    return skeletonUtilsPromise;
  }

  /**
   * Clones a loaded gltf scene. Skinned models need SkeletonUtils.clone so
   * bones stay bound; a plain .clone() would break the skeleton.
   */
  function cloneGltfScene(gltf) {
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) throw new Error('GLB contains no scene');
    let hasSkin = false;
    root.traverse((n) => { if (n.isSkinnedMesh) hasSkin = true; });
    const SU = resolvedSkeletonUtils
      || (window.SkeletonUtils && typeof window.SkeletonUtils.clone === 'function' ? window.SkeletonUtils : null)
      || (THREE && THREE.SkeletonUtils && typeof THREE.SkeletonUtils.clone === 'function' ? THREE.SkeletonUtils : null);
    if (SU && typeof SU.clone === 'function' && (gltf.animations?.length || hasSkin)) {
      return SU.clone(root);
    }
    return root.clone(true);
  }

  // Cache for the async SkeletonUtils lookup; warmed by ensureSkeletonUtils().
  let resolvedSkeletonUtils = null;
  async function ensureSkeletonUtils() {
    if (!resolvedSkeletonUtils) resolvedSkeletonUtils = await getSkeletonUtils();
    return resolvedSkeletonUtils;
  }

  // Name fragments that identify non-body parts of an object: wheels, driver,
  // shadow blobs, exhaust, particles and other game-animated decoration. These
  // must not influence the fit-bounds reference box.
  const NON_BODY_NAME_PARTS = [
    'wheel', 'tire', 'tyre', 'hub', 'spoke', 'driver', 'shadow', 'puff', 'smoke',
    'particle', 'exhaust', 'glow', 'spark', 'dust', 'trail', 'starring'
  ];

  function isNonBodyPart(node) {
    const n = String(node.name || '').toLowerCase();
    if (!n) return false;
    for (const part of NON_BODY_NAME_PARTS) {
      if (n.includes(part)) return true;
    }
    return false;
  }

  /**
   * True when `node` sits inside a non-body subtree. Matching only the node's own
   * name is not enough: a driver's limbs are named "Headgear_Cap", "Arm_0" and so
   * on, so the whole Kart_Driver group has to be excluded, not just its root.
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
   * Computes the reference bounding box for fit-bounds, in the HOST'S LOCAL
   * SPACE, from the original's own visual children only.
   *
   * Excludes:
   *  - the swapped CF_Model subtree (otherwise feedback grows each swap),
   *  - anything still marked hidden by a previous swap,
   *  - wheels / driver / particles and similar non-body parts.
   *
   * POSITION IS NORMALISED OUT. Each part's geometry bounds are taken relative to
   * that part's own local origin, then unioned. A part that is animated into a
   * different pose (or that has not finished being placed yet when the layout is
   * first applied) therefore cannot change the reference, so the fit is identical
   * on every load and at every moment of a race. A world-space box was the
   * original bug: it moved with the kart and made a 2x model measure 1.84x one
   * frame and 2.06x the next.
   *
   * Cached on userData.cfRefBox; only re-derived when the fit mode changes or
   * the user presses Refit.
   */
  function computeRefBox(hostObj) {
    hostObj.updateMatrixWorld(true);

    // Host-local frame with translation removed, so the reference does not move
    // when the object drives around the track.
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

      // Geometry bounds -> world -> host-local, keeping the part's own offset
      // (so the box spans the real body) but dropping the host's translation.
      partBox.copy(gb).applyMatrix4(node.matrixWorld).applyMatrix4(invHostLocal);
      if (!any) { box.copy(partBox); any = true; }
      else box.union(partBox);
    });

    if (!any) {
      box.setFromObject(hostObj);
      box.max.set(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
      box.min.set(0, 0, 0);
    }
    // The box is a size reference only; re-origin it to the host so the cached
    // value carries no world position and stays comparable across loads.
    box.max.sub(box.min);
    box.min.set(0, 0, 0);
    return box;
  }

  /** Returns the cached reference box, computing it on first use. */
  function getRefBox(hostObj, forceRecompute = false) {
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

  function clearRefBox(hostObj) {
    if (hostObj && hostObj.userData && hostObj.userData.cfRefBox) {
      delete hostObj.userData.cfRefBox;
    }
  }

  // --------------------------------------------------------------------------
  // Animation
  //
  // Non-destructive like everything else: one AnimationMixer per CF_Model
  // instance, clips cloned per instance from a per-path cache. Nothing here ever
  // modifies the game's own nodes.
  // --------------------------------------------------------------------------

  // path -> AnimationClip[] (the loaded source clips, never handed out directly)
  const clipCache = new Map();
  // hostObj.uuid -> animation controller for that instance
  const animControllers = new Map();

  // Auto-state thresholds, in world units per second.
  const MOVE_ENTER = 0.5; // above this, switch to the 'move' clip
  const MOVE_EXIT = 0.3;  // below this, fall back to 'idle' (hysteresis)
  const SPEED_SMOOTHING = 0.2; // seconds of exponential smoothing

  /**
   * Resolves the clips for a path, fetching the model if needed. Clips are
   * returned as a per-instance clone so two karts never share a Clip object
   * (an AnimationAction writes into the track values, so sharing is unsafe).
   */
  async function getClipsForPath(path, version) {
    const gltf = await loadGltfOnce(path, version);
    const key = version ? `${path}?v=${version}` : path;
    if (!clipCache.has(key)) {
      clipCache.set(key, gltf.animations || []);
    }
    return clipCache.get(key);
  }

  /** Drops every cached entry for a path, whatever version it was loaded under. */
  function invalidateModelCaches(path) {
    for (const k of Array.from(modelCache.keys())) {
      if (k === path || k.startsWith(path + '?')) modelCache.delete(k);
    }
    for (const k of Array.from(clipCache.keys())) {
      if (k === path || k.startsWith(path + '?')) clipCache.delete(k);
    }
  }

  function cloneClip(clip) {
    return new THREE.AnimationClip(clip.name, clip.duration, clip.tracks, clip.blendMode);
  }

  /**
   * Chooses a clip by name, falling back to the first clip when the bound name
   * is missing or empty. A missing name warns exactly once per (path, name).
   */
  function resolveClip(clips, wanted) {
    if (!clips || !clips.length) return null;
    if (wanted) {
      const hit = clips.find((c) => c.name === wanted);
      if (hit) return hit;
    }
    return clips[0];
  }

  /** Disposes the mixer and its cached actions for one instance. */
  function disposeAnimController(hostObj) {
    const ctl = animControllers.get(hostObj.uuid);
    if (!ctl) return;
    try {
      ctl.mixer.stopAllAction();
      ctl.mixer.uncacheRoot(ctl.modelRoot);
      ctl.mixer = null;
    } catch (_) {}
    animControllers.delete(hostObj.uuid);
  }

  /**
   * Creates (or replaces) the animation controller for a model instance.
   * @param {Object} hostObj the original game object hosting CF_Model
   * @param {Object} modelRoot the CF_Model clone
   * @param {Array} clips source clips for this path
   * @param {Object} anim the spec.animation block from layout
   */
  function ensureAnimController(hostObj, modelRoot, clips, anim, modelPath) {
    let ctl = animControllers.get(hostObj.uuid);
    if (!ctl) {
      ctl = {
        mixer: new THREE.AnimationMixer(modelRoot),
        modelRoot,
        // name -> AnimationAction, one per clip, so switching is instant
        actions: new Map(),
        current: null,       // name of the clip currently playing
        next: null,          // pending crossfade target
        fadeLeft: 0,
        anim: anim || {},
        // speed-smoothing state for the auto rule
        smoothSpeed: 0,
        lastPos: null,
        lastPosTime: 0,
        // when set, the auto rule is suspended (manual override from window.cf)
        manualState: null
      };
      animControllers.set(hostObj.uuid, ctl);
    } else {
      // Same instance: refresh the root in case the model was rebuilt.
      ctl.modelRoot = modelRoot;
      if (ctl.mixer.getRoot() !== modelRoot) {
        ctl.mixer = new THREE.AnimationMixer(modelRoot);
        ctl.actions.clear();
        ctl.current = null;
        ctl.next = null;
      }
    }
    ctl.anim = anim || {};
    ctl.clips = clips || [];
    // Remember the source path so warnings dedupe per file + clip name, even
    // though the model root is rebuilt on every re-apply.
    if (modelPath) ctl.modelPath = modelPath;

    // Build an action per clip (cloned, so instances never share one).
    for (const clip of ctl.clips) {
      if (ctl.actions.has(clip.name)) continue;
      const action = ctl.mixer.clipAction(cloneClip(clip));
      action.enabled = true;
      action.setLoop(
        ctl.anim.loop === false ? THREE.LoopOnce : THREE.LoopRepeat,
        Infinity
      );
      ctl.actions.set(clip.name, action);
    }
    return ctl;
  }

  /** Starts (or crossfades to) a named clip. */
  function playClip(ctl, name, opts = {}) {
    if (!ctl || !ctl.clips.length) return false;
    const clip = resolveClip(ctl.clips, name);
    if (!clip) return false;

    if (name && clip.name !== name) {
      warnMissingClip(ctl, name, clip);
    }

    const action = ctl.actions.get(clip.name);
    if (!action) return false;

    const fade = typeof opts.fade === 'number' ? opts.fade
      : (typeof ctl.anim.crossfade === 'number' ? ctl.anim.crossfade : 0.2);

    if (opts.loop === false) action.setLoop(THREE.LoopOnce, 1);

    if (ctl.current && ctl.current !== clip.name && fade > 0) {
      // Crossfade: ramp the old action out while the new one ramps in.
      const prev = ctl.actions.get(ctl.current);
      if (prev && prev.isRunning()) {
        prev.crossFadeTo(action, fade, false);
        ctl.current = clip.name;
        ctl.fadeLeft = fade;
        action.reset().setEffectiveWeight(1).play();
        return true;
      }
    }
    if (ctl.current === clip.name) {
      if (!action.isRunning()) action.reset().play();
      return true;
    }
    action.reset().setEffectiveTimeScale(animSpeed(ctl)).setEffectiveWeight(1).play();
    ctl.current = clip.name;
    ctl.next = null;
    ctl.fadeLeft = 0;
    return true;
  }

  function animSpeed(ctl) {
    const s = ctl && ctl.anim && typeof ctl.anim.speed === 'number' ? ctl.anim.speed : 1;
    return Math.min(3, Math.max(0.1, s));
  }

  const warnedMissingClips = new Set();
  function warnMissingClip(ctl, wanted, actual) {
    // Key on the model PATH, not the model root's uuid: the root is rebuilt on
    // every re-apply, so a uuid key would re-warn on each change and defeat the
    // "warn once" rule.
    const key = `${ctl.modelPath || (ctl.modelRoot ? ctl.modelRoot.uuid : 'x')}:${wanted}`;
    if (warnedMissingClips.has(key)) return;
    warnedMissingClips.add(key);
    const id = ctl.hostId || 'object';
    reportModelError(`${id}: animation clip "${wanted}" not found, using "${actual.name}" instead`);
  }

  /**
   * The auto state rule: speed from world-position change per second, smoothed
   * over 0.2 s, with hysteresis (enter move at 0.5, leave at 0.3).
   */
  function updateAutoState(ctl, hostObj, now) {
    if (!ctl.anim.auto) return;

    const pos = hostObj.position;
    if (!ctl.lastPos) {
      ctl.lastPos = pos.clone();
      ctl.lastPosTime = now;
      return;
    }
    const dt = now - ctl.lastPosTime;
    if (dt <= 0) return;
    const dist = ctl.lastPos.distanceTo(pos);
    // Exponential smoothing, so a single jittery frame cannot flip the state.
    const instant = dist / dt;
    const k = 1 - Math.exp(-dt / SPEED_SMOOTHING);
    ctl.smoothSpeed += (instant - ctl.smoothSpeed) * k;
    ctl.lastPos.copy(pos);
    ctl.lastPosTime = now;

    const s = ctl.smoothSpeed;
    let want;
    if (ctl.autoState === 'move') {
      // Already moving: only drop back to idle once clearly slow.
      want = s > MOVE_EXIT ? 'move' : 'idle';
    } else {
      // Currently idle: only start moving once clearly fast.
      want = s >= MOVE_ENTER ? 'move' : 'idle';
    }
    if (want !== ctl.autoState) {
      ctl.autoState = want;
      const clipName = want === 'move' ? ctl.anim.bindings?.move : ctl.anim.bindings?.idle;
      playClip(ctl, clipName || ctl.clips[0]?.name, { fade: ctl.anim.crossfade });
    }
  }

  /**
   * Per-frame tick for every animated instance. Called from the layout
   * enforcement hook with the game's delta time.
   */
  function updateAnimationMixers(dt, now) {
    if (!animControllers.size) return;
    if (animationSuspended) return;
    // In Edit mode mixers stay paused unless the editor is previewing, so the
    // scene is not animating behind the user's back.
    const playing = currentMode !== 'edit' || editorPreviewing;
    if (!playing) return;
    for (const [uuid, ctl] of animControllers) {
      if (!ctl.mixer || !ctl.modelRoot) continue;
      const hostObj = ctl.hostObj;
      if (hostObj) updateAutoState(ctl, hostObj, now);
      for (const [, action] of ctl.actions) {
        if (action.isRunning()) {
          action.setEffectiveTimeScale(animSpeed(ctl));
        }
      }
      try { ctl.mixer.update(dt); } catch (_) {}
    }
  }

  let editorPreviewing = false;
  // Set by the measurement hook so frame cost can be compared with/without
  // animation. Never set by the editor or the game.
  let animationSuspended = false;

  /**
   * Finds the animation controller for a layout id, which may be a glob
   * (Kart_AI_*), a plain id, or a direct object reference.
   */
  function findAnimControllerForId(id) {
    if (id && typeof id === 'object') {
      return animControllers.get(id.uuid) || null;
    }
    if (!id) return null;
    if (id.includes('*')) {
      const hit = findObjectsByGlobId(id, scene)[0];
      return hit ? animControllers.get(hit.uuid) || null : null;
    }
    const obj = findObjectById(id, scene);
    return obj ? animControllers.get(obj.uuid) || null : null;
  }

  // Public API so game code can drive animations manually. Nothing here touches
  // the game's own nodes; it only controls the CF_Model mixer.
  window.cf = window.cf || {};
  window.cf.play = function (id, clipName, opts = {}) {
    const ctl = findAnimControllerForId(id);
    if (!ctl) return false;
    // A manual play suspends the automatic speed rule.
    ctl.manualState = opts.state || 'manual';
    return playClip(ctl, clipName, opts);
  };
  window.cf.stop = function (id) {
    const ctl = findAnimControllerForId(id);
    if (!ctl || !ctl.mixer) return false;
    ctl.mixer.stopAllAction();
    ctl.current = null;
    return true;
  };
  window.cf.setState = function (id, state) {
    const ctl = findAnimControllerForId(id);
    if (!ctl) return false;
    ctl.manualState = state;
    ctl.autoState = state;
    const clipName = state === 'move' ? ctl.anim?.bindings?.move : ctl.anim?.bindings?.idle;
    return playClip(ctl, clipName || ctl.clips?.[0]?.name, { fade: ctl.anim?.crossfade });
  };
  /** Test/debug helper: reports what each animated instance is doing. */
  window.cf.debug = function () {
    const out = [];
    for (const [uuid, ctl] of animControllers) {
      let speed = null;
      if (ctl.hostObj) {
        const p = ctl.hostObj.position;
        speed = p.toArray().map((v) => +v.toFixed(3));
      }
      out.push({
        uuid,
        hostId: ctl.hostId || null,
        current: ctl.current,
        autoState: ctl.autoState || null,
        smoothSpeed: +Number(ctl.smoothSpeed || 0).toFixed(4),
        playing: ctl.actions ? Array.from(ctl.actions.entries())
          .filter(([, a]) => a.isRunning()).map(([n]) => n) : [],
        position: speed
      });
    }
    return out;
  };

  /**
   * Places the model so its pivot sits at the bottom centre of its bounding
   * box, and optionally scales it to match the original.
   */
  function placeModel(modelRoot, hostObj, spec) {
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    box.getSize(size);

    const fit = spec.fit === 'keep-size' ? 'keep-size' : 'fit-bounds';
    let uniform = 1;

    if (fit === 'fit-bounds') {
      // Match the cached reference height, but never exceed its width or length.
      // Using a stable reference is what keeps the scale constant while the kart
      // drives around.
      const origBox = getRefBox(hostObj, spec.__refit === true);
      const origSize = new THREE.Vector3();
      origBox.getSize(origSize);

      const h = size.y, w = size.x, l = size.z;
      const cand = [];
      if (h > 1e-6) cand.push(origSize.y / h);
      if (w > 1e-6) cand.push(origSize.x / w);
      if (l > 1e-6) cand.push(origSize.z / l);
      // Smallest ratio wins: matches height, and is capped by width/length.
      uniform = cand.length ? Math.min(...cand) : 1;
      if (!isFinite(uniform) || uniform <= 0) uniform = 1;
    }

    const userScale = typeof spec.scale === 'number' && isFinite(spec.scale) && spec.scale > 0 ? spec.scale : 1;
    const s = uniform * userScale;
    modelRoot.scale.setScalar(s);

    // Re-measure with the final scale so the pivot lands exactly on the base.
    const box2 = new THREE.Box3().setFromObject(modelRoot);
    const min = box2.min, max = box2.max;
    const cx = (min.x + max.x) / 2;

    const off = Array.isArray(spec.offset) ? spec.offset : [0, 0, 0];
    modelRoot.position.set(
      cx - off[0] * s,
      -min.y - off[1] * s,
      -((min.z + max.z) / 2) - off[2] * s
    );

    const rot = Array.isArray(spec.rotation) ? spec.rotation : [0, 0, 0];
    modelRoot.rotation.set(
      THREE.MathUtils.degToRad(rot[0] || 0),
      THREE.MathUtils.degToRad(rot[1] || 0),
      THREE.MathUtils.degToRad(rot[2] || 0)
    );

    modelRoot.updateMatrixWorld(true);
    return { uniform, totalScale: s, size: new THREE.Vector3(size.x * s, size.y * s, size.z * s) };
  }

  function removeCFModel(hostObj) {
    const existing = hostObj.getObjectByName(CF_MODEL_NAME);
    if (existing) {
      hostObj.remove(existing);
      try { disposeModelTree(existing); } catch (_) {}
    }
    // A reset or removal must take the mixer with it, or the actions keep
    // writing into a disposed skeleton.
    disposeAnimController(hostObj);
  }

  function restoreOriginalVisibility(hostObj) {
    hostObj.traverse((n) => {
      if (n.userData.__cfHiddenByModel) {
        n.visible = true;
        delete n.userData.__cfHiddenByModel;
      }
    });
  }

  function hideOriginalVisuals(hostObj) {
    hostObj.traverse((n) => {
      if (n.name === CF_MODEL_NAME) return;
      if (n.isMesh || n.isPoints || n.isLine || n.isSprite) {
        if (!n.userData.__cfHiddenByModel) {
          n.userData.__cfHiddenByModel = true;
          n.userData.__cfVisibleBefore = n.visible;
        }
        n.visible = false;
      }
    });
  }

  function modelSignature(spec) {
    // refit is a one-shot flag: it must change the signature so a Refit press
    // actually re-derives the reference box instead of being skipped as a no-op.
    return JSON.stringify([
      spec.path, spec.fit, spec.scale, spec.offset, spec.rotation, !!spec.__refit, spec.__v || null,
      spec.animation ? JSON.stringify(spec.animation) : null
    ]);
  }

  /**
   * Applies (or clears) the model described by `spec` on `hostObj`.
   */
  async function applyModelToObject(hostObj, id, spec) {
    if (!spec || !spec.path) {
      removeCFModel(hostObj);
      restoreOriginalVisibility(hostObj);
      appliedModelSig.delete(hostObj.uuid);
      return true;
    }

    const sig = modelSignature(spec);
    if (appliedModelSig.get(hostObj.uuid) === sig) return true;
    appliedModelSig.delete(hostObj.uuid);

    let gltf;
    try {
      gltf = await loadGltfOnce(spec.path, spec.__v);
    } catch (err) {
      // Keep the original visible and surface the error to the editor.
      removeCFModel(hostObj);
      restoreOriginalVisibility(hostObj);
      reportModelLoadError(id, spec.path, err.message);
      return false;
    }

    let cloned;
    try {
      // Make sure a SkeletonUtils is available before cloning, so skinned models
      // are not silently cloned without their skeleton.
      await ensureSkeletonUtils();
      cloned = cloneGltfScene(gltf);
    } catch (err) {
      removeCFModel(hostObj);
      restoreOriginalVisibility(hostObj);
      reportModelError(`${id}: ${err.message}`);
      return false;
    }

    setShadows(cloned);
    const info = placeModel(cloned, hostObj, spec);
    cloned.name = CF_MODEL_NAME;
    cloned.userData.__cfModel = true;

    // Remove any previous CF_Model (and its mixer) before adding the new one.
    // Without this a re-apply (hot reload, or a param change) leaves the old
    // model in the graph and getObjectByName keeps returning the stale copy.
    removeCFModel(hostObj);
    disposeAnimController(hostObj);

    hideOriginalVisuals(hostObj);
    hostObj.add(cloned);
    hostObj.updateMatrixWorld(true);

    const tris = countTriangles(cloned);
    if (tris > 200000) {
      reportModelError(`${id}: "${spec.path}" has ${tris.toLocaleString()} triangles (over 200k) — performance may suffer.`);
    }

    // ---- Animation: one mixer per instance, clips cloned from a path cache ----
    const anim = spec.animation;
    if (anim) {
      let clips = [];
      try {
        clips = await getClipsForPath(spec.path, spec.__v);
      } catch (err) {
        reportModelError(`${id}: could not read animation clips: ${err.message}`);
      }
      if (clips.length) {
        const ctl = ensureAnimController(hostObj, cloned, clips, anim, spec.path);
        ctl.hostObj = hostObj;
        ctl.hostId = id;
        // Pick a starting clip: honour an explicit manual state, else let the
        // auto rule choose on the first tick.
        const startName = ctl.manualState === 'move' ? anim.bindings?.move
          : ctl.manualState === 'idle' ? anim.bindings?.idle
          : anim.auto === false ? (anim.bindings?.idle || clips[0].name)
          : (anim.bindings?.idle || clips[0].name);
        if (startName) {
          ctl.autoState = ctl.autoState || 'idle';
          playClip(ctl, startName, { fade: 0 });
        }
      }
    } else {
      disposeAnimController(hostObj);
    }

    appliedModelSig.set(hostObj.uuid, sig);
    return { triangles: tris, scale: info.totalScale, size: info.size };
  }

  function applyLayout(layout) {
    if (!layout || !layout.objects) return;
    currentLayout = layout;

    for (const [id, data] of Object.entries(layout.objects)) {
      if (id.startsWith('path:')) continue;

      // A glob id (Kart_AI_*) applies to every matching object in the scene.
      const targets = id.includes('*')
        ? findObjectsByGlobId(id, scene)
        : [findObjectById(id, scene)].filter(Boolean);

      for (const obj of targets) {
        const driven = isDrivenId(id);

        // Never apply position or rotation for driven objects — game code owns those
        if (!driven) {
          if (Array.isArray(data.position) && data.position.length >= 3) {
            obj.position.set(data.position[0], data.position[1], data.position[2]);
          }
          if (Array.isArray(data.rotation) && data.rotation.length >= 3) {
            obj.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
          }
        }

        if (Array.isArray(data.scale) && data.scale.length >= 3) {
          obj.scale.set(data.scale[0], data.scale[1], data.scale[2]);
        }
        if (typeof data.visible === 'boolean') {
          obj.visible = data.visible;
        }
        if (data.model) {
          // Fire and forget: errors are reported back over the socket.
          applyModelToObject(obj, obj.userData?.cfId || id, data.model);
        }
        obj.updateMatrixWorld?.(true);
      }
    }
  }

  /**
   * Resolves a glob layout id to every matching scene object.
   * Accepts both "Coin_*" (bare name pattern) and "Items/Coin_*" (with a parent
   * path), because layout.json may store either form.
   */
  function findObjectsByGlobId(globId, root) {
    const out = [];
    if (!globId || !globId.includes('*')) {
      const exact = findObjectById(globId, root);
      return exact ? [exact] : [];
    }
    const segments = globId.split('/');
    const pattern = segments[segments.length - 1];
    const parentSegs = segments.slice(0, -1);

    // Walk to the parent path, then match its children.
    const search = (parent) => {
      for (const child of parent.children || []) {
        const seg = child.userData?.cfId === child.name ? child.name : getNodeSegment(child, parent);
        if (matchesPattern(seg, pattern) || matchesPattern(child.name || '', pattern)) {
          out.push(child);
        }
      }
    };

    let parent = root;
    for (const seg of parentSegs) {
      let next = null;
      for (const child of parent.children || []) {
        if (child.userData?.cfId === seg || getNodeSegment(child, parent) === seg || child.name === seg) {
          next = child;
          break;
        }
      }
      if (!next) break;
      parent = next;
    }

    if (parentSegs.length === 0) {
      // Bare pattern like "Coin_*": search the whole tree, matching either the
      // last path segment or the node's own name.
      root.traverse((node) => {
        if (node === root) return;
        if (matchesPattern(node.name || '', pattern)) out.push(node);
        else {
          const cfId = node.userData?.cfId;
          if (cfId && matchesPattern(cfId.split('/').pop(), pattern)) out.push(node);
        }
      });
    } else if (parent && parent !== root) {
      search(parent);
    }

    // De-duplicate (a node can match by both name and segment).
    const seen = new Set();
    return out.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  }

  // Load config.json then layout.json.
  // Continuous 500ms re-apply ensures scale/visible survive startRace() recreation.
  let layoutApplyInterval = null;

  function startContinuousLayoutApply() {
    if (layoutApplyInterval) clearInterval(layoutApplyInterval);
    layoutApplyInterval = setInterval(() => {
      if (currentLayout) applyLayout(currentLayout);
    }, 500);
  }

  Promise.all([
    fetch('/contextforge/config.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/contextforge/layout.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  ]).then(([config, layout]) => {
    if (config && Array.isArray(config.drivenIds)) {
      cfConfig = config;
    }
    if (layout) {
      applyLayout(layout);
      // First-load burst: catch objects added asynchronously (e.g. async GLTF loads)
      for (let i = 1; i <= 6; i++) {
        setTimeout(() => applyLayout(layout), i * 500);
      }
      // Continuous re-apply for driven objects that get recreated by game code
      startContinuousLayoutApply();
    }
  });


  // --------------------------------------------------------------------------
  // Renderer Settings
  // --------------------------------------------------------------------------
  function getRendererSettings() {
    if (!renderer) return {};
    const sm = renderer.shadowMap || {};

    // Collect all lights from the scene
    const lights = [];
    if (scene) {
      scene.traverse((node) => {
        if (!node.isLight) return;
        const lightInfo = {
          name: node.name || '',
          type: node.type || node.constructor?.name || 'Light',
          intensity: typeof node.intensity === 'number' ? node.intensity : 1,
          castShadow: Boolean(node.castShadow)
        };
        if (node.color && typeof node.color.getHex === 'function') {
          lightInfo.color = node.color.getHex();
        }
        if (node.groundColor && typeof node.groundColor.getHex === 'function') {
          lightInfo.groundColor = node.groundColor.getHex();
        }
        lights.push(lightInfo);
      });
    }

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
        : (scene?.environment && typeof scene.environment.intensity === 'number' ? scene.environment.intensity : undefined),
      // Color management & version metadata
      threeRevision: (typeof THREE !== 'undefined' && THREE.REVISION) ? String(THREE.REVISION) : null,
      colorManagementEnabled: (typeof THREE !== 'undefined' && THREE.ColorManagement) ? Boolean(THREE.ColorManagement.enabled) : false,
      useLegacyLights: renderer.useLegacyLights !== undefined ? Boolean(renderer.useLegacyLights) : null,
      // All scene lights
      lights,
      hasEnvironment: Boolean(scene && scene.environment),
      hasFog: Boolean(scene && scene.fog)
    };
  }

  // --------------------------------------------------------------------------
  // Scene Snapshot Serialization
  // --------------------------------------------------------------------------

  /**
   * The ids of every object the game currently has, matching what the editor
   * indexes (cfId). Used for the cheap 1 s drift poll.
   */
  function collectSceneIds() {
    const ids = [];
    scene.traverse((node) => {
      if (node === scene) return;
      ids.push(node.userData?.cfId || getObjectId(node, scene));
    });
    return ids;
  }

  /**
   * Order-independent hash of an id list. MUST stay identical to the editor's
   * hashIdSet() in public/js/modeling/modeling-view.js — the two compare hashes
   * to decide whether the object set changed.
   */
  function hashIdList(ids) {
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

  // Enforce the layout after the game's frame callback. Games commonly rewrite
  // properties (e.g. kart.js does `this.mesh.scale.setScalar(KART_SCALE)`) every
  // frame, which would clobber a layout value applied earlier in the frame.
  // Re-applying after the callback makes layout values stick.

  // Tracks the last frame timestamp so mixers get the game's real delta time.
  let lastFrameTime = null;

  function withLayoutEnforcement(callback) {
    return function (time) {
      try {
        callback(time);
      } finally {
        if (currentLayout) {
          try { applyLayout(currentLayout); } catch (_) {}
        }
        // Advance the animation mixers with the game's delta time, inside the
        // existing per-frame layout enforcement.
        const now = typeof time === 'number' ? time : performance.now();
        let dt = lastFrameTime === null ? 0 : (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        // Guard against tab-switch spikes and zero/negative deltas.
        if (!isFinite(dt) || dt < 0) dt = 0;
        if (dt > 0.1) dt = 0.1;
        try { updateAnimationMixers(dt, now / 1000); } catch (_) {}
      }
    };
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
    return originalRAF(withLayoutEnforcement(callback));
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
          originalRAF(withLayoutEnforcement(cb));
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
      const ids = collectSceneIds();
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'snapshot',
          scene: snapshot,
          renderer: getRendererSettings(),
          idHash: hashIdList(ids),
          idCount: ids.length
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
          const ids = collectSceneIds();
          ws.send(
            JSON.stringify({
              version: 1,
              type: 'snapshot',
              scene: serializeScene(scene),
              renderer: getRendererSettings(),
              idHash: hashIdList(ids),
              idCount: ids.length
            })
          );
        } else if (msg.type === 'req_id_set') {
          // Cheap 1 s poll: ids + hash only, no scene serialization.
          const ids = collectSceneIds();
          ws.send(
            JSON.stringify({
              version: 1,
              type: 'id_set',
              ids,
              hash: hashIdList(ids)
            })
          );
        } else if (msg.type === 'apply_layout') {
          if (msg.layout) {
            applyLayout(msg.layout);
            startContinuousLayoutApply();
          }
        } else if (msg.type === 'set_config') {
          if (msg.config && Array.isArray(msg.config.drivenIds)) {
            cfConfig = msg.config;
            console.log('[ContextForge Runtime] Config updated, drivenIds:', cfConfig.drivenIds);
          }
        } else if (msg.type === 'set_model') {
          // Live model swap/param change from the editor. Merged into the current
          // layout so it is persisted and reapplied every frame like everything else.
          if (!currentLayout) currentLayout = { version: 1, objects: {} };
          if (!currentLayout.objects) currentLayout.objects = {};
          const targetId = msg.id;
          if (!currentLayout.objects[targetId]) currentLayout.objects[targetId] = {};
          if (msg.clear) {
            delete currentLayout.objects[targetId].model;
          } else if (msg.model) {
            currentLayout.objects[targetId].model = msg.model;
          }
          if (msg.siblings && typeof msg.siblings === 'string' && msg.siblings.includes('*')) {
            currentLayout.objects[msg.siblings] = {
              ...(currentLayout.objects[msg.siblings] || {}),
              model: msg.clear ? undefined : msg.model
            };
            if (msg.clear) delete currentLayout.objects[msg.siblings].model;
          }
          applyLayout(currentLayout);
        } else if (msg.type === 'set_anim') {
          // Animation bindings from the editor. Merged into the model spec so it
          // is persisted in layout.json and reapplied with everything else.
          if (!currentLayout) currentLayout = { version: 1, objects: {} };
          if (!currentLayout.objects) currentLayout.objects = {};
          const targetIds = [msg.id, msg.siblings].filter(Boolean);
          for (const tid of targetIds) {
            if (!currentLayout.objects[tid]) currentLayout.objects[tid] = {};
            const rec = currentLayout.objects[tid];
            if (!rec.model) rec.model = { path: '', fit: 'fit-bounds', scale: 1, offset: [0, 0, 0], rotation: [0, 0, 0] };
            if (msg.animation) rec.model.animation = msg.animation;
            else delete rec.model.animation;
          }
          applyLayout(currentLayout);
        } else if (msg.type === 'reload_model' || msg.type === 'model_changed') {
          // The model file changed on disk. The project server pushes
          // `model_changed` straight to the game; the editor echoes
          // `reload_model` after it has reloaded its own copy. Both mean the
          // same thing, so handle them identically.
          const path = msg.path;
          if (path) {
            const bust = msg.version || msg.mtime || Date.now();
            invalidateModelCaches(path);
            for (const [uuid] of animControllers) {
              // Force a rebuild on next apply.
              appliedModelSig.delete(uuid);
            }
            if (currentLayout) {
              for (const [id, data] of Object.entries(currentLayout.objects || {})) {
                if (data && data.model && data.model.path === path) {
                  const targets = id.includes('*')
                    ? findObjectsByGlobId(id, scene)
                    : [findObjectById(id, scene)].filter(Boolean);
                  for (const obj of targets) {
                    appliedModelSig.delete(obj.uuid);
                    const spec = { ...data.model, __v: bust };
                    Promise.resolve(applyModelToObject(obj, obj.userData?.cfId || id, spec))
                      .catch((err) => {
                        reportModelError(`${obj.userData?.cfId || id}: reload failed: ${err.message}`);
                      });
                  }
                }
              }
            }
          }
        } else if (msg.type === 'refit') {
          // Drop the cached reference box and re-apply the model unchanged, so
          // the fit is re-derived from the original's current geometry.
          const targets = msg.id && msg.id.includes('*')
            ? findObjectsByGlobId(msg.id, scene)
            : [findObjectById(msg.id, scene)].filter(Boolean);
          for (const obj of targets) {
            clearRefBox(obj);
            appliedModelSig.delete(obj.uuid);
            const spec = currentLayout && currentLayout.objects
              ? (currentLayout.objects[msg.id]?.model) : null;
            if (spec) {
              applyModelToObject(obj, obj.userData?.cfId || msg.id, { ...spec, __refit: true });
            }
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
    THREE,
    getRenderer: () => renderer,
    getCamera,
    getMode: () => currentMode,
    setMode,
    applyLayout,
    sendSnapshot: () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ version: 1, type: 'snapshot', scene: serializeScene(scene), renderer: getRendererSettings() }));
      }
    },
    findObjectById: (id) => findObjectById(id, scene),
    findObjectsByGlobId: (glob) => findObjectsByGlobId(glob, scene),
    getCurrentLayout: () => currentLayout,
    CF_MODEL_NAME,
    // ---- animation / test surface ----
    getAnimDebug: () => window.cf.debug(),
    getAnimController: (id) => {
      const ctl = findAnimControllerForId(id);
      if (!ctl) return null;
      return {
        current: ctl.current,
        autoState: ctl.autoState || null,
        smoothSpeed: ctl.smoothSpeed,
        clips: (ctl.clips || []).map((c) => ({ name: c.name, duration: c.duration, tracks: c.tracks.length })),
        actions: Array.from(ctl.actions.keys())
      };
    },
    setEditorPreviewing: (v) => { editorPreviewing = !!v; },
    isEditorPreviewing: () => editorPreviewing,
    // Measurement hook: suspend/resume all mixers without touching the layout.
    setAnimationSuspended: (v) => { animationSuspended = !!v; return animationSuspended; },
    isAnimationSuspended: () => animationSuspended,
    getAnimInstanceCount: () => animControllers.size
  };

  window.__CONTEXTFORGE_RUNTIME__ = runtimeInstance;
  return runtimeInstance;
}
