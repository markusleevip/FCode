import { createHash } from "node:crypto";

/** Sampling misses interior screenshot removal. Hash every message in the compared prefix. */
export function fingerprintModelIOPrefix(messages: readonly unknown[], count = messages.length): string {
  const hash = createHash("sha256");
  for (let index = 0; index < count; index++) {
    hash.update(JSON.stringify(messages[index]) ?? "undefined");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Count the actual provider body before debug delta/tail projection. */
export function countProviderBodyImages(body: Record<string, unknown>): number | undefined {
  const collection = body.messages ?? body.input;
  if (collection === undefined) return undefined;
  const visit = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + visit(item), 0);
    if (!value || typeof value !== "object") return 0;
    const item = value as Record<string, unknown>;
    const image = (item.type === "image_url" || item.type === "input_image") && item.image_url !== undefined ||
      item.type === "image" && item.source !== undefined;
    return Number(image) + Object.values(item).reduce<number>((sum, child) => sum + visit(child), 0);
  };
  return visit(collection);
}
