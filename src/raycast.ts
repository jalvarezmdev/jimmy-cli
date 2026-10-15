import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JimmyBrowser, type ChatMessage } from './browser.js';
import { createSession, loadSession, type Session } from './sessions.js';

export type WorkerRequest =
  | { type: 'list' }
  | { type: 'ask'; prompt: string; sessionId?: string }
  | { type: 'history'; sessionId: string };

export interface SavedSession {
  id: string;
  updatedAt: string;
  hasConversation: boolean;
}

export type WorkerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'answer'; sessionId: string; answer: string }
  | { type: 'history'; sessionId: string; messages: ChatMessage[] }
  | { type: 'sessions'; sessions: SavedSession[] }
  | { type: 'error'; message: string };

interface WorkerOptions {
  signal?: AbortSignal;
  sessionsDirectory?: string;
  openBrowser?: (session: Session) => Promise<Pick<JimmyBrowser, 'send' | 'getMessages' | 'close'>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('The request was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

export function parseRequest(input: string): WorkerRequest {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (cause) {
    throw new Error('Expected one JSON request on stdin.', { cause });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The request must be a JSON object.');
  }
  const request = value as Record<string, unknown>;
  if (request.type !== 'list' && request.type !== 'ask' && request.type !== 'history') {
    throw new Error('Unknown request type: expected "list", "ask", or "history".');
  }
  const allowed = request.type === 'list' ? ['type']
    : request.type === 'history' ? ['type', 'sessionId'] : ['type', 'prompt', 'sessionId'];
  for (const key of Object.keys(request)) {
    if (!allowed.includes(key)) throw new Error(`Unknown request field: ${key}.`);
  }
  if (request.type === 'list') return { type: 'list' };
  if (request.type === 'history') {
    if (typeof request.sessionId !== 'string' || !UUID.test(request.sessionId)) {
      throw new Error('The sessionId must be a UUID string.');
    }
    return { type: 'history', sessionId: request.sessionId };
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new Error('The prompt must be a non-empty string.');
  }
  if ('sessionId' in request && typeof request.sessionId !== 'string') {
    throw new Error('The sessionId must be a UUID string.');
  }
  return typeof request.sessionId === 'string'
    ? { type: 'ask', prompt: request.prompt, sessionId: request.sessionId }
    : { type: 'ask', prompt: request.prompt };
}

export async function listSessions(
  baseDirectory = join(homedir(), '.jimmy', 'sessions'),
): Promise<SavedSession[]> {
  let entries;
  try {
    entries = await readdir(baseDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions: SavedSession[] = [];
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.length !== 36 || !UUID.test(entry.name)) continue;
    try {
      const session = await loadSession(entry.name, baseDirectory);
      const metadata = await stat(join(session.directory, 'session.json'));
      sessions.push({
        id: session.id,
        updatedAt: metadata.mtime.toISOString(),
        hasConversation: session.chatId !== undefined,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not list session ${entry.name}: ${detail}`, { cause });
    }
  }
  return sessions.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function runRequest(
  request: WorkerRequest,
  emit: (event: WorkerEvent) => void,
  options: WorkerOptions = {},
): Promise<void> {
  const { signal, sessionsDirectory } = options;
  checkCancellation(signal);
  if (request.type === 'list') {
    const sessions = await listSessions(sessionsDirectory);
    checkCancellation(signal);
    emit({ type: 'sessions', sessions });
    return;
  }
  if (request.type === 'ask' && (typeof request.prompt !== 'string' || !request.prompt.trim())) {
    throw new Error('The prompt must be a non-empty string.');
  }
  const session = request.sessionId === undefined
    ? await createSession(sessionsDirectory)
    : await loadSession(request.sessionId, sessionsDirectory);
  checkCancellation(signal);
  if (request.type === 'ask') emit({ type: 'session', sessionId: session.id });

  let browser: Pick<JimmyBrowser, 'send' | 'getMessages' | 'close'> | undefined;
  let closing: Promise<void> | undefined;
  const closeBrowser = (): Promise<void> => {
    if (browser === undefined) return Promise.resolve();
    closing ??= Promise.resolve().then(() => browser!.close());
    return closing;
  };
  const cancel = (): void => { void closeBrowser().catch(() => undefined); };
  signal?.addEventListener('abort', cancel);
  let result: WorkerEvent;
  try {
    checkCancellation(signal);
    // Await an in-flight open even after cancellation so its browser and lock can be closed.
    browser = await (options.openBrowser ?? JimmyBrowser.open)(session);
    checkCancellation(signal);
    result = request.type === 'history'
      ? { type: 'history', sessionId: session.id, messages: await browser.getMessages() }
      : { type: 'answer', sessionId: session.id, answer: await browser.send(request.prompt) };
  } finally {
    try {
      await closeBrowser();
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  checkCancellation(signal);
  emit(result);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = (exitCode: number): void => {
    process.exitCode = exitCode;
    controller.abort();
    process.stdin.destroy();
  };
  const interrupt = (): void => stop(130);
  const terminate = (): void => stop(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const emit = (event: WorkerEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  try {
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    checkCancellation(controller.signal);
    await runRequest(parseRequest(input), emit, { signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', message: controller.signal.aborted ? 'The request was cancelled.' : detail });
    process.exitCode ||= 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
