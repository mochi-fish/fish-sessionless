// 四家协议共用的小件。
import { sha256 } from '../util.mjs'

/** 转发器自己拒绝（不发）的错：回代理 400，记一行，不花钱。 */
export class FwdError extends Error { constructor (code, msg) { super(msg); this.code = code } }

/** Anthropic 的 tool_use id 只认 [A-Za-z0-9_-]。 */
export const safeToolId = (id, seed) => {
  const s = typeof id === 'string' && id ? id.replace(/[^A-Za-z0-9_-]/g, '_') : ''
  return s || `toolu_fwd_${sha256(String(seed)).slice(0, 20)}`
}

/** tool_use id → 这个工具结果里的图（base64），给 Gemini（functionResponse.parts）和 OpenAI（另起一条 user）用。 */
export function toolResultImages (body) {
  const map = new Map()
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || !Array.isArray(b.content)) continue
      const imgs = b.content.filter((c) => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string')
        .map((c) => ({ mimeType: c.source.media_type, data: c.source.data }))
      const files = b.content.filter((c) => c?.type === 'image' && c.source?.type !== 'base64').length
      if (files) throw new FwdError('NON_BASE64_IMAGE', 'tool_result carries a non-base64 image (file/url); placeholder it first')
      if (imgs.length) map.set(b.tool_use_id, imgs)
    }
  }
  return map
}

/** 用户消息里直接放的非 base64 图（file_id / url）：除了 DeepSeek，别家都看不到，必须先换成占位。 */
export function assertNoFileImages (body) {
  for (const m of body?.messages ?? []) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b?.type === 'image' && b.source?.type !== 'base64') throw new FwdError('NON_BASE64_IMAGE', 'image with a non-base64 source; set transforms.images=placeholder')
  }
}

/** 进指纹的工具表 sha（规范 JSON）。 */
export const toolsShaOf = (tools) => sha256(JSON.stringify(tools ?? []))

export const ANTHROPIC_STOP = Object.freeze(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal'])
