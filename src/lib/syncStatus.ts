/**
 * Sync-status helpers — surface "am I fully synced?" to the UI.
 *
 * For each account+folder, we compare:
 *   • localCount: rows in the local `messages` table for that folder
 *   • indexedCount: rows in `search_index` for that folder
 *
 * We deliberately do NOT live-query the IMAP server here — that would make
 * the indicator slow and online-only. The server count is known to recent
 * code paths (e.g. indexAllMail logs `folder X total=Y`) and can be cached
 * by the caller; for now the indicator is purely local-vs-indexed which is
 * already a useful proxy for "is search complete for this folder?".
 */

import { getDb } from "@/lib/db";

export interface FolderSyncStatus {
  account_id: number;
  folder_path: string;
  local_count: number;
  indexed_count: number;
  indexed_with_body: number;
}

export interface OverallSyncStatus {
  total_local: number;
  total_indexed: number;
  total_with_body: number;
  /** Messages that have at least one OCR-able attachment (PDF / DOCX / XLSX /
   *  CSV / TXT) according to their attachments_json. This is the denominator
   *  used by the inline indicator's "attach N/M" segment. */
  total_with_attachable: number;
  /** Messages whose search_index row has non-empty `attachment_text`. */
  total_with_attachment_text: number;
  /** Number of messages where a body is downloaded but not indexed for FTS. */
  pending_index: number;
  /** Number of `messages` rows with no `search_index` row at all. */
  pending_no_si: number;
  per_folder: FolderSyncStatus[];
}

/** Filename extensions / content-type fragments that the attachment indexer
 *  is able to extract text from. Kept in sync with INDEXABLE_TYPES in
 *  indexAllMail.ts and extractAttachmentText.ts. */
const ATTACHABLE_EXTS = new Set([
  "pdf", "docx", "doc", "xlsx", "xls", "txt", "csv", "md", "html", "htm", "eml",
]);
const ATTACHABLE_CT_FRAGMENTS = [
  "pdf", "wordprocessingml", "msword", "spreadsheetml", "excel", "text/", "message/rfc822",
];

function attachmentIsIndexable(att: { filename?: string | null; contentType?: string | null }): boolean {
  const ext = (att.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ATTACHABLE_EXTS.has(ext)) return true;
  const ct = (att.contentType ?? "").toLowerCase();
  return ATTACHABLE_CT_FRAGMENTS.some((frag) => ct.includes(frag));
}

/** Read overall sync status from the local DB. Cheap (a handful of SQL
 *  aggregates). Safe to call every few seconds from a polling effect. */
export async function getOverallSyncStatus(): Promise<OverallSyncStatus> {
  const db = await getDb();

  const [totals, attachmentRows, perFolderRows, orphanRows] = await Promise.all([
    db.select<{ tot: number; idx: number; body: number; att: number }[]>(
      `SELECT
         (SELECT COUNT(*) FROM messages)                                                AS tot,
         (SELECT COUNT(*) FROM search_index)                                            AS idx,
         (SELECT COUNT(*) FROM search_index WHERE text_body IS NOT NULL AND LENGTH(text_body) > 0) AS body,
         (SELECT COUNT(*) FROM search_index WHERE attachment_text IS NOT NULL AND LENGTH(attachment_text) > 0) AS att`,
    ),
    // Stream just the attachments_json for every message that has any —
    // typically a few hundred rows, so cheap to iterate in JS to count
    // those with at least one indexable attachment.
    db.select<{ attachments_json: string }[]>(
      `SELECT attachments_json FROM messages
        WHERE attachments_json IS NOT NULL`,
    ),
    db.select<FolderSyncStatus[]>(
      `SELECT m.account_id,
              f.path AS folder_path,
              COUNT(*) AS local_count,
              SUM(CASE WHEN si.id IS NOT NULL THEN 1 ELSE 0 END)                              AS indexed_count,
              SUM(CASE WHEN si.text_body IS NOT NULL AND LENGTH(si.text_body) > 0 THEN 1 ELSE 0 END) AS indexed_with_body
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         LEFT JOIN search_index si
           ON si.account_id = m.account_id
          AND si.folder_path = f.path
          AND si.imap_uid = m.imap_uid
        GROUP BY m.account_id, f.path
        ORDER BY local_count DESC`,
    ),
    db.select<{ pending_index: number; pending_no_si: number }[]>(
      `SELECT
         SUM(CASE WHEN m.body_fetched_at IS NOT NULL
                       AND (m.text_body IS NOT NULL OR m.html_body IS NOT NULL)
                       AND (si.id IS NULL OR si.text_body IS NULL OR si.text_body = '')
                  THEN 1 ELSE 0 END) AS pending_index,
         SUM(CASE WHEN si.id IS NULL THEN 1 ELSE 0 END) AS pending_no_si
       FROM messages m
       JOIN folders f ON f.id = m.folder_id
       LEFT JOIN search_index si
         ON si.account_id = m.account_id
        AND si.folder_path = f.path
        AND si.imap_uid = m.imap_uid`,
    ),
  ]);

  const t = totals[0] ?? { tot: 0, idx: 0, body: 0, att: 0 };
  const o = orphanRows[0] ?? { pending_index: 0, pending_no_si: 0 };

  // Count messages with ≥1 indexable attachment. Parse failures are skipped.
  let totalWithAttachable = 0;
  for (const row of attachmentRows) {
    try {
      const atts = JSON.parse(row.attachments_json) as { filename?: string | null; contentType?: string | null }[];
      if (Array.isArray(atts) && atts.some(attachmentIsIndexable)) {
        totalWithAttachable++;
      }
    } catch { /* malformed JSON — skip */ }
  }

  return {
    total_local: t.tot,
    total_indexed: t.idx,
    total_with_body: t.body,
    total_with_attachable: totalWithAttachable,
    total_with_attachment_text: t.att,
    pending_index: o.pending_index ?? 0,
    pending_no_si: o.pending_no_si ?? 0,
    per_folder: perFolderRows,
  };
}

/** Read sync status for a single (account, folder).  Used by the per-folder
 *  badge in the message-list header.  Returns null if the folder has no
 *  messages locally. */
export async function getFolderSyncStatus(
  accountId: number,
  folderPath: string,
): Promise<FolderSyncStatus | null> {
  const db = await getDb();
  const rows = await db.select<FolderSyncStatus[]>(
    `SELECT m.account_id,
            f.path AS folder_path,
            COUNT(*) AS local_count,
            SUM(CASE WHEN si.id IS NOT NULL THEN 1 ELSE 0 END)                              AS indexed_count,
            SUM(CASE WHEN si.text_body IS NOT NULL AND LENGTH(si.text_body) > 0 THEN 1 ELSE 0 END) AS indexed_with_body
       FROM messages m
       JOIN folders f ON f.id = m.folder_id
       LEFT JOIN search_index si
         ON si.account_id = m.account_id
        AND si.folder_path = f.path
        AND si.imap_uid = m.imap_uid
      WHERE m.account_id = $1 AND f.path = $2
      GROUP BY m.account_id, f.path
      LIMIT 1`,
    [accountId, folderPath],
  );
  return rows[0] ?? null;
}
