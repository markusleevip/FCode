import { CuaControlError } from "./control-contract.js";

export function mapFramePoint(frame, x, y) {
  const { width, height, region } = frame;
  if (![width, height, region?.x, region?.y, region?.width, region?.height].every(Number.isFinite) ||
      width <= 0 || height <= 0 || region.width <= 0 || region.height <= 0 ||
      !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new CuaControlError("invalid_request", "Point is outside its captured frame.");
  }
  return { x: region.x + x * region.width / width, y: region.y + y * region.height / height };
}

export function sameTarget(left, right) {
  return Boolean(left && right && left.appId === right.appId && left.pid === right.pid &&
    left.instanceId === right.instanceId && left.windowId === right.windowId);
}

export function sameRegion(left, right) {
  return Boolean(left && right && ["x", "y", "width", "height"].every((key) => left[key] === right[key]));
}
