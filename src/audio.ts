import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { PreparedAudio } from "./types.js";

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "audio.bin";
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const { code, stdout, stderr } = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

  if (code !== 0) {
    throw new Error(`${command} failed: ${stderr.trim() || stdout.trim()}`);
  }
}

async function downloadFile(fileUrl: URL, destinationPath: string): Promise<void> {
  const response = await fetch(fileUrl);
  const body = response.body;
  if (!response.ok || !body) {
    throw new Error(`Failed to download audio: ${response.status} ${response.statusText}`);
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destinationPath);
    Readable.fromWeb(body as never).pipe(output);
    output.on("finish", resolve);
    output.on("error", reject);
  });
}

export class AudioProcessor {
  async prepareFromTelegram(fileUrl: URL, fileName: string): Promise<PreparedAudio> {
    const workDir = await mkdtemp(join(tmpdir(), "brain-audio-"));
    const sourcePath = join(workDir, sanitizeFileName(fileName));
    await downloadFile(fileUrl, sourcePath);
    return this.prepareFromLocalFile(sourcePath, workDir);
  }

  async prepareFromExistingFile(sourcePath: string): Promise<PreparedAudio> {
    const workDir = await mkdtemp(join(tmpdir(), "brain-audio-"));
    await mkdir(workDir, { recursive: true });
    const targetPath = join(workDir, sanitizeFileName(basename(sourcePath)));
    await copyFile(sourcePath, targetPath);
    return this.prepareFromLocalFile(targetPath, workDir);
  }

  async cleanup(workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
  }

  private async prepareFromLocalFile(sourcePath: string, workDir: string): Promise<PreparedAudio> {
    const audioPath = join(workDir, `${basename(sourcePath, extname(sourcePath))}.mp3`);
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      sourcePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "32k",
      audioPath
    ]);

    return {
      workDir,
      sourcePath,
      audioPath
    };
  }
}
