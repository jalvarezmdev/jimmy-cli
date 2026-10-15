import { Action, ActionPanel, Form, Icon, List, Toast, showToast, useNavigation } from "@raycast/api";
import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { SessionPicker } from "./session-picker";
import { runWorker } from "./worker";
import type { WorkerResult } from "./transport";

interface Turn {
  id: string;
  prompt: string;
  answer?: string;
  error?: string;
}

function ComposeMessage({ draft, onDraftChange, onSend, onCreate, onContinue, onEnd }: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (value: string) => void;
  onCreate: () => void;
  onContinue: () => void;
  onEnd: () => void;
}) {
  const { pop } = useNavigation();
  const [message, setMessage] = useState(draft);
  const [error, setError] = useState<string>();
  return (
    <Form navigationTitle="Write Message" actions={
      <ActionPanel>
        <Action.SubmitForm title="Send Message" icon={Icon.ArrowUp} onSubmit={() => {
          if (!message.trim()) {
            setError("Write a message before sending.");
            return;
          }
          pop();
          onSend(message);
        }} />
        <ActionPanel.Section title="Session">
          <Action title="Create a new session" icon={Icon.Plus} onAction={() => { pop(); onCreate(); }} />
          <Action title="Continue from a session" icon={Icon.Clock} onAction={() => { pop(); onContinue(); }} />
          <Action title="End session" icon={Icon.Stop} onAction={() => { pop(); onEnd(); }} />
        </ActionPanel.Section>
      </ActionPanel>
    }>
      <Form.TextArea id="prompt" title="Message" placeholder="Write your message to Jimmy…" value={message} error={error} onChange={(value) => {
        setMessage(value);
        onDraftChange(value);
        setError(undefined);
      }} />
    </Form>
  );
}

export function Chat({ initialSessionId }: { initialSessionId?: string }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const session = useRef(initialSessionId);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const ended = useRef(false);
  const [historyError, setHistoryError] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  const operation = useRef<Promise<WorkerResult> | null>(null);
  const mounted = useRef(true);
  const { push, pop } = useNavigation();

  useEffect(() => {
    mounted.current = true;
    if (initialSessionId) void loadHistory(initialSessionId);
    return () => {
      mounted.current = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, []);

  async function loadHistory(id: string) {
    const controller = new AbortController();
    pending.current = controller;
    session.current = id;
    setSessionId(id);
    ended.current = false;
    setSessionEnded(false);
    setHistoryError(undefined);
    setTurns([]);
    setDraft("");
    setIsLoading(true);
    const work = runWorker({ type: "history", sessionId: id }, { signal: controller.signal });
    operation.current = work;
    try {
      const result = await work;
      if (!mounted.current || controller.signal.aborted) return;
      if (result.type !== "history") throw new Error("Jimmy did not return the saved conversation.");
      const history: Turn[] = [];
      for (const message of result.messages) {
        const last = history.at(-1);
        if (message.role === "user") {
          history.push({ id: randomUUID(), prompt: message.content });
        } else if (last && last.answer === undefined) {
          last.answer = message.content;
        } else {
          history.push({ id: randomUUID(), prompt: "", answer: message.content });
        }
      }
      for (const turn of history) {
        if (turn.answer === undefined) turn.error = "No reply is saved for this message.";
      }
      setTurns(history);
      setSelectedId(history.at(-1)?.id);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        operation.current = null;
        if (mounted.current) setIsLoading(false);
      }
    }
  }

  async function endSession() {
    ended.current = true;
    setSessionEnded(true);
    pending.current?.abort();
    try { await operation.current; } catch { /* The request view reports failures; wait for browser cleanup. */ }
    if (mounted.current) setDraft("");
  }

  async function createSession() {
    await endSession();
    if (!mounted.current) return;
    session.current = undefined;
    setSessionId(undefined);
    ended.current = false;
    setSessionEnded(false);
    setHistoryError(undefined);
    setTurns([]);
    setSelectedId(undefined);
  }

  async function continueSession() {
    await endSession();
    if (!mounted.current) return;
    push(<SessionPicker onSelect={(id) => {
      pop();
      void loadHistory(id);
    }} onCreate={() => {
      pop();
      void createSession();
    }} />);
  }

  async function send(message: string) {
    if (pending.current || ended.current || !message.trim()) return;
    const controller = new AbortController();
    const id = randomUUID();
    pending.current = controller;
    setIsLoading(true);
    setDraft("");
    setTurns((previous) => [...previous, { id, prompt: message }]);
    const work = runWorker(
      { type: "ask", prompt: message, sessionId: session.current },
      {
        signal: controller.signal,
        onSession(value) {
          if (!mounted.current || controller.signal.aborted) return;
          session.current = value;
          setSessionId(value);
        },
      },
    );
    operation.current = work;
    try {
      const result = await work;
      if (!mounted.current || controller.signal.aborted) return;
      if (result.type !== "answer") throw new Error("Jimmy did not return an answer.");
      session.current = result.sessionId;
      setSessionId(result.sessionId);
      setTurns((previous) => previous.map((turn) => turn.id === id ? { ...turn, answer: result.answer } : turn));
      setSelectedId(id);
    } catch (error) {
      if (!mounted.current) return;
      const messageText = controller.signal.aborted
        ? "Stopped. ChatJimmy may have saved your message. It was not resent."
        : error instanceof Error ? error.message : String(error);
      setTurns((previous) => previous.map((turn) => turn.id === id ? { ...turn, error: messageText } : turn));
      setSelectedId(id);
      if (!ended.current) setDraft((current) => current || message);
      if (!controller.signal.aborted) {
        await showToast({ style: Toast.Style.Failure, title: "Could Not Send Message", message: messageText });
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        operation.current = null;
        if (mounted.current) setIsLoading(false);
      }
    }
  }

  const replies = turns.filter((turn) => turn.answer !== undefined);
  const selected = turns.find((turn) => turn.id === selectedId) ?? replies.at(-1);
  const replyIndex = replies.findIndex((turn) => turn.id === selected?.id);
  const markdown = selected?.answer ?? (selected?.error
    ? `## Message not completed\n\n${selected.error}`
    : historyError ? `## Could not open conversation\n\n${historyError}`
    : sessionEnded ? "## Session ended\n\nYour saved conversation is still available. Open ⌘K to create or continue a session."
    : isLoading ? ""
    : "## What can I help with?\n\nType above and press Return to send. Open ⌘K for session options and past replies.");

  const actions = (
        <ActionPanel>
          {!sessionEnded && (
            <Action title="Send Message" icon={Icon.ArrowUp} onAction={() => {
              if (pending.current) return;
              if (draft.trim()) return send(draft);
              void showToast({ style: Toast.Style.Failure, title: "Write a message before sending." });
            }} />
          )}
          {!isLoading && !sessionEnded && <Action title="Write Multiline Message" icon={Icon.Pencil} shortcut={{ modifiers: ["cmd"], key: "e" }} onAction={() => push(
            <ComposeMessage draft={draft} onDraftChange={setDraft} onSend={(value) => { void send(value); }}
              onCreate={() => { void createSession(); }} onContinue={() => { void continueSession(); }} onEnd={() => { void endSession(); }} />
          )} />}
          <ActionPanel.Section title="Session">
            <Action title="Create a new session" icon={Icon.Plus} onAction={createSession} shortcut={{ modifiers: ["cmd"], key: "n" }} />
            <Action title="Continue from a session" icon={Icon.Clock} onAction={continueSession} shortcut={{ modifiers: ["cmd"], key: "o" }} />
            {!sessionEnded && <Action title="End session" icon={Icon.Stop} onAction={endSession} shortcut={{ modifiers: ["cmd", "shift"], key: "e" }} />}
          </ActionPanel.Section>
          {replies.length > 0 && (
            <ActionPanel.Section title="Conversation">
              {replyIndex > 0 && <Action title="Previous reply" icon={Icon.ArrowLeft} onAction={() => setSelectedId(replies[replyIndex - 1]!.id)} />}
              {replyIndex >= 0 && replyIndex < replies.length - 1 && <Action title="Next reply" icon={Icon.ArrowRight} onAction={() => setSelectedId(replies[replyIndex + 1]!.id)} />}
              <ActionPanel.Submenu title="Past replies" icon={Icon.Clock}>
                {replies.map((turn) => (
                  <Action key={turn.id} title={turn.answer!.replace(/\s+/g, " ").slice(0, 80) || "Empty reply"}
                    icon={Icon.Bubble} onAction={() => setSelectedId(turn.id)} />
                ))}
              </ActionPanel.Submenu>
            </ActionPanel.Section>
          )}
          {selected?.answer !== undefined && (
            <ActionPanel.Section title="Answer">
              <Action.CopyToClipboard title="Copy Answer" content={selected.answer} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
              <Action.Paste title="Paste Answer" content={selected.answer} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} />
            </ActionPanel.Section>
          )}
          {sessionId && (
            <ActionPanel.Submenu title="Session Details" icon={Icon.Info}>
              <Action.CopyToClipboard title="Copy Session UUID" content={sessionId} />
              <Action.CopyToClipboard title="Copy CLI Resume Command" content={`jimmy --session ${sessionId}`} />
            </ActionPanel.Submenu>
          )}
        </ActionPanel>
  );

  return (
    <List navigationTitle={sessionEnded ? "Jimmy · Session ended" : "Chat with Jimmy"}
      searchBarPlaceholder={sessionEnded ? "Session ended. Open ⌘K to start or resume." : "Message Jimmy…"}
      searchText={draft} onSearchTextChange={setDraft} filtering={false} isShowingDetail isLoading={isLoading}>
      <List.Item id="reply" title="Jimmy" subtitle={isLoading ? "🟠 Thinking…" : undefined} icon="jimmy-logo.png"
        detail={<List.Item.Detail markdown={markdown} />} actions={actions} />
    </List>
  );
}
