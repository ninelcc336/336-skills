"""Maintain explicit project facts and print a read-only activity snapshot."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def source_address(value):
    value = value.strip()
    match = re.fullmatch(
        r"(?:https?://(?:www\.)?github\.com/|git@github\.com:|ssh://git@github\.com/)"
        r"([\w.-]+)/([\w.-]+)/?", value, re.IGNORECASE | re.ASCII,
    )
    if match:
        owner, repo = match.groups()
        repo = repo.removesuffix(".git")
        if owner not in (".", "..") and repo not in ("", ".", ".."):
            return f"https://github.com/{owner.lower()}/{repo.lower()}"
    if not value or "://" in value or value.startswith("git@"):
        raise ValueError("来源请使用本地目录或 GitHub 仓库主页地址")
    return str(Path(value).expanduser().resolve())


def command(*args):
    return subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=25, env={**os.environ, "LC_ALL": "C", "GH_PROMPT_DISABLED": "1",
                         "GIT_NO_LAZY_FETCH": "1"},
    )


def local_activity(source, since, now):
    if not Path(source).is_dir():
        raise ValueError("目录不存在或无法访问")
    git = ["git", "--no-optional-locks", "-C", source]
    prefix = command(*git, "rev-parse", "--show-prefix")
    if prefix.returncode:
        if "not a git repository" in prefix.stderr:
            raise ValueError("普通目录，无 Git 活动数据")
        raise ValueError(prefix.stderr.strip() or "无法读取本地仓库")
    scope = ["--", "."] if prefix.stdout.strip() else []
    log = [*git, "log", "--no-show-signature", "--no-notes"]
    head = command(*log, "-1", "--format=%ct%x00%s", *scope)
    if head.returncode and "does not have any commits yet" not in head.stderr:
        raise ValueError(head.stderr.strip() or "无法读取提交")
    if not head.stdout.strip():
        return None, set()
    stamp, title = head.stdout.rstrip("\r\n").split("\x00", 1)
    latest = {"date": str(date.fromtimestamp(int(stamp))), "title": title}
    recent = command(*log, f"--since=@{int(since.timestamp())}",
                     f"--until=@{int(now.timestamp())}", "--format=%ct", *scope)
    if recent.returncode:
        raise ValueError(recent.stderr.strip() or "无法统计提交日期")
    return latest, {date.fromtimestamp(int(stamp)) for stamp in recent.stdout.splitlines()}


@lru_cache(maxsize=1)
def has_gh_session():
    return shutil.which("gh") and command(
        "gh", "auth", "status", "--hostname", "github.com", "--active",
    ).returncode == 0


def github_commits(repository, **params):
    endpoint = f"repos/{repository}/commits?{urlencode(params)}"
    if has_gh_session():
        result = command("gh", "api", "--hostname", "github.com", endpoint)
        if result.returncode:
            if "Git Repository is empty" in result.stderr:
                return []
            raise ValueError(result.stderr.strip() or "GitHub 请求失败")
        return json.loads(result.stdout)
    request = Request(f"https://api.github.com/{endpoint}", headers={"User-Agent": "who-am-i"})
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 409 and b"Git Repository is empty" in error.read():
            return []
        raise ValueError(f"GitHub HTTP {error.code}，请检查仓库访问权限或 API 限额") from error


def github_activity(source, since, now):
    repository = source.removeprefix("https://github.com/")
    head = github_commits(repository, per_page=1)
    if not head:
        return None, set()
    commit = head[0]["commit"]
    stamp = datetime.fromisoformat(commit["committer"]["date"].replace("Z", "+00:00"))
    latest = {"date": str(stamp.astimezone().date()), "title": commit["message"].partition("\n")[0]}
    days = set()
    page = 1
    while True:
        commits = github_commits(repository, since=since.isoformat(), until=now.isoformat(),
                                 per_page=100, page=page)
        for row in commits:
            stamp = row["commit"]["committer"]["date"].replace("Z", "+00:00")
            days.add(datetime.fromisoformat(stamp).astimezone().date())
        if len(commits) < 100:
            return latest, days
        page += 1


def snapshot(project, since, now):
    reports, days = [], set()
    readable = 0
    for source in project["sources"]:
        try:
            reader = github_activity if source.startswith("https://github.com/") else local_activity
            latest, active = reader(source, since, now)
        except (OSError, ValueError, URLError, subprocess.TimeoutExpired) as error:
            reports.append({"source": source, "unavailable": str(error)})
            continue
        reports.append({"source": source, "latest": latest, "active_days": len(active)})
        readable += 1
        days.update(active)
    return {**project, "sources": reports, "observed_active_days": len(days) if readable else None}


def save_catalog(path, projects):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        file.write(json.dumps(projects, ensure_ascii=False, indent=2) + "\n")
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    base = Path.home() / ".336"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=base / "who-am-i" / "projects.json")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("list")
    status = actions.add_parser("status")
    status.add_argument("project", nargs="?")
    add = actions.add_parser("add")
    add.add_argument("project")
    add.add_argument("--source", action="append", required=True)
    edit = actions.add_parser("edit")
    edit.add_argument("project")
    edit.add_argument("--name")
    edit.add_argument("--add-source", action="append", default=[])
    edit.add_argument("--drop-source", action="append", default=[])
    for action in (add, edit):
        action.add_argument("--purpose")
        action.add_argument("--note")
    actions.add_parser("remove").add_argument("project")
    args = parser.parse_args()

    path = args.catalog.expanduser().resolve()
    projects = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else []
    if not isinstance(projects, list):
        raise ValueError("清单顶层须为项目列表")
    names = []
    for item in projects:
        if not (isinstance(item, dict) and isinstance(item.get("name"), str)
                and isinstance(item.get("sources"), list) and item["sources"]
                and all(isinstance(s, str) and s for s in item["sources"])):
            raise ValueError("清单中有项目缺少名称或来源")
        names.append(item["name"])
    if len(set(names)) != len(names):
        raise ValueError("清单中存在重名项目")
    if args.action == "list":
        return {"catalog": str(path), "projects": projects}
    name = getattr(args, "project", None)
    if name is not None:
        name = name.strip()
        if not name:
            raise ValueError("项目名称不能为空")
        if args.action != "add" and name not in names:
            raise ValueError(f"找不到项目 {name}")
    if args.action == "status":
        now = datetime.now(timezone.utc)
        first_day = now.astimezone().date() - timedelta(days=29)
        since = datetime.combine(first_day, time.min).astimezone(timezone.utc)
        selected = projects if name is None else [projects[names.index(name)]]
        return {"as_of": now.astimezone().isoformat(timespec="seconds"), "window_start": str(first_day),
                "projects": [snapshot(project, since, now) for project in selected]}
    if args.action == "remove":
        projects.pop(names.index(name))
    elif args.action == "add":
        if name in names:
            raise ValueError(f"项目已登记：{name}")
        sources = list(dict.fromkeys(source_address(s) for s in args.source))
        projects.append({"name": name, "sources": sources, "purpose": args.purpose or "",
                         "note": args.note or ""})
    else:
        project = projects[names.index(name)]
        if args.name is not None:
            new_name = args.name.strip()
            if not new_name or (new_name != name and new_name in names):
                raise ValueError("新名称为空或已被其他项目使用")
            project["name"] = new_name
        for key in ("purpose", "note"):
            value = getattr(args, key)
            if value is not None:
                project[key] = value
        sources = project["sources"]
        for value in args.drop_source:
            source = source_address(value)
            if source not in sources:
                raise ValueError(f"该项目未登记来源 {source}")
            sources.remove(source)
        for value in args.add_source:
            source = source_address(value)
            if source not in sources:
                sources.append(source)
        if not sources:
            raise ValueError("移除最后一个来源请使用 remove 删除该条登记")
    save_catalog(path, projects)
    return {"catalog": str(path), "action": args.action, "project": getattr(args, "name", None) or name}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
