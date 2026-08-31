import type { LogEvent } from "../src/logger.js";

const validSpawn = {
  type: "command.spawned",
  scope: "global",
  index: 0,
  name: "Helper",
  pid: 123,
} satisfies LogEvent;
void validSpawn;

const unsafeCommand: LogEvent = {
  type: "command.spawned",
  scope: "global",
  index: 0,
  name: "Helper",
  // @ts-expect-error executable paths are not valid log fields
  command: "C:\\secret\\helper.exe",
};
void unsafeCommand;

const unsafeInitialization: LogEvent = {
  type: "plugin.initialized",
  commandCount: 1,
  // @ts-expect-error log file paths are not valid initialization fields
  filePath: "C:\\secret\\plugin.log",
};
void unsafeInitialization;

const unsafeBatchSkip: LogEvent = {
  type: "batch.skipped",
  reason: "already-started",
  // @ts-expect-error raw errors are not valid batch skip fields
  rawError: new Error("secret"),
};
void unsafeBatchSkip;

// @ts-expect-error exited events require complete safe exit context
const incompleteExit: LogEvent = { type: "command.exited", index: 0 };
void incompleteExit;

const validConfigurationDiagnostic = {
  type: "configuration.invalid",
  scope: "project",
  reason: "invalid-json",
} satisfies LogEvent;
void validConfigurationDiagnostic;

const validCommandDiagnostic = {
  type: "command.invalid",
  scope: "global",
  index: 1,
  name: "Helper",
} satisfies LogEvent;
void validCommandDiagnostic;

const validCommandSkip = {
  type: "command.skipped",
  scope: "project",
  index: 2,
  name: "Helper",
  reason: "duplicate",
} satisfies LogEvent;
void validCommandSkip;

const invalidConfigurationReason: LogEvent = {
  type: "configuration.invalid",
  scope: "global",
  // @ts-expect-error configuration diagnostics use fixed reasons
  reason: "invalid-command",
};
void invalidConfigurationReason;

const invalidSkipReason: LogEvent = {
  type: "command.skipped",
  scope: "global",
  index: 0,
  name: "Helper",
  // @ts-expect-error command skip diagnostics use fixed reasons
  reason: "configuration-invalid",
};
void invalidSkipReason;

type UnsafeLogField =
  | "path"
  | "filePath"
  | "content"
  | "executable"
  | "args"
  | "error"
  | "rawError"
  | "message"
  | "stack";

type EventOfType<Type extends LogEvent["type"]> = Extract<
  LogEvent,
  { type: Type }
>;
type UnsafeFieldsOf<Type extends LogEvent["type"]> = Extract<
  keyof EventOfType<Type>,
  UnsafeLogField
>;
type AssertNoUnsafeFields<Value extends never> = Value;

type PluginInitializedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"plugin.initialized">
>;
type BatchSkippedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"batch.skipped">
>;
type ConfigurationInvalidIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"configuration.invalid">
>;
type CommandInvalidIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.invalid">
>;
type CommandSkippedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.skipped">
>;
type CommandSpawnedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.spawned">
>;
type CommandSpawnFailedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.spawn-failed">
>;
type CommandChildErrorIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.child-error">
>;
type CommandExitedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.exited">
>;
