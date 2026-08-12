import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RequestWorkspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

export type RequestWorkspaceFactory = (
  basePath: string,
  tag?: string,
) => Promise<RequestWorkspace>;

export async function createRequestWorkspace(
  basePath: string,
  tag?: string,
): Promise<RequestWorkspace> {
  const resolvedBasePath = resolve(basePath);
  const baseStat = await lstat(resolvedBasePath).catch(() => undefined);
  if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error("Codex request workspace base must be an existing non-symlink directory.");
  }

  const canonicalBasePath = await realpath(resolvedBasePath).catch(() => undefined);
  if (!canonicalBasePath || pathKey(canonicalBasePath) !== pathKey(resolvedBasePath)) {
    throw new Error("Codex request workspace base must not resolve through a symbolic link.");
  }

  const prefix = tag === undefined ? "codexapi-request-" : `codexapi-request-${validatedTag(tag)}-`;
  const path = await mkdtemp(join(canonicalBasePath, prefix));
  try {
    const canonicalRequestPath = await realpath(path);
    if (!isDescendant(canonicalBasePath, canonicalRequestPath)) {
      throw new Error("Codex request workspace must remain within its configured base.");
    }

    let cleaned = false;
    let cleanupInFlight: Promise<void> | undefined;
    return {
      path: canonicalRequestPath,
      cleanup(): Promise<void> {
        if (cleaned) {
          return Promise.resolve();
        }
        if (cleanupInFlight) {
          return cleanupInFlight;
        }

        cleanupInFlight = rm(canonicalRequestPath, { recursive: true, force: true }).then(
          () => {
            cleaned = true;
            cleanupInFlight = undefined;
          },
          (error: unknown) => {
            cleanupInFlight = undefined;
            throw error;
          },
        );
        return cleanupInFlight;
      },
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

function validatedTag(tag: string): string {
  if (!/^canary-[a-f0-9]{32}$/.test(tag)) {
    throw new Error("Codex request workspace tag is invalid.");
  }
  return tag;
}

function isDescendant(basePath: string, candidatePath: string): boolean {
  const relation = relative(basePath, candidatePath);
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
