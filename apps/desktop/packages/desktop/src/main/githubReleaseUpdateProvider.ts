import { FCODE_VERSION, type ElectronReleaseChannel } from "@fcode/shared";
import {
  Provider,
  type AppUpdater,
  type ResolvedUpdateFileInfo,
  type UpdateInfo,
} from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import type { CustomPublishOptions } from "builder-util-runtime";
import { buildGithubReleasesApiUrl, pickGithubReleaseUpdateInfo } from "./githubRelease.js";

const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";

interface GithubReleaseUpdateProviderOptions extends CustomPublishOptions {
  resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
}

/**
 * Looks up the newest FCode release on GitHub. It only reports availability; installing is left to
 * the user, so the platform needs no code signing or update manifests.
 */
export class GithubReleaseUpdateProvider extends Provider<UpdateInfo> {
  private readonly options: GithubReleaseUpdateProviderOptions;

  // electron-updater instantiates custom providers as (options, updater, runtimeOptions); the
  // runtime options carry the network executor, so they must be the argument given to super().
  constructor(
    options: GithubReleaseUpdateProviderOptions,
    _updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.options = options;
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const channel =
      (await this.options.resolveReleaseChannel?.()) === "preview" ? "preview" : "stable";
    const raw = await this.httpRequest(buildGithubReleasesApiUrl(channel), {
      accept: GITHUB_ACCEPT_HEADER,
      "user-agent": `FCode/${FCODE_VERSION}`,
    });
    if (!raw) {
      throw new Error("Empty GitHub release response");
    }
    const info = pickGithubReleaseUpdateInfo(JSON.parse(raw), channel);
    if (!info) {
      throw new Error("GitHub response contains no usable release");
    }
    return info;
  }

  override resolveFiles(_updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    throw new Error("In-app download is not supported; open the release page instead");
  }
}
