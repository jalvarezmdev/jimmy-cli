#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface, type Interface } from 'node:readline';
import { JimmyBrowser } from './browser.js';
import { createSession, loadSession } from './sessions.js';

const banner = String.raw`   __  __  _  _  _  _  _  _ 
 _(  )(  )( \/ )( \/ )( \/ )
/ \) \ )( / \/ \/ \/ \ )  / 
\____/(__)\_)(_/\_)(_/(__/`;

interface CliArguments {
  ask?: string;
  session?: string;
}
const usage = 'Usage: jimmy | jimmy --ask "prompt" | jimmy --session <uuid>';

function argumentsForRun(): CliArguments {
  const { values, tokens } = parseArgs({
    options: { ask: { type: 'string' }, session: { type: 'string' } },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  if (tokens.length > 1) {
    throw new Error('Choose exactly one of --ask or --session.');
  }
  if (values.ask !== undefined && !values.ask.trim()) {
    throw new Error('--ask requires a non-empty prompt.');
  }
  if (values.session !== undefined && !values.session.trim()) {
    throw new Error('--session requires a session UUID.');
  }
  return values;
}

async function main(): Promise<void> {
  const color = process.stderr.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
  process.stderr.write(color ? `\x1b[38;5;208m${banner}\x1b[0m\n\n` : `${banner}\n\n`);
  let args: CliArguments;
  try {
    args = argumentsForRun();
  } catch (error) {
    process.stderr.write(`${message(error)}\n${usage}\n`);
    process.exitCode = 2;
    return;
  }

  let browser: JimmyBrowser | undefined;
  let input: Interface | undefined;
  let stopped = false;
  const stop = (exitCode: number): void => {
    stopped = true;
    process.exitCode = exitCode;
    input?.close();
    void browser?.close().catch(() => {});
  };
  const interrupt = (): void => stop(130);
  const terminate = (): void => stop(143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  try {
    const session = args.session === undefined
      ? await createSession()
      : await loadSession(args.session);
    process.stderr.write(`Session: ${session.id}\n`);
    browser = await JimmyBrowser.open(session);
    if (stopped) return;

    if (args.ask !== undefined) {
      const answer = await browser.send(args.ask);
      if (!stopped) process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
      return;
    }

    const terminal = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const width = Math.max(8, Math.min(process.stderr.columns ?? 80, 80));
    const divider = '─'.repeat(width);
    const inputHeading = `── YOU ${'─'.repeat(width - 7)}`;
    input = createInterface({ input: process.stdin, output: process.stderr, terminal });
    input.on('SIGINT', interrupt);
    if (terminal) {
      process.stderr.write('Enter sends a message. Ctrl+D exits.\n');
      input.setPrompt('> ');
      process.stderr.write(`\n${inputHeading}\n`);
      input.prompt();
    }
    for await (const prompt of input) {
      if (stopped) break;
      if (prompt.trim()) {
        if (terminal) process.stderr.write(`${divider}\n\n`);
        const answer = await browser.send(prompt);
        if (stopped) break;
        process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
      }
      if (terminal) {
        if (prompt.trim()) process.stderr.write(`\n${inputHeading}\n`);
        input.prompt();
      }
    }
  } catch (error) {
    if (!stopped) {
      process.stderr.write(`jimmy: ${message(error)}\n`);
      process.exitCode = 1;
    }
  } finally {
    input?.close();
    try {
      await browser?.close();
    } catch (error) {
      if (!stopped) {
        process.stderr.write(`jimmy: Could not close the browser: ${message(error)}\n`);
        process.exitCode = 1;
      }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
