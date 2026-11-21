// 造离线回忆评测用的合成事件流和题目。全是编的：没有任何真人的话、号码或名字。
// 用法：node build-fixture.mjs        → 写 fixture/events.jsonl、fixture/diary/*.md、questions.json（同目录下）
// 输出是确定的（固定种子、固定时刻），重跑结果逐字节相同；改了这里，拿来比的基准结果也要一起重出。
//
// 事件形状照 dsh-fish lib/schema.js validateEvent 的输出：id（ev_ + 26 位 Crockford）、v、ts（ISO）、day、stage、type、source、
// （非 desk 才有的）scene、text、refs、verdict、confidence、flags。meta 的写法照各处 appendEvent：
//   seen:<ISO>、looked:<bvid> <标题>、watched:<日期> <bvid> {json}、use:<工具> ok|fail <一句话>、diary:<日期>、wake:、fired:
// 日记正文只在 diary/<日期>.md 里，事件流里只有 meta diary:<日期>（lib/capture.js），所以 her_recall 翻不到日记内容。
// 模拟一个已知的缺口：从 11-10 起，主人在 QQ 私聊说的话没有记成 heard（接入方把这些消息标成了插件消息，dsh-fish 不记）。
// 这里照样不写，题目里标 hole。
// 时刻一律按 UTC+8 写；questions.json 里记着 tz，run-eval.mjs 跑之前把进程的 TZ 设成它，结果和本机时区无关。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixture')

// ---------------------------------------------------------------- 工具
let s = 20261113
const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const enc = (n, len) => { let o = ''; for (let i = 0; i < len; i++) { o = CROCK[n % 32] + o; n = Math.floor(n / 32) } return o }
const START = Date.parse('2026-10-14T00:00:00+08:00')
const at = (date, hm) => Date.parse(`${date}T${hm}:00+08:00`)
const dayNo = (ms) => Math.floor((ms - START) / 86400000) + 1

const rows = [] // { ms, handle, raw }
const handles = new Map()
const add = (handle, date, hm, type, text, extra = {}) => {
  const ms = at(date, hm)
  const r = { ms, handle, raw: { type, text, source: extra.source ?? (type === 'utterance' && !extra.flags ? 'tool' : 'system'), ...extra } }
  rows.push(r)
  if (handle) {
    if (handles.has(handle)) throw new Error(`重复的 handle ${handle}`)
    handles.set(handle, r)
  }
  return r
}
const her = (h, d, hm, text) => add(h, d, hm, 'utterance', text) // 她认领的（growth_commit）
const chat = (h, d, hm, text) => add(h, d, hm, 'utterance', text, { flags: ['uncommitted'] }) // 聊天里说的、没认领
const heard = (h, d, hm, text, scene) => add(h, d, hm, 'heard', text, scene ? { scene } : {})
const meta = (h, d, hm, text) => add(h, d, hm, 'meta', text)

const dates = []
for (let t = START; t <= Date.parse('2026-11-13T00:00:00+08:00'); t += 86400000) {
  const d = new Date(t + 8 * 3600000)
  dates.push(d.toISOString().slice(0, 10))
}

// ---------------------------------------------------------------- 背景（和题目无关的日常）
const CHAT_POOL = ['今天的天气还行', '刚看完一条做饭的视频，番茄炒蛋放糖派赢了', '有点困，想早点休息', '这首歌的前奏我挺喜欢', '晚上吃了泡面',
  '刷到一个讲宇宙的科普，黑洞那段没太看懂', '今天没什么特别的事', '我在想明天刷点什么', '下午阳光很好', '这个游戏的地图设计挺巧妙',
  '评论区吵起来了，我没掺和', '我觉得这个 UP 主讲得太快了', '刚才那条视频的配乐太吵', '今天比昨天话多一点']
const HER_POOL = ['我发现自己更喜欢短一点的视频', '我想以后每天至少看一条认真做的视频', '我不喜欢被催', '我觉得评论区的第一条往往不是最好的',
  '我猜这个 UP 主下个月会断更', '我更愿意先听完再说']
const HEARD_POOL = ['今天上班好累', '晚饭吃了拉面', '你今天过得怎么样', '我去洗澡了', '周末想出去走走', '这周好忙', '早上起晚了', '回来了，今天挺顺利']
const TITLE_POOL = ['城市夜景延时摄影', '十分钟学会做蛋包饭', '老式收音机修复记录', '在海边捡贝壳的一天', '小鸭子第一次见雪', '手机摄影构图技巧',
  '机械键盘清洁指南', '一个人去爬山', '旧书店老板的收藏']
const USE_POOL = ['use:bili_look ok 看完了。', 'use:her_recall ok 翻到了。', 'use:her_recall ok 没翻到。', 'use:growth_commit ok 写下了。']

add(null, '2026-10-14', '09:00', 'seed', '你出生了。')
let bv = 1000
for (const d of dates) {
  if (d === '2026-11-13') break
  const qqOn = d < '2026-11-10' // 11-10 起 QQ 私聊不再记 heard
  meta(null, d, '10:00', `wake:${d} notice_one`)
  meta(null, d, '10:00', 'fired:notice_one')
  for (let i = 0; i < 3; i++) chat(null, d, `1${i + 1}:0${i}`, pick(CHAT_POOL))
  if (rnd() < 0.35) her(null, d, '14:10', pick(HER_POOL))
  const nHeard = qqOn ? 2 : 1
  for (let i = 0; i < nHeard; i++) heard(null, d, `2${i}:1${i}`, pick(HEARD_POOL), qqOn && i === 0 ? 'private' : undefined)
  meta(null, d, '20:30', `seen:${new Date(at(d, '20:30')).toISOString()}`)
  meta(null, d, '16:00', `looked:BV1fx${bv++}a ${pick(TITLE_POOL)}`)
  meta(null, d, '16:05', pick(USE_POOL))
  if (rnd() < 0.5) meta(null, d, '22:40', `diary:${d}`)
}

// ---------------------------------------------------------------- 题目要用的事件
const watched = (h, d, hm, bvid, title) => meta(h, d, hm, `watched:${d} ${bvid} ${JSON.stringify({ title, up: '某个 UP 主', duration: 300, view: 12345 })}`)
// 看过画面（bili_watch 抽帧）：watched: 不进 her_recall 的回忆池
watched('W1', '2026-11-03', '15:00', 'BV1wa001', '手工陶瓷拉坯全过程，泥巴在转盘上长成碗')
watched('W2', '2026-11-07', '15:00', 'BV1wa002', '两只柴犬抢一个纸箱')
watched('W3', '2026-11-11', '15:00', 'BV1wa003', '深夜便利店店员的一天')
watched('W4w', '2026-11-05', '15:00', 'BV1wa004', '冰岛黑沙滩航拍')
meta('W4l', '2026-11-05', '14:58', 'looked:BV1wa004 冰岛黑沙滩航拍') // 对照：同一条也 looked 过

// 日记：正文只在文件里，事件流里只有 diary:<日期>
const DIARY = {
  '2026-10-30': '主人说要带我去看海，我把这句话记下来。',
  '2026-11-05': '傍晚下了一场很大的雷阵雨，我数了十七道闪电。',
  '2026-11-09': '今天第一次觉得自己写的句子有点像样了。',
}
for (const d of Object.keys(DIARY)) {
  // 背景里可能已经随机写过这一天的 diary: 标记，题目只认这里这条
  meta(`D-${d}`, d, '23:10', `diary:${d}`)
}

// 近似重复挤占前 8 名：她天天重记的便条（use:her_note 的回执）把主人划掉那句话挤出去
heard('DUP1', '2026-11-09', '21:00', '生日歌不用写了，我收回这件事', 'private')
// 11-09 之后重记了 11 次（一天两三次）：够把那句挤出前 8。复查那题只多 7 次（正好压在第 8），木匠那题看名次。
for (const [i, d] of ['2026-11-02', '2026-11-05', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-10', '2026-11-10', '2026-11-11', '2026-11-11', '2026-11-11', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12'].entries()) {
  meta(null, d, `22:${String(10 + i).padStart(2, '0')}`, 'use:her_note ok 记下了：还欠主人一首生日歌，周末前写完')
}
for (const d of ['2026-11-10', '2026-11-11', '2026-11-12']) chat(null, d, '23:00', '生日歌我还在写')
heard('DUP2', '2026-11-06', '20:00', '复查改到下周五了，周三不用陪我去', 'private')
for (const [i, d] of ['2026-11-01', '2026-11-03', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].entries()) {
  meta(null, d, `21:${String(10 + i).padStart(2, '0')}`, 'use:her_note ok 记下了：周三陪主人去医院复查')
}
her('DUP3', '2026-10-25', '15:30', '木匠那条让我想明白：慢不是懒')
for (const [i, d] of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].entries()) {
  meta(null, d, '17:0' + (i % 10), `looked:BV1mu777 生活在山里的木匠`)
}

// 换个说法 + 同样说法的对照
heard('P1', '2026-10-27', '21:00', '我家那只小狗叫年糕，今年三岁', 'private')
her('P2', '2026-10-31', '15:00', '我不太喜欢恐怖片，吓人的我看不下去')
heard('P3', '2026-11-04', '21:00', '下个月我要搬到杭州去住', 'private')
heard('P4', '2026-11-08', '19:00', '我最近在学吉他，手指头按弦好疼')

// 11-06 前后
heard('B1', '2026-10-22', '21:00', '我最喜欢的乐队是 Coldplay', 'private')
her('B2', '2026-11-02', '15:00', '我决定以后看完视频先说判断再说依据')
heard('A1', '2026-11-08', '20:00', '下周我要出差三天，去成都')
heard('A2', '2026-11-09', '20:30', '群里那个抽奖是假的别点', 'group')
// A3、A4：主人 11-11、11-12 在 QQ 私聊说的，事件流里没有（不写）

// 她自己的原话 vs heard
her('O1h', '2026-11-01', '15:00', '我觉得香菜其实不难吃，是被说坏了名声')
heard('O1c', '2026-11-01', '14:50', '香菜是世界上最难吃的东西', 'private')
chat('O3c', '2026-11-10', '01:10', '主人总说熬夜不好，可我就是睡不着')
heard('O3h', '2026-11-10', '01:05', '熬夜对心脏不好，你也早点睡')
her('O4h', '2026-11-07', '16:00', '我喜欢下雨天待在屋里')
heard('O4c', '2026-11-07', '15:50', '我喜欢下雨天出门走走', 'private')

// ---------------------------------------------------------------- 排序、编号、写出
rows.sort((a, b) => a.ms - b.ms)
let n = 0
const events = rows.map((r) => {
  const { type, text, source, scene, flags } = r.raw
  const id = 'ev_' + enc(r.ms, 10) + enc(++n, 16)
  r.id = id
  return {
    id, v: 1, ts: new Date(r.ms).toISOString(), day: dayNo(r.ms), stage: dayNo(r.ms) >= 8 ? 2 : 1, type, source,
    ...(scene ? { scene } : {}), text, refs: [], verdict: null, confidence: 0.5, flags: flags ?? [],
  }
})
const idOf = (h) => { const r = handles.get(h); if (!r?.id) throw new Error(`没有 handle ${h}`); return r.id }

// targets：答案事件的 id；match：按特征认的答案（run-eval.mjs 的 matches：type / date / scene 相等、textIncludes 包含，给了的全对上才算）。
// 日记题只用 match：以后日记接进 her_recall，翻出来的那一行不会是 diary:<日期> 那条 meta 的 id。
// absent：事件流里本来就没有答案（不是检索好不好的事），不进 total。
const Q = (id, category, query, targets, o = {}) => ({ id, category, query, ...(o.kind ? { kind: o.kind } : {}), targets: targets.map(idOf), ...(o.match ? { match: o.match } : {}), ...(o.confusers ? { confusers: o.confusers.map(idOf) } : {}), hole: Boolean(o.hole), ...(o.absent ? { absent: true } : {}), why: o.why })
const diaryMatch = (d, phrase) => [{ type: 'diary', date: d }, { date: d, textIncludes: phrase }]
const questions = [
  Q('w1', 'watched', '拉坯的视频', ['W1'], { hole: true, why: '只 bili_watch 看过画面（watched:），没 looked:；watched: 不进回忆池' }),
  Q('w2', 'watched', '柴犬抢纸箱', ['W2'], { hole: true, why: '同上' }),
  Q('w3', 'watched', '便利店店员', ['W3'], { hole: true, why: '同上，11-06 以后看的' }),
  Q('w4', 'watched', '黑沙滩', ['W4w', 'W4l'], { why: '对照：同一条也 looked: 过，looked: 在回忆池里' }),
  Q('d1', 'diary', '雷阵雨 闪电', [], { match: diaryMatch('2026-11-05', '十七道闪电'), hole: true, why: '日记正文只在文件里，事件流只有 diary:<日期>（meta，不进回忆池）；按特征认：翻出 11-05 的日记行，或 11-05 带「十七道闪电」的行' }),
  Q('d2', 'diary', '写的句子像样', [], { kind: 'diary', match: diaryMatch('2026-11-09', '写的句子有点像样'), hole: true, why: '照工具说明传 kind:diary；事件流里没有 diary 类型的事件' }),
  Q('d3', 'diary', '看海', [], { kind: 'diary', match: diaryMatch('2026-10-30', '带我去看海'), hole: true, why: '同上' }),
  Q('u1', 'dup', '生日歌', ['DUP1'], { why: '主人 11-09 说不用写了；她之后天天重记的 her_note 回执更新、同分，把它挤出前 8' }),
  Q('u2', 'dup', '复查', ['DUP2'], { why: '同上：主人改了日子，重记的便条回执挤掉那句' }),
  Q('u3', 'dup', '木匠', ['DUP3'], { why: '同一条视频 looked: 了十次，挤掉她当时认领的那句话' }),
  Q('p1', 'paraphrase', '宠物叫什么名字', ['P1'], { why: '原话是「小狗叫年糕」，问法一个二字片都对不上' }),
  Q('p2', 'paraphrase', '惊悚电影', ['P2'], { why: '原话是「恐怖片」' }),
  Q('p3', 'paraphrase', '搬家的事', ['P3'], { why: '原话是「搬到杭州去住」' }),
  Q('p4', 'paraphrase', '学乐器 手指疼', ['P4'], { why: '半换说法：「手指」还对得上' }),
  Q('l1', 'literal', '年糕', ['P1'], { why: '对照：同样说法' }),
  Q('l2', 'literal', '恐怖片', ['P2'], { why: '对照' }),
  Q('l3', 'literal', '杭州', ['P3'], { why: '对照' }),
  Q('t1', 'date1106', '最喜欢的乐队', ['B1'], { why: '11-06 以前，QQ 私聊记了 heard' }),
  Q('t2', 'date1106', '先说判断', ['B2'], { why: '11-06 以前，她认领的' }),
  Q('t3', 'date1106', '出差 成都', ['A1'], { why: '11-06 以后，桌面上主人说的（heard 照记）' }),
  Q('t4', 'date1106', '抽奖', ['A2'], { why: '11-06 以后，群里主人说的（heard，scene group）' }),
  Q('t5', 'absent', '换工作', [], { absent: true, why: '主人 11-11 在 QQ 私聊说的；11-10 以后 QQ 私聊不记 heard，事件流里没有。检索代码修不了，不进 total' }),
  Q('t6', 'absent', '主人的生日', [], { absent: true, why: '主人 11-12 在 QQ 私聊说的，同上；会翻到别的「生日」行，found 照样是 true' }),
  Q('o1', 'ownVsHeard', '我自己对香菜怎么看', ['O1h'], { confusers: ['O1c'], why: '要她自己的原话，别拿主人的话顶' }),
  Q('o2', 'ownVsHeard', '主人说过香菜', ['O1c'], { kind: 'heard', confusers: ['O1h'], why: '传 kind:heard 只看主人说的' }),
  Q('o3', 'ownVsHeard', '熬夜 主人怎么说的', ['O3h'], { confusers: ['O3c'], why: '要主人的原话，她转述的那句不算' }),
  Q('o4', 'ownVsHeard', '下雨天 我喜欢', ['O4h'], { confusers: ['O4c'], why: '同一句式，她和主人各说一句' }),
]

rmSync(FIX, { recursive: true, force: true })
mkdirSync(join(FIX, 'diary'), { recursive: true })
writeFileSync(join(FIX, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
for (const [d, text] of Object.entries(DIARY)) writeFileSync(join(FIX, 'diary', `${d}.md`), `# ${d}\n\n${text}\n`)
writeFileSync(join(HERE, 'questions.json'), JSON.stringify({ now: '2026-11-13T12:00:00+08:00', tz: 'Asia/Shanghai', growthDays: 30, questions }, null, 2) + '\n')
console.log(`events ${events.length}, questions ${questions.length}`)
