import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createSession, loadSession, saveChatId } from './sessions.js';

const chatId = '12345678-1234-4234-8234-123456789abc';
const otherId = '87654321-4321-4321-8321-cba987654321';

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jimmy-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('new sessions have distinct UUIDs, directories, and independent metadata', async (t) => {
  const root = await temporaryDirectory(t);
  const base = join(root, 'sessions');
  const first = await createSession(base);
  const second = await createSession(base);

  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.directory, join(base, first.id));
  assert.equal(second.directory, join(base, second.id));
  assert.deepEqual(JSON.parse(await readFile(join(first.directory, 'session.json'), 'utf8')), { id: first.id });
  assert.deepEqual(await loadSession(first.id, base), first);

  await saveChatId(first, chatId);
  assert.deepEqual(await loadSession(second.id, base), second);
  assert.equal(second.chatId, undefined);
  if (process.platform !== 'win32') {
    assert.equal((await stat(base)).mode & 0o777, 0o700);
    assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.directory, 'session.json'))).mode & 0o777, 0o600);
  }
});

test('saved chat ids update the object and survive reloading and replacement', async (t) => {
  const base = await temporaryDirectory(t);
  const session = await createSession(base);
  await saveChatId(session, chatId);
  assert.equal(session.chatId, chatId);
  assert.deepEqual(await loadSession(session.id, base), session);
  assert.deepEqual(JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8')), {
    id: session.id,
    chatId,
  });

  await saveChatId(session, otherId);
  assert.equal(session.chatId, otherId);
  assert.equal((await loadSession(session.id, base)).chatId, otherId);
  assert.deepEqual(await readdir(session.directory), ['session.json']);
});

test('invalid session ids are rejected without creating directories', async (t) => {
  const base = await temporaryDirectory(t);
  for (const id of ['', '../escape', `${chatId}/../escape`, `/tmp/${chatId}`, `${chatId}\n`, 'not-a-uuid']) {
    await assert.rejects(loadSession(id, base), /Invalid session id/);
  }
  assert.deepEqual(await readdir(base), []);
});

test('unknown sessions and missing metadata fail instead of creating sessions', async (t) => {
  const base = await temporaryDirectory(t);
  await assert.rejects(loadSession(otherId, base), /Unknown session/);
  assert.deepEqual(await readdir(base), []);

  const session = await createSession(base);
  await rm(join(session.directory, 'session.json'));
  await assert.rejects(loadSession(session.id, base), /Unknown session/);
  await assert.rejects(saveChatId(session, chatId), /Unknown session/);
  assert.equal(session.chatId, undefined);
  assert.deepEqual(await readdir(session.directory), []);
});

for (const [name, value] of [
  ['broken JSON', '{'],
  ['null metadata', 'null'],
  ['array metadata', '[]'],
  ['missing id', '{}'],
  ['mismatched id', JSON.stringify({ id: otherId })],
] as const) {
  test(`loading rejects ${name}`, async (t) => {
    const base = await temporaryDirectory(t);
    const session = await createSession(base);
    await writeFile(join(session.directory, 'session.json'), value);
    await assert.rejects(loadSession(session.id, base), /Invalid metadata/);
  });
}

test('unsafe persisted chat ids cannot be loaded or overwritten as valid sessions', async (t) => {
  const base = await temporaryDirectory(t);
  const session = await createSession(base);
  for (const unsafe of ['../escape', 'https://example.com', `${chatId}?redirect=evil`, `${chatId}\n`, '', null, 42]) {
    await writeFile(join(session.directory, 'session.json'), JSON.stringify({ id: session.id, chatId: unsafe }));
    await assert.rejects(loadSession(session.id, base), /Invalid metadata/);
    await assert.rejects(saveChatId(session, chatId), /Invalid metadata/);
    assert.equal(session.chatId, undefined);
  }
});

test('invalid updates leave both the saved chat id and the session object unchanged', async (t) => {
  const base = await temporaryDirectory(t);
  const session = await createSession(base);
  await saveChatId(session, chatId);
  for (const unsafe of ['../escape', '//example.com', `${chatId}/other`, `${chatId}#fragment`, `${chatId}\n`, '']) {
    await assert.rejects(saveChatId(session, unsafe), /Invalid chat id/);
    assert.equal(session.chatId, chatId);
    assert.equal((await loadSession(session.id, base)).chatId, chatId);
  }
});
