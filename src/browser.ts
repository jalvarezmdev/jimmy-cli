import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import lockfile from 'proper-lockfile';
import { saveChatId, type Session } from './sessions.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface BrowserOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

interface TransportOutcome {
  error?: Error;
  text?: string;
}

interface TransportState {
  request?: Request;
  response?: Response;
  outcome?: TransportOutcome;
}

interface ReplySnapshot {
  idle: boolean;
  complete: boolean;
}

interface ChatIdentity {
  routeId: string | null;
  storedIds: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPOSER = 'textarea[name="message"]';
const SEND = 'button[title="Send"]';
const ASSISTANT = '#scroller img[alt="Chat Jimmy"]';

export class JimmyBrowser {
  private closing: Promise<void> | undefined;
  private persistenceFailure: Error | undefined;
  private sending = false;

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly session: Session,
    private readonly baseUrl: URL,
    private readonly timeoutMs: number,
    private readonly releaseLock: () => Promise<void>,
  ) {}

  static async open(session: Session, options: BrowserOptions = {}): Promise<JimmyBrowser> {
    const baseUrl = new URL(options.baseUrl ?? 'https://chatjimmy.ai');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('The browser timeout must be a positive finite number.');
    }
    if (session.chatId !== undefined && !UUID.test(session.chatId)) {
      throw new Error('The saved website chat ID is invalid.');
    }

    let releaseLock: () => Promise<void>;
    try {
      releaseLock = await lockfile.lock(session.directory, {
        lockfilePath: join(session.directory, 'session.lock'),
        retries: 0,
      });
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ELOCKED') {
        throw new Error(`Session ${session.id} is already open in another jimmy process. Close it before resuming.`, { cause });
      }
      throw cause;
    }

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(join(session.directory, 'browser'), {
        headless: true,
        timeout: timeoutMs,
      });
    } catch (cause) {
      await releaseLock();
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/ProcessSingleton|SingletonLock|profile.*(?:in use|already)|user data directory.*in use/i.test(message)) {
        throw new Error(`Session ${session.id} is already open in another Chromium process. Close that jimmy process before resuming.`, { cause });
      }
      throw new Error(`Could not launch Chromium: ${message}`, { cause });
    }

    try {
      context.setDefaultTimeout(timeoutMs);
      const page = context.pages()[0] ?? await context.newPage();
      const target = new URL(session.chatId === undefined ? '/' : `/chats/${session.chatId}`, baseUrl);
      const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (response !== null && !response.ok()) {
        throw new Error(`ChatJimmy returned HTTP ${response.status()} while opening the chat.`);
      }
      await page.locator(COMPOSER).waitFor({ state: 'visible' });
      // The client-only Ready label avoids interacting with an unhydrated composer.
      await page.getByText('Ready', { exact: true }).waitFor({ state: 'visible' });
      await page.locator(SEND).waitFor({ state: 'attached' });

      if (session.chatId !== undefined) {
        const chatId = session.chatId;
        try {
          await page.waitForFunction((id) => {
            if (location.pathname !== `/chats/${id}`) return false;
            const raw = localStorage.getItem(`chat_${id}`);
            if (raw === null) return false;
            let history: unknown;
            try { history = JSON.parse(raw); } catch { return false; }
            if (!Array.isArray(history) || history.length === 0) return false;
            const roles: string[] = [];
            for (const message of history) {
              if (message === null || typeof message !== 'object' || typeof message.content !== 'string') return false;
              if (message.role === 'system') continue;
              if (message.role !== 'user' && message.role !== 'assistant') return false;
              roles.push(message.role);
            }
            if (!roles.includes('user')) return false;
            const images = [...document.querySelectorAll('#scroller img[alt="User"], #scroller img[alt="Chat Jimmy"]')];
            return images.length === roles.length && images.every((image, index) => (
              image.getAttribute('alt') === (roles[index] === 'user' ? 'User' : 'Chat Jimmy')
            ));
          }, chatId, { timeout: timeoutMs });
        } catch (cause) {
          throw new Error(`Saved website chat ${chatId} is missing, corrupt, or did not finish loading. No new chat was created.`, { cause });
        }
      }
      return new JimmyBrowser(context, page, session, baseUrl, timeoutMs, releaseLock);
    } catch (cause) {
      await context.close().catch(() => undefined);
      await releaseLock();
      throw cause;
    }
  }

  async send(prompt: string): Promise<string> {
    if (this.closing !== undefined) throw new Error('The ChatJimmy browser is closed.');
    if (this.sending) throw new Error('Wait for the current ChatJimmy reply before sending another prompt.');
    if (!prompt.trim()) throw new Error('The prompt must not be empty.');
    this.sending = true;
    const deadline = Date.now() + this.timeoutMs;
    const transport: TransportState = {};
    let baselineKeys = new Set<string>();
    let persistenceError: unknown;
    let failed = false;

    const captureRequest = (candidate: Request): void => {
      const url = new URL(candidate.url());
      if (transport.request === undefined && candidate.method() === 'POST' && url.origin === this.baseUrl.origin && url.pathname === '/api/chat') {
        transport.request = candidate;
      }
    };
    const captureResponse = (candidate: Response): void => {
      if (candidate.request() !== transport.request) return;
      transport.response = candidate;
      if (!candidate.ok()) {
        transport.outcome = { error: new Error(`ChatJimmy returned HTTP ${candidate.status()}; no complete reply was received.`) };
      }
    };
    const captureFailure = (candidate: Request): void => {
      if (candidate === transport.request) {
        transport.outcome = { error: new Error(`ChatJimmy's reply transport failed: ${candidate.failure()?.errorText ?? 'request aborted'}.`) };
      }
    };
    const captureFinished = (candidate: Request): void => {
      if (candidate !== transport.request || transport.outcome !== undefined) return;
      const completedResponse = transport.response;
      if (completedResponse === undefined) {
        transport.outcome = { error: new Error('ChatJimmy finished the request without a response.') };
        return;
      }
      // Read only the response caused by the UI. This never issues an API request.
      void completedResponse.text().then((text) => {
        transport.outcome = { text };
      }).catch((cause: unknown) => {
        transport.outcome = { error: new Error('ChatJimmy failed while reading the reply stream.', { cause }) };
      });
    };

    try {
      const baseline = await this.page.evaluate(() => ({
        keys: Object.keys(localStorage).filter((key) => key.startsWith('chat_')),
        assistants: document.querySelectorAll('#scroller img[alt="Chat Jimmy"]').length,
        users: document.querySelectorAll('#scroller img[alt="User"]').length,
      }));
      baselineKeys = new Set(baseline.keys);
      if (await this.page.locator(COMPOSER).isDisabled()) {
        throw new Error('This ChatJimmy conversation cannot accept more messages.');
      }
      await this.page.locator(COMPOSER).fill(prompt, { timeout: Math.max(1, deadline - Date.now()) });
      // Subscribe before clicking: real replies can finish before click() resolves.
      this.page.on('request', captureRequest);
      this.page.on('response', captureResponse);
      this.page.on('requestfailed', captureFailure);
      this.page.on('requestfinished', captureFinished);
      await this.page.locator(SEND).click({ timeout: Math.max(1, deadline - Date.now()) });

      let answerText: string | undefined;
      let completionError: Error | undefined;
      while (Date.now() < deadline) {
        await this.persistChatIdentity(baselineKeys);
        const pendingError = transport.outcome?.error ?? completionError;
        if (pendingError !== undefined) {
          // Let the UI finish its own failure handling and local history writes.
          if (await this.page.locator(SEND).count() > 0) throw pendingError;
        } else if (transport.outcome?.text !== undefined && answerText === undefined) {
          const trailer = /<\|stats\|>([\s\S]+?)<\|\/stats\|>\s*$/.exec(transport.outcome.text);
          if (trailer?.[1] === undefined) {
            completionError = new Error('ChatJimmy ended its reply without the completion trailer; the partial answer was not returned.');
          } else {
            let stats: unknown;
            try { stats = JSON.parse(trailer[1]); } catch (cause) {
              completionError = new Error('ChatJimmy returned an invalid completion trailer.', { cause });
            }
            if (completionError === undefined && (stats === null || typeof stats !== 'object' || !('done' in stats) || stats.done !== true || !('status' in stats) || stats.status !== 0)) {
              completionError = new Error('ChatJimmy reported an unsuccessful or unfinished generation; the partial answer was not returned.');
            }
            if (completionError === undefined) answerText = transport.outcome.text.slice(0, trailer.index);
          }
        }
        if (answerText !== undefined && pendingError === undefined) {
          const snapshot: ReplySnapshot = await this.page.evaluate(({ assistantSelector, sendSelector, previousAssistants, previousUsers }) => {
            const assistants = [...document.querySelectorAll(assistantSelector)];
            const row = assistants[previousAssistants]?.closest('.flex.flex-1');
            const body = row?.querySelector<HTMLElement>('.whitespace-pre-wrap.break-words');
            const idle = document.querySelector(sendSelector) !== null;
            const complete = assistants.length === previousAssistants + 1
              && document.querySelectorAll('#scroller img[alt="User"]').length === previousUsers + 1
              && row?.querySelector('[aria-label="generation stats"]') != null
              && row?.querySelector('[aria-label="Typing"]') === null
              && body != null;
            return { idle, complete };
          }, { assistantSelector: ASSISTANT, sendSelector: SEND, previousAssistants: baseline.assistants, previousUsers: baseline.users });
          if (snapshot.complete && snapshot.idle) {
            if (!answerText.trim()) throw new Error('ChatJimmy completed a new reply with no answer text.');
            await this.persistChatIdentity(baselineKeys);
            if (this.session.chatId !== undefined) return answerText;
          }
        }
        await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      }
      if (completionError !== undefined) throw completionError;
      if (transport.outcome?.error !== undefined) throw transport.outcome.error;
      throw new Error(transport.request === undefined
        ? 'Timed out waiting for ChatJimmy to submit the prompt. It was not resent.'
        : 'Timed out waiting for a complete new ChatJimmy reply. No partial answer was returned and the prompt was not resent.');
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      this.page.off('request', captureRequest);
      this.page.off('response', captureResponse);
      this.page.off('requestfailed', captureFailure);
      this.page.off('requestfinished', captureFinished);
      // The website may have created the chat even when its answer subsequently failed.
      try { await this.persistChatIdentity(baselineKeys); } catch (cause) { persistenceError = cause; }
      this.sending = false;
      if (failed || persistenceError !== undefined) await this.close().catch(() => undefined);
      if (persistenceError !== undefined) throw persistenceError;
    }
  }

  async getMessages(): Promise<ChatMessage[]> {
    if (this.closing !== undefined) throw new Error('The ChatJimmy browser is closed.');
    if (this.session.chatId === undefined) return [];
    const chatId = this.session.chatId;
    const raw = await this.page.evaluate((id) => localStorage.getItem(`chat_${id}`), chatId);
    if (raw === null) throw new Error(`Saved website chat ${chatId} is missing.`);
    let history: unknown;
    try {
      history = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Saved website chat ${chatId} is corrupt.`, { cause });
    }
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error(`Saved website chat ${chatId} is corrupt.`);
    }
    const messages: ChatMessage[] = [];
    for (const entry of history) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.content !== 'string'
        || (entry.role !== 'system' && entry.role !== 'user' && entry.role !== 'assistant')) {
        throw new Error(`Saved website chat ${chatId} contains an invalid message.`);
      }
      if (entry.role !== 'system') messages.push({ role: entry.role, content: entry.content });
    }
    if (!messages.some((message) => message.role === 'user')) {
      throw new Error(`Saved website chat ${chatId} is corrupt: no user messages.`);
    }
    return messages;
  }

  close(): Promise<void> {
    this.closing ??= this.context.close().finally(this.releaseLock);
    return this.closing;
  }

  private async persistChatIdentity(baselineKeys: ReadonlySet<string>): Promise<void> {
    if (this.persistenceFailure !== undefined) throw this.persistenceFailure;
    if (this.session.chatId !== undefined) return;
    const identity: ChatIdentity = await this.page.evaluate(() => ({
      routeId: /^\/chats\/([^/]+)\/?$/.exec(location.pathname)?.[1] ?? null,
      storedIds: Object.keys(localStorage).filter((key) => key.startsWith('chat_')),
    }));
    const createdIds = identity.storedIds.filter((key) => !baselineKeys.has(key)).map((key) => key.slice(5)).filter((id) => UUID.test(id));
    const id = identity.routeId !== null && UUID.test(identity.routeId) ? identity.routeId : createdIds.length === 1 ? createdIds[0] : undefined;
    if (id !== undefined) {
      try {
        await saveChatId(this.session, id);
      } catch (cause) {
        this.persistenceFailure = new Error(`Could not save website chat ${id} for session ${this.session.id}.`, { cause });
        throw this.persistenceFailure;
      }
    }
  }
}
