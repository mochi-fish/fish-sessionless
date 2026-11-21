// 转发器进程的出网闸（--import 预加载）。整套架子里只有转发器能出网，而且只能去名单上的「主机:端口」。
//   FWD_EGRESS_ALLOW="api.deepseek.com:443,api.anthropic.com:443,generativelanguage.googleapis.com:443,<推理机主机>:8000"
//     名单按主机名精确比（不认通配、不认 IP），端口也要对上。空 = 只许回环。
//   回环：任何端口都许连，除了线上代理那一段 18780–18799（连、听都不许）。
//   DNS：只解析名单上的主机名和 localhost，别的报 ENOTFOUND（连不了的名字也就解析不出来，不走漏查询）。
//   子进程：一律不许（转发器用不着起子进程）。
//   全局 fetch：同一套规则（undici 不走 net.Socket.prototype.connect 的 hostname 那一层，单独挡一次）。
//   FWD_EGRESS_LOG：每次放行 / 拦下记一行（只记主机和端口，不记路径、头和正文）。
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import dns from 'node:dns'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const LO = 18780
const HI = 18799
const LOG = process.env.FWD_EGRESS_LOG || ''
const note = (kind, host, port) => { if (!LOG) return; try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, host: String(host), port: Number(port) || null }) + '\n') } catch {} }

const ALLOW = new Map()
for (const part of String(process.env.FWD_EGRESS_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(part)
  if (!m || /^\d+\.\d+\.\d+\.\d+$/.test(m[1])) throw new Error(`egress-guard: bad FWD_EGRESS_ALLOW entry ${JSON.stringify(part)} (want host:port, no IPs)`)
  const host = m[1].toLowerCase()
  if (!ALLOW.has(host)) ALLOW.set(host, new Set())
  ALLOW.get(host).add(Number(m[2]))
}
const LOOP = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const isLoop = (h) => LOOP.has(String(h).toLowerCase()) || /^127\./.test(String(h))
const livePort = (p) => Number.isInteger(Number(p)) && Number(p) >= LO && Number(p) <= HI

export function egressAllowed (host, port) {
  if (host === undefined || host === null || host === '') host = 'localhost'
  const h = String(host).toLowerCase().replace(/\.$/, '')
  if (isLoop(h)) return !livePort(port)
  const ports = ALLOW.get(h)
  return !!ports && ports.has(Number(port))
}
globalThis[Symbol.for('fwd.egressGuard')] = { allow: [...ALLOW.entries()].map(([h, ps]) => `${h}:${[...ps].join('|')}`).sort(), egressAllowed }

const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect (...args) {
  let opts = args[0]
  if (Array.isArray(opts)) opts = opts[0]
  let host
  let port
  if (opts && typeof opts === 'object') {
    if ((opts.port === undefined || opts.port === null) && typeof opts.path === 'string' && opts.path !== '') {
      note('deny-pipe', opts.path.slice(0, 40), null)
      const err = new Error('egress-guard: pipes/unix sockets are not allowed')
      err.code = 'EACCES'
      process.nextTick(() => this.destroy(err))
      return this
    }
    host = opts.host ?? opts.hostname ?? 'localhost'
    port = opts.port
  } else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) {
    host = typeof args[1] === 'string' ? args[1] : 'localhost'
    port = opts
  } else {
    const err = new Error('egress-guard: pipes/unix sockets are not allowed')
    err.code = 'EACCES'
    process.nextTick(() => this.destroy(err))
    return this
  }
  if (!egressAllowed(host, port)) {
    note('deny-connect', host, port)
    const err = new Error(`egress-guard: ${host}:${port} is not on the allow list`)
    err.code = 'ECONNREFUSED'
    process.nextTick(() => this.destroy(err))
    return this
  }
  if (!isLoop(String(host))) note('allow-connect', host, port)
  return origConnect.apply(this, args)
}

const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function guardedListen (...args) {
  const a = args[0]
  const port = typeof a === 'object' && a !== null ? a.port : a
  if (livePort(port)) { note('deny-listen', 'local', port); const e = new Error(`egress-guard: may not listen on ${port}`); e.code = 'EACCES'; throw e }
  const host = typeof a === 'object' && a !== null ? a.host : (typeof args[1] === 'string' ? args[1] : undefined)
  if (host !== undefined && !isLoop(host)) { note('deny-listen-host', host, port); const e = new Error(`egress-guard: may only listen on loopback (got ${host})`); e.code = 'EACCES'; throw e }
  return origListen.apply(this, args)
}

const origLookup = dns.lookup
dns.lookup = function guardedLookup (hostname, options, cb) {
  const callback = typeof options === 'function' ? options : cb
  const h = String(hostname).toLowerCase().replace(/\.$/, '')
  if (!isLoop(h) && !ALLOW.has(h)) {
    note('deny-dns', h, null)
    const err = new Error(`egress-guard: dns ${h} not allowed`)
    err.code = 'ENOTFOUND'
    process.nextTick(() => callback(err))
    return {}
  }
  return origLookup.call(this, hostname, options, cb)
}
for (const k of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveSrv', 'resolveCname', 'resolveMx', 'resolveNs', 'reverse']) {
  if (typeof dns[k] === 'function') dns[k] = function () { const cb = [...arguments].reverse().find((x) => typeof x === 'function'); note('deny-dns-' + k, String(arguments[0]), null); const e = new Error('egress-guard: dns.' + k + ' blocked'); e.code = 'ENOTFOUND'; if (cb) process.nextTick(() => cb(e)) }
}
if (dns.promises) {
  const pl = dns.promises.lookup
  dns.promises.lookup = async (hostname, options) => {
    const h = String(hostname).toLowerCase().replace(/\.$/, '')
    if (!isLoop(h) && !ALLOW.has(h)) { note('deny-dns', h, null); const e = new Error(`egress-guard: dns ${h} not allowed`); e.code = 'ENOTFOUND'; throw e }
    return pl.call(dns.promises, hostname, options)
  }
}

const deny = (name) => function () { note('deny-child', name, null); const e = new Error(`egress-guard: child_process.${name} blocked in the forwarder`); e.code = 'EACCES'; throw e }
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[k] = deny(k)

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url)
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
    if (!egressAllowed(u.hostname, port)) { note('deny-fetch', u.hostname, port); throw new Error(`egress-guard: fetch to ${u.hostname}:${port} blocked`) }
    return origFetch(input, init)
  }
}

// 让别处用 `import { spawn } from 'node:child_process'` 这类具名导入拿到的也是上面换过的那份
syncBuiltinESMExports()
