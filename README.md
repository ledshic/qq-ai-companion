# QQ AI Companion

## 当前开发方向

A–C 已实施：`FOLLOW_UP_MODE=unified` 使用共享群上下文、独立接续与插话规则，并在每段发送前检查时机。实施与验证见 [A–C 实施记录](docs/AC-IMPLEMENTATION.md)。离线回放运行 `pnpm replay`，不连接 QQ 或模型。

已恢复 TS bot 作为开发主线，AstrBot 项目暂停。设计依据见 [QQ 群友机器人设计](docs/QQBOT-DESIGN.md)，后续任务与验收见 [短期目标大纲](docs/SHORT-TERM-PLAN.md)。搜索、图片与表情包等后续目标尚未实现。

A minimal Node.js and TypeScript foundation for a QQ AI companion.

## Requirements

- Node.js 22.13 or later (the built-in `node:sqlite` module must be available)
- pnpm 10.20.0

## Getting started

```sh
pnpm install
pnpm dev
pnpm typecheck
```

`pnpm dev` runs `src/index.ts` with tsx, processes two mock group messages, and exits.
`pnpm typecheck` checks TypeScript without generating files.

## Files

- `src/index.ts`: local simulation with mentioned and non-mentioned messages
- `src/message.ts`: message types and reply rule
- `src/store.ts`: SQLite session store behind the memory policy
- `src/lock.ts`: single-instance lock for the NapCat bot
- `package.json`: project metadata, scripts, and dependencies
- `pnpm-lock.yaml`: reproducible dependency versions
- `tsconfig.json`: strict TypeScript configuration
- `.gitignore`: generated files and local secrets excluded from Git

Only one bot process may run at a time: `pnpm napcat` takes `data/bot.lock`,
refuses to start while another live instance holds it, and removes the lock on
Ctrl+C. A lock left behind by a crashed process is reclaimed on the next start.

## Local Docker deployment

Install and start Docker Desktop for Apple Silicon first. Check the engine with
`docker info`, the Compose plugin with `docker compose version`, and container
execution with `docker run --rm hello-world`.

The included `compose.yaml` follows the NapCat Docker example. Before starting:

1. Copy `.env.example` to `.env` if it does not already exist.
2. Set a private `NAPCAT_WEBUI_TOKEN` for the NapCat management page.
3. Run `docker compose config --quiet` to validate the deployment configuration.
4. Run `docker compose up -d` and open `http://127.0.0.1:6099/webui`.
5. Log in with the dedicated bot QQ account, then configure OneBot as below.

Ports 6099 and 3001 are bound to the Mac loopback interface only. Local QQ
sessions, configuration, and plugins are stored under `data/` and ignored by
Git. `docker compose down` stops the deployment while retaining these files.
The image is pinned to the digest used for the successful live group test.
Set `NAPCAT_ACCOUNT` after the first login to reuse the saved account on restart;
QQ may still require phone verification.

## NapCat connection

`pnpm dev` remains an offline demo. `pnpm napcat` connects to a real NapCat
OneBot v11 WebSocket server. With `LLM_ENABLED=true`, replies use DeepSeek
and the upstream whale persona; otherwise a fixed reply is used.

1. Install and log in to NapCat on a supported host.
2. In NapCat WebUI, create and enable a **WebSocket server** (forward WS).
   For a local deployment, use host `127.0.0.1`, port `3001`, message format
   `array`, and disable reporting self messages. Set a connection Token.
3. Copy `.env.example` to `.env`. Set `NAPCAT_WS_URL` to the server root URL
   (for example `ws://127.0.0.1:3001/`) and `NAPCAT_TOKEN` to the same Token.
   This is the OneBot connection Token, not the WebUI login password.
4. Run `pnpm napcat`. In a test group, use another QQ account to mention the
   bot. Expect `你好，我是 AI 群友。`. Plain text, mentions of other accounts,
   mentions of everyone, private messages, and self messages produce no reply.
5. Stop with Ctrl+C. Connection loss retries after 3 seconds. A send is only
   reported successful after an API acknowledgement; unconfirmed sends are
   not retried automatically.

Keep `.env` local; it is ignored by Git. For remote deployment use a protected
connection such as an SSH tunnel or WSS. `127.0.0.1` refers to the machine
running this project; Docker and remote hosts need appropriate port mapping
or tunneling. Do not use the WebUI port (`6099`) as the OneBot WS port.

## Verification

```sh
pnpm dev
pnpm typecheck
pnpm test
```

Tests use a local mock WebSocket server to verify authentication, event
filtering and the outgoing action. They do not log in to QQ. A live test was also completed locally: a real bot
mention triggered one fixed reply, while the ordinary message did not.

References: [NapCat configuration](https://napneko.github.io/config/basic),
[OneBot WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md).

## DeepSeek replies

In `.env`, set `DEEPSEEK_API_KEY` privately, set `DEEPSEEK_MODEL` (default
`deepseek-flash`), and set `LLM_ENABLED=true`. Restart only the Node bot with
`pnpm napcat`; do not restart NapCat or log QQ out. Stop any previous bot
process first to avoid duplicate replies. `LLM_ENABLED=false` keeps fixed replies.

The current mentioned text and up to 9 recent successful conversation turns
from the same user in the same group are sent to DeepSeek. Account and group
IDs and ordinary group messages are not included; only explicitly addressed
messages may use the tools described above. Requests time out after 30 seconds,
are not automatically retried, and limit output to 512 tokens / 1500 characters.
Concurrent replies are bounded by `MAX_INFLIGHT`, and empty or
over-4000-character prompts return a local usage hint. API failures return a
fixed friendly error without exposing service details.

Official API: https://api-docs.deepseek.com/api/create-chat-completion/

## Tools

Explicit calls (@, name call or a verified reply) may use two function tools,
executed locally by `src/tools.ts`:

- `get_current_time` — current date and time in a timezone, default Asia/Shanghai
- `roll_dice` — one to ten dice with two to a hundred sides

The model may ask for at most three tool rounds per reply; each result is
truncated to 2000 characters and every call is logged as
`[工具] name → result`. Follow-up replies, interjections and warm-up messages
never receive tools, so a casual message cannot trigger extra requests. Tool
output is treated as data, and the system prompt says so explicitly, because a
tool result is not a trusted instruction.

## Conversation memory

Memory is isolated by group and sender and stored in `data/memory.db` through
the built-in `node:sqlite` module, so it survives a bot restart. Sessions expire
after 30 minutes without a successful exchange; up to 100 sessions are kept and
the least recently updated one is evicted when full. Only replies acknowledged
as sent by NapCat enter memory. Failed model calls, failed sends and ordinary
messages do not enter memory. Set `MEMORY_DB` to move the database; `:memory:`
keeps it local to one process. Delete the file to forget everything.

Mention the bot with `/清空记忆` to clear your conversation in the current group
without calling DeepSeek. This does not delete the provider's own records.
Wait for a reply before asking a follow-up; concurrent requests are ignored.

## Replying without a mention

Using QQ's Reply action on a bot message also triggers a response without an @.
The bot queries `get_msg` and verifies the original message ID, group and sender.
Replies to other members, ordinary messages, failed lookups and unverifiable
references are ignored. Mentions continue to work directly.
Only the new text and the requesting user's existing conversation memory go
to DeepSeek; quoted messages are not appended to the model context. Memory
isolation, limits, expiry and `/清空记忆` remain the same. The clear command
also works when replying to a bot message.

## Calling the bot by name

The QQ nickname is `大肥鱼`; character self-identification follows the
upstream whale persona described below. Start a new message with `大肥鱼，` (or a space/punctuation delimiter), e.g.
`大肥鱼，记住我叫小林`. Common direct phrases such as `大肥鱼你觉得呢` also work.
Leading whitespace is accepted; the name and separator are removed before
processing. `大肥鱼，/清空记忆` clears the same group/user memory without an API call.
A name-only message reaches the persona, allowing an in-character reaction.

A name in the middle of text, in quoted content, or a longer name such as
`大肥鱼爱好者` does not trigger. Nested replies are not followed. Explicit name
calls work even when replying to someone else. Mentions and verified direct
replies keep working, and all three triggers share the same memory.

Name calls, mentions and verified replies share the same group/user memory.

## Legacy follow-up observation mode

`FOLLOW_UP_OBSERVE=true` enables the explicitly authorized observation scope.
After a successful generated reply is acknowledged by NapCat, a fixed 60-second
window opens for that user in that group. Windows are keyed by group and sender:
another member speaking never ends your window, and each participant keeps their
own 60-second window and two-reply quota. A new explicit request closes the old
window; only its own successful reply can open a new one. Disconnects clear windows.

Eligible ordinary text messages (up to 4000 characters, no @, no reply reference,
no name trigger) are sent to DeepSeek with the user's existing recent conversation
(up to 9 turns, `MEMORY_TURNS`). IDs and other members' messages are not sent. Each participant
runs at most one task, a judgment times out after 10 seconds, and a newer message
from the same participant merges into the one already waiting. Observations never
send QQ replies, enter memory, or
extend the window. Logs contain only the judgment and reason, not input messages
or conversation history. Late results that arrive after the window closed are
discarded; errors default to no response. Restarting clears windows but keeps
memory, which is persisted. Set `FOLLOW_UP_OBSERVE=false` to disable.

## Legacy limited automatic follow-ups

Set `FOLLOW_UP_AUTO=true` and `FOLLOW_UP_OBSERVE=false` to enable. Observation
mode takes precedence if both are true, and setting both false disables follow-ups.
A successful explicit call (@, name, or verified direct reply) opens a fixed
60-second window for that user in that group, with at most two successful
automatic replies. Automatic replies do not extend the deadline or reset quota.
Other speakers do not affect your window; disconnects, clear commands and new
explicit requests from the same user invalidate it. The window is checked after
judgment and again immediately before sending the generated reply.

Only a successful send acknowledgement writes an automatic exchange to memory
and consumes quota. Failures/timeouts stay silent and do not write memory.
Judging and generation are serialized per participant; a candidate that arrives
while that participant is busy waits instead of being skipped. No response is
sent for a negative judgment or a window that expired or closed.

## Legacy every-message mode

`FOLLOW_UP_MODE=always` removes the window: every ordinary group message goes to
a judge that decides whether the bot should answer it, using the recent group
text plus that sender's history. Two limits keep it from taking over:
`AUTO_REPLY_COOLDOWN_SECONDS` (default 45) between two bot replies in the same
group, and `AUTO_REPLY_HOURLY_CAP` (default 12) per group per hour.

In this mode `MAX_WINDOWS` and `WINDOW_SECONDS` do not apply, and random
interjection is skipped because the judge already covers it. Each message costs
one extra model call of a few hundred tokens, so the mode trades money for
naturalness; `FOLLOW_UP_MODE=window` (the legacy window policy) stays cheaper.

## Follow-up judgment and diagnostics

Judgments return `intent`: `continue` (reply), `pause` (wait), `end` (finish),
or `uncertain` (stay silent), plus a short reason. Only `continue` allows a reply.
Pause keeps the existing deadline and quota; it never extends the 60 seconds.
End closes the window. Invalid or inconsistent results fail closed.

Skip logs distinguish expired windows, exhausted quota, closed/missing windows
and ended conversations. Logs contain no raw message
text, IDs, memory content or keys. They describe decisions, not private model
reasoning. Conversation memory remains at 9 turns by default (`MEMORY_TURNS`).

## Concurrent participants

Each participant is a cooperative task on the single Node event loop: dispatch
decides synchronously, every await is a yield point, and the task owns one
`AbortController`. A slow generation for one member never blocks another.

- A new explicit call (@, name or verified reply) supersedes whatever that
  participant had running: the old task is aborted at its next await instead of
  completing and being discarded afterwards.
- While a reply is generating, follow-up messages from the same participant wait
  in that task's inbox. Messages within three seconds of the waiting one are
  merged into a single prompt, so a sentence split across several messages is
  answered once; anything older replaces it.
- `MAX_INFLIGHT` (default 2 in the library, 3 in the shipped `.env`) limits
  concurrent model calls. Work above the cap waits for a free slot and is
  cancelled if its window expires first, so a burst queues instead of being
  dropped.
- `MAX_WINDOWS` (default 6) caps how many follow-up windows are kept; the least
  recently used one is evicted when another participant opens a window.
- `WINDOW_SECONDS` (default 60, shipped `.env` 90) is how long a window stays
  open after a successful reply.
- Sends to one group are queued, so the parts of a multi-part reply never
  interleave with another member's reply.
- Disconnecting aborts every running task immediately.

## Proactive participation

Two opt-in features let the bot speak without being addressed. They read the structured short-lived group context (by default 60 messages, 5 minutes, bounded text length). Account, group and message identifier fields are replaced with consistent aliases before model requests. The random interjection path below is a legacy option; unified mode uses semantic judgment and a separate proactive budget.

`INTERJECT_PROBABILITY` (0-1, default 0) is the chance that an ordinary group
message makes the bot chime in. It fires at most once per group per
`INTERJECT_COOLDOWN_SECONDS` (default 180), never while that sender's task is
busy, and answers the recent context rather than the single message. Set it to
`0` to disable interjection entirely.

`WARMUP_ENABLED=true` makes the bot occasionally open a topic in a quiet group.
Every `WARMUP_INTERVAL_MINUTES` (default 30) inside `WARMUP_HOURS` (default
`20-23`, wrap-around such as `22-2` works) it rolls `WARMUP_PROBABILITY`
(default 0.3). On a hit it picks the most recently active group that has been
quiet for `WARMUP_IDLE_MINUTES` (default 45) and has not been warmed up within
`WARMUP_COOLDOWN_MINUTES` (default 60).

An interjection counts as a normal reply: it is written to that sender's memory
and opens a follow-up window, so the conversation can continue. Warm-up messages
carry no sender, so they only enter the group context. Neither path preempts an
explicit call, and neither starts while `MAX_INFLIGHT` slots are saturated.

## Privacy note

Participating requests can include the current group discussion even for explicit calls.
Account, group and message identifier fields use snapshot-local aliases; nicknames and
message text are still sent as discussion data and are not automatically redacted.
The group buffer is in memory only. Per-person conversation memory remains isolated
by group and sender in SQLite. See docs/AC-IMPLEMENTATION.md for limits and validation.

## Upstream whale persona

`config/personas/dafeiyu.md` is an adaptation of the upstream QQ group-friend character card
from mtshang/make-your-qq-ai-group-member, retained under its MIT license
(`config/personas/LICENSE.mtshang`). `src/persona.ts` loads it from the project,
independent of the shell's current directory. Restart the Node bot after edits.

The prior forced self-name prompt was removed: the QQ nickname remains 大肥鱼,
but the character identifies as DeepSeek / 小鲸鱼 and can object playfully to
being called a fat fish. Sentence-start calls also accept the card's names
小鲸鱼, DeepSeek, deepseek, 蓝色大肥鱼 and D指导; 小爱 is not restored.
Calling only a name now reaches the character instead of returning an input hint.

The judgment prompt remains separate from the persona. Data scope, nine-turn
memory and bounded automatic participation remain enforced by the platform.
The runtime appendix states the actual available context and absence of tools.

Generated newline-separated short messages are delivered as at most three parts,
1.2 seconds apart. Auto-follow-ups recheck the window before each part. One batch
counts as one conversation turn and one follow-up quota unit. If interrupted or
partially failed, only the successfully delivered text enters memory.

## Disclaimer

This project drives a QQ account through a third-party protocol implementation,
[NapCatQQ](https://github.com/NapNeko/NapCatQQ), not an official Tencent API. It
is not affiliated with or endorsed by Tencent. Using an unofficial client may
violate the QQ software license and can lead to account restriction or loss:
use a dedicated account, keep message volume human-sized, and accept that risk.

Messages are sent to the model provider you configure (DeepSeek by default).
Model costs and the provider's data-retention rules are yours; conversation
memory stays local in `data/memory.db`.

## License

MIT, see [LICENSE](LICENSE). The bundled character card is redistributed
unchanged from
[mtshang/make-your-qq-ai-group-member](https://github.com/mtshang/make-your-qq-ai-group-member)
under its MIT license; see `config/personas/LICENSE.mtshang`.
