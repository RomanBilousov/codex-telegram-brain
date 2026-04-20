import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URLSearchParams } from "node:url";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "./config.js";
import type { WebAuthStatus, WebAuthUser } from "./types.js";

const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const TELEGRAM_AUTH_URL = "https://oauth.telegram.org/auth";
const TELEGRAM_TOKEN_URL = "https://oauth.telegram.org/token";
const TELEGRAM_JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
const OAUTH_STATE_COOKIE = "codex_brain_tg_oauth";
const SESSION_COOKIE = "codex_brain_tg_session";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TELEGRAM_CODE_TTL_MS = 10 * 60 * 1000;
const RETURN_HASH_RE = /^#?[a-z0-9_-]{0,40}$/i;
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

interface OAuthStateCookie {
  state: string;
  verifier: string;
  nonce: string;
  legacyClientId?: string;
  returnHash?: string;
  exp: number;
}

interface SessionCookie {
  telegramId: string;
  name: string;
  username?: string;
  picture?: string;
  phoneNumber?: string;
  exp: number;
}

interface PendingTelegramCode {
  code: string;
  user: WebAuthUser;
  expiresAt: number;
}

const jwks = createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL));
const telegramCodeLogins = new Map<string, PendingTelegramCode>();

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function sign(value: string): string {
  return base64UrlEncode(createHmac("sha256", config.webAuth!.cookieSecret).update(value).digest());
}

function encodeSignedCookie(payload: object): string {
  const value = base64UrlEncode(JSON.stringify(payload));
  return `${value}.${sign(value)}`;
}

function decodeSignedCookie<T>(value: string | undefined): T | undefined {
  if (!value || !config.webAuth) {
    return undefined;
  }

  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) {
    return undefined;
  }

  const expected = sign(encoded);
  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);

  if (signatureBytes.length !== expectedBytes.length || !timingSafeEqual(signatureBytes, expectedBytes)) {
    return undefined;
  }

  try {
    return JSON.parse(base64UrlDecode(encoded).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const index = chunk.indexOf("=");
        if (index < 0) {
          return [chunk, ""];
        }
        return [chunk.slice(0, index), decodeURIComponent(chunk.slice(index + 1))];
      })
  );
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  if (!config.webAuth) {
    throw new Error("Telegram auth is not configured.");
  }

  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (config.webAuth.secureCookies) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearCookie(name: string): string {
  if (!config.webAuth) {
    throw new Error("Telegram auth is not configured.");
  }

  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (config.webAuth.secureCookies) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function sanitizeReturnHash(raw: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!RETURN_HASH_RE.test(trimmed)) {
    return undefined;
  }

  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function sanitizeLegacyClientId(raw: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  return CLIENT_ID_RE.test(raw) ? raw : undefined;
}

function buildCodeVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

function buildCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function buildClientId(telegramId: string): string {
  return `tg_${telegramId}`;
}

function buildSessionUser(user: WebAuthUser): SessionCookie {
  return {
    telegramId: user.telegramId,
    name: user.name,
    username: user.username,
    picture: user.picture,
    phoneNumber: user.phoneNumber,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  };
}

function setSessionCookie(res: ServerResponse, user: WebAuthUser): void {
  res.setHeader("set-cookie", serializeCookie(SESSION_COOKIE, encodeSignedCookie(buildSessionUser(user)), SESSION_TTL_SECONDS));
}

function extractUser(payload: JWTPayload): WebAuthUser {
  const telegramId =
    typeof payload.id === "number"
      ? String(payload.id)
      : typeof payload.id === "string"
        ? payload.id
        : typeof payload.sub === "string"
          ? payload.sub
          : "";

  if (!telegramId) {
    throw new Error("Telegram token does not contain a user id.");
  }

  return {
    telegramId,
    clientId: buildClientId(telegramId),
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : typeof payload.preferred_username === "string" && payload.preferred_username.trim()
          ? payload.preferred_username.trim()
          : "Telegram user",
    username: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    phoneNumber: typeof payload.phone_number === "string" ? payload.phone_number : undefined
  };
}

function getCurrentSession(req: IncomingMessage): SessionCookie | undefined {
  const cookies = parseCookies(req);
  const session = decodeSignedCookie<SessionCookie>(cookies[SESSION_COOKIE]);
  if (!session) {
    return undefined;
  }

  if (session.exp < Date.now()) {
    return undefined;
  }

  return session;
}

function cleanupExpiredTelegramCodes(): void {
  const now = Date.now();
  for (const [code, entry] of telegramCodeLogins.entries()) {
    if (entry.expiresAt <= now) {
      telegramCodeLogins.delete(code);
    }
  }
}

function generateTelegramCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[randomBytes(1)[0] % alphabet.length];
  }
  return code;
}

function getHint(): string {
  return config.webAuth?.mode === "telegram-code"
    ? "Напишите боту в Telegram: «дай код для входа в веб», затем введите код здесь."
    : "Войдите через Telegram, чтобы привязать веб-сессию к вашему профилю.";
}

export function getWebAuthStatus(req: IncomingMessage): WebAuthStatus {
  if (!config.webAuth) {
    return {
      enabled: false,
      authenticated: false
    };
  }

  const session = getCurrentSession(req);
  if (!session) {
    return {
      enabled: true,
      authenticated: false,
      provider: config.webAuth.mode === "oidc" ? "telegram-oidc" : "telegram-code",
      hint: getHint()
    };
  }

  return {
    enabled: true,
    authenticated: true,
    provider: config.webAuth.mode === "oidc" ? "telegram-oidc" : "telegram-code",
    user: {
      telegramId: session.telegramId,
      clientId: buildClientId(session.telegramId),
      name: session.name,
      username: session.username,
      picture: session.picture,
      phoneNumber: session.phoneNumber
    }
  };
}

export function getAuthenticatedWebUser(req: IncomingMessage): WebAuthUser | undefined {
  const status = getWebAuthStatus(req);
  return status.authenticated ? status.user : undefined;
}

export function requireTelegramAuthConfigured(): void {
  if (!config.webAuth) {
    throw new Error("Telegram web auth is not configured.");
  }
}

export function issueTelegramCodeLogin(user: Omit<WebAuthUser, "clientId">): { code: string; expiresAt: number } {
  requireTelegramAuthConfigured();
  cleanupExpiredTelegramCodes();

  for (const [code, entry] of telegramCodeLogins.entries()) {
    if (entry.user.telegramId === user.telegramId) {
      telegramCodeLogins.delete(code);
    }
  }

  let code = generateTelegramCode();
  while (telegramCodeLogins.has(code)) {
    code = generateTelegramCode();
  }

  const expiresAt = Date.now() + TELEGRAM_CODE_TTL_MS;
  telegramCodeLogins.set(code, {
    code,
    expiresAt,
    user: {
      ...user,
      clientId: buildClientId(user.telegramId)
    }
  });

  return { code, expiresAt };
}

export function completeTelegramCodeLogin(res: ServerResponse, code: string): WebAuthUser {
  requireTelegramAuthConfigured();
  cleanupExpiredTelegramCodes();

  const normalized = code.trim().toUpperCase();
  const entry = telegramCodeLogins.get(normalized);
  if (!entry || entry.expiresAt < Date.now()) {
    telegramCodeLogins.delete(normalized);
    throw new Error("Код входа недействителен или уже истек.");
  }

  telegramCodeLogins.delete(normalized);
  setSessionCookie(res, entry.user);
  return entry.user;
}

export function startTelegramLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  requireTelegramAuthConfigured();
  void req;

  if (config.webAuth?.mode !== "oidc") {
    throw new Error("OIDC login is not enabled.");
  }

  const state = base64UrlEncode(randomBytes(24));
  const verifier = buildCodeVerifier();
  const nonce = base64UrlEncode(randomBytes(24));
  const returnHash = sanitizeReturnHash(url.searchParams.get("returnHash"));
  const legacyClientId = sanitizeLegacyClientId(url.searchParams.get("clientId"));
  const redirectUri = new URL(config.webAuth.redirectPath, config.webAuth.publicUrl).toString();

  const cookiePayload: OAuthStateCookie = {
    state,
    verifier,
    nonce,
    returnHash,
    legacyClientId,
    exp: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000
  };

  const authorizeUrl = new URL(TELEGRAM_AUTH_URL);
  authorizeUrl.searchParams.set("client_id", config.webAuth.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", config.webAuth.scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", buildCodeChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  res.writeHead(302, {
    location: authorizeUrl.toString(),
    "set-cookie": serializeCookie(OAUTH_STATE_COOKIE, encodeSignedCookie(cookiePayload), OAUTH_STATE_TTL_SECONDS),
    "cache-control": "no-store"
  });
  res.end();
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<{ id_token: string }> {
  const webAuth = config.webAuth;
  if (!webAuth || webAuth.mode !== "oidc") {
    throw new Error("OIDC login is not enabled.");
  }

  const redirectUri = new URL(webAuth.redirectPath, webAuth.publicUrl).toString();
  const credentials = Buffer.from(`${webAuth.clientId}:${webAuth.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: webAuth.clientId,
    code_verifier: verifier
  });

  const response = await fetch(TELEGRAM_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram token exchange failed: ${response.status} ${text}`.slice(0, 300));
  }

  return (await response.json()) as { id_token: string };
}

async function validateIdToken(idToken: string, nonce: string): Promise<WebAuthUser> {
  const verification = await jwtVerify(idToken, jwks, {
    issuer: TELEGRAM_ISSUER,
    audience: config.webAuth!.clientId
  });

  if (verification.payload.nonce !== nonce) {
    throw new Error("Telegram nonce check failed.");
  }

  return extractUser(verification.payload);
}

export async function completeTelegramLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<{ user: WebAuthUser; legacyClientId?: string; returnHash?: string }> {
  requireTelegramAuthConfigured();
  void req;

  if (config.webAuth?.mode !== "oidc") {
    throw new Error("OIDC login is not enabled.");
  }

  const code = url.searchParams.get("code")?.trim();
  const incomingState = url.searchParams.get("state")?.trim();
  const error = url.searchParams.get("error")?.trim();

  if (error) {
    throw new Error(`Telegram login failed: ${error}`);
  }

  if (!code || !incomingState) {
    throw new Error("Telegram callback is missing code or state.");
  }

  const cookies = parseCookies(req);
  const stateCookie = decodeSignedCookie<OAuthStateCookie>(cookies[OAUTH_STATE_COOKIE]);

  if (!stateCookie || stateCookie.exp < Date.now()) {
    throw new Error("Telegram login state expired.");
  }

  if (stateCookie.state !== incomingState) {
    throw new Error("Telegram state mismatch.");
  }

  const tokenSet = await exchangeCodeForTokens(code, stateCookie.verifier);
  const user = await validateIdToken(tokenSet.id_token, stateCookie.nonce);

  res.setHeader("set-cookie", [
    clearCookie(OAUTH_STATE_COOKIE),
    serializeCookie(SESSION_COOKIE, encodeSignedCookie(buildSessionUser(user)), SESSION_TTL_SECONDS)
  ]);

  return {
    user,
    legacyClientId: stateCookie.legacyClientId,
    returnHash: stateCookie.returnHash
  };
}

export function logoutTelegramSession(res: ServerResponse): void {
  requireTelegramAuthConfigured();
  res.setHeader("set-cookie", clearCookie(SESSION_COOKIE));
}

export function buildPostLoginRedirect(returnHash?: string): string {
  return returnHash ? `/${returnHash}` : "/#list";
}
