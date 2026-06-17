import { useState } from "react";
import { Upload, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { ipc } from "@/lib/ipc";
import {
  insertAccount,
  updateAccount,
  entryToAccountInput,
} from "@/lib/db";
import { toast } from "@/stores/toasts";
import type {
  StoredAccount,
  AccountsBundle,
  AccountBundleEntry,
} from "@/lib/db";

interface Props {
  existing: StoredAccount[];
  onClose: () => void;
  onImported: () => void;
}

type ConflictAction = "skip" | "overwrite" | "duplicate";

interface RowState {
  entry: AccountBundleEntry;
  /** Conflicting account in the local DB if any (matched by lowercased email). */
  conflictId: number | null;
  action: ConflictAction | "create";
}

export function ImportAccountsModal({ existing, onClose, onImported }: Props) {
  const [stage, setStage] = useState<"pick" | "preview">("pick");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);

  async function pickFile() {
    setError(null);
    try {
      const sel = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Blesus backup", extensions: ["blesus"] }],
      });
      if (typeof sel === "string") setFilePath(sel);
    } catch (err) {
      setError(String(err));
    }
  }

  async function decrypt() {
    setError(null);
    if (!filePath) {
      setError("Pick a backup file first.");
      return;
    }
    if (!password) {
      setError("Enter the backup password.");
      return;
    }
    setBusy(true);
    try {
      const sealed = await ipc.backupReadFile(filePath);
      const json = await ipc.backupUnseal(password, sealed);
      const bundle = JSON.parse(json) as AccountsBundle;
      if (bundle.version !== 1) {
        setError(`Unsupported backup version: ${bundle.version}`);
        return;
      }
      const byEmail = new Map(
        existing.map((a) => [a.email.toLowerCase(), a.id] as const),
      );
      const initial: RowState[] = bundle.accounts.map((entry) => {
        const conflictId = byEmail.get(entry.email.toLowerCase()) ?? null;
        return {
          entry,
          conflictId,
          action: conflictId == null ? "create" : "skip",
        };
      });
      setRows(initial);
      setStage("preview");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function performImport() {
    setError(null);
    setBusy(true);
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (const r of rows) {
        try {
          if (r.action === "skip") {
            skipped++;
            continue;
          }
          const input = entryToAccountInput(r.entry);
          if (r.action === "overwrite" && r.conflictId != null) {
            await updateAccount(r.conflictId, input);
          } else {
            // "create" or "duplicate" — both go through insertAccount.
            // The unique constraint on email blocks plain duplicates, so
            // for "duplicate" we suffix the email with a +N.
            if (r.action === "duplicate") {
              input.email = nextDuplicateEmail(r.entry.email, existing);
            }
            await insertAccount(input);
          }
          imported++;
        } catch (err) {
          console.warn("import row failed:", err);
          failed++;
        }
      }
      const parts: string[] = [];
      if (imported) parts.push(`${imported} imported`);
      if (skipped) parts.push(`${skipped} skipped`);
      if (failed) parts.push(`${failed} failed`);
      toast.success(parts.join(", ") || "Done");
      onImported();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="relative w-full max-w-[520px] rounded-xl border border-soft bg-raised shadow-soft p-6">
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 text-muted hover:text-primary"
        >
          <X size={16} />
        </button>
        <h2 className="text-[16px] font-semibold text-primary mb-1">
          Import accounts
        </h2>
        <p className="text-[12.5px] text-muted mb-5">
          {stage === "pick"
            ? "Open an encrypted .blesus backup and enter its password to preview the accounts."
            : "Choose what to do with each account, then import."}
        </p>

        {stage === "pick" ? (
          <div className="flex flex-col gap-4">
            <Field label="Backup file">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={filePath ?? ""}
                  placeholder="No file selected"
                  className="flex-1"
                />
                <Button variant="secondary" onClick={pickFile}>
                  Browse…
                </Button>
              </div>
            </Field>

            <Field label="Master password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="The password you set when exporting"
              />
            </Field>

            {error && (
              <div className="rounded-lg border border-[color:var(--color-danger)] bg-[color:rgba(229,72,77,0.08)] text-[12.5px] text-[color:var(--color-danger)] px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-1">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={decrypt}
                disabled={busy}
                className="min-w-[120px]"
              >
                {busy ? "Decrypting…" : "Continue"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2 max-h-[300px] overflow-auto">
              {rows.map((r, i) => (
                <li
                  key={`${r.entry.email}-${i}`}
                  className="rounded-md border border-soft px-3 py-2 bg-sunken"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] text-primary truncate">
                        {r.entry.email}
                      </div>
                      <div className="text-[11.5px] text-muted">
                        {r.conflictId != null ? "Already in this Cursus" : "New"}
                      </div>
                    </div>
                    <ActionPicker
                      conflict={r.conflictId != null}
                      value={r.action}
                      onChange={(v) =>
                        setRows((prev) =>
                          prev.map((p, j) => (j === i ? { ...p, action: v } : p)),
                        )
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>

            {error && (
              <div className="rounded-lg border border-[color:var(--color-danger)] bg-[color:rgba(229,72,77,0.08)] text-[12.5px] text-[color:var(--color-danger)] px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-1">
              <Button variant="ghost" onClick={() => setStage("pick")} disabled={busy}>
                Back
              </Button>
              <Button
                variant="primary"
                leading={<Upload size={14} />}
                onClick={performImport}
                disabled={busy}
                className="min-w-[120px]"
              >
                {busy ? "Importing…" : "Import"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Backdrop>
  );
}

function ActionPicker({
  conflict,
  value,
  onChange,
}: {
  conflict: boolean;
  value: ConflictAction | "create";
  onChange: (v: ConflictAction | "create") => void;
}) {
  if (!conflict) {
    // No-op control for new accounts — only "create" or "skip".
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as "create" | "skip")}
        className="h-8 px-2 text-[12px] bg-raised border border-soft rounded text-primary outline-none"
      >
        <option value="create">Import</option>
        <option value="skip">Skip</option>
      </select>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ConflictAction)}
      className="h-8 px-2 text-[12px] bg-raised border border-soft rounded text-primary outline-none"
    >
      <option value="skip">Skip</option>
      <option value="overwrite">Overwrite</option>
      <option value="duplicate">Add as new</option>
    </select>
  );
}

function nextDuplicateEmail(base: string, existing: StoredAccount[]): string {
  const taken = new Set(existing.map((a) => a.email.toLowerCase()));
  const at = base.indexOf("@");
  if (at < 0) return base;
  const local = base.slice(0, at);
  const domain = base.slice(at);
  for (let i = 2; i < 100; i++) {
    const candidate = `${local}+${i}${domain}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${local}+copy${domain}`;
}

function Backdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
