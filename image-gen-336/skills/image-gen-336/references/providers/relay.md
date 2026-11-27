# Relay provider

## 兼容边界

relay 必须实现 OpenAI Images API 兼容的 `openai-images` dialect：

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `Authorization: Bearer <key>`
- JSON generations 请求体包含 `model`、`prompt`、`size`
- edits 使用 multipart 的 `image[]` 字段
- 响应提供 `data[0].b64_json` 或 `data[0].url`

如果中转站使用其他字段、认证、路径或响应协议，不要猜测。请新增独立 dialect/provider，明确描述其 wire format，并为请求和响应增加 mock fetch 测试。

## 地址与认证

- 地址来自 `EXTEND.md` 的 `relay.base_url`；`.env` 不保存 relay 地址。
- `https://relay.example.com` 会规范化为 `https://relay.example.com/v1`。
- 已有 `/v1` 时不会重复添加；末尾斜杠会移除。
- 地址必须是 HTTP(S)，不能包含用户名、密码、查询串或 hash。
- API key 只能使用 `IMAGE_RELAY_API_KEY`。
- Katuai 的默认模型是 `gpt-image-2.6-sunburst`。其他兼容 relay 的默认模型是 `gpt-image-2`。使用 `EXTEND.md` 的 `default_model.relay` 可指定不同模型。
- 可用 `EXTEND.md` 的 `relay.dialect` 声明 dialect，但当前唯一允许值是 `openai-images`。

## 请求与响应

无参考图时调用 `/images/generations`，发送：

```json
{
  "model": "relay-image-model",
  "prompt": "A quiet mountain lake",
  "size": "2048x1152"
}
```

有参考图时调用 `/images/edits`，以 `image[]` 上传 PNG/JPG/JPEG/WEBP/GIF 文件。参考图可以是本地路径、HTTP(S) URL 或图片 Data URL；relay provider 会在 agent 环境下载或解码后统一上传，不把原始 URL/base64 直接交给兼容层，并只向主流程返回 `Uint8Array`。

Katuai 使用 `relay.base_url: https://www.katuai.cn` 和 `IMAGE_RELAY_API_KEY`。`gpt-image-2.6-sunburst` 走同步 OpenAI Images 接口，按 Katuai 尺寸矩阵发送像素尺寸。Katuai 的 `Prefer: respond-async` 异步任务和 Gemini `generateContent` 需要各自的接口支持。[Katuai API 文档](https://www.katuai.cn/open-api)

中转站返回不符合预期的 JSON 时，错误包含 HTTP 状态码和安全截断的正文。默认不自动重试；只有用户明确授权时，429、非安全策略 5xx 与网络错误最多额外请求一次。安全策略拦截即使返回 500 也不重试；4xx（包括 400、401、403）不重试。响应正文、API key、Authorization 和参考图内容不会进入日志。
