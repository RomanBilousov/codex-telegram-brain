import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface RunCodexOptions {
  codexBin: string;
  prompt: string;
  cwd?: string;
  schemaPath?: string;
  model?: string;
  images?: string[];
  sandbox: "read-only" | "workspace-write";
}

export class CodexRunner {
  async runText(options: RunCodexOptions): Promise<string> {
    const output = await this.run(options);
    return output.trim();
  }

  async runJson<T>(options: RunCodexOptions): Promise<T> {
    const output = await this.run(options);
    return JSON.parse(output) as T;
  }

  private async run(options: RunCodexOptions): Promise<string> {
    const runDir = await mkdtemp(join(tmpdir(), "codex-brain-"));
    const outputFile = join(runDir, "last-message.txt");

    try {
      const args = [
        "exec",
        "-",
        "--ephemeral",
        "--color",
        "never",
        "-s",
        options.sandbox,
        "-o",
        outputFile
      ];

      if (options.cwd) {
        args.push("-C", options.cwd);
      } else {
        args.push("--skip-git-repo-check");
      }

      if (options.model) {
        args.push("-m", options.model);
      }

      for (const imagePath of options.images ?? []) {
        args.push("-i", imagePath);
      }

      if (options.schemaPath) {
        args.push("--output-schema", options.schemaPath);
      }

      const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
        const child = spawn(options.codexBin, args, {
          stdio: ["pipe", "ignore", "pipe"]
        });

        let stderr = "";

        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("close", (code) => {
          resolve({ code: code ?? 1, stderr });
        });

        child.stdin.end(options.prompt);
      });

      if (code !== 0) {
        throw new Error(stderr.trim() || `codex exited with code ${code}`);
      }

      return await readFile(outputFile, "utf8");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }
}
