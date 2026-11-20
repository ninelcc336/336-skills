# 336 Image Gen

一个面向 Codex、Claude Code 等 agent 的轻量级图片生成 Skill，使用官方 OpenAI Images API 或兼容该 API 的 relay 生成和编辑图片。支持文生图、图生图、本地路径/HTTP(S) URL/Data URL 参考图、分辨率、图片比例、批量任务、有限并发以及费用安全的显式重试。

## 安装

将本目录作为独立 GitHub 仓库发布后，可以使用 Skills CLI 安装。当前仓库的命令是：

```bash
npx skills add ninelcc336/336-image-gen --skill 336-image-gen --global
```

如果使用的是自己的 fork，请将 `ninelcc336/336-image-gen` 替换为对应的 GitHub 仓库。

这条命令安装的是 Codex Skill，使 agent 能发现并使用它；它不会创建名为 `336-image-gen` 的全局 CLI 命令。用户明确指定本 Skill 后，agent 会在后台通过 Bun 或 `tsx` 执行内部脚本，用户不需要手动执行命令。

本地开发或直接从仓库运行：

```bash
bun skills/336-image-gen/scripts/main.ts --prompt "A quiet mountain lake" --image out/lake.png
```

如果没有 Bun：

```bash
npx -y tsx skills/336-image-gen/scripts/main.ts --prompt "A quiet mountain lake" --image out/lake.png
```

仓库结构与 `pen-design` 一致，根目录 README 不属于可安装 Skill：

```text
336-image-gen/
├── README.md
└── skills/
    └── 336-image-gen/
        ├── SKILL.md
        ├── agents/openai.yaml
        ├── references/
        └── scripts/
```

## 全局使用与项目级使用

Skill 的安装范围和 API 配置范围可以分别选择。全局安装适合在多个项目中复用；项目级安装适合只让某个项目使用，或让项目配置随项目一起管理。API key 都不应提交到 Git。

### 全局使用

在任意位置执行：

```bash
npx skills add ninelcc336/336-image-gen --skill 336-image-gen --global
```

全局安装后，Codex 或兼容 Skills 的 agent 可以在不同项目中发现这个 Skill。全局配置文件放在当前用户目录：

```text
%USERPROFILE%\.336-image-gen\.env
%USERPROFILE%\.336-image-gen\EXTEND.md
```

其中 `.env` 只保存 API key；relay 地址、模型和图片默认参数统一写入 `EXTEND.md`。例如全局 relay 配置可以写成：

```env
IMAGE_RELAY_API_KEY=<your-relay-api-key>
```

```yaml
---
default_provider: relay
default_retry_policy: manual
default_model:
  relay: relay-image-model
relay:
  base_url: https://relay.example.com
  dialect: openai-images
---
```

### 项目级使用

进入项目根目录后，不带 `--global` 安装：

```bash
npx skills add ninelcc336/336-image-gen --skill 336-image-gen
```

项目级配置放在该项目根目录：

```text
<项目根>\.336-image-gen\.env
<项目根>\.336-image-gen\EXTEND.md
```

项目 `.env` 示例：

```env
OPENAI_API_KEY=<your-openai-api-key>
```

或者使用 relay：

```env
IMAGE_RELAY_API_KEY=<your-relay-api-key>
```

relay 的非敏感配置放在同目录的 `EXTEND.md`，例如：

```yaml
---
default_provider: relay
default_model:
  relay: relay-image-model
relay:
  base_url: https://relay.example.com
  dialect: openai-images
---
```

从项目中使用时，项目级 `.env` 和 `EXTEND.md` 会优先于全局对应文件。Codex、Claude Code 等 agent 只要能读取 `SKILL.md` 并调用 Bun/tsx，就可以复用同一套执行器；不同 agent 的差异只在 Skill 的发现目录。

### Agent 使用方式

用户需要在请求中明确指定这个 Skill，例如：

```text
使用 336-image-gen，生成一张 2K、16:9 的电商主图，参考图使用这个 URL，并保存到项目素材目录。
```

普通的“生成图片”“修改图片”请求不会自动触发本 Skill。明确指定后，agent 从请求中提取 provider、模型、提示词、参考图、分辨率、比例和输出路径，在后台调用脚本，完成后返回生成文件，而不是把 CLI 命令交给用户。

### API 与 URL 对照

| 使用范围 | API key 文件 | relay URL 文件 |
| --- | --- | --- |
| 全局 | `%USERPROFILE%\.336-image-gen\.env` | `%USERPROFILE%\.336-image-gen\EXTEND.md` 的 `relay.base_url` |
| 项目级 | `<项目根>\.336-image-gen\.env` | `<项目根>\.336-image-gen\EXTEND.md` 的 `relay.base_url` |

`official` 始终使用 `https://api.openai.com/v1`，没有可配置的官方 base URL。`relay` 使用 `EXTEND.md` 中的 `relay.base_url`，地址可以带或不带 `/v1`，脚本会自动规范化。

## Provider

### official

- 固定使用 `https://api.openai.com/v1`。
- API key 使用 `OPENAI_API_KEY`。
- 默认模型来自 `EXTEND.md` 的 `default_model.official`，也可以通过 `--model` 指定。
- 没有参考图时调用 `/images/generations`，有参考图时调用 `/images/edits`。
- 参考图可为本地图片、HTTP(S) URL 或图片 Data URL；URL 会在 agent 环境下载，Data URL 会在本地解码。

### relay

- 地址来自 `EXTEND.md` 的 `relay.base_url`，脚本会自动规范化是否包含 `/v1`。
- API key 使用 `IMAGE_RELAY_API_KEY`，模型使用 `EXTEND.md` 的 `default_model.relay` 或内置默认模型。
- 默认 dialect 是 `openai-images`，必须兼容 OpenAI Images API 的 `/images/generations` 和 `/images/edits`。
- 响应需要提供 `data[0].b64_json` 或 `data[0].url`；URL 响应会由脚本下载后再保存。

不兼容 OpenAI Images API 的中转站不能直接套用本 Skill。不要猜测它的请求或响应协议，应新增独立 provider 或 dialect，并为认证、请求体、响应解析和参考图语义补充文档与测试。

## API key 与首次配置

首次使用时，应先确认：

1. 使用 `official` 还是 `relay`。
2. 使用哪个模型。
3. 如果使用 relay，中转站地址是什么。
4. 非敏感配置保存到当前项目还是用户目录。

API key 只能通过环境变量配置，不能直接贴到对话中，也不能写进 `EXTEND.md`。环境变量可以由启动进程提供，也可以写入不会提交到 Git 的 `.336-image-gen/.env` 文件。Codex OAuth 或 ChatGPT 登录令牌不是 `OPENAI_API_KEY`。

例如，使用官方 provider 时在当前 shell 配置：

```bash
export OPENAI_API_KEY="<your-openai-api-key>"
```

使用 relay 时配置：

```bash
export IMAGE_RELAY_API_KEY="<your-relay-api-key>"
```

Windows PowerShell 对应写法：

```powershell
$env:OPENAI_API_KEY = "<your-openai-api-key>"
$env:IMAGE_RELAY_API_KEY = "<your-relay-api-key>"
```

如果两套完整凭据同时存在，必须显式指定 `--provider official` 或 `--provider relay`，脚本不会静默选择。

## 内部执行示例

以下命令仅供 skill 维护者或 agent 调试执行器时使用；正常使用时由 agent 根据自然语言请求在后台构造参数，用户不需要手动执行命令。

单图：

```bash
bun skills/336-image-gen/scripts/main.ts \
  --provider official \
  --model gpt-image-2 \
  --prompt "A red fox in a snowy forest" \
  --image out/fox.png \
  --ar 16:9 \
  --quality 2k
```

使用一个或多个提示词文件：

```bash
bun skills/336-image-gen/scripts/main.ts \
  --prompt "Editorial illustration" \
  --promptfiles prompts/style.md prompts/lighting.md \
  --image out/editorial.png
```

参考图：

```bash
bun skills/336-image-gen/scripts/main.ts \
  --provider relay \
  --prompt "Keep the subject identity and change the background to a clean studio" \
  --ref refs/subject.png refs/style.jpg \
  --image out/studio.png
```

参考图支持本地 PNG、JPG、JPEG、WEBP、GIF 文件、HTTP(S) URL 和图片 Data URL。URL 会在 agent 环境下载，Data URL 会在本地解码；文件最终通过 `image[]` 字段发送到 edits 接口。单张参考图最大 20 MB，Katuai 图生图最多 6 张。

批量生成：

```json
{
  "jobs": 2,
  "tasks": [
    {
      "id": "cover",
      "prompt": "A blue editorial cover",
      "image": "out/cover.png",
      "provider": "official",
      "ar": "16:9"
    },
    {
      "id": "detail",
      "promptFiles": ["prompts/detail.md"],
      "image": "out/detail.png",
      "provider": "relay",
      "ref": ["refs/source.png"],
      "size": "1024x1024"
    }
  ]
}
```

保存为 `jobs/batch.json` 后执行：

```bash
bun skills/336-image-gen/scripts/main.ts --batchfile jobs/batch.json --jobs 2 --json
```

批量任务中的 `image`、`promptFiles` 和 `ref` 路径都相对 `batch.json` 所在目录解析。每个任务必须有自己的输出路径；任务会独立成功或失败，`--jobs` 只限制同时运行的任务数，最终有失败任务时进程返回非零状态。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--prompt <text>`、`-p` | 直接提供提示词。 |
| `--promptfiles <file...>` | 按顺序读取一个或多个提示词文件。 |
| `--image <path>` | 输出路径；父目录自动创建，没有扩展名时默认使用 `.png`。 |
| `--provider official\|relay` | 显式选择后端。 |
| `--model <id>`、`-m` | 指定模型。 |
| `--ar <ratio>`、`--aspect-ratio <ratio>` | 宽高比，例如 `1:1`、`16:9`、`9:16`、`4:3`。 |
| `--resolution <value>` | 分辨率档位：`1K`、`2K`、`4K`。 |
| `--size <WxH>` | 正整数像素尺寸，例如 `1024x1024`；优先于分辨率和比例。 |
| `--quality normal\|2k` | 旧版质量预设，默认值为 `2k`；显式 resolution 优先。 |
| `--ref <source...>` | 本地路径、HTTP(S) URL 或图片 Data URL；单张最大 20 MB。 |
| `--batchfile <path>` | 批量任务 JSON；也接受 `--batch`。 |
| `--jobs <count>` | 批量最大并发数，默认 `4`。 |
| `--retry-once` | 用户明确授权后最多额外发起一次远端请求。 |
| `--json` | 输出结构化 JSON。 |

每个请求只保存一张图片，不支持 `--n`。显式 `--size` 优先级最高；否则使用 `--resolution` 与比例换算尺寸。未指定时默认 2K 正方形。

## EXTEND.md 配置

可选配置文件路径如下，项目配置优先：

1. `.336-image-gen/EXTEND.md`
2. 用户目录下的 `.336-image-gen/EXTEND.md`

推荐格式：

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

`EXTEND.md` 只能保存非敏感配置。完整的配置优先级是：

`CLI 参数 > EXTEND.md > Skill 内置默认值`

模型的优先级是：

`--model > EXTEND.md default_model.<provider> > provider 内置默认值`

relay 的 `base_url` 可以写成带 `/v1` 或不带 `/v1` 的地址。当前 `dialect` 只能写 `openai-images`。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 官方 OpenAI Images API key，只能放在进程环境或 `.env`。 |
| `IMAGE_RELAY_API_KEY` | relay API key，只能放在进程环境或 `.env`。 |

自动选择 provider 时：只有 `OPENAI_API_KEY` 选择 `official`；只有 `IMAGE_RELAY_API_KEY` 且 `EXTEND.md` 配置了 `relay.base_url` 时选择 `relay`；两套凭据都存在时要求显式选择。缺少 relay 地址或 API key 时，错误会指出应配置的位置。

## 重试与安全行为

- 默认每个逻辑图片任务只发起一次远端生成请求。
- 只有用户明确要求重试时，agent 才能使用 `--retry-once`，最多额外发起一次请求；重试前必须告知用户失败请求可能已经产生费用。
- 安全策略拦截即使返回 HTTP 500 也永不重试；参数错误、HTTP 400、HTTP 401、HTTP 403 和其他 4xx 也不重试。
- agent 不得未经用户确认修改提示词后再次提交。
- relay 返回非预期 JSON 时，错误包含 HTTP 状态码和安全截断后的正文。
- 不在日志或错误中输出 API key、`Authorization` header、参考图内容或完整 base64 图片数据。
- 输出写入前创建父目录，并尽量通过临时文件和原子替换避免留下半截文件。

## 测试

测试使用 mock `fetch`，不会调用真实图片 API：

```bash
bun test skills/336-image-gen/scripts
```

测试覆盖参数解析、配置和 provider 选择、请求体与 multipart edits、relay 的 base64/URL 响应、重试规则、参考图校验、批量路径和并发限制以及敏感信息脱敏。

详细参数、批量格式和 provider 约束见：

- [使用说明](skills/336-image-gen/references/usage.md)
- [配置说明](skills/336-image-gen/references/config.md)
- [官方 provider](skills/336-image-gen/references/providers/official.md)
- [relay provider](skills/336-image-gen/references/providers/relay.md)
