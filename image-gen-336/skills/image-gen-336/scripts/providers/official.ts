import { resolveImageSize } from "../size.ts";
import {
  appendReferenceImages,
  getReferenceMimeType,
} from "../reference-images.ts";
import type { CliArgs } from "../types.ts";
import {
  ImageGenerationError as GenerationError,
  isSafetyPolicyRejection,
  safeResponseSnippet,
} from "../types.ts";

export const OFFICIAL_BASE_URL = "https://api.openai.com/v1";

type OpenAIImageResponse = {
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
 * 返回官方 provider 的内置默认模型；模型覆盖由 CLI 或 EXTEND.md 提供。
 */
export function getDefaultModel(): string {
  return "gpt-image-2";
}

/**
 * 官方接口生成的图片默认以 PNG 保存；用户显式提供扩展名时由主流程保留该扩展名。
 */
export function getDefaultOutputExtension(): string {
  return ".png";
}

/**
 * 在网络请求前校验官方模型与参考图组合，避免把已知不支持的 edits 请求静默降级成文生图。
 */
export function validateArgs(model: string, args: CliArgs): void {
  resolveImageSize(args.size, args.aspectRatio, args.quality ?? "2k", args.resolution);

  if (args.referenceImages.length > 0 && model.toLowerCase().includes("dall-e")) {
    throw new Error(
      "Reference images require an OpenAI GPT Image model; DALL-E models are not supported for this image[] edit flow.",
    );
  }
}

/**
 * 生成一张图片并统一返回字节；参考图存在时切换到官方 `/images/edits`。
 * 缺少 OPENAI_API_KEY 会立即失败，且不会把 Codex OAuth 当作 API key 使用。
 */
export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for the official provider. Codex/ChatGPT OAuth is not an OpenAI Images API key.",
    );
  }

  const size = resolveImageSize(args.size, args.aspectRatio, args.quality ?? "2k", args.resolution);
  if (args.referenceImages.length > 0) {
    return generateEdit(prompt, model, size, args.referenceImages, apiKey);
  }

  const response = await fetch(`${OFFICIAL_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildGenerationsBody(prompt, model, size)),
  });

  return parseImageResponse(response, "Official Images API", apiKey);
}

/**
 * 构造官方 generations 请求体，只包含官方 Images API 确定支持的字段。
 * `--quality` 已在 size 换算阶段生效，因此不会发送不确定的自定义 quality 字段。
 */
export function buildGenerationsBody(
  prompt: string,
  model: string,
  size: string,
): ImageRequestBody {
  return { model, prompt, size };
}

/**
 * 将本地路径、HTTP(S) URL 或 Data URL 统一包装成 multipart edits 请求。
 */
async function generateEdit(
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

  const response = await fetch(`${OFFICIAL_BASE_URL}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  return parseImageResponse(response, "Official Images edits API", apiKey);
}

/**
 * 根据扩展名设置 multipart 的 MIME 类型；未知扩展名不会被调用方接受，但这里仍提供 PNG 兜底。
 */
export function getMimeType(filename: string): string {
  return getReferenceMimeType(filename);
}

/**
 * 读取 JSON 响应并统一提取首张图片；HTTP 429/5xx 标记为可重试，其余状态不重试。
 */
async function parseImageResponse(
  response: Response,
  label: string,
  apiKey: string,
): Promise<Uint8Array> {
  const bodyText = await response.text();
  if (!response.ok) {
    throw new GenerationError(
      `${label} error (${response.status}): ${safeResponseSnippet(bodyText, [apiKey])}`,
      {
        status: response.status,
        retryable:
          !isSafetyPolicyRejection(bodyText) &&
          (response.status === 429 || response.status >= 500),
      },
    );
  }

  let result: OpenAIImageResponse;
  try {
    result = JSON.parse(bodyText) as OpenAIImageResponse;
  } catch {
    throw new GenerationError(
      `${label} returned invalid JSON (HTTP ${response.status}): ${safeResponseSnippet(bodyText, [apiKey])}`,
    );
  }

  return extractImageFromResponse(result, [apiKey]);
}

/**
 * 把 provider 响应中的 base64 或远程 URL 转成 Uint8Array，主流程无需了解响应格式。
 */
export async function extractImageFromResponse(
  result: OpenAIImageResponse,
  secrets: readonly string[] = [],
): Promise<Uint8Array> {
  const image = result.data?.[0];
  if (image?.b64_json) {
    return Uint8Array.from(Buffer.from(image.b64_json, "base64"));
  }

  if (image?.url) {
    return downloadImage(image.url, secrets);
  }

  throw new GenerationError("Official Images API returned no image data.");
}

/**
 * 下载 URL 响应并拒绝空内容或 HTTP 错误；下载错误带状态信息以便主流程正确重试。
 */
async function downloadImage(url: string, secrets: readonly string[]): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GenerationError("Official Images API returned an invalid image URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GenerationError("Official Images API returned an unsupported image URL scheme.");
  }

  const response = await fetch(parsed);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new GenerationError(
      `Official image download error (${response.status}): ${safeResponseSnippet(bodyText, secrets)}`,
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
    throw new GenerationError("Official image download returned an empty body.");
  }
  return bytes;
}
