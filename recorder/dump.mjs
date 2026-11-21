#!/usr/bin/env node
// 把录下来的帧按原文一行一条吐出来（可以接 jq），顺带简单筛一下。
//   node dump.mjs [YYYY-MM-DD | 某个 .jsonl] [--data 目录] [--api] [--type message|notice|request|meta_event|message_sent]
//                 [--group 群号] [--user QQ号] [--no-heartbeat] [--time]
// 默认是今天的 events；--api 看接口回包；--time 在每行前面加收到的时间（制表符隔开）。
import { readFileSync, existsSync, createReadStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, localDay } from './recorder.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const o = { kind: 'events' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--data') o.data = argv[++i]
  else if (a === '--api') o.kind = 'api'
  else if (a === '--type') o.type = argv[++i]
  else if (a === '--group') o.group = argv[++i]
  else if (a === '--user') o.user = argv[++i]
  else if (a === '--no-heartbeat') o.noHb = true
  else if (a === '--time') o.time = true
  else if (a.startsWith('--')) { console.error('不认识的参数：' + a); process.exit(2) }
  else o.target = a
}

let dataDir = o.data ?? process.env.ONEBOT_ARCHIVE_DIR
if (!dataDir && existsSync(join(HERE, 'config.json'))) {
  try { dataDir = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).dataDir } catch {}
}
dataDir ??= DEFAULTS.dataDir
const file = o.target && o.target.endsWith('.jsonl') ? o.target : join(dataDir, o.kind, `${o.target ?? localDay(Date.now())}.jsonl`)
if (!existsSync(file)) { console.error('没有这个文件：' + file); process.exit(1) }

const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
for await (const line of rl) {
  if (!line) continue
  let row
  try { row = JSON.parse(line) } catch { continue } // 录制器被掐断时可能留半行
  const raw = row.raw
  if (typeof raw !== 'string') continue // 录制器自己的记号、二进制帧、没回来的调用
  if (o.type || o.group || o.user || o.noHb) {
    let j
    try { j = JSON.parse(raw) } catch { continue }
    const ev = o.kind === 'api' ? (j.data ?? {}) : j
    if (o.type && ev.post_type !== o.type) continue
    if (o.noHb && ev.meta_event_type === 'heartbeat') continue
    if (o.group && String(ev.group_id ?? row.req?.params?.group_id) !== o.group) continue
    if (o.user && String(ev.user_id) !== o.user) continue
  }
  process.stdout.write((o.time ? new Date(row.t).toISOString() + '\t' : '') + raw + '\n')
}
