export interface HelloMessage {
  type: "fcode-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "fcode-hello-ack";
  version: string;
  clientId: string;
}
