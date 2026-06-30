/**
 * Full-mailbox download & cache.
 *
 * Phase 1 – Headers:  for every account × folder, page through all IMAP
 *            messages and upsert them into the local `messages` table so
 *            every subject/sender/date is instantly searchable offline.
 *
 * Phase 2 – Bodies:   fetch & persist the full message body (HTML + text +
 *            attachments) for every row that hasn't been indexed yet.
 *            Results go into `messages.html_body / text_body` *and* the
 *            `search_index.text_body` FTS5 column.
 *
 * The job respects `cancelRequested` between every asynchronous step so the
 * user can abort at any time without leaving the DB in an inconsistent state.
 */

import { ipc, type ImapConfig } from "@/lib/ipc";
import type { Attachment } from "@/lib/ipc";
import {
  getAccount,
  getAccountSecrets,
  listAccounts,
  listMessagesForFolder,
  listFoldersForAccount,
  upsertMessageSummary,
  upsertSearchIndex,
  setMessageBody,
  upsertSearchBody,
  upsertAttachmentText,
  getSearchIndexBody,
  getMessageBody,
  listOrphanedBodyMessages,
  backfillSearchIndexFromMessages,
  pruneSearchIndex,
  getOcrTextByMessageId,
  getAttachmentTextByMessageId,
  getMessageIdHeaderForUid,
} from "@/lib/db";
import { loadAttachmentB64 } from "@/lib/attachmentCache";
import { extractAttachmentText } from "@/lib/extractAttachmentText";
import type { OcrCacheKey } from "@/lib/extractAttachmentText";
import { useAccountsStore } from "@/stores/accounts";
import { useFullSyncStore } from "@/stores/fullSync";
import { useUiStore } from "@/stores/ui";
import { toast } from "@/stores/toasts";

// ---------- helpers ----------

const AUTO_LOCAL =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|notifications?|alerts?|automated?|auto|system|support|updates?|mailer|postmaster|bounces?|news)$/i;

function isAuto(from: string) {
  const m = from.match(/<([^>]+)>/);
  const addr = m?.[1] ?? from;
  const local = addr.split("@")[0] ?? "";
  return AUTO_LOCAL.test(local);
}

function isBulk(flags: string[]) {
  return flags.some((f) =>
    ["$NotJunk", "NotJunk", "NonJunk", "$Junk", "Junk", "Bulk"].some(
      (kw) => f.toLowerCase() === kw.toLowerCase(),
    ),
  );
}

/** Strip HTML tags, remove style/script blocks, and decode common entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]{2,8};/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildImapConfig(account: Awaited<ReturnType<typeof getAccount>>, password: string): ImapConfig {
  if (!account) throw new Error("account is null");
  return {
    host: account.imap_host,
    port: account.imap_port,
    username: account.imap_username ?? account.email,
    password,
    security: account.imap_security,
  };
}

const HEADER_BATCH = 200; // message summaries per IMAP fetch round-trip
// Fetch this many bodies per IMAP session (one login per chunk).
// 50 messages × 1 login = ~300 logins for a 15 000-message mailbox.
// Fastmail allows 500 logins/10 min — this gives comfortable headroom.
// Smaller batches mean progress fires every 50 messages and a stalled
// server (e.g. very large email, network glitch) only blocks 50 messages
// before the 10-minute BATCH_FETCH_TIMEOUT fires and moves on.
const BODY_BATCH_SIZE = 50;

// ---------- main entry ----------

export async function indexAllMail(options?: { forceReOcr?: boolean }): Promise<void> {
  const store = useFullSyncStore.getState();
  // Prevent concurrent runs
  if (store.phase !== "idle" && store.phase !== "done" && store.phase !== "cancelled") return;

  store.start();

  const cancelled = () => useFullSyncStore.getState().cancelRequested;
  const update = (patch: Parameters<typeof store._update>[0]) =>
    useFullSyncStore.getState()._update(patch);
  const finish = (...args: Parameters<typeof store._finish>) =>
    useFullSyncStore.getState()._finish(...args);

  try {
    // ── Phase 1: Headers ────────────────────────────────────────────────
    update({ phase: "headers" });
    const { accounts, folders } = useAccountsStore.getState();

    // Real folders only (no synthetic -1 sentLog placeholder etc.)
    const realFolders = folders.filter(
      (f) => f.id > 0 && accounts.some((a) => a.id === f.accountId),
    );
    update({ foldersTotal: realFolders.length, foldersDone: 0 });

    for (let fi = 0; fi < realFolders.length; fi++) {
      if (cancelled()) { finish("cancelled"); return; }

      const folder = realFolders[fi];
      if (!folder) continue;
      console.log(`[indexAllMail] folder ${fi + 1}/${realFolders.length}: ${folder.path} — fetching account`);
      const account = await getAccount(folder.accountId);
      if (!account) { console.warn(`[indexAllMail] no account for folder ${folder.path}`); continue; }
      console.log(`[indexAllMail] fetching secrets for account ${account.id}`);
      const secrets = await getAccountSecrets(folder.accountId);
      console.log(`[indexAllMail] got secrets (password length: ${secrets.imapPassword.length}), calling imapFolderStatus`);
      const cfg = buildImapConfig(account, secrets.imapPassword);

      // Get total count from server
      let total = 0;
      let statusOk = false;
      try {
        const status = await ipc.imapFolderStatus(cfg, folder.path);
        console.log(`[indexAllMail] folder ${folder.path} total=${status.total}`);
        total = status.total ?? 0;
        statusOk = true;
      } catch (e) {
        console.error(`[indexAllMail] imapFolderStatus failed for ${folder.path}:`, e);
        update({ foldersDone: fi + 1 });
        // DO NOT prune — status RPC failed; we have no idea what's really on
        // the server. Leave existing search_index rows in place so a future
        // successful reindex doesn't lose them. Phase 2 / body-repair will
        // still operate on them via the messages table.
        continue;
      }

      if (total === 0) {
        // Server reports the folder is empty. We used to wipe all
        // search_index entries here, but this turned out to be destructive
        // for two reasons:
        //  1) Some servers/folders transiently report 0 (e.g. Sent Mail
        //     during STATUS race conditions, or when the IMAP session
        //     hasn't fully selected the folder yet).
        //  2) Even if the folder really is empty on the server, the local
        //     `messages` table may still contain copies (e.g. drafts saved
        //     locally, or messages downloaded before being remotely deleted)
        //     and we still want those searchable.
        // Skip pruning entirely and let the backfill keep rows alive.
        console.log(`[indexAllMail] folder ${folder.path} reports 0 messages — skipping prune (preserving local rows)`);
        update({ foldersDone: fi + 1 });
        continue;
      }

      // Page through oldest-first (offset 0 = newest, so page backwards)
      let offset = 0;
      let fetchError = false;
      const seenUids: number[] = [];
      while (offset < total) {
        if (cancelled()) { finish("cancelled"); return; }

        let summaries: Awaited<ReturnType<typeof ipc.imapFetchMessages>> = [];
        try {
          summaries = await ipc.imapFetchMessages(
            cfg,
            folder.path,
            HEADER_BATCH,
            offset,
          );
        } catch (e) {
          console.error(`[indexAllMail] imapFetchMessages failed for ${folder.path} offset=${offset}:`, e);
          fetchError = true;
          break; // bail out of pagination; do NOT prune below
        }

        for (const s of summaries) seenUids.push(s.uid);

        await Promise.all(
          summaries.map((s) =>
            upsertMessageSummary({
              accountId: folder.accountId,
              folderId: folder.id,
              imapUid: s.uid,
              messageIdHeader: s.messageId || null,
              inReplyTo: s.inReplyTo || null,
              referencesHeader:
                (s.references ?? []).length > 0
                  ? (s.references ?? []).join(" ")
                  : null,
              fromAddress: s.from ?? "",
              toAddresses: s.to.join(", "),
              subject: s.subject,
              snippet: s.snippet,
              receivedAt: s.date,
              flags: s.flags,
              isUnread: !s.flags.includes("Seen"),
              isStarred: s.flags.includes("Flagged"),
              isImportant: false,
              hasAttachments: s.hasAttachments,
              isBulk: isBulk(s.flags),
              isAuto: isAuto(s.from ?? ""),
            }).catch(() => {}),
          ),
        );

        // Also keep search_index in lockstep
        await Promise.all(
          summaries.map((s) =>
            upsertSearchIndex({
              accountId: folder.accountId,
              folderPath: folder.path,
              imapUid: s.uid,
              messageIdHeader: s.messageId || null,
              subject: s.subject,
              fromAddress: s.from ?? "",
              toAddresses: s.to.join(", "),
              snippet: s.snippet,
              receivedAt: s.date,
            }).catch(() => {}),
          ),
        );

        offset += summaries.length || HEADER_BATCH; // avoid infinite loop if server returns nothing
        if (summaries.length < HEADER_BATCH) break; // last page
      }

      // Remove stale search_index entries for UIDs that no longer exist in
      // this folder (e.g. messages that were moved to another folder).
      // ONLY prune when:
      //   • no fetch error occurred (so seenUids is authoritative), AND
      //   • status was successfully read, AND
      //   • we actually walked the full folder (seenUids covers ≥ total).
      // Otherwise we risk deleting rows for messages we simply didn't see.
      const fullCoverage = statusOk && !fetchError && seenUids.length >= total;
      if (fullCoverage && seenUids.length > 0) {
        await pruneSearchIndex(folder.accountId, folder.path, seenUids).catch(() => {});
      } else if (!fullCoverage) {
        console.warn(`[indexAllMail] folder ${folder.path}: incomplete coverage (statusOk=${statusOk}, fetchError=${fetchError}, seen=${seenUids.length}/${total}) — skipping prune`);
      }

      update({ foldersDone: fi + 1 });
    }

    if (cancelled()) { finish("cancelled"); return; }

    // ── Backfill missing search_index rows ─────────────────────────────
    // Some messages live in the local DB (sent-and-appended, manually fetched,
    // opened-by-user, etc.) without a corresponding search_index row. Insert
    // one for each such message using the metadata already on `messages`, so
    // the subsequent body-repair pass can populate text_body for them.
    // This is a fast SQL-only operation — no IMAP traffic.
    if (!cancelled()) {
      try {
        const inserted = await backfillSearchIndexFromMessages();
        console.log(`[indexAllMail] backfilled ${inserted} missing search_index rows from messages table`);
      } catch (e) {
        console.warn("[indexAllMail] search_index backfill failed:", e);
      }
    }

    // ── Phase 2: Bodies ─────────────────────────────────────────────────
    // Key insight: group unindexed messages by (accountId, folderPath) so we
    // can fetch an entire folder's worth of bodies in a SINGLE IMAP login,
    // using one `UID FETCH 1,2,3,…` command per BODY_BATCH_SIZE chunk.
    // This reduces logins from one-per-message to one-per-50-messages,
    // staying well under server rate limits like Fastmail's 500/10-min cap.
    update({ phase: "bodies" });

    // Gather all unindexed rows grouped by (accountId, folderPath)
    const byFolder = new Map<string, {
      accountId: number;
      folderId: number;
      folderPath: string;
      uids: number[];
    }>();

    for (const folder of realFolders) {
      if (cancelled()) break;
      const rows = await listMessagesForFolder(folder.id, 999_999).catch(() => []);
      // A message needs a body fetch if any of:
      //   • body_fetched_at IS NULL — never tried,
      //   • body_fetched_at is set but BOTH text_body and html_body are null
      //     or empty — an earlier fetch attempt completed but produced no
      //     usable body (timed-out partial response, server returned empty,
      //     pre-fix code that stamped body_fetched_at without saving the
      //     body, etc.).
      // The old `r.body_fetched_at == null` filter missed the second case,
      // which is the typical state for messages that came in via the
      // backfill / Phase-1 reprune cycle without ever having had a real
      // body persisted.
      const needsBody = (r: typeof rows[number]) => {
        if (r.body_fetched_at == null) return true;
        const t = r.text_body?.trim() ?? "";
        const h = r.html_body?.trim() ?? "";
        return t.length === 0 && h.length === 0;
      };
      const unindexed = rows.filter(needsBody);
      if (unindexed.length === 0) continue;
      const key = `${folder.accountId}::${folder.path}`;
      byFolder.set(key, {
        accountId: folder.accountId,
        folderId: folder.id,
        folderPath: folder.path,
        uids: unindexed.map((r) => r.imap_uid),
      });
    }
    // Log so we can see how many bodies the new exhaustive filter has queued
    // for fetching across all folders this run.
    const queuedBodies = [...byFolder.values()].reduce((s, f) => s + f.uids.length, 0);
    console.log(`[indexAllMail] Phase 2: queued ${queuedBodies} message bodies for fetch (across ${byFolder.size} folders)`);

    if (cancelled()) { finish("cancelled"); return; }

    const totalBodies = [...byFolder.values()].reduce((s, f) => s + f.uids.length, 0);
    update({ bodiesTotal: totalBodies, bodiesDone: 0 });

    let bodiesDone = 0;
    let totalFailed = 0;

    for (const folderGroup of byFolder.values()) {
      if (cancelled()) { finish("cancelled"); return; }

      const account = await getAccount(folderGroup.accountId);
      if (!account) { bodiesDone += folderGroup.uids.length; update({ bodiesDone }); continue; }
      const secrets = await getAccountSecrets(folderGroup.accountId);
      const cfg = buildImapConfig(account, secrets.imapPassword);

      // Chunk UIDs into BODY_BATCH_SIZE — one IMAP session per chunk
      for (let i = 0; i < folderGroup.uids.length; i += BODY_BATCH_SIZE) {
        if (cancelled()) { finish("cancelled"); return; }

        const chunk = folderGroup.uids.slice(i, i + BODY_BATCH_SIZE);
        let bodies: Awaited<ReturnType<typeof ipc.imapFetchMessageBodiesBatch>> = [];
        try {
          bodies = await ipc.imapFetchMessageBodiesBatch(cfg, folderGroup.folderPath, chunk);
        } catch {
          // Whole chunk failed (network error, auth, etc.) — count all as failed
          totalFailed += chunk.length;
          bodiesDone += chunk.length;
          update({ bodiesDone, bodiesFailed: totalFailed });
          continue;
        }

        // Persist each successfully returned body
        const returnedUids = new Set(bodies.map((b) => b.uid));
        totalFailed += chunk.filter((u) => !returnedUids.has(u)).length; // server didn't return these

        await Promise.all(
          bodies.map(async (body) => {
            try {
              const attachments = body.attachments ?? [];
              await setMessageBody(
                folderGroup.folderId,
                body.uid,
                body.html,
                body.text,
                attachments.length > 0 ? JSON.stringify(attachments) : null,
              ).catch(() => {});

              const textForIndex =
                body.text && body.text.length > 0
                  ? body.text
                  : body.html
                    ? htmlToText(body.html)
                    : "";

              // Extract text from indexable attachments and append to body text
              const attachmentTexts: string[] = [];
              const INDEXABLE_TYPES = new Set([
                "pdf", "docx", "doc", "xlsx", "xls", "txt", "csv", "md", "html", "htm", "eml",
              ]);
              for (const att of attachments) {
                const ext =
                  (att.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
                const ct = (att.contentType ?? "").toLowerCase();
                const indexable =
                  INDEXABLE_TYPES.has(ext) ||
                  ct.includes("pdf") ||
                  ct.includes("wordprocessingml") ||
                  ct.includes("spreadsheetml") ||
                  ct.includes("excel") ||
                  ct.startsWith("text/") ||
                  ct.startsWith("message/");
                if (!indexable) continue;
                try {
                  const b64 = await loadAttachmentB64(
                    folderGroup.accountId,
                    folderGroup.folderPath,
                    body.uid,
                    att.index,
                  );
                  const attText = await extractAttachmentText(
                    b64,
                    att.contentType ?? "",
                    att.filename,
                    { accountId: folderGroup.accountId, uid: body.uid, attachmentIndex: att.index } satisfies OcrCacheKey,
                  );
                  if (attText) attachmentTexts.push(attText);
                } catch {
                  // Skip attachment if fetch or extraction fails
                }
              }

              if (textForIndex) {
                await upsertSearchBody(
                  folderGroup.accountId,
                  folderGroup.folderPath,
                  body.uid,
                  textForIndex,
                ).catch(() => {});
              }
              if (attachmentTexts.length > 0) {
                await upsertAttachmentText(
                  folderGroup.accountId,
                  folderGroup.folderPath,
                  body.uid,
                  attachmentTexts.join("\n\n"),
                ).catch(() => {});
              }
            } catch {
              totalFailed++;
            }
          }),
        );

        bodiesDone += chunk.length;
        update({ bodiesDone, bodiesFailed: totalFailed });
      }
    }

    // ── Body-text repair pass ────────────────────────────────────────────
    // Fill in search_index.text_body for any messages whose body is already
    // downloaded (in the messages table) but whose search_index row has no
    // text_body yet. This covers:
    //   • messages saved by the per-message-open flow (which writes to
    //     messages.text_body/html_body and may have skipped upsertSearchBody
    //     before this fix),
    //   • messages saved by the send/append flow,
    //   • any si rows freshly created by backfillSearchIndexFromMessages
    //     above (which leaves text_body null for the repair pass to fill),
    //   • messages downloaded by an earlier version that didn't call
    //     upsertSearchBody.
    if (!cancelled()) {
      const orphans = await listOrphanedBodyMessages().catch(() => []);
      console.log(`[indexAllMail] body-repair: found ${orphans.length} downloaded messages with no indexed body text`);
      let repaired = 0;
      let skippedEmpty = 0;
      for (const row of orphans) {
        if (cancelled()) break;
        const bodyText = row.text_body && row.text_body.length > 0
          ? row.text_body
          : row.html_body
            ? htmlToText(row.html_body)
            : "";
        if (!bodyText) { skippedEmpty++; continue; }
        try {
          await upsertSearchBody(row.account_id, row.folder_path, row.imap_uid, bodyText);
          repaired++;
        } catch (e) {
          console.warn(`[indexAllMail] body-repair upsert failed acct=${row.account_id} folder=${row.folder_path} uid=${row.imap_uid}:`, e);
        }
      }
      console.log(`[indexAllMail] body-repair: repaired ${repaired}, skipped ${skippedEmpty} (empty after strip), total ${orphans.length}`);
    }

    // ── Phase 3: Attachment text extraction ─────────────────────────────
    if (!cancelled()) {
      update({ phase: "attachments", attachmentsDone: 0, attachmentsTotal: 0, attachmentsCurrentFile: null });
      // Wrap the store's cancelRequested flag as an AbortSignal so
      // extractAllAttachments respects Stop button clicks.
      const cancelSignal = { get aborted() { return cancelled(); } } as AbortSignal;
      await extractAllAttachments((p) => {
        update({
          attachmentsDone: p.done,
          attachmentsTotal: p.total,
          attachmentsCurrentFile: p.currentFile ?? null,
        });
      }, cancelSignal, { forceReOcr: options?.forceReOcr });
    }

    finish("done");
  } catch (err) {
    finish("done", String(err));
  }
}

export interface AttachmentExtractionProgress {
  done: number;
  total: number;
  currentFile?: string;
}

/**
 * Walks every account's already-fetched messages and extracts text from
 * their attachments into `search_index.text_body`.  Called by the reindex
 * button so existing mail (bodies already in the DB) gets attachment coverage
 * without needing to re-download full bodies.
 */
export async function extractAllAttachments(
  onProgress?: (p: AttachmentExtractionProgress) => void,
  signal?: AbortSignal,
  options?: { forceReOcr?: boolean },
): Promise<void> {
  const INDEXABLE_TYPES = new Set([
    "pdf", "docx", "doc", "xlsx", "xls", "txt", "csv", "md", "html", "htm", "eml",
  ]);

  interface WorkItem {
    accountId: number;
    folderId: number;
    folderPath: string;
    uid: number;
    messageIdHeader: string | null;
    indexable: Attachment[];
  }

  // Pass 1: collect all messages with indexable attachments across every folder
  const work: WorkItem[] = [];
  const accounts = await listAccounts().catch(() => []);
  for (const account of accounts) {
    if (signal?.aborted) return;
    if (account.is_send_only) continue;

    const folders = await listFoldersForAccount(account.id).catch(() => []);
    for (const folder of folders) {
      if (signal?.aborted) return;

      const messages = await listMessagesForFolder(folder.id, 999_999).catch(() => []);
      for (const msg of messages) {
        // has_attachments is unreliable (hardcoded false in IMAP summary fetch),
        // so rely only on attachments_json being non-null (set when body was downloaded).
        if (!msg.attachments_json) continue;
        let atts: Attachment[];
        try {
          atts = JSON.parse(msg.attachments_json) as Attachment[];
        } catch {
          continue;
        }
        const indexable = atts.filter((att) => {
          const ext = (att.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
          const ct = (att.contentType ?? "").toLowerCase();
          return (
            INDEXABLE_TYPES.has(ext) ||
            ct.includes("pdf") ||
            ct.includes("wordprocessingml") ||
            ct.includes("spreadsheetml") ||
            ct.includes("excel") ||
            ct.startsWith("text/") ||
            ct.startsWith("message/")
          );
        });
        if (indexable.length > 0) {
          work.push({
            accountId: account.id,
            folderId: folder.id,
            folderPath: folder.path,
            uid: msg.imap_uid,
            messageIdHeader: msg.message_id_header ?? null,
            indexable,
          });
        }
      }
    }
  }

  console.log(`[extractAllAttachments] found ${work.length} messages with indexable attachments`);
  onProgress?.({ done: 0, total: work.length });

  // Pass 2: extract text from each message's indexable attachments
  for (let i = 0; i < work.length; i++) {
    if (signal?.aborted) return;
    const item = work[i];
    if (!item) continue;

    const existing = await getSearchIndexBody(
      item.accountId, item.folderPath, item.uid,
    ).catch(() => null);
    if (!existing && !options?.forceReOcr) {
      onProgress?.({ done: i + 1, total: work.length });
      continue;
    }

    // Sub-pass A (always, fast): refresh text_body from the messages table.
    // This repairs historical messages that were never body-text indexed.
    const stored = await getMessageBody(item.folderId, item.uid).catch(() => null);
    const bodyText = stored
      ? stored.text && stored.text.length > 0
        ? stored.text
        : stored.html
          ? htmlToText(stored.html)
          : ""
      : "";
    if (bodyText) {
      await upsertSearchBody(
        item.accountId, item.folderPath, item.uid, bodyText,
      ).catch(() => {});
    }

    // Sub-pass B (skipped if already indexed, unless forceReOcr is set).
    if (!options?.forceReOcr && existing?.attachments_indexed_at != null) {
      onProgress?.({ done: i + 1, total: work.length });
      continue;
    }

    // Additional cross-folder OCR skip: if this message was previously OCR-ed
    // under a different UID (e.g. after an IMAP MOVE to Archive assigned a new
    // UID), the attachment_ocr_cache will have results keyed to the old UID.
    // We detect this via message_id_header, which is stable across folder moves.
    if (!options?.forceReOcr && item.messageIdHeader) {
      const cachedTexts = await Promise.all(
        item.indexable.map((att) =>
          getOcrTextByMessageId(item.accountId, item.messageIdHeader!, att.index),
        ),
      );
      if (cachedTexts.every((t) => t !== null)) {
        // All attachments have cached OCR text — write it to the search index
        // for the new UID so the message remains searchable, then stamp
        // attachments_indexed_at so future runs skip sub-pass B immediately.
        const combinedText = cachedTexts.filter(Boolean).join("\n").trim();
        await upsertAttachmentText(
          item.accountId, item.folderPath, item.uid, combinedText,
          item.messageIdHeader,
        ).catch(() => {});
        onProgress?.({ done: i + 1, total: work.length });
        continue;
      }
    }

    const attachmentTexts: string[] = [];
    for (const att of item.indexable) {
      onProgress?.({
        done: i,
        total: work.length,
        currentFile: att.filename ?? undefined,
      });
      try {
        const b64 = await loadAttachmentB64(
          item.accountId, item.folderPath, item.uid, att.index,
        );
        const text = await extractAttachmentText(
          b64, att.contentType ?? "", att.filename,
          { accountId: item.accountId, uid: item.uid, attachmentIndex: att.index, messageIdHeader: item.messageIdHeader } satisfies OcrCacheKey,
          options?.forceReOcr,
        );
        console.log(`[extractAllAttachments] ${att.filename}: ${text?.length ?? 0} chars extracted`);
        if (text) attachmentTexts.push(text);
      } catch (err) {
        console.error(`[extractAllAttachments] failed to load/extract ${att.filename}:`, err);
      }
    }

    // Write attachment/OCR text to attachment_text and stamp the row.
    if (attachmentTexts.length > 0) {
      await upsertAttachmentText(
        item.accountId, item.folderPath, item.uid, attachmentTexts.join("\n\n"),
        item.messageIdHeader,
      ).catch((e) => console.error(`[extractAllAttachments] upsertAttachmentText failed uid=${item.uid}:`, e));
    } else {
      // No attachment text extracted — stamp anyway so we don't re-OCR on next run.
      await upsertAttachmentText(
        item.accountId, item.folderPath, item.uid, "",
        item.messageIdHeader,
      ).catch((e) => console.error(`[extractAllAttachments] upsertAttachmentText failed uid=${item.uid}:`, e));
    }

    onProgress?.({ done: i + 1, total: work.length });
  }
}

/**
 * Lightweight function to index the bodies of a small set of new UIDs that
 * just arrived during a background sync.  Fire-and-forget; errors are silent.
 * Called from threads.ts whenever a genuinely new UID is detected.
 */
/** Keys of the form `"accountId:folderPath:uid"` that are currently being
 *  processed by an in-flight indexNewArrivals call.  Prevents duplicate
 *  "Scanning…" toasts when two sync ticks fire before OCR has finished
 *  stamping attachments_indexed_at on the row. */
const _indexingInProgress = new Set<string>();

/** Keys of the form `"accountId:messageIdHeader"` for scans currently in
 *  flight. Used to detect when a message is being scanned in one folder
 *  while a moved copy lands in another — the destination waits for the
 *  source scan to finish so it can hit the attachment_text_cache. */
const _scanningByMsgId = new Map<string, Promise<void>>();

export async function indexNewArrivals(
  accountId: number,
  folderPath: string,
  folderId: number,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;

  // Filter out any UIDs that are already being processed by a concurrent call.
  // Key on accountId+folderPath+uid because IMAP UIDs are per-folder — the
  // same numeric UID can refer to different messages in different folders.
  const keys = uids.map((uid) => `${accountId}:${folderPath}:${uid}`);
  const filteredUids = uids.filter((_, i) => !_indexingInProgress.has(keys[i]!));
  if (filteredUids.length === 0) return;

  // Mark these UIDs as in-progress for the duration of this call.
  const ownedKeys = filteredUids.map((uid) => `${accountId}:${folderPath}:${uid}`);
  for (const key of ownedKeys) _indexingInProgress.add(key);

  // Shadow the parameter so the rest of the function uses the filtered list.
  uids = filteredUids;

  // Hoisted above try/finally so the finally block can always dismiss the toast.
  let toastId: number | null = null;
  let indexedCount = 0;
  let scannedCount = 0; // attachments attempted (whether or not text was extracted)

  try {
    const account = await getAccount(accountId).catch(() => null);
    if (!account) return;
    const secrets = await getAccountSecrets(accountId).catch(() => null);
    if (!secrets) return;
    const cfg = buildImapConfig(account, secrets.imapPassword);

    const INDEXABLE_TYPES = new Set([
      "pdf", "docx", "doc", "xlsx", "xls", "txt", "csv", "md", "html", "htm", "eml",
    ]);

    for (const uid of uids) {
      try {
        // Skip UIDs that are already fully indexed (body + attachments).
        // This avoids unnecessary IMAP body fetches on every refresh tick.
        const existing = await getSearchIndexBody(accountId, folderPath, uid).catch(() => null);
        if (existing?.attachments_indexed_at != null) continue;

        const body = await ipc.imapFetchMessageBody(cfg, folderPath, uid);
        const attachments = body.attachments ?? [];
        await setMessageBody(
          folderId,
          uid,
          body.html,
          body.text,
          attachments.length > 0 ? JSON.stringify(attachments) : null,
        ).catch(() => {});

        const textForIndex =
          body.text && body.text.length > 0
            ? body.text
            : body.html
              ? htmlToText(body.html)
              : "";

        // Extract text from indexable attachments (OCR for image-only PDFs).
        // Skipped when the user has turned off "Background OCR on new mail".
        const attachmentTexts: string[] = [];
        const indexableAtts = attachments.filter((att) => {
          const ext = (att.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
          const ct = (att.contentType ?? "").toLowerCase();
          return (
            INDEXABLE_TYPES.has(ext) ||
            ct.includes("pdf") ||
            ct.includes("wordprocessingml") ||
            ct.includes("spreadsheetml") ||
            ct.includes("excel") ||
            ct.startsWith("text/") ||
            ct.startsWith("message/")
          );
        });
        // Get message_id_header — use a folder-scoped DB lookup so we get the
        // correct row. imap_uid is only unique per folder, not globally, so
        // omitting folderPath from the lookup returns the wrong row after a MOVE.
        // upsertMessageSummary runs before indexNewArrivals so the row exists.
        const messageIdHeader = await getMessageIdHeaderForUid(accountId, uid, folderPath).catch(() => null);

        // Check if all attachments are already cached (e.g. message moved
        // from another folder with a new UID). If so, use cached text directly.
        let usedCached = false;
        if (messageIdHeader && indexableAtts.length > 0) {
          // Check attachment_text_cache — keyed by message_id_header, never
          // pruned on folder move, covers both text-layer and OCR PDFs.
          // If this same message is currently being scanned in another folder
          // (e.g. we moved it while its source-folder scan was in-flight),
          // wait for that scan to finish first, then retry.
          const msgIdKey = `${accountId}:${messageIdHeader}`;
          const inflight = _scanningByMsgId.get(msgIdKey);
          if (inflight) {
            await inflight.catch(() => {});
          }
          let existingText = await getAttachmentTextByMessageId(accountId, messageIdHeader).catch(() => null);
          // If still null, retry once after a short delay — the source folder's
          // scan may have just written to attachment_text_cache milliseconds ago.
          if (!existingText) {
            await new Promise((r) => setTimeout(r, 1500));
            existingText = await getAttachmentTextByMessageId(accountId, messageIdHeader).catch(() => null);
          }
          if (existingText) {
            attachmentTexts.push(existingText);
            scannedCount += indexableAtts.length;
            usedCached = true;
          } else {
            // Fall back to OCR page cache (image-only PDFs cached by page).
            const cachedTexts = await Promise.all(
              indexableAtts.map((att) =>
                getOcrTextByMessageId(accountId, messageIdHeader, att.index),
              ),
            );
            if (cachedTexts.every((t) => t !== null)) {
              const combined = cachedTexts.filter(Boolean).join("\n").trim();
              if (combined) {
                attachmentTexts.push(combined);
                scannedCount += indexableAtts.length;
              }
              usedCached = true;
            }
          }
        }
        // Register this scan in _scanningByMsgId BEFORE OCR so any concurrent
        // indexNewArrivals for the same message (destination UID after MOVE)
        // waits for us to finish writing to attachment_text_cache.
        // eslint-disable-next-line prefer-const
        let resolveScan: (() => void) | undefined;
        if (!usedCached && messageIdHeader && indexableAtts.length > 0) {
          const msgIdKey = `${accountId}:${messageIdHeader}`;
          // Wrap in a variable so TypeScript doesn't narrow it to `never`
          const scanPromise = new Promise<void>((res) => { resolveScan = res as () => void; });
          _scanningByMsgId.set(msgIdKey, scanPromise);
        }

        if (!usedCached && useUiStore.getState().autoOcr && indexableAtts.length > 0) {
          if (toastId === null) {
            // Sticky — finally block always dismisses.
            toastId = toast.push({ kind: "info", message: "Scanning attachments in new mail\u2026", durationMs: 0 });
          }
          try {
            for (const att of indexableAtts) {
              const label = att.filename ?? "attachment";
              toast.update(toastId, { message: `Scanning \u201c${label}\u201d\u2026` });
              scannedCount++;
              const tid = toastId; // capture for closure
              try {
                const b64 = await loadAttachmentB64(accountId, folderPath, uid, att.index);
                const attText = await extractAttachmentText(
                  b64, att.contentType ?? "", att.filename,
                  { accountId, uid, attachmentIndex: att.index, messageIdHeader } satisfies OcrCacheKey,
                  false,
                  (pageNum, totalPages) => {
                    toast.update(tid, { message: `Scanning \u201c${label}\u201d \u2014 page ${pageNum} / ${totalPages}` });
                  },
                );
                if (attText) {
                  attachmentTexts.push(attText);
                  indexedCount++;
                }
              } catch (e) {
                console.warn(`[indexNewArrivals] skipped attachment "${label}":`, e);
                // Best-effort — skip attachment if fetch or extraction fails
              }
            }
          } finally {
            // Note: _scanningByMsgId is deleted and resolveScan() is called
            // AFTER upsertAttachmentText below, so waiters get the cache hit.
          }
        }

        if (textForIndex) {
          await upsertSearchBody(accountId, folderPath, uid, textForIndex).catch(() => {});
        }
        // Always stamp attachments_indexed_at so subsequent fetchFolder ticks
        // don't re-run OCR on already-processed UIDs (even when no text was
        // extracted — e.g. image-only PDFs with empty OCR, or messages with
        // no indexable attachments but body already fetched).
        // Pass messageIdHeader so attachment_text_cache is written immediately
        // without racing against upsertSearchIndex populating message_id_header.
        await upsertAttachmentText(
          accountId, folderPath, uid,
          attachmentTexts.length > 0 ? attachmentTexts.join("\n\n") : "",
          messageIdHeader,
        ).catch(() => {});
        // Signal any waiting destination-UID scans that attachment_text_cache
        // has been written and they can now retry the cache lookup.
        if (messageIdHeader) {
          const k = `${accountId}:${messageIdHeader}`;
          _scanningByMsgId.delete(k);
        }
        // Resolve the scan promise (if one was created) so waiting UIDs unblock.
        if (resolveScan) resolveScan();
      } catch {
        // Best-effort — skip if this UID fails (already logged at lower level)
      }
    }

  } finally {
    // Always dismiss the scanning toast and release in-progress locks,
    // even if an unexpected error escapes the per-UID catch blocks.
    if (toastId !== null) {
      toast.dismiss(toastId);
      // Show success toast if we scanned anything — even if extractAttachmentText
      // returned empty (e.g. text-based PDFs where the body already has the text).
      if (scannedCount > 0) {
        toast.push({ kind: "success", message: `Attachments Finished Scanning!` });
      }
    }
    for (const key of ownedKeys) _indexingInProgress.delete(key);
  }
}
