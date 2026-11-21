// 原话指纹：把文字规整成「单位」序列，按固定宽度的窗口取带密钥的哈希。
//
// 生成方（私有层）和扫描方（这里）必须用同一套规整和取哈希的办法，所以公开在这里；
// 密钥和指纹库本身只在生成它的那台机器上，不进任何仓库。
//
// 规整：NFKC → 只留字母和数字（任何文字的），丢掉空白、标点、符号、表情 → 小写。
// 窗口：连续 window 个单位；窗口里 CJK（汉字、假名、谚文）少于 minCjk 个的不取（纯英文、代码不进指纹）。
// 哈希：HMAC-SHA256(密钥, 窗口文字) 的前 53 位，存成 JS 的安全整数。
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

export const FP_DEFAULTS = Object.freeze({ window: 12, minCjk: 6, minRun: 1 })

const KEEP = /[\p{L}\p{N}]/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * 规整。返回 { s, units, cjk, pos }：
 *   s     NFKC 以后的整串（行号按它算，NFKC 不增减换行）
 *   units 单位数组（每个是一个字符，已小写）
 *   cjk   Uint8Array，对应单位是不是 CJK
 *   pos   Int32Array，对应单位在 s 里的下标
 */
export function normalizeUnits (text) {
  const s = String(text ?? '').normalize('NFKC')
  const units = []
  const cjk = []
  const pos = []
  let i = 0
  for (const ch of s) {
    if (KEEP.test(ch)) {
      units.push(ch.toLowerCase())
      cjk.push(CJK.test(ch) ? 1 : 0)
      pos.push(i)
    }
    i += ch.length
  }
  return { s, units, cjk: Uint8Array.from(cjk), pos: Int32Array.from(pos) }
}

/** 规整后的纯文字（给「整句在不在」这类对照用） */
export function normalizedString (text) {
  return normalizeUnits(text).units.join('')
}

/** 带密钥的窗口哈希：53 位安全整数 */
export function windowHash (key, str) {
  const d = createHmac('sha256', key).update(str, 'utf8').digest()
  return (d.readUInt32BE(0) & 0x1fffff) * 4294967296 + d.readUInt32BE(4)
}

/**
 * 逐个窗口回调 cb(start, hash)。只对 CJK 够数的窗口取哈希。
 * norm 是 normalizeUnits 的结果。
 */
export function forEachWindow (norm, { key, window, minCjk }, cb) {
  const { units, cjk } = norm
  const n = units.length
  if (n < window) return
  let c = 0
  for (let i = 0; i < window; i++) c += cjk[i]
  for (let i = 0; ; i++) {
    if (c >= minCjk) cb(i, windowHash(key, units.slice(i, i + window).join('')))
    if (i + window >= n) break
    c += cjk[i + window] - cjk[i]
  }
}

/** 一批文字 → 窗口哈希集合；exclude 里有的不要 */
export function buildFingerprintSet (texts, opts, exclude = null) {
  const set = new Set()
  for (const t of texts) {
    const norm = normalizeUnits(t)
    forEachWindow(norm, opts, (_, h) => { if (!exclude || !exclude.has(h)) set.add(h) })
  }
  return set
}

/**
 * 在一段已规整的文字里找命中的连续窗口。
 * 返回 [{ startUnit, endUnit, windows }]（endUnit 不含），只返回 windows >= minRun 的。
 */
export function matchRuns (norm, set, opts) {
  const runs = []
  const minRun = opts.minRun ?? 1
  let cur = null
  forEachWindow(norm, opts, (i, h) => {
    if (!set.has(h)) return
    if (cur && i === cur.last + 1) { cur.last = i; cur.windows++; return }
    if (cur && cur.windows >= minRun) runs.push(cur)
    cur = { first: i, last: i, windows: 1 }
  })
  if (cur && cur.windows >= minRun) runs.push(cur)
  return runs.map((r) => ({ startUnit: r.first, endUnit: r.last + opts.window, windows: r.windows }))
}

// ---- 指纹库文件：'FPS1' + window(u32) + minCjk(u32) + count(u32) + count × (hi u32, lo u32) ----

export function writeFingerprintFile (file, set, { window, minCjk }) {
  const arr = [...set].sort((a, b) => a - b)
  const buf = Buffer.alloc(16 + arr.length * 8)
  buf.write('FPS1', 0, 'latin1')
  buf.writeUInt32BE(window, 4)
  buf.writeUInt32BE(minCjk, 8)
  buf.writeUInt32BE(arr.length, 12)
  let o = 16
  for (const v of arr) {
    buf.writeUInt32BE(Math.floor(v / 4294967296), o)
    buf.writeUInt32BE(v % 4294967296, o + 4)
    o += 8
  }
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, buf)
  renameSync(tmp, file)
  return arr.length
}

export function readFingerprintFile (file) {
  const buf = readFileSync(file)
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'FPS1') throw new Error('指纹库格式不对')
  const window = buf.readUInt32BE(4)
  const minCjk = buf.readUInt32BE(8)
  const count = buf.readUInt32BE(12)
  if (buf.length !== 16 + count * 8) throw new Error('指纹库长度不对')
  const set = new Set()
  for (let o = 16; o < buf.length; o += 8) set.add(buf.readUInt32BE(o) * 4294967296 + buf.readUInt32BE(o + 4))
  return { window, minCjk, set }
}
