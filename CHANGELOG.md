# Changelog

## 0.1.0

首个版本。

- 源代码管理面板中新增 **Worktrees** 一栏，列出仓库的所有 git worktree
- 按路径识别来源：Claude（`.claude/worktrees`）、Agent（`.agent`/`.agents`）、Codex、Cursor、Gemini、Conductor，可自定义
- 主工作区只显示未提交改动；其他 worktree 自动推断来源分支，也可以手动指定
- 改动文件支持树形和列表两种展示，图标和状态字母与原生源代码管理一致
- 单文件 diff 和多文件 diff 都用 VS Code 原生编辑器；可以对比任意两个分支
- 遵循 `.gitignore`；主工作区里嵌套的 worktree 不会被算成未跟踪文件
