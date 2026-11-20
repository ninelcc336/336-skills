---
name: 336-tts
description: 用本机 Voice Studio 将文本合成为 WAV 音频。适用于文字转语音（TTS）、生成口播配音或试听音频。
---

# 336-tts

将用户确认的朗读正文保存为 UTF-8 `.txt`，保留原标点和段落。用本技能的 [speech.py](scripts/speech.py) 从任意工作目录合成。已有文本文件可直接传入。

```powershell
python -I -X utf8 "$HOME/.agents/skills/336-tts/scripts/speech.py" "口播稿.txt"
```

直接从仓库调用时，把命令中的脚本路径换成仓库里的 `336-tts/scripts/speech.py` 的绝对路径。

命令打印 WAV 的绝对路径。默认输出到稿件旁的同名 `.wav`，可以用 `--output` 指定路径。输出已存在时，另选路径。合成后把 WAV 路径交给用户或调用方。

[.env](.env) 随技能安装，集中设置 Voice Studio 地址、默认模型、音色、语速和语言。`VOICE` 可填 `default` 或已有音色 ID。临时切换模型用 `--model voxcpm2` 或 `--model cosyvoice`。Voice Studio 后端须运行，单次最多 4096 字符。
