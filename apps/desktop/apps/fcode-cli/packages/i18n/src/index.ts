import type { UiLocale, SupportedLocale } from "@fcode/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { FCodeCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, FCodeCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, FCodeCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function getFCodeCopy(locale?: UiLocale | string, detected?: string | null): FCodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
