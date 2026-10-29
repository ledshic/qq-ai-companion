# 任务会话筛选与单次 CLI 记录

2026-10-29，面向使用者和仓库维护者。任务列表已支持按会话筛选，并提供单次 CLI 命令输出一页 JSON（可供程序读取的结构化数据）。交互式与单次命令共用参数解析、正式 SDK 和服务接口，认证、取消、任务恢复与来源授权规则继续使用原有流程。

## 交互式筛选

服务需包含本次新增的 conversationId 查询参数。进入 `pnpm agent:cli chat` 后使用：

| 命令 | 行为 |
| --- | --- |
| `/tasks --here` | 查看当前会话的未完成任务；尚未选择会话时拒绝查询 |
| `/tasks all --here` | 查看当前会话的全部状态 |
| `/tasks --conversation CONVERSATION_ID` | 查看指定本人会话的未完成任务 |
| `/tasks all --conversation CONVERSATION_ID` | 查看指定本人会话的全部状态 |
| `/tasks more` | 沿用上一页的状态与会话范围，不读取当前会话作为新条件 |
| `/tasks`、`/tasks all` | 重新查询本人全部会话，清除原会话筛选并重新编号 |

CONVERSATION_ID 替换为 `/list` 显示的会话标识。`--here` 和 `--conversation` 互斥；状态参数放在选项之前。后续已支持六种具体状态，完整取值见[状态筛选记录](AGENT-CLI-TASK-STATES.md)。交互式翻页只使用 `/tasks more`，不接受额外筛选、游标或页长选项。

切换当前会话不会改变已经打开的列表范围；列表标题始终显示范围。新的筛选从 #1 重新编号，失败的筛选清除旧编号；翻页继续沿用原来的编号和最近 200 项选择规则。`/resume #序号` 再次读取任务并核对会话；不带参数的 `/resume` 仍显示本人全部会话中的未完成任务。

## 单次命令

```text
pnpm agent:cli tasks
pnpm agent:cli tasks all --conversation CONVERSATION_ID --limit 20
pnpm agent:cli tasks all --conversation CONVERSATION_ID --before RUN_ID --limit 20
```

RUN_ID 替换为上一页返回的 nextCursor。命令只发起一次逻辑查询，不自动读取后续页；SDK 的安全 GET（只读请求）重试规则不变。默认查询 active，省略会话选项则查询本人所有会话；默认页长 50，允许 1–200。

标准输出只有一个 JSON 对象：`{ "runs": [...], "nextCursor": "..." }`。nextCursor 为 null 表示结束，空的本人会话也返回成功的空页。摘要仍不含正文、回答、推理或草稿，不提供只在交互式会话中有意义的编号。

状态必须放在选项之前，选项之间顺序不限，同一选项不能重复。缺少值、未知选项、无效页长和单次命令中的 `--here` 都在读取凭据、发送请求之前拒绝。成功退出码为 0，请求或凭据失败为 1，参数错误为 2。凭据继续从原有文件读取，不接受命令参数形式的令牌。

单次查询不会观察、取消或重新执行任务。需要查看结果、取消或恢复观察时，继续使用 `run`、`cancel` 或交互式 `/resume`，不增加新的执行流程。

## 服务与 SDK 边界

`GET /api/v1/runs` 新增可选 conversationId。服务先确认会话属于当前认证拥有者，再在原有状态筛选、创建顺序和分页查询中限定会话。不存在或其他拥有者的会话返回 404，空值等格式错误返回 400，不伪装成成功的空列表。

带会话筛选时，before 游标也必须属于该拥有者和该会话，否则返回 404。游标任务后来完成，不影响继续翻页；分页参数和排序不改变任务状态。原有不带会话筛选的请求保持兼容，没有数据库迁移。

SDK 使用 `client.runs({ status, conversationId, before, limit })`，按发起请求时的会话范围校验所有返回项，拒绝混入其他会话。筛选不会扩大来源授权，也不会将任务摘要当成模型历史；恢复后的认证、取消信号、来源检查和最终提交仍由原服务负责。

## 验证与交付

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 131 项通过，无跳过 |
| `pnpm test:clients` | 13 项通过，无跳过 |
| `pnpm typecheck`、`pnpm typecheck:clients` | 通过 |
| `pnpm web:build`、`pnpm test:web` | 构建通过，22 项浏览器测试通过 |
| `pnpm agent:cli --help`、`git diff --check` | 通过 |
| 实际进程与伪终端 | 单次命令通过真实 HTTP 读取指定会话；终端筛选、编号恢复、取消、编辑、缩放及输入模式恢复通过 |

新增回归覆盖会话归属、空会话、会话内分页、错会话游标、切换会话后的翻页范围、筛选变化后的编号重置、筛选失败、参数预校验、单页 JSON 和 SDK 范围校验。筛选后的编号恢复继续验证来源在订阅前和订阅期间撤销时不提交失效回答。

测试仅使用临时凭据、数据库和假模型；没有调用真实账号、模型、QQ 或用户数据库。HTTP、进程、Chrome 和伪终端在沙箱外验证，日志和终端记录位于忽略目录 `artifacts/cli-task-filters/`。伪终端验证沿用有 Python 3 标准库的 macOS/Linux 环境：

```sh
node --import tsx src/testing/cli-pty-smoke.ts artifacts/cli-task-filters
```

本页保留会话筛选和单次命令的首次交付记录。具体状态筛选已在后续完成，最新验证见状态筛选记录；命令补全、输入历史选择、后台观察和自动重跑仍未实现。文档已检查标题、术语、敏感信息、链接与实现事实。
