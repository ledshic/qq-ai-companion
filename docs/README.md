# 文档索引

当前文档面向常驻个人 Agent。旧 QQ 群聊、人格、事件、识图和表情说明已归档，不能作为活动服务的能力承诺。

| 文档 | 用途 |
| --- | --- |
| [重构交接与后续计划](AGENT-REFACTOR-HANDOFF.md) | 当前阶段、提交、验证和后续迭代边界 |
| [个人 Agent 架构](PERSONAL-AGENT-ARCHITECTURE.md) | 职责、依赖方向、任务和数据边界 |
| [正式 API 与常驻服务](MULTI-CLIENT-PHASE-B.md) | 启动、认证、接口和恢复 |
| [二期执行核心记录](AGENT-REFACTOR-PHASE-2.md) | 模型与工具契约、预算和取消；供应商文件在四期移到 infrastructure |
| [三期身份、记忆与人格记录](AGENT-REFACTOR-PHASE-3.md) | 元数据、来源召回、授权和表达开关 |
| [四期归档记录](AGENT-REFACTOR-PHASE-4.md) | 归档范围、兼容策略、恢复方式和验证 |
| [CLI 实施记录](AGENT-CLI.md) | 交互式聊天、单次命令、凭据、重试和任务观察 |
| [CLI 多行编辑](AGENT-CLI-EDITOR.md) | 多行按键、粘贴、草稿刷新、管道输入及真实终端验证 |
| [CLI 任务列表与恢复](AGENT-CLI-TASKS.md) | 按拥有者分页查询、编号选择、状态复核及来源检查 |
| [任务会话筛选与单次命令](AGENT-CLI-TASK-FILTERS.md) | 当前或指定会话筛选、单页 JSON、会话内游标与参数校验 |
| [任务具体状态筛选](AGENT-CLI-TASK-STATES.md) | 六种状态、会话组合、分页与状态变化后的恢复 |
| [真实流式输出](AGENT-STREAMING.md) | 模型增量、任务快照、SDK、Web 与 CLI，及认证、取消、来源检查 |
| [来源授权管理界面](AGENT-SOURCE-PERMISSIONS-UI.md) | 会话来源选择、撤销、设备权限和版本冲突 |

## 历史资料

[客户端阶段 A](MULTI-CLIENT-PHASE-A.md)记录模拟连接和原生端构建；[多客户端原始设计](MULTI-CLIENT-DESIGN.md)保留当时的方向。当前 Web 默认使用正式 API，桌面与移动端暂停迭代。

旧 QQ 资料和源码见[归档说明](../legacy/qq/README.md)。归档入口、配置和依赖不属于当前运行命令。
