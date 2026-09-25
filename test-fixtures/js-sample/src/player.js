/**
 * player.js — Player entity for the Three.js game.
 */

import { MathUtils } from './utils.js';

export class Player {
  constructor(name) {
    this.name = name;
    this.position = { x: 0, y: 0, z: 0 };
    this.health = 100;
    this.model = null;
  }

  setModel(model) {
    this.model = model;
  }

  update(dt) {
    this.position.x += MathUtils.clampDelta(dt) * 10;
  }

  takeDamage(amount) {
    this.health = MathUtils.clamp(this.health - amount, 0, 100);
  }
}

export function createPlayer(name) {
  return new Player(name);
}

export const MAX_PLAYERS = 4;
