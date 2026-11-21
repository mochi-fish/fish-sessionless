// Anthropic Messages 的流（SSE）：拆成事件、拼回一条 assistant 消息；反过来把一条消息写成流（假上游用）。
// 只认协议里的几种块：thinking（thinking_delta / signature_delta）、redacted_thinking、text、tool_use（input_json_delta）。

/** 'event: x\ndata: {...}\n\n' 一段段拆开 → [{ event, data }]（data 解不开的留原文） */
export function parseSSE (text) {
  const out = []
  for (const chunk of String(text).replace(/\r\n/g, '\n').split('\n\n')) {
    if (!chunk.trim()) continue
    let event = null
    const data = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!data.length && !event) continue
    const raw = data.join('\n')
    let parsed = raw
    try { parsed = JSON.parse(raw) } catch { /* 留原文 */ }
    out.push({ event: event ?? parsed?.type ?? null, data: parsed })
  }
  return out
}

/**
 * 流 → { ok, message: { id, model, role, content[], stop_reason, usage }, error, events }。
 * content 里每块照协议的样子（tool_use.input 是解好的对象；解不开的放 _rawInput、input 给 {}）。
 */
export function assembleMessage (events, { requireStop = true } = {}) {
  const msg = { id: null, model: null, role: 'assistant', content: [], stop_reason: null, usage: {} }
  const parts = new Map()
  let error = null
  let sawStop = false
  for (const { data } of events) {
    if (data?.type === 'message_stop') sawStop = true
    if (!data || typeof data !== 'object') continue
    switch (data.type) {
      case 'message_start': {
        const m = data.message ?? {}
        msg.id = m.id ?? null
        msg.model = m.model ?? null
        Object.assign(msg.usage, m.usage ?? {})
        break
      }
      case 'content_block_start': {
        const b = structuredClone(data.content_block ?? {})
        if (b.type === 'tool_use') { b._json = ''; if (b.input && Object.keys(b.input).length) b._preset = b.input; b.input = {} }
        if (b.type === 'thinking') { b.thinking = b.thinking ?? ''; if (b.signature === undefined) b.signature = '' }
        if (b.type === 'text') b.text = b.text ?? ''
        parts.set(data.index, b)
        break
      }
      case 'content_block_delta': {
        const b = parts.get(data.index)
        const d = data.delta ?? {}
        if (!b) break
        if (d.type === 'text_delta') b.text += d.text ?? ''
        else if (d.type === 'thinking_delta') b.thinking += d.thinking ?? ''
        else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + (d.signature ?? '')
        else if (d.type === 'input_json_delta') b._json += d.partial_json ?? ''
        break
      }
      case 'content_block_stop': break
      case 'message_delta': {
        if (data.delta?.stop_reason !== undefined) msg.stop_reason = data.delta.stop_reason
        Object.assign(msg.usage, data.usage ?? {})
        break
      }
      case 'error': error = data.error ?? data; break
      default: break
    }
  }
  for (const idx of [...parts.keys()].sort((a, b) => a - b)) {
    const b = parts.get(idx)
    if (b.type === 'tool_use') {
      const raw = b._json
      delete b._json
      if (raw.trim() === '') b.input = b._preset ?? {}
      else { try { b.input = JSON.parse(raw) } catch { b.input = {}; b._rawInput = raw } }
      delete b._preset
    }
    msg.content.push(b)
  }
  // 复核 A2（11-19）：流干净地结束、却没有 message_stop 也没有 stop_reason，是半截的回复（提供方照样收了钱），
  // 不能当成功：记 incomplete_stream（转发器按整份预留结账、不进成功缓存；执行器当出错）
  const complete = sawStop || msg.stop_reason !== null
  if (error === null && requireStop && !complete) error = { type: 'incomplete_stream', message: 'stream ended without message_stop / stop_reason' }
  return { ok: error === null, message: msg, error, complete }
}

/** 非流的 JSON 回复 → 同样的形状 */
export function fromJsonReply (obj) {
  if (obj?.type === 'error' || obj?.error) return { ok: false, message: null, error: obj.error ?? obj }
  return { ok: true, message: { id: obj.id ?? null, model: obj.model ?? null, role: 'assistant', content: structuredClone(obj.content ?? []), stop_reason: obj.stop_reason ?? null, usage: obj.usage ?? {} }, error: null }
}

const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

/** 一条消息 → 流（假上游用；工具参数按 JSON 一次给完，文字一次给完） */
export function messageToSSE (msg) {
  let s = ev('message_start', { message: { id: msg.id ?? 'msg_fake', type: 'message', role: 'assistant', content: [], model: msg.model ?? 'fake', stop_reason: null, usage: { input_tokens: msg.usage?.input_tokens ?? 0, output_tokens: 0, ...(msg.usage?.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: msg.usage.cache_read_input_tokens } : {}) } } })
  ;(msg.content ?? []).forEach((b, index) => {
    if (b.type === 'thinking') {
      s += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      if (b.thinking) s += ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } })
      s += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature ?? '' } })
    } else if (b.type === 'text') {
      s += ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      if (b.text) s += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else if (b.type === 'tool_use') {
      s += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      s += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } })
    }
    s += ev('content_block_stop', { index })
  })
  s += ev('message_delta', { delta: { stop_reason: msg.stop_reason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: msg.usage?.output_tokens ?? 1 } })
  s += ev('message_stop', {})
  return s
}
