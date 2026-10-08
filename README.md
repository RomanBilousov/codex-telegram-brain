# Codex Telegram Brain

[English README](README.en.md)

Локальный multi-agent Telegram runtime вокруг `codex` CLI.

## Текущее состояние

Фактическая сверка: 2026-10-08. Базовая ветка: `main`. Source commit: `d1711c396612486eb8b197217838bf2d79c4409f`.

По текущему README и `package.json` подтверждены:
- Node.js/TypeScript runtime;
- Telegram bot через Telegraf;
- оркестратор и специализированные agent-роли;
- локальная память/история/workspace state;
- небольшой PWA/web UI;
- optional OpenAI transcription;
- команды `npm run start`, `npm run dev`, `npm run check`.

## Запуск

```bash
npm install
cp .env.example .env
npm run check
npm run start
```

Перед запуском заполните только необходимые переменные окружения. Не коммитьте Telegram bot token, OpenAI key или приватные workspace paths.

## Документация

- [English README](README.en.md)
- [Telegram Bot API notes](docs/telegram-bot-api-notes.md)
- [Superbot architecture](docs/superbot-architecture.md)

## Управление проектом

GitHub Projects — единственный рабочий трекер. Конкретный Project в текущей сверке не подтверждён.

## Границы

Этот репозиторий описан как локальный runtime template, а не hosted SaaS. Документационный проход не разрешает запуск бота против внешних чатов, запись в подключённые workspaces или публикацию сервиса.
