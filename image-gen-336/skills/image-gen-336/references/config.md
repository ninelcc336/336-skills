# 配置

## EXTEND.md 路径

脚本按以下顺序读取第一个存在的文件：

1. 项目：`.336-image-gen/EXTEND.md`
2. 用户目录：`~/.336/image-gen-336/EXTEND.md`

全局 `.env` 也放在 `~/.336/image-gen-336/`。如果某个全局配置文件尚未迁入，脚本会从旧目录 `~/.336-image-gen/` 读取同名文件。

只保存非敏感配置，包括 provider、模型、relay 地址/dialect、质量、分辨率、比例和默认像素尺寸。API key 不能写进 `EXTEND.md`。

推荐内容：

```yaml
---
version: 1
default_provider: official
default_quality: 2k
default_resolution: null
default_aspect_ratio: null
default_size: null
default_retry_policy: manual
default_model:
  official: null
  relay: null
relay:
  base_url: null
  dialect: openai-images
---
```

`relay.base_url` 可以写 `https://relay.example.com` 或 `https://relay.example.com/v1`，脚本会规范化成带一个 `/v1` 的地址。`relay.dialect` 当前只能是 `openai-images`。

## 优先级

图片参数优先级为：

`CLI 参数 > EXTEND.md > Skill 内置默认值`

分辨率通过 `default_resolution` 设置为 `1K`、`2K`、`4K`；图片比例通过 `default_aspect_ratio` 设置，例如 `1:1`、`16:9`、`9:16`；默认精确像素尺寸通过 `default_size` 设置。显式像素 `size` 优先于分辨率和比例；`512x512` 这类值仍可作为显式像素尺寸使用。重试策略通过 `default_retry_policy` 设置为 `manual` 或 `once`，默认建议使用 `manual`。

脚本进程中原本已经存在的 API key 不会被 `.env` 覆盖。模型解析优先级为：

`--model > default_model.<provider> > provider 内置默认值`

重试策略优先级为：

`--retry-once > batch.retryPolicy > EXTEND.md default_retry_policy > manual`

非敏感模型、地址和尺寸配置不从 `.env` 或环境变量读取。内置默认模型为 `gpt-image-2`。

## Provider 自动选择

- 只有 `OPENAI_API_KEY`：选择 `official`。
- 只有 `IMAGE_RELAY_API_KEY` 且 `EXTEND.md` 配置了 `relay.base_url`：选择 `relay`。
- 两套完整凭据都存在：必须显式传 `--provider official` 或 `--provider relay`。
- 只有 relay key：报缺少 `relay.base_url` 配置。
- 只有 `EXTEND.md` 中的 relay 地址：报缺少 `IMAGE_RELAY_API_KEY`。
- 没有完整凭据：错误会明确列出需要的变量名。

显式 `--provider` 只改变选择，不会替另一个 provider 猜测或借用凭据。例如 `--provider relay` 永远使用 `IMAGE_RELAY_API_KEY`，不会因为 `OPENAI_API_KEY` 存在而改走官方 API。

## 环境变量清单

| 变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 官方 Images API key，只能放在进程环境或 `.env`。 |
| `IMAGE_RELAY_API_KEY` | relay API key。 |

`.env` 只允许 `OPENAI_API_KEY` 和 `IMAGE_RELAY_API_KEY`。不要把模型、relay 地址、dialect、质量、分辨率、比例或尺寸写进 `.env`；也不要设置 `OPENAI_API_KEY` 来承载 Codex OAuth 或 ChatGPT 登录令牌。

费用安全设置不放在 `.env`：重试策略属于非敏感行为配置，应写入 `EXTEND.md` 的 `default_retry_policy`。
