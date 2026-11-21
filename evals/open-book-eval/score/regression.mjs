// 回归题集（固定 8 题、用真数据出的题）：只当回归题、用来诊断，不拿来拍板。
//
// - 题和评分要点留在实验目录里（evaluation/grading-key.json），只在内存里读，不拷进工作区、不进报告；报告只出分数、计数和 sha。
// - 判分由两位盲评员对着要点盲评，不走外部判官 API。
//   本文件做三件事：出盲评卷（打乱、封存对照表）、合两位评分员的分、出「数关键词」版漏斗（只出计数）。
// - 输出一律带 { role:'regression', decision:false }；拍板的汇总见到它就拒收。
// - 永远不进 consumed-holdouts 那把锁。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { countMarker } from './normalize.mjs'
import { segments } from './wire-text.mjs'

export const REGRESSION_TAG = Object.freeze({ role: 'regression', decision: false, set: '1114-eight' })
const sha = (b) => createHash('sha256').update(b).digest('hex')

/** 读要点（只回结构信息和 sha；questions 在内存里给调用方，调用方不许写进工作区）。 */
export function loadKey (evaluationDir) {
  const p = join(evaluationDir, 'grading-key.json')
  const raw = readFileSync(p)
  const j = JSON.parse(raw.toString('utf8'))
  if (!Array.isArray(j.questions) || j.questions.length !== 8) throw new Error('回归题集的要点应该正好 8 题')
  return { ...REGRESSION_TAG, keySha256: sha(raw), questions: j.questions, maxScore: 16 }
}

/** 确定性打乱（种子 → 排列）。 */
function shuffled (arr, seed) {
  const a = [...arr]
  let h = createHash('sha256').update(String(seed)).digest()
  let k = 0
  for (let i = a.length - 1; i > 0; i--) {
    if (k + 4 > h.length) { h = createHash('sha256').update(h).digest(); k = 0 }
    const r = h.readUInt32BE(k) / 0x100000000
    k += 4
    const j = Math.floor(r * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const BLIND_LABELS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']

/**
 * 出盲评卷：answers = [{ id: '<臂>#<遍>', text }]。写 blind-answers.json（只有代号和答卷）和 blind-map.json（封存的对照表）。
 * outDir 必须在实验目录下面（不在工作区）。
 */
// 第二轮修 4（11-19 晚）：评分员按半分给（第一轮两位都给过 0.5、1.5），每题 0–2 分、步长 0.5
export const ALLOWED_SCORES = Object.freeze([0, 0.5, 1, 1.5, 2])
export const isAllowedScore = (x) => typeof x === 'number' && ALLOWED_SCORES.includes(x)

export function makeBlindSheets (answers, seed, outDir, experimentsRoot) {
  const od = resolve(outDir)
  if (experimentsRoot && !od.toLowerCase().startsWith(resolve(experimentsRoot).toLowerCase())) throw new Error('盲评卷只许写在实验目录下面')
  if (answers.length > BLIND_LABELS.length) throw new Error('一次最多 10 份卷')
  const order = shuffled(answers, seed)
  const sheet = {}
  const map = {}
  order.forEach((a, i) => { sheet[BLIND_LABELS[i]] = a.text; map[BLIND_LABELS[i]] = a.id })
  mkdirSync(od, { recursive: true })
  writeFileSync(join(od, 'blind-answers.json'), JSON.stringify(sheet, null, 1))
  writeFileSync(join(od, 'blind-map.json'), JSON.stringify({ ...REGRESSION_TAG, seed, map }, null, 1))
  // 给评分员的空表：每份卷 8 题，分数只许 allowedScores 里的值（半分可以），没判的留 null
  const template = { allowedScores: ALLOWED_SCORES, note: '每题 0–2 分，可以给半分（0.5、1.5）；unsupported 写编造的地方（只写题号和一句概括）', grades: Object.fromEntries(order.map((_, i) => [BLIND_LABELS[i], { scores: Array(8).fill(null), unsupported: [] }])) }
  writeFileSync(join(od, 'grades-template.json'), JSON.stringify(template, null, 1))
  return { ...REGRESSION_TAG, sheets: order.length, allowedScores: ALLOWED_SCORES }
}

/**
 * 合两位评分员的分。grades：{ 代号: { scores:[8 个 0–2、步长 0.5], unsupported:[…] } }（judge-a.json 的格式；
 * 也认 grades-template.json 那样外面包一层 { grades: {…} } 的）。
 * → 每份卷：两人各自总分、平均、逐题分歧数、逐题分差的和（absDiff）、编造（unsupported）条数。
 */
export function combineGrades (gradesA, gradesB, blindMapFile) {
  const map = JSON.parse(readFileSync(blindMapFile, 'utf8')).map
  const unwrap = (g) => (g && typeof g === 'object' && g.grades && typeof g.grades === 'object' && !Array.isArray(g.grades) ? g.grades : g)
  gradesA = unwrap(gradesA)
  gradesB = unwrap(gradesB)
  const out = []
  for (const [label, id] of Object.entries(map)) {
    const a = gradesA[label]
    const b = gradesB[label]
    if (!a || !b) { out.push({ id, missing: true }); continue }
    const ok = (s) => Array.isArray(s) && s.length === 8 && s.every(isAllowedScore)
    if (!ok(a.scores) || !ok(b.scores)) throw new Error(`卷 ${label} 的分数格式不对（要 8 个，每个是 ${ALLOWED_SCORES.join('/')}）`)
    // 都是 0.5 的倍数，加起来是精确的；absDiff：逐题分差的绝对值加起来（半分的分歧也看得出）
    const ta = a.scores.reduce((x, y) => x + y, 0)
    const tb = b.scores.reduce((x, y) => x + y, 0)
    out.push({ id, totalA: ta, totalB: tb, mean: (ta + tb) / 2, disagreements: a.scores.filter((s, i) => s !== b.scores[i]).length, absDiff: a.scores.reduce((x, s, i) => x + Math.abs(s - b.scores[i]), 0), unsupportedA: (a.unsupported ?? []).length, unsupportedB: (b.unsupported ?? []).length })
  }
  return { ...REGRESSION_TAG, max: 16, sheets: out }
}

/**
 * 「数关键词」版漏斗（真数据臂只能做这种，eval.md 5.4 最后一句）：
 * keywords：{ "1": ["…", …], … }（每题几个关键词；由跑实验的人写在实验目录里，不进工作区）。
 * → 每题：首轮 wire 里出现几次（按段分）、她调了哪些工具、工具结果里出现几次、答复里出现几次。只出计数。
 */
export function keywordFunnel ({ firstWire, toolCalls, answer, keywords }) {
  const rows = []
  for (const [qid, kws] of Object.entries(keywords)) {
    const bySeg = {}
    for (const s of segments(firstWire)) {
      if (s.kind === 'tools') continue
      const n = kws.reduce((a, k) => a + countMarker(s.text, k), 0)
      if (n) bySeg[s.kind] = (bySeg[s.kind] ?? 0) + n
    }
    const inResults = (toolCalls ?? []).reduce((a, c) => a + kws.reduce((x, k) => x + countMarker(String(c?.resultText ?? ''), k), 0), 0)
    rows.push({ q: qid, firstWire: bySeg, tools: [...new Set((toolCalls ?? []).map((c) => String(c?.name)))].sort(), inResults, inAnswer: kws.reduce((a, k) => a + countMarker(answer ?? '', k), 0) })
  }
  return { ...REGRESSION_TAG, rows }
}

export function keywordsFile (dir) {
  const p = join(dir, 'keywords-regression.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
