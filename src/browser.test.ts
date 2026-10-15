import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { JimmyBrowser } from './browser.js';
import { createSession, loadSession } from './sessions.js';

interface FixtureRequest {
  prompt: string;
  historyCount: number;
}

interface ChatFixture {
  baseUrl: string;
  requests: FixtureRequest[];
  root: string;
  browsers: JimmyBrowser[];
}

const SUCCESS_TRAILER = '<|stats|>{"done":true,"status":0}<|/stats|>';
const FORMATTED_ANSWER = 'Start\n\n```js\n  const first = 1;\n  const second = 2;\n```\n\nEnd';
const PARAGRAPH_CODE = '``\nfunction add(a, b) {\n  return a + b;\n}\n```\n';

async function createFixture(t: TestContext): Promise<ChatFixture> {
  const requests: FixtureRequest[] = [];
  const browsers: JimmyBrowser[] = [];
  const html = String.raw`<!doctype html><html><head><style>
    .whitespace-pre-wrap { white-space: pre-wrap; }
    pre { white-space: pre; }
  </style></head><body><span>Ready</span><div id="messages"></div>
    <form><textarea name="message"></textarea><button title="Send" type="submit">Send</button></form>
    <script>
    const trailer = ${JSON.stringify(SUCCESS_TRAILER)};
    const formattedAnswer = ${JSON.stringify(FORMATTED_ANSWER)};
    const paragraphCode = ${JSON.stringify(PARAGRAPH_CODE)};
    const form = document.querySelector('form');
    const textarea = document.querySelector('textarea');
    let id = /^\/chats\/([^/]+)$/.exec(location.pathname)?.[1];
    let messages = [];
    let controller;
    function save() { localStorage.setItem('chat_' + id, JSON.stringify(messages)); }
    function render(loading = false) {
      const host = document.querySelector('#messages');
      host.replaceChildren();
      const scroller = document.createElement('div');
      scroller.id = 'scroller';
      for (const message of messages) {
        const row = document.createElement('div');
        row.className = 'flex flex-1';
        const avatar = document.createElement('img');
        avatar.alt = message.role === 'user' ? 'User' : 'Chat Jimmy';
        const name = document.createElement('div');
        name.textContent = message.role === 'user' ? 'You' : 'Jimmy';
        const body = document.createElement('div');
        body.className = 'whitespace-pre-wrap break-words';
        if (message.content === formattedAnswer) {
          const before = document.createElement('p');
          before.textContent = 'Start';
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = '  const first = 1;\n  const second = 2;';
          const copy = document.createElement('button');
          copy.textContent = 'Copy';
          pre.append(code, copy);
          const after = document.createElement('p');
          after.textContent = 'End';
          body.append(before, pre, after);
        } else {
          body.textContent = message.content;
          if (message.content === paragraphCode) body.style.whiteSpace = 'normal';
        }
        row.append(avatar, name, body);
        if (message.stats) {
          const badge = document.createElement('div');
          badge.setAttribute('aria-label', 'generation stats');
          badge.textContent = 'Generated in 0.001s 🔥✨';
          row.append(badge);
        }
        const footer = document.createElement('div');
        footer.textContent = 'Regenerate Edit';
        row.append(footer);
        scroller.append(row);
      }
      host.append(scroller);
      form.querySelector('button').remove();
      const button = document.createElement('button');
      if (loading) {
        button.type = 'button';
        button.textContent = 'Stop';
        button.onclick = () => controller.abort();
      } else {
        button.type = 'submit';
        button.title = 'Send';
        button.textContent = 'Send';
      }
      form.append(button);
    }
    if (id) {
      // Real Chromium hydration must cross a platform-clock delay; Node fake timers cannot drive its page clock.
      setTimeout(() => {
        messages = JSON.parse(localStorage.getItem('chat_' + id) || '[]');
        render();
      }, 250);
    } else {
      render();
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const prompt = textarea.value;
      const historyCount = messages.length;
      id ||= crypto.randomUUID();
      messages.push({ role: 'user', content: prompt });
      save();
      textarea.value = '';
      controller = new AbortController();
      render(true);
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, historyCount }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let answer;
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          text += decoder.decode(result.value, { stream: true });
          if (prompt !== 'old-only') {
            if (!answer) {
              answer = { role: 'assistant', content: '', stats: false };
              messages.push(answer);
            }
            answer.content = text.replace(/<\|stats\|>[\s\S]*$/, '');
            // A deceptive UI can look complete while the response is still open.
            answer.stats = prompt === 'hang' && text.endsWith(trailer);
          }
          render(prompt !== 'hang');
        }
        if (answer) {
          answer.stats = /<\|stats\|>[\s\S]+<\|\/stats\|>$/.test(text) && prompt !== 'no-badge';
        }
        save();
      } catch {
        // Match the real UI: failures restore Send without a completion badge.
      } finally {
        render();
      }
    });
    </script></body></html>`;

  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/chat') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const submitted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FixtureRequest;
      requests.push(submitted);
      if (submitted.prompt === '503') {
        response.writeHead(503);
        response.end('Unavailable');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      if (submitted.prompt === 'abort') {
        response.write('Partial answer', () => response.destroy());
        return;
      }
      if (submitted.prompt === 'truncated') {
        response.end('Partial answer without trailer');
        return;
      }
      if (submitted.prompt === 'bad-stats') {
        response.end('Unsuccessful answer<|stats|>{"done":true,"status":1}<|/stats|>');
        return;
      }
      if (submitted.prompt === 'hang') {
        response.write('Apparently finished' + SUCCESS_TRAILER);
        return;
      }
      if (submitted.prompt === 'slow') {
        // Exercise a real HTTP streaming pause, not a mocked Node timer or a guessed test sleep.
        response.write('Partial');
        const timer = setTimeout(() => response.end(' complete' + SUCCESS_TRAILER), 350);
        response.on('close', () => clearTimeout(timer));
        return;
      }
      const text = submitted.prompt === 'format' ? FORMATTED_ANSWER
        : submitted.prompt === 'paragraph-code' ? PARAGRAPH_CODE
        : submitted.prompt === 'empty' ? ''
        : 'The conversation contains ' + submitted.historyCount + ' earlier messages.';
      response.end(text + SUCCESS_TRAILER);
    })().catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'jimmy-browser-'));
  t.after(async () => {
    await Promise.all(browsers.map((browser) => browser.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(root, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    root,
    browsers,
  };
}

test('fast UI replies, code extraction, two turns, and persistent-profile resume', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const session = await createSession(root);
  const browser = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(browser);
  const answer = await browser.send('format');
  assert.equal(answer, FORMATTED_ANSWER);
  assert.equal(await browser.send('second'), 'The conversation contains 2 earlier messages.');
  const saved = await loadSession(session.id, root);
  assert.match(saved.chatId ?? '', /^[0-9a-f-]{36}$/i);
  const closing = browser.close();
  assert.strictEqual(browser.close(), closing);
  await closing;

  const resumed = await JimmyBrowser.open(saved, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(resumed);
  assert.equal(await resumed.send('third'), 'The conversation contains 4 earlier messages.');
  assert.deepEqual(fixture.requests.map((request) => request.historyCount), [0, 2, 4]);
});

test('a text pause is not completion', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const browser = await JimmyBrowser.open(await createSession(root), { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(browser);
  assert.equal(await browser.send('slow'), 'Partial complete');
  assert.equal(fixture.requests.length, 1);
});

test('original code indentation survives collapsed paragraph rendering', async (t) => {
  const fixture = await createFixture(t);
  const browser = await JimmyBrowser.open(await createSession(fixture.root), { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(browser);
  assert.equal(await browser.send('paragraph-code'), PARAGRAPH_CODE);
});

test('failures never return partial replies or reuse an old badge, and never resend', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const cases: Record<string, RegExp> = {
    '503': /HTTP 503/,
    abort: /transport failed|reading the reply stream/,
    truncated: /without the completion trailer/,
    'bad-stats': /unsuccessful or unfinished/,
    empty: /no answer text/,
    'no-badge': /Timed out/,
    'old-only': /Timed out/,
    hang: /Timed out/,
  };
  for (const [prompt, error] of Object.entries(cases)) {
    await t.test(prompt, async () => {
      const session = await createSession(root);
      const browser = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 3_000 });
      fixture.browsers.push(browser);
      try {
        assert.equal(await browser.send('seed'), 'The conversation contains 0 earlier messages.');
        const before = fixture.requests.length;
        await assert.rejects(browser.send(prompt), error);
        assert.equal(fixture.requests.length, before + 1);
        assert.equal((await loadSession(session.id, root)).chatId, session.chatId);
        await assert.rejects(browser.send('must-not-submit'), /closed/);
      } finally {
        await browser.close();
      }
    });
  }
});

test('failed first answers still persist the website chat ID', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const session = await createSession(root);
  const browser = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(browser);
  await assert.rejects(browser.send('truncated'), /without the completion trailer/);
  assert.match((await loadSession(session.id, root)).chatId ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(fixture.requests.length, 1);
});

test('metadata save failures surface instead of returning an answer', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const session = await createSession(root);
  const browser = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(browser);
  await rm(join(session.directory, 'session.json'));
  await assert.rejects(browser.send('format'), /Could not save website chat/);
  assert(fixture.requests.length <= 1);
});

test('missing history fails closed and releases its Chromium profile', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const session = await createSession(root);
  await assert.rejects(JimmyBrowser.open({ ...session, chatId: randomUUID() }, { baseUrl: fixture.baseUrl, timeoutMs: 3_000 }), /missing, corrupt, or did not finish loading/);
  assert.equal(fixture.requests.length, 0);
  const reopened = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(reopened);
  await reopened.close();
});

test('an in-use dedicated profile gets a useful error', async (t) => {
  const fixture = await createFixture(t);
  const root = fixture.root;
  const session = await createSession(root);
  const browser = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(browser);
  await assert.rejects(async () => {
    const duplicate = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
    fixture.browsers.push(duplicate);
  }, /already open in another jimmy process/);
  assert.equal(await browser.send('while-locked'), 'The conversation contains 0 earlier messages.');
  await browser.close();
  const reopened = await JimmyBrowser.open(session, { baseUrl: fixture.baseUrl, timeoutMs: 5_000 });
  fixture.browsers.push(reopened);
  assert.equal(await reopened.send('after-release'), 'The conversation contains 2 earlier messages.');
});
