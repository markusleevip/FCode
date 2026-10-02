import {
  collectVisibleFCodeBackgroundTaskControlItems,
  getFCodeBackgroundTaskControlItemElapsedMs,
  isActiveFCodeBackgroundTaskControlItem,
  parseFCodeBackgroundTaskControlItems,
  type FCodeBackgroundTaskControlItem,
  type FCodeBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type FCodeBackgroundBashJobStatus = FCodeBackgroundTaskControlStatus;
export type FCodeBackgroundBashJob = FCodeBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseFCodeBackgroundBashJobs(value: unknown): FCodeBackgroundBashJob[] {
  return parseFCodeBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveFCodeBackgroundBashJob(job: FCodeBackgroundBashJob): boolean {
  return isActiveFCodeBackgroundTaskControlItem(job);
}

export function getFCodeBackgroundBashJobElapsedMs(
  job: FCodeBackgroundBashJob,
  now = Date.now(),
): number {
  return getFCodeBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleFCodeBackgroundBashJobs(
  jobs: readonly FCodeBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<FCodeBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleFCodeBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    FCodeBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: FCodeBackgroundTaskControlItem): job is FCodeBackgroundBashJob {
  return job.taskKind === "bash";
}
