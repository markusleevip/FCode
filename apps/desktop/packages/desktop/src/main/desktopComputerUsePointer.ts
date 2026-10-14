import { computerUsePointerReceiptSchema, computerUsePreviewFrameGeometrySchema,
  type ComputerUsePointerReceipt, type ComputerUsePreviewFrameGeometry, type ComputerUseOperationPointer } from "@fcode/shared";

const POINTER_TTL_MS = 3000;
export type ComputerUsePointerDiagnostic = "geometry-accepted" | "geometry-invalid" |
  "receipt-accepted" | "receipt-invalid" | "receipt-future" | "receipt-expired" |
  "frame-invalidated-receipt" | "projection-rejected" | "pointer-projected";
type Region = ComputerUsePreviewFrameGeometry["region"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameRegion = (a: Region, b: Region) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const contains = (outer: Region, inner: Region) => inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const identity = (target: ComputerUsePreviewFrameGeometry["target"]) =>
  [target.appId, target.pid, target.instanceId, target.windowId];

/** Maps backend-acknowledged positions onto a matching full-window preview only. */
export function projectComputerUsePointer(receipt: ComputerUsePointerReceipt, geometry: ComputerUsePreviewFrameGeometry) {
  if (!same(identity(receipt.target), identity(geometry.target)) || !sameRegion(receipt.region, geometry.region) ||
      receipt.topologyVersion !== geometry.topologyVersion) return undefined;
  let { x, y } = receipt;
  if (receipt.space === "page") {
    const content = geometry.contentRegion, page = geometry.page;
    if (!content || !page || !receipt.page || page.version !== receipt.page.version ||
        page.scale !== receipt.page.scale || !sameRegion(page.region, receipt.page.region) || !contains(geometry.region, content)) return undefined;
    // AXWebArea includes scrollbars; ratio-of-widths would stretch every click horizontally.
    // Use the actual browser zoom and only accept a small clipped scrollbar remainder.
    const scale = page.scale;
    const spareWidth = content.width - page.region.width * scale, spareHeight = content.height - page.region.height * scale;
    if (!Number.isFinite(scale) || scale <= 0 || spareWidth < -1 || spareHeight < -1 ||
        spareWidth > 32 * scale || spareHeight > 32 * scale ||
        x < page.region.x || y < page.region.y || x >= page.region.x + page.region.width || y >= page.region.y + page.region.height) return undefined;
    x = content.x + (x - page.region.x) * scale;
    y = content.y + (y - page.region.y) * scale;
  }
  x = (x - geometry.region.x) * geometry.width / geometry.region.width;
  y = (y - geometry.region.y) * geometry.height / geometry.region.height;
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < geometry.width && y < geometry.height ? { x, y } : undefined;
}

export class DesktopComputerUsePointer {
  private geometry?: ComputerUsePreviewFrameGeometry;
  private receipt?: ComputerUsePointerReceipt;
  private revision = 0;
  private sequence = 0;
  private reported?: Set<ComputerUsePointerDiagnostic>;
  constructor(private now: () => number = Date.now,
    private diagnostic?: (code: ComputerUsePointerDiagnostic) => void) {
    if (diagnostic) this.reported = new Set();
  }

  private report(code: ComputerUsePointerDiagnostic) {
    if (!this.diagnostic || !this.reported || this.reported.has(code)) return;
    this.reported.add(code);
    // Optional diagnostics must not affect input or expose the rejected backend object.
    try { this.diagnostic(code); } catch { /* Display diagnostics are best effort. */ }
  }

  frame(raw: unknown) {
    const parsed = computerUsePreviewFrameGeometrySchema.safeParse(raw);
    if (!parsed.success) { this.report("geometry-invalid"); this.reset(); return; }
    this.report("geometry-accepted");
    if (!same(parsed.data, this.geometry)) {
      if (this.receipt && !projectComputerUsePointer(this.receipt, parsed.data)) {
        this.report("frame-invalidated-receipt"); this.clear();
      }
      this.revision++;
      this.geometry = parsed.data;
    }
  }
  input(raw: unknown) {
    const parsed = computerUsePointerReceiptSchema.safeParse(raw);
    const now = this.now();
    // Native Date carries fractional milliseconds; Date.now uses integer milliseconds.
    // Flooring display time never extends its TTL or admits a later millisecond bucket.
    const value = parsed.success ? { ...parsed.data, updatedAt: Math.floor(parsed.data.updatedAt) } : undefined;
    this.receipt = value && value.updatedAt <= now && value.updatedAt + POINTER_TTL_MS > now ? value : undefined;
    if (!value) this.report("receipt-invalid");
    else if (this.receipt) this.report("receipt-accepted");
    else this.report(value.updatedAt > now ? "receipt-future" : "receipt-expired");
    this.sequence++;
  }
  clear() { this.receipt = undefined; }
  reset() { this.clear(); this.geometry = undefined; }
  state(): { previewGeometry?: { revision: number; width: number; height: number }; operationPointer?: ComputerUseOperationPointer } {
    const geometry = this.geometry, receipt = this.receipt;
    if (!geometry) return {};
    const result: ReturnType<DesktopComputerUsePointer["state"]> = {
      previewGeometry: { revision: this.revision, width: geometry.width, height: geometry.height },
    };
    if (!receipt || receipt.updatedAt + POINTER_TTL_MS <= this.now()) {
      if (receipt) this.report("receipt-expired");
      this.clear(); return result;
    }
    const point = projectComputerUsePointer(receipt, geometry);
    if (!point) { this.report("projection-rejected"); return result; }
    this.report("pointer-projected");
    result.operationPointer = { ...point, previewRevision: this.revision, sequence: this.sequence,
      kind: receipt.kind, phase: receipt.phase, updatedAt: receipt.updatedAt, expiresAt: receipt.updatedAt + POINTER_TTL_MS };
    return result;
  }
}
