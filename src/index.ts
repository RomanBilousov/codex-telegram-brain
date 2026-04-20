import type { Server } from "node:http";
import { Telegraf } from "telegraf";
import { getAgentName } from "./agents.js";
import { config } from "./config.js";
import { Brain } from "./brain.js";
import { startWebServer } from "./web.js";
import { issueTelegramCodeLogin } from "./web-auth.js";
import type { BrainReply, ThreadTarget } from "./types.js";

const brain = new Brain();
const bot = new Telegraf(config.telegramBotToken);
const CHAT_ACTION_INTERVAL_MS = 4000;
let webServer: Server | undefined;
let telegramLaunched = false;
const BOT_COMMANDS = [
  { command: "start", description: "Справка по суперботу" },
  { command: "office", description: "Обзор офиса и команды" },
  { command: "team", description: "Список AI-специалистов" },
  { command: "who", description: "Кто отвечает в этом чате" },
  { command: "threads", description: "Список threads/topics" },
  { command: "thread", description: "Текущий thread/topic" },
  { command: "agent", description: "Закрепить или показать агента" },
  { command: "delegate", description: "Передать задачу специалисту" },
  { command: "workspaces", description: "Показать workspace-ы" },
  { command: "workspace", description: "Выбрать workspace" },
  { command: "status", description: "Состояние супербота" },
  { command: "memory", description: "Показать память" },
  { command: "forget", description: "Удалить факт из памяти" },
  { command: "reset", description: "Сбросить историю чата" },
  { command: "weblogin", description: "Код входа в Pocket Office web" }
] as const;
const LINK_PROTOCOL_RE = /^(https?:\/\/|tg:\/\/|mailto:)/i;
const WEB_LOGIN_TEXT_RE = /(^\/weblogin\b|код.*вход.*веб|вход.*веб.*код|войти.*веб|логин.*веб|web login|login code)/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLink(label: string, target: string): string {
  const safeLabel = escapeHtml(label);
  const safeTarget = escapeHtml(target);

  if (LINK_PROTOCOL_RE.test(target)) {
    return `<a href="${safeTarget}">${safeLabel}</a>`;
  }

  return safeLabel;
}

function renderInlineTelegramHtml(text: string): string {
  let result = escapeHtml(text);

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, target: string) =>
    renderLink(label, target)
  );
  result = result.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  result = result.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  return result;
}

function formatTelegramHtml(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();

  if (!normalized) {
    return "";
  }

  const codeBlocks: string[] = [];
  const withPlaceholders = normalized.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `@@CODEBLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return placeholder;
  });

  const rendered = withPlaceholders
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return "";
      }

      if (/^#{1,6}\s+/.test(trimmed)) {
        return `<b>${renderInlineTelegramHtml(trimmed.replace(/^#{1,6}\s+/, ""))}</b>`;
      }

      return renderInlineTelegramHtml(line);
    })
    .join("\n");

  return codeBlocks.reduce(
    (result, block, index) => result.replace(`@@CODEBLOCK_${index}@@`, block),
    rendered
  );
}

function isTrustedChat(chatId: number): boolean {
  return config.trustedChatIds.has(String(chatId));
}

function getThreadTarget(chatId: number, message: Record<string, unknown>): ThreadTarget {
  const directMessagesTopicId =
    typeof message.direct_messages_topic_id === "number"
      ? message.direct_messages_topic_id
      : typeof (message.direct_messages_topic as { topic_id?: unknown } | undefined)?.topic_id === "number"
        ? ((message.direct_messages_topic as { topic_id?: number }).topic_id ?? undefined)
        : undefined;

  if (typeof message.message_thread_id === "number") {
    return {
      sessionId: `${chatId}:topic:${message.message_thread_id}`,
      chatId,
      label: `topic:${message.message_thread_id}`,
      messageThreadId: message.message_thread_id
    };
  }

  if (typeof directMessagesTopicId === "number") {
    return {
      sessionId: `${chatId}:dm-topic:${directMessagesTopicId}`,
      chatId,
      label: `dm-topic:${directMessagesTopicId}`,
      directMessagesTopicId
    };
  }

  return {
    sessionId: String(chatId),
    chatId,
    label: "main-chat"
  };
}

async function sendThreadText(ctx: any, target: ThreadTarget, text: string): Promise<{ message_id: number }> {
  const payload: Record<string, unknown> = {
    chat_id: target.chatId,
    text: formatTelegramHtml(text),
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (typeof target.messageThreadId === "number") {
    payload.message_thread_id = target.messageThreadId;
  }

  if (typeof target.directMessagesTopicId === "number") {
    payload.direct_messages_topic_id = target.directMessagesTopicId;
  }

  return (await ctx.telegram.callApi("sendMessage", payload)) as { message_id: number };
}

async function sendThreadReply(ctx: any, target: ThreadTarget, reply: BrainReply): Promise<{ message_id: number }> {
  const speaker = reply.agent ?? "general";
  const text = `${getAgentName(speaker)}:\n\n${reply.text}`;
  return sendThreadText(ctx, target, text);
}

async function sendThreadAction(ctx: any, target: ThreadTarget, action: "typing"): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: target.chatId,
    action
  };

  if (typeof target.messageThreadId === "number") {
    payload.message_thread_id = target.messageThreadId;
  }

  if (typeof target.directMessagesTopicId === "number") {
    payload.direct_messages_topic_id = target.directMessagesTopicId;
  }

  await ctx.telegram.callApi("sendChatAction", payload);
}

async function syncTelegramProfile(): Promise<void> {
  await bot.telegram.setMyName(config.telegramBotName);
  await bot.telegram.setMyDescription(config.telegramBotDescription);
  await bot.telegram.setMyShortDescription(config.telegramBotShortDescription);
  await bot.telegram.setMyCommands(BOT_COMMANDS);

  const me = await bot.telegram.getMe();
  console.log(
    `Telegram profile synced: displayName="${config.telegramBotName}", username="@${me.username ?? "unknown"}"`
  );
}

function getTelegramDisplayName(from: { first_name?: string; last_name?: string; username?: string; id: number }): string {
  const joined = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return joined || from.username || `Telegram ${from.id}`;
}

async function sendWebLoginCode(ctx: any, target: ThreadTarget): Promise<void> {
  if (config.webAuth?.mode !== "telegram-code") {
    await sendThreadText(ctx, target, "Веб-вход по коду сейчас не включен.");
    return;
  }

  if (!ctx.from) {
    await sendThreadText(ctx, target, "Не удалось определить Telegram-профиль для входа.");
    return;
  }

  const { code, expiresAt } = issueTelegramCodeLogin({
    telegramId: String(ctx.from.id),
    name: getTelegramDisplayName(ctx.from),
    username: ctx.from.username
  });
  const minutesLeft = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000));
  await sendThreadText(
    ctx,
    target,
    [`Код входа в Pocket Office: \`${code}\``, `Действует примерно ${minutesLeft} мин.`, "Откройте веб-приложение и вставьте его в поле входа."].join("\n")
  );
}

async function withProgress<T>(
  ctx: any,
  target: ThreadTarget,
  initialStatus: string,
  work: (setStatus: (status: string) => Promise<void>) => Promise<T>
): Promise<T> {
  let currentStatus = initialStatus;
  let statusMessageId: number | undefined;

  const sendTyping = async (): Promise<void> => {
    try {
      await sendThreadAction(ctx, target, "typing");
    } catch {
      // Ignore chat action failures so they do not break the main request.
    }
  };

  const setStatus = async (status: string): Promise<void> => {
    if (!ctx.chat || !statusMessageId || !status || status === currentStatus) {
      return;
    }

    currentStatus = status;

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMessageId, undefined, formatTelegramHtml(status), {
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    } catch {
      // Ignore status edit failures so they do not break the main request.
    }
  };

  try {
    const statusMessage = await sendThreadText(ctx, target, initialStatus);
    statusMessageId = statusMessage.message_id;
  } catch {
    // Ignore status message failures so the main request can still run.
  }

  await sendTyping();
  const interval = setInterval(() => {
    void sendTyping();
  }, CHAT_ACTION_INTERVAL_MS);

  try {
    return await work(setStatus);
  } finally {
    clearInterval(interval);

    if (ctx.chat && statusMessageId) {
      try {
        await ctx.telegram.deleteMessage(target.chatId, statusMessageId);
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

bot.use(async (ctx, next) => {
  if (!ctx.chat || !isTrustedChat(ctx.chat.id)) {
    if (ctx.chat) {
      console.warn(`Blocked chat ${ctx.chat.id}`);
      await ctx.reply(
        [
          "Этот чат не входит в allowlist.",
          `Chat ID: ${ctx.chat.id}`,
          "Добавьте этот ID в TRUSTED_CHAT_IDS в .env и перезапустите бота."
        ].join("\n")
      );
    }
    return;
  }

  await next();
});

bot.on("message", async (ctx) => {
  try {
    const message = ctx.message;
    const threadTarget = getThreadTarget(ctx.chat.id, message as unknown as Record<string, unknown>);
    await brain.registerThread(threadTarget, message as unknown as Record<string, unknown>);

    if (
      "forum_topic_edited" in message ||
      "forum_topic_closed" in message ||
      "forum_topic_reopened" in message
    ) {
      return;
    }

    if ("forum_topic_created" in message) {
      const onboarding = await brain.getThreadOnboarding(threadTarget.sessionId);
      if (onboarding) {
        await sendThreadText(ctx, threadTarget, onboarding);
      }
      return;
    }

    if ("text" in message) {
      if (WEB_LOGIN_TEXT_RE.test(message.text.trim())) {
        await sendWebLoginCode(ctx, threadTarget);
        return;
      }

      const reply = await withProgress(ctx, threadTarget, "Думаю...", (setStatus) =>
        brain.handleText(threadTarget.sessionId, message.text, setStatus)
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    if ("video" in message) {
      const fileUrl = await ctx.telegram.getFileLink(message.video.file_id);
      const reply = await withProgress(ctx, threadTarget, "Скачиваю и подготавливаю видео...", (setStatus) =>
        brain.handleVideo(
          threadTarget.sessionId,
          {
            caption: message.caption,
            fileName: `${message.video.file_unique_id}.mp4`,
            fileUrl
          },
          setStatus
        )
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    if ("voice" in message) {
      const fileUrl = await ctx.telegram.getFileLink(message.voice.file_id);
      const reply = await withProgress(ctx, threadTarget, "Расшифровываю голосовое...", (setStatus) =>
        brain.handleAudio(
          threadTarget.sessionId,
          {
            fileName: `${message.voice.file_unique_id}.ogg`,
            fileUrl,
            source: "voice"
          },
          setStatus
        )
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    if ("audio" in message) {
      const fileUrl = await ctx.telegram.getFileLink(message.audio.file_id);
      const reply = await withProgress(ctx, threadTarget, "Расшифровываю аудио...", (setStatus) =>
        brain.handleAudio(
          threadTarget.sessionId,
          {
            caption: message.caption,
            fileName: message.audio.file_name ?? `${message.audio.file_unique_id}.mp3`,
            fileUrl,
            source: "audio"
          },
          setStatus
        )
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    if ("video_note" in message) {
      const fileUrl = await ctx.telegram.getFileLink(message.video_note.file_id);
      const reply = await withProgress(ctx, threadTarget, "Скачиваю и подготавливаю видео...", (setStatus) =>
        brain.handleVideo(
          threadTarget.sessionId,
          {
            fileName: `${message.video_note.file_unique_id}.mp4`,
            fileUrl
          },
          setStatus
        )
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    if ("document" in message && message.document.mime_type?.startsWith("video/")) {
      const fileUrl = await ctx.telegram.getFileLink(message.document.file_id);
      const reply = await withProgress(ctx, threadTarget, "Скачиваю и подготавливаю видео...", (setStatus) =>
        brain.handleVideo(
          threadTarget.sessionId,
          {
            caption: message.caption,
            fileName: message.document.file_name ?? `${message.document.file_unique_id}.mp4`,
            fileUrl
          },
          setStatus
        )
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    if ("document" in message && message.document.mime_type?.startsWith("audio/")) {
      const fileUrl = await ctx.telegram.getFileLink(message.document.file_id);
      const reply = await withProgress(ctx, threadTarget, "Расшифровываю аудио...", (setStatus) =>
        brain.handleAudio(
          threadTarget.sessionId,
          {
            caption: message.caption,
            fileName: message.document.file_name ?? `${message.document.file_unique_id}.bin`,
            fileUrl,
            source: "audio"
          },
          setStatus
        )
      );
      await sendThreadReply(ctx, threadTarget, reply);
      return;
    }

    console.warn(`Unsupported message type in chat ${ctx.chat?.id ?? "unknown"}: ${Object.keys(message).join(",")}`);
    await sendThreadText(ctx, threadTarget, "Пока поддерживаются текст, voice, audio, видео и video note.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const target = ctx.chat
      ? {
          sessionId: String(ctx.chat.id),
          chatId: ctx.chat.id,
          label: "main-chat"
        }
      : undefined;
    if (target) {
      await sendThreadText(ctx, target, `Ошибка: ${message}`);
    }
  }
});

async function main(): Promise<void> {
  await brain.init();
  webServer = await startWebServer(brain);

  try {
    await syncTelegramProfile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Telegram profile sync skipped: ${message}`);
  }

  try {
    await bot.launch();
    telegramLaunched = true;
    console.log("Codex Telegram Brain started.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Telegram bot launch skipped: ${message}`);
    console.log("Pocket Office web app remains available without local Telegram polling.");
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (telegramLaunched) {
    bot.stop(signal);
  }

  await webServer?.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    if (!webServer) {
      resolve();
      return;
    }

    webServer.close(() => resolve());
  });

  await brain.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
