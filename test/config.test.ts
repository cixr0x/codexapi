import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { defaultCodexCommand, loadConfig } from "../src/config.js";

const SAFE_WORKSPACE = mkdtempSync(join(tmpdir(), "codexapi-config-test-"));
const SAFE_CODEX_HOME = mkdtempSync(join(tmpdir(), "codexapi-home-test-"));

afterAll(() => {
  rmSync(SAFE_WORKSPACE, { recursive: true, force: true });
  rmSync(SAFE_CODEX_HOME, { recursive: true, force: true });
});

function loadTestConfig(
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
) {
  return loadConfig(
    { CODEX_WORKSPACE: SAFE_WORKSPACE, CODEX_HOME: SAFE_CODEX_HOME, ...env },
    cwd,
    platform,
  );
}

describe("config", () => {
  it("resolves the exact pinned local Codex package under absolute Node", () => {
    const resolved = defaultCodexCommand();
    const expectedPackageRoot = dirname(
      realpathSync.native(
        createRequire(import.meta.url).resolve("@openai/codex/package.json"),
      ),
    );

    expect(resolved.command).toBe(realpathSync.native(process.execPath));
    expect(isAbsolute(resolved.command)).toBe(true);
    expect(resolved.args).toHaveLength(1);

    const scriptPath = resolved.args[0];
    expect(isAbsolute(scriptPath)).toBe(true);
    const packageRoot = dirname(dirname(scriptPath));
    expect(packageRoot).toBe(expectedPackageRoot);
    expect(relative(packageRoot, scriptPath)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(scriptPath).toBe(join(packageRoot, "bin", "codex.js"));
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    expect(packageJson.version).toBe("0.144.1");
  });

  it("ignores Windows APPDATA and executable wrapper inputs", () => {
    const expected = defaultCodexCommand();
    vi.stubEnv("APPDATA", "C:\\attacker");
    vi.stubEnv("PATH", "C:\\attacker");

    try {
      expect(defaultCodexCommand()).toEqual(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not expose environment-controlled Codex executable configuration", () => {
    const config = loadTestConfig(
      {
        CODEX_COMMAND: "node",
        CODEX_COMMAND_ARGS: "C:\\codex\\codex.js;--experimental-flag",
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      },
      "C:/repo",
      "win32",
    );

    expect(config).not.toHaveProperty("codexCommand");
    expect(config).not.toHaveProperty("codexCommandArgs");
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

  it("requires an explicit dedicated Codex home", () => {
    expect(() =>
      loadConfig({ CODEX_WORKSPACE: SAFE_WORKSPACE }, process.cwd(), process.platform),
    ).toThrow("CODEX_HOME must be an absolute path.");
  });

  it("retains only the validated dedicated Codex home path", () => {
    expect(loadTestConfig().codexHome).toBe(SAFE_CODEX_HOME);
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
    ).toThrow(
      "CODEX_WORKSPACE must be outside source and current working directories.",
    );
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
