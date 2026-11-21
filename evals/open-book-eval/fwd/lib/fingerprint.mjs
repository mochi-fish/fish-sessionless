// 指纹（eval.md 4.1）：一次跑的「模型、思考档、部署、代理构建、门、搜索、相对日期、题集 / 判官 / 执行器」写成一份规范 JSON，
// sha256 就是指纹 id。每个跑的目录只认一个指纹（第一次写 fingerprint.json，之后对不上就不起）；
// 汇总时 assertSameFingerprint 拒绝把不同指纹的行混在一起（照 dsh-soul 的 incomparable_runs）。
//
// 转发器自己填的：route / providerModel / reasoning / maxTokens / sampling / fidelity / usageFeedback / transforms / forwarder
// （转发器代码、内核转换函数、单价表的 sha）/ servingStack（Qwen：声明的部署文件 + 起来时 /v1/models 现取的）。
// 执行器那边填的（配置里的 fingerprintExtra 原样并进来）：proxy{buildSha,commit,packSha,sessionCfgSha} / gate{audienceSha,mode} /
// fish / search / reldate / heard / view / questions{setSha,rubricSha,seed} / executorSha / judge{models,promptSha}。
// strict（真跑）时这些键一个都不能少。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canonicalJson, sha256, writeAtomic } from './util.mjs'

export const FINGERPRINT_VERSION = 1
export const REQUIRED_EXTRA = Object.freeze(['proxy', 'gate', 'search', 'reldate', 'questions', 'executorSha', 'judge'])

export class FingerprintError extends Error { constructor (code, msg) { super(msg); this.code = code } }

/** 目录下全部 .mjs/.cjs/.json 的 sha（按相对路径排好）→ 一个 sha。 */
export function treeSha (dir, { skip = [] } = {}) {
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      const rel = relative(dir, p).replace(/\\/g, '/')
      if (skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(mjs|cjs|json)$/.test(n)) files.push([rel, sha256(readFileSync(p))])
    }
  }
  walk(dir)
  return { sha: sha256(canonicalJson(files)), files: files.length }
}

/**
 * @param {object} o
 *   target: { provider, model, route, baseUrlHost, effort?, thinkingLevel?, maxTokens, sampling?, contextWindow?, anthropic?, openai?, gemini? }
 *   usageFeedback: 'pinned'|'real'; arm: 'synthetic'|'real'; transforms: { ...config, codeSha, relDateSha }
 *   forwarder: { codeSha, kernelWireSha, kernelCommit, pricesSha }; servingStack: object|null
 *   summaryPolicy, cacheFrom（离线重放时源头那份的指纹 id）, extra（执行器的那些键）
 */
export function buildFingerprint (o, { strict = false } = {}) {
  const extra = o.extra ?? {}
  if (strict) {
    const missing = REQUIRED_EXTRA.filter((k) => extra[k] === undefined || extra[k] === null)
    if (missing.length) throw new FingerprintError('MISSING', `fingerprint extra is missing: ${missing.join(', ')}`)
    if (o.target.provider === 'openai' && !o.servingStack) throw new FingerprintError('MISSING', 'openai target needs servingStack (declared deploy + live /v1/models)')
  }
  const fp = {
    v: FINGERPRINT_VERSION,
    route: { provider: o.target.provider, route: o.target.route, host: o.target.baseUrlHost },
    providerModel: o.target.model,
    reasoning: { effort: o.target.effort ?? null, thinkingLevel: o.target.thinkingLevel ?? null, anthropicBlockBinding: o.target.anthropic?.blockBinding ?? null, openaiEnableThinking: o.target.openai?.enableThinking ?? null },
    maxTokens: o.target.maxTokens,
    sampling: o.target.sampling ?? null,
    contextConfig: { contextWindow: o.target.contextWindow ?? null },
    protocolOptions: { anthropic: o.target.anthropic ?? null, openai: o.target.openai ?? null, gemini: o.target.gemini ?? null },
    servingStack: o.servingStack ?? null,
    fidelity: 'L1-deepseek-anthropic-wire-view',
    arm: o.arm,
    usageFeedback: o.usageFeedback,
    summaryPolicy: o.summaryPolicy,
    transforms: o.transforms,
    forwarder: o.forwarder,
    cacheFrom: o.cacheFrom ?? null,
    ...extra,
  }
  const json = canonicalJson(fp)
  return { fp, id: sha256(json), json }
}

/** 跑的目录绑定指纹：没有就写；有就必须一字不差。 */
export function bindRunDir (stateDir, built) {
  const f = join(stateDir, 'fingerprint.json')
  if (existsSync(f)) {
    const prev = JSON.parse(readFileSync(f, 'utf8'))
    if (prev.id !== built.id) throw new FingerprintError('MISMATCH', `run dir ${stateDir} is bound to fingerprint ${String(prev.id).slice(0, 12)}, this config is ${built.id.slice(0, 12)}; use a new run dir`)
    return { bound: 'existing', id: prev.id }
  }
  writeAtomic(f, JSON.stringify({ id: built.id, fingerprint: built.fp }, null, 1) + '\n')
  return { bound: 'new', id: built.id }
}

/** 汇总用：每一行都要带 fingerprintId，而且都一样。 */
export function assertSameFingerprint (rows, what = 'rows') {
  const ids = new Set()
  for (const r of rows) {
    if (!r || typeof r.fingerprintId !== 'string' || !/^[0-9a-f]{64}$/.test(r.fingerprintId)) throw new FingerprintError('NO_ID', `${what}: a row has no fingerprintId`)
    ids.add(r.fingerprintId)
  }
  if (ids.size > 1) throw new FingerprintError('INCOMPARABLE', `incomparable_runs: ${what} mix ${ids.size} fingerprints (${[...ids].map((x) => x.slice(0, 12)).join(', ')})`)
  return [...ids][0] ?? null
}
