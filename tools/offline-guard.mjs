// 预加载：把全局 fetch 换成只放行回环地址的版本。别的地址不发出去，记一行然后抛错。
// 用法：node --import ./tools/offline-guard.mjs <脚本>（Windows 上写成 file:/// 网址）；OFFLINE_GUARD_LOG=<文件> 时把拦下的记进去。
// 只管全局 fetch；node:http、套接字直连、DNS 另挂 netguard.mjs。
import { appendFileSync } from 'node:fs'
const real = globalThis.fetch
const LOG = process.env.OFFLINE_GUARD_LOG
globalThis.fetch = async function offlineGuardFetch(input, init) {
  let host = '', path = ''
  try { const u = new URL(typeof input === 'string' ? input : (input?.url ?? String(input))); host = u.hostname; path = u.pathname } catch {}
  if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return real(input, init)
  // 调用栈里只留文件名和行列：日志里不写本机的目录（目录里常带用户名）
  try { appendFileSync(LOG, JSON.stringify({ host, path, file: String(process.argv[1] ?? '').replace(/^.*[\\/]/, ''), stack: String(new Error().stack).split('\n').slice(2, 9).map((s) => s.trim().replace(/(?:file:\/\/\/?)?(?:[A-Za-z]:)?[^\s()]*[\\/]([^\\/\s()]+:\d+:\d+)/g, '$1')) }) + '\n') } catch {}
  throw new TypeError('offline guard: real network blocked')
}
