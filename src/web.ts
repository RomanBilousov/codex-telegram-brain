import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import {
  DIRECT_AGENT_IDS,
  getAgentAvatarPath,
  getAgentAvatarSource,
  getAgentCard,
  parseAgentId,
  setAgentProfileOverride
} from "./agents.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import {
  buildPostLoginRedirect,
  completeTelegramCodeLogin,
  completeTelegramLogin,
  getAuthenticatedWebUser,
  getWebAuthStatus,
  logoutTelegramSession,
  startTelegramLogin
} from "./web-auth.js";
import type { AgentKind, ChatMessage, MemoryItem, WebAuthStatus } from "./types.js";

interface BootstrapAgentPayload {
  id: AgentKind;
  name: string;
  role: string;
  title: string;
  summary: string;
  mission: string;
  avatarUrl: string;
  requiresWorkspace: boolean;
  activeWorkspaceKey: string | null;
  messages: ChatMessage[];
}

interface BootstrapPayload {
  appName: string;
  appDescription: string;
  clientId: string;
  defaultAgentId: AgentKind;
  agents: BootstrapAgentPayload[];
  workspaces: { key: string }[];
  auth: WebAuthStatus;
}

interface AgentDetailPayload extends BootstrapAgentPayload {
  skills: ReturnType<typeof getAgentCard>["skills"];
  contextFiles: string[];
  folders: string[];
  agentMemories: MemoryItem[];
  sessionMemories: MemoryItem[];
  customization: {
    hasCustomName: boolean;
    hasCustomAvatar: boolean;
    updatedAt?: string;
  };
}

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const ICON_PATH = fileURLToPath(new URL("../web/icon.svg", import.meta.url));
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function getSessionId(clientId: string, agent: AgentKind): string {
  return agent === "general" ? `web:${clientId}` : `web:${clientId}:agent:${agent}`;
}

function sanitizeClientId(raw: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  return CLIENT_ID_RE.test(raw) ? raw : undefined;
}

function sanitizeName(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 40);
}

function sanitizeAvatarDataUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith("data:image/")) {
    throw new Error("Avatar must be an image data URL.");
  }
  if (trimmed.length > 2_000_000) {
    throw new Error("Avatar image is too large.");
  }
  return trimmed;
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) {
        reject(new Error("Payload too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as T);
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function sendStatic(res: ServerResponse, filePath: string): Promise<void> {
  const body = await readFile(filePath);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control":
      filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest") ? "no-cache" : "public, max-age=300"
  });
  res.end(body);
}

function getLanUrls(port: number): string[] {
  const urls = new Set<string>();

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      urls.add(`http://${entry.address}:${port}`);
    }
  }

  return [...urls].sort();
}

function resolveAvatarUrl(agent: AgentKind): string {
  const avatar = getAgentAvatarSource(agent);
  return avatar.startsWith("data:image/") ? avatar : `/avatars/${agent}.svg`;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function getAgentFolders(agent: AgentKind): string[] {
  switch (agent) {
    case "marketing":
      return unique([...config.companyKnowledgePaths, ...config.projectScanPaths]);
    case "coder":
      return unique(config.workspaces.map((workspace) => workspace.path));
    case "reviewer":
      return unique(config.workspaces.map((workspace) => workspace.path));
    case "planner":
      return unique([...config.companyKnowledgePaths, ...config.workspaces.map((workspace) => workspace.path)]);
    case "general":
      return unique([...config.companyKnowledgePaths, ...config.projectScanPaths, ...config.workspaces.map((workspace) => workspace.path)]);
    case "video":
      return unique(config.companyKnowledgePaths);
    default:
      return [];
  }
}

function getExpectedOrigin(req: IncomingMessage, url: URL): string {
  const publicUrl = config.webAuth?.publicUrl;
  return publicUrl?.origin ?? `${url.protocol}//${req.headers.host ?? `127.0.0.1:${config.webAppPort}`}`;
}

function assertSameOrigin(req: IncomingMessage, url: URL): void {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  if (origin !== getExpectedOrigin(req, url)) {
    throw new Error("Cross-origin request blocked.");
  }
}

function getResolvedClientId(req: IncomingMessage, candidate: string | null): string | undefined {
  const authenticated = getAuthenticatedWebUser(req);
  if (authenticated) {
    return authenticated.clientId;
  }

  if (config.webAuth) {
    return undefined;
  }

  return sanitizeClientId(candidate);
}

async function ensureWebSession(brain: Brain, clientId: string, agentId: AgentKind) {
  const currentSessionId = getSessionId(clientId, agentId);
  const current = await brain.storage.getSession(currentSessionId);
  if (current.history.length || current.memories.length || current.activeWorkspaceKey || current.generalThreadId) {
    return current;
  }

  const legacy = await brain.storage.findLatestWebSession(agentId, currentSessionId);
  if (!legacy) {
    return current;
  }

  await brain.storage.saveSession({
    ...legacy,
    chatId: currentSessionId,
    assignedAgent: agentId
  });

  return await brain.storage.getSession(currentSessionId);
}

async function buildBootstrap(brain: Brain, clientId: string, auth: WebAuthStatus): Promise<BootstrapPayload> {
  const agents = await Promise.all(
    DIRECT_AGENT_IDS.map(async (agentId) => {
      const session = await ensureWebSession(brain, clientId, agentId);
      const card = getAgentCard(agentId);

      return {
        id: agentId,
        name: card.name,
        role: card.role,
        title: card.title,
        summary: card.summary,
        mission: card.mission,
        avatarUrl: resolveAvatarUrl(agentId),
        requiresWorkspace: card.requiresWorkspace,
        activeWorkspaceKey: session.activeWorkspaceKey ?? null,
        messages: session.history
      };
    })
  );

  return {
    appName: "Codex Pocket Office",
    appDescription: "Mobile-first companion for a local multi-agent Telegram assistant.",
    clientId,
    defaultAgentId: "general",
    agents,
    workspaces: config.workspaces.map((workspace) => ({ key: workspace.key })),
    auth
  };
}

async function buildAgentDetails(brain: Brain, clientId: string, agent: AgentKind): Promise<AgentDetailPayload> {
  const card = getAgentCard(agent);
  const session = await ensureWebSession(brain, clientId, agent);
  const override = await brain.storage.getAgentProfile(agent);

  return {
    id: agent,
    name: card.name,
    role: card.role,
    title: card.title,
    summary: card.summary,
    mission: card.mission,
    avatarUrl: resolveAvatarUrl(agent),
    requiresWorkspace: card.requiresWorkspace,
    activeWorkspaceKey: session.activeWorkspaceKey ?? null,
    messages: session.history,
    skills: card.skills,
    contextFiles: card.contextFiles,
    folders: getAgentFolders(agent),
    agentMemories: await brain.storage.getAgentMemories(agent),
    sessionMemories: session.memories,
    customization: {
      hasCustomName: Boolean(override?.name?.trim()),
      hasCustomAvatar: Boolean(override?.avatarDataUrl?.trim()),
      updatedAt: override?.updatedAt
    }
  };
}

function requireResolvedClientId(req: IncomingMessage, res: ServerResponse, candidate: string | null): string | undefined {
  const clientId = getResolvedClientId(req, candidate);
  if (clientId) {
    return clientId;
  }

  sendJson(res, config.webAuth ? 401 : 400, {
    error: config.webAuth ? "Authentication required." : "Invalid clientId.",
    authRequired: Boolean(config.webAuth)
  });
  return undefined;
}

async function handleApi(brain: Brain, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      host: config.webAppHost,
      port: config.webAppPort,
      directAgents: DIRECT_AGENT_IDS,
      authEnabled: Boolean(config.webAuth)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, getWebAuthStatus(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    assertSameOrigin(req, url);
    if (config.webAuth) {
      logoutTelegramSession(res);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/telegram-code") {
    assertSameOrigin(req, url);
    if (config.webAuth?.mode !== "telegram-code") {
      sendJson(res, 400, { error: "Telegram code login is not enabled." });
      return;
    }

    const body = await readJsonBody<{ code?: string; clientId?: string }>(req);
    const code = body.code?.trim();
    if (!code) {
      sendJson(res, 400, { error: "Code is required." });
      return;
    }

    const user = completeTelegramCodeLogin(res, code);
    const legacyClientId = sanitizeClientId(body.clientId ?? null);
    if (legacyClientId) {
      await brain.storage.migrateWebSessions(legacyClientId, user.clientId);
    }

    sendJson(res, 200, {
      ok: true,
      user
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    const clientId = requireResolvedClientId(req, res, url.searchParams.get("clientId"));
    if (!clientId) {
      return;
    }

    sendJson(res, 200, await buildBootstrap(brain, clientId, getWebAuthStatus(req)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent") {
    const clientId = requireResolvedClientId(req, res, url.searchParams.get("clientId"));
    const agentId = parseAgentId(url.searchParams.get("agentId") ?? "");
    if (!clientId || !agentId) {
      if (!agentId) {
        sendJson(res, 400, { error: "agentId is required." });
      }
      return;
    }

    sendJson(res, 200, await buildAgentDetails(brain, clientId, agentId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    assertSameOrigin(req, url);
    const body = await readJsonBody<{ clientId?: string; agentId?: string; text?: string }>(req);
    const clientId = requireResolvedClientId(req, res, body.clientId ?? null);
    const agentId = body.agentId ? parseAgentId(body.agentId) : undefined;
    const text = body.text?.trim() ?? "";

    if (!clientId || !agentId || !text) {
      if (clientId && (!agentId || !text)) {
        sendJson(res, 400, { error: "agentId and text are required." });
      }
      return;
    }

    await ensureWebSession(brain, clientId, agentId);
    const reply = await brain.handleWebText(clientId, agentId, text);
    const session = await brain.storage.getSession(getSessionId(clientId, agentId));
    sendJson(res, 200, {
      reply,
      messages: session.history,
      activeWorkspaceKey: session.activeWorkspaceKey ?? null
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspace") {
    assertSameOrigin(req, url);
    const body = await readJsonBody<{ clientId?: string; agentId?: string; workspaceKey?: string | null }>(req);
    const clientId = requireResolvedClientId(req, res, body.clientId ?? null);
    const agentId = body.agentId ? parseAgentId(body.agentId) : undefined;
    const workspaceKey = body.workspaceKey?.trim() || undefined;

    if (!clientId || !agentId) {
      if (clientId && !agentId) {
        sendJson(res, 400, { error: "agentId is required." });
      }
      return;
    }

    if (workspaceKey && !config.workspaces.some((workspace) => workspace.key === workspaceKey)) {
      sendJson(res, 400, { error: "Unknown workspace." });
      return;
    }

    await ensureWebSession(brain, clientId, agentId);
    await brain.setWebWorkspace(clientId, agentId, workspaceKey);
    const session = await brain.storage.getSession(getSessionId(clientId, agentId));
    sendJson(res, 200, {
      ok: true,
      activeWorkspaceKey: session.activeWorkspaceKey ?? null
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent") {
    assertSameOrigin(req, url);
    const body = await readJsonBody<{ agentId?: string; name?: string; avatarDataUrl?: string | null }>(req);
    const agentId = body.agentId ? parseAgentId(body.agentId) : undefined;
    if (!agentId) {
      sendJson(res, 400, { error: "agentId is required." });
      return;
    }

    if (config.webAuth && !getAuthenticatedWebUser(req)) {
      sendJson(res, 401, { error: "Authentication required.", authRequired: true });
      return;
    }

    const previous = (await brain.storage.getAgentProfile(agentId)) ?? { updatedAt: new Date().toISOString() };
    const avatarDataUrl =
      body.avatarDataUrl === undefined
        ? previous.avatarDataUrl
        : body.avatarDataUrl === null
          ? undefined
          : sanitizeAvatarDataUrl(body.avatarDataUrl);

    const profile = {
      name: sanitizeName(body.name),
      avatarDataUrl,
      updatedAt: new Date().toISOString()
    };

    await brain.storage.saveAgentProfile(agentId, profile);
    setAgentProfileOverride(agentId, profile);
    sendJson(res, 200, { ok: true, agent: getAgentCard(agentId) });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function handleStatic(res: ServerResponse, url: URL): Promise<void> {
  const routes = new Map<string, string>([
    ["/", `${WEB_ROOT}index.html`],
    ["/index.html", `${WEB_ROOT}index.html`],
    ["/styles.css", `${WEB_ROOT}styles.css`],
    ["/app.js", `${WEB_ROOT}app.js`],
    ["/sw.js", `${WEB_ROOT}sw.js`],
    ["/manifest.webmanifest", `${WEB_ROOT}manifest.webmanifest`],
    ["/icon.svg", ICON_PATH],
    ["/favicon.ico", ICON_PATH]
  ]);

  if (url.pathname.startsWith("/avatars/")) {
    const avatarName = url.pathname.replace("/avatars/", "").replace(/[^a-z0-9._-]/gi, "");
    const agentId = parseAgentId(avatarName.replace(/\.svg$/i, ""));
    if (!agentId) {
      sendText(res, 404, "Avatar not found.");
      return;
    }

    await sendStatic(res, fileURLToPath(new URL(`../${getAgentAvatarPath(agentId)}`, import.meta.url)));
    return;
  }

  const filePath = routes.get(url.pathname);
  if (!filePath) {
    sendText(res, 404, "Not found.");
    return;
  }

  await sendStatic(res, filePath);
}

async function handleAuthRoutes(brain: Brain, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  void brain;

  if (req.method === "GET" && url.pathname === "/auth/telegram/start") {
    if (!config.webAuth) {
      sendText(res, 404, "Telegram auth is not configured.");
      return true;
    }

    startTelegramLogin(req, res, url);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/auth/telegram/callback") {
    if (!config.webAuth) {
      sendText(res, 404, "Telegram auth is not configured.");
      return true;
    }

    try {
      const { user, legacyClientId, returnHash } = await completeTelegramLogin(req, res, url);
      if (legacyClientId) {
        await brain.storage.migrateWebSessions(legacyClientId, user.clientId);
      }

      res.writeHead(302, {
        ...(res.getHeaders() as Record<string, string | string[]>),
        location: buildPostLoginRedirect(returnHash),
        "cache-control": "no-store"
      });
      res.end();
    } catch (error) {
      sendText(res, 500, error instanceof Error ? error.message : "Telegram login failed.");
    }
    return true;
  }

  return false;
}

async function handleRequest(brain: Brain, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (await handleAuthRoutes(brain, req, res, url)) {
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(brain, req, res, url);
      return;
    }

    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed.");
      return;
    }

    await handleStatic(res, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    } else {
      res.end();
    }
  }
}

export async function startWebServer(brain: Brain): Promise<Server> {
  const server = createServer((req, res) => {
    void handleRequest(brain, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.webAppPort, config.webAppHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`Pocket Office web app started on http://127.0.0.1:${config.webAppPort}`);
  for (const url of getLanUrls(config.webAppPort)) {
    console.log(`Pocket Office LAN URL: ${url}`);
  }
  if (config.webAuth) {
    const descriptor = config.webAuth.mode === "oidc" ? config.webAuth.publicUrl.origin : "telegram-code";
    console.log(`Pocket Office Telegram login enabled for ${descriptor}`);
  }

  return server;
}
