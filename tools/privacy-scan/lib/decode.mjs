// 扫描前的两种「换一种看法」，都记得每个字在原文里的位置，命中照原文报行列。
//
// canonWidth：全角的 ASCII（！到～）换成半角、全角空格换成空格。一个换一个，下标不变。
//   全角数字写的号、全角字母写的用户名，换过以后才认得出。
// decodeView：把常见的转义还原：\uXXXX（含代理对）、\u{…}、连续的 \xHH 和 %HH（按 UTF-8）、&#NNN; 和 &#xHHH;，
//   以及字符串里的换行、回车、制表（反斜杠加 n、r、t）。
//   Python 的 json.dumps 默认把中文写成 \uXXXX，网址里的中文是 %E4%BB%8A 这样，HTML 里可能是 &#20170;：
//   原话、号、带用户名的路径写成这样，直接看是认不出的。没有可还原的就返回 null。

const FW_CLASS = '[' + String.fromCharCode(0xFF01) + '-' + String.fromCharCode(0xFF5E) + String.fromCharCode(0x3000) + ']'
const FW_TEST = new RegExp(FW_CLASS)
const FW = new RegExp(FW_CLASS, 'g')
export function canonWidth (text) {
  const t = String(text)
  if (!FW_TEST.test(t)) return t
  return t.replace(FW, (c) => (c.charCodeAt(0) === 0x3000 ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0)))
}

const HINT = /\\[nrt]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]{1,6}\}|\\x[0-9a-fA-F]{2}|%[0-9a-fA-F]{2}|&#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7});/
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** 连续的 \xHH 或 %HH：按 UTF-8 解。解不出（不是 UTF-8）就不动 */
function bytesRun (text, i, lead) {
  const bytes = []
  let j = i
  const step = lead === '%' ? 3 : 4
  while (j + step <= text.length) {
    if (lead === '%') { if (text[j] !== '%' || !isHex(text.charCodeAt(j + 1)) || !isHex(text.charCodeAt(j + 2))) break; bytes.push(parseInt(text.slice(j + 1, j + 3), 16)) } else { if (text[j] !== '\\' || text[j + 1] !== 'x' || !isHex(text.charCodeAt(j + 2)) || !isHex(text.charCodeAt(j + 3))) break; bytes.push(parseInt(text.slice(j + 2, j + 4), 16)) }
    j += step
  }
  if (!bytes.length) return null
  try { return { s: utf8.decode(Uint8Array.from(bytes)), end: j } } catch { return null }
}

function decodeAt (text, i) {
  const c = text[i]
  if (c === '\\') {
    const d = text[i + 1]
    if (d === 'u') {
      if (text[i + 2] === '{') {
        const close = text.indexOf('}', i + 3)
        if (close > i + 3 && close <= i + 9 && /^[0-9a-fA-F]+$/.test(text.slice(i + 3, close))) {
          const cp = parseInt(text.slice(i + 3, close), 16)
          if (cp <= 0x10ffff) return { s: String.fromCodePoint(cp), end: close + 1 }
        }
        return null
      }
      if (i + 6 <= text.length && isHex(text.charCodeAt(i + 2)) && isHex(text.charCodeAt(i + 3)) && isHex(text.charCodeAt(i + 4)) && isHex(text.charCodeAt(i + 5))) {
        return { s: String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)), end: i + 6 }
      }
      return null
    }
    if (d === 'x') return bytesRun(text, i, '\\')
    // JSON / JS 字符串里的换行、制表：原文里是字母 n、t，会把两边的中文隔开，整句认不出
    if (d === 'n' || d === 'r') return { s: String.fromCharCode(10), end: i + 2 }
    if (d === 't') return { s: ' ', end: i + 2 }
    return null
  }
  if (c === '%') return bytesRun(text, i, '%')
  if (c === '&' && text[i + 1] === '#') {
    const m = /^&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/.exec(text.slice(i, i + 12))
    if (!m) return null
    const cp = m[1] ? parseInt(m[1], 16) : Number(m[2])
    if (cp > 0x10ffff) return null
    return { s: String.fromCodePoint(cp), end: i + m[0].length }
  }
  return null
}

/**
 * 返回 { text, map, esc } 或 null。
 *   map[k]：解码后第 k 个 UTF-16 单位在原文里的下标（map[text.length] = 原文长度）
 *   esc：前缀和，esc[b] - esc[a] > 0 表示解码后 [a, b) 里有字是从转义还原出来的
 */
export function decodeView (text) {
  const t = String(text)
  if (!HINT.test(t)) return null
  const parts = []
  const map = new Int32Array(t.length + 1)
  const escFlag = new Uint8Array(t.length + 1)
  let len = 0
  let plainFrom = 0
  let changed = false
  const flushPlain = (to) => {
    if (to <= plainFrom) return
    parts.push(t.slice(plainFrom, to))
    for (let k = plainFrom; k < to; k++) map[len++] = k
  }
  for (let i = 0; i < t.length;) {
    const c = t.charCodeAt(i)
    if (c === 92 || c === 37 || c === 38) {
      const r = decodeAt(t, i)
      if (r) {
        flushPlain(i)
        parts.push(r.s)
        for (let k = 0; k < r.s.length; k++) { escFlag[len] = 1; map[len++] = i }
        i = r.end
        plainFrom = i
        changed = true
        continue
      }
    }
    i++
  }
  if (!changed) return null
  flushPlain(t.length)
  map[len] = t.length
  const esc = new Int32Array(len + 1)
  for (let k = 0; k < len; k++) esc[k + 1] = esc[k] + escFlag[k]
  return { text: parts.join(''), map: map.subarray(0, len + 1), esc }
}
