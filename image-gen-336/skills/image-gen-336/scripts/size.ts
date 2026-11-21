import type { Quality, Resolution } from "./types.ts";

export type PixelSize = {
  width: number;
  height: number;
};

const SIZE_MULTIPLE = 16;
const MAX_ASPECT_RATIO = 3;

const SIZE_MATRIX: Record<string, Record<string, string>> = {
  "1k": {
    "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864",
    "9:16": "864x1536", "4:3": "1344x1008", "3:4": "1008x1344", "3:1": "2016x672",
    "1:3": "672x2016", "21:9": "1536x656", "9:21": "656x1536", "5:4": "1280x1024", "4:5": "1024x1280",
  },
  "2k": {
    "1:1": "2048x2048", "3:2": "2048x1360", "2:3": "1360x2048", "16:9": "2048x1152",
    "9:16": "1152x2048", "4:3": "2048x1536", "3:4": "1536x2048", "3:1": "3072x1024",
    "1:3": "1024x3072", "21:9": "2048x880", "9:21": "880x2048", "5:4": "2048x1648", "4:5": "1648x2048",
  },
  "4k": {
    "1:1": "2880x2880", "3:2": "3520x2352", "2:3": "2352x3520", "16:9": "3840x2160",
    "9:16": "2160x3840", "4:3": "3312x2480", "3:4": "2480x3312", "3:1": "3840x1280",
    "1:3": "1280x3840", "21:9": "3840x1648", "9:21": "1648x3840", "5:4": "3200x2560", "4:5": "2560x3200",
  },
};

/**
 * 解析正数宽高比；返回 null 代表输入不是可用于 API 的 `宽:高` 格式。
 * 宽高比只接受有限正数，并拒绝极端比例，避免换算出不被官方模型接受的尺寸。
 */
export function parseAspectRatio(value: string): { width: number; height: number } | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?):\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

/**
 * 校验显式像素尺寸，只负责通用的格式和正数约束；具体模型的额外限制由 provider 决定。
 * 失败时抛出带有原始参数的错误，调用方可以在 API 请求前终止任务。
 */
export function parsePixelSize(value: string): PixelSize | null {
  const match = value.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

/**
 * 将显式 `--size` 验证为规范字符串，防止未校验的值进入 generations 或 edits 请求。
 */
export function validatePixelSize(value: string): string {
  const parsed = parsePixelSize(value);
  if (!parsed) {
    throw new Error(`Invalid --size: ${value}. Expected a positive <width>x<height>.`);
  }
  return `${parsed.width}x${parsed.height}`;
}

/**
 * 解析 agent 常用的分辨率档位；只接受 1K、2K、4K。
 * 统一返回小写规范值，供 CLI、配置文件和批处理共享。
 */
export function parseResolution(value: string): Resolution | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1k" || normalized === "2k" || normalized === "4k") return normalized;
  return null;
}

/**
 * 校验并规范化分辨率档位，错误会在网络请求前抛出，避免将自然语言值传给 provider。
 */
export function validateResolution(value: string): Resolution {
  const resolution = parseResolution(value);
  if (!resolution) {
    throw new Error(`Invalid resolution: ${value}. Expected 1K, 2K, or 4K.`);
  }
  return resolution;
}

/**
 * 把宽高比转换成 16 像素对齐的官方 API 尺寸；quality 只影响目标长边，不会作为未知字段发送。
 */
export function sizeForAspectRatio(
  aspectRatio: string,
  quality: Quality,
  resolution: Resolution | null = null,
): string {
  const parsed = parseAspectRatio(aspectRatio);
  if (!parsed) {
    throw new Error(`Invalid --ar: ${aspectRatio}. Expected a positive ratio such as 16:9.`);
  }

  const ratio = parsed.width / parsed.height;
  if (Math.max(ratio, 1 / ratio) > MAX_ASPECT_RATIO) {
    throw new Error(`Invalid --ar: ${aspectRatio}. The aspect ratio must not exceed 3:1.`);
  }

  const normalizedRatio = `${parsed.width}:${parsed.height}`
    .replace(/\.0+(?=:|$)/g, "")
    .replace(/(\d+\.\d+):/g, (_, value: string) => String(Number(value)))
    .replace(/:(\d+\.\d+)$/g, (_, value: string) => `:${Number(value)}`);
  if (resolution) {
    const matrixSize = SIZE_MATRIX[resolution]?.[normalizedRatio];
    if (matrixSize) return matrixSize;
  }

  const longEdge = resolution
    ? resolutionLongEdge(resolution)
    : quality === "2k"
      ? 2048
      : 1024;
  let width: number;
  let height: number;

  if (ratio >= 1) {
    width = longEdge;
    height = Math.max(SIZE_MULTIPLE, Math.round((width / ratio) / SIZE_MULTIPLE) * SIZE_MULTIPLE);
  } else {
    height = longEdge;
    width = Math.max(SIZE_MULTIPLE, Math.round((height * ratio) / SIZE_MULTIPLE) * SIZE_MULTIPLE);
  }

  // 旧的 quality 换算保留 GPT Image 的最低像素约束；显式 resolution 必须保持服务商矩阵尺寸。
  while (!resolution && width * height < 655_360) {
    if (ratio >= 1) {
      width += SIZE_MULTIPLE;
      height = Math.max(SIZE_MULTIPLE, Math.round((width / ratio) / SIZE_MULTIPLE) * SIZE_MULTIPLE);
    } else {
      height += SIZE_MULTIPLE;
      width = Math.max(SIZE_MULTIPLE, Math.round((height * ratio) / SIZE_MULTIPLE) * SIZE_MULTIPLE);
    }
  }

  return `${width}x${height}`;
}

/**
 * 为未命中矩阵的自定义比例提供合理长边，已知比例仍由矩阵优先处理。
 */
function resolutionLongEdge(resolution: Resolution): number {
  if (resolution === "1k") return 1536;
  if (resolution === "2k") return 2048;
  return 3840;
}

/**
 * 按优先级解析最终请求尺寸：显式 size > aspect ratio + resolution > resolution 正方形 > quality 默认值。
 */
export function resolveImageSize(
  size: string | null,
  aspectRatio: string | null,
  quality: Quality,
  resolution: Resolution | null = null,
): string {
  if (size) return validatePixelSize(size);
  if (aspectRatio) return sizeForAspectRatio(aspectRatio, quality, resolution);
  if (resolution === "1k") return "1024x1024";
  if (resolution === "2k") return "2048x2048";
  if (resolution === "4k") return "2880x2880";
  return quality === "2k" ? "2048x2048" : "1024x1024";
}
