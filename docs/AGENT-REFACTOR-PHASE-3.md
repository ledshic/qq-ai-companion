# 身份、记忆与人格边界实施记录

2026-10-27，面向仓库维护者。工作台现已传递明确的身份和会话元数据，可选读取有来源的历史摘录，并可关闭人格表达。旧 QQ 数据和业务流程保持原样，不导入工作台。

## 身份与授权

`agent/scope.ts` 定义执行范围：

| 字段 | 含义 |
| --- | --- |
| ownerId | 数据拥有者，由服务认证身份决定 |
| conversationId | 当前会话，提交前检查归属 |
| participantId / participantIds | 当前发言者与会话参与者；当前工作台直聊中均为拥有者 |
| channelId | 接入渠道，当前工作台为 console |
| kind | direct 表示直聊，shared 表示共享会话；权限不依赖 ID 的格式 |
| memorySourceConversationIds | 拥有者为当前会话明确允许读取的其他会话 |

RunHost（持久任务宿主）从服务存储构造执行范围。消息请求仍只接受客户端消息标识和正文，不能自报拥有者、参与者或授权列表。字母标识和包含 `private:` 的字符串均按普通标识处理，不据此推断私聊权限。

服务当前只创建 console/direct 会话。能力准备层支持显式 shared 元数据的保守过滤：只接收当前会话中当前参与者的来源，拒绝直聊来源和跨会话授权。共享会话创建、成员管理及账号绑定尚未实现。

## 可选记忆

设置 `AGENT_MEMORY_ENABLED=true` 后，服务通过 `runtime/service/memory.ts` 读取已完成问答中的用户原文。默认只读取当前会话。关闭、无结果、失败分别为 disabled、empty、unavailable；有效来源为 available。系统提示要求模型按状态说明，不补写无依据的经历。

本期复用服务消息作为历史证据：

- 短期历史仍由 ServiceStore 管理，不另存一份会话状态。
- 按当前请求分词，检查已授权范围内最近 200 条已完成用户消息；不匹配时返回空结果。
- 最多返回 4 条摘录，每条最多 800 字符，并保留原消息、会话、参与者、渠道和时间。
- 排除当前短期历史已有的原文、取消或失败的执行、助手回答及推理内容。
- 摘录必须逐字存在于来源中；它代表过去的说法，不能证明现在仍然成立。

该实现提供有来源的历史召回，没有新增语义提取、用户画像或向量检索。检索范围和条数有限，不能据一次空结果声称用户从未说过某件事。不会读取旧 QQ 的事件、私聊和画像表。

### 跨会话来源管理

接口均要求认证，路径以 `/api/v1` 开头：

| 接口 | 行为 |
| --- | --- |
| `GET /conversations/:id/memory-sources` | 读取本人目标会话的来源列表和版本 |
| `POST /conversations/:id/memory-sources` | 管理拥有者提交 `{sourceConversationIds: [...]}`，整体替换授权列表 |

最多授权 8 个来源，必须属于同一拥有者，且为受支持的直聊渠道。拒绝重复、自身和其他拥有者的会话；未授权会话默认不可召回。授权是单向的，空数组表示撤销所有跨会话来源。即使服务配置关闭记忆，也可管理授权；实际召回仍受服务配置控制。

共享客户端提供 `memorySources(id)` 和 `setMemorySources(id, ids)`。调用示例：

```ts
// service 为使用拥有者凭据创建的客户端，两个标识均来自本人的会话列表。
await service.setMemorySources(targetConversationId, [sourceConversationId]);
await service.setMemorySources(targetConversationId, []);
```

新增 `service_memory_policies` 表保存列表和递增版本；服务消息、旧 QQ 表和服务模式版本保持兼容。授权重启后继续有效。本期没有新增授权管理界面；使用共享客户端或正式 API 管理。

### 来源有效性与取消

召回后、每次模型请求前后、每次工具执行前，以及最终消息提交前检查来源有效性。授权版本变化、来源删除、原文变化或归属变化会使旧结果失效；助手消息和推理均不得提交。

能力准备每项最多等待 2 秒，失败时继续基础回答；取消则结束等待并阻止后续人格、模型和工具调用。RunHost 继续负责整项任务的 120 秒总时限。撤销无法收回已经发给模型的请求或已经执行的外部副作用，变更后的后续处理会被阻止。

## 可选人格

`AGENT_PERSONA=whale` 为默认表达，`none` 关闭角色表达，保留基础助手提示和工具。旧 `PERSONALITY_MODE` 只作用于旧 QQ 路径。

`capabilities/personality/prompt.ts` 的人格契约只接收当前正文、已提交历史的副本和取消信号，返回表达提示。没有身份、授权、记忆查询和工具注册接口。关闭或失败后使用基础助手表达，记忆权限和工具集合不变。

## 模块与旧系统边界

| 模块 | 本期职责 |
| --- | --- |
| `agent/scope.ts` | 中立身份与会话元数据；不解析 QQ 编码 |
| `capabilities/prepare.ts` | 能力调用、来源过滤、状态和有效性检查 |
| `capabilities/memory/contracts.ts` | 原文证据、来源和召回契约 |
| `runtime/service/memory.ts` | 本人会话授权、来源查询、持久授权及版本检查 |
| `channels/console/generator.ts` | 基础提示、可选表达与上下文组合，交给通用执行器 |
| `runtime/service/host.ts` | 传递可信执行范围，最终提交前检查有效性 |

旧 `chat-scope.ts`、事件运行时、个人召回和 archive 仍依赖 QQ 的历史会话编码、白名单及调度语义，因此本期不将其直接接到活动服务。来源和授权检查的思路被保留，历史数据不复制、不删除。下一期按依赖图处理旧 QQ 归档及默认文档清理。

## 验证

测试使用假模型、临时数据库和测试身份，覆盖非数字身份、拥有者及会话隔离、共享会话拒绝私聊资料、授权及撤销、来源变更、能力关闭及失败、人格输入隔离、无依据摘录过滤、取消、启动配置、重启和旧 QQ 数据保留。

2026-10-28 验证结果：`pnpm typecheck`、`pnpm typecheck:clients`、`pnpm web:build` 与 `git diff --check` 通过；`pnpm test` 382 项、`pnpm test:clients` 6 项、`pnpm test:web` 6 项通过。涉及端口、进程身份和浏览器的测试在沙箱外执行，日志保存于忽略目录 `artifacts/phase-3/`。文档已核对标题、敏感信息和关键实现事实。
