import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildGenerationsBody,
  extractImageFromResponse,
  generateImage,
  normalizeRelayBaseUrl,
  validateArgs,
} from "./relay.ts";
import { ImageGenerationError } from "../types.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: "relay",
    model: null,
    aspectRatio: null,
    size: null,
    quality: "normal",
    resolution: null,
    retryPolicy: null,
    referenceImages: [],
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
    relayBaseUrl: "https://relay.example.test",
    relayDialect: "openai-images",
    ...overrides,
  };
}

/** 临时替换 relay 凭据和 fetch，确保测试不访问真实图片服务。 */
function useFetch(t: TestContext, handler: typeof fetch): void {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.IMAGE_RELAY_API_KEY;
  process.env.IMAGE_RELAY_API_KEY = "relay-secret-test";
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.IMAGE_RELAY_API_KEY;
    else process.env.IMAGE_RELAY_API_KEY = previousKey;
  });
}

/** 测试 fetch 捕获请求；若 provider 没有发出请求则立即让测试失败。 */
function requireRequest(value: Request | null): Request {
  if (!value) throw new Error("Expected mock fetch to receive a Request.");
  return value;
}

test("relay base_url 自动处理 /v1 和尾斜杠", () => {
  assert.equal(normalizeRelayBaseUrl("https://relay.example.test"), "https://relay.example.test/v1");
  assert.equal(normalizeRelayBaseUrl("https://relay.example.test/"), "https://relay.example.test/v1");
  assert.equal(normalizeRelayBaseUrl("https://relay.example.test/v1/"), "https://relay.example.test/v1");
  assert.equal(normalizeRelayBaseUrl("https://relay.example.test/api/v1///"), "https://relay.example.test/api/v1");
  assert.throws(() => normalizeRelayBaseUrl("ftp://relay.example.test"), /HTTP\(S\)/);
  assert.throws(() => normalizeRelayBaseUrl("https://user:pass@relay.example.test"), /credentials/);
  assert.throws(() => normalizeRelayBaseUrl("https://relay.example.test?key=secret"), /query/);
});

test("relay generations 请求体和 b64_json 解析", async (t: TestContext) => {
  let request: Request | null = null;
  useFetch(t, async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("relay-image").toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const bytes = await generateImage(
    "Draw a skyline",
    "relay-image-model",
    makeArgs({ quality: "2k", aspectRatio: "16:9" }),
  );
  assert.equal(new TextDecoder().decode(bytes), "relay-image");
  const capturedRequest = requireRequest(request);
  assert.equal(capturedRequest.url, "https://relay.example.test/v1/images/generations");
  assert.deepEqual(JSON.parse(await capturedRequest.text()), {
    model: "relay-image-model",
    prompt: "Draw a skyline",
    size: "2048x1152",
  });
  assert.deepEqual(buildGenerationsBody("p", "m", "1024x1024"), {
    model: "m",
    prompt: "p",
    size: "1024x1024",
  });
});

test("relay URL 响应会被下载为 Uint8Array", async (t: TestContext) => {
  const requests: string[] = [];
  useFetch(t, async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/result.png" }] }), { status: 200 });
    }
    return new Response(Uint8Array.from([9, 8, 7]), { status: 200 });
  });

  const bytes = await generateImage("download", "relay-model", makeArgs());
  assert.deepEqual([...bytes], [9, 8, 7]);
  assert.deepEqual(requests, [
    "https://relay.example.test/v1/images/generations",
    "https://cdn.example.test/result.png",
  ]);
  assert.deepEqual(
    [...await extractImageFromResponse({ data: [{ b64_json: Buffer.from("x").toString("base64") }] })],
    [120],
  );
});

test("relay URL 下载网络错误保持可重试", async (t: TestContext) => {
  useFetch(t, async (input) => {
    if (String(input).endsWith("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/result.png" }] }), { status: 200 });
    }
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    () => generateImage("download", "relay-model", makeArgs()),
    (error: unknown) => {
      assert.equal(error instanceof TypeError, true);
      return true;
    },
  );
});

test("relay edits 使用 image[]，不兼容 dialect 明确失败", async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "336-image-gen-relay-edit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const refPath = path.join(root, "reference.png");
  await fs.writeFile(refPath, "reference-bytes");

  let request: Request | null = null;
  useFetch(t, async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] }), { status: 200 });
  });

  const bytes = await generateImage(
    "Edit this",
    "relay-model",
    makeArgs({ referenceImages: [refPath], size: "1024x1024" }),
  );
  assert.equal(new TextDecoder().decode(bytes), "edited");
  const capturedRequest = requireRequest(request);
  assert.equal(capturedRequest.url, "https://relay.example.test/v1/images/edits");
  const form = await capturedRequest.formData();
  assert.equal(form.getAll("image[]").length, 1);
  assert.equal((form.get("image[]") as File).name, "reference.png");

  assert.throws(
    () => validateArgs("relay-model", makeArgs({ relayDialect: "other" as never })),
    /Unsupported relay dialect/,
  );
});

test("relay edits 会下载 URL 并解码 Data URL 后统一上传", async (t: TestContext) => {
  const source = "data:image/jpeg;base64," + Buffer.from("data-reference").toString("base64");
  let requestCount = 0;
  let editRequest: Request | null = null;
  useFetch(t, async (input, init) => {
    requestCount += 1;
    if (String(input) === "https://cdn.example.test/reference.png") {
      return new Response("url-reference", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    editRequest = new Request(input, init);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("edited").toString("base64") }] }), {
      status: 200,
    });
  });

  await generateImage(
    "Edit this",
    "relay-model",
    makeArgs({ referenceImages: ["https://cdn.example.test/reference.png", source] }),
  );

  assert.equal(requestCount, 2);
  const form = await requireRequest(editRequest).formData();
  const references = form.getAll("image[]") as File[];
  assert.equal(references.length, 2);
  assert.equal(references[0]?.name, "reference.png");
  assert.equal(await references[0]?.text(), "url-reference");
  assert.equal(references[1]?.name, "reference-2.jpg");
  assert.equal(await references[1]?.text(), "data-reference");
});

test("relay 不符合预期的 JSON 错误包含状态码和安全截断正文", async (t: TestContext) => {
  useFetch(t, async () => new Response("not-json", { status: 200 }));
  await assert.rejects(
    () => generateImage("bad", "relay-model", makeArgs()),
    /invalid JSON \(HTTP 200\).*not-json/,
  );

  useFetch(t, async () => new Response("secret-body", { status: 400 }));
  await assert.rejects(
    () => generateImage("bad", "relay-model", makeArgs()),
    (error: unknown) => {
      assert.equal(error instanceof ImageGenerationError, true);
      const imageError = error as ImageGenerationError;
      assert.equal(imageError.status, 400);
      assert.equal(imageError.retryable, false);
      assert.match(imageError.message, /400/);
      assert.match(imageError.message, /secret-body/);
      assert.equal(imageError.message.includes("relay-secret-test"), false);
      return true;
    },
  );
});

test("relay 安全策略 HTTP 500 永不标记为可重试", async (t: TestContext) => {
  useFetch(t, async () => new Response("The generated images appear to be unsafe", { status: 500 }));

  await assert.rejects(
    () => generateImage("unsafe", "relay-model", makeArgs()),
    (error: unknown) => {
      assert.equal(error instanceof ImageGenerationError, true);
      assert.equal((error as ImageGenerationError).retryable, false);
      return true;
    },
  );
});
