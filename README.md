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

`pnpm dev` runs `src/index.ts` with tsx, prints a startup message, and exits.
`pnpm typecheck` checks TypeScript without generating files.

## Files

- `src/index.ts`: application entry point
- `package.json`: project metadata, scripts, and dependencies
- `pnpm-lock.yaml`: reproducible dependency versions
- `tsconfig.json`: strict TypeScript configuration
- `.gitignore`: generated files and local secrets excluded from Git

## Current scope

Only the local project foundation is initialized. NapCat is not installed,
and no QQ account, LLM provider, or external service is connected.

## Next step

Define message handling and configuration boundaries before adding a QQ adapter
or an LLM provider. Keep account credentials and API keys in local environment
variables rather than source files.
