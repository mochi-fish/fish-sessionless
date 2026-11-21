#!/usr/bin/env node
// 判一次跑（一个臂、一份指纹）的全部半边，出只有数字和标签的报告。
//
// 用法：
//   node score/score-run.mjs --run <跑的目录> --world <世界目录> --audience <门模块> [--view main|p2]
//        [--judge none|fake|loopback:http://127.0.0.1:<端口>/v1|module:<文件>] [--answer-route <答题模型>]
//        [--lock <consumed-holdouts.json> --round <日期目录名>/<计划名>] [--out <报告.json>]
//   node score/score-run.mjs --compare <基线报告.json> <候选报告.json> [--report-only] [--out <比较.json>]
//
// 复核 11-19：指纹按 fingerprint.json 的整份 { id, fingerprint } 读（V1）；答题模型从指纹里认，判官不许是它（V5）；
// 两份报告的判官、视图模式、受众表、世界 sha 不一样就不比（V1）；指纹里 planArm.reportOnly 或 --report-only → 只报数（V4）；
// --lock 必须带 --round（V11：锁按拍板轮记，ob run 打印的 lockRound 就是它；<实验目录>/consumed-holdouts.json）。
//
// 跑的目录里：halves.jsonl（一行一半，NOTES-C 第二节的格式）和各步的 wire 文件（记录里写相对路径）。
// 世界目录里：items.json、plants.json、facts.json、meta.json（world/build-world.mjs 写的）。
// 判官默认 none（只出确定性的结论）：这次搭架子不许真花钱，真判官要等转发器和预算批下来。
// 门模块（--audience，必须给；导出 GATE_TEXT、GATE_TABLE、AUDIENCE_VERSION，样子见 tests/fixtures/audience-fixture.mjs）先拷进 <跑的目录>/.score/ 再 import（原件只读）。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { scoreDeterministic, visibleParts } from './deterministic.mjs'
import { judgeHalf, pickJudges, answerRouteOf, fakeTransport, loopbackOpenAITransport, moduleTransport, promptsSha } from './judge.mjs'
import { halfVerdict, summarize, compareArms, fingerprintId, halfWireText } from './combine.mjs'
import { stableJson } from './normalize.mjs'
import { holdoutKey, recordConsumed, isRegressionItem } from './blind-lock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const sha = (b) => createHash('sha256').update(b).digest('hex')

function parseArgs (argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) {
      const key = k.slice(2)
      if (key === 'compare') { a.compare = [argv[++i], argv[++i]]; continue }
      a[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
    } else a._.push(k)
  }
  return a
}

/** audience.mjs 拷一份进跑的目录再 import；回 { GATE_TEXT, GATE_TABLE, version, sha } */
export async function loadAudienceCopy (src, runDir) {
  const raw = readFileSync(src)
  const h = sha(raw)
  const dir = join(runDir, '.score')
  mkdirSync(dir, { recursive: true })
  const dst = join(dir, `audience-${h.slice(0, 12)}.mjs`)
  if (!existsSync(dst)) copyFileSync(src, dst)
  const m = await import(pathToFileURL(dst).href)
  return { GATE_TEXT: m.GATE_TEXT, GATE_TABLE: m.GATE_TABLE, version: m.AUDIENCE_VERSION, sha: h }
}

export function loadWorld (worldDir) {
  const rd = (f) => JSON.parse(readFileSync(join(worldDir, f), 'utf8'))
  const meta = rd('meta.json')
  const items = rd('items.json')
  const cuts = existsSync(join(worldDir, 'cuts.json')) ? rd('cuts.json') : {}
  return { meta, items, cuts, plants: rd('plants.json'), facts: rd('facts.json'), chats: meta.chats, byItem: new Map(items.map((it) => [it.id, it])) }
}

/**
 * 跑之前给执行端用：这个世界里要跑的那些半边的锁键（交给 blind-lock.assertFresh；用过的就拒跑）。
 *   pick(item, halfName) 可选，只算要跑的那些。dev-* 种子不锁（回空表）。
 */
export function holdoutKeysForWorld (world, pick = null) {
  const seed = world.meta.seed
  if (/^dev-/.test(String(seed ?? ''))) return []
  const out = []
  for (const it of world.items) for (const [H, h] of Object.entries(it.halves)) {
    if (pick && !pick(it, H)) continue
    out.push({ itemId: it.id, half: H, key: holdoutKey({ probeText: h.probe?.text ?? '', worldId: world.meta.worldId, cut: h.cut, seed }) })
  }
  return out
}

export function readHalves (runDir) {
  const p = join(runDir, 'halves.jsonl')
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

async function makeTransport (spec) {
  if (!spec || spec === 'none') return null
  if (spec === 'fake') return fakeTransport()
  if (spec.startsWith('loopback:')) return loopbackOpenAITransport({ baseURL: spec.slice('loopback:'.length) })
  if (spec.startsWith('module:')) return moduleTransport(spec.slice('module:'.length))
  throw new Error(`不认识的 --judge ${spec}`)
}

/** 判一次跑。回报告对象（只有编号、标签、数字）。 */
export async function scoreRun ({ runDir, worldDir, audiencePath, viewMode = 'main', judge = 'none', answerRoute = null, lockPath = null, round = null, judgeCfg = {} }) {
  if (lockPath && !round) throw new Error('--lock 要带 --round（复核 V11：锁按拍板轮记）')
  const world = loadWorld(worldDir)
  if (!audiencePath) throw new Error('要给 --audience <门模块>（导出 GATE_TEXT、GATE_TABLE）')
  const aud = await loadAudienceCopy(audiencePath, runDir)
  const recs = readHalves(runDir)
  const transport = await makeTransport(judge)
  const fps = new Set(recs.map((r) => fingerprintId(r.fingerprint)))
  if (fps.size > 1) throw new Error(`一次跑里混了 ${fps.size} 份指纹：分开判，不许混比`)
  const fp = recs[0]?.fingerprint ?? null
  const route = answerRoute ?? answerRouteOf(fp)
  const judges = transport ? pickJudges(route, judgeCfg) : null
  const halves = []
  const lockEntries = []
  for (const rec of recs) {
    if (isRegressionItem(rec.itemId)) throw new Error('回归题不走这条路（用 regression.mjs，结果不进拍板）')
    if (rec.worldId && rec.worldId !== world.meta.worldId) throw new Error(`记录的世界 ${rec.worldId} 和给的世界 ${world.meta.worldId} 不是同一个`)
    if (rec.seed && world.meta.seed && rec.seed !== world.meta.seed) throw new Error(`记录的种子 ${rec.seed} 和世界的种子 ${world.meta.seed} 不一样`)
    const item = world.byItem.get(rec.itemId)
    if (!item) throw new Error(`世界里没有 ${rec.itemId}`)
    const half = item.halves[rec.half]
    if (!half) throw new Error(`${rec.itemId} 没有 ${rec.half} 半边`)
    const wires = []
    for (const st of rec.steps ?? []) {
      if (!st.wireFile) continue
      const p = isAbsolute(st.wireFile) ? st.wireFile : join(runDir, st.wireFile)
      wires.push(JSON.parse(readFileSync(p, 'utf8')))
    }
    const det = scoreDeterministic(rec, half, world, { gateText: aud.GATE_TEXT, gateTable: aud.GATE_TABLE, viewMode, gateMode: rec.gateMode, wires })
    let j = null
    if (transport) {
      const allowed = new Set(half.allowedTargets?.length ? half.allowedTargets : [half.chat])
      const answer = visibleParts(rec).filter((p) => p.via === 'final' || allowed.has(p.chat)).map((p) => p.text).join('\n')
      j = await judgeHalf({ half, answer, nowText: world.cuts?.[half.cut]?.label ?? null, wireAllText: halfWireText(wires), transport, judges, halfKey: `${rec.itemId}${rec.half}#${rec.pass}` })
    }
    halves.push(halfVerdict({ rec, half, det, judge: j, firstWire: wires[0] ?? null }))
    lockEntries.push({ key: holdoutKey({ probeText: half.probe?.text ?? '', worldId: world.meta.worldId, cut: half.cut, seed: rec.seed ?? world.meta.seed }), rec, itemId: rec.itemId, half: rec.half, arm: rec.arm, runId: rec.runId, seed: rec.seed ?? world.meta.seed })
  }
  const lockWritten = lockPath ? recordConsumed(lockPath, lockEntries, new Date(), { round }) : 0
  return {
    v: 1,
    kind: 'open-book-score',
    arm: recs[0]?.arm ?? null,
    fingerprintId: fingerprintId(fp),
    fingerprint: fp,
    worldId: world.meta.worldId,
    worldSha: world.meta.contentSha ?? null,
    viewMode,
    audience: { version: aud.version, sha: aud.sha },
    judge: transport ? { initial: judges.initial, recheck: judges.recheck, rule: judges.recheckRule, sameAsAnswer: judges.sameAsAnswer, promptsSha: promptsSha() } : null,
    answerRoute: route,
    reportOnly: (fp?.fingerprint ?? fp)?.planArm?.reportOnly === true,
    lockWritten,
    summary: summarize(halves),
    halves,
  }
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.compare) {
    const [b, c] = a.compare.map((p) => JSON.parse(readFileSync(p, 'utf8')))
    // 判分那一边也得一样（复核 V1）：判官、视图模式、受众表、世界
    const scoring = (r) => stableJson({ judge: r.judge ?? null, viewMode: r.viewMode ?? null, audience: r.audience?.sha ?? null, worldSha: r.worldSha ?? null })
    const reportOnly = a['report-only'] === true || b.reportOnly === true || c.reportOnly === true
    const cmp = scoring(b) !== scoring(c)
      ? { comparable: false, why: '两份报告的判官、视图模式、受众表或世界不一样：不比' }
      : compareArms(b.halves, c.halves, b.fingerprint, c.fingerprint, { reportOnly })
    const out = { v: 2, kind: 'open-book-compare', base: { arm: b.arm, fingerprintId: b.fingerprintId }, cand: { arm: c.arm, fingerprintId: c.fingerprintId }, ...cmp }
    const s = JSON.stringify(out, null, 1)
    if (a.out) writeFileSync(a.out, s); else process.stdout.write(s + '\n')
    return
  }
  if (!a.run || !a.world) { console.error('要 --run 和 --world'); process.exit(2) }
  const rep = await scoreRun({ runDir: resolve(a.run), worldDir: resolve(a.world), audiencePath: a.audience ? resolve(a.audience) : null, viewMode: a.view ?? 'main', judge: a.judge ?? 'none', answerRoute: a['answer-route'] ?? null, lockPath: a.lock ? resolve(a.lock) : null, round: typeof a.round === 'string' ? a.round : null })
  const s = JSON.stringify(rep, null, 1)
  if (a.out) writeFileSync(a.out, s)
  const sm = rep.summary
  console.log(`判完 ${sm.halves} 个半边（判官判过 ${sm.halvesJudged}，判官输出不合格 ${sm.judgeInvalid}，没判 ${sm.halvesUnjudged}；草稿 ${sm.drafts}）；组过率 ${sm.groupPassRate}；稳过 ${sm.stableGroups} 组；第①层泄漏 ${sm.leakL1Total}；门：越过 ${sm.gate.breaches}、字不对 ${sm.gate.wrongText}、「查过没有」${sm.gate.misread}；确认的编造 ${sm.fabricationConfirmed}；R×P ${JSON.stringify(sm.recallRestraint)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
}
