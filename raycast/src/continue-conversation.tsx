import { useNavigation } from "@raycast/api";
import { Chat } from "./chat";
import { SessionPicker } from "./session-picker";

export default function ContinueConversation() {
  const { push } = useNavigation();

  return (
    <SessionPicker
      onSelect={(sessionId) => push(<Chat initialSessionId={sessionId} />)}
      onCreate={() => push(<Chat />)}
    />
  );
}
