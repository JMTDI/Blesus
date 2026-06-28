import {
  getDb,
  getOcrTextByMessageId,
  upsertAttachmentText,
} from "@/lib/db";

/**
 * Lightweight pre-search backfill — no IMAP connection required.
 *
 * Finds all messages in the local DB that have attachments but whose
 * search_index row has no attachment_text yet. For each one, checks the
 * OCR cache (keyed by message_id_header) and writes the cached text if
 * available. This catches emails that were moved between folders after
 * being scanned, so their attachment text is searchable immediately when
 * the search box is first used.
 *
 * Note: full-mailbox header + body + attachment indexing now lives in
 * `indexAllMail()` (src/lib/indexAllMail.ts). The previous
 * `indexAllMailForSearch` helper — and its overlay UI — was removed in
 * favour of the inline search box above the message list, whose Reindex
 * button invokes `indexAllMail` directly.
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
