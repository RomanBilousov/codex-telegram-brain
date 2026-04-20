import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentKind, AgentProfileOverride, ChatMessage, ChatSession, MemoryItem, OfficeState, ThreadProfile } from "./types.js";

function getSessionTimestamp(session: ChatSession): number {
  const lastMessage = session.history.at(-1)?.at;
  return lastMessage ? Date.parse(lastMessage) || 0 : 0;
}

interface StateFile extends OfficeState {
  sessions: Record<string, ChatSession>;
}

const EMPTY_STATE: StateFile = { sessions: {}, companyMemories: [], agentMemories: {}, agentProfiles: {}, threadProfiles: {} };
const HISTORY_LIMIT = 12;

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    history: session.history ?? [],
    memories: session.memories ?? []
  };
}

function normalizeState(state?: Partial<StateFile>): StateFile {
  return {
    sessions: state?.sessions ?? {},
    companyMemories: state?.companyMemories ?? [],
    agentMemories: state?.agentMemories ?? {},
    agentProfiles: state?.agentProfiles ?? {},
    threadProfiles: state?.threadProfiles ?? {}
  };
}

export class BrainStorage {
  private readonly stateFile: string;

  constructor(private readonly stateDir: string) {
    this.stateFile = join(stateDir, "state.json");
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    try {
      await readFile(this.stateFile, "utf8");
    } catch {
      await this.writeState(EMPTY_STATE);
    }
  }

  async getSession(chatId: string): Promise<ChatSession> {
    const state = await this.readState();
    return normalizeSession(
      state.sessions[chatId] ?? {
        chatId,
        history: [],
        memories: []
      }
    );
  }

  async saveSession(session: ChatSession): Promise<void> {
    const state = await this.readState();
    state.sessions[session.chatId] = normalizeSession({
      ...session,
      history: session.history.slice(-HISTORY_LIMIT)
    });
    await this.writeState(state);
  }

  async resetSession(chatId: string): Promise<void> {
    const state = await this.readState();
    delete state.sessions[chatId];
    await this.writeState(state);
  }

  async getCompanyMemories(): Promise<MemoryItem[]> {
    const state = await this.readState();
    return state.companyMemories;
  }

  async saveCompanyMemories(memories: MemoryItem[]): Promise<void> {
    const state = await this.readState();
    state.companyMemories = memories;
    await this.writeState(state);
  }

  async getAgentMemories(agent: keyof NonNullable<StateFile["agentMemories"]>): Promise<MemoryItem[]> {
    const state = await this.readState();
    return state.agentMemories?.[agent] ?? [];
  }

  async saveAgentMemories(agent: keyof NonNullable<StateFile["agentMemories"]>, memories: MemoryItem[]): Promise<void> {
    const state = await this.readState();
    state.agentMemories ??= {};
    state.agentMemories[agent] = memories;
    await this.writeState(state);
  }

  async getAgentMemoryMap(): Promise<NonNullable<StateFile["agentMemories"]>> {
    const state = await this.readState();
    return state.agentMemories ?? {};
  }

  async clearAgentMemories(): Promise<void> {
    const state = await this.readState();
    state.agentMemories = {};
    await this.writeState(state);
  }

  async getAgentProfiles(): Promise<NonNullable<StateFile["agentProfiles"]>> {
    const state = await this.readState();
    return state.agentProfiles ?? {};
  }

  async getAgentProfile(agent: AgentKind): Promise<AgentProfileOverride | undefined> {
    const state = await this.readState();
    return state.agentProfiles?.[agent];
  }

  async saveAgentProfile(agent: AgentKind, profile: AgentProfileOverride): Promise<void> {
    const state = await this.readState();
    state.agentProfiles ??= {};
    state.agentProfiles[agent] = profile;
    await this.writeState(state);
  }

  async getThreadProfiles(): Promise<Record<string, ThreadProfile>> {
    const state = await this.readState();
    return state.threadProfiles ?? {};
  }

  async saveThreadProfile(profile: ThreadProfile): Promise<void> {
    const state = await this.readState();
    state.threadProfiles ??= {};
    state.threadProfiles[profile.sessionId] = profile;
    await this.writeState(state);
  }

  async listChatThreadProfiles(chatId: number): Promise<ThreadProfile[]> {
    const state = await this.readState();
    return Object.values(state.threadProfiles ?? {})
      .filter((profile) => profile.chatId === chatId)
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async getThreadProfile(sessionId: string): Promise<ThreadProfile | undefined> {
    const state = await this.readState();
    return state.threadProfiles?.[sessionId];
  }

  async findLatestWebSession(agent: AgentKind, excludeChatId?: string): Promise<ChatSession | undefined> {
    const state = await this.readState();
    const sessions = Object.values(state.sessions)
      .map((session) => normalizeSession(session))
      .filter((session) => session.chatId.startsWith("web:"))
      .filter((session) => session.chatId !== excludeChatId)
      .filter((session) => {
        if (agent === "general") {
          return !session.chatId.includes(":agent:");
        }
        return session.chatId.endsWith(`:agent:${agent}`);
      })
      .filter((session) => session.history.length || session.memories.length || session.activeWorkspaceKey);

    sessions.sort((left, right) => getSessionTimestamp(right) - getSessionTimestamp(left));
    return sessions[0];
  }

  async migrateWebSessions(fromClientId: string, toClientId: string): Promise<void> {
    if (fromClientId === toClientId) {
      return;
    }

    const state = await this.readState();
    const sourcePrefix = `web:${fromClientId}`;
    const targetPrefix = `web:${toClientId}`;
    const sourceEntries = Object.entries(state.sessions).filter(([chatId]) => chatId === sourcePrefix || chatId.startsWith(`${sourcePrefix}:agent:`));

    let changed = false;

    for (const [chatId, rawSession] of sourceEntries) {
      const targetChatId = chatId.replace(sourcePrefix, targetPrefix);
      const existing = state.sessions[targetChatId] ? normalizeSession(state.sessions[targetChatId]) : undefined;
      if (existing && (existing.history.length || existing.memories.length || existing.activeWorkspaceKey || existing.generalThreadId)) {
        continue;
      }

      state.sessions[targetChatId] = normalizeSession({
        ...rawSession,
        chatId: targetChatId
      });
      changed = true;
    }

    if (changed) {
      await this.writeState(state);
    }
  }

  appendHistory(session: ChatSession, role: ChatMessage["role"], text: string): ChatSession {
    const nextMessage: ChatMessage = {
      role,
      text,
      at: new Date().toISOString()
    };

    return normalizeSession({
      ...session,
      history: [...session.history, nextMessage].slice(-HISTORY_LIMIT)
    });
  }

  private async readState(): Promise<StateFile> {
    try {
      const raw = await readFile(this.stateFile, "utf8");
      return normalizeState(JSON.parse(raw) as Partial<StateFile>);
    } catch {
      return EMPTY_STATE;
    }
  }

  private async writeState(state: StateFile): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(normalizeState(state), null, 2));
  }
}
