# 文档索引

先看现行说明，再按任务打开一篇实施记录。标成历史草案的文章保留取舍，不能当作当前协议去改代码。代码与文档不一致时，以代码为准。

## 现行说明

| 文档 | 用它回答 |
|---|---|
| [个人 Agent 架构](PERSONAL-AGENT-ARCHITECTURE.md) | 运行时如何装配，QQ 如何只做渠道，`chatId` 与旧库字段如何兼容 |
| [参考文本驱动的通用事件模型](EVENT-REFERENCE-MODEL.md) | 事件协议。主题在 `config/event-memory/references/`，代码不按主题词分支，观察不发送 |
| [短期目标大纲](SHORT-TERM-PLAN.md) | 阶段 A–E 的交付和验收。完成情况在文首和第 6 节 |
| [README](../README.md) | 安装、一个实例的启动停止、配置项和离线检查命令 |

## 后续设计

| 文档 | 状态与用途 |
|---|---|
| [Web、CLI 与桌面手机客户端设计](MULTI-CLIENT-DESIGN.md) | 尚未实施；常驻主机上的统一 Agent 服务、在线客户端、指令集与构建计划 |

## 实施记录

这些文章记录已经落地的行为边界和当天验证，不代替上面的现行说明。

| 文档 | 记录的内容 |
|---|---|
| [A–C 实施记录](AC-IMPLEMENTATION.md) | 统一群上下文、接续与插话分开、发送前复查 |
| [联网搜索](SEARCH-IMPLEMENTATION.md) | 明确呼叫和连续对话中的搜索 |
| [单图理解](VISION-IMPLEMENTATION.md) | 明确请求的一张图片 |
| [表情包](MEMES-IMPLEMENTATION.md) | 分类选图，每条至多一张 |
| [模块化人格首版](PERSONALITY-IMPLEMENTATION.md) | 语境观察和只读表达计划；代码默认仍是 legacy |
| [群聊玩笑与认真回应](SOCIAL-BEHAVIOR.md) | 角色卡里事实回答和玩笑表演的分工 |
| [事件记忆观察](EVENT-MEMORY-OBSERVE.md) | 采集、保存、更正；不主动发送 |
| [长期事件聊天召回](EVENT-MEMORY-RECALL.md) | 明确呼叫或接续时读取本群本人的事件 |
| [主动决策观察](EVENT-INITIATIVE-OBSERVE.md) | 到期关注事项只生成本地草稿 |

## 对照材料

[QQ 群友机器人设计说明](QQBOT-DESIGN.md) 采集于 2026-10-23。产品原则可以继续用。其中“现状”“当前”和参数是当天快照，不是现在的默认配置。

## 历史草案

| 文档 | 不要照着做的部分 |
|---|---|
| [事件记忆、关注事项与主动决策设计](EVENT-MEMORY-PROACTIVITY-DESIGN.md) | 休假专用结构、`VacationEvent`、`resumeOn`，以及主动发送。现行协议是通用事件模型 |
| [模块化人格变更设计](PERSONALITY-DESIGN.md) | 初版方案。无状态首版以人格实施记录为准 |
| [人格运行时与决策引擎升级评估](PERSONALITY-RUNTIME-EVOLUTION.md) | 阶段 1 以后的升级。阶段 1 已有实施记录，其余尚未实施 |
