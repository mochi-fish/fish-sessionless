# 安全问题怎么报

请**私下**报告，不要开公开的 issue、讨论或 PR。

## 怎么报

用 GitHub 的私下漏洞报告：在本仓库的 **Security** 页点 **Report a vulnerability**，填表提交。只有维护者看得到。

我们不提供邮箱。

请尽量写上：

- 影响哪个部分（哪个包、哪个文件），哪个版本或提交。
- 会出什么事：谁能拿到什么，或者能让系统做出什么不该做的事。
- 怎么重现。只用编出来的数据，不要附真实的聊天记录、账号、号码或密钥。

## 之后会怎样

- 我们会在报告里回复确认收到。这是业余维护的项目，没有固定的响应时间。
- 修好之前，请不要公开细节。修好、发了新版以后，我们会和你商量什么时候公开、怎么署名。
- 问题要是出在上游（DSH、dsh-fish、billion-context、OneBot 实现等），我们会请你直接报给上游，或者经你同意后代为转达。

## 范围

- 本仓库里的代码和文档。
- 已知、已经写进 [docs/zh/known-limitations.md](docs/zh/known-limitations.md) 的局限不算新问题；但如果你找到了比那里写的更严重的后果，欢迎报告。

---

## Reporting security issues (English)

Please report privately. Do not open a public issue, discussion or pull request.

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and click **Report a vulnerability**. We do not provide an email address.

Include the affected part and version, the impact, and steps to reproduce using made-up data only. This is a hobby project with no fixed response time. Please keep details private until a fix is released; we will agree on disclosure and credit with you. Issues in upstream projects (DSH, dsh-fish, billion-context, OneBot implementations) should go to those projects.
