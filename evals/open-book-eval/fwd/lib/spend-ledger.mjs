// 花钱的账（每个提供方一本，只追加、每行 fsync）。
//   reserve：发之前先记一行「要发、最多花这么多」；钱不够就不发（BudgetError），什么都不写。
//   settle ：收完了按提供方回报的用量结账（source: provider）；回报里没有用量、或者明显小于估算的，按整份预留记
//            （source: estimate-no-usage，复核 A3）。
//   fail   ：出错了也算钱（eval.md 3.7「出错照样占预算」）：没拿到状态码就断的按输入那一截记；已经开始回流以后断的、
//            超时的、半截的流按整份预留记（复核 A2：输出那一截提供方照样收钱）。
//   重启时：有 reserve 没 settle/fail 的（进程死在发的中间）补一行 settle（source: orphan-estimate，按整份预留记）；
//           这种 callId 和 fail 过的一样，以后再来一律不发（不重试、不花两遍）。
//   stop / unstop：硬停。停有种类（复核 A5）：
//     overrun  —— 一臂累计花到估算的 1.3 倍；
//     provider —— 提供方说钱不够 / 认证没过（402、401、403、insufficient balance），或余额到了给她留的底；
//     privacy  —— 隐私闸没过；  host —— 主机闸没过、人叫停、别的。
//     unstop 只解指定的那几种（默认 overrun、provider）；privacy、host 要另一个显式的参数（--unstop-gate）。
//     解开一次 overrun 以后，这一臂从解开那一刻起再花 (1.3 − 1) × 估算 就再停（不是从此不管）。
//   boundary：执行器报「一整道题 / 一整个臂」的开始和结束。开始时剩的钱不够这道题的预计花费就不让开始（干净地停在边界上）；
//            题中间撞上限的，那道题记 question-incomplete（不算分，下次从这道题重来）。
//            一臂的已花按臂 id 累计（续跑、unstop 以后都不清零；复核 A5）；再开同一臂没给估算时沿用上一次的估算。
//   headroom：外加的余量（比如 DeepSeek 余额 − 给她留的底，复核 A1）：remaining = min(上限 − 已记, headroom)。
import { join } from 'node:path'
import { appendJsonl, readJsonl, localIso } from './util.mjs'

export class BudgetError extends Error {
  constructor (code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra) }
}

const round6 = (x) => Math.round(x * 1e6) / 1e6
export const STOP_KINDS = Object.freeze(['overrun', 'provider', 'privacy', 'host'])
/** 老账本里的 stop 行没写种类：按理由认 */
export function stopKindOf (r) {
  if (STOP_KINDS.includes(r?.kind)) return r.kind
  const s = String(r?.reason ?? '')
  if (/^arm .* spent .* x estimate/.test(s)) return 'overrun'
  if (/^privacy/.test(s)) return 'privacy'
  if (/^provider|balance/.test(s)) return 'provider'
  return 'host'
}

export class SpendLedger {
  /**
   * @param {{ dir: string, caps: Record<string, number>, overrunFactor?: number, clock?: () => number, readOnly?: boolean }} o
   *   caps：提供方 → 上限（该提供方的币种）。没写的提供方上限是 0（一分钱都不许花）；免费的提供方（openai/本地）照记次数。
   *   readOnly：只读（扫别的单元的账时用）：不补孤儿行，孤儿预留按整份预留算进 committed。
   */
  constructor ({ dir, caps, overrunFactor = 1.3, clock = Date.now, readOnly = false }) {
    this.dir = dir
    this.caps = { ...caps }
    this.overrunFactor = overrunFactor
    this.clock = clock
    this.readOnly = readOnly
    this.headroomFns = {}
    this.file = join(dir, 'spend-ledger.jsonl')
    this.load()
  }

  _append (rec) {
    if (this.readOnly) throw new Error('read-only ledger')
    const row = { ...rec, at: localIso(this.clock()) }
    appendJsonl(this.file, row)
    this._apply(row)
    return row
  }

  _blank () { return { settled: 0, open: new Map(), calls: 0, settledCalls: 0, failedCalls: 0, refused: 0, estimateSettled: 0 } }
  _p (provider) { if (!this.by[provider]) this.by[provider] = this._blank(); return this.by[provider] }

  _addArm (provider, amount) {
    if (!this.arm || this.arm.provider !== provider) return
    this.arm.spent = round6(this.arm.spent + amount)
    this.armTotals.set(this.arm.id, this.arm.spent)
  }

  _apply (r) {
    switch (r.type) {
      case 'reserve': { const p = this._p(r.provider); p.open.set(r.callId, r); p.calls++; this.callState.set(r.callId, 'open'); if (this.arm) this.arm.calls++; if (this.question) this.question.calls++; break }
      case 'settle': {
        const p = this._p(r.provider); p.open.delete(r.callId); p.settled = round6(p.settled + r.cost); p.settledCalls++
        if (r.source === 'estimate-no-usage') p.estimateSettled++
        this.callState.set(r.callId, r.source === 'orphan-estimate' ? 'failed' : 'done')
        this._addArm(r.provider, r.cost)
        break
      }
      case 'fail': {
        const p = this._p(r.provider); p.open.delete(r.callId); p.settled = round6(p.settled + r.charged); p.failedCalls++
        this.callState.set(r.callId, 'failed')
        this._addArm(r.provider, r.charged)
        break
      }
      case 'refuse': this._p(r.provider).refused++; break
      case 'stop': this.stopped = { reason: r.reason, kind: stopKindOf(r), arm: r.arm ?? null, at: r.at }; break
      case 'unstop':
        // 解开的是超支停：这一臂从这一刻起重新算 1.3 倍那一截（base = 解开时的累计）
        if (this.stopped?.kind === 'overrun' && this.stopped.arm) this.armBase.set(this.stopped.arm, this.armTotals.get(this.stopped.arm) ?? 0)
        this.stopped = null
        break
      case 'boundary':
        if (r.kind === 'arm' && r.phase === 'begin') {
          if (r.estimate != null && Number(r.estimate) > 0) this.armEst.set(r.id, Number(r.estimate))
          this.arm = { id: r.id, provider: r.provider, estimate: this.armEst.get(r.id) ?? null, spent: this.armTotals.get(r.id) ?? 0, calls: 0 }
        }
        if (r.kind === 'arm' && r.phase === 'end') this.arm = null
        if (r.kind === 'question' && r.phase === 'begin') this.question = { id: r.id, calls: 0 }
        if (r.kind === 'question' && r.phase === 'end') this.question = null
        break
      case 'question-incomplete': this.incomplete.add(r.id); break
      default: break
    }
  }

  load () {
    this.by = {}
    this.callState = new Map()
    this.stopped = null
    this.arm = null
    this.question = null
    this.incomplete = new Set()
    this.armTotals = new Map()
    this.armEst = new Map()
    this.armBase = new Map()
    this.torn = 0
    for (const r of readJsonl(this.file)) { if (r.type === 'torn-line') { this.torn++; continue } this._apply(r) }
    if (this.readOnly) return
    // 进程死在发的中间：整份预留算花掉，以后这个 callId 不再发
    for (const [provider, p] of Object.entries(this.by)) {
      for (const r of [...p.open.values()]) this._append({ type: 'settle', provider, callId: r.callId, cost: r.amount, source: 'orphan-estimate' })
    }
  }

  cap (provider) { return Number(this.caps[provider] ?? 0) }
  committed (provider) { const p = this._p(provider); let s = p.settled; for (const r of p.open.values()) s += r.amount; return round6(s) }
  /** 外加的余量函数（provider → 还能花多少；null = 不限）。 */
  setHeadroom (provider, fn) { this.headroomFns[provider] = fn }
  headroom (provider) { const f = this.headroomFns[provider]; if (typeof f !== 'function') return null; const v = f(); return v === null || v === undefined ? null : Number(v) }
  remaining (provider) {
    const capLeft = round6(this.cap(provider) - this.committed(provider))
    const h = this.headroom(provider)
    return h === null ? capLeft : round6(Math.min(capLeft, h))
  }
  stateOf (callId) { return this.callState.get(callId) ?? null }

  /** 发之前：钱够、没停、这个 callId 没失败过，才记一行 reserve。 */
  reserve ({ provider, callId, amount, meta = {} }) {
    if (this.stopped) { this._append({ type: 'refuse', provider, callId, why: 'stopped' }); throw new BudgetError('STOPPED', `ledger stopped (${this.stopped.kind}): ${this.stopped.reason}`) }
    const st = this.stateOf(callId)
    if (st === 'failed') { this._append({ type: 'refuse', provider, callId, why: 'failed-before' }); throw new BudgetError('FAILED_BEFORE', 'this call failed before; no retries') }
    if (st === 'open') throw new BudgetError('IN_FLIGHT', 'this call is already in flight')
    const remaining = this.remaining(provider)
    if (amount > remaining + 1e-9) {
      const h = this.headroom(provider)
      const why = h !== null && h < round6(this.cap(provider) - this.committed(provider)) ? 'headroom' : 'cap'
      this._append({ type: 'refuse', provider, callId, why, amount, remaining })
      if (this.question) this._append({ type: 'question-incomplete', id: this.question.id, provider, why })
      throw new BudgetError(why === 'headroom' ? 'HEADROOM' : 'CAP', `budget ${why} for ${provider}: need ${amount}, remaining ${remaining}`, { remaining })
    }
    return this._append({ type: 'reserve', provider, callId, amount: round6(amount), ...meta })
  }

  settle ({ provider, callId, cost, usage, source = 'provider', extra = {} }) {
    const row = this._append({ type: 'settle', provider, callId, cost: round6(cost), usage, source, ...extra })
    this._checkOverrun(provider)
    return row
  }

  fail ({ provider, callId, charged, reason }) {
    const row = this._append({ type: 'fail', provider, callId, charged: round6(charged), reason: String(reason).slice(0, 200) })
    this._checkOverrun(provider)
    return row
  }

  /** 一臂累计花到 1.3 × 估算就停；解开过一次的从解开时的累计再算 (1.3 − 1) × 估算。 */
  overrunLimit (armId) {
    const est = this.armEst.get(armId)
    if (!(est > 0)) return null
    const base = this.armBase.get(armId)
    return base === undefined ? this.overrunFactor * est : base + (this.overrunFactor - 1) * est
  }

  _checkOverrun (provider) {
    const a = this.arm
    if (!a || a.provider !== provider) return
    const lim = this.overrunLimit(a.id)
    if (lim === null) return
    if (a.spent > lim + 1e-9 && !this.stopped) this._append({ type: 'stop', kind: 'overrun', arm: a.id, reason: `arm ${a.id} spent ${a.spent} > ${this.overrunFactor} x estimate ${a.estimate}${this.armBase.has(a.id) ? ` (after unstop at ${this.armBase.get(a.id)})` : ''}` })
  }

  stop (reason, kind = 'host') { if (!this.stopped) this._append({ type: 'stop', kind: STOP_KINDS.includes(kind) ? kind : 'host', arm: this.arm?.id ?? null, reason }) }
  /** 只解 kinds 里的那几种停；回 { ok, kind? , reason? }。 */
  unstop (reason, { kinds = ['overrun', 'provider'] } = {}) {
    if (!this.stopped) return { ok: true, was: null }
    const kind = this.stopped.kind
    if (!kinds.includes(kind)) return { ok: false, reason: 'kind-not-allowed', kind }
    this._append({ type: 'unstop', reason, kind })
    return { ok: true, was: kind }
  }

  /**
   * 边界。begin 时：停着、或剩的钱不够（question：need 或 plannedCalls × estPerCall；arm：requireFull 时整份 estimate）就拒绝。
   * 返回 { ok, reason?, remaining }。
   */
  boundary ({ kind, phase, id, provider, plannedCalls = 1, estPerCall = 0, need = null, estimate = null, requireFull = false, status = null }) {
    if (!['arm', 'question'].includes(kind) || !['begin', 'end'].includes(phase) || typeof id !== 'string' || !id) return { ok: false, reason: 'bad-boundary' }
    const remaining = this.remaining(provider)
    if (phase === 'begin') {
      if (this.stopped) return { ok: false, reason: 'stopped', kind: this.stopped.kind, detail: this.stopped.reason, remaining }
      const want = kind === 'question' ? round6(need !== null && Number(need) > 0 ? Number(need) : plannedCalls * estPerCall) : (requireFull ? Number(estimate ?? 0) : 0)
      if (want > remaining + 1e-9) {
        this._append({ type: 'boundary-refused', kind, id, provider, need: want, remaining })
        return { ok: false, reason: 'insufficient-budget', need: want, remaining }
      }
    }
    this._append({ type: 'boundary', kind, phase, id, provider, plannedCalls, estPerCall, need, estimate, requireFull, status })
    return { ok: true, remaining }
  }

  summary () {
    const out = {}
    for (const [k, p] of Object.entries(this.by)) out[k] = { cap: this.cap(k), settled: p.settled, open: p.open.size, committed: this.committed(k), remaining: this.remaining(k), headroom: this.headroom(k), calls: p.calls, settledCalls: p.settledCalls, failedCalls: p.failedCalls, refused: p.refused, estimateSettled: p.estimateSettled }
    return { providers: out, stopped: this.stopped, arm: this.arm, armTotals: Object.fromEntries(this.armTotals), question: this.question, incompleteQuestions: [...this.incomplete], tornLines: this.torn }
  }
}
