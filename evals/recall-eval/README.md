# recall-eval：离线回忆评测

拿一份**合成的**事件流和一组带答案的题，调 dsh-fish 的 `searchEvents`（`her_recall` 工具用的同一个函数、同一组参数），算每类题的 hit@8。

全是编的：事件、日记、题目都由 `build-fixture.mjs` 用固定种子造出来，没有任何真人的话、号码或名字。不联网，不花钱。

## 用法

```bash
node build-fixture.mjs        # 重造 fixture/ 和 questions.json（结果逐字节相同）
node run-eval.mjs <dsh-fish 包目录> <临时目录> [--out <结果文件>]
```

- **包目录**：dsh-fish 包解开的一份拷贝（里面要有 `lib/recall.js`），不要指向正在用的那份。
- **临时目录**：只认专用的。它要在系统临时目录下面，名字以 `recall-eval-home` 开头，而且不存在、是空的，或者是上次留下的（里面有记号文件）。另外，它不能和包目录、本目录、当前目录重叠。不满足就退出 2，什么都不删。
- 过了检查，脚本就把临时目录清空，当成假的 `DSH_FISH_HOME`；`USERPROFILE` 和 `HOME` 也指到它下面，这样 dsh-fish 碰不到真的家目录。跑完删掉。
- 三个路径都先过 `../../tools/scratch-guard.mjs` 的两道守卫：不能在 DSH 或 dsh-fish 的数据目录下面。
- 时区固定成 `questions.json` 里的 `tz`（Asia/Shanghai），所以结果和本机时区无关。

## 题

| 类 | 量什么 |
|---|---|
| `watched` | 只用 `bili_watch` 看过画面的视频：`watched:` 不进回忆池（hole） |
| `diary` | 日记正文只在文件里，事件流里只有 `diary:<日期>`（hole） |
| `dup` | 同一件事被反复记，更新的回执把真正的答案挤出前 8 |
| `paraphrase` / `literal` | 换个说法问，和照原话问对照 |
| `date1106` | 某个日子前后、不同来源记下的话 |
| `absent` | 事件流里本来就没有答案；单列，不进总数 |
| `ownVsHeard` | 陪伴体自己说的和主人说的放在一起，看答案排不排在混淆项前面（`pairOk`） |

`hole` 的题是事件流本身的缺口，不是检索好坏的问题。所以结果里另给一个去掉 hole 的总数。

## 结果

输出每类题的 n、hit@8、hit@3、hit@1、MRR 和 found 比例（found 只是给人看「找到了东西」量不出好坏，不当尺子）。另有两个总数：全部的，和去掉 hole 以后的。每道题的名次也列出来（0 = 没进前 8）。

结果里还记了 `recall.js` 和两个题目文件的 sha256：以后比较时，先看题和检索代码各变没变。

在 dsh-fish 1.0.2 上：全部 25 题 hit@8 0.72；去掉 hole 的 19 题 hit@8 0.789。

## 许可

MIT，见仓库根目录的 LICENSE。
