export type ResponsesRecord = Record<string, unknown>;

export function responsesSupplierLabel(supplier: string): string {
  return supplier === "codex"
    ? "Codex"
    : supplier === "xai"
      ? "xAI"
      : supplier === "meta"
        ? "Meta"
        : supplier;
}

export function asResponsesRecord(value: unknown): ResponsesRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ResponsesRecord)
    : undefined;
}

/** One response owner; vendor profiles only transform protocol fields/events. */
export interface ResponsesNativeProfile {
  readonly supplier: string;
  normalizeRequest(body: ResponsesRecord): ResponsesRecord;
  patchHeaders(headers: Headers): void;
  createEventNormalizer?(
    body: ResponsesRecord,
  ): (event: ResponsesRecord) => readonly ResponsesRecord[];
  normalizeJson?(value: unknown, body: ResponsesRecord): unknown;
}
