// 11 个 Mem 工具的替身（eval.md 3.4）：本地 JSON 记忆库，确定性二字片打分；只测「她想不想得到去 Mem 找」，不测 Nowledge 的排序。
// 写（memory_add / memory_update / library_add）只记进本次的写入账，不落到任何地方（替身的库在一个半边里也不变）。
// mem_fs / find_skills / report_skill_outcome 回固定的小结果。真数据臂一律回「副本里不可用」（由分派那层决定，这里不管）。
// 结果的形状照线上 Nowledge MCP 的 JSON（memory_search → {"results":[{id, memory_id, reference_uri, title, content, content_preview, …}]}），
// 字段名是从线上一份出站体的形状里看来的；正文全是合成的。
export const MEM_PREFIX = 'mcp__nowledge_mem__'
export const MEM_NAMES = Object.freeze(['find_skills', 'get_memory_by_id', 'library_add', 'mem_fs', 'memory_add', 'memory_search', 'memory_update',
  'read_source_content', 'report_skill_outcome', 'thread_fetch_messages', 'thread_search'])
export const MEM_TOOLS = Object.freeze(MEM_NAMES.map((n) => MEM_PREFIX + n))

const strip = (s) => String(s ?? '').replace(/\s+/g, '')
/** 二字片（汉字串按两个字一片；英文按词）；去重 */
export function bigrams (s) {
  const t = strip(s).toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9]+/g) ?? []) out.add(w)
  const han = t.replace(/[a-z0-9]+/g, ' ')
  for (const seg of han.split(/[\s\p{P}\p{S}]+/u)) {
    const cs = [...seg]
    if (cs.length === 1) out.add(cs[0])
    for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i] + cs[i + 1])
  }
  return out
}
/** 打分：查询的片在文档里出现的比例（0–1）；命中不到 2 片（查询本身不到 2 片时要全中）算 0。同分按 id 排，完全确定 */
export function score (query, doc) {
  const q = bigrams(query)
  if (q.size === 0) return 0
  const d = bigrams(doc)
  let hit = 0
  for (const g of q) if (d.has(g)) hit++
  return hit >= Math.min(2, q.size) ? hit / q.size : 0
}
/** 进结果的门槛 */
export const MIN_SCORE = 0.2
const preview = (s, n = 120) => { const c = [...String(s ?? '')]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join('') }

export class MemStandIn {
  /**
   * @param {object} lib { memories: [{ id, title, content, labels?, time? }], threads: [{ id, title, messages: [{ role, content, time? }] }] }
   */
  constructor (lib = {}) {
    this.memories = structuredClone(lib.memories ?? [])
    this.threads = structuredClone(lib.threads ?? [])
    this.writes = []
    this.calls = []
  }

  memRow (m, s) {
    return {
      id: m.id, memory_id: m.id, reference_uri: `nowledgemem://memory/${m.id}`, title: m.title ?? '', content: m.content ?? '',
      content_preview: preview(m.content), labels: m.labels ?? [], time: m.time ?? null, ...(s === undefined ? {} : { score: Math.round(s * 1000) / 1000 }),
    }
  }

  /** → { text, isError } ；name 是带前缀的全名或短名 */
  call (name, args = {}) {
    const short = String(name).startsWith(MEM_PREFIX) ? String(name).slice(MEM_PREFIX.length) : String(name)
    this.calls.push({ name: short, argKeys: Object.keys(args ?? {}).sort() })
    const j = (o) => ({ text: JSON.stringify(o), isError: false })
    const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5))
    switch (short) {
      case 'memory_search': {
        const q = String(args?.query ?? args?.q ?? '')
        const rows = this.memories.map((m) => ({ m, s: score(q, `${m.title ?? ''} ${m.content ?? ''} ${(m.labels ?? []).join(' ')}`) }))
          .filter((x) => x.s >= MIN_SCORE).sort((a, b) => b.s - a.s || String(a.m.id).localeCompare(String(b.m.id))).slice(0, limit)
        return j({ results: rows.map((x) => this.memRow(x.m, x.s)), total: rows.length })
      }
      case 'get_memory_by_id': {
        const id = String(args?.memory_id ?? args?.id ?? '')
        const m = this.memories.find((x) => x.id === id)
        return m ? j(this.memRow(m)) : { text: JSON.stringify({ error: 'not_found', message: `memory ${id} not found` }), isError: true }
      }
      case 'thread_search': {
        const q = String(args?.query ?? args?.q ?? '')
        const rows = this.threads.map((t) => ({ t, s: score(q, `${t.title ?? ''} ${(t.messages ?? []).map((m) => m.content).join(' ')}`) }))
          .filter((x) => x.s >= MIN_SCORE).sort((a, b) => b.s - a.s || String(a.t.id).localeCompare(String(b.t.id))).slice(0, limit)
        return j({ threads: rows.map((x) => ({ thread_id: x.t.id, title: x.t.title ?? '', message_count: (x.t.messages ?? []).length, score: Math.round(x.s * 1000) / 1000 })), total: rows.length })
      }
      case 'thread_fetch_messages': {
        const id = String(args?.thread_id ?? args?.id ?? '')
        const t = this.threads.find((x) => x.id === id)
        if (!t) return { text: JSON.stringify({ error: 'not_found', message: `thread ${id} not found` }), isError: true }
        const off = Math.max(0, Number(args?.offset) || 0)
        const lim = Math.max(1, Math.min(100, Number(args?.limit) || 50))
        return j({ thread_id: t.id, title: t.title ?? '', messages: (t.messages ?? []).slice(off, off + lim), total: (t.messages ?? []).length })
      }
      case 'read_source_content': return j({ error: 'no_source', message: '这条记忆没有附带原始资料' })
      case 'memory_add':
      case 'memory_update':
      case 'library_add': {
        this.writes.push({ tool: short, at: new Date().toISOString(), args: structuredClone(args ?? {}) })
        const id = `ob-write-${String(this.writes.length).padStart(3, '0')}`
        return j({ ok: true, id, memory_id: id, note: '已记下（评测副本：只记进本次的写入账）' })
      }
      case 'mem_fs': return j({ entries: [], note: '空' })
      case 'find_skills': return j({ skills: [] })
      case 'report_skill_outcome': return j({ ok: true })
      default: return { text: '这个工具在评测副本里不可用', isError: true }
    }
  }
}
