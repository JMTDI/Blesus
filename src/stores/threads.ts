import { create } from "zustand";
import type { MailCategory, Thread } from "@/types";
import { ipc, type ImapConfig, type MessageSummary } from "@/lib/ipc";
import {
  deleteMessage,
  deleteMessagesForFolder,
  deleteSentLogEntry,
  deleteSentLogForFolderMatches,
  deleteSearchIndexEntry,
  pruneSearchIndex,
  purgeDeletedMessages,
  mergeThreadsInDb,
  getAccount,
  getAccountSecrets,
  listMessagesForFolder,
  listAllStarredMessages,
  listConversationMessages,
  normalizeSubject,
  listRules,
  parseNameEmail,
  getOcrTextByMessageId,
  upsertAttachmentText,
  seedContact,
  updateMessageFlags,
  upsertMessageSummary,
  upsertSearchIndex,
  type StoredAccount,
  type StoredMessage,
  type StoredRule,
} from "@/lib/db";
import { isSnoozedNow, snoozeKeyword, SNOOZE_REMOVE_GLOBS } from "@/lib/snooze";
import { ruleMatches, type RuleAction, type RuleSpec } from "@/lib/rules";

/**
 * Folder IDs for which a markRead IMAP call is currently in-flight.
 * The periodic badge tick uses this to avoid re-inflating the badge to the
 * server's stale \Unseen count while \Seen is still being confirmed.
 */
export const markReadInFlight = new Set<number>();
/** Tracks "folderId:uid" pairs that have a pending star toggle in flight,
 *  mapped to the user's intended final state (true=starred, false=unstarred).
 *  While a UID is in this map, background DB upserts AND IMAP-derived thread
 *  rebuilds must use this intended state instead of the (possibly stale)
 *  server-reported \Flagged flag. Without this, the IDLE-triggered refetch
 *  re-stamps the old server value before the UID STORE has propagated. */
export const starInFlight = new Map<string, boolean>();
/** Tracks thread IDs currently being starred/unstarred. Prevents double-clicks
 *  from firing a second IMAP call before the first has completed. */
const starToggleInFlight = new Set<number>();
import { useAccountsStore } from "@/stores/accounts";
import { useUiStore } from "@/stores/ui";
import { toast } from "@/stores/toasts";
import { notifyNewMail } from "@/lib/notifications";
import { flog } from "@/lib/logger";
import { indexNewArrivals } from "@/lib/indexAllMail";

export interface FetchFolderOptions {
  /**
   * Silent refreshes skip the `loading: true` flip so the UI doesn't flash
   * its header subtitle / refresh spinner. Use for background sync ticks
   * and visibility/online triggers — anything the user didn't explicitly
   * ask for. Manual refreshes and folder-change loads stay non-silent.
   */
  silent?: boolean;
  /**
   * When true, run the IMAP fetch and apply rules but do NOT update the
   * thread list, rawThreads, or loading state. Used to fire rules in the
   * background for non-active folders (e.g. inbox when user is elsewhere)
   * without disturbing the currently-visible view.
   */
  rulesOnly?: boolean;
}

interface ThreadsState {
  threads: Thread[];
  /** Pre-merge ground-truth threads. Rebuilt from DB/IMAP; never modified by merge actions. */
  rawThreads: Thread[];
  /** All starred threads across all accounts — used by the Starred virtual view. */
  starredThreads: Thread[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  fetchFolder: (
    accountId: number,
    folderPath: string,
    folderId: number,
    options?: FetchFolderOptions,
  ) => Promise<void>;
  loadMore: (
    accountId: number,
    folderPath: string,
    folderId: number,
  ) => Promise<void>;
  /**
   * Server-side IMAP UID SEARCH UNSEEN + a single UID FETCH. Faster and
   * smoother than paginating chronologically because we never load and
   * discard read messages just to find the few unread mixed in.
   */
  fetchAllUnread: (
    accountId: number,
    folderPath: string,
    folderId: number,
  ) => Promise<void>;
  /** Load all starred messages from the local DB across all accounts into starredThreads. */
  fetchAllStarred: () => Promise<void>;
  setThreads: (threads: Thread[]) => void;
  togglePin: (id: number) => void;
  /**
   * Marks the thread read on the server. When `force` is false (default)
   * the call respects the user's `dontMarkReadOnOpen` setting and is a
   * no-op — used by the auto-mark on open. The keyboard "s" / context menu
   * paths pass `force: true` so manual marks always go through.
   */
  markRead: (id: number, opts?: { force?: boolean }) => Promise<void>;
  markUnread: (id: number) => Promise<void>;
  toggleStar: (id: number) => Promise<void>;
  moveToFolder: (id: number, destPath: string) => Promise<void>;
  snoozeThread: (id: number, untilUnixSeconds: number) => Promise<void>;
  unsnoozeThread: (id: number) => Promise<void>;
  archiveThread: (id: number) => Promise<void>;
  trashThread: (id: number) => Promise<void>;
  permanentDeleteThread: (id: number) => Promise<void>;
  markAsSpam: (id: number) => Promise<void>;
  markAsNotSpam: (id: number) => Promise<void>;
  archiveMany: (ids: number[]) => Promise<void>;
  trashMany: (ids: number[]) => Promise<void>;
  toggleStarMany: (ids: number[]) => Promise<void>;
  markManyRead: (ids: number[]) => Promise<void>;
  ensureThread: (thread: Thread) => void;
  trashMessage: (accountId: number, folderPath: string, uid: number) => Promise<void>;
  trashMessages: (accountId: number, messages: Array<{ folderPath: string; uid: number }>) => Promise<void>;
  emptyTrash: (accountId: number, folderPath: string, folderId: number) => Promise<void>;
  mergeThreads: (primaryId: number, secondaryIds: number[]) => Promise<void>;
  /** Move a subject out of its current merge group and into the group of targetThreadId.
   *  Pass targetThreadId = null to split it out into its own standalone thread. */
  moveSubjectBetweenGroups: (subject: string, targetThreadId: number | null) => void;
  /** Persisted merge groups: each inner array is a set of normalised subjects that form one merged thread. */
  mergeGroups: string[][];
  /** Per-account UIDs that should be broken out of their message-ID family and shown as standalone threads. */
  standaloneUids: Record<string, number[]>;
  /** Permanently break a message out of its message-ID family thread. */
  markStandalone: (accountId: number, msg: { uid: number; subject: string; from: string; date: number; snippet: string; hasAttachments: boolean; flags: string[]; folderId: number }) => void;
  /** Cross-folder message counts keyed by "accountId:normalizedSubject".
   *  Never wiped by folder fetches — survives set({ threads }) calls. */
  convCounts: Record<string, number>;
  setConvCounts: (counts: Record<string, number>) => void;
}

const PAGE_SIZE = 50;
const MERGE_GROUPS_KEY = "cursus:mergeGroups";
const STANDALONE_KEY = "cursus:standaloneUids";

function loadStandaloneUids(): Record<string, number[]> {
  try {
    const raw = localStorage.getItem(STANDALONE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, number[]>;
  } catch { return {}; }
}

function saveStandaloneUid(accountId: number, uid: number): void {
  const map = loadStandaloneUids();
  const key = String(accountId);
  const existing = map[key] ?? [];
  if (existing.includes(uid)) return;
  map[key] = [...existing, uid];
  try { localStorage.setItem(STANDALONE_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

function removeStandaloneUids(accountId: number, uids: number[]): Record<string, number[]> {
  const map = loadStandaloneUids();
  const key = String(accountId);
  if (!map[key]) return map;
  map[key] = map[key].filter((u) => !uids.includes(u));
  if (map[key].length === 0) delete map[key];
  try { localStorage.setItem(STANDALONE_KEY, JSON.stringify(map)); } catch { /* quota */ }
  return map;
}

function loadMergeGroups(): string[][] {
  try {
    const raw = localStorage.getItem(MERGE_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter((g): g is string[] =>
      Array.isArray(g) && g.every((s) => typeof s === "string"),
    );
  } catch {
    return [];
  }
}

function saveMergeGroups(groups: string[][]): void {
  try {
    localStorage.setItem(MERGE_GROUPS_KEY, JSON.stringify(groups));
  } catch { /* quota — ignore */ }
}

/**
 * Collapse secondary threads into their primary for any persisted merge groups.
 * The thread with the latest lastMessageAt in each group becomes the primary.
 */
function applyMergeGroups(threads: Thread[], groups: string[][], standaloneUids: Record<string, number[]> = {}): Thread[] {
  if (groups.length === 0) return threads;
  let result = [...threads];
  for (const group of groups) {
    const groupSet = new Set(group);
    const matching = result.filter((t) => {
      if (!groupSet.has(normaliseSubject(t.subject))) return false;
      // Don't pull a standalone singleton into a merge group — the user
      // explicitly broke it out and it must stay separate.
      const isolated = standaloneUids[String(t.accountId)] ?? [];
      if (t.messageCount === 1 && isolated.includes(t.id)) return false;
      return true;
    });
    if (matching.length < 2) continue;
    matching.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const [primary, ...rest] = matching as [Thread, ...Thread[]];
    const secondaryIds = new Set(rest.map((t) => t.id));
    const totalCount = matching.reduce((s, t) => s + t.messageCount, 0);
    const mergedParticipants = Array.from(new Set(matching.flatMap((t) => t.participants)));
    const anyUnread = matching.some((t) => t.hasUnread);
    result = result
      .filter((t) => !secondaryIds.has(t.id))
      .map((t) =>
        t.id === primary.id
          ? { ...t, messageCount: totalCount, participants: mergedParticipants, hasUnread: anyUnread }
          : t,
      );
  }
  return result;
}
// Per (account, folder) page counter. fetchFolder resets to 1; loadMore
// increments. The next IMAP fetch uses (pageCount - 1) * PAGE_SIZE as offset.
// Persisted to localStorage so Phase 1 (cold-start DB read) remains fast
// across app restarts — no need to re-page everything from scratch.
const PAGE_COUNT_KEY = "cursus:pageCountByFolder";
function loadPageCounts(): Map<string, number> {
  try {
    const raw = localStorage.getItem(PAGE_COUNT_KEY);
    if (raw) return new Map(JSON.parse(raw) as [string, number][]);
  } catch {}
  return new Map();
}
function savePageCounts(map: Map<string, number>): void {
  try { localStorage.setItem(PAGE_COUNT_KEY, JSON.stringify([...map.entries()])); } catch {}
}
const pageCountByFolder = loadPageCounts();

// In-memory floor for the DB row-limit used by the most recent non-silent
// fetchFolder call. loadMore uses this so it never reads fewer rows than the
// initial page load, preventing visible threads from being silently truncated.
const dbReadFloorByFolder = new Map<string, number>();

// In-memory map of max UID already seen per (account, folder), used to fire
// a notification when fetchFolder surfaces a genuinely new unread message.
// Resets on app reload, which is fine: first fetch after launch is silent.
const highestKnownUid = new Map<string, number>();

// Tracks thread IDs currently being permanently deleted to prevent double-expunge
// when Promise.all fires concurrent calls for same-subject threads.
const permanentDeleteInFlight = new Set<number>();

// ── Conversation threading (Union-Find over Message-ID / In-Reply-To /
// References) ────────────────────────────────────────────────────────────

interface ThreadMember {
  uid: number;
  date: number; // unix seconds
  subject: string;
  from: string;
  to: string[];
  flags: string[];
  hasAttachments: boolean;
  isBulk: boolean;
  isAuto: boolean;
  snippet: string;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let cur = x;
    while (true) {
      const p = this.parent.get(cur)!;
      if (p === cur) break;
      cur = p;
    }
    // Path compression: walk again, repointing each node to the root.
    let node = x;
    while (this.parent.get(node) !== cur) {
      const next = this.parent.get(node)!;
      this.parent.set(node, cur);
      node = next;
    }
    return cur;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Strip reply/forward prefixes and whitespace to get a canonical base subject
 * for fallback threading. E.g. "Re[2]: Fw: Hello world" → "hello world".
 */
function normaliseSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd?|aw|sv|vs|antw|回复|回覆|转发)(\[\d+\])?\s*:\s*)+/gi, "")
    .trim()
    .toLowerCase();
}

/**
 * Group an array of items by Message-ID family (RFC 5322). Each item
 * supplies its own messageId, inReplyTo and references. Items lacking
 * any header still get their own singleton group keyed by `uid:${uid}`.
 *
 * A subject-based fallback merges groups whose base subjects match when
 * no header link was found — handles senders that strip threading headers.
 *
 * Returns a Map of group root → items, with items inside each group
 * sorted newest-first by `date`.
 */
function groupByMessageIdFamily<T extends ThreadMember & {
  messageId: string;
  inReplyTo: string;
  references: string[];
}>(items: T[], isolatedUids?: Set<number>): Map<string, T[]> {
  const uf = new UnionFind();

  const ownIds = new Set<string>();
  for (const m of items) {
    const own = m.messageId || `uid:${m.uid}`;
    ownIds.add(own);
    uf.find(own); // ensure node exists
  }

  // Run the full union-find without any isolation filtering.
  // We will break isolated UIDs out in a post-processing step, which is
  // simpler and handles shared-ancestor chains (two messages sharing a
  // common References ancestor) that preemptive skipping cannot catch.
  for (const m of items) {
    const own = m.messageId || `uid:${m.uid}`;
    if (m.inReplyTo && ownIds.has(m.inReplyTo)) {
      uf.union(own, m.inReplyTo);
    }
    for (const r of m.references ?? []) {
      if (r && ownIds.has(r)) {
        uf.union(own, r);
      }
    }
  }

  // Subject-based fallback: group messages that share the same normalised
  // base subject when no header link connected them. Handles mail servers
  // and clients that strip In-Reply-To / References headers.
  const normSubjectToRoots = new Map<string, string[]>();
  for (const m of items) {
    const own = m.messageId || `uid:${m.uid}`;
    const root = uf.find(own);
    const ns = normaliseSubject(m.subject);
    if (!ns) continue;
    const arr = normSubjectToRoots.get(ns) ?? [];
    if (!arr.includes(root)) arr.push(root);
    normSubjectToRoots.set(ns, arr);
  }
  for (const roots of normSubjectToRoots.values()) {
    for (let i = 1; i < roots.length; i++) {
      uf.union(roots[0]!, roots[i]!);
    }
  }

  // Bucket by root.
  const groups = new Map<string, T[]>();
  for (const m of items) {
    const own = m.messageId || `uid:${m.uid}`;
    const root = uf.find(own);
    const list = groups.get(root) ?? [];
    list.push(m);
    groups.set(root, list);
  }

  // Post-process: forcibly break isolated UIDs out into their own singleton
  // groups regardless of any message-ID / references links.
  if (isolatedUids && isolatedUids.size > 0) {
    for (const [root, members] of Array.from(groups.entries())) {
      const stay = members.filter((m) => !isolatedUids.has(m.uid));
      const split = members.filter((m) => isolatedUids.has(m.uid));
      if (split.length === 0) continue;
      if (stay.length === 0) {
        // All members are isolated — break each into its own singleton.
        if (groups.get(root)?.length !== 1) {
          groups.delete(root);
          for (const mm of members) groups.set(`isolated:uid:${mm.uid}`, [mm]);
        }
        continue;
      }
      groups.set(root, stay);
      for (const splitItem of split) {
        groups.set(`isolated:uid:${splitItem.uid}`, [splitItem]);
      }
    }
  }

  // Sort each group newest-first.
  for (const list of groups.values()) {
    list.sort((a, b) => b.date - a.date);
  }
  return groups;
}

function dedupeAddresses(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Build a Thread for a group of messages. The newest message is the
 * representative — its UID becomes the Thread.id and the click-target.
 * `messageCount` reflects the real conversation size.
 */
function threadFromGroup(
  members: ThreadMember[],
  accountId: number,
  folderId: number,
): Thread {
  // Sorted newest-first by groupByMessageIdFamily.
  const newest = members[0]!;
  const allParticipants = members.flatMap((m) => [m.from, ...m.to]);
  const participants = dedupeAddresses(allParticipants).slice(0, 10);

  // Apply pending star toggles to each member's flags so an IMAP refetch
  // that still sees the old server-side \Flagged value doesn't bounce the
  // star back. Without this, the IDLE-triggered Phase 2 of fetchFolder can
  // re-derive isPinned from stale IMAP flags before the UID STORE propagates.
  const adjustedMembers = members.map((m) => {
    const intent = starInFlight.get(`${folderId}:${m.uid}`);
    if (intent === undefined) return m;
    const hasFlag = m.flags.includes("Flagged");
    if (intent && !hasFlag) return { ...m, flags: [...m.flags, "Flagged"] };
    if (!intent && hasFlag) return { ...m, flags: m.flags.filter((f) => f !== "Flagged") };
    return m;
  });

  // Thread is unread if ANY member is unread (Gmail/Spark behaviour).
  const hasUnread = adjustedMembers.some((m) => !m.flags.includes("Seen"));
  // Star rolls up the same way — any flagged member counts.
  const isPinned = adjustedMembers.some((m) => m.flags.includes("Flagged"));
  const hasAttachments = adjustedMembers.some((m) => m.hasAttachments);

  return {
    id: newest.uid,
    accountId,
    folderId,
    subject: newest.subject,
    snippet: "",
    participants,
    messageCount: members.length,
    hasUnread,
    isPinned,
    hasAttachments,
    lastMessageAt: newest.date * 1000,
    category: inferCategoryFromFlags(newest.isBulk, newest.isAuto, newest.from),
    messages: adjustedMembers.map((m) => ({
      uid: m.uid,
      from: m.from,
      date: m.date,
      snippet: m.snippet,
      flags: m.flags,
      hasAttachments: m.hasAttachments,
    })),
  };
}

function groupSummariesIntoThreads(
  summaries: MessageSummary[],
  accountId: number,
  folderId: number,
  isolatedUids?: Set<number>,
): Thread[] {
  // Hide messages whose Cursus-SnoozedUntil deadline is still in the future.
  const visible = summaries.filter((s) => !isSnoozedNow(s.flags));
  const items = visible.map((s) => ({
    uid: s.uid,
    date: s.date ?? 0,
    subject: s.subject ?? "(no subject)",
    from: s.from ?? "Unknown",
    to: s.to,
    flags: s.flags,
    hasAttachments: s.hasAttachments,
    isBulk: s.isBulk,
    isAuto: s.isAuto,
    messageId: s.messageId ?? "",
    inReplyTo: s.inReplyTo ?? "",
    references: s.references ?? [],
    snippet: s.snippet ?? "",
  }));
  const groups = groupByMessageIdFamily(items, isolatedUids);
  const threads = Array.from(groups.values()).map((g) =>
    threadFromGroup(g, accountId, folderId),
  );
  // Newest thread first.
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  // Snippet from the newest member is the user-visible preview.
  for (const t of threads) {
    const newest = summaries.find((s) => s.uid === t.id);
    if (newest) t.snippet = newest.snippet ?? "";
  }
  return threads;
}

function groupMessagesIntoThreads(
  rows: StoredMessage[],
  accountId: number,
  folderId: number,
  isolatedUids?: Set<number>,
): Thread[] {
  const visible = rows.filter((r) => {
    if (!r.flags) return true;
    const parsed = safeParseFlags(r.flags);
    return !isSnoozedNow(parsed);
  });
  const items = visible.map((r) => ({
    uid: r.imap_uid,
    date: r.received_at ?? 0,
    subject: r.subject ?? "(no subject)",
    from: r.from_address ?? "Unknown",
    to: (r.to_addresses ?? "").split(", ").filter(Boolean),
    // Derive the Seen flag from the authoritative is_unread column instead
    // of trusting the flags JSON, which can lag behind a pending markRead.
    // Same authoritative-column override for Flagged/is_starred so that
    // toggleStar from the search list persists correctly across refreshes.
    flags: (() => {
      const raw = r.flags ? safeParseFlags(r.flags) : [];
      let flags = raw;
      if (r.is_unread === 0) {
        flags = flags.includes("Seen") ? flags : [...flags, "Seen"];
      } else {
        flags = flags.filter((f) => f !== "Seen");
      }
      // If a star toggle is in flight for this UID, the DB row may not yet
      // reflect the user's action — skip the DB override and let the raw IMAP
      // flags (already correct after the UID STORE round-trip) drive isPinned.
      if (!starInFlight.has(`${folderId}:${r.imap_uid}`)) {
        if (r.is_starred === 1) {
          flags = flags.includes("Flagged") ? flags : [...flags, "Flagged"];
        } else {
          flags = flags.filter((f) => f !== "Flagged");
        }
      }
      return flags;
    })(),
    hasAttachments: r.has_attachments === 1,
    isBulk: r.is_bulk === 1,
    isAuto: r.is_auto === 1,
    messageId: r.message_id_header ?? "",
    inReplyTo: r.in_reply_to ?? "",
    references: r.references_header
      ? r.references_header.split(/\s+/).filter(Boolean)
      : [],
    snippet: r.snippet ?? "",
  }));
  const groups = groupByMessageIdFamily(items, isolatedUids);
  const threads = Array.from(groups.values()).map((g) =>
    threadFromGroup(g, accountId, folderId),
  );
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  for (const t of threads) {
    const newest = items.find((i) => i.uid === t.id);
    if (newest) t.snippet = newest.snippet;
  }
  return threads;
}

function safeParseFlags(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rulesFromStored(rows: StoredRule[]): RuleSpec[] {
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    enabled: r.enabled === 1,
    sortOrder: r.sort_order,
    conditions: safeParseJson(r.conditions_json) as RuleSpec["conditions"],
    actions: safeParseJson(r.actions_json) as RuleSpec["actions"],
  }));
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

async function applyRulesToFresh(
  accountId: number,
  folderId: number,
  folderPath: string,
  fresh: MessageSummary[],
): Promise<void> {
  // Rules should only fire on incoming mail, never on Trash/Sent/Drafts/Spam.
  // Without this guard, trashing an email causes it to land in Trash as
  // "fresh", match a move-to rule, and get sent right back to its origin.
  const folderMeta = useAccountsStore.getState().folders.find((f) => f.id === folderId);
  const skipUses = ["trash", "sent", "drafts", "spam", "junk"];
  if (folderMeta && folderMeta.specialUse && skipUses.includes(folderMeta.specialUse)) return;

  const stored = await listRules(accountId).catch(() => [] as StoredRule[]);
  const rules = rulesFromStored(stored);
  if (rules.length === 0) return;

  // Build a single config / session per pass so we don't re-LOGIN per message.
  // (Underlying IPC still does, but the call sites stay legible.)
  const account = await getAccount(accountId);
  if (!account) return;
  const secrets = await getAccountSecrets(accountId);
  const config = imapConfigFor(account, secrets.imapPassword);

  // Track which UIDs were physically moved out of this folder, along with
  // their destination path and whether they were unread. This lets us
  // immediately evict them from the in-memory store AND update folder badges.
  const movedItems: Array<{ uid: number; destPath: string; isUnread: boolean }> = [];

  for (const s of fresh) {
    let destPath: string | null = null;
    let moved = false;
    for (const rule of rules) {
      if (!ruleMatches(s, rule)) continue;
      for (const action of rule.actions) {
        try {
          moved = await runRuleAction(config, folderPath, folderId, accountId, s.uid, action);
          if (moved) {
            if (action.type === "move_to") destPath = action.folderPath;
            else if (action.type === "trash") destPath = findFolderPath(accountId, "trash") ?? "Trash";
          }
        } catch (err) {
          console.warn(`rule "${rule.name}" action failed:`, err);
        }
        if (moved) break; // message no longer in source folder
      }
      if (moved) break; // stop trying further rules on a moved message
    }
    if (moved && destPath !== null) {
      movedItems.push({ uid: s.uid, destPath, isUnread: !s.flags.includes("Seen") });
    }
  }

  // Evict moved messages from the in-memory store so the source-folder view
  // stays consistent and markRead doesn't chase a stale folderId.
  // Also adjust folder unread badges for both source and destination.
  if (movedItems.length > 0) {
    const movedSet = new Set(movedItems.map((m) => m.uid));
    const allFolders = useAccountsStore.getState().folders;
    const { activeFolderId } = useAccountsStore.getState();

    // Only evict from the visible thread list when the user is actually
    // looking at the source folder.  When running in rulesOnly / background
    // mode (activeFolderId !== folderId), touching state.threads would
    // corrupt the folder the user IS viewing.
    if (activeFolderId === folderId) {
      useThreadsStore.setState((state) => {
        const newRaw = state.rawThreads.filter((t) => !movedSet.has(t.id));
        const newThreads = applyMergeGroups(newRaw, state.mergeGroups, state.standaloneUids);
        return { threads: newThreads, rawThreads: newRaw };
      });
    }

    // Pre-compute per-destination unread increments.
    const destCountsById = new Map<number, number>();
    for (const item of movedItems) {
      if (!item.isUnread) continue;
      const destFolder = allFolders.find(
        (f) => f.accountId === accountId && f.path === item.destPath,
      );
      if (destFolder) {
        destCountsById.set(destFolder.id, (destCountsById.get(destFolder.id) ?? 0) + 1);
      }
    }
    const removedUnread = movedItems.filter((m) => m.isUnread).length;

    // Apply source decrement and all destination increments in ONE atomic
    // setState so badge.ts never sees an intermediate "all folders = 0" state
    // between the two writes.  Without this, Tauri IPC calls for
    // windowSetUnreadBadge can resolve out of order and the (0) call can
    // arrive after the (+1) call, permanently clearing the taskbar overlay.
    useAccountsStore.setState((state) => ({
      folders: state.folders.map((f) => {
        if (f.id === folderId && removedUnread > 0) {
          return { ...f, unreadCount: Math.max(0, (f.unreadCount ?? 0) - removedUnread) };
        }
        const add = destCountsById.get(f.id);
        if (add) {
          return { ...f, unreadCount: (f.unreadCount ?? 0) + add };
        }
        return f;
      }),
    }));
  }
}

async function runRuleAction(
  config: ImapConfig,
  folderPath: string,
  folderId: number,
  accountId: number,
  uid: number,
  action: RuleAction,
): Promise<boolean> {
  switch (action.type) {
    case "move_to": {
      if (folderPath === action.folderPath) return false; // already in destination
      await ipc.imapMoveUid(config, folderPath, action.folderPath, uid);
      void deleteMessage(folderId, uid).catch(() => {});
      void deleteSearchIndexEntry(accountId, folderPath, uid).catch(() => {});
      return true;
    }
    case "mark_read": {
      await ipc.imapSetFlags(config, folderPath, uid, ["\\Seen"], "add");
      void updateMessageFlags(folderId, uid, { isUnread: false }).catch(() => {});
      return false;
    }
    case "star": {
      await ipc.imapSetFlags(config, folderPath, uid, ["\\Flagged"], "add");
      void updateMessageFlags(folderId, uid, { isStarred: true }).catch(() => {});
      return false;
    }
    default: break;
  }
  // handle "trash" and "move_to" below
  switch (action.type) {
    case "trash": {
      const trashPath = findFolderPath(accountId, "trash") ?? "Trash";
      if (folderPath === trashPath) return false; // already in trash
      await ipc.imapMoveUid(config, folderPath, trashPath, uid);
      void deleteMessage(folderId, uid).catch(() => {});
      void deleteSearchIndexEntry(accountId, folderPath, uid).catch(() => {});
      return true;
    }
    default: break;
  }
  return false;
}

export const useThreadsStore = create<ThreadsState>((set, get) => ({
  threads: [],
  rawThreads: [],
  starredThreads: [],
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: null,
  mergeGroups: loadMergeGroups(),
  standaloneUids: loadStandaloneUids(),
  convCounts: {},
  setConvCounts: (counts) => set((state) => ({ convCounts: { ...state.convCounts, ...counts } })),

  fetchFolder: async (accountId, folderPath, folderId, options) => {
    const silent = options?.silent === true;
    const rulesOnly = options?.rulesOnly === true;
    const key = `${accountId}:${folderId}`;
    // Guard against stale async completions overwriting a newer folder navigation.
    // After any await, check isStale() before touching thread state.
    const isStale = () =>
      !rulesOnly && useAccountsStore.getState().activeFolderId !== folderId;

    // For silent (background) refreshes, preserve the page count so that
    // "oldest first" auto-paging isn't reset. For explicit navigations,
    // reset to page 1 UNLESS the gap-fill has already paged further ahead —
    // in that case preserve the higher count so the DB re-read limit covers
    // all gap-fill pages and the visible list includes them.
    const prevPageCount = pageCountByFolder.get(key) ?? 1;
    if (!silent) {
      // Only reset to 1 if we haven't gap-filled beyond page 1.
      // The gap-fill updates pageCountByFolder as it goes, so if it's > 1
      // we want to keep that so the Phase 3 DB re-read covers all fetched rows.
      if (prevPageCount <= 1) {
        pageCountByFolder.set(key, 1);
        savePageCounts(pageCountByFolder);
      }
    }
    // The DB limit to use when re-reading — covers all pages already loaded.
    const dbReadLimit = Math.max(1000, prevPageCount * PAGE_SIZE * 4);
    // Persist so loadMore never re-reads fewer rows than were shown here.
    if (!silent) dbReadFloorByFolder.set(key, dbReadLimit);

    // ── Phase 1: cold-start from DB ────────────────────────────────────────
    // Show whatever we previously persisted for this folder immediately, so
    // opening a folder feels instant even on a slow IMAP server. Skipped for
    // synthetic folder ids (negative) — those are placeholders that have
    // never been resolved against the DB.
    // Also skipped on silent (background) syncs: the list is already
    // populated and we don't want a partial DB re-read wiping out all the
    // old pages the auto-pager worked hard to load.
    // Phase 1 limit uses prevPageCount so returning to a folder you've
    // already paged through shows all those messages instantly.
    if (folderId > 0 && !silent && !rulesOnly) {
      try {
        const phase1Limit = Math.max(500, prevPageCount * PAGE_SIZE);
        const cached = await listMessagesForFolder(folderId, phase1Limit);
        if (cached.length > 0 && !isStale()) {
          const rawPhase1 = groupMessagesIntoThreads(cached, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
          set({
            threads: applyMergeGroups(rawPhase1, get().mergeGroups, get().standaloneUids),
            rawThreads: rawPhase1,
            error: null,
          });
        }
      } catch (err) {
        console.warn("fetchFolder: cache load failed", err);
      }
    }

    // ── Phase 2: refresh from IMAP ─────────────────────────────────────────
    if (!rulesOnly) set((state) => (silent ? { ...state, error: null } : { ...state, loading: true, error: null }));
    try {
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      const config = imapConfigFor(account, secrets.imapPassword);

      const summaries = await ipc.imapFetchMessages(config, folderPath, PAGE_SIZE, 0);

      const rawImap = groupSummariesIntoThreads(summaries, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
      const threads = applyMergeGroups(rawImap, get().mergeGroups, get().standaloneUids);

      // Whether a "Load more" button makes sense: if the page came back
      // full (50), there's likely more behind it.
      // For silent refreshes where all pages were already loaded (prevPageCount > 1),
      // preserve hasMore so oldest-first auto-paging isn't re-triggered on every IDLE tick.
      if (!silent || prevPageCount <= 1) {
        set({ hasMore: summaries.length >= PAGE_SIZE });
      }

      const key = `${accountId}:${folderId}`;
      const prev = highestKnownUid.get(key);
      const maxUid = threads.reduce((m, t) => (t.id > m ? t.id : m), 0);
      if (prev !== undefined) {
        const fresh = threads.filter((t) => t.id > prev && t.hasUnread);
        if (fresh.length > 0) {
          const newest = fresh[0];
          if (newest) {
            void notifyNewMail(
              newest.subject,
              newest.participants[0] ?? "Unknown",
              fresh.length,
            );
          }
        }
      }
      if (maxUid > 0) highestKnownUid.set(key, maxUid);

      // ── Phase 3: persist to DB ──────────────────────────────────────────
      // Skip if we still have a synthetic folder id — would violate the FK.
      // Should only happen on the very first sync of a brand-new account.
      // Collect upsert promises so the DB re-read below sees the new rows.
      // (loadMore already does this; keeping fetchFolder consistent.)
      const upsertPromises: Promise<void>[] = [];
      if (folderId > 0) {
        for (const s of summaries) {
          upsertPromises.push(
            upsertMessageSummary({
              accountId,
              folderId,
              imapUid: s.uid,
              messageIdHeader: s.messageId || null,
              inReplyTo: s.inReplyTo || null,
              referencesHeader: (s.references ?? []).length > 0 ? (s.references ?? []).join(" ") : null,
              fromAddress: s.from,
              toAddresses: s.to.join(", "),
              ccAddresses: s.cc && s.cc.length > 0 ? s.cc.join(", ") : null,
              bccAddresses: s.bcc && s.bcc.length > 0 ? s.bcc.join(", ") : null,
              subject: s.subject,
              snippet: s.snippet,
              receivedAt: s.date,
              flags: s.flags,
              isUnread: !s.flags.includes("Seen"),
              // Don't overwrite is_starred if a toggleStar is in flight for this UID —
              // the IDLE-triggered refetch may race the IMAP UID STORE and re-stamp
              // the old server value before the flag change has propagated.
              isStarred: starInFlight.has(`${folderId}:${s.uid}`)
                ? undefined
                : s.flags.includes("Flagged"),
              isImportant: false,
              hasAttachments: s.hasAttachments,
              isBulk: s.isBulk,
              isAuto: s.isAuto,
            }).catch((err) => console.warn("upsertMessageSummary failed", err)),
          );
        }
      }

      // ── Apply rules to genuinely new messages ──────────────────────────
      // `prev` (set further up) is the high-water UID we'd seen before.
      // Anything above that is fresh — eligible for rule actions. We apply
      // rules *after* the DB upsert so move_to actions naturally invalidate
      // the local row by deleting from this folder.
      //
      // On the very first fetchFolder of a session (prev === undefined) we
      // also process already-present UNREAD messages so that emails which
      // were sitting in the inbox when the app started still get moved by
      // rules.  Rule actions are idempotent (move_to is a no-op when the
      // message is already in the destination), so re-running them is safe.
      if (folderId > 0) {
        const fresh = prev === undefined
          ? summaries.filter((s) => !s.flags.includes("Seen"))
          : summaries.filter((s) => s.uid > prev);
        if (fresh.length > 0) {
          void applyRulesToFresh(accountId, folderId, folderPath, fresh).catch(
            (err) => console.warn("rules engine failed", err),
          );
        }
        // Background-index the body+attachments of ANY summary whose
        // search_index row is missing or unindexed. This catches:
        //   • new arrivals above the high-water mark (normal path)
        //   • messages moved INTO this folder (new UID from IMAP MOVE)
        //   • messages re-appearing after a UID reuse / pruning edge case
        //   • first-fetch READ messages that haven't been indexed yet
        // We pre-filter to UIDs that have attachments OR aren't yet indexed
        // so we don't refetch bodies the indexer already processed.
        if (folderId > 0 && summaries.length > 0) {
          void (async () => {
            try {
              const allUids = summaries.map((s) => s.uid);
              // indexNewArrivals itself deduplicates per-UID via _indexingInProgress,
              // so passing all UIDs is safe — already-in-flight ones are filtered out
              // inside the function synchronously before any async work begins.
              await indexNewArrivals(accountId, folderPath, folderId, allUids);
            } catch { /* best-effort */ }
          })();
        }
      }

      // Keep the existing search_index in lockstep so the search overlay
      // continues to work without a code change. This duplicates the data
      // until search migrates to messages_fts, which is acceptable for now.
      for (const s of summaries) {
        void upsertSearchIndex({
          accountId,
          folderPath,
          imapUid: s.uid,
          messageIdHeader: s.messageId || null,
          subject: s.subject,
          fromAddress: s.from,
          toAddresses: s.to.join(", "),
          snippet: s.snippet,
          receivedAt: s.date,
        }).catch(() => {});

        // OCR backfill: for messages moved between folders (new UID assigned),
        // check OCR cache by Message-ID and write attachment_text if found.
        // This makes moved messages searchable in Trash, Archive, etc. without
        // needing a full re-index.
        if (s.messageId && s.hasAttachments) {
          // No att_index → returns text across ALL attachments for this message.
          void getOcrTextByMessageId(accountId, s.messageId).then((text) => {
            if (text) {
              void upsertAttachmentText(accountId, folderPath, s.uid, text).catch(() => {});
            }
          }).catch(() => {});
        }

        // Seed the composer autocomplete with real senders — skip newsletters
        // and automated transactional mail so the pool stays clean. seedContact
        // only adds new entries; it never bumps interaction_count.
        if (!s.isBulk && !s.isAuto && s.from) {
          const parsed = parseNameEmail(s.from);
          if (parsed) {
            void seedContact(parsed.email, parsed.name).catch(() => {});
          }
        }
      }

      // Await message upserts so the DB re-read below sees the new rows.
      if (upsertPromises.length > 0) await Promise.all(upsertPromises);

      // Don't overwrite rawThreads here — the DB re-read below will set it
      // with full coverage. Using IMAP-only summaries as rawThreads would
      // undo any user-initiated standalone splits for messages outside page 1.
      //
      // For silent refreshes on real folders, skip this intermediate IMAP render.
      // The DB re-read below will be the single definitive update, avoiding the
      // double-render that causes the list to jump in oldest-first sort.
      if (!rulesOnly) {
        if (!isStale()) {
          if (!options?.silent || folderId <= 0) {
            set({ threads, loading: false });
          } else {
            set({ loading: false });
          }
        }
      }
      // If we have a real folder id, re-read from DB now that the new page
      // has been persisted. This ensures thread.messages includes ALL known
      // members for each thread, not just the 50 that came back from IMAP.
      if (folderId > 0) {
        // ── Expunge detection ───────────────────────────────────────────
        // Fetch every UID the server currently holds for this folder and
        // purge any local rows whose UID is no longer present. This catches
        // messages deleted (and expunged) on another client between syncs.
        // Runs async — the UI already shows the fresh IMAP page; the DB
        // cleanup is a best-effort background operation.
        ipc.imapFetchAllUids(config, folderPath)
          .then((serverUids) =>
            purgeDeletedMessages(folderId, folderPath, accountId, serverUids),
          )
          .then((purged) => {
            if (purged > 0 && !rulesOnly) {
              // Re-read the DB so purged messages disappear from the thread list.
              return listMessagesForFolder(folderId, dbReadLimit).then((all) => {
                if (isStale()) return;
                const rawPurge = groupMessagesIntoThreads(all, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
                set({ threads: applyMergeGroups(rawPurge, get().mergeGroups, get().standaloneUids), rawThreads: rawPurge });
              });
            }
          })
          .catch(() => {});

        if (!rulesOnly) try {
          const all = await listMessagesForFolder(folderId, dbReadLimit);
          if (all.length > 0 && !isStale()) {
            const rawSync = groupMessagesIntoThreads(all, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
            set({ threads: applyMergeGroups(rawSync, get().mergeGroups, get().standaloneUids), rawThreads: rawSync });
            // If DB returned fewer rows than the limit the DB is fully
            // covered — no more rows exist. Fast-forward pageCountByFolder
            // so the oldest-first auto-pager jumps straight to the IMAP
            // offset beyond what the DB already has, instead of churning
            // through every already-loaded page one round-trip at a time.
            if (!silent && all.length < dbReadLimit) {
              const inferredPage = Math.floor(all.length / PAGE_SIZE);
              const currentPage = pageCountByFolder.get(key) ?? 1;
              if (inferredPage > currentPage) {
                pageCountByFolder.set(key, inferredPage);
                savePageCounts(pageCountByFolder);
              }
            }

            // ── Background gap-fill ───────────────────────────────────────
            // After loading the initial page of 50 from IMAP, check if the DB
            // already contains older messages that would create a gap in the
            // visible list (e.g. May 30 → Feb 17, skipping March/April).
            // If so, silently fetch all the pages between the fresh top-50 and
            // the existing backlog so the list is contiguous.
            //
            // Detection: find the oldest timestamp in the fresh IMAP page, then
            // check if the DB contains any message older than that. If it does,
            // and the gap is more than 7 days, page through IMAP until we've
            // bridged it. Cap at MAX_GAP_PAGES to avoid runaway fetching on
            // very large mailboxes.
            if (!silent && folderId > 0 && summaries.length >= PAGE_SIZE) {
              const GAP_THRESHOLD_SECS = 7 * 24 * 3600; // 7 days min gap to fill
              const MAX_GAP_PAGES = 60; // up to 3000 messages per fill session

              // Sort all DB rows by received_at DESC (already sorted, but ensure)
              const sortedRows = all.filter((r) => (r.received_at ?? 0) > 0)
                .map((r) => r.received_at as number)
                .sort((a, b) => b - a);

              // Find the largest internal gap in the DB rows — the discontinuity
              // we need to fill. Also check the gap between IMAP fresh page bottom
              // and the top of the DB backlog.
              const freshDates = summaries.map((s) => s.date ?? 0).filter((d) => d > 0);
              const oldestFreshTs = freshDates.length > 0 ? Math.min(...freshDates) : 0;

              // Find where the biggest gap is: either between fresh IMAP bottom
              // and DB top, or between consecutive DB rows.
              let biggestGapSize = 0;
              let gapStartTs = 0; // the newer side of the gap (we fetch from here backwards)

              // Check gap between fresh IMAP page bottom and first DB row below it
              if (oldestFreshTs > 0 && sortedRows.length > 0) {
                const dbRowsBelowFresh = sortedRows.filter((ts) => ts < oldestFreshTs);
                if (dbRowsBelowFresh.length > 0) {
                  const topBacklog = dbRowsBelowFresh[0]!;
                  const gapSize = oldestFreshTs - topBacklog;
                  if (gapSize > biggestGapSize) {
                    biggestGapSize = gapSize;
                    gapStartTs = oldestFreshTs;
                  }
                }
              }

              // Check for internal gaps within DB rows
              for (let i = 0; i < sortedRows.length - 1; i++) {
                const newer = sortedRows[i]!;
                const older = sortedRows[i + 1]!;
                const gap = newer - older;
                if (gap > biggestGapSize) {
                  biggestGapSize = gap;
                  gapStartTs = newer; // gap starts right after this row
                }
              }

              // Fire gap-fill if the biggest internal gap is more than 7 days
              if (biggestGapSize > GAP_THRESHOLD_SECS && gapStartTs > 0) {
                // Figure out which IMAP page offset corresponds to gapStartTs.
                // The IMAP server delivers messages newest-first: offset 0 = newest.
                // We need to find roughly how many messages are newer than gapStartTs
                // on the server (= the offset to start fetching from).
                // Use the DB count of messages newer than gapStartTs as the offset.
                const rowsNewerThanGap = sortedRows.filter((ts) => ts > gapStartTs).length;
                const startPage = Math.max(1, Math.floor(rowsNewerThanGap / PAGE_SIZE));
                void (async () => {
                  let gapPage = startPage; // start at the page where the gap begins
                  const maxPage = startPage + MAX_GAP_PAGES;
                  while (gapPage < maxPage && !isStale()) {
                    const gapOffset = gapPage * PAGE_SIZE;
                    let gapSummaries: MessageSummary[];
                    try {
                      gapSummaries = await ipc.imapFetchMessages(config, folderPath, PAGE_SIZE, gapOffset);
                    } catch {
                      break;
                    }
                    if (gapSummaries.length === 0) break;

                    await Promise.all(gapSummaries.map((s) =>
                      upsertMessageSummary({
                        accountId,
                        folderId,
                        imapUid: s.uid,
                        messageIdHeader: s.messageId || null,
                        inReplyTo: s.inReplyTo || null,
                        referencesHeader: (s.references ?? []).length > 0 ? (s.references ?? []).join(" ") : null,
                        fromAddress: s.from,
                        toAddresses: s.to.join(", "),
                        ccAddresses: s.cc && s.cc.length > 0 ? s.cc.join(", ") : null,
                        bccAddresses: s.bcc && s.bcc.length > 0 ? s.bcc.join(", ") : null,
                        subject: s.subject,
                        snippet: s.snippet,
                        receivedAt: s.date,
                        flags: s.flags,
                        isUnread: !s.flags.includes("Seen"),
                        isStarred: starInFlight.has(`${folderId}:${s.uid}`)
                          ? undefined
                          : s.flags.includes("Flagged"),
                        isImportant: false,
                        hasAttachments: s.hasAttachments,
                        isBulk: s.isBulk,
                        isAuto: s.isAuto,
                      }).catch(() => {}),
                    ));

                    // Advance page counter so loadMore won't re-fetch these pages
                    const latestPage = pageCountByFolder.get(key) ?? 1;
                    if (gapPage + 1 > latestPage) {
                      pageCountByFolder.set(key, gapPage + 1);
                      savePageCounts(pageCountByFolder);
                    }

                    // Check if this page has bridged the gap:
                    // the oldest message in this page is before the gap start,
                    // meaning we've fetched through the gap region.
                    const pageDates = gapSummaries.map((s) => s.date ?? 0).filter((d) => d > 0);
                    const oldestPageTs = pageDates.length > 0 ? Math.min(...pageDates) : 0;
                    // Find the older side of the gap in the DB
                    const olderSideOfGap = sortedRows.filter((ts) => ts < gapStartTs - biggestGapSize + GAP_THRESHOLD_SECS);
                    const olderEdgeTs = olderSideOfGap.length > 0 ? (olderSideOfGap[0] ?? 0) : 0;
                    if (oldestPageTs > 0 && olderEdgeTs > 0 && oldestPageTs <= olderEdgeTs + GAP_THRESHOLD_SECS) {
                      gapPage++;
                      break;
                    }

                    if (gapSummaries.length < PAGE_SIZE) break; // server ran out
                    gapPage++;
                  }

                  // Re-read DB with expanded limit to show the newly filled pages
                  if (!isStale()) {
                    try {
                      const newLimit = Math.max(dbReadLimit, (pageCountByFolder.get(key) ?? 1) * PAGE_SIZE * 2);
                      const gapFilled = await listMessagesForFolder(folderId, newLimit);
                      if (gapFilled.length > 0 && !isStale()) {
                        const rawGap = groupMessagesIntoThreads(gapFilled, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
                        set({ threads: applyMergeGroups(rawGap, get().mergeGroups, get().standaloneUids), rawThreads: rawGap });
                      }
                    } catch { /* best-effort */ }
                  }
                })();
              }
            }
          }
        } catch (err) {
          console.warn("fetchFolder: post-sync DB re-read failed", err);
        }
      }
    } catch (err) {
      // On a silent (background) refresh failure we keep the previous
      // threads visible — a transient network blip during sync should not
      // wipe the inbox the user is looking at.
      if (silent) {
        set({ error: String(err), loading: false });
      } else {
        // Non-silent failure with cached threads still visible? Keep them
        // and surface only the error banner. Less destructive than wiping
        // the list whenever the server hiccups.
        set((state) =>
          state.threads.length > 0
            ? { ...state, error: String(err), loading: false }
            : { ...state, error: String(err), loading: false, threads: [] },
        );
      }
    }
  },

  fetchAllStarred: async () => {
    set({ loading: true, error: null });
    try {
      const all = await listAllStarredMessages(500);
      // Group messages by (accountId, folderId) and thread each group.
      const grouped = new Map<string, StoredMessage[]>();
      for (const msg of all) {
        const key = `${msg.account_id}:${msg.folder_id}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(msg);
      }
      const allThreads: Thread[] = [];
      for (const [key, msgs] of grouped) {
        const splitKey = key.split(":");
        const accountIdStr = splitKey[0] ?? "0";
        const folderIdStr = splitKey[1] ?? "0";
        const accountId = parseInt(accountIdStr, 10);
        const folderId = parseInt(folderIdStr, 10);
        const ts = groupMessagesIntoThreads(
          msgs,
          accountId,
          folderId,
          new Set(get().standaloneUids[String(accountId)] ?? []),
        );
        allThreads.push(...ts);
      }
      allThreads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      set({ starredThreads: allThreads, loading: false });
    } catch (err) {
      console.error("fetchAllStarred failed", err);
      set({ loading: false });
    }
  },

  fetchAllUnread: async (accountId, folderPath, folderId) => {
    if (get().loadingMore) return;
    set({ loadingMore: true });
    try {
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      const config = imapConfigFor(account, secrets.imapPassword);

      const summaries = await ipc.imapFetchUnread(config, folderPath, 500);

      // Persist into the same messages table so the cache picks them up on
      // next cold-start. Same shape as fetchFolder's persist branch.
      if (folderId > 0) {
        for (const s of summaries) {
          void upsertMessageSummary({
            accountId,
            folderId,
            imapUid: s.uid,
            messageIdHeader: s.messageId || null,
            inReplyTo: s.inReplyTo || null,
            referencesHeader:
              (s.references ?? []).length > 0 ? (s.references ?? []).join(" ") : null,
            fromAddress: s.from,
            toAddresses: s.to.join(", "),
            ccAddresses: s.cc && s.cc.length > 0 ? s.cc.join(", ") : null,
            bccAddresses: s.bcc && s.bcc.length > 0 ? s.bcc.join(", ") : null,
            subject: s.subject,
            snippet: s.snippet,
            receivedAt: s.date,
            flags: s.flags,
            isUnread: !s.flags.includes("Seen"),
            isStarred: starInFlight.has(`${folderId}:${s.uid}`)
              ? undefined
              : s.flags.includes("Flagged"),
            isImportant: false,
            hasAttachments: s.hasAttachments,
            isBulk: s.isBulk,
            isAuto: s.isAuto,
          }).catch(() => {});

          void upsertSearchIndex({
            accountId,
            folderPath,
            imapUid: s.uid,
            messageIdHeader: s.messageId || null,
            subject: s.subject,
            fromAddress: s.from,
            toAddresses: s.to.join(", "),
            snippet: s.snippet,
            receivedAt: s.date,
          }).catch(() => {});
        }
      }

      // Re-cohort the merged set (cached + just-fetched) so threading is
      // consistent across the boundary. The DB read covers everything.
      if (folderId > 0) {
        const all = await listMessagesForFolder(folderId, 1000);
        const rawUnread = groupMessagesIntoThreads(all, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
        set({
          threads: applyMergeGroups(rawUnread, get().mergeGroups, get().standaloneUids),
          rawThreads: rawUnread,
          loadingMore: false,
        });
      } else {
        // Synthetic folder: just merge into RAM.
        const newThreads = groupSummariesIntoThreads(summaries, accountId, folderId);
        const knownIds = new Set(get().threads.map((t) => t.id));
        const append = newThreads.filter((t) => !knownIds.has(t.id));
        set((state) => ({
          threads: [...state.threads, ...append].sort(
            (a, b) => b.lastMessageAt - a.lastMessageAt,
          ),
          loadingMore: false,
        }));
      }
    } catch (err) {
      console.error("fetchAllUnread failed", err);
      set({ loadingMore: false });
      toast.error(`Load unread failed: ${err}`);
    }
  },

  loadMore: async (accountId, folderPath, folderId) => {
    const { loadingMore, hasMore } = get();
    if (loadingMore || !hasMore) return;

    const key = `${accountId}:${folderId}`;
    const currentPage = pageCountByFolder.get(key) ?? 1;
    const offset = currentPage * PAGE_SIZE;

    set({ loadingMore: true });
    try {
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      const config = imapConfigFor(account, secrets.imapPassword);

      const summaries = await ipc.imapFetchMessages(
        config,
        folderPath,
        PAGE_SIZE,
        offset,
      );
      // Persist the new page so the merged view + future cold-start include it.
      if (folderId > 0) {
        const upserts: Promise<void>[] = [];
        for (const s of summaries) {
          upserts.push(
            upsertMessageSummary({
              accountId,
              folderId,
              imapUid: s.uid,
              messageIdHeader: s.messageId || null,
              inReplyTo: s.inReplyTo || null,
              referencesHeader: (s.references ?? []).length > 0 ? (s.references ?? []).join(" ") : null,
              fromAddress: s.from,
              toAddresses: s.to.join(", "),
              ccAddresses: s.cc && s.cc.length > 0 ? s.cc.join(", ") : null,
              bccAddresses: s.bcc && s.bcc.length > 0 ? s.bcc.join(", ") : null,
              subject: s.subject,
              snippet: s.snippet,
              receivedAt: s.date,
              flags: s.flags,
              isUnread: !s.flags.includes("Seen"),
              isStarred: starInFlight.has(`${folderId}:${s.uid}`)
                ? undefined
                : s.flags.includes("Flagged"),
              isImportant: false,
              hasAttachments: s.hasAttachments,
              isBulk: s.isBulk,
              isAuto: s.isAuto,
            }).catch(() => {}),
          );

          void upsertSearchIndex({
            accountId,
            folderPath,
            imapUid: s.uid,
            messageIdHeader: s.messageId || null,
            subject: s.subject,
            fromAddress: s.from,
            toAddresses: s.to.join(", "),
            snippet: s.snippet,
            receivedAt: s.date,
          }).catch(() => {});
        }
        // Wait for all upserts to complete before re-reading the DB,
        // otherwise the newly fetched old messages won't be present yet.
        await Promise.all(upserts);
      }

      // Re-cohort everything we have on disk so threading stays correct
      // when an old reply belongs to an already-loaded family. Limit grows
      // each page and never falls below the floor set by the last fetchFolder
      // call, so messages already visible are never truncated away.
      if (folderId > 0) {
        const dbFloor = dbReadFloorByFolder.get(key) ?? 1000;
        const all = await listMessagesForFolder(folderId, Math.max(dbFloor, (currentPage + 1) * PAGE_SIZE * 4));
        const rawMore = groupMessagesIntoThreads(all, accountId, folderId, new Set(get().standaloneUids[String(accountId)] ?? []));
        set({
          threads: applyMergeGroups(rawMore, get().mergeGroups, get().standaloneUids),
          rawThreads: rawMore,
          loadingMore: false,
          hasMore: summaries.length >= PAGE_SIZE,
        });
      } else {
        // Synthetic folder — no DB to re-read. Append to existing threads
        // (no re-cohorting; threading might be slightly off but acceptable
        // for the very first sync of a brand-new account).
        const newThreads = groupSummariesIntoThreads(summaries, accountId, folderId);
        const knownIds = new Set(get().threads.map((t) => t.id));
        const append = newThreads.filter((t) => !knownIds.has(t.id));
        set((state) => ({
          threads: [...state.threads, ...append].sort(
            (a, b) => b.lastMessageAt - a.lastMessageAt,
          ),
          loadingMore: false,
          hasMore: summaries.length >= PAGE_SIZE,
        }));
      }

      pageCountByFolder.set(key, currentPage + 1);
      savePageCounts(pageCountByFolder);
    } catch (err) {
      console.error("loadMore failed", err);
      set({ loadingMore: false });
      toast.error(`Load more failed: ${err}`);
    }
  },

  setThreads: (threads) => set({ threads }),

  ensureThread: (thread) =>
    set((state) => {
      if (state.threads.some((t) => t.id === thread.id)) return state;
      return { threads: [thread, ...state.threads] };
    }),

  markStandalone: (accountId, msg) => {
    saveStandaloneUid(accountId, msg.uid);
    const key = String(accountId);
    const prev = get().standaloneUids;
    const newMap = { ...prev, [key]: [...new Set([...(prev[key] ?? []), msg.uid])] };
    const rawPrev = get().rawThreads;
    const hostThread = rawPrev.find((t) => t.messages.some((m) => m.uid === msg.uid));
    let newRaw: Thread[];
    const standaloneEntry: Thread = {
      id: msg.uid,
      accountId,
      folderId: msg.folderId,
      subject: msg.subject,
      snippet: msg.snippet,
      participants: [msg.from],
      hasUnread: !msg.flags.includes("Seen"),
      isPinned: msg.flags.includes("Flagged"),
      hasAttachments: msg.hasAttachments,
      messages: [{ uid: msg.uid, from: msg.from, date: msg.date, snippet: msg.snippet, flags: msg.flags, hasAttachments: msg.hasAttachments }],
      messageCount: 1,
      lastMessageAt: msg.date * 1000,
      category: null,
    };
    if (hostThread) {
      // Split the message out of its existing thread.
      newRaw = rawPrev.flatMap((t) => {
        if (t.id !== hostThread.id) return [t];
        const remaining = t.messages.filter((m) => m.uid !== msg.uid);
        if (remaining.length === 0) return [standaloneEntry];
        const newest = remaining[0]!;
        const trimmed: Thread = { ...t, id: newest.uid, messages: remaining, messageCount: remaining.length, lastMessageAt: newest.date * 1000 };
        return [trimmed, standaloneEntry];
      });
    } else {
      // Message not in rawThreads (cross-folder or loaded before DB re-read).
      // Add a synthetic standalone thread so it appears immediately.
      newRaw = [...rawPrev, standaloneEntry];
    }
    set({ standaloneUids: newMap, rawThreads: newRaw, threads: applyMergeGroups(newRaw, get().mergeGroups, newMap) });
  },

  moveSubjectBetweenGroups: (subject, targetThreadId) => {
    const norm = normaliseSubject(subject);
    const prevGroups = get().mergeGroups;
    // Remove norm from whichever group currently contains it
    const withoutSource: string[][] = [];
    for (const g of prevGroups) {
      if (g.includes(norm)) {
        const remainder = g.filter((s) => s !== norm);
        if (remainder.length >= 2) withoutSource.push(remainder);
        // If only 1 subject remains it's a single thread — drop the group entry
      } else {
        withoutSource.push(g);
      }
    }
    let newGroups = withoutSource;
    let newStandaloneUids = get().standaloneUids;
    if (targetThreadId !== null) {
      const targetThread = get().threads.find((t) => t.id === targetThreadId);
      if (targetThread) {
        const targetNorm = normaliseSubject(targetThread.subject);
        const existingIdx = newGroups.findIndex((g) => g.includes(targetNorm));
        if (existingIdx >= 0) {
          newGroups = newGroups.map((g, i) =>
            i === existingIdx ? Array.from(new Set([...g, norm])) : g,
          );
        } else {
          // Dedup so same-subject merges (two standalone splits of one
          // conversation) collapse into a single-entry group; applyMergeGroups
          // still uses that subject to pull matching rawThreads together.
          newGroups = [...newGroups, Array.from(new Set([targetNorm, norm]))];
        }
        // Standalone marks suppress merge-group collapse in applyMergeGroups.
        // When the user explicitly merges via the picker, clear any standalone
        // marks on threads whose subject is now part of this merge group so
        // the merge actually takes effect in the list.
        const groupSet = new Set([targetNorm, norm]);
        const uidsToUnmark = get().rawThreads
          .filter((t) => groupSet.has(normaliseSubject(t.subject)))
          .map((t) => t.id);
        if (uidsToUnmark.length > 0) {
          newStandaloneUids = removeStandaloneUids(targetThread.accountId, uidsToUnmark);
        }
      }
    }
    saveMergeGroups(newGroups);
    set({
      mergeGroups: newGroups,
      standaloneUids: newStandaloneUids,
      threads: applyMergeGroups(get().rawThreads, newGroups, newStandaloneUids),
    });
  },

  mergeThreads: async (primaryId, secondaryIds) => {
    if (secondaryIds.length === 0) return;
    const all = get().threads;
    const primary = all.find((t) => t.id === primaryId);
    if (!primary) return;
    const secondaries = all.filter((t) => secondaryIds.includes(t.id));
    // Remove all merged UIDs from standaloneUids so the post-processing no longer splits them
    const allMergedUids = [primaryId, ...secondaryIds];
    const newStandaloneUids = removeStandaloneUids(primary.accountId, allMergedUids);
    // Build the new merge group (union of any existing groups touching these subjects)
    const primaryNorm = normaliseSubject(primary.subject);
    const secondaryNorms = secondaries.map((t) => normaliseSubject(t.subject));
    const involved = new Set([primaryNorm, ...secondaryNorms]);
    const prevGroups = get().mergeGroups;
    const untouched: string[][] = [];
    const touchedSubjects = new Set<string>();
    for (const g of prevGroups) {
      if (g.some((s) => involved.has(s))) {
        for (const s of g) touchedSubjects.add(s);
      } else {
        untouched.push(g);
      }
    }
    const newGroup = Array.from(new Set([...involved, ...touchedSubjects]));
    const newGroups = [...untouched, newGroup];
    saveMergeGroups(newGroups);
    // Optimistic update
    const mergedCount = secondaries.reduce((s, t) => s + t.messageCount, 0);
    const latestAt = Math.max(primary.lastMessageAt, ...secondaries.map((t) => t.lastMessageAt));
    const anyUnread = primary.hasUnread || secondaries.some((t) => t.hasUnread);
    const mergedParticipants = Array.from(
      new Set([...primary.participants, ...secondaries.flatMap((t) => t.participants)]),
    );
    set((state) => ({
      mergeGroups: newGroups,
      standaloneUids: newStandaloneUids,
      threads: state.threads
        .filter((t) => !secondaryIds.includes(t.id))
        .map((t) =>
          t.id === primaryId
            ? { ...t, messageCount: t.messageCount + mergedCount, lastMessageAt: latestAt, hasUnread: anyUnread, participants: mergedParticipants }
            : t,
        ),
    }));
    try {
      await mergeThreadsInDb(primaryId, secondaryIds);
      toast.success(
        secondaryIds.length === 1
          ? "Threads merged"
          : `Merged ${secondaryIds.length + 1} threads`,
      );
    } catch (err) {
      // Revert threads but keep the group (merge groups are intentional)
      set((state) => ({
        threads: [...state.threads, ...secondaries].sort(
          (a, b) => b.lastMessageAt - a.lastMessageAt,
        ),
      }));
      toast.error(`Merge failed: ${err}`);
    }
  },

  emptyTrash: async (accountId, folderPath, folderId) => {
    console.log(`[emptyTrash] accountId=${accountId} folder="${folderPath}" folderId=${folderId}`);
    const account = await getAccount(accountId);
    if (!account) throw new Error(`account ${accountId} not found`);
    const secrets = await getAccountSecrets(accountId);
    const config = imapConfigFor(account, secrets.imapPassword);
    // Fetch all UIDs currently in the trash folder on the server
    const uids = await ipc.imapFetchAllUids(config, folderPath);
    console.log(`[emptyTrash] server UIDs (${uids.length}):`, uids);
    if (uids.length === 0) {
      toast.success("Trash is already empty");
      return;
    }
    // Delete locally first for immediate UI feedback. Clean up matching
    // sent_log placeholders BEFORE we drop the messages rows so the
    // subject/sent_at join still has rows to match against.
    if (folderId > 0) {
      await deleteSentLogForFolderMatches(accountId, folderId).catch(() => {});
      await deleteMessagesForFolder(folderId).catch(() => {});
      console.log(`[emptyTrash] local DB cleared for folderId=${folderId}`);
    }
    await pruneSearchIndex(accountId, folderPath, []).catch(() => {});
    console.log(`[emptyTrash] search index cleared`);
    set((state) => ({
      threads: state.threads.filter((t) => t.folderId !== folderId),
    }));
    // Clear any thread selection that pointed into the now-empty trash so the
    // reading pane (which caches cross-folder conversation siblings from Sent
    // / Inbox) doesn't keep showing stale messages from the deleted thread.
    useUiStore.getState().selectThread(null);

    // Run the IMAP expunge in the background — don't block the UI on a
    // potentially slow server-side operation. Chunk UIDs so a huge trash
    // doesn't produce a multi-megabyte IMAP command that some servers
    // reject or hang on. Each chunk runs as a separate UID STORE + EXPUNGE
    // in its own short-lived session.
    const CHUNK_SIZE = 200;
    const chunks: number[][] = [];
    for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
      chunks.push(uids.slice(i, i + CHUNK_SIZE));
    }
    const total = uids.length;
    toast.success(
      `Deleting ${total} message${total === 1 ? "" : "s"} from trash\u2026`,
    );
    void (async () => {
      let done = 0;
      let failures = 0;
      for (const chunk of chunks) {
        try {
          await ipc.imapExpungeUids(config, folderPath, chunk);
          done += chunk.length;
          console.log(`[emptyTrash] expunged chunk: ${done}/${total}`);
        } catch (err) {
          failures += chunk.length;
          console.warn(`[emptyTrash] chunk failed (${chunk.length} UIDs):`, err);
        }
      }
      if (failures === 0) {
        toast.success(`Permanently deleted ${total} message${total === 1 ? "" : "s"}`);
      } else if (done > 0) {
        toast.error(`Deleted ${done} of ${total}; ${failures} failed`);
      } else {
        toast.error(`Failed to empty trash on server`);
      }
    })();
  },

  trashMessage: async (accountId, folderPath, uid) => {
    console.log(`[trashMessage] uid=${uid} folder="${folderPath}"`);
    // Sent-log entries use a negative synthetic UID (0 - sent_log.id).
    // They have no IMAP representation, so just delete the DB row and remove
    // the message from the thread list — no IMAP call needed.
    if (uid < 0) {
      const sentLogId = -uid;
      console.log(`[trashMessage] sent_log entry id=${sentLogId} — deleting from DB only`);
      await deleteSentLogEntry(sentLogId).catch(() => {});
      set((state) => ({
        threads: state.threads.map((t) => {
          if (!t.messages?.some((m) => m.uid === uid)) return t;
          const msgs = t.messages.filter((m) => m.uid !== uid);
          return { ...t, messages: msgs, messageCount: Math.max(1, t.messageCount - 1) };
        }),
      }));
      toast.success("Deleted");
      return;
    }
    const { folders } = useAccountsStore.getState();
    const folder = folders.find((f) => f.accountId === accountId && f.path === folderPath);
    const folderId = folder?.id ?? -1;
    const folderLeaf = folderPath.split(/[\/. \\]/).filter(Boolean).pop() ?? "";
    const isInTrash =
      folder?.specialUse === "trash" ||
      folder?.specialUse === "spam" ||
      /^(trash|deleted(\s*items?)?)$/i.test(folderLeaf) ||
      /^(trash|deleted(\s*items?)?)$/i.test(folder?.name ?? "");
    console.log(`[trashMessage] isInTrash=${isInTrash} folderId=${folderId}`);
    const account = await getAccount(accountId);
    if (!account) throw new Error(`account ${accountId} not found`);
    const secrets = await getAccountSecrets(accountId);
    const config = imapConfigFor(account, secrets.imapPassword);
    if (folderId > 0) {
      await deleteMessage(folderId, uid).catch(() => {});
    }
    // Remove the message from thread state. If the deleted message was the
    // thread's representative (thread.id === uid, i.e. it was the newest
    // message), re-key the thread to the next newest message so the reading
    // pane stays visible after the background IDLE sync rebuilds the list.
    let newThreadId: number | undefined;
    set((state) => ({
      threads: state.threads.map((t) => {
        if (!t.messages?.some((m) => m.uid === uid)) return t;
        const msgs = t.messages.filter((m) => m.uid !== uid);
        const newId = t.id === uid && msgs.length > 0 ? (msgs[0]?.uid ?? t.id) : t.id;
        if (t.id === uid && msgs.length > 0) newThreadId = newId;
        return { ...t, id: newId, messages: msgs, messageCount: Math.max(1, t.messageCount - 1) };
      }),
    }));
    // Keep selectedThreadId in sync so the reading pane tracks the re-keyed thread.
    if (newThreadId !== undefined && useUiStore.getState().selectedThreadId === uid) {
      useUiStore.getState().selectThread(newThreadId);
    }
    if (isInTrash) {
      console.log(`[trashMessage] expunging uid=${uid} from "${folderPath}"`);
      await ipc.imapExpungeUids(config, folderPath, [uid]);
      console.log(`[trashMessage] expunge OK`);
      toast.success("Deleted permanently");
    } else {
      const trashPath = findFolderPath(accountId, "trash") ?? "Trash";
      console.log(`[trashMessage] moving uid=${uid} from "${folderPath}" to "${trashPath}"`);
      await ipc.imapMoveUid(config, folderPath, trashPath, uid);
      console.log(`[trashMessage] move OK`);
      toast.success("Moved to Trash");
    }
  },

  trashMessages: async (accountId, msgs) => {
    if (msgs.length === 0) return;
    console.log(`[trashMessages] ${msgs.length} messages:`, msgs.map((m) => `${m.folderPath}:${m.uid}`));
    const { folders } = useAccountsStore.getState();
    const account = await getAccount(accountId);
    if (!account) return;
    const secrets = await getAccountSecrets(accountId);
    const config = imapConfigFor(account, secrets.imapPassword);

    // DB cleanup for every message up-front (before IMAP to avoid race re-adds).
    await Promise.all(
      msgs.map(({ folderPath, uid }) => {
        const folder = folders.find((f) => f.accountId === accountId && f.path === folderPath);
        const folderId = folder?.id ?? -1;
        return Promise.all([
          folderId > 0 ? deleteMessage(folderId, uid).catch(() => {}) : Promise.resolve(),
          deleteSearchIndexEntry(accountId, folderPath, uid).catch(() => {}),
        ]);
      }),
    );

    // Optimistically remove all affected UIDs from the thread store.
    const uidSet = new Set(msgs.map((m) => m.uid));
    set((state) => ({
      threads: state.threads.filter((t) => !uidSet.has(t.id)).map((t) => {
        if (!t.messages?.some((m) => uidSet.has(m.uid))) return t;
        const kept = t.messages.filter((m) => !uidSet.has(m.uid));
        return { ...t, messages: kept, messageCount: Math.max(1, kept.length) };
      }),
    }));

    // Group by folder for batch IMAP operations.
    const byFolder = new Map<string, number[]>();
    for (const { folderPath, uid } of msgs) {
      const arr = byFolder.get(folderPath) ?? [];
      arr.push(uid);
      byFolder.set(folderPath, arr);
    }

    let anyInTrash = false;
    let anyMoved = false;
    const trashPath = findFolderPath(accountId, "trash") ?? "Trash";
    for (const [folderPath, uids] of byFolder) {
      const folder = folders.find((f) => f.accountId === accountId && f.path === folderPath);
      const folderLeaf = folderPath.split(/[\/. \\]/).filter(Boolean).pop() ?? "";
      const isInTrash =
        folder?.specialUse === "trash" ||
        folder?.specialUse === "spam" ||
        /^(trash|deleted(\s*items?)?)$/i.test(folderLeaf) ||
        /^(trash|deleted(\s*items?)?)$/i.test(folder?.name ?? "");
      if (isInTrash) {
        anyInTrash = true;
        console.log(`[trashMessages] expunging uids=${JSON.stringify(uids)} from "${folderPath}"`);
        await ipc.imapExpungeUids(config, folderPath, uids).catch((e) => console.error(`[trashMessages] expunge failed:`, e));
        console.log(`[trashMessages] expunge OK for "${folderPath}"`);
      } else {
        anyMoved = true;
        console.log(`[trashMessages] moving uids=${JSON.stringify(uids)} from "${folderPath}" to "${trashPath}"`);
        await ipc.imapMoveUids(config, folderPath, trashPath, uids).catch((e) => console.error(`[trashMessages] move failed:`, e));
        console.log(`[trashMessages] move OK for "${folderPath}"`);
      }
    }

    if (anyInTrash && !anyMoved) toast.success("Deleted permanently");
    else toast.success("Moved to Trash");
    console.log(`[trashMessages] done. anyInTrash=${anyInTrash} anyMoved=${anyMoved}`);
  },

  togglePin: (id) =>
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === id ? { ...t, isPinned: !t.isPinned } : t,
      ),
    })),

  markRead: async (id, opts) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) {
      console.log(`[markRead] skip id=${id} thread=missing`);
      return;
    }
    if (!thread.hasUnread) {
      // The local DB already has is_unread=0 for this thread, but the IMAP
      // server may still report \Unseen (happens when a previous
      // imapSetFlagsMulti failed after the DB write — the catch block reverts
      // the store but, in older code paths, may not have reverted the DB).
      // Push \Seen to the server and pull STATUS to self-correct the badge.
      if (thread.folderId > 0) {
        console.log(`[markRead] hasUnread=false id=${id} → IMAP server resync`);
        void (async () => {
          try {
            const { config, folderPath } = await sessionFor(thread);
            const uids = thread.messages.map((m) => m.uid).filter((u) => u > 0);
            if (uids.length === 0) uids.push(thread.id);
            await ipc.imapSetFlagsMulti(config, folderPath, uids, ["\\Seen"], "add");
            const status = await ipc.imapFolderStatus(config, folderPath);
            useAccountsStore.setState((state) => ({
              folders: state.folders.map((f) => {
                if (f.id !== thread.folderId) return f;
                const next = Math.min(f.unreadCount ?? 0, status.unseen);
                console.log(`[markRead-resync] ${f.name} ${f.unreadCount} → ${next} (server=${status.unseen})`);
                return { ...f, unreadCount: next };
              }),
            }));
          } catch {
            // Non-fatal — the 30-s tick-inbox cycle will eventually correct it.
          }
        })();
      }
      return;
    }
    // Read-only browsing mode: skip the +Seen unless the caller forced it.
    const force = opts?.force === true;
    if (!force && useUiStore.getState().dontMarkReadOnOpen) {
      console.log(`[markRead] skip id=${id} dontMarkReadOnOpen=true`);
      return;
    }
    flog.info(
      `markRead: id=${id} folderId=${thread.folderId} force=${force}`,
    );

    // Collect UIDs across this thread AND any other unread threads in the
    // same folder with the same normalised subject. The reading pane groups
    // messages by subject (listConversationMessages), so the user considers
    // them one conversation — even when the messages lack In-Reply-To links
    // and end up in separate Thread objects in the store.
    const threadNorm = normalizeSubject(thread.subject);
    const relatedUnread = get().threads.filter(
      (t) =>
        t.folderId === thread.folderId &&
        t.hasUnread &&
        normalizeSubject(t.subject) === threadNorm,
    );
    // Collect every unread UID from all related threads.
    const uidsToMark: number[] = [];
    for (const t of relatedUnread) {
      const unread = t.messages.filter((m) => !m.flags.includes("Seen"));
      if (unread.length > 0) {
        for (const m of unread) uidsToMark.push(m.uid);
      } else {
        uidsToMark.push(t.id); // fallback for synthetic/empty messages arrays
      }
    }
    if (uidsToMark.length === 0) uidsToMark.push(thread.id);
    const unreadDelta = uidsToMark.length;
    const relatedIds = relatedUnread.map((t) => t.id);

    // Optimistic local update: mark all related threads as read at once.
    set((state) => ({
      threads: state.threads.map((t) => {
        if (!relatedIds.includes(t.id)) return t;
        return {
          ...t,
          hasUnread: false,
          messages: t.messages.map((m) =>
            !m.flags.includes("Seen") ? { ...m, flags: [...m.flags, "Seen"] } : m,
          ),
        };
      }),
    }));
    useAccountsStore.getState().adjustFolderUnread(thread.folderId, -unreadDelta);

    // Await DB writes (run in parallel with session setup) so that any
    // concurrent fetchFolder finds is_unread=0 and MIN(1,0)=0 holds.
    const dbWritePromises = thread.folderId > 0
      ? uidsToMark.map((uid) =>
          updateMessageFlags(thread.folderId, uid, { isUnread: false }).catch(() => {}),
        )
      : [];
    // Mark this folder as having an in-flight \Seen operation so the periodic
    // badge tick doesn't re-inflate the count from a stale server STATUS.
    markReadInFlight.add(thread.folderId);
    try {
      const [{ config, folderPath }] = await Promise.all([
        sessionFor(thread),
        Promise.all(dbWritePromises),
      ]);
      await ipc.imapSetFlagsMulti(config, folderPath, uidsToMark, ["\\Seen"], "add");
      markReadInFlight.delete(thread.folderId);
      // Re-sync badge count from the server to catch any drift.
      try {
        const status = await ipc.imapFolderStatus(config, folderPath);
        useAccountsStore.setState((state) => ({
          folders: state.folders.map((f) => {
            if (f.id !== thread.folderId) return f;
            // Use Math.min so markRead's resync can only REDUCE the count —
            // it must never zero out a folder that already has OTHER unread
            // messages (e.g. a second email that arrived while this STATUS
            // call was in-flight).
            const next = Math.min(f.unreadCount ?? 0, status.unseen);
            console.log(`[markRead-status] ${f.name} ${f.unreadCount} → ${next} (server=${status.unseen})`);
            return { ...f, unreadCount: next };
          }),
        }));
      } catch {
        // STATUS failure is non-fatal; the periodic resync will correct it.
      }
    } catch (err) {
      markReadInFlight.delete(thread.folderId);
      flog.error(`markRead failed on server (id=${id}):`, err);
      // Revert all related threads.
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, +unreadDelta);
      set((state) => ({
        threads: state.threads.map((t) => {
          if (!relatedIds.includes(t.id)) return t;
          return {
            ...t,
            hasUnread: true,
            messages: t.messages.map((m) =>
              uidsToMark.includes(m.uid)
                ? { ...m, flags: m.flags.filter((f) => f !== "Seen") }
                : m,
            ),
          };
        }),
      }));
      if (thread.folderId > 0) {
        for (const uid of uidsToMark) {
          void updateMessageFlags(thread.folderId, uid, { isUnread: true }).catch(() => {});
        }
      }
    }
  },

  markUnread: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread || thread.hasUnread) return;
    flog.info(`markUnread: id=${id} folderId=${thread.folderId}`);

    // Collect UIDs of all messages that currently have the Seen flag
    const uidsToMark: number[] = thread.messages.length > 0
      ? thread.messages.filter((m) => m.flags.includes("Seen")).map((m) => m.uid)
      : [thread.id];
    if (uidsToMark.length === 0) uidsToMark.push(thread.id);
    const delta = uidsToMark.length;

    // Optimistic update
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id !== id ? t : {
          ...t,
          hasUnread: true,
          messages: t.messages.map((m) =>
            uidsToMark.includes(m.uid)
              ? { ...m, flags: m.flags.filter((f) => f !== "Seen") }
              : m,
          ),
        },
      ),
    }));
    useAccountsStore.getState().adjustFolderUnread(thread.folderId, +delta);

    if (thread.folderId > 0) {
      for (const uid of uidsToMark) {
        void updateMessageFlags(thread.folderId, uid, { isUnread: true }).catch(() => {});
      }
    }

    try {
      const { config, folderPath } = await sessionFor(thread);
      await ipc.imapSetFlagsMulti(config, folderPath, uidsToMark, ["\\Seen"], "remove");
    } catch (err) {
      flog.error(`markUnread failed on server (id=${id}):`, err);
      // Revert
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -delta);
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id !== id ? t : {
            ...t,
            hasUnread: false,
            messages: t.messages.map((m) =>
              uidsToMark.includes(m.uid)
                ? { ...m, flags: [...m.flags, "Seen"] }
                : m,
            ),
          },
        ),
      }));
      if (thread.folderId > 0) {
        for (const uid of uidsToMark) {
          void updateMessageFlags(thread.folderId, uid, { isUnread: false }).catch(() => {});
        }
      }
    }
  },

  toggleStar: async (id) => {
    // Prevent double-clicks from firing a second IMAP call while the first is in progress.
    if (starToggleInFlight.has(id)) return;
    starToggleInFlight.add(id);
    const thread = get().threads.find((t) => t.id === id)
      ?? get().starredThreads.find((t) => t.id === id);
    if (!thread) { starToggleInFlight.delete(id); return; }
    const nextPinned = !thread.isPinned;

    // Collect all real IMAP UIDs in this thread. When unstarring we only
    // need to clear \Flagged on messages that actually have it; when starring
    // we add it to every message so the thread reliably shows as starred after
    // the next sync (where isPinned is derived from ANY member having Flagged).
    const allUids = thread.messages.length > 0
      ? thread.messages.map((m) => m.uid).filter((u) => u > 0)
      : [thread.id];
    const uidsToFlag = nextPinned
      ? allUids
      : allUids.filter((u) => {
          const msg = thread.messages.find((m) => m.uid === u);
          return msg ? msg.flags.includes("Flagged") : u === thread.id;
        });
    // Always include thread.id as a fallback so at least one UID is operated on.
    if (uidsToFlag.length === 0) uidsToFlag.push(thread.id);

    set((state) => ({
      threads: state.threads.map((t) => (t.id === id ? { ...t, isPinned: nextPinned } : t)),
      // Keep starredThreads in sync: add when starring, remove when unstarring.
      starredThreads: nextPinned
        ? (state.starredThreads.some((t) => t.id === id)
            ? state.starredThreads.map((t) => (t.id === id ? { ...t, isPinned: true } : t))
            : [{ ...thread, isPinned: true }, ...state.starredThreads].sort(
                (a, b) => b.lastMessageAt - a.lastMessageAt,
              ))
        : state.starredThreads.filter((t) => t.id !== id),
    }));
    // Guard all UIDs against background upserts overwriting is_starred while
    // the IMAP UID STORE round-trip is in progress (IDLE can race us).
    const inFlightKeys = allUids.map((u) => `${thread.folderId}:${u}`);
    if (thread.folderId > 0) {
      for (const key of inFlightKeys) starInFlight.set(key, nextPinned);
    }
    // Track DB write promises so we can wait for them to complete before
    // clearing the in-flight guard — fire-and-forget writes can be queued
    // behind slow FTS index updates and not land for many seconds.
    const dbWritePromises: Promise<unknown>[] = [];
    if (thread.folderId > 0) {
      for (const uid of allUids) {
        dbWritePromises.push(
          updateMessageFlags(thread.folderId, uid, { isStarred: nextPinned }).catch(() => {}),
        );
      }
    }
    try {
      const { config, folderPath } = await sessionFor(thread);
      await ipc.imapSetFlagsMulti(
        config,
        folderPath,
        uidsToFlag,
        ["\\Flagged"],
        nextPinned ? "add" : "remove",
      );
      // Wait for our DB writes to land BEFORE the finally block clears
      // the in-flight guard, so subsequent fetchFolder upserts cannot
      // race past our write with stale is_starred values.
      await Promise.all(dbWritePromises);
    } catch (err) {
      // Revert on failure.
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === id ? { ...t, isPinned: !nextPinned } : t,
        ),
        starredThreads: !nextPinned
          ? (state.starredThreads.some((t) => t.id === id)
              ? state.starredThreads.map((t) => (t.id === id ? { ...t, isPinned: true } : t))
              : [{ ...thread, isPinned: true }, ...state.starredThreads].sort(
                  (a, b) => b.lastMessageAt - a.lastMessageAt,
                ))
          : state.starredThreads.filter((t) => t.id !== id),
      }));
      if (thread.folderId > 0) {
        for (const uid of allUids) {
          void updateMessageFlags(thread.folderId, uid, { isStarred: !nextPinned }).catch(() => {});
        }
      }
      console.error("toggleStar failed:", err);
      throw err;
    } finally {
      // Keep the starInFlight guard alive for a few extra seconds after the
      // IMAP call completes. The SQLite DB can be slow (FTS index, WAL), so a
      // background fetchFolder DB write may arrive well after the IMAP round-
      // trip finishes and overwrite is_starred with the old server value.
      // starToggleInFlight is cleared immediately so the user can click again.
      starToggleInFlight.delete(id);
      setTimeout(() => {
        for (const key of inFlightKeys) starInFlight.delete(key);
      }, 5000);
    }
  },

  snoozeThread: async (id, untilUnixSeconds) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    const keyword = snoozeKeyword(untilUnixSeconds);
    // Optimistic: vanish from the visible list (the cohort filter will keep
    // it hidden on subsequent renders too).
    set((state) => ({ threads: state.threads.filter((t) => t.id !== id) }));
    try {
      const { config, folderPath } = await sessionFor(thread);
      await ipc.imapSetFlags(config, folderPath, thread.id, [keyword], "add");
      toast.success("Snoozed");
    } catch (err) {
      restoreThread(set, get, thread);
      console.error("snoozeThread failed:", err);
      toast.error(`Snooze failed: ${err}`);
      throw err;
    }
  },

  unsnoozeThread: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    // Find any snooze keyword on the message — could be one or more.
    // (Caller usually just dropped the message back into the visible list,
    // so we don't optimistic-update here.)
    try {
      const { config, folderPath } = await sessionFor(thread);
      // Without persisted flags we don't know the exact keyword string;
      // remove the family with a wildcard send. async-imap accepts any
      // flag string in -FLAGS so we send `Cursus-SnoozedUntil:*` (and the
      // most servers accept as a literal — failing that the keyword
      // simply stays and gets cleared by the periodic checker once we
      // have flags.
      await ipc.imapSetFlags(config, folderPath, thread.id, SNOOZE_REMOVE_GLOBS, "remove").catch(() => {});
    } catch (err) {
      console.warn("unsnoozeThread failed:", err);
    }
  },

  moveToFolder: async (id: number, destPath: string) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    const sourceFolder = useAccountsStore
      .getState()
      .folders.find((f) => f.id === thread.folderId);
    if (sourceFolder && sourceFolder.path === destPath) return; // no-op

    // Find all threads in the same folder with the same normalised subject so
    // the entire visible conversation moves, not just the single thread object
    // that was clicked (conversations can span multiple thread objects when
    // messages lack In-Reply-To headers).
    const threadNorm = normalizeSubject(thread.subject);
    const related = get().threads.filter(
      (t) =>
        t.folderId === thread.folderId &&
        normalizeSubject(t.subject) === threadNorm,
    );
    const relatedIds = related.map((t) => t.id);
    const uidsToMove: number[] = [];
    for (const t of related) {
      const uids = t.messages.length > 0
        ? t.messages.map((m) => m.uid).filter((u) => u > 0)
        : [t.id];
      for (const uid of uids) {
        if (!uidsToMove.includes(uid)) uidsToMove.push(uid);
      }
    }
    const unreadDelta = related.filter((t) => t.hasUnread).length;

    // Optimistic: remove all related threads from the store immediately.
    set((state) => ({
      threads: state.threads.filter((t) => !relatedIds.includes(t.id)),
    }));
    if (unreadDelta > 0) {
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -unreadDelta);
    }
    try {
      const { config, folderPath } = await sessionFor(thread);
      await ipc.imapMoveUids(config, folderPath, destPath, uidsToMove);
      if (thread.folderId > 0) {
        for (const uid of uidsToMove) {
          void deleteMessage(thread.folderId, uid).catch(() => {});
          void deleteSearchIndexEntry(thread.accountId, folderPath, uid).catch(() => {});
        }
      }
      toast.success(`Moved to ${displayPathName(destPath)}`);
      // Silently fetch the destination folder so the new UID is upserted into
      // the DB immediately — this ensures indexNewArrivals can OCR the moved
      // attachment without waiting for the user to open that folder.
      const destFolder = useAccountsStore.getState().folders.find(
        (f) => f.accountId === thread.accountId && f.path === destPath,
      );
      if (destFolder) {
        void get().fetchFolder(thread.accountId, destPath, destFolder.id, { rulesOnly: true }).catch(() => {});
      }
    } catch (err) {
      restoreThreads(null, null, related);
      if (unreadDelta > 0) {
        useAccountsStore.getState().adjustFolderUnread(thread.folderId, +unreadDelta);
      }
      console.error("moveToFolder failed:", err);
      toast.error(`Move failed: ${err}`);
      throw err;
    }
  },

  archiveThread: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    const dest = findFolderPath(thread.accountId, "archive") ?? "Archive";

    // Collect all same-subject threads in the same folder so the whole
    // conversation archives, not just the clicked thread object.
    const threadNorm = normalizeSubject(thread.subject);
    const related = get().threads.filter(
      (t) =>
        t.folderId === thread.folderId &&
        normalizeSubject(t.subject) === threadNorm,
    );
    const relatedIds = related.map((t) => t.id);
    const uidsToMove: number[] = [];
    for (const t of related) {
      const uids = t.messages.length > 0
        ? t.messages.map((m) => m.uid).filter((u) => u > 0)
        : [t.id];
      for (const uid of uids) {
        if (!uidsToMove.includes(uid)) uidsToMove.push(uid);
      }
    }
    const unreadDelta = related.filter((t) => t.hasUnread).length;

    set((state) => ({
      threads: state.threads.filter((t) => !relatedIds.includes(t.id)),
    }));
    if (unreadDelta > 0) {
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -unreadDelta);
    }
    try {
      const { config, folderPath } = await sessionFor(thread);
      await ipc.imapMoveUids(config, folderPath, dest, uidsToMove);
      if (thread.folderId > 0) {
        for (const uid of uidsToMove) {
          void deleteMessage(thread.folderId, uid).catch(() => {});
          void deleteSearchIndexEntry(thread.accountId, folderPath, uid).catch(() => {});
        }
      }
      toast.success("Archived");
      // Silently fetch destination so moved attachments get indexed immediately.
      const archiveFolder = useAccountsStore.getState().folders.find(
        (f) => f.accountId === thread.accountId && f.path === dest,
      );
      if (archiveFolder) {
        void get().fetchFolder(thread.accountId, dest, archiveFolder.id, { rulesOnly: true }).catch(() => {});
      }
    } catch (err) {
      restoreThreads(null, null, related);
      if (unreadDelta > 0) {
        useAccountsStore.getState().adjustFolderUnread(thread.folderId, +unreadDelta);
      }
      console.error("archiveThread failed:", err);
      toast.error(`Archive failed: ${err}`);
      throw err;
    }
  },

  trashThread: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    // If already in the trash or spam folder, expunge instead of move-to-same
    // which is a no-op and causes messages to reappear on next sync.
    // Use multiple signals: specialUse (most reliable when set), path name
    // pattern (works when specialUse is missing from DB), and exact path match.
    const threadFolder = useAccountsStore.getState().folders.find((f) => f.id === thread.folderId);
    const trashPath = findFolderPath(thread.accountId, "trash") ?? "Trash";
    const folderLeaf = (threadFolder?.path ?? "").split(/[\/. \\]/).filter(Boolean).pop() ?? "";
    const isInTrash =
      threadFolder?.specialUse === "trash" ||
      threadFolder?.specialUse === "spam" ||
      (threadFolder?.path ?? "") === trashPath ||
      /^(trash|deleted(\s*items?)?)$/i.test(folderLeaf) ||
      /^(trash|deleted(\s*items?)?)$/i.test(threadFolder?.name ?? "");
    if (isInTrash) {
      return get().permanentDeleteThread(id);
    }
    const dest = trashPath;
    console.log(`[trashThread] id=${id} subject="${thread.subject}" folderId=${thread.folderId} dest="${dest}" — calling sessionFor`);
    let config!: ImapConfig;
    let folderPath!: string;
    try {
      const s = await sessionFor(thread);
      config = s.config;
      folderPath = s.folderPath;
    } catch (err) {
      console.error("[trashThread] sessionFor failed:", err);
      toast.error(`Cannot trash: ${err}`);
      return;
    }
    const normSubject = normaliseSubject(thread.subject);
    const allFoldersList = useAccountsStore.getState().folders;
    console.log(`[trashThread] id=${id} subject="${thread.subject}" norm="${normSubject}" folder="${folderPath}" dest="${dest}"`);

    // Collect related messages from two sources so we cover every folder:
    // 1. In-memory threads with the same normalized subject (already loaded).
    // 2. Database (synced folders that aren't currently in memory).
    const otherFolders = new Map<string, { path: string; folderId: number; uids: number[] }>();
    // Same-folder related UIDs (e.g. duplicate receipts in INBOX) — batched with the primary move.
    const sameFolderExtraUids: number[] = [];
    const addRelated = (fp: string, fId: number, uid: number) => {
      if (uid <= 0 || fp === dest) return;
      if (fId === thread.folderId) {
        // Same folder as primary: batch into the primary IMAP move.
        if (uid !== thread.id && !sameFolderExtraUids.includes(uid)) sameFolderExtraUids.push(uid);
        return;
      }
      const entry = otherFolders.get(fp) ?? { path: fp, folderId: fId, uids: [] };
      if (!entry.uids.includes(uid)) entry.uids.push(uid);
      otherFolders.set(fp, entry);
    };

    // Source 1: in-memory threads.
    for (const t of get().threads) {
      if (t.id === id || t.accountId !== thread.accountId) continue;
      if (normaliseSubject(t.subject) !== normSubject) continue;
      const tFolder = allFoldersList.find((f) => f.id === t.folderId);
      if (!tFolder) continue;
      const uids = t.messages.length ? t.messages.map((m) => m.uid) : [t.id];
      console.log(`[trashThread] in-memory related: folder="${tFolder.path}" uids=${JSON.stringify(uids)}`);
      for (const uid of uids) addRelated(tFolder.path, t.folderId, uid);
    }

    // Source 2: database.
    const related = await listConversationMessages(thread.accountId, normSubject).catch((e) => { console.error('[trashThread] listConversationMessages error:', e); return []; });
    console.log(`[trashThread] DB related (${related.length}):`, related.map((m) => `${m.folder_path}:${m.uid}`));
    for (const msg of related) addRelated(msg.folder_path, msg.folder_id, msg.uid);
    console.log(`[trashThread] sameFolderExtraUids:`, sameFolderExtraUids);
    console.log(`[trashThread] otherFolders to move:`, [...otherFolders.entries()].map(([fp, e]) => `${fp} uids=${JSON.stringify(e.uids)}`));

    // Optimistically remove the primary, same-folder related, and cross-folder related threads.
    const otherFolderIds = new Set([...otherFolders.values()].map((e) => e.folderId));
    const sameFolderExtraSet = new Set(sameFolderExtraUids);
    const relatedInMemoryIds = new Set(
      get().threads
        .filter((t) => {
          if (t.id === id || t.accountId !== thread.accountId) return false;
          if (normaliseSubject(t.subject) !== normSubject) return false;
          // Include same-folder threads whose UID is in sameFolderExtraUids.
          if (t.folderId === thread.folderId) return sameFolderExtraSet.has(t.id);
          return otherFolderIds.has(t.folderId);
        })
        .map((t) => t.id),
    );
    const otherFolderUids = new Map(
      [...otherFolders.values()].map(({ folderId, uids }) => [folderId, new Set(uids)]),
    );
    set((state) => ({
      threads: state.threads.filter((t) => {
        if (t.id === id) return false;
        if (relatedInMemoryIds.has(t.id)) return false;
        if (t.accountId !== thread.accountId) return true;
        return !otherFolderUids.get(t.folderId)?.has(t.id);
      }),
    }));
    if (thread.hasUnread) {
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -1);
    }
    try {
      // Move all message UIDs in the primary thread folder to Trash at once,
      // including any same-folder related messages (e.g. duplicate receipts).
      const primaryUids = [
        ...(thread.messages.length
          ? thread.messages.map((m) => m.uid).filter((uid) => uid > 0)
          : [thread.id]),
        ...sameFolderExtraUids,
      ];
      // Delete from DB and search index BEFORE the IMAP call so that any
      // fetchFolder triggered by the IMAP IDLE notification doesn't read
      // stale DB rows and re-add the message to the thread list.
      if (thread.folderId > 0) {
        await Promise.all(primaryUids.map((uid) => Promise.all([
          deleteMessage(thread.folderId, uid).catch(() => {}),
          deleteSearchIndexEntry(thread.accountId, folderPath, uid).catch(() => {}),
        ])));
      }
      console.log(`[trashThread] moving primary+samefolder uids=${JSON.stringify(primaryUids)} from "${folderPath}" to "${dest}"`);
      await ipc.imapMoveUids(config, folderPath, dest, primaryUids);
      console.log(`[trashThread] primary move OK`);
      // Best-effort: move all related messages from other folders to Trash.
      void Promise.all(
        [...otherFolders.values()].map(({ path: fp, folderId: fId, uids }) => {
          // Also pre-clean DB for related folders before IMAP move.
          void Promise.all(uids.map((uid) => Promise.all([
            deleteMessage(fId, uid).catch(() => {}),
            deleteSearchIndexEntry(thread.accountId, fp, uid).catch(() => {}),
          ])));
          console.log(`[trashThread] moving related uids=${JSON.stringify(uids)} from "${fp}" to "${dest}"`);
          return ipc.imapMoveUids(config, fp, dest, uids)
            .then(() => { console.log(`[trashThread] related from "${fp}" moved OK`); })
            .catch((err) => { console.error(`[trashThread] related from "${fp}" FAILED:`, err); });
        }),
      );
      toast.success("Moved to Trash");
      // Silently fetch destination so moved attachments get indexed immediately.
      const trashFolder = useAccountsStore.getState().folders.find(
        (f) => f.accountId === thread.accountId && f.path === dest,
      );
      if (trashFolder) {
        void get().fetchFolder(thread.accountId, dest, trashFolder.id, { rulesOnly: true }).catch(() => {});
      }
    } catch (err) {
      restoreThread(set, get, thread);
      if (thread.hasUnread) {
        useAccountsStore.getState().adjustFolderUnread(thread.folderId, +1);
      }
      console.error("trashThread failed:", err);
      toast.error(`Trash failed: ${err}`);
      throw err;
    }
  },

  permanentDeleteThread: async (id) => {
    // If another concurrent call already claimed this thread, bail out.
    if (permanentDeleteInFlight.has(id)) return;
    permanentDeleteInFlight.add(id);
    const claimedIds = new Set<number>([id]);

    const thread = get().threads.find((t) => t.id === id);
    if (!thread) { permanentDeleteInFlight.delete(id); return; }

    const normSubject = normaliseSubject(thread.subject);
    const allFoldersList = useAccountsStore.getState().folders;
    console.log(`[permanentDelete] id=${id} subject="${thread.subject}" norm="${normSubject}"`);

    // Build the full folder map from two sources.
    // Never cascade permanent deletion into inbox-type folders — those
    // contain separate user messages that weren't selected for deletion.
    // Only Trash and Spam folders are eligible for permanent expunge so a
    // visible cross-folder conversation view in Trash doesn't cascade-delete
    // siblings still living in Sent, Archive, or any custom user folder.
    const allowedFolderIds = new Set(
      allFoldersList
        .filter((f) => {
          if (f.accountId !== thread.accountId) return false;
          if (f.specialUse === "trash" || f.specialUse === "spam") return true;
          const leaf = (f.path ?? "").split(/[\/. \\]/).filter(Boolean).pop() ?? "";
          return (
            /^(trash|deleted(\s*items?)?|spam|junk)$/i.test(leaf) ||
            /^(trash|deleted(\s*items?)?|spam|junk)$/i.test(f.name ?? "")
          );
        })
        .map((f) => f.id),
    );
    console.log(`[permanentDelete] allowedFolderIds (Trash/Spam only):`, [...allowedFolderIds].map((fid) => allFoldersList.find((f) => f.id === fid)?.path ?? fid));
    const folderMap = new Map<string, { path: string; folderId: number; uids: number[] }>();
    const addToMap = (fp: string, fId: number, uid: number) => {
      if (uid <= 0) return;
      if (!allowedFolderIds.has(fId)) { console.log(`[permanentDelete] skip uid=${uid} folder="${fp}" — not Trash/Spam`); return; }
      const entry = folderMap.get(fp) ?? { path: fp, folderId: fId, uids: [] };
      if (!entry.uids.includes(uid)) entry.uids.push(uid);
      folderMap.set(fp, entry);
    };

    // Source 1: in-memory threads with the same normalized subject (including primary).
    // Claim all related IDs here (before the first await) so concurrent calls bail out.
    for (const t of get().threads) {
      if (t.accountId !== thread.accountId) continue;
      if (normaliseSubject(t.subject) !== normSubject) continue;
      permanentDeleteInFlight.add(t.id);
      claimedIds.add(t.id);
      const tFolder = allFoldersList.find((f) => f.id === t.folderId);
      if (!tFolder) continue;
      const uids = t.messages.length ? t.messages.map((m) => m.uid) : [t.id];
      console.log(`[permanentDelete] in-memory: folder="${tFolder.path}" uids=${JSON.stringify(uids)}`);
      for (const uid of uids) addToMap(tFolder.path, t.folderId, uid);
    }

    // Source 2: database (synced folders not currently in memory).
    const related = await listConversationMessages(thread.accountId, normSubject).catch((e) => { console.error('[permanentDelete] listConversationMessages error:', e); return []; });
    console.log(`[permanentDelete] DB related (${related.length}):`, related.map((m) => `${m.folder_path}:${m.uid}`));
    // Collect sent_log IDs (uid < 0 → id = -uid) for cleanup; skip real IMAP add.
    const sentLogIds: number[] = [];
    for (const msg of related) {
      if (msg.uid < 0) { sentLogIds.push(-msg.uid); continue; }
      addToMap(msg.folder_path, msg.folder_id, msg.uid);
    }

    // Ensure the primary thread's UIDs are always included even if missing above,
    // but ONLY when the primary folder itself is Trash/Spam. Otherwise the user
    // is invoking permanent delete on a non-trash conversation and we should
    // not bypass the Trash/Spam guard.
    const primaryFolder = allFoldersList.find((f) => f.id === thread.folderId);
    if (primaryFolder && allowedFolderIds.has(primaryFolder.id)) {
      const primaryUids = thread.messages?.length ? thread.messages.map((m) => m.uid) : [thread.id];
      const primaryEntry = folderMap.get(primaryFolder.path) ??
        { path: primaryFolder.path, folderId: thread.folderId, uids: [] };
      for (const uid of primaryUids) {
        if (uid < 0) { if (!sentLogIds.includes(-uid)) sentLogIds.push(-uid); continue; }
        if (!primaryEntry.uids.includes(uid)) primaryEntry.uids.push(uid);
      }
      if (primaryEntry.uids.length > 0) folderMap.set(primaryFolder.path, primaryEntry);
    } else if (primaryFolder && thread.messages?.length) {
      // Primary is not Trash/Spam — only harvest sent_log placeholders for cleanup.
      for (const m of thread.messages) {
        if (m.uid < 0 && !sentLogIds.includes(-m.uid)) sentLogIds.push(-m.uid);
      }
    } else if (thread.messages?.length) {
      // No valid folder — collect any synthetic UIDs for sent_log cleanup.
      for (const m of thread.messages) {
        if (m.uid < 0 && !sentLogIds.includes(-m.uid)) sentLogIds.push(-m.uid);
      }
    }

    // Optimistically remove only the threads that will actually be expunged
    // (those in folderMap). Inbox threads are excluded from folderMap and
    // must NOT be removed from the UI.
    const deletedFolderIds = new Set([...folderMap.values()].map((e) => e.folderId));
    const relatedInMemoryIds = new Set(
      get().threads
        .filter((t) => t.accountId === thread.accountId && deletedFolderIds.has(t.folderId) && normaliseSubject(t.subject) === normSubject)
        .map((t) => t.id),
    );
    const nonPrimaryFolderUids = new Map(
      [...folderMap.values()]
        .filter(({ folderId }) => folderId !== thread.folderId)
        .map(({ folderId, uids }) => [folderId, new Set(uids)]),
    );
    set((state) => ({
      threads: state.threads.filter((t) => {
        if (relatedInMemoryIds.has(t.id)) return false;
        if (t.accountId !== thread.accountId) return true;
        return !nonPrimaryFolderUids.get(t.folderId)?.has(t.id);
      }),
    }));
    if (thread.hasUnread) {
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -1);
    }
    // Delete all from local DB, search index, and sent_log before the IMAP round-trip.
    await Promise.all([
      ...([...folderMap.values()].map(({ path: fp, folderId, uids }) =>
        Promise.all(uids.map((uid) => Promise.all([
          deleteMessage(folderId, uid).catch(() => {}),
          deleteSearchIndexEntry(thread.accountId, fp, uid).catch(() => {}),
        ]))),
      )),
      ...sentLogIds.map((slId) => deleteSentLogEntry(slId).catch(() => {})),
    ]);
    console.log(`[permanentDelete] folderMap:`, [...folderMap.entries()].map(([fp, e]) => `${fp} uids=${JSON.stringify(e.uids)}`));
    if (sentLogIds.length > 0) console.log(`[permanentDelete] deleted sent_log ids:`, sentLogIds);
    if (folderMap.size === 0) {
      if (sentLogIds.length > 0) {
        // Thread was entirely composed of sent_log entries — already cleaned up above.
        console.log(`[permanentDelete] sent_log-only thread — no IMAP expunge needed`);
        toast.success("Deleted");
      } else {
        console.warn(`[permanentDelete] folderMap is EMPTY — nothing to expunge for id=${id} subject="${thread.subject}"`);
        toast.error("Nothing to delete — could not locate messages on server");
      }
      for (const cid of claimedIds) permanentDeleteInFlight.delete(cid);
      return;
    }
    try {
      const { config } = await sessionFor(thread);
      // Expunge each folder's UIDs in parallel.
      await Promise.all(
        [...folderMap.values()].map(({ path: fp, uids }) => {
          console.log(`[permanentDelete] expunging uids=${JSON.stringify(uids)} from "${fp}"`);
          return ipc.imapExpungeUids(config, fp, uids)
            .then(() => console.log(`[permanentDelete] expunge OK for "${fp}"`))
            .catch((err) => { console.error(`[permanentDelete] expunge FAILED for "${fp}":`, err); });
        }),
      );
    } catch (err) {
      restoreThread(set, get, thread);
      if (thread.hasUnread) {
        useAccountsStore.getState().adjustFolderUnread(thread.folderId, +1);
      }
      console.error("permanentDeleteThread failed:", err);
      toast.error(`Delete failed: ${err}`);
      throw err;
    } finally {
      for (const cid of claimedIds) permanentDeleteInFlight.delete(cid);
    }
    // If the now-deleted thread was the one shown in the reading pane, clear
    // the selection so the pane doesn't keep displaying cross-folder
    // conversation siblings cached from before the expunge.
    if (claimedIds.has(useUiStore.getState().selectedThreadId ?? -1)) {
      useUiStore.getState().selectThread(null);
    }
    console.log(`[permanentDelete] DONE id=${id} — expunged ${[...folderMap.values()].reduce((n, e) => n + e.uids.length, 0)} uid(s) across ${folderMap.size} folder(s)`);
  },

  markAsSpam: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    const dest = findFolderPath(thread.accountId, "spam");
    if (!dest) {
      toast.error("No Spam folder found for this account");
      return;
    }
    // Optimistic: remove from list.
    set((state) => ({ threads: state.threads.filter((t) => t.id !== id) }));
    if (thread.hasUnread) {
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -1);
    }
    try {
      const { config, folderPath } = await sessionFor(thread);
      // Keyword contract per IANA: set $Junk, remove $NotJunk, then move.
      // Two calls because imap_set_flags takes a single mode; the extra
      // round-trip isn't noticeable in practice.
      await ipc.imapSetFlags(config, folderPath, thread.id, ["$Junk"], "add");
      await ipc
        .imapSetFlags(config, folderPath, thread.id, ["$NotJunk"], "remove")
        .catch(() => {});
      await ipc.imapMoveUid(config, folderPath, dest, thread.id);
      if (thread.folderId > 0) {
        void deleteMessage(thread.folderId, thread.id).catch(() => {});
        void deleteSearchIndexEntry(thread.accountId, folderPath, thread.id).catch(() => {});
      }
      toast.success("Moved to Spam");
    } catch (err) {
      restoreThread(set, get, thread);
      if (thread.hasUnread) {
        useAccountsStore.getState().adjustFolderUnread(thread.folderId, +1);
      }
      console.error("markAsSpam failed:", err);
      toast.error(`Mark as spam failed: ${err}`);
      throw err;
    }
  },

  markAsNotSpam: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    const dest = findFolderPath(thread.accountId, "inbox") ?? "INBOX";
    // Optimistic: remove from Junk list.
    set((state) => ({ threads: state.threads.filter((t) => t.id !== id) }));
    if (thread.hasUnread) {
      useAccountsStore.getState().adjustFolderUnread(thread.folderId, -1);
    }
    try {
      const { config, folderPath } = await sessionFor(thread);
      // Correction before the move so server-side filters can pick up the
      // $NotJunk signal while the message is still in the Junk folder.
      await ipc.imapSetFlags(config, folderPath, thread.id, ["$NotJunk"], "add");
      await ipc
        .imapSetFlags(config, folderPath, thread.id, ["$Junk"], "remove")
        .catch(() => {});
      await ipc.imapMoveUid(config, folderPath, dest, thread.id);
      if (thread.folderId > 0) {
        void deleteMessage(thread.folderId, thread.id).catch(() => {});
        void deleteSearchIndexEntry(thread.accountId, folderPath, thread.id).catch(() => {});
      }
      toast.success("Moved to Inbox");
    } catch (err) {
      restoreThread(set, get, thread);
      if (thread.hasUnread) {
        useAccountsStore.getState().adjustFolderUnread(thread.folderId, +1);
      }
      console.error("markAsNotSpam failed:", err);
      toast.error(`Mark as not spam failed: ${err}`);
      throw err;
    }
  },

  archiveMany: async (ids) => {
    const idSet = new Set(ids);
    const targets = get().threads.filter((t) => idSet.has(t.id));
    if (targets.length === 0) return;
    set((state) => ({ threads: state.threads.filter((t) => !idSet.has(t.id)) }));
    const perFolder = new Map<number, number>();
    for (const t of targets) {
      if (t.hasUnread)
        perFolder.set(t.folderId, (perFolder.get(t.folderId) ?? 0) + 1);
    }
    const accounts = useAccountsStore.getState();
    for (const [f, n] of perFolder) accounts.adjustFolderUnread(f, -n);

    const failed: Thread[] = [];
    await runBulk(targets, async (thread) => {
      try {
        const dest = findFolderPath(thread.accountId, "archive") ?? "Archive";
        const { config, folderPath } = await sessionFor(thread);
        await ipc.imapMoveUid(config, folderPath, dest, thread.id);
        if (thread.folderId > 0) {
          void deleteMessage(thread.folderId, thread.id).catch(() => {});
          void deleteSearchIndexEntry(thread.accountId, folderPath, thread.id).catch(() => {});
        }
      } catch (err) {
        failed.push(thread);
        console.error("archiveMany: thread failed:", err);
      }
    });
    if (failed.length > 0) {
      restoreThreads(set, get, failed);
      const failedPer = new Map<number, number>();
      for (const t of failed) {
        if (t.hasUnread)
          failedPer.set(t.folderId, (failedPer.get(t.folderId) ?? 0) + 1);
      }
      for (const [f, n] of failedPer) accounts.adjustFolderUnread(f, +n);
      toast.error(`Archive failed for ${failed.length} of ${targets.length}`);
    } else {
      toast.success(
        targets.length === 1 ? "Archived" : `Archived ${targets.length} conversations`,
      );
    }
  },

  trashMany: async (ids) => {
    const idSet = new Set(ids);
    const targets = get().threads.filter((t) => idSet.has(t.id));
    if (targets.length === 0) return;
    set((state) => ({ threads: state.threads.filter((t) => !idSet.has(t.id)) }));
    const perFolder = new Map<number, number>();
    for (const t of targets) {
      if (t.hasUnread)
        perFolder.set(t.folderId, (perFolder.get(t.folderId) ?? 0) + 1);
    }
    const accounts = useAccountsStore.getState();
    for (const [f, n] of perFolder) accounts.adjustFolderUnread(f, -n);

    const failed: Thread[] = [];
    await runBulk(targets, async (thread) => {
      try {
        const dest = findFolderPath(thread.accountId, "trash") ?? "Trash";
        const { config, folderPath } = await sessionFor(thread);
        await ipc.imapMoveUid(config, folderPath, dest, thread.id);
        if (thread.folderId > 0) {
          void deleteMessage(thread.folderId, thread.id).catch(() => {});
          void deleteSearchIndexEntry(thread.accountId, folderPath, thread.id).catch(() => {});
        }
      } catch (err) {
        failed.push(thread);
        console.error("trashMany: thread failed:", err);
      }
    });
    if (failed.length > 0) {
      restoreThreads(set, get, failed);
      const failedPer = new Map<number, number>();
      for (const t of failed) {
        if (t.hasUnread)
          failedPer.set(t.folderId, (failedPer.get(t.folderId) ?? 0) + 1);
      }
      for (const [f, n] of failedPer) accounts.adjustFolderUnread(f, +n);
      toast.error(`Trash failed for ${failed.length} of ${targets.length}`);
    } else {
      toast.success(
        targets.length === 1
          ? "Moved to Trash"
          : `Moved ${targets.length} conversations to Trash`,
      );
    }
  },

  markManyRead: async (ids) => {
    const idSet = new Set(ids);
    const targets = get().threads.filter((t) => idSet.has(t.id) && t.hasUnread);
    if (targets.length === 0) return;
    // Optimistic local update — thread flags + sidebar badge totals.
    set((state) => ({
      threads: state.threads.map((t) =>
        idSet.has(t.id) ? { ...t, hasUnread: false } : t,
      ),
    }));
    const perFolder = new Map<number, number>();
    for (const t of targets) {
      perFolder.set(t.folderId, (perFolder.get(t.folderId) ?? 0) + 1);
    }
    const accounts = useAccountsStore.getState();
    for (const [folderId, n] of perFolder) accounts.adjustFolderUnread(folderId, -n);

    const failed: Thread[] = [];
    await runBulk(targets, async (thread) => {
      try {
        const { config, folderPath } = await sessionFor(thread);
        await ipc.imapSetFlags(config, folderPath, thread.id, ["\\Seen"], "add");
        if (thread.folderId > 0) {
          void updateMessageFlags(thread.folderId, thread.id, { isUnread: false }).catch(() => {});
        }
      } catch (err) {
        failed.push(thread);
        console.error("markManyRead: thread failed:", err);
      }
    });
    if (failed.length > 0) {
      const failedIds = new Set(failed.map((t) => t.id));
      set((state) => ({
        threads: state.threads.map((t) =>
          failedIds.has(t.id) ? { ...t, hasUnread: true } : t,
        ),
      }));
      // Restore the failed ones in the sidebar badge too.
      const failedPerFolder = new Map<number, number>();
      for (const t of failed) {
        failedPerFolder.set(
          t.folderId,
          (failedPerFolder.get(t.folderId) ?? 0) + 1,
        );
      }
      for (const [folderId, n] of failedPerFolder) {
        accounts.adjustFolderUnread(folderId, +n);
      }
      toast.error(`Mark read failed for ${failed.length} of ${targets.length}`);
    } else {
      toast.success(
        targets.length === 1
          ? "Marked as read"
          : `Marked ${targets.length} as read`,
      );
    }
  },

  toggleStarMany: async (ids) => {
    const idSet = new Set(ids);
    // Filter out any threads already being toggled individually.
    const targets = get().threads.filter((t) => idSet.has(t.id) && !starToggleInFlight.has(t.id));
    if (targets.length === 0) return;
    // Mark all targets as in-flight to prevent concurrent individual toggles.
    for (const t of targets) starToggleInFlight.add(t.id);
    // If any are unstarred, star them all; otherwise unstar all. Matches
    // Gmail/Spark behaviour for the bulk "toggle" action.
    const anyUnstarred = targets.some((t) => !t.isPinned);
    const nextPinned = anyUnstarred;
    set((state) => ({
      threads: state.threads.map((t) =>
        idSet.has(t.id) ? { ...t, isPinned: nextPinned } : t,
      ),
    }));

    // Pre-compute per-thread UID lists and register ALL in-flight keys upfront
    // before runBulk starts. runBulk is concurrent (up to 3 at once), so the
    // IDLE push from thread 1 completing can race the workers for threads 2+
    // if we only add keys inside each individual worker.
    const threadMeta = targets.map((thread) => {
      const allUids = thread.messages.length > 0
        ? thread.messages.map((m) => m.uid).filter((u) => u > 0)
        : [thread.id];
      const uidsToFlag = nextPinned
        ? allUids
        : allUids.filter((u) => {
            const msg = thread.messages.find((m) => m.uid === u);
            return msg ? msg.flags.includes("Flagged") : u === thread.id;
          });
      if (uidsToFlag.length === 0) uidsToFlag.push(thread.id);
      return { thread, allUids, uidsToFlag };
    });

    // Register all in-flight keys before any IMAP call fires.
    const allInFlightKeys: string[] = [];
    for (const { thread, allUids } of threadMeta) {
      if (thread.folderId > 0) {
        for (const uid of allUids) {
          const key = `${thread.folderId}:${uid}`;
          starInFlight.set(key, nextPinned);
          allInFlightKeys.push(key);
        }
      }
    }

    try {
      await runBulk(threadMeta, async ({ thread, allUids, uidsToFlag }) => {
        const { config, folderPath } = await sessionFor(thread);
        await ipc.imapSetFlagsMulti(
          config,
          folderPath,
          uidsToFlag,
          ["\\Flagged"],
          nextPinned ? "add" : "remove",
        );
        if (thread.folderId > 0) {
          // Wait for DB writes to land before this worker resolves.
          await Promise.all(
            allUids.map((uid) =>
              updateMessageFlags(thread.folderId, uid, { isStarred: nextPinned }).catch(() => {}),
            ),
          );
        }
      });
    } finally {
      // Clear starToggleInFlight immediately so the user can click again,
      // but delay starInFlight removal to cover slow DB write latency.
      for (const t of targets) starToggleInFlight.delete(t.id);
      setTimeout(() => {
        for (const key of allInFlightKeys) starInFlight.delete(key);
      }, 5000);
    }
  },
}));

function restoreThread(_set: unknown, _get: unknown, thread: Thread): void {
  useThreadsStore.setState((state) => {
    if (state.threads.some((t) => t.id === thread.id)) return {};
    return {
      threads: [...state.threads, thread].sort(
        (a, b) => b.lastMessageAt - a.lastMessageAt,
      ),
    };
  });
}

function restoreThreads(_set: unknown, _get: unknown, threads: Thread[]): void {
  useThreadsStore.setState((state) => {
    const existing = new Set(state.threads.map((t) => t.id));
    const missing = threads.filter((t) => !existing.has(t.id));
    if (missing.length === 0) return {};
    return {
      threads: [...state.threads, ...missing].sort(
        (a, b) => b.lastMessageAt - a.lastMessageAt,
      ),
    };
  });
}

async function runBulk<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  const limit = 3;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (err) {
        console.error("bulk worker failed:", err);
      }
    }
  });
  await Promise.all(runners);
}

/**
 * Searches a single IMAP folder by subject and persists matching summaries to
 * the local DB, WITHOUT updating the thread store's UI state.
 *
 * Uses IMAP SEARCH SUBJECT so it finds messages regardless of how old they
 * are — unlike fetch_messages which is capped to the N most-recent. Used to
 * ensure cross-folder conversation views (e.g. Archive + Sent) are complete.
 * Safe to call in the background — errors are silently swallowed.
 */
export async function syncFolderToDb(
  accountId: number,
  folderPath: string,
  folderId: number,
  subject: string,
): Promise<void> {
  try {
    const account = await getAccount(accountId);
    if (!account) return;
    const secrets = await getAccountSecrets(accountId);
    const config = imapConfigFor(account, secrets.imapPassword);
    const summaries = await ipc.imapSearchBySubject(config, folderPath, subject);
    // Await all upserts before returning so the caller can immediately re-query
    // the DB and see the newly persisted rows.
    await Promise.all(
      summaries.map((s) =>
        upsertMessageSummary({
          accountId,
          folderId,
          imapUid: s.uid,
          messageIdHeader: s.messageId || null,
          inReplyTo: s.inReplyTo || null,
          referencesHeader: (s.references ?? []).length > 0 ? (s.references ?? []).join(" ") : null,
          fromAddress: s.from,
          toAddresses: s.to.join(", "),
          ccAddresses: s.cc && s.cc.length > 0 ? s.cc.join(", ") : null,
          bccAddresses: s.bcc && s.bcc.length > 0 ? s.bcc.join(", ") : null,
          subject: s.subject,
          snippet: s.snippet,
          receivedAt: s.date,
          flags: s.flags,
          isUnread: !s.flags.includes("Seen"),
          isStarred: starInFlight.has(`${folderId}:${s.uid}`)
            ? undefined
            : s.flags.includes("Flagged"),
          isImportant: false,
          hasAttachments: s.hasAttachments,
          isBulk: s.isBulk,
          isAuto: s.isAuto,
        }).catch(() => {}),
      ),
    );
  } catch {
    // Best-effort — do not propagate
  }
}

function imapConfigFor(account: StoredAccount, password: string): ImapConfig {
  return {
    host: account.imap_host,
    port: account.imap_port,
    username: account.imap_username ?? account.email,
    password,
    security: account.imap_security,
  };
}

async function sessionFor(thread: Thread): Promise<{
  config: ImapConfig;
  folderPath: string;
}> {
  const account = await getAccount(thread.accountId);
  if (!account) throw new Error(`account ${thread.accountId} not found`);
  const secrets = await getAccountSecrets(thread.accountId);
  const folder = useAccountsStore
    .getState()
    .folders.find((f) => f.id === thread.folderId);
  if (!folder) throw new Error(`folder ${thread.folderId} not found`);
  return {
    config: imapConfigFor(account, secrets.imapPassword),
    folderPath: folder.path,
  };
}

// Automated local-parts found in `user@domain`. Case-insensitive, matches
// the common conventions (noreply, notifications, alerts, automated, etc.).
const AUTO_LOCAL_PART =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|notifications?|alerts?|automated?|auto|system|support|updates?|mailer|postmaster|bounces?|news)$/i;

function extractEmailAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim();
}

function inferCategoryFromFlags(
  isBulk: boolean,
  isAuto: boolean,
  fromHeader: string,
): MailCategory | null {
  if (isBulk) return "newsletters";
  if (isAuto) return "notifications";
  const addr = extractEmailAddress(fromHeader);
  const local = addr.split("@")[0] ?? "";
  if (local && AUTO_LOCAL_PART.test(local)) return "notifications";
  return "people";
}

function findFolderPath(
  accountId: number,
  specialUse: "archive" | "trash" | "sent" | "drafts" | "inbox" | "spam",
): string | null {
  const folders = useAccountsStore.getState().folders;
  const match = folders.find(
    (f) => f.accountId === accountId && f.specialUse === specialUse,
  );
  return match?.path ?? null;
}

function displayPathName(path: string): string {
  // Take leaf after `/` or `.` separator. Fallback to full path.
  const parts = path.split(/[\/.]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}
