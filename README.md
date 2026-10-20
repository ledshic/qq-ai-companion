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

## Current scope

The local simulation replies with `你好，我是 AI 群友。` only when
`isMentioned` is true. Other messages produce no reply. IDs are fictional.
The mention flag is simulated explicitly; message text is not parsed for `@`.

Run `pnpm dev` to see both cases. Replies are printed locally, not sent to QQ.
NapCat is not installed, and no QQ account, LLM provider, or external service
is connected.

## Next step

Add a QQ adapter that maps real group events to `GroupMessage` and sends
the returned reply. Keep account credentials and API keys in local environment
variables rather than source files.
