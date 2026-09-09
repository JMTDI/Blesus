// Snooze: a message stays on the server but is hidden from the active
// folder's thread list until a target unix timestamp passes. The state is
// encoded as an IMAP custom keyword `Blesus-SnoozedUntil:<unix-ts>` so it
// survives across devices and across reinstalls. A periodic checker in
// App.tsx removes the keyword once the timestamp passes, at which point the
// next sync re-surfaces the message.

const SNOOZE_PREFIX = "Blesus-SnoozedUntil:";
/** Pre-rename prefix from the "Cursus"-era. Read-only — the writer always
 *  emits the new prefix. Detection / removal handles both. */
const LEGACY_SNOOZE_PREFIX = "Cursus-SnoozedUntil:";
/** Pre-rename prefix from the "Flow"-era, one rename further back. Same
 *  read-only treatment. */
const LEGACY_SNOOZE_PREFIX_2 = "Flow-SnoozedUntil:";

/** Wildcard form passed to `imapSetFlags(..., mode: "remove")` to strip every
 *  snooze keyword on a message regardless of which prefix-era set it. */
export const SNOOZE_REMOVE_GLOBS: string[] = [
  `${SNOOZE_PREFIX}*`,
  `${LEGACY_SNOOZE_PREFIX}*`,
  `${LEGACY_SNOOZE_PREFIX_2}*`,
];

export function snoozeKeyword(untilUnixSeconds: number): string {
  return `${SNOOZE_PREFIX}${Math.floor(untilUnixSeconds)}`;
}

export function isSnoozeFlag(flag: string): boolean {
  return (
    flag.startsWith(SNOOZE_PREFIX) ||
    flag.startsWith(LEGACY_SNOOZE_PREFIX) ||
    flag.startsWith(LEGACY_SNOOZE_PREFIX_2)
  );
}

/**
 * Returns the unix-second deadline encoded in any snooze keyword present in
 * the supplied flag list, or null if none. Reads the current
 * `Blesus-SnoozedUntil:` prefix plus the legacy `Cursus-SnoozedUntil:` and
 * `Flow-SnoozedUntil:` prefixes — messages snoozed in older builds keep
 * working after each rename. If multiple snooze keywords are present, the
 * latest deadline wins.
 */
export function getSnoozeUntil(flags: string[]): number | null {
  let max: number | null = null;
  for (const f of flags) {
    let payload: string | null = null;
    if (f.startsWith(SNOOZE_PREFIX)) payload = f.slice(SNOOZE_PREFIX.length);
    else if (f.startsWith(LEGACY_SNOOZE_PREFIX))
      payload = f.slice(LEGACY_SNOOZE_PREFIX.length);
    else if (f.startsWith(LEGACY_SNOOZE_PREFIX_2))
      payload = f.slice(LEGACY_SNOOZE_PREFIX_2.length);
    if (payload == null) continue;
    const ts = Number(payload);
    if (!Number.isFinite(ts)) continue;
    if (max == null || ts > max) max = ts;
  }
  return max;
}

/** True when the message is currently snoozed (deadline still in the future). */
export function isSnoozedNow(flags: string[]): boolean {
  const until = getSnoozeUntil(flags);
  if (until == null) return false;
  return until * 1000 > Date.now();
}

/** Common snooze presets surfaced in the menu. */
export interface SnoozePreset {
  label: string;
  computeUnix: () => number;
}

export const SNOOZE_PRESETS: SnoozePreset[] = [
  {
    label: "Later today",
    computeUnix: () => unixOf(addHours(roundedNow(), 3)),
  },
  {
    label: "Tomorrow morning",
    computeUnix: () => unixOf(setTime(addDays(new Date(), 1), 8, 0)),
  },
  {
    label: "This weekend",
    computeUnix: () => unixOf(setTime(nextWeekendDay(), 8, 0)),
  },
  {
    label: "Next week",
    computeUnix: () => unixOf(setTime(nextMonday(), 8, 0)),
  },
];

function unixOf(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function roundedNow(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  return d;
}

function addHours(d: Date, h: number): Date {
  const c = new Date(d);
  c.setHours(c.getHours() + h);
  return c;
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function setTime(d: Date, h: number, m: number): Date {
  const c = new Date(d);
  c.setHours(h, m, 0, 0);
  return c;
}

function nextMonday(): Date {
  const d = new Date();
  const day = d.getDay(); // 0..6, 0=Sun
  const delta = day === 1 ? 7 : (8 - day) % 7 || 7;
  return addDays(d, delta);
}

function nextWeekendDay(): Date {
  const d = new Date();
  const day = d.getDay();
  // 6 = Sat. Always pick the next upcoming Saturday — if today is Sat we
  // jump to next Saturday rather than later today.
  const delta = day < 6 ? 6 - day : 7;
  return addDays(d, delta);
}
