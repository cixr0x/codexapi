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

  it("disables call logging by default", () => {
    const config = loadConfig({}, "C:/repo", "linux");

    expect(config.callLoggingEnabled).toBe(false);
    expect(config.callLogDir).toBe(join("C:/repo", ".codexapi", "logs"));
  });
});
