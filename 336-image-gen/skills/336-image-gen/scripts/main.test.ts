import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { CliArgs } from "./types.ts";
import {
  createTaskArgs,
  detectProvider,
  execute,
  getWorkerCount,
  isRetryableGenerationError,
  loadBatchTasks,
  loadExtendConfig,
  loadEnv,
  loadEnvFile,
  mergeConfig,
  normalizeOutputImagePath,
  parseArgs,
  parseSimpleYaml,
  resolveBatchPath,
  resolveBatchReference,
  resolveModel,
  runWithConcurrency,
  safeErrorMessage,
  validateReferenceImages,
  withRetry,
} from "./main.ts";
import { ImageGenerationError } from "./types.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: null,
    model: null,
    aspectRatio: null,
    size: null,
    quality: null,
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

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 临时修改环境变量并在测试结束时恢复，避免 key 泄露或跨测试污染。 */
function useEnv(t: TestContext, values: Record<string, string | null>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** 测试 fetch 捕获请求；若 provider 没有发出请求则立即让测试失败。 */
function requireRequest(value: Request | null): Request {
  if (!value) throw new Error("Expected mock fetch to receive a Request.");
  return value;
}

test("CLI 参数解析支持提示词、文件、provider、尺寸、参考图和 JSON", () => {
  const args = parseArgs([
    "--prompt", "draw a cat", "--promptfiles", "a.md", "b.md", "--image", "out/cat",
    "--provider", "relay", "--model", "relay-model", "--ar", "16:9", "--size", "1024x768",
    "--resolution", "4K",
    "--quality", "normal", "--ref", "ref/a.png", "ref/b.jpg", "--retry-once", "--jobs", "2", "--json",
  ]);

  assert.equal(args.prompt, "draw a cat");
  assert.deepEqual(args.promptFiles, ["a.md", "b.md"]);
  assert.equal(args.imagePath, "out/cat");
  assert.equal(args.provider, "relay");
  assert.equal(args.model, "relay-model");
  assert.equal(args.aspectRatio, "16:9");
  assert.equal(args.size, "1024x768");
  assert.equal(args.quality, "normal");
  assert.equal(args.resolution, "4k");
  assert.equal(args.retryPolicy, "once");
  assert.deepEqual(args.referenceImages, ["ref/a.png", "ref/b.jpg"]);
  assert.equal(args.jobs, 2);
  assert.equal(args.json, true);
  assert.equal(parseArgs(["--aspect-ratio", "9:16"]).aspectRatio, "9:16");
  assert.equal(parseArgs(["a", "cat"]).prompt, "a cat");
  assert.throws(() => parseArgs(["--provider", "other"]), /Expected official or relay/);
  assert.throws(() => parseArgs(["--quality", "high"]), /Expected normal or 2k/);
});

test("EXTEND.md 读取、YAML 解析和配置优先级符合约定", async (t: TestContext) => {
  const root = await makeTempDir("336-image-gen-config-");
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(project, ".336-image-gen"), { recursive: true });
  await fs.mkdir(path.join(home, ".336-image-gen"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".336-image-gen", "EXTEND.md"),
    "---\ndefault_provider: relay\ndefault_quality: normal\n---\n",
  );
  await fs.writeFile(
    path.join(project, ".336-image-gen", "EXTEND.md"),
    "---\n" +
      "version: 1\n" +
      "default_provider: official\n" +
      "default_quality: 2k\n" +
      "default_resolution: 1K\n" +
      "default_aspect_ratio: 4:3\n" +
      "default_size: 1200x900\n" +
      "default_retry_policy: manual\n" +
      "default_model:\n" +
      "  official: config-official\n" +
      "  relay: config-relay\n" +
      "relay:\n" +
      "  base_url: https://relay.example.test/v1/\n" +
      "  dialect: openai-images\n" +
      "---\n说明文本\n",
  );

  const config = await loadExtendConfig(project, home);
  assert.equal(config.default_provider, "official");
  assert.equal(config.default_quality, "2k");
  assert.equal(config.default_resolution, "1k");
  assert.equal(config.default_aspect_ratio, "4:3");
  assert.equal(config.default_size, "1200x900");
  assert.equal(config.default_retry_policy, "manual");
  assert.equal(config.default_model?.relay, "config-relay");
  assert.equal(config.relay?.base_url, "https://relay.example.test/v1/");

  const env = {
    LEGACY_IMAGE_QUALITY: "normal",
    LEGACY_IMAGE_ASPECT_RATIO: "16:9",
    LEGACY_IMAGE_SIZE: "800x600",
    LEGACY_RELAY_BASE_URL: "https://env.example.test",
  };
  const merged = mergeConfig(makeArgs({ model: null }), config, env);
  assert.equal(merged.provider, "official");
  assert.equal(merged.quality, "2k");
  assert.equal(merged.aspectRatio, "4:3");
  assert.equal(merged.size, "1200x900");
  assert.equal(merged.retryPolicy, "manual");
  assert.equal(merged.relayBaseUrl, "https://relay.example.test/v1/");
  assert.equal(resolveModel("relay", makeArgs(), config, { LEGACY_RELAY_MODEL: "env-relay" }), "config-relay");
  assert.equal(
    resolveModel("official", makeArgs({ model: "cli-model" }), config, { LEGACY_OFFICIAL_MODEL: "env-official" }),
    "cli-model",
  );
  assert.equal(resolveModel("official", makeArgs(), {}, { LEGACY_OFFICIAL_MODEL: "env-official" }), "gpt-image-2");

  const parsed = parseSimpleYaml("default_provider: relay\ndefault_retry_policy: once\nrelay:\n  dialect: openai-images\n");
  assert.equal(parsed.default_provider, "relay");
  assert.equal(parsed.default_retry_policy, "once");
  assert.equal(parsed.relay?.dialect, "openai-images");
  assert.throws(
    () => parseSimpleYaml("OPENAI_API_KEY: should-not-be-here\n"),
    /cannot be stored in EXTEND\.md/,
  );
  assert.throws(
    () => parseSimpleYaml("openai_api_key: should-not-be-here\n"),
    /OPENAI_API_KEY cannot be stored in EXTEND\.md/,
  );
});

test("env 文件按用户目录、项目目录和已继承环境的优先级读取", async (t: TestContext) => {
  const root = await makeTempDir("336-image-gen-env-");
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  useEnv(t, { OPENAI_API_KEY: null, IMAGE_RELAY_API_KEY: null });

  await fs.mkdir(path.join(project, ".336-image-gen"), { recursive: true });
  await fs.mkdir(path.join(home, ".336-image-gen"), { recursive: true });
  await fs.writeFile(path.join(home, ".336-image-gen", ".env"), "OPENAI_API_KEY=home\n");
  await fs.writeFile(path.join(project, ".336-image-gen", ".env"), "OPENAI_API_KEY=project\n");
  await loadEnv(project, home);
  assert.equal(process.env.OPENAI_API_KEY, "project");
  assert.equal((await loadEnvFile(path.join(project, ".336-image-gen", ".env"))).OPENAI_API_KEY, "project");

  const invalidEnvPath = path.join(project, ".336-image-gen", "invalid.env");
  await fs.writeFile(invalidEnvPath, "IMAGE_SIZE=1024x1024\n");
  await assert.rejects(
    () => loadEnvFile(invalidEnvPath),
    /Unsupported key in \.env.*EXTEND\.md/,
  );
});

test("provider 自动选择遵守凭据歧义和精确缺失变量错误", () => {
  assert.equal(detectProvider(makeArgs(), { OPENAI_API_KEY: "official" }), "official");
  assert.equal(
    detectProvider(makeArgs({ relayBaseUrl: "https://relay.example.test" }), {
      IMAGE_RELAY_API_KEY: "relay",
    }),
    "relay",
  );
  assert.throws(
    () => detectProvider(makeArgs({ relayBaseUrl: "https://relay.example.test" }), {
      OPENAI_API_KEY: "official",
      IMAGE_RELAY_API_KEY: "relay",
    }),
    /Both official and relay credentials/,
  );
  assert.equal(
    detectProvider(makeArgs({ relayBaseUrl: "https://relay.example.test" }), {
      OPENAI_API_KEY: "official",
    }),
    "official",
  );
  assert.equal(detectProvider(makeArgs({ provider: "relay" }), { OPENAI_API_KEY: "official" }), "relay");
  assert.throws(
    () => detectProvider(makeArgs(), { IMAGE_RELAY_API_KEY: "relay" }),
    /relay\.base_url in EXTEND\.md/,
  );
  assert.throws(
    () => detectProvider(makeArgs({ relayBaseUrl: "https://relay.example.test" }), {}),
    /IMAGE_RELAY_API_KEY/,
  );
});

test("本地参考图不存在时在网络请求前失败", async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response();
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => validateReferenceImages([path.join(os.tmpdir(), "missing-336-image-gen.png")]),
    /Reference image not found/,
  );
  assert.equal(called, false);
});

test("参考图支持 HTTP(S) URL 和图片 Data URL", async () => {
  await validateReferenceImages([
    "https://cdn.example.test/reference.png?signature=test",
    "data:image/png;base64," + Buffer.from("image").toString("base64"),
  ]);
});

test("batch 相对路径相对 batch.json 所在目录解析，且 jobs 限制并发", async (t: TestContext) => {
  const root = await makeTempDir("336-image-gen-batch-");
  const batchPath = path.join(root, "jobs", "batch.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(batchPath), { recursive: true });
  await fs.writeFile(
    batchPath,
    JSON.stringify({
      jobs: 2,
      tasks: [
        {
          id: "one",
          promptFiles: ["prompts/one.md"],
          image: "out/one.png",
          ref: ["refs/one.png"],
          retryPolicy: "once",
        },
      ],
    }),
  );

  const loaded = await loadBatchTasks(batchPath);
  assert.equal(loaded.batchDir, path.dirname(batchPath));
  const task = createTaskArgs(makeArgs(), loaded.tasks[0]!, loaded.batchDir);
  assert.equal(task.promptFiles[0], resolveBatchPath(loaded.batchDir, "prompts/one.md"));
  assert.equal(task.imagePath, resolveBatchPath(loaded.batchDir, "out/one.png"));
  assert.equal(task.referenceImages[0], resolveBatchPath(loaded.batchDir, "refs/one.png"));
  assert.equal(task.retryPolicy, "once");
  assert.equal(
    resolveBatchReference(loaded.batchDir, "https://cdn.example.test/reference.png"),
    "https://cdn.example.test/reference.png",
  );

  let active = 0;
  let maxActive = 0;
  const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
  assert.equal(getWorkerCount(5, 20), 5);
});

test("429 和 5xx 重试，401、403、400 不重试", async () => {
  for (const status of [429, 500, 502]) {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new ImageGenerationError("temporary", { status, retryable: true });
        return "ok";
      },
      { maxAttempts: 3, sleep: async () => undefined },
    );
    assert.equal(result.value, "ok");
    assert.equal(calls, 2);
  }

  for (const status of [400, 401, 403]) {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls += 1;
        throw new ImageGenerationError("permanent", { status, retryable: false });
      }, { maxAttempts: 3, sleep: async () => undefined }),
    );
    assert.equal(calls, 1);
    assert.equal(isRetryableGenerationError(new ImageGenerationError("permanent", { status })), false);
  }
  assert.equal(isRetryableGenerationError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableGenerationError(new TypeError("invalid argument")), false);
  assert.equal(isRetryableGenerationError(new Error("invalid argument")), false);
});

test("默认只调用一次，显式 retry-once 最多调用两次", async () => {
  let defaultCalls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      defaultCalls += 1;
      throw new ImageGenerationError("temporary", { status: 500, retryable: true });
    }, { sleep: async () => undefined }),
  );
  assert.equal(defaultCalls, 1);

  let explicitCalls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      explicitCalls += 1;
      throw new ImageGenerationError("temporary", { status: 500, retryable: true });
    }, { maxAttempts: 2, sleep: async () => undefined }),
  );
  assert.equal(explicitCalls, 2);
});

test("execute 的默认费用安全模式和 Katuai 安全拦截都只发起一次请求", async (t: TestContext) => {
  const root = await makeTempDir("336-image-gen-retry-safety-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  useEnv(t, { OPENAI_API_KEY: "sk-retry-safety-test", IMAGE_RELAY_API_KEY: null });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporary failure", { status: 500 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => execute(["--prompt", "one", "--image", "out/default.png"], { cwd: root, home: path.join(root, "home") }),
  );
  assert.equal(calls, 1);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("temporary failure", { status: 500 });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }), {
      status: 200,
    });
  };
  const retried = await execute(
    ["--prompt", "one", "--image", "out/retried.png", "--retry-once"],
    { cwd: root, home: path.join(root, "home") },
  );
  assert.equal(retried.mode, "single");
  assert.equal(calls, 2);

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("The generated images appear to be unsafe", { status: 500 });
  };
  await assert.rejects(
    () => execute(
      ["--prompt", "unsafe", "--image", "out/unsafe.png", "--retry-once"],
      { cwd: root, home: path.join(root, "home") },
    ),
  );
  assert.equal(calls, 1);
});

test("敏感 key、Authorization 和 base64 不会进入错误消息", () => {
  const key = "sk-test-secret-336";
  const base64 = "A".repeat(180);
  const error = new Error(
    "status 500 Authorization: Bearer " + key + " {\"b64_json\":\"" + base64 + "\"}",
  );
  const message = safeErrorMessage(error, { OPENAI_API_KEY: key });
  assert.equal(message.includes(key), false);
  assert.equal(message.includes(base64), false);
  assert.match(message, /REDACTED/);
});

test("批量入口隔离失败任务，并保持 jobs 并发上限", async (t: TestContext) => {
  const root = await makeTempDir("336-image-gen-execute-");
  const batchPath = path.join(root, "batch.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  useEnv(t, {
    OPENAI_API_KEY: "sk-batch-test",
    IMAGE_RELAY_API_KEY: null,
  });
  await fs.writeFile(
    batchPath,
    JSON.stringify({
      tasks: [
        { id: "ok-1", prompt: "one", image: "out/one.png" },
        { id: "bad", prompt: "bad", image: "out/bad.png", ref: ["missing.png"] },
        { id: "ok-2", prompt: "two", image: "out/two.png" },
      ],
    }),
  );

  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await execute(["--batchfile", batchPath, "--jobs", "1"], {
    cwd: root,
    home: path.join(root, "home"),
  });
  assert.equal(result.mode, "batch");
  if (result.mode !== "batch") return;
  assert.equal(result.results.filter((item) => item.success).length, 2);
  assert.equal(result.results.filter((item) => !item.success).length, 1);
  assert.equal(maxActive, 1);
  assert.equal(await fs.readFile(path.join(root, "out", "one.png"), "utf8"), "image");
  assert.equal(await fs.readFile(path.join(root, "out", "two.png"), "utf8"), "image");
  assert.equal(await fs.stat(path.join(root, "out", "bad.png")).catch(() => null), null);
});

test("批量模式拒绝共享 --image，避免任务覆盖同一路径", async (t: TestContext) => {
  const root = await makeTempDir("336-image-gen-batch-output-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const batchPath = path.join(root, "batch.json");
  await fs.writeFile(batchPath, JSON.stringify({ tasks: [{ prompt: "one", image: "out/one.png" }] }));

  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return new Response();
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => execute(["--batchfile", batchPath, "--image", "shared.png"], { cwd: root, home: path.join(root, "home") }),
    /--image cannot be used with --batchfile/,
  );
  assert.equal(called, false);
});

test("输出路径没有扩展名时补 png", () => {
  assert.equal(normalizeOutputImagePath("out/image"), "out/image.png");
  assert.equal(normalizeOutputImagePath("out/image.jpg"), "out/image.jpg");
});
