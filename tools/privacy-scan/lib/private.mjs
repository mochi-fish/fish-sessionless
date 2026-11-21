// 私有层的接口。公开的只有接口和匹配办法；拒绝表、指纹库、密钥都由私有的 provider 在扫描时现生成，
// 只在内存里交给这里，命中只报「类别#编号」（编号 = 带密钥的哈希前 10 位），不报值。
//
// provider 是一个 .mjs，导出 async loadPrivateLayer(opts)，返回：
//   {
//     key:          Buffer（≥16 字节；给命中编号用）
//     terms:        [{ kind, value }]               真值，只在内存里
//     fingerprints: [{ rule, set, key, window, minCjk, minRun }]   rule 例：'her-words'
//     digitSets:    [{ rule, set, key }]（可省）     以前见过的号：每段 5–12 位数字算 digitHash(key, 数字) 查 set
//     allowIds:     Set<string>                     放过的编号（私有的放行表；值本身不出现）
//     health:       { ok, problems: [], counts: {} }   provider 自己的体检，只有计数
//   }
import { createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { canonWidth } from './decode.mjs'

export function termId (key, kind, value) {
  return `${kind}#${createHmac('sha256', key).update(`${kind}\0${value}`, 'utf8').digest('hex').slice(0, 10)}`
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 本机用户名、身份这几类只看左边界：名字后面接着别的字母数字（名字2、名字Dev、名字e）也算
const PREFIX_KINDS = new Set(['user-name', 'identity'])
// 号被空格、下划线（JS 的数字分隔符）、连字符拆成几段写的：相邻几段拼起来再查表
const SPLIT_DIGITS = /\d+(?:[ _-]\d+)+/g

/** 一段数字查哈希表（provider 交来的「见过的号」，只存带密钥的哈希） */
function digitHash (key, s) {
  const d = createHmac('sha256', key).update(`digits\0${s}`, 'utf8').digest()
  return (d.readUInt32BE(0) & 0x1fffff) * 4294967296 + d.readUInt32BE(4)
}
export { digitHash }

/**
 * 真值匹配器。扫之前先把全角的 ASCII 换成半角（下标不变）。
 *   纯数字的值：只认整段数字（前后不挨着别的数字），在文字里取每段连续数字查表；
 *     被空格、_、- 拆成几段的，相邻的几段拼起来也查；
 *     digitSets（[{ rule, set, key }]）：同样取每段数字，算带密钥的哈希查集合（以前见过、现在配置里没有了的号）；
 *   kind 是 secret 的：区分大小写的子串；
 *   两头是英文字母或数字的（用户名、主机名、英文昵称）：不分大小写，前后不挨着别的英文字母或数字（整词）；
 *     其中本机用户名、身份（5 个字符以上）只看左边界；
 *   别的（中文昵称、词）：不分大小写的子串。
 * entries：[{ kind, value, id, layer }]
 */
export function buildTermMatcher (entries, { digitSets = [] } = {}) {
  const digits = new Map()
  let dMin = Infinity
  let dMax = 0
  const cs = new Map()
  const word = new Map()
  const prefix = new Map()
  const ci = new Map()
  const alnumEdges = (v) => /^[A-Za-z0-9]/.test(v) && /[A-Za-z0-9]$/.test(v)
  for (const e of entries) {
    const v = String(e.value)
    if (!v) continue
    if (/^\d+$/.test(v)) { digits.set(v, e); dMin = Math.min(dMin, v.length); dMax = Math.max(dMax, v.length); continue }
    if (e.kind === 'secret') cs.set(v, e)
    else if (alnumEdges(v) && PREFIX_KINDS.has(e.kind) && v.length >= 5) prefix.set(v.toLowerCase(), e)
    else if (alnumEdges(v)) word.set(v.toLowerCase(), e)
    else ci.set(v.toLowerCase(), e)
  }
  const dsets = digitSets.filter((d) => d && d.set instanceof Set && d.set.size && Buffer.isBuffer(d.key))
  if (dsets.length) { dMin = Math.min(dMin, 5); dMax = Math.max(dMax, 12) }
  const alt = (keys) => [...keys].sort((a, b) => b.length - a.length).map(esc).join('|')
  const mk = (keys, flags) => keys.length ? new RegExp(alt(keys), flags) : null
  const reCs = mk([...cs.keys()], 'g')
  const reCi = mk([...ci.keys()], 'gi')
  const reWord = word.size ? new RegExp(`(?<![A-Za-z0-9])(?:${alt(word.keys())})(?![A-Za-z0-9])`, 'gi') : null
  const rePrefix = prefix.size ? new RegExp(`(?<![A-Za-z0-9])(?:${alt(prefix.keys())})`, 'gi') : null
  const DIG = /\d+/g
  /** 一段数字（已拼好）：先查真值表，再查哈希集合 */
  const lookupDigits = (s) => {
    if (s.length < dMin || s.length > dMax) return null
    const e = digits.get(s)
    if (e) return e
    for (const d of dsets) {
      if (d.set.has(digitHash(d.key, s))) return { kind: d.rule, value: s, id: termId(d.key, d.rule, s), layer: 'private' }
    }
    return null
  }
  return {
    size: digits.size + cs.size + word.size + prefix.size + ci.size + dsets.length,
    scan (raw) {
      const text = canonWidth(raw)
      const out = []
      if (digits.size || dsets.length) {
        DIG.lastIndex = 0
        for (const m of text.matchAll(DIG)) {
          const e = lookupDigits(m[0])
          if (e) out.push({ index: m.index, length: m[0].length, entry: e })
        }
        SPLIT_DIGITS.lastIndex = 0
        for (const m of text.matchAll(SPLIT_DIGITS)) {
          const groups = []
          for (const g of m[0].matchAll(/\d+/g)) groups.push({ s: g[0], at: m.index + g.index })
          for (let i = 0; i < groups.length; i++) {
            let acc = groups[i].s
            for (let j = i + 1; j < groups.length; j++) {
              acc += groups[j].s
              if (acc.length > dMax) break
              const e = lookupDigits(acc)
              if (e) out.push({ index: groups[i].at, length: groups[j].at + groups[j].s.length - groups[i].at, entry: e })
            }
          }
        }
      }
      if (reCs) { reCs.lastIndex = 0; for (const m of text.matchAll(reCs)) out.push({ index: m.index, length: m[0].length, entry: cs.get(m[0]) }) }
      if (reWord) { reWord.lastIndex = 0; for (const m of text.matchAll(reWord)) out.push({ index: m.index, length: m[0].length, entry: word.get(m[0].toLowerCase()) }) }
      if (rePrefix) { rePrefix.lastIndex = 0; for (const m of text.matchAll(rePrefix)) out.push({ index: m.index, length: m[0].length, entry: prefix.get(m[0].toLowerCase()) }) }
      if (reCi) { reCi.lastIndex = 0; for (const m of text.matchAll(reCi)) out.push({ index: m.index, length: m[0].length, entry: ci.get(m[0].toLowerCase()) }) }
      return out
    },
  }
}

/** 检查 provider 交回来的东西像不像样；不像样就抛错（扫描方据此退 2，不当作干净） */
export function validateLayer (layer) {
  if (!layer || typeof layer !== 'object') throw new Error('私有层没有返回对象')
  if (!Buffer.isBuffer(layer.key) || layer.key.length < 16) throw new Error('私有层的 key 不对')
  if (!Array.isArray(layer.terms)) throw new Error('私有层的 terms 要是数组')
  for (const t of layer.terms) if (!t || typeof t.kind !== 'string' || typeof t.value !== 'string') throw new Error('私有层的 terms 每项要有 kind、value')
  if (!Array.isArray(layer.fingerprints)) throw new Error('私有层的 fingerprints 要是数组')
  for (const f of layer.fingerprints) {
    if (typeof f.rule !== 'string' || !(f.set instanceof Set) || !Buffer.isBuffer(f.key)) throw new Error('私有层的指纹项不对')
    if (!(f.window >= 4) || !(f.minCjk >= 0) || f.minCjk > f.window) throw new Error('私有层的指纹窗口参数不对')
  }
  if (layer.allowIds && !(layer.allowIds instanceof Set)) throw new Error('私有层的 allowIds 要是 Set')
  if (layer.digitSets !== undefined) {
    if (!Array.isArray(layer.digitSets)) throw new Error('私有层的 digitSets 要是数组')
    for (const d of layer.digitSets) if (!d || typeof d.rule !== 'string' || !(d.set instanceof Set) || !Buffer.isBuffer(d.key) || d.key.length < 16) throw new Error('私有层的 digitSets 项不对')
  }
  return layer
}

/** 把私有层的真值变成匹配条目（带编号） */
export function privateEntries (layer) {
  const seen = new Set()
  const out = []
  for (const t of layer.terms) {
    const v = t.value.trim()
    if (!v) continue
    const k = `${t.kind}\0${v}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ kind: t.kind, value: v, id: termId(layer.key, t.kind, v), layer: 'private' })
  }
  return out
}

export async function loadProvider (modulePath, opts = {}) {
  const mod = await import(pathToFileURL(resolve(modulePath)).href)
  if (typeof mod.loadPrivateLayer !== 'function') throw new Error('provider 没有导出 loadPrivateLayer')
  return validateLayer(await mod.loadPrivateLayer(opts))
}
