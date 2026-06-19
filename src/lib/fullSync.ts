import { ipc } from "@/lib/ipc";
import { getAccountSecrets, listAccounts, pruneSearchIndex, upsertSearchIndex, getOcrTextByMessageId, upsertAttachmentText, listMessagesForFolder, listFoldersForAccount, getDb } from "@/lib/db";

export interface FullSyncProgress {
  foldersDone: number;
  foldersTotal: number;
  currentFolder: string;
  messagesIndexed: number;
}

const PAGE_SIZE = 100;

/**
 * Download and index message summaries from every folder of every account
 * into the local search_index table so they appear in the search overlay.
 *
 * Calls `onProgress` on each page. Pass an AbortSignal to cancel early.
 */
export async function indexAllMailForSearch(
  onProgress: (p: FullSyncProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const accounts = await listAccounts();
  let messagesIndexed = 0;

  for (const account of accounts) {
    if (signal?.aborted) return;
    // Send-only accounts have no inbox — skip IMAP indexing.
    if (account.is_send_only) continue;

    let secrets: { imapPassword: string };
    try {
      secrets = await getAccountSecrets(account.id);
    } catch {
      continue;
    }

    const imapConfig = {
      host: account.imap_host,
      port: account.imap_port,
      security: account.imap_security,
      username: account.imap_username ?? account.email,
      password: secrets.imapPassword,
    };

    let folders;
    try {
      folders = await ipc.imapListFolders(imapConfig);
    } catch {
      continue;
    }

    // Skip folders that cannot be selected (e.g. namespace containers)
    const selectable = folders.filter(
      (f) => !f.flags.includes("\\Noselect"),
    );

    let foldersDone = 0;

    for (const folder of selectable) {
      if (signal?.aborted) return;

      onProgress({
        foldersDone,
        foldersTotal: selectable.length,
        currentFolder: folder.name,
        messagesIndexed,
      });

      // Get total message count so we know when to stop paging
      let total = 0;
      try {
        const status = await ipc.imapFolderStatus(imapConfig, folder.path);
        total = status.total;
      } catch {
        foldersDone++;
        continue;
      }

      if (total === 0) {
        foldersDone++;
        continue;
      }

      // Paginate through all messages newest-first, PAGE_SIZE at a time.
      // imapFetchMessages(offset) skips the most-recent `offset` messages.
      const indexedUids: number[] = [];
      let offset = 0;
      while (offset < total) {
        if (signal?.aborted) return;

        let summaries;
        try {
          summaries = await ipc.imapFetchMessages(
            imapConfig,
            folder.path,
            PAGE_SIZE,
            offset,
          );
        } catch {
          break;
        }

        if (summaries.length === 0) break;

        for (const s of summaries) {
          await upsertSearchIndex({
            accountId: account.id,
            folderPath: folder.path,
            imapUid: s.uid,
            subject: s.subject,
            fromAddress: s.from,
            toAddresses: s.to.join(", "),
            snippet: s.snippet,
            receivedAt: s.date,
          }).catch(() => {});
          indexedUids.push(s.uid);
          messagesIndexed++;
        }

        offset += summaries.length;

        onProgress({
          foldersDone,
          foldersTotal: selectable.length,
          currentFolder: folder.name,
          messagesIndexed,
        });

        if (summaries.length < PAGE_SIZE) break;
      }

      // Prune stale search_index entries for UIDs no longer in this folder
      // (e.g. messages that were moved or deleted since the last sync).
      await pruneSearchIndex(account.id, folder.path, indexedUids).catch(() => {});

      // OCR backfill: for messages that were moved from another folder (new UID),
      // their search_index row won't have attachment_text yet. Check OCR cache
      // by message_id_header and write the text if available.
      const dbMessages = await listMessagesForFolder(
        (await listFoldersForAccount(account.id).catch(() => [])).find(
          (f) => f.path === folder.path,
        )?.id ?? -1,
        PAGE_SIZE * 10,
      ).catch(() => []);

      for (const msg of dbMessages) {
        if (!msg.message_id_header) continue;
        if (!msg.attachments_json) continue;
        // Check if search_index already has attachment_text for this UID
        // by using the OCR cache lookup via message_id_header.
        let atts: { index: number }[];
        try { atts = JSON.parse(msg.attachments_json) as { index: number }[]; }
        catch { continue; }
        const texts = await Promise.all(
          atts.map((att) =>
            getOcrTextByMessageId(account.id, msg.message_id_header!, att.index),
          ),
        );
        const combined = texts.filter(Boolean).join("\n").trim();
        if (combined) {
          await upsertAttachmentText(account.id, folder.path, msg.imap_uid, combined).catch(() => {});
        }
      }

      foldersDone++;
    }
  }
}

/**
 * Lightweight pre-search backfill — no IMAP connection required.
 *
 * Finds all messages in the local DB that have attachments but whose
 * search_index row has no attachment_text yet. For each one, checks the
 * OCR cache (keyed by message_id_header) and writes the cached text if
 * available. This catches emails that were moved between folders after
 * being scanned, so their attachment text is searchable immediately when
 * the search overlay opens.
 */
export async function backfillAttachmentIndex(): Promise<void> {
  const db = await getDb();

  // Find messages that have attachments_json but whose search_index row
  // either doesn't exist or has no attachment_text / attachments_indexed_at.
  const rows = await db.select<{
    account_id: number;
    folder_path: string;
    imap_uid: number;
    message_id_header: string;
    attachments_json: string;
  }[]>(
    `SELECT m.account_id, f.path AS folder_path, m.imap_uid,
            m.message_id_header, m.attachments_json
     FROM messages m
     JOIN folders f ON f.id = m.folder_id
     LEFT JOIN search_index si
       ON si.account_id = m.account_id
      AND si.folder_path = f.path
      AND si.imap_uid = m.imap_uid
     WHERE m.attachments_json IS NOT NULL
       AND m.message_id_header IS NOT NULL
       AND (si.attachments_indexed_at IS NULL OR si.attachment_text IS NULL)
     LIMIT 500`,
  ).catch(() => [] as never[]);

  for (const row of rows) {
    let atts: { index: number }[];
    try { atts = JSON.parse(row.attachments_json) as { index: number }[]; }
    catch { continue; }
    if (atts.length === 0) continue;

    const texts = await Promise.all(
      atts.map((att) =>
        getOcrTextByMessageId(row.account_id, row.message_id_header, att.index),
      ),
    );
    const combined = texts.filter(Boolean).join("\n").trim();
    if (combined) {
      await upsertAttachmentText(
        row.account_id, row.folder_path, row.imap_uid, combined,
      ).catch(() => {});
    }
  }
}
