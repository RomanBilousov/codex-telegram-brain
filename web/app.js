const STORAGE_KEY = "codex-pocket-office-client-id";
const ACTIVE_AGENT_KEY = "codex-pocket-office-active-agent";
const INSTALL_DISMISSED_KEY = "codex-pocket-office-install-dismissed";
const DEFAULT_CLIENT_ID = "pocket-office-main";
const IOS_RE = /iphone|ipad|ipod/i;

const state = {
  bootstrap: null,
  auth: null,
  activeAgentId: null,
  detailByAgent: {},
  screen: "list",
  pendingPrompt: null,
  installAvailable: false,
  isStandalone:
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true,
  pendingAvatarDataUrl: undefined
};

const elements = {
  authCodeGroup: document.querySelector("#authCodeGroup"),
  authCodeInput: document.querySelector("#authCodeInput"),
  authCodeSubmit: document.querySelector("#authCodeSubmit"),
  authCopy: document.querySelector("#authCopy"),
  authMeta: document.querySelector("#authMeta"),
  authScreen: document.querySelector("#authScreen"),
  avatarInput: document.querySelector("#avatarInput"),
  backButton: document.querySelector("#backButton"),
  chatHeaderAvatar: document.querySelector("#chatHeaderAvatar"),
  chatHeaderName: document.querySelector("#chatHeaderName"),
  chatHeaderRole: document.querySelector("#chatHeaderRole"),
  chatList: document.querySelector("#chatList"),
  chatRowTemplate: document.querySelector("#chatRowTemplate"),
  chatScreen: document.querySelector("#chatScreen"),
  closeDetailButton: document.querySelector("#closeDetailButton"),
  composer: document.querySelector("#composer"),
  composerInput: document.querySelector("#composerInput"),
  detailAvatar: document.querySelector("#detailAvatar"),
  detailContextFiles: document.querySelector("#detailContextFiles"),
  detailFolders: document.querySelector("#detailFolders"),
  detailMemories: document.querySelector("#detailMemories"),
  detailMission: document.querySelector("#detailMission"),
  detailNameInput: document.querySelector("#detailNameInput"),
  detailSection: document.querySelector("#detailSheet"),
  detailSessionMemories: document.querySelector("#detailSessionMemories"),
  detailSkills: document.querySelector("#detailSkills"),
  detailSummary: document.querySelector("#detailSummary"),
  detailTitle: document.querySelector("#detailTitle"),
  dismissInstallButton: document.querySelector("#dismissInstallButton"),
  installBanner: document.querySelector("#installBanner"),
  installButton: document.querySelector("#installButton"),
  installCopy: document.querySelector("#installCopy"),
  listScreen: document.querySelector("#listScreen"),
  loginButton: document.querySelector("#loginButton"),
  logoutButton: document.querySelector("#logoutButton"),
  messageTemplate: document.querySelector("#messageTemplate"),
  messages: document.querySelector("#messages"),
  profileTrigger: document.querySelector("#profileTrigger"),
  refreshButton: document.querySelector("#refreshButton"),
  resetAvatarButton: document.querySelector("#resetAvatarButton"),
  saveProfileButton: document.querySelector("#saveProfileButton"),
  sheetBackdrop: document.querySelector("#sheetBackdrop"),
  workspaceBar: document.querySelector("#workspaceBar"),
  workspaceSelect: document.querySelector("#workspaceSelect")
};

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function removeStoredValue(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function getClientId() {
  const existing = getStoredValue(STORAGE_KEY);
  if (existing) {
    return existing;
  }

  setStoredValue(STORAGE_KEY, DEFAULT_CLIENT_ID);
  return DEFAULT_CLIENT_ID;
}

function getResolvedClientId() {
  return state.auth?.user?.clientId ?? getClientId();
}

function getRememberedActiveAgent() {
  return getStoredValue(ACTIVE_AGENT_KEY);
}

function rememberActiveAgent(agentId) {
  if (!agentId) {
    return;
  }
  setStoredValue(ACTIVE_AGENT_KEY, agentId);
}

function clearRememberedActiveAgent() {
  removeStoredValue(ACTIVE_AGENT_KEY);
}

function formatTime(iso) {
  if (!iso) {
    return "";
  }
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function getActiveAgent() {
  return state.bootstrap?.agents.find((agent) => agent.id === state.activeAgentId) ?? null;
}

function getLastMessage(agent) {
  return agent.messages?.[agent.messages.length - 1] ?? null;
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[([^\]]+)\]\((\/[^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function renderMarkdown(text) {
  const normalized = (text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const codeBlocks = [];
  const withCodePlaceholders = normalized.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_match, code) => {
    const key = `@@CODE_${codeBlocks.length}@@`;
    codeBlocks.push(`<pre>${escapeHtml(code.trim())}</pre>`);
    return key;
  });

  const lines = withCodePlaceholders.split("\n");
  const chunks = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) {
      return;
    }
    chunks.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith("- ")) {
      listItems.push(renderInlineMarkdown(line.slice(2)));
      continue;
    }

    flushList();

    if (/^#{1,6}\s+/.test(line)) {
      chunks.push(`<p class="md-heading">${renderInlineMarkdown(line.replace(/^#{1,6}\s+/, ""))}</p>`);
      continue;
    }

    chunks.push(`<p>${renderInlineMarkdown(rawLine)}</p>`);
  }

  flushList();

  return codeBlocks.reduce(
    (acc, block, index) => acc.replace(`@@CODE_${index}@@`, block),
    chunks.join("")
  );
}

function syncComposerMetrics() {
  const composerHeight = elements.composer?.offsetHeight ?? 84;
  document.documentElement.style.setProperty("--composer-height", `${Math.round(composerHeight)}px`);
}

function autoGrowComposer() {
  elements.composerInput.style.height = "auto";
  elements.composerInput.style.height = `${Math.min(elements.composerInput.scrollHeight, 180)}px`;
  syncComposerMetrics();
}

function renderInstallBanner() {
  if (state.isStandalone || getStoredValue(INSTALL_DISMISSED_KEY) === "1" || state.screen === "auth") {
    elements.installBanner.classList.add("hidden");
    return;
  }

  const isiOS = IOS_RE.test(window.navigator.userAgent);
  if (state.installAvailable) {
    elements.installCopy.textContent = "Установи Pocket Office как приложение и открывай его с домашнего экрана.";
    elements.installButton.textContent = "Установить";
    elements.installButton.disabled = false;
    elements.installBanner.classList.remove("hidden");
    return;
  }

  if (isiOS) {
    elements.installCopy.textContent = "В Safari нажми Поделиться и выбери «На экран Домой», чтобы это работало как приложение.";
    elements.installButton.textContent = "Понятно";
    elements.installButton.disabled = false;
    elements.installBanner.classList.remove("hidden");
    return;
  }

  elements.installBanner.classList.add("hidden");
}

function renderAuthMeta() {
  const auth = state.auth;
  if (!auth?.enabled || !auth.authenticated || !auth.user) {
    elements.authMeta.classList.add("hidden");
    elements.authMeta.textContent = "";
    elements.logoutButton.classList.add("hidden");
    return;
  }

  const username = auth.user.username ? ` @${auth.user.username}` : "";
  elements.authMeta.textContent = `${auth.user.name}${username}`;
  elements.authMeta.classList.remove("hidden");
  elements.logoutButton.classList.remove("hidden");
}

function renderAuthScreen() {
  const auth = state.auth;
  if (!auth?.enabled || auth.authenticated) {
    elements.authCodeGroup.classList.add("hidden");
    elements.loginButton.textContent = "Войти через Telegram";
    return;
  }

  elements.authCopy.textContent = auth.hint || "Авторизуйтесь через Telegram.";

  if (auth.provider === "telegram-code") {
    elements.authCodeGroup.classList.remove("hidden");
    elements.loginButton.textContent = "Как получить код";
  } else {
    elements.authCodeGroup.classList.add("hidden");
    elements.loginButton.textContent = "Войти через Telegram";
  }
}

function renderChatList() {
  elements.chatList.innerHTML = "";

  for (const agent of state.bootstrap.agents) {
    const row = elements.chatRowTemplate.content.firstElementChild.cloneNode(true);
    const lastMessage = getLastMessage(agent);
    row.querySelector(".chat-row-avatar").src = agent.avatarUrl;
    row.querySelector(".chat-row-avatar").alt = agent.name;
    row.querySelector("strong").textContent = agent.name;
    row.querySelector("time").textContent = formatTime(lastMessage?.at);
    row.querySelector(".chat-row-role").textContent = agent.role;
    row.querySelector(".chat-row-preview").textContent = lastMessage
      ? `${lastMessage.role === "user" ? "Вы: " : ""}${lastMessage.text.replace(/\s+/g, " ").trim()}`
      : agent.summary;

    row.addEventListener("click", () => {
      window.location.hash = agent.id;
    });

    elements.chatList.append(row);
  }
}

function renderWorkspaceBar(agent) {
  elements.workspaceBar.classList.toggle("hidden", !agent?.requiresWorkspace);
  if (!agent?.requiresWorkspace) {
    return;
  }

  const currentValue = agent.activeWorkspaceKey ?? "";
  const options = ['<option value="">Без workspace</option>']
    .concat(state.bootstrap.workspaces.map((workspace) => {
      const selected = workspace.key === currentValue ? " selected" : "";
      return `<option value="${workspace.key}"${selected}>${workspace.key}</option>`;
    }))
    .join("");
  elements.workspaceSelect.innerHTML = options;
}

function scrollMessagesToBottom() {
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  });
}

function renderMessages(agent) {
  const messages = agent.messages ?? [];
  if (!messages.length) {
    elements.messages.innerHTML = `
      <div class="system-note">${agent.name} на связи. Напишите первое сообщение.</div>
    `;
    return;
  }

  elements.messages.innerHTML = "";
  for (const message of messages) {
    const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role === "assistant" ? "assistant" : "user");
    node.querySelector("header").textContent = message.role === "assistant" ? `${agent.name} · ${agent.role}` : "Вы";
    node.querySelector(".message-body").innerHTML = renderMarkdown(message.text);
    elements.messages.append(node);
  }
  scrollMessagesToBottom();
}

function renderChatScreen() {
  const agent = getActiveAgent();
  if (!agent) {
    return;
  }

  elements.chatHeaderAvatar.src = agent.avatarUrl;
  elements.chatHeaderAvatar.alt = agent.name;
  elements.chatHeaderName.textContent = agent.name;
  elements.chatHeaderRole.textContent = agent.role;
  elements.composerInput.placeholder = `Сообщение для ${agent.name}`;
  renderWorkspaceBar(agent);
  renderMessages(agent);
}

function setScreen(screen) {
  state.screen = screen;
  elements.authScreen.classList.toggle("hidden", screen !== "auth");
  elements.listScreen.classList.toggle("hidden", screen !== "list");
  elements.chatScreen.classList.toggle("hidden", screen !== "chat");
  if (screen === "chat") {
    renderChatScreen();
  }
  if (screen === "auth") {
    renderAuthScreen();
  }
  renderInstallBanner();
}

function syncScreenFromHash() {
  const raw = window.location.hash.replace(/^#/, "").trim();
  if (raw === "list") {
    state.activeAgentId = null;
    setScreen("list");
    return;
  }

  const requestedAgentId = raw || getRememberedActiveAgent();
  const agent = state.bootstrap?.agents.find((item) => item.id === requestedAgentId);
  if (!agent) {
    state.activeAgentId = null;
    clearRememberedActiveAgent();
    setScreen("list");
    return;
  }

  state.activeAgentId = agent.id;
  rememberActiveAgent(agent.id);
  if (!raw) {
    window.history.replaceState(null, "", `#${agent.id}`);
  }
  setScreen("chat");
}

function renderStack(container, items, renderItem) {
  if (!items.length) {
    container.innerHTML = '<div class="stack-item"><strong>Пока пусто</strong></div>';
    return;
  }

  container.innerHTML = items.map(renderItem).join("");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    state.auth = {
      enabled: true,
      authenticated: false
    };
    renderAuthMeta();
    setScreen("auth");
    throw new Error("Нужна повторная авторизация через Telegram.");
  }
  return response;
}

async function fetchAuthStatus() {
  const response = await fetch("/api/auth/status", {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error("Не удалось определить статус авторизации.");
  }
  state.auth = await response.json();
  renderAuthMeta();
  return state.auth;
}

async function fetchAgentDetail(agentId) {
  const response = await fetchJson(
    `/api/agent?clientId=${encodeURIComponent(getResolvedClientId())}&agentId=${encodeURIComponent(agentId)}`,
    {
      headers: { accept: "application/json" }
    }
  );
  if (!response.ok) {
    throw new Error("Не удалось загрузить профиль агента.");
  }
  const detail = await response.json();
  state.detailByAgent[agentId] = detail;
  return detail;
}

function openDetailSheet() {
  elements.detailSection.classList.remove("hidden");
  elements.detailSection.setAttribute("aria-hidden", "false");
}

function closeDetailSheet() {
  elements.detailSection.classList.add("hidden");
  elements.detailSection.setAttribute("aria-hidden", "true");
  state.pendingAvatarDataUrl = undefined;
}

function renderDetail(detail) {
  elements.detailTitle.textContent = `${detail.name} — ${detail.role}`;
  elements.detailAvatar.src = state.pendingAvatarDataUrl || detail.avatarUrl;
  elements.detailAvatar.alt = detail.name;
  elements.detailNameInput.value = detail.name;
  elements.detailSummary.textContent = detail.summary;
  elements.detailMission.textContent = detail.mission;

  renderStack(
    elements.detailSkills,
    detail.skills,
    (skill) => `
      <div class="stack-item">
        <strong>${escapeHtml(skill.name)}</strong>
        ${skill.note ? `<div class="stack-item-subtle">${escapeHtml(skill.note)}</div>` : ""}
        ${skill.path ? `<code>${escapeHtml(skill.path)}</code>` : ""}
      </div>
    `
  );

  renderStack(
    elements.detailMemories,
    detail.agentMemories,
    (memory) => `
      <div class="stack-item">
        <strong>${escapeHtml(memory.category)}</strong>
        <div>${escapeHtml(memory.text)}</div>
      </div>
    `
  );

  renderStack(
    elements.detailSessionMemories,
    detail.sessionMemories,
    (memory) => `
      <div class="stack-item">
        <strong>${escapeHtml(memory.category)}</strong>
        <div>${escapeHtml(memory.text)}</div>
      </div>
    `
  );

  renderStack(
    elements.detailFolders,
    detail.folders,
    (folder) => `
      <div class="stack-item">
        <strong>${escapeHtml(folder.split("/").at(-1) || folder)}</strong>
        <code>${escapeHtml(folder)}</code>
      </div>
    `
  );

  renderStack(
    elements.detailContextFiles,
    detail.contextFiles,
    (file) => `
      <div class="stack-item">
        <strong>${escapeHtml(file.split("/").at(-1) || file)}</strong>
        <code>${escapeHtml(file)}</code>
      </div>
    `
  );
}

async function openAgentDetails() {
  const agent = getActiveAgent();
  if (!agent) {
    return;
  }

  const detail = await fetchAgentDetail(agent.id);
  state.pendingAvatarDataUrl = undefined;
  renderDetail(detail);
  openDetailSheet();
}

async function saveAgentProfile() {
  const agent = getActiveAgent();
  if (!agent) {
    return;
  }

  const response = await fetchJson("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: agent.id,
      name: elements.detailNameInput.value,
      avatarDataUrl: state.pendingAvatarDataUrl
    })
  });

  if (!response.ok) {
    throw new Error("Не удалось сохранить профиль агента.");
  }

  await bootstrap();
  const updatedDetail = await fetchAgentDetail(agent.id);
  renderDetail(updatedDetail);
  renderChatScreen();
  renderChatList();
  state.pendingAvatarDataUrl = undefined;
}

function startTelegramAuth() {
  if (state.auth?.provider === "telegram-code") {
    elements.authCodeInput?.focus();
    alert("Напишите боту в Telegram: «дай код для входа в веб», затем введите код здесь.");
    return;
  }

  const url = new URL("/auth/telegram/start", window.location.origin);
  url.searchParams.set("clientId", getClientId());
  url.searchParams.set("returnHash", window.location.hash || `#${getRememberedActiveAgent() || "list"}`);
  window.location.assign(url.toString());
}

async function loginWithTelegramCode() {
  const code = elements.authCodeInput.value.trim().toUpperCase();
  if (!code) {
    elements.authCodeInput.focus();
    throw new Error("Введите код из Telegram.");
  }

  const response = await fetch("/api/auth/telegram-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      clientId: getClientId()
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Не удалось войти по коду.");
  }

  elements.authCodeInput.value = "";
  await bootstrap();
}

async function logout() {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error("Не удалось завершить сессию.");
  }

  state.auth = {
    enabled: true,
    authenticated: false
  };
  renderAuthMeta();
  setScreen("auth");
}

async function bootstrap() {
  await fetchAuthStatus();

  if (state.auth?.enabled && !state.auth.authenticated) {
    setScreen("auth");
    return;
  }

  const response = await fetchJson(`/api/bootstrap?clientId=${encodeURIComponent(getResolvedClientId())}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error("Не удалось загрузить Pocket Office.");
  }

  state.bootstrap = await response.json();
  renderChatList();
  renderAuthMeta();
  syncScreenFromHash();
}

async function sendMessage(text) {
  const agent = getActiveAgent();
  if (!agent || !text.trim()) {
    return;
  }

  agent.messages.push({
    role: "user",
    text: text.trim(),
    at: new Date().toISOString()
  });
  agent.messages.push({
    role: "assistant",
    text: "Думаю…",
    at: new Date().toISOString()
  });
  renderMessages(agent);
  renderChatList();

  const response = await fetchJson("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: getResolvedClientId(),
      agentId: agent.id,
      text
    })
  });

  if (!response.ok) {
    throw new Error("Агент не ответил.");
  }

  const payload = await response.json();
  agent.messages = payload.messages;
  agent.activeWorkspaceKey = payload.activeWorkspaceKey;
  renderChatScreen();
  renderChatList();
}

async function updateWorkspace(workspaceKey) {
  const agent = getActiveAgent();
  if (!agent) {
    return;
  }

  const response = await fetchJson("/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: getResolvedClientId(),
      agentId: agent.id,
      workspaceKey
    })
  });

  if (!response.ok) {
    throw new Error("Не удалось обновить workspace.");
  }

  const payload = await response.json();
  agent.activeWorkspaceKey = payload.activeWorkspaceKey;
  renderWorkspaceBar(agent);
}

async function fileToDataUrl(file) {
  const original = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.readAsDataURL(file);
  });

  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось открыть изображение."));
    img.src = original;
  });

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const side = Math.min(image.width, image.height);
  const sx = (image.width - side) / 2;
  const sy = (image.height - side) / 2;
  context.drawImage(image, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/png", 0.92);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }
}

function syncViewportHeight() {
  const layoutHeight = window.innerHeight;
  const viewport = window.visualViewport;
  const visibleHeight = viewport?.height ?? layoutHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  const effectiveHeight = Math.round(visibleHeight + offsetTop);
  const keyboardOpen = layoutHeight - visibleHeight > 120;

  document.documentElement.style.setProperty("--app-height", `${effectiveHeight}px`);
  document.body.classList.toggle("keyboard-open", keyboardOpen);

  if (keyboardOpen) {
    setTimeout(() => {
      window.scrollTo(0, 0);
      scrollMessagesToBottom();
    }, 0);
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.pendingPrompt = event;
  state.installAvailable = true;
  renderInstallBanner();
});

window.addEventListener("resize", syncViewportHeight);
window.addEventListener("orientationchange", syncViewportHeight);
window.addEventListener("pageshow", syncViewportHeight);
window.visualViewport?.addEventListener("resize", syncViewportHeight);

window.addEventListener("hashchange", () => {
  if (!state.bootstrap || state.screen === "auth") {
    return;
  }
  syncScreenFromHash();
});

elements.loginButton.addEventListener("click", startTelegramAuth);

elements.authCodeSubmit.addEventListener("click", () => {
  void loginWithTelegramCode().catch((error) => {
    alert(error instanceof Error ? error.message : "Не удалось войти.");
  });
});

elements.authCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void loginWithTelegramCode().catch((error) => {
      alert(error instanceof Error ? error.message : "Не удалось войти.");
    });
  }
});

elements.logoutButton.addEventListener("click", () => {
  void logout().catch((error) => {
    alert(error instanceof Error ? error.message : "Не удалось выйти.");
  });
});

elements.refreshButton.addEventListener("click", () => {
  void bootstrap();
});

elements.backButton.addEventListener("click", () => {
  window.location.hash = "list";
});

elements.profileTrigger.addEventListener("click", () => {
  void openAgentDetails();
});

elements.closeDetailButton.addEventListener("click", closeDetailSheet);

elements.sheetBackdrop.addEventListener("click", closeDetailSheet);

elements.installButton.addEventListener("click", async () => {
  if (state.pendingPrompt) {
    state.pendingPrompt.prompt();
    await state.pendingPrompt.userChoice;
    state.pendingPrompt = null;
    state.installAvailable = false;
    renderInstallBanner();
    return;
  }

  setStoredValue(INSTALL_DISMISSED_KEY, "1");
  renderInstallBanner();
});

elements.dismissInstallButton.addEventListener("click", () => {
  setStoredValue(INSTALL_DISMISSED_KEY, "1");
  renderInstallBanner();
});

elements.workspaceSelect.addEventListener("change", (event) => {
  void updateWorkspace(event.target.value || null);
});

elements.avatarInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  state.pendingAvatarDataUrl = await fileToDataUrl(file);
  elements.detailAvatar.src = state.pendingAvatarDataUrl;
});

elements.resetAvatarButton.addEventListener("click", async () => {
  state.pendingAvatarDataUrl = null;
  if (state.activeAgentId) {
    elements.detailAvatar.src = `/avatars/${state.activeAgentId}.svg`;
  }
});

elements.saveProfileButton.addEventListener("click", async () => {
  try {
    await saveAgentProfile();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Не удалось сохранить профиль.");
  }
});

elements.composerInput.addEventListener("input", autoGrowComposer);
elements.composerInput.addEventListener("focus", () => {
  setTimeout(() => {
    syncViewportHeight();
    syncComposerMetrics();
    scrollMessagesToBottom();
  }, 80);
});
elements.composerInput.addEventListener("blur", () => {
  setTimeout(() => {
    syncViewportHeight();
    syncComposerMetrics();
  }, 80);
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.composerInput.value.trim();
  if (!text) {
    return;
  }

  elements.composerInput.value = "";
  autoGrowComposer();

  try {
    await sendMessage(text);
  } catch (error) {
    const agent = getActiveAgent();
    if (!agent) {
      return;
    }

    agent.messages = agent.messages.filter((message) => message.text !== "Думаю…");
    agent.messages.push({
      role: "assistant",
      text: error instanceof Error ? error.message : "Что-то пошло не так.",
      at: new Date().toISOString()
    });
    renderChatScreen();
    renderChatList();
  }
});

syncViewportHeight();
void bootstrap().catch((error) => {
  elements.authCopy.textContent = error instanceof Error ? error.message : "Не удалось открыть Pocket Office.";
  setScreen("auth");
});

autoGrowComposer();
syncComposerMetrics();
renderInstallBanner();
registerServiceWorker();
