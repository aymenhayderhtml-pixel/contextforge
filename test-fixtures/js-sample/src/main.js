/**
 * main.js — Entry point for the Three.js sample app.
 * Imports the scene manager and player module, sets up the game loop.
 */

import { SceneManager } from './scene-manager.js';
import { createPlayer, Player } from './player.js';
import { loadModel } from './asset-loader.js';

const manager = new SceneManager();

export function startGame() {
  const player = createPlayer('Hero');
  manager.addEntity(player);

  loadModel('models/character.glb').then(model => {
    player.setModel(model);
  });

  manager.start();
}

export const GAME_VERSION = '0.1.0';
