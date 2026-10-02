// Devin protobuf wire support adapted from CLIProxyAPI (MIT).
import { ModelErrorCode, ModelProtocolError } from "@fcode/contracts";

export const DEVIN_MAX_FRAME = 16 * 1024 * 1024;
export const DEVIN_MAX_DECOMPRESSED_FRAME = 64 * 1024 * 1024;
export const DEVIN_MAX_VALUE = 8 * 1024 * 1024;
export function devinFailure(message: string, request = false): never {
  throw new ModelProtocolError(
    request ? ModelErrorCode.InvalidModelRequest : ModelErrorCode.InvalidModelResponse,
    `Devin ${message}`,
  );
}
export interface DevinWireField {
  id: number;
  wire: number;
  value: bigint | Buffer;
}
export function devinVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0)
    devinFailure("requires unsigned integer fields", true);
  const output: number[] = [];
  do {
    output.push((value % 128) | (value >= 128 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(output);
}
export const devinInteger = (id: number, value: number) =>
  Buffer.concat([devinVarint(id * 8), devinVarint(value)]);
export function devinBytes(id: number, value: string | Uint8Array): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([devinVarint(id * 8 + 2), devinVarint(bytes.length), bytes]);
}
export function devinDouble(id: number, value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return Buffer.concat([devinVarint(id * 8 + 1), bytes]);
}
export function devinEnvelope(bytes: Uint8Array, flag = 0): Buffer {
  if (bytes.length > DEVIN_MAX_FRAME) devinFailure("request exceeds the frame limit", true);
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
export function devinFields(input: Uint8Array): DevinWireField[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  const read = (): bigint => {
    let value = 0n;
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= bytes.length) devinFailure("returned a truncated varint");
      const next = bytes[offset++];
      if (shift === 63 && next > 1) devinFailure("returned an overflowing varint");
      value |= BigInt(next & 127) << BigInt(shift);
      if (!(next & 128)) return value;
    }
    return devinFailure("returned an invalid varint");
  };
  const fields: DevinWireField[] = [];
  while (offset < bytes.length) {
    const tag = read();
    const id = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (id < 1 || id > 0x1fffffff) devinFailure("returned an invalid field tag");
    let value: Buffer | bigint;
    if (wire === 0) value = read();
    else {
      const size =
        wire === 2
          ? Number(read())
          : wire === 1
            ? 8
            : wire === 5
              ? 4
              : devinFailure("returned an unsupported wire type");
      if (!Number.isSafeInteger(size) || size > bytes.length - offset)
        devinFailure("returned a truncated field");
      value = bytes.subarray(offset, offset + size);
      offset += size;
    }
    fields.push({ id, wire, value });
  }
  return fields;
}
export function devinByteFields(fields: DevinWireField[], id: number): Buffer[] {
  return fields
    .filter((field) => field.id === id && field.wire === 2)
    .map((field) => field.value as Buffer);
}
export function devinString(fields: DevinWireField[], id: number): string {
  const value = devinByteFields(fields, id).at(-1);
  if (!value) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return devinFailure("returned invalid UTF-8");
  }
}
export function devinNumbers(fields: DevinWireField[], id: number): number[] {
  return fields
    .filter((field) => field.id === id && field.wire === 0)
    .map((field) => {
      const value = Number(field.value);
      if (!Number.isSafeInteger(value)) devinFailure("returned an overflowing numeric field");
      return value;
    });
}
export const devinRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
