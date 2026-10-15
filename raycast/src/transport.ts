import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";

export interface SavedSession {
  id: string;
  updatedAt: string;
  hasConversation: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type WorkerRequest =
  | { type: "list" }
  | { type: "ask"; prompt: string; sessionId?: string }
  | { type: "history"; sessionId: string };
export type WorkerResult =
  | { type: "sessions"; sessions: SavedSession[] }
  | { type: "answer"; sessionId: string; answer: string }
  | { type: "history"; sessionId: string; messages: ChatMessage[] };
export interface WorkerOptions {
  signal?: AbortSignal;
  onSession?: (id: string) => void;
}
export interface WorkerConfiguration {
  nodeExecutable: string;
  projectDirectory: string;
}

export async function executeWorker(
  configuration: WorkerConfiguration,
  request: WorkerRequest,
  options: WorkerOptions = {},
): Promise<WorkerResult> {
  if (options.signal?.aborted) {
    throw new DOMException("Request cancelled", "AbortError");
  }
  if (!isAbsolute(configuration.nodeExecutable) || !isAbsolute(configuration.projectDirectory)) {
    throw new Error("Jimmy's installation paths are invalid. Run npm run dev in the repository's raycast folder to regenerate them.");
  }
  const { promise, resolve, reject } = Promise.withResolvers<WorkerResult>();
  const child = spawn(configuration.nodeExecutable, [join(configuration.projectDirectory, "dist", "raycast.js")], {
    cwd: configuration.projectDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let result: WorkerResult | undefined;
  let failure: Error | undefined;
  let stderr = "";
  const abort = () => { child.kill("SIGTERM"); };
  options.signal?.addEventListener("abort", abort, { once: true });
  // Catch an abort that happened between the initial check and listener setup.
  if (options.signal?.aborted) abort();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.on("error", (error: Error) => { failure ??= error; });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "session" && typeof event.sessionId === "string") {
        options.onSession?.(event.sessionId);
      } else if (event.type === "error" && typeof event.message === "string") {
        failure = new Error(event.message);
      } else if (request.type === "ask" && event.type === "answer" && typeof event.sessionId === "string" && typeof event.answer === "string") {
        result = event;
      } else if (request.type === "list" && event.type === "sessions" && Array.isArray(event.sessions) && event.sessions.every(
        (session: SavedSession) => session && typeof session.id === "string" && typeof session.updatedAt === "string" && typeof session.hasConversation === "boolean",
      )) {
        result = event;
      } else if (request.type === "history" && event.type === "history" && typeof event.sessionId === "string" && Array.isArray(event.messages) && event.messages.every(
        (message: ChatMessage) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string",
      )) {
        result = event;
      } else {
        throw new Error("Unexpected response from Jimmy. Rebuild the repository with npm run build.");
      }
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
      child.kill("SIGTERM");
    }
  });
  child.on("error", (error) => {
    failure = new Error(`Could not start Jimmy. If the repository moved or Node.js changed, run npm run dev in the raycast folder to refresh the installation. ${error.message}`);
  });
  child.on("close", (code, signal) => {
    lines.close();
    options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) {
      reject(new DOMException("Request cancelled", "AbortError"));
    } else if (failure) {
      reject(failure);
    } else if (code !== 0 || !result) {
      reject(new Error(stderr.trim() || `Jimmy exited without a complete response (${signal ?? code}). Run npm install in the Jimmy repository, then npm run dev in its raycast folder.`));
    } else {
      resolve(result);
    }
  });
  child.stdin.end(JSON.stringify(request));
  return promise;
}
