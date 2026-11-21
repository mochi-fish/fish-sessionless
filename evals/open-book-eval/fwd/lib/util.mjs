// 转发器各处共用的小工具：哈希、规范 JSON、原子写、追加写（带 fsync）、端口闸。
// 不依赖 open-book-eval 其余部分以外的东西；端口段和家目录取 ../../lib/paths.mjs（架子共用的那份）。
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { LIVE_PORT_HI, LIVE_PORT_LO } from '../../lib/paths.mjs'

export const sha256 = (b) => createHash('sha256').update(b).digest('hex')
export const shaFile = (f) => sha256(readFileSync(f))
export const randomToken = (n = 24) => randomBytes(n).toString('hex')

/** 键排好序的 JSON（指纹、callId 都靠它；同一个对象每次同样的字节）。 */
export function canonicalJson (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map((x) => canonicalJson(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}

/** 写到旁边再改名（读的人永远看到整份）。 */
export function writeAtomic (file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmp, 'w')
  try { writeSync(fd, typeof data === 'string' ? data : Buffer.from(data)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

/** 追加一行 JSON 并 fsync（花钱的账本靠它：进程在任何一步死掉，写下的行都在）。 */
export function appendJsonl (file, rec) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  try { writeSync(fd, JSON.stringify(rec) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
}

export function readJsonl (file) {
  if (!existsSync(file)) return []
  const out = []
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    try { out.push(JSON.parse(l)) } catch {
      // 最后一行写到一半（进程死在 writeSync 里）：不当成账，记下来让人看；中间行坏了直接抛
      if (i >= lines.length - 2) { out.push({ type: 'torn-line', line: i + 1 }); continue }
      throw new Error(`${file}:${i + 1} 不是 JSON`)
    }
  }
  return out
}

export const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

/** 端口闸：1–65535，而且不在线上代理那一段（18780–18799）。 */
export function portAllowed (p) {
  const n = Number(p)
  return Number.isInteger(n) && n > 0 && n < 65536 && !(n >= LIVE_PORT_LO && n <= LIVE_PORT_HI)
}
export function assertPortAllowed (p, what) {
  if (!portAllowed(p)) throw new Error(`端口闸：${what} 的端口 ${p} 不行（不许在 ${LIVE_PORT_LO}–${LIVE_PORT_HI}）`)
}

/** 本地时间的 ISO 串（账本、日志用；本机就是 UTC+8，但不靠本机时区）。 */
export function localIso (ms = Date.now()) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00')
}

/** 深拷贝（只给 JSON 用）。 */
export const clone = (v) => JSON.parse(JSON.stringify(v))
