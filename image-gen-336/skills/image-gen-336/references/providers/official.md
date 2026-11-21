# Official provider

## 认证与地址

- 地址固定为 `https://api.openai.com/v1`。
- 认证变量为 `OPENAI_API_KEY`。
- 默认模型为 `gpt-image-2`；非敏感模型覆盖写在 `EXTEND.md` 的 `default_model.official`。
- 不使用 `OPENAI_BASE_URL`，也不使用 Codex OAuth。

## 请求

文生图请求：

```http
POST https://api.openai.com/v1/images/generations
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

```json
{
  "model": "gpt-image-2",
  "prompt": "A quiet mountain lake",
  "size": "2048x1152"
}
```

有 `--ref` 时调用 `/images/edits`，请求使用 `multipart/form-data`，文本字段为 `model`、`prompt`、`size`，每张参考图使用一个 `image[]` 字段。参考图可以是本地路径、HTTP(S) URL 或图片 Data URL；URL/Data URL 会先在 agent 环境转换为图片文件再上传。尺寸只接受正整数 `WxH`；`--ar` 和 `--resolution` 会先转换为像素尺寸，不会向官方接口发送不确定的自定义字段。

当前实现对已知的 DALL-E 模型拒绝参考图，因为本 Skill 的 `image[]` edits 语义要求模型支持 GPT Image edits。遇到 provider/model 不支持时会明确报错。

## 响应

读取 `data[0].b64_json` 或 `data[0].url`。base64 在 provider 内解码为 `Uint8Array`；URL 在 provider 内下载为 `Uint8Array`。主流程不感知响应格式。

默认不自动重试。只有用户明确授权时，429、非安全策略 5xx 和网络异常由主流程最多额外请求一次；安全策略拦截即使返回 500 也不重试。401、403、400 和其他 4xx 不重试。错误只输出状态码和安全截断正文，不打印 key、Authorization 或图片 base64。
