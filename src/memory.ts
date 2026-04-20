import { randomUUID } from "node:crypto";
import type { MemoryCategory, MemoryItem } from "./types.js";

const MEMORY_LIMIT = 24;
const MEMORY_CONTEXT_LIMIT = 10;

const categoryLabels: Record<MemoryCategory, string> = {
  identity: "личное",
  preference: "предпочтение",
  constraint: "ограничение",
  project: "проект",
  goal: "фокус"
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^[\-,:;\s]+|[\-,:;\s]+$/g, "");
}

function sentenceChunks(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function cleanupForMemory(text: string): string {
  return normalizeText(text.replace(/^@(general|orchestrator|marketing|planner|coder|reviewer)\b\s*/i, ""));
}

function detectCategory(text: string): MemoryCategory | undefined {
  const lowered = text.toLowerCase();

  if (/(меня зовут|зови меня|my name is)/i.test(text)) {
    return "identity";
  }

  if (/(не делай|не нужно|без отчет|без отчета|без формальн|don't|do not)/i.test(text)) {
    return "constraint";
  }

  if (/(не нравится|не люблю|не хочу|раздражает|бесит|убери|перестань)/i.test(text)) {
    return "constraint";
  }

  if (/(мне нравится|мне нравятся|предпочитаю|отвечай|пиши|лучше|по-человечески|короче|покороче|human format|оставь так|делай так)/i.test(text)) {
    return "preference";
  }

  if (/(мой проект|основной проект|workspace|репозитор|репо|codex-telegram-brain)/i.test(text)) {
    return "project";
  }

  if (/(хочу|нужно|надо|следующий шаг|сейчас фокус|делаем|пусть|важно|сделай|ассистент|помощник)/i.test(text)) {
    return "goal";
  }

  return undefined;
}

function extractRememberClause(text: string): string | undefined {
  const match = text.match(/(?:^|\b)(?:запомни|remember)\b[:\s,-]*(.+)$/i);
  return match?.[1] ? normalizeText(match[1]) : undefined;
}

export function extractMemoryCandidates(text: string): Array<{ category: MemoryCategory; text: string }> {
  const cleaned = cleanupForMemory(text);
  if (!cleaned || cleaned.length < 8 || cleaned.startsWith("/")) {
    return [];
  }

  const candidates: Array<{ category: MemoryCategory; text: string }> = [];
  const explicitRemember = extractRememberClause(cleaned);
  if (explicitRemember) {
    const category = detectCategory(explicitRemember) ?? "goal";
    candidates.push({ category, text: explicitRemember });
  }

  for (const chunk of sentenceChunks(cleaned)) {
    if (chunk.length < 8 || chunk.length > 220) {
      continue;
    }

    const category = detectCategory(chunk);
    if (!category) {
      continue;
    }

    candidates.push({ category, text: chunk });
  }

  const unique = new Map<string, { category: MemoryCategory; text: string }>();
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate.text);
    const key = `${candidate.category}:${normalized.toLowerCase()}`;
    unique.set(key, { category: candidate.category, text: normalized });
  }

  return [...unique.values()];
}

export function upsertMemories(
  memories: MemoryItem[],
  candidates: Array<{ category: MemoryCategory; text: string }>,
  source: MemoryItem["source"] = "auto"
): MemoryItem[] {
  if (candidates.length === 0) {
    return memories;
  }

  const next = [...memories];
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const existingIndex = next.findIndex(
      (memory) =>
        memory.category === candidate.category && normalizeText(memory.text).toLowerCase() === candidate.text.toLowerCase()
    );

    if (existingIndex >= 0) {
      next[existingIndex] = {
        ...next[existingIndex],
        text: candidate.text,
        updatedAt: now,
        source
      };
      continue;
    }

    next.push({
      id: randomUUID(),
      category: candidate.category,
      text: candidate.text,
      updatedAt: now,
      source
    });
  }

  return next
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MEMORY_LIMIT);
}

export function extractCompanyMemoryCandidates(text: string): Array<{ category: MemoryCategory; text: string }> {
  return extractMemoryCandidates(text).filter((candidate) => candidate.category !== "identity");
}

export function extractAgentLearningCandidates(text: string): Array<{ category: MemoryCategory; text: string }> {
  return extractMemoryCandidates(text).filter((candidate) => candidate.category !== "identity");
}

export function mergeMemories(...groups: MemoryItem[][]): MemoryItem[] {
  const byKey = new Map<string, MemoryItem>();
  for (const group of groups) {
    for (const memory of group) {
      const key = `${memory.category}:${normalizeText(memory.text).toLowerCase()}`;
      const existing = byKey.get(key);
      if (!existing || existing.updatedAt.localeCompare(memory.updatedAt) < 0) {
        byKey.set(key, memory);
      }
    }
  }

  return [...byKey.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function describeMemories(memories: MemoryItem[]): string {
  if (memories.length === 0) {
    return "Долговременная память пока пуста.";
  }

  const lines = ["Что я помню:"];
  for (const memory of memories) {
    lines.push(`- [${memory.id.slice(0, 8)}] ${categoryLabels[memory.category]}: ${memory.text}`);
  }
  return lines.join("\n");
}

export function forgetMemory(memories: MemoryItem[], query: string): MemoryItem[] {
  const normalized = normalizeText(query).toLowerCase();
  if (!normalized) {
    return memories;
  }

  return memories.filter((memory) => {
    const idMatches = memory.id.toLowerCase().startsWith(normalized);
    const textMatches = memory.text.toLowerCase().includes(normalized);
    return !idMatches && !textMatches;
  });
}

export function renderMemoryContext(memories: MemoryItem[]): string {
  if (memories.length === 0) {
    return "No long-term memory saved.";
  }

  return memories
    .slice(0, MEMORY_CONTEXT_LIMIT)
    .map((memory) => `- ${categoryLabels[memory.category]}: ${memory.text}`)
    .join("\n");
}

export function looksLikeDelegationCandidate(text: string): boolean {
  return /(план|архитектур|стратег|roadmap|ревью|review|проверь|баг|ошибк|риск|регресс|тест|код|репозитор|репо|workspace|файл|рефактор|реализ|исправ|почини|напиши|создай|добавь|сделай|implementation|debug|маркет|продаж|growth|gtm|icp|оффер|оффер|позиционир|контент|лиды|воронк|конверси)/i.test(
    text
  );
}
