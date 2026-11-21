# recorder：OneBot 全量录制

录制器作为「又一个客户端」连到 OneBot v11 的正向 WebSocket 上。**收到的每一帧都原样存盘**：不挑，不改，也不丢。事件里拿不全的东西，再用接口补齐，接口的回包也原样存。

它不碰别的客户端（比如 DSH 的 OneBot 插件）那条连接。前提是你的 OneBot 实现会把事件推给每一个连着的客户端；常见实现大多这样，用之前请自己确认一次。

不依赖任何包，用的是 Node 22 自带的 WebSocket。

```
node recorder.mjs                 # 前台跑，Ctrl+C 停（会等手上的下载做完，最多 15 秒）
start.cmd                         # Windows：一样，崩了（退出码 1）隔 10 秒自己重开
node recorder.mjs --url ws://127.0.0.1:3001 --data D:/qq-archive --no-media --no-members --no-heartbeat
node recorder.mjs --help
```

**地址和口令**从下面几处取，后面的盖前面的：

1. `config.json`：把 `config.example.json` 拷一份改；也可以用 `--config <文件>` 指别的文件。
2. 环境变量 `ONEBOT_URL`、`ONEBOT_TOKEN`、`ONEBOT_ARCHIVE_DIR`。
3. 命令行 `--url`、`--data`。

另外，配置里给了 `dshProfile`（DSH 的 `cordis.patch.yml` 路径）而地址、口令没给时，会从那份文件里 `dsh-onebot` 那一项现读。

口令不写进盘，也不打印。同一个数据目录只能有一个录制器在写（锁文件 `.recorder.lock`），第二个会退出，退出码是 3。

## 存了什么

数据目录默认是 `~/onebot-archive/`，按本机时区的日期切文件：

| 路径 | 一行是什么 |
|---|---|
| `events/YYYY-MM-DD.jsonl` | 一帧：`{"t":收到的毫秒,"raw":"那一帧的原文"}`。消息、自己发的（如果实现推）、通知、请求、心跳、生命周期，全都在。二进制帧是 `{"t":…,"b64":…}`。录制器自己的开始、连上、断开、停止记成 `{"t":…,"rec":"start"/"open"/"close"/"stop"}`，没录到的空档从这里看 |
| `api/YYYY-MM-DD.jsonl` | 一次接口调用：`{"t":发出,"t2":收到,"why":…,"ref":…,"req":{action,params,echo},"raw":"回包原文"}`；没回来的带 `err`（timeout / closed / not-connected） |
| `media/<sha 前两位>/<sha256>.<扩展名>` | 文件本体，按内容寻址，同一个文件只存一份；扩展名先按文件头认，认不出再看文件名，最后看 content-type |
| `media/index/YYYY-MM-DD.jsonl` | 哪条消息（`ref`）的第几段（`seg`、`i`）对应哪个文件、来源（`from`：event / forward / reply / notice）、没下成的原因（`err`） |

`raw` 是 WebSocket 收到的那串字原样：`JSON.parse(行).raw` 和线上那一帧逐字相同。要解析的话，自己再 `JSON.parse` 一次。

### 用接口补的

- **快照**：连上就拍一次，之后每 24 小时一次；频繁重连时，10 分钟内不重拍。调的接口是 `get_login_info`、`get_version_info`、`get_status`、`get_friend_list`、`get_group_list`，再加每个群的 `get_group_member_list`（群和群之间隔 1.5 秒）。
- **合并转发**：调 `get_forward_msg`。转发里套的转发也展开，最多 4 层，同一个 id 只取一次。
- **引用**：调 `get_msg`，把被引用的原消息存下来。只取一层，不顺着引用链往上翻。
- **图片、表情包、语音、视频**：段里有网址就直接下。QQ 的图片网址带 rkey，会过期，所以收到就下。图片没网址时调 `get_image`；语音没网址时调 `get_record`（转成 mp3）；视频没网址的只记一笔。
- **文件**：消息里的文件段和「群文件上传」通知，先调 `get_group_file_url` 或 `get_private_file_url` 拿直链，再下。

### 合并转发：外挂整包展开（缺省关）

有的 OneBot 实现，`get_forward_msg` 只给外层：转发里再套的转发，只回一个 xml 段，内层拿不到。内层其实都在外层那个包里，只是要照那个实现的私有协议定义去解包。

**本仓库不带解包的实现，也不带任何协议定义文件**：那些定义的许可各不相同（有的不允许商用、不允许再发布）。需要的话，你自己写一个模块，再在配置里打开：

```json
"expand": { "rawForward": true, "rawForwardModule": "./my-forward.mjs" }
```

模块要导出这四个函数：

| 导出 | 做什么 |
|---|---|
| `forwardDirName(id)` | 返回这个转发的结果目录名（在 `forward/` 下面）。录制器看 `forward/<名字>/expanded.json` 在不在，在就不重做 |
| `selfUidOf(call)` | 返回自己这个号在协议里的 uid（拿不到就 `undefined`）。录制器只调一次 |
| `expandForward({ call, resId, dataDir, ref, selfUid, media, maxBytes, hosts, allowPrivate, title })` | 展开一个转发，把结果写进 `forward/<forwardDirName(resId)>/`，做完一定要写 `expanded.json`。返回 `{ messages: 条数 }`。抛错的话，录制器替你写 `failed.json`（里面有编号、来源、时间、报错） |
| `titleOf(ref)` | 返回给人看的标题，比如「群 20000 · 某时某刻」 |

`call(action, params)` 走录制器自己的接口通道：调用和回包都记进 `api/`，`why` 是 `forward-raw`。只有事件里直接出现的转发会交给模块；转发里面套的那一层，由模块自己处理。

模块读不了，或者缺导出，录制器在拿锁之前就报错退出。

### 下载的门

- 单个文件超过 `media.maxBytes`（默认 100 MB）就不下，只在索引里记一笔。没声明长度的，边下边数，超了就停。
- 消息段里带的网址，只从 `media.hosts` 里的域名及其子域名下（默认 qq.com、qpic.cn、qq.com.cn、qlogo.cn、gtimg.cn）。接口回的直链不看域名。
- 不管哪一种，都不下内网地址和回环地址。
- 卡片（json / xml 段）里的网址一概不碰，原文在 `raw` 里。

## 读

```
node dump.mjs                                   # 今天的全部帧，一行一帧原文
node dump.mjs 2026-01-02 --type message --group 20000 --time
node dump.mjs --no-heartbeat | jq -c 'select(.post_type=="notice")'
node dump.mjs --api                             # 今天的接口回包
```

## 录不到的

- 录制器没开着的那段时间：看 `events` 里 `rec` 的 close / open。断了会自己重连，间隔从 1 秒起，每次翻倍，最长 60 秒。
- 自己发出去的消息：实现推送的话，记成 `message_sent`；不推的话，这里没有。
- 视频段没网址的、文件太大的、链接已经过期的本体。

## 要知道的

- 数据目录里是这个号**所有**群和所有私聊的原文，不只是陪伴体接入的那几个。请把它当成敏感数据。陪伴体有读文件工具的话，要另外挡住这个目录。
- 控制台每 10 分钟打一行计数，不打任何正文、名字、号码。

## 测试

```
node test/test-recorder.mjs [临时目录]
```

测试用的是假 OneBot（一个最小的 WebSocket 服务端）加假媒体服务器，全在 127.0.0.1 上。外挂整包展开用的是测试里现写的桩模块。失败时退出码是 1。

## 许可

MIT，见仓库根目录的 LICENSE。
