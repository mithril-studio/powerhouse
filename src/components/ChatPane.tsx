import { resolveChatTransport, useAppStore, type Branch, type Chat } from "../store/appStore";
import { AcpChatPane } from "./AcpChatPane";
import { TerminalPane } from "./TerminalPane";

interface Props {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}

/** Selects the shared ACP experience or the raw terminal escape hatch. */
export function ChatPane(props: Props) {
  const settings = useAppStore((state) => state.settings);
  return resolveChatTransport(settings, props.chat) === "acp" ? (
    <AcpChatPane {...props} />
  ) : (
    <TerminalPane {...props} />
  );
}
