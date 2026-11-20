"""将一份 UTF-8 口播稿交给 Voice Studio 并保存 WAV。"""

import argparse
import json
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODELS = ('voxcpm2', 'cosyvoice')
ENV_FILE = Path(__file__).resolve().parents[1] / '.env'


def main():
    parser = argparse.ArgumentParser(description='用 Voice Studio 将口播稿合成为 WAV')
    parser.add_argument('script', type=Path, help='UTF-8 口播稿')
    parser.add_argument('--output', type=Path, help='WAV 文件路径，默认与稿件同名')
    parser.add_argument('--model', choices=MODELS, help='覆盖 .env 中的默认模型')
    args = parser.parse_args()

    settings = {}
    for line in ENV_FILE.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            key, separator, value = line.partition('=')
            if not separator:
                raise ValueError('.env 配置应使用 KEY=VALUE 格式')
            settings[key.strip()] = value.strip()

    model = args.model or settings['MODEL']
    if model not in MODELS:
        raise ValueError('.env 的 MODEL 应为 voxcpm2 或 cosyvoice')
    speed = float(settings['SPEED'])
    if not 0.25 <= speed <= 4:
        raise ValueError('.env 的 SPEED 应在 0.25–4.0 之间')
    text = args.script.read_text(encoding='utf-8-sig').strip()
    if not 1 <= len(text) <= 4096:
        raise ValueError('Voice Studio 每次需要 1–4096 字符的正文')

    output = (args.output or args.script.with_suffix('.wav')).resolve()
    if output.exists():
        raise FileExistsError(f'输出已存在，请用 --output 指定新路径：{output}')

    body = {
        'model': model,
        'input': text,
        'voice': settings['VOICE'],
        'speed': speed,
        'language': settings['LANGUAGE'],
        'response_format': 'wav',
    }
    request = Request(
        settings['BASE_URL'].rstrip('/') + '/v1/audio/speech',
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urlopen(request, timeout=600) as response:
        audio = response.read()
    if audio[:4] != b'RIFF' or audio[8:12] != b'WAVE':
        raise ValueError('Voice Studio 返回的内容不是 WAV 音频')

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as file:
        file.write(audio)
    print(output)


if __name__ == '__main__':
    try:
        main()
    except HTTPError as error:
        detail = error.read(2048).decode('utf-8', errors='replace').strip()
        sys.exit(f'配音失败，Voice Studio 返回 HTTP {error.code}：{detail}')
    except URLError as error:
        sys.exit(f'配音失败，请检查 Voice Studio 后端和 .env 的 BASE_URL：{error.reason}')
    except KeyError as error:
        sys.exit(f'配音失败，.env 缺少配置项 {error}')
    except (OSError, ValueError) as error:
        sys.exit(f'配音失败：{error}')
