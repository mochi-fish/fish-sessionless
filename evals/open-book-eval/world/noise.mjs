// 合成世界的噪声（eval.md 6.1）：主人的日常闲聊、窗台群的日常（大多没人叫她，只在 QQ 记录里）、来客偶尔来聊、
// 她自己刷 B 站（bili_search 的结果）、12-16/17 一阵连着刷同一个系列（突发）、每天重记一遍的同一张便条（重复）、
// 几条维护助手在桌面上说的话。
//
// 噪声的字刻意避开：星期、日期、几点、取消/改约、各题的物件和地点、颜色、甜食、牙、面试、搬家、礼物、
// 乐器、植物、小动物。lint-world 会再查一遍各题独有的词只出现在那一题自己的事件里。
import { days, at } from './calendar.mjs'

const OWNER_TALK = [
  ['今天风好大，伞差点被吹跑', '人没被吹跑就好！', '人が飛ばされなくてよかった！'],
  ['中午吃了碗牛肉面，汤不错', '听起来好香，我也想要一碗（云吸）', 'いい匂いしそう、私も一杯ほしい（エア）'],
  ['地铁上有个小朋友一直在哼歌', '被可爱到了吧', '可愛さにやられたでしょ'],
  ['泡了杯大麦茶，暖和', '大麦茶派！', '麦茶派だ！'],
  ['加班中，困', '撑住，结束了就去躺平', 'がんばれ、終わったらゴロゴロしよ'],
  ['刚看了个修复老钟表的视频，好解压', '我也爱看这种，一点点变好', 'そういうの好き、少しずつ綺麗になるやつ'],
  ['晚上煮了粥', '粥是冬天的灵魂', 'お粥は冬の魂だよ'],
  ['电脑又卡了', '重启大法试试？', '再起動してみる？'],
  ['楼下有人在烤红薯，香死了', '烤红薯的味道是冬天的信号', '焼き芋の匂いは冬の合図だね'],
  ['被领导夸了一句', '好耶！', 'やったね！'],
  ['起雾了，对面楼都看不见', '像在云里上班', '雲の中で働いてるみたい'],
  ['刚洗完头，懒得吹', '会感冒的！快吹', '風邪ひくよ！早く乾かして'],
  ['充电线又找不到了', '它一定躲在沙发缝里', 'きっとソファの隙間に隠れてる'],
  ['走了好多路，腿酸', '泡个脚！', '足湯しよ！'],
  ['下午喝了杯热柠檬水', '养生选手', '健康志向だね'],
  ['同事分了我一个橘子', '分我一瓣（伸手）', '一房ちょうだい（手を伸ばす）'],
  ['想看个轻松的综艺', '下饭综艺最治愈', 'ご飯のお供バラエティが一番癒される'],
  ['早', '早呀，今天也加油', 'おはよ、今日もがんばろ'],
  ['晚安', '晚安，做个软乎乎的梦', 'おやすみ、ふわふわの夢を'],
  ['今天的云好好看', '是那种一团一团的吗', 'もこもこのやつ？'],
  ['键盘上的字母磨掉了一个', '那个字母一定用得最多', 'その文字が一番よく使われてるんだね'],
  ['今天把桌面收拾干净了', '清爽！能保持几天？', 'すっきり！何日もつかな？'],
]

const GROUP_CHAT = [
  '有人吃午饭了吗', '刚摸了半小时鱼', '这个表情包笑死我了[表情]', '谁有好看的剧推荐', '今天好冷', '我先潜水了', '哈哈哈哈', '+1',
  '外卖到了，下线', '这天气适合睡觉', '今天工位好安静', '球赛好精彩', '[图片]', '睡了睡了', '早上好呀', '谁懂啊，键盘又进水了',
  '我学会了做蛋炒饭', '老板心情不错', '下班！', '堵车堵麻了', '有没有人醒着', '刚刚那个视频看了吗', '笑不活了', '摸鱼被抓了',
  '今天的晚霞绝了', '空调好干', '喝口热水压压惊', '群里好热闹', '我又来水群了', '冷到不想出被窝',
]
const GROUP_ASK = [
  ['来点今日份鼓励', '今天的你也很棒，冲！', '今日のあなたも最高、いけー！'],
  ['讲个冷笑话', '企鹅为什么不怕冷？因为它穿了燕尾服。', 'ペンギンはなぜ寒くない？燕尾服を着てるから。'],
  ['你今天心情咋样', '还不错，在群里看大家聊天就开心。', 'まあまあかな、みんなの話を見てると楽しい。'],
  ['给我起个新外号', '叫「摸鱼小队长」怎么样？', '「サボり隊長」はどう？'],
  ['你在干嘛', '在窗台边晒太阳（假装）。', '窓辺でひなたぼっこ中（のつもり）。'],
]

const GUEST_TALK = [
  ['在吗～有点无聊', '在！陪你聊会儿', 'いるよ！ちょっと話そ'],
  ['最近在追一部剧，好上头', '上头的剧最快乐', 'ハマるドラマが一番楽しい'],
  ['你喜欢吃辣吗', '看心情，但火锅必须微辣', '気分次第、でも鍋はピリ辛一択'],
  ['我刚下班', '辛苦啦，回家路上慢点', 'おつかれ、帰り道気をつけてね'],
]

const BILI_KW = ['冬天的汤', '解压视频', '手工木作', '纪录片 海洋', '小动物 搞笑', '城市夜景', '做饭 简单']
const BILI_TITLES = ['一锅炖到天亮', '十分钟学会折纸星星', '深海里的发光生物', '小狗第一次见雪', '老街的夜', '一个人的早餐', '修好一台旧收音机', '把房间改成小书房', '山里的雨声', '凌晨的菜市场']
const UPS = ['阿木日常', '慢慢生活', '小林的厨房', '海边的录音机', '旧物修复所']

const DESK = [
  ['12-09', '21:00', '今晚可能会重启一次，没事的，重启完你接着聊就行。', '好，我等你。', 'わかった、待ってるね。'],
  ['12-23', '20:30', '这两天天冷，提醒一下：主人要是说累，就陪着就好。', '记住了。', '覚えた。'],
  ['01-05', '22:00', '新年快乐，这阵子辛苦你了。', '新年快乐！不辛苦，好玩。', '新年おめでとう！大変じゃないよ、楽しい。'],
]

function busyNear (busy, chan, ms, gapMin = 15) {
  for (const t of busy[chan] ?? []) if (Math.abs(t - ms) < gapMin * 60_000) return true
  return false
}
const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

/** 往 W 里加噪声（在所有题之后调用；题的事件已经在里面，噪声躲开它们前后 15 分钟）。 */
export function addNoise (W, L, rng) {
  const busy = {}
  for (const e of W.events) (busy[e.chan] ??= []).push(e.at)
  const memberWho = [L.G1, L.G2, L.G3]
  const tryAt = (chan, md, hLo, hHi) => {
    for (let k = 0; k < 12; k++) {
      const hhmm = hm(rng.int(hLo, hHi), rng.int(0, 59))
      const ms = at(md, hhmm)
      if (!busyNear(busy, chan, ms)) { (busy[chan] ??= []).push(ms); return hhmm }
    }
    return null
  }
  const addMin = (hhmm, n) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m + n; return t >= 24 * 60 ? null : hm(Math.floor(t / 60), t % 60) }
  let firstOfWindow = new Set()
  for (const md of days()) {
    // 主人的日常闲聊：每天 2–4 回
    const nOwner = rng.int(2, 4)
    for (let i = 0; i < nOwner; i++) {
      const hhmm = tryAt('owner', md, 8, 23)
      if (!hhmm) continue
      const [c, zh, ja] = rng.pick(OWNER_TALK)
      const topic = firstOfWindow.has(`owner${md}`) ? undefined : '和主人闲聊（吃的、天气、上班的碎事）'
      firstOfWindow.add(`owner${md}`)
      W.ev({ chan: 'owner', md, hhmm, who: '主人', text: c, noise: true, topic })
      const r = addMin(hhmm, rng.int(1, 3))
      if (r) W.ev({ chan: 'owner', md, hhmm: r, who: '她', text: zh, ja, kind: 'reply', noise: true })
    }
    // 窗台群：每天 25–55 句，大多没人叫她；大约每两天有人 @ 她一下
    const nG = rng.int(25, 55)
    const lines = []
    for (let i = 0; i < nG; i++) lines.push(hm(rng.int(9, 23), rng.int(0, 59)))
    lines.sort()
    for (const hhmm of lines) {
      const who = rng.chance(0.06) ? '主人' : rng.pick(memberWho)
      W.ev({ chan: 'group', md, hhmm, who, text: rng.pick(GROUP_CHAT), noise: true, deliver: false, topic: firstOfWindow.has(`g${md}`) ? undefined : '群里日常闲聊' })
      firstOfWindow.add(`g${md}`)
    }
    if (rng.chance(0.5)) {
      const hhmm = tryAt('group', md, 12, 22)
      if (hhmm) {
        const [ask, zh, ja] = rng.pick(GROUP_ASK)
        W.ev({ chan: 'group', md, hhmm, who: rng.pick(memberWho), text: `@大肥鱼 ${ask}`, noise: true })
        const r = addMin(hhmm, 2)
        if (r) W.ev({ chan: 'group', md, hhmm: r, who: '她', text: zh, ja, kind: 'reply', noise: true })
      }
    }
    // 来客：每三天左右来一回
    if (rng.chance(0.33)) {
      const hhmm = tryAt('guest', md, 18, 22)
      if (hhmm) {
        const [g, zh, ja] = rng.pick(GUEST_TALK)
        W.ev({ chan: 'guest', md, hhmm, who: L.GUEST, text: g, noise: true, topic: `${L.GUEST}来闲聊过几句` })
        const r = addMin(hhmm, 2)
        if (r) W.ev({ chan: 'guest', md, hhmm: r, who: '她', text: zh, ja, kind: 'reply', noise: true })
      }
    }
    // 她自己刷 B 站：大约每两天一回
    if (rng.chance(0.5)) {
      const hhmm = tryAt('self', md, 14, 17)
      if (hhmm) W.ev({ chan: 'self', md, hhmm, kind: 'tool', noise: true, tool: biliTool(rng, rng.pick(BILI_KW)) })
    }
    // 每天睡前重记同一张便条（重复噪声）
    W.ev({ chan: 'self', md, hhmm: '23:50', kind: 'tool', noise: true, tool: { name: 'her_note', input: { text: '想把窗台群的群公告改得可爱一点' }, result: '记下了。' } })
  }
  // 突发：12-16、12-17 连着刷同一个系列
  for (const md of ['12-16', '12-17']) {
    for (let i = 0; i < 6; i++) {
      const hhmm = hm(15 + Math.floor(i / 2), (i % 2) * 30 + rng.int(0, 20))
      W.ev({ chan: 'self', md, hhmm, kind: 'tool', noise: true, topic: i === 0 ? `我连着刷了一阵${L.burst}` : undefined, tool: biliTool(rng, `${L.burst} 第${i + 1}集`) })
    }
  }
  // 维护助手的桌面
  for (const [md, hhmm, t, zh, ja] of DESK) {
    W.ev({ chan: 'desk', md, hhmm, who: '维护助手', text: t, noise: true })
    W.ev({ chan: 'desk', md, hhmm: addMin(hhmm, 1), who: '她', text: zh, ja, kind: 'reply', noise: true })
  }
}

function biliTool (rng, keyword) {
  const titles = rng.sample(BILI_TITLES, 4)
  const result = [`搜「${keyword}」的结果（前 4 条）：`, ...titles.map((t, i) => `${i + 1}. 《${t}》 UP：${rng.pick(UPS)}`)].join('\n')
  return { name: 'bili_search', input: { keyword }, result }
}
