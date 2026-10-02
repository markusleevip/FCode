import {
  buildRuntimeFCodeEndpointUrls,
  FCODE_ENV,
  type RuntimeFCodeEndpointEnv,
} from "@fcode/shared";

interface RendererImportMetaEnv {
  VITE_FCODE_BASE_URL?: string;
  VITE_FCODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererFCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeFCodeEndpointEnv {
  return {
    FCODE_ENV,
    // UI 侧的 fcode-plan 占位 provider 以前只看 FCODE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    FCODE_BASE_URL: env.VITE_FCODE_BASE_URL,
    FCODE_ENDPOINT_ORIGIN: env.VITE_FCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_FCODE_ENDPOINT_URLS = buildRuntimeFCodeEndpointUrls(
  createRendererFCodeEndpointEnv(),
);
