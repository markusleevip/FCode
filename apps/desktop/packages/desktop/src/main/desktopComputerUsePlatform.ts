/** Platform composition only. Factories retain their own lazy lifecycle. */
export function dispatchDesktopComputerUse<T, W>(platform: string, factories: {
  macOS(): T;
  windows(): W;
  unavailable(): T;
}): T | W {
  if (platform === "darwin") return factories.macOS();
  if (platform === "win32") return factories.windows();
  return factories.unavailable();
}
