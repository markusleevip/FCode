import { createContext, runInContext, type Context } from "node:vm";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { IifeContextExecutor, type ReplExecutor } from "./executors.js";
import {
  PROCESS_MODULE_IDS,
  createReplRequire,
  createRestrictedProcessFacade,
  normalizeReplError,
  stringifyReplResult,
} from "./node-repl-runtime-helpers.js";

import {
  browserScreenshotIndexResult,
  latestCuaAppResult,
  type NodeReplCuaAppIdentity,
  type NodeReplImage,
  type NodeReplRequestMeta,
  type NodeReplRunResult,
  type NodeReplSessionOptions,
  type NodeReplStructuredResult,
  type NodeReplWriteSink,
} from "./node-repl-output.js";
export type {
  NodeReplCuaAppIdentity,
  NodeReplImage,
  NodeReplRequestMeta,
  NodeReplRunResult,
  NodeReplSessionOptions,
  NodeReplStructuredResult,
  NodeReplWriteSink,
} from "./node-repl-output.js";

/** Persistent per-session JavaScript engine. VM isolation does not replace permission gates. */
export class NodeReplSession {
  private context: Context;
  private readonly createInjectedGlobals: () => Record<PropertyKey, unknown>;
  private readonly restrictedProcess: Readonly<Record<string, unknown>> | undefined;
  private currentSink: NodeReplWriteSink | null = null;
  private nodeReplApi: {
    requestMeta: NodeReplRequestMeta;
    emitStructuredResult: (result: unknown) => void;
  } | null = null;
  private disposed = false;
  private cleanupContextResources: () => void = () => undefined;
  /** 执行+持久策略（默认路线 B）；切换 executor 即切换路线，run 主体不变。 */
  private readonly executor: ReplExecutor;

  constructor(options: NodeReplSessionOptions = {}) {
    const injectedGlobals = options.injectedGlobals;
    this.createInjectedGlobals =
      typeof injectedGlobals === "function" ? injectedGlobals : () => injectedGlobals ?? {};
    this.restrictedProcess = options.restrictProcess ? createRestrictedProcessFacade() : undefined;
    this.executor = new IifeContextExecutor();
    this.context = this.buildContext();
  }

  private buildContext(): Context {
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const scopedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setTimeout(() => {
        timeouts.delete(handle);
        callback(...args);
      }, delay);
      timeouts.add(handle);
      return handle;
    };
    const scopedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
      timeouts.delete(handle);
      clearTimeout(handle);
    };
    const scopedSetInterval = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setInterval(callback, delay, ...args);
      intervals.add(handle);
      return handle;
    };
    const scopedClearInterval = (handle: ReturnType<typeof setInterval>) => {
      intervals.delete(handle);
      clearInterval(handle);
    };
    this.cleanupContextResources = () => {
      for (const handle of timeouts) clearTimeout(handle);
      for (const handle of intervals) clearInterval(handle);
      timeouts.clear();
      intervals.clear();
    };
    // console tee 到当前 sink（每次 run 前设置），同时保留原始 console 便于调试。
    const teeConsole = {
      log: (...args: unknown[]) => this.emit(args),
      info: (...args: unknown[]) => this.emit(args),
      warn: (...args: unknown[]) => this.emit(args),
      error: (...args: unknown[]) => this.emit(args),
      debug: (...args: unknown[]) => this.emit(args),
    };
    // 用当前工作目录作 require 基准。
    const req = createReplRequire(createRequire(`${process.cwd()}/`), this.restrictedProcess);
    const nodeReplApi = {
      cwd: process.cwd(),
      homeDir: homedir(),
      tmpDir: tmpdir(),
      requestMeta: {} as NodeReplRequestMeta,
      write: (text: string) => this.emit([text]),
      // 把图片（如 tab.screenshot 结果）作为 image 内容块回给模型；接受 bytes/base64/dataUrl。
      emitImage: (image: unknown) => this.emitImage(image),
      // SDK 结果必须走结构化通道；否则模型的 console.log 会把 image/image_ref 拆成普通文本，
      // 官方 CUA 的精确帧校验就无法确认这两块仍然相邻且未被改写。
      emitStructuredResult: (result: unknown) => this.emitStructuredResult(result),
      setResponseMeta: (meta: unknown) => this.setResponseMeta(meta),
    };
    this.nodeReplApi = nodeReplApi;
    const sandbox: Record<PropertyKey, unknown> = {
      console: teeConsole,
      process: this.restrictedProcess ?? process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout: scopedSetTimeout,
      clearTimeout: scopedClearTimeout,
      setInterval: scopedSetInterval,
      clearInterval: scopedClearInterval,
      queueMicrotask,
      structuredClone,
      require: req,
      // 动态加载模块。用注入函数而非裸 import()：vm 里的 import() 需要 --experimental-vm-modules
      // 启动 flag（agent 是打包 binary，不便加 flag）；importModule 直通宿主 import()，无需 flag。
      // 模型与 browser skill 使用标准 await import("...")；executor 会按 AST 安全改写到该 loader。
      importModule: (specifier: string) => this.importModule(specifier),
      nodeRepl: nodeReplApi,
      // 每次 kernel reset 都重建 browser-client facade；旧 context 中的 browser/tab binding
      // 不能跨 reset 漂移到新 generation，保持新会话 bootstrap 边界一致。
      ...this.createInjectedGlobals(),
    };
    const context = createContext(sandbox);
    // globalThis 自引用，让模型可用 globalThis.x = ... 显式持久化。
    runInContext("globalThis.globalThis = globalThis;", context);
    return context;
  }

  private emit(args: unknown[]): void {
    if (!this.currentSink) {
      return;
    }
    const text = args
      .map((a) => (typeof a === "string" ? a : (stringifyReplResult(a) ?? "undefined")))
      .join(" ");
    this.currentSink.write(text);
  }

  /**
   * 收集一张图片到本次 run 输出（供 formatModelContent 转成 image 内容块给模型）。
   * 接受 Uint8Array/Buffer/number[]、data URL，或 { base64 | bytes, mimeType }。
   * 入参非法时抛 TypeError，让模型直接看到用法错误。
   */
  private emitImage(image: unknown): void {
    if (!this.currentSink) {
      return;
    }
    const directBytes =
      (ArrayBuffer.isView(image) && !(image instanceof DataView)) || Array.isArray(image)
        ? (image as Uint8Array | number[])
        : null;
    const rec =
      directBytes !== null
        ? { bytes: directBytes }
        : ((image ?? {}) as {
            base64?: unknown;
            bytes?: unknown;
            dataUrl?: unknown;
            mimeType?: unknown;
          });
    let base64: string | null = null;
    let dataUrlMimeType: string | undefined;
    if (typeof rec.dataUrl === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(rec.dataUrl);
      if (match) {
        dataUrlMimeType = match[1];
        base64 = match[2];
      }
    } else if (typeof rec.base64 === "string" && rec.base64.length > 0) {
      base64 = rec.base64;
    } else if (rec.bytes != null) {
      try {
        base64 = Buffer.from(rec.bytes as Uint8Array | readonly number[]).toString("base64");
      } catch {
        base64 = null;
      }
    }
    if (!base64) {
      throw new TypeError(
        "nodeRepl.emitImage requires bytes, dataUrl, { base64 }, or { bytes }; e.g. emitImage(await tab.screenshot())",
      );
    }
    const mimeType =
      typeof rec.mimeType === "string" && rec.mimeType
        ? rec.mimeType
        : (dataUrlMimeType ?? "image/png");
    this.currentSink.images.push({ base64, mimeType });
  }

  private setResponseMeta(meta: unknown): void {
    if (!this.currentSink) return;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new TypeError("nodeRepl.setResponseMeta requires a plain object");
    }
    Object.assign(this.currentSink.responseMeta, meta as Record<string, unknown>);
  }

  private emitStructuredResult(result: unknown): void {
    if (!this.currentSink) return;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a result object");
    }
    const candidate = result as { content?: unknown };
    if (!Array.isArray(candidate.content)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a content array");
    }
    for (const block of candidate.content) {
      if (
        !block ||
        typeof block !== "object" ||
        typeof (block as { type?: unknown }).type !== "string"
      ) {
        throw new TypeError("nodeRepl.emitStructuredResult content blocks require a type");
      }
    }
    this.currentSink.structuredResults.push(result as NodeReplStructuredResult);
  }

  /** browser-client transport 在同一次 js run 内把 backend meta 合并进工具结果。 */
  mergeResponseMeta(meta: Record<string, unknown>): void {
    if (!this.currentSink) return;
    const currentSurface = this.currentSink.responseMeta["fcode/toolSurface"];
    const nextSurface = meta["fcode/toolSurface"];

    // cell 结束时附加最后一次成功副作用的 openTabIds/sessionEnded；自动 preview 与后续
    // title/url/domSnapshot 读取不能把先前动作 meta 覆盖掉。
    if (
      currentSurface &&
      typeof currentSurface === "object" &&
      !Array.isArray(currentSurface) &&
      nextSurface &&
      typeof nextSurface === "object" &&
      !Array.isArray(nextSurface)
    ) {
      this.setResponseMeta({
        ...meta,
        "fcode/toolSurface": {
          ...(currentSurface as Record<string, unknown>),
          ...(nextSurface as Record<string, unknown>),
        },
      });
      return;
    }
    this.setResponseMeta(meta);
  }

  /** browser transport 记录模型显式 screenshot 的原始图片，供 emitImage 结果做来源对应。 */
  recordBrowserScreenshot(image: NodeReplImage): void {
    if (!this.currentSink) return;
    this.currentSink.browserScreenshots.push(image);
  }

  /**
   * CUA bridge 从 broker 响应记录本次调用的目标应用身份。
   *
   * 刻意不放进 sandbox globals（对比 write/emitImage/emitStructuredResult/setResponseMeta）：
   * 工具卡据此显示 App 图标，模型能写就能声称自己操作了别的应用。
   */
  recordCuaAppIdentity(app: NodeReplCuaAppIdentity): void {
    if (!this.currentSink) return;
    this.currentSink.cuaApps.push(app);
  }

  /** Only the authenticated host bridge records capture provenance, never sandbox globals. */
  recordCuaCapture(image: NodeReplImage): void {
    this.currentSink?.cuaCaptures.push(image);
  }

  /** Execute a cell with cancellation support. */
  async run(
    code: string,
    options: {
      signal?: AbortSignal;
      requestMeta?: NodeReplRequestMeta;
      syncTimeoutMs?: number;
    } = {},
  ): Promise<NodeReplRunResult> {
    if (this.disposed) {
      return {
        logs: "",
        error: { name: "DisposedError", message: "REPL session 已释放" },
      };
    }
    let buffer = "";
    const images: NodeReplImage[] = [];
    const browserScreenshots: NodeReplImage[] = [];
    const structuredResults: NodeReplStructuredResult[] = [];
    const responseMeta: Record<string, unknown> = {};
    const cuaApps: NodeReplCuaAppIdentity[] = [];
    const cuaCaptures: NodeReplImage[] = [];
    if (this.nodeReplApi) {
      this.nodeReplApi.requestMeta = { ...options.requestMeta };
    }
    this.currentSink = {
      write: (text: string) => {
        buffer += (buffer ? "\n" : "") + text;
      },
      images,
      browserScreenshots,
      structuredResults,
      responseMeta,
      cuaApps,
      cuaCaptures,
    };
    try {
      // 执行委托给 executor（默认路线 B：instrument 顶层声明 → async-IIFE → runInContext），
      // 使顶层 const/let/var/function/class 跨 js 调用持久（复制到 globalThis）。
      const value = await this.executor.run(
        code,
        this.context,
        options.signal,
        options.syncTimeoutMs,
      );
      return {
        result: stringifyReplResult(value),
        logs: buffer,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
        ...(cuaCaptures.length ? { transientMedia: true as const, cuaCaptures } : {}),
      };
    } catch (error) {
      // 注意：vm context 内抛出的 Error 属于不同 realm，host 侧 `instanceof Error` 为 false。
      // 因此按 error-like 结构（有 name/message/stack 字段）鸭子提取，而非包装成新 Error
      // （包装会把 message 变成 "Error: boom" 丢失原始 message）。
      const normalized = normalizeReplError(error);
      const mustResetKernel =
        normalized.name === "AbortError" ||
        normalized.name === "TimeoutError" ||
        normalized.message.includes("Script execution timed out");
      if (mustResetKernel && !this.disposed) {
        // Promise.race 只能停止等待，旧 async continuation/timer 仍可能在同一 global 上
        // 继续写状态。取消或 VM timeout 后废弃整个 context，并清掉该 generation 的 timers；
        // 后续调用只能看到 fresh kernel，不能观察到迟到 mutation。
        this.cleanupContextResources();
        this.context = this.buildContext();
        // 静默重建 context 会让模型继续调用已清除的 browser/tab 变量，
        // 将一次 timeout 扩大成连续 ReferenceError。错误本身必须暴露 reset 语义和恢复动作。
        normalized.message = `${normalized.message}; kernel reset, all previous bindings were cleared; reinitialize browser/tab bindings before rerunning`;
      }
      return {
        logs: buffer,
        error: normalized,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
        ...(cuaCaptures.length ? { transientMedia: true as const, cuaCaptures } : {}),
      };
    } finally {
      this.currentSink = null;
      if (this.nodeReplApi) {
        this.nodeReplApi.requestMeta = {};
      }
    }
  }

  private async importModule(specifier: string): Promise<unknown> {
    if (this.restrictedProcess && PROCESS_MODULE_IDS.has(specifier)) {
      return { ...this.restrictedProcess, default: this.restrictedProcess };
    }
    return await import(specifier);
  }

  /** 释放资源。 */
  dispose(): void {
    this.disposed = true;
    this.cleanupContextResources();
    this.currentSink = null;
  }
}
