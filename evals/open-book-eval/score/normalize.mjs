// 判分用的归一（eval.md 5.1「先做全半角、空白、标点归一」）。纯函数，不碰文件、不读环境。
//
// 规矩：
// - 标记比对两边都过 normKey：NFKC（全角→半角）、ASCII 小写、去掉一切空白和标点（中英文都去）。
// - 纯数字的标记（比如 27、17）另加数字边界：127 里不算有 27，17 厘米里算有 17。
// - 带分隔符的日期写法（1/16、01-16、1.16）不过 normKey（会变成纯数字 116、0116，撞上「turn 116」这种不相干的数），
//   在 NFKC 过的原文上按分隔符认；前面不许是数字或「数字+分隔符」（免得 2027-01-16 里认出 01-16）。
// - 中文数字（二十七）不自动换算：要认就由出题的人写进别名表（world 生成器给每个数字标记都带了中文写法）。

const PUNCT = /[\s\p{P}\p{S} 　]/gu

/** 判分用的键：NFKC、小写、去空白和标点。 */
export function normKey (s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(PUNCT, '')
}

/** 只去空白（给「逐字摘引文」核子串用：标点要留着，免得两段不相干的话拼成一段）。 */
export function normQuote (s) {
  return String(s ?? '').normalize('NFKC').replace(/[\s 　]/g, '')
}

const DIGITS = /^\d+$/
const DATEISH = /^\s*(\d{1,4})\s*[-/.／]\s*(\d{1,2})\s*$/
const nfkc = (s) => String(s ?? '').normalize('NFKC')
function dateRe (m, flags = '') {
  const r = DATEISH.exec(nfkc(m))
  return new RegExp(`(?<![\\d.])(?<!\\d[-/.])0*${Number(r[1])}\\s*[-/.]\\s*0*${Number(r[2])}(?!\\d)`, flags)
}
const isDateish = (m) => DATEISH.test(nfkc(m))
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** text 里有没有 marker（任一别名）。marker 可以是字符串或字符串数组。 */
export function hasMarker (text, marker) {
  return markerIndex(text, marker) >= 0
}

/** 第一次出现的位置（归一以后的下标；没有回 -1）。给漏斗算「排第几」用。 */
export function markerIndex (text, marker) {
  const list = Array.isArray(marker) ? marker : [marker]
  const t = normKey(text)
  let best = -1
  for (const m of list) {
    let i
    if (isDateish(m)) {
      const raw = nfkc(text)
      const r = dateRe(m).exec(raw)
      i = r ? normKey(raw.slice(0, r.index)).length : -1
    } else {
      const k = normKey(m)
      if (k === '') continue
      if (DIGITS.test(k)) {
        const r = new RegExp(`(?<!\\d)${k}(?!\\d)`).exec(t)
        i = r ? r.index : -1
      } else i = t.indexOf(k)
    }
    if (i >= 0 && (best < 0 || i < best)) best = i
  }
  return best
}

/** 数 marker 在 text 里出现几次（各别名合计，不重叠）。 */
export function countMarker (text, marker) {
  const list = Array.isArray(marker) ? marker : [marker]
  const t = normKey(text)
  let n = 0
  const seenDate = new Set() // 1/16、01-16、1.16 是同一个正则，只数一次
  for (const m of list) {
    if (isDateish(m)) {
      const re = dateRe(m, 'g')
      if (seenDate.has(re.source)) continue
      seenDate.add(re.source)
      n += (nfkc(text).match(re) ?? []).length
      continue
    }
    const k = normKey(m)
    if (k === '') continue
    const re = DIGITS.test(k) ? new RegExp(`(?<!\\d)${k}(?!\\d)`, 'g') : new RegExp(escapeRe(k), 'g')
    n += (t.match(re) ?? []).length
  }
  return n
}

/** 稳定的 JSON（键排序），给指纹和锁算 sha 用。 */
export function stableJson (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}'
}
