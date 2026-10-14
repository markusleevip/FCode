import { CuaControlError, type ControlTarget } from "@fcode/cua/control-contract";
import { createHash } from "node:crypto";

export type ChromeSend = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, any>>;
export type ChromeNode = { backendId: number; role: string; name: string; focused: boolean; secure: boolean };
export type ChromeSpace = { document: string; origin: string; region: { x: number; y: number; width: number; height: number }; version: string; displayScale?: number };
export type ChromeState = { target: ControlTarget; space: ChromeSpace; nodes: ChromeNode[]; expiresAt: number };

export async function readFocusedChromeInput(send: ChromeSend, signal?: AbortSignal) {
  const doc = await send("DOM.getDocument", { depth: 0 }, signal);
  const selected = await send("DOM.querySelector", { nodeId: doc.root?.nodeId, selector: ":focus" }, signal);
  if (!selected.nodeId) return undefined;
  const described = await send("DOM.describeNode", { nodeId: selected.nodeId, depth: 0 }, signal);
  const node = described.node;
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  let secure = false;
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === "type" && String(attributes[i + 1]).toLowerCase() === "password") secure = true;
  }
  return { backendId: node?.backendNodeId, secure, editable: ["INPUT", "TEXTAREA"].includes(node?.nodeName) };
}

/** Fixed browser queries only. Never expose page values, raw protocol nodes or evaluation to the SDK. */
export async function readChromeSpace(send: ChromeSend, signal?: AbortSignal): Promise<ChromeSpace> {
  const [tree, metrics] = await Promise.all([
    send("Page.getFrameTree", {}, signal), send("Page.getLayoutMetrics", {}, signal),
  ]);
  const frame = tree.frameTree?.frame;
  const viewport = metrics.cssVisualViewport;
  let url: URL;
  try { url = new URL(frame?.url); } catch { throw new CuaControlError("target_changed"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      typeof frame?.loaderId !== "string" || typeof frame?.id !== "string" ||
      ![viewport?.clientWidth, viewport?.clientHeight, viewport?.pageX, viewport?.pageY, viewport?.scale].every(Number.isFinite) ||
      viewport.clientWidth <= 0 || viewport.clientHeight <= 0) throw new CuaControlError("target_changed");
  const region = { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight };
  const route = createHash("sha256").update(url.href).digest("hex");
  const displayScale = Number.isFinite(viewport.zoom) && viewport.zoom > 0 && viewport.zoom <= 10 &&
    viewport.scale === 1 && viewport.offsetX === 0 && viewport.offsetY === 0 ? viewport.zoom : undefined;
  return { document: `${frame.id}:${frame.loaderId}:${route}`, origin: url.origin, region, displayScale,
    version: JSON.stringify(["chrome-page-css", frame.id, frame.loaderId, route, viewport.clientWidth,
      viewport.clientHeight, viewport.pageX, viewport.pageY, viewport.scale]) };
}

export async function readChromeNodes(send: ChromeSend, signal?: AbortSignal): Promise<ChromeNode[]> {
  const focused = await readFocusedChromeInput(send, signal);
  const tree = await send("Accessibility.getFullAXTree", {}, signal);
  if (!Array.isArray(tree.nodes) || tree.nodes.length > 10000) throw new CuaControlError("resource_limit");
  const result: ChromeNode[] = [];
  for (const node of tree.nodes) {
    if (result.length >= 300) break;
    if (node.ignored || !Number.isInteger(node.backendDOMNodeId)) continue;
    const role = typeof node.role?.value === "string" ? node.role.value : "";
    const props = Array.isArray(node.properties) ? node.properties : [];
    if (props.some((p: any) => p.name === "disabled" && p.value?.value === true)) continue;
    let secure = false;
    if (["textbox", "searchbox"].includes(role)) {
      const described = await send("DOM.describeNode", { backendNodeId: node.backendDOMNodeId, depth: 0 }, signal);
      const attributes = described.node?.attributes;
      if (Array.isArray(attributes)) {
        for (let i = 0; i < attributes.length; i += 2) {
          if (attributes[i] === "type" && String(attributes[i + 1]).toLowerCase() === "password") secure = true;
        }
      }
    }
    // AX value fields are intentionally omitted, including editable text and protected values.
    const name = typeof node.name?.value === "string" ? node.name.value.slice(0, 512) : "";
    result.push({ backendId: node.backendDOMNodeId, role, name, secure,
      focused: focused?.backendId === node.backendDOMNodeId });
  }
  return result;
}

export function projectChromeNodes(nodes: ChromeNode[]) {
  return nodes.map((node, index) => ({ index, role: node.secure ? "AXSecureTextField" :
    node.role === "textbox" || node.role === "searchbox" ? "AXTextField" :
      node.role === "button" ? "AXButton" : node.role,
  subrole: node.secure ? "AXSecureTextField" : "", AXDescription: node.name, focused: node.focused,
  protected: node.secure, actions: [] }));
}

export async function verifyChromePassword(send: ChromeSend, state: ChromeState, index: number, signal?: AbortSignal) {
  const node = state.nodes[index];
  if (!node?.secure || !node.focused || !state.space.origin.startsWith("https://")) throw new CuaControlError("not_authorized");
  const current = await readChromeSpace(send, signal);
  if (current.version !== state.space.version) throw new CuaControlError("observation_stale");
  const doc = await send("DOM.getDocument", { depth: 0 }, signal);
  const selected = await send("DOM.querySelector", { nodeId: doc.root?.nodeId, selector: ":focus" }, signal);
  if (!selected.nodeId) throw new CuaControlError("not_authorized");
  const described = await send("DOM.describeNode", { nodeId: selected.nodeId, depth: 0 }, signal);
  const value = described.node;
  if (value?.backendNodeId !== node.backendId || value?.nodeName !== "INPUT" || !Array.isArray(value.attributes)) {
    throw new CuaControlError("not_authorized");
  }
  let password = false;
  for (let i = 0; i < value.attributes.length; i += 2) {
    if (value.attributes[i] === "type" && String(value.attributes[i + 1]).toLowerCase() === "password") password = true;
  }
  if (!password) throw new CuaControlError("not_authorized");
  return { origin: current.origin, field: `${current.document}:${node.backendId}`,
    name: node.name, region: current.region };
}
