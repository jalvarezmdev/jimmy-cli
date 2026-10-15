import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Session {
  id: string;
  directory: string;
  chatId?: string;
}

interface Metadata {
  id: string;
  chatId?: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, label: string): void {
  if (value.length !== 36 || !uuidPattern.test(value)) {
    throw new Error(`Invalid ${label}: expected a UUID.`);
  }
}


async function readMetadata(directory: string, id: string): Promise<Metadata> {
  let content: string;
  try {
    content = await readFile(join(directory, 'session.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Unknown session: ${id}.`, { cause: error });
    }
    throw error;
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid metadata for session ${id}.`, { cause: error });
  }
  if (
    typeof metadata !== 'object' || metadata === null || Array.isArray(metadata) ||
    !('id' in metadata) || metadata.id !== id ||
    ('chatId' in metadata && (typeof metadata.chatId !== 'string' || metadata.chatId.length !== 36 || !uuidPattern.test(metadata.chatId)))
  ) {
    throw new Error(`Invalid metadata for session ${id}.`);
  }
  return 'chatId' in metadata
    ? { id, chatId: metadata.chatId as string }
    : { id };
}

async function writeMetadata(directory: string, metadata: Metadata): Promise<void> {
  const temporaryPath = join(directory, `.session-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, join(directory, 'session.json'));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function createSession(baseDirectory = join(homedir(), '.jimmy', 'sessions')): Promise<Session> {
  await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const directory = join(baseDirectory, id);
  await mkdir(directory, { mode: 0o700 });
  try {
    await writeMetadata(directory, { id });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { id, directory };
}

export async function loadSession(id: string, baseDirectory = join(homedir(), '.jimmy', 'sessions')): Promise<Session> {
  requireUuid(id, 'session id');
  const directory = join(baseDirectory, id);
  const metadata = await readMetadata(directory, id);
  return { ...metadata, directory };
}

export async function saveChatId(session: Session, chatId: string): Promise<void> {
  requireUuid(session.id, 'session id');
  requireUuid(chatId, 'chat id');
  await readMetadata(session.directory, session.id);
  await writeMetadata(session.directory, { id: session.id, chatId });
  session.chatId = chatId;
}
