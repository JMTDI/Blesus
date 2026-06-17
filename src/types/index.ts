export type Theme = "light" | "dark" | "black" | "system";
export type ReadingPane = "right" | "bottom" | "off";
export type Density = "compact" | "comfortable" | "spacious";

export type MailCategory = "pinned" | "people" | "notifications" | "newsletters";

export interface Workspace {
  id: number;
  name: string;
  color: string;
}

export interface Account {
  id: number;
  email: string;
  /** Resend "from" address, if configured — used as the actual sender email. */
  sendViaEmail: string | null;
  displayName: string;
  color: string;
  workspaceId: number;
  unreadCount: number;
  signatureHtml: string | null;
  isSendOnly: boolean;
  /** When true, account receives mail (IMAP) but is hidden from the compose From dropdown. */
  isImapOnly: boolean;
}

export interface MailFolder {
  id: number;
  accountId: number;
  name: string;
  path: string;
  specialUse?: "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam";
  unreadCount: number;
}

export interface ThreadMessage {
  uid: number;
  from: string;
  date: number; // unix seconds
  snippet: string;
  flags: string[];
  hasAttachments: boolean;
}

export interface Thread {
  id: number;
  accountId: number;
  folderId: number;
  subject: string;
  snippet: string;
  participants: string[];
  messageCount: number;
  hasUnread: boolean;
  isPinned: boolean;
  hasAttachments: boolean;
  lastMessageAt: number;
  category: MailCategory | null;
  /** Individual messages in the thread, newest first. May be empty for
   *  synthetic threads (e.g. from search results). */
  messages: ThreadMessage[];
}
