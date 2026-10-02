// Control-plane project preparation adapted from CLIProxyAPI (MIT).
import { setTimeout as sleep } from "node:timers/promises";
import { ProviderOAuthTransport, object, string } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthTokens } from "./types.js";
import { ANTIGRAVITY_PROTOCOL_VERSION, antigravityHostHeaders } from "./antigravityProfile.js";
import { queryAntigravityModels } from "./modelCatalog.js";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
const MAX_ATTEMPTS = 5,
  POLL_INTERVAL_MS = 2000,
  PREPARATION_TIMEOUT_MS = 30000;
function project(value: unknown): string | undefined {
  const data = object(value);
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const id = string(data[key]) ?? string(object(data[key]).id);
    if (id) {
      if (
        id.length > 256 ||
        Array.from(id).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new ProviderOAuthError("invalid_project");
      return id;
    }
  }
  return undefined;
}
export function validateAntigravityProjectId(value: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id))
    throw new ProviderOAuthError("invalid_project_id");
  return id;
}
function tier(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data.allowedTiers))
    for (const value of data.allowedTiers) {
      const item = object(value);
      const id = string(item.id);
      if (item.isDefault === true && id) return item;
    }
  return string(object(data.currentTier).id) ? object(data.currentTier) : { id: "free-tier" };
}
export async function prepareAntigravityProject(
  transport: ProviderOAuthTransport,
  tokens: ProviderOAuthTokens,
  signal: AbortSignal,
  requestedProjectId?: string,
): Promise<ProviderOAuthTokens> {
  if (signal.aborted) throw new ProviderOAuthError("cancelled");
  const requested =
    requestedProjectId === undefined ? undefined : validateAntigravityProjectId(requestedProjectId);
  if (tokens.projectId) return { ...tokens, projectId: project({ project: tokens.projectId }) };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(PREPARATION_TIMEOUT_MS)]);
  const headers = {
    Authorization: `Bearer ${tokens.accessToken}`,
    ...antigravityHostHeaders(),
  };
  try {
    const loaded = await transport.json(
      LOAD_URL,
      {
        ...(requested ? { cloudaicompanionProject: requested } : {}),
        metadata: { ideType: "ANTIGRAVITY", ...(requested ? { duetProject: requested } : {}) },
      },
      deadline,
      headers,
    );
    let id = project(loaded);
    if (id) return { ...tokens, projectId: id };
    const selectedTier = tier(loaded);
    const userManaged =
      selectedTier.id !== "free-tier" &&
      (selectedTier.userDefinedCloudaicompanionProject === true ||
        selectedTier.id === "standard-tier");
    // Google 的自管项目档位不会自动返回 managed project；不能把已完成 Google 登录当成失败重试无限循环。
    if (userManaged && !requested) throw new ProviderOAuthError("project_required");
    const acceptRequestedProject = async (): Promise<ProviderOAuthTokens> => {
      const candidate = { ...tokens, projectId: requested! };
      await queryAntigravityModels(transport, candidate, deadline);
      return candidate;
    };
    if (userManaged && requested && string(object(loaded.currentTier).id))
      return await acceptRequestedProject();
    const body = {
      tier_id: selectedTier.id,
      ...(userManaged && requested ? { cloudaicompanionProject: requested } : {}),
      metadata: {
        ide_type: "ANTIGRAVITY",
        ide_name: "antigravity",
        ide_version: ANTIGRAVITY_PROTOCOL_VERSION,
        ...(userManaged && requested ? { duetProject: requested } : {}),
      },
    };
    for (let index = 0; index < MAX_ATTEMPTS; index++) {
      if (index) await sleep(POLL_INTERVAL_MS, undefined, { signal: deadline });
      const result = await transport.json(ONBOARD_URL, body, deadline, headers);
      if (result.done === true) {
        id = project(result.response);
        if (!id) {
          if (userManaged && requested) return await acceptRequestedProject();
          throw new ProviderOAuthError("project_not_returned");
        }
        return { ...tokens, projectId: id };
      }
      if (result.done !== undefined && result.done !== false)
        throw new ProviderOAuthError("invalid_response");
    }
    throw new ProviderOAuthError("project_onboarding_expired");
  } catch (error) {
    if (signal.aborted) throw new ProviderOAuthError("cancelled");
    if (deadline.aborted) throw new ProviderOAuthError("project_resolution_timeout");
    throw error;
  }
}
