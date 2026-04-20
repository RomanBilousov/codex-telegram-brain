import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface TurnWaiter {
  threadId: string;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export interface GeneralChatRequest {
  text: string;
  threadId?: string;
  model?: string;
  effort: "low" | "medium" | "high" | "xhigh";
}

export interface GeneralChatReply {
  threadId: string;
  text: string;
}

export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private nextId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly loadedThreads = new Set<string>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();

  constructor(
    private readonly codexBin: string,
    private readonly cwd: string
  ) {}

  async init(): Promise<void> {
    await this.ensureStarted();
  }

  async close(): Promise<void> {
    if (!this.child || this.child.killed) {
      return;
    }

    this.child.kill("SIGINT");
    this.child = undefined;
    this.startPromise = undefined;
    this.loadedThreads.clear();
  }

  async sendGeneralMessage(request: GeneralChatRequest): Promise<GeneralChatReply> {
    await this.ensureStarted();
    const threadId = await this.ensureGeneralThread(request.threadId, request.model);

    const turnResult = (await this.call("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: request.text
        }
      ],
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly"
      },
      ...(request.model ? { model: request.model } : {}),
      effort: request.effort
    })) as { turn: { id: string } };

    const text = await new Promise<string>((resolve, reject) => {
      this.turnWaiters.set(turnResult.turn.id, {
        threadId,
        text: "",
        resolve,
        reject
      });
    });

    return {
      threadId,
      text
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      this.child = spawn(this.codexBin, ["app-server"], {
        cwd: this.cwd,
        env: {
          ...process.env,
          RUST_LOG: "error"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      this.child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          console.error(`[app-server] ${text}`);
        }
      });

      this.child.on("exit", (code, signal) => {
        const message = new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);

        for (const pending of this.pendingRequests.values()) {
          pending.reject(message);
        }
        this.pendingRequests.clear();

        for (const waiter of this.turnWaiters.values()) {
          waiter.reject(message);
        }
        this.turnWaiters.clear();

        this.loadedThreads.clear();
        this.child = undefined;
        this.startPromise = undefined;
      });

      const lineReader = createInterface({
        input: this.child.stdout
      });

      lineReader.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        this.onMessage(line);
      });

      await this.callInternal("initialize", {
        clientInfo: {
          name: "codex_telegram_brain",
          title: "Codex Telegram Brain",
          version: "0.1.0"
        }
      });

      this.notify("initialized", {});
    })();

    return this.startPromise;
  }

  private async ensureGeneralThread(threadId: string | undefined, model: string | undefined): Promise<string> {
    if (threadId && this.loadedThreads.has(threadId)) {
      return threadId;
    }

    if (threadId) {
      await this.call("thread/resume", {
        threadId
      });
      this.loadedThreads.add(threadId);
      return threadId;
    }

    const result = (await this.call("thread/start", {
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "codex_telegram_brain",
      ...(model ? { model } : {})
    })) as { thread: { id: string } };

    this.loadedThreads.add(result.thread.id);
    return result.thread.id;
  }

  private onMessage(line: string): void {
    const message = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: any };

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Unknown JSON-RPC error"));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params;
    switch (message.method) {
      case "thread/started":
        if (params?.thread?.id) {
          this.loadedThreads.add(params.thread.id);
        }
        break;
      case "thread/closed":
        if (params?.threadId) {
          this.loadedThreads.delete(params.threadId);
        }
        break;
      case "item/agentMessage/delta": {
        const waiter = this.turnWaiters.get(params?.turnId);
        if (waiter) {
          waiter.text += params.delta ?? "";
        }
        break;
      }
      case "item/completed": {
        const waiter = this.turnWaiters.get(params?.turnId);
        if (waiter && params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
          waiter.text = params.item.text;
        }
        break;
      }
      case "turn/completed": {
        const waiter = this.turnWaiters.get(params?.turn?.id);
        if (!waiter) {
          break;
        }

        this.turnWaiters.delete(params.turn.id);
        if (params.turn.status === "completed") {
          waiter.resolve(waiter.text.trim());
          break;
        }

        const errorMessage =
          params?.turn?.error?.message ??
          params?.turn?.error?.additionalDetails ??
          `Turn failed with status ${params?.turn?.status ?? "unknown"}`;
        waiter.reject(new Error(errorMessage));
        break;
      }
      default:
        break;
    }
  }

  private async call(method: string, params: object): Promise<unknown> {
    await this.ensureStartedInternal();
    return this.callInternal(method, params);
  }

  private async callInternal(method: string, params: object): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    this.write({
      id,
      method,
      params
    });

    return promise;
  }

  private notify(method: string, params: object): void {
    this.write({
      method,
      params
    });
  }

  private write(payload: object): void {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async ensureStartedInternal(): Promise<void> {
    if (!this.startPromise) {
      await this.ensureStarted();
      return;
    }
    await this.startPromise;
  }
}
