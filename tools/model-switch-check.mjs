// 切模型之前跑（只读）：
//   node tools/model-switch-check.mjs <provider/model> [--hc] [--json] [--allow-no-usage]
//   node tools/model-switch-check.mjs --all [--hc] [--json] [--allow-no-usage]
//   node tools/model-switch-check.mjs --gate <步名> [--json]          （上线脚本用：她现在这个模型过不过这一步，= models-lib 的 gateForStep）
// 「她」是陪伴体的会话。报三样（算法和出处在 tools/models-lib.mjs 开头）：
//   1. 在那条线上宿主会永久摘掉几张她的图（DSH 的 image/offload，删不回来）——已经在那个模型上、或 DSH 里已经选了还没发，也照报；
//   2. 那边的判窗：window 模式、input 模式两种都报，标明哪种在生效；有墙（vLLM）的另报墙；
//   3. 她最近的真用量（代理日志里她会话最后一条 [acp-usage]）占判窗几成。
// 退出码（同时有几样时取 models-lib PROBLEM_ORDER 里排得最前的；脚本请读 --json 的 problems[].code，不要只看退出码）：
//   0 能用；
//   4 不在核准表 / 没批给她（NOT_APPROVED，排第一）；--gate 时这一步没在这个模型上演练过（NOT_REHEARSED）也是 4；
//   5 那边发不出去（宿主条目没有 image 输入而历史里有图块，每一步 UNSUPPORTED_CONTENT）；
//   1 图的事：会永久丢图（DROPS_IMAGES），或者上限 < 留着的图 + imageMargin（IMAGE_MARGIN）；
//   6 切回 DeepSeek 那条线会暴涨、第二份请求按过期读数紧急截断上锁（SURGE_BACK；核准表 surgeGuard.r4Live 为 true 时降成警告）；
//   3 用量的事：真用量到了截断线（判窗 × 0.95）或墙（OVER_WINDOW），或者 ≥ usageShareMax × 判窗（USAGE_HIGH）；
//   7 读不到她的真用量（USAGE_UNKNOWN）；--allow-no-usage 把它降成警告，只给人看，上线脚本不许用（--gate 不收这个开关）；
//   2 参数不对、读不到、步名不认得。
// --all：核准表里每个模型都报一遍；总退出码只算 approvedForHer 的那几个，没批的单列、不算进去。
// 读的东西（全部只读）：核准表（--models，缺省见 models-lib 的 MODELS_JSON）；DSH 的 profiles/desktop/cordis.patch.yml
//   （只取白名单里的键，不打印地址和密钥）；billion-context 的配置；dsh-fish 的 home.json（取会话 id）；她的会话日志和代理日志 ——
//   这两样先拷进本工具专用的临时目录（tools/scratch-guard.mjs 认的、名字以 model-switch-check- 开头），只读拷贝，跑完删掉。
//   不打开任何 SQLite。
// 缺省位置：DSH 目录 = 环境变量 DSH_HOME，没设就是 ~/.dsh；dsh-fish 目录 = DSH_FISH_HOME，没设就是 ~/.dsh-fish；
//   billion-context 配置 = ~/.config/billion-context/billion-context.json；代理日志在 $XDG_STATE_HOME/billion-context（没设就是
//   ~/.local/state/billion-context）。
// 换输入（测试、在拷贝上跑）：--models <json> --cordis <yml> --bc-config <json> --session-log <拷贝> --proxy-log <拷贝> --sid <会话 id> --usage <数>
//   给了 --session-log / --proxy-log 就直接读给的文件（调用方保证是拷贝），不再去拷线上的。
// --hc：假定核准表里写的图片档（每个模型 images.planned）已经写进 cordis.patch.yml，看那时候切过去会怎样（--gate 不收）。
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimScratchDir, releaseScratchDir } from './scratch-guard.mjs'
import { EXIT, MODELS_JSON, checkSwitch, exitFor, gateForStep, lastUsage, loadModels, parseCordis, parseSessionLog } from './models-lib.mjs'

const argv = process.argv.slice(2)
const flags = new Set(); const opts = {}; const pos = []
const BOOL = new Set(['--json', '--hc', '--all', '--allow-no-usage'])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (BOOL.has(a)) flags.add(a.slice(2))
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i]
  else pos.push(a)
}
const fail = (msg) => { console.error('model-switch-check: ' + msg); process.exit(EXIT.BAD_ARGS) }
const gateStep = opts.gate
if (gateStep !== undefined) {
  if (pos.length || flags.has('all') || flags.has('hc') || flags.has('allow-no-usage')) fail('--gate <步名> 不和目标、--all、--hc、--allow-no-usage 一起用')
  if (typeof gateStep !== 'string' || gateStep === '') fail('--gate 要一个步名')
} else if (!flags.has('all') && pos.length !== 1) fail('usage: model-switch-check.mjs <provider/model> [--hc] [--json] [--allow-no-usage] | --all | --gate <步名>')
else if (flags.has('all') && pos.length) fail('--all 不再带目标')

const home = homedir()
const DSH = process.env.DSH_HOME || join(home, '.dsh')
const FISH_HOME = process.env.DSH_FISH_HOME || join(home, '.dsh-fish')
const paths = {
  models: opts.models ?? MODELS_JSON,
  cordis: opts.cordis ?? join(DSH, 'profiles', 'desktop', 'cordis.patch.yml'),
  bcConfig: opts['bc-config'] ?? join(home, '.config', 'billion-context', 'billion-context.json'),
  homeJson: join(FISH_HOME, 'home.json'),
  bcState: join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'billion-context'),
}
let table, cordis, bcConfig, sid
try {
  table = loadModels(paths.models)
  cordis = parseCordis(readFileSync(paths.cordis, 'utf8'))
  bcConfig = existsSync(paths.bcConfig) ? JSON.parse(readFileSync(paths.bcConfig, 'utf8')) : {}
  sid = opts.sid ?? JSON.parse(readFileSync(paths.homeJson, 'utf8')).sessionId
} catch (e) { fail(`读不到输入：${e.code ?? ''} ${String(e.message).slice(0, 200)}`) }
if (!/^session-[0-9a-f-]{36}$/.test(String(sid))) fail('会话 id 不像 DSH 的')

// 会话日志、代理日志：没给就从线上拷进专用临时目录再读
let scratch = null
const liveSessionLog = () => {
  for (const d of readdirSync(join(DSH, 'sessions'), { withFileTypes: true })) {
    const f = join(DSH, 'sessions', d.name, sid, 'session.v4.jsonl.zstd')
    if (d.isDirectory() && existsSync(f)) return f
  }
  return null
}
const copyIn = (src, name) => {
  scratch ??= claimScratchDir(join(tmpdir(), `model-switch-check-${process.pid}`), { prefix: 'model-switch-check-', keep: [process.cwd()], what: '拷贝目录' })
  const dst = join(scratch, name)
  copyFileSync(src, dst)
  return dst
}
let events, logText = ''
try {
  const sl = opts['session-log'] ?? (() => { const f = liveSessionLog(); if (!f) throw new Error('找不到她的会话日志'); return copyIn(f, 'session.v4.jsonl.zstd') })()
  events = parseSessionLog(readFileSync(sl))
  if (opts['proxy-log']) logText = readFileSync(opts['proxy-log'], 'utf8')
  else {
    for (const n of ['bili.log.old', 'bili.log']) { const f = join(paths.bcState, n); if (existsSync(f)) logText += readFileSync(copyIn(f, n), 'utf8') + '\n' }
  }
} catch (e) { if (scratch) releaseScratchDir(scratch); fail(`读日志失败：${String(e.message).slice(0, 200)}`) }
if (scratch) releaseScratchDir(scratch)
if (events.length === 0) fail('会话日志是空的')
let usage = lastUsage(logText, sid)
if (opts.usage !== undefined) { const n = Number(opts.usage); if (opts.usage === '' || !(n >= 0)) fail('--usage 要是数'); usage = { at: 'override', input: n, cached: null } }

const n = (x) => (x === null || x === undefined ? '-' : Number(x).toLocaleString('en-US'))
const pct = (x) => (x === null || x === undefined ? '-' : (x * 100).toFixed(1) + '%')
const defaultModel = cordis.defaultModel ? `${cordis.defaultModel.provider}/${cordis.defaultModel.model}` : null

// ---- --gate ----
if (gateStep !== undefined) {
  let g
  try { g = gateForStep({ table, cordis, events, bcConfig, sid, usage, step: gateStep }) } catch (e) { fail(e.code === 'SURFACE_MISMATCH' ? '会话日志的 surface 认不出：' + e.message : String(e.message).slice(0, 200)) }
  if (flags.has('json')) console.log(JSON.stringify({ gate: gateStep, ok: g.ok, current: g.current, problems: g.problems, warnings: g.warnings, exit: g.exit, report: g.report ?? null }, null, 1))
  else {
    const c = g.current
    console.log(`步：${gateStep}；她现在：${c ? c.id + (c.reasoningEffort ? ' · ' + c.reasoningEffort : '') + (c.pending ? '（选了、还没发过请求）' : '') : '-'}；真用量：${usage ? n(usage.input) + '（' + usage.at + '）' : '没读到'}`)
    for (const p of g.problems) console.log(`  不行[${p.code}]：${p.text}`)
    for (const w of g.warnings) console.log(`  注意：${w}`)
    console.log(`  → ${g.ok ? '过' : '不过'}，退出码 ${g.exit}`)
  }
  process.exit(g.exit)
}

// ---- 目标 / --all ----
const targets = flags.has('all') ? table.models.map((m) => m.id) : pos
let reports
try {
  reports = targets.map((target) => checkSwitch({ table, cordis, events, bcConfig, sid, usage, target, hc: flags.has('hc'), allowNoUsage: flags.has('allow-no-usage') }))
} catch (e) { fail(e.code === 'SURFACE_MISMATCH' ? '会话日志的 surface 认不出：' + e.message : String(e.message).slice(0, 200)) }
// --all：只算批给她的；单个目标：照算（没批就是 4）
for (const r of reports) r.counted = !flags.has('all') || r.approvedForHer === true
const exit = exitFor(reports.filter((r) => r.counted).flatMap((r) => r.problems))

if (flags.has('json')) {
  console.log(JSON.stringify({ hc: flags.has('hc'), allowNoUsage: flags.has('allow-no-usage'), defaultModel, reports, exit }, null, 1))
} else {
  const cur = reports[0]?.current
  console.log(`她现在：${cur ? cur.id + (cur.reasoningEffort ? ' · ' + cur.reasoningEffort : '') + (cur.pending ? '（选了、还没发过请求）' : '') : '-'}${cur?.lastUsedId && cur.lastUsedId !== cur.id ? `（最后一份请求走的是 ${cur.lastUsedId}）` : ''}；全局默认：${defaultModel ?? '-'}${flags.has('hc') ? '；按 HC 已生效算' : ''}`)
  console.log(`真用量：${usage ? n(usage.input) + '（' + usage.at + '）' : '没读到'}`)
  const show = (r) => {
    const i = r.images; const j = r.judge
    console.log(`\n== ${r.target}${r.same ? '（就是现在这个）' : ''}  核准表：${r.inTable ? (r.approvedForHer ? '批了' : '在表里、没批') : '不在表里'}`)
    console.log(`  图：日志里一共 ${i.total} 张，摘过 ${i.offloaded}（${i.offloadEvents} 次），留着 ${i.retained}；那边上限 ${i.route.cap}、一档 ${i.route.quantum}、整份 ${n(i.route.maxBytes)} 字节${i.route.imageInput ? '' : '、条目没有 image 输入'}${i.route.serverMax ? `、服务端每份 ${i.route.serverMax} 张` : ''}；余量要求 ${i.margin} 张`)
    console.log(`     ${r.same ? '在这条线上下一份请求' : '切过去'}宿主永久摘掉：${i.unsupported ? '不摘（每一步直接报错）' : i.wouldOffload + ' 张'}（按张数 ${i.byCount}、按字节 ${i.byBytes}；留着的图按这条线估 ${n(i.bytesEst)} 字节）`)
    console.log(`  判窗：现在生效的是 ${j.inEffect} 模式 → ${n(j.judge)}`)
    console.log(`     window：W_eff ${n(j.window.wEff)}（${j.window.source}）− 预留 ${n(j.window.reserve)}${j.window.exempt ? '（anthropic 输出另算，不扣）' : ''} = ${n(j.window.judge)}${j.inEffect === 'window' ? '  ←生效' : ''}`)
    console.log(`     input：${n(j.input)}${j.inEffect === 'input' ? '  ←生效' : '（要她条目 limitMode:"input" 和 compress.modelWindows 这一行）'}；原生 ${n(j.native)}、max_tokens ${n(j.maxOutput)}${j.wall !== null ? `；墙 ${n(j.wall)}` : ''}`)
    if (r.usage) console.log(`  真用量占判窗：${pct(r.usage.share)}（window ${pct(r.usage.shareWindow)}，input ${pct(r.usage.shareInput)}；要 < ${pct(j.usageShareMax)}）`)
    for (const p of r.problems) console.log(`  不行[${p.code}]：${p.text}`)
    for (const w of r.warnings) console.log(`  注意：${w}`)
    console.log(`  → 退出码 ${r.exit}${r.counted ? '' : '（没批给她，不算进总退出码）'}`)
  }
  for (const r of reports.filter((x) => x.counted)) show(r)
  const others = reports.filter((x) => !x.counted)
  if (others.length) { console.log('\n---- 没批给她的（单列，不算进总退出码）----'); for (const r of others) show(r) }
  if (reports.length > 1) console.log(`\n总退出码 ${exit}（只算批给她的 ${reports.filter((x) => x.counted).length} 个）`)
}
process.exit(exit)
