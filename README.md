# fish-sessionless

给长期陪伴型 agent 用的一套「无会话（sessionless）」架构。它做在 DSH（DeepSeek Harness）的插件口子上，不改宿主。陪伴体缺省叫「大肥鱼」，这是上游 [dsh-fish](https://github.com/ssamurias/dsh-fish) 自己起的名字。

**状态：早期，自用为主。** 接口、文件格式、目录都还会变。没有版本承诺。

[English summary](#english)

## 它要解决什么

一个陪伴体只有一条生活时间线，却要同时面对好几种人：主人的私聊、群里的人、来私聊的客人。于是有四个问题：

- 群里那一轮，模型拿到的请求里带着私聊的历史。
- 她一用工具，就能翻出不该给这一轮的人看的旧事。
- 历史被压缩以后，摘要写歪了，原话找不回来。
- 历史越来越长，每次请求越来越贵，最后放不下。

## 四块东西

| 块 | 一句话 |
|---|---|
| 一条生活时间线 | 她只住一条会话。不按房间把她拆成几个人；不管跟谁说话，回复都落回同一份日志。 |
| 证据账 | 只往后追加的一本账，记每条材料从哪来、谁说的、谁能看。只存编号和带盐的哈希，不存原文，放在模型和她的工具都碰不到的地方。 |
| 按受众的工具门 | 群和来客那几轮，能翻到旧事的工具缺省挡住，只放行逐个核过的。门自己出了错，一律按「不给」。 |
| 水位 | 每次请求带多少历史有上限。越线只催她自己压缩，不让别的模型替她写摘要。 |

原则：

- 她只有一份生活史。
- 主人那几轮照旧，不加新的限制。
- 群和来客那几轮，出错一律按「不给」。
- 摘要由她自己写。原话永远留在原处，不改、不复制。

## 这一批（第一批）有什么

这一批只放不碰线上桥的干净件。

| 路径 | 是什么 |
|---|---|
| `docs/` | 文档（中文是正本）、架构决定记录（ADR）、架构图页 |
| `packages/config` | 共用的身份配置：主人、陪伴体、称呼、账本根。读不到就当「没有主人」 |
| `packages/ledger-core` | 证据账的核心：只用 Node 自带模块的纯 JS，和宿主无关 |
| `packages/audience` | 受众和工具门的判定：纯函数，不读盘、不读环境变量 |
| `packages/fish-ledger` | DSH 插件：记账，加上群和来客那几轮的工具门 |
| `packages/fish-pack-zh` | 压缩代理的中文规则包 0.2（催压的话、三个压缩工具的说明） |
| `tools/` | 推送前的隐私扫描、离线守卫、测试排队等工具 |
| `evals/` | 记忆评测架子，只用合成的世界和编出来的对话 |
| `recorder/` | OneBot 全量录制器（不带任何协议定义文件） |

单独装第一批，拼不成一套能聊天的系统：认人、送消息、请求改写都在桥里，桥第二批才发。第一批能单独用的是：证据账（只记账）、隐私扫描、录制器、评测架子、规则包。

## 以后几批

| 批 | 放什么 |
|---|---|
| 第二批 | 桥（从单文件拆成模块、个人值全进配置）、审批面板、请求对照工具、上游锚点表、几个小插件、对第三方插件的补丁 |
| 第三批 | 压缩代理的 fork（trillion-context）和规则包 0.3、dsh-fish 的本地修改、上线编排库和假家目录测试架子 |

陪伴体专属的几样（教学审批、维护助手留言板、帮手挡板、群聊回复器、QQ 空间写）以后作为**缺省关**的可选模块发。

## 文档

- 中文（正本）：[docs/zh/](docs/zh/README.md)
  - [概览](docs/zh/overview.md) · [证据账](docs/zh/evidence-ledger.md) · [受众和工具的门](docs/zh/audience-gate.md) · [水位](docs/zh/water-level.md) · [记忆和原话](docs/zh/memory.md) · [部署前提](docs/zh/deployment.md) · [已知局限](docs/zh/known-limitations.md)
- 架构决定记录：[docs/adr/](docs/adr/README.md)
- 架构图页：[docs/architecture/](docs/architecture/index.html)（静态页，可以直接用 GitHub Pages 发）
- English summary: [docs/en/](docs/en/README.md)

## 测试

Node 22 起。测试用 Node 自带的测试运行器 `node --test`。CI 在 `packages/*`、`tools/`、`evals/`、`recorder/` 下面找两种名字的文件交给它跑：`*.test.mjs`（用 `node:test` 写的）和 `test-*.mjs`（从头跑到尾、看退出码的脚本）。本地照 `.github/workflows/ci.yml` 里那一步跑就行，例如：

```sh
node --test "packages/config/test/*.test.mjs"
```

各包的说明里写着自己的跑法。测试只用编出来的号码和句子。

## 参与

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题见 [SECURITY.md](SECURITY.md)，请私下报告，不要开公开 issue。

## 许可和出处

全仓（代码和文档）用 MIT 许可，见 [LICENSE](LICENSE)。

本项目使用了 [billion-context](https://github.com/ranxianglei/billion-context)（含它的内核 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 的部分代码）：中文规则包改写自它的提示词，评测架子里有一份从它的内核源码打包的消息转换函数。按它许可里的出处条款，在这里标明。第三方的许可原文和致谢见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)。

本项目和 DeepSeek、DSH 官方没有关系。

---

<a id="english"></a>

## English

fish-sessionless is a "sessionless" architecture for a long-lived companion agent, built entirely on the plugin hooks of DSH (DeepSeek Harness). The companion keeps one life timeline and one session, while it talks to its owner, to group chats and to guests. Next to that timeline sits an append-only evidence ledger that records where each piece of material came from and who may see it (ids and keyed hashes only, never raw text). A per-audience tool gate blocks memory-reaching tools in group and guest turns and fails closed. A context water level caps how much history each request carries; when the cap is crossed, the companion is asked to compress on its own, and no other model writes summaries for it.

Status: early, built mainly for our own use. Batch 1 contains the docs, the shared identity config, the ledger core, the audience gate, the fish-ledger DSH plugin, the Chinese rule pack 0.2 for the compression proxy, tools, evals and a OneBot recorder. The bridge comes in batch 2; the compression-proxy fork and the remaining parts in batch 3. Chinese docs are canonical; see the [English summary](docs/en/README.md). MIT licensed. This project uses billion-context; see [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
