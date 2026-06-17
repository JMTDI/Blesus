import { useEffect, useMemo, useState } from "react";
import { Mail, Loader2, Check, AlertCircle, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { cn } from "@/lib/cn";
import { ipc } from "@/lib/ipc";
import { presetForEmail } from "@/lib/autoDiscovery";
import {
  getAccountSecrets,
  insertAccount,
  updateAccount,
  type AccountInput,
  type StoredAccount,
} from "@/lib/db";

type TestState = { status: "idle" | "running" | "ok" | "error"; message?: string };

const COLORS = [
  "#5B8DEF",
  "#8B5CF6",
  "#EC4899",
  "#F59E0B",
  "#10B981",
  "#06B6D4",
  "#EF4444",
  "#6366F1",
];

const SECURITY_OPTIONS = [
  { value: "ssl", label: "SSL / TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "none", label: "None (plain)" },
];

interface Props {
  editing?: StoredAccount | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function AccountForm({ editing, onSaved, onCancel }: Props) {
  const isEdit = Boolean(editing);

  const [email, setEmail] = useState(editing?.email ?? "");
  const [displayName, setDisplayName] = useState(editing?.display_name ?? "");
  const [color, setColor] = useState(editing?.color ?? COLORS[0]!);
  const [signature, setSignature] = useState(editing?.signature_html ?? "");

  const [imapHost, setImapHost] = useState(editing?.imap_host ?? "");
  const [imapPort, setImapPort] = useState(editing?.imap_port ?? 993);
  const [imapSecurity, setImapSecurity] = useState<"ssl" | "starttls" | "none">(
    editing?.imap_security ?? "ssl",
  );
  const [imapUsername, setImapUsername] = useState(editing?.imap_username ?? "");
  const [imapPassword, setImapPassword] = useState("");

  const [sendingMode, setSendingMode] = useState<"smtp" | "resend">(
    editing?.smtp_mode ?? "smtp",
  );
  const [isSendOnly, setIsSendOnly] = useState(Boolean(editing?.is_send_only));
  const [isImapOnly, setIsImapOnly] = useState(Boolean(editing?.is_imap_only));

  const [smtpHost, setSmtpHost] = useState(editing?.smtp_host ?? "");
  const [smtpPort, setSmtpPort] = useState(editing?.smtp_port ?? 465);
  const [smtpSecurity, setSmtpSecurity] = useState<"ssl" | "starttls" | "none">(
    editing?.smtp_security ?? "ssl",
  );
  const [smtpUsername, setSmtpUsername] = useState(editing?.smtp_username ?? "");
  const [smtpPassword, setSmtpPassword] = useState("");

  // "Has the user manually typed in this field?" trackers. Once true, the
  // auto-fill effect below stops touching that field — so manual edits win.
  const [imapHostTouched, setImapHostTouched] = useState(isEdit);
  const [smtpHostTouched, setSmtpHostTouched] = useState(isEdit);
  const [imapUsernameTouched, setImapUsernameTouched] = useState(isEdit);
  const [smtpUsernameTouched, setSmtpUsernameTouched] = useState(isEdit);
  const [resendFromTouched, setResendFromTouched] = useState(
    isEdit || Boolean(editing?.resend_from_address),
  );
  const [displayNameTouched, setDisplayNameTouched] = useState(
    isEdit || Boolean(editing?.display_name),
  );

  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFrom, setResendFrom] = useState(editing?.resend_from_address ?? "");

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    getAccountSecrets(editing.id)
      .then((secrets) => {
        if (cancelled) return;
        setImapPassword(secrets.imapPassword);
        if (secrets.smtpPassword) setSmtpPassword(secrets.smtpPassword);
        if (secrets.resendApiKey) setResendApiKey(secrets.resendApiKey);
      })
      .catch(() => {
        // If secrets cannot be loaded the user just re-enters them.
      });
    return () => {
      cancelled = true;
    };
  }, [editing?.id]);

  const [imapTest, setImapTest] = useState<TestState>({ status: "idle" });
  const [smtpTest, setSmtpTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canAutoDiscover = useMemo(() => email.includes("@") && email.includes("."), [email]);

  // Live auto-fill: as soon as the email has a plausible shape, pre-fill the
  // server / username / display-name fields from the preset. Fields the user
  // has actively typed in stay untouched so manual overrides win.
  useEffect(() => {
    if (isEdit) return;
    if (!canAutoDiscover) return;
    const preset = presetForEmail(email);
    if (!preset) return;
    if (!imapHostTouched) {
      setImapHost(preset.imap.host);
      setImapPort(preset.imap.port);
      setImapSecurity(preset.imap.security);
    }
    if (!smtpHostTouched) {
      setSmtpHost(preset.smtp.host);
      setSmtpPort(preset.smtp.port);
      setSmtpSecurity(preset.smtp.security);
    }
    if (!imapUsernameTouched) setImapUsername(email);
    if (!smtpUsernameTouched) setSmtpUsername(email);
    if (!resendFromTouched) setResendFrom(email);
    if (!displayNameTouched) setDisplayName(email.split("@")[0] ?? "");
  }, [
    email,
    canAutoDiscover,
    isEdit,
    imapHostTouched,
    smtpHostTouched,
    imapUsernameTouched,
    smtpUsernameTouched,
    resendFromTouched,
    displayNameTouched,
  ]);

  function autoDiscover() {
    // Manual "Auto-fill" button — resets touched flags so the preset wins
    // even for fields the user had already edited.
    const preset = presetForEmail(email);
    if (!preset) return;
    setImapHost(preset.imap.host);
    setImapPort(preset.imap.port);
    setImapSecurity(preset.imap.security);
    setImapUsername(email);
    setSmtpHost(preset.smtp.host);
    setSmtpPort(preset.smtp.port);
    setSmtpSecurity(preset.smtp.security);
    setSmtpUsername(email);
    if (!displayName) setDisplayName(email.split("@")[0] ?? "");
    setResendFrom(email);
    setImapHostTouched(false);
    setSmtpHostTouched(false);
    setImapUsernameTouched(false);
    setSmtpUsernameTouched(false);
    setResendFromTouched(false);
  }

  async function testImap() {
    setImapTest({ status: "running" });
    try {
      await ipc.imapTestConnection({
        host: imapHost,
        port: imapPort,
        username: imapUsername || email,
        password: imapPassword,
        security: imapSecurity,
      });
      setImapTest({ status: "ok", message: "Connected and authenticated." });
    } catch (err) {
      setImapTest({ status: "error", message: String(err) });
    }
  }

  async function testSmtp() {
    setSmtpTest({ status: "running" });
    try {
      if (sendingMode === "smtp") {
        await ipc.smtpTestConnection({
          host: smtpHost,
          port: smtpPort,
          username: smtpUsername || email,
          password: smtpPassword,
          security: smtpSecurity,
        });
        setSmtpTest({ status: "ok", message: "SMTP connection ok." });
      } else {
        await ipc.resendListTemplates(resendApiKey);
        setSmtpTest({ status: "ok", message: "Resend API key is valid." });
      }
    } catch (err) {
      setSmtpTest({ status: "error", message: String(err) });
    }
  }

  async function save() {
    setSaveError(null);
    if (!email) {
      setSaveError("Email address is required.");
      return;
    }
    if (!isEdit && !isSendOnly && (!imapHost || !imapPassword)) {
      setSaveError("IMAP host and password are required.");
      return;
    }
    // When editing, a blank password means "keep the stored one" — only
    // require it for new accounts.
    if (!isSendOnly) {
      if (!isEdit && sendingMode === "smtp" && (!smtpHost || !smtpPassword)) {
        setSaveError("SMTP host and password are required.");
        return;
      }
      if (!isEdit && sendingMode === "resend" && (!resendApiKey || !resendFrom)) {
        setSaveError("Resend API key and from-address are required.");
        return;
      }
      if (isEdit && sendingMode === "smtp" && !smtpHost) {
        setSaveError("SMTP host is required.");
        return;
      }
      if (isEdit && sendingMode === "resend" && !resendFrom) {
        setSaveError("Resend from-address is required.");
        return;
      }
    }

    const input: AccountInput = {
      email,
      displayName: displayName.trim(),
      color,
      imap: isSendOnly
        ? undefined
        : {
            host: imapHost,
            port: imapPort,
            security: imapSecurity,
            username: imapUsername || email,
            password: imapPassword,
          },
      sendingMode,
      smtp:
        sendingMode === "smtp"
          ? {
              host: smtpHost,
              port: smtpPort,
              security: smtpSecurity,
              username: smtpUsername || email,
              password: smtpPassword,
            }
          : undefined,
      resend:
        sendingMode === "resend"
          ? { apiKey: resendApiKey, fromAddress: resendFrom || email }
          : undefined,
      isSendOnly,
      isImapOnly: isSendOnly ? false : isImapOnly,
      signatureHtml: signature,
    };

    setSaving(true);
    try {
      if (editing) {
        await updateAccount(editing.id, input);
      } else {
        await insertAccount(input);
      }
      onSaved();
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <section className="flex flex-col gap-4">
        <SectionTitle>Identity</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email address">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourdomain.com"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Display name">
            <Input
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setDisplayNameTouched(true);
              }}
              placeholder="Shown in sidebar and From header"
            />
          </Field>
        </div>

        <Field label="Account color" hint="Visible dot in the sidebar to tell accounts apart.">
          <div className="flex items-center gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-6 w-6 rounded-full transition-transform",
                  color === c ? "ring-2 ring-offset-2 ring-offset-[color:var(--bg-raised)] ring-white/70 scale-110" : "hover:scale-105",
                )}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </Field>

        <div>
          <Button
            variant="ghost"
            size="sm"
            leading={<Wand2 size={13} />}
            disabled={!canAutoDiscover}
            onClick={autoDiscover}
          >
            Auto-fill for {email ? emailDomain(email) : "provider"}
          </Button>
        </div>

        <Field label="Send only" hint="Enable when this account has no inbox — it will appear as a From option in the Composer but won't receive mail.">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <button
              type="button"
              role="switch"
              aria-checked={isSendOnly}
              onClick={() => setIsSendOnly((v) => !v)}
              className={cn(
                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                isSendOnly ? "bg-accent" : "bg-[color:var(--border-strong)]",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                  isSendOnly ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
            <span className="text-[12px] text-muted">
              {isSendOnly ? "No inbox (send only)" : "Regular account (has inbox)"}
            </span>
          </label>
        </Field>

        {!isSendOnly && (
          <Field label="IMAP only" hint="Enable to receive mail on this account but hide it from the compose From dropdown.">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <button
                type="button"
                role="switch"
                aria-checked={isImapOnly}
                onClick={() => setIsImapOnly((v) => !v)}
                className={cn(
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                  isImapOnly ? "bg-accent" : "bg-[color:var(--border-strong)]",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                    isImapOnly ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
              <span className="text-[12px] text-muted">
                {isImapOnly ? "Receive only (hidden from compose)" : "Available in compose"}
              </span>
            </label>
          </Field>
        )}
      </section>

      {!isSendOnly && (
      <section className="flex flex-col gap-4">
        <SectionTitle>Incoming mail (IMAP)</SectionTitle>
        <div className="grid grid-cols-[1fr_120px_180px] gap-4">
          <Field label="Host">
            <Input
              value={imapHost}
              onChange={(e) => {
                setImapHost(e.target.value);
                setImapHostTouched(true);
              }}
              placeholder="mail.yourdomain.com"
              spellCheck={false}
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(Number(e.target.value) || 0)}
            />
          </Field>
          <Field label="Security">
            <Select
              value={imapSecurity}
              onChange={(e) => setImapSecurity(e.target.value as "ssl" | "starttls" | "none")}
            >
              {SECURITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Username" hint="Leave blank to use the email address.">
            <Input
              value={imapUsername}
              onChange={(e) => {
                setImapUsername(e.target.value);
                setImapUsernameTouched(true);
              }}
              placeholder={email || "username"}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={imapPassword}
              onChange={(e) => setImapPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={!imapHost || !imapPassword || imapTest.status === "running"}
            onClick={testImap}
            leading={<TestIcon status={imapTest.status} />}
          >
            {imapTest.status === "running" ? "Testing…" : "Test IMAP connection"}
          </Button>
          <TestMessage state={imapTest} />
        </div>
      </section>
      )}

      <section className="flex flex-col gap-4">
        <SectionTitle>Outgoing mail</SectionTitle>
        <ModeSegmented
          value={sendingMode}
          onChange={setSendingMode}
          options={[
            { value: "smtp", label: "SMTP" },
            { value: "resend", label: "Resend" },
          ]}
        />

        {sendingMode === "smtp" ? (
          <>
            <div className="grid grid-cols-[1fr_120px_180px] gap-4">
              <Field label="Host">
                <Input
                  value={smtpHost}
                  onChange={(e) => {
                    setSmtpHost(e.target.value);
                    setSmtpHostTouched(true);
                  }}
                  placeholder="mail.yourdomain.com"
                  spellCheck={false}
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(Number(e.target.value) || 0)}
                />
              </Field>
              <Field label="Security">
                <Select
                  value={smtpSecurity}
                  onChange={(e) => setSmtpSecurity(e.target.value as "ssl" | "starttls" | "none")}
                >
                  {SECURITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Username" hint="Leave blank to use the email address.">
                <Input
                  value={smtpUsername}
                  onChange={(e) => {
                    setSmtpUsername(e.target.value);
                    setSmtpUsernameTouched(true);
                  }}
                  placeholder={email || "username"}
                  spellCheck={false}
                  autoComplete="off"
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Resend API key" hint="From resend.com/api-keys.">
              <Input
                type="password"
                value={resendApiKey}
                onChange={(e) => setResendApiKey(e.target.value)}
                placeholder="re_..."
                autoComplete="new-password"
                spellCheck={false}
              />
            </Field>
            <Field label="From address" hint="A verified sender in your Resend account.">
              <Input
                type="email"
                value={resendFrom}
                onChange={(e) => {
                  setResendFrom(e.target.value);
                  setResendFromTouched(true);
                }}
                placeholder="hello@yourdomain.com"
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={
              smtpTest.status === "running" ||
              (sendingMode === "smtp" ? !smtpHost || !smtpPassword : !resendApiKey)
            }
            onClick={testSmtp}
            leading={<TestIcon status={smtpTest.status} />}
          >
            {smtpTest.status === "running"
              ? "Testing…"
              : sendingMode === "smtp"
                ? "Test SMTP connection"
                : "Verify Resend API key"}
          </Button>
          <TestMessage state={smtpTest} />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle>Signature</SectionTitle>
        <Field
          label="Appended automatically when composing or replying. Plain text or simple HTML — no styling beyond what you write here."
        >
          <textarea
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder={"— \nYour Name\nyour@email"}
            rows={5}
            spellCheck={false}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-[12.5px] font-mono leading-snug text-primary placeholder:text-muted outline-none focus:border-[color:var(--accent)]"
            style={{ borderColor: "var(--border-strong)" }}
          />
        </Field>
      </section>

      {saveError && (
        <div className="rounded-lg border border-[color:var(--color-danger)] bg-[color:rgba(229,72,77,0.08)] text-[12.5px] text-[color:var(--color-danger)] px-3 py-2">
          {saveError}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="primary"
          disabled={saving}
          onClick={save}
          leading={<Mail size={14} />}
          className="min-w-[180px] px-8"
        >
          {saving ? "Saving…" : isEdit ? "Update account" : "Save account"}
        </Button>
        <Button
          variant="secondary"
          onClick={onCancel}
          disabled={saving}
          className="min-w-[100px]"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[13px] font-semibold text-primary pt-1">{children}</h2>
  );
}

function ModeSegmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      role="tablist"
      aria-label="Outgoing mode"
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border-soft)",
      }}
      className="inline-flex items-center rounded-lg p-1 gap-1 w-fit"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={
              active
                ? {
                    background: "var(--accent)",
                    color: "#fff",
                    boxShadow: "var(--shadow-sm)",
                  }
                : {
                    background: "transparent",
                    color: "var(--fg-secondary)",
                  }
            }
            className={cn(
              "h-8 min-w-[90px] rounded-md px-4 text-[12.5px] font-medium transition-colors",
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

function TestIcon({ status }: { status: TestState["status"] }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin" />;
  if (status === "ok") return <Check size={13} className="text-[color:var(--color-success)]" />;
  if (status === "error") return <AlertCircle size={13} className="text-[color:var(--color-danger)]" />;
  return null;
}

function TestMessage({ state }: { state: TestState }) {
  if (state.status === "idle") return null;
  const color =
    state.status === "ok"
      ? "text-[color:var(--color-success)]"
      : state.status === "error"
        ? "text-[color:var(--color-danger)]"
        : "text-muted";
  return (
    <span className={cn("text-[12px] truncate", color)} title={state.message}>
      {state.message}
    </span>
  );
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "provider";
  return email.slice(at + 1);
}
