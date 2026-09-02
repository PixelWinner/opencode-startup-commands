import type { CommandStopTrigger, LogEvent } from "../src/logger.js";

const validSpawn = {
  type: "command.spawned",
  scope: "global",
  index: 0,
  name: "Helper",
  pid: 123,
} satisfies LogEvent;
void validSpawn;

const validStopTriggers = [
  "scope-disposed",
  "root-exited",
  "restart",
] satisfies CommandStopTrigger[];
void validStopTriggers;

const validStopRequested = {
  type: "command.stop-requested",
  scope: "project",
  index: 1,
  name: "Project helper",
  pid: 321,
  trigger: "scope-disposed",
} satisfies LogEvent;
void validStopRequested;

const validStopForced = {
  type: "command.stop-forced",
  scope: "global",
  index: 2,
  name: "Global helper",
  trigger: "restart",
} satisfies LogEvent;
void validStopForced;

const validStopFailed = {
  type: "command.stop-failed",
  scope: "project",
  index: 3,
  name: "Failed helper",
  trigger: "root-exited",
  reason: "unconfirmed",
} satisfies LogEvent;
void validStopFailed;

type CommandStopFailureReason = Extract<
  LogEvent,
  { type: "command.stop-failed" }
>["reason"];

const validStopFailureReasons = [
  "missing-pid",
  "permission-denied",
  "facility-unavailable",
  "unconfirmed",
] satisfies CommandStopFailureReason[];
void validStopFailureReasons;

const invalidStopTrigger: LogEvent = {
  type: "command.stop-requested",
  scope: "global",
  index: 0,
  name: "Helper",
  // @ts-expect-error stop triggers use a closed set of lifecycle causes
  trigger: "shutdown",
};
void invalidStopTrigger;

const invalidStopFailureReason: LogEvent = {
  type: "command.stop-failed",
  scope: "project",
  index: 0,
  name: "Helper",
  trigger: "scope-disposed",
  // @ts-expect-error stop failures use process-tree failure reasons
  reason: "unknown",
};
void invalidStopFailureReason;

const unsafeStopExecutable: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error executable paths are not valid stop fields
  executable: "C:\\secret\\helper.exe",
};
void unsafeStopExecutable;

const unsafeStopArgs: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error command arguments are not valid stop fields
  args: ["--token", "secret"],
};
void unsafeStopArgs;

const unsafeStopEnv: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error environment values are not valid stop fields
  env: { SECRET: "value" },
};
void unsafeStopEnv;

const unsafeStopConfiguration: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error configuration is not a valid stop field
  configuration: { commands: [] },
};
void unsafeStopConfiguration;

const unsafeStopStdout: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error stdout is not a valid stop field
  stdout: "secret output",
};
void unsafeStopStdout;

const unsafeStopStderr: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error stderr is not a valid stop field
  stderr: "secret output",
};
void unsafeStopStderr;

const unsafeStopOutput: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error utility output is not a valid stop field
  output: "secret output",
};
void unsafeStopOutput;

const unsafeStopRawError: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error raw errors are not valid stop fields
  rawError: new Error("secret"),
};
void unsafeStopRawError;

const unsafeStopMessage: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error error messages are not valid stop fields
  message: "secret",
};
void unsafeStopMessage;

const unsafeStopStack: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error error stacks are not valid stop fields
  stack: "secret",
};
void unsafeStopStack;

const unsafeStopPath: LogEvent = {
  ...validStopRequested,
  // @ts-expect-error paths are not valid stop fields
  path: "C:\\secret",
};
void unsafeStopPath;

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
  | "env"
  | "configuration"
  | "stdout"
  | "stderr"
  | "output"
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
type CommandStopRequestedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.stop-requested">
>;
type CommandStopForcedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.stop-forced">
>;
type CommandStopFailedIsSafe = AssertNoUnsafeFields<
  UnsafeFieldsOf<"command.stop-failed">
>;
