import type { ICredentialService } from "../credential/credential.js";
import { ProviderOAuthError } from "./types.js";

/** 仅包装对外 Credential RPC；Host 内部的加密存储保留原服务。 */
export function createProviderOAuthCredentialRpc(
  credentials: ICredentialService,
): ICredentialService {
  const check = (key: string) => {
    if (typeof key !== "string" || key.startsWith("provider-oauth:"))
      throw new ProviderOAuthError("protected_credential");
  };
  // 通用 ProxyChannel 会解析继承属性；保护 wrapper 必须仅含三个契约方法。
  return Object.freeze(
    Object.setPrototypeOf(
      {
        load: async (key) => {
          check(key);
          return credentials.load(key);
        },
        save: async (key, value) => {
          check(key);
          await credentials.save(key, value);
        },
        delete: async (key) => {
          check(key);
          await credentials.delete(key);
        },
      } satisfies ICredentialService,
      null,
    ),
  );
}
