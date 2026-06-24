import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { defaultCodexCommand, loadConfig } from "../src/config.js";

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

  it("lets CODEX_COMMAND and CODEX_COMMAND_ARGS override the platform default", () => {
    const config = loadConfig(
      {
        CODEX_COMMAND: "node",
        CODEX_COMMAND_ARGS: "C:\\codex\\codex.js;--experimental-flag",
      },
      "C:/repo",
      "win32",
    );

    expect(config.codexCommand).toBe("node");
    expect(config.codexCommandArgs).toEqual([
      "C:\\codex\\codex.js",
      "--experimental-flag",
    ]);
  });

  it("parses API-level call logging config", () => {
    const config = loadConfig(
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

  it("disables Codex plugins by default for API-launched runs", () => {
    const config = loadConfig({}, "C:/repo", "linux");

    expect(config.codexDisablePlugins).toBe(true);
  });

  it("allows Codex plugin loading to be explicitly re-enabled", () => {
    const config = loadConfig({ CODEX_DISABLE_PLUGINS: "false" }, "C:/repo", "linux");

    expect(config.codexDisablePlugins).toBe(false);
  });

  it("enables lightweight Codex exec flags by default for API-launched runs", () => {
    const config = loadConfig({}, "C:/repo", "linux");

    expect(config.codexBackend).toBe("exec");
    expect(config.codexIgnoreUserConfig).toBe(true);
    expect(config.codexEphemeral).toBe(true);
    expect(config.codexIgnoreRules).toBe(true);
    expect(config.codexDisableShellSnapshot).toBe(true);
    expect(config.codexReasoningEffort).toBe("medium");
  });

  it("allows lightweight Codex exec flags to be explicitly disabled", () => {
    const config = loadConfig(
      {
        CODEX_IGNORE_USER_CONFIG: "false",
        CODEX_EPHEMERAL: "false",
        CODEX_IGNORE_RULES: "false",
        CODEX_DISABLE_SHELL_SNAPSHOT: "false",
      },
      "C:/repo",
      "linux",
    );

    expect(config.codexIgnoreUserConfig).toBe(false);
    expect(config.codexEphemeral).toBe(false);
    expect(config.codexIgnoreRules).toBe(false);
    expect(config.codexDisableShellSnapshot).toBe(false);
  });

  it("disables call logging by default", () => {
    const config = loadConfig({}, "C:/repo", "linux");

    expect(config.callLoggingEnabled).toBe(false);
    expect(config.callLogDir).toBe(join("C:/repo", ".codexapi", "logs"));
  });

  it("parses the experimental app-server backend config", () => {
    const config = loadConfig(
      {
        CODEX_BACKEND: "app-server",
        CODEX_APP_SERVER_URL: "ws://127.0.0.1:3032",
        CODEX_APP_SERVER_PORT: "4567",
        CODEX_APP_SERVER_START_TIMEOUT_MS: "5000",
        CODEX_APP_SERVER_DISABLE_APPS: "false",
        CODEX_APP_SERVER_DISABLE_NODE_REPL_MCP: "false",
      },
      "C:/repo",
      "linux",
    );

    expect(config.codexBackend).toBe("app-server");
    expect(config.codexAppServerUrl).toBe("ws://127.0.0.1:3032");
    expect(config.codexAppServerPort).toBe(4567);
    expect(config.codexAppServerStartTimeoutMs).toBe(5000);
    expect(config.codexAppServerDisableApps).toBe(false);
    expect(config.codexAppServerDisableNodeReplMcp).toBe(false);
  });

  it("parses Codex reasoning effort config", () => {
    const config = loadConfig({ CODEX_REASONING_EFFORT: "low" }, "C:/repo", "linux");

    expect(config.codexReasoningEffort).toBe("low");
  });

  it("rejects unsupported Codex backend names", () => {
    expect(() => loadConfig({ CODEX_BACKEND: "sidecar" }, "C:/repo", "linux")).toThrow(
      "CODEX_BACKEND must be one of: exec, app-server.",
    );
  });

  it("rejects unsupported Codex reasoning effort values", () => {
    expect(() =>
      loadConfig({ CODEX_REASONING_EFFORT: "maximum" }, "C:/repo", "linux"),
    ).toThrow("CODEX_REASONING_EFFORT must be one of: minimal, low, medium, high, xhigh.");
  });
});
