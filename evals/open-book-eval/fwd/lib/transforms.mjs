// 视图变换（eval.md 3.5）。输入是代理拷贝发来的 DeepSeek-Anthropic 请求体，输出是要交给目标协议转换的那一份。
// 规矩：确定（同样的输入同样的输出，不看钟，除了 relDate 用配置里钉死的 now）、幂等（变换两遍和一遍一样）、
//       每一样都计数，配置和代码的 sha 都进指纹。原件不改（先深拷贝）。
//   stripNudge          去掉代理的整理提醒（最后那条 system 前面那条 user 字符串；或者最后一条 user 里打头是提醒的那块）
//   images              'keep' | 'placeholder'：真数据臂把图换成「[图片]」（旧的 file_id 会过期）；合成臂的图留着
//   stripForeignThinking 目标不是 DeepSeek 时去掉别家（DeepSeek）的思考块；这次跑里目标自己产出的（签名登记过的）留着。
//                       去完变空的 assistant 消息整条去掉（计数）
//   localPaths          真数据臂发给非 DeepSeek 的：本机路径换成 ~/…，用户名换成 <用户名>
//   relDate             可选钩子（默认关）：载入配置里那个模块的函数，对 user 正文和工具结果做相对日期换算；函数的 sha 进指纹
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { clone, sha256 } from './util.mjs'

export const NUDGE_PREFIXES = Object.freeze([
  'This is an efficiency nudge', // 内核默认 efficiencyNote
  '这是一条提醒你早点整理', // 中文包 0.2.0 efficiencyNote
  '⚠️ Context limit reached', // 内核默认 emergencyHeader
  '⚠️ 上下文到上限了', // 中文包 0.2.0 emergencyHeader
  'Context breakdown:', // 包把 head 设成 null 时
  '[TIER ',
  '[EMERGENCY',
])
const isNudgeText = (t) => typeof t === 'string' && NUDGE_PREFIXES.some((p) => t.startsWith(p))
const singleText = (c) => (typeof c === 'string' ? c : (Array.isArray(c) && c.length === 1 && c[0]?.type === 'text' ? c[0].text : null))

const REDACT_NAMES = String(process.env.FWD_REDACT_NAMES ?? '').split(',').map((s) => s.trim()).filter((s) => s.length >= 3)
const PATH_RULES = [
  [/\\\\Users\\\\[^\\\s"'<>|:*?]+/gi, '~'],
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|:*?]+/gi, '~'], // 别的账户名也不往外带
  [/\/[a-z]\/Users\/[^/\s"'<>|:*?]+/gi, '~'],
  // 另外要抹掉的名字（账户名、昵称……）：环境变量 FWD_REDACT_NAMES，逗号隔开，每个至少 3 个字符。
  // 注意：它会替换请求里所有字符串值中出现的这个词（连 role 之类的值也算），不要填常用词。
  ...REDACT_NAMES.map((n) => [new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<用户名>']),
]
export const PATH_RE = /(?:[A-Za-z]:[\\/]+Users[\\/]|\/[a-z]\/Users\/|\\\\Users\\\\)/i

const SKIP_KEYS = new Set(['signature', 'data', 'media_type'])
function mapStrings (v, fn, key = null) {
  if (typeof v === 'string') return SKIP_KEYS.has(key) ? v : fn(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn, null))
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = mapStrings(x, fn, k); return o }
  return v
}

/** 把配置规整成进指纹的那一份。 */
export function normalizeTransformConfig (c = {}) {
  return {
    stripNudge: c.stripNudge !== false,
    images: c.images ?? 'keep',
    stripForeignThinking: c.stripForeignThinking === true,
    localPaths: c.localPaths === true,
    relDate: c.relDate?.enabled ? { enabled: true, module: c.relDate.module, export: c.relDate.export ?? 'relDate', now: c.relDate.now } : { enabled: false },
  }
}

export async function loadRelDate (cfg) {
  if (!cfg?.enabled) return { fn: null, sha: null }
  if (!cfg.module || !cfg.now) throw new Error('relDate needs module and a fixed now')
  const sha = sha256(readFileSync(cfg.module))
  const mod = await import(pathToFileURL(cfg.module).href)
  const fn = mod[cfg.export]
  if (typeof fn !== 'function') throw new Error(`relDate module has no export ${cfg.export}`)
  return { fn, sha }
}

/**
 * @param body   代理发来的请求体（不改它）
 * @param cfg    normalizeTransformConfig 的结果
 * @param ctx    { ownSignature: (sig) => boolean, relDateFn }
 * @returns { body, counts }
 */
export function applyTransforms (body, cfg, ctx = {}) {
  const b = clone(body)
  const counts = { nudgeMessages: 0, nudgeBlocks: 0, imagesReplaced: 0, foreignThinking: 0, ownThinkingKept: 0, emptyAssistantDropped: 0, pathsReplaced: 0, relDateChanged: 0 }
  const msgs = Array.isArray(b.messages) ? b.messages : []

  if (cfg.stripNudge) {
    const last = msgs.length - 1
    const trailingSystem = msgs[last]?.role === 'system'
    const at = trailingSystem ? last - 1 : last
    if (at >= 0 && msgs[at]?.role === 'user' && isNudgeText(singleText(msgs[at].content))) { msgs.splice(at, 1); counts.nudgeMessages++ }
    // W 开卷：题接在尾部 system 后面（11-14 的协议），代理的提醒落在「提醒、system、题」的位置：末尾四条以内、紧挨 system 前面的那条也去掉
    for (let i = msgs.length - 2; i >= Math.max(0, msgs.length - 4); i--) {
      if (msgs[i]?.role === 'user' && msgs[i + 1]?.role === 'system' && isNudgeText(singleText(msgs[i].content))) { msgs.splice(i, 1); counts.nudgeMessages++; break }
    }
    // 也可能是贴在最后一条 user 末尾的一块
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'system') continue
      if (msgs[i].role !== 'user') break
      const c = msgs[i].content
      if (Array.isArray(c) && c.length > 1 && c.at(-1)?.type === 'text' && isNudgeText(c.at(-1).text)) { c.pop(); counts.nudgeBlocks++ }
      break
    }
  }

  if (cfg.images === 'placeholder') {
    const fix = (blocks) => blocks.map((x) => {
      if (x?.type === 'image') { counts.imagesReplaced++; return { type: 'text', text: '[图片]' } }
      if (x?.type === 'tool_result' && Array.isArray(x.content)) return { ...x, content: fix(x.content) }
      return x
    })
    for (const m of msgs) if (Array.isArray(m.content)) m.content = fix(m.content)
  }

  if (cfg.stripForeignThinking) {
    const own = ctx.ownSignature ?? (() => false)
    for (const m of msgs) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      m.content = m.content.filter((x) => {
        if (x?.type === 'thinking') { if (own(x.signature)) { counts.ownThinkingKept++; return true } counts.foreignThinking++; return false }
        if (x?.type === 'redacted_thinking') { if (own(x.data)) { counts.ownThinkingKept++; return true } counts.foreignThinking++; return false }
        return true
      })
    }
    const before = msgs.length
    b.messages = msgs.filter((m) => !(m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0))
    counts.emptyAssistantDropped = before - b.messages.length
  }

  if (cfg.localPaths) {
    const rep = (s) => {
      let out = s
      for (const [re, to] of PATH_RULES) out = out.replace(re, () => { counts.pathsReplaced++; return to })
      return out
    }
    if (b.system !== undefined) b.system = mapStrings(b.system, rep)
    if (b.tools !== undefined) b.tools = mapStrings(b.tools, rep)
    b.messages = mapStrings(b.messages, rep)
  }

  if (cfg.relDate?.enabled) {
    const fn = ctx.relDateFn
    if (typeof fn !== 'function') throw new Error('relDate enabled but no function loaded')
    const now = cfg.relDate.now
    const rd = (s) => { const t = fn(s, { now }); if (t !== s) counts.relDateChanged++; return t }
    for (const m of b.messages ?? []) {
      if (m.role !== 'user') continue
      if (typeof m.content === 'string') m.content = rd(m.content)
      else if (Array.isArray(m.content)) {
        m.content = m.content.map((x) => {
          if (x?.type === 'text') return { ...x, text: rd(x.text) }
          if (x?.type === 'tool_result') return { ...x, content: typeof x.content === 'string' ? rd(x.content) : (x.content ?? []).map((y) => (y?.type === 'text' ? { ...y, text: rd(y.text) } : y)) }
          return x
        })
      }
    }
  }
  return { body: b, counts }
}
