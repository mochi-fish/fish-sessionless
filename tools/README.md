# tools：部署和测试用的小工具

这些工具是给「大肥鱼」这类长期在线的陪伴体做部署时用的。它们不依赖某一台机器：路径、端口、名单都从参数或环境变量来，没给就用下面写的缺省值。

除了 `model-switch-check.mjs` 要 `js-yaml`（版本钉在 `package-lock.json` 里），别的都只用 Node 自带的模块。要求 Node 22.15 或更新（`zlib.zstdCompressSync` 从这一版起才有）。

跑全部测试：

```bash
cd tools && npm ci --ignore-scripts && node test/run-all.mjs
```

`run-all.mjs` 给每个测试文件挂上 `offline-guard.mjs` 和 `netguard.mjs`，测试不会连外网。

---

## run-exclusive.mjs：重测试排队

几套全量测试同时跑、每套又开很多并发，很容易把整台机器的 CPU 打满。这个工具让它们排队。

```bash
node tools/run-exclusive.mjs <名字> [--slots N] -- <命令> [参数…]
node tools/run-exclusive.mjs suite -- node --test --test-concurrency=4 "tests/**/*.test.mjs"
```

- 同一个名字同一时间最多跑 N 套，缺省 2 套，最多 4 套。
- 拿锁之前还会数整台机器上正在跑的 `node --test`，绕过本工具直接起的也算进去。
- 本进程和起的命令都用最低优先级。
- 命令里 `--test-concurrency` 大于 4 的会改成 4。
- 退出码照传。命令起不来时退 127。
- 环境变量：
  - `RUN_EXCLUSIVE_LOCK_DIR`：锁目录，缺省是本脚本旁边的 `.locks/`。要改的话，所有人要设成同一个值，不然就各排各的队。
  - `RUN_EXCLUSIVE_POLL_MS`：等待时隔多久再看一次，缺省 15 秒。

## offline-guard.mjs：只放行回环的 fetch

预加载以后，全局 `fetch` 只放行 127.0.0.1、localhost、::1。别的地址一律不发出去，记一行，然后抛 `TypeError`。

```bash
node --import ./tools/offline-guard.mjs your-script.mjs        # Windows 上要写成 file:/// 网址
OFFLINE_GUARD_LOG=/tmp/og.log node --import ./tools/offline-guard.mjs your-script.mjs
```

日志里只记主机、路径（不带查询串）、脚本文件名和调用栈的「文件名:行:列」，不写本机目录。

## netguard.mjs：第二道出网挡板

和 `offline-guard.mjs` 一起预加载，管 `fetch` 以外的出网：undici、`node:http`/`https`、`net`/`tls` 直连、DNS 查询，都只放行回环。子进程不拦，只记下命令名。

- 日志写进 `NETGUARD_LOG`，没设就写进 `OFFLINE_GUARD_LOG`。
- 可选：`NETGUARD_DENY_LOOPBACK_PORTS="18780-18799"`（端口或区间，用逗号分开）。设了以后，这些回环端口不许连（报 `ECONNREFUSED`），也不许听（同步抛 `EACCES`）。本机有一个正在用的服务时，可以用它让测试碰不到那个服务的端口。写错格式，进程就起不来。
- 管不到：`eval: true` 的 worker 线程里不跑 `--import` 的预加载。

## scratch-guard.mjs：临时目录守卫

测试和评测工具清空、删除临时目录之前，用它确认那是自己的专用目录。

```js
import { claimScratchDir, releaseScratchDir } from './scratch-guard.mjs'
const dir = claimScratchDir(process.argv[2], { prefix: 'my-tool-', keep: [process.cwd()] })
// …用 dir…
releaseScratchDir(dir)
```

- `claimScratchDir` 只认这样的目录：在 `os.tmpdir()` 下面、名字以 `prefix` 开头、不是目录联接、不和 `keep` 里的目录重叠。目录已经存在时，必须是空的，或者里面有上一次放的记号文件 `.scratch-guard-mark`。不合格就抛错，`code` 是 `'REFUSE'`，什么都不删。
- `releaseScratchDir` 只删有记号文件的目录。
- 另外导出 `refuseByString`、`refuseByRealpath`、`forbiddenRoots`，给「只许读拷贝、不许碰原件」的工具用。
- 受保护的目录：`~/.dsh`、`~/.dsh-fish`、`DSH_HOME`、`DSH_FISH_HOME`、dsh-fish 搬家指针（`~/.dsh-fish-location.json`，或者 `DSH_FISH_LOCATION` 指的文件）里写的根目录，再加 `SCRATCH_GUARD_EXTRA_FORBIDDEN` 里用分号隔开的路径。

## proxy-ready.mjs：代理就绪判据

重启 DSH 前后，判断 billion-context 代理（DSH 车道）是不是已经接好了。判断是只读的。DSH 刚起来就给陪伴体发消息的话，第一份请求可能被代理当成匿名会话：白跑 preflight，工具也还没登记上。这个工具就是防这个的。

```bash
node tools/proxy-ready.mjs pre-start  [--state-dir D] [--port N]
node tools/proxy-ready.mjs post-start --since <起 DSH 的时刻> [--state-dir D] [--port N] [--settle-ms 15000]
node tools/proxy-ready.mjs replay --log <bili.log 的拷贝> --since <时刻> --at <时刻> [--phase pre-start|post-start]
```

- `pre-start`：旧代理有没有走干净。只读登记文件，查进程在不在。
- `post-start`：只发一次 `GET /__bili/health`，再读登记文件和 `bili.log` 的拷贝。
- `replay`：只拿日志拷贝，复盘某一次重启当时会怎么判。
- 每次调用只判一次。要等的话，由调用方隔几秒再调。
- stdout 输出一行 JSON，`verdict` 是 `ready`、`wait`、`not-ready`、`timeout` 或 `error` 之一。
- 退出码：0 是 ready；1 是 not-ready 或 wait；2 是参数错；3 是超时。
- 缺省位置：
  - 状态目录是 `$XDG_STATE_HOME/billion-context`，没设就是 `~/.local/state/billion-context`。
  - 端口先读 `port-zone.json` 里的 dsh 车道，没有就用 18787。

## model-switch-check.mjs 和 models-lib.mjs：切模型护栏

给陪伴体的会话换模型之前跑一次，看会出什么事。它算三样：

1. **摘图**：换到那条线以后，DSH 会不会按那条线的图片上限永久摘掉老图（`image/offload`，删了拿不回来）。
2. **判窗**：那边代理的判窗是多少。window 和 input 两种模式都算，并标明哪种在生效；自己架的 vLLM 这类服务另报一个「墙」。
3. **真用量**：最近一次真用量占判窗的几成。

```bash
node tools/model-switch-check.mjs <provider/model> [--hc] [--json] [--allow-no-usage]
node tools/model-switch-check.mjs --all
node tools/model-switch-check.mjs --gate <步名>      # 给上线脚本用
```

- **核准表**：照 `models.example.json` 写一份 `tools/models.json`，或者用 `MODEL_SWITCH_MODELS` 指到别处。表里写哪些模型可以给她用（`approvedForHer`）、上线步骤的名字（`steps`），以及哪些步只在某几个模型上演练过（`rehearsedFor`）。
- **读的东西**：
  - DSH 的 `profiles/desktop/cordis.patch.yml`，只取白名单里的键，不打印地址和密钥；
  - billion-context 的配置；
  - dsh-fish 的 `home.json`，用来取会话 id；
  - 会话日志和代理日志，都先拷进一个专用临时目录再读。
  - 都只读，也不打开任何 SQLite。
- **缺省位置**：DSH 目录是 `DSH_HOME`（缺省 `~/.dsh`），dsh-fish 目录是 `DSH_FISH_HOME`（缺省 `~/.dsh-fish`）。每一样都能用参数换：`--models --cordis --bc-config --session-log --proxy-log --sid --usage`。给了 `--session-log` 或 `--proxy-log`，就直接读给的文件，调用方要保证那是拷贝。
- **退出码**：同时有几样问题时，取 `PROBLEM_ORDER` 里最靠前的那一样。脚本请读 `--json` 输出里的 `problems[].code`，不要只看退出码。
  - 0：能用。
  - 4：不在表里或没批（`NOT_APPROVED`），或者这一步没在这个模型上演练过（`NOT_REHEARSED`）。
  - 5：发不出去（`CANNOT_SEND`）。
  - 1：会永久丢图（`DROPS_IMAGES`），或者离图片上限不到余量（`IMAGE_MARGIN`）。
  - 6：切回 DeepSeek 那条线会暴涨（`SURGE_BACK`）。
  - 3：用量到了截断线，或者偏高（`OVER_WINDOW`、`USAGE_HIGH`）。
  - 7：读不到真用量（`USAGE_UNKNOWN`）。
  - 2：参数不对。
- **js-yaml**：`models-lib.mjs` 用它解析 YAML。环境变量 `FISH_TOOLS_JS_YAML` 可以指到别的 js-yaml 目录。
- **算法出处**：图片上限、一档摘几张、像素预算这些数，照的是 DSH 0.2.2 的源码，`models-lib.mjs` 开头写了出处。DSH 改了这些数，这里要跟着改。

## 许可

MIT，见仓库根目录的 LICENSE。
