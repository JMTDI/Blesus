import { create } from "zustand";
import {
  addToThreadRepair,
  removeFromThreadRepair,
  listThreadRepairItems,
  setRepairGroupId,
  getMessageIdForUid,
  deleteMessage,
  getAccount,
  getAccountSecrets,
  type StoredRepairItem,
} from "@/lib/db";
import { ipc, type ImapConfig } from "@/lib/ipc";
import { toast } from "@/stores/toasts";
import type { Thread } from "@/types";

export interface RepairItem {
  id: number;
  accountId: number;
  folderId: number;
  threadId: number;
  subject: string;
  groupId: string | null;
  addedAt: number;
  /** IMAP path the message came from (empty for thread-level reference entries) */
  originalFolderPath: string;
  /** RFC 5322 Message-ID — survives IMAP moves; null for thread-level entries */
  messageId: string | null;
}

interface ThreadRepairState {
  items: RepairItem[];
  loaded: boolean;
  /** Set of RepairItem.id values the user has checked */
  selectedIds: number[];

  load: () => Promise<void>;
  addThread: (thread: Thread) => Promise<void>;
  addMessage: (accountId: number, folderId: number, uid: number, folderPath: string, subject: string) => Promise<void>;
  moveBack: (id: number, destFolderPath: string) => Promise<void>;
  removeItem: (id: number) => Promise<void>;
  removeGroup: (groupId: string) => Promise<void>;
  toggleSelect: (id: number) => void;
  clearSelection: () => void;
  /** Assign all currently-selected items to a new shared group_id */
  mergeSelected: () => Promise<void>;
  /** Break a group apart — set group_id = NULL for all items in the group */
  unmergeGroup: (groupId: string) => Promise<void>;
}

function fromStored(r: StoredRepairItem): RepairItem {
  return {
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    threadId: r.thread_id,
    subject: r.subject ?? "(no subject)",
    groupId: r.group_id,
    addedAt: r.added_at,
    originalFolderPath: r.original_folder_path ?? "",
    messageId: r.message_id ?? null,
  };
}

export const useThreadRepairStore = create<ThreadRepairState>((set, get) => ({
  items: [],
  loaded: false,
  selectedIds: [],

  load: async () => {
    try {
      const rows = await listThreadRepairItems();
      set({ items: rows.map(fromStored), loaded: true });
    } catch (err) {
      console.warn("threadRepair load failed:", err);
      set({ loaded: true });
    }
  },

  addThread: async (thread) => {
    // Already in basket? Show info toast and bail.
    const already = get().items.some(
      (i) =>
        i.accountId === thread.accountId &&
        i.folderId === thread.folderId &&
        i.threadId === thread.id,
    );
    if (already) {
      toast.info("Already in Thread Repair");
      return;
    }
    try {
      const id = await addToThreadRepair(
        thread.accountId,
        thread.folderId,
        thread.id,
        thread.subject,
      );
      if (id > 0) {
        const newItem: RepairItem = {
          id,
          accountId: thread.accountId,
          folderId: thread.folderId,
          threadId: thread.id,
          subject: thread.subject,
          originalFolderPath: "",
          messageId: null,
          groupId: null,
          addedAt: Math.floor(Date.now() / 1000),
        };
        set((s) => ({ items: [...s.items, newItem] }));
        toast.success("Added to Thread Repair");
      }
    } catch (err) {
      toast.error(`Thread Repair: ${err}`);
    }
  },

  removeItem: async (id) => {
    await removeFromThreadRepair(id).catch(() => {});
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
    }));
  },

  removeGroup: async (groupId) => {
    const ids = get().items.filter((i) => i.groupId === groupId).map((i) => i.id);
    await Promise.all(ids.map((id) => removeFromThreadRepair(id).catch(() => {})));
    set((s) => ({
      items: s.items.filter((i) => i.groupId !== groupId),
      selectedIds: s.selectedIds.filter((sid) => !ids.includes(sid)),
    }));
  },

  toggleSelect: (id) => {
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((sid) => sid !== id)
        : [...s.selectedIds, id],
    }));
  },

  clearSelection: () => set({ selectedIds: [] }),

  mergeSelected: async () => {
    const { selectedIds } = get();
    if (selectedIds.length < 2) {
      toast.error("Select at least 2 threads to merge");
      return;
    }
    const groupId = crypto.randomUUID();
    await setRepairGroupId(selectedIds, groupId);
    set((s) => ({
      items: s.items.map((item) =>
        selectedIds.includes(item.id) ? { ...item, groupId } : item,
      ),
      selectedIds: [],
    }));
    toast.success(`Merged ${selectedIds.length} threads into one group`);
  },

  unmergeGroup: async (groupId) => {
    const ids = get().items.filter((i) => i.groupId === groupId).map((i) => i.id);
    await setRepairGroupId(ids, null);
    set((s) => ({
      items: s.items.map((item) =>
        ids.includes(item.id) ? { ...item, groupId: null } : item,
      ),
    }));
  },

  addMessage: async (accountId, folderId, uid, folderPath, subject) => {
    const REPAIR_FOLDER = "Thread Repair";
    const already = get().items.some(
      (i) => i.accountId === accountId && i.folderId === folderId && i.threadId === uid,
    );
    if (already) {
      toast.info("Already in Thread Repair");
      return;
    }
    try {
      // 1. Look up RFC 5322 Message-ID from local DB (may be null if not synced)
      const messageId = await getMessageIdForUid(accountId, folderId, uid);

      // 2. Get IMAP config
      const account = await getAccount(accountId);
      if (!account) throw new Error(`Account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      const config: ImapConfig = {
        host: account.imap_host,
        port: account.imap_port,
        username: account.imap_username ?? account.email,
        password: secrets.imapPassword ?? "",
        security: account.imap_security,
      };

      // 3. Ensure "Thread Repair" IMAP folder exists (ignore "already exists" errors)
      await ipc.imapCreateFolder(config, REPAIR_FOLDER).catch(() => {});

      // 4. Move message via IMAP
      await ipc.imapMoveUid(config, folderPath, REPAIR_FOLDER, uid);

      // 5. Remove from local messages DB
      await deleteMessage(folderId, uid).catch(() => {});

      // 6. Store in thread_repair_items with original location
      const id = await addToThreadRepair(accountId, folderId, uid, subject, folderPath, messageId);
      if (id > 0) {
        const newItem: RepairItem = {
          id,
          accountId,
          folderId,
          threadId: uid,
          subject,
          groupId: null,
          addedAt: Math.floor(Date.now() / 1000),
          originalFolderPath: folderPath,
          messageId,
        };
        set((s) => ({ items: [...s.items, newItem] }));
        toast.success("Moved to Thread Repair");
      }
    } catch (err) {
      toast.error(`Thread Repair: ${err}`);
    }
  },

  moveBack: async (id, destFolderPath) => {
    const REPAIR_FOLDER = "Thread Repair";
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    if (!item.messageId) {
      toast.error("Cannot move back: message ID not tracked (thread-level entry)");
      return;
    }
    try {
      const account = await getAccount(item.accountId);
      if (!account) throw new Error(`Account ${item.accountId} not found`);
      const secrets = await getAccountSecrets(item.accountId);
      const config: ImapConfig = {
        host: account.imap_host,
        port: account.imap_port,
        username: account.imap_username ?? account.email,
        password: secrets.imapPassword ?? "",
        security: account.imap_security,
      };

      // Find the message's current UID in Thread Repair by matching Message-ID
      const messages = await ipc.imapFetchMessages(config, REPAIR_FOLDER, 1000, 0);
      const found = messages.find((m) => m.messageId === item.messageId);
      if (!found) {
        toast.error("Message not found in Thread Repair folder — may have already been moved");
        await removeFromThreadRepair(id).catch(() => {});
        set((s) => ({
          items: s.items.filter((i) => i.id !== id),
          selectedIds: s.selectedIds.filter((sid) => sid !== id),
        }));
        return;
      }

      // Move back
      await ipc.imapMoveUid(config, REPAIR_FOLDER, destFolderPath, found.uid);
      await removeFromThreadRepair(id).catch(() => {});
      set((s) => ({
        items: s.items.filter((i) => i.id !== id),
        selectedIds: s.selectedIds.filter((sid) => sid !== id),
      }));
      toast.success(`Moved back to ${destFolderPath.split(/[\/. \\]/).filter(Boolean).pop() ?? destFolderPath}`);
    } catch (err) {
      toast.error(`Move back failed: ${err}`);
    }
  },
}));
