// 转发器的端到端测试（只在回环上）：假上游四家协议 + 真的转发器进程（带出网闸、testMode）+ 这个脚本扮代理拷贝，
// 经 CONNECT api.deepseek.com:443 + 一次性测试 CA 发 Anthropic 请求。
// 用法（经 run-exclusive，套 offline-guard + netguard，回环也不许碰 18780–18799）：
//   node tools/run-exclusive.mjs fwd-e2e -- node --import <offline-guard> --import <netguard> evals/open-book-eval/fwd/tests/test-e2e.mjs [<临时目录>]
//   不给临时目录时自己在系统临时目录下建一个，跑完删掉。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { startFakeProvider } from '../fake-provider.mjs'
import { parseSSE, assembleMessage } from '../../lib/sse.mjs'
import { countImages, pinnedInputTokens } from '../lib/usage.mjs'
import { numberHash } from '../lib/privacy-gate.mjs'
import { readJsonl } from '../lib/util.mjs'

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)))
// 没给临时目录时自己在系统临时目录下建一个，跑完删掉（CI 不带参数跑）。
const TMPAuto = process.argv[2] ? null : mkdtempSync(join(tmpdir(), 'open-book-eval-e2e-'))
if (TMPAuto) process.on('exit', () => { try { rmSync(TMPAuto, { recursive: true, force: true }) } catch {} })
const TMP = process.argv[2] || TMPAuto
mkdirSync(TMP, { recursive: true })
if (readdirSync(TMP).length) { console.error('tmpdir must be empty'); process.exit(2) }

let pass = 0
let fail = 0
const t = async (name, fn) => { try { await fn(); pass++; console.log(`PASS ${name}`) } catch (e) { fail++; console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`) } }

// ---- 证书 ----
const certs = join(TMP, 'certs')
const mk = spawnSync(process.execPath, [join(HERE, 'make-test-ca.mjs'), certs], { encoding: 'utf8' })
if (mk.status !== 0) { console.error('make-test-ca failed', mk.stderr); process.exit(2) }
const CA = readFileSync(join(certs, 'ca.pem'))

// ---- 假上游 ----
const fake = await startFakeProvider({})
const fakeStrict = await startFakeProvider({ rejectMidSystem: true, maxModelLen: 6000 })
const fakeCount = (f) => f.requests.length

// ---- 起转发器 ----
const procs = []
async function startFwd (name, cfgOver, { expectFail = false } = {}) {
  const stateDir = cfgOver.stateDir ?? join(TMP, 'state', name)
  const cfg = { stateDir, certsDir: certs, testMode: true, pingMs: 200, upstreamTimeoutMs: 20000, ...cfgOver }
  const file = join(TMP, `cfg-${name}-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(cfg, null, 1))
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(HERE, 'lib', 'egress-guard.mjs')).href, join(HERE, 'forwarder.mjs'), '--config', file],
    { env: { ...process.env, FWD_EGRESS_ALLOW: '', FWD_EGRESS_LOG: join(TMP, `egress-${name}.log`) }, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(child)
  let out = ''
  let err = ''
  child.stderr.on('data', (c) => { err += c })
  return await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`forwarder ${name} did not start: ${err}`)), 20000)
    child.on('exit', (code) => { clearTimeout(timer); if (expectFail) res({ exited: code, err }); else rej(new Error(`forwarder ${name} exited ${code}: ${err}`)) })
    child.stdout.on('data', (c) => {
      out += c
      const line = out.split('\n')[0]
      if (out.includes('\n')) {
        clearTimeout(timer)
        const r = JSON.parse(line)
        const token = readFileSync(join(stateDir, 'control-token'), 'utf8').trim()
        TOKENS.set(r.port, token)
        res({ ...r, stateDir, child, token, stop: () => new Promise((d) => { child.once('exit', d); child.kill() }) })
      }
    })
  })
}

// ---- 扮代理拷贝：CONNECT + TLS（只认测试 CA）----
// 复核 A6：CONNECT 要 Proxy-Authorization: Basic base64("fwd:<控制口令>")（undici 的 ProxyAgent 对 http://fwd:<口令>@… 就这么发）
const TOKENS = new Map()
const proxyAuth = (port) => 'Basic ' + Buffer.from('fwd:' + (TOKENS.get(port) ?? '')).toString('base64')
function viaConnect (port, path, bodyObj, headers = {}) {
  const body = JSON.stringify(bodyObj)
  return new Promise((resolveP, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'api.deepseek.com:443', headers: { 'proxy-authorization': proxyAuth(port) } })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error(`CONNECT ${res.statusCode}`)); return }
      const tsock = tls.connect({ socket, servername: 'api.deepseek.com', ca: CA })
      const r2 = http.request({ host: '127.0.0.1', port, path, method: 'POST', createConnection: () => tsock, headers: { host: 'api.deepseek.com', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'anthropic-version': '2023-06-01', 'x-dsh-auth-token': 'placeholder-from-fake-host', ...headers } }, (resp) => {
        const ch = []
        resp.on('data', (c) => ch.push(c))
        resp.on('end', () => { resolveP({ status: resp.statusCode, text: Buffer.concat(ch).toString('utf8') }); socket.destroy() })
      })
      r2.on('error', reject)
      r2.end(body)
    })
    req.on('error', reject)
    req.end()
  })
}
const control = (port, token, method, path, body) => new Promise((res, rej) => {
  const b = body ? JSON.stringify(body) : null
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(token ? { 'x-fwd-token': token } : {}), ...(b ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) } : {}) } }, (resp) => { const ch = []; resp.on('data', (c) => ch.push(c)); resp.on('end', () => res({ status: resp.statusCode, json: JSON.parse(Buffer.concat(ch).toString('utf8') || '{}') })) })
  r.on('error', rej); r.end(b ?? undefined)
})
const MSG = '/anthropic/v1/messages'
const reply = (r) => assembleMessage(parseSSE(r.text))

// ---- 合成的请求体（DeepSeek-Anthropic 视图的样子；内容全是编的） ----
const SYS_TAIL = { role: 'system', content: [{ type: 'text', text: '你叫小测试，主人是你的主人。', cache_control: { type: 'ephemeral' } }] }
const TOOLS = [{ name: 'im_send', description: '发消息', input_schema: { type: 'object', properties: { to: { type: 'string' } } } }, { name: 'search_context', description: '搜上下文', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]
function convo (lastUser, extra = []) {
  return {
    model: 'deepseek-flash', max_tokens: 256000, stream: true, thinking: { type: 'enabled' }, output_config: { effort: 'max' },
    system: [{ type: 'text', text: '系统：这是合成的测试世界。' }], tools: TOOLS,
    messages: [
      { role: 'user', content: '主人：今天天气不错。' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'DeepSeek 想的', signature: 'ds-native-1' }, { type: 'text', text: '是呀。' }] },
      { role: 'user', content: [{ type: 'text', text: '看图，路径 C:\\Users\\someone\\Pictures\\a.png' }, { type: 'image', source: { type: 'file', file_id: 'file-expired' } }] },
      { role: 'assistant', content: [{ type: 'text', text: '看到了。' }] },
      ...extra,
      { role: 'user', content: lastUser },
      { role: 'user', content: '这是一条提醒你早点整理、让上下文保持轻一点的话，不是说已经满了。' },
      SYS_TAIL,
    ],
  }
}
const REAL = { arm: 'real', transforms: { images: 'placeholder', stripForeignThinking: true, localPaths: true }, approvalsFile: join(TMP, 'approvals.json') }
writeFileSync(join(TMP, 'approvals.json'), JSON.stringify({ date: '2026-11-19', providers: ['anthropic', 'gemini', 'openai', 'deepseek'], arms: ['real'], note: 'test only' }))
const HDR = { 'x-bili-plugin-conversation': 'conv-test-1' }

try {
  // ======== Anthropic ========
  const A = await startFwd('anthropic', { ...REAL, target: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: `http://127.0.0.1:${fake.port}`, effort: 'high', maxTokens: 64000, anthropic: { blockBinding: 'drop_block' } }, caps: { anthropic: 50 }, usageFeedback: 'pinned' })
  let turn1Body
  let turn1Reply
  await t('anthropic: turn 1 through CONNECT, transforms applied, pinned usage', async () => {
    turn1Body = convo('主人：在吗？')
    const before = fakeCount(fake)
    const r = await viaConnect(A.port, MSG, turn1Body, HDR)
    assert.equal(r.status, 200, r.text)
    const m = reply(r)
    assert.equal(m.ok, true)
    turn1Reply = m.message
    assert.equal(m.message.content.at(-1).text, '好的，主人。')
    const raw = Buffer.byteLength(JSON.stringify(turn1Body))
    assert.equal(m.message.usage.input_tokens, pinnedInputTokens(raw, countImages(turn1Body)))
    assert.equal(fakeCount(fake), before + 1)
    const sent = fake.requests.at(-1)
    assert.equal(sent.body.model, 'claude-opus-5-5')
    assert.deepEqual(sent.body.output_config, { effort: 'high' })
    assert.equal(sent.body.thinking.type, 'adaptive')
    const s = JSON.stringify(sent.body)
    assert.ok(!s.includes('ds-native-1'), 'DeepSeek thinking leaked')
    assert.ok(!s.includes('file-expired'), 'file image leaked')
    assert.ok(!s.includes('someone'), 'path leaked')
    assert.ok(!s.includes('提醒你早点整理'), 'nudge leaked')
    assert.equal(sent.headers.auth, true)
    assert.ok(String(sent.headers.beta).includes('thinking-binding-controls'))
  })
  let turn2Body
  let turn2Text
  await t('anthropic: turn 2 keeps its own thinking, strips DeepSeek thinking', async () => {
    const asst = { role: 'assistant', content: turn1Reply.content }
    turn2Body = convo('[[tool]] 主人：帮我搜一下', [{ role: 'user', content: '主人：在吗？' }, asst])
    const r = await viaConnect(A.port, MSG, turn2Body, HDR)
    turn2Text = r.text
    assert.equal(r.status, 200, r.text)
    const m = reply(r)
    assert.equal(m.message.stop_reason, 'tool_use')
    const s = JSON.stringify(fake.requests.at(-1).body)
    assert.ok(s.includes('ant-sig-'), 'own Opus thinking dropped')
    assert.ok(!s.includes('ds-native-1'))
  })
  await t('anthropic: identical request is a cache hit (no new upstream call, same bytes)', async () => {
    const before = fakeCount(fake)
    const r = await viaConnect(A.port, MSG, turn2Body, HDR)
    assert.equal(r.status, 200)
    assert.equal(fakeCount(fake), before)
    const noPing = (x) => x.split('\n\n').filter((c) => !c.startsWith('event: ping')).join('\n\n')
    assert.equal(noPing(r.text), noPing(turn2Text))
    const st = await control(A.port, A.token, 'GET', '/__fwd/state')
    assert.equal(st.json.counters.cacheHits, 1)
    assert.ok(st.json.ledger.providers.anthropic.settled > 0)
  })
  await t('anthropic: refusal passes through with stop_details', async () => {
    const r = await viaConnect(A.port, MSG, convo('[[refuse]] 主人：说点别的'), HDR)
    const m = reply(r)
    assert.equal(m.message.stop_reason, 'refusal')
    assert.ok(r.text.includes('stop_details'))
  })
  await t('anthropic: upstream 500 → 400 to the proxy, charged, never retried', async () => {
    const b = convo('[[error500]] 主人：再试')
    const r = await viaConnect(A.port, MSG, b, HDR)
    assert.equal(r.status, 400)
    assert.ok(r.text.includes('upstream 500'))
    const before = fakeCount(fake)
    const r2 = await viaConnect(A.port, MSG, b, HDR)
    assert.equal(r2.status, 400)
    assert.ok(r2.text.includes('failed before'))
    assert.equal(fakeCount(fake), before)
    const st = await control(A.port, A.token, 'GET', '/__fwd/state')
    assert.ok(st.json.ledger.providers.anthropic.failedCalls >= 1)
  })
  await t('anthropic: stream cut mid-way → error, charged', async () => {
    const r = await viaConnect(A.port, MSG, convo('[[cut]] 主人：讲个故事'), HDR)
    assert.ok(r.status === 400 || r.text.includes('event: error'), r.text.slice(0, 200))
  })
  await t('control: token required; boundary refuses a question the budget cannot cover', async () => {
    assert.equal((await control(A.port, null, 'GET', '/__fwd/state')).status, 403)
    assert.equal((await control(A.port, 'wrong', 'GET', '/__fwd/state')).status, 403)
    const h = await control(A.port, null, 'GET', '/__fwd/health')
    assert.equal(h.json.ok, true)
    assert.deepEqual(h.json.egressAllow, [])
    const ok = await control(A.port, A.token, 'POST', '/__fwd/boundary', { kind: 'question', phase: 'begin', id: 'q-small', plannedCalls: 2, estPerCall: 0.01 })
    assert.equal(ok.status, 200)
    await control(A.port, A.token, 'POST', '/__fwd/boundary', { kind: 'question', phase: 'end', id: 'q-small' })
    const no = await control(A.port, A.token, 'POST', '/__fwd/boundary', { kind: 'question', phase: 'begin', id: 'q-big', plannedCalls: 1000, estPerCall: 1 })
    assert.equal(no.status, 409)
    assert.equal(no.json.reason, 'insufficient-budget')
  })
  await t('calls.jsonl has metadata only (no message text, no key)', async () => {
    const rows = readJsonl(join(A.stateDir, 'calls.jsonl'))
    assert.ok(rows.length >= 6)
    const s = JSON.stringify(rows)
    assert.ok(!s.includes('主人：') && !s.includes('test-key-not-real'))
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.fingerprintId)))
  })
  await A.stop()

  await t('fingerprint: same state dir with a different config refuses to start', async () => {
    const r = await startFwd('anthropic-mismatch', { ...REAL, stateDir: A.stateDir, target: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: `http://127.0.0.1:${fake.port}`, effort: 'max', maxTokens: 64000 }, caps: { anthropic: 50 } }, { expectFail: true })
    assert.equal(r.exited, 2)
    assert.ok(r.err.includes('bound to fingerprint'))
  })
  await t('offline replay with real usage reuses the cache, refuses misses', async () => {
    const R = await startFwd('anthropic-replay', { ...REAL, offline: true, cacheFrom: A.stateDir, usageFeedback: 'real', target: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: `http://127.0.0.1:${fake.port}`, effort: 'high', maxTokens: 64000, anthropic: { blockBinding: 'drop_block' } }, caps: {} })
    const before = fakeCount(fake)
    const r = await viaConnect(R.port, MSG, turn2Body, HDR)
    assert.equal(r.status, 200, r.text)
    const m = reply(r)
    assert.notEqual(m.message.usage.input_tokens, reply({ text: turn2Text }).message.usage.input_tokens, 'real usage should differ from pinned')
    assert.equal(fakeCount(fake), before)
    const miss = await viaConnect(R.port, MSG, convo('主人：没发过的话'), HDR)
    assert.equal(miss.status, 400)
    assert.ok(miss.text.includes('offline'))
    await R.stop()
  })
  await t('budget cap: tiny cap refuses before sending', async () => {
    const B = await startFwd('anthropic-cap', { ...REAL, target: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: `http://127.0.0.1:${fake.port}`, effort: 'high', maxTokens: 64000 }, caps: { anthropic: 0.0001 } })
    const before = fakeCount(fake)
    const r = await viaConnect(B.port, MSG, convo('主人：贵吗'), HDR)
    assert.equal(r.status, 400)
    assert.ok(r.text.includes('fwd_budget: CAP'))
    assert.equal(fakeCount(fake), before)
    await B.stop()
  })

  // ======== Gemini ========
  const G = await startFwd('gemini', { ...REAL, target: { provider: 'gemini', model: 'gemini-4-argon', baseUrl: `http://127.0.0.1:${fake.port}`, thinkingLevel: 'LOW', maxTokens: 32768 }, caps: { gemini: 50 } })
  await t('gemini: tool round trip keeps the functionCall thought signature', async () => {
    const r1 = await viaConnect(G.port, MSG, convo('[[tool]] 主人：搜一下'), HDR)
    assert.equal(r1.status, 200, r1.text)
    const m1 = reply(r1).message
    const tu = m1.content.find((b) => b.type === 'tool_use')
    assert.ok(tu && tu.id.startsWith('fc_'))
    const b2 = convo('主人：好了吗', [{ role: 'user', content: '[[tool]] 主人：搜一下' }, { role: 'assistant', content: m1.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '{"hits":1}' }] }, { role: 'assistant', content: [{ type: 'text', text: '找到一条。' }] }])
    const r2 = await viaConnect(G.port, MSG, b2, HDR)
    assert.equal(r2.status, 200, r2.text) // 假上游会核 functionCall 上的 gsig- 签名，没挂回去就是 400
    const sent = fake.requests.at(-1).body
    assert.ok(sent.systemInstruction)
    assert.ok(JSON.stringify(sent.contents).includes('gsig-call-'))
    assert.ok(JSON.stringify(sent.contents).includes('gsig-thought-'))
    assert.equal(reply(r2).message.content.at(-1).text, '好的，主人。')
  })
  await t('gemini: SAFETY → refusal', async () => {
    const m = reply(await viaConnect(G.port, MSG, convo('[[refuse]] 主人：…'), HDR)).message
    assert.equal(m.stop_reason, 'refusal')
  })
  await G.stop()

  // ======== OpenAI / vLLM（合成臂：隐私闸全开） ========
  const snap = join(TMP, 'snap')
  mkdirSync(join(snap, 'files', 'sessions'), { recursive: true })
  writeFileSync(join(snap, 'files', 'diary.md'), '今天和主人一起去河边散步看见很多白鹭在浅水里找吃的\n')
  writeFileSync(join(snap, 'files', 'sessions', 's.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify({ t: '我们约好周末去城东那家面馆吃牛肉面加一个煎蛋' }) + '\n')))
  writeFileSync(join(snap, 'deny-hashes.json'), JSON.stringify({ salt: 'e2e', hashes: [numberHash('e2e', '987654321')] }))
  const SYN = { arm: 'synthetic', transforms: { stripForeignThinking: true }, privacy: { snapshotDir: snap, toolNames: ['im_send', 'search_context'] } }
  const synConvo = (u, extra = []) => {
    const b = convo(u, extra)
    b.messages[2] = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }
    return b
  }
  const oaiTarget = (port, over = {}) => ({ provider: 'openai', model: 'scarletkc', baseUrl: `http://127.0.0.1:${port}/v1`, maxTokens: 1024, sampling: { temperature: 0.6, top_p: 0.95 }, openai: { reasoningInField: 'reasoning_content', midSystem: 'to-user', enableThinking: true, maxImages: 128, ...over } })
  const O = await startFwd('openai', { ...SYN, target: oaiTarget(fake.port), caps: {}, servingStackFile: null })
  await t('openai: reasoning back as thinking, own reasoning replayed, serving stack in fingerprint', async () => {
    const r1 = await viaConnect(O.port, MSG, synConvo('主人：你好'), HDR)
    assert.equal(r1.status, 200, r1.text)
    const m1 = reply(r1).message
    assert.equal(m1.content[0].type, 'thinking')
    const r2 = await viaConnect(O.port, MSG, synConvo('主人：再说一句', [{ role: 'user', content: '主人：你好' }, { role: 'assistant', content: m1.content }]), HDR)
    assert.equal(r2.status, 200, r2.text)
    const sent = fake.requests.at(-1).body
    assert.ok(sent.messages.some((m) => m.role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content.startsWith('想一想')))
    assert.ok(sent.messages.every((m, i) => i === 0 || m.role !== 'system'))
    assert.equal(sent.chat_template_kwargs.enable_thinking, true)
    assert.equal(sent.temperature, 0.6)
    const fp = JSON.parse(readFileSync(join(O.stateDir, 'fingerprint.json'), 'utf8'))
    assert.equal(fp.fingerprint.servingStack.live.max_model_len, 262144)
  })
  await t('openai: slow first byte gets pings, still completes', async () => {
    const r = await viaConnect(O.port, MSG, synConvo('[[slow:1200]] 主人：慢慢来'), HDR)
    assert.equal(r.status, 200)
    assert.equal(reply(r).ok, true)
  })
  await t('openai: 129 images refused by the forwarder itself', async () => {
    const b = synConvo('主人：看这么多图')
    b.messages.splice(0, 0, { role: 'user', content: Array.from({ length: 129 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } })) })
    const before = fakeCount(fake)
    const r = await viaConnect(O.port, MSG, b, HDR)
    assert.equal(r.status, 400)
    assert.ok(r.text.includes('TOO_MANY_IMAGES'))
    assert.equal(fakeCount(fake), before)
  })
  await t('privacy: a fragment of her records stops the run before sending', async () => {
    const before = fakeCount(fake)
    const r = await viaConnect(O.port, MSG, synConvo('主人说：我们约好周末去城东那家面馆吃牛肉面'), HDR)
    assert.equal(r.status, 400)
    assert.ok(r.text.includes('fwd_privacy'))
    assert.equal(fakeCount(fake), before)
    const r2 = await viaConnect(O.port, MSG, synConvo('主人：换个话题'), HDR)
    assert.ok(r2.text.includes('fwd_budget: STOPPED'))
  })
  await O.stop()
  const OS = await startFwd('openai-strict', { ...SYN, target: oaiTarget(fakeStrict.port, { midSystem: 'keep', maxImages: 200 }), caps: {} })
  await t('vLLM shapes: mid-conversation system rejected (keep mode), too long, >128 images', async () => {
    const r = await viaConnect(OS.port, MSG, synConvo('主人：一'), HDR)
    assert.equal(r.status, 400, r.text)
    assert.ok(r.text.includes('System message must be at the beginning'), r.text)
    const big = synConvo('主人：二')
    big.messages.splice(-1, 1) // 去掉结尾的 system，免得先撞上那一条
    big.messages[0] = { role: 'user', content: '很长'.repeat(12000) }
    const r2 = await viaConnect(OS.port, MSG, big, HDR)
    assert.equal(r2.status, 400, r2.text)
    assert.ok(r2.text.includes('maximum context length'), r2.text)
    const many = synConvo('主人：三')
    many.messages.splice(-1, 1)
    many.messages.splice(0, 0, { role: 'user', content: Array.from({ length: 129 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } })) })
    const r3 = await viaConnect(OS.port, MSG, many, HDR)
    assert.equal(r3.status, 400, r3.text)
    assert.ok(r3.text.includes('At most 128 image(s)'), r3.text)
  })
  await OS.stop()

  // ======== DeepSeek 原样 ========
  const D = await startFwd('deepseek', { arm: 'real', approvalsFile: join(TMP, 'approvals.json'), transforms: { images: 'placeholder' }, target: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: `http://127.0.0.1:${fake.port}`, deepseek: { auth: 'account' } }, caps: { deepseek: 1000 } })
  await t('deepseek: as-is with account headers, reply bytes passed through', async () => {
    const b = convo('主人：晚安')
    const r = await viaConnect(D.port, MSG, b, HDR)
    assert.equal(r.status, 200, r.text)
    const sent = fake.requests.at(-1)
    assert.equal(sent.proto, 'deepseek')
    assert.equal(sent.headers.dshUser, true)
    assert.ok(/^[0-9a-f-]{36}$/.test(sent.headers.dshSession))
    assert.ok(JSON.stringify(sent.body).includes('ds-native-1'), 'DeepSeek keeps its own thinking')
    assert.ok(!JSON.stringify(sent.body).includes('提醒你早点整理'))
    assert.ok(r.text.includes('ds-sig-'))
  })
  await t('plain loopback entry (/v1/messages, as EgressFront sends): token required by default', async () => {
    const b = JSON.stringify(convo('主人：明文入口'))
    const post = (headers) => new Promise((res, rej) => {
      const r = http.request({ host: '127.0.0.1', port: D.port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'x-ob-meta': JSON.stringify({ seq: 1, half: 'h-test', step: 1 }), ...headers } }, (resp) => { const ch = []; resp.on('data', (c) => ch.push(c)); resp.on('end', () => res({ status: resp.statusCode, text: Buffer.concat(ch).toString('utf8') })) })
      r.on('error', rej); r.end(b)
    })
    const before = fakeCount(fake)
    assert.equal((await post({})).status, 403)
    assert.equal(fakeCount(fake), before)
    const ok = await post({ 'x-fwd-token': D.token })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(fakeCount(fake), before + 1)
    const rows = readJsonl(join(D.stateDir, 'calls.jsonl'))
    assert.equal(rows.at(-1).ob.half, 'h-test')
  })

  // ======== 复核 11-19：A6 CONNECT 口令、A2 半截流、A3 没用量、A1 402 停账 ========
  const connectStatus = (port, headers = {}) => new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'api.deepseek.com:443', headers })
    req.on('connect', (r, s) => { s.destroy(); res(r.statusCode) })
    req.on('response', (r) => res(r.statusCode))
    req.on('error', rej)
    req.end()
  })
  const ledgerRows = (F) => readJsonl(join(F.stateDir, 'spend-ledger.jsonl'))
  const reserveOfCall = (rows, callId) => rows.find((r) => r.type === 'reserve' && r.callId === callId)?.amount
  await t('CONNECT without / with a wrong Proxy-Authorization → 407, nothing upstream (A6)', async () => {
    const before = fakeCount(fake)
    assert.equal(await connectStatus(D.port), 407)
    assert.equal(await connectStatus(D.port, { 'proxy-authorization': 'Basic ' + Buffer.from('fwd:wrong').toString('base64') }), 407)
    assert.equal(await connectStatus(D.port, { 'proxy-authorization': proxyAuth(D.port) }), 200)
    assert.equal(fakeCount(fake), before)
  })
  await t('[[nostop]]: stream ends without message_stop → error, full reserve charged (A2)', async () => {
    await viaConnect(D.port, MSG, convo('[[nostop]] 主人：说一半'), HDR)
    const rows = ledgerRows(D)
    const f = rows.filter((r) => r.type === 'fail').at(-1)
    assert.ok(f && /^stream:/.test(f.reason), JSON.stringify(f))
    assert.equal(f.charged, reserveOfCall(rows, f.callId), 'charged the whole reserve')
  })
  await t('[[nousage]]: zero usage → settled at the reserve, marked estimate-no-usage (A3)', async () => {
    const r = await viaConnect(D.port, MSG, convo('[[nousage]] 主人：没用量'), HDR)
    assert.equal(r.status, 200, r.text)
    const rows = ledgerRows(D)
    const s = rows.filter((x) => x.type === 'settle').at(-1)
    assert.equal(s.source, 'estimate-no-usage')
    assert.equal(s.cost, reserveOfCall(rows, s.callId))
    const st = (await control(D.port, D.token, 'GET', '/__fwd/state')).json
    assert.ok(st.usageAudit.noUsage >= 1)
  })
  await t('[[http402]]: provider stop; next call refused before upstream; unstop provider kind ok (A1)', async () => {
    await viaConnect(D.port, MSG, convo('[[http402]] 主人：没钱了'), HDR)
    const st = (await control(D.port, D.token, 'GET', '/__fwd/state')).json
    assert.equal(st.ledger.stopped?.kind, 'provider', JSON.stringify(st.ledger.stopped))
    const before = fakeCount(fake)
    await viaConnect(D.port, MSG, convo('主人：再试一次'), HDR)
    assert.equal(fakeCount(fake), before, 'refused without reaching upstream')
    const u = await control(D.port, D.token, 'POST', '/__fwd/unstop', { reason: 'test: topped up' })
    assert.equal(u.status, 200)
  })
  await D.stop()

  // ======== 复核 A1：DeepSeek 余额底（假上游的 /user/balance） ========
  await t('balance floor: unreadable balance → forwarder refuses to start (fail-closed)', async () => {
    await fetch(`http://127.0.0.1:${fake.port}/__fake/balance`, { method: 'POST', body: JSON.stringify({ total: 'fail' }) })
    const r = await startFwd('ds-bal-fail', { arm: 'real', approvalsFile: join(TMP, 'approvals.json'), transforms: { images: 'placeholder' }, target: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: `http://127.0.0.1:${fake.port}`, deepseek: { auth: 'account' } }, caps: { deepseek: 10 }, balanceFloor: 1 }, { expectFail: true })
    assert.notEqual(r.exited, 0)
    assert.ok(/balance/i.test(r.err))
  })
  await t('balance floor: balance just above the floor → a call that needs more is refused, ledger stops (provider)', async () => {
    await fetch(`http://127.0.0.1:${fake.port}/__fake/balance`, { method: 'POST', body: JSON.stringify({ total: 100, available: true }) })
    const DB = await startFwd('ds-bal', { arm: 'real', approvalsFile: join(TMP, 'approvals.json'), transforms: { images: 'placeholder' }, target: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: `http://127.0.0.1:${fake.port}`, deepseek: { auth: 'account' } }, caps: { deepseek: 10 }, balanceFloor: 99.999999 })
    try {
      const before = fakeCount(fake)
      await viaConnect(DB.port, MSG, convo('主人：贵吗'), HDR)
      assert.equal(fakeCount(fake), before, 'nothing sent upstream')
      const st = (await control(DB.port, DB.token, 'GET', '/__fwd/state')).json
      assert.equal(st.ledger.stopped?.kind, 'provider')
      assert.ok(st.balance && st.balance.readable === true && st.balance.reads >= 1)
    } finally { await DB.stop() }
  })
  // ======== 复核 A7：真数据臂的许可 v2（strict 时对不上就不起） ========
  await t('approvals v2: grant for another view sha → strict forwarder refuses to start', async () => {
    const ap2 = join(TMP, 'approvals-v2.json')
    writeFileSync(ap2, JSON.stringify({ v: 2, expires: '2099-01-01T00:00:00+08:00', grants: [{ id: 'g', providers: ['anthropic'], arms: ['W-O1-opus/*'], data: { viewRawSha: 'not-this-one', questionSetSha: 'q' } }] }))
    const r = await startFwd('ap-v2', { arm: 'real', strict: true, armId: 'W-O1-opus/o1', approvalsFile: ap2, transforms: { images: 'placeholder' }, target: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: `http://127.0.0.1:${fake.port}`, effort: 'high', maxTokens: 64000, anthropic: { blockBinding: 'drop_block' } }, caps: { anthropic: 1 }, fingerprintExtra: { proxy: { buildSha: 'x' }, gate: { audienceSha: 'g', mode: 'audit' }, search: { kernel: 'substring' }, reldate: { enabled: false }, executorSha: 'x', judge: { models: [] }, view: { kind: 'w-1115', rawSha: 'abc' }, questions: { setSha: 'q' } } }, { expectFail: true })
    assert.notEqual(r.exited, 0)
    assert.ok(/approval/.test(r.err), r.err.slice(0, 200))
  })
} finally {
  for (const p of procs) { try { p.kill() } catch {} }
  await fake.close()
  await fakeStrict.close()
}
// 出网闸：testMode 下名单为空，所有转发器只连过回环
for (const f of readdirSync(TMP).filter((n) => n.startsWith('egress-'))) {
  const rows = readJsonl(join(TMP, f))
  if (rows.some((r) => r.kind === 'allow-connect' || (r.host && !/^(127\.0\.0\.1|localhost)$/.test(r.host) && r.kind !== 'deny-dns'))) { fail++; console.log(`FAIL egress log ${f} shows a non-loopback attempt`) }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
