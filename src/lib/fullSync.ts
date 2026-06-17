import { ipc } from "@/lib/ipc";
import { getAccountSecrets, listAccounts, pruneSearchIndex, upsertSearchIndex } from "@/lib/db";

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

      foldersDone++;
    }
  }
}
