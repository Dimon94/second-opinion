# 跟进上游，同时保留独立 fork

`origin` 是个人 fork `Dimon94/second-opinion`；`upstream` 是
`XiaoDuoYa/codex-with-chatgpt`。保留两个 remote，不把个人分支重置为上游。

长期分叉默认用 **merge**：保留双方历史与共同祖先，下一轮只比较新增提交。
rebase 适合尚未共享的短期改动分支，不用于反复重放整条个人定制历史。
不使用强制同步 fork 来覆盖定制，不自动推送或部署。

## 每次同步

1. 检查工作区、分支和未提交改动；从包含最新定制的分支创建干净的同步 worktree。
2. `git fetch origin`、`git fetch upstream`；查看
   `git log HEAD..upstream/main` 和双方 diff，区分新增价值、已实现的等价修复与不适用功能。
3. `git merge --no-ff --no-commit upstream/main`。逐项按行为解决冲突，
   不整批选 ours/theirs。已有更完整的实现保留，并保留上游有价值的回归测试。
4. 运行 typecheck、build、完整测试与 `git diff --cached --check`，提交双亲 merge。
   核实 `git merge-base --is-ancestor upstream/main HEAD`。
5. 改动涉及绑定、OAuth、通知或恢复时，补做真实 Chat 验收；本地测试不能替代网页证据。
   向用户报告 SHA、采纳/跳过内容、验证边界；推送与运行时部署另行授权。

冲突必须保留的契约：Chat-only、每任务独立绑定、恢复重新验证、真实文件读取、
拒绝回退到最后活跃工作区、敏感文件过滤，以及授权后的异步通知与完整读回。
上游改动如果破坏这些契约，只采纳兼容部分；不要把旧流程重新写入 Second Opinion Skill。

## 2026-09-20 同步记录

同步目标：`9663b88753e35c76796c5bce000293e0bd22cd9e`。
同步前个人分支独有 41 个提交，上游独有 6 个提交。

| 上游提交 | 处理 |
| --- | --- |
| `230eec1` Windows 后台窗口 | 保留本地已适配实现及更完整的跨平台测试 |
| `39c8484` cloudflared 传输协议 | 保留本地等价实现及重启回归测试 |
| `860d7bc` 重连验证、敏感 git 状态 | 保留本地 NUL 分隔解析、重命名双端过滤及任务隔离；补充授权码生成时机和重连后真实读取规则 |
| `9663b88` 全局命令兼容遗留 `-w` | 保留已有兼容实现，纳入上游 CLI 回归测试 |
| `8fdd97c` 版本 0.1.3 | 同步包版本与运行时版本；不代表个人 fork 已发布 |
| `a48d975` Star History | 不引入上游品牌展示，保留 fork README、NOTICE 和原许可证 |

这次保留合并祖先关系，即使实现已提前适配，也无需下次重复审查同一批提交。
