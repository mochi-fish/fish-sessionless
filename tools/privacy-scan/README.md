# privacy-scan

推送公开仓库之前的隐私扫描。没有依赖，Node 22 起。命中只报规则、位置、长度和编号，不打印命中的字。

分三层：

| 层 | 在哪 | 认什么 |
|---|---|---|
| 公开规则 | 本目录 `lib/rules.mjs` | 只认形状：带用户名的家目录路径、私网 / 局域网 / tailnet 地址和主机名、号码上下文里不在假号表的长数字、noreply 和保留域名以外的邮箱、像密钥的串、U+2028/2029、二进制、超过体积上限、该用 LF 的地方用了 CRLF、不是 UTF-8 的文字（照 GB18030 读出来照常扫）、符号链接和子模块 |
| 私有层 | 只在部署那台机器上（`--private <provider.mjs>`） | 真值：号、群、联系人、昵称、本机用户名、主机名、密钥；原话指纹。真值扫描时现生成，只在内存里交给扫描器；指纹库是带密钥的哈希。都不进任何仓库 |
| 额外关键词 | `--terms <文件>` | 一行一个词（`#` 注释），命中报 `terms#行号`，不报词 |

## 用法

```sh
node tools/privacy-scan/scan.mjs [目录…]                     # 扫目录树
node tools/privacy-scan/scan.mjs --git <仓库> [--rev <提交>]   # 扫这个提交和它的全部历史
node tools/privacy-scan/scan.mjs --git <仓库> --head-only     # 只扫那一棵树
```

git 模式扫：历史里每个文件的每个版本、路径名、提交说明、作者和提交者（名字、邮箱），`--tags` 时连标签。配置从被扫的提交里取，不看工作树。

其他选项：`--config <json>`（目录模式的公开配置）、`--private <provider.mjs>`、`--terms <文件>`、`--json`、`--max <n>`。

退出码：0 干净，1 有命中，2 用法错误、扫描出错或私有层加载失败（不当作干净）。

程序接口在 `index.mjs`：`createScanner({ config, layer, extraTerms })` 返回 `scanDir`、`scanGit`、`scanFile`、`scanText`。

## 假号表

测试、示例、文档里要写号，只用 `fake-ids.json` 登记的号段，或者一眼看得出是编的号（同一个数字重复、顺着或倒着的连号）。至少 5 位。

## 公开配置 `.privacy-scan.json`（仓库根，可以没有）

| 键 | 缺省 | 说明 |
|---|---|---|
| `maxBytes` | 1 MiB | 单个文件的体积上限 |
| `crlfAllowed` | `**/*.bat`、`**/*.cmd` | 允许 CRLF 的路径 |
| `allowBinary` / `allowLarge` | 空 | 允许的二进制 / 大文件 |
| `fakeIds` | 空 | 追加假号：`{ "ids": [], "ranges": [[lo, hi]] }` |
| `allow` | 空 | `[{ "path": glob, "rule": 规则, "reason": "…" }]`，只能放过公开规则；私有层、指纹、关键词的命中这里放不过 |

## 私有层的接口

provider 是一个 `.mjs`，导出 `async loadPrivateLayer(opts)`，返回：

```js
{
  key,           // Buffer，≥16 字节，给命中编号用
  terms,         // [{ kind, value }]，真值，只在内存里
  fingerprints,  // [{ rule, set, key, window, minCjk, minRun }]
  digitSets,     // 可省：[{ rule, set, key }]，以前见过的号的带密钥哈希（digitHash），配置里没了也照样拦
  allowIds,      // Set<string>，私有的放行编号
  health,        // { ok, problems, counts }
}
```

真值的匹配：纯数字按整段数字认（前后不挨着别的数字），被空格、`_`、`-` 拆成几段写的，相邻几段拼起来也查；`digitSets` 对每段 5–12 位数字（含拼起来的）算哈希查集合；密钥按区分大小写的子串；两头是英文字母或数字的按整词、不分大小写，其中本机用户名、身份（5 个字符以上）只看左边界（后面接着数字、字母的也算）；别的（中文）按子串。命中编号是 `kind#` 加带密钥的哈希前 10 位，换了密钥就变。

## 每段文字看几遍

`lib/decode.mjs`，命中都照原文报行列：

1. 原文。全角的 ASCII（全角数字、全角字母）先换成半角再过公开规则和真值，下标不变。
2. 有转义时再看一遍还原后的：反斜杠 u 加四位十六进制（含代理对）、反斜杠 u 加花括号、连续的反斜杠 x 加两位和 `%HH`（按 UTF-8）、`&#NNN;` 和 `&#xHHH;`，以及字符串里写成反斜杠加 n、r、t 的换行和制表（原文里那个字母会把两边的中文隔开）。Python 的 `json.dumps` 默认把中文写成反斜杠 u 的转义，网址里的中文是 `%E4…`。只留碰到了还原出来的字、或者紧挨着它的命中（`%22` 包着的号：原文里号和前面的 22 连成一串），同一条规则在原文同一处只报一次，命中带 `viaEscape`。写成转义的 U+2028/2029 不算 line-sep。

不是 UTF-8 的文字文件报 `not-utf8`，再按 GB18030 读出来照常扫（Windows 上的命令输出常是 GBK，按 UTF-8 硬读中文全成乱码）。

git 模式带 `GIT_NO_REPLACE_OBJECTS=1`：`refs/replace` 换掉的对象也看原样，`git push` 推的是原样。

## 原话指纹

`lib/fingerprint.mjs`：NFKC 以后只留字母和数字、小写；每 12 个单位一个窗口，窗口里 CJK 少于 6 个的不取；HMAC-SHA256 取前 53 位。一个窗口对上就算命中（`minRun` 1）。标点、空白、换行、拆成几段字符串拼接都不影响。

已知认不出的：规整以后不到 12 个字的短句；被改写过的句子（换了字、简繁转换、每 12 个字里插进一个字母或数字）；只在公开文字里出现过的窗口（生成方会先排除掉，免得她照说过的提示词把干净的代码拦下）；base64 这类整段编码过的（二进制、压缩包照样按 binary 拦，base64 文字不认）。

## 测试

```sh
node --test "tools/privacy-scan/test/*.test.mjs"
```

测试只用运行时拼出来的合成样本；`self.test.mjs` 会拿公开规则扫本目录，所以测试源码里不能写完整的脏样本字面量。
