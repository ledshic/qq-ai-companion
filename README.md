# Personal Agent

本机常驻的个人 Agent 服务，提供认证会话、持久任务、可选来源记忆、时间与骰子工具，以及按配置启用的搜索。Web 工作台和交互式命令行已接入正式 API，并能显示真实模型增量草稿；桌面、iOS 和 Android 暂停迭代。

旧 QQ 适配器、群聊调度、事件记忆、配图及相关配置已归档到 [legacy/qq](legacy/qq/README.md)，默认构建和测试不扫描归档。已有数据库、拥有者凭据和锁路径不迁移、不删除。

## 本机启动

需要 Node.js 22.13 以上版本与 pnpm 10.20.0。初次准备依赖后，将 `.env.example` 复制为 `.env`，按需填写模型配置。

```sh
pnpm install --frozen-lockfile
pnpm agent:serve
```

服务默认监听 `127.0.0.1:4320`。第一次启动会在数据目录创建权限为 0600 的 `service-owner.json`，用于本人认证；不要分享或提交该文件。默认关闭模型，请求会明确失败为 `model_not_configured`。设置 `LLM_ENABLED=true` 并填写模型密钥后可执行模型任务。

Web 开发界面：

```sh
pnpm web:dev
```

将 `AGENT_WEB_ORIGINS` 配成实际页面来源，例如 `http://127.0.0.1:1420`，重启服务后在页面中使用拥有者或已配对设备的凭据建立浏览器会话。浏览器凭据不保存在页面存储中；关闭页面不会取消已经接受的任务。`?lab` 仅用于阶段 A 的模拟连接验证。

## 运行配置

| 配置 | 行为 |
| --- | --- |
| AGENT_PORT / AGENT_WEB_ORIGINS | 本机监听端口和明确允许的浏览器来源 |
| LLM_ENABLED / DEEPSEEK_API_KEY / DEEPSEEK_MODEL | 模型启用状态、密钥和模型名称 |
| WEB_SEARCH_ENABLED | 是否暴露公开搜索工具，默认关闭 |
| MEMORY_DB | 原数据文件路径，默认 data/memory.db |
| MAX_INFLIGHT / MEMORY_TURNS | 并发任务数 1–16；每会话已完成历史轮数 1–50 |
| AGENT_MEMORY_ENABLED | 可选来源召回，默认关闭；跨会话需拥有者显式授权 |
| AGENT_PERSONA | whale 为默认表达，none 关闭角色表达 |

记忆只使用已完成用户消息中的原文及来源，不将助手猜测或推理当成用户事实，也不导入旧 QQ 资料。检索范围和授权接口见[身份、记忆与人格记录](docs/AGENT-REFACTOR-PHASE-3.md)。

在工作台当前对话标题旁打开“来源授权”，管理设备可选择并保存其他会话来源，或撤销全部跨会话授权；普通设备只读。默认不勾选新来源，多设备版本冲突时需重新加载后再选择。操作与限制见[界面记录](docs/AGENT-SOURCE-PERMISSIONS-UI.md)。

## 进程管理

```sh
pnpm agent:status
pnpm agent:start
pnpm agent:stop
```

`pnpm dev` 与 `agent:serve` 都直接启动正式服务；`agent:start` 先检查锁，再以前台子进程运行同一入口。状态只检查本机锁，不能代表 HTTP 或上游模型可用。停止命令验证进程身份后发送 SIGTERM，由宿主退出时释放锁；无法验证身份时拒绝发送信号。

数据目录保留 `bot.lock` 兼容路径，API 继续保留固定为 disabled 的 `qq` 字段。原 `napcat`、`bot:*`、回放和表情索引脚本已退出默认命令。

## 命令行

`pnpm agent:cli --help` 查看命令。默认从数据目录的 service-owner.json 读取凭据；AGENT_CREDENTIAL_FILE 可指定已有设备凭据 JSON，AGENT_URL 可指定正式服务地址。CLI 不创建凭据或启动服务。

```sh
pnpm agent:cli status
pnpm agent:cli chat
pnpm agent:cli conversations
pnpm agent:cli new "我的计划"
pnpm agent:cli send <conversationId> "帮我梳理今天的安排"
pnpm agent:cli run <runId>
pnpm agent:cli watch
pnpm agent:cli cancel <runId>
```

`chat` 提供连续聊天，可用 /list、/new、/use、/history、/retry、/resume、/cancel 和 /exit。首条消息自动创建会话，也可用 `chat <conversationId>` 连接已有会话。历史与执行均由服务端管理，/cancel 才取消远程任务；Ctrl+C 或退出只停止本地观察。

发送前会输出 clientMessageId；网络结果不确定时，交互模式用 /retry，单次命令用相同正文和该标识作为 send 的最后一个参数重试。watch 输出逐行 JSON 事件。来源管理及完整用法见[CLI 实施记录](docs/AGENT-CLI.md)。

终端中 Enter 发送、Ctrl+J 或 Alt+Enter 换行，Ctrl+X 取消当前任务并保留输入。草稿在原位刷新；多行粘贴、编辑按键和管道模式见[CLI 多行编辑](docs/AGENT-CLI-EDITOR.md)。

## 验证与文档

```sh
pnpm typecheck
pnpm typecheck:clients
pnpm test
pnpm test:clients
pnpm web:build
pnpm test:web
```

测试使用临时数据和假模型，本地 HTTP、进程锁及浏览器测试需要正常监听和进程检查权限。没有真实账号或模型验证。

[流式输出记录](docs/AGENT-STREAMING.md)说明草稿、最终结果与重连规则；[当前架构](docs/PERSONAL-AGENT-ARCHITECTURE.md)说明职责与依赖；[正式 API](docs/MULTI-CLIENT-PHASE-B.md)说明认证与接口；[交接计划](docs/AGENT-REFACTOR-HANDOFF.md)记录已完成阶段和后续范围。完整列表见[文档索引](docs/README.md)。
