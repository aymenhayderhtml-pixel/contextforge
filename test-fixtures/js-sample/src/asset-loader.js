/**
 * asset-loader.js — Loads 3D models and textures.
 * References .glb files as asset dependencies.
 */

import { tagAsset } from './scene-manager.js';

export async function loadModel(path) {
  // In a real app, this would use THREE.GLTFLoader
  console.log(`Loading model: ${path}`);
  const model = { path, loaded: true, userData: {} };
  return tagAsset(model, path);
}

export async function loadTexture(path) {
  console.log(`Loading texture: ${path}`);
  return { path, loaded: true };
}
