// 往上游发一次（不重试）。先等到状态码（onStatus 回调，转发器靠它决定回代理 400 还是开始回流），再把整份响应收齐。
// 只记时间，不记头和正文以外的东西；凭据只在 headers 里、只在这一次调用的内存里。
import http from 'node:http'
import https from 'node:https'

export class UpstreamError extends Error { constructor (code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra) } }

/**
 * @returns Promise<{ status, contentType, raw, ttfbMs, totalMs }>；网络错、超时 → UpstreamError（带 phase: 'connect'|'stream'）
 */
export function sendUpstream ({ url, headers, body, timeoutMs = 900_000, onStatus = () => {} }) {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    let ttfbMs = null
    let gotStatus = false
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      agent: false,
    }, (res) => {
      gotStatus = true
      try { onStatus(res.statusCode) } catch { /* 回调的错不影响收 */ }
      const chunks = []
      res.on('data', (c) => { if (ttfbMs === null) ttfbMs = Date.now() - t0; chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, contentType: String(res.headers['content-type'] ?? ''), raw: Buffer.concat(chunks).toString('utf8'), ttfbMs, totalMs: Date.now() - t0 }))
      res.on('error', (e) => reject(new UpstreamError('STREAM', `upstream stream error: ${e.code ?? e.message}`, { phase: 'stream' })))
      res.on('aborted', () => reject(new UpstreamError('STREAM', 'upstream aborted', { phase: 'stream' })))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new UpstreamError('TIMEOUT', `upstream timeout after ${timeoutMs}ms`, { phase: gotStatus ? 'stream' : 'connect' })))
    req.on('error', (e) => reject(e instanceof UpstreamError ? e : new UpstreamError('NET', `upstream network error: ${e.code ?? e.message}`, { phase: gotStatus ? 'stream' : 'connect' })))
    req.end(body)
  })
}

/** SSE 的 data 行（OpenAI / Gemini 的流没有 event 名，只有 data:）。 */
export function sseDataLines (raw) {
  const out = []
  for (const chunk of String(raw).replace(/\r\n/g, '\n').split('\n\n')) {
    const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
    if (data) out.push(data)
  }
  return out
}
