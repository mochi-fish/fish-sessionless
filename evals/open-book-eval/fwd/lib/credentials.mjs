// 凭据：只从转发器进程的环境变量取，只在内存里用；不打印、不落盘、不进 wire、不进账本。
//
// 认的环境变量：
//   DEEPSEEK_API_KEY、ANTHROPIC_API_KEY、GOOGLE_API_KEY                 各家的 key
//   OPENAI_API_KEY（或 FWD_OPENAI_KEY_ENV 指定的变量名）                自建的 OpenAI 兼容服务（比如 vLLM）的 key；不要 key 的服务给什么都行
//   DEEPSEEK_ACCOUNT_TOKEN、DEEPSEEK_ANONYMOUS_USER_ID                  DeepSeek 的「账号」认证方式（auth: account），发请求时放 x-dsh-auth-token
// 可选：FWD_CORDIS_FILE 指向一份 DSH 的 cordis.patch.yml，只从里面读 llm-pi-ai 路线的名字、apiKeyEnv、baseURL 和上限字段（不读任何凭据）。
//
// 报告（`node fwd/lib/credentials.mjs`）只出「有没有、从哪来、多长、像哪一家」，不出值。
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---------- 很小的 YAML 子集解析（只管 cordis 里我们要的那几段：缩进的映射、标量、「- 」列表） ----------
function scalar (raw) {
  let s = raw.trim()
  if (s === '' ) return null
  if (s.startsWith('"')) {
    // 双引号：用 JSON 的转义规则（DSH 用 yaml 库写，只会出现 JSON 兼容的转义）
    const end = s.lastIndexOf('"')
    return JSON.parse(s.slice(0, end + 1))
  }
  if (s.startsWith("'")) {
    const end = s.lastIndexOf("'")
    return s.slice(1, end).replace(/''/g, "'")
  }
  s = s.replace(/\s+#.*$/, '')
  if (/^-?\d+$/.test(s)) return Number(s)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  return s
}

/** 缩进映射 + 标量 + 简单列表。认不出的行（!!js、多行块）整段跳过、记一笔。 */
export function parseYamlSubset (text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const root = {}
  const stack = [{ indent: -1, node: root, key: null }]
  const skipped = []
  let skipIndent = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line) || line.trim() === '---') continue
    const indent = line.length - line.trimStart().length
    if (skipIndent !== null) { if (indent > skipIndent) continue; skipIndent = null }
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop()
    const parent = stack.at(-1)
    const t = line.trim()
    if (t.startsWith('- ') || t === '-') {
      // 列表项：父节点得是数组
      if (!Array.isArray(parent.node)) {
        const holder = stack.at(-2)?.node
        if (holder && parent.key !== null && !Array.isArray(holder[parent.key])) { holder[parent.key] = []; parent.node = holder[parent.key] }
      }
      const arr = parent.node
      if (!Array.isArray(arr)) { skipped.push(i + 1); continue }
      const rest = t === '-' ? '' : t.slice(2)
      const m = /^([^:'"]+?):(?:\s+(.*))?$/.exec(rest)
      if (m) {
        const obj = {}
        arr.push(obj)
        if (m[2] !== undefined && m[2].trim() !== '') obj[m[1].trim()] = scalar(m[2])
        stack.push({ indent, node: obj, key: null })
        // 同一项后面的键比「- 」多缩进两格
        stack.at(-1).indent = indent + 1
        if (m[2] === undefined || m[2].trim() === '') { obj[m[1].trim()] = {}; stack.push({ indent: indent + 2, node: obj[m[1].trim()], key: m[1].trim(), owner: obj }) }
      } else {
        arr.push(scalar(rest))
      }
      continue
    }
    const m = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/.exec(t)
    if (!m) { skipped.push(i + 1); continue }
    const key = m[1].replace(/^["']|["']$/g, '')
    const val = m[2]
    if (val !== undefined && val.trim() !== '' && !/^[|>]/.test(val.trim())) {
      if (/^!!/.test(val.trim())) { skipped.push(i + 1); skipIndent = indent; continue }
      if (parent.node && typeof parent.node === 'object' && !Array.isArray(parent.node)) parent.node[key] = scalar(val)
      continue
    }
    if (val !== undefined && /^[|>]/.test(val.trim())) { skipped.push(i + 1); skipIndent = indent; continue }
    const child = {}
    if (parent.node && typeof parent.node === 'object' && !Array.isArray(parent.node)) parent.node[key] = child
    stack.push({ indent, node: child, key, holder: parent.node })
    // 下一行如果是「- 」开头，这个键的值是列表
    const next = lines.slice(i + 1).find((l) => l.trim() && !/^\s*#/.test(l))
    if (next && next.trim().startsWith('-') && (next.length - next.trimStart().length) >= indent) {
      parent.node[key] = []
      stack.at(-1).node = parent.node[key]
    }
  }
  return { value: root, skippedLines: skipped.length }
}

/** 变量名 → { value, source }。只看进程环境。没有就 null。 */
export function resolveRef (name) {
  const e = process.env[name]
  if (typeof e === 'string' && e.length > 0) return { value: e, source: 'env' }
  return null
}

/** DeepSeek 的账号认证：DEEPSEEK_ACCOUNT_TOKEN（+ 可选的 DEEPSEEK_ANONYMOUS_USER_ID）。没有就 null。 */
export function resolveDeepseekAccount () {
  const token = String(process.env.DEEPSEEK_ACCOUNT_TOKEN ?? '')
  if (!token) return null
  return { token, anonymousUserId: String(process.env.DEEPSEEK_ANONYMOUS_USER_ID ?? '').trim(), source: 'env' }
}

/** FWD_CORDIS_FILE 里 llm-pi-ai 的路线（只取名字、apiKeyEnv、api、baseURL、模型 id 和几个上限字段；不碰别的段）。没给就是空。 */
export function readPiAiRoutes () {
  const file = String(process.env.FWD_CORDIS_FILE ?? '').trim()
  if (!file || !existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  // 只切出 llm-pi-ai 那一条（顶层「- id: llm-pi-ai」到下一个顶层「- id:」），别的段里有 !!js，不解析
  const start = text.search(/^- id: llm-pi-ai\s*$/m)
  if (start < 0) return {}
  const rest = text.slice(start)
  const nextTop = rest.slice(1).search(/^- id: /m)
  const block = nextTop < 0 ? rest : rest.slice(0, nextTop + 1)
  const providersAt = block.search(/^ {4}providers:\s*$/m)
  if (providersAt < 0) return {}
  const providerText = block.slice(providersAt).split('\n').slice(1).filter((l) => /^ {6}/.test(l) || !l.trim()).map((l) => l.slice(6)).join('\n')
  const { value } = parseYamlSubset(providerText)
  const out = {}
  for (const [name, p] of Object.entries(value)) {
    if (!p || typeof p !== 'object') continue
    out[name] = {
      apiKeyEnv: p.apiKeyEnv ?? null,
      api: p.api ?? null,
      baseURL: p.baseURL ?? null,
      models: Array.isArray(p.models) ? p.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null, input: m.input ?? null, maxRequestImages: m.maxRequestImages ?? null })) : [],
    }
  }
  return out
}

const looks = (v) => (v.startsWith('sk-ant-') ? 'anthropic-key' : v.startsWith('AIza') ? 'google-key' : /^sk-/.test(v) ? 'sk-key' : v.length <= 2 ? 'placeholder' : 'other')

/** 只出元数据的报告。 */
export function credentialReport () {
  const report = { routes: {}, keys: {}, deepseekAccount: null }
  for (const [name, r] of Object.entries(readPiAiRoutes())) report.routes[name] = { apiKeyEnv: r.apiKeyEnv, api: r.api, hasBaseURL: !!r.baseURL, models: r.models.length }
  for (const name of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', process.env.FWD_OPENAI_KEY_ENV || 'OPENAI_API_KEY']) {
    const hit = resolveRef(name)
    report.keys[name] = hit ? { present: true, source: hit.source, length: hit.value.length, looksLike: looks(hit.value) } : { present: false }
  }
  const acct = resolveDeepseekAccount()
  report.deepseekAccount = acct ? { present: true, source: acct.source, tokenLength: acct.token.length, anonymousUserId: acct.anonymousUserId ? 'present' : 'missing' } : { present: false }
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(credentialReport(), null, 1))
}
