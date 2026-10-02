// Ported from CLIProxyAPI internal/auth; see third-party/upstream/879792e89cf1bdd6a8d446033ec87e30496f97dcafc4656dc53f641509b346a6.txt.
import type { ProviderOAuthSupplier } from "./contract.js";

export const GOOGLE_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// 上游开源安装式客户端的公开 OAuth 配置，不是用户凭据。
export const GOOGLE_CLIENT_SECRET = "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";
export const CLAUDE_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

export const OAUTH_CLIENTS = {
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    tokenEndpoint: "https://auth.openai.com/oauth/token",
  },
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    tokenEndpoint: "https://platform.claude.com/v1/oauth/token",
  },
  antigravity: { clientId: GOOGLE_CLIENT_ID, tokenEndpoint: "https://oauth2.googleapis.com/token" },
  kimi: {
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    tokenEndpoint: "https://auth.kimi.com/api/oauth/token",
    deviceEndpoint: "https://auth.kimi.com/api/oauth/device_authorization",
  },
  "kimi-ai": {
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    tokenEndpoint: "https://auth.kimi.ai/api/oauth/token",
    deviceEndpoint: "https://auth.kimi.ai/api/oauth/device_authorization",
  },
  xai: { clientId: "b1a00492-073a-47ea-816f-4c329264a828" },
  devin: { tokenEndpoint: "https://api.devin.ai/auth/cli/token" },
  // Public WorkOS client of the Cline CLI/extension, not a user credential.
  cline: {
    clientId: "client_01K3A541FN8TA3EPPHTD2325AR",
    tokenEndpoint: "https://api.workos.com/user_management/authenticate",
    deviceEndpoint: "https://api.workos.com/user_management/authorize/device",
  },
  meta: {
    clientId: "1031625952748946",
    tokenEndpoint: "https://auth.meta.com/oidc/device/token/",
    deviceEndpoint: "https://auth.meta.com/oidc/device/authorization/",
  },
} satisfies Record<ProviderOAuthSupplier, object>;
