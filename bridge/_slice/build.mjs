#!/usr/bin/env node
// build.mjs —— 按 manifest.json 把切好的片段按顺序原样拼回一个文件。
//
// 只做字节拼接：不改换行、不加分隔、不做任何文本替换、不解析片段。
// 片段本身不是能单独运行的模块（大多是同一个闭包里的一段），只有拼回去的整份才是。
// manifest 的格式见同目录的 MANIFEST.md。没有依赖，Node 18 起都能跑。
//
// 用法：
//   node build.mjs <manifest.json> --out <输出文件> [--force] [--verify] [--node-check]
//   node build.mjs <manifest.json> --verify
//
//   --out <文件>   写出拼好的文件（先写到旁边的临时文件再改名）。文件已经在时要加 --force。
//                  不写进 DSH 的数据目录（家目录下的 .dsh、.dsh-*、.config/billion-context，
//                  以及 DSH_HOME）：构建只出产物，换上线是另一步。输出文件所在的目录要已经在；
//                  判断前先把它解析成真路径（跟着 junction / 符号链接 / 8.3 短名走）；
//                  Windows 上 \\ 或 // 开头的路径（UNC、\\?\、\\.\）和带 :流 的路径一律不收，用盘符写。
//   --verify       核对每个片段的 sha256（manifest 里写了的话）和拼好以后整份的
//                  expect.sha256 / expect.bytes；对不上退出码 1。
//   --node-check   写出以后再跑一次 node --check（要和 --out 一起用）。
//
// 退出码：0 成功；1 核对没过（片段或整份的 sha、字节数、node --check）；2 用法或 manifest 有错。

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORMAT = 'fish-bridge-slice/1'

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const WIN = process.platform === 'win32'
const caseKey = (p) => (WIN ? p.toLowerCase() : p)

class UsageError extends Error {}

/** 读 manifest，返回按顺序排好的片段表 [{ path, abs, sha256?, bytes? , module }]。格式不对抛 UsageError。 */
export function readManifest(manifestPath) {
  let raw
  try { raw = readFileSync(manifestPath, 'utf8') } catch (err) { throw new UsageError(`读不了 manifest：${err.message}`) }
  let m
  try { m = JSON.parse(raw) } catch (err) { throw new UsageError(`manifest 不是 JSON：${err.message}`) }
  if (m === null || typeof m !== 'object') throw new UsageError('manifest 不是对象')
  if (m.format !== FORMAT) throw new UsageError(`format 必须是 ${FORMAT}`)
  if (!Array.isArray(m.modules) || m.modules.length === 0) throw new UsageError('modules 必须是非空数组')
  const root = realpathSync(dirname(resolve(manifestPath)))
  const seen = new Set()
  const seenReal = new Set() // 解析以后的真路径：大小写不同、经链接的同一个文件也算重复
  const ids = new Set()
  const files = []
  for (const mod of m.modules) {
    if (mod === null || typeof mod !== 'object' || typeof mod.id !== 'string' || mod.id === '') throw new UsageError('每个模块要有 id')
    if (ids.has(mod.id)) throw new UsageError(`模块 id 重复：${mod.id}`)
    ids.add(mod.id)
    if (!Array.isArray(mod.files) || mod.files.length === 0) throw new UsageError(`模块 ${mod.id} 没有 files`)
    for (const f of mod.files) {
      const p = f?.path
      if (typeof p !== 'string' || p === '') throw new UsageError(`模块 ${mod.id} 里有片段没写 path`)
      if (p.includes('\\') || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        throw new UsageError(`片段路径只许写成相对、用 / 分隔、不带 . 和 ..：${p}`)
      }
      if (seen.has(p)) throw new UsageError(`同一个片段列了两次：${p}`)
      seen.add(p)
      let abs
      try { abs = realpathSync(join(root, ...p.split('/'))) } catch (err) { throw new UsageError(`片段不在：${p}（${err.code ?? err.message}）`) }
      const rel = relative(root, abs)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`片段跑到 manifest 目录外面去了：${p}`)
      if (!statSync(abs).isFile()) throw new UsageError(`片段不是文件：${p}`)
      const realKey = caseKey(realpathSync.native(abs))
      if (seenReal.has(realKey)) throw new UsageError(`同一个片段列了两次（换了大小写或经链接）：${p}`)
      seenReal.add(realKey)
      if (f.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(f.sha256)) throw new UsageError(`片段 sha256 格式不对：${p}`)
      files.push({ path: p, abs, sha256: f.sha256, bytes: f.bytes, module: mod.id })
    }
  }
  const expect = m.expect ?? {}
  if (expect.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(expect.sha256)) throw new UsageError('expect.sha256 格式不对')
  return { manifest: m, files, expect }
}

/** 拼：返回 { buf, problems }。problems 是片段 sha / 字节数对不上的说明（只在 verify 时填）。 */
export function concat(files, { verify = false } = {}) {
  const parts = []
  const problems = []
  for (const f of files) {
    const b = readFileSync(f.abs)
    if (verify) {
      if (f.sha256 !== undefined && sha256(b) !== f.sha256) problems.push(`片段 sha256 对不上：${f.path}`)
      if (f.bytes !== undefined && b.length !== f.bytes) problems.push(`片段字节数对不上：${f.path}（${b.length} ≠ ${f.bytes}）`)
    }
    parts.push(b)
  }
  return { buf: Buffer.concat(parts), problems }
}

// Windows 会去掉每段末尾的点和空格（`.dsh.` 就是 `.dsh`），比较前照样去掉。
const trimSeg = (s) => (WIN ? s.replace(/[. ]+$/, '') : s)
const realOr = (p) => { try { return realpathSync.native(p) } catch { return p } }
const liveRoots = (home) => {
  const roots = [join(home, '.dsh'), join(home, '.config', 'billion-context')]
  if (process.env.DSH_HOME) roots.push(resolve(process.env.DSH_HOME))
  return [...roots, ...roots.map(realOr)]
}
const underRoot = (p, r) => {
  const segs = caseKey(p).split(sep).map(trimSeg)
  const rs = caseKey(r).split(sep).map(trimSeg).filter((s, i, a) => s !== '' || i < a.length - 1)
  return rs.every((s, i) => segs[i] === s)
}
/** 输出路径落不落在 DSH 的数据目录里。路径拿不准（UNC、\\?\、带流、目录不在）时抛 UsageError。 */
export function insideLive(out) {
  if (WIN && (/^[\\/]{2}/.test(out) || /:/.test(out.replace(/^[A-Za-z]:/, '')))) {
    throw new UsageError(`输出路径用盘符写（不收 UNC、\\\\?\\、\\\\.\\ 和带 :流 的写法）：${out}`)
  }
  const target = resolve(out)
  const dir = dirname(target)
  let realDir
  try { realDir = realpathSync.native(dir) } catch { throw new UsageError(`输出目录不在：${dir}`) }
  const real = join(realDir, basename(target))
  const homes = [...new Set([homedir(), realOr(homedir())])]
  for (const p of [target, real]) {
    for (const home of homes) {
      if (liveRoots(home).some((r) => underRoot(p, r))) return true
      // 家目录下以 .dsh 开头的目录或文件（.dsh、.dsh-*：DSH 和插件各自的数据目录）
      const rel = relative(home, p)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && /^\.dsh(-|$)/i.test(trimSeg(rel.split(sep)[0]))) return true
    }
  }
  return false
}

function main(argv) {
  const args = argv.slice(2)
  const take = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} 后面要跟值`)
    args.splice(i, 2)
    return v
  }
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true }
  const out = take('--out')
  const force = has('--force')
  const verify = has('--verify')
  const nodeCheck = has('--node-check')
  if (args.length !== 1 || args[0].startsWith('--')) throw new UsageError('用法：node build.mjs <manifest.json> [--out <文件>] [--force] [--verify] [--node-check]')
  if (nodeCheck && out === undefined) throw new UsageError('--node-check 要和 --out 一起用')
  if (out === undefined && !verify) throw new UsageError('至少给 --out 或 --verify 之一')

  const { files, expect } = readManifest(args[0])
  const { buf, problems } = concat(files, { verify })
  const digest = sha256(buf)
  if (verify) {
    if (expect.sha256 !== undefined && digest !== expect.sha256) problems.push(`整份 sha256 对不上：${digest} ≠ ${expect.sha256}`)
    if (expect.bytes !== undefined && buf.length !== expect.bytes) problems.push(`整份字节数对不上：${buf.length} ≠ ${expect.bytes}`)
  }

  if (out !== undefined) {
    const target = resolve(out)
    if (insideLive(out)) throw new UsageError(`不往 DSH 的数据目录里写：${target}`)
    if (existsSync(target) && !force) throw new UsageError(`${target} 已经在了（要覆盖加 --force）`)
    const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
    writeFileSync(tmp, buf, { flag: 'wx' })
    try { renameSync(tmp, target) } catch (err) { rmSync(tmp, { force: true }); throw err }
    if (nodeCheck) {
      const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
      if (r.status !== 0) problems.push(`node --check 没过：${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
    }
  }

  console.log(`${digest}  ${buf.length} bytes  ${files.length} files${out !== undefined ? `  → ${resolve(out)}` : ''}`)
  if (problems.length > 0) {
    for (const p of problems) console.error(`build: ${p}`)
    return 1
  }
  if (verify) console.log('build: verify ok')
  return 0
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  try {
    process.exitCode = main(process.argv)
  } catch (err) {
    if (err instanceof UsageError) { console.error(`build: ${err.message}`); process.exitCode = 2 } else throw err
  }
}
