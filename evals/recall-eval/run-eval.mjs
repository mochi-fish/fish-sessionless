// 离线回忆评测：拿合成事件流和带答案的题，调 dsh-fish 的 searchEvents（her_recall 用的同一个函数、同一组参数），算 hit@8。
// 用法：node run-eval.mjs <dsh-fish 包目录（拆包的拷贝，不是装着的那份）> <临时目录> [--out <文件>]
//   临时目录只认专用的：在 TEMP 下面、名字以 recall-eval-home 开头、不存在或空或是上次留下的（里面有记号文件），
//   而且不和包目录、本脚本目录、当前目录重叠（tools/scratch-guard.mjs）。不满足就退出 2，什么都不删。
//   过了才清空它，当成假的 DSH_FISH_HOME；USERPROFILE / HOME 也指到它下面，dsh-fish 碰不到真的家目录。跑完删掉。
//   包目录、临时目录、--out 都先过 tools/scratch-guard.mjs 的两道路径守卫（字符串、realpath）：不许在 ~/.dsh、~/.dsh-fish 下面。
//
// 怎么调的：和 lib/recall.js registerRecall 的 execute 一样——readEvents(root) 读事件流，solidIdsOf(events, growthDays)，
// searchEvents(events, query, { days, kind, solidIds, snippet })，只多给一个固定的 now（题目文件里写的那一刻），让结果可复现。
// 命中：前 8 条（RECALL_LIMIT）里有一条的 id 在这道题的 targets 里，或者满足这道题 match 里的任何一个特征（字段全对上：
//   type、date、scene 比相等，textIncludes 看行文字里有没有）。日记题靠 match 认：以后日记接进 her_recall，翻出来的那一行
//   不会是事件流里 diary:<日期> 那条 meta 的 id。
// absent 的题（事件流里本来就没有答案）不进 total / totalExcludingHoles，只单列，拿来看 found 和 hit 的差别。
//
// 输出：每类题的 n、hit@8、hit@3、hit@1、MRR、found 比例（只是给人看「found 量不出东西」，不当尺子），
// ownVsHeard 另有 pairOk（答案排在混淆项前面的比例）；总的，和去掉 hole 题以后的总的；每道题的名次（0 = 没进前 8）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { claimScratchDir, forbiddenRoots, refuseByRealpath, refuseByString, releaseScratchDir } from '../../tools/scratch-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let out = null
const pos = []
for (let i = 0; i < args.length; i++) { if (args[i] === '--out') { out = args[++i]; continue } pos.push(args[i]) }
const [PKG, TMP] = pos
if (!PKG || !TMP) { console.error('用法：node run-eval.mjs <dsh-fish 包目录> <临时目录> [--out <文件>]'); process.exit(2) }
if (out === undefined || out === '') { console.error('--out 后面要给文件'); process.exit(2) }
let TMPDIR
try {
  const roots = forbiddenRoots()
  // 先把三样都按字符串查完（不碰盘），再碰盘
  refuseByString(PKG, roots, '包目录')
  refuseByString(TMP, roots, '临时目录')
  if (out) refuseByString(out, roots, '输出文件')
  refuseByRealpath(PKG, roots, '包目录')
  if (out) refuseByRealpath(out, roots, '输出文件')
  const o = out ? resolve(out).toLowerCase() : ''
  const t = resolve(TMP).toLowerCase()
  if (o && (o === t || o.startsWith(t + sep))) throw Object.assign(new Error('输出文件不能放在临时目录里（跑完会删掉）'), { code: 'REFUSE' })
  if (!existsSync(join(PKG, 'lib', 'recall.js'))) throw Object.assign(new Error('包目录里没有 lib/recall.js'), { code: 'REFUSE' })
  TMPDIR = claimScratchDir(TMP, { prefix: 'recall-eval-home', keep: [PKG, HERE, process.cwd()] })
} catch (e) {
  console.error(`run-eval：${e?.message ?? e}`)
  process.exit(e?.code === 'REFUSE' ? 2 : 1)
}

// 假家目录：事件流、日记都从 fixture 拷进去。环境变量要在 import dsh-fish 之前设好（rootDir() 每次现读 process.env）
const ROOT = join(TMPDIR, 'fish-home')
mkdirSync(join(TMPDIR, 'userhome'), { recursive: true })
cpSync(join(HERE, 'fixture'), ROOT, { recursive: true })
process.env.DSH_FISH_HOME = ROOT
process.env.DSH_FISH_LOCATION = join(TMPDIR, 'no-location.json')
process.env.USERPROFILE = join(TMPDIR, 'userhome')
process.env.HOME = join(TMPDIR, 'userhome')
// 时区固定成题目文件里写的那个（dsh-fish 按本地钟算日子和钟点）：结果和本机时区无关
process.env.TZ = String(JSON.parse(readFileSync(join(HERE, 'questions.json'), 'utf8')).tz || 'Asia/Shanghai')

const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const imp = (f) => import(pathToFileURL(join(PKG, 'lib', f)).href)
const { searchEvents, solidIdsOf, RECALL_LIMIT, RECALL_SNIPPET } = await imp('recall.js')
const { readEvents } = await imp('store.js')

const { now: nowIso, growthDays, questions } = JSON.parse(readFileSync(join(HERE, 'questions.json'), 'utf8'))
const now = Date.parse(nowIso)
const { events } = await readEvents(ROOT)
const solidIds = solidIdsOf(events, Number(growthDays ?? 30))

/** 一行是否满足一个特征：给了的字段全对上才算 */
function matches (row, m) {
  if (!m || typeof m !== 'object') return false
  const keys = Object.keys(m)
  if (!keys.length) return false
  for (const key of keys) {
    if (key === 'textIncludes') { if (!String(row.text ?? '').includes(String(m.textIncludes))) return false; continue }
    if (!['type', 'date', 'scene'].includes(key)) throw new Error(`题目的 match 里不认 ${key}`)
    if (String(row[key] ?? '') !== String(m[key])) return false
  }
  return true
}

const per = []
for (const q of questions) {
  const { rows } = searchEvents(events, q.query, { kind: q.kind, solidIds, snippet: RECALL_SNIPPET, now })
  const rankOf = (pred) => { const i = rows.findIndex(pred); return i < 0 ? 0 : i + 1 }
  const rank = rankOf((r) => (q.targets ?? []).includes(r.id) || (q.match ?? []).some((m) => matches(r, m)))
  const conf = q.confusers ? rankOf((r) => q.confusers.includes(r.id)) : null
  per.push({ id: q.id, category: q.category, hole: Boolean(q.hole), ...(q.absent ? { absent: true } : {}), rank, found: rows.length > 0 ? 1 : 0, ...(conf === null ? {} : { confuserRank: conf, pairOk: rank > 0 && (conf === 0 || rank < conf) ? 1 : 0 }) })
}

const r3 = (x) => Math.round(x * 1000) / 1000
const summary = (list) => {
  const n = list.length
  if (!n) return { n: 0 }
  const hit = (k) => r3(list.filter((p) => p.rank > 0 && p.rank <= k).length / n)
  const o = { n, hit8: hit(RECALL_LIMIT), hit3: hit(3), hit1: hit(1), mrr: r3(list.reduce((a, p) => a + (p.rank ? 1 / p.rank : 0), 0) / n), foundRate: r3(list.reduce((a, p) => a + p.found, 0) / n) }
  const pairs = list.filter((p) => 'pairOk' in p)
  if (pairs.length) o.pairOk = r3(pairs.reduce((a, p) => a + p.pairOk, 0) / pairs.length)
  return o
}
const cats = [...new Set(per.map((p) => p.category))]
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const result = {
  // recall.js 的 sha 一起记：以后比的时候先看题和检索代码各变没变
  fish: { name: pkg.name, version: pkg.version, recallJsSha256: sha(join(PKG, 'lib', 'recall.js')) },
  fixture: { events: events.length, questions: questions.length, now: nowIso, tz: process.env.TZ, growthDays, limit: RECALL_LIMIT,
    eventsSha256: sha(join(HERE, 'fixture', 'events.jsonl')), questionsSha256: sha(join(HERE, 'questions.json')) },
  categories: Object.fromEntries(cats.map((c) => [c, summary(per.filter((p) => p.category === c))])),
  // absent 的题（事件流里本来就没有）不进这两个总数
  total: summary(per.filter((p) => !p.absent)),
  totalExcludingHoles: summary(per.filter((p) => !p.hole && !p.absent)),
  perQuestion: per,
}
const text = JSON.stringify(result, null, 2) + '\n'
if (out) { writeFileSync(out, text); console.error(`写好了：${out}`) } else process.stdout.write(text)
releaseScratchDir(TMPDIR)
