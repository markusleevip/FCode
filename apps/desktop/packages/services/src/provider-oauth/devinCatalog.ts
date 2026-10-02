// Unary GetCliModelConfigs protocol adapted from CLIProxyAPI (MIT).
import { createDevinClientMetadata } from "@fcode/shared/node";
import { DEVIN_NATIVE_MODEL_UID_PREFIX, FCODE_VERSION } from "@fcode/shared";
import { ProviderOAuthTransport } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthAccount } from "./types.js";

const ENDPOINT = "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
function invalid(): never {
  throw new ProviderOAuthError("invalid_model_catalog");
}
type Field = { id: number; wire: number; bytes?: Uint8Array };

function* fields(bytes: Uint8Array): Generator<Field> {
  let offset = 0;
  const uint = (): bigint => {
    let value = 0n;
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= bytes.length) invalid();
      const next = bytes[offset++];
      // 严格索引检查不推断前面的长度判断，显式拒绝缺失字节再参与位运算。
      if (next === undefined) invalid();
      if (shift === 63 && next > 1) invalid();
      value |= BigInt(next & 127) << BigInt(shift);
      if (!(next & 128)) return value;
    }
    return invalid();
  };
  let count = 0;
  while (offset < bytes.length) {
    if (++count > 65536) invalid();
    const tag = uint();
    const id = Number(tag >> 3n),
      wire = Number(tag & 7n);
    if (!Number.isSafeInteger(id) || id < 1 || id > 0x1fffffff) invalid();
    if (wire === 0) {
      uint();
      yield { id, wire };
      continue;
    }
    const length = wire === 2 ? uint() : wire === 1 ? 8n : wire === 5 ? 4n : invalid();
    if (length > BigInt(bytes.length - offset)) invalid();
    const value = bytes.subarray(offset, offset + Number(length));
    offset += Number(length);
    yield { id, wire, bytes: value };
  }
}

function decodeModel(bytes: Uint8Array): { id: string; name: string } {
  let uid: string | undefined, label: string | undefined;
  for (const field of fields(bytes)) {
    if (field.id !== 1 && field.id !== 22) continue;
    if (field.wire !== 2 || !field.bytes) invalid();
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(field.bytes);
    } catch {
      return invalid();
    }
    if (field.id === 22) {
      if (uid !== undefined) invalid();
      uid = value;
    } else {
      if (label !== undefined) invalid();
      label = value;
    }
  }
  if (
    !uid ||
    !/^[A-Za-z0-9_.-]+$/.test(uid) ||
    uid.length + DEVIN_NATIVE_MODEL_UID_PREFIX.length > 256
  )
    invalid();
  return { id: `${DEVIN_NATIVE_MODEL_UID_PREFIX}${uid}`, name: label?.trim() || uid };
}

function unaryRequest(metadata: Buffer): Buffer {
  let size = metadata.length;
  const length: number[] = [];
  do {
    length.push((size & 127) | (size > 127 ? 128 : 0));
    size = Math.floor(size / 128);
  } while (size);
  return Buffer.concat([Buffer.from([10, ...length]), metadata]);
}

export async function queryDevinCatalog(
  transport: ProviderOAuthTransport,
  account: ProviderOAuthAccount,
  signal: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  const token = account.tokens.accessToken;
  const bytes = await transport.binary(
    ENDPOINT,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${token}-${token}`,
        accept: "application/proto",
        "content-type": "application/proto",
        "Connect-Protocol-Version": "1",
        "user-agent": `FCode/${FCODE_VERSION}`,
      },
      body: new Uint8Array(
        unaryRequest(createDevinClientMetadata(token, account.tokens.deviceId ?? "")),
      ),
    },
    signal,
  );
  const models: { id: string; name: string }[] = [];
  for (const field of fields(bytes)) {
    if (field.id !== 1) continue;
    if (field.wire !== 2 || !field.bytes || models.length >= 4096) invalid();
    models.push(decodeModel(field.bytes));
  }
  return models;
}
