import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { PreparedVideo, VideoMetadata } from "./types.js";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "video.mp4";
}

function parseFps(value?: string): number | undefined {
  if (!value || value === "0/0") {
    return undefined;
  }

  if (!value.includes("/")) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const [numeratorRaw, denominatorRaw] = value.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }

  return numerator / denominator;
}

function clampTimestamp(timestamp: number, durationSeconds: number): number {
  if (durationSeconds <= 0.5) {
    return 0;
  }

  return Math.max(0, Math.min(timestamp, durationSeconds - 0.2));
}

function pickFrameTimestamps(durationSeconds: number): number[] {
  if (durationSeconds <= 1) {
    return [0];
  }

  const ratios = [0.1, 0.35, 0.6, 0.85];
  const values = ratios.map((ratio) => clampTimestamp(durationSeconds * ratio, durationSeconds));
  return [...new Set(values.map((value) => Number(value.toFixed(3))))];
}

async function runCommand(command: string, args: string[]): Promise<string> {
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
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });

  if (code !== 0) {
    throw new Error(`${command} failed: ${stderr.trim() || stdout.trim()}`);
  }

  return stdout;
}

async function downloadFile(fileUrl: URL, destinationPath: string): Promise<void> {
  const response = await fetch(fileUrl);
  const body = response.body;
  if (!response.ok || !body) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destinationPath);
    Readable.fromWeb(body as never).pipe(output);
    output.on("finish", resolve);
    output.on("error", reject);
  });
}

export class VideoProcessor {
  async prepareFromTelegram(fileUrl: URL, fileName: string): Promise<PreparedVideo> {
    const workDir = await mkdtemp(join(tmpdir(), "brain-video-"));
    const localName = sanitizeFileName(fileName);
    const videoPath = join(workDir, localName);

    await downloadFile(fileUrl, videoPath);
    return this.prepareFromLocalFile(videoPath, workDir);
  }

  async prepareFromExistingFile(sourcePath: string): Promise<PreparedVideo> {
    const workDir = await mkdtemp(join(tmpdir(), "brain-video-"));
    await mkdir(workDir, { recursive: true });
    const targetPath = join(workDir, sanitizeFileName(basename(sourcePath)));
    await copyFile(sourcePath, targetPath);
    return this.prepareFromLocalFile(targetPath, workDir);
  }

  async cleanup(workDir: string): Promise<void> {
    await rm(workDir, { recursive: true, force: true });
  }

  private async prepareFromLocalFile(videoPath: string, workDir: string): Promise<PreparedVideo> {
    const metadata = await this.probe(videoPath);
    let audioPath: string | undefined;
    if (metadata.audioCodec) {
      audioPath = join(workDir, `${basename(videoPath, extname(videoPath))}.mp3`);
      await this.extractAudio(videoPath, audioPath);
    }

    const timestamps = pickFrameTimestamps(metadata.durationSeconds);
    const keyframes: string[] = [];
    for (let index = 0; index < timestamps.length; index += 1) {
      const framePath = join(workDir, `frame-${String(index + 1).padStart(2, "0")}.png`);
      await this.extractFrame(videoPath, timestamps[index], framePath);
      keyframes.push(framePath);
    }

    return {
      workDir,
      videoPath,
      audioPath,
      keyframes,
      metadata
    };
  }

  private async probe(videoPath: string): Promise<VideoMetadata> {
    const probeJson = await runCommand("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      videoPath
    ]);
    const parsed = JSON.parse(probeJson) as FfprobeOutput;
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
    const stats = await stat(videoPath);

    return {
      durationSeconds: Number(parsed.format?.duration ?? 0),
      width: videoStream?.width,
      height: videoStream?.height,
      sizeBytes: stats.size,
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      fps: parseFps(videoStream?.avg_frame_rate)
    };
  }

  private async extractAudio(videoPath: string, audioPath: string): Promise<void> {
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "32k",
      audioPath
    ]);
  }

  private async extractFrame(videoPath: string, timestamp: number, framePath: string): Promise<void> {
    await runCommand("ffmpeg", [
      "-y",
      "-ss",
      `${timestamp}`,
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      framePath
    ]);
  }
}
