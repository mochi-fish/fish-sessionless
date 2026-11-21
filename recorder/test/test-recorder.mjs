// 录制器的离线测试：假 OneBot（最小的 WebSocket 服务端）+ 假媒体服务器，全在 127.0.0.1，不连任何真的 OneBot。
// 用法：node test/test-recorder.mjs [临时目录]
//   不给就在系统临时目录里新建一个，跑完删掉；给的话要在系统临时目录下面、名字以 recorder-test- 开头（会先清空）。
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { start, isPrivateAddr, fromDshProfile, localDay, loadRawForward } from '../recorder.mjs'
/** 私网地址在运行时拼，源码里不写死 */
const ip = (...p) => p.join('.')
const fwdDir = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 16)
const OWN_TMP = !process.argv[2]
const TMP = OWN_TMP ? mkdtempSync(join(tmpdir(), 'recorder-test-')) : resolve(process.argv[2])
if (!OWN_TMP) {
  const t = resolve(tmpdir())
  if (!TMP.startsWith(t + sep) || !basename(TMP).startsWith('recorder-test-')) { console.error('临时目录要在 ' + t + ' 下面、名字以 recorder-test- 开头'); process.exit(2) }
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
}

let pass = 0, fail = 0
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra ?? '') } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000, name = '') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await sleep(50) }
  console.log('  (等超时)', name)
  return false
}

// ---------- 纯函数 ----------
ok([ip(10, 1, 2, 3), ip(172, 16, 0, 9), ip(172, 31, 255, 1), ip(192, 168, 7, 8), '127.0.0.1', ip(169, 254, 1, 1), ip(100, 64, 0, 1), '0.0.0.0', '224.0.0.1'].every(isPrivateAddr), 'a1 v4 内网、回环、链路本地、CGNAT、组播都认得')
ok(!isPrivateAddr('203.0.113.5') && !isPrivateAddr('8.8.8.8') && !isPrivateAddr(ip(172, 32, 0, 1)) && !isPrivateAddr(ip(172, 15, 0, 1)), 'a2 v4 公网放行（172.16/12 两边的不算内网）')
ok(isPrivateAddr('::1') && isPrivateAddr(['fd00', '', '1'].join(':')) && isPrivateAddr(['fe80', '', '1'].join(':')) && isPrivateAddr('::ffff:127.0.0.1') && isPrivateAddr('::ffff:' + ip(10, 0, 0, 1)) && !isPrivateAddr('2001:db8::1'.replace('db8', '4860')), 'a3 v6')
ok(isPrivateAddr('not-an-ip'), 'a4 不是 IP 的一律当内网')
{
  const y = join(TMP, 'cordis.patch.yml')
  writeFileSync(y, [
    '- id: something-else', '  config:', '    url: ws://wrong:1', '    accessToken: nope',
    '- id: dsh-onebot', '  name: "dsh-onebot-qq"', '  config:', '    mode: forward', '    url: ws://onebot.example:4002', '    accessToken: "tok-123"', '    adminUsers:', '      - "1"',
    '- id: better-sidebar', '  config:', '    url: ws://after:2',
  ].join('\r\n'))
  const d = fromDshProfile(y)
  ok(d.url === 'ws://onebot.example:4002' && d.accessToken === 'tok-123', 'a5 从 cordis.patch.yml 只取 dsh-onebot 那一项', JSON.stringify(d))
  ok(JSON.stringify(fromDshProfile(join(TMP, 'none.yml'))) === '{}', 'a6 没有文件就是空')
}
ok(/^\d{4}-\d{2}-\d{2}$/.test(localDay(Date.now())), 'a7 日期格式')

// ---------- 假媒体服务器 ----------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body-1')])
const GIF = Buffer.from('GIF89a-gif-body')
const ZIP = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('zip-body')])
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from('mp3-body')])
const SILK = Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3 body')])
const BIG = Buffer.alloc(5000, 1)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const hits = {}
const media = createServer((req, res) => {
  const path = req.url.split('?')[0]
  hits[path] = (hits[path] ?? 0) + 1
  const send = (b, type) => { res.writeHead(200, { 'content-type': type, 'content-length': b.length }); res.end(b) }
  if (path === '/img1') return send(PNG, 'image/jpeg') // 类型故意写错，要按内容认
  if (path === '/img2') return send(GIF, 'image/gif')
  if (path === '/redir') { res.writeHead(302, { location: '/img1' }); return res.end() }
  if (path === '/file.zip') return send(ZIP, 'application/octet-stream')
  if (path === '/voice') return send(SILK, 'application/octet-stream')
  if (path === '/big') return send(BIG, 'application/octet-stream')
  if (path === '/chunked-big') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(BIG.subarray(0, 2500)); setTimeout(() => res.end(BIG.subarray(2500)), 20); return }
  res.writeHead(404); res.end()
})
await new Promise((r) => media.listen(0, '127.0.0.1', r))
const M = `http://127.0.0.1:${media.address().port}`

// ---------- 假 OneBot：最小 WebSocket 服务端 ----------
const conns = []
const sentRaw = []        // 服务端发出去的事件帧原文（文本）
const sentBin = []
const apiReqs = []        // 收到的接口请求（解析后）
const apiResp = new Map() // echo → 回包原文
function frame(op, payload) {
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | op, len])
    : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b })()
  return Buffer.concat([head, payload])
}
const ob = createServer((req, res) => { res.writeHead(404); res.end() })
ob.on('upgrade', (req, sock) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const c = {
    auth: req.headers.authorization, sock, closed: false,
    text(s) { sock.write(frame(1, Buffer.from(s, 'utf8'))) },
    event(s) { sentRaw.push(s); this.text(s) },
    bin(b) { sentBin.push(b); sock.write(frame(2, b)) },
    close(code) { const p = Buffer.alloc(2); p.writeUInt16BE(code); sock.write(frame(8, p)); setTimeout(() => sock.end(), 50) },
  }
  conns.push(c)
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      const op = buf[0] & 15
      let len = buf[1] & 127, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const masked = (buf[1] & 128) !== 0
      if (buf.length < off + (masked ? 4 : 0) + len) return
      const mask = masked ? buf.subarray(off, off + 4) : null
      off += masked ? 4 : 0
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(off + len)
      if (op === 8) { if (!c.closed) { c.closed = true; sock.write(frame(8, payload.subarray(0, 2))); setTimeout(() => sock.end(), 20) } continue }
      if (op === 9) { sock.write(frame(10, payload)); continue }
      if (op === 1) onApi(c, JSON.parse(payload.toString('utf8')))
    }
  })
  sock.on('error', () => {})
  sock.on('close', () => { c.closed = true })
  c.text(JSON.stringify({ time: 1, self_id: 10001, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }))
  sentRaw.push(JSON.stringify({ time: 1, self_id: 10001, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }))
})
const API = {
  get_login_info: () => ({ user_id: 10001, nickname: 'bot' }),
  get_version_info: () => ({ app_name: 'Fake', protocol_version: 'v11' }),
  get_status: () => ({ online: true, good: true }),
  get_friend_list: () => [{ user_id: 30001, nickname: 'f' }],
  get_group_list: () => [{ group_id: 20011 }, { group_id: 20022 }],
  get_group_member_list: (p) => [{ group_id: p.group_id, user_id: 30001 }],
  get_forward_msg: (p) => p.id === 'F1'
    ? { messages: [{ type: 'node', data: { user_id: 30005, nickname: 'n', content: [{ type: 'image', data: { url: M + '/img2' } }, { type: 'forward', data: { id: 'F2' } }] } }] }
    : p.id === 'F2' ? { messages: [{ type: 'node', data: { user_id: 30006, nickname: 'm', content: [{ type: 'image', data: { url: M + '/img1' } }, { type: 'forward', data: { id: 'F1' } }] } }] }
    : null,
  get_msg: (p) => p.message_id === 900 ? { message_id: 900, group_id: 20011, message: [{ type: 'image', data: { url: M + '/redir' } }, { type: 'reply', data: { id: '899' } }] } : null,
  get_group_file_url: (p) => ({ url: M + '/file.zip?f=' + p.file_id }),
  get_private_file_url: () => ({ url: M + '/voice' }),
  get_record: () => ({ base64: MP3.toString('base64') }),
}
function onApi(c, req) {
  apiReqs.push(req)
  const fn = API[req.action]
  const data = fn ? fn(req.params ?? {}) : null
  const resp = data === null
    ? `{"status":"failed","retcode":1404,"data":null,"message":"不支持","echo":${JSON.stringify(req.echo)}}`
    : JSON.stringify({ status: 'ok', retcode: 0, data, message: '', echo: req.echo }).replace('"status":"ok"', '"status" : "ok"') // 故意带空格，验原样
  apiResp.set(req.echo, resp)
  setTimeout(() => { if (!c.closed) c.text(resp) }, 5)
}
await new Promise((r) => ob.listen(0, '127.0.0.1', r))
const URL_ = `ws://127.0.0.1:${ob.address().port}`

// ---------- 外挂的整包展开模块 ----------
{
  let e1 = null
  try { await loadRawForward(null) } catch (e) { e1 = e }
  ok(/rawForwardModule/.test(String(e1?.message)), 'j1 rawForward 开着而没给模块 → 报错，说要给 rawForwardModule')
  const half = join(TMP, 'half.mjs')
  writeFileSync(half, 'export function forwardDirName () {}\nexport function titleOf () {}\n')
  let e2 = null
  try { await loadRawForward(half) } catch (e) { e2 = e }
  ok(/selfUidOf/.test(String(e2?.message)) && /expandForward/.test(String(e2?.message)), 'j2 模块缺导出 → 报错，列出缺的')
  let e3 = null
  try { await start({ url: 'ws://127.0.0.1:1', dataDir: join(TMP, 'never'), quiet: true, expand: { rawForward: true } }) } catch (e) { e3 = e }
  ok(/rawForwardModule/.test(String(e3?.message)) && !existsSync(join(TMP, 'never', '.recorder.lock')), 'j3 start 时就报错、不留锁')
}
// 桩：照接口写的最小实现。F9 故意失败。
const STUB = join(TMP, 'stub-forward.mjs')
writeFileSync(STUB, [
  "import { createHash } from 'node:crypto'",
  "import { mkdirSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "export const forwardDirName = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 16)",
  "export async function selfUidOf (call) { const r = await call('get_login_info', {}); return 'u_' + r?.data?.user_id }",
  "export const titleOf = (ref) => '转发 ' + (ref?.message_id ?? '?')",
  "export async function expandForward ({ call, resId, dataDir, ref, selfUid, title }) {",
  "  if (resId === 'F9') throw new Error('stub: cannot expand ' + resId)",
  "  const r = await call('get_forward_msg', { id: resId })",
  "  const dir = join(dataDir, 'forward', forwardDirName(resId))",
  "  mkdirSync(dir, { recursive: true })",
  "  writeFileSync(join(dir, 'expanded.json'), JSON.stringify({ resId, ref, selfUid, title, got: r?.status ?? null }))",
  "  return { messages: 2 }",
  "}",
  '',
].join('\n'))

// ---------- 开录 ----------
const dataDir = join(TMP, 'archive')
const rec = await start({
  url: URL_, accessToken: 'test-token', dataDir, dshProfile: join(TMP, 'none.yml'), quiet: true, statusEveryMin: 0,
  expand: { rawForward: true, rawForwardModule: STUB },
  snapshot: { gapMs: 10 },
  media: { hosts: ['127.0.0.1'], allowPrivate: true, maxBytes: 1000 },
})
ok(await until(() => conns.length === 1), 'b1 连上了')
ok(conns[0].auth === 'Bearer test-token', 'b2 口令放在 Authorization 头里', conns[0].auth)

let lockErr = null
try { await start({ url: URL_, accessToken: 'x', dataDir, quiet: true }) } catch (e) { lockErr = e }
ok(lockErr?.code === 'LOCKED', 'b3 同一个目录开第二个录制器会被拒')

ok(await until(() => apiReqs.filter((r) => r.action === 'get_group_member_list').length === 2), 'b4 连上就拍快照，两个群的成员列表都取了')

const c0 = conns[0]
const weird = '{"post_type":"message","message_type":"group","sub_type":"normal","message_id":1,"group_id":20011,"user_id":30007,"time":2,"self_id":10001,  "message":[{"type":"text","data":{"text":"原样\\u2028😀 \\"引号\\""}}],"raw_message":"x","font":0,"sender":{"user_id":30007,"nickname":"甲"}}'
c0.event(weird)
c0.event(JSON.stringify({ time: 3, self_id: 10001, post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true } }))
c0.event(JSON.stringify({
  time: 4, self_id: 10001, post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: 2, group_id: 20011, user_id: 30008,
  message: [
    { type: 'text', data: { text: 'hi' } },
    { type: 'image', data: { file: 'a.png', url: M + '/img1', summary: '' } },
    { type: 'image', data: { file: 'evil.png', url: 'http://evil.example/x.png' } },
    { type: 'image', data: { file: 'big.png', url: M + '/big' } },
    { type: 'image', data: { file: 'big2.png', url: M + '/chunked-big' } },
    { type: 'reply', data: { id: '900' } },
    { type: 'forward', data: { id: 'F1' } },
    { type: 'file', data: { file: 'a.zip', file_id: 'fid1', file_size: '8' } },
    { type: 'file', data: { file: 'huge.iso', file_id: 'fid-huge', file_size: 999999999 } },
    { type: 'record', data: { file: 'abc.amr' } },
    { type: 'video', data: { file: 'x.mp4' } },
    { type: 'json', data: { data: '{"app":"com.tencent.x","meta":{"url":"http://evil.example/card"}}' } },
  ],
  raw_message: '…', font: 0, sender: { user_id: 30008, nickname: '乙' },
}))
c0.event('这不是 JSON')
c0.bin(Buffer.from([0, 1, 2, 255]))
c0.event(JSON.stringify({ time: 5, self_id: 10001, post_type: 'notice', notice_type: 'group_upload', group_id: 20022, user_id: 30009, file: { id: 'fid2', name: 'b.zip', size: 8, busid: 102 } }))
c0.event(JSON.stringify({ time: 6, self_id: 10001, post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 3, user_id: 30009, message: [{ type: 'forward', data: { id: 'F9' } }, { type: 'file', data: { file: 'v.silk', file_id: 'fid3' } }, { type: 'record', data: { file: 'r.silk', url: M + '/voice' } }], sender: { user_id: 30009 } }))
c0.event(JSON.stringify({ time: 7, self_id: 10001, post_type: 'request', request_type: 'friend', user_id: 30010, comment: 'hello', flag: 'f1' }))

const idxFile = () => join(dataDir, 'media', 'index', localDay(Date.now()) + '.jsonl')
const idx = () => existsSync(idxFile()) ? readFileSync(idxFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
// 期望的媒体条目：img1、evil、big、chunked-big、file fid1、huge、record、video、F1 里的 img2、F2 里的 img1（同网址，去重不再下）、get_msg 里的 redir、fid2、fid3、voice url
ok(await until(() => idx().length >= 12, 15000, 'idx'), 'c0 媒体活都做完了', idx().length)
await sleep(300)

// ---------- 断开重连 ----------
c0.close(1001)
ok(await until(() => conns.length === 2 && !conns[1].closed), 'd1 被断开以后自己重连')
ok(conns[1].auth === 'Bearer test-token', 'd2 重连也带口令')
await sleep(200)
conns[1].event(JSON.stringify({ time: 8, self_id: 10001, post_type: 'message', message_type: 'group', message_id: 4, group_id: 20011, user_id: 30007, message: [{ type: 'text', data: { text: 'after' } }] }))
await sleep(300)
await rec.stop()

// ---------- 查盘上 ----------
const day = localDay(Date.now())
const evLines = readFileSync(join(dataDir, 'events', day + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const raws = evLines.filter((l) => 'raw' in l).map((l) => l.raw)
ok(JSON.stringify(raws) === JSON.stringify(sentRaw), 'e1 每一帧事件按顺序、逐字原样存下', `${raws.length} vs ${sentRaw.length}`)
ok(raws.includes(weird), 'e2 多余空格、\\u2028 转义、表情、引号都没被改写')
ok(evLines.some((l) => l.b64 === Buffer.from([0, 1, 2, 255]).toString('base64')), 'e3 二进制帧存成 base64')
const recs = evLines.filter((l) => l.rec).map((l) => l.rec).join(',')
ok(recs === 'start,open,close,open,close,stop', 'e4 录制器自己的开始 / 连上 / 断开 / 停止都记了（停的时候自己断开那次也记）', recs)
ok(evLines.every((l) => typeof l.t === 'number'), 'e5 每行都有收到的时间')
ok(!readFileSync(join(dataDir, 'events', day + '.jsonl'), 'utf8').includes('test-token'), 'e6 口令不进盘')

const apiLines = readFileSync(join(dataDir, 'api', day + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const calls = (a) => apiLines.filter((l) => l.req?.action === a)
const fwdCalls = calls('get_forward_msg').filter((l) => l.why === 'forward')
ok(fwdCalls.length === 3 && fwdCalls.map((l) => l.req.params.id).sort().join() === 'F1,F2,F9', 'f1 合并转发连套娃一起展开、F2 里回指 F1 不再取', fwdCalls.map((l) => l.req.params.id).join())
ok(calls('get_msg').length === 1 && calls('get_msg')[0].req.params.message_id === 900, 'f2 被引用的原消息取了一次（只一层，899 不取）')
ok(calls('get_group_file_url').length === 2 && calls('get_group_file_url').some((l) => l.req.params.group_id === 20022 && l.req.params.busid === 102), 'f3 群文件：消息里的和上传通知里的都取了直链')
ok(!calls('get_group_file_url').some((l) => l.req.params.file_id === 'fid-huge'), 'f4 超过上限的文件不去取')
ok(calls('get_private_file_url').length === 1, 'f5 私聊文件走 get_private_file_url')
ok(calls('get_record').length === 1, 'f6 没网址的语音走 get_record')
ok(calls('get_login_info').filter((l) => l.why === 'connect').length === 1 && calls('get_group_list').length === 1, 'f7 快照只拍一次（重连没再拍）')
ok(apiLines.filter((l) => l.raw).every((l) => l.raw === apiResp.get(l.req.echo)), 'f8 接口回包逐字原样存下')
ok(apiLines.every((l) => l.raw || l.err), 'f9 每次调用不是有回包就是有原因')
ok(fwdCalls.filter((l) => l.req.params.id !== 'F9').every((l) => l.ref?.message_id === 2) && fwdCalls.find((l) => l.req.params.id === 'F9')?.ref?.message_id === 3, 'f10 接口记录带着是哪条消息引起的')

const ix = idx()
const by = (pred) => ix.filter(pred)
ok(by((e) => e.url === M + '/img1' && e.from === 'event' && e.ok && e.sha256 === sha(PNG) && e.path.endsWith('.png')).length === 1, 'g1 图片下了，按内容认成 png、sha 对')
ok(hits['/img1'] === 2, 'g2 同一个网址只下一次（第二次是 redir 跳过来的）', hits['/img1'])
ok(by((e) => e.url === M + '/redir' && e.ok && e.dup && e.sha256 === sha(PNG) && e.from === 'reply').length === 1, 'g3 跳转跟了、内容重复只存一份、来源记成 reply')
ok(by((e) => e.url === M + '/img2' && e.ok && e.from === 'forward' && e.ref?.forward === 'F1' && e.path.endsWith('.gif')).length === 1, 'g4 合并转发里的图也下了')
ok(by((e) => e.url === 'http://evil.example/x.png' && !e.ok && /名单/.test(e.err)).length === 1, 'g5 不在名单里的域名不下')
ok(!hits['/big'] || by((e) => e.url === M + '/big' && !e.ok && /太大/.test(e.err)).length === 1, 'g6 声明太大的不下')
ok(by((e) => e.url === M + '/chunked-big' && !e.ok && /太大/.test(e.err)).length === 1, 'g7 没声明长度、下着下着超了也停')
ok(by((e) => e.seg === 'file' && e.file_id === 'fid1' && e.ok && e.sha256 === sha(ZIP) && e.path.endsWith('.zip')).length === 1, 'g8 群文件下了')
ok(by((e) => e.seg === 'group_upload' && e.ok && e.dup).length === 1, 'g9 上传通知的文件也下了（内容相同只存一份）')
ok(by((e) => e.seg === 'file' && /太大/.test(e.err ?? '') && e.name === 'huge.iso').length === 1, 'g10 太大的文件记一笔')
ok(by((e) => e.seg === 'record' && e.ok && e.path.endsWith('.mp3') && e.sha256 === sha(MP3)).length === 1, 'g11 get_record 回的 base64 存成 mp3')
ok(by((e) => e.seg === 'record' && e.ok && e.path.endsWith('.silk') && e.sha256 === sha(SILK)).length >= 1, 'g12 带网址的语音原样下（silk）')
ok(hits['/voice'] === 1 && by((e) => e.url === M + '/voice' && e.ok && e.sha256 === sha(SILK)).length === 2 && by((e) => e.url === M + '/voice' && e.sameUrl).length === 1,
  'g12b 私聊文件和语音段指向同一个网址：只下一次，两处都进索引', JSON.stringify(by((e) => e.url === M + '/voice')))
ok(by((e) => e.url === M + '/img1' && e.from === 'forward' && e.sameUrl && e.ok).length === 1, 'g12c 转发里重复的图也进索引（不再下）')
ok(by((e) => e.seg === 'video' && !e.ok).length === 1, 'g13 没网址的视频记一笔')
ok(!Object.keys(hits).some((k) => k.includes('card')), 'g14 卡片里的网址不碰')
for (const e of ix.filter((x) => x.ok)) {
  const p = join(dataDir, 'media', e.path)
  if (!existsSync(p) || sha(readFileSync(p)) !== e.sha256) { ok(false, 'g15 盘上的文件和 sha 对得上', e.path); break }
}
ok(true, 'g15 盘上的文件和 sha 对得上')
{
  const f1 = join(dataDir, 'forward', fwdDir('F1'))
  const exp = existsSync(join(f1, 'expanded.json')) ? JSON.parse(readFileSync(join(f1, 'expanded.json'), 'utf8')) : null
  ok(exp && exp.resId === 'F1' && exp.ref?.message_id === 2 && exp.selfUid === 'u_10001' && exp.title === '转发 2' && exp.got === 'ok', 'i1 消息里的合并转发交给外挂模块展开（带来源、自己的号、标题）', JSON.stringify(exp))
  ok(!existsSync(join(dataDir, 'forward', fwdDir('F2'))), 'i2 转发里面套的转发不另交（由模块自己处理）')
  ok(calls('get_forward_msg').filter((l) => l.why === 'forward-raw').length === 1 && calls('get_login_info').filter((l) => l.why === 'forward-raw').length === 1, 'i3 模块经录制器的接口调用（记成 forward-raw），自己的号只取一次')
  ok(rec.stats.fwdRaw === 1 && rec.stats.fwdRawFail === 1 && rec.stats.fwdRawMsgs === 2, 'i4 计数（F1 成、F9 败）', JSON.stringify([rec.stats.fwdRaw, rec.stats.fwdRawFail, rec.stats.fwdRawMsgs]))
  const f9 = join(dataDir, 'forward', fwdDir('F9'), 'failed.json')
  const fj = existsSync(f9) ? JSON.parse(readFileSync(f9, 'utf8')) : null
  ok(fj && fj.res_id === 'F9' && /stub: cannot expand/.test(fj.err) && fj.ref?.message_id === 3, 'i5 失败的写 failed.json')
  ok(!existsSync(join(f1, 'failed.json')), 'i6 成功的没有失败记录')
}
ok(readdirSync(join(dataDir, 'media', '.tmp')).length === 0, 'g16 临时文件都清掉了（包括下到一半超限被掐断的）', readdirSync(join(dataDir, 'media', '.tmp')).join())
ok(!existsSync(join(dataDir, '.recorder.lock')), 'h1 停了以后锁放掉了')

// 锁放掉以后能再开，而且旧锁是死进程的也能接着开
writeFileSync(join(dataDir, '.recorder.lock'), JSON.stringify({ pid: 999999 }))
const rec2 = await start({ url: 'ws://127.0.0.1:1', accessToken: 'x', dataDir, quiet: true, statusEveryMin: 0, snapshot: { everyHours: 0 } })
await sleep(200)
await rec2.stop()
ok(true, 'h2 死进程留下的锁不挡')

media.close(); ob.close()
for (const c of conns) c.sock.destroy()
if (OWN_TMP) { try { rmSync(TMP, { recursive: true, force: true }) } catch {} }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
