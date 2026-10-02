import {
  fcodeProtocolMethods,
  fcodePluginsReferenceCatalogResultSchema,
  type FCodePluginsReferenceCatalogParams,
} from "@fcode/shared";
import type { FCodeProtocolClient } from "#src/fcode-agent/fcodeProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<FCodeProtocolClient, "request">,
  params: FCodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      fcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      fcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      fcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      fcodePluginsReferenceCatalogResultSchema,
    );
  }
}
