#!/usr/bin/env node
// OneBot v11 全量录制。
// 以「又一个客户端」连 OneBot 的正向 WebSocket（不碰别的客户端那条连接），收到的每一帧原样存盘；
// 顺带把事件里拿不全的东西用接口补齐（合并转发的内容、被引用的原消息、图片 / 语音 / 视频 / 文件本体、
// 好友和群的名单快照），接口的回包同样原样存。
//
// 盘上的样子（dataDir 下面，日期按本机时区）：
//   events/YYYY-MM-DD.jsonl  一行一帧：{"t":收到的毫秒,"raw":"那一帧的原文"}；二进制帧是 {"t":…,"b64":…}；
//                            录制器自己的连上 / 断开记成 {"t":…,"rec":"open"|"close"|"start"|"stop",…}，看得出空档
//   api/YYYY-MM-DD.jsonl     一行一次调用：{"t":发出,"t2":收到,"why":…,"ref":…,"req":{action,params,echo},"raw":"回包原文"}，
//                            没回来的是 {"…","err":"timeout"|"closed"|"not-connected"}
//   media/<sha 前两位>/<sha256>.<ext>   按内容寻址，同一个文件只存一份
//   media/index/YYYY-MM-DD.jsonl       哪条消息的哪一段对应哪个文件、没下成的原因
//
// 用法见同目录 README.md。也能当模块用：import { start } from './recorder.mjs'。

import { openSync, writeSync, closeSync, mkdirSync, readFileSync, existsSync, renameSync, unlinkSync, readdirSync, createWriteStream } from 'node:fs'
import { join, extname, dirname, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DEFAULTS = Object.freeze({
  url: null,                 // ws://host:port；也可以用环境变量 ONEBOT_URL、命令行 --url
  accessToken: null,         // 也可以用环境变量 ONEBOT_TOKEN
  dshProfile: null,          // 可选：DSH 的 cordis.patch.yml 路径；给了而 url / accessToken 没给，就从里面 dsh-onebot 那一项现读
  dataDir: join(homedir(), 'onebot-archive'),
  heartbeat: true,           // 心跳帧也存（全量）；false 就只数不存
  apiTimeoutMs: 30_000,
  apiConcurrency: 2,
  snapshot: {
    onConnect: true,         // 连上就拍一次：登录号、版本、状态、好友列表、群列表
    minGapMin: 10,           // 频繁重连时，离上次快照不到这么久就不拍
    everyHours: 24,          // 之后每隔这么久再拍
    memberLists: true,       // 每个群的成员列表（一个群一次调用，中间隔 gapMs）
    gapMs: 1500,
  },
  expand: {
    forward: true,           // 合并转发：get_forward_msg，套娃的也展开
    rawForward: false,       // 合并转发另用你自己的模块整包展开（有的 OneBot 实现 get_forward_msg 拿不到内层），结果在 forward/，见 README
    rawForwardModule: null,  // 那个模块的路径（rawForward 为 true 时必须给）；要导出 forwardDirName、selfUidOf、expandForward、titleOf
    replied: true,           // 引用：get_msg 把被引用的原消息存下来（只展开一层）
    maxDepth: 4,
  },
  media: {
    enabled: true,
    maxBytes: 100 * 1024 * 1024,   // 单个文件上限，超过的只记一笔不下
    concurrency: 3,
    timeoutMs: 180_000,
    queueMax: 5000,
    // 消息段里带的网址只从这些域名（含子域名）下；接口回的直链（群文件等）不看域名，只挡内网地址
    hosts: ['qq.com', 'qpic.cn', 'qq.com.cn', 'qlogo.cn', 'gtimg.cn'],
    allowPrivate: false,     // true 才允许下内网 / 回环地址（只给测试用）
    fetchFiles: true,        // 群文件、私聊文件也下（受 maxBytes 限制）
  },
  statusEveryMin: 10,        // 每隔多久在控制台打一行计数（不打任何正文）；0 不打
  quiet: false,
})

// ---------- 小工具 ----------

function deepMerge(base, over) {
  if (over === undefined || over === null) return structuredClone(base)
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    out[k] = (k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) && typeof v === 'object' && v !== null && !Array.isArray(v))
      ? deepMerge(base[k], v) : v
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')
export function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 按天切文件、一直开着 fd 的追加写。 */
class DayLog {
  constructor(dir) { this.dir = dir; this.day = null; this.fd = null }
  write(obj) {
    const day = localDay(obj.t ?? Date.now())
    if (day !== this.day) {
      if (this.fd !== null) closeSync(this.fd)
      mkdirSync(this.dir, { recursive: true })
      this.fd = openSync(join(this.dir, `${day}.jsonl`), 'a')
      this.day = day
    }
    writeSync(this.fd, JSON.stringify(obj) + '\n')
  }
  close() { if (this.fd !== null) closeSync(this.fd); this.fd = null; this.day = null }
}

function limiter(n) {
  let active = 0
  const q = []
  const next = () => {
    while (active < n && q.length) {
      const { fn, res, rej } = q.shift()
      active++
      Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next() })
    }
  }
  const run = (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next() })
  run.pending = () => q.length + active
  return run
}

/** 记过的编号（有上限，旧的先忘）。 */
class SeenSet {
  constructor(max = 20000) { this.max = max; this.m = new Map() }
  add(k) {
    if (this.m.has(k)) return false
    this.m.set(k, 1)
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value)
    return true
  }
}

/** 从 DSH 的 cordis.patch.yml 里找 dsh-onebot 那一项的 url 和 accessToken（只认这一项，不解析整份 yaml）。 */
export function fromDshProfile(file) {
  if (!file || !existsSync(file)) return {}
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*-\s*id:\s*["']?dsh-onebot["']?\s*$/.test(l))
  if (start < 0) return {}
  const indent = lines[start].indexOf('-')
  const out = {}
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*-\s/.test(l) && l.indexOf('-') <= indent) break
    const m = /^\s+(url|accessToken):\s*(.*?)\s*$/.exec(l)
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

// ---------- 下载的门 ----------

function v4Private(ip) {
  const p = ip.split('.').map(Number)
  const [a, b] = p
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && p[2] === 0)
}
export function isPrivateAddr(ip) {
  const kind = isIP(ip)
  if (kind === 4) return v4Private(ip)
  if (kind === 6) {
    const s = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (mapped) return v4Private(mapped[1])
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s)
  }
  return true
}

function hostAllowed(host, suffixes) {
  const h = host.toLowerCase().replace(/\.$/, '')
  return suffixes.some((s) => h === s || h.endsWith('.' + s))
}

// ---------- 文件类型 ----------

const CTYPE_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
  'audio/mpeg': '.mp3', 'audio/amr': '.amr', 'audio/silk': '.silk', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'video/mp4': '.mp4', 'video/quicktime': '.mov',
}
function sniffExt(head) {
  const s = (a, b) => head.subarray(a, b).toString('latin1')
  if (s(0, 3) === 'GIF') return '.gif'
  if (head[0] === 0x89 && s(1, 4) === 'PNG') return '.png'
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg'
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return '.webp'
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return '.wav'
  if (s(0, 2) === 'BM') return '.bmp'
  if (s(0, 12).includes('#!SILK')) return '.silk'
  if (s(0, 5) === '#!AMR') return '.amr'
  if (s(4, 8) === 'ftyp') return '.mp4'
  if (s(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return '.mp3'
  if (s(0, 4) === 'PK\x03\x04') return '.zip'
  if (s(0, 4) === '%PDF') return '.pdf'
  return null
}
export function pickExt(head, ctype, name) {
  const fromName = name ? extname(String(name)).toLowerCase() : ''
  return sniffExt(head)
    ?? (/^\.[a-z0-9]{1,8}$/.test(fromName) ? fromName : null)
    ?? CTYPE_EXT[String(ctype ?? '').split(';')[0].trim().toLowerCase()]
    ?? '.bin'
}

// ---------- 合并转发整包展开（可选的外挂模块） ----------

const RAW_FORWARD_EXPORTS = ['forwardDirName', 'selfUidOf', 'expandForward', 'titleOf']
/**
 * 读用户自己给的整包展开模块。本仓库不带这样的模块：它要照某个 OneBot 实现的私有协议定义去解包，
 * 那些定义的许可各不相同，由使用者自己准备。接口见 README「合并转发：外挂整包展开」。
 */
export async function loadRawForward(modPath) {
  if (!modPath) throw new Error('expand.rawForward 开着，但没给 expand.rawForwardModule（整包展开模块的路径）')
  const m = await import(pathToFileURL(resolvePath(String(modPath))).href)
  const miss = RAW_FORWARD_EXPORTS.filter((k) => typeof m[k] !== 'function')
  if (miss.length) throw new Error('rawForwardModule 缺这几个导出：' + miss.join('、'))
  return m
}

// ---------- 主体 ----------

/**
 * 开始录。返回 { stop(), stats, done }。
 * @param {object} userCfg 见 DEFAULTS
 */
export async function start(userCfg = {}) {
  const cfg = deepMerge(DEFAULTS, userCfg)
  let tokenFrom = cfg.accessToken ? '配置' : '无'
  if (!cfg.url || cfg.accessToken === null) {
    const d = fromDshProfile(cfg.dshProfile)
    if (!cfg.url && d.url) cfg.url = d.url
    if (cfg.accessToken === null && d.accessToken) { cfg.accessToken = d.accessToken; tokenFrom = 'DSH 的 cordis.patch.yml' }
  }
  if (!cfg.url) throw new Error('没有 OneBot 地址：给 url（config.json、--url 或环境变量 ONEBOT_URL），或者让 dshProfile 指到有 dsh-onebot 那一项的 cordis.patch.yml')
  // 外挂模块先读（读不了就报错），再拿锁：报错时不留锁
  const fx = cfg.expand.rawForward ? await loadRawForward(cfg.expand.rawForwardModule) : null
  const shownUrl = (() => { try { const u = new URL(cfg.url); u.search = ''; u.username = ''; u.password = ''; return u.href } catch { return '(地址解析不了)' } })()

  const dataDir = resolvePath(cfg.dataDir)
  mkdirSync(dataDir, { recursive: true })
  const lockPath = join(dataDir, '.recorder.lock')
  takeLock(lockPath)

  const log = (...a) => { if (!cfg.quiet) console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a) }
  const evLog = new DayLog(join(dataDir, 'events'))
  const apiLog = new DayLog(join(dataDir, 'api'))
  const mediaIdx = new DayLog(join(dataDir, 'media', 'index'))
  const mediaDir = join(dataDir, 'media')
  const tmpDir = join(mediaDir, '.tmp')
  mkdirSync(tmpDir, { recursive: true })
  for (const f of readdirSync(tmpDir)) { try { unlinkSync(join(tmpDir, f)) } catch {} } // 上次没下完的半截

  const stats = {
    frames: 0, message: 0, message_sent: 0, notice: 0, request: 0, meta_event: 0, other: 0, binary: 0,
    heartbeatSkipped: 0, apiOk: 0, apiFail: 0, apiLate: 0,
    mediaOk: 0, mediaDup: 0, mediaFail: 0, mediaSkip: 0, mediaBytes: 0, opens: 0, closes: 0,
    fwdRaw: 0, fwdRawMsgs: 0, fwdRawFail: 0,
  }
  const rawRun = limiter(1)
  const seenRaw = new SeenSet()
  let selfUidP = null

  const ECHO = `obrec-${randomBytes(3).toString('hex')}-`
  let seq = 0
  const pending = new Map()
  const apiRun = limiter(cfg.apiConcurrency)
  const dlRun = limiter(cfg.media.concurrency)
  const seenForward = new SeenSet()
  const seenReply = new SeenSet()
  const seenFile = new SeenSet()
  const seenApiMedia = new SeenSet()  // 已经为它调过 get_image / get_record 的 file
  const urlJobs = new Map()           // 网址 → 那一次下载（同一个网址只下一次，各处引用都进索引）
  let ws = null
  let stopping = false
  let backoff = 1000
  let reconnectTimer = null
  let snapshotTimer = null
  let lastSnapshotAt = 0
  let snapshotting = false
  const inflight = new Set()   // 后台在跑的补充活，停的时候等一等
  const track = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p }

  evLog.write({ t: Date.now(), rec: 'start', url: shownUrl, pid: process.pid })
  log(`开始录：${shownUrl}（口令：${tokenFrom}），存到 ${dataDir}`)

  // ---- 接口 ----
  function api(action, params, meta = {}) {
    return apiRun(() => new Promise((resolve) => {
      const t = Date.now()
      const echo = ECHO + (++seq)
      const req = { action, params, echo }
      if (!ws || ws.readyState !== 1) {
        apiLog.write({ t, ...meta, req, err: 'not-connected' }); stats.apiFail++
        return resolve(null)
      }
      const timer = setTimeout(() => {
        pending.delete(echo)
        apiLog.write({ t, ...meta, req, err: 'timeout' }); stats.apiFail++
        resolve(null)
      }, cfg.apiTimeoutMs)
      pending.set(echo, { t, req, meta, timer, resolve })
      try { ws.send(JSON.stringify(req)) } catch (e) {
        clearTimeout(timer); pending.delete(echo)
        apiLog.write({ t, ...meta, req, err: 'send: ' + (e?.message ?? e) }); stats.apiFail++
        resolve(null)
      }
    }))
  }
  function onApiFrame(j, raw, t2) {
    const p = pending.get(j.echo)
    if (!p) { apiLog.write({ t: t2, late: true, raw }); stats.apiLate++; return }
    pending.delete(j.echo)
    clearTimeout(p.timer)
    apiLog.write({ t: p.t, t2, ...p.meta, req: p.req, raw })
    if (j.status === 'ok' || j.retcode === 0) stats.apiOk++; else stats.apiFail++
    p.resolve(j)
  }
  function failPending(why) {
    for (const [echo, p] of pending) {
      clearTimeout(p.timer)
      apiLog.write({ t: p.t, ...p.meta, req: p.req, err: why }); stats.apiFail++
      p.resolve(null)
      pending.delete(echo)
    }
  }

  // ---- 媒体 ----
  function indexMedia(entry) { mediaIdx.write({ t: Date.now(), ...entry }) }

  async function checkUrl(u, trust) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('不是 http(s)')
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (trust === 'event' && !hostAllowed(host, cfg.media.hosts)) throw new Error('域名不在名单里: ' + host)
    if (cfg.media.allowPrivate) return
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
    if (addrs.length === 0 || addrs.some(isPrivateAddr)) throw new Error('内网地址: ' + host)
  }

  async function storeBytes(chunks, name, ctype) {
    const buf = Buffer.concat(chunks)
    const sha = createHash('sha256').update(buf).digest('hex')
    const ext = pickExt(buf.subarray(0, 16), ctype, name)
    return placeFile(sha, ext, buf.length, (dst) => {
      const tmp = join(tmpDir, randomBytes(8).toString('hex'))
      const fd = openSync(tmp, 'w'); writeSync(fd, buf); closeSync(fd)
      renameSync(tmp, dst)
    })
  }
  function placeFile(sha, ext, bytes, write) {
    const rel = `${sha.slice(0, 2)}/${sha}${ext}`
    const dst = join(mediaDir, rel)
    if (existsSync(dst)) { stats.mediaDup++; return { sha256: sha, bytes, path: rel, dup: true } }
    mkdirSync(dirname(dst), { recursive: true })
    write(dst)
    stats.mediaOk++; stats.mediaBytes += bytes
    return { sha256: sha, bytes, path: rel }
  }

  async function fetchToStore(url, trust, name) {
    let cur = new URL(url)
    for (let hop = 0; hop < 4; hop++) {
      await checkUrl(cur, trust)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('超时')), cfg.media.timeoutMs)
      try {
        const res = await fetch(cur, { redirect: 'manual', signal: ac.signal })
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel()
          cur = new URL(res.headers.get('location'), cur)
          continue
        }
        if (!res.ok) { await res.body?.cancel(); throw new Error('http ' + res.status) }
        const len = Number(res.headers.get('content-length') ?? NaN)
        if (Number.isFinite(len) && len > cfg.media.maxBytes) { await res.body?.cancel(); throw Object.assign(new Error('太大: ' + len), { skip: true }) }
        const ctype = res.headers.get('content-type')
        const tmp = join(tmpDir, randomBytes(8).toString('hex'))
        const hash = createHash('sha256')
        // 文件是异步打开的：不管成败，都等它真的关上再改名 / 删，不然会留下半截
        const out = createWriteStream(tmp)
        const closed = new Promise((r) => out.once('close', r))
        let werr = null
        out.on('error', (e) => { werr = e })
        let bytes = 0
        let head = Buffer.alloc(0)
        try {
          for await (const chunk of res.body) {
            if (werr) throw werr
            const b = Buffer.from(chunk)
            bytes += b.length
            if (bytes > cfg.media.maxBytes) { ac.abort(); throw Object.assign(new Error('太大: 超过 ' + cfg.media.maxBytes), { skip: true }) }
            if (head.length < 16) head = Buffer.concat([head, b.subarray(0, 16 - head.length)])
            hash.update(b)
            if (!out.write(b)) await Promise.race([new Promise((r) => out.once('drain', r)), closed])
          }
          out.end()
          await closed
          if (werr) throw werr
        } catch (e) {
          out.destroy()
          await closed
          try { unlinkSync(tmp) } catch {}
          throw e
        }
        const sha = hash.digest('hex')
        const ext = pickExt(head, ctype, name)
        const r = placeFile(sha, ext, bytes, (dst) => renameSync(tmp, dst))
        if (r.dup) { try { unlinkSync(tmp) } catch {} }
        return { ...r, ctype }
      } finally { clearTimeout(timer) }
    }
    throw new Error('跳转太多')
  }

  /** 排一件下载活，队列满了直接算跳过。 */
  function dl(job) {
    if (dlRun.pending() >= cfg.media.queueMax) return Promise.reject(Object.assign(new Error('队列满了，没下'), { skip: true }))
    return dlRun(job)
  }
  /** 下载的结果写进索引；counted 为假时是同一次下载的又一处引用，不重复计数。 */
  function settle(base, p, counted) {
    track(p.then(
      (r) => { indexMedia({ ...base, ok: true, ...r }) },
      (e) => {
        if (counted) { if (e?.skip) stats.mediaSkip++; else stats.mediaFail++ }
        indexMedia({ ...base, ok: false, err: String(e?.message ?? e).slice(0, 300) })
      },
    ))
  }

  function mediaFromUrl(base, url, trust, name) {
    if (!cfg.media.enabled) return
    let p = urlJobs.get(url)
    const first = !p
    if (first) {
      p = dl(() => fetchToStore(url, trust, name))
      urlJobs.set(url, p)
      if (urlJobs.size > 5000) urlJobs.delete(urlJobs.keys().next().value)
    }
    settle({ ...base, url, ...(first ? {} : { sameUrl: true }) }, p, first)
  }

  function mediaFromBase64(base, b64, name, ctype) {
    if (!cfg.media.enabled) return
    const s = String(b64).replace(/^base64:\/\//, '')
    const buf = Buffer.from(s, 'base64')
    if (buf.length > cfg.media.maxBytes) { indexMedia({ ...base, ok: false, err: '太大: ' + buf.length }); stats.mediaSkip++; return }
    settle(base, dl(() => storeBytes([buf], name, ctype)), true)
  }

  // ---- 把一个对象里所有消息段找出来补齐 ----
  function* segments(node, depth = 0) {
    if (depth > 40 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const x of node) yield* segments(x, depth + 1); return }
    if (typeof node.type === 'string' && node.data && typeof node.data === 'object' && !Array.isArray(node.data)) yield node
    for (const v of Object.values(node)) if (v && typeof v === 'object') yield* segments(v, depth + 1)
  }

  const isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s)

  function harvest(obj, ctx) {
    let i = 0
    for (const seg of segments(obj)) {
      const d = seg.data
      const base = { from: ctx.from, ref: ctx.ref, seg: seg.type, i: i++ }
      switch (seg.type) {
        case 'image':
        case 'mface': {
          const url = isHttp(d.url) ? d.url : isHttp(d.file) ? d.file : null
          if (url) mediaFromUrl(base, url, 'event', d.file)
          else if (typeof d.file === 'string' && d.file.startsWith('base64://')) mediaFromBase64(base, d.file, null, null)
          else if (d.file && cfg.media.enabled) {
            const key = 'img:' + d.file
            if (seenApiMedia.add(key)) track(api('get_image', { file: d.file }, { why: 'media', ref: ctx.ref }).then((r) => {
              const rd = r?.data
              if (isHttp(rd?.url)) mediaFromUrl(base, rd.url, 'api', rd.file)
              else if (rd?.base64) mediaFromBase64(base, rd.base64, rd.file, null)
              else { indexMedia({ ...base, ok: false, err: '没有网址' }); stats.mediaFail++ }
            }))
          }
          break
        }
        case 'record': {
          const url = isHttp(d.url) ? d.url : isHttp(d.file) ? d.file : null
          if (url) mediaFromUrl(base, url, 'event', d.file)
          else if (typeof d.file === 'string' && d.file.startsWith('base64://')) mediaFromBase64(base, d.file, null, null)
          else if (d.file && cfg.media.enabled) {
            const key = 'rec:' + d.file
            if (seenApiMedia.add(key)) track(api('get_record', { file: d.file, out_format: 'mp3' }, { why: 'media', ref: ctx.ref }).then((r) => {
              const rd = r?.data
              if (rd?.base64) mediaFromBase64(base, rd.base64, 'voice.mp3', 'audio/mpeg')
              else if (isHttp(rd?.url)) mediaFromUrl(base, rd.url, 'api', rd.file)
              else if (isHttp(rd?.file)) mediaFromUrl(base, rd.file, 'api', null)
              else { indexMedia({ ...base, ok: false, err: '取不到语音' }); stats.mediaFail++ }
            }))
          }
          break
        }
        case 'video': {
          const url = isHttp(d.url) ? d.url : isHttp(d.file) ? d.file : null
          if (url) mediaFromUrl(base, url, 'event', d.file)
          else { indexMedia({ ...base, ok: false, err: '视频段没有网址' }); stats.mediaSkip++ }
          break
        }
        case 'file': {
          if (!cfg.media.enabled || !cfg.media.fetchFiles) break
          const fid = d.file_id ?? d.id
          const size = Number(d.file_size ?? d.size ?? NaN)
          const name = d.name ?? d.file
          if (Number.isFinite(size) && size > cfg.media.maxBytes) { indexMedia({ ...base, ok: false, err: '太大: ' + size, name }); stats.mediaSkip++; break }
          if (isHttp(d.url)) { mediaFromUrl({ ...base, name }, d.url, 'api', name); break }
          if (!fid || ctx.depth > 0 || !seenFile.add(String(fid))) break
          fetchFile(base, { group_id: ctx.group_id, file_id: fid, busid: d.busid, name })
          break
        }
        case 'forward': {
          const id = d.id ?? d.resId ?? d.res_id
          if (fx && id !== undefined && id !== null && ctx.from !== 'forward' && seenRaw.add(String(id))) rawExpand(String(id), ctx.ref)
          if (!cfg.expand.forward || id === undefined || id === null || ctx.depth >= cfg.expand.maxDepth) break
          if (!seenForward.add(String(id))) break
          const ref = { ...ctx.ref, forward: String(id) }
          track(api('get_forward_msg', { id, message_id: id }, { why: 'forward', ref: ctx.ref }).then((r) => {
            if (r?.data) harvest(r.data, { from: 'forward', ref, depth: ctx.depth + 1, group_id: ctx.group_id })
          }))
          break
        }
        case 'reply': {
          const id = d.id
          if (!cfg.expand.replied || id === undefined || id === null || ctx.depth > 0) break
          if (!seenReply.add(String(id))) break
          const ref = { ...ctx.ref, replied: String(id) }
          const mid = /^-?\d+$/.test(String(id)) && Number.isSafeInteger(Number(id)) ? Number(id) : id
          track(api('get_msg', { message_id: mid }, { why: 'reply', ref: ctx.ref }).then((r) => {
            if (r?.data) harvest(r.data, { from: 'reply', ref, depth: ctx.depth + 1, group_id: r.data.group_id ?? ctx.group_id })
          }))
          break
        }
        default: break
      }
    }
  }

  /** 整包展开（所有内层，由 rawForwardModule 做），一次一个。展开过的（盘上有 expanded.json）不重做；失败的写 failed.json，之后可以用那个模块补。 */
  function rawExpand(id, ref) {
    const dir = join(dataDir, 'forward', fx.forwardDirName(id))
    if (existsSync(join(dir, 'expanded.json'))) return
    track(rawRun(async () => {
      const call = (a, p) => api(a, p, { why: 'forward-raw', ref })
      try {
        selfUidP ??= fx.selfUidOf(call).catch(() => undefined)
        const m = await fx.expandForward({ call, resId: id, dataDir, ref, selfUid: await selfUidP, media: cfg.media.enabled, maxBytes: cfg.media.maxBytes, hosts: cfg.media.hosts, allowPrivate: cfg.media.allowPrivate, title: fx.titleOf(ref) })
        stats.fwdRaw++; stats.fwdRawMsgs += m.messages
      } catch (e) {
        stats.fwdRawFail++
        try { mkdirSync(dir, { recursive: true }); const fd = openSync(join(dir, 'failed.json'), 'w'); writeSync(fd, JSON.stringify({ res_id: id, ref, at: new Date().toISOString(), err: String(e?.message ?? e) })); closeSync(fd) } catch {}
        log('合并转发整包展开失败（已记 failed.json）：', String(e?.message ?? e).slice(0, 120))
      }
    }))
  }

  function fetchFile(base, f) {
    track((async () => {
      const r = f.group_id
        ? await api('get_group_file_url', { group_id: f.group_id, file_id: f.file_id, ...(f.busid !== undefined ? { busid: f.busid } : {}) }, { why: 'file', ref: base.ref })
        : await api('get_private_file_url', { file_id: f.file_id }, { why: 'file', ref: base.ref })
      const url = r?.data?.url
      if (isHttp(url)) mediaFromUrl({ ...base, name: f.name, file_id: f.file_id }, url, 'api', f.name)
      else { indexMedia({ ...base, name: f.name, file_id: f.file_id, ok: false, err: '拿不到文件直链' }); stats.mediaFail++ }
    })())
  }

  function refOf(ev) {
    const r = {}
    for (const k of ['post_type', 'message_type', 'notice_type', 'message_id', 'group_id', 'user_id', 'time']) if (ev[k] !== undefined) r[k] = ev[k]
    return r
  }

  function onEvent(ev) {
    if (ev.post_type === 'message' || ev.post_type === 'message_sent') {
      harvest(ev.message, { from: 'event', ref: refOf(ev), depth: 0, group_id: ev.message_type === 'group' ? ev.group_id : undefined })
    } else if (ev.post_type === 'notice' && cfg.media.enabled && cfg.media.fetchFiles) {
      const f = ev.file
      if (ev.notice_type === 'group_upload' && f && (f.id ?? f.file_id) && seenFile.add(String(f.id ?? f.file_id))) {
        const size = Number(f.size ?? NaN)
        const base = { from: 'notice', ref: refOf(ev), seg: 'group_upload', i: 0 }
        if (Number.isFinite(size) && size > cfg.media.maxBytes) { indexMedia({ ...base, name: f.name, ok: false, err: '太大: ' + size }); stats.mediaSkip++ }
        else fetchFile(base, { group_id: ev.group_id, file_id: f.id ?? f.file_id, busid: f.busid, name: f.name })
      } else if (ev.notice_type === 'offline_file' && f && isHttp(f.url)) {
        mediaFromUrl({ from: 'notice', ref: refOf(ev), seg: 'offline_file', i: 0, name: f.name }, f.url, 'api', f.name)
      }
    }
  }

  // ---- 快照 ----
  async function snapshot(why) {
    if (snapshotting) return
    snapshotting = true
    lastSnapshotAt = Date.now()
    try {
      for (const a of ['get_login_info', 'get_version_info', 'get_status', 'get_friend_list']) await api(a, {}, { why })
      const groups = await api('get_group_list', {}, { why })
      if (cfg.snapshot.memberLists && Array.isArray(groups?.data)) {
        for (const g of groups.data) {
          if (stopping || !ws) break
          if (g?.group_id === undefined) continue
          await api('get_group_member_list', { group_id: g.group_id }, { why })
          await sleep(cfg.snapshot.gapMs)
        }
      }
    } finally { snapshotting = false }
  }

  // ---- 连接 ----
  function onFrame(data) {
    const t = Date.now()
    stats.frames++
    if (typeof data !== 'string') {
      stats.binary++
      evLog.write({ t, b64: Buffer.from(data).toString('base64') })
      return
    }
    let j = null
    try { j = JSON.parse(data) } catch {}
    if (j && typeof j.echo === 'string' && j.echo.startsWith(ECHO)) { onApiFrame(j, data, t); return }
    if (j?.post_type === 'meta_event' && j.meta_event_type === 'heartbeat' && !cfg.heartbeat) { stats.heartbeatSkipped++; return }
    evLog.write({ t, raw: data })
    const pt = j?.post_type
    if (POST_TYPES.has(pt)) stats[pt]++; else stats.other++
    if (j && typeof j === 'object') {
      try { onEvent(j) } catch (e) { log('补充时出错（帧已存）：', e?.message ?? e) }
    }
  }

  function connect() {
    if (stopping) return
    const headers = cfg.accessToken ? { Authorization: `Bearer ${cfg.accessToken}` } : {}
    let sock
    try { sock = new WebSocket(cfg.url, { headers }) } catch (e) {
      log('连不上：', e?.message ?? e)
      return scheduleReconnect()
    }
    ws = sock
    sock.binaryType = 'arraybuffer'
    let opened = false
    sock.addEventListener('open', () => {
      opened = true
      backoff = 1000
      stats.opens++
      evLog.write({ t: Date.now(), rec: 'open', url: shownUrl })
      log('已连上')
      if (cfg.snapshot.onConnect && Date.now() - lastSnapshotAt >= cfg.snapshot.minGapMin * 60_000) track(snapshot('connect'))
    })
    sock.addEventListener('message', (e) => onFrame(e.data))
    sock.addEventListener('close', (e) => {
      if (ws === sock) ws = null
      failPending('closed')
      if (opened) {
        stats.closes++
        evLog.write({ t: Date.now(), rec: 'close', code: e.code, reason: e.reason || undefined })
        log(`断开了（${e.code}${e.reason ? ' ' + e.reason : ''}）`)
      }
      scheduleReconnect()
    })
    sock.addEventListener('error', () => { /* 后面一定跟着 close */ })
  }
  function scheduleReconnect() {
    if (stopping || reconnectTimer) return
    const wait = backoff
    backoff = Math.min(backoff * 2, 60_000)
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, wait)
  }

  if (cfg.snapshot.everyHours > 0) {
    snapshotTimer = setInterval(() => { if (ws && ws.readyState === 1) track(snapshot('periodic')) }, cfg.snapshot.everyHours * 3600_000)
    snapshotTimer.unref?.()
  }
  const statusTimer = cfg.statusEveryMin > 0 ? setInterval(() => log(statusLine(stats)), cfg.statusEveryMin * 60_000) : null
  statusTimer?.unref?.()

  connect()

  let resolveDone
  const done = new Promise((r) => { resolveDone = r })
  async function stop() {
    if (stopping) return done
    stopping = true
    clearTimeout(reconnectTimer)
    clearInterval(snapshotTimer)
    clearInterval(statusTimer)
    const s = ws
    // 先等手上的补充活（最多 15 秒；补充活会再派活，所以一轮轮等），再断开
    const deadline = Date.now() + 15_000
    while (inflight.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...inflight]), sleep(deadline - Date.now())])
    if (s && s.readyState <= 1) {
      await new Promise((r) => { s.addEventListener('close', r, { once: true }); try { s.close(1000) } catch { r() } setTimeout(r, 3000) })
    }
    failPending('closed')
    evLog.write({ t: Date.now(), rec: 'stop' })
    evLog.close(); apiLog.close(); mediaIdx.close()
    releaseLock(lockPath)
    log('停了。' + statusLine(stats))
    resolveDone()
    return done
  }
  return { stop, stats, done, dataDir }
}

const POST_TYPES = new Set(['message', 'message_sent', 'notice', 'request', 'meta_event'])

export function statusLine(s) {
  return `帧 ${s.frames}（消息 ${s.message}、自己发的 ${s.message_sent}、通知 ${s.notice}、请求 ${s.request}、元事件 ${s.meta_event}、其他 ${s.other + s.binary}）` +
    ` 接口 成 ${s.apiOk} / 败 ${s.apiFail}` +
    ` 媒体 新 ${s.mediaOk} / 重复 ${s.mediaDup} / 跳过 ${s.mediaSkip} / 失败 ${s.mediaFail}（${(s.mediaBytes / 1048576).toFixed(1)} MB）` +
    ` 转发整包展开 ${s.fwdRaw}（${s.fwdRawMsgs} 条）/ 失败 ${s.fwdRawFail}` +
    ` 连上 ${s.opens} 次、断开 ${s.closes} 次`
}

function takeLock(p) {
  if (existsSync(p)) {
    let pid = NaN
    try { pid = Number(JSON.parse(readFileSync(p, 'utf8')).pid) } catch {}
    let alive = false
    if (pid === process.pid) alive = true  // 同一个进程里又开一个
    else if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true } catch (e) { alive = e?.code === 'EPERM' } }
    if (alive) throw Object.assign(new Error(`已经有一个录制器在写这个目录（pid ${pid}）`), { code: 'LOCKED' })
    try { unlinkSync(p) } catch {}
  }
  const fd = openSync(p, 'wx')
  writeSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }))
  closeSync(fd)
}
function releaseLock(p) {
  try { if (Number(JSON.parse(readFileSync(p, 'utf8')).pid) === process.pid) unlinkSync(p) } catch {}
}

// ---------- 命令行 ----------

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => { if (i + 1 >= argv.length) throw new Error(a + ' 后面要跟值'); return argv[++i] }
    if (a === '--config') o.config = v()
    else if (a === '--data') o.dataDir = v()
    else if (a === '--url') o.url = v()
    else if (a === '--no-media') o.noMedia = true
    else if (a === '--no-members') o.noMembers = true
    else if (a === '--no-heartbeat') o.noHeartbeat = true
    else if (a === '-h' || a === '--help') o.help = true
    else throw new Error('不认识的参数：' + a)
  }
  return o
}

async function main() {
  let args, fileCfg = {}
  try {
    args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(readFileSync(join(HERE, 'README.md'), 'utf8').split('\n## ')[0])
      return
    }
    const cfgPath = args.config ?? (existsSync(join(HERE, 'config.json')) ? join(HERE, 'config.json') : null)
    if (cfgPath) fileCfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error(e?.message ?? e)
    process.exitCode = 2 // 参数 / 配置错：start.cmd 不重开
    return
  }
  const cfg = deepMerge(fileCfg, {})
  if (process.env.ONEBOT_URL) cfg.url = process.env.ONEBOT_URL
  if (process.env.ONEBOT_TOKEN) cfg.accessToken = process.env.ONEBOT_TOKEN
  if (process.env.ONEBOT_ARCHIVE_DIR) cfg.dataDir = process.env.ONEBOT_ARCHIVE_DIR
  if (args.url) cfg.url = args.url
  if (args.dataDir) cfg.dataDir = args.dataDir
  if (args.noMedia) cfg.media = { ...(cfg.media ?? {}), enabled: false }
  if (args.noMembers) cfg.snapshot = { ...(cfg.snapshot ?? {}), memberLists: false }
  if (args.noHeartbeat) cfg.heartbeat = false

  let rec
  try { rec = await start(cfg) } catch (e) {
    console.error(e?.message ?? e)
    process.exitCode = e?.code === 'LOCKED' ? 3 : 2
    return
  }
  let n = 0
  const onSig = () => { if (++n > 1) process.exit(130); console.log('收到停止信号，收尾中（再按一次直接退）…'); rec.stop().then(() => process.exit(0)) }
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)
  process.on('SIGBREAK', onSig)
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
if (process.argv[1] && samePath(resolvePath(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
