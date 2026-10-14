export type WindowsControlFailureStage = "host-schema" | "host-operation" | "host-execute" | "native-start";

/** Bounded failure evidence without raw messages, stacks, request data or paths. */
export function windowsControlFailureDiagnostic(stage: WindowsControlFailureStage, error: unknown) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const errorType = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "ZodError", "CuaControlError"]
    .includes(name) ? name : "UnknownError";
  const location = error instanceof Error ? error.stack?.match(/(?:[/\\])(index\.js|chunk-[A-Z0-9]+\.js):(\d+):(\d+)/) : undefined;
  return { stage, errorType, ...(location ? { file: location[1], line: Number(location[2]), column: Number(location[3]) } : {}) };
}
