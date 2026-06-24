import { describe, expect, it } from "vitest";

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
});
