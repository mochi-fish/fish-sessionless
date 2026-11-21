import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createScanner, makeConfig, buildFingerprintSet, FP_DEFAULTS, validateLayer, termId, buildTermMatcher, loadProvider } from '../index.mjs'
import { FAKE, HER_LINES, OTHER_LINES, TOOL, tmp, rmrf, writeTree, runScan } from './helpers.mjs'

function layerFor (key = randomBytes(32)) {
  const fp = { key, ...FP_DEFAULTS }
  return validateLayer({
    key,
    terms: [
      { kind: 'qq', value: FAKE.qq },
      { kind: 'group', value: FAKE.group },
      { kind: 'user-name', value: FAKE.user },
      { kind: 'host', value: FAKE.host },
      { kind: 'nick', value: FAKE.cjkName },
      { kind: 'secret', value: 'Qx7' + 'vT9mZ2pL4kR8' },
    ],
    fingerprints: [
      { rule: 'her-words', set: buildFingerprintSet(HER_LINES, fp), ...fp },
      { rule: 'others-words', set: buildFingerprintSet(OTHER_LINES, fp), ...fp },
    ],
    allowIds: new Set(),
    health: { ok: true, problems: [], counts: {} },
  })
}

const DIRTY = {
  'a.mjs': `// 主人是 ${FAKE.cjkName}\nconst ID = '${FAKE.qq}'\n`,
  'b.md': `登录 ${FAKE.host.toUpperCase()} 上看一眼\n`,
  'c.json': `{ "chat": "x${FAKE.group}" }\n`,
  'd.txt': `token Qx7vT9mZ2pL4kR8 end\n`,
  'e.mjs': `test('split', () => split('${HER_LINES[1]}'))\n`,
  'f.md': `> ${OTHER_LINES[0]}\n`,
  'g.txt': `profile ${FAKE.user}\n`,
}
const CLEAN = {
  'a.mjs': "const OWNER_QQ = '10001'\nconst FISH_QQ = '20001'\n",
  'b.md': '# 说明\n\n她在群 30001 里说话的时候，桥会先看是不是 @ 了她。\n今天的天气不错，适合出去走走。\n',
  'c.json': '{ "groups": { "30002": { "seq": 1 } } }\n',
}

test('真值：数字只认整段，名字不分大小写，密钥分大小写', () => {
  const key = randomBytes(32)
  const m = buildTermMatcher([
    { kind: 'qq', value: FAKE.qq, id: 'q', layer: 'private' },
    { kind: 'user-name', value: FAKE.user, id: 'u', layer: 'private' },
    { kind: 'secret', value: 'AbCdEfGh12345678', id: 's', layer: 'private' },
  ])
  assert.equal(m.scan(`x${FAKE.qq}y`).length, 1)
  assert.equal(m.scan(`1${FAKE.qq}`).length, 0)
  assert.equal(m.scan(FAKE.user.toUpperCase()).length, 1)
  assert.equal(m.scan(['C:', 'Users', FAKE.user, 'x'].join('\\')).length, 1)
  assert.equal(m.scan('x' + FAKE.user).length, 0) // 英文的值按整词认，嵌在别的词里不算
  assert.equal(m.scan('--C-Users-' + FAKE.user + '-.dsh').length, 1)
  assert.equal(m.scan('abcdefgh12345678').length, 0)
  assert.equal(m.scan('AbCdEfGh12345678').length, 1)
  assert.match(termId(key, 'qq', FAKE.qq), /^qq#[0-9a-f]{10}$/)
})

test('私有层：脏树每个文件都命中，干净树 0，报告里没有值', () => {
  const layer = layerFor()
  const d1 = tmp('dirty')
  const d2 = tmp('clean')
  try {
    writeTree(d1, DIRTY)
    writeTree(d2, CLEAN)
    const r1 = createScanner({ config: makeConfig({}), layer }).scanDir(d1)
    const hitFiles = new Set(r1.findings.filter((f) => f.layer === 'private').map((f) => f.path))
    assert.deepEqual([...hitFiles].sort(), Object.keys(DIRTY).sort())
    assert.ok(r1.findings.some((f) => f.rule === 'her-words' && f.path === 'e.mjs'))
    assert.ok(r1.findings.some((f) => f.rule === 'others-words' && f.path === 'f.md'))
    const out = JSON.stringify(r1)
    for (const v of [FAKE.qq, FAKE.group, FAKE.user, FAKE.host, FAKE.cjkName, 'Qx7vT9mZ2pL4kR8', HER_LINES[1].slice(0, 8)]) assert.ok(!out.includes(v), '报告里漏了值')
    const r2 = createScanner({ config: makeConfig({}), layer }).scanDir(d2)
    assert.deepEqual(r2.findings, [])
  } finally { rmrf(d1); rmrf(d2) }
})

test('私有的放行表按编号放；公开配置的 allow 放不过私有命中', () => {
  const layer = layerFor()
  const id = termId(layer.key, 'qq', FAKE.qq)
  layer.allowIds = new Set([id])
  const sc = createScanner({ config: makeConfig({ allow: [{ path: '**', rule: 'private:group', reason: '试图放过' }] }), layer })
  sc.scanFile('x.txt', Buffer.from(`${FAKE.qq} ${FAKE.group}`))
  const r = sc.result()
  assert.deepEqual(r.findings.map((f) => f.rule), ['private:group'])
  assert.equal(r.stats.suppressed, 1)
})

test('额外关键词（禁发）：命中只报标签', () => {
  const sc = createScanner({ config: makeConfig({}), extraTerms: [{ kind: 'embargo', value: 'toFile 那道门', label: 'embargo#3' }] })
  sc.scanFile('x.md', Buffer.from('这里讲 TOFILE 那道门 的绕法'))
  const r = sc.result()
  assert.deepEqual(r.findings.map((f) => [f.layer, f.rule]), [['embargo', 'embargo#3']])
  assert.ok(!JSON.stringify(r).includes('toFile'))
})

test('provider 坏了就报错，命令行退 2（不当作干净）', async () => {
  const d = tmp('prov')
  try {
    const bad = join(d, 'bad.mjs')
    writeFileSync(bad, 'export async function loadPrivateLayer () { return { key: Buffer.alloc(4), terms: [], fingerprints: [] } }\n')
    await assert.rejects(loadProvider(bad), /key/)
    const throws = join(d, 'throws.mjs')
    writeFileSync(throws, "export async function loadPrivateLayer () { throw new Error('读不到配置') }\n")
    writeTree(d, { 'tree/a.txt': 'ok\n' })
    assert.equal(runScan(['--private', bad, join(d, 'tree')]).status, 2)
    assert.equal(runScan(['--private', throws, join(d, 'tree')]).status, 2)
    const sick = join(d, 'sick.mjs')
    writeFileSync(sick, `export async function loadPrivateLayer () { return { key: Buffer.alloc(32, 1), terms: [], fingerprints: [], health: { ok: false, problems: ['指纹库是空的'] } } }\n`)
    assert.equal(runScan(['--private', sick, join(d, 'tree')]).status, 2)
  } finally { rmrf(d) }
})

test('命令行带私有层：脏树退 1、干净树退 0，输出里没有值', () => {
  const d = tmp('cli-priv')
  try {
    const fixture = join(d, 'layer.json')
    writeFileSync(fixture, JSON.stringify({ terms: [{ kind: 'qq', value: FAKE.qq }], her: HER_LINES }))
    const prov = join(d, 'prov.mjs')
    writeFileSync(prov, [
      `import { readFileSync } from 'node:fs'`,
      `import { buildFingerprintSet, FP_DEFAULTS } from ${JSON.stringify(pathToFileURL(join(TOOL, 'index.mjs')).href)}`,
      `export async function loadPrivateLayer () {`,
      `  const j = JSON.parse(readFileSync(${JSON.stringify(fixture)}, 'utf8'))`,
      `  const key = Buffer.alloc(32, 7)`,
      `  const fp = { key, ...FP_DEFAULTS }`,
      `  return { key, terms: j.terms, fingerprints: [{ rule: 'her-words', set: buildFingerprintSet(j.her, fp), ...fp }], allowIds: new Set(), health: { ok: true, problems: [], counts: {} } }`,
      `}`,
    ].join('\n'))
    writeTree(d, { 'dirty/a.mjs': DIRTY['a.mjs'], 'dirty/e.mjs': DIRTY['e.mjs'], 'clean/a.mjs': CLEAN['a.mjs'] })
    const r1 = runScan(['--private', prov, '--json', join(d, 'dirty')])
    assert.equal(r1.status, 1, r1.stderr)
    assert.ok(!r1.stdout.includes(FAKE.qq))
    const j = JSON.parse(r1.stdout)
    assert.deepEqual([...new Set(j.findings.map((f) => f.rule))].sort(), ['her-words', 'private:qq'])
    const r2 = runScan(['--private', prov, join(d, 'clean')])
    assert.equal(r2.status, 0, r2.stdout + r2.stderr)
  } finally { rmrf(d) }
})
