# 336 Skills

一组可在 Codex 中使用的 Agent Skills，用于生成图片、制作配音，以及在对话中整理个人项目近况。

## Skills

| Skill | 用途 | 使用条件 |
| --- | --- | --- |
| [`image-gen-336`](image-gen-336/README.md) | 用文字或参考图生成和编辑图片，支持批量任务。 | Bun，或 Node.js 和 `tsx`。需配置 OpenAI Images API 或兼容中转服务的 API key。 |
| [`tts-336`](tts-336/SKILL.md) | 将文本合成为单段或多段 WAV 配音。本机配音完成后可释放模型占用的显存。 | Python 3。本机使用时先启动 Voice Studio，也可在 Skill 自带的 `.env` 中配置兼容的线上语音服务。 |
| [`who-am-i`](who-am-i/SKILL.md) | 根据你登记的项目和最近提交，为当前对话整理个人项目背景。 | Python 3.9+。查询本地仓库的提交需要 Git。 |

## 安装到 Codex

先安装带 `npx` 的 Node.js。按需运行下面的命令。`-g` 表示全局安装，去掉它可安装到当前项目。

```bash
npx skills add https://github.com/ninelcc336/336-skills/tree/main/image-gen-336/skills/image-gen-336 -g -a codex -s image-gen-336
npx skills add ninelcc336/336-skills -g -a codex -s tts-336
npx skills add ninelcc336/336-skills -g -a codex -s who-am-i
```

安装后，在对话里指定 Skill 和任务。例如「用 `image-gen-336` 生成一张 16:9 封面」「用 `tts-336` 把 `口播稿.txt` 合成为 WAV」「用 `who-am-i` 看看我登记的项目最近有哪些更新」。

## 开源许可证

本仓库采用 [MIT 许可证](LICENSE)。
