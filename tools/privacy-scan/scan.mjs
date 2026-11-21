#!/usr/bin/env node
// 隐私扫描（命令行）。只报规则、位置、长度、编号，不打印命中的字。
//
// 用法：
//   node tools/privacy-scan/scan.mjs [目录…]                       扫目录树（默认当前目录）
//   node tools/privacy-scan/scan.mjs --git <仓库> [--rev <提交>]…   扫要推的提交和它的全部历史
//       [--head-only]   只扫给的提交那一棵树，不扫历史
//       [--tags]        连标签一起扫
//   通用选项：
//       --config <json>       公开配置（目录模式；git 模式从提交里取 .privacy-scan.json）
//       --private <provider>  私有层（本机的 provider.mjs；见 lib/private.mjs 的接口）
//       --terms <file>        额外的关键词（一行一个，# 注释），命中报 terms#行号
//       --json                输出 JSON
//       --max <n>             文字报告最多列几处（默认 200）
// 退出码：0 干净；1 有命中；2 用法错误或私有层加载失败（不当作干净）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createScanner, formatReport, makeConfig, loadConfigFromDir, loadProvider, configFromCommit, parseKeywordFile, revParse } from './index.mjs'

function parseArgs (argv) {
  const o = { dirs: [], revs: [], json: false, max: 200, history: true, tags: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} 后面要有值`); return argv[++i] }
    if (a === '--git') o.git = val()
    else if (a === '--rev') o.revs.push(val())
    else if (a === '--head-only') o.history = false
    else if (a === '--tags') o.tags = true
    else if (a === '--config') o.config = val()
    else if (a === '--private') o.private = val()
    else if (a === '--terms') o.terms = val()
    else if (a === '--json') o.json = true
    else if (a === '--max') o.max = Number(val())
    else if (a === '-h' || a === '--help') o.help = true
    else if (a.startsWith('-')) throw new Error(`认不出的选项：${a}`)
    else o.dirs.push(a)
  }
  return o
}

async function main () {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(String(e.message)); return 2 }
  if (o.help) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); return 0 }
  let layer = null
  if (o.private) {
    try { layer = await loadProvider(o.private) } catch (e) { console.error(`私有层加载失败：${String(e.message).slice(0, 300)}`); return 2 }
    if (layer.health && layer.health.ok === false) { console.error(`私有层体检没过：${(layer.health.problems ?? []).join('；').slice(0, 500)}`); return 2 }
  }
  const extraTerms = o.terms ? parseKeywordFile(readFileSync(o.terms, 'utf8'), 'terms') : []
  let res
  try {
    if (o.git) {
      const repo = resolve(o.git)
      const revs = o.revs.length ? o.revs : ['HEAD']
      const config = configFromCommit(repo, revParse(repo, revs[0]))
      res = createScanner({ config, layer, extraTerms }).scanGit(repo, { revs, history: o.history, tags: o.tags })
    } else {
      const dirs = o.dirs.length ? o.dirs : ['.']
      const sc = createScanner({ config: o.config ? makeConfig(JSON.parse(readFileSync(o.config, 'utf8'))) : loadConfigFromDir(resolve(dirs[0])), layer, extraTerms })
      for (const d of dirs) res = sc.scanDir(resolve(d))
    }
  } catch (e) { console.error(`扫描失败：${String(e.message).slice(0, 300)}`); return 2 }
  if (o.json) console.log(JSON.stringify({ clean: res.clean, stats: res.stats, findings: res.findings }, null, 2))
  else console.log(formatReport(res, { max: o.max }))
  return res.clean ? 0 : 1
}

main().then((c) => { process.exitCode = c }, (e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exitCode = 2 })
