// 转发器（eval.md 第 3 节）：整套架子里唯一出网的进程。
//   代理拷贝（5bb25bf）把 providers["https://api.deepseek.com"].proxy 指到这里（HTTP CONNECT），network.caFile 认这次的测试 CA；
//   转发器在 CONNECT 里用测试叶证书终止 TLS，收下「发往 api.deepseek.com 的 Anthropic 请求」，然后：
//     变换（去提醒、图换占位、去别家思考、换路径）→ 换成目标协议（四家）→ 隐私闸 → 预算账（先记 reserve）→ 发（不重试）
//     → 收齐 → 结账 → 缓存上游原文 → 转回 Anthropic 流（用量按 pinned / real）回给代理。
//   同一个调用（指纹 + 会话 + 发出去的 payload 的 sha）第二次来直接从缓存回，不花钱；失败过的不再发。
// 起法：node fwd/start.mjs --config <配置>（它按配置算出网名单、带 egress-guard 预加载起这个进程）。
// 只出元数据：calls.jsonl 一次请求一行（类别、计数、用量、钱、耗时），不记正文、不记凭据。
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedAllow, loadConfig } from './lib/config.mjs'
import { resolveDeepseekAccount, resolveRef, readPiAiRoutes } from './lib/credentials.mjs'
import { buildFingerprint, bindRunDir, treeSha } from './lib/fingerprint.mjs'
import { applyTransforms, loadRelDate } from './lib/transforms.mjs'
import { buildCorpusIndex, checkRequest, collectStrings, compileTemplates, frameworkGrams, loadDenyHashes, makeGramChecker, matchApproval } from './lib/privacy-gate.mjs'
import { SpendLedger, BudgetError, STOP_KINDS } from './lib/spend-ledger.mjs'
import { costOf, PRICES, reserveOf } from './lib/prices.mjs'
import { countImages, normalizeUsage, pinnedInputTokens, toAnthropicUsage } from './lib/usage.mjs'
import { SigStore } from './lib/sig-store.mjs'
import { sendUpstream } from './lib/upstream.mjs'
import { errorEvent, pingEvent, sseFromMessage } from './lib/anthropic-sse.mjs'
import { FwdError } from './lib/protocols/common.mjs'
import { CRED_RE } from './lib/privacy-gate.mjs'
import { PATH_RE } from './lib/transforms.mjs'
import { appendJsonl, canonicalJson, randomToken, readJson, sha256, shaFile, localIso, writeAtomic } from './lib/util.mjs'
import * as deepseek from './lib/protocols/deepseek.mjs'
import * as anthropic from './lib/protocols/anthropic.mjs'
import * as gemini from './lib/protocols/gemini.mjs'
import * as openai from './lib/protocols/openai.mjs'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))
const PROTOCOLS = { deepseek, anthropic, gemini, openai }
const die = (msg) => { process.stderr.write(`forwarder: ${msg}\n`); process.exit(2) }

const cfgPath = process.argv[process.argv.indexOf('--config') + 1]
if (!cfgPath || process.argv.indexOf('--config') < 0) die('usage: forwarder.mjs --config <file>')
let cfg
try { cfg = loadConfig(cfgPath) } catch (e) { die(`config: ${e.message}`) }
const target = cfg.target
const P = PROTOCOLS[target.provider]
const provider = target.provider

// ---- 0. 出网闸：必须预加载着，而且名单和配置算出来的一样 ----
const guard = globalThis[Symbol.for('fwd.egressGuard')]
if (!guard) die('egress guard not loaded (start through fwd/start.mjs)')
if (JSON.stringify(guard.allow) !== JSON.stringify(expectedAllow(cfg))) die(`egress allow list ${JSON.stringify(guard.allow)} != expected ${JSON.stringify(expectedAllow(cfg))}`)

// ---- 1. 内核转换函数：和清单对得上 ----
const manifest = readJson(join(HERE, 'vendor', 'kernel-wire.manifest.json'))
if (shaFile(join(HERE, 'vendor', 'kernel-wire.mjs')) !== manifest.outputSha256) die('vendor/kernel-wire.mjs does not match its manifest')

// ---- 2. 凭据（只在内存） ----
let creds = null
if (cfg.offline) creds = null
else if (cfg.testMode) creds = { apiKey: 'test-key-not-real', token: 'test-token-not-real', anonymousUserId: 'anon-test' }
else if (provider === 'deepseek' && target.deepseek.auth === 'account') { const a = resolveDeepseekAccount(); if (!a) die('no DeepSeek account token (env DEEPSEEK_ACCOUNT_TOKEN)'); creds = a }
else {
  const envName = provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'gemini' ? 'GOOGLE_API_KEY' : (process.env.FWD_OPENAI_KEY_ENV || readPiAiRoutes()['self-hosted']?.apiKeyEnv || 'OPENAI_API_KEY')
  const r = envName ? resolveRef(envName) : null
  if (!r && provider !== 'openai') die(`no credential for ${provider} (${envName})`)
  creds = { apiKey: r?.value ?? '' }
}

// ---- 3. 部署（Qwen）：声明的部署文件 + 起来时现取的 /v1/models ----
function getJson (url, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const u = new URL(url)
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, agent: false, headers: { accept: 'application/json' } }, (r) => {
      const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => { try { res({ status: r.statusCode, json: JSON.parse(Buffer.concat(ch).toString('utf8')) }) } catch (e) { rej(e) } })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', rej)
    req.end()
  })
}
let servingStack = null
if (provider === 'openai') {
  const declared = cfg.servingStackFile ? readJson(cfg.servingStackFile) : null
  let live = null
  if (!cfg.offline) {
    try {
      const r = await getJson(`${target.baseUrl}/models`)
      const m = (r.json?.data ?? []).find((x) => x.id === target.model)
      live = m ? { id: m.id, root: m.root ?? null, max_model_len: m.max_model_len ?? null, owned_by: m.owned_by ?? null } : { missing: true, ids: (r.json?.data ?? []).map((x) => x.id) }
    } catch (e) { die(`cannot read ${target.model} from /models: ${e.message}`) }
    if (live.missing) die(`model ${target.model} not served (have ${live.ids.join(',')})`)
  }
  servingStack = { declared, declaredSha: cfg.servingStackFile ? shaFile(cfg.servingStackFile) : null, live }
}

// ---- 4. 指纹 ----
const relDate = await loadRelDate(cfg.transforms.relDate)
const code = treeSha(HERE, { skip: ['tests', 'config', 'vendor/kernel-wire.manifest.json'] })
let cacheFromId = null
if (cfg.cacheFrom) cacheFromId = readJson(join(cfg.cacheFrom, 'fingerprint.json')).id
const built = buildFingerprint({
  target: { ...target, baseUrlHost: new URL(target.baseUrl).host },
  usageFeedback: cfg.usageFeedback, arm: cfg.arm, summaryPolicy: cfg.summaryPolicy,
  transforms: { ...cfg.transforms, relDateSha: relDate.sha },
  forwarder: { codeSha: code.sha, codeFiles: code.files, kernelWireSha: manifest.outputSha256, kernelCommit: manifest.commit, pricesSha: sha256(canonicalJson(PRICES)), testMode: cfg.testMode, offline: cfg.offline, ...(cfg.countOnly ? { countOnly: true } : {}) },
  servingStack, cacheFrom: cacheFromId,
  extra: cfg.fingerprintExtra ?? {},
}, { strict: cfg.strict === true })
mkdirSync(cfg.stateDir, { recursive: true })
try { bindRunDir(cfg.stateDir, built) } catch (e) { die(e.message) }
const fpId = built.id

// ---- 5. 账、签名、隐私闸 ----
const ledger = new SpendLedger({ dir: cfg.stateDir, caps: cfg.caps })
const sigStore = new SigStore(cfg.stateDir)
if (cfg.cacheFrom) sigStore.importFrom(cfg.cacheFrom)
const privacyCtx = { arm: cfg.arm, provider, isOwnText: (s) => sigStore.isOwnText(s) }
if (cfg.arm === 'synthetic') {
  const pv = cfg.privacy ?? {}
  privacyCtx.toolNames = Array.isArray(pv.toolNames) ? new Set(pv.toolNames) : null
  privacyCtx.toolsSha = pv.toolsSha ?? null
  if (pv.snapshotDir && existsSync(pv.snapshotDir)) {
    const idx = buildCorpusIndex(pv.snapshotDir)
    // 框架字（整合架子写的 framework-texts.json：代理拷贝的包、dsh-fish 拷贝的模板字、执行器的固定回复）：片段命中了不算
    let allowGrams = null
    // 替身模板（第二轮修）：整行对得上的只查空位里的字，模板的固定字不算她的话
    let templates = []
    if (pv.frameworkTextsFile) {
      const ft = readJson(pv.frameworkTextsFile)
      allowGrams = frameworkGrams(Array.isArray(ft) ? ft : ft.texts)
      templates = compileTemplates(Array.isArray(ft) ? [] : (ft.templates ?? []))
      privacyCtx.frameworkGrams = allowGrams.size
    }
    privacyCtx.gramCheck = makeGramChecker(idx, { allowGrams, templates })
    privacyCtx.deny = loadDenyHashes(pv.snapshotDir)
    privacyCtx.indexStats = { ...idx.stats, frameworkTemplates: templates.length }
  }
} else {
  // 真数据臂的许可（复核 A7）：按提供方、臂、数据指纹（视图 rawSha、题集 sha）认，带有效期；起来时就对，对不上不起
  const approvals = cfg.approvalsFile && existsSync(cfg.approvalsFile) ? readJson(cfg.approvalsFile) : null
  const ex = cfg.fingerprintExtra ?? {}
  privacyCtx.approval = matchApproval(approvals, { provider, armId: cfg.armId, data: { viewRawSha: ex.view?.rawSha ?? null, questionSetSha: ex.questions?.setSha ?? null }, testMode: cfg.testMode })
  if (!privacyCtx.approval.ok && (cfg.strict === true || !cfg.testMode)) die(`real-data arm has no matching approval: ${privacyCtx.approval.why}`)
}

// ---- 5b. 余额底（复核 A1）：DeepSeek 真出网时读余额，能花的 = min(上限剩的, 余额 − 给她留的底 − 读完以后又记下的) ----
const round6 = (x) => Math.round(x * 1e6) / 1e6
function getJsonAuthed (url, headers, timeoutMs = 15000) {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((res, rej) => {
    const req = mod.request({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, agent: false, headers }, (r) => {
      const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(ch).toString('utf8')) } catch { json = null } res({ status: r.statusCode, json }) })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', rej)
    req.end()
  })
}
const balance = { enabled: provider === 'deepseek' && cfg.balanceFloor !== null && !cfg.offline, value: null, atMs: 0, committedAt: 0, reads: 0, error: null }
async function refreshBalance (force = false) {
  if (!balance.enabled) return true
  if (!force && balance.value !== null && Date.now() - balance.atMs < cfg.balanceCheckMs) return true
  try {
    const headers = target.deepseek.auth === 'apiKey' ? { authorization: `Bearer ${creds.apiKey}`, accept: 'application/json' } : { ...P.authHeaders(target, creds, { conversationKey: 'fwd-balance' }), accept: 'application/json' }
    const r = await getJsonAuthed(`${target.baseUrl}/user/balance`, headers)
    if (r.status !== 200) throw new Error(`balance http ${r.status}`)
    if (r.json?.is_available !== true) throw new Error('balance is_available is not true')
    const cny = (r.json?.balance_infos ?? []).find((x) => x?.currency === 'CNY')
    const v = Number(cny?.total_balance)
    if (!cny || !Number.isFinite(v)) throw new Error('no CNY total_balance')
    Object.assign(balance, { value: v, atMs: Date.now(), committedAt: ledger.committed(provider), error: null })
    balance.reads++
    return true
  } catch (e) {
    balance.error = String(e?.message ?? e).replace(new RegExp(CRED_RE.source, 'g'), '[cred]').slice(0, 200)
    balance.value = null
    return false
  }
}
if (balance.enabled) {
  ledger.setHeadroom(provider, () => (balance.value === null ? 0 : round6(balance.value - cfg.balanceFloor - (ledger.committed(provider) - balance.committedAt))))
  if (!(await refreshBalance(true))) die(`cannot read the DeepSeek balance (fail-closed): ${balance.error}`)
  if (ledger.headroom(provider) <= 0) die(`DeepSeek balance is at or below the floor ${cfg.balanceFloor} CNY: nothing to spend`)
}
// 提供方说钱不够 / 认证没过：整本账停下（种类 provider），不让每个半边各撞一次
const PROVIDER_STOP = /insufficient.?balance|余额不足|insufficient_quota|credit balance is too low|billing/i
const usageAudit = { calls: 0, estInput: 0, reportedInput: 0, overReserve: 0, noUsage: 0 }

const callsLog = join(cfg.stateDir, 'calls.jsonl')
const cacheDir = join(cfg.stateDir, 'cache')
const wireDir = join(cfg.stateDir, 'wire')
mkdirSync(cacheDir, { recursive: true })
const counters = { requests: 0, main: 0, summary: 0, cacheHits: 0, sent: 0, refused: 0, upstreamErrors: 0, ...(cfg.countOnly ? { tokenizeCalls: 0 } : {}) }
const logRow = (row) => appendJsonl(callsLog, { t: localIso(), fingerprintId: fpId, ...row })
const cacheGet = (callId) => {
  for (const d of [cacheDir, cfg.cacheFrom ? join(cfg.cacheFrom, 'cache') : null]) {
    if (!d) continue
    const f = join(d, `${callId}.json`)
    if (existsSync(f)) return readJson(f)
  }
  return null
}
const cachePut = (callId, rec) => writeAtomic(join(cacheDir, `${callId}.json`), JSON.stringify(rec))
const scrub = (s) => String(s ?? '').replace(new RegExp(CRED_RE.source, 'g'), '[cred]').replace(new RegExp(PATH_RE.source, 'gi'), '[path]').slice(0, 300)

function sendJsonError (res, status, type, message) {
  if (res.headersSent) { try { res.end(errorEvent(type, message)) } catch {} return }
  const b = JSON.stringify({ type: 'error', error: { type, message } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) })
  res.end(b)
}
const readBody = (req, limit = 96 * 1024 * 1024) => new Promise((ok, bad) => {
  const ch = []; let n = 0
  req.on('data', (c) => { n += c.length; if (n > limit) { bad(new FwdError('TOO_LARGE', 'request too large')); req.destroy() } else ch.push(c) })
  req.on('end', () => ok(Buffer.concat(ch)))
  req.on('error', bad)
})
const isSummaryCall = (b) => Array.isArray(b?.messages) && b.messages.length === 1 && !(Array.isArray(b.tools) && b.tools.length)

/** 把一份上游回复（新收的或缓存里的）转给代理。 */
/** 回答里目标模型自己写的字：正文、思考、工具参数（各个字符串值 + 整份 JSON，后者是 OpenAI 线 arguments 的样子）。 */
function ownTextsOf (msg) {
  const out = []
  for (const b of msg?.content ?? []) {
    if (b.type === 'text') out.push(b.text)
    else if (b.type === 'thinking') out.push(b.thinking)
    else if (b.type === 'tool_use') { out.push(JSON.stringify(b.input ?? {})); collectStrings(b.input ?? {}, out) }
  }
  return out
}

function serve (res, rec, { replay, callId, pinnedInput, reserve, row }) {
  const parsed = P.parseUpstream(rec.raw, { sigStore })
  for (const s of parsed.ownSignatures ?? []) sigStore.addOwn(s)
  if (parsed.ok) for (const s of ownTextsOf(parsed.message)) sigStore.addOwnText(s)
  const norm = normalizeUsage(provider, parsed.usageRaw)
  const cost = costOf(provider, norm)
  Object.assign(row, { usage: norm, cost, stopReason: parsed.message?.stop_reason ?? null, extras: parsed.extras ?? {}, replay })
  if (!replay) {
    if (parsed.ok) {
      // 复核 A3：回报里没有用量（输入、输出都是 0），或者回报的输入不到估算的 30%：按整份预留记，行里标出来
      const reportedIn = (norm.input ?? 0) + (norm.cacheRead ?? 0) + (norm.cacheWrite ?? 0)
      const est = reserve?.inputTokensEst ?? 0
      const noUsage = reportedIn + (norm.output ?? 0) === 0 || (est > 0 && reportedIn < 0.3 * est)
      usageAudit.calls++
      usageAudit.estInput += est
      usageAudit.reportedInput += reportedIn
      if (reserve && cost > reserve.amount + 1e-9) usageAudit.overReserve++
      if (noUsage) {
        usageAudit.noUsage++
        row.costSource = 'estimate-no-usage'
        ledger.settle({ provider, callId, cost: Math.max(cost, reserve?.amount ?? 0), usage: norm, source: 'estimate-no-usage', extra: { reportedInput: reportedIn, inputTokensEst: est } })
      } else ledger.settle({ provider, callId, cost, usage: norm })
    } else {
      // 复核 A2：200 以后半截的流（没有 message_stop / 流里报错）：输出那一截提供方照样收钱，按整份预留记
      ledger.fail({ provider, callId, charged: Math.max(cost, reserve?.amount ?? 0), reason: `stream:${parsed.error?.type}` })
    }
  }
  if (!parsed.ok) {
    row.error = `stream:${parsed.error?.type}`
    if (!replay) cachePut(callId, { ...rec, failed: true })
    return sendJsonError(res, 400, 'api_error', `fwd: upstream stream incomplete (${parsed.error?.type})`)
  }
  let out
  if (provider === 'deepseek') out = rec.raw // DeepSeek 原样回（它数的就是 pinned 要报的那个数）
  else out = sseFromMessage(parsed.message, toAnthropicUsage(cfg.usageFeedback, { pinnedInput, norm }))
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(out)
}

// ---- 只数 token（cfg.countOnly，ob count-w，11-19） ----
// 这一发和真跑一样变换、换协议（payload 就是真跑会发去 /chat/completions 的那一份），主机闸、隐私闸（真数据臂的许可）照过，
// 然后只把同一份 messages / tools / chat_template_kwargs 交给 vLLM 的 /tokenize（同一个 host:port；它套同一个对话模板，
// add_generation_prompt 和 add_special_tokens 取 chat/completions 的缺省 true / false）。数两份：带工具表（就是要发的那份）、
// 不带工具表（核 /tokenize 认没认 tools）。一次只一份在途。不发 /chat/completions、不预留、不记账、不进缓存；
// counts.jsonl 只记数（token 数、max_model_len、消息 / 工具 / 图的个数），不记正文、不记 token id。回代理一条固定的字。
async function tokenizeOnce (url, body) {
  counters.tokenizeCalls++
  let rec
  try {
    rec = await sendUpstream({ url, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), timeoutMs: cfg.upstreamTimeoutMs })
  } catch (e) { return { status: 0, count: null, error: e.code ?? 'NET' } }
  let j = null
  try { j = JSON.parse(rec.raw) } catch { j = null }
  const out = { status: rec.status, count: Number.isInteger(j?.count) ? j.count : null, maxModelLen: Number.isInteger(j?.max_model_len) ? j.max_model_len : null, tokensReturned: Array.isArray(j?.tokens) ? j.tokens.length : null, ms: rec.totalMs }
  // 报错原文可能带回请求里的字：只记类型和长度
  if (rec.status !== 200 || out.count === null) Object.assign(out, { errorType: String(j?.type ?? j?.error?.type ?? j?.object ?? 'unknown').slice(0, 60), errorChars: String(j?.message ?? j?.error?.message ?? j?.detail ?? rec.raw ?? '').length })
  return out
}
async function handleCountOnly (res, { breq, tr, row, pinnedInput, payloadText }) {
  const up = new URL(breq.url)
  const upPort = up.port ? Number(up.port) : (up.protocol === 'https:' ? 443 : 80)
  if (up.origin !== new URL(target.baseUrl).origin || !guard.egressAllowed(up.hostname, upPort)) { counters.refused++; row.refused = 'host-gate'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd_host_gate') }
  const pg = checkRequest(privacyCtx, breq.payload, tr.body)
  if (!pg.ok) { counters.refused++; row.refused = 'privacy'; row.privacy = pg.problems; return sendJsonError(res, 400, 'invalid_request_error', `fwd_privacy: ${pg.problems.join('; ')}`) }
  const p = breq.payload
  const tokUrl = new URL('/tokenize', target.baseUrl).href
  const tu = new URL(tokUrl)
  if (tu.origin !== up.origin) { counters.refused++; row.refused = 'host-gate'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd_host_gate') }
  const base = { model: p.model, messages: p.messages, add_generation_prompt: true, continue_final_message: false, add_special_tokens: false, ...(p.chat_template_kwargs ? { chat_template_kwargs: p.chat_template_kwargs } : {}) }
  const hasTools = Array.isArray(p.tools) && p.tools.length > 0
  const variants = []
  variants.push({ name: hasTools ? 'with-tools' : 'no-tools', ...(await tokenizeOnce(tokUrl, hasTools ? { ...base, tools: p.tools } : base)) })
  if (hasTools) variants.push({ name: 'no-tools', ...(await tokenizeOnce(tokUrl, base)) })
  const roles = {}
  for (const m of p.messages ?? []) roles[m.role] = (roles[m.role] ?? 0) + 1
  const out = {
    t: localIso(), fingerprintId: fpId, conv: row.conv, ob: row.ob ?? null, model: p.model,
    payloadSha: sha256(payloadText), payloadBytes: Buffer.byteLength(payloadText),
    messages: (p.messages ?? []).length, roles, tools: hasTools ? p.tools.length : 0,
    toolChoice: typeof p.tool_choice === 'string' ? p.tool_choice : (p.tool_choice ? 'object' : null),
    maxTokens: p.max_tokens ?? null, chatTemplateKwargs: p.chat_template_kwargs ?? null,
    images: { user: breq.meta?.userImages ?? null, toolResult: breq.meta?.toolResultImages ?? null }, midSystemConverted: breq.meta?.midSystemConverted ?? null, reasoningMessages: breq.meta?.reasoningMessages ?? null,
    transforms: tr.counts, pinnedInput, variants,
  }
  appendJsonl(join(cfg.stateDir, 'counts.jsonl'), out)
  row.countOnly = variants.map((v) => ({ name: v.name, status: v.status, count: v.count }))
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(sseFromMessage({ id: 'msg_fwd_count_only', model: target.model, content: [{ type: 'text', text: '（评测转发器：这一发只数 token，没有调模型）' }], stop_reason: 'end_turn' }, toAnthropicUsage(cfg.usageFeedback, { pinnedInput, norm: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } })))
}

async function handleMessages (req, res) {
  counters.requests++
  const row = { kind: null }
  try {
    const raw = await readBody(req)
    const body = JSON.parse(raw.toString('utf8'))
    // 会话键：CONNECT 进来时用代理拷贝转来的插件头；经 A 部分的出口拦截（EgressFront，明文回环）进来时用它的 x-ob-meta.half
    let ob = null
    try { ob = JSON.parse(String(req.headers['x-ob-meta'] ?? 'null')) } catch { ob = null }
    if (ob && typeof ob === 'object') row.ob = { seq: ob.seq ?? null, half: ob.half ?? null, step: ob.step ?? null }
    const conv = String(req.headers['x-bili-plugin-conversation'] ?? req.headers['x-session-id'] ?? ob?.half ?? '')
    row.conv = conv ? sha256(conv).slice(0, 12) : ''
    row.rawBytes = raw.length
    const summary = isSummaryCall(body)
    row.kind = summary ? 'summary' : 'main'
    counters[row.kind]++
    if (summary && cfg.summaryPolicy === 'refuse') { counters.refused++; row.refused = 'summary-policy'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd: summary calls are not served in this run (summaryPolicy=refuse)') }
    if (summary && cfg.summaryPolicy === 'placeholder') {
      row.placeholder = true
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      return res.end(sseFromMessage({ id: 'msg_fwd_placeholder', model: target.model, content: [{ type: 'text', text: '（评测转发器：这次不做摘要）' }], stop_reason: 'end_turn' }, { input_tokens: 1, output_tokens: 1 }))
    }
    const images = countImages(body)
    const pinnedInput = pinnedInputTokens(raw.length, images)
    row.images = images
    row.pinnedInput = pinnedInput
    const tr = applyTransforms(body, cfg.transforms, { ownSignature: (s) => sigStore.isOwn(s), relDateFn: relDate.fn })
    row.transforms = tr.counts
    const breq = P.buildRequest(tr.body, target, { sigStore, incomingBeta: req.headers['anthropic-beta'], conversationKey: conv })
    row.protocol = breq.meta
    const payloadText = JSON.stringify(breq.payload)
    // callId 只看「发去哪儿、发了什么」：同一份 payload 换一种用量口径（--cache-from 离线重放）也认得出是同一次调用
    const upUrl = new URL(breq.url)
    const callId = sha256(`${provider}|${upUrl.host}${upUrl.pathname}|${conv}|${sha256(payloadText)}`)
    row.callId = callId
    row.payloadBytes = Buffer.byteLength(payloadText)
    if (cfg.saveWire) { const wf = join(wireDir, `${callId}.json`); if (!existsSync(wf)) writeAtomic(wf, JSON.stringify({ callId, fingerprintId: fpId, provider, model: target.model, transforms: tr.counts, payloadSha: sha256(payloadText), view: tr.body })) }
    // 只数 token：不看缓存、不预留、不发 /chat/completions（ob count-w）
    if (cfg.countOnly) return await handleCountOnly(res, { breq, tr, row, pinnedInput, payloadText })

    const cached = cacheGet(callId)
    if (cached && !cached.failed && cached.status >= 200 && cached.status < 300) { counters.cacheHits++; row.cache = 'hit'; return serve(res, cached, { replay: true, callId, pinnedInput, row }) }
    if (cached?.failed) { counters.refused++; row.refused = 'failed-before'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd: this call failed before; no retries') }
    if (cfg.offline) { counters.refused++; row.refused = 'offline-miss'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd: offline replay and this call is not in the cache') }
    row.cache = 'miss'

    // 闸 1：主机 / 端口
    const up = new URL(breq.url)
    const upPort = up.port ? Number(up.port) : (up.protocol === 'https:' ? 443 : 80)
    if (up.origin !== new URL(target.baseUrl).origin || !guard.egressAllowed(up.hostname, upPort)) { ledger.stop('host gate', 'host'); counters.refused++; row.refused = 'host-gate'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd_host_gate') }
    // 闸 2：隐私
    const pg = checkRequest(privacyCtx, breq.payload, tr.body)
    if (!pg.ok) { ledger.stop(`privacy: ${pg.problems.join('; ')}`, 'privacy'); counters.refused++; row.refused = 'privacy'; row.privacy = pg.problems; return sendJsonError(res, 400, 'invalid_request_error', `fwd_privacy: ${pg.problems.join('; ')}`) }
    // 闸 3：预算（先记 reserve）；DeepSeek 的余额过期了先重读（读不到就停，fail-closed）
    if (balance.enabled && !(await refreshBalance())) { ledger.stop(`provider: balance unreadable (${balance.error})`, 'provider'); counters.refused++; row.refused = 'budget:BALANCE_UNREADABLE'; return sendJsonError(res, 400, 'invalid_request_error', 'fwd_budget: BALANCE_UNREADABLE') }
    const maxTok = breq.payload.max_tokens ?? breq.payload.generationConfig?.maxOutputTokens ?? target.maxTokens ?? 0
    const rv = reserveOf(provider, pinnedInput, maxTok)
    row.reserve = rv.amount
    try { ledger.reserve({ provider, callId, amount: rv.amount, meta: { inputTokensEst: rv.inputTokensEst, maxTokens: maxTok, conv: row.conv } }) } catch (e) {
      if (e instanceof BudgetError) {
        // 余额到底了：整本账停（provider），人看过、充过值才 --unstop
        if (e.code === 'HEADROOM') ledger.stop(`provider: balance floor ${cfg.balanceFloor} reached`, 'provider')
        counters.refused++; row.refused = `budget:${e.code}`; return sendJsonError(res, 400, 'invalid_request_error', `fwd_budget: ${e.code}`)
      }
      throw e
    }

    // 发（不重试）
    if (cfg.countOnly) throw new FwdError('COUNT_ONLY', 'count-only forwarder never sends a completion')
    counters.sent++
    let ping = null
    const headers = { ...breq.headers, ...P.authHeaders(target, creds, { conversationKey: conv }) }
    let rec
    try {
      rec = await sendUpstream({
        url: breq.url, headers, body: payloadText, timeoutMs: cfg.upstreamTimeoutMs,
        onStatus: (st) => {
          if (st >= 200 && st < 300 && !res.headersSent) {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
            res.write(pingEvent())
            ping = setInterval(() => { try { res.write(pingEvent()) } catch {} }, cfg.pingMs)
          }
        },
      })
    } catch (e) {
      clearInterval(ping)
      counters.upstreamErrors++
      // 复核 A2：已经拿到状态码以后断的（phase stream）、超时的：输出那一截可能已经在算钱，按整份预留记；还没连上的按输入那一截
      const full = e.phase === 'stream' || e.code === 'TIMEOUT'
      row.charged = full ? 'reserve' : 'input'
      ledger.fail({ provider, callId, charged: full ? rv.amount : rv.inputPart, reason: `${e.code ?? 'NET'}${e.phase ? ':' + e.phase : ''}` })
      cachePut(callId, { callId, provider, failed: true, status: 0, error: e.code ?? 'NET', at: localIso() })
      row.error = e.code ?? 'NET'
      return sendJsonError(res, 400, 'api_error', `fwd: upstream ${e.code ?? 'network error'}`)
    }
    clearInterval(ping)
    Object.assign(row, { status: rec.status, ttfbMs: rec.ttfbMs, totalMs: rec.totalMs })
    if (rec.status < 200 || rec.status >= 300) {
      counters.upstreamErrors++
      let msg = ''
      try { const j = JSON.parse(rec.raw); msg = j.error?.message ?? j.message ?? j.detail ?? '' } catch { msg = rec.raw }
      ledger.fail({ provider, callId, charged: rv.inputPart, reason: `http ${rec.status}` })
      cachePut(callId, { callId, provider, failed: true, status: rec.status, error: scrub(msg), at: localIso() })
      row.error = `http ${rec.status}`
      row.upstreamMessage = scrub(msg)
      // 复核 A1：402 / 401 / 403、或者说余额不够的：整本账停（provider），不让后面每个半边各撞一次
      if ([401, 402, 403].includes(rec.status) || PROVIDER_STOP.test(String(msg))) { ledger.stop(`provider: http ${rec.status}`, 'provider'); row.providerStop = true }
      return sendJsonError(res, 400, 'invalid_request_error', `fwd: upstream ${rec.status}: ${scrub(msg)}`)
    }
    const stored = { callId, provider, model: target.model, status: rec.status, contentType: rec.contentType, raw: rec.raw, ttfbMs: rec.ttfbMs, totalMs: rec.totalMs, at: localIso() }
    cachePut(callId, stored)
    return serve(res, stored, { replay: false, callId, pinnedInput, reserve: rv, row })
  } catch (e) {
    const code = e instanceof FwdError ? e.code : 'INTERNAL'
    row.error = code
    counters.refused++
    return sendJsonError(res, 400, 'invalid_request_error', `fwd: ${code}: ${scrub(e.message)}`)
  } finally {
    logRow(row)
  }
}

function handleCountTokens (req, res) {
  readBody(req).then((raw) => {
    const body = JSON.parse(raw.toString('utf8'))
    const b = JSON.stringify({ input_tokens: pinnedInputTokens(raw.length, countImages(body)) })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(b)
  }).catch(() => sendJsonError(res, 400, 'invalid_request_error', 'fwd: bad count_tokens body'))
}

// ---- 内层：CONNECT 里面的那个 HTTPS 服务 ----
const inner = http.createServer((req, res) => {
  const path = String(req.url ?? '').split('?')[0]
  if (req.method === 'POST' && path === '/anthropic/v1/messages') return void handleMessages(req, res)
  if (req.method === 'POST' && path === '/anthropic/v1/messages/count_tokens') return handleCountTokens(req, res)
  sendJsonError(res, 404, 'not_found_error', `fwd: ${req.method} ${path} is not served`)
})
inner.keepAliveTimeout = 120_000

// ---- 外层：CONNECT 前门 + 控制口 ----
const token = randomToken()
const tokenFile = join(cfg.stateDir, 'control-token')
writeAtomic(tokenFile, token + '\n')
const certsDir = cfg.certsDir
const key = readFileSync(join(certsDir, 'leaf.key'))
const cert = readFileSync(join(certsDir, 'leaf.pem'))
const front = http.createServer(async (req, res) => {
  const path = String(req.url ?? '').split('?')[0]
  const json = (st, o) => { const b = JSON.stringify(o); res.writeHead(st, { 'content-type': 'application/json' }); res.end(b) }
  if (req.method === 'GET' && path === '/__fwd/health') return json(200, { ok: true, pid: process.pid, fingerprintId: fpId, provider, model: target.model, arm: cfg.arm, usageFeedback: cfg.usageFeedback, egressAllow: guard.allow, testMode: cfg.testMode, offline: cfg.offline, privacyIndex: privacyCtx.indexStats ?? null, stopped: ledger.stopped })
  // 明文回环入口（A 部分的 EgressFront 已经在它那边终止了 TLS，转到 <上游>/v1/messages）
  if (req.method === 'POST' && (path === '/v1/messages' || path === '/anthropic/v1/messages')) {
    if (cfg.plainHttp.requireToken && req.headers['x-fwd-token'] !== token) return json(403, { ok: false, reason: 'token' })
    return void handleMessages(req, res)
  }
  if (req.headers['x-fwd-token'] !== token) return json(403, { ok: false, reason: 'token' })
  if (req.method === 'GET' && path === '/__fwd/state') {
    const ua = { ...usageAudit, ratio: usageAudit.estInput > 0 ? Math.round((usageAudit.reportedInput / usageAudit.estInput) * 1000) / 1000 : null }
    return json(200, { fingerprintId: fpId, counters, ledger: ledger.summary(), usageAudit: ua, balance: balance.enabled ? { floor: cfg.balanceFloor, reads: balance.reads, readable: balance.value !== null, headroom: ledger.headroom(provider), error: balance.error } : null })
  }
  if (req.method === 'POST' && (path === '/__fwd/boundary' || path === '/__fwd/unstop')) {
    let b
    try { b = JSON.parse((await readBody(req, 1e6)).toString('utf8')) } catch { return json(400, { ok: false, reason: 'bad-json' }) }
    if (path === '/__fwd/unstop') {
      if (typeof b.reason !== 'string' || !b.reason) return json(400, { ok: false })
      // 只解给定的那几种（默认超支、提供方）；隐私 / 主机闸的停要调用方显式点名
      const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k) => STOP_KINDS.includes(k)) : ['overrun', 'provider']
      const r = ledger.unstop(b.reason, { kinds })
      return json(r.ok ? 200 : 409, r)
    }
    if (b.phase === 'begin' && balance.enabled && !(await refreshBalance())) ledger.stop(`provider: balance unreadable (${balance.error})`, 'provider')
    const r = ledger.boundary({ ...b, provider })
    return json(r.ok ? 200 : 409, r)
  }
  json(404, { ok: false })
})
// CONNECT 入口（复核 A6）：要 Proxy-Authorization: Basic base64("fwd:<控制口令>")；配置里 connectDoor:false 时一律不开
const connectAuth = 'Basic ' + Buffer.from(`fwd:${token}`).toString('base64')
front.on('connect', (req, socket, head) => {
  if (!cfg.connectDoor) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  if (req.headers['proxy-authorization'] !== connectAuth) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fwd"\r\n\r\n'); return }
  if (String(req.url).toLowerCase() !== 'api.deepseek.com:443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head?.length) socket.unshift(head)
  const t = new tls.TLSSocket(socket, { isServer: true, key, cert })
  t.on('error', () => { try { socket.destroy() } catch {} })
  inner.emit('connection', t)
})
front.listen(cfg.listen.port, '127.0.0.1', () => {
  const port = front.address().port
  writeAtomic(join(cfg.stateDir, 'forwarder.json'), JSON.stringify({ pid: process.pid, port, fingerprintId: fpId, startedAt: localIso() }) + '\n')
  process.stdout.write(JSON.stringify({ ready: true, port, fingerprintId: fpId, provider, model: target.model, tokenFile, connectDoor: cfg.connectDoor, privacyIndex: privacyCtx.indexStats ?? null }) + '\n')
})
const shutdown = () => { front.close(); inner.close(); setTimeout(() => process.exit(0), 200).unref() }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
