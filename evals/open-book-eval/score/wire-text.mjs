// 从一份 wire.json（这一步模型眼前的全部字节）里按「在哪儿」切出文字段。
// 认三种线格式：Anthropic Messages（DeepSeek 的 /anthropic 线和 Anthropic 本家一样）、OpenAI chat（vLLM / scarletkc）、
// Google generateContent（contents / parts）。都认不出就整份 JSON 里的字符串一律算 other。
//
// 段的种类（kind）：
//   system      系统段（身份、桥的段落、便条和卡）
//   tools       工具表（schema 和说明）
//   block       她写的摘要块（代理折起来的那种，以「[Compressed conversation section]」开头）
//   recent      近期原话：user 的文字（不是摘要块）
//   assistant   她以前（或这一半前几步）写的字、调工具的参数
//   toolResult  工具结果（历史里的，和这一半自己调出来的都在 wire 里）
//   other       认不出的
//
// 只读、纯函数（readWire 读一次文件）。不打印任何正文。
import { readFileSync } from 'node:fs'

export const SUMMARY_HEADERS = Object.freeze(['[Compressed conversation section]'])

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const isStr = (x) => typeof x === 'string'

export function isSummaryText (t) {
  if (!isStr(t)) return false
  const s = t.trimStart()
  return SUMMARY_HEADERS.some((h) => s.startsWith(h))
}

export function readWire (path) {
  const raw = readFileSync(path)
  return { raw, body: JSON.parse(raw.toString('utf8')) }
}

/** 线格式：anthropic | openai | google | unknown */
export function wireKind (body) {
  if (!isObj(body)) return 'unknown'
  if (Array.isArray(body.contents)) return 'google'
  if (Array.isArray(body.messages)) {
    const roles = new Set(body.messages.map((m) => m?.role))
    // 先认 Anthropic 线：DSH 发给 DeepSeek 的那种也带 role:"system" 消息，但有 tool_use / tool_result / thinking 块或 thinking、output_config 字段
    const anthBlocks = body.messages.some((m) => Array.isArray(m?.content) && m.content.some((b) => isObj(b) && ['tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(b.type)))
    if (anthBlocks || body.system !== undefined || body.thinking !== undefined || body.output_config !== undefined) return 'anthropic'
    if (roles.has('tool') || roles.has('system') || roles.has('developer') || body.messages.some((m) => Array.isArray(m?.tool_calls))) return 'openai'
    // 都是纯文字的 user/assistant：两家长得一样，按 anthropic 认（kind 不影响切段）
    return 'anthropic'
  }
  return 'unknown'
}

function allStrings (v, out) {
  if (isStr(v)) out.push(v)
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out)
  else if (isObj(v)) for (const x of Object.values(v)) allStrings(x, out)
  return out
}

function contentText (c) {
  if (isStr(c)) return c
  if (Array.isArray(c)) return c.map((p) => (isStr(p) ? p : isStr(p?.text) ? p.text : isStr(p?.content) ? p.content : contentText(p?.content ?? ''))).join('\n')
  if (isObj(c) && isStr(c.text)) return c.text
  return ''
}

/**
 * → [{ kind, msgIndex, text }]（msgIndex 是 messages / contents 里的下标；system、tools 是 -1）
 * 顺序跟 wire 里一致。
 */
export function segments (body) {
  const out = []
  const push = (kind, msgIndex, text) => { if (isStr(text) && text !== '') out.push({ kind, msgIndex, text }) }
  const k = wireKind(body)
  if (k === 'anthropic') {
    if (isStr(body.system)) push('system', -1, body.system)
    else if (Array.isArray(body.system)) for (const b of body.system) push('system', -1, contentText(b))
    if (Array.isArray(body.tools)) push('tools', -1, allStrings(body.tools, []).join('\n'))
    body.messages.forEach((m, i) => {
      const blocks = isStr(m?.content) ? [{ type: 'text', text: m.content }] : Array.isArray(m?.content) ? m.content : []
      for (const b of blocks) {
        if (!isObj(b)) continue
        if (b.type === 'text') {
          if (m.role === 'assistant') push('assistant', i, b.text)
          // DSH 把系统提示当成 messages 里一条 role:"system" 的消息发（执行端照这个样子）：算系统段，不算原文
          else if (m.role === 'system') push('system', i, b.text)
          else push(isSummaryText(b.text) ? 'block' : 'recent', i, b.text)
        } else if (b.type === 'tool_use') push('assistant', i, allStrings(b.input ?? {}, []).join('\n'))
        else if (b.type === 'tool_result') push('toolResult', i, contentText(b.content ?? ''))
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') { /* 思考不算她眼前的材料 */ } else push('other', i, allStrings(b, []).join('\n'))
      }
    })
  } else if (k === 'openai') {
    if (Array.isArray(body.tools)) push('tools', -1, allStrings(body.tools, []).join('\n'))
    body.messages.forEach((m, i) => {
      const t = contentText(m?.content ?? '')
      if (m?.role === 'system' || m?.role === 'developer') push('system', -1, t)
      else if (m?.role === 'tool') push('toolResult', i, t)
      else if (m?.role === 'assistant') {
        push('assistant', i, t)
        for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) push('assistant', i, String(tc?.function?.arguments ?? ''))
      } else push(isSummaryText(t) ? 'block' : 'recent', i, t)
    })
  } else if (k === 'google') {
    const si = body.systemInstruction ?? body.system_instruction
    if (si !== undefined) push('system', -1, allStrings(si, []).join('\n'))
    if (Array.isArray(body.tools)) push('tools', -1, allStrings(body.tools, []).join('\n'))
    body.contents.forEach((c, i) => {
      for (const p of Array.isArray(c?.parts) ? c.parts : []) {
        if (isStr(p?.text)) {
          if (p.thought === true) continue
          if (c.role === 'model') push('assistant', i, p.text)
          else push(isSummaryText(p.text) ? 'block' : 'recent', i, p.text)
        } else if (isObj(p?.functionCall)) push('assistant', i, allStrings(p.functionCall.args ?? {}, []).join('\n'))
        else if (isObj(p?.functionResponse)) push('toolResult', i, allStrings(p.functionResponse.response ?? {}, []).join('\n'))
      }
    })
  } else {
    push('other', -1, allStrings(body, []).join('\n'))
  }
  return out
}

/** 整份 wire 的文字（给编造复核核子串、给第③层泄漏扫用）。includeTools=false 时不带工具表。 */
export function wireText (body, { includeTools = true } = {}) {
  return segments(body).filter((s) => includeTools || s.kind !== 'tools').map((s) => s.text).join('\n')
}

/** 一个 marker 在这份 wire 里出现在哪几种段（system / block / recent / assistant / toolResult / tools / other）。 */
export function locate (body, has) {
  const where = new Set()
  for (const s of segments(body)) if (has(s.text)) where.add(s.kind)
  return [...where].sort()
}

/** 漏斗第一段的归类：按「她最容易看到」排一个主位置。 */
export function primaryLocation (kinds) {
  for (const k of ['recent', 'assistant', 'block', 'system', 'toolResult']) if (kinds.includes(k)) return k
  return kinds.length ? 'other' : 'absent'
}
