// 切模型护栏的只读库。陪伴体（下面写「她」）的会话在 DSH 里跑、经 billion-context（或它的 fork）代理出去，
// 换模型之前用这里的函数算一算会出什么事。
// 只算、不写：调用方把文件读进来（会话日志要先拷出来再读，见 model-switch-check.mjs），这里的函数只吃解析好的东西。
//
// 算三样：
//   1. 她在 DSH 那边还留着几张图（retained），在某条路线上宿主会按那条路线的上限永久摘掉几张（image/offload，删不回来）；
//      照 DSH 0.2.2 的 packages/llm/llm/src/content.ts 的 requiredImageOffload / offloadedImagePrefixCount（只数没摘的、从最老的数起、
//      超数按一档一档摘、超字节按字节摘够为止），compaction-image-offload 的 imageIndexes（每条消息里第几张图，摘过的也算）。
//      pi-ai 那几条线按 base64 长度算字节，每张先按像素预算缩、再封顶 requestImageMaxBytes（字节只能估：缩过以后重编码的大小拿不到，按像素比例估）。
//      pi-ai 那条路线的模型没有 image 输入时，历史里只要有图块（摘过的也算：检查在 options.messages 上做，早于占位投影），
//      宿主就不摘图、每一步都报 UNSUPPORTED_CONTENT（llm-pi-ai 的 adapter）。
//   2. 那边的判窗，两种都算：
//      - window：W = compress.sessions[她].modelContextLimit（绝对数照用，"N%" 按原生窗口折；代理不和原生窗口取小，
//        代理的 resolveContextLimitValue / applySessionCompressOverride），没有就 compress.modelContextLimit，再没有就原生窗口；
//        anthropic 线上有「输出另算」的证据（api.anthropic.com 或 claude-* 型号）时不扣，否则 maxOutput < W 时扣 min(maxOutput, 0.25 × W)
//        （代理的 reserveOutputHeadroom）；
//      - input（代理支持按输入算的判窗时）：min(inputTarget, quality, ⌊原生 × safety⌋ − min(maxOutput, 0.25 × 原生))。
//      哪种在生效看代理配置：她条目写了 limitMode:"input"、compress.modelWindows 里有这一行，才是 input。
//      vLLM 这类拒「提示 + max_tokens > max_model_len」的，另报墙：原生 − maxOutput。
//   3. 她现在的真用量（代理日志里她会话最后一条 [acp-usage] input=）占判窗几成。用量是现在这条线的分词器量的，换了模型会差。
// 门：checkSwitch（切之前）、checkHer（她现在这个模型，等于 checkSwitch 的目标就是她自己）、
//   gateForStep（上线脚本用：checkHer + 这一步认不认这个模型）。问题码和退出码见 EXIT / PROBLEM_ORDER；脚本请按 problems[].code 分，不要只看退出码。
// 不打印、不返回她的正文和 cordis.patch.yml 里的密钥：YAML 只取白名单里的键。
// 核准表（models.json）的格式见同目录的 models.example.json 和 README.md。
// YAML 用 js-yaml（tools/package.json 的依赖）；环境变量 FISH_TOOLS_JS_YAML 可以指到别的 js-yaml 目录。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

export const HERE = dirname(fileURLToPath(import.meta.url))
/** 核准表：环境变量 MODEL_SWITCH_MODELS，没设就是本目录的 models.json（照 models.example.json 写一份）。 */
export const MODELS_JSON = process.env.MODEL_SWITCH_MODELS || join(HERE, 'models.json')
const require = createRequire(import.meta.url)

// ---- 宿主的缺省（DSH 0.2.2 源码里的数，标了出处）----
export const PI_DEFAULTS = Object.freeze({
  maxRequestImages: 50, // llm-pi-ai config.ts DEFAULT_MAX_REQUEST_IMAGES
  countQuantumMax: 10, // DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM，缺省是 min(10, 上限)
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
  contextWindow: 1000000, // DEFAULT_CONTEXT_WINDOW：条目、目录、路线的 defaultContextWindow 都没说时
  maxTokens: 128000, // DEFAULT_MAX_TOKENS
  input: ['text'], // DEFAULT_INPUT
})
export const DEEPSEEK_DEFAULTS = Object.freeze({
  maxImagesPerRequest: 600, // llm-deepseek config / defaults
  imageOffloadCountQuantum: 20,
  maxRequestFilesBytes: 128 * 1024 * 1024,
  filesByteQuantum: 64 * 1024 * 1024,
  requestImageMaxBytes: 2 * 1024 * 1024, // request-pricing.ts DEFAULT_REQUEST_IMAGE_MAX_BYTES
  requestImagePixelBudget: null,
})
export const TRUNCATE_PCT = 0.95 // 内核紧急截断线（emergencyThresholdPercent 缺省 95）
export const ANTHROPIC_HOST = 'api.anthropic.com'

// ---- 问题码 → 退出码 ----
// 同一个退出码可以对几种问题：1 = 图的事（会摘 / 离上限不到余量），3 = 用量的事（到截断线或墙 / 过了 usageShareMax），4 = 不让用（表外、没批、这一步没在这个模型上演练过）。
export const EXIT = Object.freeze({
  OK: 0,
  DROPS_IMAGES: 1, IMAGE_MARGIN: 1,
  BAD_ARGS: 2,
  OVER_WINDOW: 3, USAGE_HIGH: 3,
  NOT_APPROVED: 4, NOT_REHEARSED: 4,
  CANNOT_SEND: 5,
  SURGE_BACK: 6,
  USAGE_UNKNOWN: 7,
})
/** 同时有几样时，退出码取这张表里排得最前的那一样（「没批」排第一：没批的目标不管还有什么，都先是「不让用」）。 */
export const PROBLEM_ORDER = Object.freeze(['BAD_ARGS', 'NOT_APPROVED', 'NOT_REHEARSED', 'CANNOT_SEND', 'DROPS_IMAGES', 'SURGE_BACK', 'OVER_WINDOW', 'IMAGE_MARGIN', 'USAGE_HIGH', 'USAGE_UNKNOWN'])
export function exitFor (problems) {
  const worst = PROBLEM_ORDER.find((c) => problems.some((p) => p.code === c))
  return worst ? EXIT[worst] : EXIT.OK
}

// ---- 核准表 ----
export function loadModels (path = MODELS_JSON) {
  const t = JSON.parse(readFileSync(path, 'utf8'))
  validateModels(t)
  return t
}
export function validateModels (t) {
  const bad = []
  if (t?.schema !== 1) bad.push('schema != 1')
  if (!Array.isArray(t?.models) || t.models.length === 0) bad.push('models missing')
  if (!Array.isArray(t?.steps) || t.steps.length === 0) bad.push('steps missing')
  if (!(Number.isInteger(t?.imageMargin) && t.imageMargin >= 0)) bad.push('imageMargin')
  if (!(t?.usageShareMax > 0 && t.usageShareMax < TRUNCATE_PCT)) bad.push('usageShareMax')
  if (typeof t?.surgeGuard?.r4Live !== 'boolean') bad.push('surgeGuard.r4Live')
  for (const s of t?.modelSpecificSteps ?? []) if (!(t?.steps ?? []).includes(s)) bad.push(`modelSpecificSteps ${s} not in steps`)
  const seen = new Set()
  for (const m of t?.models ?? []) {
    if (typeof m.id !== 'string' || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(m.id)) bad.push(`bad id ${m.id}`)
    if (seen.has(m.id)) bad.push(`duplicate ${m.id}`)
    seen.add(m.id)
    if (typeof m.approvedForHer !== 'boolean') bad.push(`${m.id}: approvedForHer`)
    if (!Array.isArray(m.rehearsedFor)) bad.push(`${m.id}: rehearsedFor`)
    if (!m.route?.family) bad.push(`${m.id}: route.family`)
    if (!(m.window?.native > 0) || !(m.window?.maxOutput > 0)) bad.push(`${m.id}: window`)
    if (!m.images || typeof m.images.capDefault !== 'number') bad.push(`${m.id}: images`)
    for (const s of m.rehearsedFor ?? []) if (!(t.modelSpecificSteps ?? []).includes(s)) bad.push(`${m.id}: rehearsedFor ${s} not a model-specific step`)
  }
  if (bad.length) { const e = new Error('models.json: ' + bad.join('; ')); e.code = 'BAD_TABLE'; throw e }
}
export const findModel = (table, id) => table.models.find((m) => m.id === id) ?? null
const isDeepseekId = (id) => /^deepseek/.test(String(id ?? ''))

/**
 * 只看表：这一步认不认这个模型（步名必须在 table.steps 里，大小写照写；跟模型有关的步还要 rehearsedFor 里有）。
 * 不看图、不看用量 —— 上线脚本不要直接用它，用 gateForStep。
 */
export function stepAllowedFor (table, modelId, step) {
  if (typeof step !== 'string' || !(table.steps ?? []).includes(step)) return { ok: false, code: 'BAD_ARGS', why: `不认得的步名 ${JSON.stringify(step)}（认得的：${(table.steps ?? []).join('、')}；大小写照写）` }
  const m = findModel(table, modelId)
  if (!m) return { ok: false, code: 'NOT_APPROVED', why: `${modelId} 不在核准表里` }
  if (!m.approvedForHer) return { ok: false, code: 'NOT_APPROVED', why: `${modelId} 在核准表里但没批给她（approvedForHer false）` }
  if ((table.modelSpecificSteps ?? []).includes(step) && !m.rehearsedFor.includes(step)) {
    return { ok: false, code: 'NOT_REHEARSED', why: `${step} 只在 ${table.models.filter((x) => x.rehearsedFor.includes(step)).map((x) => x.id).join('、')} 上演练过，她现在是 ${modelId}` }
  }
  return { ok: true, code: null, why: '' }
}

// ---- cordis.patch.yml（只取白名单里的键）----
let yamlMod = null
const yamlLib = () => (yamlMod ??= require(process.env.FISH_TOOLS_JS_YAML || 'js-yaml'))
// 路线级：图片档、协议、超时，加上宿主给「条目、目录都没说」的模型兜底的三样
const PI_PROVIDER_KEYS = ['api', 'maxRequestImages', 'imageOffloadCountQuantum', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes', 'streamIdleTimeoutMs',
  'defaultInput', 'defaultContextWindow', 'defaultMaxTokens']
const PI_MODEL_KEYS = ['id', 'contextWindow', 'maxTokens', 'input']
const DS_KEYS = ['maxImagesPerRequest', 'imageOffloadCountQuantum', 'maxRequestFilesBytes', 'requestImageMaxBytes', 'contextWindow', 'maxTokens']
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && (typeof o[k] !== 'object' || Array.isArray(o[k]))).map((k) => [k, o[k]]))
export function parseCordis (text) {
  const y = yamlLib()
  const JsExpr = new y.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: (d) => typeof d === 'string', construct: () => ({ __jsExpr: true }) })
  const doc = y.load(text, { schema: y.JSON_SCHEMA.extend(JsExpr) })
  const out = { piProviders: {}, deepseek: {}, defaultModel: null }
  for (const it of Array.isArray(doc) ? doc : []) {
    if (!it || it.insert || it.disabled === true) continue
    const nm = String(it.name ?? '')
    if (it.id === 'agent-default-model' || /dsh-agent-default-model$/.test(nm)) {
      const c = it.config ?? {}
      out.defaultModel = { provider: String(c.provider ?? ''), model: String(c.model ?? ''), reasoningEffort: c.reasoningEffort === undefined ? undefined : String(c.reasoningEffort) }
    } else if (/dsh-llm-pi-ai$/.test(nm)) {
      for (const [k, p] of Object.entries(it.config?.providers ?? {})) {
        const ov = p?.modelOverrides && typeof p.modelOverrides === 'object' && !Array.isArray(p.modelOverrides) ? p.modelOverrides : null
        out.piProviders[k] = {
          ...pick(p, PI_PROVIDER_KEYS),
          models: (Array.isArray(p?.models) ? p.models : []).map((m) => pick(m, PI_MODEL_KEYS)),
          ...(ov ? { modelOverrides: Object.fromEntries(Object.entries(ov).map(([id, o]) => [id, pick(o, PI_MODEL_KEYS.filter((x) => x !== 'id'))])) } : {}),
        }
      }
    } else if (/dsh-llm-deepseek(-account)?$/.test(nm)) {
      out.deepseek[it.id] = pick(it.config ?? {}, DS_KEYS)
    }
  }
  return out
}

// ---- 路线 ----
const splitId = (id) => { const i = String(id).indexOf('/'); return i < 0 ? [String(id), ''] : [id.slice(0, i), id.slice(i + 1)] }
const nonEmpty = (a) => (Array.isArray(a) && a.length > 0 ? a : undefined)
/**
 * 一个模型在宿主那边实际生效的路线参数。hc=true 时假定 HC 已经写进 cordis（用核准表里的 planned 值、按计划补全 models[] 条目）。
 * pi-ai 的取值顺序照 DSH 0.2.2 的 catalog.ts resolveRouteModels：条目（models[]，没列 models 时是 modelOverrides[id]）→ pi-ai 自带目录 → 路线的 defaultX → 宿主缺省。
 * 自带目录里的值这里不知道：只在路线没列 models、由目录供模型时，拿核准表的窗口当目录的替身（写进 notes）。
 */
export function routeFor (table, cordis, modelId, { hc = false } = {}) {
  const entry = findModel(table, modelId)
  const [provider, model] = splitId(modelId)
  const family = entry?.route?.family ?? (/^deepseek/.test(provider) ? 'llm-deepseek' : 'llm-pi-ai')
  const r = { id: modelId, provider, model, family, inTable: !!entry, approvedForHer: entry?.approvedForHer ?? false, rehearsedFor: entry?.rehearsedFor ?? [], configured: true, notes: [] }
  if (family === 'llm-deepseek') {
    const c = cordis?.deepseek?.[entry?.route?.plugin ?? 'llm-deepseek-account'] ?? {}
    Object.assign(r, {
      representation: 'files', imageInput: true, protocol: 'anthropic', origin: entry?.route?.upstream ?? 'https://api.deepseek.com',
      native: entry?.window?.native ?? 1048576, maxOutput: c.maxTokens ?? entry?.window?.maxOutput ?? 256000,
      cap: c.maxImagesPerRequest ?? DEEPSEEK_DEFAULTS.maxImagesPerRequest, quantum: c.imageOffloadCountQuantum ?? DEEPSEEK_DEFAULTS.imageOffloadCountQuantum,
      maxBytes: c.maxRequestFilesBytes ?? DEEPSEEK_DEFAULTS.maxRequestFilesBytes, byteQuantum: DEEPSEEK_DEFAULTS.filesByteQuantum,
      perImageMaxBytes: c.requestImageMaxBytes ?? DEEPSEEK_DEFAULTS.requestImageMaxBytes, pixelBudget: null,
    })
    return finishRoute(r, entry)
  }
  const pkey = entry?.route?.providerKey ?? provider
  const p = cordis?.piProviders?.[pkey]
  const listed = (p?.models ?? []).length > 0
  const overrides = p?.modelOverrides ?? {}
  let m = null; let catalogServed = false
  if (!p) { r.configured = false; r.notes.push(`cordis.patch.yml 里没有 llm-pi-ai 的 providers.${pkey}`) }
  else if (listed) {
    m = p.models.find((x) => x.id === model) ?? null
    if (!m) { r.configured = false; r.notes.push(`providers.${pkey}.models 里没有 ${model}`) }
    if (Object.keys(overrides).length > 0) { r.configured = false; r.notes.push(`providers.${pkey} 同时写了 models 和 modelOverrides：宿主会拒这条路线`) }
  } else {
    catalogServed = true
    m = overrides[model] ? { id: model, ...overrides[model] } : null
    r.notes.push(`providers.${pkey} 没列 models：宿主用 pi-ai 自带的目录供模型${m ? '（modelOverrides 里有这一条）' : ''}；目录里的窗口和输入这里不知道，条目没写的按核准表算（目录里没有 ${model} 的话宿主会拒）`)
  }
  // 自带目录的替身（只在目录供模型时）
  const stand = catalogServed && entry ? { input: entry.images?.input === false ? ['text'] : ['text', 'image'], contextWindow: entry.window.native, maxTokens: entry.window.maxOutput } : {}
  const stated = {
    input: nonEmpty(m?.input) ?? stand.input ?? (r.configured ? nonEmpty(p?.defaultInput) : undefined),
    contextWindow: m?.contextWindow ?? stand.contextWindow ?? (r.configured ? p?.defaultContextWindow : undefined),
    maxTokens: m?.maxTokens ?? stand.maxTokens ?? (r.configured ? p?.defaultMaxTokens : undefined),
  }
  const planned = hc ? entry?.images?.planned ?? null : null
  // HC 按计划补全 models[] 里的条目（只对核准表里写了 window 的）：input [text, image]、contextWindow、maxTokens
  const hcFill = hc && entry && (stated.input === undefined || stated.contextWindow === undefined || stated.maxTokens === undefined)
  const input = stated.input ?? (hcFill ? ['text', 'image'] : PI_DEFAULTS.input)
  const native = stated.contextWindow ?? (hcFill ? entry.window.native : (r.configured ? PI_DEFAULTS.contextWindow : entry?.window?.native ?? PI_DEFAULTS.contextWindow))
  const maxOutput = stated.maxTokens ?? (hcFill ? entry.window.maxOutput : (r.configured ? PI_DEFAULTS.maxTokens : entry?.window?.maxOutput ?? PI_DEFAULTS.maxTokens))
  if (r.configured && !hcFill) {
    if (stated.input === undefined) r.notes.push(`${model} 的条目和路线都没写 input：宿主按 [text] 算`)
    else if (nonEmpty(m?.input) === undefined && !catalogServed) r.notes.push(`${model} 的条目没写 input：宿主按路线的 defaultInput [${stated.input.join(', ')}] 算`)
    if (stated.contextWindow === undefined) r.notes.push(`${model} 的条目和路线都没写 contextWindow：宿主按 1,000,000 算`)
    if (stated.maxTokens === undefined) r.notes.push(`${model} 的条目和路线都没写 maxTokens：宿主按 128,000 算`)
  }
  if (hcFill) r.notes.push('按 HC 的计划补全了条目（input、contextWindow、maxTokens）')
  const cap = planned?.maxRequestImages ?? p?.maxRequestImages ?? PI_DEFAULTS.maxRequestImages
  const api = p?.api ?? entry?.route?.api ?? (pkey === 'anthropic' ? 'anthropic-messages' : pkey === 'google' ? 'google' : 'openai-completions')
  Object.assign(r, {
    representation: 'base64', imageInput: input.includes('image'), protocol: /anthropic/.test(api) ? 'anthropic' : /google/.test(api) ? 'google' : 'openai',
    origin: entry?.route?.upstream && /^https:\/\//.test(entry.route.upstream) ? entry.route.upstream : null,
    native, maxOutput, cap,
    quantum: planned?.imageOffloadCountQuantum ?? p?.imageOffloadCountQuantum ?? Math.min(PI_DEFAULTS.countQuantumMax, cap),
    maxBytes: planned?.maxRequestImageBytes ?? p?.maxRequestImageBytes ?? PI_DEFAULTS.maxRequestImageBytes, byteQuantum: 1,
    perImageMaxBytes: p?.requestImageMaxBytes ?? PI_DEFAULTS.requestImageMaxBytes,
    pixelBudget: planned?.requestImagePixelBudget ?? p?.requestImagePixelBudget ?? PI_DEFAULTS.requestImagePixelBudget,
  })
  return finishRoute(r, entry)
}
function finishRoute (r, entry) {
  r.serverMax = entry?.images?.serverMax ?? null
  r.providerMax = entry?.images?.providerMax ?? null
  r.serverMaxModelLen = entry?.server?.maxModelLen ?? null
  r.safety = entry?.window?.safety ?? 0.85
  r.quality = entry?.window?.quality ?? null
  return r
}

// ---- 会话日志 ----
/** 解 zstd 帧（DSH 的 session.v4.jsonl.zstd），只给拷贝用。 */
export function parseSessionLog (buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); const starts = []
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 4)) starts.push(i)
  const chunks = []
  for (let k = 0; k < starts.length;) {
    let d = null; let end = k + 1
    for (; end <= starts.length && d === null; end++) { try { d = zlib.zstdDecompressSync(buf.subarray(starts[k], end < starts.length ? starts[end] : buf.length)) } catch {} }
    if (d !== null) chunks.push(d.toString('utf8'))
    k = d === null ? k + 1 : end - 1
  }
  return chunks.join('').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/**
 * 她这会儿的模型：DSH 里选了还没发的（pending）优先，没有就是最后一份请求用的（lastUsed）。
 * 另给 lastUsedId：最后一份真发出去的请求用的模型（切回 DeepSeek 那条线会不会暴涨看它）。
 */
export function currentModel (events) {
  const same = (a, b) => a === b || (a && b && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort)
  let pending = null; let lastUsed = null; let lastSelectionAt = null
  for (const e of events) {
    if (e.type === 'model/selection') {
      const d = e.data ?? {}
      const s = { provider: String(d.provider), model: String(d.model), ...(d.reasoningEffort === undefined ? {} : { reasoningEffort: String(d.reasoningEffort) }) }
      if (!same(pending, s)) pending = s
      lastSelectionAt = Number(e.time)
    } else if (e.type === 'request/header') {
      const h = e.data?.header ?? {}; const c = h.config ?? {}
      const used = { provider: String(c.provider), model: String(c.model), ...(h.adapterDefaults?.reasoningEffort === true || c.reasoningEffort === undefined ? {} : { reasoningEffort: String(c.reasoningEffort) }) }
      if (same(pending, used)) pending = null
      lastUsed = used
    }
  }
  const cur = pending ?? lastUsed
  return cur
    ? { id: `${cur.provider}/${cur.model}`, reasoningEffort: cur.reasoningEffort ?? null, pending: !!pending, lastSelectionAt, lastUsedId: lastUsed ? `${lastUsed.provider}/${lastUsed.model}` : null }
    : null
}

/**
 * 宿主现在的 surface（照 DSH 0.2.2：surfaceOp 'append' 加一个节点，{op:'replace', startSeq, endSeq} 把一段换成这一条）。
 * 日志里一条 surfaceOp 都没有时（只留计数的夹具）回 null，调用方按「全在 surface 上」算。replace 指到不在 surface 上的 seq 时抛 SURFACE_MISMATCH。
 */
export function surfaceSeqs (events) {
  if (!events.some((e) => e.surfaceOp !== undefined)) return null
  const nodes = []
  for (const e of events) {
    if (e.surfaceOp === undefined || !Number.isInteger(e.seq)) continue
    if (e.surfaceOp === 'append') { nodes.push(e.seq); continue }
    const s = nodes.indexOf(e.surfaceOp?.startSeq); const t = nodes.indexOf(e.surfaceOp?.endSeq)
    if (s < 0 || t < s) { const err = new Error(`surface replace at seq ${e.seq} names seqs not on the surface`); err.code = 'SURFACE_MISMATCH'; throw err }
    nodes.splice(s, t - s + 1, e.seq)
  }
  return new Set(nodes)
}

/** 她日志里还在 surface 上的图：每张记 seq、在这条消息里是第几张、大小和宽高（不带内容）。offloaded 照 image/offload 记录标。 */
export function herImages (events) {
  const surface = surfaceSeqs(events)
  const off = new Map()
  let offloadEvents = 0
  for (const e of events) {
    if (e.type !== 'image/offload') continue
    offloadEvents++
    for (const t of e.data?.targets ?? []) { const s = off.get(t.seq) ?? new Set(); for (const i of t.imageIndexes ?? []) s.add(i); off.set(t.seq, s) }
  }
  const all = []
  for (const e of events) {
    if (e.type !== 'user/message' && e.type !== 'tool/result') continue
    if (surface !== null && !surface.has(Number(e.seq))) continue
    const content = e.type === 'user/message' ? e.data?.content : e.data?.message?.content
    if (!Array.isArray(content)) continue
    let idx = 0
    for (const b of content) {
      if (b?.type !== 'image') continue
      const a = b.attachment ?? {}
      all.push({ seq: Number(e.seq), index: idx, time: Number(e.time), bytes: Number(a.bytes) || 0, width: Number(a.width) || 0, height: Number(a.height) || 0,
        offloaded: b.offloaded === true || (off.get(Number(e.seq))?.has(idx) ?? false) })
      idx++
    }
  }
  const retained = all.filter((x) => !x.offloaded)
  return { total: all.length, offloaded: all.length - retained.length, retained, offloadEvents, surfaceNodes: surface === null ? null : surface.size }
}

// ---- 摘图的数法（DSH content.ts 照搬）----
export const base64Length = (n) => 4 * Math.ceil(n / 3)
export function offloadedImagePrefixCount (lengths, { maxImages, maxBytes, countQuantum = 1, byteQuantum = 1 }) {
  const total = lengths.reduce((s, b) => s + b, 0)
  const excessCount = maxImages === undefined ? 0 : Math.max(0, lengths.length - maxImages)
  const excessBytes = maxBytes === undefined ? 0 : Math.max(0, total - maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0; let removed = 0
  for (const b of lengths) {
    const byteMet = removeBytes === 0 || (byteQuantum === 1 ? removed >= removeBytes : removed > removeBytes)
    if (count >= removeCount && byteMet) break
    removed += b; count++
  }
  return count
}
/** DSH attachment request-projection.ts requestImageDimensions */
export function requestImageDimensions (width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let w = Math.max(1, Math.floor(width * scale)); let h = Math.max(1, Math.round(w * height / width))
    while (w * h > maxPixels && w > 1) { w -= 1; h = Math.max(1, Math.round(w * height / width)) }
    return { width: w, height: h }
  }
  let h = Math.max(1, Math.floor(height * scale)); let w = Math.max(1, Math.round(h * width / height))
  while (w * h > maxPixels && h > 1) { h -= 1; w = Math.max(1, Math.round(h * width / height)) }
  return { width: w, height: h }
}
/** 一张图在这条路线上发出去大概多少字节（估）：先按像素预算缩（按像素比例估大小），再封顶每张的上限；base64 线再换成 base64 长度。 */
export function estimateRequestBytes (img, route) {
  let n = img.bytes
  if (route.pixelBudget && img.width > 0 && img.height > 0 && img.width * img.height > route.pixelBudget) {
    const d = requestImageDimensions(img.width, img.height, route.pixelBudget)
    n = Math.ceil(n * (d.width * d.height) / (img.width * img.height))
  }
  if (route.perImageMaxBytes) n = Math.min(n, route.perImageMaxBytes)
  return route.representation === 'base64' ? base64Length(n) : n
}
/**
 * 在这条路线上宿主会永久摘掉几张（第一份请求就摘；之后在这条线上不再多摘，除非又进新图）。
 * totalImages：历史里一共有几个图块（摘过的也算）——「发不出去」看它，不看留着的。
 */
export function offloadIfSwitched (retained, route, totalImages = retained.length) {
  if (route.representation === 'base64' && !route.imageInput && totalImages > 0) {
    return { count: 0, unsupported: true, lengths: retained.length, bytesEst: 0, byCount: 0, byBytes: 0, serverOver: false }
  }
  const lengths = retained.map((x) => estimateRequestBytes(x, route))
  const budget = { maxImages: route.cap, maxBytes: route.maxBytes, countQuantum: route.quantum, byteQuantum: route.byteQuantum }
  const count = offloadedImagePrefixCount(lengths, budget)
  const byCount = offloadedImagePrefixCount(lengths, { ...budget, maxBytes: undefined })
  const byBytes = offloadedImagePrefixCount(lengths, { ...budget, maxImages: undefined })
  const bytesEst = lengths.reduce((s, b) => s + b, 0)
  const serverOver = route.serverMax !== null && retained.length - count > route.serverMax
  return { count, unsupported: false, lengths: lengths.length, bytesEst, byCount, byBytes, serverOver }
}

// ---- 判窗 ----
export function hasSeparateOutputBudgetEvidence (origin, modelId) {
  if (origin) { try { if (new URL(origin).hostname.toLowerCase() === ANTHROPIC_HOST) return true } catch {} }
  return typeof modelId === 'string' && modelId.length > 'claude-'.length && modelId.toLowerCase().startsWith('claude-')
}
/** 照代理的 resolveContextLimitValue：正数照用（向下取整），"N%" 按原生窗口折，别的数字串照数，其余（没写、写坏）= 原生窗口。 */
export function resolveContextLimitValue (raw, nativeLimit) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw))
  if (typeof raw === 'string') {
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw.trim())
    if (pct) return Math.max(1, Math.floor((nativeLimit * Number(pct[1])) / 100))
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return Math.max(1, Math.floor(nativeLimit))
}
/**
 * 代理 window 模式的判窗。sessionEntry 是 compress.sessions[她]，globalLimit 是 compress.modelContextLimit。
 * 会话上限是绝对数：代理不和原生窗口取小（applySessionCompressOverride）。
 * 没建模的：compress 的 provider / model 两级级联、proven-completion 的预留（只在吃过一次超窗 400 后才有）。
 */
export function judgeWindowNow (route, sessionEntry = {}, capPct = 0.25, globalLimit = undefined) {
  const raw = sessionEntry?.modelContextLimit
  const wEff = raw !== undefined ? resolveContextLimitValue(raw, route.native) : globalLimit !== undefined ? resolveContextLimitValue(globalLimit, route.native) : route.native
  const exempt = route.protocol === 'anthropic' && hasSeparateOutputBudgetEvidence(route.origin, route.model)
  let reserve = 0
  if (!exempt && route.maxOutput > 0 && route.maxOutput < wEff) reserve = Math.min(route.maxOutput, capPct * wEff)
  return { wEff, reserve, judge: wEff - reserve, exempt, source: raw !== undefined ? 'session' : globalLimit !== undefined ? 'global' : 'native' }
}
/** input 模式的判窗。 */
export function judgeBaseInput (route, inputTarget = 256000, capPct = 0.25) {
  const r = Math.min(route.maxOutput, capPct * route.native)
  const fromNative = Math.floor(route.native * route.safety) - r
  return Math.min(inputTarget, route.quality ?? Infinity, fromNative)
}
/** vLLM 这类服务的墙（提示 + max_tokens 不能超过 max_model_len）；不知道就是 null。 */
export const wallFor = (route) => (route.serverMaxModelLen ? route.serverMaxModelLen - route.maxOutput : null)
/** 哪种判窗在生效：她条目 limitMode:"input" 而且 compress.modelWindows 有这个模型才算 input。 */
export function limitModeInEffect (bcConfig, sid, modelId) {
  const entry = bcConfig?.compress?.sessions?.[sid] ?? {}
  const mw = bcConfig?.compress?.modelWindows ?? {}
  const [, model] = splitId(modelId)
  const hasRow = Object.prototype.hasOwnProperty.call(mw, modelId) || Object.prototype.hasOwnProperty.call(mw, model)
  return entry.limitMode === 'input' && hasRow ? 'input' : 'window'
}

// ---- 真用量 ----
/** 代理日志（bili.log 文本）里她会话最后一条 [acp-usage]。 */
export function lastUsage (logText, sid) {
  const re = /^(\S+) .*\[sess=([^\]]+)\].*\[acp-usage\] input=(\d+)(?: cached=(\d+))?/
  let last = null
  for (const line of String(logText).split('\n')) {
    if (!line.includes('[acp-usage]')) continue
    const m = re.exec(line)
    if (m && m[2] === sid) last = { at: m[1], input: Number(m[3]), cached: m[4] === undefined ? null : Number(m[4]) }
  }
  return last
}

// ---- 汇总 ----
/**
 * 「她在 target 上」安不安全：切之前问（target 是别的模型），或者问她现在这个（target 就是她现在的模型，见 checkHer）。
 * 输入全是解析好的东西：table、cordis（parseCordis 的结果）、events（会话日志）、bcConfig、sid、usage（lastUsage 的结果或 null）。
 * allowNoUsage 只给人看的场合（命令行 --allow-no-usage）；上线脚本、gateForStep 一律不许用。
 * 问题（都进 problems，退出码按 PROBLEM_ORDER 取最前的）：
 *   NOT_APPROVED  表外或 approvedForHer false
 *   CANNOT_SEND   pi-ai 条目没有 image 输入而历史里有图块：每一步 UNSUPPORTED_CONTENT
 *   DROPS_IMAGES  在那条线上宿主会永久摘图（已经在那个模型上、或 DSH 里已经选了还没发，也一样：下一份请求就摘）
 *   SURGE_BACK    最后一份请求不是 DeepSeek 那条线、目标是：切回去第一份暴涨；代理按估计用量紧急截断时，第二份会照这个过期读数截断、
 *                 锁到下一次压缩。核准表 surgeGuard.r4Live 为 false 时算问题，为 true（代理在换模型后头几份只催不截）时只出警告
 *   OVER_WINDOW   真用量 ≥ 判窗 × 0.95，或 ≥ 墙
 *   IMAGE_MARGIN  上限 < 留着的图 + imageMargin（还没摘，但再进几张就开始摘）
 *   USAGE_HIGH    真用量 ≥ usageShareMax × 判窗
 *   USAGE_UNKNOWN 读不到她的真用量
 */
export function checkSwitch ({ table, cordis, events, bcConfig, sid, usage, target, hc = false, allowNoUsage = false }) {
  const cur = currentModel(events)
  const imgs = herImages(events)
  const route = routeFor(table, cordis, target, { hc })
  const entry = bcConfig?.compress?.sessions?.[sid] ?? {}
  const now = judgeWindowNow(route, entry, 0.25, bcConfig?.compress?.modelContextLimit)
  const input = judgeBaseInput(route, table.inputTarget ?? 256000)
  const mode = limitModeInEffect(bcConfig, sid, target)
  const judge = mode === 'input' ? input : now.judge
  const wall = wallFor(route)
  const off = offloadIfSwitched(imgs.retained, route, imgs.total)
  const same = cur?.id === target
  const margin = table.imageMargin ?? 20
  const shareMax = table.usageShareMax ?? 0.8
  const problems = []; const warnings = []
  if (!route.inTable) problems.push({ code: 'NOT_APPROVED', text: `${target} 不在核准表里（models.json）` })
  else if (!route.approvedForHer) problems.push({ code: 'NOT_APPROVED', text: `${target} 在核准表里但 approvedForHer 是 false` })
  if (off.unsupported) problems.push({ code: 'CANNOT_SEND', text: `宿主那边 ${target} 的条目没有 image 输入，她历史里有 ${imgs.total} 个图块（摘过的也算）：每一步都会 UNSUPPORTED_CONTENT` })
  const capNote = `她留着 ${imgs.retained.length} 张，那边上限 ${route.cap}、一档 ${route.quantum}`
  if (off.count > 0) {
    const lead = !same ? '切过去第一份请求' : cur.pending ? `DSH 里已经选了 ${target}、还没发请求：下一份请求` : `她已经在 ${target} 上：下一份请求`
    problems.push({ code: 'DROPS_IMAGES', text: `${lead}宿主就会永久摘掉最老的 ${off.count} 张图（${capNote}）` })
  } else if (!off.unsupported && route.cap < imgs.retained.length + margin) {
    problems.push({ code: 'IMAGE_MARGIN', text: `${capNote}，不到图数 + ${margin}：再进 ${route.cap - imgs.retained.length + 1} 张就开始永久摘` })
  }
  if (off.serverOver) warnings.push(`宿主留下的 ${imgs.retained.length - off.count} 张超过服务端每份 ${route.serverMax} 张：服务端回 400、不摘图，要靠代理折图才发得出去`)
  // 切回 DeepSeek 那条线（最后一份真请求不是这条线）：已经选了还没发的也算
  const surge = route.family === 'llm-deepseek' && cur?.lastUsedId && !isDeepseekId(cur.lastUsedId)
  if (surge) {
    const text = `最后一份请求走的是 ${cur.lastUsedId}，${same ? '下一份' : '切回来第一份'}请求会把以前各模型写的思考全部带回线上、暴涨（见过两倍多判窗）；代理按估计用量紧急截断时，第二份请求会照这个过期读数截断、锁到她下一次压缩`
    if (table.surgeGuard?.r4Live === true) warnings.push(text + '（surgeGuard.r4Live：代理换模型后头几份只催不截）')
    else problems.push({ code: 'SURGE_BACK', text: text + '。代理还不会在换模型后先催后截时：第二份请求会照第一份的过期读数紧急截断、上锁，锁要到她下一次压缩成功才清；要切先把这份报告给主人看' })
  }
  const share = usage ? usage.input / judge : null
  const shareNow = usage ? usage.input / now.judge : null
  const shareInput = usage ? usage.input / input : null
  if (!usage) {
    const text = '没读到她的真用量（代理日志里没有她会话的 [acp-usage]）：「真用量 < ' + shareMax + ' × 判窗」证明不了'
    if (allowNoUsage) warnings.push(text + '（--allow-no-usage：只给人看，上线脚本不许用）')
    else problems.push({ code: 'USAGE_UNKNOWN', text })
  } else if (usage.input >= TRUNCATE_PCT * judge || (wall !== null && usage.input >= wall)) {
    problems.push({ code: 'OVER_WINDOW', text: `她最近真用量 ${usage.input} 到了那边的截断线（判窗 ${judge} × ${TRUNCATE_PCT}${wall !== null ? `；墙 ${wall}` : ''}）` })
  } else if (share >= shareMax) {
    problems.push({ code: 'USAGE_HIGH', text: `她最近真用量 ${usage.input} 占那边判窗 ${judge} 的 ${(share * 100).toFixed(1)}%，不到 ${shareMax * 100}% 才算过` })
  }
  if (!same && route.family !== 'llm-deepseek') warnings.push('切到 pi-ai 那几条线：别的模型写的思考不再发，代理的折叠 id 会对不上；切回 DeepSeek 那条线时会暴涨（见 SURGE_BACK）')
  for (const n of route.notes) warnings.push(n)
  return {
    target, current: cur, same, hc,
    images: { total: imgs.total, offloaded: imgs.offloaded, retained: imgs.retained.length, offloadEvents: imgs.offloadEvents, surfaceNodes: imgs.surfaceNodes, wouldOffload: off.count, byCount: off.byCount, byBytes: off.byBytes, bytesEst: off.bytesEst, unsupported: off.unsupported, margin,
      route: { representation: route.representation, cap: route.cap, quantum: route.quantum, maxBytes: route.maxBytes, pixelBudget: route.pixelBudget, imageInput: route.imageInput, serverMax: route.serverMax, configured: route.configured } },
    judge: { inEffect: mode, judge, window: now, input, wall, native: route.native, maxOutput: route.maxOutput, protocol: route.protocol, usageShareMax: shareMax },
    usage: usage ? { ...usage, share, shareWindow: shareNow, shareInput } : null,
    approvedForHer: route.approvedForHer, inTable: route.inTable, surge: !!surge,
    problems, warnings, exit: exitFor(problems),
  }
}

/** checkHer：她现在这个模型（pending ?? lastUsed）过不过核准表的三条前提，外加摘图、切回暴涨。 */
export function checkHer ({ table, cordis, events, bcConfig, sid, usage }) {
  const cur = currentModel(events)
  if (!cur) {
    const problems = [{ code: 'NOT_APPROVED', text: '会话日志里认不出她现在的模型（没有 model/selection、request/header）' }]
    return { ok: false, target: null, current: null, same: true, problems, warnings: [], exit: exitFor(problems) }
  }
  const r = checkSwitch({ table, cordis, events, bcConfig, sid, usage, target: cur.id, hc: false, allowNoUsage: false })
  return { ...r, ok: r.problems.length === 0 }
}

/**
 * 上线脚本用：她现在这个模型过不过这一步。gateForStep({table, cordis, events, bcConfig, sid, usage, step})。
 * = checkHer（核准表、摘图、离上限的余量、切回暴涨、真用量）+ 步名认得 + 跟模型有关的步要 rehearsedFor 里有。
 * 三参数写法 gateForStep(table, modelId, step) 只看表、会放过丢图，一律不放行。
 */
export function gateForStep (arg, ...rest) {
  const bad = (text) => { const problems = [{ code: 'BAD_ARGS', text }]; return { ok: false, step: null, current: null, problems, warnings: [], exit: exitFor(problems), why: text } }
  if (rest.length > 0 || !arg || typeof arg !== 'object' || !arg.table || !Array.isArray(arg.events)) {
    return bad('gateForStep 要一个对象 {table, cordis, events, bcConfig, sid, usage, step}：她的图和真用量都要算，只给表和模型 id 的旧写法不再放行')
  }
  const { table, step } = arg
  if (typeof step !== 'string' || !(table.steps ?? []).includes(step)) return bad(`不认得的步名 ${JSON.stringify(step)}（认得的：${(table.steps ?? []).join('、')}；大小写照写）`)
  const her = checkHer(arg)
  const problems = [...her.problems]
  if (her.current) {
    const s = stepAllowedFor(table, her.current.id, step)
    if (!s.ok && s.code === 'NOT_REHEARSED') problems.push({ code: 'NOT_REHEARSED', text: s.why })
  }
  return { ok: problems.length === 0, step, current: her.current, problems, warnings: her.warnings, exit: exitFor(problems), why: problems.map((p) => p.text).join('；'), report: her }
}
