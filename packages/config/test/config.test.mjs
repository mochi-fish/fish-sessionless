// config.test.mjs：@mochi-fish/config 的单元测试（node:test，零依赖）。
// - 只写系统临时目录下的 mochi-config-test-*，跑完删掉（KEEP=1 留着）。
// - 号、名字、会话 id 全是编的（假号段 10000–10099、20000–20099、30000–30099，或者一眼看得出的连号）。
// - 临时目录或被测的模块在真家目录的 .dsh、.dsh-fish、.dsh-fish-ledger 下面时，开头就拒跑。

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOD = process.env.MOCHI_CONFIG_MODULE || path.join(HERE, '..', 'index.mjs')

// ---------------------------------------------------------------- 拒跑的守卫

const WIN = process.platform === 'win32'
const ck = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p))
const under = (p, dir) => ck(p) === ck(dir) || ck(p).startsWith(ck(dir) + path.sep)
const REAL_HOME = os.userInfo().homedir // 不看环境变量的真家目录
const LIVE = ['.dsh', '.dsh-fish', '.dsh-fish-ledger'].map((d) => path.join(REAL_HOME, d))
for (const bad of LIVE) {
  if (under(os.tmpdir(), bad) || under(MOD, bad)) {
    console.error('拒跑：临时目录或被测模块在 ' + bad + ' 下面')
    process.exit(2)
  }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-config-test-'))
after(() => {
  if (process.env.KEEP === '1') { console.log('# 留着测试目录：' + TMP); return }
  if (under(TMP, os.tmpdir()) && path.basename(TMP).startsWith('mochi-config-test-')) fs.rmSync(TMP, { recursive: true, force: true })
})

const C = await import(pathToFileURL(MOD).href)
const C2 = await import(pathToFileURL(MOD).href + '?second-instance')
delete process.env[C.ENV_VAR] // 不读这台机器上真的配置

// ---------------------------------------------------------------- 夹具（编的）

const OWNER_QQ = '10001'
const HER_QQ = '20000'
const GROUP_QQ = '30001'
const GUEST_QQ = '10099'
const FAKE_HOME = path.join(TMP, 'home')
fs.mkdirSync(FAKE_HOME)

const good = () => ({
  schema: 1,
  owner: { displayName: '店长', ids: { qq: [OWNER_QQ], bili: ['12345678'], vrc: ['usr_11111111-2222-3333-4444-555555555555'] } },
  companion: { name: '大肥鱼', ids: { qq: [HER_QQ] } },
  proactiveChats: [{ channel: 'qq', chat: 'private:' + OWNER_QQ }, { channel: 'qq', chat: 'group:' + GROUP_QQ }],
  mainSession: { by: 'session-id', id: 'session-example-0001' },
  ledgerRoot: '~/ledger',
})

let n = 0
function writeFile (content, name) {
  const f = path.join(TMP, name ?? `identity-${++n}.json`)
  fs.writeFileSync(f, content)
  return f
}
const writeJson = (obj) => writeFile(JSON.stringify(obj, null, 2))
const load = (obj) => C.loadIdentity({ file: writeJson(obj), home: FAKE_HOME, env: {} })

function assertNoOwner (r) {
  assert.equal(r.ok, false)
  assert.equal(r.owner, null)
  assert.deepEqual(r.proactiveChats, [])
  assert.equal(r.mainSession, null)
  assert.equal(r.ledgerRoot, null)
  assert.equal(C.speakerOf(r, 'qq', OWNER_QQ), 'other')
  assert.equal(C.isOwner(r, 'qq', OWNER_QQ), false)
  assert.equal(C.mainSessionId(r), null)
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.problems))
}

function invalidWith (mutate) {
  const o = good()
  mutate(o)
  const r = load(o)
  assertNoOwner(r)
  assert.equal(r.why, 'invalid')
  assert.ok(r.problems.length > 0)
  return r
}

// ---------------------------------------------------------------- 认得的

describe('读得到、写得对', () => {
  test('整份读出来，值都对', () => {
    const r = load(good())
    assert.equal(r.ok, true)
    assert.equal(r.why, 'ok')
    assert.equal(r.source, 'argument')
    assert.deepEqual(r.problems, [])
    assert.equal(r.owner.displayName, '店长')
    assert.deepEqual([...r.owner.ids.qq], [OWNER_QQ])
    assert.equal(r.companion.name, '大肥鱼')
    assert.deepEqual(r.proactiveChats.map((c) => c.chat), ['private:' + OWNER_QQ, 'group:' + GROUP_QQ])
    assert.deepEqual({ ...r.mainSession }, { by: 'session-id', id: 'session-example-0001' })
    assert.equal(r.ledgerRoot, path.join(FAKE_HOME, 'ledger'))
    assert.ok(C.isIdentity(r))
  })

  test('整份冻住，改不动', () => {
    const r = load(good())
    for (const v of [r, r.owner, r.owner.ids, r.owner.ids.qq, r.companion, r.companion.ids, r.proactiveChats, r.proactiveChats[0], r.mainSession]) {
      assert.ok(Object.isFrozen(v))
    }
    assert.throws(() => { 'use strict'; r.owner.ids.qq.push(GUEST_QQ) })
    assert.equal(C.speakerOf(r, 'qq', GUEST_QQ), 'other')
  })

  test('speakerOf：主人、陪伴体、别人', () => {
    const r = load(good())
    assert.equal(C.speakerOf(r, 'qq', OWNER_QQ), 'owner')
    assert.equal(C.speakerOf(r, 'qq', Number(OWNER_QQ)), 'owner') // 数字形式的号也认
    assert.equal(C.speakerOf(r, 'bili', '12345678'), 'owner')
    assert.equal(C.speakerOf(r, 'qq', HER_QQ), 'companion')
    assert.equal(C.speakerOf(r, 'qq', GUEST_QQ), 'other')
    assert.equal(C.speakerOf(r, 'qq', GROUP_QQ), 'other')
    assert.equal(C.speakerOf(r, 'bili', OWNER_QQ), 'other') // 号是按渠道认的
    assert.equal(C.speakerOf(r, 'qq', ' ' + OWNER_QQ), 'other') // 不去空白
    for (const bad of [undefined, null, '', 1.5, -10001, {}, [OWNER_QQ], 2 ** 60]) assert.equal(C.speakerOf(r, 'qq', bad), 'other')
    for (const ch of [undefined, '', 'QQ', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(C.speakerOf(r, ch, OWNER_QQ), 'other')
  })

  test('示例文件本身读得通', () => {
    const ex = path.join(HERE, '..', 'example.identity.json')
    const r = C.loadIdentity({ file: ex, home: FAKE_HOME, env: {} })
    assert.equal(r.ok, true, r.problems.join('；'))
    assert.equal(C.ownerName(r), '主人')
    assert.equal(C.companionName(r), '大肥鱼')
    assert.equal(C.speakerOf(r, 'qq', OWNER_QQ), 'owner')
    assert.equal(r.mainSession.file, path.join(FAKE_HOME, '.dsh-fish', 'home.json'))
  })

  test('缺省值：只写 schema 和 owner', () => {
    const r = load({ schema: 1, owner: { ids: { qq: [OWNER_QQ] } } })
    assert.equal(r.ok, true)
    assert.equal(r.owner.displayName, C.DEFAULT_OWNER_NAME)
    assert.equal(r.companion.name, C.DEFAULT_COMPANION_NAME)
    assert.deepEqual(Object.keys(r.companion.ids), [])
    assert.deepEqual(r.proactiveChats, [])
    assert.equal(r.mainSession, null)
    assert.equal(r.ledgerRoot, null)
  })

  test('owner 明写 null：认得，但没有主人', () => {
    const r = load({ schema: 1, owner: null })
    assert.equal(r.ok, true)
    assert.equal(r.owner, null)
    assert.equal(C.speakerOf(r, 'qq', OWNER_QQ), 'other')
    assert.equal(C.ownerName(r), C.DEFAULT_OWNER_NAME)
  })

  test('$comment 哪一层都可以写', () => {
    const o = good()
    o.$comment = '说明'
    o.owner.$comment = '说明'
    o.owner.ids.$comment = '说明'
    o.companion.$comment = '说明'
    o.proactiveChats[0].$comment = '说明'
    o.mainSession.$comment = '说明'
    const r = load(o)
    assert.equal(r.ok, true, r.problems.join('；'))
    assert.deepEqual(Object.keys(r.owner.ids).sort(), ['bili', 'qq', 'vrc'])
  })

  test('开头带 BOM 的文件照读', () => {
    const f = writeFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(good()))]))
    assert.equal(C.loadIdentity({ file: f, home: FAKE_HOME, env: {} }).ok, true)
  })

  test('别的渠道：通用写法', () => {
    const o = good()
    o.owner.ids['some-chat'] = ['owner@example.invalid']
    o.proactiveChats.push({ channel: 'some-chat', chat: 'room-1' })
    const r = load(o)
    assert.equal(r.ok, true, r.problems.join('；'))
    assert.equal(C.speakerOf(r, 'some-chat', 'owner@example.invalid'), 'owner')
  })

  test('渠道名正好是原型上的名字（constructor）：按别的渠道算，不当成规则', () => {
    const o = good()
    o.owner.ids.constructor = ['owner-x1']
    o.proactiveChats.push({ channel: 'constructor', chat: 'room-1' })
    const r = load(o)
    assert.equal(r.ok, true, r.problems.join('；'))
    assert.equal(C.speakerOf(r, 'constructor', 'owner-x1'), 'owner')
    invalidWith((x) => { x.owner.ids.constructor = ['has space'] })
  })
})

// ---------------------------------------------------------------- 从哪读

describe('从哪读', () => {
  test('环境变量 FISH_IDENTITY_FILE', () => {
    const f = writeJson(good())
    const r = C.loadIdentity({ env: { [C.ENV_VAR]: f }, home: FAKE_HOME })
    assert.equal(r.ok, true)
    assert.equal(r.source, 'env')
  })

  test('参数优先于环境变量', () => {
    const a = writeJson(good())
    const b = writeJson({ schema: 1, owner: null })
    const r = C.loadIdentity({ file: a, env: { [C.ENV_VAR]: b }, home: FAKE_HOME })
    assert.equal(r.source, 'argument')
    assert.equal(C.speakerOf(r, 'qq', OWNER_QQ), 'owner')
  })

  test('~/ 开头的路径按家目录展开', () => {
    fs.writeFileSync(path.join(FAKE_HOME, 'id.json'), JSON.stringify(good()))
    assert.equal(C.loadIdentity({ file: '~/id.json', home: FAKE_HOME, env: {} }).ok, true)
  })

  test('两样都没给：没有主人（no-file）', () => {
    const r = C.loadIdentity({ env: {}, home: FAKE_HOME })
    assertNoOwner(r)
    assert.equal(r.why, 'no-file')
    assert.equal(C.loadIdentity({ env: { [C.ENV_VAR]: '' }, home: FAKE_HOME }).why, 'no-file')
  })

  test('相对路径、网络路径、怪类型：bad-path', () => {
    for (const p of ['identity.json', './identity.json', '../x.json', '\\\\server\\share\\x.json', '//server/share/x.json', 'C:x.json', 42, {}, '~x/y.json']) {
      const r = C.loadIdentity({ file: p, home: FAKE_HOME, env: {} })
      assertNoOwner(r)
      assert.equal(r.why, 'bad-path', String(p))
    }
    assert.equal(C.loadIdentity({ file: '~/x.json', home: 'relative-home', env: {} }).why, 'bad-path')
  })

  test('读不了：不存在、是目录', () => {
    assert.equal(C.loadIdentity({ file: path.join(TMP, 'nope.json'), env: {} }).why, 'unreadable')
    assert.equal(C.loadIdentity({ file: TMP, env: {} }).why, 'unreadable')
    const broken = { statSync () { throw Object.assign(new Error('x'), { code: 'EACCES' }) }, readFileSync () { throw new Error('x') } }
    const r = C.loadIdentity({ file: path.join(TMP, 'a.json'), env: {}, fs: broken })
    assertNoOwner(r)
    assert.equal(r.why, 'unreadable')
  })

  test('太大：too-large（stat 和读出来的都核）', () => {
    const r = C.loadIdentity({ file: writeFile('{' + ' '.repeat(C.MAX_BYTES) + '}'), env: {} })
    assertNoOwner(r)
    assert.equal(r.why, 'too-large')
    const liar = { statSync: () => ({ isFile: () => true, size: 10 }), readFileSync: () => Buffer.alloc(C.MAX_BYTES + 1, 0x20) }
    assert.equal(C.loadIdentity({ file: path.join(TMP, 'a.json'), env: {}, fs: liar }).why, 'too-large')
  })

  test('不是 UTF-8、不是 JSON', () => {
    const latin = writeFile(Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
    assert.equal(C.loadIdentity({ file: latin, env: {} }).why, 'not-utf8')
    for (const t of ['', '{', 'null x', "{'schema':1}", '{"schema":1,}']) {
      const r = C.loadIdentity({ file: writeFile(t), env: {} })
      assertNoOwner(r)
      assert.equal(r.why, 'not-json', JSON.stringify(t))
    }
    assert.equal(C.parseIdentity(undefined).why, 'not-json')
  })
})

// ---------------------------------------------------------------- 写得不对：整份不认

describe('写得不对就没有主人', () => {
  test('顶层不是对象', () => {
    for (const v of [null, 1, 'x', [], [good()], true]) {
      const r = C.validateIdentity(v)
      assertNoOwner(r)
      assert.equal(r.why, 'invalid')
    }
  })

  test('schema 不是 1、owner 没写', () => {
    invalidWith((o) => { o.schema = 2 })
    invalidWith((o) => { o.schema = '1' })
    invalidWith((o) => { delete o.schema })
    invalidWith((o) => { delete o.owner })
  })

  test('认不得的键（各层）', () => {
    invalidWith((o) => { o.ownr = {} })
    invalidWith((o) => { o.owner.name = 'x' })
    invalidWith((o) => { o.companion.displayName = 'x' })
    invalidWith((o) => { o.proactiveChats[0].extra = 1 })
    invalidWith((o) => { o.mainSession.file = '~/x.json' })
    invalidWith((o) => { o.$comment = 7 }) // $comment 只认字符串
  })

  test('号写成数字、写法不对、重复', () => {
    invalidWith((o) => { o.owner.ids.qq = [Number(OWNER_QQ)] })
    for (const bad of ['1234', '1234567890123', '01234', '1000l', ' 10001', '10001 ', '１０００１']) {
      invalidWith((o) => { o.owner.ids.qq = [bad] })
    }
    invalidWith((o) => { o.owner.ids.qq = [OWNER_QQ, OWNER_QQ] })
    invalidWith((o) => { o.owner.ids.qq = [] })
    invalidWith((o) => { o.owner.ids.qq = OWNER_QQ })
    invalidWith((o) => { o.owner.ids.vrc = ['usr_11111111-2222-3333-4444-55555555555G'] })
    invalidWith((o) => { o.owner.ids.vrc = ['USR_11111111-2222-3333-4444-555555555555'] })
    invalidWith((o) => { o.owner.ids.bili = ['0'] })
    invalidWith((o) => { o.owner.ids.mc = ['a b'] })
    invalidWith((o) => { o.owner.ids['other'] = ['has space'] })
    invalidWith((o) => { o.owner.ids['other'] = ['x'.repeat(129)] })
  })

  test('渠道名不对、渠道或号太多', () => {
    invalidWith((o) => { o.owner.ids.QQ = [OWNER_QQ] })
    invalidWith((o) => { Object.defineProperty(o.owner.ids, '__proto__', { value: [OWNER_QQ], enumerable: true, writable: true, configurable: true }) })
    invalidWith((o) => { o.owner.ids['1qq'] = [OWNER_QQ] })
    invalidWith((o) => { o.owner.ids = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['ch' + i, ['x']])) })
    invalidWith((o) => { o.owner.ids.qq = Array.from({ length: 17 }, (_, i) => String(10001 + i)) })
  })

  test('JSON 里的 __proto__ 键不进原型、不算渠道', () => {
    const text = `{"schema":1,"owner":{"ids":{"__proto__":["${OWNER_QQ}"],"qq":["${OWNER_QQ}"]}}}`
    const r = C.parseIdentity(text)
    assertNoOwner(r)
    assert.equal(({}).qq, undefined)
  })

  test('owner 没有号、不是对象', () => {
    invalidWith((o) => { o.owner.ids = {} })
    invalidWith((o) => { delete o.owner.ids })
    invalidWith((o) => { o.owner = 'x' })
    invalidWith((o) => { o.owner = [] })
  })

  test('主人和陪伴体的号重了', () => {
    invalidWith((o) => { o.companion.ids.qq = [OWNER_QQ] })
  })

  test('名字：空、太长、前后空白、控制字符、分隔符、方向控制符', () => {
    const ch = (code) => String.fromCharCode(code)
    for (const bad of ['', ' 店长', '店长 ', 'x'.repeat(33), 7, null, '店' + ch(0) + '长', '店' + ch(0x1b) + '长',
      '店' + ch(0x2028) + '长', '店' + ch(0x2029) + '长', '店' + ch(0x202e) + '长', '店' + ch(0x2066) + '长',
      '店' + ch(0x200f) + '长', '店' + ch(0xfeff) + '长', '店' + ch(0xd800) + '长', '店' + ch(0xe000) + '长']) {
      invalidWith((o) => { o.owner.displayName = bad })
      invalidWith((o) => { o.companion.name = bad })
    }
    // 32 个字（按码位数）正好可以
    const r = load({ ...good(), owner: { displayName: '店'.repeat(32), ids: { qq: [OWNER_QQ] } } })
    assert.equal(r.ok, true)
  })

  test('主动开口的聊天', () => {
    invalidWith((o) => { o.proactiveChats = {} })
    invalidWith((o) => { o.proactiveChats = [{ channel: 'qq', chat: OWNER_QQ }] })
    invalidWith((o) => { o.proactiveChats = [{ channel: 'qq', chat: 'private:0001' }] })
    invalidWith((o) => { o.proactiveChats = [{ channel: 'qq', chat: 'channel:' + OWNER_QQ }] })
    invalidWith((o) => { o.proactiveChats = [{ channel: 'QQ', chat: 'private:' + OWNER_QQ }] })
    invalidWith((o) => { o.proactiveChats = [{ chat: 'private:' + OWNER_QQ }] })
    invalidWith((o) => { o.proactiveChats.push({ channel: 'qq', chat: 'private:' + OWNER_QQ }) })
    invalidWith((o) => { o.proactiveChats = Array.from({ length: 33 }, (_, i) => ({ channel: 'qq', chat: 'group:' + (30001 + i) })) })
  })

  test('主会话的写法', () => {
    invalidWith((o) => { o.mainSession = { by: 'title', id: 'x' } })
    invalidWith((o) => { o.mainSession = { id: 'x' } })
    invalidWith((o) => { o.mainSession = { by: 'session-id', id: '' } })
    invalidWith((o) => { o.mainSession = { by: 'session-id', id: 'has space' } })
    invalidWith((o) => { o.mainSession = { by: 'fish-home', file: 'home.json' } })
    invalidWith((o) => { o.mainSession = 'x' })
  })

  test('账本根：相对路径、网络路径、怪类型', () => {
    for (const bad of ['ledger', './ledger', '\\\\server\\share', '//server/share', 7, {}, '', 'a\u0000b']) {
      invalidWith((o) => { o.ledgerRoot = bad })
    }
    const r = load({ ...good(), ledgerRoot: null })
    assert.equal(r.ok, true)
    assert.equal(r.ledgerRoot, null)
  })

  test('problems 只写哪一格、为什么，不带写的值', () => {
    const secretish = '10077'
    const r = invalidWith((o) => { o.owner.ids.qq = ['0' + secretish]; o.owner.displayName = ' 秘密称呼 ' })
    const all = r.problems.join('\n')
    assert.ok(all.includes('owner.ids.qq[0]'))
    assert.ok(all.includes('owner.displayName'))
    assert.ok(!all.includes(secretish) && !all.includes('秘密称呼'))
  })

  test('problems 最多 50 条', () => {
    const o = good()
    o.proactiveChats = Array.from({ length: 32 }, () => ({ channel: 'qq', chat: 'bad', x: 1 }))
    const r = load(o)
    assert.equal(r.ok, false)
    assert.ok(r.problems.length <= 50)
  })

  test('怪输入不抛错', () => {
    const cyclic = good()
    cyclic.owner.ids.self = cyclic
    const getterBomb = { schema: 1, get owner () { throw new Error('boom') } }
    const proxy = new Proxy({}, { ownKeys () { throw new Error('boom') } })
    for (const v of [cyclic, getterBomb, proxy, Object.create({ schema: 1, owner: null })]) {
      const r = C.validateIdentity(v)
      assertNoOwner(r)
    }
    assert.equal(C.loadIdentity(null).why, 'no-file')
    assert.equal(C.loadIdentity().why, 'no-file')
  })
})

// ---------------------------------------------------------------- 只认本模块造的

describe('只认本模块造的结果', () => {
  test('拼的、拷贝的、另一份实例造的都不算主人', () => {
    const r = load(good())
    const copy = JSON.parse(JSON.stringify(r))
    const spread = { ...r }
    const viaProto = Object.create(r)
    const other = C2.loadIdentity({ file: writeJson(good()), home: FAKE_HOME, env: {} })
    for (const fake of [copy, spread, viaProto, other, { ok: true, owner: { ids: { qq: [OWNER_QQ] } } }]) {
      assert.equal(C.speakerOf(fake, 'qq', OWNER_QQ), 'other')
      assert.equal(C.isIdentity(fake), false)
      assert.equal(C.mainSessionId(fake), null)
      assert.equal(C.ownerName(fake), C.DEFAULT_OWNER_NAME)
    }
    assert.equal(C2.speakerOf(other, 'qq', OWNER_QQ), 'owner')
  })
})

// ---------------------------------------------------------------- 称呼

describe('称呼', () => {
  test('fillNames 换 {owner}、{companion}，只换一遍', () => {
    const r = load(good())
    assert.equal(C.fillNames('只有{owner}和{companion}在。', r), '只有店长和大肥鱼在。')
    assert.equal(C.fillNames('{other}{OWNER}{ owner }', r), '{other}{OWNER}{ owner }')
    const tricky = load({ schema: 1, owner: { displayName: '{companion}', ids: { qq: [OWNER_QQ] } } })
    assert.equal(C.fillNames('{owner}', tricky), '{companion}')
    assert.equal(C.fillNames(7, r), '')
  })

  test('没有主人时用缺省称呼', () => {
    const r = C.loadIdentity({ env: {} })
    assert.equal(C.fillNames('{owner}/{companion}', r), C.DEFAULT_OWNER_NAME + '/' + C.DEFAULT_COMPANION_NAME)
  })
})

// ---------------------------------------------------------------- 主会话

describe('主会话', () => {
  test('session-id：照写', () => {
    assert.equal(C.mainSessionId(load(good())), 'session-example-0001')
  })

  test('fish-home：每次现读 sessionId', () => {
    const homeJson = path.join(TMP, 'fish-home.json')
    const r = load({ ...good(), mainSession: { by: 'fish-home', file: homeJson } })
    assert.equal(r.ok, true)
    assert.equal(C.mainSessionId(r), null) // 文件还不在
    fs.writeFileSync(homeJson, JSON.stringify({ sessionId: 'session-example-0002' }))
    assert.equal(C.mainSessionId(r), 'session-example-0002')
    fs.writeFileSync(homeJson, JSON.stringify({ sessionId: 'session-example-0003' }))
    assert.equal(C.mainSessionId(r), 'session-example-0003')
    for (const bad of ['{', '[]', '{"sessionId":7}', '{"sessionId":""}', '{"sessionId":"has space"}', '{"other":"x"}']) {
      fs.writeFileSync(homeJson, bad)
      assert.equal(C.mainSessionId(r), null, bad)
    }
    fs.writeFileSync(homeJson, '\ufeff' + JSON.stringify({ sessionId: 'session-example-0004' }))
    assert.equal(C.mainSessionId(r), 'session-example-0004')
    fs.writeFileSync(homeJson, JSON.stringify({ sessionId: 'x', pad: 'y'.repeat(C.MAX_BYTES) }))
    assert.equal(C.mainSessionId(r), null)
  })

  test('没写 mainSession：认不出', () => {
    const o = good()
    delete o.mainSession
    assert.equal(C.mainSessionId(load(o)), null)
  })
})

// ---------------------------------------------------------------- 模块本身

describe('模块本身', () => {
  test('只 import node 内置模块', () => {
    const src = fs.readFileSync(MOD, 'utf8')
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    assert.ok(specs.length > 0)
    for (const s of specs) assert.ok(s.startsWith('node:'), s)
    assert.ok(!/\bimport\s*\(/.test(src), '没有动态 import')
  })

  test('源码里没有行分隔符、段分隔符和 BOM', () => {
    const src = fs.readFileSync(MOD, 'utf8')
    for (const code of [0x2028, 0x2029, 0xfeff]) assert.ok(!src.includes(String.fromCharCode(code)))
  })

  test('package.json：MIT、公开、版本 0.1.0、没有依赖', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(MOD), 'package.json'), 'utf8'))
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.private, false)
    assert.equal(pkg.version, '0.1.0')
    assert.equal(pkg.publishConfig, undefined)
    assert.equal(pkg.dependencies, undefined)
  })
})
