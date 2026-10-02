import type { FCodeBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeFCodeBackgroundTaskControlItems(
  current: readonly FCodeBackgroundTaskControlItem[],
  updates: readonly FCodeBackgroundTaskControlItem[],
): FCodeBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
