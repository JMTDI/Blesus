import { create } from "zustand";
import type { Account, MailFolder, Workspace } from "@/types";
import {
  getAccount,
  getAccountSecrets,
  listAccounts,
  listFoldersForAccount,
  pruneFolders,
  setAccountSortOrders,
  upsertFolder,
  type StoredAccount,
  type StoredFolder,
} from "@/lib/db";
import { flog } from "@/lib/logger";
import { ipc } from "@/lib/ipc";

const DEFAULT_WORKSPACE: Workspace = {
  id: 1,
  name: "Default",
  color: "#5B8DEF",
};

type SpecialUse = "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam";

const SPECIAL_USE_ORDER: Record<SpecialUse, number> = {
  inbox: 0,
  sent: 1,
  drafts: 2,
  archive: 3,
  spam: 4,
  trash: 5,
};

const FLAG_TO_SPECIAL: Record<string, SpecialUse> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Archive": "archive",
  "\\Junk": "spam",
  "\\All": "archive",
};

function accountFromStored(row: StoredAccount): Account {
  return {
    id: row.id,
    email: row.email,
    sendViaEmail: row.resend_from_address ?? null,
    displayName: row.display_name ?? row.email,
    color: row.color ?? "#5B8DEF",
    workspaceId: 1,
    unreadCount: 0,
    signatureHtml: row.signature_html ?? null,
    isSendOnly: !!row.is_send_only,
    isImapOnly: !!row.is_imap_only,
  };
}

// Synthetic folder IDs are negative so they never collide with real DB row
// ids (which are positive AUTOINCREMENT). Anywhere downstream that compares
// or persists by `folder.id` must check `id > 0` before treating it as real.
function syntheticFolders(accountId: number): MailFolder[] {
  const base = -(accountId * 10);
  return [
    { id: base - 1, accountId, name: "Inbox", path: "INBOX", specialUse: "inbox", unreadCount: 0 },
    { id: base - 2, accountId, name: "Sent", path: "Sent", specialUse: "sent", unreadCount: 0 },
    { id: base - 3, accountId, name: "Drafts", path: "Drafts", specialUse: "drafts", unreadCount: 0 },
    { id: base - 4, accountId, name: "Archive", path: "Archive", specialUse: "archive", unreadCount: 0 },
    { id: base - 5, accountId, name: "Trash", path: "Trash", specialUse: "trash", unreadCount: 0 },
  ];
}

function folderFromStored(row: StoredFolder): MailFolder {
  // Use DB value when set; fall back to name-based detection so folders
  // that were persisted before special_use was populated still work.
  const specialUse: MailFolder["specialUse"] =
    (row.special_use as MailFolder["specialUse"]) ??
    matchNameToSpecial(row.name) ??
    matchNameToSpecial(row.path.split(/[/.\\ ]/).filter(Boolean).pop() ?? "") ??
    undefined;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    path: row.path,
    specialUse,
    unreadCount: row.unread_count,
  };
}

function matchNameToSpecial(name: string): SpecialUse | undefined {
  const lower = name.toLowerCase();
  if (lower === "inbox") return "inbox";
  if (/^(sent|sent\s*(mail|items|messages))$/i.test(name)) return "sent";
  if (/^(drafts?)$/i.test(name)) return "drafts";
  if (/^(trash|deleted(\s*items)?|bin|lixo)$/i.test(name)) return "trash";
  // Handles Outlook ("Junk E-mail" / "Junk Email"), Gmail ("[Gmail]/Spam" leaf),
  // generic "Spam Mail", and PT "Lixo Electrónico". Server-flag detection still
  // wins via FLAG_TO_SPECIAL when the IMAP server advertises \Junk.
  if (
    /^(junk(\s*(e-?mail|mail))?|spam(\s*mail)?|bulk\s*mail|lixo\s*electr[oó]nico)$/i.test(
      name,
    )
  )
    return "spam";
  if (/^(archive|archived|all\s*mail)$/i.test(name)) return "archive";
  return undefined;
}

function detectSpecialUse(
  path: string,
  flags: string[],
  delimiter: string | null,
): SpecialUse | undefined {
  // RFC 6154 attributes are the gold standard — use them when the server
  // advertises them (Dovecot, Gmail, Cyrus, etc.).
  for (const f of flags) {
    const known = FLAG_TO_SPECIAL[f];
    if (known) return known;
  }
  // Full-path regex handles unprefixed servers ("Sent", "Drafts").
  const full = matchNameToSpecial(path);
  if (full) return full;
  // Leaf-name fallback handles namespace-prefixed servers ("INBOX.Sent",
  // "INBOX/Drafts"). Without this, the Sent-folder APPEND from the composer
  // would silently skip and sent mail would never appear locally.
  if (delimiter) {
    const parts = path.split(delimiter);
    const leaf = parts[parts.length - 1];
    if (leaf) return matchNameToSpecial(leaf);
  }
  return undefined;
}

function displayNameFor(path: string, delimiter: string | null): string {
  if (path.toUpperCase() === "INBOX") return "Inbox";
  if (delimiter) {
    const parts = path.split(delimiter);
    const leaf = parts[parts.length - 1];
    if (leaf) return leaf;
  }
  return path;
}

function orderFolders(folders: MailFolder[]): MailFolder[] {
  return [...folders].sort((a, b) => {
    const ao = a.specialUse ? SPECIAL_USE_ORDER[a.specialUse] : 100;
    const bo = b.specialUse ? SPECIAL_USE_ORDER[b.specialUse] : 100;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

interface AccountsState {
  workspaces: Workspace[];
  accounts: Account[];
  folders: MailFolder[];
  activeAccountId: number | null;
  activeFolderId: number | null;
  loading: boolean;

  loadAccounts: () => Promise<void>;
  reorderAccounts: (fromIndex: number, toIndex: number) => Promise<void>;
  loadFoldersFor: (accountId: number) => Promise<void>;
  createFolder: (accountId: number, name: string) => Promise<void>;
  renameFolder: (accountId: number, from: string, to: string) => Promise<void>;
  deleteFolder: (accountId: number, path: string) => Promise<void>;
  adjustFolderUnread: (folderId: number, delta: number) => void;
  setActiveAccount: (id: number | null) => void;
  setActiveFolder: (id: number | null) => void;
}

// Paths the user has just deleted but that the IMAP server may still return
// in the next LIST response (cache, residual subscription, etc.). Entries
// expire after a minute — enough for any reasonable server-side propagation.
const recentlyDeletedPaths = new Map<string, number>();
const DELETED_TTL_MS = 60_000;

function deletedKey(accountId: number, path: string): string {
  return `${accountId}::${path}`;
}

function markDeleted(accountId: number, path: string): void {
  recentlyDeletedPaths.set(deletedKey(accountId, path), Date.now() + DELETED_TTL_MS);
}

function isRecentlyDeleted(accountId: number, path: string): boolean {
  const key = deletedKey(accountId, path);
  const expires = recentlyDeletedPaths.get(key);
  if (expires == null) return false;
  if (Date.now() >= expires) {
    recentlyDeletedPaths.delete(key);
    return false;
  }
  return true;
}

async function imapConfigFor(
  accountId: number,
): Promise<{
  host: string;
  port: number;
  username: string;
  password: string;
  security: "ssl" | "starttls" | "none";
}> {
  const account = await getAccount(accountId);
  if (!account) throw new Error(`account ${accountId} not found`);
  const secrets = await getAccountSecrets(accountId);
  return {
    host: account.imap_host,
    port: account.imap_port,
    username: account.imap_username ?? account.email,
    password: secrets.imapPassword,
    security: account.imap_security,
  };
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  workspaces: [DEFAULT_WORKSPACE],
  accounts: [],
  folders: [],
  activeAccountId: null,
  activeFolderId: null,
  loading: false,

  loadAccounts: async () => {
    set({ loading: true });
    try {
      const rows = await listAccounts();
      const accounts = rows.map(accountFromStored);

      // Try persisted folders first (cold-start instant). Fall back to
      // synthetic placeholders for accounts that have never synced. Either
      // way, loadFoldersFor below will refresh from IMAP in the background.
      const folders: MailFolder[] = [];
      for (const r of rows) {
        if (r.is_send_only) continue; // send-only accounts have no folders to display
        const persisted = await listFoldersForAccount(r.id).catch(() => []);
        if (persisted.length > 0) {
          folders.push(...orderFolders(persisted.map(folderFromStored)));
        } else {
          folders.push(...syntheticFolders(r.id));
        }
      }

      const currentAccountId = get().activeAccountId;
      const stillHasCurrent = accounts.some((a) => a.id === currentAccountId && !a.isSendOnly);
      const firstAccount = accounts.find((a) => !a.isSendOnly);
      const nextAccountId = stillHasCurrent ? currentAccountId : firstAccount?.id ?? null;

      const inbox = folders.find(
        (f) => f.accountId === nextAccountId && f.specialUse === "inbox",
      );

      set({
        accounts,
        folders,
        activeAccountId: nextAccountId,
        activeFolderId: inbox?.id ?? null,
        loading: false,
      });

      // Fire off real folder loading in the background for each account.
      for (const row of rows) {
        if (row.is_send_only) continue; // no IMAP inbox to sync
        void get().loadFoldersFor(row.id);
      }
    } catch (err) {
      console.error("loadAccounts failed", err);
      set({ loading: false });
    }
  },

  reorderAccounts: async (fromIndex, toIndex) => {
    const current = get().accounts;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 || fromIndex >= current.length ||
      toIndex < 0 || toIndex >= current.length
    ) return;

    const next = current.slice();
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);

    // Optimistic — sidebar re-renders immediately, persist in the background.
    set({ accounts: next });

    try {
      await setAccountSortOrders(next.map((a) => a.id));
      flog.info(`reorderAccounts ok: ${next.map((a) => a.id).join(",")}`);
    } catch (err) {
      flog.error("reorderAccounts persist failed:", err);
      set({ accounts: current });
    }
  },

  loadFoldersFor: async (accountId) => {
    try {
      const account = await getAccount(accountId);
      if (!account) return;
      const secrets = await getAccountSecrets(accountId);

      const remote = await ipc.imapListFolders({
        host: account.imap_host,
        port: account.imap_port,
        username: account.imap_username ?? account.email,
        password: secrets.imapPassword,
        security: account.imap_security,
      });

      const candidates = remote
        .filter((f) => !f.flags.includes("\\NoSelect"))
        .filter((f) => !isRecentlyDeleted(accountId, f.path));

      // Persist each folder (insert-or-update by account_id+path) to get the
      // real DB id we can use everywhere downstream (messages.folder_id FK,
      // threads, etc). This is what unlocks T2 persistence — synthetic
      // negative ids would violate the FK on insert.
      const mapped: MailFolder[] = [];
      for (const f of candidates) {
        const specialUse = detectSpecialUse(f.path, f.flags, f.delimiter);
        const name = displayNameFor(f.path, f.delimiter);
        try {
          const id = await upsertFolder({
            accountId,
            path: f.path,
            name,
            delimiter: f.delimiter,
            specialUse: specialUse ?? null,
          });
          mapped.push({ id, accountId, name, path: f.path, specialUse, unreadCount: 0 });
        } catch (err) {
          console.warn(`upsertFolder failed for ${f.path}:`, err);
        }
      }

      // Drop any folder rows for paths the server no longer advertises.
      // CASCADE removes the messages that lived in them.
      void pruneFolders(accountId, candidates.map((c) => c.path)).catch(() => {});

      const ordered = orderFolders(mapped);

      set((state) => {
        const others = state.folders.filter((f) => f.accountId !== accountId);
        // Carry forward any unread count already in the store for this folder
        // (e.g. an optimistic adjustFolderUnread that fired before this
        // reload completes). The STATUS batch below will authorise the real
        // numbers, but we don't want a momentary flash of 0.
        const withCounts = ordered.map((f) => {
          const existing = state.folders.find((e) => e.id === f.id);
          return existing ? { ...f, unreadCount: existing.unreadCount } : f;
        });
        const newFolders = [...others, ...withCounts];

        // If the currently-active folder belonged to this account, try to
        // re-select the equivalent real folder by path; otherwise pick Inbox.
        let nextFolderId = state.activeFolderId;
        if (state.activeAccountId === accountId) {
          const prev = state.folders.find((f) => f.id === state.activeFolderId);
          const match =
            (prev && ordered.find((f) => f.path === prev.path)) ||
            ordered.find((f) => f.specialUse === "inbox") ||
            ordered[0];
          nextFolderId = match?.id ?? null;
        }

        return { folders: newFolders, activeFolderId: nextFolderId };
      });

      const imapConfig = {
        host: account.imap_host,
        port: account.imap_port,
        username: account.imap_username ?? account.email,
        password: secrets.imapPassword,
        security: account.imap_security,
      };
      // Fetch STATUS for all folders in a single IMAP session instead of
      // one LOGIN per folder — avoids exhausting the server's login rate limit.
      void (async () => {
        try {
          const paths = ordered.map((f) => f.path);
          const statuses = await ipc.imapFolderStatusBatch(imapConfig, paths);
          set((state) => ({
            folders: state.folders.map((f) => {
              const idx = ordered.findIndex((o) => o.id === f.id);
              if (idx === -1 || !statuses[idx]) return f;
              // Use Math.max so any optimistic adjustFolderUnread increment
              // that arrived while this STATUS batch was in-flight is not
              // erased.  The visTick 30-second cycle corrects drift downward
              // for inbox folders; non-inbox drift is acceptable.
              const serverCount = statuses[idx].unseen;
              const next = Math.max(f.unreadCount ?? 0, serverCount);
              if (next !== (f.unreadCount ?? 0)) console.log(`[statusBatch] ${f.name} ${f.unreadCount ?? 0} → ${next} (server=${serverCount})`);
              return { ...f, unreadCount: next };
            }),
          }));
        } catch {
          // Non-fatal: leave the badges at 0.
        }
      })();
    } catch (err) {
      console.error(`loadFoldersFor(${accountId}) failed`, err);
    }
  },

  createFolder: async (accountId, name) => {
    const config = await imapConfigFor(accountId);
    await ipc.imapCreateFolder(config, name);
    await get().loadFoldersFor(accountId);
  },

  renameFolder: async (accountId, from, to) => {
    const config = await imapConfigFor(accountId);
    await ipc.imapRenameFolder(config, from, to);
    await get().loadFoldersFor(accountId);
  },

  deleteFolder: async (accountId, path) => {
    const config = await imapConfigFor(accountId);

    // Treat NONEXISTENT as success: the folder is already gone from the
    // server, so the user's intended end-state is satisfied. The only thing
    // left is to clean the local state (below).
    try {
      await ipc.imapDeleteFolder(config, path);
    } catch (err) {
      const msg = String(err);
      if (!/NONEXISTENT|doesn't exist|does not exist/i.test(msg)) {
        throw err;
      }
    }

    // Remember this path as just-deleted. loadFoldersFor below and any
    // follow-up syncs will skip it even if the IMAP server keeps returning
    // it in LIST for a while (common with server-side caches or a lingering
    // subscription record).
    markDeleted(accountId, path);

    // Optimistic: remove from local state immediately and switch away if the
    // deleted folder was active. Don't wait for the follow-up LIST — some
    // servers hold a stale cache for a moment and would keep returning the
    // folder, leaving a phantom row in the sidebar plus a red SELECT error
    // in the message pane.
    set((state) => {
      const active = state.folders.find((f) => f.id === state.activeFolderId);
      const activeWasDeleted =
        active?.accountId === accountId && active?.path === path;
      const nextFolders = state.folders.filter(
        (f) => !(f.accountId === accountId && f.path === path),
      );
      let nextActiveFolderId = state.activeFolderId;
      if (activeWasDeleted) {
        const inbox = nextFolders.find(
          (f) => f.accountId === accountId && f.specialUse === "inbox",
        );
        nextActiveFolderId = inbox?.id ?? null;
      }
      return { folders: nextFolders, activeFolderId: nextActiveFolderId };
    });

    // Re-sync against the server so IDs/ordering stay consistent. If the
    // server's LIST cache is stale and still returns the folder, the sidebar
    // briefly shows it back — but the next sync tick resolves it.
    await get().loadFoldersFor(accountId);
  },

  adjustFolderUnread: (folderId, delta) => {
    if (delta === 0) return;
    const prev = get().folders.find((f) => f.id === folderId);
    console.log(`[adjustFolderUnread] folderId=${folderId} name=${prev?.name ?? "?"} ${prev?.unreadCount ?? 0} + ${delta}`, new Error().stack?.split("\n")[2]?.trim());
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId
          ? { ...f, unreadCount: Math.max(0, (f.unreadCount ?? 0) + delta) }
          : f,
      ),
    }));
  },

  setActiveAccount: (id) => {
    const folders = get().folders;
    const inbox = folders.find((f) => f.accountId === id && f.specialUse === "inbox");
    set({ activeAccountId: id, activeFolderId: inbox?.id ?? null });
  },

  setActiveFolder: (id) => set({ activeFolderId: id }),
}));
