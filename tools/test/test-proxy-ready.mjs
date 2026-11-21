// tools/proxy-ready.mjs 的测试：replay（拿造出来的日志重演）、pre-start（造出来的登记目录）、post-start（假的 health 服务）。
// 用法：node tools/test/test-proxy-ready.mjs        （看 PASS / FAIL 行，有失败退 1）
// 不碰本机的 billion-context：一律带 --state-dir 指到临时目录、--port 指到自己开的假服务（随机端口）。
import http from 'node:http'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PR = resolve(HERE, '..', 'proxy-ready.mjs')
const T = mkdtempSync(join(tmpdir(), 'proxy-ready-test-'))

let pass = 0
let fail = 0
const check = (id, ok, what, detail = '') => {
  if (ok) pass += 1; else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}) ${what}${detail ? ` (${detail})` : ''}`)
}
const pad = (n, w = 2) => String(n).padStart(w, '0')
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` }
const env = { ...process.env, XDG_STATE_HOME: join(T, 'no-state') }
const run = (args) => {
  const r = spawnSync(process.execPath, [PR, ...args], { encoding: 'utf8', env, timeout: 60000 })
  let j = null
  try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { /* */ }
  return { code: r.status, j, out: String(r.stdout) + String(r.stderr) }
}
const runAsync = (args) => new Promise((done) => {
  const c = spawn(process.execPath, [PR, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; let err = ''
  c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { err += d })
  c.on('exit', (code) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()) } catch { /* */ } done({ code, j, out: out + err }) })
})

// ---- 日志 ----
const B = Date.parse('2026-01-02T03:04:00')
const L = {
  listen: (t, pid, id = 'abcdef0123456789') => `${stamp(t)} [proxy] acp-proxy v0.1.0 (pid ${pid}, id ${id}) listening on 127.0.0.1:20001`,
  attach: (t, pid) => `${stamp(t)} [dsh-client] bili: attaching to running proxy at 127.0.0.1:20001 (pid ${pid})`,
  fail: (t) => `${stamp(t)} [dsh-client] manifest registration failed (fetch failed)`,
  req: (t) => `${stamp(t)} [sess=session-00000000-0000-4000-8000-000000000001] [v=1] [session-00000000-0000-4000-8000-000000000001] request: 12 msgs`,
  anon: (t) => `${stamp(t)} [prefix-affinity] new anonymous session pfa-0a1b2c ua="deepseek-harness/0.2.2"`,
  flush: (t) => `${stamp(t)} [proxy] SIGTERM received — flushing sessions`,
  noise: (t) => `${stamp(t)} [proxy] something else happened`,
}
const logFile = (name, lines) => { const p = join(T, name); writeFileSync(p, lines.join('\n') + '\n'); return p }

try {
  // ---- a：replay ----
  const l1 = logFile('a1.log', [L.noise(B - 60000), L.listen(B + 2000, 4321), L.noise(B + 3000)])
  let r = run(['replay', '--log', l1, '--since', stamp(B), '--at', stamp(B + 20000)])
  check('a1', r.code === 0 && r.j?.verdict === 'ready' && r.j?.facts?.mode === 'spawned', 'replay：since 以后起的代理、过了 15 秒没有失败 → ready', r.out.slice(0, 200))
  r = run(['replay', '--log', l1, '--since', stamp(B), '--at', stamp(B + 7000)])
  check('a2', r.code === 1 && r.j?.verdict === 'wait', 'replay：落地才 5 秒 → wait（退 1）')
  r = run(['replay', '--log', l1, '--since', stamp(B), '--at', stamp(B + 7000), '--settle-ms', '1000'])
  check('a3', r.code === 0 && r.j?.verdict === 'ready', 'replay：--settle-ms 1000 时同一刻 → ready')
  const l2 = logFile('a4.log', [L.listen(B + 2000, 4321), L.fail(B + 4000)])
  r = run(['replay', '--log', l2, '--since', stamp(B), '--at', stamp(B + 30000)])
  check('a4', r.code === 1 && r.j?.verdict === 'not-ready' && r.j.reasons.some((x) => /registration not proven/.test(x)), 'replay：登记失败、之后没有带会话头的请求 → not-ready')
  const l3 = logFile('a5.log', [L.listen(B + 2000, 4321), L.fail(B + 4000), L.req(B + 9000)])
  r = run(['replay', '--log', l3, '--since', stamp(B), '--at', stamp(B + 30000)])
  check('a5', r.code === 0 && r.j?.verdict === 'ready' && r.j.warnings.some((x) => /recovered/.test(x)), 'replay：失败之后有带会话头的请求 → ready，带一条 recovered 警告')
  const l4 = logFile('a6.log', [L.listen(B + 2000, 4321), L.anon(B + 3000)])
  r = run(['replay', '--log', l4, '--since', stamp(B), '--at', stamp(B + 30000)])
  check('a6', r.code === 1 && r.j?.reasons.some((x) => /anonymous/.test(x)), 'replay：DSH 的请求已经走了匿名会话 → not-ready')
  const l5 = logFile('a7.log', [L.listen(B - 600000, 1111), L.attach(B + 3000, 1111)])
  r = run(['replay', '--log', l5, '--since', stamp(B), '--at', stamp(B + 30000)])
  check('a7', r.code === 0 && r.j?.facts?.mode === 'attached', 'replay：旧代理、但这次的宿主记了 attaching 同一个 pid → ready（attached）')
  const l6 = logFile('a8.log', [L.listen(B - 600000, 1111)])
  r = run(['replay', '--log', l6, '--since', stamp(B), '--at', stamp(B + 30000)])
  check('a8', r.code === 1 && r.j?.verdict === 'not-ready' && r.j.reasons.some((x) => /predates/.test(x)), 'replay：旧代理、没有 attaching → not-ready')
  r = run(['replay', '--log', l6, '--since', stamp(B), '--at', stamp(B + 30000), '--phase', 'pre-start'])
  check('a9', r.code === 1 && r.j?.verdict === 'not-ready', 'replay pre-start：代理还在（没有 flushing 行）→ not-ready')
  const l7 = logFile('a10.log', [L.listen(B - 600000, 1111), L.flush(B - 1000)])
  r = run(['replay', '--log', l7, '--since', stamp(B), '--at', stamp(B + 1000), '--phase', 'pre-start'])
  check('a10', r.code === 0 && r.j?.verdict === 'ready' && r.j.warnings.length === 1, 'replay pre-start：已经开始 flushing → ready，提醒看不到它什么时候退')
  const l8a = logFile('a11a.log', [L.listen(B - 600000, 1111)])
  const l8b = logFile('a11b.log', [L.attach(B + 3000, 1111)])
  r = run(['replay', '--log', l8a, '--log', l8b, '--since', stamp(B), '--at', stamp(B + 30000)])
  check('a11', r.code === 0 && r.j?.facts?.mode === 'attached', 'replay：两份日志（.old + 新的）合起来读')
  r = run(['replay', '--log', join(T, 'nope.log'), '--since', stamp(B), '--at', stamp(B + 1000)])
  check('a12', r.code === 2 && r.j?.verdict === 'error', 'replay：日志不在 → 2')

  // ---- b：参数 ----
  check('b1', run([]).code === 2, '没给阶段 → 2')
  check('b2', run(['post-start']).code === 2, 'post-start 没给 --since → 2')
  check('b3', run(['replay', '--log', l1]).code === 2, 'replay 没给 --since / --at → 2')
  check('b4', run(['pre-start', '--bogus']).code === 2, '不认识的参数 → 2')

  // ---- c：pre-start（造出来的登记目录）----
  const S1 = join(T, 'state1'); mkdirSync(join(S1, 'instances'), { recursive: true })
  r = run(['pre-start', '--state-dir', S1, '--port', '20001'])
  check('c1', r.code === 0 && r.j?.verdict === 'ready' && r.j.facts.entries.length === 0, 'pre-start：没有登记 → ready')
  check('c2', !r.out.includes(S1) && !r.out.includes(S1.replace(/\\/g, '\\\\')) && r.j?.facts?.stateDir === '<billion-context state>', 'pre-start：输出里不带状态目录的路径')
  // 一个已经退出的进程的 pid
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  const deadPid = Number(String(dead.stdout).trim())
  writeFileSync(join(S1, 'instances', 'old.json'), JSON.stringify({ pid: deadPid, instanceId: 'deadbeef00000000', port: 20001, lane: 'dsh', startedAt: B }))
  r = run(['pre-start', '--state-dir', S1, '--port', '20001'])
  check('c3', r.code === 0 && r.j?.verdict === 'ready' && r.j.warnings.some((x) => /stale/.test(x)), 'pre-start：只有死进程的登记 → ready，记一条 stale', `dead pid ${deadPid}`)
  writeFileSync(join(S1, 'instances', 'live.json'), JSON.stringify({ pid: process.pid, instanceId: 'cafe000000000000', port: 20001, lane: 'dsh', startedAt: B }))
  r = run(['pre-start', '--state-dir', S1, '--port', '20001'])
  check('c4', r.code === 1 && r.j?.reasons.some((x) => /still serving/.test(x)), 'pre-start：DSH 车道上还有活着的代理 → not-ready')
  writeFileSync(join(S1, 'instances', 'live.json'), JSON.stringify({ pid: process.pid, instanceId: 'cafe000000000000', port: 20001, lane: 'dsh', startedAt: B, portReleasedAt: B + 1000 }))
  r = run(['pre-start', '--state-dir', S1, '--port', '20001'])
  check('c5', r.code === 1 && r.j?.reasons.some((x) => /draining/.test(x)), 'pre-start：放了端口、还在落盘 → 照样 not-ready')
  writeFileSync(join(S1, 'instances', 'live.json'), JSON.stringify({ pid: process.pid, instanceId: 'cafe000000000000', port: 20999, lane: 'web', startedAt: B }))
  r = run(['pre-start', '--state-dir', S1, '--port', '20001'])
  check('c6', r.code === 0, 'pre-start：别的车道、别的端口上的活代理不算')
  writeFileSync(join(S1, 'port-zone.json'), JSON.stringify({ lanes: { dsh: 20999 } }))
  r = run(['pre-start', '--state-dir', S1])
  check('c7', r.code === 1 && r.j?.facts?.port === 20999, 'pre-start：没给 --port 时读 port-zone.json 的 dsh 车道')

  // ---- d：post-start（假 health）----
  const now0 = Date.now()
  const S2 = join(T, 'state2'); mkdirSync(join(S2, 'instances'), { recursive: true })
  const ID = '0123456789abcdef0123456789abcdef'
  let health = { ok: true, pid: process.pid, instanceId: ID, startedAt: now0 - 25500, version: '0.0.0-test', watchdog: { armed: true, parentPid: process.pid, watchers: [process.pid] }, upstream: 'https://example.invalid/' }
  let status = 200
  const srv = http.createServer((q, res) => { if (q.url !== '/__bili/health') { res.statusCode = 404; res.end(); return } res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(health)) })
  let port = 0
  for (let k = 0; k < 5; k++) { srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port; if (port < 18780 || port > 18799) break; srv.close(); await once(srv, 'close') }
  writeFileSync(join(S2, 'instances', 'me.json'), JSON.stringify({ pid: process.pid, instanceId: ID, port, lane: 'dsh', startedAt: now0 - 25500 }))
  writeFileSync(join(S2, 'bili.log'), [L.noise(now0 - 120000), L.listen(now0 - 25000, process.pid, '0123456789abcdef')].join('\n') + '\n')
  const post = (extra = []) => runAsync(['post-start', '--state-dir', S2, '--port', String(port), '--since', String(now0 - 30000), ...extra])
  r = await post()
  check('d1', r.code === 0 && r.j?.verdict === 'ready' && r.j.facts.mode === 'spawned', 'post-start：health 200、登记对得上、日志有 listening、够 15 秒 → ready', r.out.slice(0, 300))
  check('d2', !r.out.includes('example.invalid') && !r.out.includes(S2) && !r.out.includes(S2.replace(/\\/g, '\\\\')), 'post-start：输出里没有上游地址、没有状态目录')
  check('d3', JSON.stringify(r.j?.facts?.logCopied) === '["bili.log"]', 'post-start：读的是 bili.log 的拷贝')
  status = 503; health = { ok: false, reason: 'starting' }
  r = await post()
  check('d4', r.code === 1 && r.j?.verdict === 'wait', 'post-start：health 503 starting → wait')
  status = 200; health = { ok: true, pid: process.pid, instanceId: ID, startedAt: now0 - 25500, watchdog: { armed: false, watchers: [] } }
  r = await post()
  check('d5', r.code === 1 && r.j?.verdict === 'not-ready' && r.j.reasons.some((x) => /not armed/.test(x)), 'post-start：watchdog 没 armed → not-ready')
  health = { ok: true, pid: process.pid, instanceId: 'ffff000000000000', startedAt: now0 - 25500, watchdog: { armed: true, watchers: [process.pid] } }
  r = await post()
  check('d6', r.code === 1 && r.j?.reasons.some((x) => /does not match a live registry entry/.test(x)), 'post-start：health 的 id 和登记对不上 → not-ready')
  srv.close(); await once(srv, 'close')
  r = await post()
  check('d7', r.code === 1 && r.j?.verdict === 'wait' && r.j.reasons.some((x) => /no proxy answers/.test(x)), 'post-start：没人答 → wait')
} finally {
  try { rmSync(T, { recursive: true, force: true }) } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
