import type { ControlObservation, ControlRegion, ControlTarget } from "./control-contract.js";
export declare function mapFramePoint(frame: Pick<ControlObservation, "width" | "height" | "region">,
  x: number, y: number): { x: number; y: number };
export declare function sameTarget(left?: ControlTarget, right?: ControlTarget): boolean;
export declare function sameRegion(left?: ControlRegion, right?: ControlRegion): boolean;
