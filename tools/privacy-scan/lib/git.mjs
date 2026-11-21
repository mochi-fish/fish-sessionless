// 从 git 仓库取「要推出去的那一份」：给定的提交及其全部历史里出现过的每个 (blob, 路径)、
// 每个提交的说明和作者 / 提交者、要推的引用名、（可选）标签。只读：不碰工作树、不碰 index。
import { spawnSync } from 'node:child_process'

// GIT_NO_REPLACE_OBJECTS：refs/replace 换掉的对象，扫描时也看原样（git push 推的是原样）
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' }

export function git (repo, args, input) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], {
    input, env: GIT_ENV, maxBuffer: 1024 * 1024 * 1024, windowsHide: true,
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`git ${args[0]} 失败（${r.status}）：${String(r.stderr).trim().slice(0, 300)}`)
  return r.stdout
}

export function revParse (repo, rev) {
  return String(git(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim()
}

/** revs 能到的全部提交（新的在前） */
export function listCommits (repo, revs) {
  const out = String(git(repo, ['rev-list', ...revs, '--'])).trim()
  return out ? out.split('\n') : []
}

/** 一个提交的整棵树：[{ mode, type, sha, path }] */
export function lsTree (repo, commit) {
  const out = String(git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]))
  const res = []
  for (const rec of out.split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    const [mode, type, sha] = rec.slice(0, tab).split(' ')
    res.push({ mode, type, sha, path: rec.slice(tab + 1) })
  }
  return res
}

/** 批量读 blob：Map<sha, Buffer> */
export function readBlobs (repo, shas) {
  const map = new Map()
  const list = [...new Set(shas)]
  if (!list.length) return map
  const out = git(repo, ['cat-file', '--batch'], list.join('\n') + '\n')
  let o = 0
  while (o < out.length) {
    const nl = out.indexOf(10, o)
    const head = out.toString('latin1', o, nl)
    const [sha, type, sizeS] = head.split(' ')
    if (type === 'missing') throw new Error(`读不到对象 ${sha}`)
    const size = Number(sizeS)
    map.set(sha, out.subarray(nl + 1, nl + 1 + size))
    o = nl + 1 + size + 1
  }
  return map
}

/** 提交的说明、作者、提交者 */
export function commitMeta (repo, revs) {
  const out = String(git(repo, ['log', '-z', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B', ...revs, '--']))
  const res = []
  for (const rec of out.split('\0')) {
    if (!rec.trim()) continue
    const [sha, an, ae, cn, ce, ...msg] = rec.split('\x1f')
    res.push({ sha: sha.trim(), an, ae, cn, ce, message: msg.join('\x1f') })
  }
  return res
}

export function tagMeta (repo) {
  const out = String(git(repo, ['for-each-ref', '--format=%(refname)%1f%(objecttype)%1f%(taggername)%1f%(taggeremail)%1f%(contents)%00', 'refs/tags']))
  const res = []
  for (const rec of out.split('\0')) {
    if (!rec.trim()) continue
    const [ref, type, tn, te, ...msg] = rec.replace(/^\n/, '').split('\x1f')
    res.push({ ref, type, tn, te, message: msg.join('\x1f') })
  }
  return res
}

/**
 * 要扫的全部东西。
 *   revs：要推的提交（或引用）；history 为 false 时只取 revs 本身的树。
 *   返回 { commits, blobs: [{ sha, path, mode, commit, inHead }], texts: [{ path, text }], headSha }
 */
export function collectGit (repo, { revs = ['HEAD'], history = true, tags = false } = {}) {
  const resolved = revs.map((r) => revParse(repo, r))
  const commits = history ? listCommits(repo, resolved) : resolved
  const headSet = new Set()
  for (const c of resolved) for (const e of lsTree(repo, c)) headSet.add(`${e.sha}\0${e.path}`)
  const pairs = new Map()
  for (const c of commits) {
    for (const e of lsTree(repo, c)) {
      const k = `${e.sha}\0${e.path}`
      if (!pairs.has(k)) pairs.set(k, { sha: e.sha, path: e.path, mode: e.mode, type: e.type, commit: c, inHead: headSet.has(k) })
    }
  }
  const texts = []
  for (const m of history ? commitMeta(repo, resolved) : commitMeta(repo, ['--no-walk', ...resolved])) {
    const short = m.sha.slice(0, 10)
    texts.push({ path: `<commit ${short} message>`, text: m.message })
    texts.push({ path: `<commit ${short} author>`, text: `${m.an} <${m.ae}>` })
    texts.push({ path: `<commit ${short} committer>`, text: `${m.cn} <${m.ce}>` })
  }
  for (const r of revs) texts.push({ path: '<ref name>', text: r })
  if (tags) {
    for (const t of tagMeta(repo)) {
      texts.push({ path: `<tag ${t.ref}>`, text: `${t.ref}\n${t.tn ?? ''} ${t.te ?? ''}\n${t.message}` })
    }
  }
  return { commits, resolved, blobs: [...pairs.values()], texts }
}
