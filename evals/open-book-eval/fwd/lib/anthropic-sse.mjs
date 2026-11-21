// 回给代理拷贝的 Anthropic 流。转发器把目标模型的回复先整份收齐、转成一条 Anthropic 消息，再一次写成流；
// 等上游的时候每隔一会儿发一个 ping（协议里本来就有的事件），免得代理那边等头等到超时。
const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

export const pingEvent = () => ev('ping', {})
export const errorEvent = (type, message) => ev('error', { error: { type, message } })

/** msg: { id, model, content[], stop_reason, stop_details? }；usage：已经按 pinned / real 映射好的 Anthropic 用量。 */
export function sseFromMessage (msg, usage) {
  const u = { input_tokens: usage.input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 }
  let s = ev('message_start', { message: { id: msg.id ?? 'msg_fwd', type: 'message', role: 'assistant', content: [], model: msg.model ?? 'fwd', stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } } })
  ;(msg.content ?? []).forEach((b, index) => {
    if (b.type === 'thinking') {
      s += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      if (b.thinking) s += ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } })
      s += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature ?? '' } })
    } else if (b.type === 'redacted_thinking') {
      s += ev('content_block_start', { index, content_block: { type: 'redacted_thinking', data: b.data ?? '' } })
    } else if (b.type === 'text') {
      s += ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      if (b.text) s += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else if (b.type === 'tool_use') {
      s += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      s += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } })
    } else return
    s += ev('content_block_stop', { index })
  })
  s += ev('message_delta', { delta: { stop_reason: msg.stop_reason ?? 'end_turn', stop_sequence: null, ...(msg.stop_details ? { stop_details: msg.stop_details } : {}) }, usage: { ...u, output_tokens: usage.output_tokens ?? 0 } })
  s += ev('message_stop', {})
  return s
}
