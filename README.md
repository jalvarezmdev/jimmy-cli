# Jimmy

Chat with [ChatJimmy](https://chatjimmy.ai/) from your terminal. Jimmy operates the actual webpage in a dedicated headless Chromium browser; it does not call the chat API directly or use another AI agent.

## Install

Requires Node.js 22 or newer and npm.

```sh
npm install
npm run browser:install
npm link
```

`npm install` builds the TypeScript source. Rebuild after source changes with `npm run build`.

## Use

```sh
jimmy                       # Start a new interactive chat
jimmy --ask "Explain this"  # Send one prompt, print its answer, exit
jimmy --session <uuid>       # Resume an existing chat interactively
```

These are the only command forms; `--ask` and `--session` cannot be combined. In interactive mode, Enter sends a message, Ctrl+D exits, and Ctrl+C interrupts. Blank interactive lines are ignored. A quoted `--ask` argument can contain multiple lines.

In a terminal, a `YOU` heading and horizontal lines delimit your input, with a blank line before Jimmy's response and between turns.

The startup ASCII banner is orange in terminals (`NO_COLOR` disables coloring). The banner and `Session: <uuid>` are printed to stderr. Redirected output has no ANSI color codes. Answers alone go to stdout, so redirecting a one-shot answer does not capture the banner:

```sh
jimmy --ask "Explain closures" > answer.txt
```

## Saved sessions

Every new chat receives a UUID. Its metadata and private browser profile are saved under `~/.jimmy/sessions/<uuid>/`. Copy the printed UUID to resume it later; no account or everyday Chrome profile is shared between sessions.

A session becomes a resumable website conversation after its first message is saved by ChatJimmy. Opening a session that has never received a message starts its first conversation. Invalid or unknown UUIDs fail explicitly. Missing or corrupt saved website history is an error, not a replacement conversation. An exclusive filesystem lock rejects concurrent use of the same session and is released when its browser closes.

Session profiles contain conversation history and browser data on disk, unencrypted. Do not send sensitive information you do not want the website to receive. To remove a saved chat, close Jimmy and remove that UUID's directory.

## Completion and failures

Jimmy waits for the submission's successful transport, a successful completion trailer, a new reply's generation badge, and the idle composer before returning the reply. Answer text comes from the response stream initiated by the webpage, not a separate API call. Original Markdown, indentation, and line breaks are preserved; the internal generation-statistics trailer is removed.

HTTP failures, aborted or incomplete streams, and unsuccessful generation are errors. A reply has a two-minute completion deadline; partial or previous answers are never returned as successful output, and prompts are never automatically resent. Errors go to stderr with a nonzero exit status.

The adapter depends on the website's current markup and completion format. UI changes, maintenance, or access restrictions may require an update. Review the service's [terms](https://taalas.com/terms-conditions/) before using an automated client; browser access is not itself permission to automate.

## Development checks

```sh
npm test
```

Tests use local HTTP fixtures with real Chromium plus temporary filesystem sessions. They do not submit prompts to ChatJimmy. Install Chromium before running them.
