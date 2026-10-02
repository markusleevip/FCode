import type { TuiSessionMetadata } from "@fcode/tui";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";

type TuiMetadataSource = {
  getSessionMetadata?: () => Promise<TuiSessionMetadata>;
};

export async function listCustomCommandsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listFCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

export async function loadCustomCommandForTui(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadFCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}

export async function listSkillsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const listFCodeSkillsForTui = deps.listSkills ?? (await loadBootstrapModule()).listFCodeSkills;
  return await listFCodeSkillsForTui({
    env,
    logger: deps.logger,
    workingDirectory,
  });
}

export async function listSessionsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const listFCodeSessionsForTui =
    deps.listSessions ?? (await loadBootstrapModule()).listFCodeSessions;
  const sessions = await listFCodeSessionsForTui({
    directory: workingDirectory,
    env,
    limit: 50,
  });
  return sessions.map((session) => ({
    directory: session.directory,
    id: session.id,
    parentId: session.parentID,
    title: session.title,
    updatedAt: session.time.updated,
  }));
}

export async function loadInitialTuiSessionMetadata(
  promptHandler: TuiMetadataSource,
): Promise<TuiSessionMetadata> {
  try {
    return (await promptHandler.getSessionMetadata?.()) ?? {};
  } catch (error) {
    if (isStartupGateError(error)) {
      throw error;
    }
    return {};
  }
}

function isStartupGateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "SqliteSessionMigrationError";
}
