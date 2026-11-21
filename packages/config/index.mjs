// @mochi-fish/config：主人和陪伴体的身份配置。
//
// 读一份 JSON（路径由参数给，或者从环境变量 FISH_IDENTITY_FILE 取），核过、整份冻住。
// 读不到、不是 JSON、有一处不对，结果就是「没有主人」：所有来话都按别人的话算。
// 不猜写法：认不得的键、写成数字的号、相对路径，一律算不对。
// 没有依赖，只用 node 内置模块；任何输入都不抛错。格式见 SCHEMA.md。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SCHEMA = 1
export const ENV_VAR = 'FISH_IDENTITY_FILE'
export const DEFAULT_OWNER_NAME = '主人'
export const DEFAULT_COMPANION_NAME = '大肥鱼'
export const MAX_BYTES = 64 * 1024
export const LIMITS = Object.freeze({ channels: 16, idsPerChannel: 16, chats: 32, nameChars: 32, idChars: 128, sessionIdChars: 256 })

const CHANNEL_RE = /^[a-z][a-z0-9-]{0,23}$/
const GENERIC_ID_RE = /^[\x21-\x7e]{1,128}$/
const ID_RULES = Object.freeze({
  qq: { re: /^[1-9][0-9]{4,11}$/, why: '要 5–12 位数字的字符串，不以 0 开头' },
  bili: { re: /^[1-9][0-9]{0,19}$/, why: '要 1–20 位数字的字符串，不以 0 开头' },
  vrc: { re: /^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, why: '要 usr_ 加小写的 uuid' },
  mc: { re: /^[A-Za-z0-9_]{3,16}$/, why: '要 3–16 个字母、数字或下划线' },
})
const CHAT_RULES = Object.freeze({
  qq: { re: /^(?:private|group):[1-9][0-9]{4,11}$/, why: '要 private:<号> 或 group:<号>' },
})
// 名字里不许有的字：控制字符、代理项、私用区、没分配的码位、行 / 段分隔符、改变文字方向的控制符
const BAD_NAME_CHAR = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u
const SESSION_ID_RE = /^[\x21-\x7e]{1,256}$/

const MADE = new WeakSet() // 只认本模块造出来的结果：别处拼的、拷贝过的对象一律按「没有主人」算

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
const isStr = (v) => typeof v === 'string'

function deepFreeze (v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

function result (fields) {
  const r = deepFreeze({
    ok: false,
    why: 'invalid',
    source: null,
    problems: [],
    owner: null,
    companion: { name: DEFAULT_COMPANION_NAME, ids: Object.create(null) },
    proactiveChats: [],
    mainSession: null,
    ledgerRoot: null,
    ...fields,
  })
  MADE.add(r)
  return r
}

const fail = (why, source, problems = []) => result({ ok: false, why, source, problems })

// ---------------------------------------------------------------- 核对

class Problems {
  constructor () { this.list = [] }
  add (at, why) { if (this.list.length < 50) this.list.push(at === '' ? why : `${at}：${why}`) }
}

/** 只许出现 allowed 里的键；$comment（字符串）到处都可以写，读的时候跳过。 */
function checkKeys (obj, allowed, at, P) {
  for (const k of Object.keys(obj)) {
    if (k === '$comment' && isStr(obj[k])) continue
    if (!allowed.includes(k)) P.add(at, `认不得的键（只认 ${allowed.join('、')}）`)
  }
}

function checkName (v, at, P) {
  if (!isStr(v)) { P.add(at, '要字符串'); return null }
  const n = [...v].length
  if (n < 1 || n > LIMITS.nameChars) { P.add(at, `要 1–${LIMITS.nameChars} 个字`); return null }
  if (v.trim() !== v) { P.add(at, '前后不能有空白'); return null }
  if (BAD_NAME_CHAR.test(v)) { P.add(at, '有控制字符、分隔符或方向控制符'); return null }
  return v
}

function checkIds (v, at, P) {
  if (!isPlain(v)) { P.add(at, '要对象：{ 渠道: [号, …] }'); return null }
  const out = Object.create(null)
  const keys = Object.keys(v).filter((k) => !(k === '$comment' && isStr(v[k])))
  if (keys.length > LIMITS.channels) { P.add(at, `渠道最多 ${LIMITS.channels} 个`); return null }
  for (const ch of keys) {
    const chAt = `${at}.${ch}`
    if (!CHANNEL_RE.test(ch)) { P.add(at, '渠道名要小写字母开头，只用小写字母、数字和 -，最长 24'); continue }
    const list = v[ch]
    if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.idsPerChannel) { P.add(chAt, `要 1–${LIMITS.idsPerChannel} 个号的数组`); continue }
    const rule = hasOwn(ID_RULES, ch) ? ID_RULES[ch] : null // 只认自己的键：constructor 这类原型上的名字按「别的渠道」算
    const seen = new Set()
    list.forEach((id, i) => {
      if (!isStr(id)) { P.add(`${chAt}[${i}]`, '号要写成字符串'); return }
      if (rule ? !rule.re.test(id) : !GENERIC_ID_RE.test(id)) { P.add(`${chAt}[${i}]`, rule ? rule.why : `要 1–${LIMITS.idChars} 个可见的 ASCII 字符`); return }
      if (seen.has(id)) { P.add(`${chAt}[${i}]`, '重复了'); return }
      seen.add(id)
    })
    out[ch] = [...seen]
  }
  return out
}

function countIds (ids) {
  let n = 0
  for (const ch of Object.keys(ids)) n += ids[ch].length
  return n
}

function checkOwner (v, P) {
  if (v === null) return null
  if (!isPlain(v)) { P.add('owner', '要对象，或者明写 null（没有主人）'); return null }
  checkKeys(v, ['displayName', 'ids'], 'owner', P)
  const displayName = hasOwn(v, 'displayName') ? checkName(v.displayName, 'owner.displayName', P) : DEFAULT_OWNER_NAME
  if (!hasOwn(v, 'ids')) { P.add('owner', '缺 ids'); return null }
  const ids = checkIds(v.ids, 'owner.ids', P)
  if (ids && countIds(ids) === 0) P.add('owner.ids', '至少要一个号')
  return { displayName: displayName ?? DEFAULT_OWNER_NAME, ids: ids ?? Object.create(null) }
}

function checkCompanion (v, P) {
  if (v === undefined) return { name: DEFAULT_COMPANION_NAME, ids: Object.create(null) }
  if (!isPlain(v)) { P.add('companion', '要对象'); return null }
  checkKeys(v, ['name', 'ids'], 'companion', P)
  const name = hasOwn(v, 'name') ? checkName(v.name, 'companion.name', P) : DEFAULT_COMPANION_NAME
  const ids = hasOwn(v, 'ids') ? checkIds(v.ids, 'companion.ids', P) : Object.create(null)
  return { name: name ?? DEFAULT_COMPANION_NAME, ids: ids ?? Object.create(null) }
}

function checkChats (v, P) {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > LIMITS.chats) { P.add('proactiveChats', `要数组，最多 ${LIMITS.chats} 项`); return [] }
  const out = []
  const seen = new Set()
  v.forEach((c, i) => {
    const at = `proactiveChats[${i}]`
    if (!isPlain(c)) { P.add(at, '要 { channel, chat }'); return }
    checkKeys(c, ['channel', 'chat'], at, P)
    if (!isStr(c.channel) || !CHANNEL_RE.test(c.channel)) { P.add(`${at}.channel`, '渠道名不对'); return }
    const rule = hasOwn(CHAT_RULES, c.channel) ? CHAT_RULES[c.channel] : null
    if (!isStr(c.chat) || (rule ? !rule.re.test(c.chat) : !GENERIC_ID_RE.test(c.chat))) { P.add(`${at}.chat`, rule ? rule.why : `要 1–${LIMITS.idChars} 个可见的 ASCII 字符`); return }
    const key = `${c.channel}\u0000${c.chat}`
    if (seen.has(key)) { P.add(at, '重复了'); return }
    seen.add(key)
    out.push({ channel: c.channel, chat: c.chat })
  })
  return out
}

/** 绝对路径或 ~/ 开头 → 规整后的绝对路径；别的 → null。\\ 开头的（网络路径、设备路径）不认。 */
function absPath (v, home) {
  if (!isStr(v) || v === '' || v.length > 4096 || v.includes('\u0000')) return null
  if (v.startsWith('\\\\') || v.startsWith('//')) return null
  let p = v
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (!isStr(home) || !path.isAbsolute(home)) return null
    p = path.join(home, p.slice(1))
  }
  const absolute = process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/')
  return absolute ? path.resolve(p) : null
}

function checkMainSession (v, home, P) {
  if (v === undefined || v === null) return null
  if (!isPlain(v)) { P.add('mainSession', '要对象，或者 null'); return null }
  if (v.by === 'fish-home') {
    checkKeys(v, ['by', 'file'], 'mainSession', P)
    const file = absPath(v.file, home)
    if (file === null) { P.add('mainSession.file', '要绝对路径或 ~/ 开头'); return null }
    return { by: 'fish-home', file }
  }
  if (v.by === 'session-id') {
    checkKeys(v, ['by', 'id'], 'mainSession', P)
    if (!isStr(v.id) || !SESSION_ID_RE.test(v.id)) { P.add('mainSession.id', `要 1–${LIMITS.sessionIdChars} 个可见的 ASCII 字符`); return null }
    return { by: 'session-id', id: v.id }
  }
  P.add('mainSession.by', '只认 fish-home 或 session-id')
  return null
}

function checkLedgerRoot (v, home, P) {
  if (v === undefined || v === null) return null
  const p = absPath(v, home)
  if (p === null) P.add('ledgerRoot', '要绝对路径或 ~/ 开头')
  return p
}

/**
 * 从已经解析好的对象核出身份。不抛错。
 * opts：{ home }（展开 ~ 用，缺省是 os.homedir()）、{ source }（只是记在结果里）。
 */
export function validateIdentity (obj, opts = {}) {
  const source = isStr(opts?.source) ? opts.source : null
  try {
    const home = isStr(opts?.home) ? opts.home : os.homedir()
    const P = new Problems()
    if (!isPlain(obj)) return fail('invalid', source, ['整份要是一个 JSON 对象'])
    checkKeys(obj, ['schema', 'owner', 'companion', 'proactiveChats', 'mainSession', 'ledgerRoot'], '', P)
    if (obj.schema !== SCHEMA) P.add('schema', `要写 ${SCHEMA}`)
    if (!hasOwn(obj, 'owner')) P.add('owner', '要明写：对象，或者 null（没有主人）')
    const owner = hasOwn(obj, 'owner') ? checkOwner(obj.owner, P) : null
    const companion = checkCompanion(obj.companion, P)
    const proactiveChats = checkChats(obj.proactiveChats, P)
    const mainSession = checkMainSession(obj.mainSession, home, P)
    const ledgerRoot = checkLedgerRoot(obj.ledgerRoot, home, P)
    if (owner && companion) {
      for (const ch of Object.keys(owner.ids)) {
        const theirs = companion.ids[ch] ?? []
        if (owner.ids[ch].some((id) => theirs.includes(id))) P.add(`companion.ids.${ch}`, '和 owner 的号重了')
      }
    }
    if (P.list.length > 0) return fail('invalid', source, P.list)
    return result({ ok: true, why: 'ok', source, problems: [], owner, companion, proactiveChats, mainSession, ledgerRoot })
  } catch {
    return fail('invalid', source, ['核对时出错'])
  }
}

/** 从 JSON 文字核出身份（开头的 BOM 去掉）。不抛错。 */
export function parseIdentity (text, opts = {}) {
  const source = isStr(opts?.source) ? opts.source : null
  if (!isStr(text)) return fail('not-json', source)
  let obj
  try {
    obj = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return fail('not-json', source)
  }
  return validateIdentity(obj, opts)
}

/**
 * 读身份配置。不抛错。
 * opts：{ file }（优先）、{ env }（缺省 process.env，取 FISH_IDENTITY_FILE）、{ home }、{ fs }（换读文件的实现，测试用）。
 * 两样都没给 → why 'no-file'；路径不是绝对的 → 'bad-path'；读不了 → 'unreadable'；太大 → 'too-large'；
 * 不是 UTF-8 → 'not-utf8'；不是 JSON → 'not-json'；内容不对 → 'invalid'。这些结果都没有主人。
 */
export function loadIdentity (opts = {}) {
  try {
    const env = opts?.env ?? process.env ?? {}
    const home = isStr(opts?.home) ? opts.home : os.homedir()
    const F = opts?.fs ?? fs
    let raw = null
    let source = null
    if (opts?.file !== undefined && opts?.file !== null) { raw = opts.file; source = 'argument' } else if (isStr(env[ENV_VAR]) && env[ENV_VAR] !== '') { raw = env[ENV_VAR]; source = 'env' }
    if (source === null) return fail('no-file', null)
    const file = absPath(raw, home)
    if (file === null) return fail('bad-path', source)
    let buf
    try {
      const st = F.statSync(file)
      if (!st.isFile()) return fail('unreadable', source)
      if (st.size > MAX_BYTES) return fail('too-large', source)
      buf = F.readFileSync(file)
    } catch {
      return fail('unreadable', source)
    }
    if (buf.length > MAX_BYTES) return fail('too-large', source)
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
    } catch {
      return fail('not-utf8', source)
    }
    return parseIdentity(text, { home, source })
  } catch {
    return fail('unreadable', null)
  }
}

// ---------------------------------------------------------------- 用

const idText = (id) => (isStr(id) ? id : (Number.isSafeInteger(id) && id > 0 ? String(id) : null))

/** → 'owner' | 'companion' | 'other'。没有主人、或者结果不是本模块造的，就不会是 'owner'。 */
export function speakerOf (identity, channel, id) {
  try {
    if (!MADE.has(identity) || !isStr(channel) || !CHANNEL_RE.test(channel)) return 'other'
    const s = idText(id)
    if (s === null) return 'other'
    const mine = identity.owner?.ids?.[channel]
    if (identity.ok && Array.isArray(mine) && mine.includes(s)) return 'owner'
    const hers = identity.companion?.ids?.[channel]
    if (identity.ok && Array.isArray(hers) && hers.includes(s)) return 'companion'
    return 'other'
  } catch {
    return 'other'
  }
}

export const isOwner = (identity, channel, id) => speakerOf(identity, channel, id) === 'owner'

export function ownerName (identity) {
  return MADE.has(identity) && identity.owner ? identity.owner.displayName : DEFAULT_OWNER_NAME
}

export function companionName (identity) {
  return MADE.has(identity) ? identity.companion.name : DEFAULT_COMPANION_NAME
}

/** 把文字里的 {owner}、{companion} 换成配置里的称呼（只换一遍，换进去的字不再展开）。 */
export function fillNames (template, identity) {
  if (!isStr(template)) return ''
  const o = ownerName(identity)
  const c = companionName(identity)
  return template.replace(/\{(owner|companion)\}/g, (_, k) => (k === 'owner' ? o : c))
}

/**
 * 主会话的 id；认不出就是 null（这时没有哪条会话算主会话）。不抛错。
 * by 'session-id'：配置里写的 id。by 'fish-home'：读那个 JSON 文件的 sessionId（每次现读，dsh-fish 换会话时跟着换）。
 */
export function mainSessionId (identity, opts = {}) {
  try {
    if (!MADE.has(identity) || !identity.ok || identity.mainSession === null) return null
    const m = identity.mainSession
    if (m.by === 'session-id') return m.id
    const F = opts?.fs ?? fs
    const st = F.statSync(m.file)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    const obj = JSON.parse(String(F.readFileSync(m.file, 'utf8')).replace(/^\ufeff/, ''))
    const id = isPlain(obj) ? obj.sessionId : null
    return isStr(id) && SESSION_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/** 是不是本模块造出来的结果。 */
export const isIdentity = (v) => MADE.has(v)
