import { relative, resolve } from "node:path";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** pnpm v9 的生产闭包：安装目录读取仍由 third-party-npm 的唯一扫描器负责。 */
export function collectProductionLockPackages(lock, root, projects) {
  if (
    !object(lock) ||
    String(lock.lockfileVersion) !== "9.0" ||
    !object(lock.importers) ||
    !object(lock.snapshots) ||
    !object(lock.packages)
  )
    throw new Error("Unsupported or incomplete pnpm production lockfile");
  const required = new Map(),
    visitedNodes = new Set(),
    visitedProjects = new Set();
  const importerId = (path) => relative(root, path).replaceAll("\\", "/") || ".";
  const workspaceIds = new Set(projects.map((project) => importerId(project.path)));
  function dependencies(record, importer) {
    if (!object(record)) throw new Error("Invalid pnpm dependency record");
    for (const field of ["dependencies", "optionalDependencies"]) {
      const entries = record[field];
      if (entries === undefined) continue;
      if (!object(entries)) throw new Error("Invalid pnpm production dependency map");
      for (const [alias, entry] of Object.entries(entries)) {
        const ref = object(entry) ? entry.version : entry;
        if (typeof ref !== "string" || !ref)
          throw new Error(`Invalid pnpm dependency reference: ${alias}`);
        if (ref.startsWith("link:")) {
          const id = importerId(resolve(root, importer, ref.slice(5)));
          if (!workspaceIds.has(id))
            throw new Error(`Production workspace link not registered: ${id}`);
          visitProject(id);
        } else visitPackage(alias, ref);
      }
    }
  }
  function visitProject(id) {
    if (visitedProjects.has(id)) return;
    const importer = lock.importers[id];
    if (!object(importer)) throw new Error(`Missing production workspace in lockfile: ${id}`);
    visitedProjects.add(id);
    dependencies(importer, id);
  }
  function visitPackage(alias, ref) {
    const key = Object.hasOwn(lock.snapshots, `${alias}@${ref}`) ? `${alias}@${ref}` : ref;
    const snapshot = lock.snapshots[key];
    if (!object(snapshot))
      throw new Error(`Missing production dependency snapshot: ${alias}@${ref}`);
    if (visitedNodes.has(key)) return;
    const base = key.split("(", 1)[0];
    const match = /^(@[^/]+\/[^@]+|[^@/]+)@([^()]+)$/.exec(base);
    if (!match || !object(lock.packages[base]))
      throw new Error(`Missing production package metadata: ${key}`);
    visitedNodes.add(key);
    const [, name, version] = match;
    required.set(`${name}@${version}`, { name, version });
    dependencies(snapshot, ".");
  }
  for (const id of workspaceIds) visitProject(id);
  return required;
}
