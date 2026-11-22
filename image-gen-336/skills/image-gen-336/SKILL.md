---
name: image-gen-336
description: 仅在用户明确指定 image-gen-336 或要求使用本 Skill 时调用；使用官方 OpenAI Images API 或兼容 relay 生成和编辑图片，支持文生图、图生图、参考图、1K/2K/4K 分辨率和图片比例。
---

# Image Gen 336

只有当用户在当前请求中明确写出 `image-gen-336`、`$image-gen-336`、"使用这个 Skill"或等价的指定调用意图时，才使用本 Skill。普通的“生成图片”“修改图片”或“用参考图作图”请求不得自动触发本 Skill；应等待用户明确指定。指定后，agent 负责解析参数、调用内部执行器、保存产物并返回文件路径。

## Agent 使用契约

1. 只有收到明确指定调用后，才在后台调用本目录的 `scripts/main.ts`；命令行参数只是内部实现细节，不要求用户手动拼接或执行命令。
2. 从自然语言中提取提示词、provider、模型、参考图、分辨率、图片比例和输出位置。用户说“竖图/横图/方图”时分别映射为常用比例 `9:16`、`16:9`、`1:1`。
3. 用户指定“1K、2K、4K”时使用 `resolution` 参数；用户明确给出像素尺寸时使用 `size`。显式像素尺寸优先于分辨率和比例。`512` 和 `0.5K` 不再作为分辨率档位接受。
4. 用户给出本地图片、HTTP(S) 图片 URL 或 `data:image/...;base64,...` 时都视为参考图，并切换到图生图流程。不要把 Data URL 回显到消息、日志或错误中。
5. API key 从进程环境、项目 `.336-image-gen/.env` 或用户目录 `~/.336/image-gen-336/.env` 读取，不要让用户把 key 贴到对话中，也不要写入 `EXTEND.md`。
6. 完成后检查输出文件确实生成，再向用户返回产物路径和使用的模型/尺寸摘要；不要只返回一条命令让用户自己执行。
7. 用户未指定输出路径时，在当前项目下选择不覆盖已有文件的合理路径（例如 `generated/image-<timestamp>.png`），并将该路径传给内部执行器。
8. 默认费用安全模式下，每个逻辑图片任务只允许发起一次远端生成请求；失败后不得自动修改提示词或再次提交。
9. 只有用户明确要求重试时，才传入内部参数 `--retry-once`，最多额外发起一次请求；重试前必须告知用户失败请求可能已经产生费用。
10. provider 标记为安全策略拦截的错误永不重试，即使 HTTP 状态为 500；应把错误原样概括给用户，并等待用户决定是否修改请求。

如果 provider、模型或凭据缺失，只询问缺失的非敏感选择。Codex/ChatGPT OAuth 不是 `OPENAI_API_KEY`，不能当作官方 Images API 凭据。

## Provider

- `official` 固定访问 `https://api.openai.com/v1`，凭据为 `OPENAI_API_KEY`。
- `relay` 访问 `EXTEND.md` 中的 `relay.base_url`，凭据为 `IMAGE_RELAY_API_KEY`，地址会自动补 `/v1`，当前 dialect 为 `openai-images`。
- Katuai 的 OpenAI Images 入口可以作为 `relay` 使用；将 base URL 配为 `https://www.katuai.cn`，模型使用 Katuai 页面列出的模型 ID，例如 `image-2` 或 `gm-3.1-flash-image-preview`。
- 当前 Skill 支持同步 OpenAI Images `generations/edits`。Katuai 的 `Prefer: respond-async` 异步任务和 Gemini `generateContent` 需要单独的 provider/扩展，不能自行猜测协议；如果用户要求异步，应明确说明当前版本未接入，而不是伪装成同步完成。

## 参考图

`--ref` 接受以下三类来源：

- 本地 PNG、JPG、JPEG、WEBP、GIF 文件。
- 公网可访问的 `http://` 或 `https://` 图片 URL；允许签名查询参数，不允许把用户名或密码嵌入 URL。
- `data:image/png;base64,...`、`data:image/jpeg;base64,...`、`data:image/webp;base64,...` 或 GIF Data URL。

agent 会在生成请求前下载 HTTP(S) 参考图或解码 Data URL，统一以 edits 接口的 `image[]` 文件上传。单张参考图最大 20 MB；Katuai 图生图最多使用 6 张。远程 URL 必须能从 agent 的运行环境访问。

## 尺寸与比例

- `resolution`: `1K`、`2K`、`4K`。
- `aspect ratio`: `1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3` 等正数比例。
- `size`: 精确像素尺寸，例如 `1024x1024`；优先级最高。
- 未指定尺寸时默认使用 `2K`；未指定比例时默认正方形。

对 Katuai 已知的分辨率/比例组合，执行器使用 Katuai 文档中的尺寸矩阵，例如 `1K + 16:9` 为 `1536x864`，`2K + 9:16` 为 `1152x2048`。

## 配置位置

`.env` 只放 API key；非敏感默认值全部放在 `EXTEND.md`，两者不要重复配置同一项：

```env
IMAGE_RELAY_API_KEY=<your-katuai-api-key>
```

```yaml
---
version: 1
default_provider: relay
default_resolution: 2K
default_aspect_ratio: 1:1
default_size: null
default_retry_policy: manual
default_model:
  relay: image-2
relay:
  base_url: https://www.katuai.cn
  dialect: openai-images
---
```

图片参数优先级为：内部请求参数 > `EXTEND.md` > Skill 内置默认值。全局默认设置保存在 `~/.336/image-gen-336/EXTEND.md`。

## 执行与验证

在用户明确指定本 Skill 后，agent 可使用 Bun 或 `tsx` 在后台执行 `scripts/main.ts`。没有参考图时走文生图 `generations`，有参考图时走图生图 `edits`；单图必须由 agent 传入提示词和输出路径，批量任务使用 `batch.json`，每个任务独立提供输出路径。默认不自动重试；只有用户明确授权时才最多额外请求一次。安全策略错误永不重试，保存图片时使用临时文件和原子替换，避免留下半截产物。

详细参数、配置和 provider 约束见：

- [references/usage.md](references/usage.md)
- [references/config.md](references/config.md)
- [references/providers/official.md](references/providers/official.md)
- [references/providers/relay.md](references/providers/relay.md)
