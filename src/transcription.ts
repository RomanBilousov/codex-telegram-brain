import { createReadStream } from "node:fs";
import OpenAI from "openai";

export interface TranscriptionResult {
  text?: string;
  error?: string;
}

export class AudioTranscriber {
  private readonly client?: OpenAI;

  constructor(
    apiKey: string | undefined,
    private readonly model: string,
    organization?: string,
    project?: string
  ) {
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        organization,
        project
      });
    }
  }

  isEnabled(): boolean {
    return Boolean(this.client);
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    if (!this.client) {
      return {
        error: "OPENAI_API_KEY is not set"
      };
    }

    try {
      const response = await this.client.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: this.model,
        response_format: "text"
      });

      return {
        text: response.trim()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transcription error";
      return { error: message };
    }
  }
}
