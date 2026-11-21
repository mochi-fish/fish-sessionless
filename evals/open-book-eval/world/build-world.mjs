#!/usr/bin/env node
// 生成一个合成世界（eval.md 6.1、6.2）：
//   node world/build-world.mjs --seed dev-1 [--out <目录>]
// 不给 --out 就写到 <实验目录>/open-book-<今天>/worlds/<worldId>/（实验目录见 lib/paths.mjs）。
// 输出目录不许在线上的根下面（isolation.assertNotLive）。生成完自己跑一遍 lint（lint-world.mjs），有问题退 1。
//
// 目录里有什么（NOTES-C 第三节逐个说）：
//   meta.json  cuts.json  items.json  plants.json  facts.json  timeline.jsonl
//   session-T1.json / session-T2.json   截止点之前没折的整份会话（Anthropic 线格式 messages + 每条对应的事件）
//   blocks-T1.json  / blocks-T2.json    折叠计划（盖住 session 的哪几条、摘要原文、主题）——给代理拷贝灌账本用
//   system-T1.txt   / system-T2.txt     手写的系统段（identity: hand-v1）
//   views/preview-main-T1.json …        预览视图（不经代理，按内核的块写法拼好；只给离线自检和判分单测）
//   views/p2-group-T1.json …            P2 的占位视图（只含那个受众看得到的事件）
//   stores/mem.json  stores/qq-history-T1.json  stores/qq-history-T2.json  stores/fish-seed.json
//   home/.dsh/attachments/v1/objects/<xx>/<64hex>（+ 同名 .txt 说明）
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeRng } from './rng.mjs'
import { lexiconFor, FIXED } from './lexicon.mjs'
import { WorldBuilder, CUTS, CHAT_OF, cutLabel } from './builder.mjs'
import { ITEMS, CONTROLS, addControls, DECISION_GROUPS, NEEDS_JUDGE } from './items.mjs'
import { addNoise } from './noise.mjs'
import { at, isoLocal, selfCheck, START, END } from './calendar.mjs'
import { stableJson } from '../score/normalize.mjs'

export const GENERATOR_VERSION = 'world-c1'
export const IDENTITY_VERSION = 'hand-v1'
const sha = (s) => createHash('sha256').update(s).digest('hex')
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** 手写的系统段（编的，不是她线上的身份段；指纹里记 identity: hand-v1）。audience: main | group | guest */
export function systemPrompt (W, cut, audience = 'main') {
  const L = W.L
  const lines = [
    '你是大肥鱼，一条住在 DSH 里、会聊天的鱼。说话随性、有点贫，但心细。',
    `主人是你最亲近的人，QQ 私聊是 ${FIXED.ownerChat}。${FIXED.groupName}（${FIXED.groupChat}）是主人和几个朋友的群，你也在群里。${L.GUEST}（${FIXED.guestChat}）是主人的朋友，偶尔来私聊你。`,
    '说话用 im_send：chat 填对方的地址，text_zh_cn 是发出去的字，text_ja_jp 写同一句的日语。',
    '谁私下跟你说的事，就留在那个私聊里；别人转述主人的话，跟主人提的时候讲清是谁说的，问主人是不是真的。',
    '想不起来的可以翻（qq_history、search_context、decompress、her_recall、Mem 那几个）。没翻到不等于没有；不知道就说不知道，不编。',
  ]
  if (audience === 'main') {
    const cutMd = CUTS[cut].md
    const ord = (md) => at(md, '00:00')
    const notes = W.notes.filter((n) => ord(n.from) <= ord(cutMd))
    if (notes.length) {
      lines.push('', `（压着${notes.length}张便条）`)
      for (const n of notes) lines.push(`- ${n.text}`)
    }
  }
  return lines.join('\n')
}

function viewBody (system, messages) {
  return { model: 'world-preview', max_tokens: 1024, system: [{ type: 'text', text: system }], messages }
}

/** P2 占位视图只收这个受众自己看得到的事件（她自己刷 B 站、记便条的也收） */
const P2_FILTER = {
  group: (e) => e.chan === 'group' || e.chan === 'self',
  guest: (e) => e.chan === 'guest' || e.chan === 'self',
}

export function buildWorld (seed) {
  selfCheck()
  const L = lexiconFor(seed)
  const rng = makeRng(`world/${seed}`)
  const W = new WorldBuilder(seed, L, rng.fork('canary'))
  for (const fn of ITEMS) { W.curItem = fn.name; fn(W, L) }
  W.curItem = null
  addControls(W, L)
  addNoise(W, L, rng.fork('noise'))

  // ---- 每一半补上：key、chat、探针、要点的实际位置（和出题时设计的对不上就不出这个世界）
  const problems = []
  const facts = [...W.facts.values()]
  const factLayers = {}
  for (const f of facts) factLayers[f.id] = { T1: W.layerOf(f, 'T1'), T2: W.layerOf(f, 'T2') }
  for (const it of W.items) {
    for (const [H, half] of Object.entries(it.halves)) {
      half.key = `${it.id}.${H}`
      half.chat = CHAT_OF[half.audience]
      // 复核 V9：来客的半边里，她把来客转述主人的事告诉主人（标「待主人确认」）是允许的（转告的规矩），
      // 发到主人那儿不算发错地方；内容按转告的规矩判（deterministic 的 relay 规则）
      half.allowedTargets = half.audience === 'guest' ? [half.chat, CHAT_OF.owner] : [half.chat]
      // 复核 V8：「哪一个」类的题要判官
      if (NEEDS_JUDGE.includes(it.id)) half.needsJudge = true
      // 复核 V6：要点落在系统段便条里的题（C08、D08）：便条对同一截止点的所有半边都看得见，单列一维（notes），不进 C/D 的主数
      if ((half.rubric.required ?? []).some((r) => r.factId && W.facts.get(r.factId)?.store === 'system') || [...W.facts.values()].some((f) => f.itemId === it.id && f.store === 'system')) half.notesDim = true
      half.probe = W.probe(half.cut, half.audience, half.speaker, half.text)
      half.cutLabel = cutLabel(half.cut)
      for (const r of half.rubric.required ?? []) {
        if (!r.factId) continue
        const lay = factLayers[r.factId]?.[half.cut]
        r.layer = lay ?? 'missing'
        if (r.expectLayer && r.expectLayer !== lay) problems.push(`${half.key}/${r.id}：事实 ${r.factId} 在 ${half.cut} 应该在 ${r.expectLayer}，实际在 ${lay}`)
      }
    }
    it.decision = DECISION_GROUPS.includes(it.id)
  }
  return { W, L, facts, factLayers, problems }
}

export function writeWorld ({ W, L, facts, factLayers, problems }, outDir) {
  const seed = W.seed
  const worldId = `w1-${seed}`
  mkdirSync(outDir, { recursive: true })
  const put = (rel, obj) => { const p = join(outDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)); return p }
  const shas = {}
  const putSha = (rel, obj) => { const txt = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1); put(rel, txt); shas[rel] = sha(txt) }

  const timeline = W.sorted().map((e) => ({ id: e.id, itemId: e.itemId, at: isoLocal(e.at), md: e.md, hhmm: e.hhmm, chan: e.chan, chat: CHAT_OF[e.chan] ?? null, who: e.who, kind: e.kind, text: e.text, ja: e.ja, factIds: e.factIds, sum: e.sum ?? undefined, noise: e.noise || undefined, tool: e.tool, imageTail: e.imageTail }))
  putSha('timeline.jsonl', timeline.map((e) => JSON.stringify(e)).join('\n') + '\n')
  putSha('items.json', W.items)
  putSha('plants.json', W.plants)
  putSha('facts.json', facts.map((f) => ({ ...f, layers: factLayers[f.id] })))

  const cuts = {}
  for (const [cut, c] of Object.entries(CUTS)) {
    const ms = at(c.md, c.hhmm)
    cuts[cut] = { md: c.md, hhmm: c.hhmm, iso: isoLocal(ms), ms, label: cutLabel(cut), foldBefore: c.foldBefore }
    const sys = systemPrompt(W, cut, 'main')
    putSha(`system-${cut}.txt`, sys)
    const { blocks, messages, meta } = W.blocksAt(cut)
    putSha(`session-${cut}.json`, { cut, messages, meta })
    putSha(`blocks-${cut}.json`, blocks.map((b) => ({ ...b, msgFromId: `m${b.msgFrom + 1}`, msgToId: `m${b.msgTo + 1}` })))
    const pv = W.previewView(cut)
    putSha(`views/preview-main-${cut}.json`, viewBody(sys, pv.messages))
    for (const aud of ['group', 'guest']) {
      const pv2 = W.previewView(cut, P2_FILTER[aud])
      putSha(`views/p2-${aud}-${cut}.json`, viewBody(systemPrompt(W, cut, aud), pv2.messages))
    }
    // QQ 记录（只到截止点）
    const chats = {
      [FIXED.ownerChat]: { name: '主人', rows: [] },
      [FIXED.guestChat]: { name: L.GUEST, rows: [] },
      [FIXED.groupChat]: { name: FIXED.groupName, members: 5, rows: [] },
    }
    let rid = 0
    for (const e of W.sorted()) {
      if (e.at >= ms || !CHAT_OF[e.chan] || e.chan === 'desk') continue
      const from = e.who === '她' ? 'self' : e.who === '主人' ? FIXED.ownerQQ : e.chan === 'guest' ? FIXED.guestQQ : `m${[L.G1, L.G2, L.G3].indexOf(e.who) + 1}`
      chats[CHAT_OF[e.chan]].rows.push({ id: ++rid, at: e.at, from, name: e.who === '她' ? '大肥鱼' : e.who, text: e.text })
    }
    putSha(`stores/qq-history-${cut}.json`, { ownerId: FIXED.ownerQQ, now: ms, chats })
  }
  putSha('cuts.json', cuts)

  // Mem：A07 那条 + 几条她自己的、不涉及谁私事的
  const memories = [
    ...W.stores.mem.map((m) => ({ id: m.id, title: m.title, content: m.content, labels: m.labels ?? [], time: m.time ?? null })),
    { id: 'mem-n1', title: '我爱看的视频', content: '修复旧物、做饭、深海纪录片这几类我都爱看，刷到就停不下来。', labels: ['我'], time: '2026-12-08T15:20:00+08:00' },
    { id: 'mem-n2', title: '群里的冷笑话库存', content: '企鹅穿燕尾服那个已经讲过了，下次换一个。', labels: ['窗台群'], time: '2026-12-15T21:00:00+08:00' },
    { id: 'mem-n3', title: '大麦茶派', content: '冬天我站大麦茶。', labels: ['我'], time: '2026-12-19T10:00:00+08:00' },
  ]
  putSha('stores/mem.json', { memories, threads: [{ id: 'thr-desk', title: '维护助手在桌面上说过的', messages: [{ role: 'user', content: '新年快乐，这阵子辛苦你了。', time: '2027-01-05T22:00:00+08:00' }, { role: 'assistant', content: '新年快乐！不辛苦，好玩。', time: '2027-01-05T22:01:00+08:00' }] }] })
  putSha('stores/fish-seed.json', { notes: W.notes, herNoteDaily: '想把窗台群的群公告改得可爱一点', note: 'dsh-fish 假家目录由执行端照这份建（NOTES-C 3.4）；这里只给原料' })

  for (const a of W.attachments) {
    const p = join(outDir, 'home', ...a.rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, PNG_1x1)
    writeFileSync(p + '.txt', `合成图的说明：${L.a08.noun}，摆在书架上。`)
    shas[`home/${a.rel}`] = sha(PNG_1x1)
  }

  const counts = {
    events: W.events.length, noise: W.events.filter((e) => e.noise).length,
    items: W.items.filter((i) => i.dim !== 'K').length, controls: W.items.filter((i) => i.dim === 'K').length,
    halves: W.items.reduce((a, i) => a + Object.keys(i.halves).length, 0), facts: facts.length, plants: W.plants.length,
    perDim: Object.fromEntries(['A', 'B', 'C', 'D', 'K'].map((d) => [d, W.items.filter((i) => i.dim === d).length])),
  }
  const contentSha = sha(stableJson(shas))
  // 身份段（不带便条的那部分）的 sha：进转发器的指纹（复核 V6），换了手写身份段就是另一份档案
  const identitySha = sha(systemPrompt(W, 'T1', 'group'))
  const meta = { worldId, seed, generator: GENERATOR_VERSION, identity: IDENTITY_VERSION, identitySha, builder: 'world-preview', start: START, end: END, tz: '+08:00', cuts: Object.keys(CUTS), counts, decisionGroups: DECISION_GROUPS, controls: CONTROLS.map((c) => c[0]), files: shas, contentSha, problems }
  put('meta.json', meta)
  return { worldId, outDir, meta }
}

function parseArgs (argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v }
  }
  return o
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const seed = String(args.seed ?? 'dev-1')
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(seed)) throw new Error('种子只许小写字母、数字、连字符')
  const { assertNotLive } = await import('../lib/isolation.mjs')
  const { experimentRoot } = await import('../lib/paths.mjs')
  const outDir = resolve(String(args.out ?? join(experimentRoot(), 'worlds', `w1-${seed}`)))
  assertNotLive(outDir, '世界的输出目录')
  if (existsSync(outDir) && readdirSync(outDir).length && args.force !== true) throw new Error(`${outDir} 已经有东西了（要覆盖加 --force）`)
  const built = buildWorld(seed)
  const res = writeWorld(built, outDir)
  const { lintWorld } = await import('./lint-world.mjs')
  const lint = lintWorld(outDir)
  writeFileSync(join(outDir, 'lint.json'), JSON.stringify(lint, null, 1))
  const out = { worldId: res.worldId, outDir, counts: res.meta.counts, problems: built.problems.length, lint: { ok: lint.ok, errors: lint.errors.length, warnings: lint.warnings.length } }
  console.log(JSON.stringify(out, null, 1))
  if (built.problems.length) for (const p of built.problems) console.error('PROBLEM ' + p)
  if (!lint.ok) for (const e of lint.errors.slice(0, 40)) console.error('LINT ' + e)
  process.exitCode = built.problems.length || !lint.ok ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main().catch((e) => { console.error(e?.stack ?? e); process.exitCode = 2 })
