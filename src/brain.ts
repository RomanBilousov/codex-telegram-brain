import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./app-server.js";
import {
  ALL_AGENT_IDS,
  getAgentCard,
  getAgentDisplayLabel,
  getAgentName,
  parseAgentId,
  renderAgentCard,
  renderAgentList,
  setAgentProfileOverrides
} from "./agents.js";
import { config } from "./config.js";
import { CodexRunner } from "./codex.js";
import { buildMarketingKnowledgeSnapshot } from "./knowledge.js";
import { AudioProcessor } from "./audio.js";
import { VideoProcessor } from "./media.js";
import {
  describeMemories,
  extractAgentLearningCandidates,
  extractCompanyMemoryCandidates,
  extractMemoryCandidates,
  forgetMemory,
  looksLikeDelegationCandidate,
  mergeMemories,
  renderMemoryContext,
  upsertMemories
} from "./memory.js";
import { BrainStorage } from "./storage.js";
import { AudioTranscriber } from "./transcription.js";
import type {
  AgentKind,
  AudioRequest,
  BrainReply,
  ChatSession,
  RouterDecision,
  StatusCallback,
  ThreadProfile,
  ThreadTarget,
  VideoRequest,
  WorkspaceSpec
} from "./types.js";

const HELP_TEXT = [
  "Команды:",
  "/office - обзор супербота и команды",
  "/team или /agents - список специалистов",
  "/who - кто отвечает в этом чате сейчас",
  "/threads - список известных threads/topics этого чата",
  "/thread - информация о текущем thread/topic",
  "/workspaces - доступные рабочие пространства",
  "/workspace <alias> - выбрать workspace",
  "/workspace none - снять workspace",
  "/agent - текущий агент для этого чата или топика",
  "/agent <id> - закрепить агента за этим чатом или топиком",
  "/agent none - снять закрепление и вернуть оркестратор",
  "/delegate <agent> <задача> - явная передача задачи специалисту",
  "/status - состояние чата",
  "/memory [agent] - что я запомнил",
  "/forget <id или текст> - удалить факт из памяти",
  "/forget-all - очистить долговременную память",
  "/reset - сбросить историю",
  "",
  "Обычные сообщения идут в Orchestrator супербота, а он при необходимости подключает специалистов.",
  "Ручной выбор: @general, @marketing, @planner, @coder, @reviewer.",
  "Можно отправлять voice, audio и видео. Подпись к файлу используется как задача, если она есть."
].join("\n");

export class Brain {
  private readonly projectRoot = fileURLToPath(new URL("../", import.meta.url));
  private readonly routerSchemaPath = fileURLToPath(new URL("../schemas/router.schema.json", import.meta.url));
  private readonly appServer = new CodexAppServerClient(config.codexBin, this.projectRoot);
  private readonly runner = new CodexRunner();
  private readonly audioProcessor = new AudioProcessor();
  private readonly videoProcessor = new VideoProcessor();
  private readonly transcriber = new AudioTranscriber(
    config.openaiApiKey,
    config.transcriptionModel,
    config.openaiOrgId,
    config.openaiProjectId
  );
  readonly storage = new BrainStorage(config.stateDir);

  async init(): Promise<void> {
    await this.storage.init();
    setAgentProfileOverrides(await this.storage.getAgentProfiles());
    await this.appServer.init();
  }

  async close(): Promise<void> {
    await this.appServer.close();
  }

  async registerThread(target: ThreadTarget, message?: Record<string, unknown>): Promise<void> {
    const session = await this.storage.getSession(target.sessionId);
    const existingProfile = await this.storage.getThreadProfile(target.sessionId);
    const extractedTitle = this.extractThreadTitle(message);
    const title = extractedTitle || existingProfile?.title || (session.assignedAgent ? getAgentCard(session.assignedAgent).title : undefined);
    const profile: ThreadProfile = {
      sessionId: target.sessionId,
      chatId: target.chatId,
      label: target.label,
      source: target.directMessagesTopicId !== undefined ? "dm_topic" : target.messageThreadId !== undefined ? "topic" : "chat",
      messageThreadId: target.messageThreadId,
      directMessagesTopicId: target.directMessagesTopicId,
      title,
      updatedAt: new Date().toISOString()
    };

    await this.storage.saveThreadProfile(profile);

    const inferredAgent = this.inferAgentFromThreadTitle(title);
    if (inferredAgent) {
      if (!session.assignedAgent) {
        await this.storage.saveSession({
          ...session,
          assignedAgent: inferredAgent
        });
      }
    }
  }

  async getThreadOnboarding(sessionId: string): Promise<string | undefined> {
    const session = await this.storage.getSession(sessionId);
    if (session.history.length > 0) {
      return undefined;
    }

    const threadProfile = await this.storage.getThreadProfile(sessionId);
    return this.buildThreadOnboarding(session.assignedAgent, threadProfile?.title);
  }

  async handleWebText(clientId: string, agent: AgentKind, text: string, onStatus?: StatusCallback): Promise<BrainReply> {
    const sessionId = agent === "general" ? `web:${clientId}` : `web:${clientId}:agent:${agent}`;
    const session = await this.storage.getSession(sessionId);

    if (session.assignedAgent !== agent) {
      await this.storage.saveSession({
        ...session,
        chatId: sessionId,
        assignedAgent: agent
      });
    }

    return this.handleText(sessionId, text, onStatus);
  }

  async setWebWorkspace(clientId: string, agent: AgentKind, workspaceKey?: string): Promise<void> {
    const sessionId = agent === "general" ? `web:${clientId}` : `web:${clientId}:agent:${agent}`;
    const session = await this.storage.getSession(sessionId);
    await this.storage.saveSession({
      ...session,
      chatId: sessionId,
      assignedAgent: agent,
      activeWorkspaceKey: workspaceKey
    });
  }

  async handleText(chatId: string, text: string, onStatus?: StatusCallback): Promise<BrainReply> {
    const trimmed = text.trim();
    const session = await this.storage.getSession(chatId);
    const companyMemories = await this.storage.getCompanyMemories();
    const threadProfile = await this.storage.getThreadProfile(chatId);
    const explicitAgent = this.extractExplicitAgent(trimmed);

    if (!trimmed) {
      return { text: "Пустое сообщение." };
    }

    if (trimmed === "/start" || trimmed === "/help") {
      return { text: HELP_TEXT };
    }

    if (trimmed === "/office") {
      return {
        text: this.describeOffice(session, companyMemories)
      };
    }

    if (trimmed === "/team" || trimmed === "/agents") {
      return {
        text: this.describeTeam()
      };
    }

    if (trimmed === "/workspaces") {
      return {
        text: this.describeWorkspaces(session)
      };
    }

    if (trimmed.startsWith("/workspace")) {
      return this.setWorkspace(session, trimmed);
    }

    if (trimmed.startsWith("/agent")) {
      return this.setAgent(session, trimmed);
    }

    if (trimmed === "/who") {
      return {
        text: this.describeWho(session)
      };
    }

    if (trimmed === "/threads") {
      return {
        text: await this.describeThreads(session)
      };
    }

    if (trimmed === "/thread") {
      return {
        text: this.describeCurrentThread(session)
      };
    }

    if (trimmed.startsWith("/delegate")) {
      return this.delegate(session, trimmed, companyMemories, onStatus);
    }

    if (trimmed === "/status") {
      return {
        text: this.describeStatus(session, companyMemories)
      };
    }

    if (trimmed.startsWith("/memory")) {
      return {
        text: await this.describeMemory(session, companyMemories, trimmed)
      };
    }

    if (trimmed.startsWith("/forget-all")) {
      const nextSession = { ...session, memories: [] };
      await this.storage.saveSession(nextSession);
      await this.storage.saveCompanyMemories([]);
      await this.storage.clearAgentMemories();
      return { text: "Память супербота очищена: по этому чату, по компании и по обучению агентов." };
    }

    if (trimmed.startsWith("/forget")) {
      const query = trimmed.replace("/forget", "").trim();
      if (!query) {
        return { text: "После /forget укажите id или часть текста из памяти." };
      }

      const nextMemories = forgetMemory(session.memories, query);
      const nextCompanyMemories = forgetMemory(companyMemories, query);
      let removedFromAgents = 0;
      for (const agent of ALL_AGENT_IDS) {
        const currentAgentMemories = await this.storage.getAgentMemories(agent);
        const nextAgentMemories = forgetMemory(currentAgentMemories, query);
        if (nextAgentMemories.length !== currentAgentMemories.length) {
          removedFromAgents += currentAgentMemories.length - nextAgentMemories.length;
          await this.storage.saveAgentMemories(agent, nextAgentMemories);
        }
      }

      if (
        nextMemories.length === session.memories.length &&
        nextCompanyMemories.length === companyMemories.length &&
        removedFromAgents === 0
      ) {
        return { text: "Ничего не нашел для удаления." };
      }

      await this.storage.saveSession({ ...session, memories: nextMemories });
      await this.storage.saveCompanyMemories(nextCompanyMemories);
      return { text: "Факт удален из памяти супербота и обучения агентов." };
    }

    if (trimmed === "/reset") {
      await this.storage.resetSession(chatId);
      return { text: "История чата сброшена." };
    }

    const naturalIntent = this.parseNaturalIntent(trimmed, session.assignedAgent);
    if (naturalIntent?.kind === "who") {
      return {
        text: this.describeWho(session)
      };
    }

    if (naturalIntent?.kind === "show_memory") {
      const memoryCommand = naturalIntent.agent ? `/memory ${naturalIntent.agent}` : "/memory";
      return {
        text: await this.describeMemory(session, companyMemories, memoryCommand)
      };
    }

    if (naturalIntent?.kind === "forget_all") {
      const nextSession = { ...session, memories: [] };
      await this.storage.saveSession(nextSession);
      await this.storage.saveCompanyMemories([]);
      await this.storage.clearAgentMemories();
      return { text: "Ок, очистил память супербота и обучение агентов." };
    }

    if (naturalIntent?.kind === "forget") {
      return this.forgetEverywhere(session, companyMemories, naturalIntent.query);
    }

    if (naturalIntent?.kind === "learn") {
      const targetAgent = naturalIntent.agent ?? session.assignedAgent ?? "general";
      const reply: BrainReply = {
        agent: targetAgent,
        text: this.buildLearningAcknowledgement(targetAgent, naturalIntent.text)
      };
      await this.commitTurn(session, naturalIntent.text, reply, {
        agentMemoryTarget: targetAgent,
        skipCompanyMemory: targetAgent !== "general"
      });
      return reply;
    }

    if (this.isThreadBootstrapMessage(session, threadProfile?.title, trimmed)) {
      return {
        text: this.buildThreadOnboarding(session.assignedAgent, threadProfile?.title)
      };
    }

    if (explicitAgent) {
      if (!explicitAgent.text) {
        return {
          text: `После @${explicitAgent.agent} нужен текст запроса.`
        };
      }

      if (this.isStandaloneLearningInstruction(explicitAgent.text)) {
        const reply: BrainReply = {
          agent: explicitAgent.agent,
          text: this.buildLearningAcknowledgement(explicitAgent.agent, explicitAgent.text)
        };
        await this.commitTurn(session, explicitAgent.text, reply, {
          agentMemoryTarget: explicitAgent.agent,
          skipCompanyMemory: true
        });
        return reply;
      }

      const workspace =
        explicitAgent.agent === "coder"
          ? this.pickWorkspace(session, {
              agent: "coder",
              reason: "manual selection",
              needsWorkspace: true
            })
          : undefined;

      if (explicitAgent.agent === "coder" && !workspace) {
        return {
          text: [
            "Для @coder нужен активный workspace.",
            "Откройте `/workspaces`, затем выберите `/workspace <alias>`."
          ].join("\n")
        };
      }

      await onStatus?.(this.statusForAgent(explicitAgent.agent));

      if (explicitAgent.agent === "general") {
        const result = await this.appServer.sendGeneralMessage({
          text: await this.buildGeneralInput(session, companyMemories, explicitAgent.text),
          threadId: session.generalThreadId,
          model: config.defaultModel,
          effort: config.generalChatEffort
        });

        const reply: BrainReply = {
          agent: "general",
          text: result.text
        };

        await this.commitTurn(session, explicitAgent.text, reply, {
          agentMemoryTarget: "general",
          generalThreadId: result.threadId
        });

        return reply;
      }

      const reply = await this.runAgent(explicitAgent.agent, explicitAgent.text, session, companyMemories, workspace);
      await this.commitTurn(session, explicitAgent.text, reply, {
        agentMemoryTarget: explicitAgent.agent
      });

      return reply;
    }

    if (session.assignedAgent === "general") {
      await onStatus?.(this.statusForAgent("general"));

      const result = await this.appServer.sendGeneralMessage({
        text: await this.buildGeneralInput(session, companyMemories, trimmed),
        threadId: session.generalThreadId,
        model: config.defaultModel,
        effort: config.generalChatEffort
      });

      const reply: BrainReply = {
        agent: "general",
        text: result.text
      };

      await this.commitTurn(session, trimmed, reply, {
        agentMemoryTarget: "general",
        generalThreadId: result.threadId
      });

      return reply;
    }

    if (session.assignedAgent) {
      const workspace =
        session.assignedAgent === "coder"
          ? this.pickWorkspace(session, {
              agent: "coder",
              reason: "topic binding",
              needsWorkspace: true
            })
          : undefined;

      if (session.assignedAgent === "coder" && !workspace) {
        return {
          text: [
            "Для закрепленного агента coder нужен активный workspace.",
            "Откройте `/workspaces`, затем выберите `/workspace <alias>`."
          ].join("\n")
        };
      }

      await onStatus?.(this.statusForAgent(session.assignedAgent));
      const reply = await this.runAgent(session.assignedAgent, trimmed, session, companyMemories, workspace);
      await this.commitTurn(session, trimmed, reply, {
        agentMemoryTarget: session.assignedAgent
      });
      return reply;
    }

    if (this.shouldUseFastGeneralPath(trimmed, session)) {
      await onStatus?.(this.statusForAgent("general"));

      const result = await this.appServer.sendGeneralMessage({
        text: await this.buildGeneralInput(session, companyMemories, trimmed),
        threadId: session.generalThreadId,
        model: config.defaultModel,
        effort: config.generalChatEffort
      });

      const reply: BrainReply = {
        agent: "general",
        text: result.text
      };

      await this.commitTurn(session, trimmed, reply, {
        agentMemoryTarget: "general",
        generalThreadId: result.threadId
      });

      return reply;
    }

    await onStatus?.("Выбираю агента...");
    const routing = await this.route(trimmed, session, companyMemories);
    const workspace = this.pickWorkspace(session, routing);
    if (routing.needsWorkspace && !workspace) {
      return {
        text: [
          "Для этого запроса нужен активный workspace.",
          "Откройте `/workspaces`, затем выберите `/workspace <alias>`."
        ].join("\n")
      };
    }

    await onStatus?.(this.statusForAgent(routing.agent));
    const reply = await this.runAgent(routing.agent, trimmed, session, companyMemories, workspace);
    await this.commitTurn(session, trimmed, reply, {
      agentMemoryTarget: routing.agent
    });

    return reply;
  }

  async handleAudio(chatId: string, request: AudioRequest, onStatus?: StatusCallback): Promise<BrainReply> {
    const session = await this.storage.getSession(chatId);
    const prepared = await this.audioProcessor.prepareFromTelegram(request.fileUrl, request.fileName);

    try {
      await onStatus?.(request.source === "voice" ? "Расшифровываю голосовое..." : "Расшифровываю аудио...");
      const transcription = await this.transcriber.transcribe(prepared.audioPath);
      const transcript = transcription.text?.trim();

      if (!transcript) {
        return {
          agent: session.assignedAgent ?? "general",
          text:
            request.source === "voice"
              ? `Не смог распознать голосовое${transcription.error ? `: ${transcription.error}` : "."}`
              : `Не смог распознать аудио${transcription.error ? `: ${transcription.error}` : "."}`
        };
      }

      const userText = request.caption?.trim()
        ? `${request.caption.trim()}\n\nТранскрипт аудио:\n${transcript}`
        : transcript;

      return this.handleText(chatId, userText, onStatus);
    } finally {
      await this.audioProcessor.cleanup(prepared.workDir);
    }
  }

  async handleVideo(chatId: string, request: VideoRequest, onStatus?: StatusCallback): Promise<BrainReply> {
    const session = await this.storage.getSession(chatId);
    const companyMemories = await this.storage.getCompanyMemories();
    const agentMemories = await this.storage.getAgentMemories("video");
    await onStatus?.(this.statusForAgent("video"));
    const prepared = await this.videoProcessor.prepareFromTelegram(request.fileUrl, request.fileName);

    try {
      if (prepared.audioPath) {
        await onStatus?.("Делаю транскрипцию...");
      }

      const transcription = prepared.audioPath
        ? await this.transcriber.transcribe(prepared.audioPath)
        : { error: "video has no audio track" };

      if (transcription.text) {
        console.info(`Transcription received for ${request.fileName}: ${transcription.text.length} chars`);
      } else {
        console.warn(`Transcription unavailable for ${request.fileName}: ${transcription.error ?? "empty transcript"}`);
      }

      await onStatus?.("Анализирую кадры и собираю ответ...");
      const prompt = this.buildVideoPrompt(
        request,
        session,
        companyMemories,
        agentMemories,
        prepared.metadata,
        transcription.text,
        transcription.error
      );

      const response = await this.runner.runText({
        codexBin: config.codexBin,
        prompt,
        model: config.defaultModel,
        images: prepared.keyframes,
        sandbox: "read-only"
      });

      const reply: BrainReply = {
        agent: "video",
        text: response
      };

      const userText = request.caption?.trim() || transcription.text?.trim() || "[video without caption]";
      await this.commitTurn(session, userText, reply, {
        agentMemoryTarget: "video"
      });

      return reply;
    } finally {
      await this.videoProcessor.cleanup(prepared.workDir);
    }
  }

  private describeWorkspaces(session: ChatSession): string {
    if (config.workspaces.length === 0) {
      return "Workspace-ы не настроены.";
    }

    const lines = ["Доступные workspace-ы:"];
    for (const workspace of config.workspaces) {
      const marker = workspace.key === session.activeWorkspaceKey ? " (active)" : "";
      lines.push(`- ${workspace.key}: ${workspace.path}${marker}`);
    }
    return lines.join("\n");
  }

  private describeOffice(session: ChatSession, companyMemories: ChatSession["memories"]): string {
    const currentAgent = session.assignedAgent ? getAgentDisplayLabel(session.assignedAgent) : "Рэй — оркестратор (auto)";
    return [
      "Superbot Office",
      "Один Telegram-бот, внутри которого живет команда AI-специалистов и thread-aware офис.",
      "",
      `Current chat mode: ${currentAgent}`,
      `Company memory facts: ${companyMemories.length}`,
      `Chat memory facts: ${session.memories.length}`,
      "",
      "Как работать:",
      "- Пишите обычным текстом: отвечает Рэй или подключает нужного специалиста.",
      "- Если у Telegram включены threads/topics, каждый thread живет как отдельное рабочее пространство общения.",
      "- Пишите напрямую: @marketing, @planner, @coder, @reviewer или по именам: Мира, Платон, Коди, Вера.",
      "- Закрепляйте режим: /agent marketing или /agent orchestrator.",
      "- Передавайте задачу явно: /delegate coder <задача>.",
      "",
      this.describeTeam()
    ].join("\n");
  }

  private describeTeam(): string {
    return [
      renderAgentList(),
      "",
      "Прямой доступ:",
      "- Рэй: @general <текст>",
      "- Мира: @marketing <текст>",
      "- Платон: @planner <текст>",
      "- Коди: @coder <текст>",
      "- Вера: @reviewer <текст>"
    ].join("\n");
  }

  private describeWho(session: ChatSession): string {
    return session.assignedAgent
      ? [
          "Этот чат закреплен за агентом.",
          "",
          renderAgentCard(session.assignedAgent)
        ].join("\n")
      : [
          "Этот чат работает в режиме Superbot Orchestrator.",
          "Пишите обычным текстом, а оркестратор сам решит, отвечать самому или передать задачу специалисту.",
          "Для прямого режима используйте `/agent <id>` или `@marketing`, `@coder` и т.д."
        ].join("\n");
  }

  private async describeThreads(session: ChatSession): Promise<string> {
    const chatId = this.parseRootChatId(session.chatId);
    if (chatId === undefined) {
      return "Не смог определить корневой chat id для этого thread.";
    }

    const profiles = await this.storage.listChatThreadProfiles(chatId);
    if (profiles.length === 0) {
      return "У этого чата пока нет зарегистрированных threads/topics.";
    }

    const lines = ["Известные threads/topics:"];
    for (const profile of profiles) {
      const marker = profile.sessionId === session.chatId ? " (current)" : "";
      const title = profile.title ? `, title=${profile.title}` : "";
      const threadSession = await this.storage.getSession(profile.sessionId);
      const assignedAgent = threadSession.assignedAgent ? getAgentDisplayLabel(threadSession.assignedAgent) : undefined;
      const agentLabel = assignedAgent ? `, agent=${assignedAgent}` : "";
      lines.push(`- ${profile.label}${marker} [${profile.source}]${title}${agentLabel}`);
    }

    return lines.join("\n");
  }

  private describeCurrentThread(session: ChatSession): string {
    return [
      `Current session id: ${session.chatId}`,
      `Thread kind: ${this.getThreadKind(session.chatId)}`,
      session.assignedAgent
        ? `Assigned agent: ${getAgentDisplayLabel(session.assignedAgent)}`
        : "Assigned agent: none (Orchestrator auto)"
    ].join("\n");
  }

  private describeStatus(session: ChatSession, companyMemories: ChatSession["memories"]): string {
    const workspace = this.getWorkspaceByKey(session.activeWorkspaceKey);
    const assignedAgent = session.assignedAgent ? getAgentDisplayLabel(session.assignedAgent) : "Рэй — оркестратор (default)";
    return [
      "Mode: Superbot",
      `Chat: ${session.chatId}`,
      `Agent: ${assignedAgent}`,
      `Workspace: ${workspace ? `${workspace.key} -> ${workspace.path}` : "none"}`,
      `History items: ${session.history.length}`,
      `Chat memories: ${session.memories.length}`,
      `Company memories: ${companyMemories.length}`
    ].join("\n");
  }

  private async setAgent(session: ChatSession, text: string): Promise<BrainReply> {
    const raw = text.replace("/agent", "").trim();
    if (!raw) {
      return {
        text: session.assignedAgent
          ? ["Текущий агент для этого чата:", renderAgentCard(session.assignedAgent)].join("\n\n")
          : "Для этого чата агент не закреплен. По умолчанию отвечает Рэй как оркестратор."
      };
    }

    if (raw === "none") {
      await this.storage.saveSession({ ...session, assignedAgent: undefined });
      return { text: "Закрепление агента снято. Этот чат снова идет через Рэя как Superbot Orchestrator." };
    }

    const agent = parseAgentId(raw);
    if (!agent || agent === "video") {
      return { text: "Неизвестный агент. Используйте /agents для списка доступных вариантов." };
    }

    await this.storage.saveSession({ ...session, assignedAgent: agent });
    return {
      text: [
        "Агент закреплен за этим чатом или топиком.",
        "",
        renderAgentCard(agent)
      ].join("\n")
    };
  }

  private async delegate(
    session: ChatSession,
    text: string,
    companyMemories: ChatSession["memories"],
    onStatus?: StatusCallback
  ): Promise<BrainReply> {
    const raw = text.replace("/delegate", "").trim();
    if (!raw) {
      return { text: "Формат: /delegate <agent> <задача>" };
    }

    const [rawAgent, ...taskParts] = raw.split(/\s+/);
    const agent = parseAgentId(rawAgent);
    const task = taskParts.join(" ").trim();

    if (!agent || agent === "video") {
      return { text: "Неизвестный агент. Используйте /team для списка специалистов." };
    }

    if (!task) {
      return { text: "После имени агента нужна задача. Пример: /delegate marketing придумай 3 вектора роста" };
    }

    if (agent === "general") {
      await onStatus?.(this.statusForAgent("general"));
      const result = await this.appServer.sendGeneralMessage({
        text: await this.buildGeneralInput(session, companyMemories, task),
        threadId: session.generalThreadId,
        model: config.defaultModel,
        effort: config.generalChatEffort
      });

      const reply: BrainReply = {
        agent: "general",
        text: result.text
      };

      await this.commitTurn(session, task, reply, {
        agentMemoryTarget: "general",
        generalThreadId: result.threadId
      });

      return reply;
    }

    const workspace =
      agent === "coder"
        ? this.pickWorkspace(session, {
            agent: "coder",
            reason: "manual delegation",
            needsWorkspace: true
          })
        : undefined;

    if (agent === "coder" && !workspace) {
      return {
        text: [
          "Для /delegate coder нужен активный workspace.",
          "Откройте `/workspaces`, затем выберите `/workspace <alias>`."
        ].join("\n")
      };
    }

    await onStatus?.(this.statusForAgent(agent));
    const reply = await this.runAgent(agent, task, session, companyMemories, workspace);
    await this.commitTurn(session, task, reply, {
      agentMemoryTarget: agent
    });
    return reply;
  }

  private async setWorkspace(session: ChatSession, text: string): Promise<BrainReply> {
    const raw = text.replace("/workspace", "").trim();
    if (!raw) {
      return { text: this.describeWorkspaces(session) };
    }

    if (raw === "none") {
      const nextSession = { ...session, activeWorkspaceKey: undefined };
      await this.storage.saveSession(nextSession);
      return { text: "Активный workspace снят." };
    }

    const workspace = this.getWorkspaceByKey(raw);
    if (!workspace) {
      return {
        text: `Не нашел workspace с alias \`${raw}\`.`
      };
    }

    const nextSession = { ...session, activeWorkspaceKey: workspace.key };
    await this.storage.saveSession(nextSession);
    return {
      text: `Активный workspace: ${workspace.key} -> ${workspace.path}`
    };
  }

  private async forgetEverywhere(
    session: ChatSession,
    companyMemories: ChatSession["memories"],
    query: string
  ): Promise<BrainReply> {
    const nextMemories = forgetMemory(session.memories, query);
    const nextCompanyMemories = forgetMemory(companyMemories, query);
    let removedFromAgents = 0;
    for (const agent of ALL_AGENT_IDS) {
      const currentAgentMemories = await this.storage.getAgentMemories(agent);
      const nextAgentMemories = forgetMemory(currentAgentMemories, query);
      if (nextAgentMemories.length !== currentAgentMemories.length) {
        removedFromAgents += currentAgentMemories.length - nextAgentMemories.length;
        await this.storage.saveAgentMemories(agent, nextAgentMemories);
      }
    }

    if (
      nextMemories.length === session.memories.length &&
      nextCompanyMemories.length === companyMemories.length &&
      removedFromAgents === 0
    ) {
      return { text: "Ничего не нашел для удаления." };
    }

    await this.storage.saveSession({ ...session, memories: nextMemories });
    await this.storage.saveCompanyMemories(nextCompanyMemories);
    return { text: "Ок, удалил это из памяти супербота и обучения агентов." };
  }

  private async describeMemory(
    session: ChatSession,
    companyMemories: ChatSession["memories"],
    commandText: string
  ): Promise<string> {
    const requestedAgentRaw = commandText.replace("/memory", "").trim();
    const requestedAgent = requestedAgentRaw ? parseAgentId(requestedAgentRaw) : session.assignedAgent ?? "general";
    if (requestedAgentRaw && !requestedAgent) {
      return "Неизвестный агент для /memory. Используйте /team для списка специалистов.";
    }

    const agentMemories = requestedAgent ? await this.storage.getAgentMemories(requestedAgent) : [];
    return [
      "Память супербота:",
      "",
      "Общая память компании и стиля работы:",
      describeMemories(companyMemories),
      "",
      requestedAgent ? `Обучение агента ${getAgentName(requestedAgent)}:` : "Обучение агента:",
      requestedAgent ? describeMemories(agentMemories) : "Агент не выбран.",
      "",
      "Память этого чата:",
      describeMemories(session.memories)
    ].join("\n");
  }

  private renderMemoryBlocks(
    session: ChatSession,
    companyMemories: ChatSession["memories"],
    agentMemories: ChatSession["memories"] = []
  ): string {
    return [
      `Company memory:\n${renderMemoryContext(companyMemories)}`,
      `Agent memory:\n${renderMemoryContext(agentMemories)}`,
      `Chat memory:\n${renderMemoryContext(session.memories)}`,
      `Combined memory:\n${renderMemoryContext(mergeMemories(companyMemories, agentMemories, session.memories))}`
    ].join("\n\n");
  }

  private async buildGeneralInput(session: ChatSession, companyMemories: ChatSession["memories"], text: string): Promise<string> {
    const agentMemories = await this.storage.getAgentMemories("general");
    return [
      "You are the Superbot Orchestrator inside a local Telegram brain.",
      "Answer in Russian.",
      "You are the main AI office interface for the user.",
      "You have internal specialists: marketing, planner, coder, reviewer, and video.",
      "Use the saved long-term memory when it helps.",
      "Telegram mode: be direct, practical, and short by default.",
      "Lead with the answer, decision, or recommendation in the first sentence.",
      "Do not write consulting-style essays, long questionnaires, or abstract frameworks unless the user explicitly asks for that depth.",
      "If the user says 'choose yourself', choose and state the choice clearly.",
      "If the user asks something conversational, reply naturally.",
      "If the request clearly sounds like specialist work, reply as an orchestrator and the outer brain may also route such tasks to another agent.",
      "Do not pretend to delegate to many agents unless that will materially help. Prefer one owner and one next step.",
      "You are teachable. Respect saved orchestrator preferences and constraints when they improve collaboration.",
      "If a saved user preference conflicts with correctness, safety, or strong specialist judgment, say so briefly and recommend the correct path instead of blindly obeying it.",
      "",
      `Agent card:\n${renderAgentCard("general")}`,
      "",
      this.renderMemoryBlocks(session, companyMemories, agentMemories),
      "",
      `User message:\n${text}`
    ].join("\n");
  }

  private async commitTurn(
    session: ChatSession,
    userText: string,
    reply: BrainReply,
    patch: Partial<ChatSession> & { agentMemoryTarget?: AgentKind; skipCompanyMemory?: boolean } = {}
  ): Promise<void> {
    const { agentMemoryTarget, skipCompanyMemory, ...sessionPatch } = patch;
    let nextSession: ChatSession = {
      ...session,
      ...sessionPatch
    };

    nextSession = this.storage.appendHistory(nextSession, "user", userText);
    nextSession = this.storage.appendHistory(nextSession, "assistant", reply.text);
    const userMemoryCandidates = extractMemoryCandidates(userText);
    nextSession = {
      ...nextSession,
      memories: upsertMemories(nextSession.memories, userMemoryCandidates)
    };
    await this.storage.saveSession(nextSession);

    const companyMemoryCandidates = extractCompanyMemoryCandidates(userText);
    if (!skipCompanyMemory && companyMemoryCandidates.length > 0) {
      const companyMemories = await this.storage.getCompanyMemories();
      await this.storage.saveCompanyMemories(upsertMemories(companyMemories, companyMemoryCandidates));
    }

    if (agentMemoryTarget) {
      const agentLearningCandidates = extractAgentLearningCandidates(userText);
      if (agentLearningCandidates.length > 0) {
        const currentAgentMemories = await this.storage.getAgentMemories(agentMemoryTarget);
        await this.storage.saveAgentMemories(
          agentMemoryTarget,
          upsertMemories(currentAgentMemories, agentLearningCandidates)
        );
      }
    }
  }

  private async route(
    text: string,
    session: ChatSession,
    companyMemories: ChatSession["memories"]
  ): Promise<RouterDecision> {
    const currentWorkspace = this.getWorkspaceByKey(session.activeWorkspaceKey);
    const workspaceList = config.workspaces.map((workspace) => `${workspace.key}: ${workspace.path}`).join("\n");
    const history = this.renderHistory(session);
    const memory = this.renderMemoryBlocks(session, companyMemories);
    const prompt = [
      "You are the Router subagent for a local Telegram-controlled Codex brain.",
      "Choose exactly one agent: general, marketing, planner, coder, reviewer.",
      "Return JSON only.",
      "You are routing inside a single superbot with internal specialist agents.",
      "Use coder for implementation, debugging, repository exploration, shell actions, file edits, integration work.",
      "Use reviewer for explicit reviews, bug hunts, regression/risk finding, test-gap analysis.",
      "Use marketing for growth, positioning, GTM, ICP, offers, messaging, funnel, content, and sales-direction questions.",
      "Use planner for architecture, strategy, decomposition, roadmap, and system design thinking.",
      "Use general for simple factual Q&A, personal assistant help, and general explanation.",
      "Set needsWorkspace=true only if the chosen agent must inspect or modify files.",
      "",
      `Active workspace: ${currentWorkspace ? `${currentWorkspace.key} -> ${currentWorkspace.path}` : "none"}`,
      `Available workspaces:\n${workspaceList || "none"}`,
      "",
      `Long-term memory:\n${memory}`,
      "",
      `Recent history:\n${history}`,
      "",
      `User message:\n${text}`
    ].join("\n");

    return this.runner.runJson<RouterDecision>({
      codexBin: config.codexBin,
      prompt,
      schemaPath: this.routerSchemaPath,
      model: config.defaultModel,
      sandbox: "read-only"
    });
  }

  private async runAgent(
    agent: AgentKind,
    text: string,
    session: ChatSession,
    companyMemories: ChatSession["memories"],
    workspace?: WorkspaceSpec
  ): Promise<BrainReply> {
    const history = this.renderHistory(session);
    const agentMemories = await this.storage.getAgentMemories(agent);
    const memory = this.renderMemoryBlocks(session, companyMemories, agentMemories);
    const workspaceLine = workspace ? `${workspace.key} -> ${workspace.path}` : "none";
    const marketingKnowledge =
      agent === "marketing"
        ? await buildMarketingKnowledgeSnapshot(config.companyKnowledgePaths, config.projectScanPaths)
        : undefined;

    const rolePromptByAgent: Record<AgentKind, string> = {
      general: [
        "You are the Superbot Orchestrator / personal assistant inside a local Telegram brain.",
        "Answer in Russian.",
        "Be concise, practical, and helpful.",
        "Act like the user's AI chief of staff when appropriate.",
        "Do not invent filesystem work if it is not needed."
      ].join("\n"),
      marketing: [
        "You are the Marketing agent inside a local Telegram brain.",
        "Answer in Russian.",
        "Your job is growth, positioning, GTM, funnel thinking, messaging, content direction, and proactive marketing help.",
        "Telegram mode: do not answer like an auditor or a consultant writing a report.",
        "Default format: 1 direct recommendation, 2-4 short supporting points, 1 next step if needed.",
        "Do not dump repository paths, local file links, or internal research notes unless the user explicitly asks for sources.",
        "Synthesize the company and project context into a decision or recommendation instead of listing everything you found.",
        "If the user asks 'на чем фокус', 'что делать', or 'что выбрать', answer decisively.",
        "Be proactive: if critical context is missing, ask at most 1-3 sharp questions instead of pretending you know enough.",
        "Work like a strong marketer embedded in an early AI IT company with sales problems.",
        "Prefer clear next moves, hypotheses, and strategic direction over generic theory.",
        "Use the local marketing skill stack defined in AGENTS.md.",
        "Start from .agents/product-marketing-context.md for foundational context.",
        "Pick the narrowest relevant marketing playbook instead of giving a broad generic answer.",
        "Respect saved marketing preferences and constraints when they improve collaboration."
      ].join("\n"),
      planner: [
        "You are the Planner subagent inside a local Telegram brain.",
        "Answer in Russian.",
        "Focus on architecture, tradeoffs, decomposition, and next steps.",
        "Telegram mode: be concise and operational, not academic.",
        "Do not modify files.",
        "Respect saved planner preferences and constraints when they improve collaboration."
      ].join("\n"),
      coder: [
        "You are the Coder subagent inside a local Telegram brain.",
        "Answer in Russian.",
        "When the request is actionable, implement it instead of only describing it.",
        "Respect the active workspace and do not operate outside it.",
        "At the end, summarize what changed and how you verified it.",
        "Respect saved coder preferences and constraints when they improve collaboration."
      ].join("\n"),
      reviewer: [
        "You are the Reviewer subagent inside a local Telegram brain.",
        "Answer in Russian.",
        "Use a code-review mindset: findings first, then assumptions, then a short summary.",
        "Telegram mode: keep findings crisp and easy to scan.",
        "If no findings exist, say that explicitly.",
        "Respect saved reviewer preferences and constraints when they improve collaboration."
      ].join("\n"),
      video: [
        "You are the Video subagent inside a local Telegram brain.",
        "Answer in Russian.",
        "Analyze the provided keyframes, metadata, and transcript.",
        "State clearly when transcript is missing or partial.",
        "Prefer practical output: summary, key points, visible details, and useful next actions.",
        "Respect saved video preferences and constraints when they improve collaboration."
      ].join("\n")
    };

    const prompt = [
      rolePromptByAgent[agent],
      "You are teachable. Treat saved agent memory as learned preferences, constraints, and working style for this specialist.",
      "If a saved user preference conflicts with correctness, safety, or strong specialist judgment, do not blindly comply. Briefly explain why and recommend the correct path.",
      "",
      `Agent card:\n${renderAgentCard(agent)}`,
      "",
      `Active workspace: ${workspaceLine}`,
      "",
      marketingKnowledge ? `Live company and project knowledge:\n${marketingKnowledge}` : "",
      memory,
      "",
      `Recent history:\n${history}`,
      "",
      `User request:\n${text}`
    ].join("\n");

    const response = await this.runner.runText({
      codexBin: config.codexBin,
      prompt,
      cwd: workspace?.path,
      model: config.defaultModel,
      sandbox: agent === "coder" ? "workspace-write" : "read-only"
    });

    return {
      agent,
      text: response
    };
  }

  private renderHistory(session: ChatSession): string {
    if (session.history.length === 0) {
      return "No previous messages.";
    }

    return session.history
      .slice(-8)
      .map((item) => `${item.role}: ${item.text}`)
      .join("\n");
  }

  private pickWorkspace(session: ChatSession, routing: RouterDecision): WorkspaceSpec | undefined {
    if (!routing.needsWorkspace) {
      return undefined;
    }

    if (session.activeWorkspaceKey) {
      return this.getWorkspaceByKey(session.activeWorkspaceKey);
    }

    if (config.workspaces.length === 1) {
      return config.workspaces[0];
    }

    return undefined;
  }

  private getWorkspaceByKey(key?: string): WorkspaceSpec | undefined {
    if (!key) {
      return undefined;
    }
    return config.workspaces.find((workspace) => workspace.key === key);
  }

  private buildVideoPrompt(
    request: VideoRequest,
    session: ChatSession,
    companyMemories: ChatSession["memories"],
    agentMemories: ChatSession["memories"],
    metadata: {
      durationSeconds: number;
      width?: number;
      height?: number;
      sizeBytes: number;
      videoCodec?: string;
      audioCodec?: string;
      fps?: number;
    },
    transcript?: string,
    transcriptError?: string
  ): string {
    const squareishVideo =
      metadata.width !== undefined &&
      metadata.height !== undefined &&
      Math.abs(metadata.width - metadata.height) <= Math.max(metadata.width, metadata.height) * 0.2;
    const shortCasualVideo = !request.caption?.trim() && metadata.durationSeconds <= 20 && squareishVideo;
    const explicitAnalysisRequest = Boolean(request.caption?.trim());
    const userGoal = explicitAnalysisRequest
      ? request.caption!.trim()
      : shortCasualVideo
        ? "Это короткий разговорный кружок. Воспринимай transcript как живое сообщение пользователя тебе. Если в речи есть просьба или вопрос, ответь на него напрямую и по-человечески, используя transcript и то, что видно на кадрах."
        : "Ответь по сути видео кратко и естественно, без формального отчета.";
    const transcriptStatus = transcript
      ? "transcript available"
      : `transcript unavailable (${transcriptError ?? "unknown reason"})`;
    const behaviorRules = shortCasualVideo
      ? [
          "Main rule: do not write a report.",
          "Treat the transcript as the user's spoken request to you.",
          "If the person asks something like 'посмотри где я', 'что ты видишь', 'какое у меня состояние', answer that request directly first.",
          "Use what is visible in the frames only to support the direct answer.",
          "Prefer 1-3 short natural sentences in Russian.",
          "Do not use bullet points unless the user explicitly asked for a list.",
          "Do not mention metadata, codecs, duration, character counts, or technical details.",
          "Do not mention transcript status unless it actually blocks the answer.",
          "If the speech was not recognized well enough, say it simply and humanly, for example: 'Не до конца разобрал речь, повтори коротко'. Do not expose raw API errors.",
          "Do not suggest posts, reels, hooks, CTA, content ideas, or next steps unless the user directly asked for that.",
          "Examples:",
          "- If transcript means 'посмотри где я', answer like 'Ты на кухне, на фоне девушка что-то делает.'",
          "- If transcript means 'что ты видишь', answer like 'Вижу, что ты на кухне и говоришь в камеру, сзади девушка занята своими делами.'",
          "- If transcript means 'какое состояние', answer carefully from visible cues only, without medical diagnosis."
        ]
      : [
          "Be concise and practical.",
          "Answer in natural Russian prose, not as a formal report.",
          "If the transcript contains a direct question or instruction, answer it directly first.",
          "Only mention transcription failure if it prevents you from answering the request.",
          "Do not suggest posts, reels, hooks, CTA, or repurposing unless the user explicitly asks for that."
        ];
    const outputMode = shortCasualVideo
      ? [
          "Output format:",
          "- A short direct reply in plain prose.",
          "- Usually 1 short paragraph or 1-3 short sentences.",
          "- No bullets by default."
        ]
      : [
          "Output format:",
          "- Short plain-prose answer in Russian.",
          "- No report structure unless the user explicitly asked for analysis."
        ];

    return [
      "You are the Video subagent inside a local Telegram brain.",
      "Answer in Russian.",
      "The attached images are keyframes extracted from the video.",
      "Use only the provided transcript if it exists. Do not fabricate spoken content.",
      "You are teachable. Respect saved video preferences and constraints when they improve collaboration.",
      "If a saved user preference conflicts with correctness, safety, or strong specialist judgment, briefly explain why and recommend the correct path.",
      "",
      `User goal:\n${userGoal}`,
      "",
      `Video metadata: duration=${metadata.durationSeconds.toFixed(2)}s; resolution=${metadata.width ?? "?"}x${metadata.height ?? "?"}; sizeBytes=${metadata.sizeBytes}; videoCodec=${metadata.videoCodec ?? "unknown"}; audioCodec=${metadata.audioCodec ?? "unknown"}; fps=${metadata.fps?.toFixed(2) ?? "unknown"}`,
      "",
      this.renderMemoryBlocks(session, companyMemories, agentMemories),
      "",
      `Recent history:\n${this.renderHistory(session)}`,
      "",
      `Transcript status for internal use: ${transcriptStatus}`,
      "",
      `Transcript:\n${transcript ?? "No transcript available."}`,
      "",
      ...behaviorRules,
      "",
      ...outputMode
    ].join("\n");
  }

  private shouldUseFastGeneralPath(text: string, session: ChatSession): boolean {
    if (session.activeWorkspaceKey) {
      return false;
    }

    if (text.startsWith("@")) {
      return false;
    }

    if (looksLikeDelegationCandidate(text)) {
      return false;
    }

    return true;
  }

  private extractExplicitAgent(
    text: string
  ): { agent: "general" | "marketing" | "planner" | "coder" | "reviewer"; text: string } | undefined {
    const trimmed = text.trim();
    const match = trimmed.match(/^@?([^,:;\s-]+)[,:;\s-]*(.*)$/is);
    if (!match) {
      return undefined;
    }

    const agent = parseAgentId(match[1]);
    if (!agent || agent === "video") {
      return undefined;
    }

    return {
      agent,
      text: match[2]?.trim() ?? ""
    };
  }

  private parseNaturalIntent(
    text: string,
    currentAgent?: AgentKind
  ):
    | { kind: "show_memory"; agent?: AgentKind }
    | { kind: "forget"; query: string }
    | { kind: "forget_all" }
    | { kind: "who" }
    | { kind: "learn"; text: string; agent?: AgentKind }
    | undefined {
    const normalized = text.trim();
    const lowered = normalized.toLowerCase();

    if (/(кто ты( здесь)?|кто отвечает( здесь| в этой теме| в этом чате)?|какой ты агент)/i.test(normalized)) {
      return { kind: "who" };
    }

    if (/(что ты (помнишь|запомнил)|что помнит\b|покажи память|напомни что ты помнишь)/i.test(normalized)) {
      return {
        kind: "show_memory",
        agent: this.extractAgentMentionFromText(normalized) ?? currentAgent
      };
    }

    if (/(очисти память|сотри память|забудь все|забудь всё|удали всю память)/i.test(normalized)) {
      return { kind: "forget_all" };
    }

    const forgetMatch = normalized.match(/^(?:забудь|удали из памяти|не запоминай)\s+(.+)$/i);
    if (forgetMatch?.[1]) {
      return { kind: "forget", query: forgetMatch[1].trim() };
    }

    if (this.isStandaloneLearningInstruction(normalized)) {
      return {
        kind: "learn",
        text: normalized,
        agent: this.extractAgentMentionFromText(normalized) ?? currentAgent
      };
    }

    return undefined;
  }

  private extractAgentMentionFromText(text: string): AgentKind | undefined {
    const lowered = text.toLowerCase();
    for (const agent of ALL_AGENT_IDS) {
      const name = getAgentName(agent).toLowerCase();
      if (lowered.includes(name)) {
        return agent;
      }
    }
    if (/(маркетолог|marketing|маркетинг)/i.test(lowered)) {
      return "marketing";
    }
    if (/(кодер|coder|разработчик|dev)/i.test(lowered)) {
      return "coder";
    }
    if (/(ревьюер|reviewer|review|qa)/i.test(lowered)) {
      return "reviewer";
    }
    if (/(планировщик|planner|стратег|strategy|product)/i.test(lowered)) {
      return "planner";
    }
    if (/(оркестратор|orchestrator|general|ассистент)/i.test(lowered)) {
      return "general";
    }
    if (/(видео|video|media)/i.test(lowered)) {
      return "video";
    }
    return undefined;
  }

  private isStandaloneLearningInstruction(text: string): boolean {
    if (text.includes("?")) {
      return false;
    }

    const cleaned = text
      .trim()
      .replace(
        /^(?:@?(general|orchestrator|marketing|planner|coder|reviewer|рей|рэй|ray|мира|mira|платон|platon|коди|cody|codey|вера|vera|видо|vido)|маркетолог|кодер|ревьюер|планировщик|оркестратор|ассистент)\b[,:;\s-]*/i,
        ""
      );

    return /^(запомни|не делай|не нужно|без |отвечай|пиши|предпочитаю|мне нравится|мне не нравится|не люблю|не хочу|лучше |делай так|оставь так)/i.test(
      cleaned
    );
  }

  private buildLearningAcknowledgement(agent: AgentKind, text: string): string {
    const agentName = getAgentName(agent);
    return [
      `Ок, ${agentName} это учтет.`,
      text,
      "Если это будет мешать качеству или корректности, я коротко скажу об этом и предложу лучший вариант."
    ].join("\n");
  }

  private statusForAgent(agent: AgentKind): string {
    switch (agent) {
      case "marketing":
        return "Думаю над маркетингом и ростом...";
      case "planner":
        return "Планирую...";
      case "coder":
        return "Работаю с кодом...";
      case "reviewer":
        return "Проверяю и ищу риски...";
      case "video":
        return "Скачиваю и подготавливаю видео...";
      case "general":
      default:
        return "Думаю...";
    }
  }

  private parseRootChatId(sessionId: string): number | undefined {
    const raw = sessionId.split(":")[0];
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  private getThreadKind(sessionId: string): string {
    if (sessionId.includes(":dm-topic:")) {
      return "direct-messages-topic";
    }
    if (sessionId.includes(":topic:")) {
      return "topic";
    }
    return "main-chat";
  }

  private extractThreadTitle(message?: Record<string, unknown>): string | undefined {
    if (!message) {
      return undefined;
    }

    const forumCreated = message.forum_topic_created as { name?: unknown } | undefined;
    if (typeof forumCreated?.name === "string" && forumCreated.name.trim()) {
      return forumCreated.name.trim();
    }

    const forumEdited = message.forum_topic_edited as { name?: unknown } | undefined;
    if (typeof forumEdited?.name === "string" && forumEdited.name.trim()) {
      return forumEdited.name.trim();
    }

    const directTopic = message.direct_messages_topic as { title?: unknown; name?: unknown } | undefined;
    if (typeof directTopic?.title === "string" && directTopic.title.trim()) {
      return directTopic.title.trim();
    }
    if (typeof directTopic?.name === "string" && directTopic.name.trim()) {
      return directTopic.name.trim();
    }

    return undefined;
  }

  private isThreadBootstrapMessage(session: ChatSession, threadTitle: string | undefined, text: string): boolean {
    if (!session.assignedAgent || session.history.length > 0) {
      return false;
    }

    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const title = threadTitle?.trim().toLowerCase();
    const agentTitle = getAgentCard(session.assignedAgent).title.trim().toLowerCase();
    const agentId = session.assignedAgent.trim().toLowerCase();

    return normalized === title || normalized === agentTitle || normalized === agentId;
  }

  private buildThreadOnboarding(agent: AgentKind | undefined, threadTitle?: string): string {
    if (!agent) {
      return "Тема создана. Можешь писать сюда как в отдельный рабочий тред.";
    }

    switch (agent) {
      case "marketing":
        return `${getAgentName("marketing")} на связи${threadTitle ? `: ${threadTitle}` : ""}. Пиши сюда про рост, продажи, офферы, позиционирование и контент.`;
      case "coder":
        return `${getAgentName("coder")} на связи${threadTitle ? `: ${threadTitle}` : ""}. Пиши сюда технические задачи. Если нужно работать с кодом, сначала выбери workspace через /workspace <alias>.`;
      case "reviewer":
        return `${getAgentName("reviewer")} на связи${threadTitle ? `: ${threadTitle}` : ""}. Пиши сюда для проверки рисков, багов и регрессий.`;
      case "planner":
        return `${getAgentName("planner")} на связи${threadTitle ? `: ${threadTitle}` : ""}. Пиши сюда про архитектуру, план, стратегию и декомпозицию.`;
      case "general":
        return `${getAgentName("general")} на связи${threadTitle ? `: ${threadTitle}` : ""}. Это главный тред, здесь можно ставить общие задачи и делегировать работу.`;
      case "video":
        return `${getAgentName("video")} на связи${threadTitle ? `: ${threadTitle}` : ""}. Пиши сюда или отправляй видео для разбора.`;
      default:
        return "Тема создана и готова к работе.";
    }
  }

  private inferAgentFromThreadTitle(title?: string): AgentKind | undefined {
    if (!title) {
      return undefined;
    }

    const normalized = title.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (/(orchestrator|general|main|chief|assistant|оркестр|главн|рей|рэй|ray)/i.test(normalized)) {
      return "general";
    }
    if (/(marketing|growth|gtm|sales|маркет|продаж|рост|мира|mira)/i.test(normalized)) {
      return "marketing";
    }
    if (/(planner|product|strategy|plan|план|стратег|продукт|платон|platon)/i.test(normalized)) {
      return "planner";
    }
    if (/(coder|dev|engineering|engineer|code|разраб|код|engineering|коди|cody|codey)/i.test(normalized)) {
      return "coder";
    }
    if (/(review|reviewer|qa|audit|ревью|проверк|qa|вера|vera)/i.test(normalized)) {
      return "reviewer";
    }
    if (/(video|media|voice|видео|медиа|видо|vido)/i.test(normalized)) {
      return "video";
    }

    return undefined;
  }
}
