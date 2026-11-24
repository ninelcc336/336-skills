"""释放本批配音使用的 Voice Studio 模型。"""

import argparse
from http.client import HTTPException
from ipaddress import ip_address
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

# python -I 不会将脚本目录加入模块搜索路径。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from speech import read_settings, selected_model


def uses_local_studio(settings):
    mode = settings.get('SERVICE_MODE', 'auto').lower()
    if mode in ('local', 'remote'):
        return mode == 'local'
    if mode != 'auto':
        raise ValueError('.env 的 SERVICE_MODE 应为 auto、local 或 remote')
    url = urlsplit(settings['BASE_URL'])
    if url.scheme not in ('http', 'https') or not url.hostname:
        raise ValueError('.env 的 BASE_URL 应为完整的 HTTP 或 HTTPS 服务地址')
    host = url.hostname.rstrip('.')
    if host == 'localhost':
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:  # 域名按远程地址处理。
        return False


def request_json(base_url, path, method='GET'):
    request = Request(base_url + path, method=method)
    try:
        with urlopen(request, timeout=60) as response:
            result = json.load(response)
    except HTTPError as error:
        detail = error.read(2048).decode('utf-8', errors='replace').strip()
        raise ValueError(f'{method} {path} 返回 HTTP {error.code}：{detail}') from error
    except (OSError, HTTPException, ValueError) as error:
        raise ValueError(f'{method} {path} 请求或读取响应失败：{error}') from error
    if not isinstance(result, dict):
        raise ValueError(f'{method} {path} 未返回 JSON 对象')
    return result


def loaded_ids(base_url, model):
    result = request_json(base_url, '/model/loaded')
    entries = result.get('models')
    if not isinstance(entries, list) or result.get('count') != len(entries):
        raise ValueError('/model/loaded 返回的模型列表或数量无效')
    degraded = result.get('degraded_sources')
    if not isinstance(degraded, list) or any(
        source in degraded for source in ('sidecars', 'engines', 'active-engine')
    ):
        raise ValueError(f'无法确认配音模型列表完整，degraded_sources={degraded!r}')

    matches = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not entry['id']:
            raise ValueError('/model/loaded 返回了缺少有效 id 的模型记录')
        model_id = entry['id']
        engine = entry.get('engine_id')
        if model_id.startswith(('sidecar:', 'engine:', 'active-engine:')):
            if not isinstance(engine, str) or not engine:
                raise ValueError(f'/model/loaded 未提供 {model_id} 所属的 engine_id')
        if engine == model:
            if model_id == 'sidecars' or entry.get('unloadable') is not True:
                raise ValueError(f'无法单独卸载 {model_id}')
            matches.append(model_id)
    return matches


def main():
    parser = argparse.ArgumentParser(description='释放指定配音模型，并向 Voice Studio 确认结果')
    parser.add_argument('--model', help='本批合成使用的模型名，默认读取 .env 的 MODEL')
    args = parser.parse_args()
    settings = read_settings()
    if not uses_local_studio(settings):
        print('远程服务，已跳过本机模型清理')
        return
    model = selected_model(args.model, settings)
    base_url = settings['BASE_URL'].rstrip('/')
    targets = loaded_ids(base_url, model)
    if not targets:
        print(f'{model} 未加载，无需释放')
        return

    for model_id in targets:
        result = request_json(base_url, '/model/unload/' + quote(model_id, safe=''), 'POST')
        if result.get('success') is not True or result.get('unloaded') != model_id:
            raise ValueError(f'服务未确认卸载 {model_id}：{result}')
    remaining = loaded_ids(base_url, model)
    if remaining:
        raise ValueError(f'卸载后仍在 /model/loaded 中：{", ".join(remaining)}')
    print(f'已确认释放 {", ".join(targets)}')


if __name__ == '__main__':
    try:
        main()
    except KeyError as error:
        sys.exit(f'模型释放失败，.env 缺少配置项 {error}')
    except (OSError, ValueError) as error:
        sys.exit(f'模型释放未确认：{error}')
