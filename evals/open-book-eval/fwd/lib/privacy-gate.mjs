// 隐私闸（eval.md 3.7 第 2 道；照早先一版隐私闸（guard.py）改成读「纯文件快照」、片段表只在内存里）。
// 只报「哪一类没过」，不打印、不记任何命中的原文或真号码。
//
// 合成臂（每一次真发之前）：
//   1. 工具表：名字都在白名单里；配了 toolsSha 的话，工具表（规范 JSON）的 sha 必须一字不差
//   2. qq:private / qq:group 后面只能是 10000 / 10001 / 20000；正文里不能有她的真号（快照里存的是加盐的哈希，不是号码本身）
//   3. 没有本机路径、没有像凭据的串（签名字段、图片 base64 不算正文，不扫）
//   4. 正文任意连续 12 个字（去空白、至少 6 个汉字）在她记录快照里 0 命中（框架字的片段不算；整行对得上替身模板的行，
//      只查模板空位里的字——第二轮修，模板见 lib/stub-templates.mjs）
// 真数据臂：
//   1. 目标提供方在用户批过的名单里（approvals：日期、提供方、哪一臂）
//   2. 路径已经换掉（PATH_RE 0 命中）  3. 凭据扫描 0 命中
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PATH_RE } from './transforms.mjs'
import { canonicalJson, sha256 } from './util.mjs'
import { zstdDecompressAll } from './zstd-frames.mjs'

export const N = 12
export const STRIDE = 6
export const SYNTHETIC_QQ = new Set(['10000', '10001', '20000'])
// 11-19：前面加了「不能紧跟字母数字」——普通英文词（如 task-…）里的「sk-…」曾被当成 sk- 开头的 key（整合冒烟抓到的误报）
export const CRED_RE = /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|x-dsh-auth-token|ghp_[A-Za-z0-9]{10,}|github_pat_|AKIA[0-9A-Z]{12,}|xox[bp]-|eyJ[A-Za-z0-9_-]{20,}\.|AIza[0-9A-Za-z_-]{30,})/
// 签名字段在哪一层都不是正文；data / url / media_type / mimeType / file_id 只在图片、文件块（和它们的 source）里跳过
// （复核 B1：以前任何层级都跳，工具参数里叫 data / url 的正文就不查了）
const SKIP_ANY = new Set(['signature', 'thoughtSignature'])
const SKIP_MEDIA = new Set(['data', 'url', 'media_type', 'mimeType', 'file_id', 'fileUri'])
const MEDIA_TYPES = new Set(['image', 'document', 'image_url', 'input_image', 'file'])
const MEDIA_KEYS = new Set(['inlineData', 'fileData', 'image_url'])

/** 请求里所有「正文」字符串（跳过签名、图片 / 文件块里的 base64 和地址）。 */
export function collectStrings (v, out = [], key = null, inMedia = false) {
  if (typeof v === 'string') { if (!SKIP_ANY.has(key) && !(inMedia && SKIP_MEDIA.has(key)) && !/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(v)) out.push(v); return out }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, null, inMedia); return out }
  if (v && typeof v === 'object') {
    const media = inMedia || MEDIA_TYPES.has(v.type)
    for (const [k, x] of Object.entries(v)) collectStrings(x, out, k, media || MEDIA_KEYS.has(k))
    return out
  }
  return out
}

const isCjk = (c) => c >= '一' && c <= '鿿'
const norm = (s) => s.replace(/\s+/g, '')
function hasCjk6 (g) { let n = 0; for (const c of g) if (isCjk(c) && ++n >= 6) return true; return false }
// 32 位 FNV-1a（只做预筛；命中后逐字核对，所以哈希撞了也不会误报）
function h32 (s, from, len) {
  let h = 0x811c9dc5
  for (let i = from; i < from + len; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/** 盐 + 号码 → 哈希（快照里存这个，不存号码）。 */
export const numberHash = (salt, n) => createHash('sha256').update(salt + ':' + n).digest('hex').slice(0, 32)

// ---------- 快照里的语料 ----------
function * snapshotTexts (dir, skipped = []) {
  const walk = function * (d) {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      const st = statSync(p)
      if (st.isDirectory()) { yield * walk(p); continue }
      // 复核 B1：≥ 20 MB 的文字文件以前静默跳过；现在一律读（快照是拷贝），读不了就抛（闸起不来，fail-closed）
      if (/\.(json|jsonl|md|txt)$/i.test(n)) yield readFileSync(p, 'utf8')
      else if (/\.zstd?$/i.test(n)) yield decompressTolerant(readFileSync(p))
      else skipped.push(n)
    }
  }
  yield * walk(join(dir, 'files'))
}
/** 会话日志是一条记录一帧、帧接帧追加的（Node 自带的只解第一帧）；拷的时候正在写的那一帧不完整，丢掉。 */
function decompressTolerant (buf) {
  return zstdDecompressAll(buf).text
}
/** 一行 JSON 里的全部字符串值（会话日志、事件流都是 JSONL；解不开的就当纯文字）。 */
function * textItems (text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t[0] === '{' || t[0] === '[') {
      try { for (const s of collectStrings(JSON.parse(t))) yield s; continue } catch { /* 当纯文字 */ }
    }
    yield line
  }
}
const B64_RUN = /[A-Za-z0-9+/=_-]{64,}/g

/** 快照里建索引用的那些字（去空白、去长 base64 以后），一条一条给。测试拿它在内存里挑一段她真的字（不打印、不落盘）。 */
export function * snapshotStrings (snapshotDir) {
  for (const text of snapshotTexts(snapshotDir, [])) {
    for (const item of textItems(text)) {
      if (!item || !/[一-鿿]/.test(item)) continue
      const s = norm(item.replace(B64_RUN, ''))
      if (s.length >= N) yield s
    }
  }
}

/**
 * 读快照目录，建片段表（全在内存里）。返回 { lookup(gram) → bool, stats }。
 * 结构：所有文本去空白后用 \u0000 连成一串；每隔 6 个字取一段 6 字的哈希，(hash<<32 | 位置) 排好序放 BigUint64Array。
 * 查一个 12 字片段：它在语料里出现的话，一定整段盖住某个 6 的倍数位置开始的 6 个字；对 7 种偏移各查一次哈希，候选位置逐字核对。
 */
export function buildCorpusIndex (snapshotDir) {
  const t0 = Date.now()
  const seen = new Set()
  const parts = []
  let files = 0
  let rawChars = 0
  const skipped = []
  for (const text of snapshotTexts(snapshotDir, skipped)) {
    files++
    for (const item of textItems(text)) {
      if (!item || !/[一-鿿]/.test(item)) continue
      const s = norm(item.replace(B64_RUN, ''))
      if (s.length < N) continue
      const k = sha256(s)
      if (seen.has(k)) continue
      seen.add(k)
      parts.push(s)
      rawChars += s.length
    }
  }
  const corpus = parts.join('\u0000')
  const count = Math.max(0, Math.floor((corpus.length - STRIDE) / STRIDE) + 1)
  const keys = new BigUint64Array(count)
  for (let i = 0, p = 0; i < count; i++, p += STRIDE) keys[i] = (BigInt(h32(corpus, p, STRIDE)) << 32n) | BigInt(p)
  keys.sort()
  const hashes = new Uint32Array(count)
  const pos = new Uint32Array(count)
  for (let i = 0; i < count; i++) { hashes[i] = Number(keys[i] >> 32n); pos[i] = Number(keys[i] & 0xffffffffn) }
  const lowerBound = (h) => { let lo = 0; let hi = count; while (lo < hi) { const mid = (lo + hi) >>> 1; if (hashes[mid] < h) lo = mid + 1; else hi = mid } return lo }
  const lookup = (gram) => {
    for (let off = 0; off <= N - STRIDE; off++) {
      const h = h32(gram, off, STRIDE)
      for (let i = lowerBound(h); i < count && hashes[i] === h; i++) {
        const start = pos[i] - off
        if (start >= 0 && corpus.startsWith(gram, start)) return true
      }
    }
    return false
  }
  return { lookup, stats: { files, texts: parts.length, chars: rawChars, pieces: count, skippedFiles: skipped.length, ms: Date.now() - t0 } }
}

/** 一组「框架字」（工具说明、代理和 dsh-fish 拷贝自带的模板字、执行器的固定回复）→ 它们的 12 字片段集合。
 *  这些字是代码带的、不是她的话；她的会话日志里也有它们（她天天看这些工具说明和结果模板），不豁免的话合成臂每一发都会被拦。 */
export function frameworkGrams (texts) {
  const out = new Set()
  for (const raw of texts ?? []) {
    if (typeof raw !== 'string' || !/[一-鿿]/.test(raw)) continue
    const t = norm(raw)
    for (let i = 0; i + N <= t.length; i++) { const g = t.slice(i, i + N); if (hasCjk6(g)) out.add(g) }
  }
  return out
}

// ---------- 替身模板（第二轮修，11-19 晚；模板由 lib/stub-templates.mjs 拿真的替身代码在哨兵世界里渲出来，写在 framework-texts.json 里） ----------
// 一行字整行对得上某个模板时，模板的固定字拿掉，只查空位里的字（每个空位单独当一段查）：固定字（桥第 22 条照写的标题行之类）
// 不算她的话，空位里的合成名字、正文、模型给的参数照查。整行对不上的照旧（和前后行连着查）。
const SLOT_SRC = Object.freeze({ free: '(.*?)', num: '(\\d+)', time: '((?:昨天 )?(?:\\d{2}-\\d{2} )?\\d{2}:\\d{2})' })
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 比这长的行不拿模板比（替身的行都在几百字以内；防正则在很长的行上回溯） */
export const TEMPLATE_LINE_MAX = 2000

/** framework-texts.json 的 templates → 编好的正则（固定字多的排前面）。认不出的空位整条不要。 */
export function compileTemplates (templates) {
  const out = []
  for (const t of templates ?? []) {
    if (!Array.isArray(t?.parts) || !t.parts.some((p) => p?.slot)) continue
    let src = '^'
    let lit = ''
    let need = ''
    let ok = true
    for (const p of t.parts) {
      if (typeof p?.lit === 'string') { src += escRe(p.lit); lit += p.lit; if (p.lit.length > need.length) need = p.lit } else if (SLOT_SRC[p?.slot]) src += SLOT_SRC[p.slot]; else { ok = false; break }
    }
    if (!ok) continue
    // 固定字里要有汉字、或者带钟点（太泛的不收；和 lib/stub-templates.mjs acceptTemplate 同一条）
    if (!/[一-鿿]/.test(lit) && !t.parts.some((p) => p.slot === 'time')) continue
    out.push({ id: t.id ?? null, re: new RegExp(src + '$'), litLen: lit.length, need })
  }
  return out.sort((a, b) => b.litLen - a.litLen)
}

/** 一段字 → 要查的几段：整行对得上模板的，换成它空位里的字（各自一段）；别的行照旧连在一起。 */
export function templateSegments (text, compiled, stats = null) {
  const s = String(text)
  if (!compiled?.length) return [s]
  const segs = []
  let cur = []
  for (const raw of s.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    let m = null
    if (line.length <= TEMPLATE_LINE_MAX && /[一-鿿]|\d{2}:\d{2}/.test(line)) {
      for (const t of compiled) { if (t.need && !line.includes(t.need)) continue; m = t.re.exec(line); if (m) break }
    }
    if (!m) { cur.push(raw); continue }
    if (stats) stats.templateLines = (stats.templateLines ?? 0) + 1
    if (cur.length) { segs.push(cur.join('\n')); cur = [] }
    for (const g of m.slice(1)) if (g) segs.push(g)
  }
  if (cur.length) segs.push(cur.join('\n'))
  return segs
}

/** 正文里 12 字片段的命中数（同一段正文查过就记住，不再查）。只回个数。
 *  allowGrams：框架字的片段（frameworkGrams），命中了也不算（11-19 整合时加）。
 *  templates：替身模板（compileTemplates 的结果，或者 framework-texts.json 里的原样）：整行对得上的只查空位（第二轮修）。 */
export function makeGramChecker (index, { allowGrams = null, templates = null } = {}) {
  const memo = new Map()
  const compiled = Array.isArray(templates) && templates.length && !(templates[0]?.re instanceof RegExp) ? compileTemplates(templates) : (templates ?? [])
  const stats = { templateLines: 0, templates: compiled.length }
  // templateOnly：只对这些字符串用模板（checkRequest 给的是请求里工具结果的那些字；不给 = 都用）
  const check = (texts, { templateOnly = null } = {}) => {
    let hits = 0
    for (const raw of texts) {
      if (!raw || !/[一-鿿]/.test(raw)) continue
      const useTpl = compiled.length > 0 && (!templateOnly || templateOnly.has(raw))
      const k = (useTpl ? 't:' : 'n:') + sha256(raw)
      let h = memo.get(k)
      if (h === undefined) {
        h = 0
        for (const seg of useTpl ? templateSegments(raw, compiled, stats) : [raw]) {
          const t = norm(seg)
          if (t.length < N) continue
          for (let i = 0; i + N <= t.length; i++) { const g = t.slice(i, i + N); if (hasCjk6(g) && !(allowGrams && allowGrams.has(g)) && index.lookup(g)) h++ }
        }
        memo.set(k, h)
      }
      hits += h
    }
    return hits
  }
  check.stats = stats
  return check
}

/** 请求里工具结果的那些字（替身模板只对它们用）：Anthropic / DeepSeek 的 tool_result、OpenAI 的 role:tool、Gemini 的 functionResponse。 */
export function toolResultStrings (payload) {
  const out = []
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (!v || typeof v !== 'object') return
    if (v.type === 'tool_result') { collectStrings(v.content, out); return }
    if (v.role === 'tool') { collectStrings(v.content, out); return }
    if (v.functionResponse && typeof v.functionResponse === 'object') { collectStrings(v.functionResponse, out); return }
    for (const x of Object.values(v)) walk(x)
  }
  walk(payload)
  return out
}

/** 快照里加盐的号码哈希。 */
export function loadDenyHashes (snapshotDir) {
  const f = join(snapshotDir, 'deny-hashes.json')
  if (!existsSync(f)) return { salt: null, set: new Set() }
  const j = JSON.parse(readFileSync(f, 'utf8'))
  return { salt: j.salt, set: new Set(j.hashes) }
}

/**
 * @param ctx { arm, provider, toolNames:Set, toolsSha?, approvals?, gramCheck?, deny?:{salt,set}, isOwnText?(s), today? }
 * @param payload 真正要发出去的那一份（目标协议的形状）
 * @param anthBody 变换后的 Anthropic 形状（工具表从这里核）
 * @returns { ok, problems: string[] }
 */
export function checkRequest (ctx, payload, anthBody) {
  const problems = []
  const strings = collectStrings(payload)
  const text = strings.join('\n')
  if (ctx.arm === 'synthetic') {
    const tools = Array.isArray(anthBody?.tools) ? anthBody.tools : []
    if (!ctx.toolNames) problems.push('没配工具白名单')
    else if (tools.some((t) => !ctx.toolNames.has(t?.name))) problems.push('工具表里有白名单以外的工具')
    const toolsOk = Boolean(ctx.toolsSha) && sha256(canonicalJson(tools)) === ctx.toolsSha
    if (ctx.toolsSha && !toolsOk) problems.push('工具表不是批过的那一份')
    // 批过的工具表（sha 对得上）里的字整串不进片段核对：表是批的时候核过、脱过敏的，说明文字和她记录里的请求头逐字相同是应该的
    const toolStrings = toolsOk ? new Set(collectStrings(tools)) : null
    for (const m of text.matchAll(/qq:(?:private|group):(\d+)/g)) if (!SYNTHETIC_QQ.has(m[1])) { problems.push('qq: 后面不是假号'); break }
    if (ctx.deny?.salt && ctx.deny.set.size) {
      for (const m of text.matchAll(/(?<!\d)\d{5,12}(?!\d)/g)) if (ctx.deny.set.has(numberHash(ctx.deny.salt, m[0]))) { problems.push('含真实 QQ 号'); break }
    } else problems.push('没载入真号哈希表')
    if (PATH_RE.test(text)) problems.push('含本机路径')
    if (CRED_RE.test(text)) problems.push('含像凭据的串')
    if (typeof ctx.gramCheck !== 'function') problems.push('没载入她记录的片段表')
    // 目标模型这次跑里自己写出来的字（回答、思考、工具参数）不查：它们是从过了闸的输入生成的，
    // 和她记录里的套话（「用户想让我…」）偶然重合 12 个字也不是泄露；执行器 / 合成世界给的字照查
    else {
      const pool = strings.filter((s) => !(toolStrings && toolStrings.has(s)) && !(typeof ctx.isOwnText === 'function' && ctx.isOwnText(s)))
      // 替身模板只对工具结果用（第二轮修）：世界的会话、系统段里碰巧长得像的行照旧整段查
      if (ctx.gramCheck(pool, { templateOnly: new Set(toolResultStrings(payload)) }) > 0) problems.push('有 12 字片段和她的记录重合')
    }
  } else if (ctx.arm === 'real') {
    // 复核 A7：许可按提供方、臂、数据指纹认（起来时就对过，matchApproval），每一发再看有效期
    const ap = ctx.approval
    if (!ap?.ok) problems.push('真数据臂没有对得上的许可（提供方 / 臂 / 数据指纹）')
    else if (ap.expiresMs !== null && ap.expiresMs !== undefined && (typeof ctx.now === 'function' ? ctx.now() : Date.now()) > ap.expiresMs) problems.push('真数据臂的许可过期了')
    if (ctx.provider !== 'deepseek' && PATH_RE.test(text)) problems.push('路径没换干净')
    if (CRED_RE.test(text)) problems.push('含像凭据的串')
  } else problems.push('不认识的臂')
  return { ok: problems.length === 0, problems }
}

/**
 * 真数据臂的许可（复核 A7，11-19）。许可文件 v2：
 *   { v: 2, date, expires: ISO, grants: [{ id, providers: [...], arms: ["W-O1-flash/o1", "W-O1-*"...], data: { viewRawSha, questionSetSha } }] }
 * 要提供方在、臂在（精确或「前缀*」）、data 里写了的每一样都和这一单元的指纹对得上、没过期。
 * 老格式（只有 providers、arms:["real"]，不绑数据）只在 testMode 下认。
 * → { ok, why?, grantId?, expiresMs }
 */
export function matchApproval (ap, { provider, armId, data = {}, testMode = false, now = Date.now() }) {
  if (!ap || typeof ap !== 'object') return { ok: false, why: 'no approvals file', expiresMs: null }
  const expiresMs = ap.expires ? Date.parse(ap.expires) : null
  if (ap.expires && !Number.isFinite(expiresMs)) return { ok: false, why: 'bad expires', expiresMs: null }
  if (expiresMs !== null && now > expiresMs) return { ok: false, why: 'approvals expired', expiresMs }
  if (!Array.isArray(ap.grants)) {
    if (!testMode) return { ok: false, why: 'legacy approvals (no data binding) are only accepted in testMode', expiresMs }
    const ok = Array.isArray(ap.providers) && ap.providers.includes(provider) && (!ap.arms || ap.arms.includes('real'))
    return ok ? { ok: true, grantId: 'legacy-test', expiresMs } : { ok: false, why: 'provider not approved', expiresMs }
  }
  const armOk = (pat) => typeof pat === 'string' && Boolean(armId) && (pat === armId || (pat.endsWith('*') && armId.startsWith(pat.slice(0, -1))))
  const whys = []
  for (const g of ap.grants) {
    if (!Array.isArray(g?.providers) || !g.providers.includes(provider)) { whys.push(`${g?.id}:provider`); continue }
    if (!Array.isArray(g.arms) || !g.arms.some(armOk)) { whys.push(`${g.id}:arm`); continue }
    const need = Object.entries(g.data ?? {})
    if (need.length === 0) { whys.push(`${g.id}:no-data-binding`); continue }
    // 值可以是一个 sha，也可以是一组（任一对上就算；第二轮修 3：W-O1t 的许可同时认闭卷原句和开卷题面两份题的 sha）。空组、非字符串不认
    const valOk = (want, got) => Array.isArray(want) ? (want.length > 0 && want.every((x) => typeof x === 'string' && x.length > 0) && want.includes(got)) : (typeof want === 'string' && want.length > 0 && got === want)
    const bad = need.filter(([k, v]) => !valOk(v, data[k])).map(([k]) => k)
    if (bad.length) { whys.push(`${g.id}:data(${bad.join(',')})`); continue }
    return { ok: true, grantId: g.id, expiresMs }
  }
  return { ok: false, why: whys.join('; ') || 'no grants', expiresMs }
}
