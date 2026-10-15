```text
   __  __  _  _  _  _  _  _ 
 _(  )(  )( \/ )( \/ )( \/ )
/ \) \ )( / \/ \/ \/ \ )  / 
\____/(__)\_)(_/\_)(_/(__/
```

# Jimmy

**Your terminal. Your workflow. ChatJimmy, one command away.**

Explain a tricky bit of code. Find a better way to phrase something. Keep a useful conversation going without leaving your terminal.

Jimmy is an **unofficial command-line companion for [ChatJimmy](https://chatjimmy.ai/), the chat experience provided by [Taalas](https://taalas.com/)**. It opens the real website in a dedicated headless Chromium browser, submits your message through the page, and brings the completed answer back to your console. No API-key configuration, local AI model, or extra AI agent required.

## Small interface. Useful everyday.

- **Chat your way.** Start an interactive conversation or send a single question and get back to work.
- **Pick up where you left off.** Every chat gets a UUID you can use to resume it later.
- **Keep your output useful.** Answers go to stdout; banners, session IDs, and errors go to stderr.
- **Keep the formatting.** Original Markdown, code indentation, and line breaks survive the trip back to your terminal.
- **See each turn clearly.** An orange startup banner, a delimited `YOU` input area, and breathing room between messages keep interactive chats readable.

## Install

You need **Node.js 22 or newer**, **npm**, **Git**, and an internet connection. The first browser setup downloads Chromium; you do not need to configure your everyday Chrome profile.

```sh
git clone https://github.com/jalvarezmdev/jimmy-cli.git
cd jimmy-cli
npm install
npm run browser:install
npm link
```

`npm install` builds the CLI. `npm link` makes the `jimmy` command available through npm's global executable directory; that directory must be on your `PATH`.

Because this is a linked installation, keep the cloned folder in place while you use Jimmy. There is no npm-registry installation required.

## Three commands. That's it.

```sh
jimmy                       # Start a new interactive chat
jimmy --ask "Explain this"   # Ask once, print the answer, exit
jimmy --session <uuid>       # Resume a saved chat interactively
```

In interactive mode, **Enter** sends, **Ctrl+D** exits, and **Ctrl+C** interrupts. Blank lines are ignored. For a multiline one-shot prompt, include the line breaks inside the quoted `--ask` argument.

`--ask` and `--session` are separate modes and cannot be combined. There are no additional command modes or flags.

### Take the answer with you

```sh
jimmy --ask "Explain closures with a short JavaScript example" > answer.md
```

The file receives only the answer. The ASCII banner and `Session: <uuid>` stay on stderr. Redirected streams have no color codes or interactive decorations; setting `NO_COLOR` disables the orange banner in a terminal too.

## Conversations worth keeping

Every new chat is saved under:

```text
~/.jimmy/sessions/<uuid>/
  session.json
  browser/
```

Copy the UUID printed at startup to resume that conversation later. Each session has its own browser profile, separate from other sessions and from your usual Chrome data. An exclusive lock prevents two Jimmy processes from using the same session simultaneously.

A website conversation becomes resumable after ChatJimmy saves its first message. A session opened and closed without sending anything starts its first conversation when resumed. Unknown UUIDs and missing or corrupt saved conversations fail explicitly rather than silently creating a replacement.

**Local storage is not local inference.** Browser data and conversation history are saved on disk, unencrypted, and your prompts are sent to ChatJimmy. Do not submit information you do not want the service to receive.

## Complete answers, not guesses

Jimmy waits for the page-initiated request to finish successfully, validates its completion trailer, and checks that the new reply has its own generation badge and the composer has returned to idle. It then returns the original reply text, excluding internal generation statistics.

If a request fails, the stream is incomplete, or generation does not complete within two minutes, Jimmy exits with an error instead of returning a partial or previous answer as success. It never automatically resends your prompt. A completed answer is not a guarantee of factual accuracy; review AI output before relying on it.

This client depends on ChatJimmy's current page structure and response format. Website updates, maintenance, or access restrictions can require an adapter update.

## Uninstall

Close any running Jimmy sessions, then remove the globally linked command:

```sh
npm unlink --global chatjimmy-console
```

The npm package is named **`chatjimmy-console`**; the command it exposes is **`jimmy`**. Unlinking removes the global command, not your cloned repository or saved conversations. You can delete the clone afterward if you no longer need the source.

### Optional: remove browser downloads

Before deleting the clone or its dependencies, run this **from the cloned repository**:

```sh
npx playwright uninstall
```

Playwright manages a shared browser cache. This command unregisters this installation and removes browser downloads no longer needed by other registered Playwright installations. Avoid `--all`: it targets browser downloads for other installations too.

### Optional: remove saved conversations

The following command **permanently deletes every saved Jimmy session**, including its browser profile. Only run it after closing all Jimmy processes and deciding you no longer need those conversations:

```sh
rm -rf "$HOME/.jimmy"
```

To keep other chats, remove only the chosen UUID's directory under `~/.jimmy/sessions/` instead.

## Development

```sh
npm run build
npm test
```

Rebuild after editing TypeScript; the linked `jimmy` command uses the compiled files in `dist/`. Tests exercise real Chromium against local HTTP fixtures and use temporary filesystem sessions. They do not send prompts to ChatJimmy. Install Chromium before running them.

## Credits and service terms

**The chat service deserves the credit:** [ChatJimmy](https://chatjimmy.ai/) and [Taalas](https://taalas.com/) provide the website and hosted AI inference. This repository adds the terminal interface and browser automation; it does not build, host, or claim ownership of their service or AI models.

Jimmy CLI is an independent, unofficial project and is not affiliated with or endorsed by Taalas. Please review the service's [Terms and Conditions](https://taalas.com/terms-conditions/) and [Privacy Policy](https://taalas.com/privacy-policy/) before use. Access to the website does not itself establish permission to automate it.
