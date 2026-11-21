// fish-pack-zh 的测试：拼出来的两份文件对不对、称呼能不能换、坏称呼会不会拒、仓库里的 dist/ 是不是最新的。
// 用法：node test/test-pack.mjs        （看 PASS / FAIL 行，有失败退 1）
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const BUILD = join(PKG, 'build.mjs')
const T = mkdtempSync(join(tmpdir(), 'fish-pack-zh-test-'))

let pass = 0
let fail = 0
const check = (id, ok, what, detail = '') => {
  if (ok) pass += 1; else fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}) ${what}${detail ? ` (${detail})` : ''}`)
}
const build = (args) => spawnSync(process.execPath, [BUILD, ...args], { encoding: 'utf8' })
const load = (dir) => ({ pack: JSON.parse(readFileSync(join(dir, 'fish.json'), 'utf8')), block: JSON.parse(readFileSync(join(dir, 'compress-block.json'), 'utf8')), raw: readFileSync(join(dir, 'fish.json')), rawBlock: readFileSync(join(dir, 'compress-block.json')) })
const SEP = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']')

try {
  const a = join(T, 'a')
  let r = build(['--out', a])
  check('1', r.status === 0, '缺省称呼能拼出来', r.stderr.slice(0, 200))
  const A = load(a)
  check('2', JSON.stringify(Object.keys(A.pack)) === JSON.stringify(['name', 'version', 'description', 'promptSections', 'nudgeSections', 'toolPrompts']) && A.pack.name === 'fish' && A.pack.version === '0.2.0', '包的键和顺序、名字、版本')
  check('3', JSON.stringify(Object.keys(A.pack.nudgeSections)) === JSON.stringify(['t2Guidance', 't3Guidance', 'efficiencyNote', 'emergencyHeader']), 'nudgeSections 的四格')
  check('4', A.block.acknowledgePromptsRisk === true && A.block.promptPack === 'fish' && JSON.stringify(Object.keys(A.block.prompts)) === JSON.stringify(['compressPhilosophy', 'howToCompressRules', 'tier2DistillRules', 'tier3CondenseRules']), 'compress 块：确认覆盖、包名、四段')
  const phil = A.block.prompts.compressPhilosophy
  check('5', A.pack.nudgeSections.efficiencyNote.endsWith('\n\n' + phil) && A.pack.nudgeSections.emergencyHeader.endsWith('\n\n' + phil), '两个抬头末尾接的是 compressPhilosophy 原文')
  const all = JSON.stringify(A.pack) + JSON.stringify(A.block)
  check('6', all.includes('主人') && all.includes('维护助手') && !/\{\{(owner|maintainer)\}\}/.test(all), '缺省称呼换进去了，没有剩下的占位符')
  check('7', !/[他她]/.test(all) && !SEP.test(all), '没有「他」「她」，没有 U+2028 / U+2029')
  check('8', A.raw[0] !== 0xef && A.rawBlock[0] !== 0xef && !A.raw.includes(13) && !A.rawBlock.includes(13), '不带 BOM、没有 \\r')

  const b = join(T, 'b')
  r = build(['--out', b, '--owner', '阿明', '--maintainer', '小助手'])
  const B = load(b)
  const allB = JSON.stringify(B.pack) + JSON.stringify(B.block)
  check('9', r.status === 0 && allB.includes('阿明') && allB.includes('小助手') && !allB.includes('主人') && !allB.includes('维护助手'), '换称呼：全换过去了')
  check('10', allB.split('阿明').length === all.split('主人').length, '换称呼：点名的处数不变', `${allB.split('阿明').length - 1} vs ${all.split('主人').length - 1}`)

  const c = join(T, 'c')
  build(['--out', c])
  check('11', load(c).raw.equals(A.raw) && load(c).rawBlock.equals(A.rawBlock), '同样的输入拼两次，逐字节相同')

  for (const [id, args, what] of [
    ['12', ['--owner', '她'], '称呼里带「她」'],
    ['13', ['--owner', 'a b'], '称呼里带空白'],
    ['14', ['--owner', '一二三四五六七八九十一二三'], '称呼超过 12 个字'],
    ['15', ['--owner', '阿明', '--maintainer', '阿明'], '两个称呼一样'],
    ['16', ['--bogus'], '不认识的参数'],
    ['17', ['--owner'], '参数缺值'],
  ]) {
    const x = build([...args, '--out', join(T, 'bad-' + id)])
    check(id, x.status === 2, `${what} → 退 2`, String(x.status))
  }
  r = build(['--check'])
  check('18', r.status === 0, '--check 只检查、能过')

  // 仓库里的 dist/ 是用缺省称呼拼的最新结果
  check('19', load(join(PKG, 'dist')).raw.equals(A.raw) && load(join(PKG, 'dist')).rawBlock.equals(A.rawBlock), 'dist/ 和现在的 texts/ 拼出来的一致（改了正文要重新 node build.mjs）')
} finally {
  try { rmSync(T, { recursive: true, force: true }) } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
