import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const privateReportingUrl =
  "https://github.com/PixelWinner/opencode-startup-commands/security/advisories/new";
const canonicalMitLicense = `MIT License

Copyright (c) 2026 Oleksandr Khoroshykh (PixelWinner)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const expectedBugIssueForm: Record<string, unknown> = {
  name: "Bug report",
  description: "Report a reproducible problem with the plugin",
  title: "[Bug]: ",
  labels: ["bug"],
  body: [
    {
      type: "markdown",
      attributes: {
        value:
          "Thanks for reporting a bug. Remove credentials, tokens, personal data, and unrelated private information before submitting.\n",
      },
    },
    {
      type: "input",
      id: "plugin-version",
      attributes: {
        label: "Plugin version",
        placeholder: "1.1.0",
      },
      validations: { required: true },
    },
    {
      type: "input",
      id: "opencode-version",
      attributes: {
        label: "OpenCode version",
        placeholder: "1.18.25",
      },
      validations: { required: true },
    },
    {
      type: "input",
      id: "operating-system",
      attributes: {
        label: "Operating system",
        placeholder: "Windows 11, macOS 15, or Ubuntu 24.04",
      },
      validations: { required: true },
    },
    {
      type: "textarea",
      id: "reproduction",
      attributes: {
        label: "Steps to reproduce",
        description: "Provide the smallest reproducible sequence of steps.",
      },
      validations: { required: true },
    },
    {
      type: "textarea",
      id: "expected-behavior",
      attributes: { label: "Expected behavior" },
      validations: { required: true },
    },
    {
      type: "textarea",
      id: "actual-behavior",
      attributes: { label: "Actual behavior" },
      validations: { required: true },
    },
    {
      type: "textarea",
      id: "sanitized-evidence",
      attributes: {
        label: "Sanitized evidence",
        description:
          "Provide sanitized logs or configuration only when needed. Do not include secrets or personal data.",
        render: "shell",
      },
      validations: { required: false },
    },
  ],
};
const expectedFeatureIssueForm: Record<string, unknown> = {
  name: "Feature request",
  description: "Suggest an improvement or new capability",
  title: "[Feature]: ",
  labels: ["enhancement"],
  body: [
    {
      type: "markdown",
      attributes: {
        value:
          "Feature requests are welcome. External code contributions are not currently accepted.\n",
      },
    },
    {
      type: "textarea",
      id: "problem-or-use-case",
      attributes: {
        label: "Problem or use case",
        description: "Describe the problem to solve or the use case to support.",
      },
      validations: { required: true },
    },
    {
      type: "textarea",
      id: "proposed-behavior",
      attributes: {
        label: "Proposed behavior",
        description: "Describe how the plugin should behave.",
      },
      validations: { required: true },
    },
    {
      type: "textarea",
      id: "additional-context",
      attributes: {
        label: "Additional context",
        description: "Add optional examples or alternatives.",
      },
      validations: { required: false },
    },
    {
      type: "checkboxes",
      id: "duplicate-check",
      attributes: {
        label: "Duplicate check",
        options: [
          {
            label:
              "I searched existing open issues and did not find this request.",
            required: true,
          },
        ],
      },
    },
  ],
};

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function normalizeText(text: string): string {
  return `${text.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

function parseIssueForm(path: string): Record<string, unknown> {
  return Bun.YAML.parse(readRepositoryFile(path)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExactStructure(
  actual: unknown,
  expected: unknown,
  path: string,
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${path} type must be array`);
    }
    if (actual.length !== expected.length) {
      throw new Error(`${path} length must be ${expected.length}`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      validateExactStructure(actual[index], expected[index], `${path}[${index}]`);
    }
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      throw new Error(`${path} type must be object`);
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`${path} fields must be exactly ${expectedKeys.join(", ")}`);
    }
    for (const key of expectedKeys) {
      validateExactStructure(actual[key], expected[key], `${path}.${key}`);
    }
    return;
  }

  if (!Object.is(actual, expected)) {
    throw new Error(`${path} must be ${JSON.stringify(expected)}`);
  }
}

function validateIssueForm(
  form: unknown,
  expectedForm: Record<string, unknown>,
): void {
  if (!isRecord(form)) {
    throw new Error("Issue Form type must be object");
  }
  const requiredTopLevelFields = [
    "body",
    "description",
    "labels",
    "name",
    "title",
  ];
  if (
    JSON.stringify(Object.keys(form).sort()) !==
    JSON.stringify(requiredTopLevelFields)
  ) {
    throw new Error(
      `Issue Form top-level fields must be exactly ${requiredTopLevelFields.join(", ")}`,
    );
  }
  validateExactStructure(form, expectedForm, "Issue Form");
}

function validateBugIssueForm(form: unknown): void {
  validateIssueForm(form, expectedBugIssueForm);
}

function validateFeatureIssueForm(form: unknown): void {
  validateIssueForm(form, expectedFeatureIssueForm);
}

function replaceBodyField(
  form: Record<string, unknown>,
  index: number,
  replace: (field: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const body = form.body as unknown[];
  return {
    ...form,
    body: body.map((field, fieldIndex) =>
      fieldIndex === index ? replace(field as Record<string, unknown>) : field,
    ),
  };
}

test("ships the complete canonical MIT license with the approved copyright", () => {
  expect(normalizeText(readRepositoryFile("LICENSE"))).toBe(
    normalizeText(canonicalMitLicense),
  );
});

test("publishes a private, sanitized, latest-release-only security policy", () => {
  const securityPolicy = readRepositoryFile("SECURITY.md");

  expect(securityPolicy).toContain(privateReportingUrl);
  expect(securityPolicy).toMatch(/latest published (?:release|version) only/i);
  expect(securityPolicy).toMatch(/do not report.*public/i);
  expect(securityPolicy).toMatch(/minimal.*sanitized.*reproduction/i);
  expect(securityPolicy).toMatch(/credentials.*tokens.*personal data/i);
  expect(securityPolicy).toMatch(/do not include.*unrelated private information/i);
  expect(securityPolicy).toMatch(/no response-time SLA/i);
  expect(securityPolicy).toMatch(
    /external code contributions are not currently accepted/i,
  );
});

test("bug Issue Form has the exact approved structure and required semantics", () => {
  validateBugIssueForm(
    parseIssueForm(".github/ISSUE_TEMPLATE/bug_report.yml"),
  );
});

test("bug Issue Form validator rejects missing and wrong fields", () => {
  const { description: _description, ...missingDescription } =
    expectedBugIssueForm;
  const wrongId = replaceBodyField(expectedBugIssueForm, 1, (field) => ({
    ...field,
    id: "version",
  }));
  const wrongLabel = replaceBodyField(expectedBugIssueForm, 2, (field) => ({
    ...field,
    attributes: {
      ...(field.attributes as Record<string, unknown>),
      label: "Editor version",
    },
  }));
  const wrongDescription = replaceBodyField(
    expectedBugIssueForm,
    4,
    (field) => ({
      ...field,
      attributes: {
        ...(field.attributes as Record<string, unknown>),
        description: "Describe what happened.",
      },
    }),
  );
  const wrongRequired = replaceBodyField(expectedBugIssueForm, 7, (field) => ({
    ...field,
    validations: { required: true },
  }));

  for (const [fixture, errorPath] of [
    [missingDescription, "description"],
    [wrongId, "body[1].id"],
    [wrongLabel, "body[2].attributes.label"],
    [wrongDescription, "body[4].attributes.description"],
    [wrongRequired, "body[7].validations.required"],
  ] as Array<[Record<string, unknown>, string]>) {
    expect(() => validateBugIssueForm(fixture)).toThrow(errorPath);
  }
});

test("feature Issue Form has the exact approved structure and checkbox semantics", () => {
  validateFeatureIssueForm(
    parseIssueForm(".github/ISSUE_TEMPLATE/feature_request.yml"),
  );
});

test("feature Issue Form validator rejects malformed fields and checkbox options", () => {
  const extraTopLevelField = {
    ...expectedFeatureIssueForm,
    assignees: [],
  };
  const wrongType = replaceBodyField(
    expectedFeatureIssueForm,
    1,
    (field) => ({ ...field, type: "input" }),
  );
  const wrongDescription = replaceBodyField(
    expectedFeatureIssueForm,
    2,
    (field) => ({
      ...field,
      attributes: {
        ...(field.attributes as Record<string, unknown>),
        description: "Describe the implementation.",
      },
    }),
  );
  const wrongRequired = replaceBodyField(
    expectedFeatureIssueForm,
    3,
    (field) => ({ ...field, validations: { required: true } }),
  );
  const optionalCheckbox = replaceBodyField(
    expectedFeatureIssueForm,
    4,
    (field) => {
      const attributes = field.attributes as Record<string, unknown>;
      const options = attributes.options as Array<Record<string, unknown>>;
      return {
        ...field,
        attributes: {
          ...attributes,
          options: options.map((option) => ({
            ...option,
            required: false,
          })),
        },
      };
    },
  );

  for (const [fixture, errorPath] of [
    [extraTopLevelField, "top-level fields"],
    [wrongType, "body[1].type"],
    [wrongDescription, "body[2].attributes.description"],
    [wrongRequired, "body[3].validations.required"],
    [optionalCheckbox, "body[4].attributes.options[0].required"],
  ] as Array<[Record<string, unknown>, string]>) {
    expect(() => validateFeatureIssueForm(fixture)).toThrow(errorPath);
  }
});

test("disables blank issues and routes security reports to Private Vulnerability Reporting", () => {
  const config = parseIssueForm(".github/ISSUE_TEMPLATE/config.yml") as {
    blank_issues_enabled?: boolean;
    contact_links?: Array<Record<string, string>>;
  };

  expect(config.blank_issues_enabled).toBe(false);
  expect(config.contact_links).toEqual([
    {
      name: "Report a security vulnerability",
      url: privateReportingUrl,
      about:
        "Report vulnerabilities privately through GitHub Private Vulnerability Reporting.",
    },
  ]);
});

test("does not introduce pull request or contribution templates", () => {
  for (const forbiddenPath of [
    "CONTRIBUTING.md",
    "PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE",
    "pull_request_template",
    ".github/CONTRIBUTING.md",
    ".github/contributing.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE",
    ".github/pull_request_template",
    "docs/CONTRIBUTING.md",
    "docs/contributing.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE",
    "docs/pull_request_template",
  ]) {
    expect(existsSync(join(repositoryRoot, forbiddenPath))).toBe(false);
  }
});
