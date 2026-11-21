// 在别的脚本里起转发器（冒烟、以后的执行器都用这一个）：按配置算出网名单，带 egress-guard 预加载起 forwarder.mjs，
// 等第一行 {ready:true,…}，读控制口令。回 { port, url, token, stateDir, fingerprintId, child, stop() }。
//   - extraImports / extraRequires：再挂的守卫（no-live-port、no-live-fs…）。offline-guard 只许在 testMode / offline 时挂
//     （它把 fetch 收成只放回环，正式跑时会挡住转发器自己的出网）——这里替调用方核一遍。
//   - 子进程的 stdout / stderr 落到 <stateDir>/forwarder.stdout.log（转发器不打印 key；这里也不往控制台转）。
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expectedAllow, loadConfig } from './config.mjs'
import { assertPortAllowed } from './util.mjs'

const FWD = resolve(fileURLToPath(new URL('..', import.meta.url)))

export async function startForwarder (cfgFile, { extraImports = [], extraRequires = [], env = process.env, readyTimeoutMs = 60_000 } = {}) {
  const cfg = loadConfig(cfgFile)
  const allow = expectedAllow(cfg)
  if (allow.length && extraImports.some((p) => /offline-guard/i.test(String(p)))) throw new Error('offline-guard would block the forwarder\'s own egress (only for testMode/offline)')
  const args = [
    ...extraRequires.flatMap((p) => ['--require', p]),
    ...extraImports.flatMap((p) => ['--import', pathToFileURL(p).href]),
    '--import', pathToFileURL(join(FWD, 'lib', 'egress-guard.mjs')).href,
    join(FWD, 'forwarder.mjs'), '--config', resolve(cfgFile),
  ]
  const childEnv = { ...env, FWD_EGRESS_ALLOW: allow.join(','), FWD_EGRESS_LOG: join(cfg.stateDir, 'egress.log') }
  const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log = createWriteStream(join(cfg.stateDir, 'forwarder.stdout.log'), { flags: 'a' })
  let first = ''
  let errTail = ''
  child.stderr.on('data', (c) => { errTail = (errTail + c).slice(-4000); log.write(c) })
  const ready = await new Promise((res, rej) => {
    const timer = setTimeout(() => { child.kill(); rej(new Error(`forwarder not ready: ${errTail.slice(-600)}`)) }, readyTimeoutMs)
    const onExit = (code) => { clearTimeout(timer); rej(Object.assign(new Error(`forwarder exited ${code}: ${errTail.slice(-600)}`), { exitCode: code })) }
    child.once('exit', onExit)
    child.stdout.on('data', function onData (c) {
      log.write(c)
      if (first === null) return
      first += c
      const nl = first.indexOf('\n')
      if (nl < 0) return
      const line = first.slice(0, nl)
      first = null
      clearTimeout(timer)
      child.off('exit', onExit)
      try { res(JSON.parse(line)) } catch (e) { rej(e) }
    })
  })
  if (!ready.ready) throw new Error('forwarder did not report ready')
  assertPortAllowed(ready.port)
  const token = readFileSync(join(cfg.stateDir, 'control-token'), 'utf8').trim()
  // 被 kill 掉的子进程 exitCode 是 null、signalCode 有值：两样都要看，不然第二次 stop() 会一直等一个不会再来的 exit
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const stop = () => new Promise((d) => { if (exited()) return d(child.exitCode ?? child.signalCode); child.once('exit', (c, s) => d(c ?? s)); child.kill() })
  // CONNECT 入口要 Proxy-Authorization（复核 A6）：带口令的网址只给要走 CONNECT 的那一个调用方，别落盘、别打印
  const connectUrl = ready.connectDoor === false ? null : `http://fwd:${encodeURIComponent(token)}@127.0.0.1:${ready.port}`
  return { ...ready, url: `http://127.0.0.1:${ready.port}`, connectUrl, token, stateDir: cfg.stateDir, cfg, allow, child, stop }
}

/** 控制口（只回环）。token 为 null 时只许 /__fwd/health。 */
export async function fwdControl (fw, method, path, body) {
  const headers = { ...(path === '/__fwd/health' ? {} : { 'x-fwd-token': fw.token }), ...(body ? { 'content-type': 'application/json' } : {}) }
  const r = await fetch(fw.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => null) }
}
