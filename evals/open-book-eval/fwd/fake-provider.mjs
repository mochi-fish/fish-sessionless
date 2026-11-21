// 假上游（只听 127.0.0.1，端口不在 18780–18799）：四家协议各说一种，给转发器的测试用，不出网。
//   DeepSeek  POST /anthropic/v1/messages                        Anthropic 流（思考签名 ds-sig-…）
//   Anthropic POST /v1/messages                                  核：adaptive 思考、effort、没有采样参数、x-api-key、block_binding 要带 beta 头
//   Gemini    POST /v1beta/models/<m>:streamGenerateContent      核：x-goog-api-key、parametersJsonSchema、thinkingLevel、历史里每个 functionCall 都带 gsig- 签名
//   OpenAI    POST /v1/chat/completions、GET /v1/models          照 vLLM 0.31 的样子：reasoning 字段、128 张图上限、上下文 262144、
//                                                                （可选）中途 system 报 400；POST /tokenize（对话那种，假装数，ob count-w 的回环核对用）
// 最后一条 user 正文里的记号决定怎么回：[[tool]] 调第一个工具；[[call:<工具名> <参数 JSON>]] 调指定的工具（整合冒烟用，11-19 加）；
// [[refuse]] 拒答；[[error500]]；[[slow:毫秒]] 晚回头；[[cut]] 流到一半断开。
// 复核 11-19 加：[[nostop]] 流干净地结束、却没有 stop_reason / message_stop（半截）；[[nousage]] 用量全是 0；
// [[http402]] 回 402「Insufficient Balance」。GET /user/balance 照 DeepSeek 的样子回余额（POST /__fake/balance {total, available} 设）。
// 每个请求都记下来（GET /__fake/requests），测试拿它核转发器发出去的样子。
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const LO = 18780
const HI = 18799

function lastUserText (proto, body) {
  const pick = (blocks) => (typeof blocks === 'string' ? blocks : (blocks ?? []).map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('')) : '')).join('\n'))
  if (proto === 'anthropic' || proto === 'deepseek') { const m = [...(body.messages ?? [])].reverse().find((x) => x.role === 'user'); return m ? pick(m.content) : '' }
  if (proto === 'gemini') { const c = [...(body.contents ?? [])].reverse().find((x) => x.role === 'user'); return (c?.parts ?? []).map((p) => p.text ?? JSON.stringify(p.functionResponse?.response ?? '')).join('\n') }
  const m = [...(body.messages ?? [])].reverse().find((x) => (x.role === 'user' || x.role === 'tool') && !(typeof x.content === 'string' && x.content.startsWith('[system]\n')))
  return typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p) => p.text ?? '').join('\n')
}
// [[call:名字 {参数}]]：参数是一行 JSON（不含「]]」）；解不开就当 {}
function parseCall (text) {
  const m = /\[\[call:([A-Za-z0-9_.-]+)(?:\s+(\{.*?\}))?\]\]/.exec(String(text ?? ''))
  if (!m) return null
  let args = {}
  try { args = m[2] ? JSON.parse(m[2]) : {} } catch { args = {} }
  return { name: m[1], args }
}
const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
const data = (o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`

export function startFakeProvider ({ port = 0, rejectMidSystem = false, maxModelLen = 262144, maxImages = 128 } = {}) {
  const requests = []
  let seq = 0
  const bal = { total: 100, available: true, reads: 0 }
  const server = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', async () => {
      const raw = Buffer.concat(ch).toString('utf8')
      const url = new URL(req.url, 'http://x')
      const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (req.method === 'GET' && url.pathname === '/__fake/requests') return json(200, requests)
      if (req.method === 'POST' && url.pathname === '/__fake/reset') { requests.length = 0; return json(200, { ok: true }) }
      if (req.method === 'POST' && url.pathname === '/__fake/balance') { try { const b = JSON.parse(raw); if (b.total !== undefined) bal.total = b.total; if (b.available !== undefined) bal.available = b.available } catch { /* */ } return json(200, { ok: true, ...bal }) }
      if (req.method === 'GET' && url.pathname === '/__fake/balance') return json(200, bal)
      if (req.method === 'GET' && url.pathname === '/user/balance') {
        bal.reads++
        if (!(req.headers.authorization || req.headers['x-dsh-auth-token'])) return json(401, { error: { message: 'no key' } })
        if (bal.total === 'fail') return json(500, { error: { message: 'fake balance down' } })
        return json(200, { is_available: bal.available, balance_infos: [{ currency: 'CNY', total_balance: String(bal.total), granted_balance: '0.00', topped_up_balance: String(bal.total) }] })
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return json(200, { object: 'list', data: [{ id: 'scarletkc', object: 'model', root: '/models/scarletkc-nvfp4', max_model_len: maxModelLen, owned_by: 'vllm' }] })
      let body = null
      try { body = JSON.parse(raw) } catch { return json(400, { error: { message: 'bad json' } }) }
      const proto = url.pathname === '/anthropic/v1/messages' ? 'deepseek' : url.pathname === '/v1/messages' ? 'anthropic' : /^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(url.pathname) ? 'gemini' : url.pathname === '/v1/chat/completions' ? 'openai' : null
      const hdr = { auth: !!(req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.headers.authorization || req.headers['x-dsh-auth-token']), beta: req.headers['anthropic-beta'] ?? null, dshUser: !!req.headers['x-deepseek-harness-user-id'], dshSession: req.headers['x-deepseek-harness-session-id'] ?? null }
      // vLLM 的 /tokenize（对话那一种；ob count-w 的回环核对用，11-19 加）：按「消息 + 工具的 JSON 字数 / 3」假装数，回 count、max_model_len、tokens
      if (req.method === 'POST' && url.pathname === '/tokenize') {
        const count = Math.ceil(JSON.stringify({ messages: body.messages ?? [], tools: body.tools ?? [] }).length / 3)
        requests.push({ proto: 'tokenize', path: url.pathname, query: url.search, headers: hdr, body: { model: body.model ?? null, messages: (body.messages ?? []).length, tools: (body.tools ?? []).length, addGenerationPrompt: body.add_generation_prompt ?? null, addSpecialTokens: body.add_special_tokens ?? null, chatTemplateKwargs: body.chat_template_kwargs ?? null } })
        return json(200, { count, max_model_len: maxModelLen, tokens: new Array(count).fill(0), token_strs: null })
      }
      requests.push({ proto, path: url.pathname, query: url.search, headers: hdr, body })
      if (!proto) return json(404, { error: { message: 'not found' } })
      const n = ++seq
      const text = lastUserText(proto, body)
      const slow = /\[\[slow:(\d+)\]\]/.exec(text)
      if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])))
      if (text.includes('[[error500]]')) return json(500, { error: { type: 'api_error', message: 'fake overloaded' } })
      if (text.includes('[[http402]]')) return json(402, { error: { type: 'payment_required', message: 'Insufficient Balance' } })
      const nostop = text.includes('[[nostop]]')
      const nousage = text.includes('[[nousage]]')
      const call = parseCall(text)
      // 最后一步不许调工具（tool_choice none / Gemini mode NONE）：照真的那样只回文字
      const noTools = body.tool_choice?.type === 'none' || body.tool_choice === 'none' || body.toolConfig?.functionCallingConfig?.mode === 'NONE'
      const wantTool = (text.includes('[[tool]]') || call !== null) && !noTools
      const refuse = text.includes('[[refuse]]')
      const cut = text.includes('[[cut]]')
      const inTok = nousage ? 0 : Math.ceil(raw.length / 4)

      if (proto === 'anthropic') {
        if (body.thinking?.type !== 'adaptive') return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type must be adaptive' } })
        if (!body.output_config?.effort) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'effort missing (fake strict)' } })
        for (const k of ['temperature', 'top_p', 'top_k']) if (k in body) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: `${k} not supported` } })
        if (body.thinking.block_binding && !String(hdr.beta ?? '').includes('thinking-binding-controls-2026-08-01')) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'block_binding: Extra inputs are not permitted' } })
        if (!req.headers['x-api-key']) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'no key' } })
      }
      if (proto === 'gemini') {
        if (!req.headers['x-goog-api-key']) return json(403, { error: { code: 403, message: 'no key', status: 'PERMISSION_DENIED' } })
        if (!body.generationConfig?.thinkingConfig?.thinkingLevel) return json(400, { error: { code: 400, message: 'thinkingLevel required (fake)', status: 'INVALID_ARGUMENT' } })
        // 真 Gemini 3 只核「当前这一轮」（最后一条带文字的 user 之后）的 functionCall 签名；更早的不核——
        // DSH 的 pi-ai 发外家历史里的 functionCall 就不带签名（在 Gemini 上照样跑）。假上游照这个口径
        const cs = body.contents ?? []
        let turnStart = 0
        cs.forEach((c, i) => { if (c.role === 'user' && (c.parts ?? []).some((p) => typeof p.text === 'string')) turnStart = i })
        for (const c of cs.slice(turnStart)) for (const p of c.parts ?? []) if (c.role === 'model' && p.functionCall && !String(p.thoughtSignature ?? '').startsWith('gsig-')) return json(400, { error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.', status: 'INVALID_ARGUMENT' } })
        for (const t of body.tools?.[0]?.functionDeclarations ?? []) if (!t.parametersJsonSchema) return json(400, { error: { code: 400, message: 'parametersJsonSchema missing (fake)' } })
      }
      if (proto === 'openai') {
        if (rejectMidSystem && (body.messages ?? []).some((m, i) => i > 0 && m.role === 'system')) return json(400, { object: 'error', message: 'System message must be at the beginning.', type: 'BadRequestError', code: 400 })
        const imgs = (body.messages ?? []).reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0)
        if (imgs > maxImages) return json(400, { object: 'error', message: `At most ${maxImages} image(s) may be provided in one prompt.`, type: 'BadRequestError', code: 400 })
        const promptTok = Math.ceil(raw.length / 3)
        if (promptTok + (body.max_tokens ?? 0) > maxModelLen) return json(400, { object: 'error', message: `This model's maximum context length is ${maxModelLen} tokens. However, you requested ${promptTok + (body.max_tokens ?? 0)} tokens. Please reduce the length of the messages or completion.`, type: 'BadRequestError', code: 400 })
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const firstTool = call?.name ?? (proto === 'gemini' ? body.tools?.[0]?.functionDeclarations?.[0]?.name : proto === 'openai' ? body.tools?.[0]?.function?.name : body.tools?.[0]?.name) ?? 'noop'
      const callArgs = call ? call.args : { q: 'x' }
      const argsJson = JSON.stringify(callArgs)
      if (proto === 'deepseek' || proto === 'anthropic') {
        const sigp = proto === 'deepseek' ? 'ds-sig-' : 'ant-sig-'
        let s = ev('message_start', { message: { id: `msg_fake_${n}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, usage: { input_tokens: inTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: nousage ? 0 : 1 }, ...(String(hdr.beta ?? '').includes('thinking-binding-controls') ? { input_transformations: [] } : {}) } })
        s += ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
        s += ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: `想一想（第 ${n} 次）` } })
        s += ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: `${sigp}${n}` } })
        s += ev('content_block_stop', { index: 0 })
        if (cut) { res.write(s); res.destroy(); return }
        if (refuse && proto === 'anthropic') {
          s += ev('message_delta', { delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber', explanation: 'fake refusal' } }, usage: { output_tokens: 5 } })
        } else if (wantTool) {
          s += ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: `toolu_fake_${n}`, name: firstTool, input: {} } })
          s += ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: argsJson } })
          s += ev('content_block_stop', { index: 1 })
          s += ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } })
        } else {
          s += ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
          s += ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '好的，主人。' } })
          s += ev('content_block_stop', { index: 1 })
          if (nostop) return res.end(s)
          s += ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: nousage ? 0 : 9 } })
        }
        s += ev('message_stop', {})
        return res.end(s)
      }
      if (proto === 'gemini') {
        let s = data({ candidates: [{ content: { role: 'model', parts: [{ text: `想一想（第 ${n} 次）`, thought: true, thoughtSignature: `gsig-thought-${n}` }] } }], modelVersion: 'gemini-4-argon', responseId: `resp${n}` })
        if (cut) { res.write(s); res.destroy(); return }
        if (refuse) s += data({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: 0, thoughtsTokenCount: 4 } })
        else if (wantTool) s += data({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: `fc_${n}`, name: firstTool, args: callArgs }, thoughtSignature: `gsig-call-${n}` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: inTok, cachedContentTokenCount: 0, candidatesTokenCount: 6, thoughtsTokenCount: 4 } })
        else {
          s += data({ candidates: [{ content: { role: 'model', parts: [{ text: '好的，' }] } }] })
          s += data({ candidates: [{ content: { role: 'model', parts: [{ text: '主人。', thoughtSignature: `gsig-text-${n}` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: inTok, cachedContentTokenCount: 0, candidatesTokenCount: 5, thoughtsTokenCount: 4 } })
        }
        return res.end(s)
      }
      // openai / vLLM
      const id = `chatcmpl-${n}`
      let s = data({ id, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning: `想一想（第 ${n} 次）` } }] })
      if (cut) { res.write(s); res.destroy(); return }
      if (wantTool) {
        s += data({ id, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `chatcmpl-tool-${n}`, type: 'function', function: { name: firstTool, arguments: argsJson.slice(0, Math.ceil(argsJson.length / 2)) } }] } }] })
        s += data({ id, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(Math.ceil(argsJson.length / 2)) } }] }, finish_reason: 'tool_calls' }] })
      } else {
        s += data({ id, model: body.model, choices: [{ index: 0, delta: { content: '好的，主人。' }, finish_reason: 'stop' }] })
      }
      s += data({ id, model: body.model, choices: [], usage: { prompt_tokens: Math.ceil(raw.length / 3), completion_tokens: 11, total_tokens: Math.ceil(raw.length / 3) + 11 } })
      s += data('[DONE]')
      res.end(s)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      if (p >= LO && p <= HI) { server.close(); reject(new Error('fake provider landed on a live port')); return }
      resolve({ port: p, server, requests, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 0)
  const fp = await startFakeProvider({ port, rejectMidSystem: process.argv.includes('--reject-mid-system') })
  console.log(JSON.stringify({ ready: true, port: fp.port }))
}
