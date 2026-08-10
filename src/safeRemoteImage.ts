import { promises as dnsPromises, type LookupAddress } from "node:dns";
import {
  mkdtemp as nodeMkdtemp,
  open as nodeOpen,
  rename as nodeRename,
  rm as nodeRm,
} from "node:fs/promises";
import {
  request as nodeHttpRequest,
  type IncomingHttpHeaders,
  type RequestOptions as HttpRequestOptions,
} from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { tmpdir as nodeTmpdir } from "node:os";
import { join } from "node:path";

export type SafeImageReason =
  | "invalid_url"
  | "credentials"
  | "unsupported_scheme"
  | "unsupported_port"
  | "dns_failed"
  | "non_public_address"
  | "redirect_limit"
  | "redirect_invalid"
  | "timeout"
  | "http_status"
  | "too_large"
  | "unsupported_type"
  | "invalid_magic"
  | "fetch_failed";

export interface PreparedRemoteImage {
  path: string | null;
  reason: SafeImageReason | null;
  cleanup(): Promise<void>;
}

export class SafeImageCleanupError extends Error {
  readonly code = "image_cleanup_failed" as const;

  constructor() {
    super("Temporary image cleanup failed.");
    this.name = "SafeImageCleanupError";
  }
}

export type SafeImageLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface SafeImageTransportRequestOptions {
  hostname: string;
  port: number;
  path: string;
  method: "GET";
  headers: Readonly<Record<"Host" | "Accept", string>>;
  lookup: LookupFunction;
  servername?: string;
  signal: AbortSignal;
}

export interface SafeImageTransportResponse {
  statusCode: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(error?: Error): void;
}

export type SafeImageTransport = (
  protocol: "http:" | "https:",
  options: SafeImageTransportRequestOptions,
) => Promise<SafeImageTransportResponse>;

interface SafeImageFileHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

export interface SafeRemoteImageDependencies {
  lookup?: SafeImageLookup;
  request?: SafeImageTransport;
  tmpdir?: () => string;
  mkdtemp?: (prefix: string) => Promise<string>;
  open?: (path: string, flags: "wx", mode: number) => Promise<SafeImageFileHandle>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  rm?: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  signal?: AbortSignal;
}

interface ResolvedDependencies {
  lookup: SafeImageLookup;
  request: SafeImageTransport;
  tmpdir: () => string;
  mkdtemp: (prefix: string) => Promise<string>;
  open: (path: string, flags: "wx", mode: number) => Promise<SafeImageFileHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  signal?: AbortSignal;
}

interface AbortState {
  controller: AbortController;
  timedOut: boolean;
}

interface VerifiedAddress {
  address: string;
  family: 4 | 6;
}

interface VerifiedImageType {
  mime: "image/jpeg" | "image/png" | "image/webp";
  extension: ".jpg" | ".png" | ".webp";
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_CLEANUP_ATTEMPTS = 3;
const ACCEPT_HEADER = "image/jpeg, image/png, image/webp";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const NON_PUBLIC_ADDRESSES = createNonPublicBlockLists();
const ALLOCATED_GLOBAL_IPV6 = createAllocatedGlobalIpv6BlockList();

class SafeImageError extends Error {
  constructor(readonly reason: SafeImageReason) {
    super(reason);
    this.name = "SafeImageError";
  }
}

export async function prepareRemoteImage(
  input: string,
  dependencies: SafeRemoteImageDependencies = {},
): Promise<PreparedRemoteImage> {
  const runtime = resolveDependencies(dependencies);
  let initialUrl: URL;

  try {
    initialUrl = parseAndValidateUrl(input);
  } catch (error) {
    return failedPreparedImage(reasonFor(error));
  }

  const abortState: AbortState = {
    controller: new AbortController(),
    timedOut: false,
  };
  const onCallerAbort = () => abortState.controller.abort();
  if (runtime.signal?.aborted) {
    onCallerAbort();
  } else {
    runtime.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeoutHandle = runtime.setTimeout(() => {
    abortState.timedOut = true;
    abortState.controller.abort();
  }, FETCH_TIMEOUT_MS);

  let activeResponse: SafeImageTransportResponse | undefined;
  let fileHandle: SafeImageFileHandle | undefined;
  let temporaryDirectory: string | undefined;

  try {
    throwIfAborted(abortState);
    activeResponse = await fetchFollowingRedirects(initialUrl, runtime, abortState);
    throwIfAborted(abortState);

    const expectedType = parseContentType(activeResponse.headers["content-type"]);
    rejectDeclaredOversize(activeResponse.headers["content-length"]);

    temporaryDirectory = await runtime.mkdtemp(
      join(runtime.tmpdir(), "codexapi-image-"),
    );
    throwIfAborted(abortState);

    const stagingPath = join(temporaryDirectory, "image.download");
    fileHandle = await runtime.open(stagingPath, "wx", 0o600);
    throwIfAborted(abortState);

    const prefixChunks: Uint8Array[] = [];
    let prefixLength = 0;
    let totalBytes = 0;
    const iterator = activeResponse.body[Symbol.asyncIterator]();

    while (true) {
      const next = await withAbort(iterator.next(), abortState);
      if (next.done) {
        break;
      }

      const chunk = asBytes(next.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_IMAGE_BYTES) {
        throw new SafeImageError("too_large");
      }

      if (prefixLength < 12) {
        const prefixChunk = chunk.subarray(0, 12 - prefixLength);
        prefixChunks.push(prefixChunk);
        prefixLength += prefixChunk.byteLength;
      }

      await writeAll(fileHandle, chunk);
      throwIfAborted(abortState);
    }

    await fileHandle.close();
    fileHandle = undefined;

    const verifiedType = detectImageType(concatenate(prefixChunks, prefixLength));
    if (!verifiedType || verifiedType.mime !== expectedType.mime) {
      throw new SafeImageError("invalid_magic");
    }

    const finalPath = join(temporaryDirectory, `image${verifiedType.extension}`);
    await runtime.rename(stagingPath, finalPath);
    throwIfAborted(abortState);

    activeResponse = undefined;
    const cleanup = createCleanup(temporaryDirectory, runtime.rm);
    temporaryDirectory = undefined;
    return { path: finalPath, reason: null, cleanup };
  } catch (error) {
    activeResponse?.destroy();
    await closeFile(fileHandle);
    let cleanup: () => Promise<void> = async () => undefined;
    if (temporaryDirectory) {
      cleanup = createCleanup(temporaryDirectory, runtime.rm);
      try {
        await cleanup();
      } catch {
        // The bounded reason remains the fetch result; the returned cleanup stays retryable.
      }
    }
    return failedPreparedImage(reasonFor(error, abortState), cleanup);
  } finally {
    runtime.clearTimeout(timeoutHandle);
    runtime.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export function emptyPreparedRemoteImage(): PreparedRemoteImage {
  return {
    path: null,
    reason: null,
    async cleanup() {},
  };
}

async function fetchFollowingRedirects(
  initialUrl: URL,
  runtime: ResolvedDependencies,
  abortState: AbortState,
): Promise<SafeImageTransportResponse> {
  let currentUrl = initialUrl;
  let redirectCount = 0;

  while (true) {
    throwIfAborted(abortState);
    const address = await resolvePublicAddress(currentUrl, runtime.lookup, abortState);
    const response = await withAbort(
      runtime.request(currentUrl.protocol as "http:" | "https:", {
        hostname: normalizedHostname(currentUrl),
        port: effectivePort(currentUrl),
        path: `${currentUrl.pathname}${currentUrl.search}`,
        method: "GET",
        headers: {
          Host: currentUrl.host,
          Accept: ACCEPT_HEADER,
        },
        lookup: createPinnedLookup(address),
        ...(isIP(normalizedHostname(currentUrl)) === 0
          ? { servername: normalizedHostname(currentUrl) }
          : {}),
        signal: abortState.controller.signal,
      }),
      abortState,
    );

    if (!REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        throw new SafeImageError("http_status");
      }
      return response;
    }

    response.destroy();
    if (redirectCount >= MAX_REDIRECTS) {
      throw new SafeImageError("redirect_limit");
    }

    const location = singleHeader(response.headers.location);
    if (!location || location.trim() === "") {
      throw new SafeImageError("redirect_invalid");
    }

    try {
      currentUrl = parseAndValidateUrl(new URL(location, currentUrl).href);
    } catch (error) {
      if (error instanceof SafeImageError) {
        throw error;
      }
      throw new SafeImageError("redirect_invalid");
    }
    redirectCount += 1;
  }
}

async function resolvePublicAddress(
  url: URL,
  lookup: SafeImageLookup,
  abortState: AbortState,
): Promise<VerifiedAddress> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicAddress(hostname, literalFamily)) {
      throw new SafeImageError("non_public_address");
    }
    return { address: hostname, family: literalFamily };
  }

  let answers: Array<{ address: string; family: 4 | 6 }>;
  try {
    answers = await withAbort(
      lookup(hostname, { all: true, verbatim: true }),
      abortState,
    );
  } catch (error) {
    if (error instanceof SafeImageError) {
      throw error;
    }
    throw new SafeImageError("dns_failed");
  }

  if (answers.length === 0) {
    throw new SafeImageError("dns_failed");
  }

  const verified: VerifiedAddress[] = answers.map((answer) => {
    if (!isPublicAddress(answer.address, answer.family)) {
      throw new SafeImageError("non_public_address");
    }
    return answer;
  });

  return verified[0]!;
}

function parseAndValidateUrl(input: string): URL {
  if (typeof input !== "string") {
    throw new SafeImageError("invalid_url");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeImageError("invalid_url");
  }

  if (url.username !== "" || url.password !== "") {
    throw new SafeImageError("credentials");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeImageError("unsupported_scheme");
  }
  if (normalizedHostname(url) === "") {
    throw new SafeImageError("invalid_url");
  }

  const port = effectivePort(url);
  if (port !== 80 && port !== 443) {
    throw new SafeImageError("unsupported_port");
  }

  return url;
}

function effectivePort(url: URL): number {
  if (url.port !== "") {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function isPublicAddress(address: string, declaredFamily: 4 | 6): boolean {
  if (address.includes("%")) {
    return false;
  }

  const actualFamily = isIP(address);
  if (actualFamily !== declaredFamily) {
    return false;
  }

  try {
    if (
      declaredFamily === 6 &&
      !ALLOCATED_GLOBAL_IPV6.check(address, "ipv6")
    ) {
      return false;
    }
    const blockList =
      declaredFamily === 4 ? NON_PUBLIC_ADDRESSES.ipv4 : NON_PUBLIC_ADDRESSES.ipv6;
    return !blockList.check(
      address,
      declaredFamily === 4 ? "ipv4" : "ipv6",
    );
  } catch {
    return false;
  }
}

function createPinnedLookup(address: VerifiedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function parseContentType(value: string | string[] | undefined): VerifiedImageType {
  const raw = singleHeader(value);
  const mime = raw?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/jpeg") {
    return { mime, extension: ".jpg" };
  }
  if (mime === "image/png") {
    return { mime, extension: ".png" };
  }
  if (mime === "image/webp") {
    return { mime, extension: ".webp" };
  }
  throw new SafeImageError("unsupported_type");
}

function rejectDeclaredOversize(value: string | string[] | undefined): void {
  const raw = singleHeader(value);
  if (!raw || !/^\d+$/.test(raw.trim())) {
    return;
  }
  if (BigInt(raw.trim()) > BigInt(MAX_IMAGE_BYTES)) {
    throw new SafeImageError("too_large");
  }
}

function detectImageType(prefix: Uint8Array): VerifiedImageType | null {
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", extension: ".jpg" };
  }
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: ".png" };
  }
  if (
    prefix.byteLength >= 12 &&
    String.fromCharCode(...prefix.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...prefix.subarray(8, 12)) === "WEBP"
  ) {
    return { mime: "image/webp", extension: ".webp" };
  }
  return null;
}

function startsWith(value: Uint8Array, prefix: number[]): boolean {
  return (
    value.byteLength >= prefix.length &&
    prefix.every((byte, index) => value[index] === byte)
  );
}

function concatenate(chunks: Uint8Array[], length: number): Uint8Array {
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function asBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new SafeImageError("fetch_failed");
  }
  return value;
}

async function writeAll(handle: SafeImageFileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new SafeImageError("fetch_failed");
    }
    offset += bytesWritten;
  }
}

async function closeFile(handle: SafeImageFileHandle | undefined): Promise<void> {
  if (!handle) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // The enclosing fetch result remains bounded and cleanup still removes the directory.
  }
}

function createCleanup(
  directory: string,
  rm: ResolvedDependencies["rm"],
): () => Promise<void> {
  let cleaned = false;
  let activeCleanup: Promise<void> | undefined;

  return async () => {
    if (cleaned) {
      return;
    }
    activeCleanup ??= removeTemporaryDirectory(directory, rm);
    const currentCleanup = activeCleanup;
    try {
      await currentCleanup;
      cleaned = true;
    } finally {
      if (activeCleanup === currentCleanup) {
        activeCleanup = undefined;
      }
    }
  };
}

async function removeTemporaryDirectory(
  directory: string,
  rm: ResolvedDependencies["rm"],
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      // Retry a bounded number of times; callers can retry the idempotent cleanup later.
    }
  }
  throw new SafeImageCleanupError();
}

function failedPreparedImage(
  reason: SafeImageReason,
  cleanup: () => Promise<void> = async () => undefined,
): PreparedRemoteImage {
  return {
    path: null,
    reason,
    cleanup,
  };
}

function reasonFor(error: unknown, abortState?: AbortState): SafeImageReason {
  if (abortState?.timedOut) {
    return "timeout";
  }
  return error instanceof SafeImageError ? error.reason : "fetch_failed";
}

function throwIfAborted(abortState: AbortState): void {
  if (abortState.controller.signal.aborted) {
    throw new SafeImageError(abortState.timedOut ? "timeout" : "fetch_failed");
  }
}

async function withAbort<T>(promise: Promise<T>, abortState: AbortState): Promise<T> {
  throwIfAborted(abortState);
  const signal = abortState.controller.signal;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SafeImageError(abortState.timedOut ? "timeout" : "fetch_failed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveDependencies(
  dependencies: SafeRemoteImageDependencies,
): ResolvedDependencies {
  return {
    lookup:
      dependencies.lookup ??
      (async (hostname) =>
        (await dnsPromises.lookup(hostname, {
          all: true,
          verbatim: true,
        })) as Array<LookupAddress & { family: 4 | 6 }>),
    request: dependencies.request ?? nativeTransport,
    tmpdir: dependencies.tmpdir ?? nodeTmpdir,
    mkdtemp: dependencies.mkdtemp ?? nodeMkdtemp,
    open:
      dependencies.open ??
      (async (path, flags, mode) => {
        const handle = await nodeOpen(path, flags, mode);
        return {
          async write(buffer, offset, length, position) {
            const result = await handle.write(buffer, offset, length, position);
            return { bytesWritten: result.bytesWritten };
          },
          close: () => handle.close(),
        };
      }),
    rename: dependencies.rename ?? nodeRename,
    rm: dependencies.rm ?? nodeRm,
    setTimeout:
      dependencies.setTimeout ??
      ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds)),
    clearTimeout:
      dependencies.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)),
    signal: dependencies.signal,
  };
}

function nativeTransport(
  protocol: "http:" | "https:",
  options: SafeImageTransportRequestOptions,
): Promise<SafeImageTransportResponse> {
  return new Promise((resolve, reject) => {
    const requestOptions: HttpRequestOptions = {
      protocol,
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: options.headers,
      lookup: options.lookup,
      signal: options.signal,
      agent: false,
      ...(options.servername === undefined ? {} : { servername: options.servername }),
    };
    const request = protocol === "https:" ? nodeHttpsRequest : nodeHttpRequest;
    const outgoing = request(requestOptions, (incoming) => {
      resolve({
        statusCode: incoming.statusCode,
        headers: incoming.headers as IncomingHttpHeaders,
        body: incoming,
        destroy(error?: Error) {
          incoming.destroy(error);
        },
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function createNonPublicBlockLists(): { ipv4: BlockList; ipv6: BlockList } {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  const ipv4Subnets: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.31.196.0", 24],
    ["192.52.193.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["192.175.48.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ];
  const ipv6Subnets: Array<[string, number]> = [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["::ffff:0:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["2620:4f:8000::", 48],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];

  for (const [network, prefix] of ipv4Subnets) {
    ipv4.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of ipv6Subnets) {
    ipv6.addSubnet(network, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function createAllocatedGlobalIpv6BlockList(): BlockList {
  const blockList = new BlockList();
  blockList.addSubnet("2000::", 3, "ipv6");
  return blockList;
}
