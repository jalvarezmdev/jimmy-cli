import { Action, ActionPanel, List, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { runWorker, type SavedSession } from "./worker";

export function SessionPicker({ onSelect, onCreate }: { onSelect: (sessionId: string) => void; onCreate: () => void }) {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(undefined);

    async function loadSessions() {
      try {
        const result = await runWorker({ type: "list" }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.type !== "sessions") throw new Error("Jimmy returned an answer instead of a session list.");
        setSessions(result.sessions);
      } catch (cause) {
        if (controller.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        await showToast({ style: Toast.Style.Failure, title: "Could Not Load Conversations", message });
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadSessions();
    return () => controller.abort();
  }, [revision]);

  const actions = (
    <ActionPanel>
      <Action title="Create a new session" onAction={onCreate} shortcut={{ modifiers: ["cmd"], key: "n" }} />
      {!isLoading && (
        <Action title="Refresh Conversations" onAction={() => setRevision((value) => value + 1)} shortcut={{ modifiers: ["cmd"], key: "r" }} />
      )}
    </ActionPanel>
  );

  return (
    <List isLoading={isLoading} navigationTitle="Continue Conversation" searchBarPlaceholder="Search session UUIDs" actions={actions}>
      <List.EmptyView
        title={isLoading ? "Loading Conversations…" : error ? "Could Not Load Conversations" : "No Saved Conversations"}
        description={error ?? "Ask Jimmy a question to start a conversation shared with the CLI."}
        actions={actions}
      />
      {sessions.map((session) => (
        <List.Item
          key={session.id}
          id={session.id}
          title={session.id}
          subtitle={session.hasConversation ? "Conversation" : "No messages yet"}
          accessories={[{ date: new Date(session.updatedAt), tooltip: `Session metadata saved ${new Date(session.updatedAt).toLocaleString()}` }]}
          actions={
            <ActionPanel>
              <Action title="Continue from a session" onAction={() => onSelect(session.id)} />
              <Action.CopyToClipboard title="Copy Session UUID" content={session.id} />
              <Action.CopyToClipboard title="Copy CLI Resume Command" content={`jimmy --session ${session.id}`} />
              <ActionPanel.Section>
                <Action title="Create a new session" onAction={onCreate} shortcut={{ modifiers: ["cmd"], key: "n" }} />
                {!isLoading && (
                  <Action title="Refresh Conversations" onAction={() => setRevision((value) => value + 1)} shortcut={{ modifiers: ["cmd"], key: "r" }} />
                )}
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
