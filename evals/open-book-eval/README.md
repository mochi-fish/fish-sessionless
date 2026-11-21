# open-book-eval：合成世界、判分和转发器

这是「开卷评测」架子里能单独发布的三块。它们用来回答一个问题：陪伴体（比如「大肥鱼」）在上下文被压缩以后，还能不能把以前的事说对，又不把一处听到的话说到别处去。

- `world/`：造**合成世界**。一个月的聊天、群聊、来客、便条、Mem、QQ 记录，全部是编的；题和评分要点也一起造出来。
- `score/`：**判分**。确定性的一层（关键词、泄露、门的行为）加上可选的结构化判官，最后按组比两臂。
- `fwd/`：**转发器**。整套架子里唯一能出网的进程，有四家协议的转换（DeepSeek、Anthropic、Gemini、OpenAI 兼容）、每家的花费上限、账本、隐私闸和出网闸。

这一版没有带执行器、代理拷贝和编排器（原来的 `lib/` 大部分、`bin/`）。它们离不开具体部署里的东西（代理的私有构建、陪伴体的工具表），所以整条「真跑」的线还拼不起来。见文末「没带的」。

## 不花钱、不出网

- 付费的臂（DeepSeek、Anthropic、Gemini）的代码都在，但缺省**一条都不发**：配置里没写 `caps` 的那家，上限就是 0。
- DeepSeek 真出网、上限大于 0 时，还必须给 `balanceFloor`（余额里要留下多少钱），否则转发器拒绝启动。
- 判官缺省是 `none`，只出确定性的结论。
- 这里列的测试全部只在回环上跑：假上游、假判官、假快照，都是现造的。

## 凭据

凭据只从转发器进程的环境变量取，不读任何文件：

| 变量 | 给谁 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek（`auth: apiKey`，缺省） |
| `DEEPSEEK_ACCOUNT_TOKEN`、`DEEPSEEK_ANONYMOUS_USER_ID` | DeepSeek（`auth: account`） |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_API_KEY` | Gemini |
| `OPENAI_API_KEY`（或 `FWD_OPENAI_KEY_ENV` 指定的名字） | 自建的 OpenAI 兼容服务 |

自建服务的地址用 `FWD_OPENAI_BASE_URL`。也可以用 `FWD_CORDIS_FILE` 指向一份 DSH 的 `cordis.patch.yml`：转发器只从 `llm-pi-ai` 里名叫 `self-hosted` 的那条路线读地址和变量名，不读任何凭据。

`node fwd/lib/credentials.mjs` 只报「有没有、多长、像哪一家」，不打印值。

## 用法

```bash
# 造一个世界（缺省写到实验目录；实验目录见 lib/paths.mjs，可以用 OB_EXPERIMENTS 改）
node world/build-world.mjs --seed dev-1 --out <目录>
node world/lint-world.mjs <世界目录>

# 发给外面的模型之前：合成世界和你自己记录的拷贝撞没撞上（只出编号和计数）
node world/fragment-check.mjs --world <世界目录> --snapshot <记录的拷贝目录>

# 判一次跑（门模块必须给，样子见 tests/fixtures/audience-fixture.mjs）
node score/score-run.mjs --run <跑的目录> --world <世界目录> --audience <门模块> --judge none
node score/score-run.mjs --compare <基线报告.json> <候选报告.json>

# 起转发器（单独起只许 testMode / offline，或者上限全是 0）
node fwd/start.mjs --config <配置>
```

配置样板在 `fwd/config/`。真数据臂（`arm: real`）还要一份许可文件，格式见 `approvals.example.json`：许可按提供方、臂和数据指纹认，带有效期。

### 时区

世界日历、账本和日志的时刻一律按 UTC+8 写，不靠本机时区。

### 路径和名字

- 转发器的 `localPaths` 变换会把 `C:\Users\<名字>`、`/c/Users/<名字>` 这类家目录路径换成 `~`。
- 要另外抹掉的名字（账户名、昵称）放进 `FWD_REDACT_NAMES`，用逗号隔开，每个至少 3 个字符。它会替换请求里**所有**字符串值中出现的这个词，所以不要填常用词。

### 隐私闸要的快照

合成臂的隐私闸要一份「你自己记录的纯文件快照」（`privacy.snapshotDir`），用来查有没有 12 个字以上的片段和真记录重合：

- `files/` 下面放记录的拷贝（`.zst` 会解开再扫）；
- `deny-hashes.json` 是加了盐的号码表 `{ salt, hashes }`（`numberHash(salt, 号码)`）。

快照怎么拍要看你的部署，这里不带拍快照的脚本。只按文件拷，不要用 SQLite 打开正在用的库。

## 测试

```bash
node --import <tools/offline-guard.mjs 的 file:/// 网址> --import <tools/netguard.mjs 的 file:/// 网址> tests/test-c-world.mjs [<临时目录>]
node --import … tests/test-c-score.mjs [<临时目录>]
node --import … fwd/tests/test-unit.mjs [<临时目录>]
node --import … fwd/tests/test-e2e.mjs [<临时目录>]
```

- 临时目录要是新的或者空的。不给就在系统临时目录下自己建一个，跑完删掉（CI 就是这样跑的）。
- `fwd/tests/test-e2e.mjs` 要用 openssl 造一次性的测试证书：Windows 上缺省找 Git 自带的那个，别的系统用 PATH 里的；`OPENSSL_EXE` 可以换。
- 重的测试请经 `tools/run-exclusive.mjs` 排队跑。
- 看 `PASS` / `FAIL` 行，有失败退出码是 1。
- `fwd/tests/test-unit.mjs` 里有一项在 Windows 上用 PowerShell 读进程命令行（自建推理机锁的那一项）。

## 没带的

- **执行器和编排器**：假宿主、每个半边一份代理拷贝、EgressFront、`ob run` 的计划和续跑。
- **W 开卷补测**：用真数据视图的那几臂、它的许可文件和题。
- **拍快照的脚本**、**工具表的生成**：这两样都要读陪伴体线上的数据。
- **整条链的冒烟**：要代理的私有构建。

代码注释里提到的 `eval.md`、`PLAN`、`NOTES-*` 是原项目的内部设计文档，没有一起发布。

## 出处和许可

`fwd/vendor/kernel-wire.mjs` 是从 [billion-context](https://github.com/ranxianglei/billion-context) 内核的 `kernel/src/wire` 打包出来的（MIT），许可原文在 `THIRD-PARTY-NOTICES.md`。重新生成用 `fwd/vendor/build-kernel-wire.mjs <billion-context 仓库目录>`。

其余按 MIT 许可发布，见仓库根目录的 LICENSE。
