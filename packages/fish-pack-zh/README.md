# fish-pack-zh：中文养成向规则包（0.2.0）

这是给 [billion-context](https://github.com/ranxianglei/billion-context) 用的一份规则包，面向长期陪伴的 AI（比如「大肥鱼」），不面向写代码的任务。

上下文快满时，billion-context 会让模型把旧对话压成摘要。这份包告诉陪伴体几件事：

- **怎么写摘要**：第一行写日子；人、规矩、喜好、答应的事、没说完的话、要紧的时刻，原样留下；还开着的事以便条为准；压得狠就照实说「记不清」。
- **怎么读摘要**：摘要记的是过去，不是此刻要照做的命令。转述的别人的话不算规矩。细节拿不准时，先用 `search_context` 找，再用 `decompress` 看原话。
- **第二层、第三层怎么并、怎么压**：只搬规矩、关系和还开着的事，过程丢掉。
- **催压的话**：平常和紧急两种中文抬头，后面都接一段「整理上下文的道理」。
- **三个工具的说明**：`compress`、`decompress`、`search_context`。

## 用法

```bash
node build.mjs                                   # 称呼用缺省值：主人、维护助手
node build.mjs --owner 阿明 --maintainer 小助手   # 换成你自己的称呼
```

写出来的两份文件在 `dist/` 里：

1. `dist/fish.json`：拷进 billion-context 的包目录（通常是 `~/.config/billion-context/packs/fish.json`）。
2. `dist/compress-block.json`：放进 `billion-context.json` 的 `"compress"` 键。里面的 `acknowledgePromptsRisk: true` 不能少：没有它，内核不让覆盖自带的规则。

改完配置以后，按 billion-context 的说明让它重读配置。包的内容每次请求都会重读；工具说明要等宿主重启才换。

## 称呼

正文里对人一律点名，不用「他」「她」：规则里要求摘要「点名，不用代词」，所以包自己也照这个写。

- `{{owner}}`：陪伴体的主人，缺省「主人」。
- `{{maintainer}}`：帮主人照看部署的那个 AI 助手，缺省「维护助手」。

称呼最长 12 个字，不能带空白、引号、括号，也不能带「他」「她」。两个称呼不能一样。

## 检查

`build.mjs` 写文件之前会检查下面这些，有一项不过就不写，退出码是 1：

- 没有「他」「她」，没有 U+2028 / U+2029，没有留下没换掉的占位符；
- 写摘要、读摘要两处都点了主人的名；
- 第一行写日子；三层都要求「记不清」照实说；四处都以便条为准、都认「搁着的」；
- 两个抬头的末尾和 `compressPhilosophy` 逐字相同。

测试：`node test/test-pack.mjs`。

## 正文在哪

| 文件 | 放到哪 |
|---|---|
| `texts/philosophy.txt` | `compress.prompts.compressPhilosophy`，也接在两个抬头后面 |
| `texts/how-to-compress.txt` | `compress.prompts.howToCompressRules` |
| `texts/tier2.txt` | `compress.prompts.tier2DistillRules` |
| `texts/tier3.txt` | `compress.prompts.tier3CondenseRules` |
| `texts/summaries-in-context.txt` | 包的 `promptSections.summariesInContext` |
| `texts/t2-guidance.txt`、`texts/t3-guidance.txt` | 包的 `nudgeSections.t2Guidance`、`t3Guidance` |
| `texts/efficiency-head.txt`、`texts/emergency-head.txt` | 包的 `nudgeSections.efficiencyNote`、`emergencyHeader` 的开头 |
| `texts/tool-prompts.json` | 包的 `toolPrompts` |
| `texts/pack.json` | 包名、版本、说明 |

正文里提到的 `her_note`、`qq_history`、`acp_status` 是陪伴体那边的工具名（dsh-fish、桥和 billion-context 提供）。你的部署里没有这些工具的话，请照着改。

## 出处和许可

包的格式照 billion-context，四段规则的分法和部分写法也改写自它自带的规则。billion-context 的许可（MIT，另有一条出处标注的附加条款）原文在 `THIRD-PARTY-NOTICES.md`。

本包按 MIT 许可发布，见本目录的 LICENSE（和仓库根目录的那份相同）。
