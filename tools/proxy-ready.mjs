#!/usr/bin/env node
// 代理就绪判据：上线脚本重启 DSH 前后，只读地判断
// billion-context 代理（DSH 车道，默认 127.0.0.1:18787）是不是「这次起来的 DSH 已经接好、工具也登记上了」，
// 免得 DSH 刚起来就给陪伴体送消息、把她叫起来时，第一份请求被代理当成匿名会话（见过的后果：白跑几分钟 preflight、413、
// 多一次 UNKNOWN_TOOL）。
//
// 三种用法（每次调用都是一次性的判断，要等就由上线脚本自己隔几秒再调）：
//   node tools/proxy-ready.mjs pre-start  [--state-dir D] [--deadline-ms 8000]
//       停 DSH 以后、起 DSH 以前：旧代理走干净了没有。只读文件 + 查进程在不在，不连网、不连端口。
//       读 <state>/instances/*.json 和 <state>/proxy-origin（代理自己的登记），DSH 车道（lane dsh 或端口等于
//       port-zone.json 记的端口）上只要还有一个进程活着的登记（不管有没有 portReleasedAt）就算没走完。
//   node tools/proxy-ready.mjs post-start --since <起 DSH 的时刻> [--state-dir D] [--port N] [--settle-ms 15000] [--deadline-ms 10000]
//       起 DSH 以后、给陪伴体送第一条消息以前：GET 一次 http://127.0.0.1:<port>/__bili/health（只这一个请求，不复用连接、
//       不重试，3 秒超时），读登记文件，把 bili.log（必要时连 bili.log.old）拷到自己的临时目录读拷贝、读完删掉。
//       --since 给毫秒数或本地时刻（2026-01-02T03:04:05，和 bili.log 一样是本机钟点、不带时区）。
//   node tools/proxy-ready.mjs replay --log <bili.log 的拷贝> [--log <另一份>] --since <本地时刻> --at <本地时刻>
//                                   [--phase pre-start|post-start] [--settle-ms 15000]
//       只拿日志拷贝重演某个时刻会怎么判（health 和登记由日志推出来）：事后复盘某一次重启用。
//       不碰线上任何东西，--log 指线上原件的话照样只读、不拷。
//
// 判 post-start 的几条（都过才 ready）：
//   H  health 200、ok:true；它的 pid / instanceId 和登记里活着的那一条对得上；watchdog.armed，watchers 里至少一个进程活着。
//   F  代理是这次起的（health.startedAt ≥ since−2s，日志里 since 以后有它的 listening 行）；
//      或者是旧的、但 since 以后有「attaching to running proxy … (pid 同一个)」那行。
//   R  since 以后没有 [dsh-client] 的 manifest registration failed / proxy bootstrap failed / proxy respawn gave up /
//      bili tools still unavailable / attach target … unreachable；也没有「attaching to running proxy」接到别的 pid 上。
//      有的话，要在最后一条之后看见带会话头的请求（[sess=session-…] request:），才算已经好了。
//   S  listening（或 attaching）那行到现在至少 settle 毫秒（默认 15 秒）：dsh-native 在代理落地后马上取 manifest
//      登记工具，取不到 5 秒内（MANIFEST_TIMEOUT_MS）就会写一行 failed；成功不写日志，所以只能等够这段时间、看没有失败。
//   另：since 以后出现过 ua 是 deepseek-harness 的匿名会话（[prefix-affinity] new anonymous session pfa-…），说明已经
//   有请求走了 wire 模式；后面没有带会话头的请求就算没好。带会话头、工具表里却没有 compress 的请求（代理打
//   surface=off(...) 的那种）只报 warning：那一步开始时工具还没登记，里面调 acp_status 会 UNKNOWN_TOOL。
//   没人答 health、503 starting、listening 行还没写出来，这几样算 wait（再等等），不算 not-ready。
//
// 输出：stdout 一行 JSON {tool, v, phase, verdict, ready, reasons[], warnings[], facts{}}；只有时刻、pid、连接、计数、
// 状态码，不打印日志正文、上游地址、会话内容。
// 退出码：0 ready；1 not-ready 或 wait（verdict 区分）；2 参数错 / 读不了；3 超过 --deadline-ms。
// 不写任何东西（除了 post-start 自己 mkdtemp 的临时目录，读完就删）；不发 health 以外的请求；只连 127.0.0.1 上的那一个端口
// （--port，没给就读 port-zone.json 的 dsh 车道，再没有就是 billion-context 的缺省 18787）。
// 状态目录缺省是 $XDG_STATE_HOME/billion-context（没设就是 ~/.local/state/billion-context），--state-dir 可换。
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const USAGE = [
  '用法：',
  '  node tools/proxy-ready.mjs pre-start  [--state-dir D] [--deadline-ms 8000]',
  '  node tools/proxy-ready.mjs post-start --since <毫秒|本地时刻> [--state-dir D] [--port N] [--settle-ms 15000] [--deadline-ms 10000]',
  '  node tools/proxy-ready.mjs replay --log <拷贝> [--log <拷贝>] --since <本地时刻> --at <本地时刻> [--phase pre-start|post-start] [--settle-ms 15000]',
].join('\n')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const phaseArg = argv[0]
const opt = { logs: [] }
for (let k = 1; k < argv.length; k++) {
  const a = argv[k]
  const val = () => { const v = argv[++k]; if (v === undefined) usage(`${a} 要给值`); return v }
  if (a === '--state-dir') opt.stateDir = val()
  else if (a === '--since') opt.since = val()
  else if (a === '--at') opt.at = val()
  else if (a === '--port') opt.port = Number(val())
  else if (a === '--settle-ms') opt.settleMs = Number(val())
  else if (a === '--deadline-ms') opt.deadlineMs = Number(val())
  else if (a === '--phase') opt.phase = val()
  else if (a === '--log') opt.logs.push(val())
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0) }
  else usage(`不认识的参数 ${a}`)
}
function usage (msg) { console.error(msg + '\n' + USAGE); process.exit(2) }
if (!['pre-start', 'post-start', 'replay'].includes(phaseArg)) usage('第一个参数要是 pre-start、post-start 或 replay')
const SETTLE_MS = Number.isFinite(opt.settleMs) && opt.settleMs >= 0 ? opt.settleMs : 15000
const DEADLINE_MS = Number.isFinite(opt.deadlineMs) && opt.deadlineMs > 0 ? opt.deadlineMs : (phaseArg === 'post-start' ? 10000 : 8000)
const HEALTH_TIMEOUT_MS = 3000
const SINCE_SLACK_MS = 2000

const home = process.env.USERPROFILE || homedir()
const stateDir = resolve(opt.stateDir ?? join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'billion-context'))

/** 毫秒数或本地时刻（不带时区 = 本机钟点，和 bili.log 一样）→ 毫秒 */
function toMs (s, what) {
  if (s === undefined) return undefined
  if (/^\d{12,}$/.test(String(s))) return Number(s)
  const t = Date.parse(String(s))
  if (!Number.isFinite(t)) usage(`${what} 认不出：${s}`)
  return t
}
const pad = (n, w = 2) => String(n).padStart(w, '0')
const localStamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` }

// ---------- 输出 / 时限 ----------
let tmpDir = null
const cleanup = () => { if (tmpDir !== null) { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 删不掉就算了：在 TEMP 里 */ } tmpDir = null } }
let printed = false
function finish (result, code) {
  if (printed) return
  printed = true
  cleanup()
  process.stdout.write(JSON.stringify({ tool: 'proxy-ready', v: 1, phase: phaseArg === 'replay' ? `replay:${opt.phase ?? 'post-start'}` : phaseArg, ...result }) + '\n')
  process.exit(code)
}
const deadline = setTimeout(() => finish({ verdict: 'timeout', ready: false, reasons: [`no verdict within ${DEADLINE_MS} ms`], warnings: [], facts: {} }, 3), DEADLINE_MS)

// ---------- 进程在不在（只查，不动） ----------
/** 活着回 { alive:true, image }，image 拿不到是 null；pid 不合法或没这个进程回 { alive:false } */
function pidInfo (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, image: null }
  let alive
  try { process.kill(pid, 0); alive = true } catch (e) { alive = e?.code === 'EPERM' }
  if (!alive) return { alive: false, image: null }
  let image = null
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
      const row = String(r.stdout ?? '').split(/\r?\n/).map((l) => l.match(/^"([^"]*)","(\d+)"/)).find((m) => m !== null && Number(m[2]) === pid)
      if (row) image = row[1]
      else if (r.status === 0) alive = false // tasklist 跑通了却没有这一行：进程刚走
    } catch { /* tasklist 起不来：只信 kill(0) */ }
  }
  return { alive, image }
}

// ---------- 代理自己的登记 ----------
function zonePort () {
  if (Number.isInteger(opt.port) && opt.port > 0 && opt.port < 65536) return opt.port
  try { const p = JSON.parse(readFileSync(join(stateDir, 'port-zone.json'), 'utf8'))?.lanes?.dsh; if (Number.isInteger(p) && p > 0 && p < 65536) return p } catch { /* 没有就是缺省 */ }
  return 18787
}
/** instances/*.json + proxy-origin，按 instanceId 去重；只留和 DSH 车道有关的 */
function registry (port) {
  const seen = new Map()
  const take = (o, from) => {
    if (!o || typeof o !== 'object') return
    const pid = Number(o.pid)
    const id = typeof o.instanceId === 'string' ? o.instanceId : `${from}:${pid}`
    const e = seen.get(id) ?? { instanceId: id, from: [] }
    e.from.push(from)
    e.pid = pid
    e.port = Number(o.port)
    e.lane = typeof o.lane === 'string' ? o.lane : null
    if (Number.isFinite(o.startedAt)) e.startedAt = o.startedAt
    if (Number.isFinite(o.portReleasedAt)) e.portReleasedAt = o.portReleasedAt
    seen.set(id, e)
  }
  let unreadable = 0
  const dir = join(stateDir, 'instances')
  let names = []
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { /* 没有目录 = 没有登记 */ }
  for (const n of names) { try { take(JSON.parse(readFileSync(join(dir, n), 'utf8')), 'instances') } catch { unreadable += 1 } }
  try { take(JSON.parse(readFileSync(join(stateDir, 'proxy-origin'), 'utf8')), 'proxy-origin') } catch { /* 没有或坏了 */ }
  const out = []
  for (const e of seen.values()) {
    if (e.lane !== 'dsh' && e.port !== port) continue
    const p = pidInfo(e.pid)
    out.push({ ...e, alive: p.alive, image: p.image, state: !p.alive ? 'gone' : (e.portReleasedAt !== undefined ? 'draining' : 'serving') })
  }
  return { entries: out, unreadable }
}
const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : null)
const entryFact = (e) => ({ pid: e.pid, id: shortId(e.instanceId), state: e.state, image: e.image, startedAt: e.startedAt !== undefined ? localStamp(e.startedAt) : null, portReleasedAt: e.portReleasedAt !== undefined ? localStamp(e.portReleasedAt) : null, from: e.from })

// ---------- 日志 ----------
const RX = {
  listening: /acp-proxy v\S+ \(pid (\d+), id ([0-9a-f]+)\) listening on /,
  attach: /bili: attaching to running proxy at \S+ \(pid (\d+)\)/,
  fail: /\[dsh-client\] (manifest registration failed|proxy bootstrap failed|proxy respawn gave up|bili tools still unavailable|(?:explicit )?attach target \S+ unreachable)/,
  direct: /\[native-client\].*model request goes direct|\[dsh-client\] proxy respawn gave up — model traffic goes direct/,
  flush: / received — flushing sessions/,
  anonDsh: /\[prefix-affinity\] new anonymous session (pfa-[0-9a-f]+).*ua="deepseek-harness/,
  pluginReq: /\[sess=session-[^\]]+\] \[v=[^\]]+\] \[session-[^\]]+\] request: \d+ msgs/,
  llmStream: /\[dsh-client\] bili-native-dsh: llm\/stream attribution active/,
  // 带会话头、但这份请求的工具表里没有 compress（代理只在这种时候打 surface=off(...)）：这一步是在工具登记之前开始的，
  // 模型照历史调 acp_status 会得 UNKNOWN_TOOL。只做事后的提醒。
  surfaceOff: /\[sess=session-[^\]]+\].* nudge [^:]*:.*surface=off\((?:no-tools|top-level=\[[^\]]*\])\)/,
  fetchFailedKind: /manifest registration failed \(([^)]{0,40})\)/,
}
/** 日志行 → {t, kind, ...}；只留判断要用的那几类，正文不留 */
function scan (text, fromMs, untilMs) {
  const ev = []
  let first = null
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 24 || line[4] !== '-' || line[10] !== 'T') continue
    const t = Date.parse(line.slice(0, 23))
    if (!Number.isFinite(t)) continue
    if (first === null) first = t
    if (t < fromMs || (untilMs !== undefined && t > untilMs)) continue
    let m
    if ((m = line.match(RX.listening))) ev.push({ t, kind: 'listening', pid: Number(m[1]), id: m[2] })
    else if ((m = line.match(RX.attach))) ev.push({ t, kind: 'attach', pid: Number(m[1]) })
    else if ((m = line.match(RX.fail))) { const k = line.match(RX.fetchFailedKind); ev.push({ t, kind: 'fail', what: m[1].replace(/ \S+ unreachable$/, ' unreachable').replace(/^attach target unreachable$/, 'attach target unreachable'), cause: k ? k[1] : null }) }
    else if (RX.direct.test(line)) ev.push({ t, kind: 'direct' })
    else if (RX.flush.test(line)) ev.push({ t, kind: 'flush' })
    else if ((m = line.match(RX.anonDsh))) ev.push({ t, kind: 'anonDsh', sid: m[1] })
    else if (RX.pluginReq.test(line)) ev.push({ t, kind: 'pluginReq' })
    else if (RX.surfaceOff.test(line)) ev.push({ t, kind: 'surfaceOff' })
    else if (RX.llmStream.test(line)) ev.push({ t, kind: 'llmStream' })
  }
  return { ev, first }
}
/** 线上的 bili.log 只读拷贝：拷进自己的临时目录再读，读完删 */
function readLiveLog (fromMs) {
  tmpDir = mkdtempSync(join(tmpdir(), 'proxy-ready-'))
  const cur = join(stateDir, 'bili.log')
  const old = join(stateDir, 'bili.log.old')
  if (!existsSync(cur)) return { ev: [], copied: [], first: null }
  const c1 = join(tmpDir, 'bili.log')
  copyFileSync(cur, c1)
  const a = scan(readFileSync(c1, 'utf8'), fromMs)
  const copied = ['bili.log']
  let ev = a.ev
  if ((a.first === null || a.first > fromMs) && existsSync(old)) {
    const c2 = join(tmpDir, 'bili.log.old')
    copyFileSync(old, c2)
    copied.push('bili.log.old')
    ev = scan(readFileSync(c2, 'utf8'), fromMs).ev.concat(ev)
  }
  cleanup()
  return { ev: ev.sort((x, y) => x.t - y.t), copied, first: a.first }
}

// ---------- 唯一的请求：GET /__bili/health ----------
function getHealth (port) {
  return new Promise((done) => {
    const t0 = Date.now()
    let settled = false
    const end = (r) => { if (!settled) { settled = true; done({ ...r, ms: Date.now() - t0 }) } }
    const req = request({ host: '127.0.0.1', port, path: '/__bili/health', method: 'GET', agent: false, headers: { connection: 'close', accept: 'application/json' }, timeout: HEALTH_TIMEOUT_MS }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => { size += c.length; if (size <= 65536) chunks.push(c) })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 不是 JSON */ }
        end({ status: res.statusCode, json })
      })
      res.on('error', (e) => end({ status: res.statusCode, error: e.code ?? 'read-error' }))
    })
    req.on('timeout', () => { req.destroy(); end({ status: null, error: 'timeout' }) })
    req.on('error', (e) => end({ status: null, error: e.code ?? 'error' }))
    req.end()
  })
}
/** health 里只留判断用的字段（upstream、auxProxy 之类不留） */
function healthFact (h) {
  const j = h.json ?? {}
  const wd = j.watchdog ?? {}
  const watchers = Array.isArray(wd.watchers) ? wd.watchers.filter((p) => Number.isInteger(p)) : []
  const parentPid = Number.isInteger(wd.parentPid) ? wd.parentPid : null
  const pidsToCheck = [...new Set([parentPid, ...watchers].filter((p) => p !== null))]
  const aliveWatchers = pidsToCheck.filter((p) => pidInfo(p).alive)
  return {
    status: h.status, error: h.error ?? null, ms: h.ms, ok: j.ok === true, reason: typeof j.reason === 'string' ? j.reason.slice(0, 40) : null,
    pid: Number.isInteger(j.pid) ? j.pid : null, id: typeof j.instanceId === 'string' ? j.instanceId : null,
    startedAt: Number.isFinite(j.startedAt) ? j.startedAt : null, version: typeof j.version === 'string' ? j.version.slice(0, 20) : null, commit: typeof j.commit === 'string' ? j.commit.slice(0, 12) : null,
    armed: wd.armed === true, parentPid, watchers: watchers.length, aliveWatchers: aliveWatchers.length,
  }
}

// ---------- 判 ----------
/** post-start 的判断；health 是 healthFact 的样子（replay 时由日志推出来），reg 是这次能确认的登记（replay 时 null） */
function judgePost ({ health, reg, ev, since, now }) {
  const reasons = []
  const warnings = []
  const facts = { since: localStamp(since), now: localStamp(now) }
  // H
  // 没人答、503 starting 先算「再等等」：真坏了的话（bootstrap 失败、接到死代理上）R 那几条会另外给出 not-ready
  if (health.status !== 200 || !health.ok) reasons.push(health.status === null ? `WAIT: no proxy answers /__bili/health (${health.error ?? 'no answer'})` : (health.status === 503 ? `WAIT: health 503${health.reason ? ' ' + health.reason : ''}` : `health ${health.status}${health.reason ? ' ' + health.reason : ''}`))
  else {
    if (!health.armed) reasons.push('health: watchdog not armed (a daemon proxy, not one this DSH owns)')
    if (health.aliveWatchers === 0) reasons.push('health: none of the watchdog pids is alive')
    if (reg !== null) {
      const live = reg.entries.filter((e) => e.state === 'serving')
      if (!live.some((e) => e.pid === health.pid && e.instanceId === health.id)) reasons.push(`health pid ${health.pid} / id ${shortId(health.id)} does not match a live registry entry`)
      if (live.length > 1) warnings.push(`${live.length} live registry entries on the DSH lane`)
    }
  }
  // F + S
  const after = ev.filter((e) => e.t >= since && e.t <= now)
  const listen = after.filter((e) => e.kind === 'listening' && e.pid === health.pid).pop()
  const attachSame = after.filter((e) => e.kind === 'attach' && e.pid === health.pid).pop()
  const attachOther = after.filter((e) => e.kind === 'attach' && e.pid !== health.pid)
  let landedAt = null
  if (health.status === 200 && health.ok) {
    const fresh = health.startedAt !== null && health.startedAt >= since - SINCE_SLACK_MS
    facts.mode = fresh ? 'spawned' : (attachSame ? 'attached' : 'older')
    if (fresh) {
      if (listen) landedAt = listen.t
      else reasons.push('WAIT: proxy started after the DSH start but its listening line is not in the log yet')
    } else if (attachSame) landedAt = attachSame.t
    else reasons.push(`proxy predates this DSH start (started ${health.startedAt !== null ? localStamp(health.startedAt) : '?'}) and the new host never logged attaching to it`)
  }
  if (landedAt !== null) {
    facts.landedAt = localStamp(landedAt)
    const waited = now - landedAt
    facts.settledMs = waited
    if (waited < SETTLE_MS) reasons.push(`WAIT: proxy landed ${Math.round(waited / 1000)} s ago, need ${Math.round(SETTLE_MS / 1000)} s with no registration failure`)
  }
  // R
  const fails = after.filter((e) => e.kind === 'fail' || e.kind === 'direct')
  const pluginReqs = after.filter((e) => e.kind === 'pluginReq')
  const anon = after.filter((e) => e.kind === 'anonDsh')
  const lastBad = [...fails, ...attachOther, ...anon].sort((x, y) => x.t - y.t).pop()
  const recovered = lastBad !== undefined && pluginReqs.some((e) => e.t > lastBad.t)
  facts.log = {
    listening: after.filter((e) => e.kind === 'listening').map((e) => `${localStamp(e.t).slice(11)} pid ${e.pid}`),
    attach: after.filter((e) => e.kind === 'attach').map((e) => `${localStamp(e.t).slice(11)} pid ${e.pid}`),
    failures: fails.map((e) => `${localStamp(e.t).slice(11)} ${e.what ?? 'direct'}${e.cause ? ' (' + e.cause + ')' : ''}`),
    anonymousDsh: anon.map((e) => localStamp(e.t).slice(11)),
    firstLlmStream: (after.find((e) => e.kind === 'llmStream') ?? null) && localStamp(after.find((e) => e.kind === 'llmStream').t).slice(11),
    pluginRequests: pluginReqs.length,
    firstPluginRequest: pluginReqs.length > 0 ? localStamp(pluginReqs[0].t).slice(11) : null,
  }
  if (lastBad !== undefined) {
    const what = []
    if (attachOther.length > 0) what.push(`this start's host attached to pid ${[...new Set(attachOther.map((e) => e.pid))].join(',')}, which is not the proxy answering now`)
    if (fails.length > 0) what.push(`${fails.length} client failure line(s) since the start (last ${localStamp(fails[fails.length - 1].t).slice(11)}: ${fails[fails.length - 1].what ?? 'direct'})`)
    if (anon.length > 0) what.push(`${anon.length} DSH request(s) already went anonymous (wire mode)`)
    if (recovered) warnings.push('degraded earlier, recovered: ' + what.join('; ') + ` — plugin-mode requests seen after it (${pluginReqs.length})`)
    else reasons.push('registration not proven: ' + what.join('; ') + ' — no plugin-mode request after it (tool registration succeeds silently, so only a restart or a request proves it)')
  }
  const surfaceOff = after.filter((e) => e.kind === 'surfaceOff')
  facts.log.toolTableWithoutBili = surfaceOff.map((e) => localStamp(e.t).slice(11))
  if (surfaceOff.length > 0) warnings.push(`${surfaceOff.length} plugin-mode request(s) whose tool table had no compress tool (surface=off; first ${localStamp(surfaceOff[0].t).slice(11)}): that step began before the bili tools were registered, a call to acp_status there fails as UNKNOWN_TOOL`)
  const onlyWait = reasons.length > 0 && reasons.every((r) => r.startsWith('WAIT:'))
  const verdict = reasons.length === 0 ? 'ready' : (onlyWait ? 'wait' : 'not-ready')
  return { verdict, ready: verdict === 'ready', reasons, warnings, facts }
}

/** pre-start 的判断：DSH 车道上还有活着的代理登记就没走完 */
function judgePre (entries) {
  const reasons = []
  const warnings = []
  const live = entries.filter((e) => e.state !== 'gone')
  for (const e of live) {
    if (e.state === 'serving') reasons.push(`old proxy pid ${e.pid} still serving${e.image ? ' (' + e.image + ')' : ''}: a host started now could attach to it while it is about to shut down`)
    else reasons.push(`old proxy pid ${e.pid} draining since ${localStamp(e.portReleasedAt).slice(11)} (port released, still flushing)`)
    if (e.image !== null && !/node|deepseek/i.test(e.image)) warnings.push(`pid ${e.pid} runs ${e.image}: maybe a reused pid behind a stale registry file`)
  }
  const stale = entries.filter((e) => e.state === 'gone').length
  if (stale > 0) warnings.push(`${stale} stale registry record(s) with a dead pid (ignored)`)
  return { verdict: reasons.length === 0 ? 'ready' : 'not-ready', ready: reasons.length === 0, reasons, warnings }
}

// ---------- replay：从日志推出某个时刻的 health ----------
function replayHealth (ev, at) {
  const upTo = ev.filter((e) => e.t <= at)
  const lastListen = upTo.filter((e) => e.kind === 'listening').pop()
  if (!lastListen) return { status: null, error: 'no proxy in the log', ok: false }
  const flushed = upTo.some((e) => e.kind === 'flush' && e.t > lastListen.t)
  if (flushed) return { status: null, error: 'ECONNREFUSED (inferred: last proxy began shutting down)', ok: false, lastPid: lastListen.pid }
  // 日志里看不到 watcher 名单：当作 armed、有活着的 watcher（复盘时这两条一般不是判断的关键）
  return { status: 200, ok: true, pid: lastListen.pid, id: lastListen.id, startedAt: lastListen.t - 500, armed: true, aliveWatchers: 1, watchers: 1, parentPid: null, inferred: true }
}

// ---------- main ----------
async function main () {
  if (phaseArg === 'pre-start') {
    const port = zonePort()
    const reg = registry(port)
    const r = judgePre(reg.entries)
    finish({ ...r, facts: { port, stateDir: '<billion-context state>', entries: reg.entries.map(entryFact), unreadable: reg.unreadable } }, r.ready ? 0 : 1)
    return
  }
  if (phaseArg === 'post-start') {
    const since = toMs(opt.since, '--since')
    if (since === undefined) usage('post-start 要给 --since（起 DSH 的时刻）')
    const port = zonePort()
    const reg = registry(port)
    const h = healthFact(await getHealth(port))
    let logInfo
    try { logInfo = readLiveLog(since - 60000) } catch (e) { finish({ verdict: 'error', ready: false, reasons: ['bili.log could not be copied/read: ' + (e?.code ?? e?.message ?? e)], warnings: [], facts: {} }, 2); return }
    const now = Date.now()
    const r = judgePost({ health: h, reg, ev: logInfo.ev, since, now })
    r.facts = { port, health: { ...h, id: shortId(h.id), startedAt: h.startedAt !== null ? localStamp(h.startedAt) : null }, registry: reg.entries.map(entryFact), logCopied: logInfo.copied, ...r.facts }
    finish(r, r.ready ? 0 : 1)
    return
  }
  // replay
  if (opt.logs.length === 0) usage('replay 要给 --log')
  const since = toMs(opt.since, '--since')
  const at = toMs(opt.at, '--at')
  if (since === undefined || at === undefined) usage('replay 要给 --since 和 --at')
  let ev = []
  for (const f of opt.logs) {
    try { if (!statSync(f).isFile()) throw new Error('not a file') } catch (e) { finish({ verdict: 'error', ready: false, reasons: [`--log ${f}: ${e.code ?? e.message}`], warnings: [], facts: {} }, 2); return }
    ev = ev.concat(scan(readFileSync(f, 'utf8'), 0, at).ev)
  }
  ev.sort((x, y) => x.t - y.t)
  const phase = opt.phase ?? 'post-start'
  if (phase === 'pre-start') {
    const h = replayHealth(ev, at)
    const lastListen = ev.filter((e) => e.t <= at && e.kind === 'listening').pop()
    const entries = lastListen ? [{ pid: lastListen.pid, instanceId: lastListen.id, state: h.status === 200 ? 'serving' : 'draining', image: null, from: ['log'] }] : []
    const r = judgePre(entries.filter((e) => e.state === 'serving'))
    if (h.status !== 200 && lastListen) r.warnings.push(`pid ${lastListen.pid} began shutting down before ${localStamp(at).slice(11)}; the log does not show when it exited (files mode waits for its registry entry to vanish)`)
    finish({ ...r, facts: { at: localStamp(at), inferredFromLog: true } }, r.ready ? 0 : 1)
    return
  }
  if (phase !== 'post-start') usage('--phase 只认 pre-start 或 post-start')
  const h = replayHealth(ev, at)
  const r = judgePost({ health: h, reg: null, ev, since, now: at })
  r.facts = { health: { status: h.status, error: h.error ?? null, pid: h.pid ?? null, startedAt: h.startedAt ? localStamp(h.startedAt) : null, inferredFromLog: true }, ...r.facts }
  finish(r, r.ready ? 0 : 1)
}

main().catch((e) => finish({ verdict: 'error', ready: false, reasons: [String(e?.message ?? e).slice(0, 200)], warnings: [], facts: {} }, 2)).finally(() => clearTimeout(deadline))
