# 架构决定记录（ADR）

每条记录一个大决定：当时的情况、定了什么、带来什么后果。只追加；改主意时写一条新的，在旧的里标「被第 N 条取代」。

| 号 | 决定 | 状态 |
|---|---|---|
| [0001](0001-one-session-for-life.md) | 她只住一条会话 | 采用 |
| [0002](0002-evidence-ledger-outside-model-view.md) | 证据账放在模型和工具碰不到的地方 | 采用 |
| [0003](0003-fail-closed-audience-gate.md) | 群和来客那几轮，工具的门失败即关 | 采用 |
| [0004](0004-config-driven-identity.md) | 身份走配置，读不到就当没有主人 | 采用 |
| [0005](0005-frozen-request-time-labels.md) | 请求期贴的字冻结不改 | 采用 |
| [0006](0006-mem-tools-every-turn.md) | 外部记忆库的工具每一轮都放 | 采用 |
| [0007](0007-heard-writes-fail-closed.md) | heard 的写入失败即关 | 采用 |
| [0008](0008-water-level-via-forked-proxy.md) | 水位做在压缩代理的 fork 里 | 采用 |

格式：

```
# 编号. 标题
状态：采用 / 被取代 / 作废
## 背景
## 决定
## 后果
```
