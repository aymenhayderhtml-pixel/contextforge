/**
 * scene-manager.js — Manages the Three.js scene, camera, and renderer.
 */

import { MathUtils } from './utils.js';

export class SceneManager {
  constructor() {
    this.entities = [];
    this.running = false;
  }

  addEntity(entity) {
    this.entities.push(entity);
  }

  removeEntity(entity) {
    const idx = this.entities.indexOf(entity);
    if (idx !== -1) this.entities.splice(idx, 1);
  }

  start() {
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
  }

  _loop() {
    if (!this.running) return;
    const dt = MathUtils.clampDelta(1 / 60);
    for (const entity of this.entities) {
      if (entity.update) entity.update(dt);
    }
    requestAnimationFrame(() => this._loop());
  }
}

export function createScene(name) {
  return new SceneManager();
}

/**
 * Tag an Object3D root with its source manifest asset id.
 * ContextForge live preview uses this tag for click-to-select asset inspection and swapping (T127).
 * @param {Object} object - Root Object3D of the loaded asset
 * @param {string} assetId - Project-relative asset id (e.g. 'models/character.glb')
 * @returns {Object}
 */
export function tagAsset(object, assetId) {
  if (object) {
    if (!object.userData) object.userData = {};
    object.userData.cfAssetId = assetId;
    object.userData.assetId = assetId;
    object.userData.manifestAssetId = assetId;
  }
  return object;
}

