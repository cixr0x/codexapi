const CODE_MODE_DISABLED_WARNING = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
const UNSTABLE_FEATURES_WARNING = "Under-development features enabled: code_mode. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in /var/lib/codexapi/home/config.toml.";
const FILESYSTEM_DENY_GLOB_WARNINGS = new Set([":workspace_roots/**/.env", ":workspace_roots/**/.env.*"].map((pattern) => `Filesystem deny-read glob \`${pattern}\` uses \`**\`. Non-macOS sandboxing does not support unbounded \`**\` natively; set \`glob_scan_max_depth\` in this filesystem profile to cap Linux glob expansion and silence this warning, or enumerate explicit depths such as \`*.env\`, \`*/*.env\`, and \`*/*/*.env\`.`));

/** Shared exact pinned advisories and copy/order limits for success and failure. */
export class CodexStartupWarnings {
  private state: "none" | "unstable" | "unsupported" | "disabled" = "none";
  private readonly counts = new Map<string, number>();
  constructor(private readonly model?: string) {}
  accept(message: unknown): boolean {
    if (typeof message !== "string") return false;
    if (FILESYSTEM_DENY_GLOB_WARNINGS.has(message)) {
      const count = this.counts.get(message) ?? 0;
      if (count >= 2) return false;
      this.counts.set(message, count + 1);
      return true;
    }
    if (this.state === "none" && message === CODE_MODE_DISABLED_WARNING) { this.state = "disabled"; return true; }
    if (this.state === "none" && message === UNSTABLE_FEATURES_WARNING) { this.state = "unstable"; return true; }
    if ((this.state === "none" || this.state === "unstable") && this.model !== undefined && message === `Code Mode is enabled in configuration, but model \`${this.model}\` does not advertise Code Mode support. This may degrade model performance. Disable \`features.code_mode\` and \`features.code_mode_only\`, or select a model whose metadata enables Code Mode.`) {
      this.state = "unsupported";
      return true;
    }
    return false;
  }
}
