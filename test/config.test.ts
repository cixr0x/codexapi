import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultCodexCommand, loadConfig } from "../src/config.js";

const SAFE_WORKSPACE = resolve(process.cwd(), ".codexapi-inference-test");

function loadTestConfig(
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
) {
  return loadConfig({ CODEX_WORKSPACE: SAFE_WORKSPACE, ...env }, cwd, platform);
}

describe("config", () => {
  it("uses the npm Codex node script as the default command on Windows", () => {
    expect(
      defaultCodexCommand(
        "win32",
        { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
        "C:\\Program Files\\nodejs\\node.exe",
      ),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      ],
    });
  });

  it("uses codex as the default command on non-Windows platforms", () => {
    expect(defaultCodexCommand("linux")).toEqual({ command: "codex", args: [] });
  });

  it("allows an executable override without accepting arbitrary runner arguments", () => {
    const config = loadTestConfig(
      {
        CODEX_COMMAND: "node",
        CODEX_COMMAND_ARGS: "C:\\codex\\codex.js;--experimental-flag",
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      },
      "C:/repo",
      "win32",
    );

    expect(config.codexCommand).toBe("node");
    expect(config.codexCommandArgs).toEqual([]);
  });

  it("parses API-level call logging config", () => {
    const config = loadTestConfig(
      {
        CODEX_CALL_LOGGING: "true",
        CODEX_CALL_LOG_DIR: "C:\\logs\\codexapi",
      },
      "C:/repo",
      "win32",
    );

    expect(config.callLoggingEnabled).toBe(true);
    expect(config.callLogDir).toBe("C:\\logs\\codexapi");
  });

  it("uses the fixed local development port by default", () => {
    expect(loadTestConfig({}, "C:/repo", "linux").port).toBe(3001);
  });

  it("keeps the execution backend and capability policy immutable", () => {
    const config = loadTestConfig(
      {
        CODEX_PROFILE: "privileged",
        CODEX_IGNORE_USER_CONFIG: "false",
        CODEX_DISABLE_PLUGINS: "false",
        CODEX_DISABLE_SHELL_SNAPSHOT: "false",
        CODEX_EPHEMERAL: "false",
        CODEX_IGNORE_RULES: "false",
      },
      "C:/repo",
      "linux",
    );

    expect(config.codexBackend).toBe("exec");
    expect(config).not.toHaveProperty("codexProfile");
    expect(config).not.toHaveProperty("codexIgnoreUserConfig");
    expect(config).not.toHaveProperty("codexDisablePlugins");
    expect(config).not.toHaveProperty("codexDisableShellSnapshot");
    expect(config).not.toHaveProperty("codexEphemeral");
    expect(config).not.toHaveProperty("codexIgnoreRules");
  });

  it("uses the configured model defaults", () => {
    const config = loadTestConfig({}, "C:/repo", "linux");

    expect(config.codexDefaultModel).toBe("gpt-5.4-mini");
    expect(config.codexAllowedModels).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(config.codexReasoningEffort).toBe("medium");
  });

  it("disables call logging by default", () => {
    const config = loadTestConfig({}, "C:/repo", "linux");

    expect(config.callLoggingEnabled).toBe(false);
    expect(config.callLogDir).toBe(join("C:/repo", ".codexapi", "logs"));
  });

  it("rejects the app-server backend", () => {
    expect(() =>
      loadTestConfig({ CODEX_BACKEND: "app-server" }, "C:/repo", "linux"),
    ).toThrow("CODEX_BACKEND only supports exec.");
  });

  it("rejects the repository/current working directory as the Codex workspace", () => {
    expect(() =>
      loadConfig({ CODEX_WORKSPACE: process.cwd() }, process.cwd(), process.platform),
    ).toThrow("CODEX_WORKSPACE must be a dedicated inference directory.");
  });

  it("requires an explicitly configured Codex workspace", () => {
    expect(() => loadConfig({}, process.cwd(), process.platform)).toThrow(
      "CODEX_WORKSPACE must be an absolute path.",
    );
  });

  it.each(["low", "max", "ultra"])(
    "parses Codex reasoning effort config value %s",
    (effort) => {
      const config = loadTestConfig(
        { CODEX_REASONING_EFFORT: effort },
        "C:/repo",
        "linux",
      );

      expect(config.codexReasoningEffort).toBe(effort);
    },
  );

  it("parses Codex default and allowed model config", () => {
    const config = loadTestConfig(
      {
        CODEX_DEFAULT_MODEL: "custom-fast",
        CODEX_ALLOWED_MODELS: "custom-fast, custom-deep; gpt-5.5",
      },
      "C:/repo",
      "linux",
    );

    expect(config.codexDefaultModel).toBe("custom-fast");
    expect(config.codexAllowedModels).toEqual(["custom-fast", "custom-deep", "gpt-5.5"]);
  });

  it("rejects unsupported Codex backend names", () => {
    expect(() =>
      loadTestConfig({ CODEX_BACKEND: "sidecar" }, "C:/repo", "linux"),
    ).toThrow("CODEX_BACKEND only supports exec.");
  });

  it("rejects unsupported Codex reasoning effort values", () => {
    expect(() =>
      loadTestConfig({ CODEX_REASONING_EFFORT: "maximum" }, "C:/repo", "linux"),
    ).toThrow(
      "CODEX_REASONING_EFFORT must be one of: low, medium, high, xhigh, max, ultra.",
    );
  });
});
