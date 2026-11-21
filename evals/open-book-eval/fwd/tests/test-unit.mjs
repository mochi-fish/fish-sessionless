// 转发器的单元测试（不起服务、不出网）。用法：node fwd/tests/test-unit.mjs [<临时目录>]
// 输出 PASS / FAIL 行，有失败退出码 1。临时目录必须是新的或空的（测试会往里写）；不给就自己在系统临时目录下建一个，跑完删掉。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { applyTransforms, normalizeTransformConfig, PATH_RE } from '../lib/transforms.mjs'
import { buildCorpusIndex, checkRequest, compileTemplates, makeGramChecker, loadDenyHashes, numberHash, CRED_RE, matchApproval, templateSegments, toolResultStrings } from '../lib/privacy-gate.mjs'
import { SpendLedger, BudgetError } from '../lib/spend-ledger.mjs'
import { acquireDirLock, acquirePaidLock, acquireSelfHostLock, globalSpend, processCommandLine, SELFHOST_LOCK } from '../lib/global-spend.mjs'
import { buildFingerprint, bindRunDir, assertSameFingerprint, FingerprintError } from '../lib/fingerprint.mjs'
import { K_TEXT, pinnedInputTokens, normalizeUsage, toAnthropicUsage, countImages } from '../lib/usage.mjs'
import { costOf, reserveOf } from '../lib/prices.mjs'
import { canonicalJson } from '../lib/util.mjs'
import { parseYamlSubset } from '../lib/credentials.mjs'
import { loadConfig } from '../lib/config.mjs'
import { MemorySigStore } from '../lib/sig-store.mjs'
import { zstdDecompressAll } from '../lib/zstd-frames.mjs'
import { FwdError } from '../lib/protocols/common.mjs'
import * as anthropic from '../lib/protocols/anthropic.mjs'
import * as gemini from '../lib/protocols/gemini.mjs'
import * as openai from '../lib/protocols/openai.mjs'
import * as deepseek from '../lib/protocols/deepseek.mjs'
import { sseFromMessage } from '../lib/anthropic-sse.mjs'
import { parseSSE, assembleMessage } from '../../lib/sse.mjs'

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)))
// 没给临时目录时自己在系统临时目录下建一个，跑完删掉（CI 不带参数跑）。
const TMPAuto = process.argv[2] ? null : mkdtempSync(join(tmpdir(), 'open-book-eval-unit-'))
if (TMPAuto) process.on('exit', () => { try { rmSync(TMPAuto, { recursive: true, force: true }) } catch {} })
const TMP = process.argv[2] || TMPAuto
mkdirSync(TMP, { recursive: true })
if (readdirSync(TMP).length) { console.error('tmpdir must be empty'); process.exit(2) }

let pass = 0
let fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`) } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`) } }

// ---------- 样本：一份合成的 DeepSeek-Anthropic 请求体（主人 / 她 / 来客，全是编的） ----------
const SYS_TAIL = { role: 'system', content: [{ type: 'text', text: '你叫小测试。主人是你的主人。', cache_control: { type: 'ephemeral' } }] }
function sample () {
  return {
    model: 'deepseek-flash', max_tokens: 256000, stream: true, thinking: { type: 'enabled' }, output_config: { effort: 'max' },
    system: [{ type: 'text', text: '系统提示：这是合成的世界。' }],
    tools: [{ name: 'im_send', description: '发消息到 C:\\Users\\someone\\.dsh-fish\\home', input_schema: { type: 'object', properties: { to: { type: 'string' } } } }, { name: 'search_context', description: '搜上下文', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: '主人：今天去公园看见一只来客养的狗，叫豆豆。' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'DeepSeek 的思考', signature: 'deepseek-native-sig' }, { type: 'text', text: '豆豆听起来很可爱。' }] },
      { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', source: { type: 'file', file_id: 'file-old-1' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '只有思考', signature: 'deepseek-native-2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a1', name: 'search_context', input: { q: '豆豆' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: [{ type: 'text', text: '结果在 /c/Users/someone/notes.md' }, { type: 'image', source: { type: 'file', file_id: 'file-old-2' } }] }] },
      { role: 'user', content: '这是一条提醒你早点整理、让上下文保持轻一点的话，不是说已经满了。' },
      SYS_TAIL,
    ],
  }
}

// ---------- 变换 ----------
t('transforms: strip nudge / images / foreign thinking / paths; counts', () => {
  const cfg = normalizeTransformConfig({ images: 'placeholder', stripForeignThinking: true, localPaths: true })
  const orig = sample()
  const before = canonicalJson(orig)
  const { body, counts } = applyTransforms(orig, cfg, { ownSignature: () => false })
  assert.equal(canonicalJson(orig), before, 'original mutated')
  assert.equal(counts.nudgeMessages, 1)
  assert.equal(counts.imagesReplaced, 2)
  assert.equal(counts.foreignThinking, 2)
  assert.equal(counts.emptyAssistantDropped, 1)
  assert.ok(counts.pathsReplaced >= 2)
  assert.equal(body.messages.at(-1).role, 'system')
  assert.equal(body.messages.at(-2).role, 'user')
  assert.ok(!PATH_RE.test(JSON.stringify(body)), 'paths remain')
  assert.ok(JSON.stringify(body).includes('[图片]'))
  assert.ok(!JSON.stringify(body).includes('"thinking"') || !JSON.stringify(body.messages).includes('deepseek-native'))
})
t('transforms: deterministic and idempotent', () => {
  const cfg = normalizeTransformConfig({ images: 'placeholder', stripForeignThinking: true, localPaths: true })
  const a = applyTransforms(sample(), cfg, { ownSignature: () => false }).body
  const b = applyTransforms(sample(), cfg, { ownSignature: () => false }).body
  assert.equal(canonicalJson(a), canonicalJson(b))
  const c = applyTransforms(a, cfg, { ownSignature: () => false })
  assert.equal(canonicalJson(c.body), canonicalJson(a))
  assert.equal(c.counts.nudgeMessages + c.counts.imagesReplaced + c.counts.foreignThinking + c.counts.pathsReplaced, 0)
})
t('transforms: own thinking kept; DeepSeek target keeps everything but the nudge', () => {
  const own = new Set(['deepseek-native-sig'])
  const r = applyTransforms(sample(), normalizeTransformConfig({ stripForeignThinking: true }), { ownSignature: (s) => own.has(s) })
  assert.equal(r.counts.ownThinkingKept, 1)
  assert.equal(r.counts.foreignThinking, 1)
  const d = applyTransforms(sample(), normalizeTransformConfig({}), {})
  assert.equal(d.counts.foreignThinking, 0)
  assert.equal(d.counts.imagesReplaced, 0)
  assert.equal(d.body.messages.length, sample().messages.length - 1)
})
t('transforms: nudge appended as last block of the last user message', () => {
  const b = sample()
  b.messages.splice(-2, 1)
  b.messages[b.messages.length - 2].content.push({ type: 'text', text: '⚠️ 上下文到上限了：请马上整理。' })
  const r = applyTransforms(b, normalizeTransformConfig({}), {})
  assert.equal(r.counts.nudgeBlocks, 1)
})

// ---------- 用量 ----------
t('usage: pinned calibration reproduces the measured count', () => {
  assert.equal(pinnedInputTokens(2429665, 261), 733506)
  assert.ok(K_TEXT > 0.2 && K_TEXT < 0.3)
  assert.equal(countImages(sample()), 2)
})
t('usage: normalize four providers and map to Anthropic fields', () => {
  assert.deepEqual(normalizeUsage('anthropic', { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 }), { input: 10, cacheRead: 5, cacheWrite: 2, output: 7 })
  assert.equal(normalizeUsage('gemini', { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 4 }).input, 70)
  assert.equal(normalizeUsage('gemini', { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 4 }).output, 9)
  assert.equal(normalizeUsage('openai', { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 20 } }).cacheRead, 20)
  assert.deepEqual(toAnthropicUsage('pinned', { pinnedInput: 1234, norm: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } }), { input_tokens: 1234, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 })
  assert.deepEqual(toAnthropicUsage('real', { pinnedInput: 1234, norm: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 } }), { input_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 })
})
t('prices: cost and reserve upper bound', () => {
  assert.equal(costOf('anthropic', { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }), 4)
  assert.equal(costOf('openai', { input: 1e6, output: 1e6 }), 0)
  const r = reserveOf('anthropic', 100000, 1000)
  assert.ok(r.amount >= (135000 * 5 + 1000 * 20) / 1e6 - 1e-9)
  assert.ok(costOf('gemini', { input: 300000, output: 0 }) > costOf('gemini', { input: 150000, output: 0 }) * 2, 'long-context tier')
})

// ---------- 账 ----------
t('ledger: cap, reserve, settle, fail, refuse', () => {
  const dir = join(TMP, 'ledger1')
  const L = new SpendLedger({ dir, caps: { anthropic: 1 } })
  L.reserve({ provider: 'anthropic', callId: 'a', amount: 0.6 })
  assert.equal(L.remaining('anthropic'), 0.4)
  assert.throws(() => L.reserve({ provider: 'anthropic', callId: 'b', amount: 0.5 }), (e) => e instanceof BudgetError && e.code === 'CAP')
  L.settle({ provider: 'anthropic', callId: 'a', cost: 0.1, usage: {} })
  assert.equal(L.remaining('anthropic'), 0.9)
  L.reserve({ provider: 'anthropic', callId: 'c', amount: 0.3 })
  L.fail({ provider: 'anthropic', callId: 'c', charged: 0.2, reason: 'http 500' })
  assert.equal(L.remaining('anthropic'), 0.7)
  assert.throws(() => L.reserve({ provider: 'anthropic', callId: 'c', amount: 0.01 }), (e) => e.code === 'FAILED_BEFORE')
  assert.throws(() => L.reserve({ provider: 'gemini', callId: 'g', amount: 0.01 }), (e) => e.code === 'CAP', 'uncapped provider must be 0')
  L.reserve({ provider: 'openai', callId: 'o', amount: 0 })
})
t('ledger: crash resume charges open reservations and refuses that call', () => {
  const dir = join(TMP, 'ledger2')
  const L = new SpendLedger({ dir, caps: { anthropic: 2 } })
  L.reserve({ provider: 'anthropic', callId: 'x', amount: 0.7 })
  const L2 = new SpendLedger({ dir, caps: { anthropic: 2 } }) // 「重启」
  assert.equal(L2.remaining('anthropic'), 1.3)
  assert.equal(L2.summary().providers.anthropic.open, 0)
  assert.throws(() => L2.reserve({ provider: 'anthropic', callId: 'x', amount: 0.1 }), (e) => e.code === 'FAILED_BEFORE')
  const L3 = new SpendLedger({ dir, caps: { anthropic: 2 } })
  assert.equal(L3.remaining('anthropic'), 1.3, 'orphan charged once only')
})
t('ledger: clean boundaries (question refused when budget short; incomplete marked)', () => {
  const dir = join(TMP, 'ledger3')
  const L = new SpendLedger({ dir, caps: { gemini: 1 } })
  assert.equal(L.boundary({ kind: 'arm', phase: 'begin', id: 'arm1', provider: 'gemini', estimate: 0.5 }).ok, true)
  assert.equal(L.boundary({ kind: 'question', phase: 'begin', id: 'q1', provider: 'gemini', plannedCalls: 3, estPerCall: 0.2 }).ok, true)
  L.reserve({ provider: 'gemini', callId: 'q1c1', amount: 0.3 }); L.settle({ provider: 'gemini', callId: 'q1c1', cost: 0.3, usage: {} })
  L.boundary({ kind: 'question', phase: 'end', id: 'q1', provider: 'gemini' })
  const r = L.boundary({ kind: 'question', phase: 'begin', id: 'q2', provider: 'gemini', plannedCalls: 4, estPerCall: 0.2 })
  assert.equal(r.ok, false); assert.equal(r.reason, 'insufficient-budget')
  L.boundary({ kind: 'question', phase: 'begin', id: 'q3', provider: 'gemini', plannedCalls: 1, estPerCall: 0.1 })
  assert.throws(() => L.reserve({ provider: 'gemini', callId: 'q3c1', amount: 0.9 }), (e) => e.code === 'CAP')
  assert.deepEqual(L.summary().incompleteQuestions, ['q3'])
})
t('ledger: auto-stop at 1.3x the arm estimate, survives restart, unstop', () => {
  const dir = join(TMP, 'ledger4')
  const L = new SpendLedger({ dir, caps: { anthropic: 10 } })
  L.boundary({ kind: 'arm', phase: 'begin', id: 'opus', provider: 'anthropic', estimate: 1 })
  L.reserve({ provider: 'anthropic', callId: 'a', amount: 2 }); L.settle({ provider: 'anthropic', callId: 'a', cost: 1.2, usage: {} })
  assert.equal(L.stopped, null)
  L.reserve({ provider: 'anthropic', callId: 'b', amount: 2 }); L.settle({ provider: 'anthropic', callId: 'b', cost: 0.2, usage: {} })
  assert.ok(L.stopped, 'should stop at 1.4 > 1.3')
  const L2 = new SpendLedger({ dir, caps: { anthropic: 10 } })
  assert.throws(() => L2.reserve({ provider: 'anthropic', callId: 'c', amount: 0.1 }), (e) => e.code === 'STOPPED')
  assert.equal(L2.boundary({ kind: 'question', phase: 'begin', id: 'q', provider: 'anthropic' }).reason, 'stopped')
  L2.unstop('user said go on')
  L2.reserve({ provider: 'anthropic', callId: 'c', amount: 0.1 })
  // 复核 A3：解开以后再超 0.3 倍估算照样停（以前解开一次就再也不停）
  L2.settle({ provider: 'anthropic', callId: 'c', cost: 0.1, usage: {} })
  assert.equal(L2.stopped, null)
  L2.reserve({ provider: 'anthropic', callId: 'd', amount: 0.5 }); L2.settle({ provider: 'anthropic', callId: 'd', cost: 0.3, usage: {} })
  assert.ok(L2.stopped, 'overrun after unstop must stop again')
})
t('ledger: unstop only the allowed kinds; headroom; read-only scan writes nothing', () => {
  const dir = join(TMP, 'ledger5')
  const L = new SpendLedger({ dir, caps: { deepseek: 10, anthropic: 10 } })
  L.stop('privacy gate', 'privacy')
  const r1 = L.unstop('go on')
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'kind-not-allowed')
  assert.ok(L.stopped)
  assert.equal(L.unstop('user looked', { kinds: ['privacy'] }).ok, true)
  // 余额底（复核 A1）：remaining = min(上限 − 已花, 余额 − 底)
  let head = 0.5
  L.setHeadroom('deepseek', () => head)
  assert.equal(L.remaining('deepseek'), 0.5)
  assert.throws(() => L.reserve({ provider: 'deepseek', callId: 'h1', amount: 0.6 }), (e) => e.code === 'HEADROOM')
  head = 5
  L.reserve({ provider: 'deepseek', callId: 'h2', amount: 0.6 })
  const before = readFileSync(join(dir, 'spend-ledger.jsonl'), 'utf8')
  const R = new SpendLedger({ dir, caps: { deepseek: 10 }, readOnly: true })
  assert.ok(R.summary().providers.deepseek.committed >= 0.6 - 1e-9, 'open reservation counted in read-only view')
  assert.equal(readFileSync(join(dir, 'spend-ledger.jsonl'), 'utf8'), before, 'read-only scan must not append orphan settles')
})

// ---------- 指纹 ----------
const fpInput = (over = {}) => ({ target: { provider: 'gemini', model: 'gemini-4-argon', route: 'gemini', baseUrlHost: 'generativelanguage.googleapis.com', thinkingLevel: 'LOW', maxTokens: 32768 }, usageFeedback: 'pinned', arm: 'synthetic', summaryPolicy: 'refuse', transforms: normalizeTransformConfig({}), forwarder: { codeSha: 'x' }, extra: {}, ...over })
t('fingerprint: bind, reuse, refuse a different one', () => {
  const dir = join(TMP, 'fp1')
  mkdirSync(dir)
  const a = buildFingerprint(fpInput())
  assert.equal(bindRunDir(dir, a).bound, 'new')
  assert.equal(bindRunDir(dir, buildFingerprint(fpInput())).bound, 'existing')
  const b = buildFingerprint(fpInput({ usageFeedback: 'real' }))
  assert.notEqual(a.id, b.id)
  assert.throws(() => bindRunDir(dir, b), (e) => e instanceof FingerprintError && e.code === 'MISMATCH')
  const c = buildFingerprint({ ...fpInput(), target: { ...fpInput().target, thinkingLevel: 'HIGH' } })
  assert.notEqual(a.id, c.id)
})
t('fingerprint: aggregator refuses mixed ids; strict needs executor keys', () => {
  const a = buildFingerprint(fpInput()).id
  const b = buildFingerprint(fpInput({ arm: 'real' })).id
  assert.equal(assertSameFingerprint([{ fingerprintId: a }, { fingerprintId: a }]), a)
  assert.throws(() => assertSameFingerprint([{ fingerprintId: a }, { fingerprintId: b }]), (e) => e.code === 'INCOMPARABLE')
  assert.throws(() => assertSameFingerprint([{}]), (e) => e.code === 'NO_ID')
  assert.throws(() => buildFingerprint(fpInput(), { strict: true }), (e) => e.code === 'MISSING')
  const full = { proxy: { buildSha: 'x' }, gate: { mode: 'audit' }, search: 'bm25', reldate: false, questions: { setSha: 'q' }, executorSha: 'e', judge: { models: ['m'] } }
  assert.ok(buildFingerprint(fpInput({ extra: full }), { strict: true }).id)
})

// ---------- 隐私闸 ----------
const snap = join(TMP, 'snap')
mkdirSync(join(snap, 'files', 'sessions'), { recursive: true })
writeFileSync(join(snap, 'files', 'diary.md'), '今天和主人一起去河边散步看见很多白鹭在浅水里找吃的\n')
// DSH 的会话日志：一条记录一帧、帧接帧追加；最后一帧可能正写到一半（这里截掉 5 个字节）
const frame = (o) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(o) + '\n'))
const tornTail = frame({ msg: { text: '这一条还没写完整不该出现在索引里面的内容' } })
writeFileSync(join(snap, 'files', 'sessions', 's.jsonl.zstd'), Buffer.concat([frame({ type: 'header', v: 1 }), frame({ msg: { text: '我们约好周末去城东那家面馆吃牛肉面加一个煎蛋' } }), tornTail.subarray(0, tornTail.length - 5)]))
writeFileSync(join(snap, 'deny-hashes.json'), JSON.stringify({ salt: 's1', hashes: [numberHash('s1', '987654321')] }))
const idx = buildCorpusIndex(snap)
const gramCheck = makeGramChecker(idx)
const synCtx = { arm: 'synthetic', provider: 'gemini', toolNames: new Set(['im_send', 'search_context']), gramCheck, deny: loadDenyHashes(snap) }
const synBody = (text) => ({ tools: [{ name: 'im_send' }], messages: [{ role: 'user', content: text }] })
t('privacy: clean synthetic request passes', () => {
  const r = checkRequest(synCtx, { contents: [{ parts: [{ text: '主人说想去山上看日出，然后吃一碗热汤面' }] }] }, synBody('x'))
  assert.equal(r.ok, true, r.problems.join(','))
})
t('privacy: multi-frame zstd session log is read past the first frame; torn tail dropped', () => {
  const r = zstdDecompressAll(readFileSync(join(snap, 'files', 'sessions', 's.jsonl.zstd')))
  assert.equal(r.frames, 2)
  assert.ok(r.droppedTailBytes > 0)
  assert.equal(checkRequest(synCtx, { x: '这一条还没写完整不该出现在索引里面' }, synBody('x')).ok, true)
})
t('privacy: 12-char fragment of her records (plain file and zstd) fails', () => {
  assert.ok(idx.stats.texts >= 2)
  assert.ok(checkRequest(synCtx, { x: '前面随便写点东西和主人一起去河边散步看见很多白鹭' }, synBody('x')).problems.includes('有 12 字片段和她的记录重合'))
  assert.ok(checkRequest(synCtx, { x: '城东那家面馆吃牛肉面加一个' }, synBody('x')).problems.includes('有 12 字片段和她的记录重合'))
})
t('privacy: text the target model itself produced is exempt from the gram check, nothing else is', () => {
  const store = new MemorySigStore()
  const ctx = { ...synCtx, isOwnText: (s) => store.isOwnText(s) }
  const modelSaid = '我想起和主人一起去河边散步看见很多白鹭的样子'
  assert.equal(checkRequest(ctx, { messages: [{ role: 'assistant', content: modelSaid }] }, synBody('x')).ok, false)
  store.addOwnText(modelSaid)
  assert.equal(checkRequest(ctx, { messages: [{ role: 'assistant', content: modelSaid }] }, synBody('x')).ok, true)
  // 同一段话放进别的字符串里（比如执行器拼进工具结果）照查
  assert.equal(checkRequest(ctx, { messages: [{ role: 'tool', content: `结果：${modelSaid}` }] }, synBody('x')).ok, false)
})
t('privacy: real QQ (hashed), qq: tag, path, credential, tools', () => {
  assert.ok(checkRequest(synCtx, { x: '号码 987654321 别外传' }, synBody('x')).problems.includes('含真实 QQ 号'))
  assert.ok(checkRequest(synCtx, { x: 'qq:private:12345' }, synBody('x')).problems.includes('qq: 后面不是假号'))
  assert.equal(checkRequest(synCtx, { x: 'qq:private:10001 qq:group:20000' }, synBody('x')).ok, true)
  assert.ok(checkRequest(synCtx, { x: 'C:\\Users\\someone\\x' }, synBody('x')).problems.includes('含本机路径'))
  assert.ok(checkRequest(synCtx, { x: 'Bearer abcdefghijklmnop' }, synBody('x')).problems.includes('含像凭据的串'))
  assert.equal(checkRequest(synCtx, { x: 'ok', signature: ['sk', 'should-not-be-scanned-because-signature'].join('-') }, synBody('x')).ok, true)
  assert.ok(checkRequest(synCtx, { x: 'ok' }, { tools: [{ name: 'shell' }], messages: [] }).problems.includes('工具表里有白名单以外的工具'))
  assert.ok(checkRequest({ ...synCtx, gramCheck: undefined }, { x: 'ok' }, synBody('x')).problems.includes('没载入她记录的片段表'))
  assert.ok(CRED_RE.test('AIza' + 'a'.repeat(35)))
})
t('privacy: real arm needs a matching approval (provider + arm + data shas) and clean paths', () => {
  // 复核 A7：许可 v2 按提供方、臂、数据指纹认；旧格式只在 testMode 认
  const ap = { v: 2, expires: '2026-12-19T23:59:59+08:00', grants: [{ id: 'g1', providers: ['anthropic', 'gemini', 'openai', 'deepseek'], arms: ['W-O1-opus/*', 'W-O1-flash/*'], data: { viewRawSha: 'V', questionSetSha: 'Q' } }] }
  const now = Date.parse('2026-11-19T12:00:00+08:00')
  const m = (o) => matchApproval(ap, { provider: 'anthropic', armId: 'W-O1-opus/o1', data: { viewRawSha: 'V', questionSetSha: 'Q' }, now, ...o })
  assert.equal(m({}).ok, true)
  assert.equal(m({ armId: 'SYN-opus/NEXT' }).ok, false, 'other arm')
  assert.equal(m({ data: { viewRawSha: 'V2', questionSetSha: 'Q' } }).ok, false, 'other view')
  assert.equal(m({ provider: 'xai' }).ok, false, 'other provider')
  assert.equal(m({ now: Date.parse('2026-12-20T00:00:00+08:00') }).ok, false, 'expired')
  const legacy = { date: '2026-11-19', providers: ['anthropic'], arms: ['real'] }
  assert.equal(matchApproval(legacy, { provider: 'anthropic', armId: 'x', testMode: false }).ok, false, 'legacy only in testMode')
  assert.equal(matchApproval(legacy, { provider: 'anthropic', armId: 'x', testMode: true }).ok, true)
  const approval = m({})
  assert.equal(checkRequest({ arm: 'real', provider: 'anthropic', approval, now: () => now }, { x: '她的话' }, {}).ok, true)
  assert.ok(checkRequest({ arm: 'real', provider: 'anthropic', approval: m({ armId: 'nope' }) }, { x: '' }, {}).problems.includes('真数据臂没有对得上的许可（提供方 / 臂 / 数据指纹）'))
  assert.ok(checkRequest({ arm: 'real', provider: 'anthropic', approval, now: () => Date.parse('2026-12-20T00:00:00+08:00') }, { x: '' }, {}).problems.includes('真数据臂的许可过期了'))
  assert.ok(checkRequest({ arm: 'real', provider: 'anthropic', approval, now: () => now }, { x: '/c/Users/someone/x' }, {}).problems.includes('路径没换干净'))
  assert.equal(checkRequest({ arm: 'real', provider: 'deepseek', approval, now: () => now }, { x: '/c/Users/someone/x' }, {}).ok, true)
  // 两条许可的样本（结构照真跑用的许可文件，sha 是编的）：W 四臂一条；W-O1t（真开卷）另一条，只给 openai，认开卷、闭卷两份题
  const V = 'a'.repeat(64)
  const QC = 'b'.repeat(64)
  const QO = 'c'.repeat(64)
  const real = { v: 2, date: '2026-11-19', expires: '2026-12-19T23:59:59+08:00', grants: [
    { id: 'w-1115-view-to-four', providers: ['deepseek', 'anthropic', 'gemini', 'openai'], arms: ['W-O1-flash/*', 'W-O1-scarletkc/*', 'W-O1-gemini/*', 'W-O1-opus/*'], data: { viewRawSha: V, questionSetSha: QC } },
    { id: 'w-1115-view-o1t-scarletkc', providers: ['openai'], arms: ['W-O1t-scarletkc/*'], data: { viewRawSha: V, questionSetSha: [QO, QC] } },
  ] }
  assert.equal(matchApproval(real, { provider: 'gemini', armId: 'W-O1-gemini/o1', data: { viewRawSha: V, questionSetSha: QC }, now }).ok, true)
  assert.equal(matchApproval(real, { provider: 'gemini', armId: 'SYN-gemini/NEXT', data: {}, now }).ok, false)
  const mr = (provider, armId, q, n = now) => matchApproval(real, { provider, armId, data: { viewRawSha: V, questionSetSha: q }, now: n })
  assert.equal(mr('openai', 'W-O1t-scarletkc/o1t', QO).grantId, 'w-1115-view-o1t-scarletkc')
  assert.equal(mr('openai', 'W-O1t-scarletkc/closed', QC).ok, true)
  for (const p of ['anthropic', 'gemini', 'deepseek']) assert.equal(mr(p, 'W-O1t-scarletkc/o1t', QO).ok, false, `${p} must not match the o1t grant`)
  assert.equal(mr('openai', 'W-O1-scarletkc/o1', QO).ok, false, 'old grant does not take the open-book sha')
  assert.equal(mr('openai', 'W-O1-scarletkc/o1', QC).grantId, 'w-1115-view-to-four', 'old grant unchanged')
  assert.equal(mr('openai', 'W-O1t-flash/o1t', QO).ok, false)
  assert.equal(mr('openai', 'W-O1t-scarletkc/o1t', 'other').ok, false)
  assert.equal(mr('openai', 'W-O1t-scarletkc/o1t', QO, Date.parse('2026-12-20T00:00:00+08:00')).ok, false, 'same expiry as the file')
  // 数组只许非空、全是字符串
  const arr = (vals) => matchApproval({ v: 2, expires: '2099-01-01T00:00:00Z', grants: [{ id: 'a', providers: ['openai'], arms: ['X/*'], data: { q: vals } }] }, { provider: 'openai', armId: 'X/1', data: { q: 'Q' }, now })
  assert.equal(arr(['Q', 'R']).ok, true)
  assert.equal(arr([]).ok, false)
  assert.equal(arr(['Q', 7]).ok, false)
  assert.equal(arr('').ok, false)
})
// ---------- 第二轮修 1：替身模板（整行对得上的只查空位；固定字不算她的话，空位里的照查） ----------
const snap2 = join(TMP, 'snap-tpl')
mkdirSync(join(snap2, 'files'), { recursive: true })
writeFileSync(join(snap2, 'files', 'diary.md'), '阿栗，就是主人）的私聊最近的消息\n窗外的雨一直下到半夜都没有停下来的意思\n')
writeFileSync(join(snap2, 'deny-hashes.json'), JSON.stringify({ salt: 's2', hashes: [numberHash('s2', '987654321')] }))
const idx2 = buildCorpusIndex(snap2)
const TPL = [
  { id: 't1', parts: [{ lit: 'qq:private:' }, { slot: 'num' }, { lit: '（' }, { slot: 'free' }, { lit: '，就是主人）的私聊最近的 ' }, { slot: 'num' }, { lit: ' 条（' }, { slot: 'time' }, { lit: '–' }, { slot: 'time' }, { lit: '）：' }] },
  { id: 't2', parts: [{ slot: 'time' }, { lit: ' ' }, { slot: 'free' }, { lit: '（主人）：' }, { slot: 'free' }] },
  { id: 'bad-ascii', parts: [{ slot: 'free' }, { lit: ' ' }, { slot: 'num' }] },
  { id: 'bad-slot', parts: [{ lit: '有' }, { slot: 'weird' }] },
]
const title = (name) => `qq:private:10000（${name}，就是主人）的私聊最近的 3 条（12:00–昨天 12:30）：`
t('privacy r2: compileTemplates keeps CJK/time templates only, longest literal first', () => {
  const c = compileTemplates(TPL)
  assert.deepEqual(c.map((x) => x.id), ['t1', 't2'])
  assert.deepEqual(templateSegments(title('阿栗'), c), ['10000', '阿栗', '3', '12:00', '昨天 12:30'])
  assert.deepEqual(templateSegments('前面一行\n' + title('阿栗') + '\n后面一行', c), ['前面一行', '10000', '阿栗', '3', '12:00', '昨天 12:30', '后面一行'])
})
t('privacy r2: fixed template words + a synthetic name no longer count as her text; her words in a slot still do', () => {
  const plain = makeGramChecker(idx2)
  const tpl = makeGramChecker(idx2, { templates: TPL })
  assert.ok(plain([title('阿栗')]) > 0, 'without templates: the round-1 false positive reproduces')
  assert.equal(tpl([title('阿栗')]), 0, 'with templates: only the slots are checked')
  assert.ok(tpl([title('窗外的雨一直下到半夜都没有停下来')]) > 0, 'her 12 chars in the name slot are still caught')
  assert.ok(tpl(['12:00 阿栗（主人）：窗外的雨一直下到半夜都没有停下来']) > 0, 'her 12 chars in a row slot are still caught')
  assert.ok(tpl(['x' + title('阿栗')]) > 0, 'a line that does not match a template whole is checked whole')
  assert.ok(tpl.stats.templateLines >= 2)
})
t('privacy r2: templates only apply to tool results in a real request (OpenAI role:tool / Anthropic tool_result / Gemini functionResponse)', () => {
  const ctx = { arm: 'synthetic', provider: 'openai', toolNames: new Set(['im_send', 'search_context']), gramCheck: makeGramChecker(idx2, { templates: TPL }), deny: loadDenyHashes(snap2) }
  const body = { tools: [{ name: 'im_send' }], messages: [{ role: 'user', content: 'x' }] }
  assert.equal(checkRequest(ctx, { messages: [{ role: 'tool', tool_call_id: 'c1', content: title('阿栗') + '\n12:00 阿栗（主人）：下雨了' }] }, body).ok, true)
  assert.ok(checkRequest(ctx, { messages: [{ role: 'user', content: title('阿栗') }] }, body).problems.includes('有 12 字片段和她的记录重合'), 'same line in a user message is checked whole')
  assert.ok(toolResultStrings({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'A' }] }, { type: 'text', text: 'C' }] }] }).includes('A'))
  assert.ok(!toolResultStrings({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'A' }] }, { type: 'text', text: 'C' }] }] }).includes('C'), 'text next to a tool_result is not a tool result')
  assert.ok(toolResultStrings({ contents: [{ parts: [{ functionResponse: { name: 'x', response: { output: 'B' } } }] }] }).includes('B'))
})

t('global spend: every open-book-* dir, paid ledgers only, open reserves count, except-self; paid lock + run-dir lock (A4)', () => {
  const ex = join(TMP, 'gs-exp')
  const mk = (rel, provider, fw, settle, open = 0) => {
    const d = join(ex, rel)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'fingerprint.json'), JSON.stringify({ id: 'fp-x', fingerprint: { route: { provider }, forwarder: fw } }))
    const L = new SpendLedger({ dir: d, caps: { [provider]: 1000 } })
    L.reserve({ provider, callId: 'c1', amount: settle })
    L.settle({ provider, callId: 'c1', cost: settle, usage: {} })
    if (open) L.reserve({ provider, callId: 'c2', amount: open })
    return d
  }
  mk('open-book-20261118/runs/a/fwd-state', 'deepseek', {}, 2)
  const self = mk('open-book-20261119/runs/b/units/u1/fwd-state', 'deepseek', {}, 3, 1.5)
  mk('open-book-20261119/runs/c/fwd-state', 'deepseek', { testMode: true }, 50)
  mk('open-book-20261119/runs/d/fwd-state', 'deepseek', { offline: true }, 40)
  mk('open-book-20261119/runs/e/fwd-state', 'anthropic', {}, 7)
  mk('not-open-book/fwd-state', 'deepseek', {}, 99)
  assert.equal(globalSpend(ex, 'deepseek').total, 6.5, 'settled 2 + 3 and the open reserve 1.5; test/offline/other dirs ignored')
  assert.equal(globalSpend(ex, 'deepseek', { exceptStateDirs: [self] }).total, 2)
  assert.equal(globalSpend(ex, 'anthropic').total, 7)
  assert.equal(readFileSync(join(self, 'spend-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length, 3, 'read-only scan wrote nothing')
  const rel = acquirePaidLock(ex, 'test one')
  writeFileSync(join(ex, 'paid-run.lock'), JSON.stringify({ pid: process.ppid, owner: 'other live process' }))
  assert.throws(() => acquirePaidLock(ex, 'test two'), /只许一个/)
  writeFileSync(join(ex, 'paid-run.lock'), JSON.stringify({ pid: 2147483646, owner: 'dead' }))
  const rel2 = acquirePaidLock(ex, 'after a dead owner')
  rel2(); rel()
  assert.equal(existsSync(join(ex, 'paid-run.lock')), false)
  const rd = join(ex, 'open-book-20261119/runs/b')
  const r1 = acquireDirLock(rd, 'run one')
  assert.ok(existsSync(join(rd, '.run.lock')))
  r1()
})

// ---------- 推理机的锁（不按年纪过期；pid 复用靠命令行认） ----------
t('selfhost lock: one at a time, no age expiry, dead / reused pid reclaimed, unknown command line counts as alive', () => {
  const ex = join(TMP, 'selfhost-exp')
  mkdirSync(ex, { recursive: true })
  const lf = join(ex, SELFHOST_LOCK)
  const rel = acquireSelfHostLock(ex, 'arm one')
  assert.ok(existsSync(lf))
  assert.throws(() => acquireSelfHostLock(ex, 'nested'), /已经拿着/)
  rel()
  assert.equal(existsSync(lf), false)
  const ob = () => 'node C:\\x\\tools\\open-book-eval\\bin\\ob.mjs run'
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600e3).toISOString()
  writeFileSync(lf, JSON.stringify({ pid: process.ppid, owner: 'other ob run', at: fiveHoursAgo }))
  assert.throws(() => acquireSelfHostLock(ex, 'second', { cmdlineOf: ob }), /推理机上已经有一臂在跑/, 'live ob owner, 5 hours old: still refused')
  assert.throws(() => acquireSelfHostLock(ex, 'second', { cmdlineOf: () => null }), /推理机上已经有一臂在跑/, 'cannot read the command line: treat as alive')
  const r2 = acquireSelfHostLock(ex, 'after pid reuse', { cmdlineOf: () => 'C:\\Windows\\notepad.exe' })
  r2()
  writeFileSync(lf, JSON.stringify({ pid: 2147483646, owner: 'dead', at: fiveHoursAgo }))
  const r3 = acquireSelfHostLock(ex, 'after a dead owner', { cmdlineOf: () => { throw new Error('should not be asked for a dead pid') } })
  r3()
  writeFileSync(lf, 'not json')
  acquireSelfHostLock(ex, 'after a broken lock')()
  assert.equal(existsSync(lf), false)
})
t('selfhost lock: the real command-line probe sees a live open-book-eval process (PowerShell CIM)', () => {
  if (process.platform !== 'win32') return
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'open-book-eval-selfhost-lock-probe'], { stdio: 'ignore', windowsHide: true })
  try {
    const ex = join(TMP, 'selfhost-real')
    mkdirSync(ex, { recursive: true })
    let cl = ''
    for (let i = 0; i < 5 && !cl.includes('open-book-eval'); i++) cl = processCommandLine(child.pid) ?? ''
    assert.ok(cl.includes('open-book-eval-selfhost-lock-probe'), 'probe sees the marker')
    writeFileSync(join(ex, SELFHOST_LOCK), JSON.stringify({ pid: child.pid, owner: 'probe', at: new Date(0).toISOString() }))
    assert.throws(() => acquireSelfHostLock(ex, 'second'), /推理机上已经有一臂在跑/)
  } finally { child.kill() }
})

t('config: a paid DeepSeek run needs balanceFloor; floor only for deepseek (A1)', () => {
  const w = (name, o) => { const p = join(TMP, `cfg-${name}.json`); writeFileSync(p, JSON.stringify({ arm: 'synthetic', stateDir: join(TMP, `st-${name}`), ...o })); return p }
  const ds = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', deepseek: { auth: 'apiKey' } }
  assert.throws(() => loadConfig(w('nofloor', { target: ds, caps: { deepseek: 10 } })), /balanceFloor/)
  assert.equal(loadConfig(w('floor', { target: ds, caps: { deepseek: 10 }, balanceFloor: 5 })).balanceFloor, 5)
  assert.equal(loadConfig(w('nocap', { target: ds, caps: { deepseek: 0 } })).balanceFloor ?? null, null, 'cap 0 spends nothing, no floor needed')
  assert.throws(() => loadConfig(w('floor-anth', { target: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com' }, caps: { anthropic: 1 }, balanceFloor: 1 })), /balanceFloor/)
  assert.equal(loadConfig(w('door', { target: ds, caps: {}, connectDoor: false })).connectDoor, false)
})
t('privacy: media fields skipped only inside media blocks (B1)', () => {
  const ctx = { arm: 'real', provider: 'anthropic', approval: { ok: true, expiresMs: null } }
  assert.ok(checkRequest(ctx, { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', data: 'C:\\Users\\someone\\leak' }] }] }, {}).problems.includes('路径没换干净'), 'data outside a media block is scanned')
  assert.equal(checkRequest(ctx, { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QzpcVXNlcnM=' } }] }] }, {}).ok, true)
})

// ---------- 协议 ----------
const T = {
  anthropic: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: 'http://127.0.0.1:1', effort: 'high', maxTokens: 64000, anthropic: { blockBinding: 'drop_block' } },
  gemini: { provider: 'gemini', model: 'gemini-4-argon', baseUrl: 'http://127.0.0.1:1', thinkingLevel: 'LOW', maxTokens: 32768 },
  openai: { provider: 'openai', model: 'scarletkc', baseUrl: 'http://127.0.0.1:1/v1', maxTokens: 8192, openai: { reasoningInField: 'reasoning', midSystem: 'to-user', enableThinking: true, maxImages: 128 } },
  deepseek: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:1', deepseek: { auth: 'account' } },
}
const cleaned = () => applyTransforms(sample(), normalizeTransformConfig({ images: 'placeholder', stripForeignThinking: true, localPaths: true }), { ownSignature: () => false }).body
t('anthropic: pinned effort/adaptive/no fallback, betas, tool_choice, file images refused', () => {
  const b = cleaned()
  b.tool_choice = { type: 'any' }
  b.temperature = 0.3
  const r = anthropic.buildRequest(b, T.anthropic)
  assert.deepEqual(r.payload.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
  assert.deepEqual(r.payload.output_config, { effort: 'high' })
  assert.equal(r.payload.model, 'claude-opus-5-5')
  assert.equal(r.payload.tool_choice.type, 'auto')
  assert.ok(!('temperature' in r.payload) && !('fallbacks' in r.payload))
  assert.ok(r.headers['anthropic-beta'].includes('thinking-binding-controls-2026-08-01'))
  assert.equal(r.meta.toolChoiceForcedToAuto, 1)
  assert.throws(() => anthropic.buildRequest(sample(), T.anthropic), (e) => e instanceof FwdError && e.code === 'NON_BASE64_IMAGE')
  assert.throws(() => anthropic.buildRequest(b, { ...T.anthropic, effort: undefined }), (e) => e.code === 'CONFIG')
})
t('anthropic: mid-conversation system placement, cache breakpoints <= 4', () => {
  const b = cleaned()
  b.messages.splice(1, 0, { role: 'system', content: '中途的系统话' }) // 前面是 user、后面是 assistant：合规
  b.messages.splice(0, 0, { role: 'system', content: '开头不合规' })
  for (const m of b.messages) if (Array.isArray(m.content)) for (const x of m.content) x.cache_control = { type: 'ephemeral' }
  const r = anthropic.buildRequest(b, T.anthropic)
  assert.equal(r.meta.midSystemConverted, 1)
  assert.equal(r.payload.messages[0].role, 'user')
  assert.ok(r.payload.messages.some((m) => m.role === 'system'))
  let marks = 0
  for (const m of r.payload.messages) if (Array.isArray(m.content)) for (const x of m.content) if (x.cache_control) marks++
  assert.ok(marks <= 4)
})
t('anthropic: parse refusal, stop_details, input_transformations, own signatures', () => {
  const raw = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":1},"input_transformations":[{"type":"thinking_dropped","reason":"prefix_binding_mismatch","path":"messages.3.content.0"}]}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opus-sig-1"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber"}},"usage":{"output_tokens":3}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const p = anthropic.parseUpstream(raw)
  assert.equal(p.ok, true)
  assert.equal(p.message.stop_reason, 'refusal')
  assert.equal(p.extras.thinkingDropped, 1)
  assert.deepEqual(p.ownSignatures, ['opus-sig-1'])
  assert.equal(p.message.stop_details.category, 'cyber')
})
t('gemini: conversion via kernel + signatures re-attached + tool images in functionResponse.parts', () => {
  const sig = new MemorySigStore()
  sig.setG('tool:toolu_g1', 'gsig-call-7')
  const b = cleaned()
  b.messages.splice(b.messages.length - 1, 0,
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'gemini 自己的思考', signature: 'fwdg1.gsig-thought-7' }, { type: 'tool_use', id: 'toolu_g1', name: 'im_send', input: { to: 'qq:private:10000' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_g1', content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] })
  const r = gemini.buildRequest(b, T.gemini, { sigStore: sig })
  const parts = r.payload.contents.flatMap((c) => c.parts)
  const call = parts.find((p) => p.functionCall?.id === 'toolu_g1')
  assert.equal(call.thoughtSignature, 'gsig-call-7')
  assert.ok(parts.some((p) => p.thought === true && p.thoughtSignature === 'gsig-thought-7'))
  const fr = parts.find((p) => p.functionResponse?.id === 'toolu_g1')
  assert.equal(fr.functionResponse.parts[0].inlineData.mimeType, 'image/png')
  assert.ok(r.payload.systemInstruction.parts[0].text.includes('合成的世界'))
  assert.ok(r.payload.tools[0].functionDeclarations[0].parametersJsonSchema)
  assert.equal(r.payload.generationConfig.thinkingConfig.thinkingLevel, 'LOW')
  assert.ok(r.url.endsWith(':streamGenerateContent?alt=sse'))
  assert.equal(r.meta.midSystemAsUserText, 1)
})
t('gemini: parse thought/text/functionCall, finish mapping, signatures recorded', () => {
  const sig = new MemorySigStore()
  const raw = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"想","thought":true,"thoughtSignature":"S1"}]}}],"responseId":"r1"}\n\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"fc9","name":"im_send","args":{"to":"x"}},"thoughtSignature":"S2"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":1}}\n\n'
  const p = gemini.parseUpstream(raw, { sigStore: sig })
  assert.equal(p.ok, true)
  assert.equal(p.message.stop_reason, 'tool_use')
  assert.equal(p.message.content[0].signature, 'fwdg1.S1')
  assert.equal(p.message.content[1].id, 'fc9')
  assert.equal(sig.getG('tool:fc9'), 'S2')
  const refusal = gemini.parseUpstream('data: {"candidates":[{"content":{"parts":[]},"finishReason":"SAFETY"}]}\n\n', { sigStore: sig })
  assert.equal(refusal.message.stop_reason, 'refusal')
  assert.equal(gemini.parseUpstream('data: {"candidates":[{"content":{"parts":[{"text":"半"}]}}]}\n\n', { sigStore: sig }).ok, false)
})
t('openai: kernel conversion, reasoning field rename, mid system to user, tool images after the tool run', () => {
  const b = cleaned()
  b.messages.splice(b.messages.length - 1, 0,
    { role: 'assistant', content: [{ type: 'thinking', thinking: '自己的思考', signature: 'fwdo1:reasoning:abc' }, { type: 'tool_use', id: 'call_1', name: 'im_send', input: { to: 'qq:private:10000' } }, { type: 'tool_use', id: 'call_2', name: 'im_send', input: { to: 'qq:group:20000' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } }] }, { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'ok2' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB=' } }] }] })
  const r = openai.buildRequest(b, T.openai)
  const msgs = r.payload.messages
  assert.equal(msgs[0].role, 'system')
  assert.ok(msgs.every((m, i) => i === 0 || m.role !== 'system'))
  const asst = msgs.find((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === 'call_1'))
  assert.equal(asst.reasoning, '自己的思考')
  assert.ok(!('reasoning_content' in asst))
  const ti = msgs.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'call_2')
  assert.equal(msgs[ti - 1].tool_call_id, 'call_1')
  const att = msgs[ti + 1]
  assert.equal(att.role, 'user')
  assert.equal(att.content[1].image_url.url, 'data:image/png;base64,AAA=')
  assert.equal(att.content[2].image_url.url, 'data:image/jpeg;base64,BBB=')
  assert.equal(r.meta.midSystemConverted, 1)
  assert.deepEqual(r.payload.chat_template_kwargs, { enable_thinking: true })
  assert.equal(r.payload.stream_options.include_usage, true)
})
t('openai: more than maxImages is refused before sending', () => {
  const b = cleaned()
  b.messages.splice(0, 0, { role: 'user', content: Array.from({ length: 129 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } })) })
  assert.throws(() => openai.buildRequest(b, T.openai), (e) => e.code === 'TOO_MANY_IMAGES')
})
t('openai: parse vLLM stream (reasoning, tool call pieces, usage, bad args)', () => {
  const raw = 'data: {"id":"c1","model":"scarletkc","choices":[{"index":0,"delta":{"reasoning":"想"}}]}\n\n' +
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-1","function":{"name":"im_send","arguments":"{\\"to\\":"}}]}}]}\n\n' +
    'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":40,"completion_tokens":7}}\n\ndata: [DONE]\n\n'
  const p = openai.parseUpstream(raw)
  assert.equal(p.ok, true)
  assert.equal(p.message.stop_reason, 'tool_use')
  assert.deepEqual(p.message.content[1].input, { to: 'x' })
  assert.equal(p.message.content[1].id, 'chatcmpl-tool-1')
  assert.ok(p.message.content[0].signature.startsWith('fwdo1:reasoning:'))
  assert.equal(p.extras.reasoningFieldSeen, 'reasoning')
  assert.equal(normalizeUsage('openai', p.usageRaw).input, 40)
  const bad = openai.parseUpstream('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{oops"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')
  assert.equal(bad.extras.badToolArgs, 1)
})
t('deepseek: as-is, beta filter, auth routes, stable session id', () => {
  const b = sample()
  const r = deepseek.buildRequest(b, T.deepseek, { incomingBeta: 'files-api-2025-04-14,weird-beta' })
  assert.equal(r.headers['anthropic-beta'], 'files-api-2025-04-14')
  assert.deepEqual(r.payload.messages, b.messages)
  const h1 = deepseek.authHeaders(T.deepseek, { token: 't', anonymousUserId: 'u' }, { conversationKey: 'c1' })
  assert.equal(h1['x-deepseek-harness-session-id'], deepseek.authHeaders(T.deepseek, { token: 't', anonymousUserId: 'u' }, { conversationKey: 'c1' })['x-deepseek-harness-session-id'])
  assert.ok(/^[0-9a-f-]{36}$/.test(h1['x-deepseek-harness-session-id']))
  assert.deepEqual(Object.keys(deepseek.authHeaders({ ...T.deepseek, deepseek: { auth: 'apiKey' } }, { apiKey: 'k' })), ['x-api-key'])
})
t('anthropic SSE writer round-trips through the shared parser', () => {
  const msg = { id: 'm', model: 'x', content: [{ type: 'thinking', thinking: '想', signature: 's' }, { type: 'redacted_thinking', data: 'r' }, { type: 'text', text: '好' }, { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }], stop_reason: 'tool_use' }
  const back = assembleMessage(parseSSE(sseFromMessage(msg, { input_tokens: 5, output_tokens: 2 })))
  assert.equal(back.ok, true)
  assert.deepEqual(back.message.content.map((b) => b.type), ['thinking', 'redacted_thinking', 'text', 'tool_use'])
  assert.deepEqual(back.message.content[3].input, { a: 1 })
  assert.equal(back.message.usage.input_tokens, 5)
  assert.equal(back.message.usage.output_tokens, 2)
})

// ---------- 凭据文件的解析（合成的 YAML，不读真的） ----------
t('credentials: YAML subset parser (refs, records, lists, quoted)', () => {
  const y = 'version: 1\nrecords:\n  r1:\n    kind: grant\n    payload:\n      token: "abc\\u0041"\n      issuer: https://platform.deepseek.com/x\nrefs:\n  ANTHROPIC_API_KEY: sk-ant-xyz\n  SELFHOST_API_KEY: \'x\'\nmodels:\n  - id: claude-opus-5-5\n    contextWindow: 1000000\n    input:\n      - text\n      - image\n  - id: other\n'
  const v = parseYamlSubset(y).value
  assert.equal(v.records.r1.payload.token, 'abcA')
  assert.equal(v.refs.ANTHROPIC_API_KEY, 'sk-ant-xyz')
  assert.equal(v.refs.SELFHOST_API_KEY, 'x')
  assert.equal(v.models.length, 2)
  assert.equal(v.models[0].contextWindow, 1000000)
  assert.deepEqual(v.models[0].input, ['text', 'image'])
})

// ---------- 出网闸（子进程里装上再试；线上那一段只核判定函数，绝不真连） ----------
t('egress guard: allow list, live ports, dns, child_process, fetch', () => {
  const probe = join(TMP, 'probe-egress.mjs')
  writeFileSync(probe, `
import net from 'node:net'; import dns from 'node:dns'; import cp from 'node:child_process'
const g = globalThis[Symbol.for('fwd.egressGuard')]
const out = { allow: g.allow, live: g.egressAllowed('127.0.0.1', 18787), liveLo: g.egressAllowed('localhost', 18780), loopOk: g.egressAllowed('127.0.0.1', 28800), listed: g.egressAllowed('api.anthropic.com', 443), wrongPort: g.egressAllowed('api.anthropic.com', 80), other: g.egressAllowed('example.invalid', 443) }
out.child = (() => { try { cp.spawnSync('node', ['-v']); return 'ran' } catch (e) { return e.code } })()
out.dns = await new Promise((r) => dns.lookup('blocked.invalid', (e) => r(e ? e.code : 'resolved')))
out.fetch = await fetch('https://blocked.invalid/').then(() => 'ok', (e) => String(e.message).includes('egress-guard') ? 'blocked' : 'other:' + e.message)
out.listenLive = (() => { try { const x = net.createServer().listen(18799, '127.0.0.1'); x.close(); return 'listened' } catch (e) { return e.code } })()
const srv = net.createServer((s) => s.end('hi')).listen(0, '127.0.0.1')
await new Promise((r) => srv.once('listening', r))
out.loopConnect = await new Promise((r) => { const s = net.connect(srv.address().port, '127.0.0.1'); s.on('data', () => { r('ok'); s.end() }); s.on('error', (e) => r(e.code)) })
out.remote = await new Promise((r) => { const s = net.connect(443, 'example.invalid'); s.on('connect', () => r('connected')); s.on('error', (e) => r(e.code)) })
srv.close()
console.log(JSON.stringify(out))
`)
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(HERE, 'lib', 'egress-guard.mjs')).href, probe], { encoding: 'utf8', env: { ...process.env, FWD_EGRESS_ALLOW: 'api.anthropic.com:443' }, timeout: 20000 })
  const o = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.deepEqual(o.allow, ['api.anthropic.com:443'])
  assert.equal(o.live, false); assert.equal(o.liveLo, false); assert.equal(o.loopOk, true); assert.equal(o.listed, true); assert.equal(o.wrongPort, false); assert.equal(o.other, false)
  assert.equal(o.child, 'EACCES')
  assert.equal(o.dns, 'ENOTFOUND')
  assert.equal(o.fetch, 'blocked')
  assert.equal(o.listenLive, 'EACCES')
  assert.equal(o.loopConnect, 'ok')
  assert.equal(o.remote, 'ECONNREFUSED')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
