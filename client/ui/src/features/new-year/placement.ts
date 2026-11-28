import { isWithinCrown } from "./art/Scene";

export function clampCrown(x: number, y: number) {
  y = Math.max(140, Math.min(930, Math.round(y)));
  const edge = Math.floor(0.42 * y) - 35;
  x = Math.max(500 - edge, Math.min(500 + edge, Math.round(x)));
  return { x, y };
}
export { isWithinCrown };
export function validRotation(rotation: number) {
  return Number.isInteger(rotation) && rotation >= -45 && rotation <= 45;
}
