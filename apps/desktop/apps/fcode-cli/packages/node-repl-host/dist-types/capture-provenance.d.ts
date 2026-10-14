import type { NodeReplRunResult } from "@fcode/core/repl";
/** Match output occurrences to authenticated captures, without trusting sandbox metadata. */
export declare function cuaScreenshotContentIndices(content: readonly {
    type: string;
    data?: unknown;
    mimeType?: unknown;
}[], captures: NodeReplRunResult["cuaCaptures"]): number[];
//# sourceMappingURL=capture-provenance.d.ts.map