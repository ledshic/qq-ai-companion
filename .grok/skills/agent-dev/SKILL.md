---
name: agent-dev
description: >
  Develop and refactor qq-ai-companion from a QQ bot into a personal agent.
  QQ stays a channel adapter; personality, memory, participation, tools, and
  send review stay in one runtime. Use when the user says agent-dev, /agent-dev,
  qq-ai-companion, personal agent, 个人 Agent, 渠道适配, refactor the bot,
  or asks for code changes in documents/workspace/qq-ai-companion.
---

# Agent dev

Work only in `/Users/dongxuli/documents/workspace/qq-ai-companion`. If the session cwd is elsewhere, use that absolute path. Do not edit other projects in the same turn.

## Read before editing

Read `docs/README.md` first when the task is to read or update project docs. It says which file is current, which is an implementation record, and which is a historical draft. Then read the doc that owns the area, and the code it names. Design facts live in those docs. This skill only says how to change the code.

| Change | Read first |
| --- | --- |
| Runtime split, channels, `chatId` | `docs/PERSONAL-AGENT-ARCHITECTURE.md` |
| Participation, follow-up, warmup stage E | `docs/SHORT-TERM-PLAN.md`, `docs/QQBOT-DESIGN.md` |
| Events, attention, initiative | `docs/EVENT-REFERENCE-MODEL.md`, then `docs/EVENT-MEMORY-OBSERVE.md` and `docs/EVENT-INITIATIVE-OBSERVE.md` |
| Persona | `docs/PERSONALITY-IMPLEMENTATION.md` |
| Search, vision, memes | the matching `docs/*-IMPLEMENTATION.md` |

`docs/EVENT-MEMORY-PROACTIVITY-DESIGN.md` is a historical draft for the vacation-shaped model. The live protocol is `src/memory/events/domains/event.ts` plus `config/event-memory/references/`. Do not add a topic module, `VacationEvent`, or `resumeOn`.

If code and a doc disagree, trust the code. Update `docs/PERSONAL-AGENT-ARCHITECTURE.md` in the same change only when that change makes one of its statements false. Do not add a new design doc unless the user asks.

## Place the change

| Layer | Home | Put here |
| --- | --- | --- |
| Process assembly | `src/app/` | QQ process entry, instance commands, offline demo, replay and maintenance |
| Runtime assembly | `src/runtime/agent.ts` | `createPersonalAgent`: start, tick, stop, one channel |
| Channel contract | `src/channels/channel.ts` | `ChatMessage` in, delivery capture and lookups out |
| QQ adapter | `src/channels/qq/` | OneBot parsing, WebSocket, lookups and channel wiring; process entry stays in `src/app/napcat.ts` |
| Participation | `src/runtime/conversation/conversation.ts`, `src/runtime/participation/participation-policy.ts`, `src/runtime/participation/observation.ts`, `src/cognitive/follow-up.ts`, `src/runtime/conversation/explicit-reply.ts`, `src/runtime/delivery/send-review.ts`, `src/runtime/participation/proactive-budget.ts` | Whether to speak, and whether a draft is still valid |
| Memory | `src/memory/memory.ts`, `src/memory/store.ts`, `src/memory/events/` | Short-term turns and evidence-backed events |
| Expression | `src/cognitive/personality/persona.ts`, `src/cognitive/personality/personality-runtime.ts`, `config/personas/` | How a reply sounds |
| Tools | `src/tools/builtin.ts`, `src/tools/search.ts`, `src/tools/vision/vision.ts`, `src/tools/memes/memes.ts` | Time, dice, search, one requested image, one meme |
| Shared primitives | `src/shared/` | Cancellation, concurrency and value validation only; no business policy |

A new platform field parsed in `conversation.ts` is in the wrong layer. Parse it in the adapter and pass `chatId`, `ReferencedMessage`, or `ReferenceHistory`.

## Rules that the refactor keeps

- Core identifiers are strings: `chatId`, `messageId`, `senderId`. Private chats use `private:<user id>` from `src/runtime/chat-scope.ts`.
- SQLite column `group_id` and stored JSON key `groupId` stay. `src/memory/events/storage-scope.ts` maps them to `chatId`. Do not bump a schema or rewrite `data/memory.db`.
- Session keys stay `[chatId, senderId]`: the second key identifies the sender/memory owner, never the bot's `selfId`. One runtime binds one channel.
- Participation kinds stay separate: explicit call, follow-up, interjection, warmup. An explicit call outranks the others. Warmup and interjection budgets must not block an active follow-up.
- A turn enters short-term memory only after the channel acknowledges the send. A failed, cancelled, or unconfirmed send does not.
- Tools may run on an explicit addressed turn or a follow-up admitted by the participation policy. Interjection and warmup do not receive tools. Image understanding keeps its separate explicit-request checks.
- Group replies may reference only the current sender's own private memory, and only when the current message explicitly authorizes quoting that specific private topic in the group. Merely mentioning a topic is not permission. Other users' private memory must never be disclosed. Authorization applies only to this message and is not stored; generation must receive only the private material inspected by the selector.
- Event topic text is data in `config/event-memory/references/`. Code does not branch on topic words. Initiative observation does not send. Do not add a send path unless the task is that feature.
- Persona text does not decide whether to speak. Participation policy does.

## Verify

From the repository root:

```sh
pnpm typecheck
pnpm test
```

`pnpm test` recursively runs `src/**/*.test.ts` with Node and the `tsx` loader. Keep each test beside its module in the corresponding domain directory. Use synthetic string ids. Cover the new rule and the adjacent rule it could break: chat isolation, unconfirmed send, stop rejecting input, or private-memory refusal.

Do not run `pnpm napcat`, `docker compose`, or a model call unless the user asks for a live check. Do not read or write `.env` or `data/`.

## Report

Say which layer changed, which doc you followed, and the typecheck and test results. If you did not run a command, say so.
