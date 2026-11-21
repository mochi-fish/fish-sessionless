# @mochi-fish/config

主人和陪伴体的身份配置：谁是主人、主人在各个渠道的号、怎么称呼主人；陪伴体叫什么；她可以主动开口的聊天；主会话怎么认；证据账放在哪。

桥、fish-ledger、audience 以后都从这一份读（第二批接上）。没有依赖，Node 22 起。

## 读不到就当没有主人

配置读不到、不是 JSON、有一处写得不对，结果都是「没有主人」：

- `speakerOf` 永远不回 `owner`，所有来话都按别人的话算；
- 没有主动开口的聊天，认不出主会话。

不猜写法：认不得的键、写成数字的号、相对路径，都算不对。格式见 [SCHEMA.md](SCHEMA.md)，示例见 [example.identity.json](example.identity.json)（全是编的）。

## 用法

```js
import { loadIdentity, speakerOf, ownerName, fillNames, mainSessionId } from '@mochi-fish/config'

const id = loadIdentity() // 路径从环境变量 FISH_IDENTITY_FILE 取；也可以 loadIdentity({ file })
if (!id.ok) console.warn('身份配置不认：', id.why, id.problems) // problems 只写哪一格、为什么，不带写的值

speakerOf(id, 'qq', '10001') // 'owner' | 'companion' | 'other'
fillNames('只有{owner}和{companion}在。', id) // 换成配置里的称呼
mainSessionId(id) // 主会话的 id，认不出是 null
```

| 导出 | 说明 |
|---|---|
| `loadIdentity({ file, env, home, fs })` | 读文件、核对、冻住。不抛错 |
| `parseIdentity(text, opts)`、`validateIdentity(obj, opts)` | 已经有文字或对象时用 |
| `speakerOf(id, channel, uid)`、`isOwner(…)` | 这个号是谁 |
| `ownerName(id)`、`companionName(id)`、`fillNames(text, id)` | 称呼 |
| `mainSessionId(id, { fs })` | 主会话的 id，每次现算 |
| `isIdentity(v)` | 是不是本模块造的结果 |

结果是整份冻住的对象：`{ ok, why, source, problems, owner, companion, proactiveChats, mainSession, ledgerRoot }`。`why` 是 `ok`、`no-file`、`bad-path`、`unreadable`、`too-large`、`not-utf8`、`not-json`、`invalid` 之一。

只认本模块造出来的结果：自己拼的、拷贝过的对象交给 `speakerOf`，一律回 `other`。

## 测试

```sh
node --test "packages/config/test/*.test.mjs"
```

测试只写系统临时目录，号和名字都是编的；临时目录或被测的模块在 `~/.dsh`、`~/.dsh-fish`、`~/.dsh-fish-ledger` 下面时直接拒跑。

## 许可

MIT，见 [LICENSE](LICENSE)。
