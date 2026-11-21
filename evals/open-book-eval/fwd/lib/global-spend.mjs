// 全局花费（复核 A4，11-19）：用户批的是「这一家一共花多少」，不是「这一次跑花多少」。
// 把实验总目录下所有 open-book-* 里的转发器账本（任何深度的 spend-ledger.jsonl，旁边要有 fingerprint.json）都只读地扫一遍，
// testMode / offline 的（假上游、离线重放）不算；同一家、真出网的转发器记下的「已结 + 未结预留」加起来就是已花。
// 只读：不补孤儿行（SpendLedger readOnly），孤儿预留按整份预留算。
// 另有一把付费锁（<实验总目录>/paid-run.lock）：同一时刻只许一个付费跑，进程死了锁自动作废（pid 不在）。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SpendLedger } from './spend-ledger.mjs'

const round6 = (x) => Math.round(x * 1e6) / 1e6
const norm = (p) => resolve(String(p)).toLowerCase()

/** 找 root 下面所有的 fwd-state（有 spend-ledger.jsonl 或 fingerprint.json 的目录），最深 maxDepth 层。 */
export function findStateDirs (root, maxDepth = 8) {
  const out = []
  const walk = (d, depth) => {
    let names
    try { names = readdirSync(d) } catch { return }
    if (names.includes('spend-ledger.jsonl') && names.includes('fingerprint.json')) { out.push(d); return }
    if (depth >= maxDepth) return
    for (const n of names) {
      if (n === 'cache' || n === 'wire' || n === 'node_modules' || n === 'home' || n === 'fish-home') continue
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** 一个 fwd-state 是不是「真出网、这一家」的账。 */
export function stateDirInfo (sd) {
  try {
    const fp = JSON.parse(readFileSync(join(sd, 'fingerprint.json'), 'utf8'))
    const f = fp.fingerprint ?? fp
    const provider = f.route?.provider ?? f.target?.provider ?? null
    const fw = f.forwarder ?? {}
    return { provider, paid: fw.testMode !== true && fw.offline !== true, id: fp.id ?? null }
  } catch { return { provider: null, paid: true, id: null, unreadable: true } }
}

/**
 * experimentsDir 下所有 open-book-* 里这一家已经花的（真出网的转发器）。exceptStateDirs 里的不算（正在起的那个自己的账）。
 * → { total, byDir: [{ dir, committed }], unreadable }
 */
export function globalSpend (experimentsDir, provider, { exceptStateDirs = [] } = {}) {
  const skip = new Set(exceptStateDirs.map(norm))
  let total = 0
  const byDir = []
  let unreadable = 0
  if (!existsSync(experimentsDir)) return { total: 0, byDir, unreadable }
  for (const n of readdirSync(experimentsDir)) {
    if (!/^open-book-/.test(n)) continue
    for (const sd of findStateDirs(join(experimentsDir, n))) {
      if (skip.has(norm(sd))) continue
      const info = stateDirInfo(sd)
      if (info.unreadable) unreadable++
      // 认不出是哪家的（指纹坏了）按「可能是这一家」算进去：只会多算，不会少算
      if (!info.paid || (info.provider !== null && info.provider !== provider)) continue
      const L = new SpendLedger({ dir: sd, caps: {}, readOnly: true })
      const c = L.committed(provider)
      if (c > 0) byDir.push({ dir: sd, committed: c })
      total += c
    }
  }
  return { total: round6(total), byDir, unreadable }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** 付费锁：拿到回 release()；别人拿着（pid 还活着）就抛。 */
export function acquirePaidLock (experimentsDir, owner, name = 'paid-run.lock') {
  const f = join(experimentsDir, name)
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() }) + '\n')
      closeSync(fd)
      return () => { try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.pid === process.pid) unlinkSync(f) } catch { /* */ } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let j = null
      try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { /* 坏的锁当作死锁 */ }
      if (j && Number.isInteger(j.pid) && alive(j.pid) && j.pid !== process.pid) throw new Error(`另一个跑（${name}）正在进行（pid ${j.pid}，${j.owner ?? ''}）：同一时刻只许一个`)
      try { unlinkSync(f) } catch { /* */ }
    }
  }
  throw new Error('拿不到付费锁')
}

// ---------- 自建推理机的锁 ----------
// scarletkc 跑在一台自建的推理机上：同一时刻最多一个请求在路上，所以两臂 scarletkc 不能叠着跑。
// run-exclusive 的 open-book-eval 锁本来也是一次一个，但它的锁超过 3 小时就当陈旧删掉（不管拿锁的进程还在不在）——一臂在推理机上
// 可能跑得比 3 小时长，那时第二个 ob 进程就会进来。这把锁不按年纪过期，只看拿锁的进程还在不在；pid 被别的进程复用时，
// 靠它的命令行里有没有 open-book-eval 认出来（查不到命令行 = 当它还在，宁可不跑）。拿不到就立刻报错，不在 run-exclusive 里干等。
export const SELFHOST_LOCK = 'selfhost-run.lock'
const heldSelfHost = new Set()

/** 这个 pid 的命令行（Windows：PowerShell CIM）。进程不在 / 看不到 → ''；查不了（PowerShell 出错、不是 Windows）→ null */
export function processCommandLine (pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return null
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }`], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (r.error || r.status !== 0) return null
  return String(r.stdout ?? '')
}

/** 拿推理机的锁：拿到回 release()；别的 open-book-eval 进程拿着（还活着）就抛。cmdlineOf 只给测试换。 */
export function acquireSelfHostLock (experimentsDir, owner, { cmdlineOf = processCommandLine } = {}) {
  const f = join(experimentsDir, SELFHOST_LOCK)
  if (heldSelfHost.has(resolve(f))) throw new Error('这个进程已经拿着推理机的锁（不许套着拿）')
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString(), note: 'scarletkc（推理机）同一时刻只许一臂；不按年纪过期' }) + '\n')
      closeSync(fd)
      heldSelfHost.add(resolve(f))
      return () => {
        heldSelfHost.delete(resolve(f))
        try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.pid === process.pid) unlinkSync(f) } catch { /* */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let raw = null
      let j = null
      try { raw = readFileSync(f, 'utf8'); j = JSON.parse(raw) } catch { /* 坏的锁当作死锁 */ }
      if (j && Number.isInteger(j.pid) && j.pid !== process.pid && alive(j.pid)) {
        const cl = cmdlineOf(j.pid)
        if (cl === null || /open-book-eval/i.test(cl)) throw new Error(`推理机上已经有一臂在跑（pid ${j.pid}，${j.owner ?? ''}，从 ${j.at ?? '?'} 起）：scarletkc 同一时刻只许一臂，等它跑完再起（这把锁不按年纪过期）`)
      }
      // 拿锁的进程不在了（或者 pid 被别的程序复用了）：删掉再拿。删之前再读一次，内容变了说明别人刚拿到，留给下一轮去撞
      try { if (readFileSync(f, 'utf8') === raw) unlinkSync(f) } catch { /* */ }
    }
  }
  throw new Error('拿不到推理机的锁（刚好有别的进程在抢，过一会儿再跑）')
}

/** run-dir 自己的锁（复核 A8：两个进程同时跑同一个 run-dir 会各算一份上限）。 */
export function acquireDirLock (dir, owner) {
  return acquirePaidLock(dir, owner, '.run.lock')
}
