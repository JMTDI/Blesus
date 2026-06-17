import { useEffect, useRef, useState } from "react";
import { X, Users } from "lucide-react";
import { searchContacts, searchContactGroups, type ContactRow, type ContactGroupSearchResult } from "@/lib/db";

type HitContact = { kind: "contact"; data: ContactRow };
type HitGroup   = { kind: "group";   data: ContactGroupSearchResult };
type Hit = HitContact | HitGroup;

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoComplete?: string;
  spellCheck?: boolean;
}

/** Parse a comma/semicolon-separated address string into individual tokens,
 *  respecting quoted display names and angle-bracket addresses. */
function parseAddressTokens(csv: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === "<" && !inQuote) {
      inAngle = true;
      current += ch;
    } else if (ch === ">" && !inQuote) {
      inAngle = false;
      current += ch;
    } else if ((ch === "," || ch === ";") && !inQuote && !inAngle) {
      const t = current.trim();
      if (t) tokens.push(t);
      current = "";
    } else {
      current += ch;
    }
  }
  const t = current.trim();
  if (t) tokens.push(t);
  return tokens;
}

/** Short display label for a chip — extracts display name or falls back to the full string. */
function chipLabel(addr: string): string {
  const named = addr.match(/^"?(.+?)"?\s*<[^>]+>$/);
  if (named) return (named[1] ?? "").replace(/^"|"$/g, "").trim();
  return addr.trim();
}

/** Rebuild the value string from confirmed chips + the current typing draft. */
function buildValue(chips: string[], draft: string): string {
  if (chips.length === 0) return draft;
  return chips.join(", ") + ", " + draft;
}

function formatContact(c: ContactRow): string {
  const name = c.display_name?.trim();
  if (!name) return c.email;
  // Same RFC 5322 display-name escaping as Composer.buildFrom.
  if (/[@<>,;:"]/.test(name)) {
    const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}" <${c.email}>`;
  }
  return `${name} <${c.email}>`;
}

export function RecipientsField({
  value,
  onChange,
  placeholder,
  autoComplete = "off",
  spellCheck = false,
}: Props) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Split value into confirmed chips + the currently-being-typed token.
  const endsWithSep = /[,;]\s*$/.test(value);
  const allTokens = parseAddressTokens(value);
  const confirmed = endsWithSep ? allTokens : allTokens.slice(0, -1);
  const typing = endsWithSep ? "" : (allTokens[allTokens.length - 1] ?? "");
  const query = typing.trim();

  function removeChip(i: number) {
    const next = confirmed.filter((_, j) => j !== i);
    onChange(buildValue(next, typing));
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Debounced query against the contacts table and groups.
  useEffect(() => {
    if (!query) {
      setHits([]);
      setOpen(false);
      return;
    }
    const handle = setTimeout(() => {
      void Promise.all([
        searchContacts(query, 6),
        searchContactGroups(query),
      ]).then(([contacts, groups]) => {
        const combined: Hit[] = [
          ...groups.map((g): Hit => ({ kind: "group", data: g })),
          ...contacts.map((c): Hit => ({ kind: "contact", data: c })),
        ];
        setHits(combined);
        setIdx(0);
        if (document.activeElement === inputRef.current) {
          setOpen(combined.length > 0);
        }
      });
    }, 120);
    return () => clearTimeout(handle);
  }, [query]);

  function accept(hit: Hit) {
    let newChips: string[];
    if (hit.kind === "contact") {
      newChips = [...confirmed, formatContact(hit.data)];
    } else {
      // Group: expand all members into individual chips.
      newChips = [...confirmed, ...parseAddressTokens(hit.data.member_emails)];
    }
    onChange(buildValue(newChips, ""));
    setOpen(false);
    setHits([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace on empty input → remove last chip.
    if (e.key === "Backspace" && typing === "" && confirmed.length > 0) {
      e.preventDefault();
      removeChip(confirmed.length - 1);
      return;
    }
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      // Stop propagation so the outer composer's Ctrl+Enter listener
      // doesn't also fire a send while the user is just picking a contact.
      e.stopPropagation();
      const chosen = hits[idx];
      if (chosen) accept(chosen);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  function onBlur() {
    // Small delay so a click on a dropdown item has time to register
    // before focus is considered lost.
    blurTimer.current = setTimeout(() => setOpen(false), 120);
  }
  function onFocus() {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    if (hits.length > 0) setOpen(true);
  }

  return (
    <div className="relative w-full">
      <div
        className="flex flex-wrap items-center gap-1"
        onClick={() => inputRef.current?.focus()}
      >
        {confirmed.map((addr, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] text-secondary bg-[var(--bg-sunken)] border border-[var(--border-strong)] max-w-[220px]"
          >
            <span className="truncate">{chipLabel(addr)}</span>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); removeChip(i); }}
              className="shrink-0 text-muted hover:text-red-400 transition-colors -mr-0.5"
              aria-label={`Remove ${chipLabel(addr)}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={typing}
          onChange={(e) => onChange(buildValue(confirmed, e.target.value))}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder={confirmed.length === 0 ? placeholder : undefined}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          className="flex-1 min-w-[140px] bg-transparent border-0 outline-none text-[13px] text-primary placeholder:text-disabled"
        />
      </div>
      {open && hits.length > 0 && (
        <ul
          role="listbox"
          style={{
            background: "var(--bg-raised)",
            borderColor: "var(--border-strong)",
            boxShadow: "var(--shadow-md)",
          }}
          className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border max-h-[240px] overflow-y-auto py-1"
        >
          {hits.map((h, i) => {
            const highlighted = i === idx;
            const isGroup = h.kind === "group";
            const primary = isGroup ? h.data.name : (h.data.display_name?.trim() || h.data.email);
            const secondary = isGroup
              ? `${h.data.member_count} member${h.data.member_count !== 1 ? "s" : ""}`
              : (h.data.display_name?.trim() ? h.data.email : null);
            return (
              <li
                key={isGroup ? `g-${h.data.id}` : `c-${h.data.id}`}
                role="option"
                aria-selected={highlighted}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(h);
                }}
                onMouseEnter={() => setIdx(i)}
                style={highlighted ? { background: "var(--accent-soft)" } : undefined}
                className="flex items-center gap-2 px-3 py-1.5 cursor-pointer"
              >
                {isGroup && (
                  <Users size={12} className="shrink-0 text-muted" />
                )}
                <span className="flex flex-col flex-1 min-w-0">
                  <span className="text-[12.5px] text-primary truncate">{primary}</span>
                  {secondary && (
                    <span className="text-[11px] text-muted truncate">{secondary}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
