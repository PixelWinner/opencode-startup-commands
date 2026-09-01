import {
  loadConfigFile,
  type ConfigDiagnostic,
  type ConfiguredCommand,
  type OnExistingProcessPolicy,
} from "../src/config.js";

loadConfigFile("global", "global.json");
loadConfigFile("project", "project.json", "project-root");

// @ts-expect-error project configuration requires its project root
loadConfigFile("project", "project.json");

// @ts-expect-error global configuration does not accept a project root
loadConfigFile("global", "global.json", "project-root");

const onExistingProcessPolicies: OnExistingProcessPolicy[] = [
  "start",
  "skip",
  "restart",
];
void onExistingProcessPolicies;

// @ts-expect-error onExistingProcess rejects unsupported policies
const invalidOnExistingProcessPolicy: OnExistingProcessPolicy = "replace";
void invalidOnExistingProcessPolicy;

const globalCommand = {
  name: "Global Helper",
  executable: "helper",
  args: [],
  onExistingProcess: "skip",
  stopOnExit: true,
  scope: "global",
  index: 0,
} satisfies ConfiguredCommand;
void globalCommand;

const projectCommand = {
  name: "Project Helper",
  executable: "helper",
  args: [],
  onExistingProcess: "start",
  stopOnExit: false,
  scope: "project",
  projectRoot: "project-root",
  index: 0,
} satisfies ConfiguredCommand;
void projectCommand;

// @ts-expect-error configured commands require onExistingProcess
const commandWithoutOnExistingProcess: ConfiguredCommand = {
  name: "Global Helper",
  executable: "helper",
  args: [],
  stopOnExit: true,
  scope: "global",
  index: 0,
};
void commandWithoutOnExistingProcess;

const commandWithNonBooleanStopOnExit: ConfiguredCommand = {
  name: "Global Helper",
  executable: "helper",
  args: [],
  onExistingProcess: "skip",
  // @ts-expect-error configured commands require boolean stopOnExit
  stopOnExit: "yes",
  scope: "global",
  index: 0,
};
void commandWithNonBooleanStopOnExit;

// @ts-expect-error configured commands require their source array index
const globalCommandWithoutIndex: ConfiguredCommand = {
  name: "Global Helper",
  executable: "helper",
  args: [],
  onExistingProcess: "skip",
  stopOnExit: true,
  scope: "global",
};
void globalCommandWithoutIndex;

// @ts-expect-error project commands require a project root
const projectWithoutRoot: ConfiguredCommand = {
  name: "Project Helper",
  executable: "helper",
  args: [],
  onExistingProcess: "skip",
  stopOnExit: true,
  scope: "project",
  index: 0,
};
void projectWithoutRoot;

// @ts-expect-error global commands prohibit a project root
const globalWithRoot: ConfiguredCommand = {
  name: "Global Helper",
  executable: "helper",
  args: [],
  onExistingProcess: "skip",
  stopOnExit: true,
  scope: "global",
  projectRoot: "project-root",
  index: 0,
};
void globalWithRoot;

for (const command of loadConfigFile("global", "global.json").commands) {
  if (command.scope === "project") {
    const projectRoot: string = command.projectRoot;
    void projectRoot;
  } else {
    // @ts-expect-error global commands do not expose a string project root
    const projectRoot: string = command.projectRoot;
    void projectRoot;
  }
}

const invalidCommandDiagnostic = {
  scope: "global",
  reason: "invalid-command",
  index: 0,
  name: "Safe helper name",
} satisfies ConfigDiagnostic;
void invalidCommandDiagnostic;

const unnamedInvalidCommandDiagnostic = {
  scope: "project",
  reason: "invalid-command",
  index: 1,
} satisfies ConfigDiagnostic;
void unnamedInvalidCommandDiagnostic;

const scopeDiagnostic = {
  scope: "global",
  reason: "invalid-json",
} satisfies ConfigDiagnostic;
void scopeDiagnostic;

// @ts-expect-error invalid command diagnostics require an index
const invalidCommandWithoutIndex: ConfigDiagnostic = {
  scope: "global",
  reason: "invalid-command",
};
void invalidCommandWithoutIndex;

// @ts-expect-error scope-level diagnostics prohibit command indexes
const scopeDiagnosticWithIndex: ConfigDiagnostic = {
  scope: "project",
  reason: "file-unavailable",
  index: 0,
};
void scopeDiagnosticWithIndex;

// @ts-expect-error scope-level diagnostics prohibit command names
const scopeDiagnosticWithName: ConfigDiagnostic = {
  scope: "global",
  reason: "commands-required",
  name: "Not allowed",
};
void scopeDiagnosticWithName;
