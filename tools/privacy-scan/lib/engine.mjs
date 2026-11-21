// 扫描引擎：把公开规则、私有层（真值 + 原话指纹）、禁发关键词跑在一批「目标」上。
// 目标可以是目录树（scanDir）或 git 的一份要推的历史（scanGit）。命中只记位置和长度，不记命中的字。
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { TEXT_RULES, PATH_RULES, isBinary } from './rules.mjs'
import { matchesAny } from './config.mjs'
import { buildTermMatcher, privateEntries, termId } from './private.mjs'
import { normalizeUnits, matchRuns } from './fingerprint.mjs'
import { collectGit, readBlobs } from './git.mjs'
import { canonWidth, decodeView } from './decode.mjs'

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** 行列号（1 起）；同一段文字多处命中时只建一次行首表 */
function lineColFn (text) {
  let starts = null
  return (index) => {
    if (!starts) {
      starts = [0]
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
    }
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1 }
    return { line: lo + 1, col: index - starts[lo] + 1 }
  }
}
const lineCol = (text, index) => lineColFn(text)(index)

/** 解码视图里 [a, b) 连同两边各一个字，有没有从转义还原出来的 */
function touchesEscape (dv, a, b) {
  const n = dv.esc.length - 1
  const lo = Math.max(0, a - 1)
  const hi = Math.min(n, b + 1)
  return dv.esc[hi] - dv.esc[lo] > 0
}

/**
 * opts：
 *   config       makeConfig() 的结果
 *   layer        私有层（validateLayer 过的），可省
 *   extraTerms   [{ kind, value, label }]：禁发关键词这类，命中报 label，不报值
 */
export function createScanner ({ config, layer = null, extraTerms = [] }) {
  const entries = layer ? privateEntries(layer) : []
  for (const t of extraTerms) {
    const v = String(t.value ?? '').trim()
    if (v) entries.push({ kind: t.kind ?? 'embargo', value: v, id: t.label ?? `${t.kind ?? 'embargo'}`, layer: t.layer ?? 'embargo' })
  }
  const matcher = buildTermMatcher(entries, { digitSets: layer?.digitSets ?? [] })
  const fps = layer ? layer.fingerprints.filter((f) => f.set.size > 0) : []
  const allowIds = layer?.allowIds ?? new Set()
  const findings = []
  const stats = { targets: 0, bytes: 0, binaries: 0, byRule: {}, suppressed: 0 }

  const publicAllowed = (path, rule) => config.allow.some((a) => a.rule === rule && a.re.test(path))
  const add = (f) => {
    if (f.layer === 'public' && publicAllowed(f.path, f.rule)) { stats.suppressed++; return }
    if (f.layer === 'private' && f.id && allowIds.has(f.id)) { stats.suppressed++; return }
    findings.push(f)
    stats.byRule[f.rule] = (stats.byRule[f.rule] ?? 0) + 1
  }

  /**
   * 一段文字（文件内容、提交说明、路径名）。看两遍：
   *   1. 原文（全角 ASCII 先换半角，下标不变）：公开规则、真值；原话指纹按 NFKC 规整后的原文。
   *   2. 有转义时的解码视图（\uXXXX、%HH、\xHH、&#…;，见 decode.mjs）：同样的规则再过一遍，
   *      只留下碰到了解码出来的字的命中（别的第一遍已经报过），位置换回原文。
   */
  function scanText (path, text, { isPath = false, where = path } = {}) {
    const rules = isPath ? PATH_RULES : TEXT_RULES
    const ctx = { path, config, isPath }
    const canon = canonWidth(text)
    const lc = lineColFn(text)
    const pathTag = isPath ? { inPathName: true } : {}
    const at = (i) => (isPath ? { line: 0, col: i + 1 } : lc(i))
    // 同一条规则在原文同一个位置只报一次（解码那一遍和原文那一遍可能认出同一处）
    const seenAt = new Set()
    const once = (rule, i) => { const k = `${rule}@${i}`; if (seenAt.has(k)) return false; seenAt.add(k); return true }
    const pass = (view, keep, toOrig, viaEscape) => {
      for (const r of rules) {
        if (viaEscape && r.id === 'line-sep') continue // 写成反斜杠 u 2028 这种转义正是该有的写法
        for (const h of r.scan(view, ctx)) {
          if (!keep(h.index, h.index + h.length)) continue
          const o = toOrig(h.index)
          if (!once(r.id, o)) continue
          add({ layer: 'public', rule: r.id, path: where, ...at(o), length: h.length, ...pathTag, ...(viaEscape ? { viaEscape: true } : {}) })
        }
      }
      if (matcher.size) {
        for (const h of matcher.scan(view)) {
          if (!keep(h.index, h.index + h.length)) continue
          const o = toOrig(h.index)
          const rule = h.entry.layer === 'private' ? `private:${h.entry.kind}` : h.entry.id
          if (!once(`${rule}#${h.entry.id}`, o)) continue
          add({ layer: h.entry.layer, rule, id: h.entry.id, path: where, ...at(o), length: h.length, ...pathTag, ...(viaEscape ? { viaEscape: true } : {}) })
        }
      }
    }
    pass(canon, () => true, (i) => i, false)
    const dv = decodeView(canon)
    // 解码那一遍只留碰到了还原出来的字、或者紧挨着它的命中（%22 这种转义改的是边界：原文里号和前面的 22 连成一串）
    if (dv) pass(dv.text, (a, b) => touchesEscape(dv, a, b), (i) => dv.map[i], true)

    if (fps.length && !isPath) {
      fingerprintPass(text, null)
      if (dv) fingerprintPass(dv.text, dv)
    }

    function fingerprintPass (src, view) {
      const norm = normalizeUnits(src)
      // 规整后的下标 → 原文下标。原文那一遍沿用 NFKC 串上的行列（NFKC 不增减换行）；
      // 解码那一遍逐字 NFKC 建一张回指表，再经 view.map 回到原文
      let back = null
      if (view) {
        back = []
        let d = 0
        for (const ch of src) { const n = ch.normalize('NFKC').length; for (let k = 0; k < n; k++) back.push(d); d += ch.length }
        back.push(src.length)
      }
      const lcn = view ? null : lineColFn(norm.s)
      const toDecoded = (p) => back[Math.min(p, back.length - 1)]
      for (const f of fps) {
        for (const run of matchRuns(norm, f.set, f)) {
          const s0 = norm.pos[run.startUnit]
          const s1 = norm.pos[run.endUnit - 1] + 1
          let pos, end
          if (view) {
            const a = toDecoded(s0)
            const b = toDecoded(s1)
            if (!touchesEscape(view, a, b)) continue // 没碰到转义：原文那一遍报过了
            pos = lc(view.map[a])
            end = lc(view.map[Math.min(b, view.map.length - 1)])
          } else {
            pos = lcn(s0)
            end = lcn(s1)
          }
          if (!once(`fp:${f.rule}`, `${pos.line}:${pos.col}`)) continue
          const id = termId(layer.key, f.rule, norm.units.slice(run.startUnit, run.endUnit).join(''))
          add({ layer: 'private', rule: f.rule, id, path: where, line: pos.line, col: pos.col, endLine: end.line, endCol: end.col, units: run.endUnit - run.startUnit, ...(view ? { viaEscape: true } : {}) })
        }
      }
    }
  }

  /**
   * 二进制里夹着的明文（PNG 的文字块、EXIF、PDF 的作者和路径、可执行文件里编进去的路径）：
   * 抽出 5 个字以上的可打印串，只过带用户名的路径和真值。放行了的二进制（allowBinary）也照过。
   * 压缩过的块（zTXt、PDF 的流）看不见；图里画着的字更看不见，放行图片之前要人看过。
   */
  function scanEmbedded (path, buf, where) {
    const runs = []
    const latin = buf.toString('latin1')
    for (const m of latin.matchAll(/[\x20-\x7e]{5,}/g)) runs.push(m[0])
    const u = buf.toString('utf8')
    for (const m of u.matchAll(/[^\x00-\x1f\x7f\ufffd]{3,}/gu)) if (/[^\x00-\x7f]/.test(m[0])) runs.push(m[0])
    if (!runs.length) return
    const text = runs.join('\n')
    const hits = []
    for (const r of TEXT_RULES) if (r.id === 'user-path') for (const h of r.scan(text, { path, config, isPath: false })) hits.push({ layer: 'public', rule: r.id })
    if (matcher.size) for (const h of matcher.scan(text)) hits.push({ layer: h.entry.layer, rule: h.entry.layer === 'private' ? `private:${h.entry.kind}` : h.entry.id, id: h.entry.id })
    for (const h of hits) add({ ...h, path: where, line: 0, col: 0, inBinary: true })
  }

  /** 一个文件（buf 是全部字节） */
  function scanFile (path, buf, { where = path, mode = '100644' } = {}) {
    stats.targets++
    stats.bytes += buf.length
    scanText(path, path, { isPath: true, where })
    if (mode === '120000') { add({ layer: 'public', rule: 'symlink', path: where, line: 0, col: 0 }); return }
    if (mode === '160000') { add({ layer: 'public', rule: 'submodule', path: where, line: 0, col: 0 }); return }
    if (buf.length > config.maxBytes && !matchesAny(path, config.allowLarge)) {
      add({ layer: 'public', rule: 'oversize', path: where, line: 0, col: 0, length: buf.length })
    }
    if (isBinary(buf, path)) {
      stats.binaries++
      if (!matchesAny(path, config.allowBinary)) add({ layer: 'public', rule: 'binary', path: where, line: 0, col: 0, length: buf.length })
      scanEmbedded(path, buf, where)
      return
    }
    // 不是 UTF-8 的文字（Windows 上的命令输出常是 GBK）：按 UTF-8 硬读会把中文读成乱码，原话、昵称就认不出了。
    // 报 not-utf8，再按 GB18030 读出来照常扫
    let text
    try { text = UTF8.decode(buf) } catch {
      add({ layer: 'public', rule: 'not-utf8', path: where, line: 0, col: 0 })
      try { text = new TextDecoder('gb18030').decode(buf) } catch { text = buf.toString('utf8') }
    }
    const crlf = text.indexOf('\r\n')
    if (crlf >= 0 && !matchesAny(path, config.crlfAllowed)) {
      const { line } = lineCol(text, crlf)
      add({ layer: 'public', rule: 'crlf', path: where, line, col: 0 })
    }
    scanText(path, text, { where })
  }

  function scanDir (root) {
    const walk = (dir) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, d.name)
        const rel = relative(root, full).split(sep).join('/')
        if (d.name === '.git') continue
        const st = lstatSync(full)
        if (st.isSymbolicLink()) { scanText(rel, rel, { isPath: true }); add({ layer: 'public', rule: 'symlink', path: rel, line: 0, col: 0 }); continue }
        if (st.isDirectory()) { walk(full); continue }
        if (!st.isFile()) continue
        let buf
        try { buf = readFileSync(full) } catch { add({ layer: 'public', rule: 'unreadable', path: rel, line: 0, col: 0 }); continue }
        scanFile(rel, buf)
      }
    }
    walk(root)
    return result()
  }

  function scanGit (repo, opts = {}) {
    const g = collectGit(repo, opts)
    const blobs = new Map()
    const want = g.blobs.filter((b) => b.type === 'blob').map((b) => b.sha)
    for (const [k, v] of readBlobsChunked(repo, want)) blobs.set(k, v)
    for (const b of g.blobs) {
      const where = b.inHead ? b.path : `${b.path} @${b.commit.slice(0, 10)}（历史）`
      if (b.type !== 'blob') { scanText(b.path, b.path, { isPath: true, where }); add({ layer: 'public', rule: b.type === 'commit' ? 'submodule' : 'unreadable', path: where, line: 0, col: 0 }); continue }
      scanFile(b.path, blobs.get(b.sha), { where, mode: b.mode })
    }
    for (const t of g.texts) { stats.targets++; scanText(t.path, t.text, { where: t.path }) }
    stats.commits = g.commits.length
    stats.resolved = g.resolved
    return result()
  }

  function result () {
    return { findings: findings.slice(), stats: { ...stats, byRule: { ...stats.byRule } }, clean: findings.length === 0 }
  }

  return { scanText, scanFile, scanDir, scanGit, result }
}

/** 分批读 blob，免得一次的输出太大 */
function readBlobsChunked (repo, shas) {
  const uniq = [...new Set(shas)]
  const res = new Map()
  for (let i = 0; i < uniq.length; i += 500) {
    for (const [k, v] of readBlobs(repo, uniq.slice(i, i + 500))) res.set(k, v)
  }
  return res
}

/** 给人看的报告：只有规则、位置、长度、编号 */
export function formatReport ({ findings, stats }, { max = 200 } = {}) {
  const lines = []
  const files = new Set(findings.map((f) => f.path))
  lines.push(`privacy-scan：${findings.length} 处命中，${files.size} 个位置（扫了 ${stats.targets} 项，${stats.bytes} 字节${stats.commits !== undefined ? `，${stats.commits} 个提交` : ''}；放过 ${stats.suppressed} 处）`)
  for (const [r, n] of Object.entries(stats.byRule).sort()) lines.push(`  ${r}: ${n}`)
  for (const f of findings.slice(0, max)) {
    const loc = f.line ? `${f.path}:${f.line}:${f.col}` : f.path
    const extra = f.units ? `连续 ${f.units} 个字` : (f.length !== undefined ? `长 ${f.length}` : '')
    lines.push(`  [${f.layer}] ${f.id && f.layer !== 'public' ? f.id : f.rule}  ${loc}${f.inPathName ? '（路径名）' : ''}  ${extra}`)
  }
  if (findings.length > max) lines.push(`  …还有 ${findings.length - max} 处没列`)
  return lines.join('\n')
}
