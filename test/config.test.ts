import { describe, expect, it } from "vitest";

import { defaultCodexCommand, loadConfig } from "../src/config.js";

describe("config", () => {
  it("uses codex.exe as the default command on Windows", () => {
    expect(defaultCodexCommand("win32")).toBe("codex.exe");
  });

  it("uses codex as the default command on non-Windows platforms", () => {
    expect(defaultCodexCommand("linux")).toBe("codex");
  });

  it("lets CODEX_COMMAND override the platform default", () => {
    const config = loadConfig({ CODEX_COMMAND: "custom-codex" }, "C:/repo", "win32");

    expect(config.codexCommand).toBe("custom-codex");
  });
});
