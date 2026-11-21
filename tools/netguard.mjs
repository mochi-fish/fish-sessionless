// 第二道出网挡板（和 offline-guard.mjs 一起预加载：node --import offline-guard.mjs --import netguard.mjs <脚本>）：
// 全局 fetch 以外的出网（undici、node:http/https、net/tls 直连、dns 查询）也只放行回环；
// 子进程不拦，只记下命令名，事后看有没有可能出网的。拦下的记进 NETGUARD_LOG（没设就用 OFFLINE_GUARD_LOG）。
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import dns from 'node:dns'
import cp from 'node:child_process'
import { createRequire } from 'node:module'

const LOG = process.env.NETGUARD_LOG || process.env.OFFLINE_GUARD_LOG
const LOOP = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', ''])
const isLoop = (h) => h === undefined || h === null || LOOP.has(String(h)) || /^127\./.test(String(h))
const note = (kind, detail) => { try { appendFileSync(LOG, JSON.stringify({ kind, detail, argv1: String(process.argv[1] ?? '').replace(/^.*[\\/]/, '') }) + '\n') } catch {} }

// 可选，缺省关：回环端口黑名单。NETGUARD_DENY_LOOPBACK_PORTS="18780-18799"（逗号分隔的端口或「起-止」区间）时，
// 这些端口不许连（记 loopback-port.connect、套接字报 ECONNREFUSED）、也不许听（记 loopback-port.listen、同步抛 EACCES）；
// 设了以后 globalThis[Symbol.for('netguard.denyLoopbackPorts')] 是规整过的写法，脚本可以拿它自查。
// 用处：本机有一个正在用的服务（比如线上的代理）时，测试里的东西碰不到它的端口。
// 不设或空白：不多拦、不多记、不碰 net.Server.prototype.listen。写错了就让进程起不来，不当成没设。
// 管不到的（netguard 整份都一样）：--import 的预加载在 eval: true 的 worker 线程里不跑（node 22 上核过）；
// 要挡这种 worker 里的连接，得另用 --require 挂一个 CommonJS 的挡板。
// 测试：tools/test/test-netguard.mjs。
const DENY_SPEC = String(process.env.NETGUARD_DENY_LOOPBACK_PORTS ?? '').trim()
const DENY = DENY_SPEC === '' ? null : DENY_SPEC.split(',').map((part) => {
  const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(part)
  const a = m ? Number(m[1]) : NaN
  const b = m ? Number(m[2] ?? m[1]) : NaN
  if (!(a >= 1 && b <= 65535 && a <= b)) throw new Error(`netguard: bad NETGUARD_DENY_LOOPBACK_PORTS ${JSON.stringify(DENY_SPEC)} (want e.g. 18780-18799 or 18787,18790-18799)`)
  return [a, b]
})
const denied = (p) => DENY !== null && Number.isInteger(p) && DENY.some(([a, b]) => p >= a && p <= b)

const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0]
  if (Array.isArray(opts)) opts = opts[0]
  let host
  let port
  if (opts && typeof opts === 'object') {
    // 命名管道 / unix socket：只有没给端口、path 是字符串时才算（https 的选项里 path 是请求路径，不能放过）
    if ((opts.port === undefined || opts.port === null) && typeof opts.path === 'string' && opts.path !== '') return origConnect.apply(this, args)
    host = opts.host ?? opts.hostname ?? 'localhost'
    port = opts.port
  } else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) {
    host = typeof args[1] === 'string' ? args[1] : undefined
    port = opts
  } else if (typeof opts === 'string') {
    return origConnect.apply(this, args) // 管道路径
  }
  if (!isLoop(host)) {
    note('net.connect', String(host))
    const err = new Error(`netguard: real network blocked (${host})`)
    err.code = 'ECONNREFUSED'
    process.nextTick(() => this.destroy(err))
    return this
  }
  if (DENY !== null && denied(Number(port))) {
    note('loopback-port.connect', String(Number(port)))
    const err = new Error(`netguard: loopback port ${Number(port)} is on NETGUARD_DENY_LOOPBACK_PORTS`)
    err.code = 'ECONNREFUSED'
    process.nextTick(() => this.destroy(err))
    return this
  }
  return origConnect.apply(this, args)
}

if (DENY !== null) {
  const origListen = net.Server.prototype.listen
  net.Server.prototype.listen = function guardedListen(...args) {
    const a = args[0]
    const p = Number(a && typeof a === 'object' ? a.port : a)
    if (denied(p)) {
      note('loopback-port.listen', String(p))
      throw Object.assign(new Error(`netguard: refusing to listen on ${p} (NETGUARD_DENY_LOOPBACK_PORTS)`), { code: 'EACCES' })
    }
    return origListen.apply(this, args)
  }
  globalThis[Symbol.for('netguard.denyLoopbackPorts')] = DENY.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',')
}

const origLookup = dns.lookup
dns.lookup = function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  if (!isLoop(hostname)) {
    note('dns.lookup', String(hostname))
    const err = new Error(`netguard: dns blocked (${hostname})`)
    err.code = 'ENOTFOUND'
    process.nextTick(() => callback(err))
    return
  }
  return origLookup.call(this, hostname, options, callback)
}
if (dns.promises) {
  const origP = dns.promises.lookup
  dns.promises.lookup = async function guardedPLookup(hostname, options) {
    if (!isLoop(hostname)) { note('dns.promises.lookup', String(hostname)); const e = new Error(`netguard: dns blocked (${hostname})`); e.code = 'ENOTFOUND'; throw e }
    return origP.call(this, hostname, options)
  }
}

for (const name of ['spawn', 'execFile', 'exec', 'spawnSync', 'execFileSync', 'execSync', 'fork']) {
  const orig = cp[name]
  if (typeof orig !== 'function') continue
  cp[name] = function loggedChild(cmd, ...rest) {
    const argv = Array.isArray(rest[0]) ? rest[0].slice(0, 4).map(String) : []
    note('child', `${name} ${String(cmd).replace(/^.*[\\/]/, '')} ${argv.join(' ')}`.slice(0, 200))
    return orig.call(this, cmd, ...rest)
  }
}
// ESM 的命名导入在这之前已经绑定了原函数：把 builtin 的导出也同步一下
try { const req = createRequire(import.meta.url); const m = req('node:module'); m.syncBuiltinESMExports?.() } catch {}
