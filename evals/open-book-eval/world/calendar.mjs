// 合成世界的日历（eval.md 6.1）：2026-12-07（周一）到 2027-01-13（周三），跨年；时区固定 UTC+8（本机）。
// 周从周一算（ISO，eval.md 第九节「注记函数的约定」）。只认固定偏移，不碰本机时区设置。
//
// 日期写法：'12-07' 这种月-日（12 月归 2026，1 月归 2027）；时刻 'HH:MM'。

export const TZ_OFFSET_MIN = 8 * 60
export const START = '12-07'
export const END = '01-13'
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WD_ALT = { 周日: ['周日', '星期日', '星期天', '礼拜天', '周天'], 周一: ['周一', '星期一', '礼拜一'], 周二: ['周二', '星期二', '礼拜二'], 周三: ['周三', '星期三', '礼拜三'], 周四: ['周四', '星期四', '礼拜四'], 周五: ['周五', '星期五', '礼拜五'], 周六: ['周六', '星期六', '礼拜六'] }
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十', '三十一']

export function yearOf (md) {
  const m = Number(String(md).slice(0, 2))
  return m === 12 || m === 11 ? 2026 : 2027
}

/** 'MM-DD' + 'HH:MM' → 毫秒（UTC）。 */
export function at (md, hhmm = '00:00') {
  const [m, d] = String(md).split('-').map(Number)
  const [h, mi] = String(hhmm).split(':').map(Number)
  return Date.UTC(yearOf(md), m - 1, d, h, mi) - TZ_OFFSET_MIN * 60_000
}

/** 毫秒 → 本地（UTC+8）的各部分。 */
export function parts (ms) {
  const t = new Date(ms + TZ_OFFSET_MIN * 60_000)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), wd: t.getUTCDay() }
}

const p2 = (n) => String(n).padStart(2, '0')
export const mdOf = (ms) => { const p = parts(ms); return `${p2(p.m)}-${p2(p.d)}` }
export const hhmmOf = (ms) => { const p = parts(ms); return `${p2(p.h)}:${p2(p.mi)}` }
export const weekdayOf = (ms) => WD[parts(ms).wd]

/** 宿主时间行的写法：2027-01-13T21:00:00+08:00[Asia/Shanghai] */
export function hostIso (ms) {
  const p = parts(ms)
  return `${p.y}-${p2(p.m)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}+08:00[Asia/Shanghai]`
}
export function isoLocal (ms) {
  const p = parts(ms)
  return `${p.y}-${p2(p.m)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}+08:00`
}

export function addDays (md, n) {
  return mdOf(at(md, '12:00') + n * 86_400_000)
}

/** 从 START 到 END 的每一天（'MM-DD'）。 */
export function days () {
  const out = []
  for (let md = START; ; md = addDays(md, 1)) { out.push(md); if (md === END) break }
  return out
}

/** ISO 周一（'MM-DD'）。 */
export function mondayOf (md) {
  const wd = parts(at(md, '12:00')).wd
  return addDays(md, -((wd + 6) % 7))
}

const WD_INDEX = { 周一: 0, 周二: 1, 周三: 2, 周四: 3, 周五: 4, 周六: 5, 周日: 6 }

/**
 * 相对说法 → 日期（'MM-DD'）。认：今天 明天 后天 大后天 昨天 前天 这周X 下周X 下下周X 上周X 上周末（回两个日子）。
 * 出题和自检用（不是给她的注记函数；那个以日期注记模块的正本为准）。
 */
export function resolveRel (saidMd, expr) {
  const e = String(expr)
  const simple = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2 }
  if (e in simple) return addDays(saidMd, simple[e])
  if (e === '上周末') { const mon = mondayOf(saidMd); return [addDays(mon, -2), addDays(mon, -1)] }
  const m = /^(这周|本周|下下周|下周|上周|这个|下个|下下个)(?:周|星期|礼拜)?([一二三四五六日天])$/.exec(e)
  if (m) {
    const shift = { 这周: 0, 本周: 0, 这个: 0, 下周: 7, 下个: 7, 下下周: 14, 下下个: 14, 上周: -7 }[m[1]]
    return addDays(mondayOf(saidMd), shift + WD_INDEX['周' + (m[2] === '天' ? '日' : m[2])])
  }
  throw new Error(`resolveRel 不认识「${e}」`)
}

/** 'MM-DD' → 给她看的写法「1 月 8 日」 */
export function zhDate (md) {
  const [m, d] = String(md).split('-').map(Number)
  return `${m} 月 ${d} 日`
}

/** 判分用的别名：1月8日、1月8号、01-08、1/8、一月八日、一月八号、8号（同月份上下文里）…… */
export function dateAliases (md, { withBareDay = false } = {}) {
  const [m, d] = String(md).split('-').map(Number)
  const al = [`${m}月${d}日`, `${m}月${d}号`, `${p2(m)}-${p2(d)}`, `${m}/${d}`, `${CN_NUM[m]}月${CN_NUM[d]}日`, `${CN_NUM[m]}月${CN_NUM[d]}号`, `${m}.${d}`]
  if (m === 1) al.push(`元月${d}日`, `元月${d}号`)
  if (withBareDay) al.push(`${d}号`, `${d}日`)
  return al
}

export function weekdayAliases (wd) { return [...(WD_ALT[wd] ?? [wd])] }

export const cnNum = (n) => CN_NUM[n] ?? String(n)

/** 自检：几个固定的锚点（eval.md 6.1、6.2 写的星期）。不对就抛。 */
export function selfCheck () {
  const want = { '12-07': '周一', '12-25': '周五', '12-28': '周一', '12-29': '周二', '12-30': '周三', '01-04': '周一', '01-06': '周三', '01-07': '周四', '01-08': '周五', '01-12': '周二', '01-13': '周三' }
  for (const [md, wd] of Object.entries(want)) if (weekdayOf(at(md, '12:00')) !== wd) throw new Error(`日历不对：${md} 应该是 ${wd}`)
  const rel = [['12-30', '下周五', '01-08'], ['12-30', '这周五', '01-01'], ['01-06', '下周三', '01-13'], ['12-28', '大后天', '12-31'], ['12-25', '下下周一', '01-04'], ['12-25', '下周一', '12-28'], ['12-29', '下下周二', '01-12'], ['01-04', '昨天', '01-03']]
  for (const [s, e, w] of rel) if (resolveRel(s, e) !== w) throw new Error(`相对日期不对：${s} 的「${e}」应该是 ${w}，算出 ${resolveRel(s, e)}`)
  const wk = resolveRel('01-04', '上周末')
  if (wk[0] !== '01-02' || wk[1] !== '01-03') throw new Error('上周末不对')
  if (days().length !== 38) throw new Error(`天数不对：${days().length}`)
  return true
}
