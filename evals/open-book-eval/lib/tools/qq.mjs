// qq_history 的合成替身（eval.md 3.4）：按聊天编号存（合成世界只有 qq:private:10000 = 主人、qq:private:10001 = 来客阿栗、qq:group:20000 = 窗台群）。
// 输出照桥第 22 条的 qqHistoryText / qqListText 的样子（标题行、「HH:MM 名字：正文」、「更早的：before 填 N」），钟点按世界的「现在」算。
// 不是真的 OneBot 实现：没有图片下载、没有引用、没有 @ 换名字之外的处理。
const QQ_HISTORY_COUNT = 30
const QQ_HISTORY_MAX = 100
const QQ_HISTORY_CHARS = 8000
const QQ_HISTORY_LINE_CHARS = 300
const TZ_MS = 8 * 3600 * 1000 // 本机 UTC+8

const day = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10)
const hhmm = (ms) => new Date(ms + TZ_MS).toISOString().slice(11, 16)

export class QqStandIn {
  /**
   * @param {object} world
   * @param {string} world.ownerId 主人的 QQ（合成：10000）
   * @param {object} world.chats { 'qq:private:10000': { name, members?, rows: [{ id, at（ms）, from（QQ 号或 'self'）, name, text }] }, … }
   * @param {number} [world.now] 世界的「现在」（ms）；不给就用最新一条之后一分钟
   */
  constructor ({ ownerId = '10000', chats = {}, now } = {}) {
    this.ownerId = String(ownerId)
    this.chats = structuredClone(chats)
    const last = Math.max(0, ...Object.values(this.chats).flatMap((c) => (c.rows ?? []).map((r) => r.at)))
    this.now = now ?? (last + 60 * 1000)
    this.calls = []
  }

  when (ms) {
    if (day(ms) === day(this.now)) return hhmm(ms)
    if (day(ms) === day(this.now - 24 * 3600 * 1000)) return `昨天 ${hhmm(ms)}`
    return `${day(ms).slice(5)} ${hhmm(ms)}`
  }

  listText (find) {
    const q = String(find ?? '').trim().toLowerCase()
    const entries = Object.entries(this.chats).map(([addr, c]) => ({ addr, ...c }))
    const hit = (x) => q === '' || String(x.name ?? '').toLowerCase().includes(q) || x.addr.includes(q)
    const groups = entries.filter((x) => x.addr.startsWith('qq:group:') && hit(x))
    const friends = entries.filter((x) => x.addr.startsWith('qq:private:') && hit(x))
    const out = q === '' ? [] : [`名字或号码里有「${String(find).trim()}」的：`]
    if (groups.length === 0) out.push('群：没有')
    else {
      out.push('群（最近 7 天有人说话的，最近的在前）：')
      for (const g of groups) { const last = g.rows?.at(-1)?.at; out.push(`- ${g.addr}「${g.name ?? '群'}」${g.members ? `${g.members} 人，` : ''}最后一句 ${last ? this.when(last) : '没有'}`) }
    }
    out.push(friends.length === 0 ? '好友：没有' : `好友（qq:private:QQ号）：${friends.map((f) => { const id = f.addr.split(':')[2]; return `${f.name ?? id}${id === this.ownerId ? '（主人）' : ''} ${id}` }).join('、')}`)
    out.push('要看哪个，chat 填它的地址。')
    return out.join('\n')
  }

  /** → { text, isError, meta: { chat, readOthers } } */
  call (args = {}) {
    this.calls.push({ chat: args?.chat ?? null, count: args?.count ?? null, before: args?.before ?? null })
    if (typeof args?.chat !== 'string' || args.chat.trim() === '') return { text: this.listText(args?.find), isError: false, meta: { list: true } }
    const s = args.chat.trim().replace(/^qq:/, '')
    const m = s.match(/^(group|private):(\d{5,12})$/)
    if (m === null) return { text: 'chat 写成 qq:group:群号 或 qq:private:QQ号；不知道号码就先不填 chat，看一眼列表', isError: false, meta: {} }
    const address = `qq:${m[1]}:${m[2]}`
    const chat = this.chats[address]
    const count = Math.max(1, Math.min(QQ_HISTORY_MAX, Math.round(Number(args?.count) || QQ_HISTORY_COUNT)))
    const b = String(args?.before ?? '').trim()
    const before = /^-?\d+$/.test(b) ? b : undefined
    const isOwner = m[1] === 'private' && m[2] === this.ownerId
    const title = m[1] === 'group' ? `「${chat?.name ?? '群'}」` : `（${chat?.name ?? '私聊'}${isOwner ? '，就是主人' : ''}）`
    let rows = [...(chat?.rows ?? [])].sort((x, y) => x.at - y.at)
    if (before !== undefined) { const i = rows.findIndex((r) => String(r.id) === before); rows = i < 0 ? [] : rows.slice(0, i) }
    rows = rows.slice(-count)
    if (rows.length === 0) return { text: `${address}${title}${before === undefined ? '里没有记录' : '再往前没有了'}。`, isError: false, meta: { chat: address, empty: true } }
    const who = (r) => (r.from === 'self' ? '你' : `${r.name ?? r.from}${String(r.from) === this.ownerId ? '（主人）' : ''}`)
    const textOf = (r) => { const t = String(r.text ?? '').replace(/</g, '＜').replace(/>/g, '＞').replace(/\s+/g, ' ').trim(); const cs = [...t]; return cs.length > QQ_HISTORY_LINE_CHARS ? cs.slice(0, QQ_HISTORY_LINE_CHARS).join('') + '…' : t }
    const oneDay = day(rows[0].at) === day(rows.at(-1).at)
    const lines = []
    let chars = 0
    let trimmed = false
    for (let k = rows.length - 1; k >= 0; k--) {
      const r = rows[k]
      const line = `${oneDay ? hhmm(r.at) : `${day(r.at).slice(5)} ${hhmm(r.at)}`} ${who(r)}：${textOf(r)}`
      if (lines.length > 0 && chars + line.length > QQ_HISTORY_CHARS) { trimmed = true; break }
      lines.unshift({ r, line })
      chars += line.length + 1
    }
    const first = lines[0].r
    const more = trimmed || rows.length >= count
    const text = [
      `${address}${title}${m[1] === 'private' ? '的私聊' : ''}${before === undefined ? '最近' : '往前'}的 ${lines.length} 条（${this.when(first.at)}–${this.when(lines.at(-1).r.at)}）：`,
      ...lines.map((x) => x.line),
      more ? `更早的：before 填 ${first.id}` : '再往前没有了。',
    ].join('\n')
    return { text, isError: false, meta: { chat: address, readOthers: !isOwner, lines: lines.length } }
  }
}
