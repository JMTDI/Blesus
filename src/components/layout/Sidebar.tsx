import { useEffect, useRef, useState } from "react";
import {
  Inbox,
  Send,
  FileText,
  Archive,
  Trash2,
  Star,
  Plus,
  Settings as SettingsIcon,
  PenSquare,
  ChevronsLeft,
  Mail,
  ShieldAlert,
  Clock,
  Folder,
  Power,
  FolderPlus,
  Users,
  Lock,
  AlertTriangle,
} from "lucide-react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { useAccountsStore } from "@/stores/accounts";
import { useUiStore } from "@/stores/ui";
import { useComposerStore } from "@/stores/composer";
import {
  listDrafts,
  listProtectedFolderIds,
  getFolderPasswordHash,
  setFolderPasswordHash,
  removeFolderPasswordHash,
} from "@/lib/db";
import { hashFolderPassword, verifyFolderPassword } from "@/lib/folderPassword";
import { useThreadsStore } from "@/stores/threads";
import { toast } from "@/stores/toasts";
import {
  FolderContextMenu,
  type FolderContextMenuState,
} from "@/components/layout/FolderContextMenu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  FolderPasswordDialog,
  type FolderPasswordMode,
} from "@/components/ui/FolderPasswordDialog";
import type { Account, MailFolder } from "@/types";

function iconForFolder(folder: MailFolder): typeof Inbox {
  const special = folder.specialUse;
  if (special === "inbox") return Inbox;
  if (special === "sent") return Send;
  if (special === "drafts") return FileText;
  if (special === "archive") return Archive;
  if (special === "trash") return Trash2;
  if (special === "spam") return ShieldAlert;
  const lower = folder.name.toLowerCase();
  if (/snooze/.test(lower)) return Clock;
  if (/star|flag/.test(lower)) return Star;
  if (/spam|junk|lixo\s*electr/.test(lower)) return ShieldAlert;
  if (/trash|bin|lixo/.test(lower)) return Trash2;
  return Folder;
}

export function Sidebar() {
  const { accounts, folders, activeAccountId, activeFolderId, setActiveFolder } =
    useAccountsStore();
  const createFolder = useAccountsStore((s) => s.createFolder);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openSettings = useUiStore((s) => s.openSettings);
  const openSettingsAt = useUiStore((s) => s.openSettingsAt);
  const openCompose = useComposerStore((s) => s.openCompose);
  const starredView = useUiStore((s) => s.starredView);
  const setStarredView = useUiStore((s) => s.setStarredView);
  const setListQuery = useUiStore((s) => s.setListQuery);

  const renameFolder = useAccountsStore((s) => s.renameFolder);
  const deleteFolder = useAccountsStore((s) => s.deleteFolder);
  const reorderAccounts = useAccountsStore((s) => s.reorderAccounts);
  const emptyTrash = useThreadsStore((s) => s.emptyTrash);

  const protectedFolderIds = useUiStore((s) => s.protectedFolderIds);
  const unlockedFolderIds = useUiStore((s) => s.unlockedFolderIds);
  const setProtectedFolderIds = useUiStore((s) => s.setProtectedFolderIds);
  const markFolderProtected = useUiStore((s) => s.markFolderProtected);
  const unmarkFolderProtected = useUiStore((s) => s.unmarkFolderProtected);
  const unlockFolder = useUiStore((s) => s.unlockFolder);
  const lockFolder = useUiStore((s) => s.lockFolder);

  const [menu, setMenu] = useState<FolderContextMenuState | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState<MailFolder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [emptyingTrashFolder, setEmptyingTrashFolder] = useState<MailFolder | null>(null);
  const [emptyingTrash, setEmptyingTrash] = useState(false);

  // Password dialog state
  const [passwordFolder, setPasswordFolder] = useState<MailFolder | null>(null);
  const [passwordMode, setPasswordMode] = useState<FolderPasswordMode>("unlock");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  // Pending navigation: folder to navigate to after successful unlock
  const [pendingNavFolderId, setPendingNavFolderId] = useState<number | null>(null);
  // Drag-reorder state for the Accounts list. `dragIndex` is the row being
  // dragged; `dragOverIndex` is where a drop would land (for the line cue).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [localDraftCount, setLocalDraftCount] = useState(0);

  const composerOpen = useComposerStore((s) => s.open);
  const draftBumpKey = useComposerStore((s) => s.draftBumpKey);

  useEffect(() => {
    if (activeAccountId == null) return;
    listDrafts(activeAccountId)
      .then((drafts) => setLocalDraftCount(drafts.length))
      .catch(() => setLocalDraftCount(0));
  }, [activeAccountId, composerOpen, draftBumpKey]);

  // Load protected folder IDs from DB on startup
  useEffect(() => {
    listProtectedFolderIds()
      .then((ids) => setProtectedFolderIds(ids))
      .catch(() => {});
  }, []);

  const inboxAccounts = accounts.filter((a) => !a.isSendOnly);
  // Never treat a send-only account as the active one in the sidebar.
  const activeAccount =
    (activeAccountId != null && inboxAccounts.find((a) => a.id === activeAccountId)) ||
    inboxAccounts[0] ||
    null;
  const accountFolders = activeAccount
    ? folders.filter((f) => f.accountId === activeAccount.id)
    : [];
  const hasAccounts = inboxAccounts.length > 0;

  // If the store's activeAccountId points at a send-only account (e.g. after
  // an HMR reload or a race), correct it to the first real inbox account.
  useEffect(() => {
    if (accounts.length === 0) return;
    const active = accounts.find((a) => a.id === activeAccountId);
    if (active?.isSendOnly || (activeAccountId != null && !active)) {
      const first = inboxAccounts[0];
      if (first) useAccountsStore.getState().setActiveAccount(first.id);
    }
  }, [accounts, activeAccountId]);

  // Sum of unread across every Inbox folder per account — matches what the
  // taskbar badge uses as "this account has N new messages". Spam/Junk are
  // excluded both by specialUse and by a name-pattern fallback so quirky
  // IMAP servers without RFC 6154 attributes still get the right answer.
  const unreadByAccountId = new Map<number, number>();
  for (const f of folders) {
    if (f.specialUse !== "inbox") continue;
    if (/\b(spam|junk)\b/i.test(f.name) || /\b(spam|junk)\b/i.test(f.path)) continue;
    unreadByAccountId.set(
      f.accountId,
      (unreadByAccountId.get(f.accountId) ?? 0) + (f.unreadCount ?? 0),
    );
  }

  async function submitCreate(name: string) {
    setCreatingFolder(false);
    const trimmed = name.trim();
    if (!trimmed || !activeAccount) return;
    try {
      await createFolder(activeAccount.id, trimmed);
      toast.success(`Folder ${trimmed} created`);
    } catch (err) {
      toast.error(`Create failed: ${err}`);
    }
  }

  async function submitRename(folder: MailFolder, nextName: string) {
    setRenamingFolderId(null);
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === folder.name) return;
    // Preserve the parent-path prefix so we only rename the leaf.
    const lastSep = Math.max(
      folder.path.lastIndexOf("/"),
      folder.path.lastIndexOf("."),
    );
    const parentPrefix = lastSep >= 0 ? folder.path.slice(0, lastSep + 1) : "";
    const newPath = parentPrefix + trimmed;
    try {
      await renameFolder(folder.accountId, folder.path, newPath);
      toast.success(`Renamed to ${trimmed}`);
    } catch (err) {
      toast.error(`Rename failed: ${err}`);
    }
  }

  async function confirmDelete() {
    const folder = deletingFolder;
    if (!folder) return;
    setDeleting(true);
    try {
      await deleteFolder(folder.accountId, folder.path);
      toast.success(`Deleted ${folder.name}`);
      setDeletingFolder(null);
      setDeleteConfirmText("");
    } catch (err) {
      toast.error(`Delete failed: ${err}`);
    } finally {
      setDeleting(false);
    }
  }

  async function confirmEmptyTrash() {
    const folder = emptyingTrashFolder;
    if (!folder) return;
    setEmptyingTrash(true);
    try {
      await emptyTrash(folder.accountId, folder.path, folder.id);
      setEmptyingTrashFolder(null);
    } catch (err) {
      toast.error(`Empty Trash failed: ${err}`);
    } finally {
      setEmptyingTrash(false);
    }
  }

  function openPasswordDialog(folder: MailFolder, mode: FolderPasswordMode) {
    setPasswordFolder(folder);
    setPasswordMode(mode);
    setPasswordError(null);
    setPasswordLoading(false);
  }

  async function handlePasswordSubmit(password: string) {
    if (!passwordFolder) return;
    setPasswordLoading(true);
    setPasswordError(null);
    try {
      if (passwordMode === "set") {
        const hash = await hashFolderPassword(password);
        await setFolderPasswordHash(passwordFolder.id, hash);
        markFolderProtected(passwordFolder.id);
        setPasswordFolder(null);
        toast.success(`"${passwordFolder.name}" is now password-protected`);
      } else if (passwordMode === "remove") {
        const storedHash = await getFolderPasswordHash(passwordFolder.id);
        if (!storedHash) {
          await removeFolderPasswordHash(passwordFolder.id);
          unmarkFolderProtected(passwordFolder.id);
          setPasswordFolder(null);
          return;
        }
        const ok = await verifyFolderPassword(password, storedHash);
        if (!ok) {
          setPasswordError("Incorrect password.");
          return;
        }
        await removeFolderPasswordHash(passwordFolder.id);
        unmarkFolderProtected(passwordFolder.id);
        setPasswordFolder(null);
        toast.success(`Lock removed from "${passwordFolder.name}"`);
      } else {
        // unlock
        const storedHash = await getFolderPasswordHash(passwordFolder.id);
        if (!storedHash) {
          // No password in DB — treat as unlocked
          unlockFolder(passwordFolder.id);
          setPasswordFolder(null);
          if (pendingNavFolderId !== null) {
            setStarredView(false);
            setActiveFolder(pendingNavFolderId);
          }
          return;
        }
        const ok = await verifyFolderPassword(password, storedHash);
        if (!ok) {
          setPasswordError("Incorrect password.");
          return;
        }
        unlockFolder(passwordFolder.id);
        setPasswordFolder(null);
        if (pendingNavFolderId !== null) {
          setStarredView(false);
          setActiveFolder(pendingNavFolderId);
        }
      }
    } catch (err) {
      setPasswordError(`Error: ${err}`);
    } finally {
      setPasswordLoading(false);
    }
  }

  return (
    <aside
      className="flex flex-col bg-sidebar border-r border-soft overflow-hidden"
      aria-label="Navigation"
    >
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!hasAccounts}
          onClick={() => openCompose(null)}
          className={cn(
            "flex h-9 items-center justify-center gap-2 rounded-lg",
            sidebarCollapsed ? "w-9" : "flex-1",
            "bg-accent text-white font-medium text-[13px] shadow-soft",
            "hover:opacity-95 transition-opacity",
            !hasAccounts && "opacity-40 cursor-not-allowed",
          )}
        >
          <PenSquare size={14} />
          {!sidebarCollapsed && <span>Compose</span>}
        </button>
        <button
          type="button"
          title="Contacts"
          onClick={() => openSettingsAt("contacts")}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            "text-muted hover:bg-hover hover:text-primary transition-colors",
          )}
        >
          <Users size={15} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {hasAccounts ? (
          <>
            {!sidebarCollapsed && <SectionHeader>Mailboxes</SectionHeader>}

            <NavItem
              icon={<Star size={15} fill={starredView ? "currentColor" : "none"} />}
              label="Starred"
              active={starredView}
              collapsed={sidebarCollapsed}
              onClick={() => { setListQuery(""); setStarredView(!starredView); }}
            />

            {accountFolders.map((folder) => {
              const Icon = iconForFolder(folder);
              if (folder.id === renamingFolderId && !sidebarCollapsed) {
                return (
                  <InlineFolderInput
                    key={folder.id}
                    icon={<Icon size={15} />}
                    initialValue={folder.name}
                    onSubmit={(v) => void submitRename(folder, v)}
                    onCancel={() => setRenamingFolderId(null)}
                  />
                );
              }
              const isLocked =
                protectedFolderIds.has(folder.id) &&
                !unlockedFolderIds.has(folder.id);
              return (
                <NavItem
                  key={folder.id}
                  icon={<Icon size={15} />}
                  label={folder.name}
                  badge={folder.specialUse === "drafts" ? (localDraftCount || undefined) : (folder.unreadCount || undefined)}
                  active={folder.id === activeFolderId && !starredView}
                  collapsed={sidebarCollapsed}
                  lockIcon={isLocked}
                  onClick={() => {
                    setListQuery("");
                    if (isLocked) {
                      setPendingNavFolderId(folder.id);
                      openPasswordDialog(folder, "unlock");
                    } else {
                      setStarredView(false);
                      setActiveFolder(folder.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ folder, x: e.clientX, y: e.clientY });
                  }}
                />
              );
            })}

            {!sidebarCollapsed && activeAccount &&
              (creatingFolder ? (
                <InlineFolderInput
                  icon={<FolderPlus size={14} />}
                  initialValue=""
                  placeholder="Folder name"
                  onSubmit={(v) => void submitCreate(v)}
                  onCancel={() => setCreatingFolder(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setCreatingFolder(true)}
                  className="flex h-8 items-center gap-2.5 w-full rounded-md px-2 text-[12.5px] text-muted hover:text-primary hover:bg-hover mt-1"
                >
                  <FolderPlus size={14} />
                  <span>New folder</span>
                </button>
              ))}

            {!sidebarCollapsed && (
              <SectionHeader className="mt-4">Accounts</SectionHeader>
            )}
            {inboxAccounts.map((account, index) => (
              <AccountRow
                key={account.id}
                account={account}
                active={account.id === activeAccountId}
                collapsed={sidebarCollapsed}
                unread={unreadByAccountId.get(account.id) ?? 0}
                index={index}
                isDragging={dragIndex === index}
                dropAbove={dragOverIndex === index && dragIndex !== null && dragIndex > index}
                dropBelow={dragOverIndex === index && dragIndex !== null && dragIndex < index}
                onDragStart={() => setDragIndex(index)}
                onDragOver={() => {
                  if (dragIndex === null || dragIndex === index) return;
                  setDragOverIndex(index);
                }}
                onDragLeave={() => {
                  setDragOverIndex((cur) => (cur === index ? null : cur));
                }}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== index) {
                    void reorderAccounts(dragIndex, index);
                  }
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
              />
            ))}
            {!sidebarCollapsed && (
              <button
                type="button"
                onClick={openSettings}
                className="flex h-8 items-center gap-2 w-full rounded-md px-2 text-[12.5px] text-muted hover:text-primary hover:bg-hover"
              >
                <Plus size={14} />
                <span>Add account</span>
              </button>
            )}
          </>
        ) : sidebarCollapsed ? null : (
          <SidebarEmpty onAdd={openSettings} />
        )}
      </nav>

      <div className="border-t border-soft px-2 py-2 flex items-center gap-1">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <ChevronsLeft
            size={15}
            style={{ transform: sidebarCollapsed ? "rotate(180deg)" : undefined }}
          />
        </button>
        {!sidebarCollapsed && (
          <button
            type="button"
            onClick={openSettings}
            className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-[12.5px] text-muted hover:bg-hover hover:text-primary"
          >
            <SettingsIcon size={15} />
            <span>Settings</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => void ipc.appQuit().catch(() => {})}
          title="Quit Blesus (Ctrl+Q)"
          aria-label="Quit Blesus"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-[color:var(--color-danger)]"
        >
          <Power size={15} />
        </button>
      </div>
      {menu && (
        <FolderContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onRequestRename={(f) => setRenamingFolderId(f.id)}
          onRequestDelete={(f) => { setDeletingFolder(f); setDeleteConfirmText(""); }}
          onRequestEmptyTrash={(f) => setEmptyingTrashFolder(f)}
          isPasswordProtected={protectedFolderIds.has(menu.folder.id)}
          isUnlocked={unlockedFolderIds.has(menu.folder.id)}
          onRequestSetPassword={(f) => openPasswordDialog(f, "set")}
          onRequestRemovePassword={(f) => openPasswordDialog(f, "remove")}
          onRequestLockNow={(f) => lockFolder(f.id)}
        />
      )}
      <FolderPasswordDialog
        open={passwordFolder !== null}
        mode={passwordMode}
        folderName={passwordFolder?.name ?? ""}
        error={passwordError}
        loading={passwordLoading}
        onSubmit={(pw) => void handlePasswordSubmit(pw)}
        onCancel={() => {
          setPasswordFolder(null);
          setPendingNavFolderId(null);
        }}
      />
      {deletingFolder !== null && (
        <>
          <div
            className="fixed inset-0 z-[60] no-drag"
            style={{ background: "rgba(0,0,0,0.55)" }}
            onClick={() => { if (!deleting) { setDeletingFolder(null); setDeleteConfirmText(""); } }}
          />
          <div
            role="alertdialog"
            className="fixed left-1/2 top-1/2 z-[61] w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl no-drag"
            style={{ background: "var(--bg-raised)", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-md)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 px-5 pt-5 pb-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(239,68,68,0.15)" }}>
                <AlertTriangle size={17} className="text-red-500" />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-primary">Delete &ldquo;{deletingFolder.name}&rdquo;?</p>
                <p className="mt-1 text-[13px] text-secondary">
                  {deletingFolder.specialUse
                    ? `"${deletingFolder.name}" is a system folder. Deleting it may cause problems with sent/received mail. All messages inside will be permanently deleted.`
                    : `All messages inside "${deletingFolder.name}" will be permanently deleted.`
                  }{" "}This cannot be undone.
                </p>
              </div>
            </div>
            <div className="px-5 pb-4">
              <label className="block text-[12px] text-secondary mb-1.5">
                Type <span className="font-semibold text-primary">{deletingFolder.name}</span> to confirm
              </label>
              <input
                autoFocus
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setDeletingFolder(null); setDeleteConfirmText(""); }
                  if (e.key === "Enter" && deleteConfirmText === deletingFolder.name && !deleting) void confirmDelete();
                }}
                className="w-full rounded-md border px-3 py-1.5 text-[13px] outline-none"
                style={{ background: "var(--bg-input)", borderColor: "var(--border-soft)", color: "var(--text-primary)" }}
                placeholder={deletingFolder.name}
              />
            </div>
            <div className="flex justify-end gap-2 px-5 pb-5">
              <button
                type="button"
                onClick={() => { if (!deleting) { setDeletingFolder(null); setDeleteConfirmText(""); } }}
                className="h-8 px-3.5 rounded-md text-[13px] text-secondary hover:bg-hover transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteConfirmText !== deletingFolder.name || deleting}
                onClick={() => { if (!deleting) void confirmDelete(); }}
                className="h-8 px-3.5 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "rgb(239,68,68)", color: "#fff" }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}
      <ConfirmDialog
        open={emptyingTrashFolder !== null}
        title="Empty Trash?"
        message="All messages in Trash will be permanently deleted. This cannot be undone."
        confirmLabel={emptyingTrash ? "Emptying…" : "Empty Trash"}
        danger
        onConfirm={() => {
          if (!emptyingTrash) void confirmEmptyTrash();
        }}
        onCancel={() => {
          if (!emptyingTrash) setEmptyingTrashFolder(null);
        }}
      />
    </aside>
  );
}

function InlineFolderInput({
  icon,
  initialValue,
  placeholder,
  onSubmit,
  onCancel,
}: {
  icon: React.ReactNode;
  initialValue: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  function submit() {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(value);
  }

  function cancel() {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onCancel();
  }

  return (
    <div
      className="flex h-8 items-center gap-2.5 w-full rounded-md px-2"
      style={{
        background: "var(--bg-hover)",
        border: "1px solid var(--accent)",
      }}
    >
      <span className="flex items-center justify-center text-accent">{icon}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          // Blur without Enter counts as cancel — keeps the UX predictable
          // and avoids accidental creates from an empty/stray input.
          cancel();
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="flex-1 bg-transparent border-0 outline-none text-[13px] text-primary placeholder:text-disabled"
      />
    </div>
  );
}

function SectionHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-disabled",
        className,
      )}
    >
      {children}
    </div>
  );
}

function NavItem({
  icon,
  label,
  badge,
  active,
  collapsed,
  lockIcon,
  onClick,
  onContextMenu,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: number;
  active?: boolean;
  collapsed?: boolean;
  lockIcon?: boolean;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "flex h-8 items-center gap-2.5 w-full rounded-md px-2 transition-colors",
        "text-[13px]",
        active
          ? "bg-accent-soft text-primary font-medium"
          : "text-secondary hover:bg-hover hover:text-primary",
        collapsed && "justify-center",
      )}
      title={collapsed ? label : undefined}
    >
      <span className={cn("flex items-center justify-center", active && "text-accent")}>
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 text-left truncate capitalize">{label}</span>
          {lockIcon && (
            <Lock size={11} className="shrink-0 text-muted" aria-label="Password protected" />
          )}
          {!lockIcon && badge ? (
            <span className="text-[11px] text-muted tabular-nums">{badge}</span>
          ) : null}
          {lockIcon && badge ? (
            <span className="text-[11px] text-muted tabular-nums">{badge}</span>
          ) : null}
        </>
      )}
    </button>
  );
}

function AccountRow({
  account,
  active,
  collapsed,
  unread,
  index,
  isDragging,
  dropAbove,
  dropBelow,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  account: Account;
  active: boolean;
  collapsed: boolean;
  unread: number;
  index: number;
  isDragging: boolean;
  dropAbove: boolean;
  dropBelow: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const { setActiveAccount } = useAccountsStore();
  return (
    <div
      className="relative"
      draggable
      onDragStart={(e) => {
        // Some browsers cancel the drag if dataTransfer has nothing.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {dropAbove && (
        <div
          aria-hidden
          className="absolute left-1 right-1 top-0 h-0.5 rounded-full"
          style={{ background: "var(--accent)" }}
        />
      )}
      {dropBelow && (
        <div
          aria-hidden
          className="absolute left-1 right-1 bottom-0 h-0.5 rounded-full"
          style={{ background: "var(--accent)" }}
        />
      )}
      <button
        type="button"
        onClick={() => setActiveAccount(account.id)}
        style={
          active
            ? {
                backgroundColor: "var(--accent-soft)",
                border: "1.5px solid var(--accent)",
                color: "var(--fg-primary)",
              }
            : { border: "1.5px solid transparent" }
        }
        className={cn(
          "flex h-11 items-center gap-2.5 w-full rounded-md px-2.5 transition-colors cursor-grab active:cursor-grabbing",
          !active && "text-secondary hover:bg-hover hover:text-primary",
          collapsed && "justify-center",
        )}
        title={collapsed ? account.email : undefined}
      >
        <span
          className="relative block h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: account.color }}
          aria-hidden
        >
          {collapsed && unread > 0 && <UnreadBadge count={unread} floating />}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 min-w-0 text-left">
              <div
                className={cn(
                  "text-[12.5px] truncate",
                  active ? "font-semibold text-primary" : "font-medium",
                )}
              >
                {account.displayName}
              </div>
              <div className="text-[11px] text-muted truncate">{account.email}</div>
            </span>
            {unread > 0 && <UnreadBadge count={unread} />}
          </>
        )}
      </button>
    </div>
  );
}

function UnreadBadge({
  count,
  floating,
}: {
  count: number;
  floating?: boolean;
}) {
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      aria-label={`${count} unread`}
      style={{
        background: "var(--color-danger)",
        color: "#fff",
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-full text-[10px] font-semibold tabular-nums leading-none shrink-0",
        // Pill proportions: short for 1–2 digits, a bit wider for 3+.
        count > 9 ? "px-1.5 h-[16px] min-w-[20px]" : "h-[16px] w-[16px]",
        // Floating variant is anchored to the coloured account dot when the
        // sidebar is collapsed — like iOS app icon badges.
        floating &&
          "absolute -right-1.5 -top-1.5 h-[14px] w-[14px] min-w-[14px] text-[9px] leading-none shadow-[0_0_0_1.5px_var(--bg-sidebar)]",
      )}
    >
      {label}
    </span>
  );
}

function SidebarEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center text-center px-3 pt-10">
      <div
        className="h-10 w-10 rounded-full flex items-center justify-center mb-3"
        style={{ background: "var(--accent-soft)" }}
      >
        <Mail size={16} className="text-accent" />
      </div>
      <p className="text-[12.5px] text-primary font-medium">No accounts</p>
      <p className="text-[11.5px] text-muted mt-1 mb-3">
        Add a mailbox to start using Blesus.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="h-8 px-3 rounded-md bg-accent text-white text-[12px] font-medium hover:opacity-95"
      >
        Add account
      </button>
    </div>
  );
}
