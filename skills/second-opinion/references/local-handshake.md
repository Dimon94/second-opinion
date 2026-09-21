# 本地授权握手

本流程的验收状态以当前实际测试记录为准；新工具部署或 Skill 格式验证不等于网页链路通过。

## 1. 本地挑战

在当前项目 cwd、真实 CODEX_THREAD_ID 下调用 `c2c binding bootstrap --json`，把 bootstrapToken 保留在内存。计算其 UTF-8 字符串的 SHA-256 小写十六进制值作为 nonce。bootstrap 有效期五分钟，等待网页准备好后才生成。
将当前 URL、宿主、workspaceId、独立 TASK_ID 和 nonce 在内存中关联。仅把 nonce 发到自己的目标网页会话；不要把 bootstrap 发到网页。

## 2. 网页只读证明

选中同一 Codex Workspace Connector 并发送：

```text
[C2C]
TASK_ID: <unique-task-id>
ITERATION: 0
仅做连接校验。调用 connection_info({nonce:"<nonce>"})。
原样返回工具结果中的 connection_proof，供本地 Codex 验证。
这一步不绑定工作区、不读文件、不调用 bind_workspace。失败就返回实际错误，不编造证明。
```

从该回合完整回复取回 connection_proof 到内存。它是服务器对认证客户端、请求会话、nonce 和有效期的签名，不是模型自报的项目归属。原始证明不可打印到 Codex 工具输出；脱敏匹配 `c2c_ctx_[A-Za-z0-9_.-]+`。

本地消费前检查解码后的 principal 仅含 clientId/scopes；发现 token、secret 等额外凭据字段就停止并报告安全事件。Base64 不是加密；字段检查不代替服务端签名验证。

## 3. 本地授权

以 stdin 传 JSON `{bootstrapToken, connectionProof}` 给 `c2c binding authorize --json`；cwd 和 CODEX_THREAD_ID 与第 1 步相同。用进程 stdin 的内存数据传递，不把凭据写进命令行、文件或日志。
服务端核验签名、挑战、时效、当前宿主和工作区，再消费一次性 bootstrap、创建绑定。CLI 返回的 binding_token 只发回同一个 URL。
签名或挑战不匹配时不授权；重新确认目标回合。过期、Bridge 重启或 bootstrap 已消费时重新从第 1 步开始。SESSION_ALREADY_BOUND 按恢复阶梯处理，不撤销别的宿主。

## 4. 网页实读

向同一网页发送 binding_token，要求每次 workspace_info/read_file 都带 token。核验实际 workspaceId，再读取 Codex 已本地确认的非敏感相对路径与短行范围，回传路径、实际 ID 和内容摘要，不回显 token。
这一步通过才保存 URL 并发正式问题。新的宿主、项目或网页会话要独立握手。恢复旧会话先读回本地归属并实际核验；如果原 token 失效，再重新握手。

connection_info 只计算证明，不创建绑定、不读取工作区文件。真正授权只发生在已认证的本地 loopback 管理入口。证明与浏览器 URL 的对应仍由 Codex 的 tab、TASK_ID、nonce 和已发送回合核验，不能把 openai/session 元数据称作平台签名的网页 URL。
