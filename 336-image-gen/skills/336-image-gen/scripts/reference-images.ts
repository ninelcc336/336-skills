import path from "node:path";
import { readFile } from "node:fs/promises";

import { ImageGenerationError, safeResponseSnippet } from "./types.ts";

export const REFERENCE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export type ReferenceImageKind = "local" | "url" | "data_url";

export type PreparedReferenceImage = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
};

/**
 * 判断参考图来源并校验其协议、格式和 Data URL 头部；不会访问远程 URL。
 * 远程图片的可用性和大小在真正发起生成请求前由 `loadReferenceImage` 再次检查。
 */
export function validateReferenceImageSource(source: string): ReferenceImageKind {
  const value = source.trim();
  if (!value) throw new Error("Reference image must not be empty.");

  if (/^data:/i.test(value)) {
    parseDataUrl(value);
    return "data_url";
  }

  if (/^https?:\/\//i.test(value)) {
    validateHttpUrl(value);
    return "url";
  }

  // Windows 盘符形如 `C:\\path`，不要把它误判成带 scheme 的 URL。
  if (/^[a-z]:[\\/]/i.test(value)) return "local";

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error("Reference image URL must use HTTP(S) or a base64 image Data URL.");
  }

  const extension = path.extname(value).toLowerCase();
  if (!REFERENCE_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported reference image extension: ${value}. Use PNG, JPG, JPEG, WEBP, or GIF, or provide an HTTP(S)/Data URL.`,
    );
  }
  return "local";
}

/**
 * 根据文件名或响应 MIME 类型选择 multipart 文件类型；只允许当前 skill 可处理的图片格式。
 */
export function getReferenceMimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

/**
 * 将所有参考图统一加载成字节并追加为 `image[]`，让官方 API 和兼容 relay 走同一套 edits 语义。
 * URL 在 agent 所在环境下载，Data URL 在本地解码；因此不会把超长 base64 内容写入日志。
 */
export async function appendReferenceImages(
  form: FormData,
  sources: readonly string[],
): Promise<void> {
  for (let index = 0; index < sources.length; index += 1) {
    const image = await loadReferenceImage(sources[index]!, index + 1);
    form.append("image[]", new Blob([image.bytes], { type: image.mimeType }), image.filename);
  }
}

/**
 * 加载本地图片、HTTP(S) 图片或 Data URL，并限制大小及 MIME 类型，避免无界上传。
 */
export async function loadReferenceImage(
  source: string,
  index = 1,
): Promise<PreparedReferenceImage> {
  const kind = validateReferenceImageSource(source);
  if (kind === "data_url") {
    const parsed = parseDataUrl(source.trim());
    ensureReferenceImageSize(parsed.bytes.length);
    return {
      bytes: parsed.bytes,
      filename: `reference-${index}${MIME_TO_EXTENSION[parsed.mimeType]}`,
      mimeType: parsed.mimeType,
    };
  }

  if (kind === "url") return loadRemoteReferenceImage(source.trim(), index);

  const bytes = new Uint8Array(await readFile(source));
  ensureReferenceImageSize(bytes.length);
  const filename = path.basename(source);
  return { bytes, filename, mimeType: getReferenceMimeType(filename) };
}

/**
 * 解析图片 Data URL；为避免误把文本或任意协议当成图片，只接受支持的 MIME 和 base64 编码。
 */
export function parseDataUrl(value: string): { bytes: Uint8Array; mimeType: string } {
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (!match) {
    throw new Error("Reference Data URL must be a base64-encoded PNG, JPEG, WEBP, or GIF image.");
  }

  const mimeType = normalizeImageMimeType(match[1]!);
  if (!mimeType) {
    throw new Error("Reference Data URL must use PNG, JPEG, WEBP, or GIF MIME type.");
  }

  let encoded: string;
  try {
    encoded = decodeURIComponent(match[2]!).replace(/\s/g, "");
  } catch {
    throw new Error("Reference Data URL contains invalid percent encoding.");
  }
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Reference Data URL contains invalid base64 data.");
  }

  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (bytes.length === 0) throw new Error("Reference Data URL contains an empty image.");
  return { bytes, mimeType };
}

/**
 * 校验远程图片地址不携带 URL 用户名或密码；签名查询参数允许存在，因为 CDN 常用它们鉴权。
 */
function validateHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Reference image URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reference image URL must use HTTP(S).");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Reference image URL must not contain embedded credentials.");
  }
  return parsed;
}

/**
 * 下载远程参考图并把响应转换为 multipart 文件；非图片响应和超大响应在生成前失败。
 */
async function loadRemoteReferenceImage(
  source: string,
  index: number,
): Promise<PreparedReferenceImage> {
  const parsed = validateHttpUrl(source);
  const response = await fetch(parsed);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new ImageGenerationError(
      `Reference image URL returned HTTP ${response.status}: ${safeResponseSnippet(bodyText)}`,
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("Reference image URL response exceeds the 20 MB limit.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  ensureReferenceImageSize(bytes.length);
  const responseMime = normalizeImageMimeType(response.headers.get("content-type")?.split(";", 1)[0] || "");
  const extensionMime = getMimeTypeFromUrlPath(parsed.pathname);
  if (response.headers.has("content-type") && !responseMime) {
    throw new Error("Reference image URL must return a PNG, JPEG, WEBP, or GIF image.");
  }
  const mimeType = responseMime || extensionMime;
  if (!mimeType) {
    throw new Error("Reference image URL must include a supported image MIME type or file extension.");
  }

  const filename = getRemoteFilename(parsed, mimeType, index);
  return { bytes, filename, mimeType };
}

/**
 * 统一 JPEG 的非标准别名，并拒绝 SVG 等当前输出流程无法可靠处理的图片格式。
 */
function normalizeImageMimeType(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return MIME_TO_EXTENSION[normalized] ? normalized : null;
}

function getMimeTypeFromUrlPath(urlPath: string): string | null {
  const extension = path.extname(urlPath).toLowerCase();
  if (!REFERENCE_IMAGE_EXTENSIONS.has(extension)) return null;
  return getReferenceMimeType(urlPath);
}

function getRemoteFilename(parsed: URL, mimeType: string, index: number): string {
  const rawName = path.basename(parsed.pathname);
  let filename = "";
  try {
    filename = decodeURIComponent(rawName);
  } catch {
    filename = rawName;
  }
  if (
    !filename ||
    filename === "." ||
    filename === "/" ||
    !path.extname(filename) ||
    getMimeTypeFromUrlPath(filename) !== mimeType
  ) {
    filename = `reference-${index}${MIME_TO_EXTENSION[mimeType]}`;
  }
  return filename;
}

function ensureReferenceImageSize(size: number): void {
  if (size <= 0) throw new Error("Reference image is empty.");
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("Reference image must not exceed 20 MB.");
  }
}
