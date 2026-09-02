import { normalize, resolve } from "node:path";
import { getErrorCode as getRawErrorCode } from "./error-code.js";
const ALLOWED_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);
const PROCESS_STATE_KEY = Symbol.for("opencode.startup-commands.state");
const processGlobal = globalThis;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isNonnegativeSafeInteger(value) {
    return (typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0);
}
function isOptionalPid(value) {
    return (value === undefined ||
        (typeof value === "number" && Number.isSafeInteger(value) && value > 0));
}
function isPromiseLike(value) {
    try {
        return isRecord(value) && typeof value.then === "function";
    }
    catch {
        return false;
    }
}
function isManagedCommandContext(value) {
    if (!isRecord(value)) {
        return false;
    }
    try {
        return ((value.scope === "global" || value.scope === "project") &&
            isNonnegativeSafeInteger(value.index) &&
            typeof value.name === "string");
    }
    catch {
        return false;
    }
}
function isSpawnedChild(value) {
    if (!isRecord(value)) {
        return false;
    }
    try {
        return (isOptionalPid(value.pid) &&
            typeof value.once === "function" &&
            typeof value.unref === "function");
    }
    catch {
        return false;
    }
}
function isOwnerSet(value) {
    if (!(value instanceof Set)) {
        return false;
    }
    try {
        return [...value].every((owner) => typeof owner === "symbol");
    }
    catch {
        return false;
    }
}
function isProcessRecord(value) {
    if (!isRecord(value)) {
        return false;
    }
    try {
        const sharedFieldsValid = isOptionalPid(value.pid) &&
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
    }
    catch {
        return false;
    }
}
function isIdentityEntry(value, processKey) {
    if (!isRecord(value)) {
        return false;
    }
    try {
        if (value.processKey !== processKey ||
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
            (value.retryTombstone !== undefined && value.records.length > 0)) {
            return false;
        }
        let previousCreationOrder = -1;
        for (const record of value.records) {
            if (record.creationOrder <= previousCreationOrder ||
                record.creationOrder >= value.nextCreationOrder) {
                return false;
            }
            previousCreationOrder = record.creationOrder;
        }
        return true;
    }
    catch {
        return false;
    }
}
function isStartupState(value) {
    if (!(value instanceof Map)) {
        return false;
    }
    try {
        return [...value].every(([processKey, entry]) => typeof processKey === "string" &&
            isIdentityEntry(entry, processKey));
    }
    catch {
        return false;
    }
}
function createIdentityEntry(processKey) {
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
export function createStartupState() {
    return new Map();
}
function convertLegacyState(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    let started;
    try {
        started = value.started;
    }
    catch {
        return undefined;
    }
    if (!(started instanceof Set)) {
        return undefined;
    }
    let processKeys;
    try {
        processKeys = [...started];
    }
    catch {
        return undefined;
    }
    if (!processKeys.every((processKey) => typeof processKey === "string")) {
        return undefined;
    }
    const state = createStartupState();
    for (const processKey of processKeys) {
        const entry = createIdentityEntry(processKey);
        entry.cleanupUnconfirmed = true;
        entry.status = "degraded";
        state.set(processKey, entry);
    }
    return state;
}
export function getOrCreateProcessState(registry) {
    const existingState = registry[PROCESS_STATE_KEY];
    if (isStartupState(existingState)) {
        return existingState;
    }
    const state = convertLegacyState(existingState) ?? createStartupState();
    registry[PROCESS_STATE_KEY] = state;
    return state;
}
export const processState = getOrCreateProcessState(processGlobal);
function getCommandSignature(command) {
    return JSON.stringify([command.executable, command.args]);
}
function getNormalizedProjectRoot(projectRoot) {
    const normalizedRoot = normalize(resolve(projectRoot));
    return process.platform === "win32"
        ? normalizedRoot.toLowerCase()
        : normalizedRoot;
}
export { getNormalizedProjectRoot as normalizeProjectRoot };
function getProcessKey(command, signature) {
    if (command.scope === "global") {
        return `global:${signature}`;
    }
    return `project:${getNormalizedProjectRoot(command.projectRoot)}:${signature}`;
}
function getErrorCode(error) {
    const code = getRawErrorCode(error);
    return (code !== undefined && ALLOWED_ERROR_CODES.has(code) ? code : undefined);
}
function writeLog(logger, event) {
    try {
        logger.write(event);
    }
    catch {
    }
}
function pruneIdentityIfEmpty(state, entry) {
    if (entry.records.length === 0 &&
        entry.retryTombstone === undefined &&
        !entry.cleanupUnconfirmed &&
        entry.pendingTransitions === 0 &&
        state.get(entry.processKey) === entry) {
        state.delete(entry.processKey);
    }
}
async function withIdentityTransition(state, processKey, transition) {
    const entry = state.get(processKey) ?? createIdentityEntry(processKey);
    if (!state.has(processKey)) {
        state.set(processKey, entry);
    }
    entry.pendingTransitions += 1;
    const previous = entry.transitionTail;
    let release;
    entry.transitionTail = new Promise((resolveTransition) => {
        release = resolveTransition;
    });
    try {
        await Promise.resolve(previous).catch(() => undefined);
        return await transition(entry);
    }
    finally {
        entry.pendingTransitions -= 1;
        release();
        pruneIdentityIfEmpty(state, entry);
    }
}
function getValidatedPid(child) {
    try {
        const pid = child.pid;
        return typeof pid === "number" &&
            Number.isSafeInteger(pid) &&
            pid > 0
            ? pid
            : undefined;
    }
    catch {
        return undefined;
    }
}
function spawnRecord(command, owner, entry, dependencies) {
    const spawnOptions = {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
    };
    if (command.scope === "project") {
        spawnOptions.cwd = command.projectRoot;
    }
    let child;
    try {
        child = dependencies.spawn(command.executable, command.args, spawnOptions);
    }
    catch (error) {
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
    const record = {
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
                void withIdentityTransition(dependencies.state, entry.processKey, async (currentEntry) => {
                    if (!currentEntry.records.includes(record)) {
                        return;
                    }
                    currentEntry.records = currentEntry.records.filter((candidate) => candidate !== record);
                    if (currentEntry.records.length === 0) {
                        currentEntry.retryTombstone = "spawn-failed";
                    }
                }).catch(() => undefined);
            }
        });
    }
    catch {
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
            void withIdentityTransition(dependencies.state, entry.processKey, async (currentEntry) => {
                if (!currentEntry.records.includes(record) ||
                    record.stopPromise !== undefined) {
                    return;
                }
                const result = await requestRecordStop(record, "root-exited", dependencies);
                if (!currentEntry.records.includes(record)) {
                    return;
                }
                applyRecordStopResult(currentEntry, record, result);
                if (currentEntry.records.length === 0) {
                    currentEntry.retryTombstone = "natural-exit";
                }
            }).catch(() => undefined);
        });
    }
    catch {
    }
    try {
        child.unref();
    }
    catch {
    }
    return record;
}
function requestRecordStop(record, trigger, dependencies) {
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
        .catch(() => ({
        status: "failed",
        reason: "unconfirmed",
        addressability: record.rootExited ? "lost" : "safe",
    }));
    return record.stopPromise;
}
async function resolveRootExited(record, dependencies) {
    if (!dependencies.identity) {
        return true;
    }
    try {
        const probed = await dependencies.identity.probe(record.pid, record.startToken);
        return probed.status !== "alive";
    }
    catch {
        return true;
    }
}
function stopThroughTree(record, trigger, dependencies) {
    let stopPromise;
    try {
        stopPromise = Promise.resolve(dependencies.processTree.stop(record.pid, {
            isRootExited: () => record.rootExited,
            onForce: () => {
                writeLog(dependencies.logger, {
                    type: "command.stop-forced",
                    ...record.context,
                    pid: record.pid,
                    trigger,
                });
            },
        }));
    }
    catch {
        stopPromise = Promise.resolve({
            status: "failed",
            reason: "unconfirmed",
            addressability: record.rootExited ? "lost" : "safe",
        });
    }
    return stopPromise
        .catch(() => ({
        status: "failed",
        reason: "unconfirmed",
        addressability: record.rootExited ? "lost" : "safe",
    }))
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
function applyRecordStopResult(entry, record, result) {
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
function durableKeyFor(part) {
    return part.scope === "global"
        ? `identity:${part.identityHash}`
        : `identity:${part.identityHash}:root:${part.projectRootHash}`;
}
function trackedPidKey(processKey, pid) {
    return `${processKey}:${pid}`;
}
function adoptedRecordFrom(stored, context) {
    return {
        origin: "adopted",
        pid: stored.pid,
        startToken: stored.startToken,
        context,
        creationOrder: stored.creationOrder,
        owners: new Set(),
        stopOnExit: false,
        status: "active",
        rootExited: false,
    };
}
function toDurableRecord(scopeInfo, pid, startToken, creationOrder, recordedAt) {
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
const DURABLE_CAUSE_BY_REASON = {
    unreadable: "registry-unreadable",
    malformed: "registry-malformed",
    "unsupported-schema": "registry-unsupported-schema",
};
function durableCauseFor(reason) {
    return DURABLE_CAUSE_BY_REASON[reason];
}
function finalizePersistedRecords(records) {
    const deduped = new Map();
    for (const stored of records) {
        deduped.set(`${durableKeyFor(stored)}:${stored.pid}`, stored);
    }
    const groups = new Map();
    const groupOrder = [];
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
    const sorted = [];
    for (const key of groupOrder) {
        const group = groups.get(key);
        group.sort((left, right) => left.creationOrder - right.creationOrder);
        sorted.push(...group);
    }
    return sorted;
}
async function safeDescribe(pid, identity) {
    try {
        return await identity.describe(pid);
    }
    catch {
        return { status: "unknown", reason: "unconfirmed" };
    }
}
async function safeProbe(pid, startToken, identity) {
    try {
        return await identity.probe(pid, startToken);
    }
    catch {
        return { status: "unknown", reason: "unconfirmed" };
    }
}
async function describeToken(pid, identity) {
    const described = await safeDescribe(pid, identity);
    return described.status === "described" ? described.token : undefined;
}
async function resolveLockHolder(resolveOwner, identity) {
    let owner;
    try {
        owner = await resolveOwner?.();
    }
    catch {
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
function indexDurableCommands(uniqueCommands, registry, projectRootHash) {
    const durableScopes = new Map();
    const durableProcessKeys = new Set();
    const commandByDurableKey = new Map();
    for (const { command, signature } of uniqueCommands) {
        const processKey = getProcessKey(command, signature);
        const identityHash = registry.hashIdentity(signature);
        if (!command.stopOnExit) {
            durableProcessKeys.add(processKey);
        }
        let scopeInfo;
        if (command.scope === "global") {
            scopeInfo = { scope: "global", identityHash };
        }
        else {
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
function partitionByProjectRoot(records, projectRootHash) {
    const foreign = [];
    const current = [];
    for (const stored of records) {
        if (stored.scope === "global" ||
            stored.projectRootHash === projectRootHash) {
            current.push(stored);
        }
        else {
            foreign.push(stored);
        }
    }
    return { foreign, current };
}
async function buildDurablePlan(uniqueCommands, dependencies, options, registry, identity) {
    const { durableScopes, durableProcessKeys, commandByDurableKey } = indexDurableCommands(uniqueCommands, registry, options?.projectRootHash);
    const reconciledCounts = {
        global: { stopped: 0 },
        project: { stopped: 0 },
    };
    function unavailable(cause) {
        writeLog(dependencies.logger, {
            type: "durable.unavailable",
            cause,
        });
        return {
            plan: { enabled: false, blocked: durableProcessKeys },
            durableScopes,
        };
    }
    const holderResolution = await resolveLockHolder(options?.resolveOwner, identity);
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
        const { foreign: foreignRecords, current: currentScopeRecords } = partitionByProjectRoot(readResult.records, options?.projectRootHash);
        const nextCreationOrderByKey = new Map();
        for (const stored of currentScopeRecords) {
            const key = durableKeyFor(stored);
            nextCreationOrderByKey.set(key, Math.max(nextCreationOrderByKey.get(key) ?? 0, stored.creationOrder + 1));
        }
        const carriedRecords = [];
        const fallbackTokens = new Map();
        const seededEntries = new Map();
        function seededEntryFor(processKey, nextOrderFloor) {
            let entry = seededEntries.get(processKey);
            if (!entry) {
                entry =
                    dependencies.state.get(processKey) ??
                        createIdentityEntry(processKey);
                dependencies.state.set(processKey, entry);
                seededEntries.set(processKey, entry);
            }
            entry.nextCreationOrder = Math.max(entry.nextCreationOrder, nextOrderFloor);
            return entry;
        }
        for (const stored of currentScopeRecords) {
            const key = durableKeyFor(stored);
            const lookup = commandByDurableKey.get(key);
            const nextOrderFloor = nextCreationOrderByKey.get(key) ?? stored.creationOrder + 1;
            const owningCommand = lookup
                ? {
                    processKey: lookup.processKey,
                    entry: seededEntryFor(lookup.processKey, nextOrderFloor),
                    context: lookup.context,
                }
                : undefined;
            const probeResult = await safeProbe(stored.pid, stored.startToken, identity);
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
                    const stopResult = await requestRecordStop(orphanProcessRecord, "restart", dependencies);
                    if (stopResult.status !== "stopped") {
                        carriedRecords.push(stored);
                        continue;
                    }
                    reconciledCounts[stored.scope].stopped += 1;
                    continue;
                }
                const alreadyTracked = owningCommand.entry.records.some((existing) => existing.pid === stored.pid);
                if (alreadyTracked) {
                    fallbackTokens.set(trackedPidKey(owningCommand.processKey, stored.pid), stored.startToken);
                    continue;
                }
                owningCommand.entry.records.push(adoptedRecordFrom(stored, owningCommand.context));
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
        for (const scope of ["global", "project"]) {
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
    }
    catch (error) {
        handle.release();
        throw error;
    }
}
function dedupeCommands(commands, logger) {
    const globalCommands = new Map();
    const projectCommands = new Map();
    const duplicateCommands = [];
    commands.forEach((command, order) => {
        const signature = getCommandSignature(command);
        const indexedCommand = { command, order, signature };
        if (command.scope === "global") {
            if (globalCommands.has(signature)) {
                duplicateCommands.push(indexedCommand);
            }
            else {
                globalCommands.set(signature, indexedCommand);
            }
            return;
        }
        const projectKey = getProcessKey(command, signature);
        if (projectCommands.has(projectKey)) {
            duplicateCommands.push(indexedCommand);
        }
        else {
            projectCommands.set(projectKey, indexedCommand);
        }
    });
    const uniqueProjectCommands = [...projectCommands.values()].filter((indexedCommand) => {
        if (globalCommands.has(indexedCommand.signature)) {
            duplicateCommands.push(indexedCommand);
            return false;
        }
        return true;
    });
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
function createActivation(claimedKeys, owner, dependencies) {
    let disposePromise;
    return {
        dispose() {
            disposePromise ??= Promise.all([...claimedKeys].map((processKey) => withIdentityTransition(dependencies.state, processKey, async (entry) => {
                const recordsToStop = [];
                for (const record of entry.records) {
                    if (record.owners.delete(owner) &&
                        record.owners.size === 0 &&
                        record.stopOnExit) {
                        recordsToStop.push(record);
                    }
                }
                const results = await Promise.all(recordsToStop.map((record) => requestRecordStop(record, "scope-disposed", dependencies)));
                results.forEach((result, index) => {
                    applyRecordStopResult(entry, recordsToStop[index], result);
                });
            })))
                .then(() => undefined)
                .catch(() => undefined);
            return disposePromise;
        },
    };
}
async function restartIdentity(entry, command, processKey, owner, claimedKeys, dependencies) {
    entry.status = "restarting";
    const snapshot = entry.records.map((record) => ({
        record,
        owners: new Set(record.owners),
    }));
    const ownerUnion = new Set([owner]);
    for (const { owners } of snapshot) {
        for (const recordOwner of owners) {
            ownerUnion.add(recordOwner);
        }
    }
    const results = await Promise.all(snapshot.map(({ record }) => requestRecordStop(record, "restart", dependencies)));
    const safeSurvivors = [];
    const transferredOwners = new Set([owner]);
    let stopFailed = false;
    results.forEach((result, index) => {
        const { record, owners } = snapshot[index];
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
        const replacement = spawnRecord(command, owner, entry, dependencies);
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
async function persistDurableRecords(plan, durableScopes, dependencies) {
    const persisted = [...plan.carriedRecords];
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
            const describedToken = record.origin === "adopted"
                ? record.startToken
                : await describeToken(record.pid, plan.identity);
            const startToken = describedToken ??
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
            persisted.push(toDurableRecord(scopeInfo, record.pid, startToken, record.creationOrder, recordedAt));
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
export async function runStartupCommands(commands, dependencies, options) {
    const owner = Symbol("startup-command-owner");
    const claimedKeys = new Set();
    const activation = createActivation(claimedKeys, owner, dependencies);
    writeLog(dependencies.logger, {
        type: "plugin.initialized",
        commandCount: commands.length,
    });
    const uniqueCommands = dedupeCommands(commands, dependencies.logger);
    let commandAttempted = false;
    let durablePlan;
    let durableScopes;
    const registry = dependencies.registry;
    if (registry &&
        dependencies.identity &&
        (uniqueCommands.some(({ command }) => !command.stopOnExit) ||
            registry.exists())) {
        const built = await buildDurablePlan(uniqueCommands, dependencies, options, registry, dependencies.identity);
        durablePlan = built.plan;
        durableScopes = built.durableScopes;
    }
    else {
        durablePlan = { enabled: false, blocked: new Set() };
        durableScopes = new Map();
    }
    function logSkipped(command, reason) {
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
            const attempted = await withIdentityTransition(dependencies.state, processKey, async (entry) => {
                if (entry.records.length === 0) {
                    if (entry.retryTombstone !== undefined ||
                        entry.cleanupUnconfirmed) {
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
                    const activeRecord = entry.records.find((record) => record.status === "active");
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
                return await restartIdentity(entry, command, processKey, owner, claimedKeys, dependencies);
            });
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
    }
    finally {
        if (durablePlan.enabled) {
            durablePlan.handle.release();
        }
    }
    return activation;
}
//# sourceMappingURL=core.js.map