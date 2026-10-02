import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { scanFCodeDataDirectory, type FCodeDataSizeScanRequest } from "./fcodeDataSizeScanner.js";

type WorkerResponse =
  | { ok: true; result: Awaited<ReturnType<typeof scanFCodeDataDirectory>> }
  | { ok: false; error: string };

const workerParentPort = parentPort;
if (!isMainThread && workerParentPort) {
  void scanFCodeDataDirectory(workerData as FCodeDataSizeScanRequest)
    .then((result) => {
      workerParentPort.postMessage({ ok: true, result } satisfies WorkerResponse);
    })
    .catch((error) => {
      workerParentPort.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : "unknown worker error",
      } satisfies WorkerResponse);
    });
}
