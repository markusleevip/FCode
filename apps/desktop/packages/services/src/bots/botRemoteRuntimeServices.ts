import {
  ChannelClient,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
  type MessagePortPayload,
} from "@fcode/rpc";
import {
  IFCodeTaskService,
  type IFCodeTaskService as IFCodeTaskServiceShape,
} from "#src/session/fcodeTaskService.js";
import {
  IFCodeAgentService,
  type IFCodeAgentService as IFCodeAgentServiceShape,
} from "#src/fcode-agent/fcodeAgent.js";
import {
  IFCodeSessionService,
  type IFCodeSessionService as IFCodeSessionServiceShape,
} from "#src/fcode-session/fcodeSession.js";
import {
  IModelSelectionService,
  type IModelSelectionService as IModelSelectionServiceShape,
} from "#src/model-provider/providerFacadeServices.js";

interface PortLike {
  on?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  off?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  addEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  removeEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  postMessage(message: MessagePortPayload): void;
  start?(): void;
  close?(): void;
}

function toMessagePortLike(port: PortLike): MessagePortLike {
  return {
    addEventListener(type, listener) {
      if (port.addEventListener) {
        port.addEventListener(type, listener);
        return;
      }
      port.on?.(type, listener);
    },
    removeEventListener(type, listener) {
      if (port.removeEventListener) {
        port.removeEventListener(type, listener);
        return;
      }
      port.off?.(type, listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start?.();
    },
    close() {
      port.close?.();
    },
  };
}

export interface RemoteBotWorkspaceRuntimeServices {
  fcodeAgentService: IFCodeAgentServiceShape;
  fcodeTaskService: IFCodeTaskServiceShape;
  fcodeSessionService: IFCodeSessionServiceShape;
  modelSelectionService: IModelSelectionServiceShape;
}

export function createRemoteRuntimeServicesFromPort(
  port: unknown,
): RemoteBotWorkspaceRuntimeServices {
  const protocol = new MessagePortProtocol(toMessagePortLike(port as PortLike));
  const client = new ChannelClient(protocol);
  return {
    fcodeAgentService: ProxyChannel.toService<IFCodeAgentServiceShape>(
      client.getChannel(IFCodeAgentService.channelName),
    ),
    fcodeTaskService: ProxyChannel.toService<IFCodeTaskServiceShape>(
      client.getChannel(IFCodeTaskService.channelName),
    ),
    fcodeSessionService: ProxyChannel.toService<IFCodeSessionServiceShape>(
      client.getChannel(IFCodeSessionService.channelName),
    ),
    modelSelectionService: ProxyChannel.toService<IModelSelectionServiceShape>(
      client.getChannel(IModelSelectionService.channelName),
    ),
  };
}
