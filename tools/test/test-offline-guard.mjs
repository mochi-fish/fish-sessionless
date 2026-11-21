// tools/offline-guard.mjs 的测试：全局 fetch 只放行回环；别的地址不发、记一行、抛错；日志里不带本机目录。
// 用法：node tools/test/test-offline-guard.mjs        （看 PASS / FAIL 行，有失败退 1）
// 非回环用文档专用的 192.0.2.1 和保留域名 example.invalid：挡板在发出去之前就拦下。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OG = resolve(HERE, '..', 'offline-guard.mjs')
const T = mkdtempSync(join(tmpdir(), 'offline-guard-test-'))

let pass = 0
let fail = 0
const check = (id, ok, what, detail = '') => {
  if (ok) pass += 1; else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}) ${what}${detail ? ` (${detail})` : ''}`)
}

const CHILD = String.raw`
import http from 'node:http'
import { once } from 'node:events'
const out = { name: globalThis.fetch.name }
const srv = http.createServer((q, r) => r.end('ok'))
srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
const P = srv.address().port
const tryFetch = (u) => fetch(u).then(async (r) => ({ ok: true, status: r.status, body: await r.text() }), (e) => ({ ok: false, name: e.name, msg: String(e.message).slice(0, 120) }))
out.loop = await tryFetch('http://127.0.0.1:' + P + '/')
out.localhost = await tryFetch('http://localhost:' + P + '/')
out.ip = await tryFetch('http://192.0.2.1/x')
out.host = await tryFetch(new URL('https://example.invalid/path?q=1'))
out.req = await tryFetch(new Request('https://example.invalid/req'))
srv.close()
console.log(JSON.stringify(out))
`
const childFile = join(T, 'child.mjs')
writeFileSync(childFile, CHILD)
const env = { ...process.env }
for (const k of ['NODE_OPTIONS', 'OFFLINE_GUARD_LOG', 'NETGUARD_LOG']) delete env[k]

try {
  const log = join(T, 'og.log')
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(OG).href, childFile], { env: { ...env, OFFLINE_GUARD_LOG: log }, encoding: 'utf8', timeout: 60_000 })
  let j = null
  try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { /* 下面看 */ }
  check('1', r.status === 0 && j !== null, '子进程正常退出', `status ${r.status} ${String(r.stderr).slice(0, 200)}`)
  check('2', j?.name === 'offlineGuardFetch', '全局 fetch 被换掉了')
  check('3', j?.loop?.ok === true && j.loop.body === 'ok' && j?.localhost?.ok === true, '回环（127.0.0.1、localhost）照常通')
  check('4', [j?.ip, j?.host, j?.req].every((x) => x && x.ok === false && x.name === 'TypeError' && /offline guard/.test(x.msg)), '非回环（IP、URL 对象、Request 对象）都抛 TypeError', JSON.stringify([j?.ip, j?.host, j?.req]))
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  check('5', lines.length === 3 && JSON.stringify(lines.map((l) => [l.host, l.path])) === JSON.stringify([['192.0.2.1', '/x'], ['example.invalid', '/path'], ['example.invalid', '/req']]), '每次拦下记一行（主机、路径，不带查询串）', JSON.stringify(lines.map((l) => l.host)))
  const tdir = T.replace(/\\/g, '/')
  check('6', lines.every((l) => l.file === 'child.mjs' && !JSON.stringify(l).includes(tdir) && !JSON.stringify(l).includes(T.replace(/\\/g, '\\\\'))), '日志里只有文件名，没有本机目录')
  check('7', lines.every((l) => Array.isArray(l.stack) && l.stack.some((s) => /child\.mjs:\d+:\d+/.test(s))), '调用栈留着文件名和行列')

  // 没设 OFFLINE_GUARD_LOG：照样拦，不报别的错
  const r2 = spawnSync(process.execPath, ['--import', pathToFileURL(OG).href, childFile], { env, encoding: 'utf8', timeout: 60_000 })
  let j2 = null
  try { j2 = JSON.parse(String(r2.stdout).trim().split('\n').pop()) } catch { /* */ }
  check('8', r2.status === 0 && j2?.ip?.ok === false && j2?.loop?.ok === true, '没设日志文件：照样拦、照样放回环')
} finally {
  try { rmSync(T, { recursive: true, force: true }) } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
