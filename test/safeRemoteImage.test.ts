import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareRemoteImage,
  type SafeImageLookup,
  type SafeImageReason,
  type SafeImageTransport,
  type SafeImageTransportResponse,
} from "../src/safeRemoteImage.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const WEBP = Buffer.from("RIFF\x04\x00\x00\x00WEBPdata", "binary");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PUBLIC_V4 = "93.184.216.34";

let tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codexapi-safe-image-test-"));
  tempRoots.push(root);
  return root;
}

function response({
  statusCode = 200,
  headers = { "content-type": "image/jpeg" },
  chunks = [JPEG],
  body,
}: {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
  chunks?: Uint8Array[];
  body?: AsyncIterable<Uint8Array>;
} = {}): SafeImageTransportResponse {
  return {
    statusCode,
    headers,
    body: body ?? chunksBody(chunks),
    destroy: vi.fn(),
  };
}

async function* chunksBody(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function dependencies({
  answers = [{ address: PUBLIC_V4, family: 4 as const }],
  responses = [response()],
  lookupError,
  request,
  root,
}: {
  answers?: Array<{ address: string; family: 4 | 6 }>;
  responses?: SafeImageTransportResponse[];
  lookupError?: Error;
  request?: SafeImageTransport;
  root?: string;
} = {}) {
  const tempRoot = root ?? (await createTempRoot());
  const lookup = vi.fn<SafeImageLookup>(async () => {
    if (lookupError) {
      throw lookupError;
    }
    return answers;
  });
  const queuedResponses = [...responses];
  const transport =
    request ??
    vi.fn<SafeImageTransport>(async () => {
      const next = queuedResponses.shift();
      if (!next) {
        throw new Error("Unexpected transport request");
      }
      return next;
    });

  return {
    lookup,
    request: transport,
    tempRoot,
    dependencies: {
      lookup,
      request: transport,
      tmpdir: () => tempRoot,
    },
  };
}

describe("prepareRemoteImage destination validation", () => {
  it("rejects URL credentials before DNS or transport", async () => {
    const setup = await dependencies();

    const prepared = await prepareRemoteImage(
      "https://caller:secret@images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "credentials" });
    expect(setup.lookup).not.toHaveBeenCalled();
    expect(setup.request).not.toHaveBeenCalled();
  });

  it.each([
    ["a file URL", "file:///etc/passwd", "unsupported_scheme"],
    ["an FTP URL", "ftp://images.example.test/cover.jpg", "unsupported_scheme"],
    ["a malformed URL", "not a remote URL", "invalid_url"],
    ["an HTTP alternate port", "http://images.example.test:3001/cover.jpg", "unsupported_port"],
    ["an HTTPS alternate port", "https://images.example.test:8443/cover.jpg", "unsupported_port"],
  ] as const)("rejects %s before DNS", async (_name, url, reason) => {
    const setup = await dependencies();

    const prepared = await prepareRemoteImage(url, setup.dependencies);

    expect(prepared).toMatchObject({ path: null, reason });
    expect(setup.lookup).not.toHaveBeenCalled();
    expect(setup.request).not.toHaveBeenCalled();
  });

  it.each([
    ["IPv4 unspecified", "0.0.0.0"],
    ["IPv4 current network", "0.1.2.3"],
    ["IPv4 private 10/8", "10.4.3.2"],
    ["IPv4 shared address space", "100.64.0.1"],
    ["IPv4 loopback", "127.0.0.1"],
    ["cloud metadata/link-local", "169.254.169.254"],
    ["IPv4 private 172.16/12", "172.31.255.254"],
    ["IPv4 protocol assignments", "192.0.0.8"],
    ["IPv4 documentation", "192.0.2.1"],
    ["IPv4 private 192.168/16", "192.168.1.1"],
    ["IPv4 benchmarking", "198.18.0.1"],
    ["IPv4 documentation 198.51.100/24", "198.51.100.1"],
    ["IPv4 documentation 203.0.113/24", "203.0.113.1"],
    ["IPv4 multicast", "239.1.2.3"],
    ["IPv4 reserved", "240.0.0.1"],
    ["IPv4 limited broadcast", "255.255.255.255"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv4-mapped IPv6", "::ffff:127.0.0.1"],
    ["IPv4-translatable IPv6", "::ffff:0:127.0.0.1"],
    ["IPv6 discard-only", "100::1"],
    ["IPv6 protocol assignments", "2001::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["IPv6 6to4", "2002:c0a8:101::"],
    ["IPv6 documentation 3fff::/20", "3fff::1"],
    ["IPv6 outside allocated global unicast", "4000::1"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 deprecated site-local", "fec0::1"],
    ["IPv6 multicast", "ff02::1"],
  ])("rejects %s DNS answers", async (_name, address) => {
    const family = address.includes(":") ? (6 as const) : (4 as const);
    const setup = await dependencies({ answers: [{ address, family }] });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "non_public_address" });
    expect(setup.request).not.toHaveBeenCalled();
  });

  it("rejects all DNS answers when one answer is non-public", async () => {
    const setup = await dependencies({
      answers: [
        { address: PUBLIC_V4, family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "non_public_address" });
    expect(setup.request).not.toHaveBeenCalled();
  });

  it("classifies a numeric URL host directly instead of trusting injected DNS", async () => {
    const setup = await dependencies({
      answers: [{ address: PUBLIC_V4, family: 4 }],
    });

    const prepared = await prepareRemoteImage(
      "http://127.0.0.1/private-cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "non_public_address" });
    expect(setup.lookup).not.toHaveBeenCalled();
    expect(setup.request).not.toHaveBeenCalled();
  });

  it("accepts a public IPv6 DNS answer", async () => {
    const setup = await dependencies({
      answers: [{ address: "2606:4700:4700::1111", family: 6 }],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared.reason).toBeNull();
    expect(prepared.path).toMatch(/\.jpg$/);
    await prepared.cleanup();
  });

  it("maps DNS failures and empty answers to dns_failed", async () => {
    const failed = await dependencies({ lookupError: new Error("resolver unavailable") });
    const empty = await dependencies({ answers: [] });

    await expect(
      prepareRemoteImage("https://images.example.test/a.jpg", failed.dependencies),
    ).resolves.toMatchObject({ path: null, reason: "dns_failed" });
    await expect(
      prepareRemoteImage("https://images.example.test/b.jpg", empty.dependencies),
    ).resolves.toMatchObject({ path: null, reason: "dns_failed" });
  });

  it("re-resolves and revalidates every redirect target", async () => {
    const root = await createTempRoot();
    const lookup = vi.fn<SafeImageLookup>(async (hostname) => {
      if (hostname === "first.example.test") {
        return [{ address: PUBLIC_V4, family: 4 }];
      }
      return [{ address: "2606:4700:4700::1111", family: 6 }];
    });
    const redirects = [
      response({ statusCode: 302, headers: { location: "https://second.example.test/final.png" } }),
      response({ headers: { "content-type": "image/png" }, chunks: [PNG] }),
    ];
    const request = vi.fn<SafeImageTransport>(async () => redirects.shift()!);

    const prepared = await prepareRemoteImage("https://first.example.test/start", {
      lookup,
      request,
      tmpdir: () => root,
    });

    expect(prepared.reason).toBeNull();
    expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual([
      "first.example.test",
      "second.example.test",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    await prepared.cleanup();
  });

  it("rejects a redirect whose freshly resolved target has any private answer", async () => {
    const root = await createTempRoot();
    const lookup = vi.fn<SafeImageLookup>(async (hostname) =>
      hostname === "first.example.test"
        ? [{ address: PUBLIC_V4, family: 4 }]
        : [
            { address: PUBLIC_V4, family: 4 },
            { address: "127.0.0.1", family: 4 },
          ],
    );
    const redirect = response({
      statusCode: 302,
      headers: { location: "https://second.example.test/private.jpg" },
    });
    const request = vi.fn<SafeImageTransport>(async () => redirect);

    const prepared = await prepareRemoteImage("https://first.example.test/start", {
      lookup,
      request,
      tmpdir: () => root,
    });

    expect(prepared).toMatchObject({ path: null, reason: "non_public_address" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(redirect.destroy).toHaveBeenCalledOnce();
  });

  it("allows three redirects and rejects a fourth without resolving its target", async () => {
    const redirects = [1, 2, 3, 4].map((number) =>
      response({
        statusCode: 302,
        headers: { location: `https://redirect-${number}.example.test/cover.jpg` },
      }),
    );
    const setup = await dependencies({ responses: redirects });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "redirect_limit" });
    expect(setup.lookup).toHaveBeenCalledTimes(4);
    expect(setup.request).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["a missing Location", undefined],
    ["a malformed Location", "http://[not-an-ipv6-address"],
  ])("rejects a redirect with %s", async (_name, location) => {
    const setup = await dependencies({
      responses: [response({ statusCode: 302, headers: { location } })],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "redirect_invalid" });
    expect(setup.request).toHaveBeenCalledOnce();
  });

  it("pins the prevalidated address while preserving Host and TLS SNI", async () => {
    const root = await createTempRoot();
    const lookup = vi.fn<SafeImageLookup>(async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
    const request = vi.fn<SafeImageTransport>(async (protocol, options) => {
      expect(protocol).toBe("https:");
      expect(options).toMatchObject({
        hostname: "images.example.test",
        port: 443,
        path: "/cover.jpg?size=large",
        method: "GET",
        servername: "images.example.test",
        headers: {
          Host: "images.example.test",
          Accept: "image/jpeg, image/png, image/webp",
        },
      });
      expect(Object.keys(options.headers).sort()).toEqual(["Accept", "Host"]);

      const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        options.lookup("rebound.internal", { all: false }, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address: address as string, family: family! });
        });
      });
      expect(pinned).toEqual({ address: PUBLIC_V4, family: 4 });
      return response();
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg?size=large#ignored",
      { lookup, request, tmpdir: () => root },
    );

    expect(prepared.reason).toBeNull();
    await prepared.cleanup();
  });
});

describe("prepareRemoteImage byte validation and cleanup", () => {
  it.each([
    ["JPEG", "image/jpeg", JPEG, ".jpg"],
    ["PNG", "image/png", PNG, ".png"],
    ["WebP", "image/webp", WEBP, ".webp"],
  ])("streams a verified %s to a type-derived extension", async (_name, mime, bytes, extension) => {
    const setup = await dependencies({
      responses: [
        response({
          headers: {
            "content-type": `${mime}; charset=binary`,
            "content-length": String(bytes.byteLength),
          },
          chunks: [bytes.subarray(0, 2), bytes.subarray(2)],
        }),
      ],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover",
      setup.dependencies,
    );

    expect(prepared.reason).toBeNull();
    expect(prepared.path).toMatch(new RegExp(`\\${extension}$`));
    await expect(readFile(prepared.path!)).resolves.toEqual(bytes);

    await prepared.cleanup();
    await prepared.cleanup();
    await expect(readFile(prepared.path!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("rejects a MIME and magic-byte mismatch", async () => {
    const setup = await dependencies({
      responses: [response({ headers: { "content-type": "image/png" }, chunks: [JPEG] })],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "invalid_magic" });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("rejects an unsupported MIME type before creating a temporary directory", async () => {
    const setup = await dependencies({
      responses: [response({ headers: { "content-type": "image/svg+xml" } })],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.svg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "unsupported_type" });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("rejects invalid magic bytes for an accepted MIME type", async () => {
    const setup = await dependencies({
      responses: [
        response({
          headers: { "content-type": "image/webp" },
          chunks: [Buffer.from("not really an image")],
        }),
      ],
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.webp",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "invalid_magic" });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("fails closed and cleans up when the completed image cannot be closed", async () => {
    const setup = await dependencies();

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      {
        ...setup.dependencies,
        async open(path, flags, mode) {
          const handle = await open(path, flags, mode);
          return {
            async write(buffer, offset, length, position) {
              const result = await handle.write(buffer, offset, length, position);
              return { bytesWritten: result.bytesWritten };
            },
            async close() {
              await handle.close();
              throw new Error("simulated close failure");
            },
          };
        },
      },
    );

    expect(prepared).toMatchObject({ path: null, reason: "fetch_failed" });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("rejects a declared response larger than 8 MiB", async () => {
    const oversized = response({
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(MAX_IMAGE_BYTES + 1),
      },
    });
    const setup = await dependencies({ responses: [oversized] });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "too_large" });
    expect(oversized.destroy).toHaveBeenCalledOnce();
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("stops a streamed response as soon as it exceeds 8 MiB", async () => {
    const oversized = response({ chunks: [Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff)] });
    const setup = await dependencies({ responses: [oversized] });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "too_large" });
    expect(oversized.destroy).toHaveBeenCalledOnce();
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("aborts transport at exactly 10 seconds and returns timeout", async () => {
    let timeoutCallback: (() => void) | undefined;
    const clearTimeout = vi.fn();
    const request = vi.fn<SafeImageTransport>(async (_protocol, options) =>
      new Promise<SafeImageTransportResponse>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
    );
    const setup = await dependencies({ request });

    const preparedPromise = prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      {
        ...setup.dependencies,
        setTimeout(callback, milliseconds) {
          expect(milliseconds).toBe(10_000);
          timeoutCallback = callback;
          return "timeout-handle";
        },
        clearTimeout,
      },
    );
    for (let index = 0; index < 10 && !timeoutCallback; index += 1) {
      await Promise.resolve();
    }
    expect(timeoutCallback).toBeTypeOf("function");
    timeoutCallback!();

    await expect(preparedPromise).resolves.toMatchObject({ path: null, reason: "timeout" });
    expect(clearTimeout).toHaveBeenCalledWith("timeout-handle");
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("returns http_status for a non-2xx response", async () => {
    const notFound = response({ statusCode: 404 });
    const setup = await dependencies({ responses: [notFound] });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/missing.jpg",
      setup.dependencies,
    );

    expect(prepared).toMatchObject({ path: null, reason: "http_status" });
    expect(notFound.destroy).toHaveBeenCalledOnce();
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("maps an unexpected transport error to fetch_failed without throwing", async () => {
    const request = vi.fn<SafeImageTransport>(async () => {
      throw new Error("socket reset with sensitive destination details");
    });
    const setup = await dependencies({ request });

    await expect(
      prepareRemoteImage("https://images.example.test/cover.jpg", setup.dependencies),
    ).resolves.toMatchObject({ path: null, reason: "fetch_failed" });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("cleans a partial temporary file when the caller cancels", async () => {
    const controller = new AbortController();
    let bodyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const request = vi.fn<SafeImageTransport>(async (_protocol, options) =>
      response({
        body: {
          async *[Symbol.asyncIterator]() {
            yield JPEG;
            bodyStarted!();
            await new Promise<void>((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
                { once: true },
              );
            });
          },
        },
      }),
    );
    const setup = await dependencies({ request });

    const preparedPromise = prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      { ...setup.dependencies, signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(preparedPromise).resolves.toMatchObject({
      path: null,
      reason: "fetch_failed",
    });
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("retains a retryable cleanup after bounded failure-path deletion attempts", async () => {
    const setup = await dependencies({
      responses: [
        response({
          headers: { "content-type": "image/jpeg" },
          chunks: [Buffer.from("not an image")],
        }),
      ],
    });
    let removalAttempts = 0;
    const remove = vi.fn(async (
      path: string,
      options: { recursive: true; force: true },
    ) => {
      removalAttempts += 1;
      if (removalAttempts <= 3) {
        throw Object.assign(new Error("transient sharing violation"), {
          code: "EPERM",
        });
      }
      await rm(path, options);
    });

    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      { ...setup.dependencies, rm: remove },
    );

    expect(prepared).toMatchObject({ path: null, reason: "invalid_magic" });
    expect(remove).toHaveBeenCalledTimes(3);
    expect(await readdir(setup.tempRoot)).toHaveLength(1);

    await prepared.cleanup();
    await prepared.cleanup();

    expect(remove).toHaveBeenCalledTimes(4);
    expect(await readdir(setup.tempRoot)).toEqual([]);
  });

  it("signals a bounded cleanup failure when a verified image cannot be removed", async () => {
    const setup = await dependencies();
    const remove = vi.fn(async () => {
      throw Object.assign(new Error("sensitive platform cleanup detail"), {
        code: "EPERM",
      });
    });
    const prepared = await prepareRemoteImage(
      "https://images.example.test/cover.jpg",
      { ...setup.dependencies, rm: remove },
    );

    expect(prepared.reason).toBeNull();
    await expect(prepared.cleanup()).rejects.toMatchObject({
      name: "SafeImageCleanupError",
      code: "image_cleanup_failed",
      message: "Temporary image cleanup failed.",
    });
    expect(remove).toHaveBeenCalledTimes(3);
    expect(await readdir(setup.tempRoot)).toHaveLength(1);
  });

  it("exposes only the closed bounded reason vocabulary", () => {
    const reasons = [
      "invalid_url",
      "credentials",
      "unsupported_scheme",
      "unsupported_port",
      "dns_failed",
      "non_public_address",
      "redirect_limit",
      "redirect_invalid",
      "timeout",
      "http_status",
      "too_large",
      "unsupported_type",
      "invalid_magic",
      "fetch_failed",
    ] satisfies SafeImageReason[];

    expect(new Set(reasons).size).toBe(14);
  });
});
