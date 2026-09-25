/**
 * utils.js — Shared math utilities. Leaf module with no imports.
 */

export const MathUtils = {
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  clampDelta(dt) {
    return Math.min(dt, 0.1);
  },

  lerp(a, b, t) {
    return a + (b - a) * t;
  }
};

export function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

export default MathUtils;
