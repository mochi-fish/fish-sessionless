// --import 预载：本进程碰线上的根就当场抛 EACCES，并记一行（OB_NO_LIVE_FS_LOG）。
//   OB_NO_LIVE_FS=write（默认）：只拦写（写、追加、建、删、改名、拷到、截断、改时间、按写方式打开）；
//   OB_NO_LIVE_FS=all：读也拦（读文件、列目录、按读方式打开、读流）。代理拷贝、假上游用 all；执行器用 write
//   （执行器要在 prepareCache 里拷一次线上的配置文件；她的数据只许拷、不许改）。
// 线上的根按 os.userInfo().homedir 算（换掉 HOME / USERPROFILE 也算得对），和 lib/isolation.mjs 的 liveRoots 同一张表。
// stat / exists 不拦（不打开文件；SQLite 的 -shm 那件事是「打开」才会动）。node:sqlite 走原生代码，这里拦不到：
// 架子里只对拷贝开 SQLite，这条靠代码审，不靠这个守卫。
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODE = process.env.OB_NO_LIVE_FS === 'all' ? 'all' : 'write'
const LOG = process.env.OB_NO_LIVE_FS_LOG || null
const home = os.userInfo().homedir
const win = process.platform === 'win32'
const norm = (p) => {
  let s = String(p)
  if (win) s = s.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '')
  s = path.resolve(s)
  if (win) s = s.replace(/\//g, '\\').toLowerCase()
  while (s.length > 3 && s.endsWith(path.sep)) s = s.slice(0, -1)
  return s
}
// 复核 B2（11-19）：加 ~/.dsh-fish-homes.json；~/.dsh-watch-* 按前缀认（起来以后才建的也算）；
// 字符串比不中的，再对「存在的那一层」取 realpath 比一次（防目录联接 / 符号链接绕过去）——只在家目录所在的盘上取，
// 别的盘（网络盘、SSHFS）不取，免得掉线时卡住。
const roots = [
  '.dsh', '.dsh-fish', '.dsh-fish-ledger', '.dsh-fish-location.json', '.dsh-fish-homes.json', '.nowledge', '.nmem',
  path.join('.config', 'billion-context'), path.join('.local', 'share', 'billion-context'),
  path.join('.local', 'state', 'billion-context'), path.join('.cache', 'billion-context'),
].map((r) => norm(path.join(home, r)))
try { for (const n of fs.readdirSync(home)) if (/^\.dsh-watch-/i.test(n)) roots.push(norm(path.join(home, n))) } catch { /* */ }
const homeN = norm(home)
const realNative = fs.realpathSync.native
const existsS = fs.existsSync
// 存在的根自己也取一次 realpath（根本身是联接时，指到的地方也算线上）
const realRoots = []
for (const r of roots) { try { if (existsS(r)) { const rr = norm(realNative(r)); if (rr !== r) realRoots.push(rr) } } catch { /* */ } }
const sameDrive = (n) => !win || n.slice(0, 2) === homeN.slice(0, 2)

const origAppend = fs.appendFileSync.bind(fs)
function asPath (p) {
  if (typeof p === 'number') return null
  if (p instanceof URL) return fileURLToPath(p)
  if (Buffer.isBuffer(p)) return p.toString('utf8')
  if (typeof p === 'string') return p
  return null
}
function hitRoots (n) {
  if (roots.some((r) => n === r || n.startsWith(r + path.sep))) return true
  if (realRoots.some((r) => n === r || n.startsWith(r + path.sep))) return true
  // ~/.dsh-watch-<名字>（按前缀）
  if (n.startsWith(homeN + path.sep) && /^\.dsh-watch-/i.test(n.slice(homeN.length + 1))) return true
  return false
}
const lstatS = fs.lstatSync
// 作用在目录项本身的操作（删链、改名、读链、建链的那一头）：最后一层是链接 / 联接时不顺着它走，
// 只看它所在的那一层（删一个指进线上根的联接不碰线上根；以前顺着走，把实验目录里的联接也拦住了，删不掉）
const ENTRY_OPS = new Set(['unlink', 'rmdir', 'rm', 'rename', 'readlink', 'lutimes', 'symlink', 'link'])
function isLive (p, entry = false) {
  const s = asPath(p)
  if (s === null || s === '') return false
  const n = norm(s)
  if (hitRoots(n)) return true
  if (!sameDrive(n)) return false
  if (entry) {
    let isLink = false
    try { isLink = lstatS(n).isSymbolicLink() } catch { /* 不存在 */ }
    if (isLink) {
      const parent = path.dirname(n)
      if (parent === n) return false
      try { return hitRoots(norm(path.join(existsS(parent) ? realNative(parent) : parent, path.basename(n)))) } catch { return false }
    }
  }
  // 存在的那一层取 realpath 再比
  let cur = n
  try {
    while (!existsS(cur)) { const up = path.dirname(cur); if (up === cur) return false; cur = up }
    const rp = norm(realNative(cur))
    if (rp === cur) return false
    const rest = n.slice(cur.length)
    return hitRoots(norm(rp + rest))
  } catch { return false }
}
function deny (op, p) {
  const rec = { at: new Date().toISOString(), pid: process.pid, op, path: String(asPath(p)).slice(0, 300) }
  if (LOG) { try { origAppend(LOG, JSON.stringify(rec) + '\n') } catch { /* */ } }
  const e = new Error(`open-book no-live-fs: ${op} on a live root is refused`)
  e.code = 'EACCES'
  return e
}
const writeFlag = (f) => {
  if (f === undefined || f === null) return false
  if (typeof f === 'number') return (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0
  return /[wa+]/.test(String(f))
}

// [名字, 哪几个参数是路径, 'w' 写 / 'r' 读 / 'o' 看 flags]
const SPECS = [
  ['writeFile', [0], 'w'], ['appendFile', [0], 'w'], ['mkdir', [0], 'w'], ['rm', [0], 'w'], ['rmdir', [0], 'w'], ['unlink', [0], 'w'],
  ['rename', [0, 1], 'w'], ['copyFile', [1], 'w'], ['cp', [1], 'w'], ['truncate', [0], 'w'], ['utimes', [0], 'w'], ['chmod', [0], 'w'],
  ['symlink', [1], 'w'], ['link', [1], 'w'], ['mkdtemp', [0], 'w'], ['lutimes', [0], 'w'],
  ['readFile', [0], 'r'], ['readdir', [0], 'r'], ['opendir', [0], 'r'], ['readlink', [0], 'r'],
  ['open', [0], 'o'],
]
const SRC_READ = new Set(['copyFile', 'cp'])

function check (name, kind, idxs, args) {
  for (const i of idxs) {
    const p = args[i]
    if (!isLive(p, ENTRY_OPS.has(name.replace(/Sync$/, '')))) continue
    if (kind === 'w') throw deny(name, p)
    if (kind === 'r' && MODE === 'all') throw deny(name, p)
    if (kind === 'o') {
      const flags = args[1]
      if (writeFlag(flags)) throw deny(name + '(write)', p)
      if (MODE === 'all') throw deny(name + '(read)', p)
    }
  }
  if (MODE === 'all' && SRC_READ.has(name) && isLive(args[0])) throw deny(name + '(src)', args[0])
}

function wrap (obj, name, idxs, kind, style) {
  const orig = obj[name]
  if (typeof orig !== 'function') return
  const wrapped = function (...args) {
    try { check(name, kind, idxs, args) } catch (e) {
      if (style === 'cb') { const cb = args.findLast((a) => typeof a === 'function'); if (cb) { process.nextTick(cb, e); return } }
      if (style === 'promise') return Promise.reject(e)
      throw e
    }
    return orig.apply(this, args)
  }
  Object.defineProperty(wrapped, 'name', { value: orig.name })
  obj[name] = wrapped
}

for (const [name, idxs, kind] of SPECS) {
  wrap(fs, name + 'Sync', idxs, kind, 'sync')
  wrap(fs, name, idxs, kind, 'cb')
  wrap(fs.promises, name, idxs, kind, 'promise')
}
// 流
const origWS = fs.createWriteStream
fs.createWriteStream = function (p, ...rest) { if (isLive(p)) throw deny('createWriteStream', p); return origWS.call(this, p, ...rest) }
const origRS = fs.createReadStream
fs.createReadStream = function (p, ...rest) { if (MODE === 'all' && isLive(p)) throw deny('createReadStream', p); return origRS.call(this, p, ...rest) }
syncBuiltinESMExports()
