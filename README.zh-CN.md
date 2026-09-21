# Second Opinion

[English](README.md) | 简体中文

让 ChatGPT Chat 基于真实项目材料给出第二意见；Codex 负责核验、采纳或拒绝建议，以及用户授权范围内的执行。

## 来源与声明

本项目由 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
fork 而来，由 Dimon94 独立维护，已进行较大幅度修改。
感谢原作者及贡献者提供的 Bridge、OAuth、隧道与 Agent 工作流基础。
本分支重点增加多工作区/多任务隔离、本地授权握手、异常恢复与异步评议通知。

这不是上游官方发行版，也不是 OpenAI 官方项目，不代表上游或 OpenAI 的背书。
保留原版权声明和 [MIT 许可证](LICENSE)，详见 [NOTICE](NOTICE)。
本分支的问题请提交到[本仓库](https://github.com/Dimon94/second-opinion/issues)。

## 三个名称，不混用

- **Second Opinion**：项目名称与 [Codex Skill](skills/second-opinion/SKILL.md)。
- **Codex Workspace Connector**：ChatGPT 里的 MCP 连接器；老安装可能仍显示旧名 Second Opinion。
- **c2c / codex-with-chatgpt**：保留的命令、包名和状态目录标识。远程仓库改名不意味着迁移已有授权或运行目录。

Skill 只走 **Chat，不走 Work**，并核对实际可见的 Pro 模型。
Codex 并非“只执行”：它还要核验材料与会话归属、读回完整意见、判断建议及守住用户授权边界。

## 怎么协同

1. Codex 核对项目、宿主任务和 Chat 的对应关系，登记本轮、发问，然后结束回合。
2. ChatGPT 读取授权材料，分析完后提交评议。
3. Bridge 保存结果，通知本地预先登记的原 Codex 任务。
4. Codex 被激活后核验轮次，主动打开原 Chat，读回完整意见、分析并确认。
5. 需要追问就登记下一轮；结束后清理本任务绑定。

项目文件读取是只读的；**完成通知不是只读操作**：它保存意见并启动 Codex 新回合，
需要在读取权限之外明确授予 `review.submit`。
“通知成功”“完整读回”“授权任务完成”分别验收，不能互相替代。
被读取的文件内容会传给 ChatGPT，因此不再使用“仓库数据永不上传”这类绝对承诺。

## 安装与使用

需要 Node.js 20+、Corepack/pnpm、Git、运行中的本机 Codex App 及浏览器工具、
具备所需模型和连接器能力的 ChatGPT 账号；公网连接需要 cloudflared。
自动唤醒还要求本机 Codex CLI 支持 `queue --thread --message`，不能假设所有版本都支持。
本流程不使用 OpenAI API Key。

```sh
git clone https://github.com/Dimon94/second-opinion.git
cd second-opinion
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js --help
```

安装完整的 `skills/second-opinion/` 目录，不能只复制 SKILL.md。
推荐从 Codex skills 目录建立指向此仓库 Skill 绝对路径的符号链接，便于更新和定位运行入口。
已有同名 Skill 时先比较，保留本机部署信息，不能盲目覆盖。
复制安装需要按[运行入口](skills/second-opinion/references/local-runtime.md)记录实际部署仓库位置。

首次连接先看 `node <checkout>/bin/c2c.js setup --help`，再按现有
[配置 Skill](skill/SKILL.md)及 [Doctor 契约](skill/DOCTOR-HANDOFF.md)执行。
使用本 fork 的 checkout，不自动从上游拉取并覆盖。
连接器显示名设为 **Codex Workspace Connector**，端点使用 Doctor 返回的 `/mcp/session`。
登录、OAuth 授权和平台确认由用户完成；已有部署先检查再变更。
固定域名隧道可减少重启后的 URL 变化。

在实际项目的 Codex 任务里说：

> 使用 $second-opinion，围绕当前项目的设计讨论两轮，读回意见并说明采纳或拒绝的理由；先不要改代码。

每个宿主任务，包括分叉和同项目的兄弟任务，都使用自己的 Chat。
恢复时重新核验对应关系与真实文件读取，不回退到机器上最后活跃的工作区。

## 授权与恢复

部署工具变更后，刷新同一连接器元数据，在新 Chat 验证。
设置页普通 **Reconnect 可能只申请旧的只读权限**；完成通知需要走工具级 OAuth 入口，
确认实际请求包含 `review.submit`。

权限扩大后重新取得连接证明并建立绑定。平台可能自动续调旧请求并返回
`WORKSPACE_BINDING_MISMATCH`，这不是通知成功；先检查旧轮状态再恢复。
遇到安全拦截不改标只读、不换入口绕过。完整规则见[异步评议](skills/second-opinion/references/async-review.md)。

## 验收范围

2026-09-20，真实本机 Codex 任务与 ChatGPT Chat / 可见 6 Pro 已连续完成两轮：
发问 → 结束回合 → 真实通知 → 自动新回合 → 主动完整读回 → 确认，最终清理绑定。

这证明单任务的两轮异步链路，不代表四任务并发、休眠恢复、App 退出、远程宿主或
逐次确认弹窗全部通过。详见[验收记录](docs/validation.md)。

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

已有 CI 在 macOS/Windows 执行上述检查；测试也校验打包 Skill 的本地引用和机器专属路径。
自动化测试不替代真实网页验收。

## 文档与许可证

[长期跟进上游的合并规则](docs/upstream-sync.md)

[Skill](skills/second-opinion/SKILL.md) · [安全](docs/security.md) ·
[架构](docs/architecture.md) · [协议](docs/protocol.md) · [故障排查](docs/troubleshooting.md)

架构与协议文档包含继承的旧只读流程；异步通知以当前 Skill 与安全文档为准。
继续采用 [MIT](LICENSE)，保留上游版权和许可文本；独立维护与主要差异见 [NOTICE](NOTICE)。
