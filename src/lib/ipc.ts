import { invoke } from "@tauri-apps/api/core";

export type ImapSecurity = "ssl" | "starttls" | "none";
export type SmtpSecurity = "ssl" | "starttls" | "none";

export interface ImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  security: ImapSecurity;
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  security: SmtpSecurity;
}

export interface OutgoingAttachment {
  filename: string;
  path: string;
  contentType?: string;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  attachments?: OutgoingAttachment[];
  /** RFC 2822 `In-Reply-To` header value (angle-bracketed message ID). */
  inReplyTo?: string;
  /** RFC 2822 `References` header value (space-separated angle-bracketed IDs). */
  references?: string;
}

export interface SendResult {
  messageId?: string;
  /** Present only when `saveToSent` was passed in. True = IMAP APPEND
   *  succeeded, false = APPEND attempted and failed. */
  imapAppended?: boolean;
}

export interface Folder {
  name: string;
  path: string;
  delimiter: string | null;
  flags: string[];
}

export interface FolderStatus {
  unseen: number;
  total: number;
}

export interface MessageSummary {
  uid: number;
  subject: string | null;
  from: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  date: number | null;
  snippet: string | null;
  flags: string[];
  hasAttachments: boolean;
  isBulk: boolean;
  isAuto: boolean;
  /** RFC 5322 Message-ID, lowercase, brackets stripped. Empty when missing. */
  messageId: string;
  /** Single parent ID from In-Reply-To, same normalisation. */
  inReplyTo: string;
  /** Full chain from References, in order, same normalisation. */
  references: string[];
}

export interface MessageBody {
  uid: number;
  html: string | null;
  text: string | null;
  headers: Array<[string, string]>;
  attachments: Attachment[];
  unsubscribe: UnsubscribeInfo | null;
}

export interface UnsubscribeInfo {
  mailto: string | null;
  http: string | null;
  oneClick: boolean;
}

export interface Attachment {
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
}

export interface ResendTemplateSummary {
  id: string;
  name: string;
  subject: string | null;
}

export type FlagMode = "add" | "remove" | "replace";

/** When set, the Rust send commands APPEND the outgoing message to the
 *  sender's IMAP Sent folder after a successful send. */
export interface SaveToSent {
  imap: ImapConfig;
  folder: string;
}

export const ipc = {
  ping: () => invoke<string>("ping"),

  imapTestConnection: (config: ImapConfig) =>
    invoke<void>("imap_test_connection", { config }),
  imapListFolders: (config: ImapConfig) =>
    invoke<Folder[]>("imap_list_folders", { config }),
  imapFolderStatus: (config: ImapConfig, folder: string) =>
    invoke<FolderStatus>("imap_folder_status", { config, folder }),
  imapFolderStatusBatch: (config: ImapConfig, folders: string[]) =>
    invoke<FolderStatus[]>("imap_folder_status_batch", { config, folders }),
  imapFetchMessages: (
    config: ImapConfig,
    folder: string,
    limit: number,
    offset: number = 0,
  ) =>
    invoke<MessageSummary[]>("imap_fetch_messages", { config, folder, limit, offset }),
  imapFetchUnread: (config: ImapConfig, folder: string, limit: number = 500) =>
    invoke<MessageSummary[]>("imap_fetch_unread", { config, folder, limit }),
  imapSearchBySubject: (config: ImapConfig, folder: string, subject: string) =>
    invoke<MessageSummary[]>("imap_search_by_subject", { config, folder, subject }),
  imapFetchAllUids: (config: ImapConfig, folder: string) =>
    invoke<number[]>("imap_fetch_all_uids", { config, folder }),
  imapFetchMessageBody: (config: ImapConfig, folder: string, uid: number) =>
    invoke<MessageBody>("imap_fetch_message_body", { config, folder, uid }),
  imapFetchMessageBodiesBatch: (config: ImapConfig, folder: string, uids: number[]) =>
    invoke<MessageBody[]>("imap_fetch_message_bodies_batch", { config, folder, uids }),
  imapExpungeUid: (config: ImapConfig, folder: string, uid: number) =>
    invoke<void>("imap_expunge_uid", { config, folder, uid }),
  imapExpungeUids: (config: ImapConfig, folder: string, uids: number[]) =>
    invoke<void>("imap_expunge_uids", { config, folder, uids }),
  imapSaveAttachment: (
    config: ImapConfig,
    folder: string,
    uid: number,
    index: number,
    destPath: string,
  ) =>
    invoke<void>("imap_save_attachment", {
      config,
      folder,
      uid,
      index,
      destPath,
    }),
  imapLoadAttachmentB64: (
    config: ImapConfig,
    folder: string,
    uid: number,
    index: number,
  ) =>
    invoke<string>("imap_load_attachment_b64", { config, folder, uid, index }),
  imapCreateFolder: (config: ImapConfig, name: string) =>
    invoke<void>("imap_create_folder", { config, name }),
  imapRenameFolder: (config: ImapConfig, from: string, to: string) =>
    invoke<void>("imap_rename_folder", { config, from, to }),
  imapDeleteFolder: (config: ImapConfig, path: string) =>
    invoke<void>("imap_delete_folder", { config, path }),

  imapSetFlags: (
    config: ImapConfig,
    folder: string,
    uid: number,
    flags: string[],
    mode: FlagMode,
  ) => invoke<void>("imap_set_flags", { config, folder, uid, flags, mode }),
  imapSetFlagsMulti: (
    config: ImapConfig,
    folder: string,
    uids: number[],
    flags: string[],
    mode: FlagMode,
  ) => invoke<void>("imap_set_flags_multi", { config, folder, uids, flags, mode }),
  imapMoveUid: (
    config: ImapConfig,
    folder: string,
    destFolder: string,
    uid: number,
  ) => invoke<void>("imap_move_uid", { config, folder, destFolder, uid }),

  imapMoveUids: (
    config: ImapConfig,
    folder: string,
    destFolder: string,
    uids: number[],
  ) => invoke<void>("imap_move_uids", { config, folder, destFolder, uids }),

  smtpTestConnection: (config: SmtpConfig) =>
    invoke<void>("smtp_test_connection", { config }),
  smtpSend: (
    config: SmtpConfig,
    message: OutgoingMessage,
    saveToSent?: SaveToSent | null,
  ) =>
    invoke<SendResult>("smtp_send", {
      config,
      message,
      saveToSent: saveToSent ?? null,
    }),

  resendSend: (
    apiKey: string,
    message: OutgoingMessage,
    saveToSent?: SaveToSent | null,
  ) =>
    invoke<SendResult>("resend_send", {
      apiKey,
      message,
      saveToSent: saveToSent ?? null,
    }),
  resendSendTemplate: (
    apiKey: string,
    templateId: string,
    from: string,
    to: string[],
    variables: Record<string, unknown>,
  ) =>
    invoke<SendResult>("resend_send_template", {
      apiKey,
      templateId,
      from,
      to,
      variables,
    }),
  resendListTemplates: (apiKey: string) =>
    invoke<ResendTemplateSummary[]>("resend_list_templates", { apiKey }),

  unsubscribeOneClick: (url: string) =>
    invoke<void>("unsubscribe_one_click", { url }),

  secretsSave: (key: string, value: string) =>
    invoke<void>("secrets_save", { key, value }),
  secretsLoad: (key: string) =>
    invoke<string | null>("secrets_load", { key }),
  secretsDelete: (key: string) =>
    invoke<void>("secrets_delete", { key }),

  windowSetUnreadBadge: (count: number) =>
    invoke<void>("window_set_unread_badge", { count }),

  appQuit: () => invoke<void>("app_quit"),

  imapIdleStart: (accountId: number, config: ImapConfig, folder: string) =>
    invoke<void>("imap_idle_start", { accountId, config, folder }),
  imapIdleStop: (accountId: number, folder: string) =>
    invoke<void>("imap_idle_stop", { accountId, folder }),

  getDatabaseUrl: () => invoke<string>("get_database_url"),

  backupSeal: (password: string, plaintext: string) =>
    invoke<string>("backup_seal", { password, plaintext }),
  backupUnseal: (password: string, blob: string) =>
    invoke<string>("backup_unseal", { password, blob }),
  backupWriteFile: (path: string, contents: string) =>
    invoke<void>("backup_write_file", { path, contents }),
  backupReadFile: (path: string) =>
    invoke<string>("backup_read_file", { path }),

  getLogsDir: () => invoke<string>("get_logs_dir"),
  getAttachmentCacheDir: () => invoke<string>("get_attachment_cache_dir"),
  attachmentCacheRead: (fileName: string) =>
    invoke<string>("attachment_cache_read", { fileName }),
  attachmentCacheWrite: (fileName: string, b64: string) =>
    invoke<void>("attachment_cache_write", { fileName, b64 }),
  attachmentCacheDelete: (fileName: string) =>
    invoke<void>("attachment_cache_delete", { fileName }),
  logFrontend: (level: "info" | "warn" | "error" | "debug", message: string) =>
    invoke<void>("log_frontend", { level, message }),
};

/** Payload of the `imap-update` event emitted from the Rust IDLE loop. */
export interface ImapUpdateEvent {
  accountId: number;
  folder: string;
}
