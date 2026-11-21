// 隔离的断言（PLAN EV「代理拷贝的家目录要整个换掉」、第五节「离线作业的固定规矩」）。
// 起任何子进程之前调 assertProxyEnv / assertPort / assertLoopbackUrl；不过就抛 IsolationError，什么都不起。
//
// 两层：
//   1. 正向白名单：该换的环境变量（HOME、USERPROFILE、XDG_*、DSH_HOME、FISH_LEDGER_DIR、TEMP…）一个都不能少，
//      而且都得落在这次跑的目录（runDir）下面——字符串比一次，存在的那一层取 realpath 再比一次（防目录联接）。
//   2. 反向黑名单：任何环境变量的值里都不许出现线上的根（~/.dsh、~/.dsh-fish、~/.dsh-fish-ledger、
//      ~/.config|.local/share|.local/state|.cache 下的 billion-context、~/.dsh-watch-*），也不许等于真的家目录。
// 端口：不许落在 18780–18799（线上代理那一段）；BILI_ZONE_PORT 往上顺延 17 次也不许碰到这一段。
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { LIVE_PORT_HI, LIVE_PORT_LO, REAL_HOME } from './paths.mjs'

export class IsolationError extends Error {
  constructor (msg) { super(`隔离断言没过：${msg}`); this.code = 'ISOLATION' }
}
const fail = (msg) => { throw new IsolationError(msg) }

const win = process.platform === 'win32'
export const norm = (p) => {
  let s = resolve(String(p))
  if (win) s = s.replace(/\//g, '\\').toLowerCase()
  while (s.length > 3 && s.endsWith(sep)) s = s.slice(0, -1)
  return s
}
export const under = (p, root) => {
  const a = norm(p)
  const r = norm(root)
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep)
}
/** 存在的那一层取 realpath（不存在就往上找）；取不到回 null。 */
export function realish (p) {
  let cur = resolve(String(p))
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) return null; cur = up }
  try { return norm(realpathSync.native(cur)) } catch { return null }
}

/** 线上的根（她的、DSH 的、线上代理的）。只按本机真家目录算，不看环境变量。 */
export function liveRoots (home = REAL_HOME) {
  const roots = [
    join(home, '.dsh'), join(home, '.dsh-fish'), join(home, '.dsh-fish-ledger'), join(home, '.dsh-fish-location.json'), join(home, '.dsh-fish-homes.json'),
    join(home, '.config', 'billion-context'), join(home, '.local', 'share', 'billion-context'),
    join(home, '.local', 'state', 'billion-context'), join(home, '.cache', 'billion-context'),
    join(home, '.nowledge'), join(home, '.nmem'),
  ]
  // 眼耳嘴的口令目录（~/.dsh-watch-<名字>）
  try { for (const n of readdirSync(home)) if (/^\.dsh-watch-/i.test(n)) roots.push(join(home, n)) } catch { /* 列不出就只用上面那些 */ }
  return roots
}

/** 一个路径：不许在线上的根下面（字符串、realpath 各一次），不许等于真家目录。 */
export function assertNotLive (p, what, roots = liveRoots()) {
  if (typeof p !== 'string' || p === '') fail(`${what} 没给`)
  if (/^[\\/]{2}/.test(p)) fail(`${what} 是 \\\\ 开头的路径`)
  if (norm(p) === norm(REAL_HOME)) fail(`${what} 等于真的家目录`)
  for (const r of roots) if (under(p, r)) fail(`${what} 在线上的根 ${r} 下面`)
  // ~/.dsh-watch-<名字> 按前缀认（列目录以后才建的也算；复核 B2）
  { const h = norm(REAL_HOME); const n = norm(p); if (n.startsWith(h + sep) && /^\.dsh-watch-/i.test(n.slice(h.length + 1))) fail(`${what} 在 ~/.dsh-watch-* 下面`) }
  const rp = realish(p)
  if (rp !== null) {
    if (rp === norm(REAL_HOME)) fail(`${what} 实际指向真的家目录`)
    // 根本身存在才取它的 realpath（不存在的根往上找会找到家目录，那样什么都算在里面）
    for (const r of roots) { const rr = existsSync(r) ? realish(r) : null; if (under(rp, r) || (rr !== null && under(rp, rr))) fail(`${what} 实际指向线上的根 ${r}`) }
  }
}

/** 一个路径：必须在 runDir 下面（字符串、realpath 各一次）。 */
export function assertInside (p, runDir, what) {
  if (typeof p !== 'string' || p === '') fail(`${what} 没给`)
  if (!under(p, runDir)) fail(`${what}（${p}）不在这次跑的目录 ${runDir} 下面`)
  const rp = realish(p)
  const rr = realish(runDir)
  if (rp !== null && rr !== null && !under(rp, rr)) fail(`${what} 实际不在这次跑的目录下面（目录联接？）`)
}

export function portOk (p) {
  const n = Number(p)
  return Number.isInteger(n) && n > 0 && n < 65536 && !(n >= LIVE_PORT_LO && n <= LIVE_PORT_HI)
}
export function assertPort (p, what) {
  if (!portOk(p)) fail(`${what} 端口 ${p} 不行（要 1–65535，而且不在 ${LIVE_PORT_LO}–${LIVE_PORT_HI}）`)
}
/** 只认 http://127.0.0.1:<端口>，端口不在线上那一段。 */
export function assertLoopbackUrl (u, what) {
  let url
  try { url = new URL(String(u)) } catch { fail(`${what} 不是网址`) }
  if (url.protocol !== 'http:') fail(`${what} 只认 http（回环上不走 TLS）`)
  if (url.hostname !== '127.0.0.1') fail(`${what} 的主机必须是 127.0.0.1（给的是 ${url.hostname}）`)
  assertPort(Number(url.port), what)
}

/** 代理拷贝 / 临时宿主必须换掉的环境变量（全部要给、全部在 runDir 下面）。 */
export const MUST_SWAP = Object.freeze([
  'HOME', 'USERPROFILE', 'DSH_HOME', 'FISH_LEDGER_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA',
])
/** 给了就也得在 runDir 下面的。 */
export const MAY_SWAP = Object.freeze(['DSH_FISH_HOME', 'DSH_FISH_LOCATION', 'DSH_FISH_HOMES', 'DSH_FISH_PROFILES','BILI_CONFIG_FILE', 'BILI_SESSIONS_DIR', 'ACP_DUMP_DIR', 'LIVE_PORT_LOG', 'OFFLINE_GUARD_LOG', 'NETGUARD_LOG', 'NODE_EXTRA_CA_CERTS', 'OB_NO_LIVE_FS_LOG', 'OB_LOOPBACK_LOG', 'OB_CLOCK_FILE'])
/** 名字像凭据的变量：代理拷贝的环境里一个都不许有（凭据只在转发器进程里）。 */
const CRED_NAME = /(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION_?KEY)/i
/** 会改变代理拷贝认法的线上记号：不许带进来。 */
const LIVE_MARKERS = ['BILI_LAUNCHER_LANE', 'NODE_TEST_CONTEXT', 'BILI_CLAUDE_NATIVE_PORT', 'DSH_PROFILE', 'DSH_AUTH_TOKEN']

/**
 * 代理拷贝（或临时宿主）的环境：起之前断言。
 * 回一份报告（只有名字和「在不在 runDir 下面」，不带值）写进 run.json。
 */
export function assertProxyEnv (env, runDir, { zonePort } = {}) {
  assertNotLive(runDir, 'runDir')
  const report = { swapped: {}, zonePort: null, strictPort: env.BILI_STRICT_PORT === '1', credNames: [], liveMarkers: [] }
  for (const k of MUST_SWAP) {
    if (!env[k]) fail(`环境变量 ${k} 没换（必须指进这次跑的目录）`)
    assertInside(env[k], runDir, k)
    assertNotLive(env[k], k)
    report.swapped[k] = 'inside-run'
  }
  for (const k of MAY_SWAP) {
    if (!env[k]) continue
    assertInside(env[k], runDir, k)
    assertNotLive(env[k], k)
    report.swapped[k] = 'inside-run'
  }
  const roots = liveRoots().map(norm)
  const home = norm(REAL_HOME)
  for (const [k, v] of Object.entries(env)) {
    if (CRED_NAME.test(k)) report.credNames.push(k)
    if (LIVE_MARKERS.includes(k)) report.liveMarkers.push(k)
    const val = String(v ?? '')
    if (val === '') continue
    // 值里出现线上的根（PATH 一类以分号分段比；别的整串比）
    const parts = /^(path|pathext)$/i.test(k) ? val.split(';') : [val]
    for (const part of parts) {
      if (part === '' || !/^[A-Za-z]:[\\/]|^[\\/]/.test(part)) continue
      const n = norm(part)
      if (n === home && !/^(path)$/i.test(k)) fail(`环境变量 ${k} 指着真的家目录`)
      for (const r of roots) if (n === r || n.startsWith(r + sep)) fail(`环境变量 ${k} 指进了线上的根 ${r}`)
    }
  }
  if (report.credNames.length) fail(`代理拷贝的环境里有像凭据的变量：${report.credNames.join(', ')}（凭据只许在转发器里）`)
  if (report.liveMarkers.length) fail(`代理拷贝的环境里带着线上的记号：${report.liveMarkers.join(', ')}`)
  const z = Number(env.BILI_ZONE_PORT)
  if (!Number.isInteger(z)) fail('BILI_ZONE_PORT 没设（不设就从 18787 起）')
  for (let i = 0; i <= 17; i++) if (!portOk(z + i)) fail(`BILI_ZONE_PORT=${z} 往上顺延会碰到 ${LIVE_PORT_LO}–${LIVE_PORT_HI}`)
  if (zonePort !== undefined && z !== zonePort) fail(`BILI_ZONE_PORT 不是约定的 ${zonePort}`)
  report.zonePort = z
  if (!report.strictPort) fail('BILI_STRICT_PORT 不是 1（代理被占时会往上顺延换端口）')
  return report
}

/** 从本进程的环境里只留系统必需的几样（照 rig 的做法），别的一律不带给子进程。 */
export function baseEnv (src = process.env) {
  const roots = liveRoots().map(norm)
  const out = Object.fromEntries(Object.entries(src).filter(([k]) => /^(path|systemroot|windir|comspec|pathext|systemdrive|number_of_processors|processor_architecture|os)$/i.test(k)))
  // PATH 里落在线上根下面的段（比如 ~/.dsh 里的什么 bin）去掉，免得子进程顺着 PATH 起到线上的东西
  for (const k of Object.keys(out)) {
    if (!/^path$/i.test(k)) continue
    out[k] = String(out[k]).split(';').filter((part) => {
      if (!/^[A-Za-z]:[\\/]/.test(part)) return true
      const n = norm(part)
      return !roots.some((r) => n === r || n.startsWith(r + sep))
    }).join(';')
  }
  return out
}

/** git 不签名的四个变量（测试或第三方代码自己建临时仓库时不走本机的提交签名）。 */
export const GIT_NOSIGN = Object.freeze({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false' })
