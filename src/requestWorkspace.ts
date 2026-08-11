import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RequestWorkspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

export type RequestWorkspaceFactory = (
  basePath: string,
) => Promise<RequestWorkspace>;

export async function createRequestWorkspace(
  basePath: string,
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

  const path = await mkdtemp(join(canonicalBasePath, "codexapi-request-"));
  try {
    const canonicalRequestPath = await realpath(path);
    if (!isDescendant(canonicalBasePath, canonicalRequestPath)) {
      throw new Error("Codex request workspace must remain within its configured base.");
    }

    let cleaned = false;
    return {
      path: canonicalRequestPath,
      async cleanup(): Promise<void> {
        if (cleaned) {
          return;
        }
        cleaned = true;
        await rm(canonicalRequestPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
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
