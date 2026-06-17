import { useEffect, useRef, useState } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

export type FolderPasswordMode = "unlock" | "set" | "remove";

interface Props {
  open: boolean;
  mode: FolderPasswordMode;
  folderName: string;
  /** Error message to display (e.g. "Incorrect password") */
  error?: string | null;
  loading?: boolean;
  onSubmit: (password: string, newPassword?: string) => void;
  onCancel: () => void;
}

export function FolderPasswordDialog({
  open,
  mode,
  folderName,
  error,
  loading,
  onSubmit,
  onCancel,
}: Props) {
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset fields whenever the dialog opens
  useEffect(() => {
    if (open) {
      setPassword("");
      setNewPassword("");
      setConfirm("");
      setShowPassword(false);
      setLocalError(null);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (mode === "set") {
      if (newPassword.length < 4) {
        setLocalError("Password must be at least 4 characters.");
        return;
      }
      if (newPassword !== confirm) {
        setLocalError("Passwords do not match.");
        return;
      }
      onSubmit(newPassword);
    } else if (mode === "remove") {
      onSubmit(password);
    } else {
      // unlock
      onSubmit(password);
    }
  }

  if (!open) return null;

  const title =
    mode === "unlock"
      ? `Unlock "${folderName}"`
      : mode === "set"
        ? `Lock "${folderName}"`
        : `Remove lock from "${folderName}"`;

  const submitLabel =
    mode === "unlock" ? "Unlock" : mode === "set" ? "Set password" : "Remove lock";

  const displayError = error ?? localError;

  return (
    <>
      <div
        className="fixed inset-0 z-[60] no-drag"
        style={{ background: "rgba(0,0,0,0.55)" }}
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-labelledby="fp-title"
        className="fixed left-1/2 top-1/2 z-[61] w-[380px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl no-drag"
        style={{
          background: "var(--bg-raised)",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--shadow-md)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div className="flex items-center gap-3 px-5 pt-5 pb-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{
                background: "rgba(var(--accent-rgb), 0.12)",
                color: "var(--accent)",
              }}
            >
              <Lock size={16} />
            </div>
            <h2 id="fp-title" className="text-[14px] font-semibold text-primary">
              {title}
            </h2>
          </div>

          <div className="px-5 pb-2 flex flex-col gap-3">
            {mode === "set" ? (
              <>
                <PasswordInput
                  label="New password"
                  value={newPassword}
                  onChange={setNewPassword}
                  show={showPassword}
                  onToggleShow={() => setShowPassword((v) => !v)}
                  inputRef={inputRef}
                  placeholder="Enter a password"
                />
                <PasswordInput
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  show={showPassword}
                  onToggleShow={() => setShowPassword((v) => !v)}
                  placeholder="Repeat password"
                />
              </>
            ) : (
              <PasswordInput
                label={mode === "unlock" ? "Password" : "Current password"}
                value={password}
                onChange={setPassword}
                show={showPassword}
                onToggleShow={() => setShowPassword((v) => !v)}
                inputRef={inputRef}
                placeholder="Enter folder password"
              />
            )}

            {displayError && (
              <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>
                {displayError}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={mode === "remove" ? "danger" : "primary"}
              size="sm"
              disabled={loading}
            >
              {loading ? "Please wait…" : submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}

function PasswordInput({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  inputRef: _inputRef,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted">
        {label}
      </span>
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pr-9"
          autoComplete="new-password"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={onToggleShow}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-primary transition-colors"
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
  );
}
