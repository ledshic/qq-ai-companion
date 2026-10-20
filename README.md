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
OneBot v11 WebSocket server and sends the fixed reply when this account is
explicitly mentioned in a group. No LLM is connected.

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
