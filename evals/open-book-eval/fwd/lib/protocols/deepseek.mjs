// DeepSeek：原样转发到 api.deepseek.com/anthropic/v1/messages（代理拷贝本来就是这么发的），回复原样回给代理。
// 认证两种（进指纹）：account = DSH 账号那条路（x-dsh-auth-token + 匿名用户 id + 每个会话一个 session id）；
//                   apiKey  = 环境变量 DEEPSEEK_API_KEY（x-api-key）。
// 代理拷贝发来的认证头（假宿主给的占位）一律丢掉，转发器这里现补。
import { parseSSE, assembleMessage } from '../../../lib/sse.mjs'
import { sha256 } from '../util.mjs'

export const name = 'deepseek'
export const OFFICIAL_BASE = 'https://api.deepseek.com'
export const DSH_UA = 'deepseek-harness/0.2.2-rc.3 (+https://github.com/deepseek-ai/deepseek-harness) dsh-profile/desktop'
const BETAS = new Set(['files-api-2025-04-14', 'mid-conversation-tool-changes-2026-07-01'])

export function buildRequest (body, target, ctx = {}) {
  const payload = { ...body }
  if (target.model) payload.model = target.model
  if (target.maxTokens) payload.max_tokens = target.maxTokens
  if (target.effort) payload.output_config = { ...(payload.output_config ?? {}), effort: target.effort }
  const betas = String(ctx.incomingBeta ?? '').split(',').map((s) => s.trim()).filter((s) => BETAS.has(s))
  return {
    url: `${target.baseUrl}/anthropic/v1/messages`,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01', 'user-agent': DSH_UA, ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}) },
    payload,
    meta: { betas },
  }
}

/** 会话 id：按会话键算一个稳定的 uuid 形状（不是她的真会话 id）。 */
export function sessionIdFor (conversationKey) {
  const h = sha256('fwd-session|' + conversationKey)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function authHeaders (target, creds, ctx = {}) {
  if (target.deepseek?.auth === 'apiKey') return { 'x-api-key': creds.apiKey }
  return { 'x-dsh-auth-token': creds.token, 'x-deepseek-harness-user-id': creds.anonymousUserId, 'x-deepseek-harness-session-id': sessionIdFor(ctx.conversationKey ?? '') }
}

export function parseUpstream (raw) {
  const events = parseSSE(raw)
  const { ok, message, error } = assembleMessage(events)
  return { ok, message, error, usageRaw: message?.usage ?? {}, extras: {}, passthrough: true }
}
