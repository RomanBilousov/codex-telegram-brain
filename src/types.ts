export type AgentKind = "general" | "marketing" | "planner" | "coder" | "reviewer" | "video";
export type MemoryCategory = "identity" | "preference" | "constraint" | "project" | "goal";

export interface AgentProfileOverride {
  name?: string;
  avatarDataUrl?: string;
  updatedAt: string;
}

export interface WorkspaceSpec {
  key: string;
  path: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  text: string;
  source: "auto" | "manual";
  updatedAt: string;
}

export interface ChatSession {
  chatId: string;
  activeWorkspaceKey?: string;
  assignedAgent?: AgentKind;
  generalThreadId?: string;
  history: ChatMessage[];
  memories: MemoryItem[];
}

export interface OfficeState {
  companyMemories: MemoryItem[];
  agentMemories?: Partial<Record<AgentKind, MemoryItem[]>>;
  agentProfiles?: Partial<Record<AgentKind, AgentProfileOverride>>;
  threadProfiles?: Record<string, ThreadProfile>;
}

export interface ThreadTarget {
  sessionId: string;
  chatId: number;
  label: string;
  messageThreadId?: number;
  directMessagesTopicId?: number;
}

export interface ThreadProfile {
  sessionId: string;
  chatId: number;
  label: string;
  source: "chat" | "topic" | "dm_topic";
  messageThreadId?: number;
  directMessagesTopicId?: number;
  title?: string;
  updatedAt: string;
}

export interface RouterDecision {
  agent: AgentKind;
  reason: string;
  needsWorkspace: boolean;
}

export interface BrainReply {
  text: string;
  agent?: AgentKind;
}

export type StatusCallback = (status: string) => Promise<void>;

export interface AudioRequest {
  caption?: string;
  fileName: string;
  fileUrl: URL;
  source: "voice" | "audio";
}

export interface VideoRequest {
  caption?: string;
  fileName: string;
  fileUrl: URL;
}

export interface VideoMetadata {
  durationSeconds: number;
  width?: number;
  height?: number;
  sizeBytes: number;
  videoCodec?: string;
  audioCodec?: string;
  fps?: number;
}

export interface PreparedAudio {
  workDir: string;
  sourcePath: string;
  audioPath: string;
}

export interface PreparedVideo {
  workDir: string;
  videoPath: string;
  audioPath?: string;
  keyframes: string[];
  metadata: VideoMetadata;
}

export interface WebAuthUser {
  telegramId: string;
  clientId: string;
  name: string;
  username?: string;
  picture?: string;
  phoneNumber?: string;
}

export interface WebAuthStatus {
  enabled: boolean;
  authenticated: boolean;
  provider?: "telegram-code" | "telegram-oidc";
  hint?: string;
  user?: WebAuthUser;
}
