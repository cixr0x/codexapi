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

function nativeCodexTarget(): {
  packageName: string;
  triple: string;
  suffix: string;
} {
  const key = `${process.platform}-${process.arch}`;
  const targets: Record<
    string,
    { packageName: string; triple: string; suffix: string }
  > = {
    "linux-x64": {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
      suffix: "linux-x64",
    },
    "linux-arm64": {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
      suffix: "linux-arm64",
    },
    "darwin-x64": {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin",
      suffix: "darwin-x64",
    },
    "darwin-arm64": {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
      suffix: "darwin-arm64",
    },
    "win32-x64": {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
      suffix: "win32-x64",
    },
    "win32-arm64": {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
      suffix: "win32-arm64",
    },
  };
  const target = targets[key];
  if (!target) {
    throw new Error(`Unsupported test platform: ${key}`);
  }
  return target;
}

describe("config", () => {
  it("resolves the exact pinned package-local platform-native Codex executable", () => {
    const resolved = defaultCodexCommand();
    const mainPackageRoot = dirname(
      realpathSync.native(
        createRequire(import.meta.url).resolve("@openai/codex/package.json"),
      ),
    );
    const target = nativeCodexTarget();
    const nativePackageRoot = dirname(
      realpathSync.native(
        createRequire(import.meta.url).resolve(`${target.packageName}/package.json`),
      ),
    );
    const expectedExecutable = realpathSync.native(
      join(
        nativePackageRoot,
        "vendor",
        target.triple,
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex",
      ),
    );

    expect(resolved.command).toBe(expectedExecutable);
    expect(isAbsolute(resolved.command)).toBe(true);
    expect(relative(nativePackageRoot, resolved.command)).not.toMatch(
      /^\.\.(?:[\\/]|$)/,
    );
    expect(resolved.args).toEqual([]);

    const mainPackageJson = JSON.parse(
      readFileSync(join(mainPackageRoot, "package.json"), "utf8"),
    ) as {
      version?: string;
      optionalDependencies?: Record<string, string>;
    };
    const nativePackageJson = JSON.parse(
      readFileSync(join(nativePackageRoot, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    expect(mainPackageJson.version).toBe("0.144.1");
    expect(mainPackageJson.optionalDependencies?.[target.packageName]).toBe(
      `npm:@openai/codex@0.144.1-${target.suffix}`,
    );
    expect(nativePackageJson).toMatchObject({
      name: "@openai/codex",
      version: `0.144.1-${target.suffix}`,
    });
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
