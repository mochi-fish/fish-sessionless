// tools/netguard.mjs 的测试：缺省（不设黑名单）时的行为，和「回环端口黑名单」选项（NETGUARD_DENY_LOOPBACK_PORTS）。
// 用法：node tools/test/test-netguard.mjs        （一个文件从头跑到尾，看 PASS / FAIL 行，有失败退 1）
//
// 规矩：
//   - 黑名单只用 29780–29799、29787、31001–31003 这几段（不在 Windows / Linux 的临时端口段里，也不是常见服务的端口），
//     而且只在「选项开着、挡板已经核过挂上了」的子进程里试被挡的那一下；没挂挡板的子进程一律不碰这几段。
//   - 子进程的环境是拼出来的：去掉 NODE_OPTIONS、NETGUARD_DENY_LOOPBACK_PORTS、OFFLINE_GUARD_LOG，NETGUARD_LOG 指到临时目录。
//   - 「非回环」用文档专用的 192.0.2.1（TEST-NET-1）：挡板在连之前就拦下，不会真的发出去。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NG = resolve(HERE, '..', 'netguard.mjs')
const T = mkdtempSync(join(tmpdir(), 'netguard-test-'))

let pass = 0
let fail = 0
const check = (id, ok, what, detail = '') => {
  if (ok) pass += 1; else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}) ${what}${detail ? ` (${detail})` : ''}`)
}

// 子脚本：按 mode 做几样事，结果打成一行 JSON。只在 mode 是 on* / multi 的时候才碰清单里的端口，而且先核过挡板挂上了。
const CHILD = String.raw`
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const mode = process.argv[2]
const out = { mode }
const MARK = Symbol.for('netguard.denyLoopbackPorts')
out.connectName = net.Socket.prototype.connect.name
out.listenName = net.Server.prototype.listen.name
out.marker = globalThis[MARK] ?? null
const tryConnect = (opts) => new Promise((res) => {
  const s = net.connect(opts)
  const t = setTimeout(() => { s.destroy(); res({ ok: false, code: 'TIMEOUT' }) }, 4000)
  s.once('connect', () => { clearTimeout(t); s.destroy(); res({ ok: true }) })
  s.once('error', (e) => { clearTimeout(t); res({ ok: false, code: e.code, msg: String(e.message).slice(0, 120) }) })
})
const tryListen = (arg, host) => {
  const srv = net.createServer()
  try {
    if (host === undefined) srv.listen(arg); else srv.listen(arg, host)
  } catch (e) { return Promise.resolve({ threw: true, code: e.code, msg: String(e.message).slice(0, 120) }) }
  return new Promise((res) => {
    srv.once('listening', () => srv.close(() => res({ threw: false, listening: true })))
    srv.once('error', (e) => res({ threw: false, listening: false, code: e.code }))
  })
}
// 自己开一个回环服务（随机端口），连它要通
const srv = http.createServer((q, r) => r.end('ok'))
srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
const P = srv.address().port
out.ownPortInDenyRange = P >= 29780 && P <= 29799
out.ownConnect = await tryConnect({ host: '127.0.0.1', port: P })
out.ownHttp = await new Promise((res) => { http.get('http://127.0.0.1:' + P + '/', (r) => { r.resume(); r.on('end', () => res({ ok: r.statusCode === 200 })) }).on('error', (e) => res({ ok: false, code: e.code })) })
// 非回环照旧被挡（IP 字面量，不查 DNS；文档专用地址）
out.nonLoop = await tryConnect({ host: '192.0.2.1', port: 9 })
const guarded = out.connectName === 'guardedConnect' && out.listenName === 'guardedListen' && typeof out.marker === 'string'
if (mode === 'on' || mode === 'grandchild') {
  if (!guarded) { out.skipped = 'guard not loaded, nothing in the deny list was tried' } else {
    out.c29799 = await tryConnect({ host: '127.0.0.1', port: 29799 })
    if (mode === 'on') {
      out.c29780num = await tryConnect(29780)
      out.c29790str = await tryConnect({ host: 'localhost', port: '29790' })
      out.http29799 = await new Promise((res) => { http.get('http://127.0.0.1:29799/', (r) => { r.resume(); res({ ok: true }) }).on('error', (e) => res({ ok: false, code: e.code, msg: String(e.message).slice(0, 120) })) })
      out.fetch29799 = await fetch('http://127.0.0.1:29799/').then(() => ({ ok: true }), (e) => ({ ok: false, code: e?.cause?.code, msg: String(e?.cause?.message ?? e.message).slice(0, 120) }))
      out.l29798 = await tryListen(29798, '127.0.0.1')
      out.l29798obj = await tryListen({ port: 29798, host: '127.0.0.1' })
      out.l29798str = await tryListen('29798')
      out.l0 = await tryListen(0, '127.0.0.1')
      out.l29779 = await tryListen(29779, '127.0.0.1')
      out.l29800 = await tryListen(29800, '127.0.0.1')
      // 孙进程：只靠继承下来的环境（NODE_OPTIONS + NETGUARD_DENY_LOOPBACK_PORTS）
      const g = spawn(process.execPath, [process.argv[1], 'grandchild'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let gout = ''
      g.stdout.on('data', (d) => { gout += d })
      await once(g, 'exit')
      try { out.grandchild = JSON.parse(gout.trim().split('\n').pop()) } catch { out.grandchild = { raw: gout.slice(0, 300) } }
    } else {
      out.l29798 = await tryListen(29798, '127.0.0.1')
    }
  }
}
if (mode === 'multi') {
  if (!guarded) { out.skipped = 'guard not loaded' } else {
    out.l29787 = await tryListen(29787, '127.0.0.1')
    out.l31002 = await tryListen(31002, '127.0.0.1')
    out.l31004 = await tryListen(31004, '127.0.0.1')
  }
}
srv.close()
console.log(JSON.stringify(out))
`
const childFile = join(T, 'child.mjs')
writeFileSync(childFile, CHILD)

const baseEnv = () => {
  const e = { ...process.env }
  for (const k of ['NODE_OPTIONS', 'NETGUARD_DENY_LOOPBACK_PORTS', 'OFFLINE_GUARD_LOG', 'NETGUARD_LOG']) delete e[k]
  return e
}
const runChild = (label, mode, extra = {}, viaNodeOptions = false) => {
  const log = join(T, `${label}.net.log`)
  const env = { ...baseEnv(), NETGUARD_LOG: log, ...extra }
  const url = pathToFileURL(NG).href
  let args
  if (viaNodeOptions) { env.NODE_OPTIONS = `--import=${url}`; args = [childFile, mode] } else args = [`--import=${url}`, childFile, mode]
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000 })
  let json = null
  try { json = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { /* 下面看 */ }
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  return { status: r.status, stderr: String(r.stderr), json, lines }
}
const kinds = (lines) => lines.reduce((m, l) => { m[l.kind] = (m[l.kind] ?? 0) + 1; return m }, {})
const blockedConnect = (x) => x && x.ok === false && x.code === 'ECONNREFUSED' && /NETGUARD_DENY_LOOPBACK_PORTS/.test(x.msg ?? '')
const blockedListen = (x) => x && x.threw === true && x.code === 'EACCES' && /NETGUARD_DENY_LOOPBACK_PORTS/.test(x.msg ?? '')
const notGuardListen = (x) => x && x.threw === false // 起来了，或者异步报 EADDRINUSE 之类：总之不是挡板同步抛的

try {
  // a：关着（不设）
  const off = runChild('off', 'off')
  const strip = (j) => j && JSON.stringify({ ...j, mode: undefined })
  check('a1', off.status === 0 && off.json !== null, '关着：子进程正常退出', `status ${off.status}${off.stderr ? ', stderr ' + off.stderr.slice(0, 200) : ''}`)
  // 原生的 net.Server.prototype.listen 是匿名函数（name 为 ""）：没被换 = 不是 guardedListen
  check('a2', off.json?.connectName === 'guardedConnect' && off.json?.listenName !== 'guardedListen' && off.json?.marker === null, '关着：connect 是 guardedConnect、listen 没被换、没有自查记号', JSON.stringify({ c: off.json?.connectName, l: off.json?.listenName, m: off.json?.marker }))
  check('a3', off.json?.ownConnect?.ok === true && off.json?.ownHttp?.ok === true, '关着：自己开的回环端口连得上、http 通')
  check('a4', off.json?.nonLoop?.code === 'ECONNREFUSED' && /real network blocked/.test(off.json?.nonLoop?.msg ?? ''), '关着：非回环被挡')
  check('a5', JSON.stringify(off.lines.map((l) => [l.kind, l.detail])) === JSON.stringify([['net.connect', '192.0.2.1']]), '关着：NETGUARD_LOG 里只有挡下非回环那一行', JSON.stringify(kinds(off.lines)))
  check('a6', off.lines.every((l) => l.argv1 === 'child.mjs'), '关着：日志里只记脚本的文件名，不记目录')

  // b：设成空串、只有空白——当成没设
  for (const [id, v] of [['b1', ''], ['b2', '   ']]) {
    const r = runChild(`blank-${id}`, 'off', { NETGUARD_DENY_LOOPBACK_PORTS: v })
    check(id, r.status === 0 && r.json?.listenName !== 'guardedListen' && r.json?.marker === null && strip(r.json) === strip(off.json) && JSON.stringify(kinds(r.lines)) === JSON.stringify(kinds(off.lines)), `设成 ${JSON.stringify(v)}：和不设一样`, `status ${r.status}`)
  }

  // c：开着（29780-29799，经 NODE_OPTIONS 挂上，孙进程靠继承）
  const on = runChild('on', 'on', { NETGUARD_DENY_LOOPBACK_PORTS: '29780-29799' }, true)
  const j = on.json ?? {}
  check('c0', on.status === 0 && on.json !== null && !j.skipped, '开着：子进程正常退出、挡板核过挂上了才试', `status ${on.status}${j.skipped ? ', ' + j.skipped : ''}${on.stderr ? ', stderr ' + on.stderr.slice(0, 200) : ''}`)
  check('c1', j.connectName === 'guardedConnect' && j.listenName === 'guardedListen' && j.marker === '29780-29799', '开着：connect 名字不变、listen 换成 guardedListen、自查记号是 29780-29799')
  check('c2', blockedConnect(j.c29799), '开着：连 127.0.0.1:29799 → ECONNREFUSED（挡板报的）', JSON.stringify(j.c29799))
  check('c3', blockedConnect(j.c29780num), '开着：net.connect(29780)（只给端口数字）→ 挡', JSON.stringify(j.c29780num))
  check('c4', blockedConnect(j.c29790str), '开着：{ host: localhost, port: "29790" }（字符串端口）→ 挡', JSON.stringify(j.c29790str))
  check('c5', j.http29799?.ok === false && j.http29799?.code === 'ECONNREFUSED' && /NETGUARD/.test(j.http29799?.msg ?? ''), '开着：http.get 29799 → 挡', JSON.stringify(j.http29799))
  check('c6', j.fetch29799?.ok === false && j.fetch29799?.code === 'ECONNREFUSED' && /NETGUARD/.test(j.fetch29799?.msg ?? ''), '开着：fetch 29799（undici）→ 挡', JSON.stringify(j.fetch29799))
  check('c7', blockedListen(j.l29798) && blockedListen(j.l29798obj) && blockedListen(j.l29798str), '开着：听 29798（数字 / 对象 / 字符串三种写法）→ 同步抛 EACCES', JSON.stringify([j.l29798?.code, j.l29798obj?.code, j.l29798str?.code]))
  check('c8', j.l0?.listening === true && j.ownConnect?.ok === true && j.ownHttp?.ok === true, '开着：随机端口照样能听、能连')
  check('c9', notGuardListen(j.l29779) && notGuardListen(j.l29800), '开着：区间两边的 29779、29800 不归它管', JSON.stringify([j.l29779, j.l29800]))
  check('c10', j.nonLoop?.code === 'ECONNREFUSED' && /real network blocked/.test(j.nonLoop?.msg ?? ''), '开着：非回环照旧按原来的规矩挡（记 net.connect）')
  const g = j.grandchild ?? {}
  check('c11', g.marker === '29780-29799' && g.listenName === 'guardedListen' && blockedConnect(g.c29799) && blockedListen(g.l29798), '开着：孙进程（只靠继承的环境）也挂着、连 29799 / 听 29798 都被挡', JSON.stringify({ m: g.marker, c: g.c29799?.code, l: g.l29798?.code, skipped: g.skipped }))
  const k = kinds(on.lines)
  const ports = on.lines.filter((l) => l.kind.startsWith('loopback-port')).map((l) => Number(l.detail))
  check('c12', k['loopback-port.connect'] === 6 && k['loopback-port.listen'] === 4 && k['net.connect'] === 2, '开着：NETGUARD_LOG 里 loopback-port.connect 6 行（子 5、孙 1）、loopback-port.listen 4 行（子 3、孙 1）、net.connect 2 行', JSON.stringify(k))
  check('c13', ports.length > 0 && ports.every((p) => p >= 29780 && p <= 29799), '开着：记下的端口都在区间里', JSON.stringify([...new Set(ports)].sort()))
  check('c14', on.lines.some((l) => l.kind === 'child'), '开着：起孙进程记了一行 child（子进程只记、不拦）')

  // d：多段写法（只试清单里的和清单外的端口）
  const multi = runChild('multi', 'multi', { NETGUARD_DENY_LOOPBACK_PORTS: ' 29787 , 31001-31003 ' })
  check('d1', multi.status === 0 && multi.json?.marker === '29787,31001-31003', '多段：规整成 29787,31001-31003', String(multi.json?.marker))
  check('d2', blockedListen(multi.json?.l29787) && blockedListen(multi.json?.l31002) && notGuardListen(multi.json?.l31004), '多段：听 29787、31002 被挡，31004 不归它管', JSON.stringify([multi.json?.l29787?.code, multi.json?.l31002?.code, multi.json?.l31004]))

  // e：写错了——进程起不来，不当成没设
  for (const [id, v] of [['e1', 'abc'], ['e2', '0'], ['e3', '70000'], ['e4', '29799-29780'], ['e5', '29780-'], ['e6', '29780,,29781'], ['e7', '29780-29799;']]) {
    const r = runChild(`bad-${id}`, 'off', { NETGUARD_DENY_LOOPBACK_PORTS: v })
    check(id, r.status !== 0 && r.json === null && /bad NETGUARD_DENY_LOOPBACK_PORTS/.test(r.stderr), `写成 ${JSON.stringify(v)}：进程起不来、报 bad NETGUARD_DENY_LOOPBACK_PORTS`, `status ${r.status}`)
  }
} finally {
  // 只删这次自己 mkdtemp 出来的目录（里面只有子脚本和日志，没有链接）
  try { rmSync(T, { recursive: true, force: true }) } catch { /* 留着也无妨 */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
