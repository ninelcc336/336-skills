import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildGenerationsBody,
  generateImage,
  getMimeType,
  validateArgs,
} from "./official.ts";
import { ImageGenerationError } from "../types.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: "official",
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
    relayBaseUrl: null,
    relayDialect: null,
    ...overrides,
  };
}

/** 临时替换 API key 和 fetch，测试完成后恢复进程状态。 */
function useFetch(t: TestContext, handler: typeof fetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

/** 测试 fetch 捕获请求；若 provider 没有发出请求则立即让测试失败。 */
function requireRequest(value: Request | null): Request {
  if (!value) throw new Error("Expected mock fetch to receive a Request.");
  return value;
}

test("official generations 请求体只发送确定的 OpenAI Images 字段", async (t: TestContext) => {
  process.env.OPENAI_API_KEY = "sk-official-test";
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
  });

  let request: Request | null = null;
  useFetch(t, async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("official-image").toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const bytes = await generateImage(
    "Draw a skyline",
    "gpt-image-2",
    makeArgs({ quality: "2k", aspectRatio: "16:9" }),
  );

  assert.equal(new TextDecoder().decode(bytes), "official-image");
  const capturedRequest = requireRequest(request);
  assert.equal(capturedRequest.url, "https://api.openai.com/v1/images/generations");
  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.headers.get("Authorization"), "Bearer sk-official-test");
  assert.deepEqual(JSON.parse(await capturedRequest.text()), {
    model: "gpt-image-2",
    prompt: "Draw a skyline",
    size: "2048x1152",
  });
});

test("official edits 使用 image[] multipart 并发送多个本地参考图", async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "336-image-gen-official-edit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.OPENAI_API_KEY = "sk-official-edit-test";
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
  });
  const pngPath = path.join(root, "subject.png");
  const jpgPath = path.join(root, "style.jpg");
  await fs.writeFile(pngPath, "png-bytes");
  await fs.writeFile(jpgPath, "jpg-bytes");

  let request: Request | null = null;
  useFetch(t, async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("edited-image").toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const bytes = await generateImage(
    "Keep identity",
    "gpt-image-2",
    makeArgs({ referenceImages: [pngPath, jpgPath], size: "1024x768" }),
  );
  assert.equal(new TextDecoder().decode(bytes), "edited-image");
  const capturedRequest = requireRequest(request);
  assert.equal(capturedRequest.url, "https://api.openai.com/v1/images/edits");
  assert.equal(capturedRequest.headers.get("Content-Type")?.startsWith("multipart/form-data"), true);

  const form = await capturedRequest.formData();
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("prompt"), "Keep identity");
  assert.equal(form.get("size"), "1024x768");
  const references = form.getAll("image[]");
  assert.equal(references.length, 2);
  assert.equal((references[0] as File).name, "subject.png");
  assert.equal((references[0] as File).type, "image/png");
  assert.equal((references[1] as File).name, "style.jpg");
  assert.equal((references[1] as File).type, "image/jpeg");
});

test("official provider 校验参考图模型并识别 MIME 类型", () => {
  assert.equal(getMimeType("photo.jpg"), "image/jpeg");
  assert.equal(getMimeType("photo.webp"), "image/webp");
  assert.equal(getMimeType("photo.png"), "image/png");
  assert.throws(
    () => validateArgs("dall-e-3", makeArgs({ referenceImages: ["ref.png"] })),
    /DALL-E models are not supported/,
  );
});

test("official provider 的 HTTP 状态错误带状态且只标记 429/5xx 可重试", async (t: TestContext) => {
  process.env.OPENAI_API_KEY = "sk-official-status-test";
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
  });

  for (const [status, retryable] of [[429, true], [500, true], [401, false], [403, false], [400, false]] as const) {
    useFetch(t, async () => new Response("denied", { status }));
    await assert.rejects(
      () => generateImage("test", "gpt-image-2", makeArgs()),
      (error: unknown) => {
        assert.equal(error instanceof ImageGenerationError, true);
        const imageError = error as ImageGenerationError;
        assert.equal(imageError.status, status);
        assert.equal(imageError.retryable, retryable);
        assert.match(imageError.message, new RegExp(String(status)));
        return true;
      },
    );
  }
});

test("official 安全策略 HTTP 500 永不标记为可重试", async (t: TestContext) => {
  process.env.OPENAI_API_KEY = "sk-official-safety-test";
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
  });
  useFetch(t, async () => new Response("The generated images appear to be unsafe", { status: 500 }));

  await assert.rejects(
    () => generateImage("unsafe", "gpt-image-2", makeArgs()),
    (error: unknown) => {
      assert.equal(error instanceof ImageGenerationError, true);
      assert.equal((error as ImageGenerationError).retryable, false);
      return true;
    },
  );
});
