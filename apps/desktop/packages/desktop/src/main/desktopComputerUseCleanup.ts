import { CuaControlError } from "@fcode/cua/control-contract";

/** Close captured owned backends independently; one failure must not orphan the other. */
export async function closeComputerUseBackends(...backends: Array<{ close(): Promise<unknown> } | undefined>) {
  const results = await Promise.allSettled(backends.map(async (backend) => { await backend?.close(); }));
  if (results.some((result) => result.status === "rejected")) {
    throw new CuaControlError("backend_cleanup_failed", "Computer Use backend cleanup did not complete successfully.");
  }
}
