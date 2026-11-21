#!/usr/bin/env node
// 拼「中文养成向」规则包：读 texts/ 下的各段正文，换掉称呼占位符，写出两份文件。
//   dist/fish.json            规则包本体，放进 billion-context 的包目录（~/.config/billion-context/packs/）
//   dist/compress-block.json  四段规则正文，放进 billion-context.json 的 "compress" 键
//   dist/sha256.txt           两份文件的 sha256
// 用法：node build.mjs [--owner 主人] [--maintainer 维护助手] [--out <目录>] [--check]
//   --owner       陪伴体怎么称呼她的主人（缺省「主人」）。正文里的 {{owner}} 换成它。
//   --maintainer  帮主人照看部署的那个 AI 助手叫什么（缺省「维护助手」）。正文里的 {{maintainer}} 换成它。
//   --out         写到哪个目录（缺省本目录的 dist/）。
//   --check       只检查、不写文件。
// 两个抬头（平常 / 紧急）的末尾自动接上 philosophy.txt 的全文：内核看到这两格被覆盖，就不再自己接道理，所以要抄进来。
// 写出来的文件不带 BOM，换行是 \n。有一项检查不过就不写，退出码 1；参数错退 2。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = { owner: '主人', maintainer: '维护助手', out: join(here, 'dist'), check: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  const val = () => { const v = args[++i]; if (v === undefined) usage(`${a} 后面要跟值`); return v }
  if (a === '--owner') opt.owner = val()
  else if (a === '--maintainer') opt.maintainer = val()
  else if (a === '--out') opt.out = resolve(val())
  else if (a === '--check') opt.check = true
  else usage(`不认识的参数 ${a}`)
}
function usage (msg) { console.error(msg + '\n用法：node build.mjs [--owner 主人] [--maintainer 维护助手] [--out <目录>] [--check]'); process.exit(2) }
const SEP = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']')
for (const [k, v] of [['--owner', opt.owner], ['--maintainer', opt.maintainer]]) {
  if (!v || v.length > 12 || /[\s{}「」"\\]/.test(v) || SEP.test(v)) usage(`${k} 要是 1 到 12 个字、不带空白、引号和括号`)
  if (/[他她]/.test(v)) usage(`${k} 里不要有「他」「她」：规则里要求点名不用代词，称呼里带了会和这一条打架`)
}
if (opt.owner === opt.maintainer) usage('--owner 和 --maintainer 不能一样')

const read = (n) => readFileSync(join(here, 'texts', n), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
const fill = (s) => s.split('{{owner}}').join(opt.owner).split('{{maintainer}}').join(opt.maintainer)
const T = Object.fromEntries(Object.entries({
  compressPhilosophy: 'philosophy.txt',
  howToCompressRules: 'how-to-compress.txt',
  tier2DistillRules: 'tier2.txt',
  tier3CondenseRules: 'tier3.txt',
  summariesInContext: 'summaries-in-context.txt',
  t2Guidance: 't2-guidance.txt',
  t3Guidance: 't3-guidance.txt',
  efficiencyHead: 'efficiency-head.txt',
  emergencyHead: 'emergency-head.txt',
}).map(([k, f]) => [k, fill(read(f))]))
const meta = JSON.parse(read('pack.json'))
const tools = JSON.parse(fill(read('tool-prompts.json')))

let fail = 0
const check = (ok, what) => { if (!ok) { console.error('FAIL ' + what); fail++ } }

// ---- 字面检查：给陪伴体看的字
const own = (s) => s.split(opt.owner).length - 1
for (const [k, v] of Object.entries(T)) {
  check(!SEP.test(v), `${k}: 不能有 U+2028 / U+2029`)
  check(!/[他她]/.test(v), `${k}: 不能有「他」「她」（点名，不用代词）`)
  check(!/\{\{|\}\}/.test(v), `${k}: 还有没换掉的占位符`)
  check((v.match(/Open objectives/g) ?? []).length === (v.match(/旧[^。\n]{0,8}「Open objectives」/g) ?? []).length, `${k}: 提到「Open objectives」的地方只能是在说旧摘要里的那一栏`)
}
check(own(T.howToCompressRules) > 0 && own(T.summariesInContext) > 0, '写摘要和读摘要两处都要点名主人')
check(/日子/.test(T.howToCompressRules.split('\n').slice(0, 6).join('\n')), '写摘要的头几行就是「第一行写日子」')
check(['howToCompressRules', 'tier2DistillRules', 'tier3CondenseRules'].every((k) => /记不清/.test(T[k])), '三层都要求「记不清」照实说')
check(['howToCompressRules', 'tier2DistillRules', 'tier3CondenseRules', 'summariesInContext'].every((k) => /便条/.test(T[k])), '还开着的事四处都以便条为准')
check(['howToCompressRules', 'tier2DistillRules', 'tier3CondenseRules', 'summariesInContext'].every((k) => /搁着的/.test(T[k])), '四处都认「搁着的」')
check(['summariesInContext', 'tier2DistillRules', 'tier3CondenseRules'].every((k) => T[k].includes('重折，未核原话')), '读摘要和二三层都保留「重折，未核原话」的标记')
check(/只抄便条的句子本身/.test(T.howToCompressRules) && /调不了工具/.test(T.howToCompressRules), '便条那一行的写法和翻不了便条时的写法都在')
check(/每个源块留 3 到 6 条、40 到 100 字/.test(T.tier2DistillRules), '第二层的长度按源块算')
check(/preflight/.test(T.summariesInContext), '读摘要那一节点明 preflight 是代理代写的')
for (const [name, t] of Object.entries(tools)) {
  check(typeof t.description === 'string' && t.description.length > 0, `toolPrompts.${name}: 要有 description`)
  check(!/[他她]/.test(JSON.stringify(t)) && !SEP.test(JSON.stringify(t)), `toolPrompts.${name}: 不能有「他」「她」或 U+2028 / U+2029`)
}
check(JSON.stringify(Object.keys(tools)) === JSON.stringify(['compress', 'decompress', 'search_context']), 'toolPrompts 正好是 compress、decompress、search_context')

// ---- 拼
const pack = {
  name: meta.name,
  version: meta.version,
  description: meta.description,
  promptSections: { summariesInContext: T.summariesInContext },
  nudgeSections: {
    t2Guidance: T.t2Guidance,
    t3Guidance: T.t3Guidance,
    efficiencyNote: `${T.efficiencyHead}\n\n${T.compressPhilosophy}`,
    emergencyHeader: `${T.emergencyHead}\n\n${T.compressPhilosophy}`,
  },
  toolPrompts: tools,
}
const compressBlock = {
  acknowledgePromptsRisk: true,
  promptPack: meta.name,
  prompts: {
    compressPhilosophy: T.compressPhilosophy,
    howToCompressRules: T.howToCompressRules,
    tier2DistillRules: T.tier2DistillRules,
    tier3CondenseRules: T.tier3CondenseRules,
  },
}
check(pack.nudgeSections.efficiencyNote.endsWith('\n\n' + compressBlock.prompts.compressPhilosophy) && pack.nudgeSections.emergencyHeader.endsWith('\n\n' + compressBlock.prompts.compressPhilosophy), '两个抬头的末尾和 compressPhilosophy 逐字相同')

if (fail) { console.error(`${fail} 项没过，没写文件`); process.exit(1) }
const sha = (s) => createHash('sha256').update(s).digest('hex')
const packJson = JSON.stringify(pack, null, 2) + '\n'
const blockJson = JSON.stringify(compressBlock, null, 2) + '\n'
const lines = [`fish.json ${sha(packJson)}`, `compress-block.json ${sha(blockJson)}`, `owner ${opt.owner}`, `maintainer ${opt.maintainer}`]
if (!opt.check) {
  mkdirSync(opt.out, { recursive: true })
  writeFileSync(join(opt.out, 'fish.json'), packJson)
  writeFileSync(join(opt.out, 'compress-block.json'), blockJson)
  writeFileSync(join(opt.out, 'sha256.txt'), lines.join('\n') + '\n')
}
console.log(lines.join('\n'))
