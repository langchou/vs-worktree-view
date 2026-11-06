'use strict';
// 纯 git 层：不依赖 vscode，方便单独测试。
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 64 * 1024 * 1024;

class GitError extends Error {}

function git(args, cwd, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          reject(new GitError((stderr || err.message).trim()));
        } else {
          resolve(stdout || '');
        }
      });
  });
}

function assertRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\s]/.test(ref)) {
    throw new GitError(`非法的 ref: ${ref}`);
  }
  return ref;
}

/** 返回仓库公共信息；cwd 不在 git 仓库内时返回 null */
async function repoInfo(cwd) {
  const out = await git(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], cwd, { allowFail: true });
  const [commonDir, toplevel] = out.trim().split('\n');
  if (!commonDir || !toplevel) return null;
  return { commonDir: fs.realpathSync(commonDir), toplevel };
}

/** 解析 `git worktree list --porcelain`。无论 worktree 建在 .claude/、.agent/ 还是仓库外，git 都会登记在这里。 */
async function listWorktrees(cwd) {
  const out = await git(['worktree', 'list', '--porcelain'], cwd);
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  list.forEach((w, i) => { w.isMain = i === 0; });
  return list;
}

/** 默认的来源识别规则，可在设置里覆盖/追加 */
const DEFAULT_SOURCES = [
  { pattern: '/.claude/worktrees/', label: 'Claude', icon: 'sparkle' },
  { pattern: '/.claude-worktrees/', label: 'Claude', icon: 'sparkle' },
  { pattern: '/.claude/', label: 'Claude', icon: 'sparkle' },
  { pattern: '/\\.agents?/', label: 'Agent', icon: 'robot', regex: true },
  { pattern: '/.codex/', label: 'Codex', icon: 'hubot' },
  { pattern: '/.cursor/', label: 'Cursor', icon: 'symbol-event' },
  { pattern: '/.gemini/', label: 'Gemini', icon: 'star-full' },
  { pattern: '/.worktrees/', label: 'Worktree', icon: 'git-branch' },
  { pattern: '/conductor/', label: 'Conductor', icon: 'organization' },
];

function detectSource(wtPath, rules) {
  const p = wtPath.endsWith('/') ? wtPath : wtPath + '/';
  for (const r of rules) {
    try {
      const hit = r.regex ? new RegExp(r.pattern).test(p) : p.includes(r.pattern);
      if (hit) return { label: r.label, icon: r.icon || 'git-branch' };
    } catch { /* 坏的正则直接跳过 */ }
  }
  return null;
}

async function refExists(cwd, ref) {
  const out = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, { allowFail: true });
  return out.trim() || null;
}

/** 自动推断基准分支：origin/HEAD → main → master → 主工作区当前分支 */
async function detectBase(cwd, mainWorktree) {
  const sym = (await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd, { allowFail: true })).trim();
  if (sym) {
    const local = sym.replace(/^origin\//, '');
    if (await refExists(cwd, local)) return local;
    return sym;
  }
  for (const b of ['main', 'master', 'develop', 'trunk']) {
    if (await refExists(cwd, b)) return b;
  }
  if (mainWorktree && mainWorktree.branch) return mainWorktree.branch;
  return 'HEAD';
}

async function listBranches(cwd) {
  const out = await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'], cwd);
  return out.split('\n').filter(r => r && !r.endsWith('/HEAD')).map(r => r.replace(/^refs\/(heads|remotes)\//, ''));
}

/** 解析 `--name-status -z` 与 `--numstat -z`，合并成文件列表 */
function parseNameStatus(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    const code = st[0];
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      files.push({ status: code, oldPath, path: newPath });
    } else {
      const p = parts[i++];
      files.push({ status: code, oldPath: p, path: p });
    }
  }
  return files;
}

function parseNumstat(out) {
  const map = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length;) {
    const rec = parts[i++];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    let file = p;
    if (p === '') { i++; file = parts[i++]; } // 重命名：旧路径、新路径各占一段
    const binary = a === '-';
    map.set(file, { add: binary ? 0 : Number(a), del: binary ? 0 : Number(d), binary });
  }
  return map;
}

function countLines(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { add: 0, binary: false };
    if (st.size > 2 * 1024 * 1024) return { add: 0, binary: true };
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return { add: 0, binary: true };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return { add: n, binary: false };
  } catch {
    return { add: 0, binary: false };
  }
}

async function diffFiles(cwd, rangeArgs) {
  const [ns, num] = await Promise.all([
    git(['diff', '--no-color', '-M', '--name-status', '-z', ...rangeArgs, '--'], cwd),
    git(['diff', '--no-color', '-M', '--numstat', '-z', ...rangeArgs, '--'], cwd),
  ]);
  const stats = parseNumstat(num);
  return parseNameStatus(ns).map(f => ({ ...f, ...(stats.get(f.path) || { add: 0, del: 0, binary: false }) }));
}

/**
 * 某个 worktree 相对基准的状态：包含已提交 + 未提交 + 未跟踪的改动。
 * otherWorktreePaths 用来排除嵌套在本目录里的其他 worktree（例如主工作区下的 .claude/worktrees/*）。
 */
async function worktreeStatus(wt, base, { mode = 'mergeBase', otherWorktreePaths = [], workingOnly = false } = {}) {
  const cwd = wt.path;
  const res = { mergeBase: null, compareRef: null, upstream: null, ahead: 0, behind: 0, files: [], add: 0, del: 0, dirty: 0, lastCommit: null, error: null };
  if (wt.bare || wt.prunable || !fs.existsSync(cwd)) {
    res.error = wt.prunable ? '目录已不存在（可执行 git worktree prune）' : '无法访问';
    return res;
  }
  try {
    const head = wt.head || 'HEAD';
    if (workingOnly) {
      // 只看未提交改动（和 VS Code 源代码管理一致）；领先/落后按上游分支算
      res.upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd, { allowFail: true })).trim() || null;
      base = res.upstream || head;
    }
    assertRef(base);
    const [mb, lr, last, statusOut] = await Promise.all([
      git(['merge-base', base, head], cwd, { allowFail: true }),
      git(['rev-list', '--left-right', '--count', `${base}...${head}`], cwd, { allowFail: true }),
      git(['log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%an', head], cwd, { allowFail: true }),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd, { allowFail: true }),
    ]);
    res.mergeBase = mb.trim() || null;
    const [behind, ahead] = lr.trim().split(/\s+/).map(Number);
    res.behind = behind || 0;
    res.ahead = ahead || 0;
    const [h, s, r, a] = last.trim().split('\x1f');
    if (h) res.lastCommit = { hash: h, subject: s, relTime: r, author: a };

    const nested = otherWorktreePaths
      .filter(p => p !== cwd && p.startsWith(cwd + '/'))
      .map(p => path.relative(cwd, p));
    const isNested = raw => {
      const rel = raw.replace(/\/$/, '');
      return nested.some(n => rel === n || rel.startsWith(n + '/') || n.startsWith(rel + '/'));
    };

    // 未提交改动集合（用来给文件打 “未提交” 标记）
    const uncommitted = new Set();
    const st = statusOut.split('\0');
    for (let i = 0; i < st.length; i++) {
      const rec = st[i];
      if (!rec) continue;
      const xy = rec.slice(0, 2);
      const p = rec.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') i++; // 跳过旧路径
      if (isNested(p)) continue;
      uncommitted.add(p.replace(/\/$/, ''));
    }
    res.dirty = uncommitted.size;

    // 统一解析成 commit SHA：分支前进后 diff 的 URI 也会变，避免 VS Code 缓存旧内容
    if (workingOnly) res.compareRef = (await refExists(cwd, head)) || head;
    else res.compareRef = mode === 'direct' ? (await refExists(cwd, base)) || base : (res.mergeBase || base);
    const tracked = await diffFiles(cwd, [res.compareRef]);

    const untrackedOut = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd, { allowFail: true });
    const untracked = untrackedOut.split('\0').filter(p => p && !p.endsWith('/') && !isNested(p)).map(p => {
      const c = countLines(path.join(cwd, p));
      return { status: 'U', oldPath: p, path: p, add: c.add, del: 0, binary: c.binary };
    });

    res.files = [...tracked, ...untracked]
      .filter(f => !isNested(f.path))
      .map(f => ({ ...f, uncommitted: uncommitted.has(f.path) || f.status === 'U' }))
      .sort((x, y) => x.path.localeCompare(y.path));
    for (const f of res.files) { res.add += f.add; res.del += f.del; }
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

/**
 * 推断某个 worktree 分支是从哪个分支拉出来的。
 * 1. 分支 reflog 里的 "branch: Created from X"（git worktree add -b x path main 会记录）
 * 2. 否则在所有分支里找“这个分支独有提交最少”的那个，相同时取分叉点最新（对方独有提交最少）的；
 *    再相同则优先主工作区分支 > 默认分支 > 本地分支 > 远程分支。
 * exclude：其他 worktree 正在用的分支（AI 并行开的分支不应该互相当基准）
 */
async function inferBase(cwd, wt, { preferred = [], exclude = [] } = {}) {
  const branch = wt.branch;
  const head = wt.head || 'HEAD';
  if (branch) {
    const reflog = await git(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], cwd, { allowFail: true });
    const first = reflog.trim().split('\n').pop() || '';
    const m = first.match(/^branch: Created from (.+)$/);
    if (m) {
      const ref = m[1].trim().replace(/^refs\/(heads|remotes)\//, '');
      if (ref !== 'HEAD' && !/^[0-9a-f]{7,40}$/.test(ref) && !ref.startsWith('-') && ref !== branch && await refExists(cwd, ref)) {
        return { ref, reason: `git 记录：从 ${ref} 创建` };
      }
    }
  }
  const excluded = new Set([branch, ...exclude].filter(Boolean));
  const out = await git(['for-each-ref', `--format=%(refname)%00%(ahead-behind:${head})`, 'refs/heads', 'refs/remotes'], cwd, { allowFail: true });
  const cands = [];
  for (const line of out.split('\n')) {
    const [full, ab] = line.split('\0');
    if (!full || !ab || full.endsWith('/HEAD')) continue;
    const local = full.startsWith('refs/heads/');
    const short = full.replace(/^refs\/(heads|remotes)\//, '');
    const bare = local ? short : short.replace(/^[^/]+\//, '');
    if (excluded.has(bare)) continue; // 自己、自己的远程分支、其他 worktree 的分支
    const [theirs, mine] = ab.split(' ').map(Number);
    const pref = preferred.indexOf(short);
    cands.push({ ref: short, mine, theirs, rank: pref >= 0 ? pref : preferred.length + (local ? 0 : 1) });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.mine - b.mine || a.theirs - b.theirs || a.rank - b.rank);
  const c = cands[0];
  return { ref: c.ref, reason: `推断：本分支在 ${c.ref} 之上有 ${c.mine} 个提交` };
}

/** 两个 ref 之间的比较（只看已提交内容） */
async function compareRefs(cwd, base, target, mode = 'mergeBase') {
  assertRef(base); assertRef(target);
  const baseSha = (await refExists(cwd, base)) || base;
  const targetSha = (await refExists(cwd, target)) || target;
  let left = baseSha;
  if (mode !== 'direct') {
    left = (await git(['merge-base', baseSha, targetSha], cwd, { allowFail: true })).trim() || baseSha;
  }
  const files = await diffFiles(cwd, [left, targetSha]);
  const [behind, ahead] = (await git(['rev-list', '--left-right', '--count', `${base}...${target}`], cwd, { allowFail: true }))
    .trim().split(/\s+/).map(Number);
  let add = 0, del = 0;
  for (const f of files) { add += f.add; del += f.del; }
  return { leftRef: left, rightRef: targetSha, files, add, del, ahead: ahead || 0, behind: behind || 0 };
}

/** 读取某个 ref 下的文件内容；不存在则返回空串 */
async function showFile(cwd, ref, relPath) {
  if (!ref) return '';
  assertRef(ref);
  return git(['show', `${ref}:${relPath}`], cwd, { allowFail: true });
}

async function commitsBetween(cwd, base, target, limit = 50) {
  assertRef(base); assertRef(target);
  const out = await git(['log', `--max-count=${limit}`, '--format=%h%x1f%s%x1f%cr%x1f%an', `${base}..${target}`], cwd, { allowFail: true });
  return out.split('\n').filter(Boolean).map(l => {
    const [hash, subject, relTime, author] = l.split('\x1f');
    return { hash, subject, relTime, author };
  });
}

module.exports = {
  GitError, git, repoInfo, listWorktrees, detectSource, DEFAULT_SOURCES, detectBase, listBranches,
  worktreeStatus, inferBase, compareRefs, showFile, commitsBetween, refExists,
};
