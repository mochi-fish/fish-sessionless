// 换一种写法藏起来的号、路径、原话：全角、拆段、转义（\uXXXX、%HH、\xHH、&#…;）、名字后面接着别的字。
// 样本全在运行时拼（见 helpers.mjs 的说明）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createScanner, makeConfig, buildFingerprintSet, FP_DEFAULTS, validateLayer, canonWidth, decodeView, digitHash } from '../index.mjs'
import { FAKE, HER_LINES, winHome } from './helpers.mjs'

const BS = String.fromCharCode(92)
const fullwidth = (s) => [...s].map((c) => (/[!-~]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xFEE0) : c)).join('')
const uEscape = (s, upper = false) => [...s].map((c) => {
  const h = c.charCodeAt(0).toString(16).padStart(4, '0')
  return c.charCodeAt(0) > 127 ? BS + 'u' + (upper ? h.toUpperCase() : h) : c
}).join('')
const xEscape = (s) => [...Buffer.from(s, 'utf8')].map((b) => BS + 'x' + b.toString(16).padStart(2, '0')).join('')
const entities = (s, hex = false) => [...s].map((c) => (c.codePointAt(0) > 127 ? `&#${hex ? 'x' + c.codePointAt(0).toString(16) : c.codePointAt(0)};` : c)).join('')

function layerFor ({ digitSets } = {}) {
  const key = randomBytes(32)
  const fp = { key, ...FP_DEFAULTS }
  return validateLayer({
    key,
    terms: [{ kind: 'qq', value: FAKE.qq }, { kind: 'user-name', value: FAKE.user }],
    fingerprints: [{ rule: 'her-words', set: buildFingerprintSet(HER_LINES, fp), ...fp }],
    digitSets,
    allowIds: new Set(),
  })
}
function rules (text, { layer = null, path = 'src/a.mjs' } = {}) {
  const sc = createScanner({ config: makeConfig({}), layer })
  sc.scanFile(path, Buffer.from(text))
  return sc.result().findings.map((f) => f.rule)
}

test('视图：全角换半角下标不变；转义还原后记得原文位置', () => {
  const t = 'ab' + fullwidth('Q1') + 'c'
  assert.equal(canonWidth(t), 'abQ1c')
  assert.equal(canonWidth(t).length, t.length)
  const src = 'x' + uEscape('今天') + 'y%E4%BB%8Az'
  const v = decodeView(src)
  assert.equal(v.text, 'x今天y今z')
  assert.equal(v.map[1], 1) // 「今」从原文第 1 个字起
  assert.equal(v.map[4], src.indexOf('%'))
  assert.equal(v.esc[v.text.length], 3)
  assert.equal(decodeView('没有转义 100% 的'), null)
  assert.equal(decodeView('%ZZ%G1'), null)
  assert.equal(decodeView('%FF%FE'), null) // 不是 UTF-8 的字节不动
})

test('全角数字写的号：公开规则（有上下文时）和真值都认得', () => {
  assert.ok(rules('QQ：' + fullwidth(FAKE.qq)).includes('qq-context'))
  const layer = layerFor()
  assert.ok(rules('x ' + fullwidth(FAKE.qq), { layer }).includes('private:qq'))
  assert.ok(rules('home ' + fullwidth(FAKE.user), { layer }).includes('private:user-name'))
})

test('拆成几段写的号：空格、下划线（数字分隔符）、连字符', () => {
  const layer = layerFor()
  const q = FAKE.qq
  for (const sep of [' ', '_', '-']) {
    const t = `const x = ${q.slice(0, 3)}${sep}${q.slice(3, 6)}${sep}${q.slice(6)}`
    assert.ok(rules(t, { layer }).includes('private:qq'), JSON.stringify(sep))
  }
  // 拼不出这个号的不算；前面多一段也照样认出中间那几段
  assert.ok(!rules(`v ${q.slice(0, 3)} ${q.slice(4)}`, { layer }).includes('private:qq'))
  assert.ok(rules(`v 12-${q.slice(0, 4)}-${q.slice(4)}`, { layer }).includes('private:qq'))
})

test('本机用户名后面接着别的字母数字也算；前面接着的不算', () => {
  const layer = layerFor()
  for (const t of [FAKE.user + '2', FAKE.user + 'Dev', FAKE.user + '_x', FAKE.user.toUpperCase() + 'e']) {
    assert.ok(rules(t, { layer }).includes('private:user-name'), t)
  }
  assert.ok(!rules('x' + FAKE.user, { layer }).includes('private:user-name'))
})

test('转义写的原话、号、路径：\\uXXXX、%HH、\\xHH、&#…; 都还原了再认', () => {
  const layer = layerFor()
  const her = HER_LINES[2]
  for (const [name, t] of [
    ['u 小写', JSON.stringify({ text: uEscape(her) })],
    ['u 大写', uEscape(her, true)],
    ['百分号', 'https://example.invalid/search?q=' + encodeURIComponent(her)],
    ['x 字节', xEscape(her)],
    ['十进制实体', entities(her)],
    ['十六进制实体', entities(her, true)],
  ]) {
    const r = rules(t, { layer })
    assert.ok(r.includes('her-words'), name)
  }
  const digits = [...FAKE.qq].map((c) => BS + 'u003' + c).join('')
  assert.ok(rules(`{"note":"${digits}"}`, { layer }).includes('private:qq'))
  const encPath = encodeURIComponent(winHome(FAKE.user, BS))
  assert.ok(rules('file=' + encPath).includes('user-path'))
})

test('JSON 字符串里被换行隔开的原话、%22 包着的号', () => {
  const layer = layerFor()
  const her = HER_LINES[0]
  const cut = 9 // 两边都不满一个窗口
  const t = JSON.stringify({ text: her.slice(0, cut) + String.fromCharCode(10) + her.slice(cut, cut + 9) })
  assert.ok(t.includes(BS + 'n'))
  assert.ok(rules(t, { layer }).includes('her-words'))
  assert.ok(rules(`q=%22${FAKE.qq}%22`, { layer }).includes('private:qq'))
})

test('转义视图不重复报：原文里本来就认得出的只报一次；转义写的分隔符不算 line-sep', () => {
  const layer = layerFor()
  const t = `${HER_LINES[0]} %20 ${FAKE.qq} qq`
  const r = rules(t, { layer })
  assert.equal(r.filter((x) => x === 'her-words').length, 1)
  assert.equal(r.filter((x) => x === 'private:qq').length, 1)
  assert.equal(r.filter((x) => x === 'qq-context').length, 1)
  const sep = BS + 'u' + (0x2028).toString(16)
  assert.deepEqual(rules(`const LS = '${sep}'\n`), [])
})

test('GBK 写的文件：报 not-utf8，按 GB18030 读出来的原话照样认', () => {
  // Node 只有 GB18030 的解码器：倒查一张双字节表来编码
  const dec = new TextDecoder('gb18030')
  const enc = new Map()
  for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) { if (b === 0x7f) continue; const ch = dec.decode(Uint8Array.of(a, b)); if (ch.length === 1 && !enc.has(ch)) enc.set(ch, [a, b]) }
  const gbk = (s) => Buffer.from([...s].flatMap((c) => (c.charCodeAt(0) < 128 ? [c.charCodeAt(0)] : enc.get(c))))
  const layer = layerFor()
  const sc = createScanner({ config: makeConfig({}), layer })
  sc.scanFile('logs/out.txt', gbk(`log: ${HER_LINES[1]}\n`))
  const r = sc.result().findings.map((f) => f.rule).sort()
  assert.deepEqual(r, ['her-words', 'not-utf8'])
  const ok = createScanner({ config: makeConfig({}) })
  ok.scanFile('a.md', Buffer.from(String.fromCharCode(0xFEFF) + '# 带 BOM 的 UTF-8 不算\n'))
  assert.deepEqual(ok.result().findings, [])
})

test('二进制里夹着的明文（放行了的图片也照查）：带用户名的路径、真值', () => {
  const layer = layerFor()
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.from('tEXtSource' + String.fromCharCode(0) + winHome(FAKE.user, BS) + BS + 'shot.png'), Buffer.from([0, 0, 1, 2]), Buffer.from(' uid ' + FAKE.qq + ' '), Buffer.from([0, 3])])
  const sc = createScanner({ config: makeConfig({ allowBinary: ['docs/**'] }), layer })
  sc.scanFile('docs/shot.png', png)
  const r = sc.result().findings
  assert.ok(r.every((f) => f.inBinary))
  assert.deepEqual([...new Set(r.map((f) => f.rule))].sort(), ['private:qq', 'private:user-name', 'user-path'])
  const clean = createScanner({ config: makeConfig({ allowBinary: ['docs/**'] }), layer })
  clean.scanFile('docs/ok.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3]))
  assert.deepEqual(clean.result().findings, [])
})

test('见过的号（只存带密钥的哈希）：配置里没了也照样认', () => {
  const key = randomBytes(32)
  const set = new Set([digitHash(key, FAKE.group)])
  const layer = layerFor({ digitSets: [{ rule: 'seen-digits', set, key }] })
  assert.ok(rules(`x ${FAKE.group} y`, { layer }).includes('private:seen-digits'))
  assert.ok(!rules(`x ${FAKE.group}1 y`, { layer }).includes('private:seen-digits'))
  assert.throws(() => validateLayer({ ...layer, digitSets: [{ rule: 'x', set: [], key }] }), /digitSets/)
})
