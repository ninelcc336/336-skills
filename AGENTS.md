# 本地数据目录

本仓库的 Skill 需要跨项目保存用户数据或配置时，默认放在 `~/.336/<Skill 名>/`。子目录使用 `SKILL.md` 里的 `name`，例如 `~/.336/who-am-i/`。需要写入时再创建对应目录。

## 更新本机 Skill

将改动提交并推送到 GitHub 后，通过 `npx skills update -g <Skill 名>` 更新本机安装。首次安装使用 `npx skills add ninelcc336/336-skills -g -a codex -s <Skill 名>`。
