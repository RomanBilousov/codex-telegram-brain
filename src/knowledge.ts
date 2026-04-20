import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

interface EntrySummary {
  name: string;
  isDirectory: boolean;
  mtimeMs: number;
}

async function readTopLevel(path: string): Promise<EntrySummary[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const summaries = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const info = await stat(join(path, entry.name));
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          mtimeMs: info.mtimeMs
        };
      })
  );

  return summaries;
}

function formatEntries(entries: EntrySummary[], limit: number, sortByRecent: boolean): string[] {
  const sorted = [...entries].sort((left, right) => {
    if (sortByRecent && left.mtimeMs !== right.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }

    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return left.name.localeCompare(right.name, "ru");
  });

  return sorted.slice(0, limit).map((entry) => `${entry.isDirectory ? "dir" : "file"}: ${entry.name}`);
}

async function summarizePath(path: string, title: string, options: { limit: number; sortByRecent: boolean }): Promise<string> {
  try {
    const entries = await readTopLevel(path);
    const lines = formatEntries(entries, options.limit, options.sortByRecent);
    return [
      `${title}: ${path}`,
      `Top-level entries (${entries.length} total):`,
      ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ["- empty"])
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${title}: ${path}`, `- unavailable: ${message}`].join("\n");
  }
}

export async function buildMarketingKnowledgeSnapshot(
  companyKnowledgePaths: string[],
  projectScanPaths: string[]
): Promise<string> {
  const sections: string[] = [];

  for (const path of companyKnowledgePaths) {
    sections.push(
      await summarizePath(path, `Company knowledge source (${basename(path)})`, {
        limit: 12,
        sortByRecent: false
      })
    );
  }

  for (const path of projectScanPaths) {
    sections.push(
      await summarizePath(path, `Project landscape (${basename(path)})`, {
        limit: 15,
        sortByRecent: true
      })
    );
  }

  if (sections.length === 0) {
    return "No external company knowledge sources configured.";
  }

  return sections.join("\n\n");
}
