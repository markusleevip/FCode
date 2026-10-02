import type { OpenAIProvider } from "@ai-sdk/openai";

type CodexSdkModel = ReturnType<OpenAIProvider["responses"]>;
type CallOptions = Parameters<CodexSdkModel["doGenerate"]>[0];

/** Force complete history before SDK conversion, including when a caller supplies store:true. */
export function withNativeResponsesModel(model: CodexSdkModel): CodexSdkModel {
  const options = (value: CallOptions): CallOptions => ({
    ...value,
    providerOptions: {
      ...value.providerOptions,
      // SDK 在编码前就会按 previousResponseId 丢弃历史，不能只在最终 body 中删除。
      openai: {
        ...value.providerOptions?.openai,
        store: false,
        previousResponseId: undefined,
        conversation: undefined,
      },
    },
  });
  return new Proxy(model, {
    get(target, key) {
      if (key === "doGenerate") return (value: CallOptions) => target.doGenerate(options(value));
      if (key === "doStream") return (value: CallOptions) => target.doStream(options(value));
      return Reflect.get(target, key, target);
    },
  });
}

export const withCodexNativeModel = withNativeResponsesModel;
