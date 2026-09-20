# 运行入口

业务工作区取当前 Codex 任务 cwd，服务安装目录与业务项目分开。

1. 安装为符号链接时解析 Skill 的真实目录，仓库根在 `skills/second-opinion` 上两层；CLI 为仓库的 `bin/c2c.js`，恢复契约为 `skill/DOCTOR-HANDOFF.md`。复制安装时从本机部署记录确定运行仓库；找不到时询问部署位置，不猜测其他 checkout。
2. 用 Node.js 20+ 运行 `<checkout>/bin/c2c.js --help`，检查 workspace、doctor、session、binding bootstrap/authorize/unbind 与 review arm/status/ack/cancel。源码存在不等于它就是运行中的部署；CLI 与 Bridge 必须同版，先核验部署再执行。
3. 解释 Doctor 或恢复前完整读该部署的 DOCTOR-HANDOFF.md。运行 `<node> <cli> doctor -w <project-root> --json` 并按其唯一 nextAction 操作。首次部署按仓库 README 构建及 setup；已有部署不因定位失败就重启或重建。
4. 从 Doctor 与实际 ChatGPT 设置确定现有连接器、App ID 和端点，期望端点为 `/mcp/session`。显示名使用 Codex Workspace Connector；旧显示名 Second Opinion 可能缓存，按 App ID/端点核对而非创建副本。本仓库不包含维护者个人域名、App ID 或凭据。

从业务项目 cwd 执行 CLI，保留真实 CODEX_THREAD_ID。命令参数以当前 --help 为准。binding authorize 的秘密输入仅经进程 stdin，不能写入命令行或文件。

异步评议依赖运行中的本机 Codex App 与支持 `queue --thread --message` 的 Codex CLI；先检查 `codex queue --help`。Bridge 默认查找用户目录下的 `.local/bin/codex`（Windows 为 codex.exe），其他安装位置在启动 Bridge 前设置 C2C_CODEX_BIN 为可信绝对路径。该已实测 CLI 能力不是跨版本稳定性承诺；不可用时报告异步阻塞，不静默切换 transport。

仓库默认名、包名、状态目录仍含 codex-with-chatgpt，这是兼容标识，不要随项目改名迁移已有授权。只验收 App 运行中的本地路径，不推断休眠、退出 App 或远程宿主支持。
