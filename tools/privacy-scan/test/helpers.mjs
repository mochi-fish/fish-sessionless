// 测试用的合成材料。这里的「真值」全是编的，而且都在运行时拼出来：
// 源码里不出现能被扫描器认出来的完整写法（否则仓库自扫就不干净了）。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const TOOL = join(HERE, '..')
export const SCAN = join(TOOL, 'scan.mjs')

export function tmp (tag = 't') {
  return mkdtempSync(join(tmpdir(), `privacy-scan-test-${tag}-`))
}
export function rmrf (p) { rmSync(p, { recursive: true, force: true }) }

export function writeTree (root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = join(root, rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, content)
  }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export function randomAlnum (n) {
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += ALNUM[b[i] % ALNUM.length]
  return s
}

// 编出来的「本机用户名」「号」「主机名」等
export const FAKE = {
  user: 'zed' + 'quill',
  // 不在假号表、不是连号的 8 位数
  qq: ['5826', '3914'].join(''),
  group: ['730', '418', '265'].join(''),
  host: 'quill' + 'box',
  cjkName: '青柠' + '岛主',
}
export const winHome = (name = FAKE.user, sep = '\\') => ['C:', 'Users', name, 'workspace'].join(sep)
export const ip = (...o) => o.join('.')
export const mail = (local, domain) => local + '@' + domain

// 编的「她的原话」：几句不会在别处出现的句子
export const HER_LINES = [
  '今天的月亮像一块被咬过的柠檬饼干，我盯着它看了半天才想起来要回消息',
  '如果明天还下雨的话我们就去地下商场找那家卖章鱼烧的小摊吧',
  '刚才那局我其实是故意输的才怪呢，下次一定把你打得落花流水',
]
export const OTHER_LINES = [
  '群里那个说要请奶茶的人到现在还没兑现承诺大家都记着呢',
]

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'tag.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_TERMINAL_PROMPT: '0',
}
export function sh (cwd, cmd, args, env = GIT_ENV) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → ${r.status}: ${r.stderr}`)
  return r.stdout
}
export function gitInit (dir, email = mail('dev', 'example.invalid')) {
  sh(dir, 'git', ['init', '-q', '-b', 'main'])
  sh(dir, 'git', ['config', 'user.name', 'test dev'])
  sh(dir, 'git', ['config', 'user.email', email])
}
export function gitCommitAll (dir, msg) {
  sh(dir, 'git', ['add', '-A'])
  sh(dir, 'git', ['commit', '-q', '-m', msg])
}

export function runScan (args, opts = {}) {
  return spawnSync(process.execPath, [SCAN, ...args], { encoding: 'utf8', windowsHide: true, ...opts })
}
