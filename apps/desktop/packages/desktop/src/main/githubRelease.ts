import type { ElectronReleaseChannel } from "@fcode/shared";
import type { UpdateInfo } from "electron-updater";

export const GITHUB_RELEASES_REPOSITORY = "markusleevip/FCode";
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_RELEASES_REPOSITORY}/releases`;

const GITHUB_API_ORIGIN = "https://api.github.com";
// The preview channel also considers pre-releases; ten entries are plenty to find the newest one.
const PREVIEW_RELEASES_PAGE_SIZE = 10;

/** The update info enriched with where the release can be downloaded from. */
export type GithubReleaseUpdateInfo = UpdateInfo & {
  fcodeReleaseChannel: ElectronReleaseChannel;
  fcodeReleaseUrl: string;
};

interface GithubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function isRecord(value: unknown): value is GithubReleasePayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildGithubReleasesApiUrl(channel: ElectronReleaseChannel): URL {
  return new URL(
    channel === "preview"
      ? `/repos/${GITHUB_RELEASES_REPOSITORY}/releases?per_page=${PREVIEW_RELEASES_PAGE_SIZE}`
      : `/repos/${GITHUB_RELEASES_REPOSITORY}/releases/latest`,
    GITHUB_API_ORIGIN,
  );
}

/** Only this repository's GitHub release pages are ever opened; anything else falls back to the list. */
export function resolveGithubReleaseUrl(value: unknown): string {
  const candidate = readString(value);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.pathname.startsWith(`/${GITHUB_RELEASES_REPOSITORY}/releases`)
      ) {
        return url.toString();
      }
    } catch {
      // Fall through to the release list.
    }
  }
  return GITHUB_RELEASES_PAGE_URL;
}

/** Turns one GitHub release into electron-updater update info; null when it is not a usable release. */
export function toGithubReleaseUpdateInfo(
  payload: unknown,
  channel: ElectronReleaseChannel,
): GithubReleaseUpdateInfo | null {
  if (!isRecord(payload) || payload.draft === true) return null;
  const tag = readString(payload.tag_name);
  const version = tag?.replace(/^v/i, "");
  // A tag that is not a plain x.y.z[-pre] version must never be mistaken for an update.
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  if (payload.prerelease === true && channel !== "preview") return null;
  const releaseUrl = resolveGithubReleaseUrl(payload.html_url);
  const releaseDate = readString(payload.published_at);
  const releaseNotes = readString(payload.body);
  return {
    version,
    // Nothing is downloaded in-app: the update button opens the release page instead.
    files: [],
    path: releaseUrl,
    sha512: "",
    releaseName: readString(payload.name) ?? `v${version}`,
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    fcodeReleaseChannel: channel,
    fcodeReleaseUrl: releaseUrl,
  } as GithubReleaseUpdateInfo;
}

/** Picks the newest usable release from a `/releases/latest` object or a `/releases` list. */
export function pickGithubReleaseUpdateInfo(
  parsed: unknown,
  channel: ElectronReleaseChannel,
): GithubReleaseUpdateInfo | null {
  for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
    const info = toGithubReleaseUpdateInfo(candidate, channel);
    if (info) return info;
  }
  return null;
}
