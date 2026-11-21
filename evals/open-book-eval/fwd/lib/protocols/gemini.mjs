// Gemini（generativelanguage.googleapis.com v1beta，流式 :streamGenerateContent?alt=sse）。
// 消息转换用 fork 内核 5bb25bf 的 anthropicToCore → coreToGoogle（vendor/kernel-wire.mjs，只读拷出），这里只补内核没管的几样：
//   - 顶层 system → systemInstruction（对话中间的 system 由内核放进 user 一侧的文字，Gemini 没有中途 system）
//   - 工具表 → functionDeclarations（parametersJsonSchema 给完整 JSON Schema，和 pi-ai 一样）
//   - Gemini 3 起：functionCall / functionResponse 带 id（内核按 toolCallId 带上）；functionCall 上的 thoughtSignature 会被核，
//     我们把它记在 SigStore（按 tool_use id），发回时挂回去；思考块的签名直接编进 Anthropic thinking 块的 signature（'fwdg1.' 前缀）
//   - 工具结果里的图：内核只留文字，这里按 pi-ai 的做法挂到 functionResponse.parts（Gemini 3 起支持）
//   - thinkingConfig：includeThoughts + 钉死的 thinkingLevel（LOW/MEDIUM/HIGH）
import { anthropicToCore, coreToGoogle, extractSystem } from '../../vendor/kernel-wire.mjs'
import { sseDataLines } from '../upstream.mjs'
import { sha256 } from '../util.mjs'
import { FwdError, safeToolId, toolResultImages } from './common.mjs'

export const name = 'gemini'
export const OFFICIAL_BASE = 'https://generativelanguage.googleapis.com'
export const LEVELS = Object.freeze(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'])
const SIG = 'fwdg1.'
const NOSIG = 'fwdg1.nosig.'

const textKey = (t) => 'text:' + sha256(t)
const toolKey = (id) => 'tool:' + id

export function buildRequest (body, target, ctx) {
  if (!LEVELS.includes(target.thinkingLevel)) throw new FwdError('CONFIG', `gemini target needs thinkingLevel in ${LEVELS.join('/')}`)
  const sig = ctx.sigStore
  const meta = { thoughtSigAttached: 0, toolSigAttached: 0, textSigAttached: 0, toolResultImages: 0, userImages: 0, midSystemAsUserText: 0 }
  const imgs = toolResultImages(body)
  const { msgs } = anthropicToCore(body)
  for (const m of msgs) {
    if (m.role === 'system') meta.midSystemAsUserText++
    if (m.imagePart && m.imageBase64) meta.userImages++
    else if (m.imagePart) throw new FwdError('NON_BASE64_IMAGE', 'image with a non-base64 source; set transforms.images=placeholder')
    if (m.contentType === 'reasoning' && typeof m.thinkingSignature === 'string' && m.thinkingSignature.startsWith(SIG)) {
      if (!m.thinkingSignature.startsWith(NOSIG)) { m.googleThoughtSignature = m.thinkingSignature.slice(SIG.length); meta.thoughtSigAttached++ }
      delete m.thinkingSignature
    }
    if (m.contentType === 'tool-call' && m.toolCallId) { const s = sig.getG(toolKey(m.toolCallId)); if (s) { m.googleThoughtSignature = s; meta.toolSigAttached++ } }
    if (m.role === 'assistant' && m.contentType === 'text' && !m.imagePart) { const s = sig.getG(textKey(m.text ?? '')); if (s) { m.googleThoughtSignature = s; meta.textSigAttached++ } }
  }
  const contents = coreToGoogle(msgs)
  // 工具结果里的图挂到 functionResponse.parts
  for (const c of contents) {
    for (const p of c.parts ?? []) {
      const fr = p.functionResponse
      if (!fr || !imgs.has(fr.id)) continue
      fr.parts = imgs.get(fr.id).map((x) => ({ inlineData: { mimeType: x.mimeType, data: x.data } }))
      meta.toolResultImages += fr.parts.length
    }
  }
  const sys = extractSystem(body.system)
  const tools = (body.tools ?? []).filter((t) => t && typeof t.name === 'string')
  const tc = body.tool_choice
  const mode = !tc || tc.type === 'auto' ? 'AUTO' : tc.type === 'none' ? 'NONE' : 'ANY'
  const payload = {
    contents,
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
    ...(tools.length ? {
      tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? '', parametersJsonSchema: t.input_schema ?? { type: 'object', properties: {} } })) }],
      toolConfig: { functionCallingConfig: { mode, ...(tc?.type === 'tool' ? { allowedFunctionNames: [tc.name] } : {}) } },
    } : {}),
    generationConfig: { maxOutputTokens: target.maxTokens, thinkingConfig: { includeThoughts: true, thinkingLevel: target.thinkingLevel }, ...(target.sampling ?? {}) },
  }
  return {
    url: `${target.baseUrl}/v1beta/models/${encodeURIComponent(target.model)}:streamGenerateContent?alt=sse`,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    payload,
    meta,
  }
}

export function authHeaders (target, creds) { return { 'x-goog-api-key': creds.apiKey } }

const REFUSAL = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'])

export function parseUpstream (raw, ctx) {
  const blocks = []
  let finish = null
  let usage = {}
  let model = null
  let id = null
  let blockReason = null
  let error = null
  let callIndex = 0
  for (const line of sseDataLines(raw)) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.error) { error = { type: 'upstream_error', message: String(j.error.message ?? j.error.status ?? 'error').slice(0, 300) }; continue }
    if (j.usageMetadata) usage = j.usageMetadata
    if (j.modelVersion) model = j.modelVersion
    if (j.responseId) id = j.responseId
    if (j.promptFeedback?.blockReason) blockReason = j.promptFeedback.blockReason
    const cand = j.candidates?.[0]
    if (!cand) continue
    if (cand.finishReason) finish = cand.finishReason
    for (const p of cand.content?.parts ?? []) {
      const last = blocks.at(-1)
      if (p.functionCall) {
        const fc = p.functionCall
        const tid = safeToolId(fc.id, `${fc.name}|${JSON.stringify(fc.args ?? {})}|${callIndex++}|${raw.length}`)
        blocks.push({ type: 'tool_use', id: tid, name: fc.name, input: fc.args ?? {}, _sig: p.thoughtSignature })
      } else if (p.thought === true) {
        if (last?.type === 'thinking' && !last._sig) { last.thinking += p.text ?? ''; if (p.thoughtSignature) last._sig = p.thoughtSignature }
        else blocks.push({ type: 'thinking', thinking: p.text ?? '', _sig: p.thoughtSignature })
      } else if (typeof p.text === 'string') {
        if (last?.type === 'text') { last.text += p.text; if (p.thoughtSignature) last._sig = p.thoughtSignature }
        else blocks.push({ type: 'text', text: p.text, _sig: p.thoughtSignature })
      }
    }
  }
  const ownSignatures = []
  const sigEntries = []
  for (const b of blocks) {
    if (b.type === 'thinking') { b.signature = b._sig ? SIG + b._sig : NOSIG + sha256(b.thinking).slice(0, 24); ownSignatures.push(b.signature) }
    if (b.type === 'tool_use' && b._sig) sigEntries.push([toolKey(b.id), b._sig])
    if (b.type === 'text' && b._sig) sigEntries.push([textKey(b.text), b._sig])
    delete b._sig
  }
  const content = blocks.filter((b) => !(b.type === 'text' && b.text === ''))
  const hasTool = content.some((b) => b.type === 'tool_use')
  let stop = 'end_turn'
  let refusal = null
  if (blockReason) { stop = 'refusal'; refusal = { blockReason } } else if (finish === 'MAX_TOKENS') stop = 'max_tokens'
  else if (REFUSAL.has(finish)) { stop = 'refusal'; refusal = { finishReason: finish } } else if (hasTool) stop = 'tool_use'
  const abnormal = finish && !['STOP', 'MAX_TOKENS'].includes(finish) && !REFUSAL.has(finish) ? finish : null
  if (ctx?.sigStore) for (const [k, s] of sigEntries) ctx.sigStore.setG(k, s)
  const ok = !error && (finish !== null || blockReason !== null)
  return {
    ok, error: error ?? (ok ? null : { type: 'incomplete_stream', message: 'gemini stream ended without finishReason' }),
    message: { id: id ? `msg_fwdg_${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}` : 'msg_fwdg', model: model ?? null, content, stop_reason: stop },
    usageRaw: usage, ownSignatures, sigEntries: sigEntries.length,
    extras: { finishReason: finish, refusal, abnormalFinish: abnormal },
  }
}
