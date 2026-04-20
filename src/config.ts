import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { WorkspaceSpec } from "./types.js";

dotenv.config();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TRUSTED_CHAT_IDS: z.string().min(1),
  TELEGRAM_BOT_NAME: z.string().optional(),
  TELEGRAM_BOT_DESCRIPTION: z.string().optional(),
  TELEGRAM_BOT_SHORT_DESCRIPTION: z.string().optional(),
  CODEX_BIN: z.string().min(1).default("codex"),
  DEFAULT_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ORG_ID: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
  GENERAL_CHAT_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("low"),
  BRAIN_STATE_DIR: z.string().min(1).default(".brain"),
  BRAIN_WORKSPACES: z.string().optional(),
  BRAIN_COMPANY_KNOWLEDGE: z.string().optional(),
  BRAIN_PROJECT_SCAN_PATHS: z.string().optional(),
  WEB_APP_HOST: z.string().min(1).default("0.0.0.0"),
  WEB_APP_PORT: z.coerce.number().int().positive().default(4317),
  WEB_AUTH_MODE: z.enum(["off", "telegram-code", "oidc"]).default("telegram-code"),
  WEB_APP_PUBLIC_URL: z.string().optional(),
  TELEGRAM_WEB_LOGIN_CLIENT_ID: z.string().optional(),
  TELEGRAM_WEB_LOGIN_CLIENT_SECRET: z.string().optional(),
  TELEGRAM_WEB_LOGIN_SCOPES: z.string().optional(),
  WEB_AUTH_COOKIE_SECRET: z.string().optional()
});

const env = envSchema.parse(process.env);

function parseTrustedChatIds(input: string): Set<string> {
  return new Set(
    input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function parseWorkspaces(input?: string): WorkspaceSpec[] {
  if (!input) {
    return [];
  }

  return input
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [rawKey, ...pathParts] = entry.split("=");
      const key = rawKey?.trim();
      const joinedPath = pathParts.join("=").trim();

      if (!key || !joinedPath) {
        throw new Error(`Invalid workspace entry: ${entry}`);
      }

      const path = resolve(joinedPath);
      if (!existsSync(path)) {
        throw new Error(`Workspace path does not exist: ${path}`);
      }

      return { key, path };
    });
}

function parsePathList(input?: string): string[] {
  if (!input) {
    return [];
  }

  return input
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const path = resolve(entry);
      if (!existsSync(path)) {
        throw new Error(`Knowledge path does not exist: ${path}`);
      }
      return path;
    });
}

const webPublicUrl = env.WEB_APP_PUBLIC_URL?.trim() ? new URL(env.WEB_APP_PUBLIC_URL.trim()) : undefined;
const derivedCookieSecret = createHash("sha256").update(env.TELEGRAM_BOT_TOKEN).digest("hex");

if (env.WEB_AUTH_MODE === "oidc") {
  const oidcFields = [
    env.WEB_APP_PUBLIC_URL,
    env.TELEGRAM_WEB_LOGIN_CLIENT_ID,
    env.TELEGRAM_WEB_LOGIN_CLIENT_SECRET
  ].filter((value) => value?.trim());

  if (oidcFields.length < 3) {
    throw new Error(
      "OIDC mode requires WEB_APP_PUBLIC_URL, TELEGRAM_WEB_LOGIN_CLIENT_ID and TELEGRAM_WEB_LOGIN_CLIENT_SECRET."
    );
  }
}

export const config = {
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  trustedChatIds: parseTrustedChatIds(env.TRUSTED_CHAT_IDS),
  telegramBotName: env.TELEGRAM_BOT_NAME?.trim() || "Codex Brain",
  telegramBotDescription:
    env.TELEGRAM_BOT_DESCRIPTION?.trim() ||
    "Local multi-agent Telegram assistant with orchestrator, planner, coder, reviewer, and video agent.",
  telegramBotShortDescription:
    env.TELEGRAM_BOT_SHORT_DESCRIPTION?.trim() || "One Telegram bot with a small team of AI agents inside.",
  codexBin: env.CODEX_BIN,
  defaultModel: env.DEFAULT_MODEL?.trim() || undefined,
  openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
  openaiOrgId: env.OPENAI_ORG_ID?.trim() || undefined,
  openaiProjectId: env.OPENAI_PROJECT_ID?.trim() || undefined,
  transcriptionModel: env.TRANSCRIPTION_MODEL,
  generalChatEffort: env.GENERAL_CHAT_EFFORT,
  stateDir: resolve(env.BRAIN_STATE_DIR),
  workspaces: parseWorkspaces(env.BRAIN_WORKSPACES),
  companyKnowledgePaths: parsePathList(env.BRAIN_COMPANY_KNOWLEDGE),
  projectScanPaths: parsePathList(env.BRAIN_PROJECT_SCAN_PATHS),
  webAppHost: env.WEB_APP_HOST,
  webAppPort: env.WEB_APP_PORT,
  webAuth:
    env.WEB_AUTH_MODE === "off"
      ? undefined
      : env.WEB_AUTH_MODE === "oidc"
        ? {
            mode: "oidc" as const,
            publicUrl: webPublicUrl!,
            redirectPath: "/auth/telegram/callback",
            clientId: env.TELEGRAM_WEB_LOGIN_CLIENT_ID!.trim(),
            clientSecret: env.TELEGRAM_WEB_LOGIN_CLIENT_SECRET!.trim(),
            scopes: env.TELEGRAM_WEB_LOGIN_SCOPES?.trim() || "openid profile telegram:bot_access",
            cookieSecret: env.WEB_AUTH_COOKIE_SECRET?.trim() || derivedCookieSecret,
            secureCookies: webPublicUrl?.protocol === "https:"
          }
        : {
            mode: "telegram-code" as const,
            cookieSecret: env.WEB_AUTH_COOKIE_SECRET?.trim() || derivedCookieSecret,
            secureCookies: webPublicUrl?.protocol === "https:",
            publicUrl: webPublicUrl
          }
};
