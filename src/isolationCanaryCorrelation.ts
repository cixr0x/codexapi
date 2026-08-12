import { createHash } from "node:crypto";

export const ISOLATION_CANARY_HEADER = "x-codexapi-isolation-canary-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isolationCanaryWorkspaceTag(value: string | undefined, remoteAddress: string | undefined): string | undefined {
  if ((remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") || !value || !UUID.test(value)) {
    return undefined;
  }
  return `canary-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
