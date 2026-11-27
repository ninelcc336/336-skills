import { resolveImageSize } from "../size.ts";
import {
  appendReferenceImages,
  getReferenceMimeType,
} from "../reference-images.ts";
import type { CliArgs } from "../types.ts";
import { ImageGenerationError, isSafetyPolicyRejection, safeResponseSnippet } from "../types.ts";

export const DEFAULT_RELAY_DIALECT: string = "openai-images";

type RelayImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
};

type ImageRequestBody = {
  model: string;
  prompt: string;
  size: string;
};

/**
 * 返回 relay provider 的内置默认模型；模型覆盖由 CLI 或 EXTEND.md 提供。
 */
export function getDefaultModel(baseUrl?: string | null): string {
  if (baseUrl) {
    const { hostname } = new URL(normalizeRelayBaseUrl(baseUrl));
    if (hostname === "www.katuai.cn" || hostname === "katuai.cn") return "gpt-image-2.6-sunburst";
  }
  return "gpt-image-2";
}

/**
 * relay 默认也以 PNG 保存，输出路径的显式扩展名仍由主流程负责保留。
 */
export function getDefaultOutputExtension(): string {
  return ".png";
}

/**
 * 校验 relay 目前支持的 dialect 和已知的参考图限制，未知协议必须显式扩展 provider。
 */
export function validateArgs(model: string, args: CliArgs): void {
  const dialect = args.relayDialect ?? DEFAULT_RELAY_DIALECT;
  if (dialect !== DEFAULT_RELAY_DIALECT) {
    throw new Error(
      `Unsupported relay dialect: ${dialect}. This Skill only supports the openai-images dialect; add a separate provider for another protocol.`,
    );
  }

  resolveImageSize(args.size, args.aspectRatio, args.quality ?? "2k", args.resolution);
  if (args.referenceImages.length > 0 && model.toLowerCase().includes("dall-e")) {
    throw new Error(
      "Reference images require a relay model that supports OpenAI Images edits; this known DALL-E model is not accepted.",
    );
  }
}

/**
 * 调用 OpenAI Images 兼容 relay，并把 generations/edits 的响应统一转换为图片字节。
 * relay 地址只来自 CLI 或 EXTEND.md，API key 只来自 IMAGE_RELAY_API_KEY。
 */
export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const apiKey = process.env.IMAGE_RELAY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("IMAGE_RELAY_API_KEY is required for the relay provider.");
  }

  const dialect = args.relayDialect ?? DEFAULT_RELAY_DIALECT;
  if (dialect !== DEFAULT_RELAY_DIALECT) {
    throw new Error(
      `Unsupported relay dialect: ${dialect}. This Skill only supports openai-images and will not guess another protocol.`,
    );
  }

  const configuredBaseUrl = args.relayBaseUrl?.trim();
  if (!configuredBaseUrl) {
    throw new Error("relay.base_url in EXTEND.md is required for the relay provider.");
  }

  const baseUrl = normalizeRelayBaseUrl(configuredBaseUrl);
  const size = resolveImageSize(args.size, args.aspectRatio, args.quality ?? "2k", args.resolution);
  if (args.referenceImages.length > 0) {
    return generateEdit(baseUrl, prompt, model, size, args.referenceImages, apiKey);
  }

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildGenerationsBody(prompt, model, size)),
  });

  return parseImageResponse(response, "Relay Images API", apiKey);
}

/**
 * 将 relay 地址归一化为不带尾斜杠且恰好包含 `/v1` 的 base URL。
 * 只接受 HTTP(S)，并拒绝 URL 用户名、密码、查询串和 hash，避免凭据进入请求地址或日志。
 */
export function normalizeRelayBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("relay.base_url must not be empty.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("relay.base_url must be a valid HTTP(S) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("relay.base_url must be an HTTP(S) URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("relay.base_url must not contain credentials, query parameters, or a hash.");
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname) pathname = "/v1";
  else if (!/(?:^|\/)v1$/i.test(pathname)) pathname = `${pathname}/v1`;

  return `${url.origin}${pathname}`;
}

/**
 * 构造 relay 的 generations 请求体，保持与 OpenAI Images API 的最小兼容字段集合一致。
 */
export function buildGenerationsBody(
  prompt: string,
  model: string,
  size: string,
): ImageRequestBody {
  return { model, prompt, size };
}

/**
 * 通过 multipart 的 `image[]` 字段发送所有参考图；URL/Data URL 会先在 agent 环境转换为文件。
 */
async function generateEdit(
  baseUrl: string,
  prompt: string,
  model: string,
  size: string,
  referenceImages: string[],
  apiKey: string,
): Promise<Uint8Array> {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);

  await appendReferenceImages(form, referenceImages);

  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  return parseImageResponse(response, "Relay Images edits API", apiKey);
}

/**
 * 根据本地参考图扩展名选择 MIME 类型，避免把图片文件内容以文本方式处理。
 */
export function getMimeType(filename: string): string {
  return getReferenceMimeType(filename);
}

/**
 * 解析 relay 的 HTTP 响应并统一处理状态错误、无效 JSON 和图片数据缺失。
 */
async function parseImageResponse(
  response: Response,
  label: string,
  apiKey: string,
): Promise<Uint8Array> {
  const bodyText = await response.text();
  if (!response.ok) {
    throw new ImageGenerationError(
      `${label} error (${response.status}): ${safeResponseSnippet(bodyText, [apiKey])}`,
      {
        status: response.status,
        retryable:
          !isSafetyPolicyRejection(bodyText) &&
          (response.status === 429 || response.status >= 500),
      },
    );
  }

  let result: RelayImageResponse;
  try {
    result = JSON.parse(bodyText) as RelayImageResponse;
  } catch {
    throw new ImageGenerationError(
      `${label} returned invalid JSON (HTTP ${response.status}): ${safeResponseSnippet(bodyText, [apiKey])}`,
    );
  }

  try {
    return await extractImageFromResponse(result, [apiKey]);
  } catch (error) {
    // 下载 URL 时的网络错误必须原样交给主流程，否则会被误判为不可重试的 JSON 错误。
    if (!(error instanceof ImageGenerationError)) throw error;
    if (error.status !== null || error.retryable) throw error;
    throw new ImageGenerationError(
      `${label} returned unexpected JSON (HTTP ${response.status}): ${safeResponseSnippet(bodyText, [apiKey])}`,
    );
  }
}

/**
 * 提取 relay 返回的首张 base64 图片，或下载其 URL，并始终返回 Uint8Array。
 */
export async function extractImageFromResponse(
  result: RelayImageResponse,
  secrets: readonly string[] = [],
): Promise<Uint8Array> {
  const image = result.data?.[0];
  if (image?.b64_json) {
    return Uint8Array.from(Buffer.from(image.b64_json, "base64"));
  }

  if (image?.url) {
    return downloadImage(image.url, secrets);
  }

  throw new ImageGenerationError("Relay Images API returned no image data.");
}

/**
 * 下载 relay 返回的图片 URL；URL 本身不写入错误，响应正文也按同一脱敏策略截断。
 */
async function downloadImage(url: string, secrets: readonly string[]): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageGenerationError("Relay Images API returned an invalid image URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImageGenerationError("Relay Images API returned an unsupported image URL scheme.");
  }

  const response = await fetch(parsed);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new ImageGenerationError(
      `Relay image download error (${response.status}): ${safeResponseSnippet(bodyText, secrets)}`,
      {
        status: response.status,
        retryable:
          !isSafetyPolicyRejection(bodyText) &&
          (response.status === 429 || response.status >= 500),
      },
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new ImageGenerationError("Relay image download returned an empty body.");
  }
  return bytes;
}
