import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { listSessions, parseRequest, runRequest, type WorkerEvent } from './raycast.js';
import { createSession, saveChatId } from './sessions.js';

const chatId = '12345678-1234-4234-8234-123456789abc';

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jimmy-raycast-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('request parsing accepts only the three exact request shapes', () => {
  assert.deepEqual(parseRequest('{"type":"list"}\n'), { type: 'list' });
  assert.deepEqual(parseRequest('{"type":"ask","prompt":"  hello  "}'), { type: 'ask', prompt: '  hello  ' });
  assert.deepEqual(parseRequest(JSON.stringify({ type: 'ask', prompt: 'hello', sessionId: chatId })), {
    type: 'ask', prompt: 'hello', sessionId: chatId,
  });
  assert.deepEqual(parseRequest(JSON.stringify({ type: 'history', sessionId: chatId })), {
    type: 'history', sessionId: chatId,
  });
  for (const input of [
    '', '{}', 'null', '[]', '{"type":"unknown"}', '{"type":"list","prompt":"hello"}',
    '{"type":"ask"}', '{"type":"ask","prompt":1}', '{"type":"ask","prompt":"  "}',
    '{"type":"ask","prompt":"hello","sessionId":null}',
    '{"type":"ask","prompt":"hello","baseUrl":"https://example.com"}',
    '{"type":"list"}\n{"type":"list"}',
    '{"type":"history"}', '{"type":"history","sessionId":null}',
    '{"type":"history","sessionId":"invalid"}',
    '{"type":"history","sessionId":"12345678-1234-4234-8234-123456789abc","prompt":"hello"}',
  ]) {
    assert.throws(() => parseRequest(input), input);
  }
});

test('listing ignores non-session entries and sorts metadata timestamps with a stable UUID tie-break', async (t) => {
  const root = await temporaryDirectory(t);
  assert.deepEqual(await listSessions(join(root, 'missing')), []);
  const first = await createSession(root);
  const second = await createSession(root);
  const newest = await createSession(root);
  await saveChatId(first, chatId);
  await mkdir(join(root, 'not-a-session'));
  await writeFile(join(root, chatId), 'not a directory');
  const older = new Date('2026-01-01T00:00:00.000Z');
  const newer = new Date('2026-02-01T00:00:00.000Z');
  await utimes(join(first.directory, 'session.json'), older, older);
  await utimes(join(second.directory, 'session.json'), older, older);
  await utimes(join(newest.directory, 'session.json'), newer, newer);
  const tied = [
    { id: first.id, updatedAt: older.toISOString(), hasConversation: true },
    { id: second.id, updatedAt: older.toISOString(), hasConversation: false },
  ].sort((a, b) => a.id < b.id ? -1 : 1);
  assert.deepEqual(await listSessions(root), [
    { id: newest.id, updatedAt: newer.toISOString(), hasConversation: false },
    ...tied,
  ]);
});

test('a corrupt UUID session fails listing with its identity instead of disappearing', async (t) => {
  const root = await temporaryDirectory(t);
  const session = await createSession(root);
  await writeFile(join(session.directory, 'session.json'), '{');
  await assert.rejects(listSessions(root), new RegExp(`Could not list session ${session.id}: Invalid metadata`));
  await rm(join(session.directory, 'session.json'));
  await assert.rejects(listSessions(root), new RegExp(`Could not list session ${session.id}: Unknown session`));
});

test('resuming emits the session before open and preserves the answer only after close finishes', async (t) => {
  const root = await temporaryDirectory(t);
  const session = await createSession(root);
  await saveChatId(session, chatId);
  const events: WorkerEvent[] = [];
  const closeStarted = Promise.withResolvers<void>();
  const allowClose = Promise.withResolvers<void>();
  const answer = 'First paragraph\n\n```js\n  const value = 1;\n```';
  const pending = runRequest({ type: 'ask', prompt: 'follow up', sessionId: session.id }, (event) => events.push(event), {
    sessionsDirectory: root,
    openBrowser: async (loaded) => {
      assert.equal(loaded.chatId, chatId);
      assert.deepEqual(events, [{ type: 'session', sessionId: session.id }]);
      return {
        getMessages: async () => { throw new Error('Unexpected history read.'); },
        send: async (prompt) => {
          assert.equal(prompt, 'follow up');
          return answer;
        },
        close: async () => {
          closeStarted.resolve();
          await allowClose.promise;
        },
      };
    },
  });
  await closeStarted.promise;
  assert.deepEqual(events, [{ type: 'session', sessionId: session.id }]);
  allowClose.resolve();
  await pending;
  assert.deepEqual(events, [
    { type: 'session', sessionId: session.id },
    { type: 'answer', sessionId: session.id, answer },
  ]);
});

test('unknown sessions fail before browser open without creating a replacement', async (t) => {
  const root = await temporaryDirectory(t);
  const events: WorkerEvent[] = [];
  for (const request of [
    { type: 'ask', prompt: 'hello', sessionId: chatId },
    { type: 'history', sessionId: chatId },
  ] as const) {
    await assert.rejects(runRequest(request, (event) => events.push(event), {
      sessionsDirectory: root,
      openBrowser: async () => { throw new Error('Must not open an unknown session.'); },
    }), /Unknown session/);
  }
  assert.deepEqual(events, []);
  assert.deepEqual(await listSessions(root), []);
});

for (const failure of ['send', 'close'] as const) {
  test(`${failure} failures close the browser and never emit an answer`, async (t) => {
    const root = await temporaryDirectory(t);
    const events: WorkerEvent[] = [];
    let closes = 0;
    await assert.rejects(runRequest({ type: 'ask', prompt: 'hello' }, (event) => events.push(event), {
      sessionsDirectory: root,
      openBrowser: async () => ({
        getMessages: async () => { throw new Error('Unexpected history read.'); },
        send: async () => {
          if (failure === 'send') throw new Error('Send failed.');
          return 'answer';
        },
        close: async () => {
          closes += 1;
          if (failure === 'close') throw new Error('Close failed.');
        },
      }),
    }), failure === 'send' ? /Send failed/ : /Close failed/);
    assert.equal(closes, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'session');
  });
}

test('cancellation during open waits for the handle, then closes it without sending', async (t) => {
  const root = await temporaryDirectory(t);
  const controller = new AbortController();
  const events: WorkerEvent[] = [];
  const openStarted = Promise.withResolvers<void>();
  const allowOpen = Promise.withResolvers<void>();
  let closes = 0;
  let sends = 0;
  const pending = runRequest({ type: 'ask', prompt: 'hello' }, (event) => events.push(event), {
    sessionsDirectory: root,
    signal: controller.signal,
    openBrowser: async () => {
      openStarted.resolve();
      await allowOpen.promise;
      return {
        getMessages: async () => { throw new Error('Unexpected history read.'); },
        send: async () => { sends += 1; return 'answer'; },
        close: async () => { closes += 1; },
      };
    },
  });
  await openStarted.promise;
  controller.abort();
  allowOpen.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sends, 0);
  assert.equal(closes, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'session');
});

test('cancellation closes an active send exactly once and suppresses its eventual answer', async (t) => {
  const root = await temporaryDirectory(t);
  const controller = new AbortController();
  const events: WorkerEvent[] = [];
  const sendStarted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<string>();
  let closes = 0;
  const pending = runRequest({ type: 'ask', prompt: 'hello' }, (event) => events.push(event), {
    sessionsDirectory: root,
    signal: controller.signal,
    openBrowser: async () => ({
      getMessages: async () => { throw new Error('Unexpected history read.'); },
      send: async () => {
        sendStarted.resolve();
        return reply.promise;
      },
      close: async () => {
        closes += 1;
        reply.resolve('answer received while closing');
      },
    }),
  });
  await sendStarted.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(closes, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'session');
});

for (const failure of ['history', 'close'] as const) {
  test(`history ${failure} failures close exactly once and suppress success`, async (t) => {
    const root = await temporaryDirectory(t);
    const session = await createSession(root);
    const events: WorkerEvent[] = [];
    let closes = 0;
    await assert.rejects(runRequest({ type: 'history', sessionId: session.id }, (event) => events.push(event), {
      sessionsDirectory: root,
      openBrowser: async () => ({
        send: async () => { throw new Error('History must not submit a prompt.'); },
        getMessages: async () => {
          if (failure === 'history') throw new Error('Saved history is corrupt.');
          return [];
        },
        close: async () => {
          closes += 1;
          if (failure === 'close') throw new Error('Close failed.');
        },
      }),
    }), failure === 'history' ? /Saved history is corrupt/ : /Close failed/);
    assert.equal(closes, 1);
    assert.deepEqual(events, []);
  });
}

test('cancelling an active history read closes once and suppresses the result', async (t) => {
  const root = await temporaryDirectory(t);
  const session = await createSession(root);
  const controller = new AbortController();
  const events: WorkerEvent[] = [];
  const started = Promise.withResolvers<void>();
  const history = Promise.withResolvers<[]>();
  let closes = 0;
  const pending = runRequest({ type: 'history', sessionId: session.id }, (event) => events.push(event), {
    sessionsDirectory: root,
    signal: controller.signal,
    openBrowser: async () => ({
      send: async () => { throw new Error('History must not submit a prompt.'); },
      getMessages: async () => {
        started.resolve();
        return history.promise;
      },
      close: async () => {
        closes += 1;
        history.resolve([]);
      },
    }),
  });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(closes, 1);
  assert.deepEqual(events, []);
});
