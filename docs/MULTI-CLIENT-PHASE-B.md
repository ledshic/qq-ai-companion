# 多客户端阶段 B：常驻服务与正式 API

2026-10-27：已实现常驻宿主、正式 v1 API、设备认证、持久执行记录和事件补读，可供下一阶段 CLI、Web 接入。桌面端、iOS、Android 保持暂停，本轮未修改原生工程。

当前服务默认仅监听本机。工作台只访问自己的独立直聊会话，不读取旧 QQ 群聊、私聊或长期资料。Web 页面仍使用阶段 A 模拟 API，CLI 可执行程序尚未实现；这两部分属于阶段 C。

## 启动与认证

```sh
pnpm install
# 明确关闭 QQ 和模型，仅启动服务；环境变量覆盖 .env 中同名值：
NAPCAT_WS_URL= LLM_ENABLED=false pnpm agent:serve
```

正式服务地址默认是 `http://127.0.0.1:4320`，与阶段 A 的模拟服务 4317 端口分开。配置 `LLM_ENABLED=true` 和模型密钥后，工作台会调用现有文字生成、时间、骰子及按配置启用的搜索工具。状态中的 configured 只表示配置已启用，不代表已经探测过模型；QQ 的 connected 只表示适配器 WebSocket 已连接，不代表 QQ 账号登录状态已核实。

| 配置 | 行为 |
| --- | --- |
| `AGENT_PORT` | HTTP 端口，默认 4320，监听地址固定为 127.0.0.1 |
| `AGENT_WEB_ORIGINS` | 逗号分隔的可信 Web 来源，必须是完整 origin；空值只允许服务自身来源 |
| `NAPCAT_WS_URL` | 可选，空值关闭 QQ；配置后在 HTTP 服务就绪后启动 QQ 适配器 |
| `MEMORY_DB` | 沿用原数据文件；拥有者凭据与实例锁放在同一目录 |
| `MAX_INFLIGHT` | QQ 与工作台共用的生成额度，范围 1–16；后台任务保留原有前台优先规则 |
| `MEMORY_TURNS` | 工作台生成时读取最近已完成的对话轮数，范围 1–50 |

开发 Web 需要显式配置来源，例如 `AGENT_WEB_ORIGINS=http://127.0.0.1:1420,http://localhost:1420`。本轮没有开启公网监听、HTTPS 部署或自动安装系统启动任务。

第一次启动在数据目录创建 `service-owner.json`，仅当前系统用户可读写，权限为 0600；服务只在数据库中保存凭据哈希，不在日志中打印令牌。已有文件权限不安全、身份与数据库不符或是符号链接时拒绝启动，不重置拥有者。

本机运维可读取该文件，通过共享 SDK 查询服务。下面的示例不会把令牌放进命令历史或打印到终端；按实际 `MEMORY_DB` 调整凭据路径。

```sh
node --import tsx --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { createServiceClient } from './packages/client/src/service.ts';
const { token } = JSON.parse(readFileSync('data/service-owner.json', 'utf8'));
const service = createServiceClient('http://127.0.0.1:4320', { token });
console.log(await service.status());
JS
```

初始凭据用于本机拥有者管理。日常设备通过配对领取可撤销凭据，不需要复制初始凭据文件。备份恢复时应同时保留数据库与拥有者凭据，不删除凭据文件来重新认领既有数据库。

## 模块职责

| 位置 | 职责 |
| --- | --- |
| `src/app/bootstrap.ts` | 配置、模型、QQ 短期记忆、事件作业、共用模型额度与资源关闭 |
| `src/app/service.ts` | HTTP 进程入口、启动顺序、凭据初始化和统一退出 |
| `src/app/server/` | Fastify 路由、认证、来源校验、配对及 SSE 连接管理 |
| `src/runtime/service/host.ts` | 执行排队、取消、超时和关闭后的提交阻止 |
| `src/runtime/service/store.ts` | 附加表、事务去重、消息提交、恢复与事件查询 |
| `src/channels/console/` | 明确的工作台直聊环境，复用现有模型与文字工具 |
| `packages/contracts/service` | 请求校验、执行状态、响应与事件校验 |
| `packages/client/service` | HTTP 调用与带凭据的 SSE 读取，可供 CLI、Web 共用 |

`src/app/napcat.ts` 保留兼容入口，调用相同的启动组装。统一服务与旧 QQ 入口共用原实例锁，不能对同一数据目录同时运行。`bot:status`、`bot:stop` 仍是本机进程运维命令，会作用于持有这把锁的宿主；QQ 是否在线应通过正式状态接口判断。

QQ 断连只取消 QQ 路由中的工作，不关闭宿主或工作台执行。客户端断开、停止事件订阅或关闭界面也不会取消已接受的任务。只有显式取消、新消息取代同会话旧任务或宿主关闭会改变相应执行状态。

## 正式接口

所有路径以 `/api/v1` 开头。除创建配对请求与领取配对结果外，其余接口都需要认证。修改请求的 JSON 字段按实际允许列表校验，不能自报 `ownerId`、`senderId` 或 QQ 身份。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /me`、`GET /status` | 当前身份和权限；宿主、模型配置与 QQ 分项状态 |
| `POST /pairings` | 创建 5 分钟有效的配对请求，返回单次领取密钥 |
| `GET /pairings` | 初始拥有者查看待批准设备 |
| `POST /pairings/:id/approve` | 初始拥有者批准指定配对 |
| `POST /pairings/:id/claim` | 提交领取密钥，批准后单次领取设备凭据 |
| `GET /devices`、`DELETE /devices/:id` | 初始拥有者查看和撤销设备；普通设备只能撤销自身，`current` 表示当前设备 |
| `POST /sessions`、`DELETE /sessions/current` | 将 Bearer 凭据换成浏览器会话，或退出当前浏览器会话 |
| `GET /conversations`、`POST /conversations` | 按认证身份列出或创建工作台会话 |
| `GET /conversations/:id/messages` | 按位置分页读取消息 |
| `POST /conversations/:id/messages` | 提交 `{clientMessageId, content}`，返回 202 和消息、执行、事件标识 |
| `GET /runs/:id`、`POST /runs/:id/cancel` | 查询已保存执行结果或显式取消 |
| `GET /events` | JSON 补读；请求接受类型为 text/event-stream 时使用 SSE 持续推送 |
| `POST /runtime/pause`、`POST /runtime/resume` | 初始拥有者暂停或恢复接收新请求，不伪造已运行任务完成 |

CLI 使用 Authorization Bearer 请求头。浏览器会话 Cookie 设置 HttpOnly、SameSite=Strict 和 12 小时有效期；HTTPS 来源会设置 Secure。Cookie 认证的修改操作必须附带受信任 Origin，跨域来源也按明确列表检查，不能仅依靠 CORS 作为认证。

配对创建与领取按来源地址限流，最多保留 64 个待配对请求，错误领取最多尝试 10 次。普通设备不能批准新设备或暂停宿主；初始管理设备不能通过远程接口撤销。撤销设备会同时使其 Bearer 凭据和浏览器会话失效，已有事件流在下一轮权限检查时关闭。

错误统一返回 `{error: {code}}`，不返回模型密钥、上游响应体或数据库错误细节。模型关闭时可查询服务并接受请求，但执行会明确失败为 `model_not_configured`，不会冒充模型成功回答。

## 执行与恢复

执行状态为 queued、running、completed、failed、cancelled、interrupted。提交先事务保存用户消息和 message.accepted 事件，再由宿主执行；HTTP 请求不会一直等模型回答。

去重键由认证身份、工作台会话和 `clientMessageId` 组成。同标识同内容返回原执行，内容不同返回 409。暂停接收时，已经接受的请求重试仍返回原记录。生成最多同时执行配置允许的工作台任务，等待任务最多 256 个；与 QQ 的实际生成仍共用同一额度。

同会话新消息会取消未完成的旧执行。提交回答时再检查执行状态和会话版本，迟到结果不写成助手消息。回答、message.committed 和终态事件在同一事务保存；多个设备观察同一回答不会重复提交。

工作台历史只包含该会话已完成的问答，不把取消、失败或旧 QQ 资料当成已提交记忆。进入 running 后的时限为两分钟；底层模型调用继续保留原超时与取消机制。正常退出或异常重启后，未完成记录标记为 interrupted，不自动重新调用模型或重发 QQ 消息。

事件保存后才可查询或推送。`after` 查询参数或 Last-Event-ID 请求头指定恢复位置，每次最多读取 200 条；服务保留最近 10000 条事件，位置已失效或超出当前序列时返回 `event_resync_required`，客户端应重新读取快照。权限检查在数据库查询与事件写入连接之前执行。

共享 SDK 的 `watch(after, signal)` 支持按事件位置重新订阅，调用方保存最后收到的 eventId。取消这个 signal 只停止观察；取消执行须调用 `cancel(runId)`。GET 网络失败最多重试一次，消息提交不暗中重试，调用方应保留原 `clientMessageId` 再提交。

## 数据兼容与验证

新增表统一使用 `service_` 前缀，模式版本单独保存在 `service_meta` 中。不修改旧会话键、旧表列名或旧事件资料，也不将拥有者身份自动绑定为 QQ 账号。未知服务模式版本拒绝启动。

本轮验证结果：

| 检查 | 结果 |
| --- | --- |
| 核心与客户端类型检查 | 通过 |
| 完整核心测试 | 351 项通过，包含 14 项新增宿主、API、认证、恢复与共用额度回归 |
| 共享客户端与模拟 API 测试 | 6 项通过 |
| 原 Web 构建与浏览器回归 | 构建通过，3 项浏览器测试通过；未切换到正式 API |
| 独立进程 HTTP 检查 | 通过：401 拒绝、配对、自行撤销、去重、无模型明确失败、SIGTERM 后释放锁 |

记录位于忽略目录 `artifacts/phase-b/`，测试使用临时数据库和模拟模型响应，没有调用真实模型。独立进程检查关闭 QQ 与模型，不使用正式数据文件。团队记忆工具在本会话不可用，判断依据为当前代码、官方 Fastify 文档与实际测试结果。

下一阶段接入 CLI 和 Web 的真实会话、活动与有限管理。本人长期记忆投影、QQ 身份绑定、附件接口、云端部署和凭据迁移仍未实现，不通过工作台绕过旧私聊资料的可见范围。
