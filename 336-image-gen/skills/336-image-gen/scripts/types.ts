/** 这个模块集中定义 CLI、配置文件、批处理和 provider 之间共享的数据契约。 */

export type Provider = "official" | "relay";
export type Quality = "normal" | "2k";
export type Resolution = "1k" | "2k" | "4k";
export type RelayDialect = "openai-images";
export type RetryPolicy = "manual" | "once";

export type CliArgs = {
  prompt: string | null;
  promptFiles: string[];
  imagePath: string | null;
  provider: Provider | null;
  model: string | null;
  aspectRatio: string | null;
  size: string | null;
  quality: Quality | null;
  resolution: Resolution | null;
  retryPolicy: RetryPolicy | null;
  referenceImages: string[];
  batchFile: string | null;
  jobs: number | null;
  json: boolean;
  help: boolean;
  relayBaseUrl: string | null;
  relayDialect: RelayDialect | null;
};

export type ExtendConfig = {
  version?: number;
  default_provider?: Provider | null;
  default_quality?: Quality | null;
  default_resolution?: Resolution | null;
  default_aspect_ratio?: string | null;
  default_size?: string | null;
  default_retry_policy?: RetryPolicy | null;
  default_model?: Partial<Record<Provider, string | null>>;
  relay?: {
    base_url?: string | null;
    dialect?: RelayDialect | null;
  };
};

export type BatchTaskInput = {
  id?: string;
  prompt?: string | null;
  promptFiles?: string[];
  promptfiles?: string[];
  image?: string | null;
  provider?: Provider | null;
  model?: string | null;
  ar?: string | null;
  size?: string | null;
  quality?: Quality | null;
  resolution?: Resolution | null;
  retryPolicy?: RetryPolicy | null;
  ref?: string[];
};

export type BatchFile =
  | BatchTaskInput[]
  | {
      tasks: BatchTaskInput[];
      jobs?: number | null;
    };

/**
 * 统一表示 HTTP provider 的错误，使主流程可以只按状态判断重试。
 * `retryable` 必须由产生错误的边界决定，参数、鉴权和响应解析错误不得被误重试。
 */
export class ImageGenerationError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "ImageGenerationError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * 清理错误和诊断文本中的凭据、认证头及图片 base64，避免 provider 的响应原文泄密。
 * 该函数不修改请求内容，只用于日志和面向用户的错误消息。
 */
export function redactSensitiveText(input: string, secrets: readonly string[] = []): string {
  let output = input;

  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.split(secret).join("[REDACTED]");
    }
  }

  output = output
    .replace(/"(?:b64_json|base64|data)"\s*:\s*"[^"]*"/gi, '"b64_json":"[REDACTED]"')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, "data:image/[REDACTED]")
    .replace(/Bearer\s+[^\s"'`,}]+/gi, "Bearer [REDACTED]")
    .replace(/Authorization\s*:\s*[^\r\n,}]+/gi, "Authorization: [REDACTED]")
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[REDACTED_BASE64]");

  return output;
}

/**
 * 将远端响应正文限制在可读长度内，并在截断前完成敏感信息清理。
 * 这样 429/5xx 的诊断仍保留状态和少量上下文，但不会把完整图片或密钥写入日志。
 */
export function safeResponseSnippet(
  input: string,
  secrets: readonly string[] = [],
  maxLength = 1200,
): string {
  const redacted = redactSensitiveText(input, secrets).trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}...[truncated]`;
}

/**
 * 判断 provider 的错误正文是否明确表示内容安全策略拦截；这类 500 是业务拒绝而非临时故障，禁止自动重试。
 */
export function isSafetyPolicyRejection(input: string): boolean {
  return /unsafe|safety|content[\s_-]*policy|policy\s+violation|generated images appear to be unsafe|安全策略|内容违规|不安全/i.test(input);
}
