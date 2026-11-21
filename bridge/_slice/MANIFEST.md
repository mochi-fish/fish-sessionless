# 桥的切片清单（manifest）格式

桥部署时是一个单文件插件。拆成模块之前先做一步**机械切片**：把单文件按它自己的分段切成有序的片段，再用 `build.mjs` 按清单原样拼回去。拼回来的文件和原文件**逐字节相同**（sha256 相等），就证明切片这一步什么都没改。之后的配置化、拆模块都在切好的片段上做，每一步都拿同样的办法核对。

带部署值的切片（真实账号、称呼这类）不进这个仓库，放在部署方自己的私有仓里；这里只放 `build.mjs` 和这份格式说明。配置化把个人值换成配置以后，片段才能公开。

## 拼法

- 顺序：`modules` 的顺序，每个模块里再按 `files` 的顺序。
- 每个片段是源文件里连续的一段**原始字节**，按 `0x0A` 分行，换行跟着上一行走。拼的时候不加分隔、不改换行、不转编码、不做任何替换。
- 片段本身大多不是能单独运行的模块（很多是同一个函数闭包里的一段），所以 `build.mjs` 不解析片段，只拼；要核语法就对拼好的整份跑 `node --check`（`--node-check`）。
- 片段要按字节存：放进 git 时给片段目录加 `-text` 属性（例如在切片目录放一个 `.gitattributes`，写 `* -text`），免得换行被转换以后 sha 对不上。

## 字段

顶层：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `format` | string | 是 | 固定 `fish-bridge-slice/1` |
| `output` | string | 否 | 拼出来的文件该叫什么（只是说明，`build.mjs` 以 `--out` 为准） |
| `source` | object | 否 | 切的是哪一份：`name`、`sha256`、`bytes`、`lines` |
| `expect` | object | 否 | 拼好以后应该是什么：`sha256`、`bytes`。`--verify` 时核对 |
| `modules` | array | 是 | 模块，按拼接顺序 |

模块：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 全清单唯一 |
| `region` | string | 否 | `head`（头注释）、`prelude`（import / export）、`shared`（顶层共用定义）、`apply`（插件入口函数里的各段） |
| `section` | number \| null | 否 | 对应头注释里的第几条；共用件是 `null` |
| `core` | boolean | 否 | 是不是共用件 / 核心（不属于某一条） |
| `marker` | string | 否 | 切点那一行分段标记的标题 |
| `files` | array | 是 | 片段，按拼接顺序，至少一个 |

片段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 相对清单所在目录的路径，用 `/` 分隔，不许 `.`、`..`、绝对路径、反斜杠；同一个片段不许列两次（按解析以后的真路径比，大小写不同或经链接指到同一个文件也算）；解析符号链接以后也必须还在清单目录里 |
| `sha256` | string | 否 | 片段字节的 sha256（小写十六进制）。`--verify` 时核对 |
| `bytes` | number | 否 | 片段字节数。`--verify` 时核对 |
| `lines` | [number, number] | 否 | 在源文件里的起止行号（从 1 数，含两头） |
| `cut` | string | 否 | 这个片段是按什么切出来的，见下表 |
| `marker` | string | 否 | 模块里第二个以后的片段：切点那一行分段标记的标题 |
| `why` | string | 否 | 按表切（`anchor`）的理由 |

`cut` 的取值（只是记录，`build.mjs` 不看）：

| 值 | 切点 |
|---|---|
| `head-preamble` / `head-entry` / `head-trailer` | 头注释：开头几行、每一条「 * N. 」、结尾几行 |
| `prelude` | import 和 `export const` 那几行 |
| `blank-block` | 顶层共用定义区按源码自己的空行分块；只有注释的块并进下一块 |
| `apply-prologue` | 入口函数开头到第一个分段标记之前 |
| `marker` | 带编号的分段标记（`// ---- N. … ----`），开一个新模块 |
| `marker-sub` | 不带编号的分段标记，算所在模块的下一个片段 |
| `anchor` | 没有标记的地方，按一张写明理由的切点表（整行原文）切：共用件、整份嵌进来的源码单独成片 |

## 例子

```json
{
  "format": "fish-bridge-slice/1",
  "output": "local-bridge.mjs",
  "source": { "name": "example", "sha256": "<64 位十六进制>", "bytes": 120, "lines": 9 },
  "expect": { "sha256": "<同上>", "bytes": 120 },
  "modules": [
    { "id": "prelude", "region": "prelude", "section": null, "core": true,
      "files": [ { "path": "parts/1-prelude/00-imports.frag.mjs", "lines": [1, 3], "cut": "prelude" } ] },
    { "id": "a-s01-example", "region": "apply", "section": 1, "core": false, "marker": "1. 例子",
      "files": [
        { "path": "parts/3-apply/01-s01-example/00-main.frag.mjs", "lines": [4, 6], "cut": "marker" },
        { "path": "parts/3-apply/01-s01-example/01-part.frag.mjs", "lines": [7, 9], "cut": "marker-sub", "marker": "子段" }
      ] }
  ]
}
```

## build.mjs

```
node build.mjs <manifest.json> --out <输出文件> [--force] [--verify] [--node-check]
node build.mjs <manifest.json> --verify
```

- `--out`：写出拼好的文件（先写临时文件再改名）。文件已经在时要加 `--force`。不往 DSH 的数据目录里写（家目录下的 `.dsh`、`.dsh-*`、`.config/billion-context` 和 `DSH_HOME`）：构建只出产物，换上线是另一步。输出文件所在的目录要已经在，判断前先解析成真路径（跟着 junction、符号链接、8.3 短名走，Windows 上每段末尾的点和空格去掉再比）；Windows 上 `\\` 或 `//` 开头的路径（UNC、`\\?\`、`\\.\`）和带 `:流` 的路径一律不收，用盘符写。
- `--verify`：核对每个片段的 `sha256` / `bytes`，以及整份的 `expect.sha256` / `expect.bytes`。
- `--node-check`：写出以后对整份跑一次 `node --check`。
- 输出一行：整份的 sha256、字节数、片段数。
- 退出码：`0` 成功；`1` 核对没过（片段或整份的 sha、字节数，或 `node --check`）；`2` 用法或清单有错。

切片证明就是：

```
node build.mjs <私有仓里的 manifest.json> --out <临时目录>/local-bridge.mjs --verify --node-check
```

退出码 0，打印出来的 sha256 等于线上那份桥的 sha256。

没有依赖，Node 18 起都能跑。
