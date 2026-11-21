// OpenAI 兼容（scarletkc：自建推理机上的 vLLM 0.31.0，/v1/chat/completions）。
// 消息转换用 fork 内核 5bb25bf 的 anthropicToCore → coreToOpenai → injectOpenaiSystem（vendor/kernel-wire.mjs），这里补：
//   - 思考字段名：内核写 reasoning_content；vLLM 回的是 reasoning。发回去用哪个名字由配置定（openai.reasoningInField，进指纹），
//     真冒烟里核过哪个能被 Qwen 的模板读到
//   - 对话中间的 system：Qwen 的模板可能只认开头的 system。openai.midSystem = 'keep' | 'to-user'（改成 user 文字「[system]\n…」）
//   - 工具结果里的图：内核只留文字；照 pi-ai 的做法，在那一串 tool 消息后面另起一条 user（"Attached image(s) from tool result:" + 图）
//   - 一次最多 128 张图（vLLM --limit-mm-per-prompt image=128）：超了转发器自己先拒，不白等预填
//   - chat_template_kwargs.enable_thinking、采样参数钉死（进指纹）；stream_options.include_usage 拿用量
import { anthropicToCore, coreToOpenai, extractSystem, injectOpenaiSystem } from '../../vendor/kernel-wire.mjs'
import { sseDataLines } from '../upstream.mjs'
import { sha256 } from '../util.mjs'
import { FwdError, safeToolId, toolResultImages } from './common.mjs'

export const name = 'openai'
export const REASONING_FIELDS = Object.freeze(['reasoning_content', 'reasoning', 'reasoning_text'])
const SIG = 'fwdo1:'

export function buildRequest (body, target) {
  const o = target.openai ?? {}
  const field = o.reasoningInField ?? 'reasoning_content'
  if (!REASONING_FIELDS.includes(field)) throw new FwdError('CONFIG', `openai.reasoningInField must be one of ${REASONING_FIELDS.join('/')}`)
  const midSystem = o.midSystem ?? 'keep'
  if (!['keep', 'to-user'].includes(midSystem)) throw new FwdError('CONFIG', 'openai.midSystem must be keep or to-user')
  const maxImages = o.maxImages ?? 128
  const meta = { midSystemConverted: 0, reasoningMessages: 0, toolResultImages: 0, userImages: 0, reasoningField: field }
  const imgs = toolResultImages(body)
  const { msgs } = anthropicToCore(body)
  for (const m of msgs) if (m.imagePart && !m.imageBase64) throw new FwdError('NON_BASE64_IMAGE', 'image with a non-base64 source; set transforms.images=placeholder')
  const sys = extractSystem(body.system)
  let messages = injectOpenaiSystem(coreToOpenai(msgs), sys ? [sys] : [])

  const out = []
  for (let i = 0; i < messages.length; i++) {
    let m = messages[i]
    if ('reasoning_content' in m) {
      meta.reasoningMessages++
      if (field !== 'reasoning_content') { m = { ...m, [field]: m.reasoning_content }; delete m.reasoning_content }
    }
    if (i > 0 && (m.role === 'system' || m.role === 'developer') && midSystem === 'to-user') {
      const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('\n')
      m = { role: 'user', content: `[system]\n${text}` }
      meta.midSystemConverted++
    }
    if (m.role === 'user' && Array.isArray(m.content)) meta.userImages += m.content.filter((p) => p?.type === 'image_url').length
    out.push(m)
    // 一串 tool 消息结束时，把这串里带的图另起一条 user
    if (m.role === 'tool' && messages[i + 1]?.role !== 'tool') {
      let j = out.length - 1
      const parts = []
      while (j >= 0 && out[j].role === 'tool') { parts.unshift(...(imgs.get(out[j].tool_call_id) ?? []).map((x) => ({ type: 'image_url', image_url: { url: `data:${x.mimeType};base64,${x.data}` } }))); j-- }
      if (parts.length) { out.push({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...parts] }); meta.toolResultImages += parts.length }
    }
  }
  messages = out
  const totalImages = meta.userImages + meta.toolResultImages
  if (totalImages > maxImages) throw new FwdError('TOO_MANY_IMAGES', `request carries ${totalImages} images, the endpoint takes at most ${maxImages}`)

  const tools = (body.tools ?? []).filter((t) => t && typeof t.name === 'string')
  const tc = body.tool_choice
  const payload = {
    model: target.model,
    messages,
    ...(tools.length ? {
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } })),
      tool_choice: !tc || tc.type === 'auto' ? 'auto' : tc.type === 'none' ? 'none' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : 'required',
    } : {}),
    max_tokens: target.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: o.enableThinking !== false },
    ...(target.sampling ?? {}),
  }
  return { url: `${target.baseUrl}/chat/completions`, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, payload, meta }
}

/** 本地 vLLM 没开 --api-key：占位的那一位字符不当真，不发 Authorization。 */
export function authHeaders (target, creds) { return creds?.apiKey && creds.apiKey.length > 2 ? { authorization: `Bearer ${creds.apiKey}` } : {} }

export function parseUpstream (raw) {
  let thinking = ''
  let thinkField = null
  let text = ''
  const calls = new Map()
  let finish = null
  let usage = {}
  let model = null
  let id = null
  let error = null
  let done = false
  for (const line of sseDataLines(raw)) {
    if (line.trim() === '[DONE]') { done = true; continue }
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.error) { error = { type: 'upstream_error', message: String(j.error.message ?? j.error).slice(0, 300) }; continue }
    if (j.model) model = j.model
    if (j.id) id = j.id
    if (j.usage) usage = j.usage
    for (const ch of j.choices ?? []) {
      const d = ch.delta ?? {}
      for (const f of REASONING_FIELDS) if (typeof d[f] === 'string' && d[f]) { thinking += d[f]; thinkField = thinkField ?? f }
      if (typeof d.content === 'string') text += d.content
      for (const tc of d.tool_calls ?? []) {
        const k = tc.index ?? 0
        const cur = calls.get(k) ?? { id: null, name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
        calls.set(k, cur)
      }
      if (ch.finish_reason) finish = ch.finish_reason
    }
  }
  const content = []
  const ownSignatures = []
  if (thinking) { const sig = `${SIG}${thinkField}:${sha256(thinking).slice(0, 24)}`; content.push({ type: 'thinking', thinking, signature: sig }); ownSignatures.push(sig) }
  if (text) content.push({ type: 'text', text })
  let badToolArgs = 0
  for (const [k, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    let input = {}
    if (c.args.trim()) { try { input = JSON.parse(c.args) } catch { badToolArgs++ } }
    content.push({ type: 'tool_use', id: safeToolId(c.id, `${c.name}|${c.args}|${k}|${raw.length}`), name: c.name, input })
  }
  const hasTool = content.some((b) => b.type === 'tool_use')
  const stop = finish === 'length' ? 'max_tokens' : hasTool ? 'tool_use' : 'end_turn'
  const ok = !error && finish !== null
  return {
    ok, error: error ?? (ok ? null : { type: 'incomplete_stream', message: `openai stream ended without finish_reason${done ? '' : ' or [DONE]'}` }),
    message: { id: id ? `msg_fwdo_${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}` : 'msg_fwdo', model, content, stop_reason: stop },
    usageRaw: usage, ownSignatures,
    extras: { finishReason: finish, reasoningFieldSeen: thinkField, badToolArgs, refusal: null },
  }
}
