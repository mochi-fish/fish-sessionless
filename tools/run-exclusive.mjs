// 让重的测试排队跑：同一个名字同一时间最多 N 套（默认 2），别的等着。几套全量测试同时跑、每套又开很多并发，很容易把整台机器的 CPU 打满。
// 用法：node tools/run-exclusive.mjs <名字> [--slots N] -- <命令> [参数…]
//   例：node tools/run-exclusive.mjs suite -- node --test --test-concurrency=4 "tests/**/*.test.mjs"
// 环境变量原样传给命令（挡板的 NODE_OPTIONS、假家目录都照设），stdio 直通，退出码照传。
// 三道：
//   1. 锁：锁目录下的 <名字>-<k>.lock 目录（mkdir 是原子的），里面写 owner.json（pid、开始时间、命令）。
//      锁目录缺省在本脚本旁边的 .locks/。只有 owner.json 里的进程确实不在了、或者锁没有 owner.json 已经超过 5 分钟、
//      或者锁超过 3 小时，才算死锁删掉。
//   2. 数：拿到锁之前还要数整台机器上正在跑的整套测试（node 命令行里有「 --test 」且不是本工具的），已经有 N 套就接着等
//      （有人没经过本工具直接跑全套时也拦得住后来的）。Windows 用 PowerShell 的 CIM 数，别的系统用 ps 数；数不出来时
//      Windows 上当作已满（宁可多等），别的系统当作 0（只靠锁）。
//   3. 优先级：本进程和起的命令都用最低优先级（Windows 上是 Idle，子进程继承），CPU 只用别人不用的那部分。
//   命令里有 --test-concurrency=K 且 K>4 的，改成 4。
// 环境变量（都可以不设）：
//   RUN_EXCLUSIVE_LOCK_DIR  锁目录。缺省跟着本脚本走，不跟 TEMP / HOME：测试常把 TEMP、HOME 指到假目录再起本工具，
//                           跟着它们走的话每个人各排各的队。要改就让所有人设成同一个值。
//   RUN_EXCLUSIVE_POLL_MS   等的时候隔多久再看一次（缺省 15000，另加最多 5 秒的随机数），只给测试调小用。
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setPriority, constants } from 'node:os'

const argv = process.argv.slice(2)
const dd = argv.indexOf('--')
if (dd < 1 || dd === argv.length - 1) { console.error('usage: run-exclusive.mjs <name> [--slots N] -- <command> [args…]'); process.exit(2) }
const head = argv.slice(0, dd)
const cmd = argv.slice(dd + 1).map((a) => a.replace(/^--test-concurrency=(\d+)$/, (m, k) => (Number(k) > 4 ? '--test-concurrency=4' : m)))
const name = head[0]
if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { console.error('bad lock name'); process.exit(2) }
const si = head.indexOf('--slots')
const slots = si >= 0 ? Math.max(1, Math.min(4, Number(head[si + 1]) || 2)) : 2
const dir = process.env.RUN_EXCLUSIVE_LOCK_DIR ? resolve(process.env.RUN_EXCLUSIVE_LOCK_DIR) : join(dirname(fileURLToPath(import.meta.url)), '.locks')
mkdirSync(dir, { recursive: true })
const LOCK_MAX_MS = 3 * 60 * 60 * 1000
const NO_OWNER_MS = 5 * 60 * 1000
const POLL_MS = Number(process.env.RUN_EXCLUSIVE_POLL_MS) > 0 ? Number(process.env.RUN_EXCLUSIVE_POLL_MS) : 15000
try { setPriority(constants.priority.PRIORITY_LOW) } catch { /* 不行就算了 */ }

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** 整台机器上正在跑的整套测试（node --test 的总进程）有几套。 */
const runningSuites = () => {
  if (process.platform === 'win32') {
    const ps = "$n = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match ' --test( |$)' -and $_.CommandLine -notmatch 'run-exclusive' }).Count; Write-Output $n"
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const n = Number(String(r.stdout ?? '').trim())
    return Number.isFinite(n) && r.status === 0 ? n : Infinity
  }
  const r = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 30000 })
  if (r.status !== 0) return 0
  return String(r.stdout ?? '').split('\n').filter((l) => /(^|[\\/])node(\.exe)?\s/.test(l) && / --test( |$)/.test(l) && !/run-exclusive/.test(l)).length
}

const tryTake = () => {
  for (let k = 1; k <= slots; k++) {
    const lock = join(dir, `${name}-${k}.lock`)
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), cmd: cmd.join(' ').slice(0, 300) }))
      return lock
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let owner = null
      try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) } catch { /* 刚建、还没写 */ }
      let age = 0
      try { age = Date.now() - statSync(lock).mtimeMs } catch { continue }
      const dead = owner && Number.isInteger(owner.pid) ? !alive(owner.pid) : age > NO_OWNER_MS
      if (dead || age > LOCK_MAX_MS) { try { rmSync(lock, { recursive: true, force: true }) } catch { /* 别人在删 */ } }
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
let lock = null
for (;;) {
  const n = runningSuites()
  if (n < slots) {
    lock = tryTake()
    if (lock) {
      // 拿到锁以后再数一次：两个人同时数到 n<slots 时，后到的放回去接着等
      const again = runningSuites()
      if (again < slots) break
      try { rmSync(lock, { recursive: true, force: true }) } catch { /* */ }
      lock = null
    }
  }
  console.error(`[run-exclusive] ${name}: busy (${n === Infinity ? '?' : n} suites running, ${slots} allowed), waiting (${Math.round((Date.now() - t0) / 1000)}s)`)
  await sleep(POLL_MS + Math.floor(Math.random() * Math.min(5000, POLL_MS / 3)))
}
console.error(`[run-exclusive] ${name}: got ${lock.split(/[\\/]/).at(-1)} after ${Math.round((Date.now() - t0) / 1000)}s`)
const release = () => { try { rmSync(lock, { recursive: true, force: true }) } catch { /* ignore */ } }
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env, shell: false, windowsHide: true })
try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_LOW) } catch { /* 继承了也行 */ }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill() } catch { /* */ } release(); process.exit(130) })
child.on('error', (e) => { console.error('[run-exclusive] spawn failed:', e.message); release(); process.exit(127) })
child.on('exit', (code, signal) => { release(); process.exit(code ?? (signal ? 1 : 0)) })
