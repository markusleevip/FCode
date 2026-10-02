/** Label shown on models that Cline serves free of charge; intentionally not translated. */
export const FREE_MODEL_BADGE_LABEL = "Free";

// Cline's free preview models. `cline-free/*` is deliberately absent: Cline serves it to its own
// clients only (HTTP 403 for others), so it is not offered at all.
const FREE_MODEL_ID_PATTERN = /^stealth\//;

export function isFreeModel(modelId: string): boolean {
  return FREE_MODEL_ID_PATTERN.test(modelId);
}
