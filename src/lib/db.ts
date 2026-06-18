import Database from "@tauri-apps/plugin-sql";
import { ipc } from "@/lib/ipc";

/** Strips Re:/Fwd:/etc. prefixes to get the canonical subject for threading.
 *  Must stay in sync with the same regex in MessageView.tsx. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "")
    .replace(/^(\s*(re|fwd?|aw|sv|vs|antw|回复|回覆|转发)(\[\d+\])?\s*:\s*)+/gi, "")
    .trim()
    .toLowerCase();
}

let cached: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!cached) {
    // The DB lives in a portable folder next to the executable
    // (`<exe_dir>/blesus-files/blesus.db`). The Rust side computes the absolute
    // SQLite URL at startup and registers migrations against it; we have to
    // load with the exact same string, hence the IPC round-trip.
    const url = await ipc.getDatabaseUrl();
    cached = await Database.load(url);
  }
  return cached;
}

export interface StoredAccount {
  id: number;
  email: string;
  display_name: string | null;
  color: string | null;
  imap_host: string;
  imap_port: number;
  imap_security: "ssl" | "starttls" | "none";
  imap_username: string | null;
  smtp_mode: "smtp" | "resend";
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: "ssl" | "starttls" | "none" | null;
  smtp_username: string | null;
  resend_from_address: string | null;
  signature_html: string | null;
  created_at: number;
  /** True when this account has no IMAP inbox — appears only as a From option in the Composer. */
  is_send_only: number; // SQLite integer boolean
  /** True when this account only receives mail and should not appear in the compose From dropdown. */
  is_imap_only: number; // SQLite integer boolean
}

export interface AccountInput {
  email: string;
  displayName: string;
  color: string;
  /** Omit for send-only accounts that have no IMAP inbox. */
  imap?: {
    host: string;
    port: number;
    security: "ssl" | "starttls" | "none";
    username: string;
    password: string;
  };
  sendingMode: "smtp" | "resend";
  smtp?: {
    host: string;
    port: number;
    security: "ssl" | "starttls" | "none";
    username: string;
    password: string;
  };
  resend?: {
    apiKey: string;
    fromAddress: string;
  };
  /** When true, account has no IMAP inbox and only appears as a From option. */
  isSendOnly?: boolean;
  /** When true, account only receives mail and is hidden from the compose From dropdown. */
  isImapOnly?: boolean;
  signatureHtml?: string;
}

// Secrets are stored in the OS keychain (Windows Credential Manager / macOS
// Keychain / libsecret on Linux) via the `keyring` crate. The BLOB columns
// are kept for backwards compatibility: legacy plaintext passwords there are
// still readable on first load and migrated into the keychain on next save.
//
// Keychain key layout: `imap.{accountId}`, `smtp.{accountId}`, `resend.{accountId}`.
const KEYCHAIN_PLACEHOLDER = "__keychain__";

function encodeSecret(_text: string): string {
  // Insert into the BLOB column as a marker; the real value lives in the
  // keychain and is written separately after the account row is created.
  return KEYCHAIN_PLACEHOLDER;
}

async function loadSecret(
  keychainKey: string,
  blobValue: string | null,
): Promise<string> {
  if (blobValue === KEYCHAIN_PLACEHOLDER) {
    const v = await ipc.secretsLoad(keychainKey).catch(() => null);
    return v ?? "";
  }
  // Legacy plaintext fallback. The value stays readable; the next save path
  // will promote it to the keychain and overwrite the BLOB with the marker.
  return blobValue ?? "";
}

async function writeSecret(keychainKey: string, value: string): Promise<void> {
  if (value === "") {
    await ipc.secretsDelete(keychainKey).catch(() => {});
    return;
  }
  await ipc.secretsSave(keychainKey, value);
}

function secretKeyImap(id: number): string { return `imap.${id}`; }
function secretKeySmtp(id: number): string { return `smtp.${id}`; }
function secretKeyResend(id: number): string { return `resend.${id}`; }

export async function listAccounts(): Promise<StoredAccount[]> {
  const db = await getDb();
  return db.select<StoredAccount[]>(
    `SELECT id, email, display_name, color, imap_host, imap_port, imap_security,
            imap_username, smtp_mode, smtp_host, smtp_port, smtp_security,
            smtp_username, resend_from_address, signature_html, created_at,
            COALESCE(is_send_only, 0) AS is_send_only,
            COALESCE(is_imap_only, 0) AS is_imap_only
       FROM accounts
       ORDER BY sort_order ASC, id ASC`,
  );
}

/** Persist a new sidebar order. Caller passes the full account list in the
 *  desired order; this writes `sort_order = index` for each row in a single
 *  transaction so the sidebar's optimistic update doesn't drift from the DB. */
export async function setAccountSortOrders(
  orderedIds: number[],
): Promise<void> {
  if (orderedIds.length === 0) return;
  const db = await getDb();
  await db.execute("BEGIN");
  try {
    for (let i = 0; i < orderedIds.length; i++) {
      await db.execute(
        `UPDATE accounts SET sort_order = $1, updated_at = unixepoch() WHERE id = $2`,
        [i, orderedIds[i]],
      );
    }
    await db.execute("COMMIT");
  } catch (err) {
    await db.execute("ROLLBACK").catch(() => {});
    throw err;
  }
}

export async function getAccount(id: number): Promise<StoredAccount | null> {
  const db = await getDb();
  const rows = await db.select<StoredAccount[]>(
    `SELECT id, email, display_name, color, imap_host, imap_port, imap_security,
            imap_username, smtp_mode, smtp_host, smtp_port, smtp_security,
            smtp_username, resend_from_address, signature_html, created_at,
            COALESCE(is_send_only, 0) AS is_send_only,
            COALESCE(is_imap_only, 0) AS is_imap_only
       FROM accounts WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertAccount(input: AccountInput): Promise<number> {
  const db = await getDb();
  // For send-only accounts we store placeholder IMAP values so the NOT NULL
  // DB constraint is satisfied. The imap_host="" sentinel tells the app
  // not to attempt any IMAP connection for this account.
  const imapHost = input.imap?.host ?? "";
  const imapPort = input.imap?.port ?? 0;
  const imapSecurity = input.imap?.security ?? "none";
  const imapUsername = input.imap?.username ?? null;
  const imapPasswordRaw = input.imap?.password ?? "";
  const imapMarker = imapPasswordRaw ? encodeSecret(imapPasswordRaw) : "";
  const smtpMarker = input.smtp ? encodeSecret(input.smtp.password) : null;
  const resendMarker = input.resend ? encodeSecret(input.resend.apiKey) : null;

  const result = await db.execute(
    `INSERT INTO accounts (
       email, display_name, color,
       imap_host, imap_port, imap_security, imap_username, imap_password_enc,
       smtp_mode, smtp_host, smtp_port, smtp_security, smtp_username, smtp_password_enc,
       resend_api_key_enc, resend_from_address, signature_html, is_send_only, is_imap_only
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      input.email,
      input.displayName || null,
      input.color || null,
      imapHost,
      imapPort,
      imapSecurity,
      imapUsername,
      imapMarker,
      input.sendingMode,
      input.smtp?.host ?? null,
      input.smtp?.port ?? null,
      input.smtp?.security ?? null,
      input.smtp?.username ?? null,
      smtpMarker,
      resendMarker,
      input.resend?.fromAddress ?? null,
      input.signatureHtml?.trim() || null,
      input.isSendOnly ? 1 : 0,
      input.isImapOnly ? 1 : 0,
    ],
  );
  const id = Number(result.lastInsertId);

  if (imapPasswordRaw) await writeSecret(secretKeyImap(id), imapPasswordRaw);
  if (input.smtp) await writeSecret(secretKeySmtp(id), input.smtp.password);
  if (input.resend) await writeSecret(secretKeyResend(id), input.resend.apiKey);
  return id;
}

export async function updateAccount(id: number, input: AccountInput): Promise<void> {
  const db = await getDb();

  // Read the current encrypted markers so we can preserve passwords that
  // weren't re-entered (empty string = "keep existing").
  const existing = await db.select<Array<{
    imap_password_enc: string | null;
    smtp_password_enc: string | null;
    resend_api_key_enc: string | null;
  }>>(
    "SELECT imap_password_enc, smtp_password_enc, resend_api_key_enc FROM accounts WHERE id = $1",
    [id],
  );
  const cur = existing[0];

  const imapPasswordRaw = input.imap?.password ?? "";
  const imapHost = input.imap?.host ?? "";
  const imapPort = input.imap?.port ?? 0;
  const imapSecurity = input.imap?.security ?? "none";
  const imapUsername = input.imap?.username ?? null;
  const imapMarker = imapPasswordRaw
    ? encodeSecret(imapPasswordRaw)
    : (cur?.imap_password_enc ?? "");

  const smtpPasswordRaw = input.smtp?.password ?? "";
  const smtpMarker = input.smtp
    ? (smtpPasswordRaw ? encodeSecret(smtpPasswordRaw) : (cur?.smtp_password_enc ?? null))
    : null;

  const resendKeyRaw = input.resend?.apiKey ?? "";
  const resendMarker = input.resend
    ? (resendKeyRaw ? encodeSecret(resendKeyRaw) : (cur?.resend_api_key_enc ?? null))
    : null;

  await db.execute(
    `UPDATE accounts SET
       email = $1, display_name = $2, color = $3,
       imap_host = $4, imap_port = $5, imap_security = $6,
       imap_username = $7, imap_password_enc = $8,
       smtp_mode = $9, smtp_host = $10, smtp_port = $11,
       smtp_security = $12, smtp_username = $13, smtp_password_enc = $14,
       resend_api_key_enc = $15, resend_from_address = $16,
       signature_html = $17, is_send_only = $18, is_imap_only = $19,
       updated_at = unixepoch()
     WHERE id = $20`,
    [
      input.email,
      input.displayName || null,
      input.color || null,
      imapHost,
      imapPort,
      imapSecurity,
      imapUsername,
      imapMarker,
      input.sendingMode,
      input.smtp?.host ?? null,
      input.smtp?.port ?? null,
      input.smtp?.security ?? null,
      input.smtp?.username ?? null,
      smtpMarker,
      resendMarker,
      input.resend?.fromAddress ?? null,
      input.signatureHtml?.trim() || null,
      input.isSendOnly ? 1 : 0,
      input.isImapOnly ? 1 : 0,
      id,
    ],
  );

  if (imapPasswordRaw) await writeSecret(secretKeyImap(id), imapPasswordRaw);
  if (input.smtp) {
    if (smtpPasswordRaw) await writeSecret(secretKeySmtp(id), smtpPasswordRaw);
  } else {
    await ipc.secretsDelete(secretKeySmtp(id)).catch(() => {});
  }
  if (input.resend) {
    if (resendKeyRaw) await writeSecret(secretKeyResend(id), resendKeyRaw);
  } else {
    await ipc.secretsDelete(secretKeyResend(id)).catch(() => {});
  }
}

// --- Backup bundle (export/import accounts) ------------------------------

export interface AccountBundleEntry {
  email: string;
  displayName: string;
  color: string;
  imap: {
    host: string;
    port: number;
    security: "ssl" | "starttls" | "none";
    username: string;
    password: string;
  };
  sendingMode: "smtp" | "resend";
  smtp?: {
    host: string;
    port: number;
    security: "ssl" | "starttls" | "none";
    username: string;
    password: string;
  };
  resend?: {
    apiKey: string;
    fromAddress: string;
  };
  signatureHtml?: string;
}

export interface AccountsBundle {
  version: 1;
  exportedAt: number;
  accounts: AccountBundleEntry[];
}

/**
 * Build a self-contained bundle (with secrets) for the given account ids.
 * Hits the keychain via `getAccountSecrets`, so callers should expect a
 * round-trip per account.
 */
export async function buildAccountsBundle(
  accountIds: number[],
): Promise<AccountsBundle> {
  const all = await listAccounts();
  const wanted = all.filter((a) => accountIds.includes(a.id));
  const items: AccountBundleEntry[] = [];
  for (const a of wanted) {
    const secrets = await getAccountSecrets(a.id);
    const entry: AccountBundleEntry = {
      email: a.email,
      displayName: a.display_name ?? "",
      color: a.color ?? "",
      imap: {
        host: a.imap_host,
        port: a.imap_port,
        security: a.imap_security,
        username: a.imap_username ?? a.email,
        password: secrets.imapPassword,
      },
      sendingMode: a.smtp_mode,
    };
    if (a.smtp_mode === "smtp" && a.smtp_host && a.smtp_port && a.smtp_security) {
      entry.smtp = {
        host: a.smtp_host,
        port: a.smtp_port,
        security: a.smtp_security,
        username: a.smtp_username ?? a.email,
        password: secrets.smtpPassword ?? "",
      };
    }
    if (a.smtp_mode === "resend") {
      entry.resend = {
        apiKey: secrets.resendApiKey ?? "",
        fromAddress: a.resend_from_address ?? "",
      };
    }
    if (a.signature_html) entry.signatureHtml = a.signature_html;
    items.push(entry);
  }
  return { version: 1, exportedAt: Math.floor(Date.now() / 1000), accounts: items };
}

/** Convert a bundle entry into the AccountInput shape that
 *  `insertAccount` / `updateAccount` consume. */
export function entryToAccountInput(e: AccountBundleEntry): AccountInput {
  return {
    email: e.email,
    displayName: e.displayName,
    color: e.color,
    imap: e.imap,
    sendingMode: e.sendingMode,
    smtp: e.smtp,
    resend: e.resend,
    signatureHtml: e.signatureHtml,
  };
}

export async function deleteAccount(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM accounts WHERE id = $1", [id]);
  await ipc.secretsDelete(secretKeyImap(id)).catch(() => {});
  await ipc.secretsDelete(secretKeySmtp(id)).catch(() => {});
  await ipc.secretsDelete(secretKeyResend(id)).catch(() => {});
}

export type DraftMode = "new" | "reply" | "replyAll" | "forward";

export interface StoredDraft {
  id: number;
  account_id: number;
  mode: DraftMode;
  reply_uid: number | null;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  subject: string;
  html_body: string;
  text_body: string;
  body_is_raw: number; // 1 = verbatim email HTML (render in iframe), 0 = Tiptap HTML
  attachments_json: string | null;
  updated_at: number;
}

export interface DraftInput {
  accountId: number;
  mode: DraftMode;
  replyUid: number | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  bodyIsRaw?: boolean;
  attachments?: Array<{ filename: string; path: string }>;
}

export async function getDraft(id: number): Promise<StoredDraft | null> {
  const db = await getDb();
  const rows = await db.select<StoredDraft[]>(
    `SELECT id, account_id, mode, reply_uid, to_addresses, cc_addresses,
            bcc_addresses, subject, html_body, text_body, body_is_raw, attachments_json, updated_at
       FROM drafts WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function findReplyDraft(
  accountId: number,
  mode: DraftMode,
  replyUid: number | null,
): Promise<StoredDraft | null> {
  const db = await getDb();
  const rows =
    replyUid == null
      ? await db.select<StoredDraft[]>(
          `SELECT id, account_id, mode, reply_uid, to_addresses, cc_addresses,
                  bcc_addresses, subject, html_body, text_body, body_is_raw, attachments_json, updated_at
             FROM drafts
            WHERE account_id = $1 AND mode = $2 AND reply_uid IS NULL
            ORDER BY updated_at DESC LIMIT 1`,
          [accountId, mode],
        )
      : await db.select<StoredDraft[]>(
          `SELECT id, account_id, mode, reply_uid, to_addresses, cc_addresses,
                  bcc_addresses, subject, html_body, text_body, body_is_raw, attachments_json, updated_at
             FROM drafts
            WHERE account_id = $1 AND mode = $2 AND reply_uid = $3
            ORDER BY updated_at DESC LIMIT 1`,
          [accountId, mode, replyUid],
        );
  return rows[0] ?? null;
}

export async function insertDraft(input: DraftInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO drafts (
       account_id, mode, reply_uid,
       to_addresses, cc_addresses, bcc_addresses,
       subject, html_body, text_body, body_is_raw, attachments_json, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, unixepoch())`,
    [
      input.accountId,
      input.mode,
      input.replyUid,
     input.to ?? '',
     input.cc ?? '',
     input.bcc ?? '',
     input.subject ?? '',
     input.htmlBody ?? '',
     input.textBody ?? '',
      input.bodyIsRaw ? 1 : 0,
      input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null,
    ],
  );
  return Number(result.lastInsertId);
}

export async function updateDraft(id: number, input: DraftInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE drafts SET
       to_addresses = $1, cc_addresses = $2, bcc_addresses = $3,
       subject = $4, html_body = $5, text_body = $6, body_is_raw = $7,
       attachments_json = $8, updated_at = unixepoch()
     WHERE id = $9`,
    [
     input.to ?? '',
     input.cc ?? '',
     input.bcc ?? '',
     input.subject ?? '',
     input.htmlBody ?? '',
     input.textBody ?? '',
      input.bodyIsRaw ? 1 : 0,
      input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null,
      id,
    ],
  );
}

export async function deleteDraft(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM drafts WHERE id = $1", [id]);
}

export async function listDrafts(accountId: number): Promise<StoredDraft[]> {
  const db = await getDb();
  return db.select<StoredDraft[]>(
    `SELECT id, account_id, mode, reply_uid, to_addresses, cc_addresses,
            bcc_addresses, subject, html_body, text_body, body_is_raw, attachments_json, updated_at
       FROM drafts WHERE account_id = $1
       ORDER BY updated_at DESC`,
    [accountId],
  );
}

// --- Contacts (for composer autocomplete) ----------------------------------

export interface ContactRow {
  id: number;
  email: string;
  display_name: string | null;
  interaction_count: number;
  last_interaction_at: number | null;
}

// Heuristic for automated / transactional local-parts that should not be
// auto-suggested when the user composes. Mirrors the regex in threads.ts
// (inferCategory) so the two stay in sync.
const AUTO_LOCAL_PART =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|notifications?|alerts?|automated?|auto|system|support|updates?|mailer|postmaster|bounces?|news)$/i;

export function parseNameEmail(
  raw: string,
): { name: string | null; email: string } | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m && m[2]) {
    const rawName = m[1]?.trim() ?? "";
    const unquoted = rawName.replace(/^"(.*)"$/, "$1").trim();
    return { name: unquoted || null, email: m[2].trim() };
  }
  if (s.includes("@")) return { name: null, email: s };
  return null;
}

export function isAutomatedEmail(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return AUTO_LOCAL_PART.test(local);
}

/** Upsert bumping interaction_count. Use on outgoing sends and on replies
 *  to senders — anywhere the user actively interacts with the address. */
export async function upsertContact(
  email: string,
  displayName: string | null,
): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!addr || !addr.includes("@")) return;
  if (isAutomatedEmail(addr)) return;
  const name = displayName?.trim() || null;
  const db = await getDb();
  await db.execute(
    `INSERT INTO contacts (email, display_name, interaction_count, last_interaction_at)
     VALUES ($1, $2, 1, unixepoch())
     ON CONFLICT(email) DO UPDATE SET
       display_name = COALESCE(NULLIF(excluded.display_name, ''), contacts.display_name),
       interaction_count = contacts.interaction_count + 1,
       last_interaction_at = unixepoch()`,
    [addr, name],
  );
}

/** Add to the pool without bumping. Use on fetched senders so the user
 *  gets useful autocomplete on day one without those senders outranking
 *  the people they actually email. */
export async function seedContact(
  email: string,
  displayName: string | null,
): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!addr || !addr.includes("@")) return;
  if (isAutomatedEmail(addr)) return;
  const name = displayName?.trim() || null;
  const db = await getDb();
  await db.execute(
    `INSERT INTO contacts (email, display_name, interaction_count, last_interaction_at)
     VALUES ($1, $2, 0, NULL)
     ON CONFLICT(email) DO UPDATE SET
       display_name = COALESCE(NULLIF(excluded.display_name, ''), contacts.display_name)`,
    [addr, name],
  );
}

export async function searchContacts(
  query: string,
  limit = 8,
): Promise<ContactRow[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // Escape LIKE metacharacters so a `_` in the user's typing matches a
  // literal underscore, not a wildcard.
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  const db = await getDb();
  return db.select<ContactRow[]>(
    `SELECT id, email, display_name, interaction_count, last_interaction_at
       FROM contacts
      WHERE email LIKE $1 ESCAPE '\\'
         OR (display_name IS NOT NULL AND lower(display_name) LIKE $1 ESCAPE '\\')
      ORDER BY interaction_count DESC,
               COALESCE(last_interaction_at, 0) DESC,
               email ASC
      LIMIT $2`,
    [like, limit],
  );
}

/** One-shot: seed the contacts table from previously-indexed senders in
 *  `search_index`. Idempotent — safe to run every boot. */
export async function backfillContactsFromSearchIndex(): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ from_address: string | null }[]>(
    `SELECT DISTINCT from_address FROM search_index WHERE from_address IS NOT NULL`,
  );
  for (const r of rows) {
    if (!r.from_address) continue;
    const parsed = parseNameEmail(r.from_address);
    if (!parsed) continue;
    try {
      await seedContact(parsed.email, parsed.name);
    } catch {
      // Keep going on per-row errors.
    }
  }
}

export interface SentLogInput {
  accountId: number;
  providerMessageId: string | null;
  mode: DraftMode;
  replyUid: number | null;
  fromAddress: string;
  toAddresses: string;
  ccAddresses: string | null;
  bccAddresses: string | null;
  subject: string | null;
  htmlBody: string | null;
  textBody: string | null;
  attachmentsJson: string | null;
  imapAppended: boolean;
  sentAt: number;
}

export async function insertSentLog(input: SentLogInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO sent_log (
       account_id, provider_message_id, mode, reply_uid,
       from_address, to_addresses, cc_addresses, bcc_addresses,
       subject, subject_normalized, html_body, text_body, attachments_json,
       imap_appended, sent_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      input.accountId,
      input.providerMessageId,
      input.mode,
      input.replyUid,
      input.fromAddress,
      input.toAddresses,
      input.ccAddresses,
      input.bccAddresses,
      input.subject,
      normalizeSubject(input.subject),
      input.htmlBody,
      input.textBody,
      input.attachmentsJson,
      input.imapAppended ? 1 : 0,
      input.sentAt,
    ],
  );
  return Number(result.lastInsertId);
}

export interface StoredSentLogEntry {
  id: number;
  account_id: number;
  provider_message_id: string | null;
  mode: DraftMode;
  reply_uid: number | null;
  from_address: string;
  to_addresses: string;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  html_body: string | null;
  text_body: string | null;
  attachments_json: string | null;
  imap_appended: number;
  sent_at: number;
}

export async function listSentLog(
  accountId: number | null,
  limit = 100,
): Promise<StoredSentLogEntry[]> {
  const db = await getDb();
  if (accountId == null) {
    return db.select<StoredSentLogEntry[]>(
      `SELECT * FROM sent_log ORDER BY sent_at DESC LIMIT $1`,
      [limit],
    );
  }
  return db.select<StoredSentLogEntry[]>(
    `SELECT * FROM sent_log WHERE account_id = $1 ORDER BY sent_at DESC LIMIT $2`,
    [accountId, limit],
  );
}

export async function deleteSentLogEntry(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM sent_log WHERE id = $1`, [id]);
}

export async function countSearchIndexed(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<[{ n: number }]>(
    "SELECT COUNT(*) AS n FROM search_index",
  );
  return rows[0]?.n ?? 0;
}

export interface SearchIndexEntry {
  accountId: number;
  folderPath: string;
  imapUid: number;
  subject: string | null;
  fromAddress: string | null;
  toAddresses: string | null;
  snippet: string | null;
  receivedAt: number | null;
}

export async function upsertSearchIndex(e: SearchIndexEntry): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO search_index (
       account_id, folder_path, imap_uid,
       subject, from_address, to_addresses, snippet, received_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(account_id, folder_path, imap_uid) DO UPDATE SET
       subject = excluded.subject,
       from_address = excluded.from_address,
       to_addresses = excluded.to_addresses,
       snippet = excluded.snippet,
       received_at = excluded.received_at`,
    [
      e.accountId,
      e.folderPath,
      e.imapUid,
      e.subject,
      e.fromAddress,
      e.toAddresses,
      e.snippet,
      e.receivedAt,
    ],
  );
}

export async function upsertSearchBody(
  accountId: number,
  folderPath: string,
  imapUid: number,
  textBody: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE search_index SET text_body = $4
      WHERE account_id = $1 AND folder_path = $2 AND imap_uid = $3`,
    [accountId, folderPath, imapUid, textBody],
  );
}

/** Write extracted attachment/OCR text and stamp the row so Phase 3 skips it on subsequent reindexes. */
export async function upsertAttachmentText(
  accountId: number,
  folderPath: string,
  imapUid: number,
  attachmentText: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO search_index (account_id, folder_path, imap_uid, attachment_text, attachments_indexed_at)
        VALUES ($1, $2, $3, $4, unixepoch())
        ON CONFLICT(account_id, folder_path, imap_uid) DO UPDATE SET
          attachment_text = excluded.attachment_text,
          attachments_indexed_at = unixepoch()`,
    [accountId, folderPath, imapUid, attachmentText],
  );
}

export async function deleteSearchIndexEntry(
  accountId: number,
  folderPath: string,
  imapUid: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM search_index WHERE account_id = $1 AND folder_path = $2 AND imap_uid = $3`,
    [accountId, folderPath, imapUid],
  );
}

// ─── OCR bounding-box cache ───────────────────────────────────────────────────

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Returns cached OCR words for one PDF page, or null if not yet cached. */
export async function getOcrCache(
  accountId: number,
  folderPath: string,
  imapUid: number,
  attIndex: number,
  pageNum: number,
): Promise<OcrWord[] | null> {
  const db = await getDb();
  const rows = await db.select<{ words_json: string }[]>(
    `SELECT words_json FROM attachment_ocr_cache
      WHERE account_id = $1 AND folder_path = $2 AND imap_uid = $3
        AND att_index = $4 AND page_num = $5`,
    [accountId, folderPath, imapUid, attIndex, pageNum],
  );
  if (rows.length === 0) return null;
  const first = rows[0];
  if (!first) return null;
  try { return JSON.parse(first.words_json) as OcrWord[]; }
  catch { return null; }
}

/** Writes (or replaces) the cached OCR words for one PDF page. */
export async function setOcrCache(
  accountId: number,
  folderPath: string,
  imapUid: number,
  attIndex: number,
  pageNum: number,
  words: OcrWord[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR REPLACE INTO attachment_ocr_cache
       (account_id, folder_path, imap_uid, att_index, page_num, words_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, unixepoch())`,
    [accountId, folderPath, imapUid, attIndex, pageNum, JSON.stringify(words)],
  );
}

export interface OrphanedBodyRow {
  account_id: number;
  folder_path: string;
  imap_uid: number;
  text_body: string | null;
  html_body: string | null;
}

/**
 * Returns messages that have a downloaded body but no text in search_index.
 * Used by the reindex body-repair pass to fill in search_index.text_body for
 * messages that were downloaded before body-text indexing was in place.
 */
export async function listOrphanedBodyMessages(): Promise<OrphanedBodyRow[]> {
  const db = await getDb();
  return db.select<OrphanedBodyRow[]>(
    `SELECT f.account_id, f.path AS folder_path, m.imap_uid,
            m.text_body, m.html_body
       FROM messages m
       JOIN folders f ON f.id = m.folder_id
       JOIN search_index si
         ON si.account_id = f.account_id
        AND si.folder_path = f.path
        AND si.imap_uid = m.imap_uid
      WHERE m.body_fetched_at IS NOT NULL
        AND (si.text_body IS NULL OR si.text_body = '')
        AND (m.text_body IS NOT NULL OR m.html_body IS NOT NULL)`,
  );
}

/**
 * Remove search_index rows for a folder whose UIDs are NOT in `validUids`.
 * Pass an empty array when the folder is known to be empty on the server —
 * this will wipe all stale entries for that folder.
 * Called after a full folder re-index so stale entries for moved/deleted
 * messages stop appearing in search results.
 */
export async function pruneSearchIndex(
  accountId: number,
  folderPath: string,
  validUids: number[],
): Promise<void> {
  const db = await getDb();

  if (validUids.length === 0) {
    // Folder is empty — delete every search_index entry for it.
    await db.execute(
      `DELETE FROM search_index WHERE account_id = $1 AND folder_path = $2`,
      [accountId, folderPath],
    );
    return;
  }

  // Get all indexed UIDs for this folder, then bulk-delete the stale ones.
  // This avoids generating a huge NOT IN (…) clause for large mailboxes.
  const rows = await db.select<{ imap_uid: number }[]>(
    `SELECT imap_uid FROM search_index WHERE account_id = $1 AND folder_path = $2`,
    [accountId, folderPath],
  );
  const valid = new Set(validUids);
  const stale = rows.map((r) => r.imap_uid).filter((u) => !valid.has(u));
  if (stale.length === 0) return;

  // Delete in chunks of 500 to stay within SQLite variable limits.
  const CHUNK = 500;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    const ph = chunk.map((_, j) => `$${j + 3}`).join(",");
    await db.execute(
      `DELETE FROM search_index WHERE account_id = $1 AND folder_path = $2 AND imap_uid IN (${ph})`,
      [accountId, folderPath, ...chunk],
    );
  }
}

export async function getSearchIndexBody(
  accountId: number,
  folderPath: string,
  imapUid: number,
): Promise<{ text_body: string | null; snippet: string | null; attachment_text: string | null; attachments_indexed_at: number | null } | null> {
  const db = await getDb();
  const rows = await db.select<{ text_body: string | null; snippet: string | null; attachment_text: string | null; attachments_indexed_at: number | null }[]>(
    `SELECT text_body, snippet, attachment_text, attachments_indexed_at FROM search_index
      WHERE account_id = $1 AND folder_path = $2 AND imap_uid = $3
      LIMIT 1`,
    [accountId, folderPath, imapUid],
  );
  return rows[0] ?? null;
}

export interface SearchHit {
  accountId: number;
  folderPath: string;
  imapUid: number;
  subject: string | null;
  fromAddress: string | null;
  snippet: string | null;
  receivedAt: number | null;
  rank: number;
  isStarred: number;
}

/** Number of top BM25 results shown before switching to newest-first order. */
const BM25_TOP = 15;

export async function searchMessages(
  query: string,
  limit = 50,
  offset = 0,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const escaped = `"${q.replace(/"/g, '""')}"`;
  const db = await getDb();
  try {
    // Step 1: always fetch BM25 top rows (cheap — LIMIT 15) so we know which
    // IDs to exclude from the date-sorted section and can keep pagination
    // offsets consistent across "load more" calls.
    const bm25Rows = await db.select<(SearchHit & { _id: number })[]>(
      `SELECT
         si.id AS _id,
         si.account_id AS accountId,
         si.folder_path AS folderPath,
         si.imap_uid AS imapUid,
         si.subject,
         si.from_address AS fromAddress,
         si.snippet,
         si.received_at AS receivedAt,
         bm25(search_fts) AS rank,
         COALESCE(m.is_starred, 0) AS isStarred
       FROM search_fts
       JOIN search_index si ON si.id = search_fts.rowid
       LEFT JOIN folders f ON f.account_id = si.account_id AND f.path = si.folder_path
       LEFT JOIN messages m ON m.account_id = si.account_id AND m.folder_id = f.id AND m.imap_uid = si.imap_uid
       WHERE search_fts MATCH $1
       ORDER BY bm25(search_fts) ASC
       LIMIT $2`,
      [escaped, BM25_TOP],
    );
    const bm25Count = bm25Rows.length;

    // Step 2: date-sorted query, excluding the BM25 top IDs.
    // The caller's offset is split: first BM25_TOP slots are always the BM25
    // block, so the date-sorted offset is `caller_offset - bm25Count`.
    const dateOffset = offset === 0 ? 0 : Math.max(0, offset - bm25Count);
    const dateLimit  = offset === 0 ? limit - bm25Count : limit;

    const notIn = bm25Rows.map((r) => r._id).join(",");
    const exclusion = notIn ? `AND search_fts.rowid NOT IN (${notIn})` : "";

    const dateRows = await db.select<SearchHit[]>(
      `SELECT
         si.account_id AS accountId,
         si.folder_path AS folderPath,
         si.imap_uid AS imapUid,
         si.subject,
         si.from_address AS fromAddress,
         si.snippet,
         si.received_at AS receivedAt,
         0.0 AS rank,
         COALESCE(m.is_starred, 0) AS isStarred
       FROM search_fts
       JOIN search_index si ON si.id = search_fts.rowid
       LEFT JOIN folders f ON f.account_id = si.account_id AND f.path = si.folder_path
       LEFT JOIN messages m ON m.account_id = si.account_id AND m.folder_id = f.id AND m.imap_uid = si.imap_uid
       WHERE search_fts MATCH $1
         ${exclusion}
       ORDER BY si.received_at DESC
       LIMIT $2 OFFSET $3`,
      [escaped, dateLimit, dateOffset],
    );

    // On the first page, prepend the BM25 block. On subsequent pages the
    // BM25 block was already shown, so return only the date-sorted rows.
    if (offset === 0) {
      return [...bm25Rows, ...dateRows];
    }
    return dateRows;
  } catch (err) {
    console.warn("searchMessages failed:", err);
    return [];
  }
}

// --- Folders -------------------------------------------------------------

export interface StoredFolder {
  id: number;
  account_id: number;
  path: string;
  name: string;
  delimiter: string | null;
  special_use: string | null;
  uid_validity: number | null;
  last_uid: number | null;
  unread_count: number;
  total_count: number;
}

export async function listFoldersForAccount(
  accountId: number,
): Promise<StoredFolder[]> {
  const db = await getDb();
  return db.select<StoredFolder[]>(
    `SELECT id, account_id, path, name, delimiter, special_use,
            uid_validity, last_uid, unread_count, total_count
       FROM folders
      WHERE account_id = $1`,
    [accountId],
  );
}

export interface UpsertFolderInput {
  accountId: number;
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: string | null;
  uidValidity?: number | null;
}

/**
 * Insert-or-update by (account_id, path). Returns the row id.
 * Does not touch unread_count / last_uid — those are maintained separately.
 */
export async function upsertFolder(input: UpsertFolderInput): Promise<number> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO folders (account_id, path, name, delimiter, special_use, uid_validity)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(account_id, path) DO UPDATE SET
       name = excluded.name,
       delimiter = excluded.delimiter,
       special_use = excluded.special_use,
       uid_validity = COALESCE(excluded.uid_validity, folders.uid_validity)`,
    [
      input.accountId,
      input.path,
      input.name,
      input.delimiter,
      input.specialUse,
      input.uidValidity ?? null,
    ],
  );
  const rows = await db.select<{ id: number }[]>(
    `SELECT id FROM folders WHERE account_id = $1 AND path = $2`,
    [input.accountId, input.path],
  );
  if (!rows[0]) throw new Error(`upsertFolder: row missing after insert`);
  return rows[0].id;
}

/**
 * Remove folders that the IMAP server no longer advertises. Cascades into
 * messages via the FK. Pass the full set of paths the server still has.
 */
export async function pruneFolders(
  accountId: number,
  keepPaths: string[],
): Promise<void> {
  const db = await getDb();
  if (keepPaths.length === 0) {
    await db.execute(`DELETE FROM folders WHERE account_id = $1`, [accountId]);
    return;
  }
  // Build a parameter list ($2, $3, ...) for the NOT IN clause.
  const placeholders = keepPaths.map((_, i) => `$${i + 2}`).join(", ");
  await db.execute(
    `DELETE FROM folders
       WHERE account_id = $1 AND path NOT IN (${placeholders})`,
    [accountId, ...keepPaths],
  );
}

export async function setFolderUnreadCount(
  folderId: number,
  unread: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE folders SET unread_count = $1 WHERE id = $2`, [
    Math.max(0, unread),
    folderId,
  ]);
}

// --- Messages ------------------------------------------------------------

export interface StoredMessage {
  id: number;
  thread_id: number | null;
  account_id: number;
  folder_id: number;
  imap_uid: number;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  snippet: string | null;
  html_body: string | null;
  text_body: string | null;
  received_at: number | null;
  flags: string | null;
  is_unread: number;
  is_starred: number;
  is_important: number;
  has_attachments: number;
  is_bulk: number;
  is_auto: number;
  attachments_json: string | null;
  body_fetched_at: number | null;
}

export interface UpsertMessageInput {
  accountId: number;
  folderId: number;
  imapUid: number;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  fromAddress: string | null;
  toAddresses: string | null;
  ccAddresses?: string | null;
  bccAddresses?: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: number | null;
  flags: string[];
  isUnread: boolean;
  /** Omit to preserve the existing DB value (used when a toggleStar is in-flight). */
  isStarred?: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
  isBulk: boolean;
  isAuto: boolean;
  /** Pre-computed normalizeSubject(subject). If omitted, computed automatically. */
  subjectNormalized?: string | null;
}

/**
 * Insert summary fields. Body fields (html_body / text_body / attachments)
 * are filled later by setMessageBody when the user opens the message.
 * Star / unread / important are updated on conflict so server-side flag
 * changes are reflected locally on the next sync.
 */
export async function upsertMessageSummary(input: UpsertMessageInput): Promise<void> {
  const db = await getDb();
  const subjectNorm = input.subjectNormalized ?? normalizeSubject(input.subject);
  await db.execute(
    `INSERT INTO messages (
       account_id, folder_id, imap_uid,
       message_id_header, in_reply_to, references_header,
       from_address, to_addresses, cc_addresses, bcc_addresses,
       subject, subject_normalized, snippet, received_at, flags,
       is_unread, is_starred, is_important, has_attachments, is_bulk, is_auto
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
     )
     ON CONFLICT(account_id, folder_id, imap_uid) DO UPDATE SET
       message_id_header = COALESCE(excluded.message_id_header, messages.message_id_header),
       in_reply_to = COALESCE(excluded.in_reply_to, messages.in_reply_to),
       references_header = COALESCE(excluded.references_header, messages.references_header),
       from_address = excluded.from_address,
       to_addresses = excluded.to_addresses,
       cc_addresses = excluded.cc_addresses,
       bcc_addresses = excluded.bcc_addresses,
       subject = excluded.subject,
       subject_normalized = excluded.subject_normalized,
       snippet = excluded.snippet,
       received_at = COALESCE(excluded.received_at, messages.received_at),
       flags = excluded.flags,
       is_unread = MIN(excluded.is_unread, messages.is_unread),
       is_starred = COALESCE(excluded.is_starred, messages.is_starred),
       is_important = excluded.is_important,
       has_attachments = MAX(excluded.has_attachments, messages.has_attachments),
       is_bulk = excluded.is_bulk,
       is_auto = excluded.is_auto`,
    [
      input.accountId,
      input.folderId,
      input.imapUid,
      input.messageIdHeader ?? null,
      input.inReplyTo ?? null,
      input.referencesHeader ?? null,
      input.fromAddress,
      input.toAddresses,
      input.ccAddresses ?? null,
      input.bccAddresses ?? null,
      input.subject,
      subjectNorm,
      input.snippet,
      // Fall back to current time if the server didn't provide a date, so
      // the message still sorts near the top rather than NULL-sorting to the bottom.
      input.receivedAt ?? Math.floor(Date.now() / 1000),
      JSON.stringify(input.flags),
      input.isUnread ? 1 : 0,
      input.isStarred === undefined ? null : input.isStarred ? 1 : 0,
      input.isImportant ? 1 : 0,
      input.hasAttachments ? 1 : 0,
      input.isBulk ? 1 : 0,
      input.isAuto ? 1 : 0,
    ],
  );
}

export async function listMessagesForFolder(
  folderId: number,
  limit = 50,
): Promise<StoredMessage[]> {
  const db = await getDb();
  return db.select<StoredMessage[]>(
    `SELECT * FROM messages
      WHERE folder_id = $1
      ORDER BY received_at DESC NULLS LAST, imap_uid DESC
      LIMIT $2`,
    [folderId, limit],
  );
}

export async function listAllStarredMessages(limit = 500): Promise<StoredMessage[]> {
  const db = await getDb();
  return db.select<StoredMessage[]>(
    `SELECT * FROM messages
      WHERE is_starred = 1
      ORDER BY received_at DESC NULLS LAST, imap_uid DESC
      LIMIT $1`,
    [limit],
  );
}

/** All messages in an account that share the same base subject (strips Re:/Fwd: prefixes).
 *  JOINs the folders table so each row includes the folder path needed for body fetching.
 *  Results are sorted oldest-first so the reading pane shows chronological order. */
export interface ConversationMessage {
  uid: number;
  folder_id: number;
  folder_path: string;
  folder_name: string;
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  received_at: number | null;
  snippet: string | null;
  flags: string | null;
  has_attachments: number;
  subject: string | null;
  /** Populated only for locally-stored sent_log entries (uid is negative). */
  html_body?: string | null;
  text_body?: string | null;
}

/** Returns the cross-folder message count for every conversation, keyed by
 *  accountId + normalised subject.  Used to sync messageCount after a full
 *  folder refresh without issuing one query per thread. */
export async function getAllConversationCounts(): Promise<
  { accountId: number; baseSubject: string; count: number }[]
> {
  const db = await getDb();
  return db.select<{ accountId: number; baseSubject: string; count: number }[]>(
    `SELECT
       f.account_id                                          AS accountId,
       COALESCE(m.subject_normalized, LOWER(m.subject), '') AS baseSubject,
       COUNT(DISTINCT m.imap_uid || ':' || m.folder_id)     AS count
     FROM messages m
     JOIN folders f ON m.folder_id = f.id
     GROUP BY f.account_id, COALESCE(m.subject_normalized, LOWER(m.subject), '')`,
  );
}

export async function listConversationMessages(
  accountId: number,
  baseSubject: string, // already normalised (lowercase, prefixes stripped) by caller
  limit = 300,
  threadId?: number,
): Promise<ConversationMessage[]> {
  const db = await getDb();
  // Use exact match on subject_normalized (falls back to LOWER(subject) for
  // rows that predate migration 12 where subject_normalized is NULL).
  // If a threadId is provided, also include messages explicitly assigned to
  // that thread (handles merged threads whose secondary emails may differ).
  const threadClause = threadId != null
    ? `(COALESCE(m.subject_normalized, LOWER(m.subject)) = $2 OR m.thread_id = $4)`
    : `COALESCE(m.subject_normalized, LOWER(m.subject)) = $2`;
  const params: unknown[] = threadId != null
    ? [accountId, baseSubject, limit, threadId]
    : [accountId, baseSubject, limit];
  return db.select<ConversationMessage[]>(
    `SELECT
       m.imap_uid      AS uid,
       m.folder_id,
       f.path          AS folder_path,
       f.name          AS folder_name,
       m.from_address,
       m.to_addresses,
       m.cc_addresses,
       m.bcc_addresses,
       m.received_at,
       m.snippet,
       m.flags,
       m.has_attachments,
       m.subject,
       NULL            AS html_body,
       NULL            AS text_body
     FROM messages m
     JOIN folders f ON m.folder_id = f.id
     WHERE m.account_id = $1
       AND ${threadClause}

     UNION ALL

     -- Include locally-stored sent messages that haven't been synced back from
     -- the Sent IMAP folder yet (uid is stored as 0 - sent_log.id so it's
     -- always negative and never collides with real IMAP UIDs).
     SELECT
       0 - sl.id       AS uid,
       0               AS folder_id,
       ''              AS folder_path,
       'Sent'          AS folder_name,
       sl.from_address,
       sl.to_addresses,
       sl.cc_addresses,
       sl.bcc_addresses,
       sl.sent_at      AS received_at,
       SUBSTR(COALESCE(sl.text_body, ''), 1, 200) AS snippet,
       '["Seen"]'      AS flags,
       0               AS has_attachments,
       sl.subject,
       sl.html_body,
       sl.text_body
     FROM sent_log sl
     WHERE sl.account_id = $1
       AND (
         -- Match by normalised subject
         COALESCE(sl.subject_normalized, LOWER(sl.subject)) = $2
         -- OR match by direct reply link — handles wrong/missing subject_normalized
         -- (e.g. entries backfilled by migration 12 without prefix stripping).
         OR sl.reply_uid IN (
           SELECT m3.imap_uid FROM messages m3
           WHERE m3.account_id = $1
             AND COALESCE(m3.subject_normalized, LOWER(m3.subject)) = $2
         )
       )
       -- Skip if any IMAP folder already has this message (synced copy
       -- preferred). We match Sent OR Trash so that trashing the Sent copy
       -- doesn't cause the local sent_log placeholder to reappear as a
       -- duplicate, unbadged bubble.
       AND NOT EXISTS (
         SELECT 1 FROM messages m2
         JOIN folders f2 ON m2.folder_id = f2.id
         WHERE m2.account_id = $1
           AND f2.special_use IN ('sent', 'trash')
           AND COALESCE(m2.subject_normalized, LOWER(m2.subject)) = $2
           AND ABS(m2.received_at - sl.sent_at) <= 120
       )

     ORDER BY received_at ASC, uid ASC
     LIMIT $3`,
    params,
  );
}

export async function deleteMessage(
  folderId: number,
  imapUid: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM messages WHERE folder_id = $1 AND imap_uid = $2`,
    [folderId, imapUid],
  );
}

export async function deleteMessagesForFolder(folderId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM messages WHERE folder_id = $1`, [folderId]);
}

/**
 * Deletes sent_log rows whose subject+sent_at match any message currently in
 * the given folder. Used by Empty Trash so that, after expunge, locally-stored
 * placeholders for the same outgoing message don't resurface in the
 * cross-folder conversation view.
 */
export async function deleteSentLogForFolderMatches(
  accountId: number,
  folderId: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM sent_log
     WHERE account_id = $1
       AND id IN (
         SELECT sl.id FROM sent_log sl
         WHERE sl.account_id = $1
           AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.folder_id = $2
               AND COALESCE(m.subject_normalized, LOWER(m.subject))
                   = COALESCE(sl.subject_normalized, LOWER(sl.subject))
               AND ABS(m.received_at - sl.sent_at) <= 120
           )
       )`,
    [accountId, folderId],
  );
}

/**
 * Merges one or more threads into a primary thread locally (no IMAP changes).
 * All messages from the secondary thread IDs are re-assigned to the primary
 * thread ID, then the secondaries are deleted and the primary's metadata
 * (count, last_message_at, has_unread, participants) is recalculated.
 */
export async function mergeThreadsInDb(
  primaryId: number,
  secondaryIds: number[],
): Promise<void> {
  if (secondaryIds.length === 0) return;
  const db = await getDb();
  for (const secId of secondaryIds) {
    await db.execute(
      `UPDATE messages SET thread_id = $1 WHERE thread_id = $2`,
      [primaryId, secId],
    );
    await db.execute(`DELETE FROM threads WHERE id = $1`, [secId]);
  }
  // Recompute primary thread stats from its messages
  const stats = await db.select<{
    cnt: number;
    has_unread: number;
    last_at: number | null;
  }[]>(
    `SELECT COUNT(*) AS cnt,
            MAX(is_unread) AS has_unread,
            MAX(received_at) AS last_at
       FROM messages WHERE thread_id = $1`,
    [primaryId],
  );
  if (stats[0]) {
    const { cnt, has_unread, last_at } = stats[0];
    await db.execute(
      `UPDATE threads SET message_count = $1, has_unread = $2, last_message_at = $3 WHERE id = $4`,
      [cnt, has_unread, last_at ?? 0, primaryId],
    );
  }
}

/**
 * Removes messages from the local DB (and the search_index mirror) whose
 * IMAP UIDs are no longer present on the server. Call this after fetching
 * the server's full UID list for a folder to detect remote deletes.
 * Returns the number of messages purged.
 */
export async function purgeDeletedMessages(
  folderId: number,
  folderPath: string,
  accountId: number,
  serverUids: number[],
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ imap_uid: number }[]>(
    `SELECT imap_uid FROM messages WHERE folder_id = $1`,
    [folderId],
  );
  const serverSet = new Set(serverUids);
  const toDelete = rows.map((r) => r.imap_uid).filter((u) => !serverSet.has(u));
  for (const uid of toDelete) {
    await db.execute(
      `DELETE FROM messages WHERE folder_id = $1 AND imap_uid = $2`,
      [folderId, uid],
    );
    await db.execute(
      `DELETE FROM search_index WHERE account_id = $1 AND folder_path = $2 AND imap_uid = $3`,
      [accountId, folderPath, uid],
    ).catch(() => {});
  }
  return toDelete.length;
}

export async function updateMessageFlags(
  folderId: number,
  imapUid: number,
  patch: { isUnread?: boolean; isStarred?: boolean; isImportant?: boolean },
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: (string | number)[] = [];
  let i = 1;
  if (patch.isUnread !== undefined) {
    sets.push(`is_unread = $${i++}`);
    params.push(patch.isUnread ? 1 : 0);
  }
  if (patch.isStarred !== undefined) {
    sets.push(`is_starred = $${i++}`);
    params.push(patch.isStarred ? 1 : 0);
  }
  if (patch.isImportant !== undefined) {
    sets.push(`is_important = $${i++}`);
    params.push(patch.isImportant ? 1 : 0);
  }
  if (sets.length === 0) return;
  params.push(folderId, imapUid);
  await db.execute(
    `UPDATE messages SET ${sets.join(", ")}
      WHERE folder_id = $${i++} AND imap_uid = $${i++}`,
    params,
  );
}

// --- Thread Repair -------------------------------------------------------

export interface StoredRepairItem {
  id: number;
  account_id: number;
  folder_id: number;
  thread_id: number;
  subject: string | null;
  group_id: string | null;
  added_at: number;
  original_folder_path: string;
  message_id: string | null;
}

export async function addToThreadRepair(
  accountId: number,
  folderId: number,
  threadId: number,
  subject: string,
  originalFolderPath: string = '',
  messageId: string | null = null,
): Promise<number> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO thread_repair_items (account_id, folder_id, thread_id, subject, original_folder_path, message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(account_id, folder_id, thread_id) DO NOTHING`,
    [accountId, folderId, threadId, subject, originalFolderPath, messageId],
  );
  const rows = await db.select<{ id: number }[]>(
    `SELECT id FROM thread_repair_items
      WHERE account_id = $1 AND folder_id = $2 AND thread_id = $3`,
    [accountId, folderId, threadId],
  );
  return rows[0]?.id ?? -1;
}

export async function removeFromThreadRepair(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM thread_repair_items WHERE id = $1`, [id]);
}

export async function getMessageIdForUid(
  accountId: number,
  folderId: number,
  uid: number,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ message_id_header: string | null }[]>(
    `SELECT message_id_header FROM messages
      WHERE account_id = $1 AND folder_id = $2 AND imap_uid = $3`,
    [accountId, folderId, uid],
  );
  return rows[0]?.message_id_header ?? null;
}

export async function getThreadingHeadersForUid(
  accountId: number,
  folderId: number,
  uid: number,
): Promise<{ messageIdHeader: string | null; referencesHeader: string | null }> {
  const db = await getDb();
  const rows = await db.select<{ message_id_header: string | null; references_header: string | null }[]>(
    `SELECT message_id_header, references_header FROM messages
      WHERE account_id = $1 AND folder_id = $2 AND imap_uid = $3`,
    [accountId, folderId, uid],
  );
  return {
    messageIdHeader: rows[0]?.message_id_header ?? null,
    referencesHeader: rows[0]?.references_header ?? null,
  };
}

export async function listThreadRepairItems(): Promise<StoredRepairItem[]> {
  const db = await getDb();
  return db.select<StoredRepairItem[]>(
    `SELECT * FROM thread_repair_items ORDER BY group_id ASC NULLS LAST, added_at DESC`,
  );
}

export async function setRepairGroupId(
  ids: number[],
  groupId: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
  await db.execute(
    `UPDATE thread_repair_items SET group_id = $1 WHERE id IN (${placeholders})`,
    [groupId, ...ids],
  );
}


export interface StoredMessageBody {
  html: string | null;
  text: string | null;
  attachments: string | null; // JSON
}

export async function getMessageBody(
  folderId: number,
  imapUid: number,
): Promise<StoredMessageBody | null> {
  const db = await getDb();
  const rows = await db.select<StoredMessageBody[]>(
    `SELECT html_body AS html, text_body AS text, attachments_json AS attachments
       FROM messages
      WHERE folder_id = $1 AND imap_uid = $2 AND body_fetched_at IS NOT NULL`,
    [folderId, imapUid],
  );
  return rows[0] ?? null;
}

export async function setMessageBody(
  folderId: number,
  imapUid: number,
  html: string | null,
  text: string | null,
  attachmentsJson: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE messages SET
       html_body = $1, text_body = $2, attachments_json = $3,
       has_attachments = CASE WHEN $3 IS NOT NULL THEN 1 ELSE has_attachments END,
       body_fetched_at = unixepoch()
      WHERE folder_id = $4 AND imap_uid = $5`,
    [html, text, attachmentsJson, folderId, imapUid],
  );
}

// --- Rules ----------------------------------------------------------------

export interface StoredRule {
  id: number;
  account_id: number | null;
  name: string;
  enabled: number;
  sort_order: number;
  conditions_json: string;
  actions_json: string;
  created_at: number;
  updated_at: number;
}

export interface RuleInput {
  id?: number | null;
  accountId: number | null;
  name: string;
  enabled: boolean;
  sortOrder: number;
  conditionsJson: string;
  actionsJson: string;
}

export async function listRules(accountId: number | null): Promise<StoredRule[]> {
  const db = await getDb();
  if (accountId == null) {
    return db.select<StoredRule[]>(
      `SELECT * FROM rules ORDER BY sort_order ASC, id ASC`,
    );
  }
  // Account-scoped rules + global (account_id IS NULL) rules apply.
  return db.select<StoredRule[]>(
    `SELECT * FROM rules WHERE account_id = $1 OR account_id IS NULL
     ORDER BY sort_order ASC, id ASC`,
    [accountId],
  );
}

export async function upsertRule(input: RuleInput): Promise<number> {
  const db = await getDb();
  if (input.id != null) {
    await db.execute(
      `UPDATE rules SET account_id = $1, name = $2, enabled = $3,
         sort_order = $4, conditions_json = $5, actions_json = $6,
         updated_at = unixepoch()
       WHERE id = $7`,
      [
        input.accountId,
        input.name,
        input.enabled ? 1 : 0,
        input.sortOrder,
        input.conditionsJson,
        input.actionsJson,
        input.id,
      ],
    );
    return input.id;
  }
  const result = await db.execute(
    `INSERT INTO rules (
       account_id, name, enabled, sort_order, conditions_json, actions_json
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.accountId,
      input.name,
      input.enabled ? 1 : 0,
      input.sortOrder,
      input.conditionsJson,
      input.actionsJson,
    ],
  );
  return Number(result.lastInsertId);
}

export async function deleteRule(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM rules WHERE id = $1`, [id]);
}

// --- Scheduled sends -----------------------------------------------------

export interface ScheduledSendInput {
  accountId: number;
  payloadJson: string;
  mode: string;
  replyUid: number | null;
  draftId: number | null;
  scheduledAt: number;
}

export interface StoredScheduledSend {
  id: number;
  account_id: number;
  payload_json: string;
  mode: string;
  reply_uid: number | null;
  draft_id: number | null;
  scheduled_at: number;
  created_at: number;
}

export async function insertScheduledSend(input: ScheduledSendInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO scheduled_sends (
       account_id, payload_json, mode, reply_uid, draft_id, scheduled_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.accountId,
      input.payloadJson,
      input.mode,
      input.replyUid,
      input.draftId,
      input.scheduledAt,
    ],
  );
  return Number(result.lastInsertId);
}

export async function listDueScheduledSends(now: number): Promise<StoredScheduledSend[]> {
  const db = await getDb();
  return db.select<StoredScheduledSend[]>(
    `SELECT * FROM scheduled_sends WHERE scheduled_at <= $1 ORDER BY scheduled_at ASC`,
    [now],
  );
}

export async function deleteScheduledSend(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM scheduled_sends WHERE id = $1`, [id]);
}

export async function getAccountSecrets(id: number): Promise<{
  imapPassword: string;
  smtpPassword: string | null;
  resendApiKey: string | null;
}> {
  const db = await getDb();
  const rows = await db.select<
    Array<{
      imap_password_enc: string | null;
      smtp_password_enc: string | null;
      resend_api_key_enc: string | null;
    }>
  >(
    "SELECT imap_password_enc, smtp_password_enc, resend_api_key_enc FROM accounts WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`account ${id} not found`);
  const imapPassword = await loadSecret(secretKeyImap(id), row.imap_password_enc);
  const smtpPassword = row.smtp_password_enc
    ? await loadSecret(secretKeySmtp(id), row.smtp_password_enc)
    : null;
  const resendApiKey = row.resend_api_key_enc
    ? await loadSecret(secretKeyResend(id), row.resend_api_key_enc)
    : null;
  return { imapPassword, smtpPassword, resendApiKey };
}

// --- Address Book (full contact CRUD + CardDAV accounts) ------------------

export interface ContactRowFull {
  id: number;
  email: string;
  display_name: string | null;
  interaction_count: number;
  last_interaction_at: number | null;
  phone: string | null;
  notes: string | null;
  vcard_uid: string | null;
  carddav_etag: string | null;
  carddav_url: string | null;
  carddav_account_id: number | null;
}

export interface CardDavAccountRow {
  id: number;
  display_name: string;
  server_url: string;
  username: string;
  last_synced_at: number | null;
  created_at: number;
}

const CONTACTS_SELECT = `
  id, email, display_name, interaction_count, last_interaction_at,
  phone, notes, vcard_uid, carddav_etag, carddav_url, carddav_account_id
`;

/** Paginated contact list with optional substring search. */
export async function listContactsFull(opts: {
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ContactRowFull[]> {
  const db = await getDb();
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  if (opts.search?.trim()) {
    const escaped = opts.search.trim().replace(/[\\%_]/g, "\\$&");
    const like = `%${escaped}%`;
    return db.select<ContactRowFull[]>(
      `SELECT ${CONTACTS_SELECT} FROM contacts
        WHERE email LIKE $1 ESCAPE '\\'
           OR (display_name IS NOT NULL AND lower(display_name) LIKE $1 ESCAPE '\\')
           OR (phone IS NOT NULL AND phone LIKE $1 ESCAPE '\\')
        ORDER BY COALESCE(display_name, email) ASC
        LIMIT $2 OFFSET $3`,
      [like, limit, offset],
    );
  }
  return db.select<ContactRowFull[]>(
    `SELECT ${CONTACTS_SELECT} FROM contacts
      ORDER BY COALESCE(display_name, email) ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

export async function getContactFull(id: number): Promise<ContactRowFull | null> {
  const db = await getDb();
  const rows = await db.select<ContactRowFull[]>(
    `SELECT ${CONTACTS_SELECT} FROM contacts WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertContactFull(data: {
  email: string;
  displayName: string | null;
  phone: string | null;
  notes: string | null;
  vcardUid?: string | null;
}): Promise<number> {
  const db = await getDb();
  const addr = data.email.trim().toLowerCase();
  const uid = data.vcardUid ?? crypto.randomUUID();
  const result = await db.execute(
    `INSERT INTO contacts (email, display_name, interaction_count, last_interaction_at,
       phone, notes, vcard_uid)
     VALUES ($1, $2, 0, NULL, $3, $4, $5)
     ON CONFLICT(email) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, contacts.display_name),
       phone = COALESCE(excluded.phone, contacts.phone),
       notes = COALESCE(excluded.notes, contacts.notes),
       vcard_uid = COALESCE(contacts.vcard_uid, excluded.vcard_uid)`,
    [addr, data.displayName?.trim() || null, data.phone?.trim() || null,
     data.notes?.trim() || null, uid],
  );
  return Number(result.lastInsertId);
}

export async function updateContactFull(id: number, data: {
  email?: string;
  displayName?: string | null;
  phone?: string | null;
  notes?: string | null;
}): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (data.email !== undefined) { sets.push(`email = $${i++}`); params.push(data.email.trim().toLowerCase()); }
  if (data.displayName !== undefined) { sets.push(`display_name = $${i++}`); params.push(data.displayName?.trim() || null); }
  if (data.phone !== undefined) { sets.push(`phone = $${i++}`); params.push(data.phone?.trim() || null); }
  if (data.notes !== undefined) { sets.push(`notes = $${i++}`); params.push(data.notes?.trim() || null); }
  if (sets.length === 0) return;
  params.push(id);
  await db.execute(`UPDATE contacts SET ${sets.join(", ")} WHERE id = $${i}`, params);
}

export async function deleteContactById(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM contacts WHERE id = $1`, [id]);
}

/** Upsert a contact imported from a vCard (CardDAV sync). Updates etag and url on conflict. */
export async function upsertContactFromVCard(data: {
  email: string;
  displayName: string | null;
  phone: string | null;
  notes: string | null;
  vcardUid: string;
  cardavEtag: string;
  cardavUrl: string;
  cardavAccountId: number;
}): Promise<void> {
  const db = await getDb();
  const addr = data.email.trim().toLowerCase();
  await db.execute(
    `INSERT INTO contacts (email, display_name, interaction_count, last_interaction_at,
       phone, notes, vcard_uid, carddav_etag, carddav_url, carddav_account_id)
     VALUES ($1, $2, 0, NULL, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(email) DO UPDATE SET
       display_name = COALESCE(excluded.display_name, contacts.display_name),
       phone = COALESCE(excluded.phone, contacts.phone),
       notes = COALESCE(excluded.notes, contacts.notes),
       vcard_uid = excluded.vcard_uid,
       carddav_etag = excluded.carddav_etag,
       carddav_url = excluded.carddav_url,
       carddav_account_id = excluded.carddav_account_id`,
    [addr, data.displayName?.trim() || null, data.phone?.trim() || null,
     data.notes?.trim() || null, data.vcardUid, data.cardavEtag,
     data.cardavUrl, data.cardavAccountId],
  );
}

/** Get contacts that belong to a given CardDAV account. */
export async function getContactsByCardDavAccount(
  accountId: number,
): Promise<ContactRowFull[]> {
  const db = await getDb();
  return db.select<ContactRowFull[]>(
    `SELECT ${CONTACTS_SELECT} FROM contacts
      WHERE carddav_account_id = $1
      ORDER BY COALESCE(display_name, email) ASC`,
    [accountId],
  );
}

// ── CardDAV server accounts ───────────────────────────────────────────────

export async function listCardDavAccounts(): Promise<CardDavAccountRow[]> {
  const db = await getDb();
  return db.select<CardDavAccountRow[]>(
    `SELECT id, display_name, server_url, username, last_synced_at, created_at
       FROM carddav_accounts ORDER BY created_at ASC`,
  );
}

export async function insertCardDavAccount(data: {
  displayName: string;
  serverUrl: string;
  username: string;
}): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO carddav_accounts (display_name, server_url, username)
     VALUES ($1, $2, $3)`,
    [data.displayName, data.serverUrl, data.username],
  );
  return Number(result.lastInsertId);
}

export async function updateCardDavAccount(id: number, data: {
  displayName?: string;
  serverUrl?: string;
  username?: string;
  lastSyncedAt?: number;
}): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (data.displayName !== undefined) { sets.push(`display_name = $${i++}`); params.push(data.displayName); }
  if (data.serverUrl !== undefined) { sets.push(`server_url = $${i++}`); params.push(data.serverUrl); }
  if (data.username !== undefined) { sets.push(`username = $${i++}`); params.push(data.username); }
  if (data.lastSyncedAt !== undefined) { sets.push(`last_synced_at = $${i++}`); params.push(data.lastSyncedAt); }
  if (sets.length === 0) return;
  params.push(id);
  await db.execute(`UPDATE carddav_accounts SET ${sets.join(", ")} WHERE id = $${i}`, params);
}

export async function deleteCardDavAccount(id: number): Promise<void> {
  const db = await getDb();
  // Detach contacts (don't delete them — user may want to keep local copies).
  await db.execute(
    `UPDATE contacts SET carddav_account_id = NULL, carddav_etag = NULL, carddav_url = NULL
      WHERE carddav_account_id = $1`,
    [id],
  );
  await db.execute(`DELETE FROM carddav_accounts WHERE id = $1`, [id]);
}

// ── Contact Groups (distribution lists) ──────────────────────────────────

export interface ContactGroupRow {
  id: number;
  name: string;
  created_at: number;
  member_count: number;
}

export async function listContactGroups(): Promise<ContactGroupRow[]> {
  const db = await getDb();
  return db.select<ContactGroupRow[]>(
    `SELECT g.id, g.name, g.created_at,
            COUNT(m.contact_id) AS member_count
       FROM contact_groups g
       LEFT JOIN contact_group_members m ON m.group_id = g.id
      GROUP BY g.id
      ORDER BY g.name ASC`,
  );
}

export async function insertContactGroup(name: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO contact_groups (name) VALUES ($1)`,
    [name.trim()],
  );
  return Number(result.lastInsertId);
}

export async function updateContactGroup(id: number, name: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE contact_groups SET name = $1 WHERE id = $2`, [name.trim(), id]);
}

export async function deleteContactGroup(id: number): Promise<void> {
  const db = await getDb();
  // CASCADE on the FK removes contact_group_members rows automatically.
  await db.execute(`DELETE FROM contact_groups WHERE id = $1`, [id]);
}

export async function listContactsInGroup(groupId: number): Promise<ContactRowFull[]> {
  const db = await getDb();
  return db.select<ContactRowFull[]>(
    `SELECT ${CONTACTS_SELECT}
       FROM contacts c
       JOIN contact_group_members m ON m.contact_id = c.id
      WHERE m.group_id = $1
      ORDER BY COALESCE(c.display_name, c.email) ASC`,
    [groupId],
  );
}

export async function addContactToGroup(groupId: number, contactId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES ($1, $2)`,
    [groupId, contactId],
  );
}

export async function removeContactFromGroup(groupId: number, contactId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2`,
    [groupId, contactId],
  );
}

/** Search groups by name — returns groups with their member emails for composer expansion. */
export interface ContactGroupSearchResult {
  id: number;
  name: string;
  member_count: number;
  member_emails: string; // comma-separated "Display Name <email>" strings
}

// ── Folder passwords ─────────────────────────────────────────────────────────

/** Returns the stored PBKDF2 hash string for a folder, or null if unprotected. */
export async function getFolderPasswordHash(folderId: number): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ password_hash: string }[]>(
    `SELECT password_hash FROM folder_passwords WHERE folder_id = $1`,
    [folderId],
  );
  return rows[0]?.password_hash ?? null;
}

/** Upsert a hash for a folder (insert or replace). */
export async function setFolderPasswordHash(folderId: number, hash: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO folder_passwords (folder_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT(folder_id) DO UPDATE SET password_hash = excluded.password_hash`,
    [folderId, hash],
  );
}

/** Remove password protection from a folder. */
export async function removeFolderPasswordHash(folderId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM folder_passwords WHERE folder_id = $1`, [folderId]);
}

/** Returns the set of folder IDs that currently have a password set. */
export async function listProtectedFolderIds(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ folder_id: number }[]>(
    `SELECT folder_id FROM folder_passwords`,
  );
  return rows.map((r) => r.folder_id);
}

export async function searchContactGroups(query: string): Promise<ContactGroupSearchResult[]> {
  const db = await getDb();
  const escaped = query.trim().replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  // Fetch matching groups.
  const groups = await db.select<{ id: number; name: string }[]>(
    `SELECT id, name FROM contact_groups WHERE name LIKE $1 ESCAPE '\\' ORDER BY name ASC LIMIT 10`,
    [like],
  );
  if (groups.length === 0) return [];
  // For each matched group, fetch member emails so the caller can expand them.
  const results: ContactGroupSearchResult[] = [];
  for (const g of groups) {
    const members = await db.select<{ email: string; display_name: string | null }[]>(
      `SELECT c.email, c.display_name
         FROM contacts c
         JOIN contact_group_members m ON m.contact_id = c.id
        WHERE m.group_id = $1
        ORDER BY COALESCE(c.display_name, c.email) ASC`,
      [g.id],
    );
    const member_emails = members
      .map((m) => {
        const name = m.display_name?.trim();
        if (!name) return m.email;
        if (/[@<>,;:"]/.test(name)) {
          const esc = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          return `"${esc}" <${m.email}>`;
        }
        return `${name} <${m.email}>`;
      })
      .join(", ");
    results.push({ id: g.id, name: g.name, member_count: members.length, member_emails });
  }
  return results;
}
