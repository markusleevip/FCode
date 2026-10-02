import type { FCodeProtocolMethod, FCodeProtocolRequestId } from "@fcode/shared";
import type { V4Method } from "@fcode/shared/fcode-protocol-v4";

export class FCodeProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "FCodeProtocolClientError";
  }
}

export class FCodeProtocolRequestTimeoutError extends Error {
  constructor(
    readonly method: FCodeProtocolMethod | V4Method,
    readonly requestId: FCodeProtocolRequestId,
    readonly timeoutMs: number,
  ) {
    super(`FCode Protocol request timed out: ${method}`);
    this.name = "FCodeProtocolRequestTimeoutError";
  }
}
