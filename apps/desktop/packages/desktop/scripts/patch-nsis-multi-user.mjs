import { readFile, writeFile } from "node:fs/promises";

const marker = "; fcode-install-directory-v1";
export function patchNsisMultiUserSource(source) {
  if (source.includes(marker)) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let result = source.replaceAll("\r\n", "\n");
  for (const variable of ["perUserInstallationFolder", "perMachineInstallationFolder"]) {
    const anchor = `      StrCpy $INSTDIR $${variable}`;
    if (!result.includes(anchor))
      throw new Error(`NSIS missing saved directory anchor: ${variable}`);
    result = result.replace(
      anchor,
      `${anchor}\n      !ifmacrodef FCodeNormalizeLegacyInstallDirectory\n        !insertmacro FCodeNormalizeLegacyInstallDirectory\n      !endif`,
    );
  }
  return `${marker}\n${result}`.replaceAll("\n", eol);
}

export async function patchNsisMultiUserFile(path) {
  const source = await readFile(path, "utf8");
  const patched = patchNsisMultiUserSource(source);
  if (patched === source) return { changed: false, originalSource: null };
  await writeFile(path, patched, "utf8");
  return { changed: true, originalSource: source };
}
