// tools/scratch-guard.mjs 的测试。只在 os.tmpdir() 下面自己 mkdtemp 的目录里动；受保护的目录（DSH_HOME 等）也指到这里面。
// 用法：node tools/test/test-scratch-guard.mjs        （看 PASS / FAIL 行，有失败退 1）
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const T = mkdtempSync(join(tmpdir(), 'scratch-guard-test-'))
// 受保护的目录全指到临时目录里（读这些变量是在调用时）
process.env.DSH_HOME = join(T, 'fake-dsh')
process.env.DSH_FISH_HOME = join(T, 'fake-fish')
process.env.DSH_FISH_LOCATION = join(T, 'location.json')
process.env.SCRATCH_GUARD_EXTRA_FORBIDDEN = join(T, 'extra-a') + ';' + join(T, 'extra-b')
writeFileSync(process.env.DSH_FISH_LOCATION, JSON.stringify({ root: join(T, 'moved-fish') }))
const G = await import('../scratch-guard.mjs')

let pass = 0
let fail = 0
const check = (id, ok, what, detail = '') => {
  if (ok) pass += 1; else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}) ${what}${detail ? ` (${detail})` : ''}`)
}
const refused = (fn) => { try { fn(); return false } catch (e) { return e.code === 'REFUSE' } }
const links = []
const link = (target, path) => { symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); links.push(path) }

try {
  // a：forbiddenRoots
  const roots = G.forbiddenRoots()
  check('a1', [process.env.DSH_HOME, process.env.DSH_FISH_HOME, join(T, 'moved-fish'), join(T, 'extra-a'), join(T, 'extra-b'), join(homedir(), '.dsh'), join(homedir(), '.dsh-fish')].every((r) => roots.includes(r)), 'forbiddenRoots：~/.dsh、~/.dsh-fish、两个环境变量、搬家指针、额外的都在')

  // b：refuseByString / refuseByRealpath
  check('b1', refused(() => G.refuseByString(join(process.env.DSH_HOME, 'x', 'y'), roots, 'p')), '受保护目录下面的路径 → 拒（只比字符串）')
  check('b2', refused(() => G.refuseByString('\\\\server\\share\\x', roots, 'p')) && refused(() => G.refuseByString('//server/share/x', roots, 'p')), '\\\\ 或 // 开头 → 拒')
  check('b3', refused(() => G.refuseByString('', roots, 'p')), '空 → 拒')
  check('b4', !refused(() => G.refuseByString(join(T, 'copies', 'a.json'), roots, 'p')), '别处 → 过')
  mkdirSync(join(T, 'extra-a', 'inner'), { recursive: true })
  link(join(T, 'extra-a', 'inner'), join(T, 'sneaky'))
  check('b5', !refused(() => G.refuseByString(join(T, 'sneaky', 'f.json'), roots, 'p')) && refused(() => G.refuseByRealpath(join(T, 'sneaky', 'f.json'), roots, 'p')), '目录联接指进受保护目录：字符串那道过，realpath 那道拒')
  check('b6', !refused(() => G.refuseByRealpath(join(T, 'not-yet', 'out.json'), roots, 'p')), '还不存在的路径：往上找到存在的那层再比')

  // c：claimScratchDir
  const P = 'sgt-'
  const a = G.claimScratchDir(join(T, 'sgt-one'), { prefix: P })
  check('c1', existsSync(join(a, G.SCRATCH_MARK)) && readdirSync(a).length === 1, '新目录：建好、放记号')
  writeFileSync(join(a, 'left.txt'), 'x')
  G.claimScratchDir(join(T, 'sgt-one'), { prefix: P })
  check('c2', !existsSync(join(a, 'left.txt')) && existsSync(join(a, G.SCRATCH_MARK)), '有记号的旧目录：清空重建')
  mkdirSync(join(T, 'sgt-foreign')); writeFileSync(join(T, 'sgt-foreign', 'keep.txt'), 'x')
  check('c3', refused(() => G.claimScratchDir(join(T, 'sgt-foreign'), { prefix: P })) && existsSync(join(T, 'sgt-foreign', 'keep.txt')), '有东西又没记号：拒，东西还在')
  check('c4', refused(() => G.claimScratchDir(join(T, 'other-name'), { prefix: P })), '名字不以 prefix 开头 → 拒')
  check('c5', refused(() => G.claimScratchDir(tmpdir(), { prefix: '' })) === false && (() => { try { G.claimScratchDir(tmpdir(), { prefix: '' }); return false } catch (e) { return /prefix/.test(e.message) } })(), '没给 prefix → 抛（不是 REFUSE，是用法错）')
  check('c6', refused(() => G.claimScratchDir(join(homedir(), 'sgt-not-in-tmp-' + process.pid), { prefix: P })) && !existsSync(join(homedir(), 'sgt-not-in-tmp-' + process.pid)), '不在 tmpdir 下面 → 拒，也不建')
  check('c7', refused(() => G.claimScratchDir(join(T, 'sgt-keep'), { prefix: P, keep: [join(T, 'sgt-keep', 'pkg')] })), '会删到 keep 里的目录 → 拒')
  check('c8', refused(() => G.claimScratchDir(join(T, 'sgt-in-keep'), { prefix: P, keep: [T] })), '在 keep 里面 → 拒')
  mkdirSync(join(T, 'fake-dsh'), { recursive: true })
  check('c9', refused(() => G.claimScratchDir(join(T, 'fake-dsh', 'sgt-x'), { prefix: P })) && !existsSync(join(T, 'fake-dsh', 'sgt-x')), 'DSH_HOME 下面 → 拒，也不建')
  check('c10', refused(() => G.claimScratchDir(join(T, 'extra-b', 'sgt-x'), { prefix: P })), 'SCRATCH_GUARD_EXTRA_FORBIDDEN 下面 → 拒')
  mkdirSync(join(T, 'sgt-target')); writeFileSync(join(T, 'sgt-target', 'keep.txt'), 'x'); writeFileSync(join(T, 'sgt-target', G.SCRATCH_MARK), '')
  link(join(T, 'sgt-target'), join(T, 'sgt-link'))
  check('c11', refused(() => G.claimScratchDir(join(T, 'sgt-link'), { prefix: P })) && existsSync(join(T, 'sgt-target', 'keep.txt')), '目录本身是联接 → 拒，指向的东西还在')
  // c12 拿本测试所在的目录当「tmpdir 外面」。仓库克隆在系统临时目录下面时这个前提不成立（守卫照规矩放行，还会在这里建出 sgt-child），只能跳过。
  const lc = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const hereInTmp = lc(realpathSync.native(HERE) + sep).startsWith(lc(realpathSync.native(tmpdir()) + sep))
  if (hereInTmp) console.log('SKIP c12) 测试目录在系统临时目录下面，造不出指到 tmpdir 外面的联接')
  else link(HERE, join(T, 'outside'))
  if (!hereInTmp) check('c12', refused(() => G.claimScratchDir(join(T, 'outside', 'sgt-child'), { prefix: P })) && !existsSync(join(HERE, 'sgt-child')), '上层是指到 tmpdir 外面的联接 → 拒，外面没多出东西')
  writeFileSync(join(T, 'sgt-file'), 'x')
  check('c13', refused(() => G.claimScratchDir(join(T, 'sgt-file'), { prefix: P })), '同名的是文件 → 拒')

  // d：releaseScratchDir
  G.releaseScratchDir(a)
  check('d1', !existsSync(a), '有记号的：删')
  G.releaseScratchDir(join(T, 'sgt-foreign'))
  check('d2', existsSync(join(T, 'sgt-foreign', 'keep.txt')), '没记号的：不删')
  G.releaseScratchDir(join(T, 'sgt-link'))
  check('d3', existsSync(join(T, 'sgt-target', 'keep.txt')), '联接：不删（连指向的也不动）')
} finally {
  // 先拆联接（只拆联接本身），再删整个临时目录
  for (const l of links) { try { rmdirSync(l) } catch { try { unlinkSync(l) } catch { /* */ } } }
  try { rmSync(T, { recursive: true, force: true }) } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
