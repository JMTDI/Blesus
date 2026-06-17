import { useState } from "react";
import { Download, X } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { ipc } from "@/lib/ipc";
import { buildAccountsBundle } from "@/lib/db";
import { toast } from "@/stores/toasts";
import type { StoredAccount } from "@/lib/db";

interface Props {
  accounts: StoredAccount[];
  onClose: () => void;
}

export function ExportAccountsModal({ accounts, onClose }: Props) {
  const [selected, setSelected] = useState<Set<number>>(
    new Set(accounts.map((a) => a.id)),
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function handleExport() {
    setError(null);
    if (selected.size === 0) {
      setError("Pick at least one account.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const bundle = await buildAccountsBundle(Array.from(selected));
      const sealed = await ipc.backupSeal(password, JSON.stringify(bundle));
      const path = await save({
        defaultPath: "blesus-accounts.blesus",
        filters: [{ name: "Blesus backup", extensions: ["blesus"] }],
      });
      if (!path) {
        setBusy(false);
        return;
      }
      await ipc.backupWriteFile(path, sealed);
      toast.success(`Exported ${selected.size} account${selected.size > 1 ? "s" : ""}`);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <div className="relative w-full max-w-[460px] rounded-xl border border-soft bg-raised shadow-soft p-6">
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 text-muted hover:text-primary"
        >
          <X size={16} />
        </button>
        <h2 className="text-[16px] font-semibold text-primary mb-1">
          Export accounts
        </h2>
        <p className="text-[12.5px] text-muted mb-5">
          Saves the selected accounts (with passwords) to a single encrypted
          file. Use a strong password — without it the backup can't be opened.
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted mb-2">
              Accounts
            </div>
            <ul className="flex flex-col gap-1 max-h-[180px] overflow-auto rounded-md border border-soft p-2 bg-sunken">
              {accounts.map((a) => (
                <li key={a.id}>
                  <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                    <span className="text-[13px] text-primary">{a.email}</span>
                    {a.display_name && (
                      <span className="text-[12px] text-muted">
                        — {a.display_name}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <Field label="Master password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              placeholder="At least 8 characters"
            />
          </Field>
          <Field label="Confirm password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type the same password again"
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
              leading={<Download size={14} />}
              onClick={handleExport}
              disabled={busy}
              className="min-w-[120px]"
            >
              {busy ? "Encrypting…" : "Export"}
            </Button>
          </div>
        </div>
      </div>
    </Backdrop>
  );
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
