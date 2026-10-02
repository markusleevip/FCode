import type { ModelSelection, ProviderRegistryView } from "@fcode/provider";
import {
  CLAUDE_NATIVE_ACCOUNT_HEADER,
  DEVIN_NATIVE_DEVICE_HEADER,
  ANTIGRAVITY_NATIVE_PROJECT_HEADER,
  VERTEX_NATIVE_PROJECT_HEADER,
  VERTEX_NATIVE_LOCATION_HEADER,
} from "@fcode/shared";
import type { AccountRequestAuthMaterial } from "../model-provider/accountRequestAuthService.js";
import { formatClineApiToken } from "./clineCredentials.js";
import { ProviderOAuthError, type ProviderOAuthAccount } from "./types.js";

/** Host 按已发布 Registry 解析账号；不接受 Agent/Renderer 自报 accountId。 */
export function createProviderOAuthRequestAuthResolver(options: {
  getRegistryView(): Promise<ProviderRegistryView>;
  resolveAccount(accountId: string): Promise<ProviderOAuthAccount>;
}): (request: {
  providerId: string;
  modelSelection: ModelSelection;
}) => Promise<AccountRequestAuthMaterial | undefined> {
  return async (request) => {
    const view = await options.getRegistryView();
    const provider = view.providers.find((item) => item.providerId === request.providerId);
    if (provider?.config.access.type !== "provider-oauth") return undefined;
    if (
      request.modelSelection.providerId !== provider.providerId ||
      !provider.models.some((model) => model.modelId === request.modelSelection.modelId)
    )
      throw new ProviderOAuthError("invalid_model_binding");
    const access = provider.config.access;
    const account = await options.resolveAccount(access.accountId);
    if (account.supplier !== access.supplier)
      throw new ProviderOAuthError("account_identity_mismatch");
    if (!account.enabled) throw new ProviderOAuthError("account_disabled");
    if (account.needsAuthorization) throw new ProviderOAuthError("reauthorization_required");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${account.tokens.accessToken}`,
    };
    if (account.supplier === "codex" && account.tokens.accountIdentity)
      headers["ChatGPT-Account-Id"] = account.tokens.accountIdentity;
    if (account.supplier === "claude") {
      // 功能 beta 由 Agent 合并；这里给单个 OAuth beta 会覆盖供应商的已配置能力。
      headers[CLAUDE_NATIVE_ACCOUNT_HEADER] = account.tokens.accountIdentity ?? "";
    }
    if ((account.supplier === "kimi" || account.supplier === "kimi-ai") && account.tokens.deviceId)
      headers["X-Msh-Device-Id"] = account.tokens.deviceId;
    if (account.supplier === "devin")
      headers[DEVIN_NATIVE_DEVICE_HEADER] = account.tokens.deviceId ?? "";
    if (account.supplier === "antigravity") {
      if (!account.tokens.projectId) throw new ProviderOAuthError("missing_project");
      headers[ANTIGRAVITY_NATIVE_PROJECT_HEADER] = account.tokens.projectId;
    }
    if (account.supplier === "vertex") {
      if (!account.tokens.projectId) throw new ProviderOAuthError("missing_project");
      headers[VERTEX_NATIVE_PROJECT_HEADER] = account.tokens.projectId;
      headers[VERTEX_NATIVE_LOCATION_HEADER] = account.tokens.location ?? "global";
    }
    if (account.supplier === "cline") {
      // Cline rejects a bare JWT; the Authorization header must carry the `workos:` prefix.
      const apiKey = formatClineApiToken(account.tokens.accessToken);
      headers.Authorization = `Bearer ${apiKey}`;
      return { apiKey, headers };
    }
    return { apiKey: account.tokens.accessToken, headers };
  };
}
