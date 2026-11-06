# Worktree View

一个轻量的 VS Code worktree 看板。开发仍然交给 Claude Desktop / Claude Code / Codex 等 harness，这个插件只负责**看清楚每个 worktree 改了什么、方便对比**。

- 纯 JavaScript，零依赖，无需构建；只用 VS Code 原生 API（TreeView、diff 编辑器、多文件 diff 编辑器）
- 目前只在 macOS 上测试过

## 功能

- **侧边栏看板**：列出仓库的所有 worktree，每个显示来源、领先/落后基准几个提交、改动文件数、`+/-` 行数和未提交数量
- **兼容不同 harness**：worktree 来自 `git worktree list`，建在 `.claude/worktrees/`、`.agent/`、`.codex/`，或者仓库外都能列出来，并按路径标出来源（Claude / Agent / Codex / Cursor / Gemini / Conductor…，可自定义）
- **改动包含未提交内容**：已提交、未提交、未跟踪（新建）的文件都会列出，未提交的文件会单独标记
- **原生外观**：文件图标跟随当前图标主题，右侧 M / A / D / U / R 状态字母和文件名颜色与原生源代码管理一致
- **原生 diff**：点击文件打开 VS Code 的 diff 编辑器，右侧就是 worktree 里的真实文件，可以直接改
- **查看全部改动**：worktree 那一行的 `⧉` 按钮会用多文件 diff 编辑器一次性展开所有改动
- **任意两个分支对比**：标题栏的 `对比` 按钮，或者 worktree 右键 → 与其他分支对比
- 主工作区下嵌套的 worktree（如 `.claude/worktrees/*`）不会被算成未跟踪文件
- 右键菜单：在新窗口打开、在终端打开、在访达中显示、复制路径/分支名

## 和谁比？

| worktree | 默认对比对象 |
|---|---|
| 主工作区 | `HEAD`，只看未提交改动（和 VS Code 源代码管理一致）；领先/落后按上游分支（如 `origin/main`）算 |
| 其他 worktree | 它是从哪个分支拉出来的：先看 git reflog 里的 “Created from X”，没有记录就在所有分支里找“本分支独有提交最少”的那个（不会拿其他 worktree 的分支当基准） |

推断出来的基准显示在描述里（`← main`），悬停可以看到推断依据。推断不准时，在 worktree 上右键 → **设置对比基准…** 手动指定（📌 标记），选 “自动推断” 可恢复。标题栏的 🎯 按钮可以一次性给所有 worktree 指定同一个基准。

## 对比模式

| 模式 | 含义 |
|---|---|
| `mergeBase`（默认） | 和分叉点比，只显示这个分支自己的改动，基准分支后来的提交不会混进来，等同 `git diff main...branch` |
| `direct` | 直接和基准分支最新代码比，等同 `git diff main branch` |

可以在标题栏 `…` 菜单里切换。

## 安装

在扩展市场搜索 **Worktree View**（publisher：langchou）安装；Cursor / Windsurf / VSCodium 等编辑器可从 Open VSX 安装。

也可以从源码安装：

```bash
git clone https://github.com/langchou/vs-worktree-view.git
ln -s "$PWD/vs-worktree-view" ~/.vscode/extensions/langchou.vs-worktree-view-0.1.0
```

然后重启 VS Code（或执行 `Developer: Reload Window`），在 **源代码管理** 面板里会多出一栏 **Worktrees**（可以拖动调整位置，或在面板右上角 `…` 里隐藏/显示）。

开发调试：用 VS Code 打开本目录，按 F5（Run Extension）。

## 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `worktreeView.baseBranch` | `""` | 强制所有 worktree 都和这个分支比；留空（推荐）则按上面的规则自动推断 |
| `worktreeView.compareMode` | `mergeBase` | 见上面的对比模式 |
| `worktreeView.fileLayout` | `tree` | 改动文件按目录树（`tree`）或平铺（`list`）展示，标题栏按钮可切换 |
| `worktreeView.autoRefreshSeconds` | `10` | 视图可见时自动刷新的间隔，0 表示关闭 |
| `worktreeView.sourcePatterns` | `[]` | 自定义来源识别，例如 `[{ "pattern": "/.windsurf/", "label": "Windsurf", "icon": "rocket" }]` |

## 结构

```
src/git.js        纯 git 层（不依赖 vscode，可单独测试）
src/extension.js  树视图、命令、diff 内容提供器
package.json      视图、命令、菜单、设置声明
```
