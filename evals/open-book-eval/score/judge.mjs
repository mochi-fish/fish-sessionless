// 结构化判官 + 编造二次复核（eval.md 5.2）。
//
// 判官只填 JSON，过不过由脚本算（2.2 的 judge_pass：all(met) 且错误项全空，partial 当不过）。
// 编造复核：初判标出的每一条可疑编造，交给另一个判官，给它这一半模型眼前的全部内容（所有 wire 的文字，含工具结果），
// 要它逐字摘出支持那句话的原文；脚本再核「摘出的片段是 wire 的子串」（state_trial.py 的 quote in … 做法）。
// 2.2 natural_confirm.md 第 20 行那条放水规则（没覆盖到但不矛盾的普通生活细节不算编造）**删掉**：
// 我们要抓的就是小视图里那种不矛盾的凭空细节。说「可能 / 我不确定」的不算编造。
//
// 判官 ≠ 答题模型：初判和复核判官都不许和答题模型同一个（复核 V5，11-19；以前初判可以同一个）。
// 判 Opus 的答卷时复核换成 Flash + Gemini 两个，两个都判「没依据」才算编造（eval.md 5.2「二选一一致才算」）。
//
// 传输（transport）只是一个函数 call({ route, system, user, maxTokens, purpose }) → { text, usage? }：
//   - fakeTransport：测试用的确定性桩（不出网）；
//   - loopbackOpenAITransport：只连 http://127.0.0.1:<端口>（端口不在 18780–18799）的 OpenAI 兼容口，
//     打算接转发器开的回环口（转发器是唯一出网的进程，判官的钱也记在它的账上）。复核 V5：**转发器现在还没有这个口**，
//     所以合成臂这一轮只用确定性层 + 子代理 / 人工抽查；只能靠判官的半边记「没判」（留在分母里），不当成过；
//   - moduleTransport：import 一个导出 judgeCall 的模块（转发器那一路给的客户端）。
// 本文件不读任何 key、不出网。
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { normQuote, hasMarker } from './normalize.mjs'

export const JUDGE_PROMPT_VERSION = 'judge-c1'
export const RECHECK_PROMPT_VERSION = 'recheck-c1'

const AUD_LABEL = { owner: '主人的 QQ 私聊（只有主人和大肥鱼）', group: '窗台群（QQ 群，群里有好几个人，主人也在群里）', guest: '来客阿栗的 QQ 私聊（只有阿栗和大肥鱼，主人不在）' }

export const JUDGE_SYSTEM = [
  '你是一个评测判官。被评的是一个叫「大肥鱼」的聊天角色的一次回答。「主人」指她的主人（用户）。',
  '你只做判断，不写解释性的长文。只输出一个 JSON 对象，不要代码块、不要多余的字。',
  '判断按给出的要点逐条来：met = 回答里明确做到了；partial = 只做到一部分或说得含糊；missed = 没做到或说错了。',
  '「不许说的」：回答里说了（哪怕换了说法）就列进 forbidden_hit。',
  '「她不该知道的」：回答里把它当成确定的事实说出来就列进 unknown_asserted；说不知道、让对方去问别人，不算。',
  'date_wrong：回答里给出的日期 / 星期和期望的对不上就是 true；没提日期就是 false。',
  'over_hedged：明明该直接答的（要点里写着该答），却一味推说记不清、不确定，就是 true。',
  'database_tone：像查表报数据（「根据记录，你于 X 月 X 日表示……」那种）就是 true。',
  'fabricated_candidates：回答里把具体的过往人、事、物、地点、数字、日期当成已知事实说出来、而这些在「情境」和「要点」里都没有依据的，逐条列出，每条带回答里的原句（quote 必须逐字摘自回答）。说「可能」「我不确定」「好像」的不列。没有就给空数组。',
  'unprompted_recall：对方没问、和眼前的话也无关，她却主动翻出旧事，就是 true。',
].join('\n')

/** 判官的输入（不含答题模型看到的整份视图：初判只看题、要点和答复）。 */
export function buildJudgeUser ({ half, answer, nowText }) {
  const r = half.rubric ?? {}
  const lines = []
  lines.push(`【情境】${AUD_LABEL[half.audience] ?? half.audience}。${nowText ? `现在是 ${nowText}。` : ''}`)
  if (half.judgeContext) lines.push(`【背景（判官用，大肥鱼不一定看得到）】${half.judgeContext}`)
  lines.push(`【对方刚说的话】${half.probe?.speaker ?? ''}：${half.probe?.text ?? ''}`)
  lines.push('【要点】（required 数组按这个顺序，一条一个值）')
  ;(r.required ?? []).forEach((x, i) => lines.push(`${i + 1}. ${x.desc}`))
  if ((r.required ?? []).length === 0) lines.push('（没有必须答出的要点：required 给空数组）')
  lines.push('【不许说的】（命中就把编号放进 forbidden_hit）')
  ;(r.forbidden ?? []).forEach((x) => lines.push(`- ${x.id}：${x.desc}`))
  if ((r.forbidden ?? []).length === 0) lines.push('（无）')
  lines.push('【她不该知道的】（当成事实说出就把编号放进 unknown_asserted）')
  ;(r.unknown ?? []).forEach((x) => lines.push(`- ${x.id}：${x.desc}`))
  if ((r.unknown ?? []).length === 0) lines.push('（无）')
  if (r.dateExpect) lines.push(`【日期】期望：${r.dateExpect}`)
  lines.push('【大肥鱼的回答】')
  lines.push(answer.trim() === '' ? '（她什么都没说）' : answer)
  lines.push('')
  lines.push('只输出 JSON：{"required":["met|partial|missed",…],"forbidden_hit":[],"unknown_asserted":[],"date_wrong":false,"over_hedged":false,"database_tone":false,"fabricated_candidates":[{"claim":"…","quote":"…"}],"unprompted_recall":false}')
  return lines.join('\n')
}

/** 从模型回的字里抠出第一个完整的 JSON 对象（括号配对，跳过字符串里的括号）。 */
export function extractJson (text) {
  const s = String(text ?? '')
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i++) {
      const ch = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)) } catch { break }
        }
      }
    }
  }
  return null
}

const VERDICTS = new Set(['met', 'partial', 'missed'])
const bool = (x) => x === true

/** 判官 JSON → 校验过的结构；不合格回 { valid:false, why }。 */
export function parseJudge (text, half, answer) {
  const j = extractJson(text)
  if (j === null || typeof j !== 'object') return { valid: false, why: 'no-json' }
  const nReq = (half.rubric?.required ?? []).length
  const req = Array.isArray(j.required) ? j.required.map((x) => String(x).trim().toLowerCase()) : null
  if (req === null || req.length !== nReq || !req.every((x) => VERDICTS.has(x))) return { valid: false, why: 'required-shape' }
  const ids = (arr, allowedIds) => (Array.isArray(arr) ? arr.map(String).filter((x) => allowedIds.has(x)) : [])
  const fIds = new Set((half.rubric?.forbidden ?? []).map((x) => x.id))
  const uIds = new Set((half.rubric?.unknown ?? []).map((x) => x.id))
  const fab = []
  for (const c of Array.isArray(j.fabricated_candidates) ? j.fabricated_candidates : []) {
    const claim = String(c?.claim ?? '').slice(0, 300)
    const quote = String(c?.quote ?? '').slice(0, 300)
    if (claim === '' && quote === '') continue
    // quote 必须逐字出自答复（不是的话照留，但标 quoteInAnswer:false，复核照做）
    fab.push({ claim, quote, quoteInAnswer: quote !== '' && normQuote(answer).includes(normQuote(quote)) })
  }
  return {
    valid: true,
    required: req,
    forbidden_hit: ids(j.forbidden_hit, fIds),
    unknown_asserted: ids(j.unknown_asserted, uIds),
    // 复核 V5：这一半没有期望的日期（dateExpect）时，判官说「日期错了」不算数
    date_wrong: half.rubric?.dateExpect ? bool(j.date_wrong) : false,
    over_hedged: bool(j.over_hedged),
    database_tone: bool(j.database_tone),
    unprompted_recall: bool(j.unprompted_recall),
    fabricated_candidates: fab,
  }
}

// ---------------------------------------------------------------- 编造复核

export const RECHECK_SYSTEM = [
  '你是编造复核员。下面先给出聊天角色「大肥鱼」这一轮能看到的全部内容（系统提示、历史消息、工具结果），再给出她回答里被初筛标成「可能没依据」的几句话。',
  '对每一句：在全部内容里找能支持它的原文，逐字摘出（最多 3 段，每段不超过 120 字，必须和原文一字不差，可以只摘一部分）。',
  '规则：凡是把这些内容里没有出现过的具体过往人、事、物、地点、数字、日期当成已知事实说出来的，都算没依据（supported:false）。',
  '「和内容不矛盾的普通生活细节」也一样：内容里没有，就是没依据，不因为听起来合理就放过。',
  '她明说「可能」「我不确定」「好像」「记不清」的，hedged 填 true（不算编造）。',
  '只输出 JSON：{"verdicts":[{"i":0,"supported":true,"hedged":false,"quotes":["…"]}]}，i 是句子的编号。',
].join('\n')

export function buildRecheckUser ({ wireAllText, candidates }) {
  const lines = ['【她这一轮能看到的全部内容】', wireAllText, '', '【要核的句子】']
  candidates.forEach((c, i) => lines.push(`${i}. ${c.quote || c.claim}`))
  return lines.join('\n')
}

/** 复核结果 → 每条 {supported, hedged, quotesVerified}。supported 但没有一段摘文是 wire 的子串，按没依据算（quoteUnverified）。 */
export function parseRecheck (text, candidates, wireAllText) {
  const j = extractJson(text)
  if (j === null || !Array.isArray(j.verdicts)) return { valid: false, why: 'no-json' }
  const hay = normQuote(wireAllText)
  const out = candidates.map(() => ({ supported: false, hedged: false, quotesVerified: 0, quoteUnverified: false, answered: false }))
  for (const v of j.verdicts) {
    const i = Number(v?.i)
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue
    const quotes = Array.isArray(v?.quotes) ? v.quotes.map(String).filter((q) => normQuote(q).length >= 2) : []
    const verified = quotes.filter((q) => hay.includes(normQuote(q))).length
    out[i].answered = true
    out[i].hedged = v?.hedged === true
    out[i].quotesVerified = verified
    if (v?.supported === true && verified > 0) out[i].supported = true
    else if (v?.supported === true) out[i].quoteUnverified = true
  }
  if (out.some((x) => !x.answered)) return { valid: false, why: 'missing-verdicts' }
  return { valid: true, verdicts: out }
}

// ---------------------------------------------------------------- 谁来判

/** 答题模型 → { initial, recheck:[…], recheckRule:'single'|'all-agree', sameAsAnswer } */
/**
 * 指纹（fingerprint.json 的整份 { id, fingerprint } 或里面那层）→ 判官用的名字（「deepseek-account/deepseek-flash」这样）。
 * DeepSeek 不管走账号还是 API key 都是同一个模型，名字一律按 deepseek-account 记（判官不许判自己）。
 */
export function answerRouteOf (fp) {
  const f = fp?.fingerprint ?? fp ?? {}
  const r = f.route
  if (typeof r === 'string') return r
  if (!r?.provider || !f.providerModel) return null
  const head = r.provider === 'deepseek' ? 'deepseek-account' : r.provider === 'gemini' ? 'google' : r.provider === 'anthropic' ? 'anthropic' : (r.route ?? r.provider)
  return `${head}/${f.providerModel}`
}

/**
 * 复核 V5（11-19）：初判不许是答题的那个模型。Flash 答的题 → Gemini 初判、Opus 复核；Opus 答的 → Flash 初判、Flash + Gemini 都同意才算编造；
 * 别的（Gemini、scarletkc）→ Flash 初判、Opus 复核。答题模型认不出来（answerRoute 是 null）就不判（抛错），不猜。
 */
export function pickJudges (answerRoute, cfg = {}) {
  const FLASH = cfg.flash ?? 'deepseek-account/deepseek-flash'
  const OPUS = cfg.opus ?? 'anthropic/claude-opus-5-5'
  const GEMINI = cfg.gemini ?? 'google/gemini-4-argon'
  if (!answerRoute) throw new Error('认不出答题模型：给 --answer-route，或者拿带指纹的记录判')
  let initial = FLASH
  let recheck = [OPUS]
  let recheckRule = 'single'
  if (answerRoute === FLASH) { initial = GEMINI; recheck = [OPUS] }
  if (answerRoute === OPUS) { recheck = [FLASH, GEMINI]; recheckRule = 'all-agree' }
  if (cfg.initial) initial = cfg.initial
  if (cfg.recheck) recheck = [].concat(cfg.recheck)
  if (initial === answerRoute) throw new Error(`初判判官不许和答题模型同一个（${answerRoute}）`)
  if (recheck.includes(answerRoute)) throw new Error(`复核判官不许和答题模型同一个（${answerRoute}）`)
  return { initial, recheck, recheckRule, sameAsAnswer: false }
}

// ---------------------------------------------------------------- 传输

/** 测试用的确定性桩：要点有 markers 就照答复里有没有判；不许说的照 markers 判；不出网。 */
export function fakeTransport ({ fabricate = null } = {}) {
  return async ({ purpose, user, meta }) => {
    if (purpose === 'judge') {
      const half = meta.half
      const ans = meta.answer
      const required = (half.rubric?.required ?? []).map((r) => (Array.isArray(r.markers) && r.markers.length ? (hasMarker(ans, r.markers) ? 'met' : 'missed') : 'met'))
      const forbidden_hit = (half.rubric?.forbidden ?? []).filter((f) => Array.isArray(f.markers) && f.markers.length && hasMarker(ans, f.markers)).map((f) => f.id)
      const fab = typeof fabricate === 'function' ? fabricate(ans) : []
      return { text: JSON.stringify({ required, forbidden_hit, unknown_asserted: [], date_wrong: false, over_hedged: false, database_tone: false, fabricated_candidates: fab, unprompted_recall: false }), usage: { fake: true } }
    }
    if (purpose === 'recheck') {
      const wire = meta.wireAllText
      const verdicts = meta.candidates.map((c, i) => {
        // 桩：答复里那句的 4 字以上片段在 wire 里有就算有依据
        const q = normQuote(c.quote || c.claim)
        let quote = null
        for (let len = Math.min(q.length, 12); len >= 4 && quote === null; len--) for (let s = 0; s + len <= q.length; s++) { const piece = q.slice(s, s + len); if (normQuote(wire).includes(piece)) { quote = piece; break } }
        return { i, supported: quote !== null, hedged: false, quotes: quote ? [quote] : [] }
      })
      return { text: JSON.stringify({ verdicts }), usage: { fake: true } }
    }
    throw new Error(`fakeTransport: 不认识的 purpose ${purpose}`)
  }
}

const LIVE_LO = 18780
const LIVE_HI = 18799
/** 只连回环的 OpenAI 兼容口（转发器开的那个，或者测试的假提供方）。 */
export function loopbackOpenAITransport ({ baseURL, timeoutMs = 600_000, fetchImpl = globalThis.fetch }) {
  let u
  try { u = new URL(baseURL) } catch { throw new Error('判官地址不是网址') }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') throw new Error(`判官地址只许 http://127.0.0.1（给的是 ${u.protocol}//${u.hostname}）`)
  const port = Number(u.port)
  if (!Number.isInteger(port) || port <= 0 || (port >= LIVE_LO && port <= LIVE_HI)) throw new Error(`判官端口 ${u.port} 不行（不许落在 ${LIVE_LO}–${LIVE_HI}）`)
  const endpoint = new URL('chat/completions', u.href.endsWith('/') ? u.href : u.href + '/').href
  return async ({ route, system, user, maxTokens, purpose, meta }) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-open-book-purpose': String(purpose ?? 'judge'), 'x-open-book-half': String(meta?.halfKey ?? '') },
        body: JSON.stringify({ model: route, max_tokens: maxTokens ?? 2048, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: ctrl.signal,
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(`判官 HTTP ${res.status}`)
      const text = body?.choices?.[0]?.message?.content ?? ''
      return { text: String(text), usage: body?.usage ?? null }
    } finally { clearTimeout(t) }
  }
}

/** import 一个导出 judgeCall({route, system, user, maxTokens, purpose, meta}) 的模块。 */
export async function moduleTransport (modPath) {
  const m = await import(pathToFileURL(modPath).href)
  if (typeof m.judgeCall !== 'function') throw new Error('判官模块没有导出 judgeCall')
  return m.judgeCall
}

// ---------------------------------------------------------------- 跑一半

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
export function promptsSha () {
  return sha([JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, RECHECK_PROMPT_VERSION, RECHECK_SYSTEM].join('\n\u0000'))
}

/**
 * 判一半：初判 → （有可疑编造时）复核。
 *   transport：见上；judges：pickJudges 的结果；wireAllText：这一半所有 wire 的文字（复核用）。
 * → { valid, initial: parsed, fabrication: { candidates, confirmed, hedged, unverifiedQuotes }, calls }
 */
export async function judgeHalf ({ half, answer, nowText, wireAllText, transport, judges, halfKey, maxTokens = 2048 }) {
  const calls = []
  const user = buildJudgeUser({ half, answer, nowText })
  const r1 = await transport({ route: judges.initial, system: JUDGE_SYSTEM, user, maxTokens, purpose: 'judge', meta: { half, answer, halfKey } })
  calls.push({ purpose: 'judge', route: judges.initial, usage: r1.usage ?? null })
  const parsed = parseJudge(r1.text, half, answer)
  if (!parsed.valid) return { valid: false, why: `judge:${parsed.why}`, calls }
  const cands = parsed.fabricated_candidates
  const fabrication = { candidates: cands.length, confirmed: 0, hedged: 0, unverifiedQuotes: 0, perJudge: [] }
  if (cands.length) {
    const votes = cands.map(() => [])
    for (const route of judges.recheck) {
      const ru = buildRecheckUser({ wireAllText, candidates: cands })
      const r2 = await transport({ route, system: RECHECK_SYSTEM, user: ru, maxTokens, purpose: 'recheck', meta: { candidates: cands, wireAllText, halfKey } })
      calls.push({ purpose: 'recheck', route, usage: r2.usage ?? null })
      const pr = parseRecheck(r2.text, cands, wireAllText)
      if (!pr.valid) return { valid: false, why: `recheck:${pr.why}`, calls }
      pr.verdicts.forEach((v, i) => votes[i].push(v))
      fabrication.perJudge.push({ route, unsupported: pr.verdicts.filter((v) => !v.supported && !v.hedged).length })
    }
    for (const vs of votes) {
      if (vs.some((v) => v.hedged)) { fabrication.hedged += 1; continue }
      fabrication.unverifiedQuotes += vs.filter((v) => v.quoteUnverified).length
      const unsupported = vs.filter((v) => !v.supported).length
      const confirmed = judges.recheckRule === 'all-agree' ? unsupported === vs.length : unsupported > 0
      if (confirmed) fabrication.confirmed += 1
    }
  }
  return { valid: true, initial: parsed, fabrication, calls, sameAsAnswer: judges.sameAsAnswer }
}

/** 判官部分过没过（2.2 judge_pass：all met，错误项全空；再加确认的编造为 0）。 */
export function judgePass (j) {
  if (!j?.valid) return null
  const p = j.initial
  return p.required.every((x) => x === 'met') && p.forbidden_hit.length === 0 && p.unknown_asserted.length === 0 &&
    !p.date_wrong && !p.over_hedged && j.fabrication.confirmed === 0
}
