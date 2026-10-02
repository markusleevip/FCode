// Devin response fields adapted from CLIProxyAPI (MIT).
import {
  devinFields,
  devinByteFields,
  devinString,
  devinNumbers,
  devinFailure,
  type DevinWireField,
} from "./devin-native-protobuf.js";
export interface DevinUsage {
  input: number;
  output: number;
  cached: number;
  written: number;
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function dimensions(fields: DevinWireField[]) {
  const values: Record<string, number> = {};
  for (const raw of devinByteFields(fields, 28)) {
    const group = devinFields(raw);
    if (devinString(group, 1).toLowerCase() !== "token usage") continue;
    for (const metric of devinByteFields(group, 2)) {
      const parts = devinFields(metric);
      const key = devinString(parts, 5);
      for (const rawValue of devinByteFields(parts, 4)) {
        const field = devinFields(rawValue).find((item) => item.id === 2 && item.wire === 5);
        if (field) {
          const value = (field.value as Buffer).readFloatLE();
          if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
            devinFailure("returned invalid token metrics");
          values[key] = Math.trunc(value);
        }
      }
    }
  }
  return values;
}
export function decodeDevinFrame(bytes: Uint8Array) {
  const fields = devinFields(bytes);
  const usageRaw = devinByteFields(fields, 7).at(-1);
  let usage: Partial<DevinUsage> = {};
  if (usageRaw) {
    const values = devinFields(usageRaw);
    const status = devinNumbers(values, 6).at(-1) ?? 0;
    if (status >= 400) devinFailure(`upstream reported HTTP ${status} in usage`);
    if (devinNumbers(values, 2).length) usage.input = sum(devinNumbers(values, 2));
    if (devinNumbers(values, 3).length) usage.output = devinNumbers(values, 3).at(-1)!;
    if (devinNumbers(values, 5).length) usage.cached = devinNumbers(values, 5).at(-1)!;
    if (devinNumbers(values, 4).length) usage.written = sum(devinNumbers(values, 4));
  }
  const metrics = dimensions(fields);
  if (!usage.input && metrics.input_tokens !== undefined) usage.input = metrics.input_tokens;
  if (!usage.output && metrics.output_tokens !== undefined) usage.output = metrics.output_tokens;
  if (!usage.cached && metrics.cached_input_tokens !== undefined)
    usage.cached = metrics.cached_input_tokens;
  return {
    id: devinString(fields, 1),
    stop: devinNumbers(fields, 5).at(-1) ?? 0,
    text: Buffer.concat(devinByteFields(fields, 3)),
    thinking: Buffer.concat(devinByteFields(fields, 9)),
    signature: Buffer.concat(devinByteFields(fields, 10)),
    signatureType: devinString(fields, 21),
    usage,
    tools: devinByteFields(fields, 6).map((raw) => {
      const tool = devinFields(raw);
      if ((devinNumbers(tool, 6).at(-1) ?? 0) !== 0)
        devinFailure("returned an unsupported custom tool call");
      const args = devinByteFields(tool, 3);
      return {
        id: devinString(tool, 1),
        name: devinString(tool, 2),
        arguments: Buffer.concat(args.length ? args : devinByteFields(tool, 4)),
      };
    }),
  };
}
