import { getFCodeCopy, type SupportedLocale, type UiLocale } from "@fcode/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getFCodeCopy(locale, detectedLocale).cli.help(version);
}
