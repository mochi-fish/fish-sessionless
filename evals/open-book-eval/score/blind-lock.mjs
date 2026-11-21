// 盲测锁和留出题轮换（eval.md 5.6）。
//
// - 题是「模板 + 种子」生成的：dev-* 种子随便跑；别的种子是留出种子，拍板用，每把只用一回。
// - consumed-holdouts.json：键是 sha256(归一化探针 + 世界 id + 截止点 + 种子)。
// - **拿到一次有效输出以后才写**（修 dsh-soul 发前就锁、超时 / 502 就废题的毛病）：有效 = 这一半的结局不是 error。
// - 下一次拍板遇到已消耗的键直接拒跑（assertFresh 抛错）。
// - 最早那批 8 道真题只当回归题：永远不进这把锁，也不许拿来拍板（isRegressionItem）。
// - 复核 V11（11-19）：锁按「拍板轮」记（round：实验目录名 / 计划名）。同一轮里别的臂、别的模型看同一批留出题不算复用
//   （以前第一臂判完一写锁，第二臂就被拒）；下一轮（换了目录或计划名）再用才拒。没带 round 的旧记录一律算用过。
// 写文件：先写旁边的临时文件再改名（同目录、原子）。
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { normKey } from './normalize.mjs'

export const LOCK_FILE = 'consumed-holdouts.json'

export const isDevSeed = (seed) => /^dev-/.test(String(seed ?? ''))
export const isRegressionItem = (itemId) => /^R1114-/.test(String(itemId ?? ''))
export const isHoldoutSeed = (seed) => !isDevSeed(seed) && String(seed ?? '') !== ''

/** 这一半的锁键。 */
export function holdoutKey ({ probeText, worldId, cut, seed }) {
  const s = [normKey(probeText), String(worldId), String(cut ?? ''), String(seed)].join('\u0000')
  return createHash('sha256').update(s).digest('hex')
}

export function readLock (path) {
  if (!existsSync(path)) return { v: 1, consumed: {} }
  const j = JSON.parse(readFileSync(path, 'utf8'))
  if (j?.v !== 1 || typeof j.consumed !== 'object' || j.consumed === null) throw new Error('consumed-holdouts.json 格式不对')
  return j
}

/** 跑之前：这些键有一个已经用过就拒跑。回的是没用过的那些（全部）。 */
export function assertFresh (path, keys, { round = null } = {}) {
  const lock = readLock(path)
  const used = keys.filter((k) => Object.prototype.hasOwnProperty.call(lock.consumed, k) && !(round && lock.consumed[k]?.round === round))
  if (used.length) {
    const e = new Error(`有 ${used.length} 道留出题已经拍过板了，换种子重出（不许复用）`)
    e.code = 'HOLDOUT_CONSUMED'
    e.used = used.length
    throw e
  }
  return keys
}

/** 有效输出：结局不是 error（拒答、空回复、跑到步数上限也算拿到了输出：题已经被模型看过了）。 */
export const validOutput = (rec) => rec != null && ['answered', 'draft', 'empty', 'refusal', 'maxSteps'].includes(rec.outcome)

/**
 * 记下消耗。entries：[{ key, rec, itemId, half, arm, runId, seed }]。
 * 只写结局有效的、留出种子的、不是回归题的；回写了几条。
 */
export function recordConsumed (path, entries, now = new Date(), { round = null } = {}) {
  const lock = readLock(path)
  let n = 0
  for (const e of entries) {
    if (!isHoldoutSeed(e.seed) || isRegressionItem(e.itemId) || !validOutput(e.rec)) continue
    if (Object.prototype.hasOwnProperty.call(lock.consumed, e.key)) continue
    lock.consumed[e.key] = { at: now.toISOString(), itemId: e.itemId, half: e.half, arm: e.arm, runId: e.runId, seed: e.seed, round: round ?? null }
    n++
  }
  if (n > 0) {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(lock, null, 1))
    renameSync(tmp, path)
  }
  return n
}
