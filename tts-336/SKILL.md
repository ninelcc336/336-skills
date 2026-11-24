---
name: tts-336
description: 通过本机 Voice Studio 或兼容的线上语音接口，将文本合成为单段或批量 WAV 配音。使用本机 Voice Studio 时，支持整批结束后释放配音模型占用的显存。
---

# tts-336

将用户确认的朗读正文保存为 UTF-8 `.txt`，保留原标点和段落。用本技能的 [speech.py](scripts/speech.py) 从任意工作目录合成。已有文本文件可直接传入。

```powershell
python -I -X utf8 "$HOME/.agents/skills/tts-336/scripts/speech.py" "口播稿.txt"
```

直接从仓库调用时，将脚本目录换成仓库中 `tts-336/scripts` 的绝对路径。

命令打印 WAV 的绝对路径。默认输出到稿件旁的同名 `.wav`，可以用 `--output` 指定路径。输出已存在时，另选路径。

[.env](.env) 随技能安装。`BASE_URL` 填服务根地址，脚本会追加 `/v1/audio/speech`。`MODEL` 填用户选择且服务支持的模型名，也可以用 `--model` 为本批指定模型。音色、语速和语言按所用服务配置。单次最多 4096 字符。

`SERVICE_MODE=auto` 根据地址判断是否需要清理。默认将 `localhost` 和回环 IP 视为本机 Voice Studio，其他地址视为远程。通过本地代理调用线上服务时设为 `remote`；本机 Voice Studio 使用自定义域名或局域网地址时可设为 `local`。此设置只影响批末清理。

## 批量生成与释放

1. 使用用户为本批指定的模型，未单独指定时读取 `.env` 的 `MODEL`。本批若覆盖默认值，逐段合成和本机释放都传相同的 `--model`。
2. 每段调用一次 `speech.py`，记录成功返回的 WAV 路径。还有下一段、重试或补录时，保留模型供下一次合成复用。
3. 整批生成后核对段数，确认每段 WAV 能读取且有音频帧，并完成任务要求的试听或其他检查。
4. 线上服务在检查通过后直接交付音频。本机 Voice Studio 在检查通过后调用一次 [unload.py](scripts/unload.py) 释放本批模型。单段本机任务确定无需继续生成时也可以释放。

```powershell
# $model 为用户给本批指定的模型名。使用 .env 默认模型时，两条命令都省略 --model 参数。
python -I -X utf8 "$HOME/.agents/skills/tts-336/scripts/speech.py" "第一段.txt" --model $model
# 仅本机 Voice Studio：在全部段落生成并检查通过后执行一次
python -I -X utf8 "$HOME/.agents/skills/tts-336/scripts/unload.py" --model $model
```

本机释放命令用本批合成时的模型名精确匹配 `GET /model/loaded` 返回的 `engine_id`，将同一条记录的 `id` 编码后传给 `POST /model/unload/{id}`，再查询确认。目标原本未加载也会正常结束。Voice Studio 保持在线，下次生成时会重新加载模型。

若中途失败，保留成功的 WAV，记录还缺哪几段。本机任务准备补录时先保留模型，决定结束本批时再释放。释放命令以非零状态退出时，只重试释放步骤。交付时列出音频路径及未完成的段落（如有）。本机任务还要说明模型已释放、原本未加载、为继续生成而保留或释放未确认。
