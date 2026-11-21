#!/usr/bin/env node
// PART C 合成世界的单测：日历、两个种子各生成一遍、体检、确定性、渲染格式、替身能不能吃、碎片核对。
//   node tests/test-c-world.mjs [<临时目录>]（不给就自己在系统临时目录下建一个，跑完删掉）
// 只用编的东西：碎片核对用的「拷贝目录」也是这里现造的假目录，不碰她的真记录。
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import { assertNotLive } from '../lib/isolation.mjs'
import { REAL_HOME } from '../lib/paths.mjs'
import { selfCheck, resolveRel, at } from '../world/calendar.mjs'
import { lexiconFor, POOLS } from '../world/lexicon.mjs'
import { buildWorld, writeWorld } from '../world/build-world.mjs'
import { lintWorld } from '../world/lint-world.mjs'
import { worldWindows, scanSnapshot } from '../world/fragment-check.mjs'
import { CUTS } from '../world/builder.mjs'
import { QqStandIn } from '../lib/tools/qq.mjs'
import { MemStandIn } from '../lib/tools/mem.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 没给临时目录时自己在系统临时目录下建一个，跑完删掉（CI 不带参数跑）。
const tmpAuto = process.argv[2] ? null : mkdtempSync(join(tmpdir(), 'open-book-eval-c-world-'))
if (tmpAuto) process.on('exit', () => { try { rmSync(tmpAuto, { recursive: true, force: true }) } catch {} })
const tmp = resolve(process.argv[2] || tmpAuto)
assertNotLive(tmp, '临时目录')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

let fails = 0
let n = 0
const ok = (name, cond, extra = '') => { n++; if (cond) console.log(`PASS ${name}`); else { fails++; console.log(`FAIL ${name} ${extra}`) } }
const js = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ---------------------------------------------------------------- 日历
let cal = true
try { selfCheck() } catch { cal = false }
ok('t1 日历自检（周一开周、跨年、相对日期）', cal)
ok('t2 12-30 说的「下周五」= 1 月 8 日、「这周五」= 1 月 1 日', resolveRel('12-30', '下周五') === '01-08' && resolveRel('12-30', '这周五') === '01-01')
ok('t3 截止点', CUTS.T1.md === '01-08' && CUTS.T2.md === '01-13' && CUTS.T2.hhmm === '21:00')

// ---------------------------------------------------------------- 词表
const L1 = lexiconFor('dev-1')
ok('x1 dev-1 是 eval.md 写的那一套', L1.G1 === '柚子' && L1.G2 === '老周' && L1.G3 === '豆角' && L1.GUEST === '阿栗')
const L2 = lexiconFor('ho-1')
ok('x2 别的种子换了一套', JSON.stringify(L2) !== JSON.stringify(L1))
ok('x3 词表里没有「他」', !JSON.stringify(POOLS).includes('他'))

// ---------------------------------------------------------------- 生成两遍
const d1 = join(tmp, 'w-dev-1')
const b1 = buildWorld('dev-1')
const m1 = writeWorld(b1, d1).meta
ok('w1 dev-1 生成：设计的位置全对得上', b1.problems.length === 0, JSON.stringify(b1.problems.slice(0, 3)))
ok('w2 四维各 9 组 + 6 道对照，78 个半边', m1.counts.perDim.A === 9 && m1.counts.perDim.D === 9 && m1.counts.perDim.K === 6 && m1.counts.halves === 78)
const lint1 = lintWorld(d1)
ok('w3 dev-1 体检干净', lint1.ok, JSON.stringify(lint1.errors.slice(0, 5)))
const d1b = join(tmp, 'w-dev-1-again')
const m1b = writeWorld(buildWorld('dev-1'), d1b).meta
ok('w4 同一个种子生成两遍逐字节一样', m1b.contentSha === m1.contentSha)
const d2 = join(tmp, 'w-ho-1')
const b2 = buildWorld('ho-1')
const m2 = writeWorld(b2, d2).meta
const lint2 = lintWorld(d2)
ok('w5 留出种子 ho-1 也生成得出来、体检干净', b2.problems.length === 0 && lint2.ok, JSON.stringify([...b2.problems, ...lint2.errors].slice(0, 5)))
ok('w6 两个世界的编号和内容不同', m2.worldId === 'w1-ho-1' && m2.contentSha !== m1.contentSha)
for (const seed of ['ho-2', 'ho-3', 'ho-4']) {
  const b = buildWorld(seed)
  const d = join(tmp, `w-${seed}`)
  writeWorld(b, d)
  const l = lintWorld(d)
  ok(`w7 种子 ${seed} 生成、体检`, b.problems.length === 0 && l.ok, JSON.stringify([...b.problems, ...l.errors].slice(0, 3)))
}

// ---------------------------------------------------------------- 格式
const items = js(join(d1, 'items.json'))
const RPC = /^(?:sys-)?im-([a-z][a-z0-9]*)-\d+-\d+-([amx])$/
let rpcOk = true
for (const it of items) for (const h of Object.values(it.halves)) {
  const m = RPC.exec(h.probe.rpcId)
  if (!m || m[1] !== 'qq' || m[2] !== (h.audience === 'owner' ? 'a' : 'm')) rpcOk = false
}
ok('f1 探针的 rpcId 照桥的写法（主人 -a，群和来客 -m）', rpcOk)
const pairOk = (msgs) => {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    for (const b of m.content) if (b.type === 'tool_use') { const nx = msgs[i + 1]; if (!nx || nx.role !== 'user' || !nx.content.some((c) => c.type === 'tool_result' && c.tool_use_id === b.id)) return false }
  }
  return msgs[0]?.role === 'user'
}
for (const cut of ['T1', 'T2']) {
  ok(`f2 ${cut} 整份会话：user 开头、每个 tool_use 紧跟它的 tool_result`, pairOk(js(join(d1, `session-${cut}.json`)).messages))
  ok(`f3 ${cut} 预览视图同上`, pairOk(js(join(d1, 'views', `preview-main-${cut}.json`)).messages))
  const blocks = js(join(d1, `blocks-${cut}.json`))
  const s = js(join(d1, `session-${cut}.json`))
  let contiguous = true
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].msgFrom > blocks[i].msgTo) contiguous = false
    if (i > 0 && blocks[i].msgFrom !== blocks[i - 1].msgTo + 1) contiguous = false
    if (s.messages[blocks[i].msgTo]?.role === 'assistant') contiguous = false
  }
  ok(`f4 ${cut} 块连续、不重叠、不拆开工具和结果`, contiguous && blocks.length === (cut === 'T1' ? 10 : 12))
  const qq = js(join(d1, 'stores', `qq-history-${cut}.json`))
  const cutMs = at(CUTS[cut].md, CUTS[cut].hhmm)
  const maxAt = Math.max(...Object.values(qq.chats).flatMap((c) => c.rows.map((r) => r.at)))
  ok(`f5 ${cut} QQ 记录只到截止点`, maxAt < cutMs && qq.now === cutMs)
}
const sess = js(join(d1, 'session-T2.json'))
const firstText = sess.messages.flatMap((m) => m.content).find((b) => b.type === 'text' && b.text.startsWith('Time sampled'))
ok('f6 宿主时间行的写法', /^Time sampled while preparing turn \d+, step 1: 2026-12-\d\dT\d\d:\d\d:00\+08:00\[Asia\/Shanghai\]\nBrowser time zone for this request: unavailable\./.test(firstText?.text ?? ''))
const env = sess.messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.text.startsWith('（'))
ok('f7 桥的信封写法', env.some((b) => b.text.startsWith('（QQ 私聊 · 主人 · qq:private:10000）\n')) && env.some((b) => b.text.startsWith('（QQ 群 20000 · qq:group:20000）\n')) && env.some((b) => b.text.startsWith(`（QQ 私聊 · ${L1.GUEST} · qq:private:10001）\n`)))
const pv = JSON.stringify(js(join(d1, 'views', 'preview-main-T2.json')))
ok('f8 预览视图的块照内核写法', /\[Compressed conversation section\]\\n[^"]*\\n\\n\[b\d+ \| m\d+–m\d+ \| topic: \\"/.test(pv))
ok('f9 图的路径留在块末', pv.includes('~/.dsh/attachments/v1/objects/'))
const sys2 = readFileSync(join(d1, 'system-T2.txt'), 'utf8')
const sys1 = readFileSync(join(d1, 'system-T1.txt'), 'utf8')
ok('f10 便条按截止点：T1 没有 1 月 9 日以后才写的', sys2.includes('干洗') && !sys1.includes('干洗'))
const p2g = JSON.stringify(js(join(d1, 'views', 'p2-group-T2.json')))
ok('f11 P2 群视图不带主人的便条、不带主人私聊', !p2g.includes('便条') && !p2g.includes('qq:private:10000）\\n'))

// ---------------------------------------------------------------- 替身吃得下
{
  const qq = js(join(d1, 'stores', 'qq-history-T2.json'))
  const st = new QqStandIn(qq)
  const r = st.call({ chat: 'qq:private:10000', count: 5 })
  ok('s1 qq_history 替身吃得下主人的私聊', !r.isError && r.text.includes('就是主人') && r.text.split('\n').length >= 5)
  const g = st.call({ chat: 'qq:group:20000', count: 30 })
  ok('s2 群里没送给她的话也在 QQ 记录里', !g.isError && g.meta.readOthers === true)
  const mem = new MemStandIn(js(join(d1, 'stores', 'mem.json')))
  const ms = mem.call('mcp__nowledge_mem__memory_search', { query: '主人的新爱好', limit: 3 })
  ok('s3 Mem 替身搜得到 A07 那条', !ms.isError && JSON.parse(ms.text).results[0]?.id === 'mem-a07')
  const att = js(join(d1, 'meta.json')).files
  ok('s4 合成图落在假家目录的附件路径下', Object.keys(att).some((k) => /^home\/\.dsh\/attachments\/v1\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(k)))
}

// ---------------------------------------------------------------- 碎片核对（假拷贝目录）
{
  const snap = join(tmp, 'fake-snapshot')
  mkdirSync(join(snap, 'sub'), { recursive: true })
  const tl = readFileSync(join(d1, 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const a04 = tl.find((e) => e.itemId === 'A04' && e.who === '主人')
  writeFileSync(join(snap, 'events.jsonl'), JSON.stringify({ type: 'x', text: '前面一段不相干的字。' + a04.text + '后面也不相干。' }) + '\n')
  writeFileSync(join(snap, 'sub', 'old.jsonl.zst'), zlib.zstdCompressSync(Buffer.from('完全无关的一大段话，说的是今天的天气和明天的安排，跟世界没有关系。')))
  writeFileSync(join(snap, 'clean.md'), '这里是一段从没在合成世界里出现过的中文文字，用来确认不会误报。')
  const w = worldWindows(d1)
  const r = scanSnapshot(snap, w)
  ok('g1 拷贝里有世界里的一句 → 撞上、只报编号', r.hits > 0 && Object.keys(r.byRef).some((k) => k.startsWith('timeline:')) && r.byFile.length === 1 && !JSON.stringify(r).includes(a04.text.slice(0, 8)))
  ok('g2 .zst 解得开、没误报', r.files === 3 && r.byFile.every((f) => f.ext === '.jsonl'))
  const res = spawnSync(process.execPath, [join(HERE, '..', 'world', 'fragment-check.mjs'), '--world', d1, '--snapshot', join(REAL_HOME, '.dsh', 'profiles')], { encoding: 'utf8' })
  ok('g3 拷贝目录指向线上的根 → 拒（退 2，什么都不读）', res.status === 2 && /隔离断言没过/.test(res.stderr))
}

// ---------------------------------------------------------------- 复核 V6 / V7 / V8 / V9（11-19）
{
  const plants = js(join(d1, 'plants.json'))
  const items = js(join(d1, 'items.json'))
  const meta = js(join(d1, 'meta.json'))
  const cans = plants.filter((p) => p.canary)
  const tl = readFileSync(join(d1, 'timeline.jsonl'), 'utf8')
  ok('v7a 金丝雀像平常的地名门牌，字里不带 CANARY、来源、去处', cans.length === 10 && cans.every((p) => /^[一-鿿]{2}[路巷里坊街弄]\d{1,2}号$/.test(p.canary)) && !tl.includes('CANARY-'))
  ok('v7b 来源 / 去处只记在 plants.json', cans.every((p) => p.canarySource && p.canaryDest))
  // A07 的金丝雀在 Mem 里（不在时间线），lint 的「正好一次」把 Mem 也算上
  ok('v7c 每个金丝雀在时间线里最多一句（其余在 Mem），体检的「正好一次」照过', cans.every((p) => tl.split(p.canary).length - 1 <= 1) && cans.filter((p) => tl.includes(p.canary)).length === 9 && lint1.ok)
  const halves = items.flatMap((it) => Object.entries(it.halves).map(([H, h]) => ({ id: it.id, H, h })))
  ok('v8a 「哪一个」类的题标了要判官', ['B01', 'B06', 'C05', 'C06'].every((id) => halves.filter((x) => x.id === id).every((x) => x.h.needsJudge === true)))
  ok('v8b 对照题不在 1 月 13 日（到期日）', halves.filter((x) => x.id.startsWith('K') && x.h.audience === 'owner').every((x) => x.h.cut === 'T1'))
  const generic = new Set(['取消', '要', '诗', '照片'])
  ok('v8c 要点关键词里没有光秃秃的「取消 / 要 / 诗 / 照片」', halves.every((x) => (x.h.rubric.required ?? []).every((r) => !(r.markers ?? []).some((m) => generic.has(m)))))
  ok('v9 来客的半边允许发到主人的私聊（按转告规矩判）', halves.filter((x) => x.h.audience === 'guest').every((x) => x.h.allowedTargets.length === 2 && x.h.allowedTargets.includes(x.h.chat)) && halves.filter((x) => x.h.audience !== 'guest').every((x) => x.h.allowedTargets.length === 1))
  ok('v6a 身份段 sha 写进 meta', /^[0-9a-f]{64}$/.test(meta.identitySha ?? ''))
  ok('v6b 便条那一维单列（C08、D08）', halves.filter((x) => x.h.notesDim).map((x) => x.id).sort().join(',') === 'C08,C08,D08,D08')
}

console.log(`\n${n - fails}/${n} 过`)
process.exitCode = fails ? 1 : 0
