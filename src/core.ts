import { normalize, resolve } from "node:path";
import type { ConfiguredCommand } from "./config.js";
import { getErrorCode as getRawErrorCode } from "./error-code.js";
import type {
  DurableLockHandle,
  DurableLockHolder,
  DurableRecord,
  DurableRegistry,
  DurableUnavailableReason,
} from "./durable-registry.js";
import type {
  CommandStopTrigger,
  DurableUnavailableCause,
  LogEvent,
  Logger,
} from "./logger.js";
import type {
  ProcessDescribeResult,
  ProcessIdentityController,
  ProcessProbeResult,
} from "./process-identity.js";
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

interface ProcessRecordBase {
  pid?: number;
  context: ManagedCommandContext;
  creationOrder: number;
  owners: Set<OwnerToken>;
  stopOnExit: boolean;
  status: ProcessRecordStatus;
  stopPromise?: Promise<ProcessTreeStopResult>;
  rootExited: boolean;
}

type ProcessRecord =
  | (ProcessRecordBase & { origin: "spawned"; child: SpawnedChild })
  | (ProcessRecordBase & { origin: "adopted"; startToken: string });

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
  identity?: ProcessIdentityController;
  registry?: DurableRegistry;
}

export interface StartupActivation {
  dispose(): Promise<void>;
}

export interface StartupRunOptions {
  authoritative: boolean;
  projectRootHash: string;
  resolveOwner?: () => Promise<DurableLockHolder | undefined>;
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
    const sharedFieldsValid =
      isOptionalPid(value.pid) &&
      isManagedCommandContext(value.context) &&
      isNonnegativeSafeInteger(value.creationOrder) &&
      isOwnerSet(value.owners) &&
      typeof value.stopOnExit === "boolean" &&
      (value.status === "active" || value.status === "stopping") &&
      (value.stopPromise === undefined || isPromiseLike(value.stopPromise)) &&
      typeof value.rootExited === "boolean";

    if (!sharedFieldsValid) {
      return false;
    }

    if (value.origin === "adopted") {
      return typeof value.startToken === "string" && value.startToken !== "";
    }

    if (value.origin === undefined || value.origin === "spawned") {
      return isSpawnedChild(value.child);
    }

    return false;
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

export { getNormalizedProjectRoot as normalizeProjectRoot };

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
  const code = getRawErrorCode(error);
  return (
    code !== undefined && ALLOWED_ERROR_CODES.has(code) ? code : undefined
  ) as LogErrorCode | undefined;
}

function writeLog(logger: Logger, event: LogEvent): void {
  try {
    logger.write(event);
  } catch {
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
    origin: "spawned",
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
  }

  try {
    child.unref();
  } catch {
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

  if (record.origin === "spawned") {
    record.stopPromise = stopThroughTree(record, trigger, dependencies);
    return record.stopPromise;
  }

  record.stopPromise = resolveRootExited(record, dependencies)
    .then((rootExitedAtEntry) => {
      record.rootExited = record.rootExited || rootExitedAtEntry;
      return stopThroughTree(record, trigger, dependencies);
    })
    .catch(
      (): ProcessTreeStopResult => ({
        status: "failed",
        reason: "unconfirmed",
        addressability: record.rootExited ? "lost" : "safe",
      }),
    );

  return record.stopPromise;
}

async function resolveRootExited(
  record: Extract<ProcessRecord, { origin: "adopted" }>,
  dependencies: StartupDependencies,
): Promise<boolean> {
  if (!dependencies.identity) {
    return true;
  }
  try {
    const probed = await dependencies.identity.probe(
      record.pid,
      record.startToken,
    );
    return probed.status !== "alive";
  } catch {
    return true;
  }
}

function stopThroughTree(
  record: ProcessRecord,
  trigger: CommandStopTrigger,
  dependencies: StartupDependencies,
): Promise<ProcessTreeStopResult> {
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

  return stopPromise
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

type DurableScopeInfo =
  | { scope: "global"; identityHash: string }
  | { scope: "project"; identityHash: string; projectRootHash: string };

type DurablePlan =
  | {
      enabled: true;
      registry: DurableRegistry;
      identity: ProcessIdentityController;
      handle: DurableLockHandle;
      foreignRecords: DurableRecord[];
      carriedRecords: DurableRecord[];
      fallbackTokens: Map<string, string>;
      blocked: Set<string>;
    }
  | { enabled: false; blocked: Set<string> };

function durableKeyFor(part: {
  scope: "global" | "project";
  identityHash: string;
  projectRootHash?: string;
}): string {
  return part.scope === "global"
    ? `identity:${part.identityHash}`
    : `identity:${part.identityHash}:root:${part.projectRootHash}`;
}

function trackedPidKey(processKey: string, pid: number): string {
  return `${processKey}:${pid}`;
}

function adoptedRecordFrom(
  stored: DurableRecord,
  context: ManagedCommandContext,
): ProcessRecord {
  return {
    origin: "adopted",
    pid: stored.pid,
    startToken: stored.startToken,
    context,
    creationOrder: stored.creationOrder,
    owners: new Set<OwnerToken>(),
    stopOnExit: false,
    status: "active",
    rootExited: false,
  };
}

function toDurableRecord(
  scopeInfo: DurableScopeInfo,
  pid: number,
  startToken: string,
  creationOrder: number,
  recordedAt: string,
): DurableRecord {
  return scopeInfo.scope === "global"
    ? {
        scope: "global",
        identityHash: scopeInfo.identityHash,
        pid,
        startToken,
        stopOnExit: false,
        creationOrder,
        recordedAt,
      }
    : {
        scope: "project",
        identityHash: scopeInfo.identityHash,
        projectRootHash: scopeInfo.projectRootHash,
        pid,
        startToken,
        stopOnExit: false,
        creationOrder,
        recordedAt,
      };
}

const DURABLE_CAUSE_BY_REASON: Record<
  DurableUnavailableReason,
  DurableUnavailableCause
> = {
  unreadable: "registry-unreadable",
  malformed: "registry-malformed",
  "unsupported-schema": "registry-unsupported-schema",
};

function durableCauseFor(
  reason: DurableUnavailableReason,
): DurableUnavailableCause {
  return DURABLE_CAUSE_BY_REASON[reason];
}

function finalizePersistedRecords(
  records: readonly DurableRecord[],
): DurableRecord[] {
  const deduped = new Map<string, DurableRecord>();
  for (const stored of records) {
    deduped.set(`${durableKeyFor(stored)}:${stored.pid}`, stored);
  }

  const groups = new Map<string, DurableRecord[]>();
  const groupOrder: string[] = [];
  for (const stored of deduped.values()) {
    const key = durableKeyFor(stored);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.push(stored);
  }

  const sorted: DurableRecord[] = [];
  for (const key of groupOrder) {
    const group = groups.get(key)!;
    group.sort((left, right) => left.creationOrder - right.creationOrder);
    sorted.push(...group);
  }
  return sorted;
}

async function safeDescribe(
  pid: number | undefined,
  identity: ProcessIdentityController,
): Promise<ProcessDescribeResult> {
  try {
    return await identity.describe(pid);
  } catch {
    return { status: "unknown", reason: "unconfirmed" };
  }
}

async function safeProbe(
  pid: number,
  startToken: string,
  identity: ProcessIdentityController,
): Promise<ProcessProbeResult> {
  try {
    return await identity.probe(pid, startToken);
  } catch {
    return { status: "unknown", reason: "unconfirmed" };
  }
}

async function describeToken(
  pid: number,
  identity: ProcessIdentityController,
): Promise<string | undefined> {
  const described = await safeDescribe(pid, identity);
  return described.status === "described" ? described.token : undefined;
}

type LockHolderResolution =
  | { status: "resolved"; holder: DurableLockHolder }
  | { status: "unresolved" };

async function resolveLockHolder(
  resolveOwner: StartupRunOptions["resolveOwner"],
  identity: ProcessIdentityController,
): Promise<LockHolderResolution> {
  let owner: DurableLockHolder | undefined;
  try {
    owner = await resolveOwner?.();
  } catch {
    owner = undefined;
  }
  if (owner) {
    return { status: "resolved", holder: owner };
  }
  const resolved = await describeToken(process.pid, identity);
  return resolved === undefined
    ? { status: "unresolved" }
    : {
        status: "resolved",
        holder: { pid: process.pid, startToken: resolved },
      };
}

type DurableCommandIndex = {
  durableScopes: Map<string, DurableScopeInfo>;
  durableProcessKeys: Set<string>;
  commandByDurableKey: Map<
    string,
    { processKey: string; context: ManagedCommandContext }
  >;
};

function indexDurableCommands(
  uniqueCommands: readonly IndexedCommand[],
  registry: DurableRegistry,
  projectRootHash: string | undefined,
): DurableCommandIndex {
  const durableScopes = new Map<string, DurableScopeInfo>();
  const durableProcessKeys = new Set<string>();
  const commandByDurableKey = new Map<
    string,
    { processKey: string; context: ManagedCommandContext }
  >();

  for (const { command, signature } of uniqueCommands) {
    const processKey = getProcessKey(command, signature);
    const identityHash = registry.hashIdentity(signature);

    if (!command.stopOnExit) {
      durableProcessKeys.add(processKey);
    }

    let scopeInfo: DurableScopeInfo;
    if (command.scope === "global") {
      scopeInfo = { scope: "global", identityHash };
    } else {
      if (projectRootHash === undefined) {
        continue;
      }
      scopeInfo = { scope: "project", identityHash, projectRootHash };
    }

    durableScopes.set(processKey, scopeInfo);

    if (!command.stopOnExit) {
      commandByDurableKey.set(durableKeyFor(scopeInfo), {
        processKey,
        context: {
          scope: command.scope,
          index: command.index,
          name: command.name,
        },
      });
    }
  }

  return { durableScopes, durableProcessKeys, commandByDurableKey };
}

function partitionByProjectRoot(
  records: readonly DurableRecord[],
  projectRootHash: string | undefined,
): { foreign: DurableRecord[]; current: DurableRecord[] } {
  const foreign: DurableRecord[] = [];
  const current: DurableRecord[] = [];
  for (const stored of records) {
    if (
      stored.scope === "global" ||
      stored.projectRootHash === projectRootHash
    ) {
      current.push(stored);
    } else {
      foreign.push(stored);
    }
  }
  return { foreign, current };
}

async function buildDurablePlan(
  uniqueCommands: readonly IndexedCommand[],
  dependencies: StartupDependencies,
  options: StartupRunOptions | undefined,
  registry: DurableRegistry,
  identity: ProcessIdentityController,
): Promise<{
  plan: DurablePlan;
  durableScopes: Map<string, DurableScopeInfo>;
}> {
  const { durableScopes, durableProcessKeys, commandByDurableKey } =
    indexDurableCommands(uniqueCommands, registry, options?.projectRootHash);
  const reconciledCounts: Record<"global" | "project", { stopped: number }> = {
    global: { stopped: 0 },
    project: { stopped: 0 },
  };

  function unavailable(cause: DurableUnavailableCause): {
    plan: DurablePlan;
    durableScopes: Map<string, DurableScopeInfo>;
  } {
    writeLog(dependencies.logger, {
      type: "durable.unavailable",
      cause,
    });
    return {
      plan: { enabled: false, blocked: durableProcessKeys },
      durableScopes,
    };
  }

  const holderResolution = await resolveLockHolder(
    options?.resolveOwner,
    identity,
  );
  if (holderResolution.status === "unresolved") {
    return unavailable("identity-unavailable");
  }

  const lockResult = await registry.acquireLock(holderResolution.holder);
  if (lockResult.status === "unavailable") {
    return unavailable("lock-unavailable");
  }
  const handle = lockResult.handle;

  try {
    const readResult = registry.read();
    if (readResult.status === "unavailable") {
      const cause = durableCauseFor(readResult.reason);
      const result = unavailable(cause);
      handle.release();
      return result;
    }

    if (readResult.quarantined) {
      writeLog(dependencies.logger, {
        type: "durable.registry-quarantined",
      });
    }

    const { foreign: foreignRecords, current: currentScopeRecords } =
      partitionByProjectRoot(readResult.records, options?.projectRootHash);

    const nextCreationOrderByKey = new Map<string, number>();
    for (const stored of currentScopeRecords) {
      const key = durableKeyFor(stored);
      nextCreationOrderByKey.set(
        key,
        Math.max(
          nextCreationOrderByKey.get(key) ?? 0,
          stored.creationOrder + 1,
        ),
      );
    }

    const carriedRecords: DurableRecord[] = [];
    const fallbackTokens = new Map<string, string>();
    const seededEntries = new Map<string, IdentityEntry>();

    function seededEntryFor(
      processKey: string,
      nextOrderFloor: number,
    ): IdentityEntry {
      let entry = seededEntries.get(processKey);
      if (!entry) {
        entry =
          dependencies.state.get(processKey) ??
          createIdentityEntry(processKey);
        dependencies.state.set(processKey, entry);
        seededEntries.set(processKey, entry);
      }
      entry.nextCreationOrder = Math.max(
        entry.nextCreationOrder,
        nextOrderFloor,
      );
      return entry;
    }

    for (const stored of currentScopeRecords) {
      const key = durableKeyFor(stored);
      const lookup = commandByDurableKey.get(key);
      const nextOrderFloor =
        nextCreationOrderByKey.get(key) ?? stored.creationOrder + 1;
      const owningCommand = lookup
        ? {
            processKey: lookup.processKey,
            entry: seededEntryFor(lookup.processKey, nextOrderFloor),
            context: lookup.context,
          }
        : undefined;
      const probeResult = await safeProbe(
        stored.pid,
        stored.startToken,
        identity,
      );

      if (probeResult.status === "alive") {
        if (!owningCommand) {
          if (options?.authoritative !== true) {
            carriedRecords.push(stored);
            continue;
          }

          const orphanProcessRecord = adoptedRecordFrom(stored, {
            scope: stored.scope,
            index: -1,
            name: "(orphaned)",
          });

          const stopResult = await requestRecordStop(
            orphanProcessRecord,
            "restart",
            dependencies,
          );
          if (stopResult.status !== "stopped") {
            carriedRecords.push(stored);
            continue;
          }

          reconciledCounts[stored.scope].stopped += 1;
          continue;
        }

        const alreadyTracked = owningCommand.entry.records.some(
          (existing) => existing.pid === stored.pid,
        );
        if (alreadyTracked) {
          fallbackTokens.set(
            trackedPidKey(owningCommand.processKey, stored.pid),
            stored.startToken,
          );
          continue;
        }

        owningCommand.entry.records.push(
          adoptedRecordFrom(stored, owningCommand.context),
        );
        writeLog(dependencies.logger, {
          type: "durable.record-adopted",
          scope: owningCommand.context.scope,
          index: owningCommand.context.index,
          name: owningCommand.context.name,
          pid: stored.pid,
        });
        continue;
      }

      if (probeResult.status === "gone") {
        writeLog(dependencies.logger, {
          type: "durable.record-dropped",
          scope: stored.scope,
          index: owningCommand?.context.index,
          name: owningCommand?.context.name,
          pid: stored.pid,
        });
        continue;
      }

      if (owningCommand) {
        owningCommand.entry.cleanupUnconfirmed = true;
        owningCommand.entry.status = "degraded";
      }
      carriedRecords.push(stored);
      writeLog(dependencies.logger, {
        type: "durable.record-unverifiable",
        scope: stored.scope,
        index: owningCommand?.context.index,
        name: owningCommand?.context.name,
        pid: stored.pid,
      });
    }

    for (const scope of ["global", "project"] as const) {
      const counts = reconciledCounts[scope];
      if (counts.stopped === 0) {
        continue;
      }
      writeLog(dependencies.logger, {
        type: "durable.reconciled",
        scope,
        stoppedCount: counts.stopped,
      });
    }

    return {
      plan: {
        enabled: true,
        registry,
        identity,
        handle,
        foreignRecords,
        carriedRecords,
        fallbackTokens,
        blocked: new Set(),
      },
      durableScopes,
    };
  } catch (error) {
    handle.release();
    throw error;
  }
}

function dedupeCommands(
  commands: readonly ConfiguredCommand[],
  logger: Logger,
): IndexedCommand[] {
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

  duplicateCommands
    .sort((left, right) => left.order - right.order)
    .forEach(({ command }) => {
      writeLog(logger, {
        type: "command.skipped",
        scope: command.scope,
        index: command.index,
        name: command.name,
        reason: "duplicate",
      });
    });

  return uniqueCommands;
}

function createActivation(
  claimedKeys: ReadonlySet<string>,
  owner: OwnerToken,
  dependencies: StartupDependencies,
): StartupActivation {
  let disposePromise: Promise<void> | undefined;
  return {
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
}

async function restartIdentity(
  entry: IdentityEntry,
  command: ConfiguredCommand,
  processKey: string,
  owner: OwnerToken,
  claimedKeys: Set<string>,
  dependencies: StartupDependencies,
): Promise<boolean> {
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
}

async function persistDurableRecords(
  plan: Extract<DurablePlan, { enabled: true }>,
  durableScopes: ReadonlyMap<string, DurableScopeInfo>,
  dependencies: StartupDependencies,
): Promise<void> {
  const persisted: DurableRecord[] = [...plan.carriedRecords];

  for (const [processKey, entry] of dependencies.state) {
    const scopeInfo = durableScopes.get(processKey);
    if (!scopeInfo) {
      continue;
    }

    for (const record of entry.records) {
      if (record.stopOnExit) {
        continue;
      }
      if (record.pid === undefined) {
        writeLog(dependencies.logger, {
          type: "durable.record-unverifiable",
          ...record.context,
          pid: undefined,
        });
        continue;
      }

      const describedToken =
        record.origin === "adopted"
          ? record.startToken
          : await describeToken(record.pid, plan.identity);
      const startToken =
        describedToken ??
        plan.fallbackTokens.get(trackedPidKey(processKey, record.pid));
      if (startToken === undefined) {
        writeLog(dependencies.logger, {
          type: "durable.record-unverifiable",
          ...record.context,
          pid: record.pid,
        });
        continue;
      }

      const recordedAt = new Date().toISOString();
      persisted.push(
        toDurableRecord(
          scopeInfo,
          record.pid,
          startToken,
          record.creationOrder,
          recordedAt,
        ),
      );
    }
  }

  const finalRecords = [
    ...plan.foreignRecords,
    ...finalizePersistedRecords(persisted),
  ];

  const persistedSuccessfully = plan.registry.write(finalRecords);
  if (!persistedSuccessfully) {
    writeLog(dependencies.logger, {
      type: "durable.unavailable",
      cause: "registry-unwritable",
    });
  }
}

export async function runStartupCommands(
  commands: readonly ConfiguredCommand[],
  dependencies: StartupDependencies,
  options?: StartupRunOptions,
): Promise<StartupActivation> {
  const owner = Symbol("startup-command-owner");
  const claimedKeys = new Set<string>();
  const activation = createActivation(claimedKeys, owner, dependencies);

  writeLog(dependencies.logger, {
    type: "plugin.initialized",
    commandCount: commands.length,
  });

  const uniqueCommands = dedupeCommands(commands, dependencies.logger);
  let commandAttempted = false;

  let durablePlan: DurablePlan;
  let durableScopes: Map<string, DurableScopeInfo>;
  const registry = dependencies.registry;
  if (
    registry &&
    dependencies.identity &&
    (uniqueCommands.some(({ command }) => !command.stopOnExit) ||
      registry.exists())
  ) {
    const built = await buildDurablePlan(
      uniqueCommands,
      dependencies,
      options,
      registry,
      dependencies.identity,
    );
    durablePlan = built.plan;
    durableScopes = built.durableScopes;
  } else {
    durablePlan = { enabled: false, blocked: new Set() };
    durableScopes = new Map();
  }

  function logSkipped(
    command: ConfiguredCommand,
    reason: "already-started" | "durable-unavailable",
  ): void {
    writeLog(dependencies.logger, {
      type: "command.skipped",
      scope: command.scope,
      index: command.index,
      name: command.name,
      reason,
    });
  }

  try {
    for (const { command, signature } of uniqueCommands) {
      const processKey = getProcessKey(command, signature);

      if (durablePlan.blocked.has(processKey)) {
        logSkipped(command, "durable-unavailable");
        continue;
      }

      const attempted = await withIdentityTransition(
        dependencies.state,
        processKey,
        async (entry) => {
          if (entry.records.length === 0) {
            if (
              entry.retryTombstone !== undefined ||
              entry.cleanupUnconfirmed
            ) {
              logSkipped(command, "already-started");
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
            logSkipped(command, "already-started");
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

          return await restartIdentity(
            entry,
            command,
            processKey,
            owner,
            claimedKeys,
            dependencies,
          );
        },
      );
      commandAttempted ||= attempted;
    }

    if (!commandAttempted) {
      writeLog(dependencies.logger, {
        type: "batch.skipped",
        reason: commands.length === 0 ? "no-valid-commands" : "already-started",
      });
    }

    if (durablePlan.enabled) {
      await persistDurableRecords(durablePlan, durableScopes, dependencies);
    }
  } finally {
    if (durablePlan.enabled) {
      durablePlan.handle.release();
    }
  }

  return activation;
}
