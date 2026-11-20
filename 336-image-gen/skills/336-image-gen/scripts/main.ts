import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import * as official from "./providers/official.ts";
import * as relay from "./providers/relay.ts";
import { resolveImageSize, validatePixelSize, validateResolution } from "./size.ts";
import {
  REFERENCE_IMAGE_EXTENSIONS,
  validateReferenceImageSource,
} from "./reference-images.ts";
import {
  ImageGenerationError,
  type BatchFile,
  type BatchTaskInput,
  type CliArgs,
  type ExtendConfig,
  type Provider,
  type Quality,
  type RelayDialect,
  type RetryPolicy,
  safeResponseSnippet,
} from "./types.ts";

export type ProviderModule = {
  getDefaultModel: () => string;
  generateImage: (prompt: string, model: string, args: CliArgs) => Promise<Uint8Array>;
  validateArgs?: (model: string, args: CliArgs) => void;
  getDefaultOutputExtension?: () => string;
};

export type TaskResult = {
  id: string;
  provider: Provider | null;
  model: string | null;
  outputPath: string;
  success: boolean;
  attempts: number;
  error: string | null;
};

export type SingleExecution = {
  mode: "single";
  result: TaskResult;
};

export type BatchExecution = {
  mode: "batch";
  results: TaskResult[];
};

export type ExecutionResult = SingleExecution | BatchExecution;

type PreparedTask = {
  id: string;
  prompt: string;
  args: CliArgs;
  provider: Provider;
  model: string;
  outputPath: string;
  providerModule: ProviderModule;
};

type RetryOptions = {
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (error: unknown, nextAttempt: number) => void;
};

export type RetryResult<T> = {
  value: T;
  attempts: number;
};

type ExecutionOptions = {
  cwd?: string;
  home?: string;
};

const DEFAULT_QUALITY: Quality = "2k";
const DEFAULT_BATCH_JOBS = 4;
const DEFAULT_MAX_ATTEMPTS = 1;
const EXPLICIT_RETRY_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const SENSITIVE_CONFIG_KEYS = new Set(["OPENAI_API_KEY", "IMAGE_RELAY_API_KEY"]);
// .env 只承载运行时凭据；所有非敏感默认值统一放进 EXTEND.md。
const ENV_FILE_KEYS = new Set(["OPENAI_API_KEY", "IMAGE_RELAY_API_KEY"]);
const PROVIDERS: Record<Provider, ProviderModule> = {
  official,
  relay,
};

/**
 * 打印命令行帮助；帮助内容只描述稳定的公开参数，不暴露任何当前环境值。
 */
export function printUsage(): void {
  console.log(`用法:
  bun 336-image-gen/scripts/main.ts --prompt "A cat" --image cat.png
  npx -y tsx 336-image-gen/scripts/main.ts --promptfiles prompt.md --image out.png
  bun 336-image-gen/scripts/main.ts --batchfile batch.json --jobs 4

选项:
  -p, --prompt <text>       文生图提示词
  --promptfiles <files...>  从一个或多个文件读取提示词
  --image <path>            输出图片路径（单图模式必填）
  --batchfile <path>        批量任务 JSON 文件
  --jobs <count>            批量并发数，默认 4
  --provider official|relay 显式选择 provider
  -m, --model <id>          模型 ID
  --ar <ratio>              宽高比，例如 1:1、16:9、9:16、4:3
  --aspect-ratio <ratio>    --ar 的可读别名
  --size <WxH>              显式像素尺寸，例如 1024x1024
  --resolution <value>      分辨率档位：1K、2K、4K
  --quality normal|2k       尺寸质量预设，默认 2k
  --ref <sources...>       本地路径、HTTP(S) URL 或图片 Data URL
  --retry-once              用户明确授权后最多额外重试一次
  --json                    输出 JSON 结果
  -h, --help                显示帮助

环境变量:
  OPENAI_API_KEY            官方 OpenAI Images API key
  IMAGE_RELAY_API_KEY       relay API key

配置文件:
  .env                     只保存上述 API key
  EXTEND.md                保存 provider、模型、relay 地址和图片默认参数`);
}

/**
 * 从当前位置开始收集一个多值 CLI 参数，遇到下一个选项即停止并返回最后索引。
 */
function takeMany(argv: string[], index: number, option: string): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let cursor = index + 1;
  while (cursor < argv.length && !argv[cursor]!.startsWith("-")) {
    values.push(argv[cursor]!);
    cursor += 1;
  }
  if (values.length === 0) throw new Error(`Missing value for ${option}`);
  return { values, nextIndex: cursor - 1 };
}

/**
 * 解析并校验 provider 名称，集中处理 CLI 和配置文件共用的两值枚举。
 */
function parseProvider(value: string, source: string): Provider {
  if (value === "official" || value === "relay") return value;
  throw new Error(`Invalid ${source}: ${value}. Expected official or relay.`);
}

/**
 * 解析质量预设；未知值在 API 请求前失败，避免被中转站当成隐含协议。
 */
function parseQuality(value: string, source: string): Quality {
  if (value === "normal" || value === "2k") return value;
  throw new Error(`Invalid ${source}: ${value}. Expected normal or 2k.`);
}

/**
 * 解析重试授权级别；manual 是默认费用安全模式，once 只能代表用户已明确授权一次重试。
 */
function parseRetryPolicy(value: string, source: string): RetryPolicy {
  if (value === "manual" || value === "once") return value;
  throw new Error(`Invalid ${source}: ${value}. Expected manual or once.`);
}

/**
 * 解析支持的 relay dialect；当前只有 OpenAI Images 兼容协议，其他协议必须新增 provider。
 */
function parseRelayDialect(value: string, source: string): RelayDialect {
  if (value === "openai-images") return value;
  throw new Error(
    `Unsupported ${source}: ${value}. This Skill only supports openai-images; add a separate provider for another dialect.`,
  );
}

/**
 * 解析所有公开 CLI 参数，并把多值参数保留为数组供单图和批量模式共用。
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
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
  };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--json") {
      args.json = true;
      continue;
    }
    if (current === "--retry-once") {
      args.retryPolicy = "once";
      continue;
    }
    if (current === "--prompt" || current === "-p") {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${current}`);
      args.prompt = value;
      continue;
    }
    if (current === "--promptfiles") {
      const result = takeMany(argv, index, current);
      args.promptFiles.push(...result.values);
      index = result.nextIndex;
      continue;
    }
    if (current === "--image") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --image");
      args.imagePath = value;
      continue;
    }
    if (current === "--batchfile" || current === "--batch") {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${current}`);
      args.batchFile = value;
      continue;
    }
    if (current === "--jobs") {
      const value = argv[++index];
      const jobs = value ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(jobs) || jobs < 1) {
        throw new Error(`Invalid worker count: ${value ?? ""}`);
      }
      args.jobs = jobs;
      continue;
    }
    if (current === "--provider") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --provider");
      args.provider = parseProvider(value, "provider");
      continue;
    }
    if (current === "--model" || current === "-m") {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${current}`);
      args.model = value;
      continue;
    }
    if (current === "--ar" || current === "--aspect-ratio") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --ar");
      args.aspectRatio = value;
      continue;
    }
    if (current === "--size") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --size");
      args.size = validatePixelSize(value);
      continue;
    }
    if (current === "--resolution") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --resolution");
      args.resolution = validateResolution(value);
      continue;
    }
    if (current === "--quality") {
      const value = argv[++index];
      if (!value) throw new Error("Missing value for --quality");
      args.quality = parseQuality(value, "quality");
      continue;
    }
    if (current === "--ref" || current === "--reference") {
      const result = takeMany(argv, index, current);
      args.referenceImages.push(...result.values);
      index = result.nextIndex;
      continue;
    }
    if (current.startsWith("-")) throw new Error(`Unknown option: ${current}`);
    positional.push(current);
  }

  if (positional.length > 0) {
    if (args.prompt || args.promptFiles.length > 0) {
      throw new Error("Positional prompt cannot be combined with --prompt or --promptfiles.");
    }
    args.prompt = positional.join(" ");
  }

  return args;
}

/**
 * 读取凭据专用 env 文件；只解析 API key，不执行 shell 语法，也不把内容打印到终端。
 * 非敏感配置必须写入 EXTEND.md，避免两个配置文件表达同一项设置。
 */
export async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, "utf8");
    const values: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const assignment = trimmed.replace(/^export\s+/, "");
      const separator = assignment.indexOf("=");
      if (separator < 1) continue;

      const key = assignment.slice(0, separator).trim();
      if (!ENV_FILE_KEYS.has(key)) {
        throw new Error(
          `Unsupported key in .env: ${key}. .env only accepts OPENAI_API_KEY and IMAGE_RELAY_API_KEY; put non-sensitive settings in EXTEND.md.`,
        );
      }
      let value = assignment.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return {};
    throw error;
  }
}

/**
 * 按用户目录凭据文件、项目凭据文件的顺序补齐 API key；进程环境始终优先。
 * 非敏感配置不从 .env 加载，避免与 EXTEND.md 重合。
 */
export async function loadEnv(cwd = process.cwd(), home = homedir()): Promise<void> {
  const homeEnv = await loadEnvFile(path.join(home, ".336-image-gen", ".env"));
  const projectEnv = await loadEnvFile(path.join(cwd, ".336-image-gen", ".env"));
  const inheritedKeys = new Set(Object.keys(process.env));

  for (const [key, value] of Object.entries(homeEnv)) {
    if (!inheritedKeys.has(key)) process.env[key] = value;
  }
  for (const [key, value] of Object.entries(projectEnv)) {
    if (!inheritedKeys.has(key)) process.env[key] = value;
  }
}

/**
 * 去掉 YAML 标量的引号和空值标记，保持 EXTEND.md 的非敏感配置可读且可移植。
 */
function parseYamlScalar(rawValue: string): string | null {
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value === "" || value === "null" ? null : value;
}

/**
 * 解析本 Skill 所需的窄 YAML 子集；未知字段会被忽略，敏感 key 不会被定义为配置项。
 */
export function parseSimpleYaml(yaml: string): Partial<ExtendConfig> {
  const config: Partial<ExtendConfig> = {};
  let section: "default_model" | "relay" | null = null;

  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const separator = trimmed.indexOf(":");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    const normalizedKey = key.toUpperCase();
    if (SENSITIVE_CONFIG_KEYS.has(normalizedKey)) {
      throw new Error(`${normalizedKey} cannot be stored in EXTEND.md; configure API keys through environment variables.`);
    }
    const value = parseYamlScalar(trimmed.slice(separator + 1));

    if (indent === 0) {
      section = null;
      if (key === "version") {
        const version = value === null ? 1 : Number(value);
        if (!Number.isSafeInteger(version) || version < 1) {
          throw new Error(`Invalid EXTEND.md version: ${value ?? "null"}`);
        }
        config.version = version;
      } else if (key === "default_provider") {
        config.default_provider = value === null ? null : parseProvider(value, "default_provider");
      } else if (key === "default_quality") {
        config.default_quality = value === null ? null : parseQuality(value, "default_quality");
      } else if (key === "default_resolution") {
        config.default_resolution = value === null ? null : validateResolution(value);
      } else if (key === "default_aspect_ratio") {
        config.default_aspect_ratio = value;
      } else if (key === "default_size") {
        config.default_size = value === null ? null : validatePixelSize(value);
      } else if (key === "default_retry_policy") {
        config.default_retry_policy = value === null ? null : parseRetryPolicy(value, "default_retry_policy");
      } else if (key === "default_model") {
        config.default_model = {};
        section = "default_model";
      } else if (key === "relay") {
        config.relay = {};
        section = "relay";
      }
      continue;
    }

    if (indent < 2 || !section) continue;
    if (section === "default_model" && (key === "official" || key === "relay")) {
      config.default_model ??= {};
      config.default_model[key] = value;
      continue;
    }
    if (section === "relay" && key === "base_url") {
      config.relay ??= {};
      config.relay.base_url = value;
      continue;
    }
    if (section === "relay" && key === "dialect") {
      config.relay ??= {};
      config.relay.dialect = value === null ? null : parseRelayDialect(value, "relay.dialect");
    }
  }

  return config;
}

/**
 * 提取 EXTEND.md 的 YAML front matter；没有 front matter 的配置文件被视为格式错误。
 */
export function extractYamlFrontMatter(content: string): string | null {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)/);
  return match ? match[1]! : null;
}

/**
 * 读取项目优先、用户目录兜底的 EXTEND.md，不存在时返回空配置。
 */
export async function loadExtendConfig(
  cwd = process.cwd(),
  home = homedir(),
): Promise<Partial<ExtendConfig>> {
  const candidates = [
    path.join(cwd, ".336-image-gen", "EXTEND.md"),
    path.join(home, ".336-image-gen", "EXTEND.md"),
  ];

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, "utf8");
      const yaml = extractYamlFrontMatter(content);
      if (yaml === null) {
        throw new Error(`Invalid EXTEND.md: ${filePath} must contain YAML front matter.`);
      }
      return parseSimpleYaml(yaml);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") continue;
      throw error;
    }
  }

  return {};
}

/**
 * 读取配置中的可选文本；空字符串按未配置处理，避免空值覆盖 EXTEND.md。
 */
function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 合并 CLI 与 EXTEND.md；API key 是唯一从 .env/进程环境读取的内容，非敏感配置不再从环境变量兜底。
 */
export function mergeConfig(
  args: CliArgs,
  config: Partial<ExtendConfig>,
  _env: Record<string, string | undefined> = process.env,
): CliArgs {
  const merged: CliArgs = {
    ...args,
    promptFiles: [...args.promptFiles],
    referenceImages: [...args.referenceImages],
  };

  if (merged.provider === null && config.default_provider) {
    merged.provider = config.default_provider;
  }
  if (merged.quality === null) {
    merged.quality = config.default_quality ?? null;
  }
  if (merged.aspectRatio === null) {
    merged.aspectRatio = config.default_aspect_ratio ?? null;
  }
  if (merged.resolution === null) {
    merged.resolution = config.default_resolution ?? null;
  }
  if (merged.size === null) {
    merged.size = config.default_size ?? null;
  }
  if (merged.retryPolicy === null) {
    merged.retryPolicy = config.default_retry_policy ?? null;
  }
  if (merged.relayBaseUrl === null) {
    merged.relayBaseUrl = nonEmpty(config.relay?.base_url);
  }
  if (merged.relayDialect === null) {
    merged.relayDialect = config.relay?.dialect ?? "openai-images";
  }

  return merged;
}

/**
 * 根据 provider 解析模型优先级：CLI > EXTEND.md > provider 内置默认值。
 */
export function resolveModel(
  provider: Provider,
  args: CliArgs,
  config: Partial<ExtendConfig>,
  _env: Record<string, string | undefined> = process.env,
): string {
  const cliModel = nonEmpty(args.model);
  if (cliModel) return cliModel;

  const configuredModel = nonEmpty(config.default_model?.[provider]);
  if (configuredModel) return configuredModel;

  return PROVIDERS[provider].getDefaultModel();
}

/**
 * 按凭据自动选择 provider；两套完整凭据同时存在时必须显式选择，避免错误计费或路由。
 */
export function detectProvider(
  args: CliArgs,
  env: Record<string, string | undefined> = process.env,
): Provider {
  if (args.provider) return parseProvider(String(args.provider), "provider");

  const officialKey = nonEmpty(env.OPENAI_API_KEY);
  const relayKey = nonEmpty(env.IMAGE_RELAY_API_KEY);
  const relayBaseUrl = nonEmpty(args.relayBaseUrl);

  if (officialKey && relayKey) {
    if (!relayBaseUrl) {
      throw new Error("relay.base_url in EXTEND.md is required when IMAGE_RELAY_API_KEY is configured.");
    }
    throw new Error(
      "Both official and relay credentials are configured. Please pass --provider official or --provider relay explicitly.",
    );
  }
  // relay 地址本身不是凭据；官方 key 单独存在时不得被无关的 relay 配置干扰。
  if (officialKey) return "official";
  if (relayKey && !relayBaseUrl) {
    throw new Error("relay.base_url in EXTEND.md is required when IMAGE_RELAY_API_KEY is configured.");
  }
  if (relayBaseUrl && !relayKey) {
    throw new Error("IMAGE_RELAY_API_KEY is required when relay.base_url is configured in EXTEND.md.");
  }
  if (relayKey && relayBaseUrl) return "relay";

  throw new Error(
    "No image provider credentials found. Set OPENAI_API_KEY, or set IMAGE_RELAY_API_KEY and relay.base_url in EXTEND.md.",
  );
}

/**
 * 校验参考图来源；本地路径、HTTP(S) URL 和图片 Data URL 都会在请求前完成格式检查。
 * URL 不在这里下载，网络可用性和响应 MIME 会在 provider 构造请求时检查。
 */
export async function validateReferenceImages(referenceImages: string[]): Promise<void> {
  for (const referencePath of referenceImages) {
    const kind = validateReferenceImageSource(referencePath);
    if (kind !== "local") continue;

    const extension = path.extname(referencePath).toLowerCase();
    if (!REFERENCE_IMAGE_EXTENSIONS.has(extension)) continue;

    try {
      const fileInfo = await stat(referencePath);
      if (!fileInfo.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Reference image not found or is not a file: ${referencePath}`);
    }
  }
}

/**
 * 从 prompt 和 promptfiles 组合最终提示词；文件内容只进入请求，不进入日志和 JSON 摘要。
 */
export async function readPrompt(args: Pick<CliArgs, "prompt" | "promptFiles">): Promise<string> {
  const parts: string[] = [];
  if (args.prompt) parts.push(args.prompt);
  for (const filePath of args.promptFiles) {
    parts.push(await readFile(filePath, "utf8"));
  }
  const prompt = parts.join("\n\n").trim();
  if (!prompt) throw new Error("A prompt or at least one --promptfiles file is required.");
  return prompt;
}

/**
 * 确保目录存在；只在目录缺失时创建，其他文件系统错误继续向调用方抛出。
 */
export async function ensureDir(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    try {
      if ((await stat(directory)).isDirectory()) return;
    } catch {
      // 保留原始 mkdir 错误，避免掩盖权限或路径问题。
    }
    throw error;
  }
}

/**
 * 给没有扩展名的输出路径补 provider 默认扩展名，同时保留用户显式指定的扩展名。
 */
export function normalizeOutputImagePath(outputPath: string, defaultExtension = ".png"): string {
  if (path.extname(outputPath)) return outputPath;
  return outputPath + defaultExtension;
}

/**
 * 将异常转换成安全短消息，统一移除两套 API key 和潜在的 base64 内容。
 */
export function safeErrorMessage(
  error: unknown,
  env: Record<string, string | undefined> = process.env,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [env.OPENAI_API_KEY, env.IMAGE_RELAY_API_KEY].filter(
    (value): value is string => Boolean(value),
  );
  return safeResponseSnippet(message, secrets);
}

/**
 * 根据 HTTP 状态、网络异常和 provider 明确标记判断是否应该重试本次生成。
 * 普通参数错误、鉴权错误和其他 4xx 默认不可重试。
 */
export function isRetryableGenerationError(error: unknown): boolean {
  if (error instanceof ImageGenerationError) return error.retryable;

  const maybeStatus = error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  if (maybeStatus === 429 || maybeStatus >= 500) return true;
  if (maybeStatus >= 400 && maybeStatus < 500) return false;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /failed to fetch|fetch failed|network|socket|econn|enotfound|eai_again|und_err|etimedout|timed out|connection reset/.test(message);
}

/**
 * 为重试提供短指数退避；测试可以注入 no-op sleep，不会触发真实网络等待。
 */
export function getRetryDelayMs(attempt: number): number {
  return DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}

/**
 * 执行带上限的生成重试，并只对网络错误、429 和 5xx 继续尝试。
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      return { value: await operation(), attempts };
    } catch (error) {
      if (attempts >= maxAttempts || !isRetryableGenerationError(error)) throw error;
      const nextAttempt = attempts + 1;
      options.onRetry?.(error, nextAttempt);
      await sleep(getRetryDelayMs(attempts));
    }
  }

  throw new Error("Image generation retry loop ended unexpectedly.");
}

/**
 * 原子保存图片：先在目标目录写临时文件，成功后再替换目标，失败时清理临时文件。
 */
export async function saveImageAtomically(bytes: Uint8Array, outputPath: string): Promise<void> {
  if (bytes.length === 0) throw new Error("Image provider returned an empty image.");

  const directory = path.dirname(outputPath);
  await ensureDir(directory);
  const temporaryPath = path.join(
    directory,
    "." + path.basename(outputPath) + "." + randomUUID() + ".tmp",
  );

  try {
    await writeFile(temporaryPath, bytes);
    try {
      await rename(temporaryPath, outputPath);
    } catch (error) {
      // Windows 可能拒绝直接覆盖已存在目标；仍先完成临时写入，再做可恢复的替换。
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(outputPath, { force: true });
      await rename(temporaryPath, outputPath);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 将 batch.json 的相对路径解析到 batch 文件目录，绝不相对当前进程工作目录漂移。
 */
export function resolveBatchPath(batchDirectory: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(batchDirectory, value);
}

/**
 * 解析批处理参考图路径；本地路径相对 batch.json，HTTP(S)/Data URL 必须原样保留。
 */
export function resolveBatchReference(batchDirectory: string, value: string): string {
  return validateReferenceImageSource(value) === "local"
    ? resolveBatchPath(batchDirectory, value)
    : value;
}

/**
 * 读取数组或 tasks/jobs 对象形式的批量文件，并返回路径解析所需的目录。
 */
export async function loadBatchTasks(batchFilePath: string): Promise<{
  tasks: BatchTaskInput[];
  jobs: number | null;
  batchDir: string;
}> {
  const absolutePath = path.resolve(batchFilePath);
  const raw = await readFile(absolutePath, "utf8");
  let parsed: BatchFile;
  try {
    parsed = JSON.parse(raw) as BatchFile;
  } catch {
    throw new Error(`Invalid batch JSON: ${batchFilePath}`);
  }

  const tasks = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? parsed.tasks
      : null;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("Batch file must contain a non-empty tasks array.");
  }
  if (tasks.some((task) => !task || typeof task !== "object")) {
    throw new Error("Each batch task must be a JSON object.");
  }

  const rawJobs = Array.isArray(parsed) ? null : parsed.jobs ?? null;
  if (rawJobs !== null && (!Number.isSafeInteger(rawJobs) || rawJobs < 1)) {
    throw new Error(`Invalid batch jobs value: ${rawJobs}`);
  }
  return { tasks, jobs: rawJobs, batchDir: path.dirname(absolutePath) };
}

/**
 * 把一个 batch 任务映射成 CLI 参数；全局 CLI 值优先，任务值只填补未指定的全局选项。
 */
export function createTaskArgs(
  baseArgs: CliArgs,
  task: BatchTaskInput,
  batchDirectory: string,
): CliArgs {
  const result: CliArgs = {
    ...baseArgs,
    promptFiles: [...baseArgs.promptFiles],
    referenceImages: [...baseArgs.referenceImages],
  };
  const taskPromptFiles = task.promptFiles ?? task.promptfiles;

  if (!baseArgs.prompt && baseArgs.promptFiles.length === 0) {
    result.prompt = task.prompt ?? null;
    result.promptFiles = taskPromptFiles?.map((filePath) => resolveBatchPath(batchDirectory, filePath)) ?? [];
  }
  if (baseArgs.imagePath === null && task.image) {
    result.imagePath = resolveBatchPath(batchDirectory, task.image);
  }
  if (baseArgs.provider === null && task.provider !== undefined) result.provider = task.provider;
  if (baseArgs.model === null && task.model !== undefined) result.model = task.model;
  if (baseArgs.aspectRatio === null && task.ar !== undefined) result.aspectRatio = task.ar;
  if (baseArgs.size === null && task.size !== undefined) result.size = task.size;
  if (baseArgs.quality === null && task.quality !== undefined) result.quality = task.quality;
  if (baseArgs.resolution === null && task.resolution !== undefined) result.resolution = task.resolution;
  if (baseArgs.retryPolicy === null && task.retryPolicy !== undefined) {
    result.retryPolicy = task.retryPolicy === null
      ? null
      : parseRetryPolicy(String(task.retryPolicy), "batch retryPolicy");
  }
  if (baseArgs.referenceImages.length === 0 && task.ref !== undefined) {
    result.referenceImages = task.ref.map((source) => resolveBatchReference(batchDirectory, source));
  }

  return result;
}

/**
 * 返回任务并发数，确保 jobs 不会超过任务数量且始终至少有一个 worker。
 */
export function getWorkerCount(
  taskCount: number,
  jobs: number | null,
  defaultJobs = DEFAULT_BATCH_JOBS,
): number {
  if (taskCount <= 0) return 0;
  const requested = jobs ?? defaultJobs;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(`Invalid worker count: ${requested}`);
  }
  return Math.max(1, Math.min(taskCount, requested));
}

/**
 * 通用有界并发执行器；按输入顺序收集结果，worker 的异常会交给调用方决定是否隔离。
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  jobs: number | null,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = getWorkerCount(items.length, jobs);

  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/**
 * 在 provider 和模型确定后准备任务，统一完成提示词、参考图、尺寸和输出路径校验。
 */
async function prepareTask(
  id: string,
  args: CliArgs,
  config: Partial<ExtendConfig>,
): Promise<PreparedTask> {
  const provider = detectProvider(args);
  const providerModule = PROVIDERS[provider];
  const model = resolveModel(provider, args, config);
  const effectiveArgs: CliArgs = {
    ...args,
    quality: args.quality ?? DEFAULT_QUALITY,
    retryPolicy: args.retryPolicy ?? "manual",
    resolution: args.resolution === null ? null : validateResolution(String(args.resolution)),
  };
  if (effectiveArgs.quality !== "normal" && effectiveArgs.quality !== "2k") {
    throw new Error("Invalid task quality. Expected normal or 2k.");
  }
  if (effectiveArgs.retryPolicy !== "manual" && effectiveArgs.retryPolicy !== "once") {
    throw new Error("Invalid task retry policy. Expected manual or once.");
  }

  providerModule.validateArgs?.(model, effectiveArgs);
  await validateReferenceImages(effectiveArgs.referenceImages);
  const prompt = await readPrompt(effectiveArgs);
  if (!effectiveArgs.imagePath) {
    throw new Error("--image is required in single-image mode and for every batch task.");
  }

  // 再次解析尺寸，确保来自 batch.json 或环境配置的值也走同一校验路径。
  resolveImageSize(
    effectiveArgs.size,
    effectiveArgs.aspectRatio,
    effectiveArgs.quality ?? DEFAULT_QUALITY,
    effectiveArgs.resolution,
  );
  const outputPath = normalizeOutputImagePath(
    effectiveArgs.imagePath,
    providerModule.getDefaultOutputExtension?.() ?? ".png",
  );

  return { id, prompt, args: effectiveArgs, provider, model, outputPath, providerModule };
}

/**
 * 执行已准备任务；生成只在可重试错误上重试，保存失败不会重复调用远端 API。
 */
async function executePreparedTask(task: PreparedTask): Promise<TaskResult> {
  let attempts = 0;
  try {
    const generated = await withRetry(
      () => {
        attempts += 1;
        return task.providerModule.generateImage(task.prompt, task.model, task.args);
      },
      {
        maxAttempts:
          task.args.retryPolicy === "once"
            ? EXPLICIT_RETRY_MAX_ATTEMPTS
            : DEFAULT_MAX_ATTEMPTS,
        onRetry: (error, nextAttempt) => {
          console.error(
            "[" + task.id + "] 即将进行第 " + nextAttempt + " 次请求；上一次失败请求可能已经产生费用：" +
              safeErrorMessage(error),
          );
        },
      },
    );
    await saveImageAtomically(generated.value, task.outputPath);
    return {
      id: task.id,
      provider: task.provider,
      model: task.model,
      outputPath: task.outputPath,
      success: true,
      attempts: generated.attempts,
      error: null,
    };
  } catch (error) {
    return {
      id: task.id,
      provider: task.provider,
      model: task.model,
      outputPath: task.outputPath,
      success: false,
      attempts,
      error: safeErrorMessage(error),
    };
  }
}

/**
 * 隔离单个批量任务的准备错误和生成错误，保证其他任务继续运行。
 */
async function executeTask(
  id: string,
  args: CliArgs,
  config: Partial<ExtendConfig>,
): Promise<TaskResult> {
  try {
    const prepared = await prepareTask(id, args, config);
    return executePreparedTask(prepared);
  } catch (error) {
    return {
      id,
      provider: args.provider,
      model: args.model,
      outputPath: args.imagePath ?? "",
      success: false,
      attempts: 0,
      error: safeErrorMessage(error),
    };
  }
}

/**
 * 执行单图模式并返回结构化结果；命令行输出由外层 main 根据 --json 决定。
 */
async function runSingle(args: CliArgs, config: Partial<ExtendConfig>): Promise<SingleExecution> {
  const prepared = await prepareTask("image", args, config);
  const result = await executePreparedTask(prepared);
  if (!result.success) throw new Error(result.error ?? "Image generation failed.");
  return { mode: "single", result };
}

/**
 * 执行批量模式；每个任务拥有独立结果和错误，jobs 只限制同时进行的任务数量。
 */
async function runBatch(args: CliArgs, config: Partial<ExtendConfig>): Promise<BatchExecution> {
  if (!args.batchFile) throw new Error("--batchfile is required for batch mode.");
  if (args.imagePath !== null) {
    throw new Error("--image cannot be used with --batchfile; set a distinct image path on every batch task.");
  }
  const loaded = await loadBatchTasks(args.batchFile);
  const results = await runWithConcurrency(
    loaded.tasks,
    args.jobs ?? loaded.jobs,
    (task, index) => {
      const taskId = (typeof task.id === "string" ? task.id.trim() : "") || "task-" + (index + 1);
      try {
        const taskArgs = mergeConfig(createTaskArgs(args, task, loaded.batchDir), config);
        return executeTask(taskId, taskArgs, config);
      } catch (error) {
        const outputPath = typeof task.image === "string"
          ? resolveBatchPath(loaded.batchDir, task.image)
          : args.imagePath ?? "";
        return Promise.resolve({
          id: taskId,
          provider: task.provider ?? args.provider,
          model: task.model ?? args.model,
          outputPath,
          success: false,
          attempts: 0,
          error: safeErrorMessage(error),
        });
      }
    },
  );
  return { mode: "batch", results };
}

/**
 * 运行 Skill 的可测试入口：加载环境和配置后选择单图或批量流程，但不直接打印结果。
 */
export async function execute(
  argv: string[] = process.argv.slice(2),
  options: ExecutionOptions = {},
): Promise<ExecutionResult | { mode: "help" }> {
  const args = parseArgs(argv);
  if (args.help) return { mode: "help" };

  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  await loadEnv(cwd, home);
  const config = await loadExtendConfig(cwd, home);
  if (args.batchFile) {
    args.batchFile = path.isAbsolute(args.batchFile)
      ? args.batchFile
      : path.resolve(cwd, args.batchFile);
    return runBatch(args, config);
  }
  const merged = mergeConfig(args, config);
  return runSingle(merged, config);
}

/**
 * 输出单图或批量结果；批量部分失败时设置非零退出码但仍保留已成功文件。
 */
function printExecutionResult(result: ExecutionResult, json: boolean): void {
  if (result.mode === "single") {
    if (json) {
      console.log(JSON.stringify({ ...result.result, savedImage: result.result.outputPath }, null, 2));
    } else {
      console.log(result.result.outputPath);
    }
    return;
  }

  const succeeded = result.results.filter((item) => item.success).length;
  const failed = result.results.length - succeeded;
  console.error(
    "Batch complete: " + result.results.length + " total, " + succeeded + " succeeded, " + failed + " failed.",
  );
  if (failed > 0) {
    for (const item of result.results.filter((entry) => !entry.success)) {
      console.error("- " + item.id + ": " + item.error);
    }
    process.exitCode = 1;
  }
  if (json) {
    console.log(
      JSON.stringify(
        { mode: "batch", total: result.results.length, succeeded, failed, results: result.results },
        null,
        2,
      ),
    );
  }
}

/**
 * 判断当前文件是否由命令行直接执行，避免测试导入 main.ts 时触发真实 API 调用。
 */
function isDirectExecution(metaUrl: string): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return path.resolve(entryPath) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) {
  execute()
    .then((result) => {
      if (result.mode === "help") {
        printUsage();
        return;
      }
      const args = parseArgs(process.argv.slice(2));
      printExecutionResult(result, args.json);
    })
    .catch((error) => {
      console.error(safeErrorMessage(error));
      process.exit(1);
    });
}
