import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScanner, makeConfig } from '../index.mjs'
import { FAKE, winHome, ip, mail, randomAlnum } from './helpers.mjs'

const config = makeConfig({})
function rulesHit (text, path = 'docs/a.md') {
  const sc = createScanner({ config })
  sc.scanFile(path, Buffer.from(text))
  return sc.result().findings.map((f) => f.rule)
}
const hits = (text, rule, path) => rulesHit(text, path).filter((r) => r === rule).length

test('user-path：各种写法的带用户名路径都认', () => {
  assert.equal(hits(winHome(FAKE.user, '\\'), 'user-path'), 1)
  assert.equal(hits(winHome(FAKE.user, '/'), 'user-path'), 1)
  assert.equal(hits(winHome(FAKE.user, '\\\\'), 'user-path'), 1) // JSON 里转义过的
  assert.equal(hits('/c/Users/' + FAKE.user + '/x', 'user-path'), 1)
  assert.equal(hits('/mnt/c/Users/' + FAKE.user + '/x', 'user-path'), 1)
  assert.equal(hits('/home/' + FAKE.user + '/x', 'user-path'), 1)
  assert.equal(hits('/Users/' + FAKE.user + '/Library', 'user-path'), 1)
  assert.equal(hits('sessions/--C-Users-' + FAKE.user + '-.dsh-fish-home--/x', 'user-path'), 1)
  assert.equal(hits('projects/C--Users-' + FAKE.user + '-workspace-x', 'user-path'), 1)
  // 复核补的写法
  const B = '\\'
  assert.equal(hits('/cygdrive/c/Users/' + FAKE.user + '/x', 'user-path'), 1)
  assert.equal(hits('/var/home/' + FAKE.user + '/x', 'user-path'), 1)
  assert.equal(hits(['C:', 'Users', '', FAKE.user, 'x'].join('/'), 'user-path'), 1)
  assert.equal(hits([B, 'box', 'C$', 'Users', FAKE.user].join(B), 'user-path'), 1)
  assert.equal(hits([B, 'wsl$', 'Ubuntu', 'home', FAKE.user, 'x'].join(B), 'user-path'), 1)
  assert.equal(hits([B, 'wsl.localhost', 'Ubuntu', 'home', FAKE.user].join(B), 'user-path'), 1)
  assert.equal(hits('//wsl$/Ubuntu/home/' + FAKE.user, 'user-path'), 1)
  assert.equal(hits('https://example.invalid/home/' + FAKE.user, 'user-path'), 0) // 网址里的 /home 不算
})

test('user-path：占位写法不算', () => {
  for (const name of ['<name>', '${USER}', '%USERNAME%', '$USER', 'example', 'runner', 'Public', 'Default', '*', 'you']) {
    assert.equal(hits(['C:', 'Users', name, 'x'].join('\\'), 'user-path'), 0, name)
  }
  assert.equal(hits('/home/runner/work/repo', 'user-path'), 0)
  assert.equal(hits('%USERPROFILE%\\.dsh', 'user-path'), 0)
  assert.equal(hits('~/.dsh/local-plugins', 'user-path'), 0)
})

test('private-ip：私网、CGNAT（tailnet）、链路本地、ULA', () => {
  for (const a of [ip(10, 1, 2, 3), ip(172, 20, 0, 5), ip(192, 168, 50, 9), ip(100, 101, 7, 8), ip(169, 254, 1, 1)]) {
    assert.equal(hits(`baseUrl: http://${a}:8000/v1`, 'private-ip'), 1, a)
  }
  assert.equal(hits(['fd7a', '115c', 'a1e0', '', 'ab12'].join(':'), 'private-ip'), 1)
  for (const a of [ip(127, 0, 0, 1), ip(8, 8, 8, 8), ip(172, 32, 0, 1), ip(100, 128, 0, 1), '10.0.26200', ip(1, 10, 0, 1), ip(300, 1, 1, 1)]) {
    assert.equal(hits(`x ${a} y`, 'private-ip'), 0, a)
  }
})

test('lan-host：.local / .lan / tailnet 主机名', () => {
  assert.equal(hits('ssh ' + FAKE.host + '.local', 'lan-host'), 1)
  assert.equal(hits('http://' + FAKE.host + '.lan:8080', 'lan-host'), 1)
  assert.equal(hits([FAKE.host, 'tail1a2b', 'ts', 'net'].join('.'), 'lan-host'), 1)
  assert.equal(hits('.claude/settings.local.json', 'lan-host'), 0)
  assert.equal(hits('dsh-fish-0.9.6-local.1.tgz', 'lan-host'), 0)
  assert.equal(hits('printer.example.local', 'lan-host'), 0)
})

test('qq-context：号码上下文里不在假号表的长数字', () => {
  assert.equal(hits(`const OWNER_QQ = '${FAKE.qq}'`, 'qq-context'), 1)
  assert.equal(hits(`qq:private:${FAKE.qq}`, 'qq-context'), 1)
  assert.equal(hits(`[CQ:at,qq=${FAKE.qq}]`, 'qq-context'), 1)
  assert.equal(hits(`群 ${FAKE.group} 里有人说`, 'qq-context'), 1)
  assert.equal(hits(`"group_id": ${FAKE.group},`, 'qq-context'), 1)
  assert.equal(hits(`onebot-private-${FAKE.qq}-abc`, 'qq-context'), 1)
  assert.equal(hits(`qq${FAKE.qq}`, 'qq-context'), 1)
  // 文件路径本身是号码上下文：JSON 键上光秃秃的号也算
  assert.equal(hits(`{ "${FAKE.group}": { "seq": 1 } }`, 'qq-context', 'state/groups.json'), 1)
})

test('qq-context：假号、连号、日期、端口、时间戳、哈希、没上下文的都不算', () => {
  assert.equal(hits("const OWNER_QQ = '10001'", 'qq-context'), 0)
  assert.equal(hits('group: 30005', 'qq-context'), 0)
  assert.equal(hits('qq: 40123', 'qq-context'), 0)
  assert.equal(hits('qq: 12345678', 'qq-context'), 0)
  assert.equal(hits('qq: 88888888', 'qq-context'), 0)
  assert.equal(hits('群 20261121 的记录', 'qq-context'), 0)
  assert.equal(hits('onebot ws://' + ip(127, 0, 0, 1) + ':' + (25 * 1000 + 592), 'qq-context'), 0)
  assert.equal(hits('chat "ts": 1763698800', 'qq-context'), 0)
  assert.equal(hits('group a1b2c3' + FAKE.qq + 'ff', 'qq-context'), 0)
  assert.equal(hits('size ' + FAKE.qq + ' bytes', 'qq-context'), 0)
  assert.equal(hits('群里提过 #' + (6 * 10000 + 7631), 'qq-context'), 0)
  // 错误码（负数）、sendError 里的 sender、模型表里的 context / output 都不是号码上下文
  assert.equal(hits('sendError(id, -' + (32 * 1000 + 603) + ', "server not initialized")', 'qq-context'), 0)
  assert.equal(hits('{"id":"deepseek-chat","limit":{"context":' + (128 * 1000 + 1) + ',"output":' + (8 * 1000 + 193) + '}}', 'qq-context'), 0)
})

test('qq-context：紧挨着的键名也算上下文', () => {
  assert.equal(hits(`"owner": "${FAKE.qq}"`, 'qq-context'), 1)
  assert.equal(hits(`sender=${FAKE.qq}`, 'qq-context'), 1)
  assert.equal(hits(`chats: ['${FAKE.qq}']`, 'qq-context'), 1)
  assert.equal(hits(`提醒 @${FAKE.qq} 一下`, 'qq-context'), 1)
})

test('讲地址段、公开常量的不算私网地址；示意的单字母用户名不算', () => {
  assert.equal(hits(ip(10, 0, 0, 0) + '/8 and ' + ip(192, 168, 0, 0) + '/16', 'private-ip'), 0)
  assert.equal(hits('fe80' + ':: and fc00' + '::/7 are private ranges', 'private-ip'), 0)
  assert.equal(hits('metadata at ' + ip(169, 254, 169, 254), 'private-ip'), 0)
  assert.equal(hits('metadata.google' + '.internal', 'lan-host'), 0)
  assert.equal(hits('/** 最后一段（`' + ['C:', 'Users', 'x', ''].join('\\') + '` → `x`） */', 'user-path'), 0)
})

test('email：只放 noreply、example.invalid 和保留域名', () => {
  assert.equal(hits(mail('zed.quill', 'gmail.com'), 'email'), 1)
  assert.equal(hits('From: X <' + mail('someone', 'qq.com') + '>', 'email'), 1)
  for (const ok of [mail('noreply', 'github.com'), mail('123+zed', 'users.noreply.github.com'), mail('dev', 'example.invalid'),
    mail('a', 'example.com'), mail('git', 'github.com'), 'react@18.3.1', 'lib@index.mjs']) {
    assert.equal(hits(ok, 'email'), 0, ok)
  }
})

test('secret：像密钥的串；明显是假的不算', () => {
  assert.equal(hits('key = "sk-' + randomAlnum(48) + '"', 'secret'), 1)
  assert.equal(hits('ghp_' + randomAlnum(36), 'secret'), 1)
  assert.equal(hits('apiKey: "' + randomAlnum(40) + '"', 'secret'), 1)
  assert.equal(hits('Authorization: Bearer ' + randomAlnum(40), 'secret') >= 1, true)
  assert.equal(hits('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'secret'), 1)
  assert.equal(hits('sk-test-' + '0'.repeat(30), 'secret'), 0)
  assert.equal(hits('apiKey: process.env.SILICONFLOW_API_KEY', 'secret'), 0)
  assert.equal(hits('token: "${TOKEN_FROM_ENV_PLACEHOLDER}"', 'secret'), 0)
  assert.equal(hits('password = "changeme-changeme-changeme"', 'secret'), 0)
  assert.equal(hits('tokenPath: lib/some/module/path.mjs', 'secret'), 0)
})

test('line-sep、crlf、binary、oversize', () => {
  assert.equal(hits('a' + String.fromCharCode(0x2028) + 'b', 'line-sep'), 1)
  assert.equal(hits('a\r\nb\r\n', 'crlf', 'x.mjs'), 1)
  assert.equal(hits('a\r\nb\r\n', 'crlf', 'run.cmd'), 0)
  assert.equal(hits('abc\u0000def', 'binary', 'x.dat'), 1)
  assert.equal(hits('not really', 'binary', 'logo.png'), 1)
  const big = 'x'.repeat(2048)
  const sc = createScanner({ config: makeConfig({ maxBytes: 1024 }) })
  sc.scanFile('big.txt', Buffer.from(big))
  assert.deepEqual(sc.result().findings.map((f) => f.rule), ['oversize'])
  const sc2 = createScanner({ config: makeConfig({ maxBytes: 1024, allowLarge: ['big.txt'] }) })
  sc2.scanFile('big.txt', Buffer.from(big))
  assert.equal(sc2.result().findings.length, 0)
})

test('路径名本身也扫', () => {
  const sc = createScanner({ config })
  sc.scanFile(`sessions/onebot-private-${FAKE.qq}/a.txt`, Buffer.from('ok'))
  assert.deepEqual(sc.result().findings.map((f) => [f.rule, !!f.inPathName]), [['qq-context', true]])
})

test('配置里的 allow 只放过公开规则的那一条', () => {
  const sc = createScanner({ config: makeConfig({ allow: [{ path: 'docs/**', rule: 'private-ip', reason: '示例' }] }) })
  sc.scanFile('docs/net.md', Buffer.from('http://' + ip(192, 168, 1, 2) + ' ' + mail('zed', 'gmail.com')))
  const r = sc.result()
  assert.deepEqual(r.findings.map((f) => f.rule), ['email'])
  assert.equal(r.stats.suppressed, 1)
  assert.throws(() => makeConfig({ allow: [{ path: 'x', rule: 'email' }] }), /reason/)
  assert.throws(() => makeConfig({ bogus: 1 }), /认不出的键/)
})

test('报告里没有命中的字', () => {
  const sc = createScanner({ config })
  const text = `owner qq ${FAKE.qq} at ${winHome()} ${mail('zed.quill', 'gmail.com')}`
  sc.scanFile('a.md', Buffer.from(text))
  const out = JSON.stringify(sc.result())
  assert.ok(!out.includes(FAKE.qq))
  assert.ok(!out.includes(FAKE.user))
  assert.ok(!out.includes('gmail'))
})
