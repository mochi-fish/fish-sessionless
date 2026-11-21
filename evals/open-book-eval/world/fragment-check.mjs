#!/usr/bin/env node
// 碎片核对（发给任何外面的模型之前跑一次）：合成世界里有没有哪一段和她真记录的拷贝撞上。
//   node world/fragment-check.mjs --world <世界目录> --snapshot <她记录的拷贝目录> [--out <结果.json>] [--allow <允许的窗口.json>]
//
// 做法（照早先一版隐私闸（guard.py）的口径）：
//   - 两边都先 NFKC、去空白。
//   - 世界这边：所有字串里每个起点的 12 字窗口（含至少 6 个汉字的）全收进一个集合（步长 1），记住它出自哪一项（只记编号）。
//   - 拷贝这边：按步长 6 扫 12 字窗口（含至少 6 个汉字的）去集合里查。两边共有 ≥17 字的一段一定会被扫到。
//   - 拷贝里的 .zst 用 zlib 解开再扫；.db / .sqlite 当字节读（不用 SQLite 打开）；别的按 UTF-8 读。
// 只输出编号和计数：文件用相对路径的 sha256 前 12 位，世界那边用「文件:事件编号」，不输出任何一段正文。
// 拷贝目录不许在线上的根下面、不许是真家目录（isolation.assertNotLive）。这个脚本只读不写（--out 除外，写在实验目录里）。
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { zstdDecompressAll } from '../fwd/lib/zstd-frames.mjs'

export const WIN = 12
export const MIN_HAN = 6
export const STRIDE = 6
const HAN = /\p{Script=Han}/u
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const prep = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '')

function hanCount (chars, i) {
  let n = 0
  for (let k = i; k < i + WIN; k++) if (HAN.test(chars[k])) n++
  return n
}

/** 世界目录 → Map(窗口 → 出处编号)。只收会进模型眼前或判分的那些字。 */
export function worldWindows (worldDir, { allow = new Set() } = {}) {
  const map = new Map()
  const add = (ref, text) => {
    const cs = [...prep(text)]
    for (let i = 0; i + WIN <= cs.length; i++) {
      if (hanCount(cs, i) < MIN_HAN) continue
      const w = cs.slice(i, i + WIN).join('')
      if (allow.has(w)) continue
      if (!map.has(w)) map.set(w, ref)
    }
  }
  const rd = (rel) => readFileSync(join(worldDir, rel), 'utf8')
  for (const line of rd('timeline.jsonl').split('\n')) {
    if (!line) continue
    const e = JSON.parse(line)
    add(`timeline:${e.id}`, [e.text, e.ja ?? '', e.sum ?? '', e.tool ? JSON.stringify(e.tool) : ''].join('\n'))
  }
  for (const it of JSON.parse(rd('items.json'))) for (const [H, h] of Object.entries(it.halves)) add(`items:${it.id}.${H}`, JSON.stringify(h))
  const meta = JSON.parse(rd('meta.json'))
  for (const cut of meta.cuts) {
    add(`system-${cut}`, rd(`system-${cut}.txt`))
    for (const b of JSON.parse(rd(`blocks-${cut}.json`))) add(`blocks-${cut}:${b.blockId}`, b.summary)
  }
  const mem = JSON.parse(rd('stores/mem.json'))
  for (const m of mem.memories) add(`mem:${m.id}`, `${m.title}\n${m.content}`)
  for (const t of mem.threads ?? []) add(`mem:${t.id}`, JSON.stringify(t))
  add('fish-seed', rd('stores/fish-seed.json'))
  return map
}

function* walk (dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) yield* walk(p)
    else if (st.isFile()) yield { p, size: st.size }
  }
}

/** 一个文件的文字，分块交给 cb（块之间留 WIN-1 个字的重叠）。 */
function eachChunk (file, cb) {
  const ext = extname(file).toLowerCase()
  if (ext === '.zst') {
    // 账本的 .zst 是一帧接一帧追加的（单帧解只拿到第一帧）：逐帧解开
    const r = zstdDecompressAll(readFileSync(file))
    cb(r.text)
    return Buffer.byteLength(r.text)
  }
  if (ext === '.gz') {
    const buf = zlib.gunzipSync(readFileSync(file))
    cb(buf.toString('utf8'))
    return buf.length
  }
  const fd = openSync(file, 'r')
  const dec = new TextDecoder('utf-8', { fatal: false })
  const buf = Buffer.alloc(8 * 1024 * 1024)
  let carry = ''
  let total = 0
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      total += n
      const text = carry + dec.decode(buf.subarray(0, n), { stream: true })
      cb(text)
      const cs = [...text]
      carry = cs.slice(Math.max(0, cs.length - (WIN - 1))).join('')
    }
    const tail = dec.decode()
    if (tail) cb(carry + tail)
  } finally { closeSync(fd) }
  return total
}

export function scanSnapshot (snapshotDir, windows) {
  const byFile = []
  const byRef = {}
  let files = 0
  let bytes = 0
  let hits = 0
  for (const { p } of walk(snapshotDir)) {
    files++
    let fileHits = 0
    const seen = new Set()
    try {
      bytes += eachChunk(p, (text) => {
        const cs = [...prep(text)]
        for (let i = 0; i + WIN <= cs.length; i += STRIDE) {
          if (hanCount(cs, i) < MIN_HAN) continue
          const w = cs.slice(i, i + WIN).join('')
          const ref = windows.get(w)
          if (ref === undefined || seen.has(w)) continue
          seen.add(w)
          fileHits++
          byRef[ref] = (byRef[ref] ?? 0) + 1
        }
      })
    } catch (e) {
      byFile.push({ fileId: sha12(relative(snapshotDir, p)), ext: extname(p).toLowerCase(), error: String(e?.code ?? 'read-failed') })
      continue
    }
    if (fileHits) byFile.push({ fileId: sha12(relative(snapshotDir, p)), ext: extname(p).toLowerCase(), hits: fileHits })
    hits += fileHits
  }
  return { files, bytes, hits, byFile, byRef }
}

function parseArgs (argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
  return o
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (!a.world || !a.snapshot) throw new Error('要 --world <世界目录> --snapshot <拷贝目录>')
  const { assertNotLive } = await import('../lib/isolation.mjs')
  const worldDir = resolve(String(a.world))
  const snap = resolve(String(a.snapshot))
  assertNotLive(snap, '她记录的拷贝目录')
  assertNotLive(worldDir, '世界目录')
  const allow = new Set(a.allow ? JSON.parse(readFileSync(String(a.allow), 'utf8')) : [])
  const windows = worldWindows(worldDir, { allow })
  const meta = JSON.parse(readFileSync(join(worldDir, 'meta.json'), 'utf8'))
  const r = scanSnapshot(snap, windows)
  const out = { worldId: meta.worldId, contentSha: meta.contentSha, window: WIN, minHan: MIN_HAN, stride: STRIDE, worldWindows: windows.size, allowed: allow.size, ...r, ok: r.hits === 0, at: new Date().toISOString() }
  if (a.out) { const o = resolve(String(a.out)); assertNotLive(o, '结果文件'); writeFileSync(o, JSON.stringify(out, null, 1)) }
  console.log(JSON.stringify({ worldId: out.worldId, worldWindows: out.worldWindows, files: out.files, bytes: out.bytes, hits: out.hits, ok: out.ok, refs: Object.keys(out.byRef).length }, null, 1))
  process.exitCode = out.ok ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch((e) => { console.error(e?.message ?? e); process.exitCode = 2 })
