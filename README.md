# QQ AI Companion

A minimal Node.js and TypeScript foundation for a QQ AI companion.

## Requirements

- Node.js 22 or later
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
- `package.json`: project metadata, scripts, and dependencies
- `pnpm-lock.yaml`: reproducible dependency versions
- `tsconfig.json`: strict TypeScript configuration
- `.gitignore`: generated files and local secrets excluded from Git

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

The current mentioned text and up to 6 recent successful conversation turns
from the same user in the same group are sent to DeepSeek. Account and group
IDs and ordinary group messages are not included. No tools are enabled. Requests time out after 30 seconds,
are not automatically retried, and limit output to 512 tokens / 1500 characters.
Only one LLM request is processed at a time; further mentions while busy are
ignored. Empty or over-4000-character prompts return a local usage hint.
API failures return a fixed friendly error without exposing service details.

Official API: https://api-docs.deepseek.com/api/create-chat-completion/

## Conversation memory

Memory is isolated by group and sender, kept in RAM, and cleared on bot process
restart. Sessions expire after 30 minutes without a successful exchange. Up to
100 sessions are kept; the least recently updated session is evicted when full.
Only replies acknowledged as sent by NapCat enter memory. Failed model calls,
failed sends and ordinary messages do not enter memory.

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

## Follow-up observation mode

`FOLLOW_UP_OBSERVE=true` enables the explicitly authorized observation scope.
After a successful generated reply is acknowledged by NapCat, a fixed 60-second
window opens for that user in that group. Another member's message ends the
window, including an image-only message. A new explicit request closes the old
window; only its own successful reply can open a new one. Disconnects clear windows.

Eligible ordinary text messages (up to 4000 characters, no @, no reply reference,
no name trigger) are sent to DeepSeek with the user's existing recent conversation
(up to 6 turns). IDs and other members' messages are not sent. One observation
runs at a time and times out after 10 seconds; busy candidates are skipped.
Observations never send QQ replies, enter memory, or extend the window. Logs
contain only the judgment and reason, not input messages or conversation history.
Expired/interrupted late results are discarded; errors default to no response.
Restarting clears windows and memory. Set `FOLLOW_UP_OBSERVE=false` to disable.

## Limited automatic follow-ups

Set `FOLLOW_UP_AUTO=true` and `FOLLOW_UP_OBSERVE=false` to enable. Observation
mode takes precedence if both are true, and setting both false disables follow-ups.
A successful explicit call (@, name, or verified direct reply) opens a fixed
60-second window for that user in that group, with at most two successful
automatic replies. Automatic replies do not extend the deadline or reset quota.
Other speakers (including image-only messages), disconnects, clear commands and
new explicit requests invalidate the old window. The window is checked after
judgment and again immediately before sending the generated reply.

Only a successful send acknowledgement writes an automatic exchange to memory
and consumes quota. Failures/timeouts stay silent and do not write memory.
Judging and generation are serialized; concurrent candidates are skipped.
No response is sent for a negative judgment, expired or interrupted window.

## Follow-up judgment and diagnostics

Judgments return `intent`: `continue` (reply), `pause` (wait), `end` (finish),
or `uncertain` (stay silent), plus a short reason. Only `continue` allows a reply.
Pause keeps the existing deadline and quota; it never extends the 60 seconds.
End closes the window. Invalid or inconsistent results fail closed.

Skip logs distinguish expired windows, interruption by another member, exhausted
quota, closed/missing windows and busy processing. Logs contain no raw message
text, IDs, memory content or keys. They describe decisions, not private model
reasoning. Conversation memory remains at 6 turns.

## Upstream whale persona

`config/personas/dafeiyu.md` is the full upstream QQ group-friend character card
from mtshang/make-your-qq-ai-group-member, retained under its MIT license
(`config/personas/LICENSE.mtshang`). `src/persona.ts` loads it from the project,
independent of the shell's current directory. Restart the Node bot after edits.

The prior forced self-name prompt was removed: the QQ nickname remains 大肥鱼,
but the character identifies as DeepSeek / 小鲸鱼 and can object playfully to
being called a fat fish. Sentence-start calls also accept the card's names
小鲸鱼, DeepSeek, deepseek, 蓝色大肥鱼 and D指导; 小爱 is not restored.
Calling only a name now reaches the character instead of returning an input hint.

The judgment prompt remains separate from the persona. Data scope, six-turn
memory and bounded automatic participation remain enforced by the platform.
The runtime appendix states the actual available context and absence of tools.

Generated newline-separated short messages are delivered as at most three parts,
1.2 seconds apart. Auto-follow-ups recheck the window before each part. One batch
counts as one conversation turn and one follow-up quota unit. If interrupted or
partially failed, only the successfully delivered text enters memory.
