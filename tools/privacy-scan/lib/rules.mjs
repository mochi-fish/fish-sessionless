// 公开规则。只认形状，不认任何真值（真值在私有层）。
// 每条规则：{ id, what, scan(text, ctx) → [{ index, length }] }。命中只报位置和长度，不带命中的字。
//
// ctx：{ path（仓库里的相对路径，正斜杠）, config（见 config.mjs）, isPath（扫的是路径名本身） }

// ---------------------------------------------------------------- 带用户名的家目录路径

// 分隔符可以重复（盘符后 Users 两边写成双斜杠的、JSON 里转义过的反斜杠）
const SEP = String.raw`(?:\\{1,4}|/){1,2}`
const NAME = String.raw`([^\\/\s"'\`<>|:*?;,()\[\]{}]+)`
// 盘符（C:）、管理共享（\\主机\C$）、/mnt/c、/cygdrive/c、Git Bash 的 /c
const WIN_HOME = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:[A-Za-z]:|[A-Za-z]\$|/mnt/[A-Za-z]|/cygdrive/[A-Za-z]|/[A-Za-z](?=/[Uu]sers/))${SEP}(?:Users|Documents and Settings)${SEP}${NAME}`,
  'gi')
// /home/<name>、/Users/<name>、/var/home/<name>（Silverblue 一类），以及 WSL 的 \\wsl$\<发行版>\home\<name>、\\wsl.localhost\…
const UNIX_HOME = new RegExp(String.raw`(?:(?<![A-Za-z0-9_.~-])|(?<=/var))/(?:Users|home)/${NAME}`, 'g')
const WSL_HOME = new RegExp(String.raw`(?:\\{1,4}|//)wsl(?:\$|\.localhost)(?:\\{1,4}|/)[^\\/\s"'<>|]+(?:\\{1,4}|/)home(?:\\{1,4}|/)${NAME}`, 'gi')
// DSH 会话目录、Claude 项目目录那种把路径压成一串的写法：--C-Users-<名字>-…、C--Users-<名字>-…
const FLAT_HOME = /(?<![A-Za-z0-9])[A-Za-z]-{1,2}Users-([A-Za-z0-9_.]+?)(?=-)/gi

const NAME_PLACEHOLDERS = new Set([
  'user', 'username', 'user-name', 'user_name', 'you', 'yourname', 'your-name', 'your_name', 'me', 'name',
  'example', 'someone', 'somebody', 'foo', 'xxx', 'runner', 'runneradmin', 'public', 'default', 'default user',
  'all users', 'vscode', 'codespace', 'node', 'ubuntu', 'admin', 'administrator', 'shared', 'guest',
])
export function isPlaceholderName (name) {
  const n = String(name).trim().toLowerCase()
  if (!n) return true
  if (NAME_PLACEHOLDERS.has(n)) return true
  if (n.length === 1) return true // 注释里的示意写法
  if (/^[<{$%*…]|^\.\.\.|^\[/.test(n)) return true // <name>、${USER}、$USER、%USERNAME%、*、…
  return false
}

function userPath (text) {
  const out = []
  for (const re of [WIN_HOME, UNIX_HOME, WSL_HOME, FLAT_HOME]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (isPlaceholderName(m[1])) continue
      out.push({ index: m.index, length: m[0].length })
    }
  }
  // 同一段路径可能被两种写法都认出来（盘符写法里也含一段 /Users/<名字>）：重叠的只留一处
  out.sort((a, b) => a.index - b.index)
  return out.filter((h, i) => i === 0 || h.index >= out[i - 1].index + out[i - 1].length)
}

// ---------------------------------------------------------------- 私网地址、局域网主机名

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g
export function isPrivateIPv4 (a, b, c, d) {
  if ([a, b, c, d].some((x) => x > 255)) return false
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT，tailnet 用的就是这一段
  if (a === 169 && b === 254) return true
  return false
}
const IPV6_PRIVATE = /(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![0-9a-f:])/gi

// 公开的固定地址（云上的元数据服务），说的是机制，不是谁家的机器
const WELL_KNOWN_IPS = new Set(['169.254.169.254', '100.100.100.200', '169.254.170.2'])
const isCidrAfter = (text, end) => /^\/\d{1,3}(?!\d)/.test(text.slice(end, end + 4))

function privateIp (text) {
  const out = []
  IPV4.lastIndex = 0
  for (const m of text.matchAll(IPV4)) {
    if (!isPrivateIPv4(+m[1], +m[2], +m[3], +m[4])) continue
    if (WELL_KNOWN_IPS.has(m[0]) || isCidrAfter(text, m.index + m[0].length)) continue
    out.push({ index: m.index, length: m[0].length })
  }
  IPV6_PRIVATE.lastIndex = 0
  for (const m of text.matchAll(IPV6_PRIVATE)) {
    // fe80::、fc00::/7 这类只写前缀的是在讲地址段
    if (/::$/.test(m[0]) || isCidrAfter(text, m.index + m[0].length)) continue
    out.push({ index: m.index, length: m[0].length })
  }
  return out
}

const WELL_KNOWN_HOSTS = new Set(['metadata.google.internal'])
const LAN_HOST = /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:local|lan|internal|intranet|corp|localdomain|home\.arpa|ts\.net)(?![\w-]|\.\w)/gi
function lanHost (text) {
  const out = []
  LAN_HOST.lastIndex = 0
  for (const m of text.matchAll(LAN_HOST)) {
    const labels = m[0].toLowerCase().split('.')
    if (labels.includes('example')) continue
    if (WELL_KNOWN_HOSTS.has(m[0].toLowerCase())) continue
    out.push({ index: m.index, length: m[0].length })
  }
  return out
}

// ---------------------------------------------------------------- 号码上下文里的长数字

const DIGITS = /(?<![\d.])\d{5,12}(?!\d|\.\d)/g
// 同一行里出现就算号码上下文的（英文词按词边界认：sendError 里的 sender 不算）
const QQ_CONTEXT = /(?<![a-z])qq(?![a-z])|onebot|cq:|(?<![a-z])(?:uin|uid|mid)(?![a-z])|user_?id|group_?id|self_?id|target_?id|peer_?id|chat_?id|sender_?id|owner_?(?:qq|id|uin)|admin_?users|allow_?from|private:|group:|群|号码|账号|私聊|好友|成员|发给/i
// 紧挨在数字前面的键名或记号（"owner": "…"、sender=…、@…、群：…）
const QQ_PREFIX = /(?:(?<![a-z])(?:qq|uin|uid|mid|owner|sender|chat|member|friend|group|admin|peer|target|user)s?(?:_?ids?)?["'\]]?\s*[:=]\s*\[?\s*["']?|@|[群号]\s*[:：]?\s*)$/i
const QQ_PATH_CONTEXT = /qq|onebot|group|chat|contact|friend|member|群/i
const PORT_BEFORE = /(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}):$/i
const TIME_KEY_BEFORE = /(?:time|ts|at|date|seconds|epoch|expires?|mtime|ctime)["']?\s*[:=]\s*$/i
const TOKEN_CHAR = /[A-Za-z0-9]/

function isDateLike (s) {
  if (s.length === 8 || s.length === 12) {
    const y = +s.slice(0, 4); const mo = +s.slice(4, 6); const d = +s.slice(6, 8)
    if (y >= 1990 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      if (s.length === 8) return true
      const h = +s.slice(8, 10); const mi = +s.slice(10, 12)
      return h <= 23 && mi <= 59
    }
  }
  return false
}

/** 一眼看得出是编的号：同一个数字重复、顺着或倒着的连号 */
export function isObviousFake (s) {
  if (/^(\d)\1+$/.test(s)) return true
  if ('01234567890123456789'.includes(s)) return true
  if ('98765432109876543210'.includes(s)) return true
  return false
}

export function isFakeId (s, fakeIds) {
  if (isObviousFake(s)) return true
  if (!fakeIds) return false
  if (fakeIds.set?.has(s)) return true
  const n = Number(s)
  for (const [lo, hi] of fakeIds.ranges ?? []) if (n >= lo && n <= hi && String(lo).length === s.length) return true
  return false
}

function lineAround (text, index) {
  const a = text.lastIndexOf('\n', index - 1) + 1
  let b = text.indexOf('\n', index)
  if (b < 0) b = text.length
  return [a, b]
}

function qqContext (text, ctx) {
  const out = []
  const pathCtx = !ctx.isPath && QQ_PATH_CONTEXT.test(ctx.path ?? '')
  DIGITS.lastIndex = 0
  for (const m of text.matchAll(DIGITS)) {
    const s = m[0]
    const i = m.index
    // 夹在字母数字串里的（哈希、uuid 片段、标识符）：去掉 qq / uin / u / g / id 这类前缀以后还剩字母的不算
    let a = i; while (a > 0 && TOKEN_CHAR.test(text[a - 1])) a--
    let b = i + s.length; while (b < text.length && TOKEN_CHAR.test(text[b])) b++
    if (a !== i || b !== i + s.length) {
      const tok = text.slice(a, b)
      const rest = tok.replace(/^(?:qq|uin|u|g|group|id|user|uid|gid)/i, '')
      if (rest !== s) continue
    }
    if (isFakeId(s, ctx.config?.fakeIds)) continue
    if (isDateLike(s)) continue
    const before = text.slice(Math.max(0, i - 80), i)
    if (PORT_BEFORE.test(before) && Number(s) <= 65535) continue
    if (TIME_KEY_BEFORE.test(before) && s.length === 10) continue
    if (/#$/.test(before)) continue // #6313 这类 issue / PR 编号
    if (/(?:^|[^A-Za-z0-9])-$/.test(before)) continue // 负数（错误码这类）；号码不会是负的
    if (!pathCtx) {
      const [la, lb] = lineAround(text, i)
      const lo = Math.max(la, i - 160)
      const hi = Math.min(lb, i + s.length + 160)
      if (!QQ_CONTEXT.test(text.slice(lo, i) + ' ' + text.slice(i + s.length, hi)) && !QQ_PREFIX.test(text.slice(Math.max(la, i - 32), i))) continue
    }
    out.push({ index: i, length: s.length })
  }
  return out
}

// ---------------------------------------------------------------- 邮箱

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-]|\.\w)/g
const FILE_TLDS = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'json', 'md', 'txt', 'yml', 'yaml', 'py', 'sh', 'lock', 'tgz', 'zip', 'log', 'html', 'css', 'png', 'svg', 'toml', 'jsonl'])
const SSH_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'ssh.github.com'])
export function isAllowedEmail (addr) {
  const at = addr.lastIndexOf('@')
  const local = addr.slice(0, at).toLowerCase()
  const domain = addr.slice(at + 1).toLowerCase()
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (FILE_TLDS.has(tld)) return true // 不是邮箱，是 包名@文件 这类
  if (local === 'noreply' || local === 'no-reply') return true
  if (domain === 'users.noreply.github.com' || domain.endsWith('.noreply.github.com') || domain === 'noreply.github.com') return true
  if (domain === 'example.invalid' || domain.endsWith('.invalid')) return true
  if (['example.com', 'example.org', 'example.net'].includes(domain) || domain.endsWith('.example')) return true
  if (domain.endsWith('.test') || domain.endsWith('.localhost')) return true
  if (local === 'git' && SSH_HOSTS.has(domain)) return true
  return false
}
function email (text) {
  const out = []
  EMAIL.lastIndex = 0
  for (const m of text.matchAll(EMAIL)) if (!isAllowedEmail(m[0])) out.push({ index: m.index, length: m[0].length })
  return out
}

// ---------------------------------------------------------------- 像密钥的串

const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g,
]
const SECRET_ASSIGN = /(?:api[_-]?key|apikey|secret|token|access[_-]?token|auth[_-]?token|password|passwd|pwd|cookie|sessdata|bili_jct|authorization|credential|private[_-]?key)["'\]]?\s*[:=]\s*["'`]?([A-Za-z0-9_\-+/=.~%]{16,})/gi
const FAKE_WORDS = /fake|dummy|example|sample|test|placeholder|changeme|redacted|your|xxxx|0000|1234|abcd|notreal|not-a-real|secret-here|invalid|deadbeef|<|\$\{/i

export function entropy (s) {
  const f = new Map()
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p) }
  return h
}
export function looksFakeSecret (s) {
  if (FAKE_WORDS.test(s)) return true
  if (entropy(s) < 3.0) return true
  if (/(.)\1{5,}/.test(s)) return true
  return false
}
function secret (text) {
  const out = []
  const seen = new Set()
  for (const re of SECRET_SHAPES) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const v = m[1] ?? m[0]
      if (!m[0].startsWith('-----BEGIN') && looksFakeSecret(v)) continue
      if (seen.has(m.index)) continue
      seen.add(m.index)
      out.push({ index: m.index, length: m[0].length })
    }
  }
  SECRET_ASSIGN.lastIndex = 0
  for (const m of text.matchAll(SECRET_ASSIGN)) {
    const v = m[1]
    if (looksFakeSecret(v) || entropy(v) < 3.5) continue
    // 只有字母或只有数字的长串多半是名字、常量，不是密钥
    if (/^[A-Za-z_-]+$/.test(v) || /^\d+$/.test(v)) continue
    // 路径、模块名、点分的标识符
    if (/^[\w-]+(?:[./][\w-]+)+$/.test(v) && !/[0-9]/.test(v.replace(/[./]/g, ''))) continue
    const at = m.index + m[0].length - v.length
    if (seen.has(at)) continue
    seen.add(at)
    out.push({ index: at, length: v.length })
  }
  return out
}

// ---------------------------------------------------------------- U+2028 / U+2029

// 用字符码拼，源码里不放这两个字本身（放了会弄断正则和语法）
const LINE_SEP = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g')
function lineSep (text) {
  const out = []
  LINE_SEP.lastIndex = 0
  for (const m of text.matchAll(LINE_SEP)) out.push({ index: m.index, length: 1 })
  return out
}

// ---------------------------------------------------------------- 规则表

export const TEXT_RULES = [
  { id: 'user-path', what: '带用户名的家目录路径', scan: userPath },
  { id: 'private-ip', what: '私网 / 局域网 / tailnet 地址', scan: privateIp },
  { id: 'lan-host', what: '局域网 / tailnet 主机名', scan: lanHost },
  { id: 'qq-context', what: '号码上下文里不在假号表的长数字', scan: qqContext },
  { id: 'email', what: 'noreply / example.invalid 以外的邮箱', scan: email },
  { id: 'secret', what: '像密钥 / 口令的串', scan: secret },
  { id: 'line-sep', what: 'U+2028 / U+2029', scan: lineSep },
]

// 路径名本身也过一遍（文件名里带号、带用户名的）
export const PATH_RULES = TEXT_RULES.filter((r) => ['user-path', 'private-ip', 'lan-host', 'qq-context', 'email', 'secret'].includes(r.id))

export const FILE_RULE_IDS = ['binary', 'oversize', 'crlf', 'not-utf8', 'symlink', 'submodule', 'unreadable']

export const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'tgz', 'gz', 'zst', 'zstd', '7z', 'rar', 'xz', 'bz2',
  'exe', 'dll', 'so', 'dylib', 'bin', 'db', 'sqlite', 'wasm', 'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'woff', 'woff2',
  'ttf', 'otf', 'jar', 'class', 'pyc', 'bundle', 'node', 'pak', 'asar', 'npz', 'pt', 'pth', 'onnx', 'safetensors',
])

export function isBinary (buf, path) {
  const ext = String(path).toLowerCase().split('/').pop().split('.').slice(1).pop()
  if (ext && BINARY_EXTS.has(ext)) return true
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}
