/**
 * asset-loader.js — Loads 3D models and textures.
 * References .glb files as asset dependencies.
 */

export async function loadModel(path) {
  // In a real app, this would use THREE.GLTFLoader
  console.log(`Loading model: ${path}`);
  return { path, loaded: true };
}

export async function loadTexture(path) {
  console.log(`Loading texture: ${path}`);
  return { path, loaded: true };
}
