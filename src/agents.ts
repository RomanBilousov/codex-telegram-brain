import type { AgentKind, AgentProfileOverride } from "./types.js";

export interface AgentSkill {
  name: string;
  kind: "local-skill" | "system-capability";
  path?: string;
  note?: string;
}

export interface AgentCard {
  id: AgentKind;
  title: string;
  name: string;
  role: string;
  avatarPath: string;
  avatarDataUrl?: string;
  summary: string;
  mission: string;
  directChat: boolean;
  proactive: boolean;
  requiresWorkspace: boolean;
  skills: AgentSkill[];
  contextFiles: string[];
}

const profileOverrides: Partial<Record<AgentKind, AgentProfileOverride>> = {};

const MARKETING_SKILLS: AgentSkill[] = [
  {
    name: "market-research",
    kind: "system-capability",
    note: "Analyzes positioning, offers, channels, and growth opportunities."
  },
  {
    name: "go-to-market",
    kind: "system-capability",
    note: "Builds GTM plans, messaging, and launch structure."
  },
  {
    name: "pricing-strategy",
    kind: "system-capability",
    note: "Helps shape pricing, packaging, and value framing."
  },
  {
    name: "copywriting",
    kind: "system-capability",
    note: "Writes and edits pages, messages, and campaign copy."
  },
  {
    name: "content-strategy",
    kind: "system-capability",
    note: "Suggests content plans, channel ideas, and campaign angles."
  }
];

const AGENT_CARDS: Record<AgentKind, AgentCard> = {
  general: {
    id: "general",
    title: "Orchestrator",
    name: "Рэй",
    role: "главный оркестратор",
    avatarPath: "docs/agent-avatars/ray.svg",
    summary: "Главный ассистент и координатор. Понимает контекст компании и решает, кого подключить.",
    mission: "Быть личным AI-ассистентом и верхнеуровневым оркестратором работы по компании.",
    directChat: true,
    proactive: true,
    requiresWorkspace: false,
    skills: [
      { name: "delegation-router", kind: "system-capability", note: "Определяет владельца задачи и маршрутизирует работу." },
      { name: "company-memory", kind: "system-capability", note: "Использует общую память компании и контекст всех агентов." },
      { name: "codex-app-server", kind: "system-capability", note: "Ведет persistent диалог как главный ассистент." }
    ],
    contextFiles: []
  },
  marketing: {
    id: "marketing",
    title: "Marketing",
    name: "Мира",
    role: "маркетолог",
    avatarPath: "docs/agent-avatars/mira.svg",
    summary: "Маркетолог и growth-оператор. Ищет вектор роста, гипотезы, офферы и вопросы к вам.",
    mission: "Помогать строить AI IT-компанию через позиционирование, контент, GTM, воронку и продажи.",
    directChat: true,
    proactive: true,
    requiresWorkspace: false,
    skills: MARKETING_SKILLS,
    contextFiles: []
  },
  planner: {
    id: "planner",
    title: "Planner",
    name: "Платон",
    role: "стратег",
    avatarPath: "docs/agent-avatars/platon.svg",
    summary: "Стратегия, архитектура, декомпозиция, roadmap и продуктовые решения.",
    mission: "Структурировать сложные задачи и проектные решения.",
    directChat: true,
    proactive: false,
    requiresWorkspace: false,
    skills: [
      { name: "strategy-decomposition", kind: "system-capability", note: "Делит цель на этапы, решения и roadmap." },
      { name: "tradeoff-analysis", kind: "system-capability", note: "Смотрит на варианты и их компромиссы." }
    ],
    contextFiles: []
  },
  coder: {
    id: "coder",
    title: "Coder",
    name: "Коди",
    role: "инженер",
    avatarPath: "docs/agent-avatars/cody.svg",
    summary: "Работа с кодом, файлами и реализацией в выбранном workspace.",
    mission: "Делать техническую работу руками, а не только обсуждать её.",
    directChat: true,
    proactive: false,
    requiresWorkspace: true,
    skills: [
      { name: "workspace-write", kind: "system-capability", note: "Может менять файлы в активном workspace." },
      { name: "repo-implementation", kind: "system-capability", note: "Делает реализацию, фиксы и интеграции." }
    ],
    contextFiles: []
  },
  reviewer: {
    id: "reviewer",
    title: "Reviewer",
    name: "Вера",
    role: "ревьюер",
    avatarPath: "docs/agent-avatars/vera.svg",
    summary: "Ревью, риски, регрессии, тестовые пробелы и качественный контроль.",
    mission: "Защищать от багов, регрессий и слабых решений.",
    directChat: true,
    proactive: false,
    requiresWorkspace: false,
    skills: [
      { name: "review-mindset", kind: "system-capability", note: "Фокус на находках, рисках и regressions." },
      { name: "quality-control", kind: "system-capability", note: "Проверяет тестовые пробелы и слабые места." }
    ],
    contextFiles: []
  },
  video: {
    id: "video",
    title: "Video",
    name: "Видо",
    role: "видео-агент",
    avatarPath: "docs/agent-avatars/vido.svg",
    summary: "Понимает видео, кадры и речь, отвечает по смыслу увиденного и сказанного.",
    mission: "Обрабатывать видео как живой интерфейс общения.",
    directChat: false,
    proactive: false,
    requiresWorkspace: false,
    skills: [
      { name: "video-analysis", kind: "system-capability", note: "Работает с keyframes, transcript и метаданными." },
      { name: "audio-transcription", kind: "system-capability", note: "Использует speech-to-text pipeline." }
    ],
    contextFiles: []
  }
};

export const ALL_AGENT_IDS: AgentKind[] = ["general", "marketing", "planner", "coder", "reviewer", "video"];
export const DIRECT_AGENT_IDS: AgentKind[] = ["general", "marketing", "planner", "coder", "reviewer"];

function normalizeAgentName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function setAgentProfileOverrides(overrides: Partial<Record<AgentKind, AgentProfileOverride>>): void {
  for (const agent of ALL_AGENT_IDS) {
    if (overrides[agent]) {
      profileOverrides[agent] = overrides[agent];
    } else {
      delete profileOverrides[agent];
    }
  }
}

export function setAgentProfileOverride(agent: AgentKind, override: AgentProfileOverride): void {
  profileOverrides[agent] = override;
}

export function getAgentProfileOverride(agent: AgentKind): AgentProfileOverride | undefined {
  return profileOverrides[agent];
}

export function getAgentCard(agent: AgentKind): AgentCard {
  const base = AGENT_CARDS[agent];
  const override = profileOverrides[agent];
  return {
    ...base,
    name: override?.name?.trim() || base.name,
    avatarDataUrl: override?.avatarDataUrl?.trim() || undefined
  };
}

export function getAgentName(agent: AgentKind): string {
  return getAgentCard(agent).name;
}

export function getAgentDisplayLabel(agent: AgentKind): string {
  const card = getAgentCard(agent);
  return `${card.name} — ${card.role}`;
}

export function getAgentAvatarPath(agent: AgentKind): string {
  return AGENT_CARDS[agent].avatarPath;
}

export function getAgentAvatarSource(agent: AgentKind): string {
  const card = getAgentCard(agent);
  return card.avatarDataUrl?.trim() || card.avatarPath;
}

export function parseAgentId(raw: string): AgentKind | undefined {
  const normalized = raw.trim().toLowerCase().replace(/^@/, "");
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "orchestrator":
    case "рей":
    case "рэй":
    case "ray":
      return "general";
    case "мира":
    case "mira":
      return "marketing";
    case "платон":
    case "platon":
      return "planner";
    case "коди":
    case "cody":
    case "codey":
      return "coder";
    case "вера":
    case "vera":
      return "reviewer";
    case "видо":
    case "vido":
      return "video";
    default:
      break;
  }

  for (const agent of ALL_AGENT_IDS) {
    if (normalizeAgentName(getAgentCard(agent).name) === normalized) {
      return agent;
    }
  }

  return Object.prototype.hasOwnProperty.call(AGENT_CARDS, normalized) ? (normalized as AgentKind) : undefined;
}

export function renderAgentList(): string {
  const lines = ["Специалисты супербота:"];
  for (const id of DIRECT_AGENT_IDS) {
    const card = getAgentCard(id);
    lines.push(`- ${card.name} — ${card.role} (${card.id}): ${card.summary}`);
  }
  const video = getAgentCard("video");
  lines.push(`- ${video.name} — ${video.role} (${video.id}): ${video.summary}`);
  return lines.join("\n");
}

export function renderAgentCard(agent: AgentKind): string {
  const card = getAgentCard(agent);
  return [
    `${card.name} — ${card.role}`,
    `Agent id: ${card.id}`,
    `System role: ${card.title}`,
    card.summary,
    `Mission: ${card.mission}`,
    `Direct chat: ${card.directChat ? "yes" : "no"}`,
    `Proactive: ${card.proactive ? "yes" : "no"}`,
    `Needs workspace: ${card.requiresWorkspace ? "yes" : "no"}`
  ].join("\n");
}
