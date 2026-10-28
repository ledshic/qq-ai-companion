# 常驻服务与正式 API

2026-10-28 更新。阶段 B 建立的 v1 API、认证、持久任务和事件补读继续使用。Web 已接入正式服务；第三期新增来源授权，第四期移除活动 QQ 入口。桌面、iOS、Android 暂停迭代，CLI 聊天程序尚未实现。

## 启动与认证

`pnpm agent:serve` 默认监听 `127.0.0.1:4320`，只读取服务配置，不初始化 QQ。模型默认关闭；配置 `LLM_ENABLED=true` 与 DEEPSEEK_API_KEY 后才生成回答。AGENT_WEB_ORIGINS 必须列出实际浏览器来源，空值只允许服务自身来源。

拥有者凭据保存在数据目录的 service-owner.json，权限为 0600；数据库只保存令牌哈希。已有文件权限不安全、身份不符或为符号链接时拒绝启动，不重新认领旧库。不要打印或分享凭据，备份时同时保留数据库和凭据文件。

共享 SDK 使用示例：

```ts
import { createServiceClient } from './packages/client/src/service.js';
const service = createServiceClient('http://127.0.0.1:4320', { token });
console.log(await service.status());
```

日常设备通过配对获得可撤销凭据。普通设备和管理设备属于同一拥有者；普通设备不能批准配对、管理其他设备、改变运行状态或扩大记忆来源。

浏览器用 Bearer 凭据建立 HttpOnly、SameSite=Strict 的会话，时限 12 小时；HTTPS 来源设置 Secure。Cookie 的修改请求必须带受信任 Origin。跨域限制之外，所有数据请求仍检查认证与归属。

## 接口列表

路径前缀为 `/api/v1`。除创建及领取配对外，其余接口要求认证。JSON 按允许字段严格校验，不能自报拥有者、发言者或执行权限。

| 方法与路径 | 行为 |
| --- | --- |
| GET /me、GET /status | 当前身份及权限；服务、模型配置和兼容状态 |
| POST /pairings | 创建 5 分钟有效的配对请求，返回一次性领取密钥 |
| GET /pairings | 管理拥有者查看待批准请求 |
| POST /pairings/:id/approve | 管理拥有者批准设备 |
| POST /pairings/:id/claim | 批准后提交领取密钥，单次领取设备凭据 |
| GET /devices、DELETE /devices/:id | 管理拥有者查看、撤销设备；普通设备只能撤销自身 |
| POST /sessions、DELETE /sessions/current | 建立或退出浏览器会话 |
| GET /conversations、POST /conversations | 按认证身份列出、创建直聊会话 |
| GET /conversations/:id/messages | 按位置分页读取本人会话消息，推理单独返回 |
| POST /conversations/:id/messages | 提交 clientMessageId 和 content，返回 202 与消息、执行和事件标识 |
| GET /conversations/:id/memory-sources | 查看本人会话的跨会话来源授权及版本 |
| POST /conversations/:id/memory-sources | 管理拥有者整体替换 sourceConversationIds，空数组撤销授权 |
| GET /runs/:id、POST /runs/:id/cancel | 查询结果或取消执行 |
| GET /events | JSON 补读；Accept 为 text/event-stream 时持续推送事件 |
| POST /runtime/pause、POST /runtime/resume | 管理拥有者暂停、恢复接收新请求，不停止已运行任务 |

配对按来源地址限流，最多保留 64 项，错误领取最多尝试 10 次。初始管理设备不能通过 API 撤销；撤销普通设备后，其令牌、会话和已有事件流随权限检查失效。

来源列表只允许同一拥有者的受支持直聊会话，最多 8 项。服务配置必须同时启用记忆才会召回，完整规则见[三期记录](AGENT-REFACTOR-PHASE-3.md)。

错误为 `{error: {code}}`，不公开模型密钥、上游响应或数据库细节。模型关闭时仍可接受任务，但执行会失败为 model_not_configured。兼容字段 qq 固定为 disabled；configured 只表示模型配置启用，不表示已探测上游可用性。

## 执行与恢复

提交先事务保存用户消息和 message.accepted 事件，随后排队执行。同拥有者、会话和 clientMessageId 为去重键；同键同内容返回原结果，内容不同返回 409。暂停时重复提交已接受的同一请求仍返回原记录。

任务状态包括 queued、running、completed、failed、cancelled、interrupted。并发范围 1–16，等待任务最多 256 个。当前会话的新消息取代未完成的旧执行；取消信号、会话版本与来源检查防止旧结果提交。

进入 running 后总时限 120 秒。关闭浏览器、断开订阅都不会取消已接受任务；显式取消或宿主关闭才改变执行。正常退出或重启后，未完成任务成为 interrupted，不自动重新调用模型。

消息、推理和终态事件按事务保存。下一轮历史只读取已完成问答，不包含推理、失败、取消或旧 QQ 数据。来源授权变化、证据删除或原文变化会使旧记忆结果失效。

## 事件与客户端

事件最多保留最近 10000 条。after 或 Last-Event-ID 指定位置，每次最多 200 条。失效或超范围的位置返回 event_resync_required，调用方需重新取得快照。查询及推送前均校验归属。

`watch(after, signal)` 的取消只停止观察，执行取消需调用 cancel(runId)。GET 网络错误最多重试一次；提交消息不暗中重试，调用方保留原 clientMessageId 后重试。

## 数据与验证

服务表统一以 service_ 开头。数据库路径、旧 QQ 表、拥有者凭据及 bot.lock 位置不变，未知服务模式版本拒绝启动。活动服务不读写归档代码或旧 QQ 业务资料。

各期命令与结果见[交接记录](AGENT-REFACTOR-HANDOFF.md)。测试只用临时数据库、假模型和本地测试服务，不连接真实 QQ 或模型；涉及本机监听、进程身份和浏览器时需对应权限。
