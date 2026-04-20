# Codex Telegram Brain

Codex Telegram Brain is a local multi-agent Telegram runtime built around the
`codex` CLI.

It gives you one Telegram bot with an orchestrator, planner, coder, reviewer,
marketing assistant, and video agent, plus an optional mobile-first web app
that talks to the same local runtime.

## What it does

- receives messages from Telegram
- routes requests through an orchestrator or a chosen specialist
- supports direct agent calls such as `@coder` or `@reviewer`
- keeps per-chat memory, history, and active workspace state
- supports Telegram threads and topics as separate working contexts
- runs local Codex sessions for task execution
- optionally processes video with keyframes and speech transcription
- exposes a lightweight PWA for mobile access

## Included agents

- `general` / `orchestrator` - main coordinator
- `marketing` - positioning, growth, messaging, GTM
- `planner` - architecture, plans, decomposition
- `coder` - implementation inside an allowed workspace
- `reviewer` - risks, regressions, and test gaps
- `video` - video analysis with transcript and keyframes

## Requirements

- Node.js `20+`
- npm
- a Telegram bot token
- the `codex` CLI installed and available in `PATH`
- optional: `OPENAI_API_KEY` for transcription

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment file:

   ```bash
   cp .env.example .env
   ```

3. Set the required values:

   - `TELEGRAM_BOT_TOKEN`
   - `TRUSTED_CHAT_IDS`
   - `BRAIN_WORKSPACES`

4. Start the runtime:

   ```bash
   npm run start
   ```

5. Message your bot in Telegram.

## Core configuration

Environment variables are documented in [`.env.example`](.env.example).

The most important ones are:

- `TELEGRAM_BOT_TOKEN` - Telegram bot token from BotFather
- `TRUSTED_CHAT_IDS` - comma-separated allowlist of Telegram chat ids
- `BRAIN_WORKSPACES` - allowed workspaces in `alias=/absolute/path` format
- `BRAIN_COMPANY_KNOWLEDGE` - optional shared knowledge folders
- `BRAIN_PROJECT_SCAN_PATHS` - optional project scan roots
- `OPENAI_API_KEY` - optional, enables audio transcription for the video agent
- `WEB_AUTH_MODE` - `off`, `telegram-code`, or `oidc`

## Bot commands

- `/start` or `/help` - quick help
- `/office` - office and team overview
- `/team` or `/agents` - list available agents
- `/who` - show the active agent in the current chat
- `/threads` - list known chat threads/topics
- `/thread` - show the current thread/topic
- `/workspaces` - list configured workspaces
- `/workspace <alias>` - activate a workspace
- `/workspace none` - clear the active workspace
- `/agent <id>` - pin a specific agent
- `/agent none` - return to orchestrator mode
- `/delegate <agent> <task>` - delegate explicitly
- `/memory` - show memory
- `/forget <id or text>` - delete a memory item
- `/reset` - clear chat history
- `/weblogin` - issue a web login code for the PWA

## Web app

Running `npm run start` also launches a small PWA on `WEB_APP_HOST:WEB_APP_PORT`.

- local default: `http://127.0.0.1:4317`
- LAN usage: open the printed local network URL on your phone
- iPhone install: use Safari and choose `Add to Home Screen`

The web UI uses the same agents, memory, and workspace state as Telegram.

Authentication modes:

- `telegram-code` - default, sign in with a one-time code issued by the bot
- `oidc` - Telegram OIDC login for a public deployment
- `off` - disable web auth for a fully local trusted setup

Architecture notes:

- [Telegram Bot API notes](docs/telegram-bot-api-notes.md)
- [Superbot architecture](docs/superbot-architecture.md)

## Security model

- the bot only replies to trusted chat ids
- the `coder` agent only runs inside a selected workspace
- non-coding agents can operate without write access
- video processing runs in temporary working space
- no secrets are committed in this repository; runtime credentials are loaded from `.env`

## Video pipeline

- extracts audio, metadata, and key frames from Telegram video uploads
- uses OpenAI transcription only when `OPENAI_API_KEY` is configured
- passes transcript and frame context into the local video agent

## Repository layout

- [`src/`](src/) - Telegram runtime, agent orchestration, storage, and web server
- [`web/`](web/) - mobile-first PWA assets
- [`docs/`](docs/) - architecture notes and avatar assets
- [`schemas/`](schemas/) - structured data definitions

## Notes

- this repository is intended as a local runtime template, not a hosted SaaS
- private company-specific skills or hidden local folders are intentionally excluded from the public repository
