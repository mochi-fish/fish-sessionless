// 转发器的配置：读、补默认、核。出网名单（FWD_EGRESS_ALLOW）也从这里算，start.mjs 和 forwarder.mjs 用同一份算法，
// 转发器起来时核「预加载的出网闸的名单 == 按配置算出来的名单」，对不上就不起。
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve, dirname } from 'node:path'
import { readPiAiRoutes } from './credentials.mjs'
import { portAllowed } from './util.mjs'
import { normalizeTransformConfig } from './transforms.mjs'

export const PROVIDERS = Object.freeze(['deepseek', 'anthropic', 'gemini', 'openai'])
const OFFICIAL = { deepseek: 'https://api.deepseek.com', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com' }

/** 正式的上游地址。openai（自建的 OpenAI 兼容服务，比如 vLLM）取环境变量 FWD_OPENAI_BASE_URL；没给就看 FWD_CORDIS_FILE 里 self-hosted 那条路线的 baseURL。 */
export function officialBase (provider) {
  if (OFFICIAL[provider]) return OFFICIAL[provider]
  if (provider === 'openai') {
    const env = String(process.env.FWD_OPENAI_BASE_URL ?? '').trim()
    if (env) return env.replace(/\/+$/, '')
    const r = readPiAiRoutes()['self-hosted']
    if (!r?.baseURL) throw new Error('openai provider needs FWD_OPENAI_BASE_URL (or a self-hosted route in FWD_CORDIS_FILE)')
    return String(r.baseURL).replace(/\/+$/, '')
  }
  throw new Error(`unknown provider ${provider}`)
}

const isLoopHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]'

export function loadConfig (file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const base = dirname(resolve(file))
  const abs = (p) => (p == null ? p : (isAbsolute(p) ? p : resolve(base, p)))
  const c = structuredClone(raw)
  if (!PROVIDERS.includes(c.target?.provider)) throw new Error(`target.provider must be one of ${PROVIDERS.join('/')}`)
  if (!['synthetic', 'real'].includes(c.arm)) throw new Error('arm must be synthetic or real')
  c.usageFeedback = c.usageFeedback ?? 'pinned'
  if (!['pinned', 'real'].includes(c.usageFeedback)) throw new Error('usageFeedback must be pinned or real')
  c.summaryPolicy = c.summaryPolicy ?? 'refuse'
  if (!['refuse', 'placeholder', 'forward'].includes(c.summaryPolicy)) throw new Error('summaryPolicy must be refuse/placeholder/forward')
  c.testMode = c.testMode === true
  c.offline = c.offline === true
  c.stateDir = abs(c.stateDir)
  if (!c.stateDir) throw new Error('stateDir required')
  c.certsDir = abs(c.certsDir)
  c.cacheFrom = abs(c.cacheFrom ?? null)
  c.approvalsFile = abs(c.approvalsFile ?? null)
  c.servingStackFile = abs(c.servingStackFile ?? null)
  if (c.privacy) { c.privacy.snapshotDir = abs(c.privacy.snapshotDir); if (c.privacy.frameworkTextsFile) c.privacy.frameworkTextsFile = abs(c.privacy.frameworkTextsFile) }
  c.listen = { host: '127.0.0.1', port: Number(c.listen?.port ?? 0) }
  if (c.listen.port !== 0 && !portAllowed(c.listen.port)) throw new Error(`listen port ${c.listen.port} not allowed`)
  c.caps = c.caps ?? {}
  c.transforms = normalizeTransformConfig(c.transforms)
  if (c.transforms.relDate.enabled) c.transforms.relDate.module = abs(c.transforms.relDate.module)
  c.upstreamTimeoutMs = Number(c.upstreamTimeoutMs ?? 900_000)
  c.pingMs = Number(c.pingMs ?? 10_000)
  c.saveWire = c.saveWire !== false
  // 明文回环入口（POST /v1/messages）：默认要 x-fwd-token（本机别的进程不能拿它花钱）；A 部分的 EgressFront 现在不带这个头，
  // 接它的时候要么让它带上，要么在这里显式写 requireToken:false（记进 calls.jsonl 的每一行都照旧）
  c.plainHttp = { requireToken: c.plainHttp?.requireToken !== false }
  // CONNECT 入口（复核 A6）：默认开、要 Proxy-Authorization（Basic fwd:<控制口令>）；编排器真跑时关掉（EgressFront 走明文入口）
  c.connectDoor = c.connectDoor !== false
  // 这一单元是哪一臂（真数据臂的许可按臂认，复核 A7）
  c.armId = typeof c.armId === 'string' && c.armId ? c.armId : null
  // 上游地址：正式跑必须是正式地址；testMode 必须是回环（假上游）
  const t = c.target
  if (c.testMode) {
    const u = new URL(t.baseUrl)
    if (u.protocol !== 'http:' || !isLoopHost(u.hostname) || !portAllowed(Number(u.port))) throw new Error('testMode baseUrl must be http://127.0.0.1:<port> outside 18780-18799')
  } else {
    const off = officialBase(t.provider)
    if (t.baseUrl && t.baseUrl.replace(/\/+$/, '') !== off) throw new Error(`target.baseUrl must be the official ${off}`)
    t.baseUrl = off
  }
  t.baseUrl = t.baseUrl.replace(/\/+$/, '')
  // DeepSeek 两种认证都能选（做成可选项）：apiKey（DEEPSEEK_API_KEY）是缺省；account 是她线上 DSH 那条路
  if (t.provider === 'deepseek') t.deepseek = { auth: t.deepseek?.auth ?? 'apiKey' }
  if (t.provider === 'deepseek' && !['account', 'apiKey'].includes(t.deepseek.auth)) throw new Error('deepseek.auth must be account or apiKey')
  // DeepSeek 的回答原样转回（它报的用量就是代理拷贝平时看到的那个数），没有「钉住」这回事：写了 pinned 就报错，不写就记成 real
  if (t.provider === 'deepseek') {
    if (raw.usageFeedback === 'pinned') throw new Error('deepseek replies pass through as-is; usageFeedback must be real (or omitted)')
    c.usageFeedback = 'real'
  }
  t.route = t.route ?? (t.provider === 'deepseek' ? `deepseek-${t.deepseek.auth}` : t.provider === 'openai' ? 'self-hosted' : t.provider)
  // 余额底（复核 A1）：DeepSeek 真出网、上限 > 0 时必须给「余额里给她留多少」（人民币）。转发器起来时读一次余额、之后每 60 秒最多读一次，
  // 能花的 = min(上限剩的, 余额 − 底)；读不到余额（或 is_available 是 false）就不起 / 不发（fail-closed）。
  // 不知道 DEEPSEEK_API_KEY 和她 DSH 账户是不是同一份余额，所以 apiKey 也一样要底。
  c.balanceFloor = c.balanceFloor === undefined || c.balanceFloor === null ? null : Number(c.balanceFloor)
  if (c.balanceFloor !== null && !(Number.isFinite(c.balanceFloor) && c.balanceFloor >= 0)) throw new Error('balanceFloor must be a number >= 0 (CNY)')
  c.balanceCheckMs = Number(c.balanceCheckMs ?? 60_000)
  if (t.provider === 'deepseek' && !c.testMode && !c.offline && Number(c.caps.deepseek ?? 0) > 0 && c.balanceFloor === null) {
    throw new Error('deepseek paid run needs balanceFloor (CNY to leave in her balance; ob.mjs --live-floor deepseek=<CNY>)')
  }
  if (c.balanceFloor !== null && t.provider !== 'deepseek') throw new Error('balanceFloor is only for deepseek')
  // 只数 token（ob count-w，11-19）：变换、换协议、主机闸、隐私闸照真跑走，然后只调 vLLM 的 /tokenize（同一个 host:port），
  // 不发 /chat/completions、不记账、不进缓存。只认 openai（scarletkc 的 vLLM）；上限必须是 0（这条路不花钱，也不许花）
  c.countOnly = c.countOnly === true
  if (c.countOnly && t.provider !== 'openai') throw new Error('countOnly is only for openai (vLLM /tokenize)')
  if (c.countOnly && Object.values(c.caps).some((v) => Number(v) > 0)) throw new Error('countOnly forwarder must have zero caps')
  if (c.countOnly && c.offline) throw new Error('countOnly cannot be offline')
  return c
}

/** 这份配置下转发器许连的上游（host:port），排好序。testMode / offline 时为空（只许回环）。 */
export function expectedAllow (c) {
  if (c.testMode || c.offline) return []
  const u = new URL(c.target.baseUrl)
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  return [`${u.hostname.toLowerCase()}:${port}`]
}
