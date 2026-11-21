// Anthropic（claude-opus-5-5）：消息几乎原样过去，换模型、钉住思考和档位：
//   thinking 只能是 {type:'adaptive'}（disabled / budget_tokens 在 Opus 5.5 上是 400）；档位放 output_config.effort，必须在配置里写明
//   （不写默认是 medium，跑和跑之间会悄悄不一样）；没有服务端 fallbacks（会让指纹失真）。
//   block_binding（可选，进指纹）：'drop_block' | 'error' | null。转发器的变换是确定的，但代理拷贝每轮把最新的 system 挪到最后，
//   这会让 Opus 自己上一轮的思考块对不上前缀：设 drop_block 时 API 丢掉对不上的块照常回（数量记在 input_transformations），
//   设 error 时直接 400，null 时按账户默认（2026-08-31 以后开的账户会 400）。
//   tool_choice 只认 auto / none（any、tool 在开着思考时是 400），强制的改成 auto 并计数。
//   file 图拒发（Anthropic 那边认不得 DeepSeek 的 file_id）；base64 图照发。
//   cache_control 断点最多 4 个：超了留第一个和最后三个。
//   对话中间的 system 消息：前面得是 user，后面得是结尾或 assistant；不合规的改成 user 文字并计数。
//   采样参数（temperature / top_p / top_k）一律不发。
import { parseSSE, assembleMessage } from '../../../lib/sse.mjs'
import { assertNoFileImages, FwdError } from './common.mjs'

export const name = 'anthropic'
export const OFFICIAL_BASE = 'https://api.anthropic.com'
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

function systemText (m) {
  return typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
}

export function buildRequest (body, target) {
  if (!EFFORTS.includes(target.effort)) throw new FwdError('CONFIG', `anthropic target needs effort in ${EFFORTS.join('/')}`)
  if (!(target.maxTokens > 0 && target.maxTokens <= 128000)) throw new FwdError('CONFIG', 'anthropic maxTokens must be 1..128000')
  assertNoFileImages(body)
  const meta = { toolChoiceForcedToAuto: 0, midSystemConverted: 0, cacheBreakpointsDropped: 0, droppedSampling: [], betas: [] }
  const messages = structuredClone(body.messages ?? [])

  // 对话中间的 system 消息的位置
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'system') continue
    const prevOk = i > 0 && messages[i - 1].role === 'user'
    const next = messages[i + 1]
    const nextOk = next === undefined || next.role === 'assistant'
    if (!prevOk || !nextOk) { messages[i] = { role: 'user', content: [{ type: 'text', text: `[system]\n${systemText(m)}` }] }; meta.midSystemConverted++ }
  }

  let tools = body.tools
  let usesToolChanges = false
  for (const m of messages) if (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_addition' || b?.type === 'tool_removal')) usesToolChanges = true

  let toolChoice = body.tool_choice
  if (toolChoice && (toolChoice.type === 'any' || toolChoice.type === 'tool')) { toolChoice = { type: 'auto' }; meta.toolChoiceForcedToAuto++ }

  for (const k of ['temperature', 'top_p', 'top_k']) if (body[k] !== undefined) meta.droppedSampling.push(k)

  const payload = {
    model: target.model,
    max_tokens: target.maxTokens,
    stream: true,
    thinking: { type: 'adaptive', ...(target.anthropic?.blockBinding ? { block_binding: { prefix_mismatch_behavior: target.anthropic.blockBinding } } : {}) },
    output_config: { effort: target.effort },
    ...(body.system !== undefined ? { system: structuredClone(body.system) } : {}),
    messages,
    ...(tools !== undefined ? { tools: structuredClone(tools) } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(body.stop_sequences ? { stop_sequences: body.stop_sequences } : {}),
  }

  // cache_control 断点（system、tools、消息里的块）
  const marks = []
  const visit = (holder) => { if (holder && typeof holder === 'object' && holder.cache_control) marks.push(holder) }
  if (Array.isArray(payload.system)) payload.system.forEach(visit)
  if (Array.isArray(payload.tools)) payload.tools.forEach(visit)
  for (const m of payload.messages) if (Array.isArray(m.content)) m.content.forEach(visit)
  if (marks.length > 4) {
    const keep = new Set([marks[0], ...marks.slice(-3)])
    for (const h of marks) if (!keep.has(h)) { delete h.cache_control; meta.cacheBreakpointsDropped++ }
  }
  meta.cacheBreakpoints = Math.min(marks.length, 4)

  if (target.anthropic?.blockBinding) meta.betas.push('thinking-binding-controls-2026-08-01')
  if (usesToolChanges) meta.betas.push('mid-conversation-tool-changes-2026-07-01')
  return {
    url: `${target.baseUrl}/v1/messages`,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01', ...(meta.betas.length ? { 'anthropic-beta': meta.betas.join(',') } : {}) },
    payload,
    meta,
  }
}

export function authHeaders (target, creds) { return { 'x-api-key': creds.apiKey } }

export function parseUpstream (raw) {
  const events = parseSSE(raw)
  const { ok, message, error } = assembleMessage(events)
  let stopDetails = null
  let transformations = null
  for (const { data } of events) {
    if (data?.type === 'message_start' && Array.isArray(data.message?.input_transformations)) transformations = data.message.input_transformations
    if (data?.type === 'message_delta') {
      if (data.delta?.stop_details) stopDetails = data.delta.stop_details
      if (Array.isArray(data.input_transformations)) transformations = data.input_transformations
    }
  }
  const ownSignatures = []
  for (const b of message?.content ?? []) {
    if (b.type === 'thinking' && b.signature) ownSignatures.push(b.signature)
    if (b.type === 'redacted_thinking' && b.data) ownSignatures.push(b.data)
  }
  if (message && stopDetails) message.stop_details = stopDetails
  const dropped = (transformations ?? []).filter((t) => t?.type === 'thinking_dropped')
  return {
    ok, message, error, usageRaw: message?.usage ?? {}, ownSignatures,
    extras: {
      refusal: message?.stop_reason === 'refusal' ? (stopDetails ?? true) : null,
      thinkingDropped: dropped.length,
      thinkingDroppedReasons: [...new Set(dropped.map((t) => t.reason))],
      mismatchAllowed: (transformations ?? []).filter((t) => t?.type === 'thinking_mismatch_allowed').length,
    },
  }
}
