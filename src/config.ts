export interface AppConfig {
  host: string;
  port: number;
  codexWorkspace: string;
  codexCommand: string;
  codexProfile: string;
  codexTimeoutMs: number;
  openAICompatModel: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AppConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: parseInteger(env.PORT, 3000, "PORT"),
    codexWorkspace: env.CODEX_WORKSPACE ?? cwd,
    codexCommand: env.CODEX_COMMAND ?? "codex",
    codexProfile: env.CODEX_PROFILE ?? "plain",
    codexTimeoutMs: parseInteger(env.CODEX_TIMEOUT_MS, 120000, "CODEX_TIMEOUT_MS"),
    openAICompatModel: env.OPENAI_COMPAT_MODEL ?? "local-codex",
  };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}
