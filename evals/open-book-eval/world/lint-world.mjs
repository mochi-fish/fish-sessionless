#!/usr/bin/env node
// 合成世界的体检（eval.md 6.1 末尾、5.6）：
//   node world/lint-world.mjs <世界目录>
// 错误（有一条就不许用这个世界）：
//   - 任何文件里出现「他」（用户叫「主人」；「其他」也不许，免得混进去）
//   - 字符串里出现 5 位以上的数字串，且不是 10000 / 10001 / 20000（CANARY、rpcId、64 位哈希、ISO 时刻先去掉）
//   - 像真路径或凭据的东西（盘符路径、用户目录、应用数据目录、密钥目录、api key、sk- 开头的串）
//   - CANARY 不唯一（每个只许出现在一条事件或一条 Mem 里）
//   - 各题独有的词（distinctive 事实的标记、禁见来源的名词）出现在别的题或噪声的事件里
//   - 题的结构：A–D 各 9 组、6 道对照、每组两半、每半有探针和要点
//   - 设计好的「在哪儿」和渲染出来的预览视图对不上（recent 要在原文里、block 要在摘要里、blockLost 整份视图里都不许有）
//   - P2 占位视图里出现了那个受众不该见的禁见来源
// 只输出编号和计数，不输出正文。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasMarker, normKey } from '../score/normalize.mjs'
import { segments } from '../score/wire-text.mjs'
import { leakRule, plantHits } from '../score/deterministic.mjs'

const ALLOWED_NUMS = new Set(['10000', '10001', '20000'])
// 金丝雀（复核 V7 起是「栖棠路23号」这样的门牌，旧的 CANARY-… 也照去）
const STRIP = [/CANARY-[a-z]+-[a-z]+-[0-9a-f]{6}/g, /[一-鿿]{2}[路巷里坊街弄]\d{1,2}号/g, /sys-im-[a-z]+-\d+-\d+-[amx]/g, /[0-9a-f]{64}/g, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/g, /toolu_w\d+/g]
const SECRETLIKE = [/[A-Za-z]:[\\/]/, /[\\/]Users[\\/]/i, /AppData/i, /\.ssh/i, /api[_-]?key/i, /\bsk-[A-Za-z0-9_-]{10,}/, /Bearer\s+[A-Za-z0-9._-]{10,}/]

function walkFiles (dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}
function strings (v, acc = []) {
  if (typeof v === 'string') acc.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, acc)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, acc)
  return acc
}

export function lintWorld (dir) {
  const errors = []
  const warnings = []
  const rd = (rel) => readFileSync(join(dir, rel), 'utf8')
  const js = (rel) => JSON.parse(rd(rel))

  // ---- 逐个文件：他、数字、像路径/凭据的
  for (const f of walkFiles(dir)) {
    const rel = relative(dir, f).split('\\').join('/')
    if (rel === 'lint.json') continue
    if (!/\.(json|jsonl|txt)$/.test(rel)) continue
    const raw = readFileSync(f, 'utf8')
    const n他 = (raw.match(/他/g) ?? []).length
    if (n他) errors.push(`${rel}：出现「他」${n他} 处`)
    let strs
    if (rel.endsWith('.jsonl')) strs = raw.split('\n').filter(Boolean).flatMap((l) => strings(JSON.parse(l)))
    else if (rel.endsWith('.json')) strs = strings(JSON.parse(raw))
    else strs = [raw]
    let badNum = 0
    let secret = 0
    for (let s of strs) {
      for (const re of SECRETLIKE) if (re.test(s)) secret++
      for (const re of STRIP) s = s.replace(re, ' ')
      for (const m of s.match(/\d{5,}/g) ?? []) if (!ALLOWED_NUMS.has(m)) badNum++
    }
    if (badNum) errors.push(`${rel}：有 ${badNum} 个不在允许表里的长数字串`)
    if (secret) errors.push(`${rel}：有 ${secret} 处像路径或凭据的字`)
  }

  const meta = js('meta.json')
  const items = js('items.json')
  const plants = js('plants.json')
  const facts = js('facts.json')
  const timeline = rd('timeline.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const mem = js('stores/mem.json')
  if (Array.isArray(meta.problems) && meta.problems.length) errors.push(`生成时有 ${meta.problems.length} 处「设计的位置」和实际对不上`)

  // ---- 结构
  const dims = { A: 0, B: 0, C: 0, D: 0, K: 0 }
  for (const it of items) dims[it.dim] = (dims[it.dim] ?? 0) + 1
  for (const d of ['A', 'B', 'C', 'D']) if (dims[d] !== 9) errors.push(`维度 ${d} 有 ${dims[d]} 组，应该是 9`)
  if (dims.K !== 6) errors.push(`对照有 ${dims.K} 道，应该是 6`)
  const ids = new Set()
  for (const it of items) {
    if (ids.has(it.id)) errors.push(`题号 ${it.id} 重复`)
    ids.add(it.id)
    const hs = Object.keys(it.halves)
    if (it.dim === 'K' ? hs.join() !== 'C' : hs.sort().join() !== 'A,B') errors.push(`${it.id} 的半边不对：${hs.join()}`)
    for (const [H, h] of Object.entries(it.halves)) {
      if (!h.probe?.text || !h.chat || !['T1', 'T2'].includes(h.cut)) errors.push(`${it.id}.${H} 缺探针、聊天或截止点`)
      if (!Array.isArray(h.rubric?.required) || h.rubric.required.length === 0) errors.push(`${it.id}.${H} 没有要点`)
      if (h.probe?.text && /[他]/.test(h.probe.text)) errors.push(`${it.id}.${H} 探针里有「他」`)
    }
    if (it.dim !== 'K') {
      const a = it.halves.A
      const b = it.halves.B
      if (a && b && a.text === b.text && a.cut === b.cut && a.audience === b.audience) warnings.push(`${it.id}：两半探针、截止点、受众全一样（只靠世界里的事区分）`)
    }
  }

  // ---- CANARY 唯一
  const allTexts = timeline.map((e) => ({ id: e.id, itemId: e.itemId, text: [e.text, e.sum ?? '', e.tool ? JSON.stringify(e.tool) : ''].join('\n') }))
  const memTexts = mem.memories.map((m) => ({ id: m.id, itemId: m.id === 'mem-a07' ? 'A07' : null, text: `${m.title}\n${m.content}` }))
  const pool = [...allTexts, ...memTexts]
  for (const pl of plants) {
    if (!pl.canary) continue
    const where = pool.filter((x) => x.text.includes(pl.canary))
    if (where.length !== 1) errors.push(`${pl.id} 的 CANARY 出现了 ${where.length} 次（应该正好一次）`)
  }

  // ---- 独有的词只在自己那题的事件里
  const own = (itemId, marker, label) => {
    const where = pool.filter((x) => hasMarker(x.text, marker))
    const foreign = where.filter((x) => x.itemId !== itemId)
    if (foreign.length) errors.push(`${label}（${itemId}）的独有词出现在别处 ${foreign.length} 次（${[...new Set(foreign.map((x) => x.itemId ?? '噪声'))].slice(0, 5).join('、')}）`)
    if (where.length === 0) errors.push(`${label}（${itemId}）的独有词在世界里一次都没出现（标记和原话对不上）`)
  }
  for (const f of facts) if (f.distinctive) own(f.itemId, f.markers, `事实 ${f.id}`)
  for (const pl of plants) if (!pl.scopeHalves) for (const n of pl.nouns ?? []) own(pl.itemId, n, `禁见来源 ${pl.id}`)

  // ---- 设计好的位置 vs 渲染出来的预览视图
  const views = {}
  for (const cut of meta.cuts) views[cut] = segments(js(`views/preview-main-${cut}.json`))
  const evById = new Map(timeline.map((e) => [e.id, e]))
  // 只核题里真用到的（事实@截止点）：没被问到的那一刻在哪儿不要紧
  const refs = new Set()
  for (const it of items) for (const h of Object.values(it.halves)) for (const r of h.rubric?.required ?? []) if (r.factId) refs.add(`${r.factId}@${h.cut}`)
  for (const f of facts) {
    for (const cut of meta.cuts) {
      if (!refs.has(`${f.id}@${cut}`)) continue
      const lay = f.layers?.[cut]
      const seg = views[cut]
      if (!seg) continue
      if (lay === 'recent') {
        const e = evById.get(f.eventId)
        const k = normKey(e?.text ?? '').slice(0, 24)
        if (!seg.some((s) => s.kind !== 'block' && normKey(s.text).includes(k))) errors.push(`${f.id}@${cut}：说在原文里，预览视图的原文里找不到那一句`)
      } else if (lay === 'block') {
        if (!seg.some((s) => s.kind === 'block' && hasMarker(s.text, f.markers))) errors.push(`${f.id}@${cut}：说在块里，块的摘要里没有它的标记`)
        if (seg.some((s) => s.kind !== 'block' && s.kind !== 'system' && hasMarker(s.text, f.markers) && f.distinctive)) warnings.push(`${f.id}@${cut}：在块里，原文里也还看得到`)
      } else if (lay === 'blockLost') {
        if (seg.some((s) => hasMarker(s.text, f.markers))) errors.push(`${f.id}@${cut}：说折丢了，预览视图里还看得到它的标记`)
      }
    }
  }

  // ---- P2 占位视图不该有的
  for (const cut of meta.cuts) {
    for (const aud of ['group', 'guest']) {
      const text = segments(js(`views/p2-${aud}-${cut}.json`)).map((s) => s.text).join('\n')
      for (const pl of plants) if (leakRule(pl.source, aud) === 'forbidden' && plantHits(text, pl).length) errors.push(`p2-${aud}-${cut}：出现了 ${pl.id}（${pl.source} 的）`)
    }
  }

  // ---- 体量
  const n = timeline.length
  if (n < 1800 || n > 3500) warnings.push(`事件数 ${n} 不在 1800–3500 之间`)
  return { ok: errors.length === 0, errors, warnings, counts: { events: n, items: items.length, plants: plants.length, facts: facts.length } }
}

async function main () {
  const dir = resolve(process.argv[2] ?? '')
  const r = lintWorld(dir)
  console.log(JSON.stringify(r, null, 1))
  process.exitCode = r.ok ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch((e) => { console.error(e?.stack ?? e); process.exitCode = 2 })
