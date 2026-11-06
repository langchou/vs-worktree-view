'use strict';
const vscode = require('vscode');
const path = require('path');
const G = require('./git');

const SCHEME = 'wtview';
const STATUS_TEXT = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更', U: '未跟踪' };

// ---------- 配置 ----------
function cfg() { return vscode.workspace.getConfiguration('worktreeView'); }
function sourceRules() {
  const extra = cfg().get('sourcePatterns') || [];
  return [...extra, ...G.DEFAULT_SOURCES];
}
function compareMode() { return cfg().get('compareMode') === 'direct' ? 'direct' : 'mergeBase'; }
function fileLayout() { return cfg().get('fileLayout') === 'list' ? 'list' : 'tree'; }

// ---------- 基准版本内容：wtview:/<相对路径>?{"repo":..,"ref":..} ----------
function refUri(repo, ref, relPath) {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + relPath, query: JSON.stringify({ repo, ref: ref || '' }) });
}
class RefContentProvider {
  constructor() { this._emitter = new vscode.EventEmitter(); this.onDidChange = this._emitter.event; }
  /** 通知已打开的 wtview 文档重新读取 */
  invalidateAll() {
    for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === SCHEME) this._emitter.fire(doc.uri);
  }
  async provideTextDocumentContent(uri) {
    const { repo, ref } = JSON.parse(uri.query);
    return G.showFile(repo, ref, uri.path.slice(1));
  }
}

// ---------- 原生风格装饰：wtview-item:/<路径>?<所属>#<状态字母> ----------
const ITEM_SCHEME = 'wtview-item';
const DECO = {
  M: ['gitDecoration.modifiedResourceForeground', '修改'],
  A: ['gitDecoration.addedResourceForeground', '新增'],
  U: ['gitDecoration.untrackedResourceForeground', '未跟踪'],
  D: ['gitDecoration.deletedResourceForeground', '删除'],
  R: ['gitDecoration.renamedResourceForeground', '重命名'],
  C: ['gitDecoration.addedResourceForeground', '复制'],
  T: ['gitDecoration.modifiedResourceForeground', '类型变更'],
};
function ownerKey(owner) {
  return owner.kind === 'worktree' ? 'wt:' + owner.wt.path : `cmp:${owner.cmp.base}:${owner.cmp.target}`;
}
function itemUri(owner, relPath, letter) {
  return vscode.Uri.from({ scheme: ITEM_SCHEME, path: '/' + relPath, query: ownerKey(owner), fragment: letter || '' });
}
class ItemDecorations {
  provideFileDecoration(uri) {
    if (uri.scheme !== ITEM_SCHEME || !uri.fragment) return undefined;
    const d = DECO[uri.fragment] || DECO.M;
    return new vscode.FileDecoration(uri.fragment, d[1], new vscode.ThemeColor(d[0]));
  }
}

// ---------- 树节点 ----------
class RepoNode {
  constructor(repo) { this.kind = 'repo'; this.repo = repo; }
}
class WorktreeNode {
  /** baseInfo: { ref, reason, workingOnly } */
  constructor(repo, wt, status, baseInfo) {
    this.kind = 'worktree'; this.repo = repo; this.wt = wt; this.status = status;
    this.baseInfo = baseInfo || { ref: repo.base, reason: '' };
  }
  /** diff 左侧显示的名字 */
  get baseLabel() { return this.baseInfo.workingOnly ? 'HEAD' : this.baseInfo.ref; }
}
class CompareNode {
  constructor(repo, cmp) { this.kind = 'compare'; this.repo = repo; this.cmp = cmp; }
}
class FileNode {
  constructor(parent, file) { this.kind = 'file'; this.parent = parent; this.file = file; }
}
class DirNode {
  constructor(owner, name, relPath) {
    this.kind = 'dir'; this.owner = owner; this.name = name; this.relPath = relPath;
    this.dirs = new Map(); this.files = []; this.add = 0; this.del = 0; this.count = 0;
  }
}

/** 把文件列表组装成目录树；只有一个子目录且没有文件的目录会合并成 a/b/c，和 VS Code 源代码管理一致 */
function buildFileTree(owner, files) {
  const root = new DirNode(owner, '', '');
  for (const f of files) {
    const segs = f.path.split('/');
    let cur = root;
    cur.add += f.add; cur.del += f.del; cur.count++;
    for (let i = 0; i < segs.length - 1; i++) {
      const rel = segs.slice(0, i + 1).join('/');
      if (!cur.dirs.has(segs[i])) cur.dirs.set(segs[i], new DirNode(owner, segs[i], rel));
      cur = cur.dirs.get(segs[i]);
      cur.add += f.add; cur.del += f.del; cur.count++;
    }
    cur.files.push(new FileNode(owner, f));
  }
  const compact = d => {
    for (const [k, c] of d.dirs) {
      let n = c;
      while (n.files.length === 0 && n.dirs.size === 1) {
        const only = [...n.dirs.values()][0];
        only.name = n.name + '/' + only.name;
        n = only;
      }
      d.dirs.set(k, n);
      compact(n);
    }
  };
  compact(root);
  return root;
}
function dirChildren(d) {
  const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...d.files].sort((a, b) => path.basename(a.file.path).localeCompare(path.basename(b.file.path)));
  return [...dirs, ...files];
}
function fileChildren(owner, files) {
  if (fileLayout() === 'list') return files.map(f => new FileNode(owner, f));
  if (!owner._tree || owner._treeFiles !== files) { owner._tree = buildFileTree(owner, files); owner._treeFiles = files; }
  return dirChildren(owner._tree);
}

class InfoNode {
  constructor(text, icon, tooltip) { this.kind = 'info'; this.text = text; this.icon = icon; this.tooltip = tooltip; }
}

function statLine(add, del) { return `+${add} −${del}`; }

/** 一个文件的 [展示用 uri, 左侧 uri, 右侧 uri] */
function fileUris(node) {
  const f = node.file;
  const p = node.parent;
  if (p.kind === 'worktree') {
    const repo = p.wt.path;
    const leftRef = f.status === 'A' || f.status === 'U' ? '' : p.status.compareRef;
    const left = refUri(repo, leftRef, f.oldPath);
    const right = f.status === 'D' ? refUri(repo, '', f.path) : vscode.Uri.file(path.join(repo, f.path));
    return [vscode.Uri.file(path.join(repo, f.path)), left, right];
  }
  const repo = p.repo.root;
  const left = refUri(repo, f.status === 'A' ? '' : p.cmp.leftRef, f.oldPath);
  const right = refUri(repo, f.status === 'D' ? '' : p.cmp.rightRef, f.path);
  return [refUri(repo, p.cmp.rightRef, f.path), left, right];
}

function shortRef(ref) { return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref; }

function worktreeTitle(node) {
  const wt = node.wt;
  return wt.branch || `(detached ${String(wt.head).slice(0, 7)})`;
}

const OVERRIDE_KEY = 'worktreeView.baseOverrides'; // { [worktree 路径 或 'repo:'+commonDir]: ref }

class WorktreeTree {
  constructor(state) {
    this.state = state;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.repos = [];       // { root, commonDir, base, worktrees: [WorktreeNode] }
    this.compares = [];    // CompareNode
    this.loading = null;
  }

  refresh() { this.loading = null; this._emitter.fire(); }

  overrides() { return (this.state && this.state.get(OVERRIDE_KEY)) || {}; }
  async setOverride(key, ref) {
    const o = { ...this.overrides() };
    if (ref) o[key] = ref; else delete o[key];
    await this.state.update(OVERRIDE_KEY, o);
    this.refresh();
  }

  /** 决定某个 worktree 跟谁比 */
  async resolveBase(repo, w, ctx) {
    const o = this.overrides();
    const valid = async ref => ref && await G.refExists(repo.root, ref) ? ref : null;
    const own = await valid(o[w.path]);
    if (own) return { ref: own, reason: '手动指定' };
    if (w.isMain) return { ref: 'HEAD', reason: '主工作区：只看未提交改动', workingOnly: true };
    const repoWide = await valid(o['repo:' + repo.commonDir]);
    if (repoWide) return { ref: repoWide, reason: '仓库统一基准（手动指定）' };
    const configured = await valid((cfg().get('baseBranch') || '').trim());
    if (configured) return { ref: configured, reason: '设置 worktreeView.baseBranch' };
    const inferred = await G.inferBase(w.path, w, ctx).catch(() => null);
    if (inferred) return inferred;
    return { ref: repo.base, reason: '默认分支' };
  }

  async load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const seen = new Map();
      for (const folder of vscode.workspace.workspaceFolders || []) {
        const info = await G.repoInfo(folder.uri.fsPath);
        if (info && !seen.has(info.commonDir)) seen.set(info.commonDir, info);
      }
      const rules = sourceRules();
      const mode = compareMode();
      const repos = [];
      for (const info of seen.values()) {
        try {
          const wts = await G.listWorktrees(info.toplevel);
          const main = wts.find(w => w.isMain) || wts[0];
          const root = main ? main.path : info.toplevel;
          const base = await G.detectBase(root, main);
          const allPaths = wts.map(w => w.path);
          const repo = { root, commonDir: info.commonDir, base, name: path.basename(root) };
          const ctx = {
            preferred: [...new Set([main && main.branch, base].filter(Boolean))],
            exclude: wts.filter(w => !w.isMain && w.branch).map(w => w.branch),
          };
          repo.worktrees = await Promise.all(wts.map(async w => {
            w.source = w.isMain ? { label: '主工作区', icon: 'home' } : (G.detectSource(w.path, rules) || { label: '', icon: 'git-branch' });
            const baseInfo = w.prunable || w.bare ? { ref: base, reason: '' } : await this.resolveBase(repo, w, ctx);
            const status = await G.worktreeStatus(w, baseInfo.ref, { mode, otherWorktreePaths: allPaths, workingOnly: !!baseInfo.workingOnly });
            return new WorktreeNode(repo, w, status, baseInfo);
          }));
          repos.push(repo);
        } catch (e) {
          repos.push({ root: info.toplevel, commonDir: info.commonDir, name: path.basename(info.toplevel), error: e.message, worktrees: [] });
        }
      }
      this.repos = repos;
      this.compares = this.compares.filter(c => repos.some(r => r.commonDir === c.repo.commonDir));
      updateBadge(repos);
    })();
    return this.loading;
  }

  async getChildren(el) {
    if (!el) {
      await this.load();
      if (!this.repos.length) return [];
      const top = [...this.compares];
      if (this.repos.length === 1) {
        const r = this.repos[0];
        if (r.error) return [new InfoNode(r.error, 'error')];
        return [...top, ...r.worktrees];
      }
      return [...top, ...this.repos.map(r => new RepoNode(r))];
    }
    if (el.kind === 'repo') {
      if (el.repo.error) return [new InfoNode(el.repo.error, 'error')];
      return el.repo.worktrees;
    }
    if (el.kind === 'worktree') {
      if (el.status.error) return [new InfoNode(el.status.error, 'warning')];
      if (!el.status.files.length) return [new InfoNode(el.baseInfo.workingOnly ? '没有未提交的改动' : `与 ${el.baseLabel} 无差异`, 'check')];
      return fileChildren(el, el.status.files);
    }
    if (el.kind === 'compare') {
      if (!el.cmp.files.length) return [new InfoNode('两者没有差异', 'check')];
      return fileChildren(el, el.cmp.files);
    }
    if (el.kind === 'dir') {
      return dirChildren(el);
    }
    return [];
  }

  getParent() { return undefined; }

  getTreeItem(el) {
    const C = vscode.TreeItemCollapsibleState;
    if (el.kind === 'info') {
      const it = new vscode.TreeItem(el.text, C.None);
      it.iconPath = new vscode.ThemeIcon(el.icon);
      it.tooltip = el.tooltip || el.text;
      return it;
    }
    if (el.kind === 'repo') {
      const it = new vscode.TreeItem(el.repo.name, C.Expanded);
      it.description = `${el.repo.worktrees.length} 个 worktree`;
      it.iconPath = new vscode.ThemeIcon('repo');
      it.contextValue = 'repo';
      it.tooltip = el.repo.root;
      return it;
    }
    if (el.kind === 'worktree') {
      const { wt, status, baseInfo } = el;
      const it = new vscode.TreeItem(worktreeTitle(el), status.files.length ? C.Collapsed : C.None);
      it.id = `wt:${wt.path}`;
      const parts = [];
      if (wt.source.label) parts.push(wt.source.label);
      if (status.error) {
        parts.push('⚠ ' + status.error);
      } else if (baseInfo.workingOnly) {
        if (status.upstream) parts.push(`↑${status.ahead} ↓${status.behind} ${status.upstream}`);
        parts.push(status.dirty ? `● ${status.dirty} 未提交 ${statLine(status.add, status.del)}` : '无未提交改动');
      } else {
        parts.push(`← ${baseInfo.ref}${baseInfo.reason === '手动指定' ? ' 📌' : ''}`);
        parts.push(`↑${status.ahead} ↓${status.behind}`);
        parts.push(`${status.files.length} 文件 ${statLine(status.add, status.del)}`);
        if (status.dirty) parts.push(`● ${status.dirty} 未提交`);
      }
      it.description = parts.join(' · ');
      it.iconPath = new vscode.ThemeIcon(wt.source.icon,
        status.error ? new vscode.ThemeColor('disabledForeground')
          : status.dirty ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined);
      it.contextValue = wt.isMain ? 'worktree.main' : 'worktree';
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${worktreeTitle(el)}**  ${wt.source.label ? '`' + wt.source.label + '`' : ''}\n\n`);
      md.appendMarkdown(`$(folder) \`${wt.path}\`\n\n`);
      if (baseInfo.workingOnly) {
        md.appendMarkdown(`$(git-compare) 只显示未提交改动（对比 HEAD）\n\n`);
        if (status.upstream) md.appendMarkdown(`相对 \`${status.upstream}\` 领先 ${status.ahead} / 落后 ${status.behind} 个提交\n\n`);
      } else {
        md.appendMarkdown(`$(git-compare) 基准 \`${baseInfo.ref}\` — ${escapeMd(baseInfo.reason)}\n\n`);
        md.appendMarkdown(`对比点 \`${shortRef(status.compareRef || '?')}\`（${compareMode() === 'direct' ? '直接对比基准最新' : 'merge-base 分叉点'}）\n\n`);
        if (!status.error) md.appendMarkdown(`领先 ${status.ahead} / 落后 ${status.behind} 个提交 · ${status.files.length} 个文件 ${statLine(status.add, status.del)} · ${status.dirty} 个未提交\n\n`);
      }
      md.appendMarkdown(`_右键 → 设置对比基准… 可手动修改_\n\n`);
      if (status.lastCommit) md.appendMarkdown(`$(git-commit) \`${status.lastCommit.hash}\` ${escapeMd(status.lastCommit.subject)} — ${status.lastCommit.author}，${status.lastCommit.relTime}`);
      if (wt.locked) md.appendMarkdown('\n\n$(lock) 已锁定');
      it.tooltip = md;
      return it;
    }
    if (el.kind === 'compare') {
      const { cmp } = el;
      const it = new vscode.TreeItem(`${cmp.base} ↔ ${cmp.target}`, C.Expanded);
      it.id = `cmp:${cmp.base}:${cmp.target}`;
      it.description = `↑${cmp.ahead} ↓${cmp.behind} · ${cmp.files.length} 文件 ${statLine(cmp.add, cmp.del)}`;
      it.iconPath = new vscode.ThemeIcon('git-compare');
      it.contextValue = 'compare';
      it.tooltip = `${cmp.base}（对比点 ${shortRef(cmp.leftRef)}）→ ${cmp.target}`;
      return it;
    }
    if (el.kind === 'dir') {
      const it = new vscode.TreeItem(el.name, C.Expanded);
      it.id = `${ownerKey(el.owner)}/dir:${el.relPath}`;
      it.resourceUri = itemUri(el.owner, el.relPath, '');
      it.iconPath = vscode.ThemeIcon.Folder;
      it.description = `${el.count} · ${statLine(el.add, el.del)}`;
      it.tooltip = el.relPath;
      it.contextValue = 'dir';
      return it;
    }
    // file
    const f = el.file;
    const letter = f.status === 'U' ? 'U' : f.status;
    const it = new vscode.TreeItem(path.basename(f.path), C.None);
    // 和原生源代码管理一样：文件类型图标来自当前图标主题，右侧状态字母和文件名颜色来自 FileDecorationProvider
    it.resourceUri = itemUri(el.parent, f.path, letter);
    it.iconPath = vscode.ThemeIcon.File;
    const dir = path.dirname(f.path);
    const bits = [];
    if (dir !== '.' && fileLayout() === 'list') bits.push(dir);
    if (f.status === 'R' && !f.add && !f.del) bits.push(`重命名自 ${f.oldPath}`);
    else bits.push(f.binary ? '二进制' : statLine(f.add, f.del));
    if (f.uncommitted && f.status !== 'U') bits.push('未提交');
    it.description = bits.join(' · ');
    it.tooltip = `${STATUS_TEXT[letter] || letter}  ${f.status === 'R' ? f.oldPath + ' → ' : ''}${f.path}`;
    it.contextValue = 'file';
    it.command = { command: 'worktreeView.openFileDiff', title: '查看 diff', arguments: [el] };
    return it;
  }
}

function escapeMd(s) { return String(s || '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); }

let treeView;
function updateBadge(repos) {
  if (!treeView) return;
  const n = repos.reduce((acc, r) => acc + (r.worktrees || []).filter(w => !w.wt.isMain).length, 0);
  treeView.badge = n ? { value: n, tooltip: `${n} 个 worktree` } : undefined;
}

// ---------- 命令实现 ----------
function diffTitle(node) {
  const f = node.file;
  const p = node.parent;
  if (p.kind === 'worktree') return `${path.basename(f.path)} (${p.baseLabel} ↔ ${worktreeTitle(p)})`;
  return `${path.basename(f.path)} (${p.cmp.base} ↔ ${p.cmp.target})`;
}

async function openFileDiff(node) {
  const [, left, right] = fileUris(node);
  await vscode.commands.executeCommand('vscode.diff', left, right, diffTitle(node), { preview: true });
}

async function openAllChanges(node) {
  const files = node.kind === 'worktree' ? node.status.files : node.cmp.files;
  if (!files.length) { vscode.window.showInformationMessage('没有改动'); return; }
  const title = node.kind === 'worktree' ? `${node.baseLabel} ↔ ${worktreeTitle(node)}` : `${node.cmp.base} ↔ ${node.cmp.target}`;
  const resources = files.map(f => fileUris(new FileNode(node, f)));
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

function pickRepo(tree) {
  if (tree.repos.length <= 1) return Promise.resolve(tree.repos[0]);
  return vscode.window.showQuickPick(tree.repos.map(r => ({ label: r.name, description: r.root, repo: r })), { placeHolder: '选择仓库' })
    .then(x => x && x.repo);
}

async function pickRef(repo, placeHolder, { includeWorktrees = false, exclude, allowAuto = false } = {}) {
  const branches = await G.listBranches(repo.root);
  const items = [];
  if (allowAuto) items.push({ label: '$(sparkle) 自动推断', description: '每个 worktree 自动找它是从哪个分支拉出来的', auto: true });
  if (includeWorktrees) {
    items.push({ label: 'Worktree（含未提交改动）', kind: vscode.QuickPickItemKind.Separator });
    for (const w of repo.worktrees) {
      if (w.wt.path === exclude) continue;
      items.push({ label: `$(${w.wt.source.icon}) ${worktreeTitle(w)}`, description: w.wt.source.label, detail: w.wt.path, worktree: w });
    }
  }
  items.push({ label: '分支', kind: vscode.QuickPickItemKind.Separator });
  for (const b of branches) {
    const wt = repo.worktrees.find(w => w.wt.branch === b);
    items.push({ label: `$(git-branch) ${b}`, description: wt ? `检出于 ${wt.wt.source.label || 'worktree'}` : '', ref: b });
  }
  const qp = vscode.window.createQuickPick();
  qp.items = items;
  qp.placeholder = `${placeHolder}（也可直接输入 commit / tag）`;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  return new Promise(resolve => {
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      const typed = qp.value.trim();
      qp.hide();
      if (sel) resolve(sel.auto ? { auto: true } : sel.worktree ? { worktree: sel.worktree } : { ref: sel.ref });
      else if (typed) resolve({ ref: typed });
      else resolve(undefined);
    });
    qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
    qp.show();
  });
}

async function addCompare(tree, repo, base, target) {
  try {
    if (!(await G.refExists(repo.root, base))) throw new Error(`找不到 ${base}`);
    if (!(await G.refExists(repo.root, target))) throw new Error(`找不到 ${target}`);
    const r = await G.compareRefs(repo.root, base, target, compareMode());
    const cmp = { base, target, ...r };
    tree.compares = tree.compares.filter(c => !(c.cmp.base === base && c.cmp.target === target));
    const node = new CompareNode(repo, cmp);
    tree.compares.unshift(node);
    tree._emitter.fire();
    await openAllChanges(node);
  } catch (e) {
    vscode.window.showErrorMessage(`对比失败：${e.message}`);
  }
}

// ---------- 激活 ----------
function activate(context) {
  const tree = new WorktreeTree(context.globalState);
  const contentProvider = new RefContentProvider();
  treeView = vscode.window.createTreeView('worktreeView.list', { treeDataProvider: tree, showCollapseAll: true });
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(new ItemDecorations()),
  );

  reg('worktreeView.refresh', () => { contentProvider.invalidateAll(); tree.refresh(); });
  reg('worktreeView.openFileDiff', openFileDiff);
  reg('worktreeView.openAllChanges', node => node && openAllChanges(node));

  reg('worktreeView.openFile', async node => {
    if (!node || node.kind !== 'file') return;
    const [uri] = fileUris(node);
    if (node.file.status === 'D') { vscode.window.showInformationMessage('文件已被删除'); return; }
    await vscode.window.showTextDocument(uri, { preview: true });
  });

  reg('worktreeView.setBase', async () => {
    await tree.load();
    const repo = await pickRepo(tree);
    if (!repo) return;
    const sel = await pickRef(repo, `所有 worktree 统一和哪个分支比？`, { allowAuto: true });
    if (!sel) return;
    if (sel.auto) { await tree.setOverride('repo:' + repo.commonDir, null); return; }
    if (!(await G.refExists(repo.root, sel.ref))) { vscode.window.showErrorMessage(`找不到 ${sel.ref}`); return; }
    await tree.setOverride('repo:' + repo.commonDir, sel.ref);
  });

  reg('worktreeView.compare', async () => {
    await tree.load();
    const repo = await pickRepo(tree);
    if (!repo) return;
    const a = await pickRef(repo, '① 选择基准（左侧）');
    if (!a) return;
    const b = await pickRef(repo, `② 选择要和 ${a.ref} 对比的目标（右侧）`, { includeWorktrees: true });
    if (!b) return;
    if (b.worktree) {
      // worktree 作为目标：临时把基准换成 a，直接看它（含未提交改动）
      const status = await G.worktreeStatus(b.worktree.wt, a.ref, { mode: compareMode(), otherWorktreePaths: repo.worktrees.map(w => w.wt.path) });
      if (status.error) { vscode.window.showErrorMessage(status.error); return; }
      const node = new WorktreeNode(repo, b.worktree.wt, status, { ref: a.ref, reason: '临时对比' });
      await openAllChanges(node);
      return;
    }
    await addCompare(tree, repo, a.ref, b.ref);
  });

  reg('worktreeView.compareWith', async node => {
    if (!node || node.kind !== 'worktree') return;
    const sel = await pickRef(node.repo, `选择要与 ${worktreeTitle(node)} 对比的分支`, );
    if (!sel || !sel.ref) return;
    const otherRef = sel.ref;
    const mine = node.wt.branch || node.wt.head;
    await addCompare(tree, node.repo, otherRef, mine);
  });

  reg('worktreeView.setWorktreeBase', async node => {
    if (!node || node.kind !== 'worktree') return;
    const sel = await pickRef(node.repo, `${worktreeTitle(node)} 和哪个分支比？（当前 ${node.baseLabel}：${node.baseInfo.reason}）`,
      { allowAuto: true });
    if (!sel) return;
    if (sel.auto) { await tree.setOverride(node.wt.path, null); return; }
    if (!(await G.refExists(node.repo.root, sel.ref))) { vscode.window.showErrorMessage(`找不到 ${sel.ref}`); return; }
    await tree.setOverride(node.wt.path, sel.ref);
  });

  reg('worktreeView.removeCompare', node => {
    tree.compares = tree.compares.filter(c => c !== node);
    tree._emitter.fire();
  });

  reg('worktreeView.openInNewWindow', node => node && vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.wt.path), { forceNewWindow: true }));
  reg('worktreeView.openTerminal', node => {
    if (!node) return;
    vscode.window.createTerminal({ name: worktreeTitle(node), cwd: node.wt.path }).show();
  });
  reg('worktreeView.revealInFinder', node => node && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.wt.path)));
  reg('worktreeView.copyPath', async node => {
    if (!node) return;
    await vscode.env.clipboard.writeText(node.wt.path);
    vscode.window.setStatusBarMessage(`已复制 ${node.wt.path}`, 2000);
  });
  reg('worktreeView.copyBranch', async node => {
    if (!node) return;
    await vscode.env.clipboard.writeText(node.wt.branch || node.wt.head);
  });
  const setLayoutCtx = () => vscode.commands.executeCommand('setContext', 'worktreeView.fileLayout', fileLayout());
  setLayoutCtx();
  reg('worktreeView.viewAsTree', () => cfg().update('fileLayout', 'tree', vscode.ConfigurationTarget.Global));
  reg('worktreeView.viewAsList', () => cfg().update('fileLayout', 'list', vscode.ConfigurationTarget.Global));
  reg('worktreeView.toggleMode', async () => {
    const next = compareMode() === 'direct' ? 'mergeBase' : 'direct';
    await cfg().update('compareMode', next, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`对比模式：${next === 'direct' ? '直接对比基准分支最新' : 'merge-base（只看分支自己的改动）'}`, 3000);
  });

  // 自动刷新：视图可见时定时刷新；窗口重新获得焦点、配置变化、工作区变化时也刷新
  let timer;
  const schedule = () => {
    clearInterval(timer);
    const sec = Number(cfg().get('autoRefreshSeconds')) || 0;
    if (sec > 0) timer = setInterval(() => { if (treeView.visible) tree.refresh(); }, Math.max(3, sec) * 1000);
  };
  schedule();
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeWindowState(s => { if (s.focused && treeView.visible) tree.refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('worktreeView')) { setLayoutCtx(); schedule(); tree.refresh(); }
    }),
    vscode.workspace.onDidSaveTextDocument(() => { if (treeView.visible) tree.refresh(); }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
