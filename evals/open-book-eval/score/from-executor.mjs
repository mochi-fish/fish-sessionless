// 执行端（lib/executor.mjs 的 runHalf）落的盘 → 判分要的「半边记录」（NOTES-C 第二节）。
//   halfRecordFromExecutor({ halfDir, frontRecords, meta }) → 记录对象
//   halfDir 里：result.json、history.json、transcript.jsonl（runHalf 写的）。
//   frontRecords：EgressFront 的记录（front.records 或 front.jsonl 读出来的行；要 kind:'main' 的 wireSha、wireFile）。
//   meta：{ runId, arm, fingerprint, worldId, seed, cut, itemId, half:'A'|'B'|'C', pass, gateMode, runDir? }
// 工具结果的正文从 history.json 里拿（transcript 只记长度）；门挡没挡看 transcript 里每一下的 rec.route === 'gate'，
// audit 时「会挡」看 rec.gate.verdict === 'deny'。wire 路径给了 runDir 就写成相对它的。
import { readFileSync, existsSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

const OUTCOME = { text: 'answered', im_send: 'answered', empty: 'empty', 'max-steps': 'maxSteps', refusal: 'refusal', error: 'error' }

const textOf = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }])
  .filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n') : '')

export function halfRecordFromExecutor ({ halfDir, frontRecords = [], meta }) {
  const rd = (f) => JSON.parse(readFileSync(join(halfDir, f), 'utf8'))
  const result = rd('result.json')
  const history = rd('history.json')
  const tx = readFileSync(join(halfDir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const start = tx.find((x) => x.kind === 'start')
  const stepRecs = tx.filter((x) => x.kind === 'step')
  // 新的部分从探针后面开始（探针后面要是紧跟一条 system，也跳过）
  let i = (start?.prefixMessages ?? 0) + 1
  if (history[i]?.role === 'system') i++
  const toolRec = new Map()
  for (const s of stepRecs) for (const r of s.tools ?? []) toolRec.set(r.id, r)
  const wireBySha = new Map(frontRecords.filter((r) => r.kind === 'main' && r.wireSha).map((r) => [r.wireSha, r.wireFile]))
  const rel = (p) => (p && meta.runDir && isAbsolute(p) ? relative(meta.runDir, p).split('\\').join('/') : p ?? null)
  const steps = []
  let k = 0
  for (; i < history.length; i++) {
    const m = history[i]
    if (m.role !== 'assistant') continue
    const sr = stepRecs[k++] ?? {}
    const uses = (m.content ?? []).filter((b) => b.type === 'tool_use')
    const next = history[i + 1]
    const results = new Map((next?.role === 'user' ? next.content ?? [] : []).filter((b) => b.type === 'tool_result').map((b) => [b.tool_use_id, b]))
    const toolCalls = uses.map((u) => {
      const r = results.get(u.id)
      const tr = toolRec.get(u.id)
      return {
        id: u.id, name: u.name, args: u.input ?? {}, resultText: resultText(r?.content), error: r?.is_error === true,
        gated: tr?.route === 'gate', wouldDeny: tr?.gate?.verdict === 'deny', route: tr?.route ?? null,
      }
    })
    steps.push({ wireFile: rel(wireBySha.get(sr.wireSha) ?? null), wireSha: sr.wireSha ?? null, assistant: { text: textOf(m.content) }, toolCalls })
  }
  // 拒答、出错的那一步没有 assistant 消息：也记一步（带 wire），免得第③层少看一份
  for (; k < stepRecs.length; k++) steps.push({ wireFile: rel(wireBySha.get(stepRecs[k].wireSha) ?? null), wireSha: stepRecs[k].wireSha ?? null, assistant: { text: '' }, toolCalls: [] })
  const imSends = (result.ims ?? []).filter((x) => x.ok).map((x) => ({ chat: x.chat, text_zh_cn: x.text, text_ja_jp: x.ja ?? '' }))
  // 复核 V2：走满步数、但中途说过可见的话的，那段话记成草稿（outcome 'draft'，判分当答了，另行报数）
  const draft = result.outcome === 'max-steps' && result.answer?.kind === 'draft'
  const final = { text: result.answer?.kind === 'text' || draft ? String(result.answer.text ?? '') : '' }
  if (existsSync(join(halfDir, 'result.json')) && !(result.outcome in OUTCOME)) throw new Error(`不认识的结局 ${result.outcome}`)
  return {
    v: 1, runId: meta.runId, arm: meta.arm, fingerprint: meta.fingerprint, worldId: meta.worldId, seed: meta.seed, cut: meta.cut,
    itemId: meta.itemId, half: meta.half, pass: meta.pass ?? 1, gateMode: meta.gateMode ?? 'audit',
    outcome: draft ? 'draft' : OUTCOME[result.outcome], executorOutcome: result.outcome, finalStepNoTools: result.finalStepNoTools === true, steps, final, imSends,
  }
}
