import { normalize, resolve } from "node:path";
import type { ConfiguredCommand } from "./config.js";
import type {
  CommandStopTrigger,
  LogEvent,
  Logger,
} from "./logger.js";
import type {
  ProcessTreeController,
  ProcessTreeStopResult,
} from "./process-tree.js";

type LogErrorCode = NonNullable<
  Extract<LogEvent, { type: "command.spawn-failed" }>["code"]
>;

export interface SpawnedChild {
  readonly pid?: number;
  once(event: "error", listener: (error: Error) => void): SpawnedChild;
  once(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): SpawnedChild;
  unref(): void;
}

type OwnerToken = symbol;
type RetryTombstone = "spawn-failed" | "natural-exit";
type IdentityStatus = "stable" | "restarting" | "degraded";
type ProcessRecordStatus = "active" | "stopping";

interface ManagedCommandContext {
  scope: "global" | "project";
  index: number;
  name: string;
}

interface ProcessRecord {
  child: SpawnedChild;
  pid?: number;
  context: ManagedCommandContext;
  creationOrder: number;
  owners: Set<OwnerToken>;
  stopOnExit: boolean;
  status: ProcessRecordStatus;
  stopPromise?: Promise<ProcessTreeStopResult>;
  rootExited: boolean;
}

interface IdentityEntry {
  processKey: string;
  records: ProcessRecord[];
  retryTombstone?: RetryTombstone;
  cleanupUnconfirmed: boolean;
  status: IdentityStatus;
  transitionTail: Promise<void>;
  pendingTransitions: number;
  nextCreationOrder: number;
}

export type StartupState = Map<string, IdentityEntry>;

export interface StartupSpawnOptions {
  cwd?: string;
  detached: true;
  shell: false;
  stdio: "ignore";
  windowsHide: true;
}

export type SpawnFunction = (
  command: string,
  args: string[],
  options: StartupSpawnOptions,
) => SpawnedChild;

export interface StartupDependencies {
  spawn: SpawnFunction;
  state: StartupState;
  processTree: ProcessTreeController;
  logger: Logger;
}

export interface StartupActivation {
  dispose(): Promise<void>;
}

interface IndexedCommand {
  command: ConfiguredCommand;
  order: number;
  signature: string;
}

const ALLOWED_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);
const PROCESS_STATE_KEY = Symbol.for("opencode.startup-commands.state");
const processGlobal = globalThis as unknown as Record<symbol, unknown>;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isOptionalPid(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  try {
    return isRecord(value) && typeof value.then === "function";
  } catch {
    return false;
  }
}

function isManagedCommandContext(
  value: unknown,
): value is ManagedCommandContext {
  if (!isRecord(value)) {
    return false;
  }

  try {
    return (
      (value.scope === "global" || value.scope === "project") &&
      isNonnegativeSafeInteger(value.index) &&
      typeof value.name === "string"
    );
  } catch {
    return false;
  }
}

function isSpawnedChild(value: unknown): value is SpawnedChild {
  if (!isRecord(value)) {
    return false;
  }

  try {
    return (
      isOptionalPid(value.pid) &&
      typeof value.once === "function" &&
      typeof value.unref === "function"
    );
  } catch {
    return false;
  }
}

function isOwnerSet(value: unknown): value is Set<OwnerToken> {
  if (!(value instanceof Set)) {
    return false;
  }

  try {
    return [...value].every((owner) => typeof owner === "symbol");
  } catch {
    return false;
  }
}

function isProcessRecord(value: unknown): value is ProcessRecord {
  if (!isRecord(value)) {
    return false;
  }

  try {
    return (
      isSpawnedChild(value.child) &&
      isOptionalPid(value.pid) &&
      isManagedCommandContext(value.context) &&
      isNonnegativeSafeInteger(value.creationOrder) &&
      isOwnerSet(value.owners) &&
      typeof value.stopOnExit === "boolean" &&
      (value.status === "active" || value.status === "stopping") &&
      (value.stopPromise === undefined || isPromiseLike(value.stopPromise)) &&
      typeof value.rootExited === "boolean"
    );
  } catch {
    return false;
  }
}

function isIdentityEntry(
  value: unknown,
  processKey: string,
): value is IdentityEntry {
  if (!isRecord(value)) {
    return false;
  }

  try {
    if (
      value.processKey !== processKey ||
      !Array.isArray(value.records) ||
      !value.records.every(isProcessRecord) ||
      (value.retryTombstone !== undefined &&
        value.retryTombstone !== "spawn-failed" &&
        value.retryTombstone !== "natural-exit") ||
      typeof value.cleanupUnconfirmed !== "boolean" ||
      (value.status !== "stable" &&
        value.status !== "restarting" &&
        value.status !== "degraded") ||
      !isPromiseLike(value.transitionTail) ||
      !isNonnegativeSafeInteger(value.pendingTransitions) ||
      !isNonnegativeSafeInteger(value.nextCreationOrder) ||
      (value.retryTombstone !== undefined && value.records.length > 0)
    ) {
      return false;
    }

    let previousCreationOrder = -1;
    for (const record of value.records) {
      if (
        record.creationOrder <= previousCreationOrder ||
        record.creationOrder >= value.nextCreationOrder
      ) {
        return false;
      }
      previousCreationOrder = record.creationOrder;
    }

    return true;
  } catch {
    return false;
  }
}

function isStartupState(value: unknown): value is StartupState {
  if (!(value instanceof Map)) {
    return false;
  }

  try {
    return [...value].every(
      ([processKey, entry]) =>
        typeof processKey === "string" &&
        isIdentityEntry(entry, processKey),
    );
  } catch {
    return false;
  }
}

function createIdentityEntry(processKey: string): IdentityEntry {
  return {
    processKey,
    records: [],
    cleanupUnconfirmed: false,
    status: "stable",
    transitionTail: Promise.resolve(),
    pendingTransitions: 0,
    nextCreationOrder: 0,
  };
}

export function createStartupState(): StartupState {
  return new Map<string, IdentityEntry>();
}

function convertLegacyState(value: unknown): StartupState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  let started: unknown;
  try {
    started = value.started;
  } catch {
    return undefined;
  }
  if (!(started instanceof Set)) {
    return undefined;
  }

  let processKeys: unknown[];
  try {
    processKeys = [...started];
  } catch {
    return undefined;
  }
  if (!processKeys.every((processKey) => typeof processKey === "string")) {
    return undefined;
  }

  const state = createStartupState();
  for (const processKey of processKeys as string[]) {
    const entry = createIdentityEntry(processKey);
    entry.cleanupUnconfirmed = true;
    entry.status = "degraded";
    state.set(processKey, entry);
  }
  return state;
}

export function getOrCreateProcessState(
  registry: Record<symbol, unknown>,
): StartupState {
  const existingState = registry[PROCESS_STATE_KEY];

  if (isStartupState(existingState)) {
    return existingState;
  }

  const state = convertLegacyState(existingState) ?? createStartupState();
  registry[PROCESS_STATE_KEY] = state;

  return state;
}

export const processState = getOrCreateProcessState(processGlobal);

function getCommandSignature(command: ConfiguredCommand): string {
  return JSON.stringify([command.executable, command.args]);
}

function getNormalizedProjectRoot(projectRoot: string): string {
  const normalizedRoot = normalize(resolve(projectRoot));

  return process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
}

function getProcessKey(
  command: ConfiguredCommand,
  signature: string,
): string {
  if (command.scope === "global") {
    return `global:${signature}`;
  }

  return `project:${getNormalizedProjectRoot(command.projectRoot)}:${signature}`;
}

function getErrorCode(error: unknown): LogErrorCode | undefined {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    ALLOWED_ERROR_CODES.has(error.code)
      ? error.code
      : undefined
  ) as LogErrorCode | undefined;
}

function writeLog(logger: Logger, event: LogEvent): void {
  try {
    logger.write(event);
  } catch {
    // Logging must not affect command execution or child lifecycle callbacks.
  }
}

function pruneIdentityIfEmpty(
  state: StartupState,
  entry: IdentityEntry,
): void {
  if (
    entry.records.length === 0 &&
    entry.retryTombstone === undefined &&
    !entry.cleanupUnconfirmed &&
    entry.pendingTransitions === 0 &&
    state.get(entry.processKey) === entry
  ) {
    state.delete(entry.processKey);
  }
}

async function withIdentityTransition<T>(
  state: StartupState,
  processKey: string,
  transition: (entry: IdentityEntry) => Promise<T>,
): Promise<T> {
  const entry = state.get(processKey) ?? createIdentityEntry(processKey);
  if (!state.has(processKey)) {
    state.set(processKey, entry);
  }

  entry.pendingTransitions += 1;
  const previous = entry.transitionTail;
  let release!: () => void;
  entry.transitionTail = new Promise<void>((resolveTransition) => {
    release = resolveTransition;
  });

  try {
    await Promise.resolve(previous).catch(() => undefined);
    return await transition(entry);
  } finally {
    entry.pendingTransitions -= 1;
    release();
    pruneIdentityIfEmpty(state, entry);
  }
}

function getValidatedPid(child: SpawnedChild): number | undefined {
  try {
    const pid = child.pid;
    return typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0
      ? pid
      : undefined;
  } catch {
    return undefined;
  }
}

function spawnRecord(
  command: ConfiguredCommand,
  owner: OwnerToken,
  entry: IdentityEntry,
  dependencies: StartupDependencies,
): ProcessRecord | undefined {
  const spawnOptions: StartupSpawnOptions = {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  };

  if (command.scope === "project") {
    spawnOptions.cwd = command.projectRoot;
  }

  let child: SpawnedChild;
  try {
    child = dependencies.spawn(command.executable, command.args, spawnOptions);
  } catch (error) {
    writeLog(dependencies.logger, {
      type: "command.spawn-failed",
      scope: command.scope,
      index: command.index,
      name: command.name,
      code: getErrorCode(error),
    });
    if (entry.records.length === 0) {
      entry.retryTombstone = "spawn-failed";
    }
    return undefined;
  }

  const pid = getValidatedPid(child);
  const record: ProcessRecord = {
    child,
    pid,
    context: {
      scope: command.scope,
      index: command.index,
      name: command.name,
    },
    creationOrder: entry.nextCreationOrder,
    owners: new Set([owner]),
    stopOnExit: command.stopOnExit,
    status: "active",
    rootExited: false,
  };
  entry.nextCreationOrder += 1;
  entry.records.push(record);

  writeLog(dependencies.logger, {
    type: "command.spawned",
    ...record.context,
    pid,
  });

  try {
    child.once("error", (error) => {
      writeLog(dependencies.logger, {
        type: "command.child-error",
        ...record.context,
        code: getErrorCode(error),
      });

      if (record.pid === undefined) {
        void withIdentityTransition(
          dependencies.state,
          entry.processKey,
          async (currentEntry) => {
            if (!currentEntry.records.includes(record)) {
              return;
            }

            currentEntry.records = currentEntry.records.filter(
              (candidate) => candidate !== record,
            );
            if (currentEntry.records.length === 0) {
              currentEntry.retryTombstone = "spawn-failed";
            }
          },
        ).catch(() => undefined);
      }
    });
  } catch {
    // A spawned child remains successful even if lifecycle hooks are unavailable.
  }

  try {
    child.once("exit", (exitCode, signal) => {
      record.rootExited = true;
      writeLog(dependencies.logger, {
        type: "command.exited",
        ...record.context,
        exitCode,
        signal,
      });

      void withIdentityTransition(
        dependencies.state,
        entry.processKey,
        async (currentEntry) => {
          if (
            !currentEntry.records.includes(record) ||
            record.stopPromise !== undefined
          ) {
            return;
          }

          const result = await requestRecordStop(
            record,
            "root-exited",
            dependencies,
          );
          if (!currentEntry.records.includes(record)) {
            return;
          }

          applyRecordStopResult(currentEntry, record, result);
          if (currentEntry.records.length === 0) {
            currentEntry.retryTombstone = "natural-exit";
          }
        },
      ).catch(() => undefined);
    });
  } catch {
    // A spawned child remains successful even if lifecycle hooks are unavailable.
  }

  try {
    child.unref();
  } catch {
    // The child already started, so an unref failure is not a spawn failure.
  }

  return record;
}

function requestRecordStop(
  record: ProcessRecord,
  trigger: CommandStopTrigger,
  dependencies: StartupDependencies,
): Promise<ProcessTreeStopResult> {
  if (record.stopPromise) {
    return record.stopPromise;
  }

  record.status = "stopping";
  writeLog(dependencies.logger, {
    type: "command.stop-requested",
    ...record.context,
    pid: record.pid,
    trigger,
  });

  let stopPromise: Promise<ProcessTreeStopResult>;
  try {
    stopPromise = Promise.resolve(
      dependencies.processTree.stop(record.pid, {
        isRootExited: () => record.rootExited,
        onForce: () => {
          writeLog(dependencies.logger, {
            type: "command.stop-forced",
            ...record.context,
            pid: record.pid,
            trigger,
          });
        },
      }),
    );
  } catch {
    stopPromise = Promise.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: record.rootExited ? "lost" : "safe",
    });
  }

  record.stopPromise = stopPromise
    .catch(
      (): ProcessTreeStopResult => ({
        status: "failed",
        reason: "unconfirmed",
        addressability: record.rootExited ? "lost" : "safe",
      }),
    )
    .then((result) => {
      if (result.status === "failed") {
        writeLog(dependencies.logger, {
          type: "command.stop-failed",
          ...record.context,
          pid: record.pid,
          trigger,
          reason: result.reason,
        });
      }
      return result;
    });
  return record.stopPromise;
}

function applyRecordStopResult(
  entry: IdentityEntry,
  record: ProcessRecord,
  result: ProcessTreeStopResult,
): void {
  if (result.status === "stopped") {
    entry.records = entry.records.filter((candidate) => candidate !== record);
    return;
  }

  if (record.rootExited || result.addressability === "lost") {
    entry.records = entry.records.filter((candidate) => candidate !== record);
    entry.cleanupUnconfirmed = true;
    entry.status = "degraded";
    return;
  }

  record.status = "active";
  record.stopPromise = undefined;
}

export async function runStartupCommands(
  commands: readonly ConfiguredCommand[],
  dependencies: StartupDependencies,
): Promise<StartupActivation> {
  const owner = Symbol("startup-command-owner");
  const claimedKeys = new Set<string>();
  let disposePromise: Promise<void> | undefined;
  const activation: StartupActivation = {
    dispose(): Promise<void> {
      disposePromise ??= Promise.all(
        [...claimedKeys].map((processKey) =>
          withIdentityTransition(
            dependencies.state,
            processKey,
            async (entry) => {
              const recordsToStop: ProcessRecord[] = [];
              for (const record of entry.records) {
                if (
                  record.owners.delete(owner) &&
                  record.owners.size === 0 &&
                  record.stopOnExit
                ) {
                  recordsToStop.push(record);
                }
              }

              const results = await Promise.all(
                recordsToStop.map((record) =>
                  requestRecordStop(
                    record,
                    "scope-disposed",
                    dependencies,
                  ),
                ),
              );
              results.forEach((result, index) => {
                applyRecordStopResult(
                  entry,
                  recordsToStop[index]!,
                  result,
                );
              });
            },
          ),
        ),
      )
        .then(() => undefined)
        .catch(() => undefined);
      return disposePromise;
    },
  };

  writeLog(dependencies.logger, {
    type: "plugin.initialized",
    commandCount: commands.length,
  });

  if (commands.length === 0) {
    writeLog(dependencies.logger, {
      type: "batch.skipped",
      reason: "no-valid-commands",
    });
    return activation;
  }

  const globalCommands = new Map<string, IndexedCommand>();
  const projectCommands = new Map<string, IndexedCommand>();
  const duplicateCommands: IndexedCommand[] = [];

  commands.forEach((command, order) => {
    const signature = getCommandSignature(command);
    const indexedCommand = { command, order, signature };

    if (command.scope === "global") {
      if (globalCommands.has(signature)) {
        duplicateCommands.push(indexedCommand);
      } else {
        globalCommands.set(signature, indexedCommand);
      }
      return;
    }

    const projectKey = getProcessKey(command, signature);
    if (projectCommands.has(projectKey)) {
      duplicateCommands.push(indexedCommand);
    } else {
      projectCommands.set(projectKey, indexedCommand);
    }
  });

  const uniqueProjectCommands = [...projectCommands.values()].filter(
    (indexedCommand) => {
      if (globalCommands.has(indexedCommand.signature)) {
        duplicateCommands.push(indexedCommand);
        return false;
      }
      return true;
    },
  );
  const uniqueCommands = [
    ...globalCommands.values(),
    ...uniqueProjectCommands,
  ];
  let commandAttempted = false;

  duplicateCommands
    .sort((left, right) => left.order - right.order)
    .forEach(({ command }) => {
      writeLog(dependencies.logger, {
        type: "command.skipped",
        scope: command.scope,
        index: command.index,
        name: command.name,
        reason: "duplicate",
      });
    });

  for (const { command, signature } of uniqueCommands) {
    const processKey = getProcessKey(command, signature);
    const attempted = await withIdentityTransition(
      dependencies.state,
      processKey,
      async (entry) => {
        if (entry.records.length === 0) {
          if (
            entry.retryTombstone !== undefined ||
            entry.cleanupUnconfirmed
          ) {
            writeLog(dependencies.logger, {
              type: "command.skipped",
              scope: command.scope,
              index: command.index,
              name: command.name,
              reason: "already-started",
            });
            return false;
          }

          const record = spawnRecord(command, owner, entry, dependencies);
          if (record) {
            claimedKeys.add(processKey);
          }
          return true;
        }

        if (command.onExistingProcess === "start") {
          const record = spawnRecord(command, owner, entry, dependencies);
          if (record) {
            claimedKeys.add(processKey);
          }
          return true;
        }

        if (command.onExistingProcess === "skip") {
          const activeRecord = entry.records.find(
            (record) => record.status === "active",
          );
          if (activeRecord) {
            activeRecord.owners.add(owner);
            claimedKeys.add(processKey);
          }
          writeLog(dependencies.logger, {
            type: "command.skipped",
            scope: command.scope,
            index: command.index,
            name: command.name,
            reason: "already-started",
          });
          return false;
        }

        if (entry.cleanupUnconfirmed) {
          entry.status = "degraded";
          writeLog(dependencies.logger, {
            type: "command.stop-failed",
            scope: command.scope,
            index: command.index,
            name: command.name,
            pid: undefined,
            trigger: "restart",
            reason: "unconfirmed",
          });
          return true;
        }

        entry.status = "restarting";
        const snapshot = entry.records.map((record) => ({
          record,
          owners: new Set(record.owners),
        }));
        const ownerUnion = new Set<OwnerToken>([owner]);
        for (const { owners } of snapshot) {
          for (const recordOwner of owners) {
            ownerUnion.add(recordOwner);
          }
        }
        const results = await Promise.all(
          snapshot.map(({ record }) =>
            requestRecordStop(record, "restart", dependencies),
          ),
        );

        const safeSurvivors: ProcessRecord[] = [];
        const transferredOwners = new Set<OwnerToken>([owner]);
        let stopFailed = false;
        results.forEach((result, index) => {
          const { record, owners } = snapshot[index]!;
          if (result.status === "stopped") {
            for (const recordOwner of owners) {
              transferredOwners.add(recordOwner);
            }
            return;
          }

          stopFailed = true;
          if (record.rootExited || result.addressability === "lost") {
            entry.cleanupUnconfirmed = true;
            for (const recordOwner of owners) {
              transferredOwners.add(recordOwner);
            }
            return;
          }

          record.owners.clear();
          for (const recordOwner of owners) {
            record.owners.add(recordOwner);
          }
          record.status = "active";
          record.stopPromise = undefined;
          safeSurvivors.push(record);
        });
        entry.records = safeSurvivors;

        if (!stopFailed) {
          const replacement = spawnRecord(
            command,
            owner,
            entry,
            dependencies,
          );
          if (replacement) {
            for (const recordOwner of ownerUnion) {
              replacement.owners.add(recordOwner);
            }
            entry.retryTombstone = undefined;
            claimedKeys.add(processKey);
          }
          entry.status = "stable";
          return true;
        }

        const oldestSurvivor = safeSurvivors[0];
        if (oldestSurvivor) {
          for (const recordOwner of transferredOwners) {
            oldestSurvivor.owners.add(recordOwner);
          }
          claimedKeys.add(processKey);
        }
        entry.status = "degraded";
        return true;
      },
    );
    commandAttempted ||= attempted;
  }

  if (!commandAttempted) {
    writeLog(dependencies.logger, {
      type: "batch.skipped",
      reason: "already-started",
    });
  }

  return activation;
}
