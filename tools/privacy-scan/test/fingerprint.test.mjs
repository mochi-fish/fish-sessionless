import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  normalizeUnits, normalizedString, buildFingerprintSet, matchRuns, writeFingerprintFile, readFingerprintFile, FP_DEFAULTS,
} from '../index.mjs'
import { HER_LINES, tmp, rmrf } from './helpers.mjs'

const key = randomBytes(32)
const opts = { key, ...FP_DEFAULTS }

test('规整：只留字母数字，小写，全角转半角', () => {
  assert.equal(normalizedString('你好，World！ １２３\n\t「嗯」'), '你好world123嗯')
  const n = normalizeUnits('a，b')
  assert.deepEqual([...n.pos], [0, 2])
})

test('原句换了标点、空白、拆成多行、放进代码里，照样认得出', () => {
  const set = buildFingerprintSet(HER_LINES, opts)
  assert.ok(set.size > 0)
  const line = HER_LINES[0]
  const mangled = `const cases = [\n  '${line.slice(0, 10)}' +\n    '${line.slice(10).replace(/，/g, ', ')}',\n]`
  const runs = matchRuns(normalizeUnits(mangled), set, opts)
  assert.equal(runs.length, 1)
  assert.ok(runs[0].endUnit - runs[0].startUnit >= normalizedString(line).length - 1)
})

test('只重合几个字不算；没有 CJK 的窗口不进指纹', () => {
  const set = buildFingerprintSet(HER_LINES, opts)
  const runs = matchRuns(normalizeUnits('今天的月亮真圆。如果明天还下雨就算了'), set, opts)
  assert.equal(runs.length, 0)
  const ascii = buildFingerprintSet(['this is an english sentence that is long enough'], opts)
  assert.equal(ascii.size, 0)
})

test('排除集合里的窗口不进指纹（我们自己的提示词她照说过的）', () => {
  const ours = '如果明天还下雨的话我们就去地下商场找那家卖章鱼烧的小摊吧'
  const exclude = buildFingerprintSet([ours], opts)
  const set = buildFingerprintSet(HER_LINES, opts, exclude)
  assert.equal(matchRuns(normalizeUnits(ours), set, opts).length, 0)
  assert.equal(matchRuns(normalizeUnits(HER_LINES[2]), set, opts).length, 1)
})

test('换一把密钥就对不上', () => {
  const set = buildFingerprintSet(HER_LINES, opts)
  const other = { ...opts, key: randomBytes(32) }
  assert.equal(matchRuns(normalizeUnits(HER_LINES[0]), set, other).length, 0)
})

test('指纹库文件来回一致', () => {
  const d = tmp('fp')
  try {
    const set = buildFingerprintSet(HER_LINES, opts)
    const f = join(d, 'fp.bin')
    assert.equal(writeFingerprintFile(f, set, opts), set.size)
    const back = readFingerprintFile(f)
    assert.equal(back.window, opts.window)
    assert.equal(back.minCjk, opts.minCjk)
    assert.deepEqual([...back.set].sort(), [...set].sort())
  } finally { rmrf(d) }
})
