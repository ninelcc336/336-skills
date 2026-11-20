# 使用说明

## Agent 调用

该文件描述执行器的内部参数，不要求最终用户手动执行命令。只有用户明确指定 `336-image-gen` 或要求使用本 Skill 后，Codex、Claude Code 等 agent 才应从自然语言请求提取这些值，在后台调用 `scripts/main.ts`，并在完成后返回生成文件路径；普通图片请求不得自动调用。

## 参数

主脚本是 `scripts/main.ts`。单图模式需要 `--prompt` 或 `--promptfiles`，并且需要 `--image`。

| 参数 | 说明 |
| --- | --- |
| `--prompt <text>` / `-p` | 直接提供提示词。 |
| `--promptfiles <file...>` | 按参数顺序读取并用空行拼接多个本地文本文件。 |
| `--image <path>` | 输出文件路径；父目录自动创建。没有扩展名时默认补 `.png`。 |
| `--provider official\|relay` | 指定后端；优先级高于配置和自动判断。 |
| `--model <id>` / `-m` | 指定模型。优先级最高。 |
| `--ar <ratio>`、`--aspect-ratio <ratio>` | 正数宽高比，如 `1:1`、`16:9`、`9:16`、`4:3`。会转换成像素 `size`。 |
| `--resolution <value>` | `1K`、`2K`、`4K`；与比例一起使用时按 Katuai 尺寸矩阵换算。 |
| `--size <WxH>` | 正整数尺寸，如 `1024x1024`；显式值优先于分辨率和比例。 |
| `--quality normal\|2k` | 旧版质量预设；未指定 resolution 时影响 `--ar` 换算出的目标长边，默认 `2k`。 |
| `--ref <source...>` | 本地图片、HTTP(S) URL 或图片 Data URL，使用 edits 接口；单张最大 20 MB。 |
| `--retry-once` | 仅在用户明确授权重试时使用；失败后最多额外发起一次远端请求。 |
| `--batchfile <path>` | 读取批量 JSON；每个任务都要有 `image` 和提示词来源。 |
| `--jobs <count>` | 批量最大并发任务数，默认 4。 |
| `--json` | 输出 JSON；批量模式包含每个任务的成功、失败、路径和尝试次数。 |

每个请求只保存一张图片，不支持 `--n`。HTTP(S) 参考图会从 agent 运行环境下载，Data URL 会在本地解码，最后统一以 `image[]` 上传。远程 URL 必须是公网可访问的图片地址。

## 提示词

直接提示词：

```bash
bun 336-image-gen/scripts/main.ts --prompt "A minimal product photo" --image out/product.png
```

文件提示词：

```bash
bun 336-image-gen/scripts/main.ts --promptfiles prompts/style.md prompts/scene.md --image out/scene.png
```

`--prompt` 与 `--promptfiles` 可以同时使用，直接提示词会排在文件内容之前。位置参数只在没有这两个选项时作为提示词。

## 参考图

```bash
bun 336-image-gen/scripts/main.ts \
  --provider official \
  --prompt "Preserve the subject identity and change the background to a clean studio" \
  --ref refs/subject.png refs/style.jpg \
  --image out/studio.png
```

参考图按 `image[]` 字段发送到 `/images/edits`。本地路径、HTTP(S) URL 和 Data URL 的处理方式一致；如果 provider 或模型拒绝 edits，请使用支持参考图的模型，脚本不会悄悄忽略 `--ref`。

## batch.json

支持数组和对象两种形式。路径都相对 `batch.json` 所在目录解析，不相对当前 shell 目录漂移。批量模式不接受共享的 `--image`；每个任务必须提供自己的输出路径，避免任务互相覆盖。

```json
{
  "jobs": 2,
  "tasks": [
    {
      "id": "cover",
      "prompt": "A blue editorial cover",
      "image": "out/cover.png",
      "provider": "official",
      "ar": "16:9",
      "resolution": "2K"
    },
    {
      "id": "detail",
      "promptFiles": ["prompts/detail.md"],
      "image": "out/detail.png",
      "provider": "relay",
      "model": "relay-image-model",
      "ref": ["refs/source.png", "https://cdn.example.com/style.png"],
      "resolution": "1K",
      "ar": "1:1"
    }
  ]
}
```

字段为 `id`、`prompt`、`promptFiles`（也接受 `promptfiles`）、`image`、`provider`、`model`、`ar`、`size`、`resolution`、`quality`、`retryPolicy` 和 `ref`。`retryPolicy` 可写 `manual` 或 `once`；`once` 只应在用户明确授权后使用。`ref` 中的本地相对路径相对 `batch.json` 解析，HTTP(S)/Data URL 原样保留。全局 CLI 值优先于任务值。任务准备失败、请求失败或保存失败只影响该任务；最终有失败任务时进程以非零状态退出。

```bash
bun 336-image-gen/scripts/main.ts --batchfile jobs/batch.json --jobs 3 --json
```

默认每个任务只尝试一次；用户明确授权 `--retry-once` 或任务使用 `retryPolicy: once` 时，网络错误、429 和非安全策略 5xx 最多额外尝试一次，采用短指数退避。401、403、400 和其他 4xx 不重试；安全策略拦截即使返回 500 也不重试。agent 不得自动修改提示词后重新提交，且重试前必须提示可能产生新的 API 费用。错误正文只保留安全截断片段，API key、Authorization 和 base64 图片不会写入日志。
