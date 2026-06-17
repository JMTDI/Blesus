import { useEffect, useRef, useState } from "react";
import {
  X,
  Plus,
  Trash2,
  Pencil,
  User,
  Users,
  Sliders,
  Palette,
  Keyboard,
  Mail as MailIcon,
  Filter,
  Download,
  Upload,
  MoreHorizontal,
  RefreshCw,
  HardDriveDownload,
  Square,
  CheckCircle2,
  Star,
  ArrowLeft,
  BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useUiStore, type RemoteImagesPolicy, FOLDER_AUTO_LOCK_OPTIONS_MIN } from "@/stores/ui";
import { useFullSyncStore } from "@/stores/fullSync";
import { indexAllMail } from "@/lib/indexAllMail";
import { useAccountsStore } from "@/stores/accounts";
import { useThreadsStore } from "@/stores/threads";
import { toast } from "@/stores/toasts";
import {
  deleteAccount,
  deleteRule,
  listAccounts,
  listRules,
  upsertRule,
  getAllConversationCounts,
  type StoredAccount,
  type StoredRule,
} from "@/lib/db";
import { getSettings, setSetting } from "@/lib/settings";
import type { RuleAction, RuleCondition, RuleField, RuleOp } from "@/lib/rules";
import { AccountForm } from "@/components/settings/AccountForm";
import { AddressBook } from "@/components/settings/AddressBook";
import { ExportAccountsModal } from "@/components/settings/ExportAccountsModal";
import { ImportAccountsModal } from "@/components/settings/ImportAccountsModal";
import type { Theme, ReadingPane } from "@/types";

type SectionId = "accounts" | "appearance" | "general" | "rules" | "keyboard" | "contacts" | "features";
type AccountsMode = "list" | "form";

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ElementType }> = [
  { id: "accounts", label: "Accounts", icon: MailIcon },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "general", label: "General", icon: Sliders },
  { id: "rules", label: "Rules", icon: Filter },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "features", label: "Features documentation", icon: BookOpen },
];

export function SettingsPage() {
  const closeSettings = useUiStore((s) => s.closeSettings);
  const settingsInitialSection = useUiStore((s) => s.settingsInitialSection);
  const [section, setSection] = useState<SectionId>(
    (settingsInitialSection as SectionId | null) ?? "accounts",
  );

  return (
    <section className="col-span-full flex flex-col bg-base overflow-hidden">
      <header className="flex items-center justify-between px-8 py-4 border-b border-soft shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={closeSettings}
            aria-label="Back to mail"
            className="flex items-center justify-center h-7 w-7 rounded-md text-muted hover:text-primary hover:bg-hover transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-[18px] font-semibold text-primary">Settings</h1>
        </div>
        <CloseSettingsButton onClick={closeSettings} />
      </header>

      <div className="flex-1 grid grid-cols-[220px_1fr] overflow-hidden">
        <nav className="border-r border-soft py-4 px-3 space-y-1">
          {SECTIONS.map((s) => (
            <NavTab
              key={s.id}
              icon={<s.icon size={14} />}
              active={section === s.id}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </NavTab>
          ))}
        </nav>

        <div className="overflow-y-auto">
          {section === "contacts" ? (
            <div className="px-10 py-8">
              <AddressBook />
            </div>
          ) : (
            <div className="px-10 py-8 max-w-3xl">
              {section === "accounts" && <AccountsSection />}
              {section === "appearance" && <AppearanceSection />}
              {section === "general" && <GeneralSection />}
              {section === "rules" && <RulesSection />}
              {section === "keyboard" && <KeyboardSection />}
              {section === "features" && <FeaturesSection />}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CloseSettingsButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Close settings"
      style={{
        color: hover ? "var(--color-danger)" : "var(--fg-muted)",
        transition: "color 120ms",
      }}
      className="flex h-8 w-8 items-center justify-center"
    >
      <X size={16} />
    </button>
  );
}

function NavTab({
  children,
  icon,
  active,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 items-center gap-2 w-full rounded-md px-3 text-[13px] text-left transition-colors",
        active
          ? "bg-accent-soft text-primary font-medium"
          : "text-secondary hover:bg-hover hover:text-primary",
      )}
    >
      <span className={cn(active ? "text-accent" : "text-muted")}>{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function AccountsSection() {
  const [mode, setMode] = useState<AccountsMode>("list");
  const [editingAccount, setEditingAccount] = useState<StoredAccount | null>(null);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [defaultComposeId, setDefaultComposeId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StoredAccount | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const rows = await listAccounts();
      setAccounts(rows);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    void getSettings(["default_compose_account_id"]).then((s) => {
      const v = s["default_compose_account_id"];
      setDefaultComposeId(v ? Number(v) : null);
    });
  }, []);

  async function handleSetDefault(id: number) {
    const newId = defaultComposeId === id ? null : id;
    await setSetting("default_compose_account_id", newId == null ? null : String(newId));
    setDefaultComposeId(newId);
  }

  async function handleDelete(id: number) {
    try {
      await deleteAccount(id);
      await refresh();
      await useAccountsStore.getState().loadAccounts();
    } catch (err) {
      setError(String(err));
    }
  }

  if (mode === "form") {
    return (
      <>
        <SectionHeader
          title={editingAccount ? "Edit account" : "Add account"}
          description={
            editingAccount
              ? "Passwords are pre-filled from the database. Change only what you need."
              : "Fill in IMAP for receiving, and SMTP or Resend for sending."
          }
        />
        <AccountForm
          editing={editingAccount}
          onCancel={() => {
            setEditingAccount(null);
            setMode("list");
          }}
          onSaved={async () => {
            await refresh();
            await useAccountsStore.getState().loadAccounts();
            setEditingAccount(null);
            setMode("list");
          }}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-[16px] font-semibold text-primary">Accounts</h2>
          <p className="text-[12.5px] text-muted mt-0.5">
            Add the IMAP + SMTP or Resend credentials for each of your accounts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AccountsOverflow
            exportDisabled={accounts.length === 0}
            onImport={() => setShowImport(true)}
            onExport={() => setShowExport(true)}
          />
          <Button
            variant="primary"
            leading={<Plus size={14} />}
            className="min-w-[180px]"
            onClick={() => {
              setEditingAccount(null);
              setMode("form");
            }}
          >
            Add account
          </Button>
        </div>
      </div>

      {showExport && (
        <ExportAccountsModal
          accounts={accounts}
          onClose={() => setShowExport(false)}
        />
      )}
      {showImport && (
        <ImportAccountsModal
          existing={accounts}
          onClose={() => setShowImport(false)}
          onImported={async () => {
            await refresh();
            await useAccountsStore.getState().loadAccounts();
          }}
        />
      )}

      {error && (
        <div className="rounded-lg border border-[color:var(--color-danger)] bg-[color:rgba(229,72,77,0.08)] text-[12.5px] text-[color:var(--color-danger)] px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-[12.5px] text-muted">Loading…</p>
      ) : accounts.length === 0 ? (
        <EmptyState
          onAdd={() => {
            setEditingAccount(null);
            setMode("form");
          }}
        />
      ) : (
        <>
          {(() => {
            const regularAccounts = accounts.filter((a) => !a.is_send_only);
            const sendOnlyAccounts = accounts.filter((a) => a.is_send_only);
            return (
              <>
                {regularAccounts.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {regularAccounts.map((a) => (
                      <AccountListItem
                        key={a.id}
                        account={a}
                        isDefault={defaultComposeId === a.id}
                        onSetDefault={() => void handleSetDefault(a.id)}
                        onEdit={() => { setEditingAccount(a); setMode("form"); }}
                        onDelete={() => setPendingDelete(a)}
                      />
                    ))}
                  </ul>
                )}
                {sendOnlyAccounts.length > 0 && (
                  <>
                    <div className="mt-6 mb-3 flex items-center gap-3">
                      <span className="text-[11.5px] font-semibold text-muted uppercase tracking-wide">
                        Send via accounts
                      </span>
                      <span className="flex-1 border-t border-soft" />
                    </div>
                    <p className="text-[12px] text-muted mb-3">
                      These accounts appear as From options in the Composer but have no inbox.
                    </p>
                    <ul className="flex flex-col gap-2">
                      {sendOnlyAccounts.map((a) => (
                        <AccountListItem
                          key={a.id}
                          account={a}
                          sendOnly
                          isDefault={defaultComposeId === a.id}
                          onSetDefault={() => void handleSetDefault(a.id)}
                          onEdit={() => { setEditingAccount(a); setMode("form"); }}
                          onDelete={() => setPendingDelete(a)}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </>
            );
          })()}
        </>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.is_send_only ? "Remove send-via account?" : "Remove account?"}
        message={
          pendingDelete
            ? `Remove ${pendingDelete.display_name || pendingDelete.email} (${pendingDelete.email}) from Blesus? ${
                pendingDelete.is_send_only
                  ? "This SMTP send-via profile will no longer appear in the composer From dropdown."
                  : "Local mail, drafts, and cached attachments for this account will be removed. The remote mailbox on the server is untouched."
              }`
            : ""
        }
        confirmLabel="Remove account"
        danger
        onConfirm={() => {
          const id = pendingDelete?.id;
          setPendingDelete(null);
          if (id != null) void handleDelete(id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

function AccountListItem({
  account: a,
  sendOnly,
  isDefault,
  onSetDefault,
  onEdit,
  onDelete,
}: {
  account: StoredAccount;
  sendOnly?: boolean;
  isDefault?: boolean;
  onSetDefault?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 bg-raised border border-soft rounded-lg px-4 py-3">
      <span
        className="h-2.5 w-2.5 rounded-full shrink-0"
        style={{ backgroundColor: a.color ?? "#5B8DEF" }}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-primary truncate">
            {a.display_name || a.email}
          </span>
          {sendOnly && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium bg-accent/15 text-accent">
              Send via
            </span>
          )}
          {isDefault && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium bg-[color:rgba(var(--color-warning-rgb,234,179,8),0.15)] text-[color:var(--color-warning,#ca8a04)]">
              Default composer
            </span>
          )}
        </div>
        <div className="text-[11.5px] text-muted truncate">
          {sendOnly
            ? `${a.email} · ${a.smtp_mode === "resend" ? "Resend" : `SMTP ${a.smtp_host}:${a.smtp_port}`}`
            : `${a.email} · IMAP ${a.imap_host}:${a.imap_port} · ${a.smtp_mode === "resend" ? "Resend" : `SMTP ${a.smtp_host}:${a.smtp_port}`}`}
        </div>
      </div>
      <button
        type="button"
        onClick={onSetDefault}
        title={isDefault ? "Remove as default composer" : "Set as default composer"}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          isDefault
            ? "text-[color:var(--color-warning,#ca8a04)] hover:bg-hover"
            : "text-muted hover:bg-hover hover:text-primary",
        )}
      >
        <Star size={14} fill={isDefault ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={onEdit}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary"
        aria-label="Edit account"
        title="Edit account"
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-[color:var(--color-danger)]"
        aria-label="Remove account"
        title="Remove account"
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function AppearanceSection() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const readingPane = useUiStore((s) => s.readingPane);
  const setReadingPane = useUiStore((s) => s.setReadingPane);

  return (
    <>
      <SectionHeader
        title="Appearance"
        description="How Blesus looks on your machine."
      />

      <Row
        label="Theme"
        hint="Follow the system, or pin a specific mode."
      >
        <SegmentedGroup<Theme>
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "black", label: "Black" },
          ]}
        />
      </Row>

      <Row
        label="Reading pane"
        hint="Show the message reader next to the inbox list, or open messages full-width."
      >
        <SegmentedGroup<ReadingPane>
          value={readingPane === "right" ? "right" : "off"}
          onChange={(v) => setReadingPane(v)}
          options={[
            { value: "right", label: "Right" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>
    </>
  );
}

function GeneralSection() {
  const syncIntervalMs = useUiStore((s) => s.syncIntervalMs);
  const setSyncIntervalMs = useUiStore((s) => s.setSyncIntervalMs);
  const notificationsEnabled = useUiStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useUiStore((s) => s.setNotificationsEnabled);
  const quietHoursEnabled = useUiStore((s) => s.quietHoursEnabled);
  const setQuietHoursEnabled = useUiStore((s) => s.setQuietHoursEnabled);
  const quietHoursStart = useUiStore((s) => s.quietHoursStart);
  const setQuietHoursStart = useUiStore((s) => s.setQuietHoursStart);
  const quietHoursEnd = useUiStore((s) => s.quietHoursEnd);
  const setQuietHoursEnd = useUiStore((s) => s.setQuietHoursEnd);
  const taskbarBadgeEnabled = useUiStore((s) => s.taskbarBadgeEnabled);
  const setTaskbarBadgeEnabled = useUiStore((s) => s.setTaskbarBadgeEnabled);
  const remoteImages = useUiStore((s) => s.remoteImages);
  const setRemoteImages = useUiStore((s) => s.setRemoteImages);
  const launchAtLogin = useUiStore((s) => s.launchAtLogin);
  const setLaunchAtLogin = useUiStore((s) => s.setLaunchAtLogin);
  const closeToTray = useUiStore((s) => s.closeToTray);
  const setCloseToTray = useUiStore((s) => s.setCloseToTray);
  const undoSendSeconds = useUiStore((s) => s.undoSendSeconds);
  const setUndoSendSeconds = useUiStore((s) => s.setUndoSendSeconds);
  const confirmBeforeSend = useUiStore((s) => s.confirmBeforeSend);
  const dontMarkReadOnOpen = useUiStore((s) => s.dontMarkReadOnOpen);
  const setDontMarkReadOnOpen = useUiStore((s) => s.setDontMarkReadOnOpen);
  const setConfirmBeforeSend = useUiStore((s) => s.setConfirmBeforeSend);
  const autoOcr = useUiStore((s) => s.autoOcr);
  const setAutoOcr = useUiStore((s) => s.setAutoOcr);
  const folderAutoLockMinutes = useUiStore((s) => s.folderAutoLockMinutes);
  const setFolderAutoLockMinutes = useUiStore((s) => s.setFolderAutoLockMinutes);

  return (
    <>
      <SectionHeader title="General" description="Global behaviour of the app." />

      <Row
        label="Sync interval"
        hint="How often Blesus refreshes the active folder. Manual disables the background loop — triggers only on focus or network reconnect."
      >
        <SegmentedGroup<string>
          value={String(syncIntervalMs)}
          onChange={(v) => setSyncIntervalMs(Number(v))}
          options={[
            { value: "0", label: "Manual" },
            { value: "30000", label: "30s" },
            { value: "60000", label: "1m" },
            { value: "300000", label: "5m" },
            { value: "900000", label: "15m" },
          ]}
        />
      </Row>

      <Row
        label="Desktop notifications"
        hint="Toast alerts in the Windows Action Center when new mail arrives and this window is not focused."
      >
        <div className="flex items-center gap-2">
          <SegmentedGroup<string>
            value={notificationsEnabled ? "on" : "off"}
            onChange={(v) => setNotificationsEnabled(v === "on")}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
          <button
            type="button"
            onClick={async () => {
              try {
                const {
                  isPermissionGranted,
                  requestPermission,
                  sendNotification,
                } = await import("@tauri-apps/plugin-notification");
                if (!(await isPermissionGranted())) {
                  const res = await requestPermission();
                  if (res !== "granted") {
                    toast.error("Notifications permission denied");
                    return;
                  }
                }
                sendNotification({
                  title: "Cursus",
                  body: "Test notification — toasts are working.",
                });
              } catch (err) {
                toast.error(`Test failed: ${err}`);
              }
            }}
            className="rounded-md border px-2.5 py-1 text-[12.5px] text-primary hover:bg-[rgba(255,255,255,0.06)]"
            style={{ borderColor: "var(--border-strong)" }}
          >
            Send test
          </button>
        </div>
      </Row>

      <Row
        label="Quiet hours"
        hint="Suppress notifications during this window. The range may wrap past midnight (e.g. 22:00 to 08:00)."
      >
        <div className="flex items-center gap-2">
          <SegmentedGroup<string>
            value={quietHoursEnabled ? "on" : "off"}
            onChange={(v) => setQuietHoursEnabled(v === "on")}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
          {quietHoursEnabled && (
            <>
              <input
                type="time"
                value={quietHoursStart}
                onChange={(e) => setQuietHoursStart(e.target.value)}
                className="rounded-md border bg-transparent px-2 py-1 text-[12.5px] text-primary outline-none focus:border-[color:var(--accent)]"
                style={{ borderColor: "var(--border-strong)" }}
              />
              <span className="text-muted">–</span>
              <input
                type="time"
                value={quietHoursEnd}
                onChange={(e) => setQuietHoursEnd(e.target.value)}
                className="rounded-md border bg-transparent px-2 py-1 text-[12.5px] text-primary outline-none focus:border-[color:var(--accent)]"
                style={{ borderColor: "var(--border-strong)" }}
              />
            </>
          )}
        </div>
      </Row>

      <Row
        label="Taskbar badge"
        hint="Red circle with unread count (1–99+) overlaid on the taskbar icon."
      >
        <SegmentedGroup<string>
          value={taskbarBadgeEnabled ? "on" : "off"}
          onChange={(v) => setTaskbarBadgeEnabled(v === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>

      <Row
        label="Remote images"
        hint="Many marketing emails embed 1×1 tracking pixels that signal when you opened the message. Blocking by default protects you; 'Ask' lets you load images per message."
      >
        <SegmentedGroup<RemoteImagesPolicy>
          value={remoteImages}
          onChange={setRemoteImages}
          options={[
            { value: "never", label: "Never" },
            { value: "ask", label: "Ask" },
            { value: "always", label: "Always" },
          ]}
        />
      </Row>

      <Row
        label="Launch at login"
        hint="Start Blesus automatically when you sign in. Combine with 'Close to tray' for a silent background service."
      >
        <SegmentedGroup<string>
          value={launchAtLogin ? "on" : "off"}
          onChange={(v) => setLaunchAtLogin(v === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>

      <Row
        label="Close to tray"
        hint="Closing the window keeps Blesus running in the system tray so notifications and sync continue. Use 'Quit' in the tray menu to fully exit."
      >
        <SegmentedGroup<string>
          value={closeToTray ? "on" : "off"}
          onChange={(v) => setCloseToTray(v === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>

      <Row
        label="Undo send"
        hint="Hold outgoing messages for a few seconds so you can click 'Undo' in the toast and recover them before they leave."
      >
        <SegmentedGroup<string>
          value={String(undoSendSeconds)}
          onChange={(v) => setUndoSendSeconds(Number(v))}
          options={[
            { value: "0", label: "Off" },
            { value: "5", label: "5s" },
            { value: "10", label: "10s" },
            { value: "30", label: "30s" },
          ]}
        />
      </Row>

      <Row
        label="Confirm before send"
        hint="Ask one more time if the subject is empty, the recipient list is empty, or the body mentions an attachment you haven't added."
      >
        <SegmentedGroup<string>
          value={confirmBeforeSend ? "on" : "off"}
          onChange={(v) => setConfirmBeforeSend(v === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>

      <Row
        label="Mark messages as read on open"
        hint="When off, opening a thread no longer marks it as read on the server. Use the keyboard shortcut or the context menu to mark messages as read manually."
      >
        <SegmentedGroup<string>
          value={dontMarkReadOnOpen ? "off" : "on"}
          onChange={(v) => setDontMarkReadOnOpen(v === "off")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>

      <Row
        label="Background OCR on new mail"
        hint="When a new message arrives, Blesus automatically extracts text from its attachments — including OCR for image-only PDFs — so they are immediately searchable. Turning this off means attachments are only indexed during a manual reindex."
      >
        <SegmentedGroup<string>
          value={autoOcr ? "on" : "off"}
          onChange={(v) => setAutoOcr(v === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>

      <Row
        label="Auto-lock folders"
        hint="Re-lock password-protected folders after they have been unlocked for the specified duration. 'Never' keeps them open for the entire session."
      >
        <SegmentedGroup<string>
          value={String(folderAutoLockMinutes)}
          onChange={(v) => setFolderAutoLockMinutes(Number(v))}
          options={FOLDER_AUTO_LOCK_OPTIONS_MIN.map((m) => ({
            value: String(m),
            label: autoLockLabel(m),
          }))}
        />
      </Row>

      <FullIndexRow />
      <RefreshAllFoldersRow />
    </>
  );
}

function autoLockLabel(min: number): string {
  if (min === 0) return "Never";
  if (min < 60) return `${min}m`;
  return `${min / 60}h`;
}

function FullIndexRow() {
  const { phase, foldersDone, foldersTotal, bodiesDone, bodiesTotal, bodiesFailed, attachmentsDone, attachmentsTotal, attachmentsCurrentFile, cancelRequested } =
    useFullSyncStore();
  const cancel = useFullSyncStore((s) => s.cancel);
  const isRunning = phase === "headers" || phase === "bodies" || phase === "attachments";
  const isDone = phase === "done";
  const isCancelled = phase === "cancelled";
  const [confirmForceReOcr, setConfirmForceReOcr] = useState(false);

  useEffect(() => {
    if (isDone) {
      if (bodiesFailed > 0) {
        toast.error(`Indexed ${bodiesTotal - bodiesFailed} / ${bodiesTotal} messages — ${bodiesFailed} failed`);
      } else {
        toast.success("All mail indexed");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDone]);

  function label() {
    if (cancelRequested && isRunning) return "Stopping…";
    if (phase === "headers") {
      return foldersTotal > 0
        ? `Syncing headers… (${foldersDone} / ${foldersTotal} folders)`
        : "Syncing headers…";
    }
    if (phase === "bodies") {
      return bodiesTotal > 0
        ? `Indexing bodies… (${bodiesDone} / ${bodiesTotal} messages)`
        : "Indexing bodies…";
    }
    if (phase === "attachments") {
      const file = attachmentsCurrentFile ? ` · ${attachmentsCurrentFile}` : "";
      return attachmentsTotal > 0
        ? `Extracting attachments… (${attachmentsDone} / ${attachmentsTotal}${file})`
        : "Extracting attachments…";
    }
    if (isDone) {
      if (bodiesFailed > 0) return `Indexed ${bodiesTotal - bodiesFailed} / ${bodiesTotal} — ${bodiesFailed} failed (run again to retry)`;
      return "All mail indexed ✓";
    }
    if (isCancelled) return "Cancelled";
    return "Index all mail";
  }

  const pct =
    phase === "headers" && foldersTotal > 0
      ? (foldersDone / foldersTotal) * 100
      : phase === "bodies" && bodiesTotal > 0
        ? (bodiesDone / bodiesTotal) * 100
        : phase === "attachments" && attachmentsTotal > 0
          ? (attachmentsDone / attachmentsTotal) * 100
          : null;

  return (
    <>
    <Row
      label="Download & cache all mail"
      hint="Syncs every message header and body across all accounts and folders so full-text search works completely offline. Attachment text is extracted automatically — PDF pages with no selectable text are processed with Windows OCR (Tesseract fallback on macOS/Linux). Large mailboxes may take several minutes. Already-indexed attachments are skipped on subsequent runs; Shift+click the reindex button to force re-OCR everything. You can cancel at any time."
    >
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          {isRunning && (
            <button
              type="button"
              onClick={cancel}
              disabled={cancelRequested}
              className="flex items-center gap-1 px-2 h-7 text-[12px] rounded-md border border-strong bg-sunken hover:bg-hover text-secondary disabled:opacity-50"
            >
              <Square size={10} />
              Stop
            </button>
          )}
          <button
            type="button"
            disabled={isRunning}
            onClick={(e) => {
              if (e.shiftKey) setConfirmForceReOcr(true);
              else void indexAllMail();
            }}
            title="Index all mail · Shift+click to force re-OCR"
            className="flex items-center gap-1.5 px-3 h-7 text-[12px] rounded-md border border-strong bg-sunken hover:bg-hover hover:text-primary text-secondary disabled:opacity-50"
          >
            {isDone && bodiesFailed === 0 ? (
              <CheckCircle2 size={12} className="text-green-500" />
            ) : (
              <HardDriveDownload size={12} className={isRunning ? "animate-pulse" : ""} />
            )}
            {label()}
          </button>
        </div>
        {isRunning && pct !== null && (
          <div className="w-[200px] h-1 rounded-full bg-[var(--bg-sunken)] overflow-hidden border border-[var(--border-soft)]">
            <div
              className="h-full bg-[var(--accent)] transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    </Row>

    <ConfirmDialog
      open={confirmForceReOcr}
      title="Force re-OCR all attachments"
      message="This will re-run OCR on every attachment, overwriting previously indexed text and bounding box cache. Use this to rebuild the database with Windows OCR. Continue?"
      confirmLabel="Force re-OCR"
      onConfirm={() => { setConfirmForceReOcr(false); void indexAllMail({ forceReOcr: true }); }}
      onCancel={() => setConfirmForceReOcr(false)}
    />
    </>
  );
}

function RefreshAllFoldersRow() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function runRefresh() {
    setRunning(true);
    setStatus(null);
    const { accounts, folders } = useAccountsStore.getState();
    const fetchFolder = useThreadsStore.getState().fetchFolder;
    let foldersDone = 0;
    const realFolders = folders.filter(
      (f) => f.id > 0 && accounts.some((a) => a.id === f.accountId),
    );
    for (const folder of realFolders) {
      try {
        setStatus(`Syncing ${folder.name}… (${foldersDone + 1}/${realFolders.length})`);
        await fetchFolder(folder.accountId, folder.path, folder.id, { silent: true });
      } catch (err) {
        console.warn(`Refresh failed for folder ${folder.path}:`, err);
      }
      foldersDone++;
    }
    // Sync cross-folder message counts into the separate convCounts map so the
    // list badge matches the reading pane for all threads immediately.
    try {
      const counts = await getAllConversationCounts();
      const patch: Record<string, number> = {};
      for (const c of counts) {
        patch[`${c.accountId}:${c.baseSubject}`] = c.count;
      }
      useThreadsStore.getState().setConvCounts(patch);
    } catch (err) {
      console.warn("Count sync failed:", err);
    }
    setRunning(false);
    setStatus(null);
    toast.success(`Refreshed ${foldersDone} folder${foldersDone === 1 ? "" : "s"}`);
  }

  return (
    <Row
      label="Refresh all folders"
      hint="Re-syncs every folder across all accounts from the server and rebuilds all thread message lists."
    >
      <button
        type="button"
        disabled={running}
        onClick={() => void runRefresh()}
        className="flex items-center gap-1.5 px-3 h-7 text-[12px] rounded-md border border-strong bg-sunken hover:bg-hover hover:text-primary text-secondary disabled:opacity-50"
      >
        <RefreshCw size={12} className={running ? "animate-spin" : ""} />
        {running && status ? status : "Refresh now"}
      </button>
    </Row>
  );
}

// ── Rules section ─────────────────────────────────────────────────────────

interface RuleDraft {
  id: number | null;
  name: string;
  accountId: number | null;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

function emptyDraft(): RuleDraft {
  return {
    id: null,
    name: "",
    accountId: null,
    enabled: true,
    conditions: [{ field: "from", op: "contains", value: "" }],
    actions: [{ type: "mark_read" }],
  };
}

function fromStored(r: StoredRule): RuleDraft {
  let conditions: RuleCondition[] = [];
  let actions: RuleAction[] = [];
  try {
    conditions = JSON.parse(r.conditions_json) as RuleCondition[];
  } catch {
    /* empty */
  }
  try {
    actions = JSON.parse(r.actions_json) as RuleAction[];
  } catch {
    /* empty */
  }
  return {
    id: r.id,
    name: r.name,
    accountId: r.account_id,
    enabled: r.enabled === 1,
    conditions,
    actions,
  };
}

function RulesSection() {
  const [rules, setRules] = useState<StoredRule[]>([]);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  async function refresh() {
    const [r, a] = await Promise.all([listRules(null), listAccounts()]);
    setRules(r);
    setAccounts(a);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error("Rule name is required");
      return;
    }
    if (draft.conditions.length === 0) {
      toast.error("At least one condition is required");
      return;
    }
    if (draft.actions.length === 0) {
      toast.error("At least one action is required");
      return;
    }
    try {
      await upsertRule({
        id: draft.id,
        accountId: draft.accountId,
        name: draft.name.trim(),
        enabled: draft.enabled,
        sortOrder: 0,
        conditionsJson: JSON.stringify(draft.conditions),
        actionsJson: JSON.stringify(draft.actions),
      });
      setDraft(null);
      void refresh();
    } catch (err) {
      toast.error(`Save failed: ${err}`);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Delete this rule?")) return;
    await deleteRule(id);
    void refresh();
  }

  return (
    <>
      <SectionHeader
        title="Rules"
        description="Run automatic actions on incoming mail. Rules apply to messages newly arrived since the last sync."
      />

      {draft ? (
        <RuleDraftForm
          draft={draft}
          accounts={accounts}
          onChange={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            leading={<Plus size={14} />}
            onClick={() => setDraft(emptyDraft())}
          >
            Add rule
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-2 mt-4">
        {rules.length === 0 ? (
          <p className="text-[12.5px] text-muted py-6 text-center">
            No rules yet.
          </p>
        ) : (
          rules.map((r) => (
            <RuleListRow
              key={r.id}
              rule={r}
              accounts={accounts}
              onEdit={() => setDraft(fromStored(r))}
              onDelete={() => void remove(r.id)}
            />
          ))
        )}
      </div>
    </>
  );
}

function RuleListRow({
  rule,
  accounts,
  onEdit,
  onDelete,
}: {
  rule: StoredRule;
  accounts: StoredAccount[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const scope =
    rule.account_id == null
      ? "All accounts"
      : accounts.find((a) => a.id === rule.account_id)?.email ?? `Account #${rule.account_id}`;
  const condCount = (() => {
    try {
      const c = JSON.parse(rule.conditions_json) as unknown[];
      return Array.isArray(c) ? c.length : 0;
    } catch {
      return 0;
    }
  })();
  const actCount = (() => {
    try {
      const a = JSON.parse(rule.actions_json) as unknown[];
      return Array.isArray(a) ? a.length : 0;
    } catch {
      return 0;
    }
  })();

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-md border"
      style={{ borderColor: "var(--border-soft)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-primary truncate">
          {rule.name}{" "}
          {rule.enabled === 0 && (
            <span className="text-[10.5px] text-muted font-normal">(disabled)</span>
          )}
        </div>
        <div className="text-[11.5px] text-muted truncate">
          {scope} · {condCount} condition{condCount === 1 ? "" : "s"} · {actCount} action
          {actCount === 1 ? "" : "s"}
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="px-2 py-1 text-[11.5px] text-secondary hover:text-primary hover:bg-hover rounded-md"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="px-2 py-1 text-[11.5px] text-secondary hover:text-[color:var(--color-danger)] hover:bg-hover rounded-md"
      >
        Delete
      </button>
    </div>
  );
}

const FIELDS: { value: RuleField; label: string }[] = [
  { value: "from", label: "From" },
  { value: "to", label: "To" },
  { value: "subject", label: "Subject" },
  { value: "hasAttachment", label: "Has attachment" },
  { value: "isBulk", label: "Is newsletter" },
];

const OPS: { value: RuleOp; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "regex", label: "matches regex" },
  { value: "is", label: "is" },
];

function RuleDraftForm({
  draft,
  accounts,
  onChange,
  onSave,
  onCancel,
}: {
  draft: RuleDraft;
  accounts: StoredAccount[];
  onChange: (d: RuleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  function patch(p: Partial<RuleDraft>): void {
    onChange({ ...draft, ...p });
  }
  return (
    <div
      className="flex flex-col gap-4 p-4 rounded-lg border"
      style={{ borderColor: "var(--border-strong)", background: "var(--bg-sunken)" }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. Stripe receipts"
            spellCheck={false}
          />
        </Field>
        <Field label="Account">
          <Select
            value={draft.accountId == null ? "" : String(draft.accountId)}
            onChange={(e) =>
              patch({ accountId: e.target.value === "" ? null : Number(e.target.value) })
            }
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-medium text-secondary">Conditions (all must match)</span>
          <button
            type="button"
            onClick={() =>
              patch({
                conditions: [
                  ...draft.conditions,
                  { field: "from", op: "contains", value: "" },
                ],
              })
            }
            className="text-[11.5px] text-secondary hover:text-primary"
          >
            + Add condition
          </button>
        </div>
        {draft.conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <Select
              value={c.field}
              onChange={(e) => {
                const next = [...draft.conditions];
                next[i] = { ...c, field: e.target.value as RuleField };
                patch({ conditions: next });
              }}
            >
              {FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Select
              value={c.op}
              onChange={(e) => {
                const next = [...draft.conditions];
                next[i] = { ...c, op: e.target.value as RuleOp };
                patch({ conditions: next });
              }}
            >
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Input
              className="flex-1"
              value={String(c.value)}
              onChange={(e) => {
                const next = [...draft.conditions];
                next[i] = { ...c, value: e.target.value };
                patch({ conditions: next });
              }}
              placeholder={c.field === "hasAttachment" || c.field === "isBulk" ? "true" : "value"}
            />
            <button
              type="button"
              onClick={() => {
                const next = draft.conditions.filter((_, idx) => idx !== i);
                patch({ conditions: next });
              }}
              className="text-muted hover:text-[color:var(--color-danger)] px-2"
              aria-label="Remove condition"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-medium text-secondary">Actions</span>
          <button
            type="button"
            onClick={() =>
              patch({ actions: [...draft.actions, { type: "mark_read" }] })
            }
            className="text-[11.5px] text-secondary hover:text-primary"
          >
            + Add action
          </button>
        </div>
        {draft.actions.map((a, i) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <Select
              value={a.type}
              onChange={(e) => {
                const t = e.target.value as RuleAction["type"];
                const next: RuleAction[] = [...draft.actions];
                next[i] =
                  t === "move_to" ? { type: "move_to", folderPath: "" } : { type: t };
                patch({ actions: next });
              }}
            >
              <option value="move_to">Move to folder</option>
              <option value="mark_read">Mark as read</option>
              <option value="star">Star</option>
              <option value="trash">Move to Trash</option>
            </Select>
            {a.type === "move_to" && (
              <Input
                className="flex-1"
                value={a.folderPath}
                onChange={(e) => {
                  const next: RuleAction[] = [...draft.actions];
                  next[i] = { type: "move_to", folderPath: e.target.value };
                  patch({ actions: next });
                }}
                placeholder="folder path (e.g. INBOX.Receipts)"
              />
            )}
            <button
              type="button"
              onClick={() => {
                const next = draft.actions.filter((_, idx) => idx !== i);
                patch({ actions: next });
              }}
              className="text-muted hover:text-[color:var(--color-danger)] px-2"
              aria-label="Remove action"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-secondary">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onSave}>
          Save rule
        </Button>
      </div>
    </div>
  );
}

function KeyboardSection() {
  const groups: Array<{
    title: string;
    items: Array<{ keys: string[]; description: string }>;
  }> = [
    {
      title: "Navigation",
      items: [
        { keys: ["↓", "j"], description: "Next conversation (within active category)" },
        { keys: ["↑", "k"], description: "Previous conversation (within active category)" },
        { keys: ["→"], description: "Next category tab" },
        { keys: ["←"], description: "Previous category tab" },
        { keys: ["Home"], description: "First conversation" },
        { keys: ["End"], description: "Last conversation" },
        { keys: ["Enter", "o"], description: "Open when none selected" },
        { keys: ["u", "Esc"], description: "Back to the list / clear selection" },
      ],
    },
    {
      title: "Selection",
      items: [
        { keys: ["x"], description: "Toggle current row in selection" },
        { keys: ["Shift", "↓"], description: "Extend selection down" },
        { keys: ["Shift", "↑"], description: "Extend selection up" },
        { keys: ["Shift", "click"], description: "Range-select from anchor" },
        { keys: ["Ctrl", "click"], description: "Toggle individual row" },
      ],
    },
    {
      title: "Compose",
      items: [
        { keys: ["c"], description: "New message" },
        { keys: ["r"], description: "Reply" },
        { keys: ["a"], description: "Reply all" },
        { keys: ["f"], description: "Forward" },
        { keys: ["Ctrl", "Enter"], description: "Send (in composer)" },
      ],
    },
    {
      title: "Actions (single or bulk)",
      items: [
        { keys: ["e"], description: "Archive — selected row or whole selection" },
        { keys: ["#", "Del"], description: "Move to trash — row or selection" },
        { keys: ["s"], description: "Toggle star — row or selection" },
        { keys: ["!"], description: "Toggle importance on the selected row" },
      ],
    },
    {
      title: "App",
      items: [
        { keys: ["/"], description: "Open search overlay" },
        { keys: ["Ctrl", "K"], description: "Open search overlay" },
        { keys: ["Ctrl", "Q"], description: "Quit Cursus (bypasses 'Close to tray')" },
      ],
    },
  ];

  return (
    <>
      <SectionHeader
        title="Keyboard"
        description="Single-letter shortcuts, Gmail/Spark-style. Ignored while typing in any input or the composer."
      />
      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <div key={group.title}>
            <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted mb-2">
              {group.title}
            </h3>
            <ul className="flex flex-col gap-1">
              {group.items.map((it) => (
                <li
                  key={it.description}
                  className="flex items-center justify-between py-1.5 text-[13px]"
                >
                  <span className="text-secondary">{it.description}</span>
                  <span className="flex items-center gap-1">
                    {it.keys.map((k, idx) => (
                      <span key={k} className="flex items-center gap-1">
                        {idx > 0 && (
                          <span className="text-[11px] text-muted">or</span>
                        )}
                        <Kbd>{k}</Kbd>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        background: "var(--bg-sunken)",
        borderColor: "var(--border-strong)",
        color: "var(--fg-primary)",
      }}
      className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded border text-[11.5px] font-mono"
    >
      {children}
    </kbd>
  );
}

const FEATURE_DOC_SECTIONS: Array<{ title: string; items: string[] }> = [
  {
    title: "Search & Indexing",
    items: [
      "Global search overlay with Ctrl+K and \"/\" shortcut.",
      "Search-from-the-list mode: a search executed from the toolbar above the message list replaces the list with results and persists until cleared.",
      "Searches every account and every folder by default (not just the active mailbox).",
      "Results sorted newest-to-oldest, with optional BM25 \"Relevant\" group (top 15) above a \"Newest to oldest\" group when ranking is enabled.",
      "Pagination — \"Load more\" button in the search results list.",
      "\"Download & cache all mail\" indexes every header and body for full-text search.",
      "Reindex button in the title-bar search row; Shift+click forces re-OCR of every attachment.",
      "Indexing progress shown in the search row (messages processed, OCR pages).",
      "Confirmation dialog before starting a reindex; icon turns green when complete.",
      "Attachment full-text indexing for PDF, DOCX, XLSX, RTF, HTML and plain text.",
      "OCR for image-only PDFs and image attachments — Windows OCR API on Windows, Tesseract.js fallback elsewhere.",
      "Background OCR on new mail — toggleable in General settings; arrivals are immediately searchable.",
      "OCR'd PDF text becomes selectable inside the PDF viewer via bounding-box cache (Windows OCR).",
      "Per-message resync after server expunge so deleted-on-server messages drop out of the local index.",
      "\"Remove from search results\" action for stale hits that no longer exist on the server.",
      "Login rate-limit aware indexing — batches via session reuse (50+ messages per IMAP login).",
    ],
  },
  {
    title: "Threading & Conversations",
    items: [
      "Message-ID / In-Reply-To / References threading.",
      "Subject-based fallback threading with a configurable time window.",
      "Ghost-parent suppression — won't merge threads via an absent reference.",
      "Sent messages auto-thread back into the matching inbox/archive conversation across folders.",
      "Per-thread Merge action — select two or more rows and merge them into one conversation.",
      "Per-thread \"Make standalone thread\" action — pull a single message out of a conversation.",
      "Standalone state persists across refreshes via localStorage.",
      "Move-to-thread picker in the reading pane (right-arrow icon on each message) for moving a single message between conversations.",
      "Cross-folder thread display: sent replies appear under inbox/archive conversations and vice versa.",
      "Per-message folder badge (Inbox / Sent / Archive / Trash / Spam / Drafts / custom folder) on each bubble in the reading pane.",
      "Merge group persistence in localStorage; survives app restart.",
      "Message-count badge inline with the thread subject in the reading pane header.",
      "Refreshes recompute merge group message counts.",
    ],
  },
  {
    title: "Reading Pane",
    items: [
      "Each message in a thread renders as its own row with the same styling as the message list, click-to-expand inline.",
      "Expanded message fills the full reading-pane height.",
      "Latest message expanded by default; one-click swaps to any other message in the thread.",
      "Quoted-text stripping with toggle button to reveal hidden quoted content.",
      "Heuristics handle \"On <date> ... wrote:\", \"----- Original message -----\", From/Sent/To/Subject blocks and Outlook WordSection quoting.",
      "Per-message header dropdown showing full To / Cc / Bcc list.",
      "Top-of-thread header shows only subject + message count (no participant smear).",
      "Trash and Archive icons positioned under each message's timestamp.",
      "\"Send New\" button at the bottom of each message — copies body (including inline images) to a fresh compose, drops subject and quoted text, preserves HTML structure with image spacing.",
      "Link-hover tooltip near the cursor showing the destination URL with a readable background.",
      "Right-click to copy selected text in the reading pane.",
      "Auto-mark-read on open with toggle in General settings.",
      "Sandboxed HtmlViewer that strips scripts and disables remote image fetches.",
    ],
  },
  {
    title: "Composer",
    items: [
      "Expand-to-full-screen toggle in the composer window.",
      "Rich-text TipTap editor with formatting toolbar and \"Clear formatting\" button.",
      "Reply, Reply-All, Forward — all preserve thread headers for proper threading.",
      "Reply-All address chips with per-recipient X buttons (every recipient is removable, including the last one).",
      "Self-address stripping on Reply-All, including every Send-Via alias.",
      "Reply uses the account that originally received the message (replies on Send-Via mail go out via the Send-Via account).",
      "Send-Via SMTP accounts appear as composer From: options without creating a separate mailbox.",
      "Per-account signature, swapped automatically based on chosen From: account.",
      "Inline image transfer in Send-New; image spacing matches the original message.",
      "Image and PDF attachment preview in the composer (with the same annotation tools as the standalone viewers).",
      "Default zoom presets: 50% for the PDF preview, 75% for the image preview.",
      "Ctrl + mouse-wheel zoom inside composer attachment previews.",
      "Attachments persist across draft save/reopen.",
      "Draft saved without an internet connection.",
      "Drafts folder count badge that updates on send and on discard.",
      "Cross-draft isolation: a new compose never inherits state from another draft.",
      "Tiptap chrome hidden for plain-text Send-New so the transferred text appears at the top with a single line of leading whitespace.",
      "Transferred Send-New text remains editable with all composer formatting tools.",
      "Ctrl+Enter sends.",
      "WebView2 native right-click menu blocked on inline images in drafts to prevent untrusted URL fetches.",
      "Camera capture — take a photo directly in the composer via the camera toolbar button.",
      "Camera preview is resizable (drag the bottom-right corner); video fills the container without letterboxing.",
      "Post-capture crop using react-image-crop; drag to select a region or leave full selection to use the whole photo.",
      "Captured photo can be inserted inline into the email body or attached as a file.",
      "Brightness, Contrast, and Saturation sliders (0–200%) adjust the photo before export; adjustments are baked into the saved image.",
      "Camera selector dropdown appears when multiple cameras are detected, allowing you to switch devices before capturing.",
    ],
  },
  {
    title: "Attachment Viewers",
    items: [
      "Audio player for .mp3, .wav, .ogg, .flac, .aac, .mp4 audio.",
      "Background audio playback continues when switching threads; a \"now playing\" icon appears on the message row.",
      "Image viewer with 2×2.5\" thumbnails that expand to 80% of the window on click.",
      "Image gallery with mouse-wheel scrolling between images.",
      "Per-image and bulk download buttons.",
      "Magnifier tool in the image viewer.",
      "PDF viewer with progressive page rendering.",
      "PDF text selection backed by Windows OCR bounding boxes (Tesseract fallback indexes for search only).",
      "Ctrl + mouse-wheel zoom in the PDF viewer.",
      "Fullscreen mode for both image and PDF viewers.",
      "Print support for images and PDFs.",
      "Annotation toolbar for images and PDFs: text boxes, freehand pen, highlighter, color picker (15 presets + custom).",
      "Default annotation text color is black; toolbar docks to the top without pushing the document aside.",
      "Annotations cleared automatically when the viewer closes.",
      "\"Download with annotations\" — saves an annotated copy of the image or PDF to the path you choose.",
      "\"Mail+\" button — attaches the current (annotated) image or PDF to a fresh compose.",
      "\"Reply with attachment\" button (image and PDF viewers) — attaches the annotated file to a reply on the same thread, or to the currently open draft if one exists.",
      "Inline search inside the PDF viewer with hit highlighting.",
      "PDF AcroForm field detection (with graceful fallback when fields cannot be edited).",
      "DOCX preview via mammoth; XLSX, RTF, HTML, code files, plain text and 30+ text-like extensions previewed natively.",
      "WebView2 native right-click menu blocked on image and PDF viewers.",
    ],
  },
  {
    title: "Trash, Archive & Delete",
    items: [
      "\"Empty trash\" button in the Trash folder that clears the server and local DB.",
      "True permanent delete via EXPUNGE; selection and reading pane clear automatically after the operation.",
      "Selecting a message that has cross-folder threads moves the entire conversation to Trash (Inbox + Sent + Archive + custom folders).",
      "Deleting an individual message inside a thread only moves that one message.",
      "Permanent delete only expunges from Trash and Spam; Sent, Archive and custom folders are preserved.",
      "Trash button in the message-row balloon performs the same action as the right-click \"Delete permanently\" item when already in Trash.",
      "Sent-log dedup against Sent and Trash folders so trashed sent copies don't reappear in conversations.",
      "Trash workflow works in user-created folders identically to built-in special folders.",
      "Trashed messages clear from search results.",
    ],
  },
  {
    title: "Folders & Sidebar",
    items: [
      "Custom user-created folders work everywhere (move, trash, archive, rules, search).",
      "Send-Via accounts are hidden from the sidebar folder tree.",
      "Folder context menu with delete confirmation that warns when emails will be permanently destroyed.",
      "Per-folder unread count next to folder name.",
      "Password-protected folders — folders can be locked behind a password.",
      "Auto-lock timer in settings re-locks an opened folder after the configured idle period.",
      "Folder selection settles correctly after a switch (no stale list from the previous folder).",
      "Account sort order persisted (migration 08).",
      "Sidebar account/folder drag-handle resize.",
    ],
  },
  {
    title: "Sending",
    items: [
      "SMTP via lettre with STARTTLS/SSL enforcement (plain IMAP/SMTP rejected at save time).",
      "Send-Via aliases — outgoing-only SMTP profiles selectable in the composer From: dropdown.",
      "Resend HTTP send transport as a built-in option.",
      "Scheduled sends (migration 06) with a Scheduled pseudo-folder.",
      "Send-Via sent copies are written to the parent account's Sent folder so they appear in conversations.",
      "Sent_log dedup across folders prevents ghost copies in trashed/sent conversations.",
    ],
  },
  {
    title: "Drafts",
    items: [
      "Closing the composer auto-saves a draft (including HTML, attachments, recipients, subject).",
      "Drafts folder count badge reflects pending drafts.",
      "Full HTML preserved on round-trip; attachments survive close-reopen.",
      "body_is_raw column (migration) preserves wire-faithful HTML.",
      "Empty drafts no longer leak into a brand new compose window.",
      "Sent drafts are removed from the Drafts folder after delivery.",
    ],
  },
  {
    title: "Rules Engine",
    items: [
      "Route-on-arrival rules (migration 07) move matching mail into a chosen folder.",
      "Mark-read on open works for rule-routed mail in non-Inbox folders.",
      "Routed mail only badges its target folder, not the Inbox.",
      "Rules editor in Settings with per-account scoping and condition/action UI.",
    ],
  },
  {
    title: "Notifications & Badges",
    items: [
      "Taskbar badge total reflects unread across all folders and clears when nothing remains unread.",
      "System notifications for new arrivals via @tauri-apps/plugin-notification.",
      "Toast system for in-app feedback (move/undo/error).",
      "Recompute-on-statusBatch keeps the badge accurate across IDLE pushes.",
      "Per-thread \"new\" badge clears when the conversation is opened, even for multi-message new conversations.",
    ],
  },
  {
    title: "Sync, IMAP & Caching",
    items: [
      "Server-deletion mirroring — messages deleted in another client disappear locally.",
      "IDLE-based push notifications for arrivals.",
      "Periodic status batch polling falls back when IDLE is unavailable.",
      "Aggressive local caching — older pages stay in memory; up to 500 message scrollback per folder.",
      "\"Refresh all folders\" button re-syncs every folder across all accounts and rebuilds thread message lists.",
      "Auto-discovery for known IMAP/SMTP providers from email domain.",
      "Login throttling that respects per-10-minute server limits.",
      "Persistent 4 GB attachment disk cache — attachments are saved to blesus-files/attachment-cache/ on first open and loaded from disk on subsequent opens, surviving app restarts. LRU eviction keeps total size under 4 GB.",
      "200-entry in-memory attachment cache — the 200 most recently opened attachments are kept in RAM for instant access within a session (LRU eviction promotes disk-cached entries back to memory on re-open).",
      "Transient IMAP server shutdown auto-retry — if the server returns a BYE System shutdown response, Blesus automatically reconnects once before surfacing an error to the UI.",
    ],
  },
  {
    title: "Stars / Pinning",
    items: [
      "Star toggle on message rows and inside search results (both Ctrl+K overlay and inline search list).",
      "Starred messages pin to the top of their folder.",
      "Starred messages survive refresh (pinned state preserved across server resync).",
      "Starred folder aggregates every starred message across all accounts and folders.",
      "Importance flag removed — Star is the single pin/prioritise affordance.",
    ],
  },
  {
    title: "Contacts",
    items: [
      "Address book with add / edit / delete.",
      "Contact Groups for one-click bulk addressing.",
      "CardDAV import / export.",
      "Contact icon next to the Compose button (same icon as the Settings → Contacts row).",
      "Wider contacts and groups list rows for easier reading.",
      "Icon-row spacing tuned for Contacts / Groups / CardDAV sub-tabs.",
    ],
  },
  {
    title: "Window & System",
    items: [
      "X (close) button minimizes the window instead of quitting (\"close to tray\" behaviour).",
      "Ctrl+Q quits the app, bypassing close-to-tray.",
      "Hidden console window — no command-line shell appears when launching the app.",
      "Autostart on login (toggleable in Settings).",
      "Tray icon with hover label matching the app brand.",
      "Window dragging via custom titlebar.",
      "WebView2 hardlink recovery documented for force-kill recovery paths.",
    ],
  },
  {
    title: "Backup & Restore",
    items: [
      "Account export to encrypted .blesus file.",
      "Account import from previously exported .blesus file (with conflict handling).",
    ],
  },
  {
    title: "Account Options",
    items: [
      "Send only accounts — account has no inbox and appears only as a From option in the Composer.",
      "IMAP only accounts — account receives mail normally but is hidden from the Compose From dropdown. Useful for monitoring accounts you never send from.",
    ],
  },
];

function FeaturesSection() {
  return (
    <>
      <SectionHeader
        title="Features documentation"
        description="Everything Blesus does, grouped by area. Updated as features ship."
      />
      <div className="flex flex-col gap-6">
        {FEATURE_DOC_SECTIONS.map((sec) => (
          <section key={sec.title}>
            <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted mb-2">
              {sec.title}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {sec.items.map((item, i) => (
                <li
                  key={i}
                  className="text-[13px] leading-snug text-secondary pl-4 relative"
                >
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-[0.55em] inline-block h-1 w-1 rounded-full"
                    style={{ background: "var(--accent)" }}
                  />
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-[16px] font-semibold text-primary">{title}</h2>
      <p className="text-[12.5px] text-muted mt-0.5">{description}</p>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-4 border-b border-soft last:border-b-0">
      <div className="min-w-0 max-w-sm">
        <div className="text-[13px] font-medium text-primary">{label}</div>
        {hint && <div className="text-[12px] text-muted mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SegmentedGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div
      role="radiogroup"
      style={{
        background: "var(--bg-sunken)",
        borderColor: "var(--border-strong)",
      }}
      className="inline-flex items-stretch rounded-lg border p-1 gap-1"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            style={{
              background: active
                ? "color-mix(in oklab, var(--accent) 24%, transparent)"
                : "transparent",
              color: active ? "var(--accent)" : "var(--fg-secondary)",
              borderColor: active ? "var(--accent)" : "transparent",
              boxShadow: active ? "var(--shadow-sm)" : "none",
            }}
            className={cn(
              "min-w-[76px] h-8 px-4 rounded-md text-[12.5px] font-medium border",
              "transition-colors",
              !active && "hover:text-[color:var(--fg-primary)]",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 border border-dashed border-soft rounded-xl">
      <div
        className="h-12 w-12 rounded-full flex items-center justify-center mb-3"
        style={{ background: "var(--accent-soft)" }}
      >
        <User size={18} className="text-accent" />
      </div>
      <h3 className="text-[14px] font-semibold text-primary">No accounts yet</h3>
      <p className="text-[12.5px] text-muted max-w-sm mt-1">
        Add your first mailbox to start sending and receiving from Cursus.
      </p>
      <Button
        variant="primary"
        className="mt-4 min-w-[180px]"
        leading={<Plus size={14} />}
        onClick={onAdd}
      >
        Add account
      </Button>
    </div>
  );
}

function AccountsOverflow({
  onImport,
  onExport,
  exportDisabled,
}: {
  onImport: () => void;
  onExport: () => void;
  exportDisabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account actions"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "h-9 w-9 inline-flex items-center justify-center rounded-md",
          "bg-sunken text-secondary border border-soft",
          "hover:border-strong hover:text-primary hover:bg-hover transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-soft)]",
          open && "border-strong text-primary",
        )}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-20 min-w-[200px] rounded-md border border-strong bg-raised shadow-soft py-1"
        >
          <OverflowItem
            icon={<Upload size={14} />}
            onClick={() => {
              setOpen(false);
              onImport();
            }}
          >
            Import accounts…
          </OverflowItem>
          <OverflowItem
            icon={<Download size={14} />}
            disabled={exportDisabled}
            onClick={() => {
              setOpen(false);
              onExport();
            }}
          >
            Export accounts…
          </OverflowItem>
        </div>
      )}
    </div>
  );
}

function OverflowItem({
  icon,
  disabled,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-left",
        "text-secondary hover:bg-hover hover:text-primary transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      <span className="text-muted">{icon}</span>
      <span>{children}</span>
    </button>
  );
}
