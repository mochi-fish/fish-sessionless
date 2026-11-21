// tools/run-exclusive.mjs 的测试。锁目录用 RUN_EXCLUSIVE_LOCK_DIR 指到临时目录，等待间隔用 RUN_EXCLUSIVE_POLL_MS 调小。
// 用法：node tools/test/test-run-exclusive.mjs        （看 PASS / FAIL 行，有失败退 1）
// 注意：run-exclusive 拿锁之前会数整台机器上正在跑的 node --test 总进程；这几个用例用 --slots 3 / 4，
// 机器上同时有 3 套以上别的全量测试在跑时会一直等到超时（报 FAIL），那时请晚点再跑。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RE = resolve(HERE, '..', 'run-exclusive.mjs')
const T = mkdtempSync(join(tmpdir(), 'run-exclusive-test-'))
const LOCKS = join(T, 'locks')

let pass = 0
let fail = 0
const check = (id, ok, what, detail = '') => {
  if (ok) pass += 1; else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}) ${what}${detail ? ` (${detail})` : ''}`)
}
const env = { ...process.env, RUN_EXCLUSIVE_LOCK_DIR: LOCKS, RUN_EXCLUSIVE_POLL_MS: '200' }
const run = (args, timeout = 90000) => {
  const r = spawnSync(process.execPath, [RE, ...args], { encoding: 'utf8', env, timeout })
  return { code: r.status, out: String(r.stdout), err: String(r.stderr) }
}
const argvScript = join(T, 'argv.mjs')
writeFileSync(argvScript, 'console.log(JSON.stringify(process.argv.slice(2)))\n')

try {
  check('a1', run([]).code === 2, '没给名字和命令 → 2')
  check('a2', run(['x']).code === 2 && run(['x', '--']).code === 2, '没给 -- 后面的命令 → 2')
  check('a3', run(['bad name!', '--', process.execPath, '-e', '0']).code === 2, '名字不合规 → 2')

  let r = run(['t1', '--slots', '4', '--', process.execPath, '-e', 'process.exit(3)'])
  check('b1', r.code === 3 && /got t1-1\.lock/.test(r.err), '退出码照传；拿到第 1 个锁', r.err.slice(0, 200))
  check('b2', existsSync(LOCKS) && readdirSync(LOCKS).length === 0, '跑完锁放掉了')
  r = run(['t2', '--slots', '4', '--', process.execPath, argvScript, '--test-concurrency=8', '--test-concurrency=2', 'x'])
  check('b3', r.code === 0 && r.out.trim() === JSON.stringify(['--test-concurrency=4', '--test-concurrency=2', 'x']), '--test-concurrency 大于 4 的改成 4，别的不动', r.out.trim())
  r = run(['t3', '--slots', '4', '--', join(T, 'no-such-command')])
  check('b4', r.code === 127 && readdirSync(LOCKS).length === 0, '命令起不来 → 127，锁放掉', String(r.code))

  // 死锁：owner 的进程已经不在了
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  const deadPid = Number(String(dead.stdout).trim())
  for (const k of [1, 2, 3]) { mkdirSync(join(LOCKS, `t4-${k}.lock`), { recursive: true }); writeFileSync(join(LOCKS, `t4-${k}.lock`, 'owner.json'), JSON.stringify({ pid: deadPid, at: new Date().toISOString() })) }
  r = run(['t4', '--slots', '3', '--', process.execPath, '-e', '0'])
  check('c1', r.code === 0 && /got t4-\d\.lock/.test(r.err), 'owner 已经不在的锁算死锁、清掉再拿', r.err.slice(0, 200))

  // 活锁：owner 是本测试进程。三个都占着 → 等；放掉一个 → 拿到
  for (const k of [1, 2, 3]) { rmSync(join(LOCKS, `t5-${k}.lock`), { recursive: true, force: true }); mkdirSync(join(LOCKS, `t5-${k}.lock`), { recursive: true }); writeFileSync(join(LOCKS, `t5-${k}.lock`, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() })) }
  const c = spawn(process.execPath, [RE, 't5', '--slots', '3', '--', process.execPath, '-e', 'process.exit(5)'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  c.stderr.on('data', (d) => { err += d })
  const exited = new Promise((done) => c.on('exit', (code) => done(code)))
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((s) => setTimeout(s, 100)) } return false }
  const waited = await until(() => /busy/.test(err), 60000)
  check('c2', waited && !/got t5/.test(err), '三个锁都被活进程占着 → 等（打 busy）')
  rmSync(join(LOCKS, 't5-2.lock'), { recursive: true, force: true })
  const code = await Promise.race([exited, new Promise((s) => setTimeout(() => s('timeout'), 90000))])
  if (code === 'timeout') c.kill()
  check('c3', code === 5 && /got t5-2\.lock/.test(err), '放掉一个以后拿到的就是那一个，退出码照传', String(code))
  check('c4', existsSync(join(LOCKS, 't5-1.lock')) && existsSync(join(LOCKS, 't5-3.lock')) && !existsSync(join(LOCKS, 't5-2.lock')), '别人的锁没动、自己的放掉了')
} finally {
  try { rmSync(T, { recursive: true, force: true }) } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
