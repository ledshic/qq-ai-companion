# CLI 任务具体状态筛选记录

2026-10-29，面向使用者和仓库维护者。任务列表现可按六种具体状态筛选，覆盖正式服务、共享 SDK（服务客户端）、交互式与单次 CLI。状态选择只改变读取条件，不改变任务执行、认证、取消或来源授权规则。

## 可选状态

| 状态值 | 列表范围 |
| --- | --- |
| active | 排队中和运行中，保留原聚合含义 |
| all | 全部状态，保留原聚合含义 |
| queued | 排队中 |
| running | 运行中 |
| completed | 已完成 |
| failed | 失败 |
| cancelled | 已取消 |
| interrupted | 已中断，例如服务重启后中断的任务 |

状态值区分大小写，每次使用一个具体状态或原有聚合值，不接受逗号组合。服务接口未指定状态时仍默认 all，交互式和单次 CLI 仍默认 active。

## 命令用法

交互式示例：

```text
/tasks running --here
/tasks failed --conversation CONVERSATION_ID
/tasks more
/resume #1
```

CONVERSATION_ID 替换为本人会话标识。状态放在选项之前，`--here`、`--conversation` 和编号恢复规则不变。`/tasks more` 保持上一页的具体状态与会话范围；切换当前会话不改变这两个条件。换一个状态重新查询会从 #1 编号，旧编号清除。

单次示例：

```text
pnpm agent:cli tasks completed --conversation CONVERSATION_ID --limit 20
pnpm agent:cli tasks failed --conversation CONVERSATION_ID --before RUN_ID --limit 20
```

RUN_ID 替换为同一筛选下上一页的 nextCursor。输出仍是一页 JSON（结构化数据），包含 runs 与 nextCursor，不自动翻页，也不提供交互式编号。未知状态、重复状态参数和无效组合在读取凭据、发起请求前拒绝；其余参数和退出码沿用[会话筛选记录](AGENT-CLI-TASK-FILTERS.md)。

## 状态变化与恢复

列表反映查询时的状态，不保证任务在选择时仍保持原状态。按 running 列出的任务后来完成，`/resume #序号` 会重新查询并显示最终结果；按 failed 或 interrupted 查询不会自动重新执行。排队或运行中任务仍通过原有订阅观察，取消继续调用正式取消接口。

分页游标仍按任务创建位置定位，不要求游标任务当前仍符合状态。例如上一页最后一项从 running 变成 completed，仍能继续读取更早的 running 任务。更换筛选条件时应从首页开始；会话、拥有者与游标归属检查不变。

状态筛选不会读取或扩大跨会话来源。恢复前及恢复期间的来源撤销仍会清除草稿、阻止失效回答提交；列表继续只包含摘要，不携带正文、结果、推理或草稿。

## 服务与 SDK

`GET /api/v1/runs?status=failed` 等请求使用原有 status 字段。新增值与任务的六种持久状态一致；非法值返回 400，不默认为 all。状态条件与拥有者、可选 conversationId、before 和 limit 一起执行，不增加数据表或迁移。

SDK 使用 `client.runs({ status: 'failed', conversationId, before, limit })`。共享契约提供状态目录与类型，CLI 参数解析和服务校验使用同一目录。SDK 按请求发出时的状态验证每个返回项：active 只能包含 queued/running，具体值必须完全匹配；不匹配时拒绝整页，不显示混合结果。

## 验证与交付

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 135 项通过，无跳过 |
| `pnpm test:clients` | 14 项通过，无跳过 |
| `pnpm typecheck`、`pnpm typecheck:clients` | 通过 |
| `pnpm web:build`、`pnpm test:web` | 构建通过，22 项浏览器测试通过 |
| `pnpm agent:cli --help`、`git diff --check` | 通过 |
| 真实进程与伪终端 | running 单次查询、筛选恢复、completed 当前会话列表、取消、多行编辑及输入模式恢复通过 |

新增测试逐项覆盖六种状态的服务、SDK、交互式和单次命令，验证拥有者隔离、会话组合、分页、状态变化后的游标、编号重置、终态只读、非法值预校验、SDK 返回项不匹配及请求条件快照。既有来源撤销验证已改为 running 会话筛选后的恢复流程，覆盖订阅前和订阅期间撤销。

验证使用临时凭据、数据库和假模型，没有访问真实账号、模型、QQ 或用户数据库。HTTP、进程、Chrome 和伪终端在沙箱外执行，日志与终端记录位于忽略目录 `artifacts/cli-task-states/`。有 Python 3 标准库的 macOS/Linux 可运行：

```sh
node --import tsx src/testing/cli-pty-smoke.ts artifacts/cli-task-states
```

文档已检查标题、术语、敏感信息、链接及实现事实。后续可按明确需求增加命令补全或输入历史选择，继续复用正式服务；不自动重跑失败任务。
