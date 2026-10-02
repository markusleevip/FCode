import type { Event, IDisposable } from "@fcode/rpc";
import type { FCodeProtocolMessage } from "@fcode/shared";

export type FCodeProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface FCodeProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface FCodeProtocolTransport extends IDisposable {
  readonly kind: FCodeProtocolTransportKind;
  readonly onMessage: Event<FCodeProtocolMessage>;
  readonly onClose: Event<FCodeProtocolTransportClosedEvent>;
  send(message: FCodeProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
