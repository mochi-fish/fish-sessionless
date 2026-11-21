// tools/models-lib.mjs 和 tools/model-switch-check.mjs 的测试。夹具全是这里现造的（假会话、假配置、假代理日志），
// 核准表用 tools/models.example.json。不读本机 DSH、dsh-fish、billion-context 的任何东西：命令行一律给全输入，
// DSH_HOME、DSH_FISH_HOME、XDG_STATE_HOME 指到临时目录里不存在的地方。
// 用法：node tools/test/test-models.mjs        （要能 import js-yaml：装了 tools/package.json 的依赖，或者设 FISH_TOOLS_JS_YAML）
// 打 PASS / FAIL 行，有失败退出码 1。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import * as L from '../models-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const CLI = join(TOOLS, 'model-switch-check.mjs')
const EXAMPLE = join(TOOLS, 'models.example.json')
const SID = 'session-00000000-0000-4000-8000-000000000001'
const TMP = fs.mkdtempSync(join(tmpdir(), 'models-test-'))

let pass = 0; let fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + String(e.message).split('\n')[0].slice(0, 300)) } }

// ---- 夹具 ----
const FLASH = 'deepseek-account/deepseek-flash'
const OPUS = 'anthropic/claude-opus-5-5'
const GEMINI = 'google/gemini-4-argon'
const VLLM = 'local-vllm/Qwen3-32B'
const FAKE_KEY = 'sk-fake-0000000000000000'
const FAKE_URL = 'http://192.0.2.10:8000/v1'
const cordisText = (o = {}) => `# 测试夹具：现造的，密钥、地址都是假的
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
- id: some-im
  name: some-im-plugin
  config:
    accessToken: FAKE-TOKEN-NOT-REAL
- insert:
    - id: local-thing
      name: ./fake/local-thing.mjs
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      anthropic:
        apiKey: ${FAKE_KEY}
${o.hc ? '        maxRequestImages: 300\n        imageOffloadCountQuantum: 10\n        maxRequestImageBytes: 100663296\n        requestImagePixelBudget: 2359296\n' : ''}        models:
          - { id: claude-opus-5-5, name: Opus 5.5, contextWindow: 1000000, maxTokens: 128000, input: [text, image] }
      google:
        apiKey: ${FAKE_KEY}
        hook: !!js "process.env.FAKE_SECRET"
        models:
          - { id: gemini-4-argon, name: Gemini 4 Argon, contextWindow: 1048576, maxTokens: 32768, input: [text, image] }
      local-vllm:
        api: openai-completions
        baseURL: ${FAKE_URL}
        apiKey: ${FAKE_KEY}
        models:
          - { id: Qwen3-32B, name: Qwen3 32B, contextWindow: 131072, maxTokens: 16384${o.vllmImages ? ', input: [text, image]' : ''} }
- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'
  config:
    token: ${FAKE_KEY}
`
const table = L.loadModels(EXAMPLE)
const cordisNow = L.parseCordis(cordisText())
const cordisHc = L.parseCordis(cordisText({ hc: true }))
const bcW = { compress: { sessions: { [SID]: { modelContextLimit: 256000 } } } }

// 会话事件：n 张图分在几条消息里，每张 300 KB、1600×1200
let seq = 0
const T0 = Date.parse('2026-01-01T00:00:00Z')
const ev = (type, data, extra = {}) => ({ type, seq: ++seq, time: T0 + seq * 1000, data, ...extra })
const img = () => ({ type: 'image', attachment: { bytes: 300 * 1024, width: 1600, height: 1200 } })
const userMsg = (k, extra) => ev('user/message', { content: [{ type: 'text', text: '（假的消息）' }, ...Array.from({ length: k }, img)] }, extra)
const toolRes = (k, extra) => ev('tool/result', { message: { content: Array.from({ length: k }, img) } }, extra)
const hdr = (id, effort) => { const [provider, model] = id.split('/'); return ev('request/header', { header: { config: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }, adapterDefaults: {} } }) }
const sel = (id, effort) => { const [provider, model] = id.split('/'); return ev('model/selection', { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }) }
/** 她在 cur 上，留着 n 张图（每条消息 5 张，零头放最后一条） */
const world = (n, cur = FLASH, opts = {}) => {
  seq = 0
  const out = [hdr(FLASH, 'max')]
  let left = n
  while (left > 0) { const k = Math.min(5, left); out.push(left % 2 ? userMsg(k) : toolRes(k)); left -= k }
  if (cur !== FLASH) out.push(hdr(cur))
  if (opts.pending) out.push(sel(opts.pending))
  return out
}
const USAGE = { input: 120000 }
const sw = (target, o = {}) => L.checkSwitch({ table: o.table ?? table, cordis: o.cordis ?? cordisNow, events: o.events ?? world(40), bcConfig: o.bc ?? bcW, sid: SID, usage: 'usage' in o ? o.usage : USAGE, target, hc: o.hc ?? false, allowNoUsage: o.allowNoUsage ?? false })
const codes = (r) => r.problems.map((p) => p.code)

// ---- a：核准表 ----
t('a1 示例核准表能读、过校验；四个模型，vLLM 那条没批', () => {
  assert.deepEqual(table.models.map((m) => [m.id, m.approvedForHer]), [[FLASH, true], [OPUS, true], [GEMINI, true], [VLLM, false]])
})
t('a2 validateModels 挡坏表（重复 id、rehearsedFor 写了不认的步、没有 steps、modelSpecificSteps 不在 steps 里、没有 surgeGuard、usageShareMax 越界）', () => {
  const clone = () => JSON.parse(JSON.stringify(table))
  const bads = [
    (x) => { x.models.push(x.models[0]) },
    (x) => { x.models[1].rehearsedFor = ['bridge-swap'] },
    (x) => { x.steps = [] },
    (x) => { x.modelSpecificSteps = ['nope'] },
    (x) => { delete x.surgeGuard },
    (x) => { x.usageShareMax = 0.96 },
    (x) => { x.models[0].id = 'no-slash' },
  ]
  for (const b of bads) { const x = clone(); b(x); assert.throws(() => L.validateModels(x), (e) => e.code === 'BAD_TABLE') }
})
t('a3 stepAllowedFor：image-fold 只放 Flash；跟模型无关的步放批了的三个；没批的、表外的不放；步名大小写照写', () => {
  assert.equal(L.stepAllowedFor(table, FLASH, 'image-fold').ok, true)
  assert.equal(L.stepAllowedFor(table, GEMINI, 'image-fold').code, 'NOT_REHEARSED')
  for (const id of [FLASH, OPUS, GEMINI]) assert.equal(L.stepAllowedFor(table, id, 'bridge-swap').ok, true)
  assert.equal(L.stepAllowedFor(table, VLLM, 'bridge-swap').code, 'NOT_APPROVED')
  assert.equal(L.stepAllowedFor(table, 'deepseek-account/other', 'bridge-swap').code, 'NOT_APPROVED')
  assert.equal(L.stepAllowedFor(table, FLASH, 'Bridge-Swap').code, 'BAD_ARGS')
})

// ---- b：cordis ----
t('b1 parseCordis 只取白名单：不带出密钥、地址、!!js；insert、别的插件不看', () => {
  const s = JSON.stringify(cordisNow)
  for (const x of [FAKE_KEY, FAKE_URL, 'FAKE-TOKEN', 'FAKE_SECRET', 'local-thing']) assert.ok(!s.includes(x), x)
  assert.deepEqual(Object.keys(cordisNow.piProviders).sort(), ['anthropic', 'google', 'local-vllm'])
  assert.equal(cordisNow.defaultModel.model, 'deepseek-flash')
  assert.equal(cordisNow.piProviders['local-vllm'].api, 'openai-completions')
})

// ---- c：摘图的数法 ----
t('c1 offloadedImagePrefixCount 照 DSH：52 张、上限 50、一档 10 → 10；上限 300 → 0；600 / 20 → 0', () => {
  const l = Array(52).fill(1000)
  assert.equal(L.offloadedImagePrefixCount(l, { maxImages: 50, countQuantum: 10 }), 10)
  assert.equal(L.offloadedImagePrefixCount(l, { maxImages: 300, countQuantum: 10 }), 0)
  assert.equal(L.offloadedImagePrefixCount(l, { maxImages: 600, countQuantum: 20 }), 0)
  assert.equal(L.offloadedImagePrefixCount(Array(61).fill(1), { maxImages: 50, countQuantum: 10 }), 20)
})
t('c2 按字节：量子 1 时摘够为止；大量子时要摘过量子', () => {
  assert.equal(L.offloadedImagePrefixCount([10, 10, 10, 10], { maxBytes: 25, byteQuantum: 1 }), 2)
  assert.equal(L.offloadedImagePrefixCount([10, 10, 10, 10], { maxBytes: 35, byteQuantum: 20 }), 3)
})
t('c3 requestImageDimensions：缩完不超像素预算、比例近似不变；小图不动', () => {
  const d = L.requestImageDimensions(4000, 3000, 1024 * 1024)
  assert.ok(d.width * d.height <= 1024 * 1024)
  assert.ok(Math.abs(d.width / d.height - 4 / 3) < 0.01)
  assert.deepEqual(L.requestImageDimensions(800, 600, 1024 * 1024), { width: 800, height: 600 })
})
t('c4 herImages：数留着的、摘过的；image/offload 记录和块上的 offloaded 都认', () => {
  const e = world(12)
  e.push(ev('image/offload', { targets: [{ seq: e[1].seq, imageIndexes: [0, 1] }] }))
  e[2].data.content[1].offloaded = true
  const h = L.herImages(e)
  assert.equal(h.total, 12); assert.equal(h.offloaded, 3); assert.equal(h.retained.length, 9); assert.equal(h.offloadEvents, 1)
})
t('c5 surface：被 replace 换掉的消息里的图不算；replace 指错了抛 SURFACE_MISMATCH；没有 surfaceOp 全算', () => {
  seq = 0
  const a = userMsg(3, { surfaceOp: 'append' }); const b = toolRes(4, { surfaceOp: 'append' }); const c = userMsg(2, { surfaceOp: 'append' })
  const r = ev('user/message', { content: [{ type: 'text', text: '（摘要）' }] }, { surfaceOp: { op: 'replace', startSeq: a.seq, endSeq: b.seq } })
  const h = L.herImages([a, b, c, r])
  assert.equal(h.total, 2); assert.equal(h.surfaceNodes, 2)
  const bad = ev('user/message', { content: [] }, { surfaceOp: { op: 'replace', startSeq: 999, endSeq: 999 } })
  assert.throws(() => L.herImages([a, bad]), (e) => e.code === 'SURFACE_MISMATCH')
  assert.equal(L.herImages(world(7)).surfaceNodes, null)
})

// ---- d：路线和判窗 ----
t('d1 routeFor：Flash 600/20、Opus 现在 50/10（HC 以后 300）、Gemini 50/10、vLLM 只认文字', () => {
  const f = L.routeFor(table, cordisNow, FLASH); assert.deepEqual([f.cap, f.quantum, f.representation], [600, 20, 'files'])
  const o = L.routeFor(table, cordisNow, OPUS); assert.deepEqual([o.cap, o.quantum, o.imageInput], [50, 10, true])
  assert.equal(L.routeFor(table, cordisHc, OPUS).cap, 300)
  assert.equal(L.routeFor(table, cordisNow, OPUS, { hc: true }).cap, 300)
  const g = L.routeFor(table, cordisNow, GEMINI); assert.deepEqual([g.cap, g.native, g.maxOutput, g.protocol], [50, 1048576, 32768, 'google'])
  const v = L.routeFor(table, cordisNow, VLLM); assert.deepEqual([v.imageInput, v.protocol, v.serverMaxModelLen], [false, 'openai', 131072])
  assert.ok(v.notes.some((n) => /没写 input/.test(n)))
})
t('d2 window 判窗：会话 256,000 时 Opus 不扣（anthropic 输出另算）、Gemini 扣 32,768、Flash 不扣（max_tokens 不小于窗口）', () => {
  const j = (id) => L.judgeWindowNow(L.routeFor(table, cordisNow, id), bcW.compress.sessions[SID]).judge
  assert.equal(j(OPUS), 256000); assert.equal(j(GEMINI), 256000 - 32768); assert.equal(j(FLASH), 256000)
})
t('d3 会话上限：绝对数不和原生窗口取小；"50%" 按原生折；写坏了 = 原生；没会话上限时看全局', () => {
  const g = L.routeFor(table, cordisNow, GEMINI)
  assert.equal(L.judgeWindowNow(g, { modelContextLimit: 2000000 }).wEff, 2000000)
  assert.equal(L.judgeWindowNow(g, { modelContextLimit: '50%' }).wEff, 524288)
  assert.equal(L.judgeWindowNow(g, { modelContextLimit: 'abc' }).wEff, 1048576)
  const w = L.judgeWindowNow(g, {}, 0.25, 300000); assert.equal(w.wEff, 300000); assert.equal(w.source, 'global')
})
t('d4 input 判窗：1M 级的 256,000；vLLM 是 ⌊131072 × 0.85⌋ − 16384；墙是 131072 − 16384', () => {
  assert.equal(L.judgeBaseInput(L.routeFor(table, cordisNow, GEMINI), 256000), 256000)
  const v = L.routeFor(table, cordisNow, VLLM)
  assert.equal(L.judgeBaseInput(v, 256000), Math.floor(131072 * 0.85) - 16384)
  assert.equal(L.wallFor(v), 131072 - 16384)
})
t('d5 哪种判窗生效：limitMode input + modelWindows 有这一行才是 input', () => {
  assert.equal(L.limitModeInEffect(bcW, SID, GEMINI), 'window')
  assert.equal(L.limitModeInEffect({ compress: { sessions: { [SID]: { limitMode: 'input' } } } }, SID, GEMINI), 'window')
  assert.equal(L.limitModeInEffect({ compress: { sessions: { [SID]: { limitMode: 'input' } }, modelWindows: { 'gemini-4-argon': {} } } }, SID, GEMINI), 'input')
})
t('d6 lastUsage：只认这个会话的最后一条', () => {
  const log = [
    `2026-01-01T00:00:01.000 [x] [sess=${SID}] [acp-usage] input=100 cached=50`,
    '2026-01-01T00:00:02.000 [x] [sess=session-00000000-0000-4000-8000-000000000002] [acp-usage] input=999',
    `2026-01-01T00:00:03.000 [x] [sess=${SID}] [acp-usage] input=120000`,
    '2026-01-01T00:00:04.000 [x] [sess=session-00000000-0000-4000-8000-000000000002] [acp-usage] input=7',
  ].join('\n')
  assert.deepEqual(L.lastUsage(log, SID), { at: '2026-01-01T00:00:03.000', input: 120000, cached: null })
  assert.equal(L.lastUsage('', SID), null)
})

// ---- e：checkSwitch / gateForStep ----
t('e1 她在 Flash、留 40 张：问 Flash → 0；问 Opus / Gemini（上限 50）→ IMAGE_MARGIN 退 1', () => {
  assert.equal(sw(FLASH).exit, 0)
  for (const id of [OPUS, GEMINI]) { const r = sw(id); assert.deepEqual(codes(r), ['IMAGE_MARGIN']); assert.equal(r.exit, 1) }
})
t('e2 留 52 张：问 Gemini → DROPS_IMAGES 摘 10 张；HC 以后（上限 300）→ 0', () => {
  const r = sw(GEMINI, { events: world(52) }); assert.deepEqual(codes(r), ['DROPS_IMAGES']); assert.equal(r.images.wouldOffload, 10)
  assert.equal(sw(OPUS, { events: world(52), cordis: cordisHc }).exit, 0)
})
t('e3 已经在 Gemini 上（最后一份请求是 Gemini）留 52 张：问 Gemini → 1、same', () => {
  const r = sw(GEMINI, { events: world(52, GEMINI) }); assert.equal(r.exit, 1); assert.equal(r.same, true)
})
t('e4 DSH 里已经选了 Gemini 还没发：当前是 Gemini（pending），问它照样报摘图', () => {
  const e = world(52, FLASH, { pending: GEMINI })
  const cur = L.currentModel(e); assert.deepEqual([cur.id, cur.pending, cur.lastUsedId], [GEMINI, true, FLASH])
  assert.deepEqual(codes(sw(GEMINI, { events: e })), ['DROPS_IMAGES'])
})
t('e5 vLLM：没批排第一（退 4），同时报发不出去（CANNOT_SEND）；没批的话退出码不会是 5', () => {
  const r = sw(VLLM); assert.equal(r.exit, 4); assert.ok(codes(r).includes('NOT_APPROVED') && codes(r).includes('CANNOT_SEND'))
  assert.equal(L.PROBLEM_ORDER[1], 'NOT_APPROVED')
})
t('e6 留着 0 张、摘过 1 张，没有 image 输入的那条线照样发不出去', () => {
  const e = world(1); e.push(ev('image/offload', { targets: [{ seq: e[1].seq, imageIndexes: [0] }] }))
  const cordis = cordisNow
  const t2 = JSON.parse(JSON.stringify(table)); t2.models[3].approvedForHer = true
  const r = sw(VLLM, { events: e, table: t2, cordis }); assert.ok(codes(r).includes('CANNOT_SEND')); assert.equal(r.exit, 5)
})
t('e7 表外的模型 → NOT_APPROVED 退 4', () => {
  const r = sw('deepseek-account/other'); assert.equal(r.exit, 4); assert.equal(r.inTable, false)
})
t('e8 真用量：Flash 判窗 256,000 时 204,799 → 0、204,800 → USAGE_HIGH、243,200 → OVER_WINDOW；vLLM 撞墙也算 OVER_WINDOW', () => {
  assert.equal(sw(FLASH, { usage: { input: 204799 } }).exit, 0)
  assert.deepEqual(codes(sw(FLASH, { usage: { input: 204800 } })), ['USAGE_HIGH'])
  assert.deepEqual(codes(sw(FLASH, { usage: { input: 243200 } })), ['OVER_WINDOW'])
  const t2 = JSON.parse(JSON.stringify(table)); t2.models[3].approvedForHer = true
  const r = sw(VLLM, { table: t2, events: [hdr(FLASH)], usage: { input: 131072 - 16384 }, bc: {} })
  assert.ok(codes(r).includes('OVER_WINDOW'), JSON.stringify(codes(r)))
})
t('e9 读不到真用量 → USAGE_UNKNOWN 退 7；allowNoUsage 只降成警告', () => {
  const r = sw(FLASH, { usage: null }); assert.deepEqual(codes(r), ['USAGE_UNKNOWN']); assert.equal(r.exit, 7)
  const w = sw(FLASH, { usage: null, allowNoUsage: true }); assert.equal(w.exit, 0); assert.ok(w.warnings.some((x) => /allow-no-usage/.test(x)))
})
t('e10 切回 DeepSeek：最后一份是 Gemini、问 Flash → SURGE_BACK 退 6；r4Live true 时只警告', () => {
  const e = world(10, GEMINI)
  const r = sw(FLASH, { events: e }); assert.deepEqual(codes(r), ['SURGE_BACK']); assert.equal(r.exit, 6)
  const t2 = JSON.parse(JSON.stringify(table)); t2.surgeGuard.r4Live = true
  const w = sw(FLASH, { events: e, table: t2 }); assert.equal(w.exit, 0); assert.ok(w.warnings.some((x) => /r4Live/.test(x)))
  assert.equal(sw(FLASH, { events: world(10, FLASH, { pending: FLASH }) }).surge, false)
})
t('e11 gateForStep：不认得的步名、三参数写法 → BAD_ARGS；image-fold 在 Gemini 上 → NOT_REHEARSED；Flash 干净 → 过', () => {
  const base = { table, cordis: cordisNow, bcConfig: bcW, sid: SID, usage: USAGE }
  assert.equal(L.gateForStep({ ...base, events: world(10), step: 'image-Fold' }).problems[0].code, 'BAD_ARGS')
  assert.equal(L.gateForStep(table, FLASH, 'bridge-swap').exit, 2)
  assert.ok(L.gateForStep({ ...base, events: world(10, GEMINI), step: 'image-fold' }).problems.some((p) => p.code === 'NOT_REHEARSED'))
  const ok = L.gateForStep({ ...base, events: world(10), step: 'image-fold' }); assert.equal(ok.ok, true, ok.why)
  const g = L.gateForStep({ ...base, events: world(52, GEMINI), step: 'bridge-swap' }); assert.equal(g.ok, false); assert.equal(g.exit, 1)
})

// ---- f：命令行 ----
const files = {}
const writeFixtures = () => {
  files.models = EXAMPLE
  files.cordis = join(TMP, 'cordis.patch.yml'); fs.writeFileSync(files.cordis, cordisText())
  files.cordisHc = join(TMP, 'cordis-hc.yml'); fs.writeFileSync(files.cordisHc, cordisText({ hc: true }))
  files.bc = join(TMP, 'bc.json'); fs.writeFileSync(files.bc, JSON.stringify(bcW))
  const sess = (events) => { const p = join(TMP, `s-${Math.random().toString(16).slice(2)}.v4.jsonl.zstd`); const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n'; const half = Math.floor(text.length / 2); fs.writeFileSync(p, Buffer.concat([zlib.zstdCompressSync(Buffer.from(text.slice(0, half))), zlib.zstdCompressSync(Buffer.from(text.slice(half)))])); return p }
  files.s40 = sess(world(40)); files.s52gem = sess(world(52, GEMINI)); files.s10gem = sess(world(10, GEMINI))
  files.proxy = join(TMP, 'bili.log'); fs.writeFileSync(files.proxy, `2026-01-01T00:00:03.000 [x] [sess=${SID}] [acp-usage] input=120000 cached=1\n`)
  files.proxyEmpty = join(TMP, 'empty.log'); fs.writeFileSync(files.proxyEmpty, '')
}
writeFixtures()
const childEnv = { ...process.env, DSH_HOME: join(TMP, 'no-dsh'), DSH_FISH_HOME: join(TMP, 'no-fish'), XDG_STATE_HOME: join(TMP, 'no-state') }
delete childEnv.MODEL_SWITCH_MODELS
const run = (args, o = {}) => {
  const a = [CLI, ...args, '--models', files.models, '--cordis', o.cordis ?? files.cordis, '--bc-config', files.bc, '--session-log', o.sess ?? files.s40, '--proxy-log', o.proxy ?? files.proxy, '--sid', SID, '--json']
  const r = spawnSync(process.execPath, a, { encoding: 'utf8', env: childEnv, timeout: 60000 })
  let j = null; try { j = JSON.parse(r.stdout) } catch { /* */ }
  return { code: r.status, j, out: r.stdout + r.stderr }
}
t('f0 拼成两帧的 zstd 会话日志能解开', () => {
  assert.equal(L.parseSessionLog(fs.readFileSync(files.s40)).length, world(40).length)
})
t('f1 命令行：Flash → 0；Gemini → 1；--hc 以后 Gemini 照算（HC 计划值 300）', () => {
  const a = run([FLASH]); assert.equal(a.code, 0, a.out.slice(0, 300))
  assert.equal(run([GEMINI]).code, 1)
  assert.equal(run([GEMINI, '--hc']).code, 0)
})
t('f2 命令行：表外 → 4；没批的 vLLM → 4', () => {
  assert.equal(run(['deepseek-account/other']).code, 4)
  assert.equal(run([VLLM]).code, 4)
})
t('f3 命令行：--all 只算批给她的；vLLM 单列', () => {
  const r = run(['--all']); assert.equal(r.code, 1, r.out.slice(0, 600))
  assert.equal(r.j?.reports?.length, 4)
  assert.equal(run(['--all', '--hc']).code, 0)
})
t('f4 命令行：代理日志里没有用量 → 7；--allow-no-usage → 0；--usage 覆盖', () => {
  assert.equal(run([FLASH], { proxy: files.proxyEmpty }).code, 7)
  assert.equal(run([FLASH, '--allow-no-usage'], { proxy: files.proxyEmpty }).code, 0)
  assert.equal(run([FLASH, '--usage', '243200']).code, 3)
})
t('f5 命令行：切回 Flash 的暴涨 → 6', () => { assert.equal(run([FLASH], { sess: files.s10gem }).code, 6) })
t('f6 命令行：--gate image-fold 在 Flash 上 → 0；在 Gemini（52 张）上 → 4（没演练过排在摘图前面）；不认得的步名 → 2；--gate 带 --hc → 2', () => {
  assert.equal(run(['--gate', 'image-fold']).code, 0)
  assert.equal(run(['--gate', 'image-fold'], { sess: files.s52gem }).code, 4)
  assert.equal(run(['--gate', 'nope']).code, 2)
  assert.equal(run(['--gate', 'image-fold', '--hc']).code, 2)
})
t('f7 命令行：坏参数 → 2（没目标、目标带 --all、--usage 不是数、会话 id 不像）', () => {
  assert.equal(run([]).code, 2)
  assert.equal(run(['--all', FLASH]).code, 2)
  assert.equal(run([FLASH, '--usage', 'x']).code, 2)
  const r = spawnSync(process.execPath, [CLI, FLASH, '--models', files.models, '--cordis', files.cordis, '--bc-config', files.bc, '--session-log', files.s40, '--proxy-log', files.proxy, '--sid', 'nope'], { encoding: 'utf8', env: childEnv })
  assert.equal(r.status, 2)
})
t('f8 命令行输出里没有密钥、地址', () => {
  const r = run(['--all']); for (const x of [FAKE_KEY, FAKE_URL, 'FAKE-TOKEN']) assert.ok(!r.out.includes(x), x)
  const h = spawnSync(process.execPath, [CLI, '--all', '--models', files.models, '--cordis', files.cordis, '--bc-config', files.bc, '--session-log', files.s40, '--proxy-log', files.proxy, '--sid', SID], { encoding: 'utf8', env: childEnv })
  for (const x of [FAKE_KEY, FAKE_URL, 'FAKE-TOKEN']) assert.ok(!(h.stdout + h.stderr).includes(x), x)
  assert.ok(/←生效/.test(h.stdout))
})
t('f9 命令行：没给 --session-log 时只去 DSH_HOME 下面找，找不到就退 2（不碰别处）', () => {
  const r = spawnSync(process.execPath, [CLI, FLASH, '--models', files.models, '--cordis', files.cordis, '--bc-config', files.bc, '--proxy-log', files.proxy, '--sid', SID], { encoding: 'utf8', env: childEnv })
  assert.equal(r.status, 2)
})

// ---- g：补回来的几项（服务端每份图数、路线级缺省、modelOverrides、问题码的先后） ----
t('g1 HC 以后 Opus 上限 300：留 300 张不摘、301 张摘一档 10；核准表写了 serverMax 时，超过它报 serverOver（不摘）', () => {
  const r = L.routeFor(table, cordisHc, OPUS)
  const mk = (n) => Array.from({ length: n }, () => ({ bytes: 200000, width: 1080, height: 1920 }))
  assert.equal(L.offloadIfSwitched(mk(300), r).count, 0)
  assert.equal(L.offloadIfSwitched(mk(301), r).count, 10)
  assert.equal(L.offloadIfSwitched(mk(300), r).serverOver, false)
  const t2 = JSON.parse(JSON.stringify(table)); t2.models.find((m) => m.id === OPUS).images.serverMax = 128
  const r2 = L.routeFor(t2, cordisHc, OPUS); assert.equal(r2.serverMax, 128)
  assert.deepEqual([L.offloadIfSwitched(mk(128), r2).serverOver, L.offloadIfSwitched(mk(129), r2).serverOver, L.offloadIfSwitched(mk(300), r2).serverOver], [false, true, true])
  assert.equal(L.offloadIfSwitched(mk(300), r2).count, 0)
})
t('g2 路线级 defaultInput / defaultContextWindow / defaultMaxTokens：条目没写时用它；条目写了的胜过它', () => {
  const y = cordisText()
  const entryLine = '- { id: Qwen3-32B, name: Qwen3 32B, contextWindow: 131072, maxTokens: 16384 }'
  assert.ok(y.includes(entryLine))
  const viaDefaults = L.parseCordis(y.replace(entryLine, '- { id: Qwen3-32B, name: Qwen3 32B }')
    .replace('        api: openai-completions\n', '        api: openai-completions\n        defaultInput: [text, image]\n        defaultContextWindow: 262144\n        defaultMaxTokens: 32768\n'))
  const a = L.routeFor(table, viaDefaults, VLLM)
  assert.deepEqual([a.configured, a.imageInput, a.native, a.maxOutput], [true, true, 262144, 32768])
  assert.ok(a.notes.some((n) => /defaultInput/.test(n)))
  const both = L.parseCordis(y.replace('        api: openai-completions\n', '        api: openai-completions\n        defaultContextWindow: 100000\n        defaultMaxTokens: 9999\n'))
  const b = L.routeFor(table, both, VLLM); assert.deepEqual([b.native, b.maxOutput], [131072, 16384])
})
t('g3 没列 models 的目录路线走 modelOverrides；同一条路线 models 和 modelOverrides 都写 → configured false（宿主会拒）', () => {
  const head = ['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  config:', '    providers:', '      google:']
  const cat = L.parseCordis([...head, '        modelOverrides:', '          gemini-4-argon: { contextWindow: 500000, maxTokens: 16384 }'].join('\n'))
  const c = L.routeFor(table, cat, GEMINI); assert.deepEqual([c.configured, c.native, c.maxOutput, c.imageInput], [true, 500000, 16384, true])
  const clash = L.parseCordis([...head, '        models: [{ id: gemini-4-argon, input: [text, image] }]', '        modelOverrides:', '          gemini-4-argon: { contextWindow: 500000 }'].join('\n'))
  const d = L.routeFor(table, clash, GEMINI); assert.equal(d.configured, false); assert.ok(d.notes.some((n) => /modelOverrides/.test(n)))
})
t('g4 PROBLEM_ORDER 前三个是 BAD_ARGS、NOT_APPROVED、NOT_REHEARSED（脚本按它取退出码）', () => {
  assert.deepEqual(L.PROBLEM_ORDER.slice(0, 3), ['BAD_ARGS', 'NOT_APPROVED', 'NOT_REHEARSED'])
})

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* */ }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
