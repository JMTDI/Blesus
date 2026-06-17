import { useEffect, useRef, useState } from "react";
import {
  Reply,
  ReplyAll,
  Forward,
  Archive,
  Trash2,
  Star,
  Clock,
  MoreHorizontal,
  Inbox as InboxIcon,
  Loader2,
  AlertCircle,
  Paperclip,
  Download,
  Play,
  Pause,
  Eye,
  Images,
  Ban,
  ShieldCheck,
  BellOff,
  ChevronLeft,
  ChevronDown,
  ArrowRightLeft,
  Unlink,
  Search as SearchIcon,
  MailPlus,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { tempDir } from "@tauri-apps/api/path";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { cn } from "@/lib/cn";
import { useAccountsStore } from "@/stores/accounts";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useBodiesStore } from "@/stores/bodies";
import { useComposerStore } from "@/stores/composer";
import { Avatar } from "@/components/mail/Avatar";
import { HtmlViewer } from "@/components/mail/HtmlViewer";
import { addressName, formatDateStack } from "@/lib/time";
import { deleteSearchIndexEntry, getAccount, getAccountSecrets, listConversationMessages, normalizeSubject, type ConversationMessage } from "@/lib/db";
import { ipc, type Attachment, type OutgoingAttachment, type UnsubscribeInfo } from "@/lib/ipc";
import { toast } from "@/stores/toasts";
import { SNOOZE_PRESETS } from "@/lib/snooze";
import { syncFolderToDb } from "@/stores/threads";
import { useMediaPlayerStore } from "@/stores/mediaPlayer";
import { useAttachmentPreviewStore } from "@/stores/attachmentPreview";
import { useImageGalleryStore } from "@/stores/imageGallery";
import { renderWithFlags } from "@/lib/flagEmoji";
import { loadAttachmentB64, prefetchAttachments } from "@/lib/attachmentCache";
import type { Thread } from "@/types";

/** Strips Re:/Fwd:/etc. prefixes to get the base subject for DB lookup.
 * Re-exported from db.ts — kept here for call sites that don't import db directly. */
// normalizeSubject is imported from @/lib/db above.

/**
 * Fetches all remote HTTPS images in an HTML string via Tauri's Rust HTTP
 * client and replaces their `src` with base64 `data:` URIs so the HTML is
 * self-contained.  Images that fail to fetch (network error, non-image
 * content-type, or >2 MB) keep their original src.
 */
async function embedRemoteImages(html: string): Promise<string> {
  if (!html || html === "<p></p>") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = Array.from(doc.querySelectorAll("img[src]")).filter((img) =>
    /^https?:/i.test(img.getAttribute("src") ?? ""),
  );
  if (imgs.length === 0) return html;

  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      try {
        const resp = await Promise.race([
          tauriFetch(src),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 10_000),
          ),
        ]);
        if (!resp.ok) return;
        const ct = ((resp.headers.get("content-type") ?? "image/jpeg").split(";")[0] ?? "image/jpeg").trim();
        if (!ct.startsWith("image/")) return;
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength > 2 * 1024 * 1024) return; // skip > 2 MB
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i] ?? 0);
        img.setAttribute("src", `data:${ct};base64,${btoa(binary)}`);
      } catch {
        // Keep original src on any error — better than removing the image
      }
    }),
  );

  return doc.body.innerHTML.trim() || html;
}

// ── Subject exclusions ────────────────────────────────────────────────────────
// The new exact-match threading largely makes this unnecessary, but kept for
// any legacy stored exclusion keys.
const EXCLUSIONS_KEY = "cursus:subjectExclusions";
type ExclusionMap = Record<string, string[]>;

function loadExclusions(): ExclusionMap {
  try {
    const raw = localStorage.getItem(EXCLUSIONS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ExclusionMap;
  } catch { return {}; }
}

function saveExclusion(accountId: number, threadNorm: string, excludedNorm: string): void {
  const map = loadExclusions();
  const key = `${accountId}:${threadNorm}`;
  const existing = map[key] ?? [];
  if (!existing.includes(excludedNorm)) {
    map[key] = [...existing, excludedNorm];
    try { localStorage.setItem(EXCLUSIONS_KEY, JSON.stringify(map)); } catch { /* quota */ }
  }
}

function getExclusionsForThread(accountId: number, threadNorm: string): string[] {
  return loadExclusions()[`${accountId}:${threadNorm}`] ?? [];
}

/** A single displayable message — carries its own folderPath for body fetching. */
interface ConvMsg {
  uid: number;
  folderPath: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: number; // unix seconds
  snippet: string;
  flags: string[];
  hasAttachments: boolean;
  subject: string;
  /** Set for locally-stored sent_log entries (uid < 0) — body is pre-seeded. */
  htmlBody?: string | null;
  textBody?: string | null;
}

function convFromRow(r: ConversationMessage): ConvMsg {
  let flags: string[] = [];
  try { flags = r.flags ? JSON.parse(r.flags) as string[] : []; } catch { /* */ }
  return {
    uid: r.uid,
    folderPath: r.folder_path,
    from: r.from_address ?? "Unknown",
    to: r.to_addresses ?? "",
    cc: r.cc_addresses ?? "",
    bcc: r.bcc_addresses ?? "",
    date: r.received_at ?? 0,
    snippet: r.snippet ?? "",
    flags,
    hasAttachments: r.has_attachments === 1,
    subject: r.subject ?? "",
    htmlBody: r.html_body,
    textBody: r.text_body,
  };
}

export function MessageView({ fullHeight = false }: { fullHeight?: boolean } = {}) {
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const threads = useThreadsStore((s) => s.threads);
  const starredThreads = useThreadsStore((s) => s.starredThreads);
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const accounts = useAccountsStore((s) => s.accounts);
  const activeFolderId = useAccountsStore((s) => s.activeFolderId);
  const folders = useAccountsStore((s) => s.folders);
  const toggleStar = useThreadsStore((s) => s.toggleStar);
  const archiveThread = useThreadsStore((s) => s.archiveThread);
  const trashMessage = useThreadsStore((s) => s.trashMessage);
  const trashMessages = useThreadsStore((s) => s.trashMessages);
  const markAsSpam = useThreadsStore((s) => s.markAsSpam);
  const markAsNotSpam = useThreadsStore((s) => s.markAsNotSpam);
  const moveSubjectBetweenGroups = useThreadsStore((s) => s.moveSubjectBetweenGroups);
  const mergeGroups = useThreadsStore((s) => s.mergeGroups);
  const markStandalone = useThreadsStore((s) => s.markStandalone);
  const selectThread = useUiStore((s) => s.selectThread);

  // Look up in current-folder threads first, then fall back to the starred virtual list.
  const realThread = threads.find((t) => t.id === selectedThreadId)
    ?? starredThreads.find((t) => t.id === selectedThreadId);
  const activeFolder = folders.find((f) => f.id === activeFolderId);

  const [convMessages, setConvMessages] = useState<ConvMsg[]>([]);

  // When a user deletes the only Zustand-tracked message of a conversation,
  // the underlying thread is removed by the next fetchFolder rebuild even
  // though the cross-folder conversation view still has surviving messages
  // (e.g. older INBOX messages of the same subject paged below the current
  // thread list page). Without a fallback the reading pane would blank out
  // and the user perceives the entire conversation as gone. Cache the most
  // recent valid thread so the pane keeps rendering as long as convMessages
  // still has at least one survivor in the active folder.
  const lastValidThreadRef = useRef<Thread | null>(null);
  if (realThread) lastValidThreadRef.current = realThread;
  const cmHasActiveFolderSurvivor =
    convMessages.length > 0 &&
    convMessages.some((m) => !activeFolder || m.folderPath === activeFolder.path);
  const thread: Thread | undefined =
    realThread ?? (cmHasActiveFolderSurvivor ? lastValidThreadRef.current ?? undefined : undefined);

  // The thread may come from a different account/folder than the sidebar selection.
  const threadAccountId: number | null = thread ? thread.accountId : activeAccountId;
  const threadFolder = folders.find((f) => f.id === thread?.folderId);
  const activeAccount = accounts.find((a) => a.id === threadAccountId);
  // Use a compound "folderPath:uid" key so two messages that share the same
  // IMAP uid in different folders (e.g. uid=5 in INBOX and uid=5 in Sent)
  // can each be independently expanded or collapsed.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Live ref so the re-anchor effect can read convMessages without stale closures.
  const convMessagesRef = useRef<ConvMsg[]>(convMessages);
  convMessagesRef.current = convMessages;

  // When set to true, the next run of the convMessages-loading effect skips
  // the initial clear so the reading pane doesn't flash empty during re-anchor.
  const skipClearConvRef = useRef(false);

  function msgKey(msg: ConvMsg) { return `${msg.folderPath}:${msg.uid}`; }

  function handleDeleteMessage(msg: ConvMsg) {
    setConvMessages((prev) => {
      // Filter by the compound key so only the exact message is removed,
      // not every message sharing the same uid in a different folder.
      const next = prev.filter((m) => !(m.uid === msg.uid && m.folderPath === msg.folderPath));
      if (next.length === 0) selectThread(null);
      else if (expandedKey === msgKey(msg)) {
        const last = next[next.length - 1];
        if (last) setExpandedKey(msgKey(last));
      }
      return next;
    });
    void trashMessage(threadAccountId!, msg.folderPath, msg.uid).catch(() => {});
  }

  // When the selection is explicitly cleared (e.g. emptyTrash /
  // permanentDeleteThread), tear down the fallback state so the reading pane
  // actually goes blank. Without this, lastValidThreadRef keeps the previous
  // thread alive and convMessages still contains the just-expunged Trash
  // entries — which match the active folder path and re-trigger the
  // cmHasActiveFolderSurvivor fallback, leaving stale messages on screen.
  useEffect(() => {
    if (selectedThreadId == null) {
      lastValidThreadRef.current = null;
      setConvMessages([]);
      setExpandedKey(null);
    }
  }, [selectedThreadId]);

  // Re-anchor effect: when fetchFolder rebuilds the thread list after a delete,
  // the selected thread's ID may change (or the thread may disappear entirely
  // if it was a single-message thread). If convMessages still has items, find
  // the nearest surviving sibling thread and re-select it so the reading pane
  // stays open instead of going blank.
  useEffect(() => {
    if (selectedThreadId == null) return; // nothing selected
    if (thread != null) return;           // thread still valid — no action needed
    const cm = convMessagesRef.current;
    if (cm.length === 0) return;          // nothing left to anchor to
    const accountsState = useAccountsStore.getState();
    const currentActiveFolderId = accountsState.activeFolderId;
    const currentActiveFolder = accountsState.folders.find((f) => f.id === currentActiveFolderId);
    const activeFolderPath = currentActiveFolder?.path;
    // Only match against messages that belong to the active folder.
    // listConversationMessages returns cross-folder results (Sent, Trash, etc.)
    // and a Trash message uid could accidentally equal an INBOX thread id,
    // causing selectThread to jump to a Trash thread.
    const activeCm = activeFolderPath
      ? cm.filter((m) => m.folderPath === activeFolderPath)
      : cm;
    if (activeCm.length === 0) return;
    const allThreads = useThreadsStore.getState().threads;
    console.log(
      `[re-anchor] activeFolderPath=${activeFolderPath} activeCm=${activeCm.map((m) => m.uid).join(',')} threadIds=${allThreads.map((t) => t.id).join(',')}`,
    );
    // Only anchor to threads that belong to the active folder so we never
    // accidentally land on a Trash / Sent thread.
    const anchor = allThreads.find(
      (t) =>
        t.folderId === currentActiveFolderId &&
        (activeCm.some((m) => m.uid === t.id) ||
          t.messages?.some((tm) => activeCm.some((cm2) => cm2.uid === tm.uid))),
    );
    console.log(`[re-anchor] anchor=${anchor?.id} folderId=${anchor?.folderId}`);
    if (anchor) {
      skipClearConvRef.current = true; // preserve current convMessages through re-anchor
      selectThread(anchor.id);
    }
  }, [selectedThreadId, thread, selectThread]);

  useEffect(() => {
    const reanchoring = skipClearConvRef.current;
    if (!reanchoring) {
      setConvMessages([]);
      setExpandedKey(null);
    }
    if (!thread || !threadAccountId) return;
    // Only consume the flag once we actually proceed with a load so it
    // survives the render where thread=null (early-return path) and remains
    // available for the next render where thread=anchor.
    skipClearConvRef.current = false;
    const base = normalizeSubject(thread.subject);
    if (!base) return;
    let cancelled = false;
    // Capture the effective account for this load so closures stay consistent.
    const effectAccountId = thread.accountId;

    // All subjects belonging to this thread (primary + any that were merged in)
    const mergeGroups = useThreadsStore.getState().mergeGroups;
    const threadNorm = normalizeSubject(thread.subject);
    const myGroup = mergeGroups.find((g) => g.includes(threadNorm));
    const extraBases = myGroup ? myGroup.filter((s) => s !== threadNorm) : [];

    /** Query every relevant subject in parallel and dedup by uid. */
    async function queryAll(): Promise<ConversationMessage[]> {
      const results = await Promise.all([
        listConversationMessages(effectAccountId, base, 300, thread!.id),
        ...extraBases.map((s) => listConversationMessages(effectAccountId, s, 300)),
      ]);
      // Dedup by (uid, folder_id) — IMAP UIDs are per-folder so the same uid
      // can legitimately appear in both Inbox and Sent with different content.
      const seen = new Set<string>();
      const merged: ConversationMessage[] = [];
      for (const rows of results) {
        for (const row of rows) {
          const key = `${row.uid}:${row.folder_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(row);
          }
        }
      }
      // Filter out subjects the user has explicitly excluded from this thread.
      const excluded = getExclusionsForThread(effectAccountId, threadNorm);
      const filtered = excluded.length === 0 ? merged : merged.filter((row) => {
        const rNorm = normalizeSubject(row.subject ?? "");
        return !excluded.some((ex) => rNorm === ex || rNorm.includes(ex));
      });
      return filtered.sort((a, b) => (a.received_at ?? 0) - (b.received_at ?? 0));
    }

    function applyRows(rows: ConversationMessage[]) {
      const msgs = rows.map(convFromRow);
      const { seedBody } = useBodiesStore.getState();
      for (const msg of msgs) {
        if (msg.uid < 0) {
          seedBody(msg.folderPath, msg.uid, msg.htmlBody ?? null, msg.textBody ?? null);
        }
      }
      setConvMessages(msgs);
      setExpandedKey((prev) => {
        if (prev) return prev;
        const last = msgs[msgs.length - 1];
        return last ? msgKey(last) : null;
      });
      // Write the cross-folder count into the separate convCounts map so the
      // list badge stays correct even when fetchFolder rebuilds threads.
      if (msgs.length > 0 && thread) {
        const key = `${thread.accountId}:${normalizeSubject(thread.subject)}`;
        useThreadsStore.getState().setConvCounts({ [key]: msgs.length });
      }
    }

    // Phase 1: populate immediately from what's already in the local DB.
    queryAll()
      .then((rows) => { if (!cancelled) applyRows(rows); })
      .catch(() => { if (!cancelled) setConvMessages([]); });

    // Phase 2: ensure the Sent folder is indexed locally so cross-folder
    // conversations include outgoing messages. After syncing, re-query the
    // DB so newly indexed Sent messages appear in the conversation.
    const sentFolder = useAccountsStore
      .getState()
      .folders.find(
        (f) => f.accountId === effectAccountId && f.specialUse === "sent",
      );
    if (sentFolder && sentFolder.id > 0) {
      syncFolderToDb(effectAccountId, sentFolder.path, sentFolder.id, base)
        .then(() => queryAll())
        .then((rows) => { if (!cancelled) applyRows(rows); })
        .catch(() => {});
    }

    return () => { cancelled = true; };
  }, [thread?.id, thread?.messageCount, thread?.accountId, activeAccountId]);

  if (!thread) {
    return <EmptyReadingPane />;
  }

  // Use cross-folder results if available; fall back to thread.messages; final
  // fallback is a single synthetic entry from the thread's own metadata.
  // thread.messages is stored newest-first (see threadFromGroup) so we
  // reverse it here to match the rest of the app (oldest at top, newest at
  // bottom) — the same order convMessages is sorted in.
  const messages: ConvMsg[] =
    convMessages.length > 0
      ? convMessages
      : (thread.messages ?? []).length > 0
        ? [...thread.messages]
            .sort((a, b) => (a.date ?? 0) - (b.date ?? 0))
            .map((m) => ({
            uid: m.uid,
            folderPath: threadFolder?.path ?? activeFolder?.path ?? "",
            from: m.from,
            to: "",
            cc: "",
            bcc: "",
            date: m.date,
            snippet: m.snippet,
            flags: m.flags,
            hasAttachments: m.hasAttachments,
            subject: thread.subject,
          }))
        : [
            {
              uid: thread.id,
              folderPath: threadFolder?.path ?? activeFolder?.path ?? "",
              from: thread.participants[0] ?? "Unknown",
              to: "",
              cc: "",
              bcc: "",
              date: Math.floor(thread.lastMessageAt / 1000),
              snippet: thread.snippet,
              flags: thread.hasUnread ? [] : ["Seen"],
              hasAttachments: thread.hasAttachments,
              subject: thread.subject,
            },
          ];

  // Determine if this message is already in a merge group (used for toast wording only)
  const threadNorm = normalizeSubject(thread.subject);
  void threadNorm; // referenced in queryAll inside the effect

  return (
    <section
      className={cn("relative flex flex-col bg-raised border-r border-soft overflow-hidden", fullHeight && "h-full border-r-0")}
      aria-label="Thread messages"
    >
      {/* Thread header — always visible, never grows */}
      <header className="flex items-center gap-3 pl-7 pr-4 pt-3 pb-2 shrink-0 border-b border-soft">
        <button
          type="button"
          onClick={() => selectThread(null)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary transition-colors shrink-0"
          title="Back to list"
        >
          <ChevronLeft size={15} />
        </button>

        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-muted tabular-nums shrink-0">
            {messages.length}
          </span>
          <h1 className="text-[15px] font-semibold text-primary truncate leading-snug">
            {renderWithFlags(thread.subject)}
          </h1>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <ActionButton label={thread.isPinned ? "Unstar" : "Star"} active={thread.isPinned} onClick={() => void toggleStar(thread.id)}>
            <Star size={14} fill={thread.isPinned ? "currentColor" : "none"} />
          </ActionButton>
          <SnoozeMenu thread={thread} />
          <ActionButton label="Archive" onClick={() => { selectThread(null); void archiveThread(thread.id); }}>
            <Archive size={14} />
          </ActionButton>
          <ActionButton
            label={
              activeFolder?.specialUse === "trash" ||
              /^(trash|deleted(\s*items?)?)$/i.test(activeFolder?.name ?? "") ||
              /^(trash|deleted(\s*items?)?)$/i.test((activeFolder?.path ?? "").split(/[\/. \\]/).filter(Boolean).pop() ?? "")
                ? "Delete permanently"
                : "Trash"
            }
            onClick={() => {
              // Delete ALL messages currently shown in the reading pane.
              // trashMessages handles both trash (expunge) and non-trash (move) per folder.
              const msgsToDelete = messages.map((m) => ({ folderPath: m.folderPath, uid: m.uid }));
              setConvMessages([]);
              selectThread(null);
              void trashMessages(threadAccountId!, msgsToDelete).catch(() => {});
            }}
          >
            <Trash2 size={14} />
          </ActionButton>
          {(threadFolder ?? activeFolder)?.specialUse === "spam" ? (
            <ActionButton label="Not spam" onClick={() => { selectThread(null); void markAsNotSpam(thread.id); }}>
              <ShieldCheck size={14} />
            </ActionButton>
          ) : (
            <ActionButton label="Mark as spam" onClick={() => { selectThread(null); void markAsSpam(thread.id); }}>
              <Ban size={14} />
            </ActionButton>
          )}
          <ActionButton label="More"><MoreHorizontal size={14} /></ActionButton>
        </div>
      </header>

      {/* All messages in a single scrollable column — collapsed rows above, expanded inline */}
      <div className="flex-1 overflow-y-auto">
        {messages.map((msg) =>
          msgKey(msg) === expandedKey ? (
            <InlineExpandedMessage
              key={`${msg.folderPath}:${msg.uid}`}
              message={msg}
              thread={thread}
              activeAccountId={threadAccountId}
              activeAccount={activeAccount ?? null}
              allMessages={messages}
              onDelete={() => handleDeleteMessage(msg)}
              onArchive={() => { selectThread(null); void archiveThread(thread.id); }}
              onMoveToThread={(targetId) => {
                const msgNorm = normalizeSubject(msg.subject);
                const threadNorm = normalizeSubject(thread.subject);
                const myGroup = mergeGroups.find((g) => g.includes(threadNorm));
                const canonicalEntry =
                  myGroup?.find((s) => s === msgNorm) ??
                  myGroup?.find((s) => msgNorm.includes(s) && s !== threadNorm) ??
                  msgNorm;
                // No-op: can't split the only message in a single-message thread.
                if (targetId === null && messages.length <= 1) return;
                if (myGroup) {
                  moveSubjectBetweenGroups(canonicalEntry, targetId);
                } else if (targetId === null) {
                  // Message-ID family false-positive or same-subject sibling:
                  // exclude from pane AND break out as its own thread.
                  saveExclusion(threadAccountId!, threadNorm, msgNorm);
                  markStandalone(threadAccountId!, {
                    uid: msg.uid,
                    subject: msg.subject,
                    from: msg.from,
                    date: msg.date,
                    snippet: msg.snippet,
                    hasAttachments: msg.hasAttachments,
                    flags: msg.flags,
                    folderId: thread.folderId,
                  });
                } else {
                  moveSubjectBetweenGroups(canonicalEntry, targetId);
                }
                setConvMessages((prev) =>
                  prev.filter((m) => !(m.uid === msg.uid && m.folderPath === msg.folderPath)),
                );
                toast.success(targetId === null ? "Split into standalone thread" : "Moved to selected thread");
              }}
            />
          ) : (
            <CollapsedMessageRow
              key={`${msg.folderPath}:${msg.uid}`}
              message={msg}
              onClick={() => setExpandedKey(msgKey(msg))}
              onDelete={() => handleDeleteMessage(msg)}
              onArchive={() => { selectThread(null); void archiveThread(thread.id); }}
              accountId={threadAccountId}
            />
          )
        )}
      </div>
    </section>
  );
}

/**
 * Small pill showing which folder a conversation message lives in.
 * Helps distinguish e.g. "this bubble is in Sent" vs. "in Trash" vs.
 * "in INBOX" when the reading pane shows cross-folder results.
 */
function FolderBadge({ folderPath }: { accountId?: number | null; folderPath: string }) {
  const folders = useAccountsStore((s) => s.folders);
  if (!folderPath) return null;
  const folder = folders.find((f) => f.path === folderPath);
  // Prefer the user-visible folder name; fall back to the trailing path leaf.
  const leaf = folderPath.split(/[\/. \\]/).filter(Boolean).pop() ?? folderPath;
  const label = folder?.name || leaf;
  // Map a few well-known special-use folders to tinted styles; everything
  // else (including custom user folders) gets the neutral muted style.
  let palette = "border-[var(--border-strong)] text-muted bg-[var(--bg-base)]";
  switch (folder?.specialUse) {
    case "inbox":
      palette = "border-blue-500/40 text-blue-600 bg-blue-500/10 dark:text-blue-300";
      break;
    case "sent":
      palette = "border-emerald-500/40 text-emerald-600 bg-emerald-500/10 dark:text-emerald-300";
      break;
    case "trash":
      palette = "border-rose-500/40 text-rose-600 bg-rose-500/10 dark:text-rose-300";
      break;
    case "spam":
      palette = "border-amber-500/40 text-amber-600 bg-amber-500/10 dark:text-amber-300";
      break;
    case "drafts":
      palette = "border-violet-500/40 text-violet-600 bg-violet-500/10 dark:text-violet-300";
      break;
    case "archive":
      palette = "border-slate-500/40 text-slate-600 bg-slate-500/10 dark:text-slate-300";
      break;
  }
  return (
    <span
      title={`In folder: ${label}`}
      className={cn(
        "inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium border shrink-0 leading-tight",
        palette,
      )}
    >
      {label}
    </span>
  );
}

/** Compact single-line row for non-expanded messages in the thread. */
function CollapsedMessageRow({
  message,
  onClick,
  onDelete,
  onArchive,
  accountId,
}: {
  message: ConvMsg;
  onClick: () => void;
  onDelete: () => void;
  onArchive: () => void;
  accountId: number | null;
}) {
  const senderName = addressName(message.from) || message.from;
  const unread = !message.flags.includes("Seen");
  const { primary: dateMain } = formatDateStack(message.date * 1000);

  return (
    <div
      className={cn(
        "relative w-full flex items-center gap-3 px-4 h-[52px] border-b text-left transition-colors group",
        unread ? "bg-accent-soft hover:bg-hover" : "hover:bg-hover",
      )}
      style={{ borderColor: "var(--border-strong)" }}
    >
      {unread && (
        <span
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r"
          style={{ backgroundColor: "var(--accent)" }}
          aria-hidden
        />
      )}
      <button type="button" onClick={onClick} className="flex items-center gap-3 flex-1 min-w-0 h-full text-left">
        <Avatar name={senderName} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-[12.5px] flex-1 min-w-0", unread ? "font-semibold text-primary" : "font-medium text-secondary")}>
              {senderName}
            </span>
            <FolderBadge accountId={accountId} folderPath={message.folderPath} />
            <span className="text-[11px] text-muted tabular-nums shrink-0">{dateMain}</span>
          </div>
          {message.snippet && (
            <p className="truncate text-[12px] text-muted">{message.snippet}</p>
          )}
        </div>
      </button>
      <button
        type="button"
        title="Archive thread"
        aria-label="Archive thread"
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        className="flex h-7 w-7 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 shrink-0"
      >
        <Archive size={13} />
      </button>
      <button
        type="button"
        title="Delete message"
        aria-label="Delete message"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="flex h-7 w-7 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 shrink-0"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

/** Picker popover for moving a message's subject into another thread. */
function ThreadPickerPopover({
  currentSubject,
  currentThreadId,
  onPick,
  onMakeStandalone,
  onClose,
}: {
  currentSubject: string;
  currentThreadId: number;
  onPick: (threadId: number) => void;
  onMakeStandalone: () => void;
  onClose: () => void;
}) {
  const threads = useThreadsStore((s) => s.threads);
  const mergeGroups = useThreadsStore((s) => s.mergeGroups);
  const currentNorm = normalizeSubject(currentSubject);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Exclude only the thread we're acting from, and threads already in the
  // same merge group. Same-subject siblings (e.g. standalone splits of a
  // formerly-merged conversation) must remain visible so the user can pick
  // them as the merge target.
  const otherThreads = threads.filter((t) => {
    if (t.id === currentThreadId) return false;
    const tNorm = normalizeSubject(t.subject);
    const inSameGroup = mergeGroups.some(
      (g) => g.includes(currentNorm) && g.includes(tNorm),
    );
    return !inSameGroup;
  });

  const filtered = query
    ? otherThreads.filter((t) =>
        t.subject.toLowerCase().includes(query.toLowerCase()) ||
        t.participants.some((p) => p.toLowerCase().includes(query.toLowerCase())),
      )
    : otherThreads.slice(0, 30);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border shadow-xl flex flex-col overflow-hidden"
      style={{ background: "var(--bg-raised)", borderColor: "var(--border-strong)" }}
    >
      <div className="p-2 border-b" style={{ borderColor: "var(--border-soft)" }}>
        <div className="flex items-center gap-2 px-2 py-1 rounded"
          style={{ background: "var(--bg-base)" }}>
          <SearchIcon size={12} className="text-muted shrink-0" />
          <input
            autoFocus
            placeholder="Search threads…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-[12px] outline-none text-primary placeholder:text-disabled"
          />
        </div>
      </div>
      <div className="overflow-y-auto max-h-56">
        <button
          type="button"
          onClick={() => { onMakeStandalone(); onClose(); }}
          className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-hover transition-colors border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <Unlink size={12} className="text-muted shrink-0" />
          <p className="text-[12px] font-medium text-primary">Make standalone thread</p>
        </button>
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-[12px] text-muted">No other threads</p>
        ) : (
          filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { onPick(t.id); onClose(); }}
              className="w-full text-left px-3 py-2 hover:bg-hover transition-colors"
            >
              <p className="text-[12px] font-medium text-primary truncate">{t.subject || "(no subject)"}</p>
              <p className="text-[11px] text-muted truncate">{t.participants.slice(0, 2).join(", ")}</p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Expanded message shown inline in the thread scroll list. */
function InlineExpandedMessage({
  message,
  thread,
  activeAccountId,
  activeAccount,
  allMessages,
  onDelete,
  onArchive,
  onMoveToThread,
}: {
  message: ConvMsg;
  thread: Thread;
  activeAccountId: number | null;
  activeAccount: { email: string; signatureHtml: string | null } | null;
  allMessages: ConvMsg[];
  onDelete: () => void;
  onArchive: () => void;
  onMoveToThread: (targetThreadId: number | null) => void;
}) {
  const senderName = addressName(message.from) || message.from;
  const { primary: dateMain, secondary: dateSub } = formatDateStack(message.date * 1000);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const fullDate = message.date
    ? new Date(message.date * 1000).toLocaleString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="border-b" style={{ borderColor: "var(--border-strong)" }}>
      {/* Sender row */}
      <div
        className="flex items-center gap-3 px-6 py-3 border-b"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <Avatar name={senderName} size={36} />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-primary">{senderName}</p>
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex items-center gap-1 text-left group/details"
            title={detailsOpen ? "Hide details" : "Show details"}
          >
            <span className="text-[11.5px] text-muted truncate max-w-[260px]">{message.from}</span>
            <ChevronDown
              size={12}
              className={cn(
                "text-muted shrink-0 transition-transform duration-150",
                detailsOpen && "rotate-180",
              )}
            />
            <FolderBadge accountId={activeAccountId} folderPath={message.folderPath} />
          </button>
        </div>
        <div className="relative flex items-center gap-2 shrink-0">
          <div className="text-right">
            <p className="text-[12px] text-muted tabular-nums">{dateMain}</p>
            {dateSub && <p className="text-[10.5px] text-disabled tabular-nums">{dateSub}</p>}
            <div className="flex items-center justify-end gap-0.5 mt-1.5">
              <button
                type="button"
                title="Archive thread"
                aria-label="Archive thread"
                onClick={onArchive}
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors"
              >
                <Archive size={13} />
              </button>
              <button
                type="button"
                title="Delete message"
                aria-label="Delete message"
                onClick={onDelete}
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {onMoveToThread && (
            <>
              <button
                type="button"
                title="Move to a different thread"
                aria-label="Move to a different thread"
                onClick={() => setPickerOpen((v) => !v)}
                className="flex h-7 w-7 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors"
              >
                <ArrowRightLeft size={14} />
              </button>
              {pickerOpen && (
                <ThreadPickerPopover
                  currentSubject={message.subject}
                  currentThreadId={thread.id}
                  onPick={(targetId) => { onMoveToThread(targetId); }}
                  onMakeStandalone={() => { onMoveToThread(null); }}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </>
          )}
        </div>
      </div>
      {/* Collapsible To / Cc / Bcc / Subject / Date details */}
      {detailsOpen && (
        <div
          className="px-6 py-2 border-b text-[12px]"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-base)" }}
        >
          <table style={{ borderSpacing: 0, borderCollapse: "collapse" }}>
            <tbody>
              {message.to && (
                <tr>
                  <td className="text-muted font-medium pr-3 py-0.5 whitespace-nowrap align-top">To</td>
                  <td className="text-primary py-0.5">{message.to}</td>
                </tr>
              )}
              {message.cc && (
                <tr>
                  <td className="text-muted font-medium pr-3 py-0.5 whitespace-nowrap align-top">Cc</td>
                  <td className="text-primary py-0.5">{message.cc}</td>
                </tr>
              )}
              {message.bcc && (
                <tr>
                  <td className="text-muted font-medium pr-3 py-0.5 whitespace-nowrap align-top">Bcc</td>
                  <td className="text-primary py-0.5">{message.bcc}</td>
                </tr>
              )}
              {message.subject && (
                <tr>
                  <td className="text-muted font-medium pr-3 py-0.5 whitespace-nowrap align-top">Subject</td>
                  <td className="text-primary py-0.5">{message.subject}</td>
                </tr>
              )}
              {fullDate && (
                <tr>
                  <td className="text-muted font-medium pr-3 py-0.5 whitespace-nowrap align-top">Date</td>
                  <td className="text-primary py-0.5 tabular-nums">{fullDate}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {/* Body — flows naturally; outer div scrolls */}
      <MessageBodyContent
        message={message}
        thread={thread}
        activeAccountId={activeAccountId}
        activeAccount={activeAccount}
      />
      {/* Reply / forward actions */}
      <MessageReplyBar
        message={message}
        thread={thread}
        activeAccountId={activeAccountId}
        activeAccount={activeAccount}
        allMessages={allMessages}
      />
    </div>
  );
}

export function MessageCard({
  message,
  thread,
  isSelected,
  onToggle,
}: {
  message: ConvMsg;
  thread: Thread;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const toggleStar = useThreadsStore((s) => s.toggleStar);
  const senderName = addressName(message.from) || message.from;
  const unread = !message.flags.includes("Seen");
  const { primary: dateMain, secondary: dateSub } = formatDateStack(message.date * 1000);

  return (
    <div
      className={cn(
        "relative w-full border-b border-strong transition-colors",
        isSelected ? "bg-selected" : unread ? "bg-accent-soft hover:bg-hover" : "hover:bg-hover",
      )}
    >
      {unread && !isSelected && (
        <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r z-10" style={{ backgroundColor: "var(--accent)" }} aria-hidden />
      )}

      <div className="relative flex items-center gap-3 w-full h-[72px]">
        <div className="flex items-center gap-0.5 pl-4 shrink-0">
          <IconToggle label={thread.isPinned ? "Unstar" : "Star"} active={thread.isPinned} accent={thread.isPinned} onClick={(e) => { e.stopPropagation(); void toggleStar(thread.id); }}>
            <Star size={15} fill={thread.isPinned ? "currentColor" : "none"} strokeWidth={thread.isPinned ? 1.5 : 2} />
          </IconToggle>
        </div>

        <button
          type="button"
          onClick={onToggle}
          style={{ paddingRight: 28 }}
          className="flex items-center gap-3 flex-1 min-w-0 h-full text-left"
        >
          <Avatar name={senderName} size={36} />
          <div className="flex-1 min-w-0 flex flex-col justify-center">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={cn("truncate text-[13px] flex-1 min-w-0", unread ? "text-primary font-semibold" : "text-secondary font-medium")}>
                {senderName}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={cn("truncate text-[12.5px] flex-1 min-w-0", unread ? "text-primary" : "text-muted")}>
                <span className={unread ? "font-medium" : ""}>{renderWithFlags(thread.subject)}</span>
                {message.snippet && <span className="text-muted font-normal"> — {message.snippet}</span>}
              </span>
              {message.hasAttachments && <Paperclip size={12} className="text-muted shrink-0" />}
            </div>
          </div>
          <div className={cn("flex flex-col items-end justify-center shrink-0 tabular-nums leading-tight w-[52px]", unread ? "text-primary" : "text-muted")}>
            <span className="text-[11.5px] font-medium">{dateMain}</span>
            {dateSub && <span className="text-[10.5px] text-disabled mt-0.5">{dateSub}</span>}
          </div>
        </button>
      </div>
    </div>
  );
}


/** Scrollable body — occupies the `1fr` grid row. Must NOT set its own height. */
/** Strips quoted reply content from a plain-text email body. */
function stripQuotedText(text: string): { main: string; hasQuotes: boolean } {
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    const nextLine = (lines[i + 1] ?? "").trimEnd();

    // "On Mon, Apr 1 2024, John wrote:" — may span two lines in Gmail plain text.
    // Require the token after "on " to be a weekday/month abbreviation or a
    // digit so prose accidentally starting with "on " (e.g. "On the other hand
    // … wrote:") is never misidentified as a quote header.
    if (
      /^on\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d).{2,119}\s+wrote:\s*$/i.test(line) ||
      (/^on\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d).{2,79}$/i.test(line) && /^.{0,80} wrote:\s*$/i.test(nextLine))
    ) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      return { main: main || text, hasQuotes: main.length < text.length };
    }

    // "----- Original message -----" — Outlook (any number of dashes, any case)
    if (/-{3,}[\s]*original[\s]+message[\s]*-{3,}/i.test(line)) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      return { main: main || text, hasQuotes: main.length < text.length };
    }

    // "From: ... Sent: ... To: ... Subject:" block — Outlook (separate lines)
    if (/^from\s*:/i.test(line) && i > 0 && lines.slice(i, i + 6).some((l) => /^subject\s*:/i.test(l))) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      return { main: main || text, hasQuotes: main.length < text.length };
    }

    // Consecutive ">" quoted lines
    if (line.startsWith(">") && i > 0) {
      let quoteCount = 0;
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        const qLine = lines[j] ?? "";
        if (qLine.startsWith(">") || qLine.trim() === "") quoteCount++;
        else break;
      }
      if (quoteCount >= 2) {
        const main = lines.slice(0, i).join("\n").trimEnd();
        return { main: main || text, hasQuotes: main.length < text.length };
      }
    }
  }

  return { main: text, hasQuotes: false };
}

function MessageBodyContent({
  message,
  thread,
  activeAccountId,
  activeAccount: _activeAccountMBC,
}: {
  message: ConvMsg;
  thread: Thread;
  activeAccountId: number | null;
  activeAccount: { email: string; signatureHtml: string | null } | null;
}) {
  const fetchBody = useBodiesStore((s) => s.fetchBody);
  const bodies = useBodiesStore((s) => s.bodies);
  const loading = useBodiesStore((s) => s.loading);
  const errors = useBodiesStore((s) => s.errors);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);

  const folderPath = message.folderPath;
  const senderName = addressName(message.from) || message.from;

  useEffect(() => {
    // Sent_log entries (uid < 0) have their body pre-seeded — no IMAP fetch needed.
    if (message.uid < 0) return;
    if (activeAccountId && folderPath) {
      fetchBody(activeAccountId, folderPath, message.uid);
    }
  }, [activeAccountId, folderPath, message.uid, fetchBody]);

  const body = bodies[`${folderPath}:${message.uid}`];
  const isLoading = loading[`${folderPath}:${message.uid}`];
  const err = errors[`${folderPath}:${message.uid}`];

  const [showFullText, setShowFullText] = useState(false);
  useEffect(() => { setShowFullText(false); }, [message.uid]);

  const { main: plainMain, hasQuotes: plainHasQuotes } = body?.text
    ? stripQuotedText(body.text)
    : { main: "", hasQuotes: false };

  return (
    <div>
      {body?.unsubscribe && (
        <UnsubscribeBanner
          info={body.unsubscribe}
          senderLabel={senderName}
          onMailto={(to, subject, bodyText) =>
            openComposeWith({ to, subject, bodyHtml: bodyText ? `<p>${bodyText.replace(/</g, "&lt;")}</p>` : "<p></p>" })
          }
        />
      )}
      {body?.attachments && body.attachments.length > 0 && activeAccountId && folderPath && (
        <AttachmentStrip attachments={body.attachments} accountId={activeAccountId} folderPath={folderPath} uid={message.uid} threadId={thread.id} />
      )}
      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted text-[12.5px]">
          <Loader2 size={16} className="animate-spin mr-2" /> Loading message…
        </div>
      ) : err ? (
        <div className="flex flex-col items-center justify-center py-10 text-center px-6">
          <AlertCircle size={20} className="text-[color:var(--color-danger)] mb-2" />
          <p className="text-[13px] text-primary font-medium">Could not load message</p>
          <p className="text-[12px] text-muted mt-1 max-w-sm break-words">{err}</p>
        </div>
      ) : body?.unavailable ? (
        <UnavailableNotice
          snippet={body.text}
          accountId={activeAccountId ?? 0}
          folderPath={folderPath ?? ""}
          uid={message.uid}
        />
      ) : body?.html ? (
        <HtmlViewer html={body.html} uid={message.uid} />
      ) : body?.text ? (
        <>
          <pre className="p-6 text-[13px] text-primary whitespace-pre-wrap font-sans leading-relaxed">
            {showFullText ? body.text : plainMain}
          </pre>
          {plainHasQuotes && (
            <button
              type="button"
              onClick={() => setShowFullText((v) => !v)}
              className="text-left px-6 py-2 text-[12px] text-muted hover:text-primary transition-colors border-t"
              style={{ borderColor: "var(--border-soft)" }}
            >
              {showFullText ? "▲ Hide quoted text" : "▼ Show quoted text"}
            </button>
          )}
        </>
      ) : (
        <div className="p-6 text-[13px] text-muted">{message.snippet || "No content."}</div>
      )}
    </div>
  );
}

function UnavailableNotice({
  snippet,
  accountId,
  folderPath,
  uid,
}: {
  snippet: string | null;
  accountId: number;
  folderPath: string;
  uid: number;
}) {
  const setListQuery = useUiStore((s) => s.setListQuery);
  const [removed, setRemoved] = useState(false);

  async function handleRemove() {
    await deleteSearchIndexEntry(accountId, folderPath, uid).catch(() => {});
    setRemoved(true);
    // Clear the active search so the stale result disappears from the list.
    setListQuery("");
  }

  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 gap-4">
      <div className="text-center max-w-sm">
        <p className="text-[13px] text-primary font-medium mb-1">
          Message not available
        </p>
        <p className="text-[12px] text-muted leading-relaxed">
          This message could not be fetched — it may have been moved or deleted
          on the server. It still appeared in search results because the local
          index hasn&apos;t been updated yet.
        </p>
      </div>
      {snippet && (
        <pre className="w-full max-w-lg rounded-lg border px-4 py-3 text-[12px] text-muted whitespace-pre-wrap font-sans leading-relaxed"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}>
          {snippet}
        </pre>
      )}
      {removed ? (
        <p className="text-[12px] text-muted">Removed from search results.</p>
      ) : (
        <button
          type="button"
          onClick={() => void handleRemove()}
          className="rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-hover"
          style={{ borderColor: "var(--border-strong)", color: "var(--text-primary)" }}
        >
          Remove from search results
        </button>
      )}
    </div>
  );
}

/** Reply bar — occupies the `auto` grid row at the bottom. */
function MessageReplyBar({
  message,
  thread,
  activeAccountId,
  activeAccount: _activeAccount,
  allMessages,
}: {
  message: ConvMsg;
  thread: Thread;
  activeAccountId: number | null;
  activeAccount: { email: string; signatureHtml: string | null } | null;
  allMessages: ConvMsg[];
}) {
  const bodies = useBodiesStore((s) => s.bodies);
  const loading = useBodiesStore((s) => s.loading);
  const openReply = useComposerStore((s) => s.openReply);
  const openReplyAll = useComposerStore((s) => s.openReplyAll);
  const openForward = useComposerStore((s) => s.openForward);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);
  const accounts = useAccountsStore((s) => s.accounts);

  const body = bodies[`${message.folderPath}:${message.uid}`];
  const isLoading = loading[`${message.folderPath}:${message.uid}`];
  const canReply = Boolean(_activeAccount && !isLoading);

  // Build participants from THIS specific message's from/to/cc so that
  // Reply/Reply All target the right people regardless of thread order.
  const syntheticThread: Thread = (() => {
    const addrs = [
      message.from,
      ...message.to.split(", ").filter(Boolean),
      ...message.cc.split(", ").filter(Boolean),
    ];
    const seen = new Set<string>();
    const participants = addrs.filter((v) => {
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...thread, id: message.uid, participants };
  })();

  // Detect which of our accounts was used to send in this thread so that
  // replying from a "send via" account is preserved across turns.
  // Strategy: scan the conversation for outgoing messages (uid < 0 = sent_log,
  // or uid > 0 in a sent folder) where `from` matches one of our accounts.
  // The most recent such message wins.
  const preferredFromAccountId: number | null = (() => {
    const accountEmails = new Map(accounts.map((a) => [a.email.toLowerCase(), a.id]));
    // Walk backwards (newest first) through all messages in the thread.
    const sorted = [...allMessages].sort((a, b) => b.date - a.date);
    for (const m of sorted) {
      // Skip the message being replied to (it's from the external sender).
      if (m.uid === message.uid) continue;
      const fromMatch = m.from.match(/<([^>]+)>/);
      const fromEmail = (fromMatch?.[1] ?? m.from).toLowerCase();
      const id = accountEmails.get(fromEmail);
      if (id != null) return id;
    }
    return null;
  })();

  const [sendingNew, setSendingNew] = useState(false);

  async function handleSendNew() {
    if (!canReply || sendingNew) return;
    setSendingNew(true);
    try {
      // Build body without quoted/replied content and without subject.
      let bodyHtml: string;
      if (body?.html) {
        // Strategy: find the FIRST quote marker in document order
        // (blockquote, Outlook border-top divider, hr, "On … wrote:" attribution,
        // or "From:/Sent:/To:/Subject:" header) and remove it + everything after it.
        // This handles Outlook-style multi-level quoting where intermediate
        // quoted prose is not wrapped in <blockquote>.
        const parser = new DOMParser();
        const doc = parser.parseFromString(body.html, "text/html");

        const isQuoteMarker = (el: Element): string | null => {
          const tag = el.tagName;
          if (tag === "BLOCKQUOTE") return "blockquote";
          if (tag === "HR") return "hr";
          if (tag === "DIV") {
            const style = el.getAttribute("style") ?? "";
            if (/border-top\s*:\s*[^;]*solid/i.test(style)) return "outlook-border-top";
          }
          const txt = (el.textContent ?? "").trim();
          if (!txt) return null;
          // "On <date>, <name> wrote:" — require a date indicator so prose
          // like "On be to visit…" never matches.
          if (
            txt.length < 400 &&
            /^on\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)[\s\S]{2,300}\s+wrote:\s*$/i.test(txt)
          ) {
            return "attribution-on-wrote";
          }
          // Outlook header block From:/Sent:/To:/Subject: collapsed into one element.
          if (
            txt.length < 600 &&
            /\bFrom\s*:/i.test(txt) &&
            /\bSent\s*:/i.test(txt) &&
            /\bTo\s*:/i.test(txt) &&
            /\bSubject\s*:/i.test(txt)
          ) {
            return "outlook-header";
          }
          return null;
        };

        // Walk document in order; pick the FIRST element that matches.
        // querySelectorAll returns elements in tree order.
        let marker: Element | null = null;
        for (const el of Array.from(doc.body.querySelectorAll("*"))) {
          const kind = isQuoteMarker(el);
          if (kind) {
            marker = el;
            break;
          }
        }
        if (marker) {
          // Remove marker and every node that comes after it in document order.
          let node: Node | null = marker;
          let removeSelf = true;
          while (node && node !== doc.body && node.parentNode) {
            let sib: Node | null = node.nextSibling;
            while (sib) {
              const next: Node | null = sib.nextSibling;
              sib.parentNode?.removeChild(sib);
              sib = next;
            }
            const parent: Node | null = node.parentNode;
            if (removeSelf) {
              node.parentNode?.removeChild(node);
              removeSelf = false;
            }
            node = parent;
          }
        } else {
          // Fallback: split HTML by <br>, scan for quote intro, reconstruct up to that point.
          // Only applies if no marker found.
          // This robustly handles flat HTML with <br>-only quoting.
          const html = doc.body.innerHTML;
          // Split on <br> or <br/> or <br /> (case-insensitive)
          const lines = html.split(/<br\s*\/?>/i);
          let cutIdx = -1;
          for (let i = 0; i < lines.length; ++i) {
            const txt = (lines[i] ?? "").replace(/<[^>]+>/g, "").trim();
            if (
              /^on\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)[\s\S]{2,300}\s+wrote:\s*$/i.test(txt) ||
              /^>{1,3}\s*/.test(txt) ||
              /-{3,}\s*original message\s*-{3,}/i.test(txt)
            ) {
              cutIdx = i;
              break;
            }
          }
          if (cutIdx >= 0) {
            // Reconstruct HTML up to (but not including) the quote intro line
            const kept = lines.slice(0, cutIdx).join("<br>");
            doc.body.innerHTML = kept;
          }
        }

        // Strip leading empty block elements (blank lines many clients add at top).
        // Note: check el.tagName directly because querySelector only finds descendants,
        // not the element itself — a bare <img> would have no text and no img descendants.
        const isVisualElement = (el: Element) =>
          el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "TABLE" ||
          el.querySelector("img,video,table") !== null;
        while (doc.body.firstElementChild) {
          const el = doc.body.firstElementChild;
          if (el.textContent?.trim() === "" && !isVisualElement(el)) {
            el.remove();
          } else {
            break;
          }
        }
        // Also strip trailing empty block elements (clients often leave a few
        // blank paragraphs between the new content and the quote marker).
        while (doc.body.lastElementChild) {
          const el = doc.body.lastElementChild;
          if (el.textContent?.trim() === "" && !isVisualElement(el)) {
            el.remove();
          } else {
            break;
          }
        }
        // Recurse into a single wrapper child (e.g. <div class=WordSection1>)
        // and strip trailing blanks there too.
        const trimTrailingBlanks = (root: Element) => {
          while (root.lastElementChild) {
            const el = root.lastElementChild;
            if (el.textContent?.trim() === "" && !isVisualElement(el)) {
              el.remove();
            } else {
              break;
            }
          }
        };
        if (doc.body.children.length === 1) {
          trimTrailingBlanks(doc.body.firstElementChild!);
        }

        // Restore spacing that Tailwind's CSS reset removes. We apply
        // inline styles directly to elements since DOMPurify strips <style>
        // tag contents. Inline style= wins over all selector-based rules.
        //
        // Fix <p> margins (covers emails where each image is in its own <p>).
        for (const p of Array.from(doc.querySelectorAll("p"))) {
          const existing = p.getAttribute("style") ?? "";
          if (!/margin/.test(existing)) {
            p.setAttribute("style", existing ? `${existing};margin:1em 0` : "margin:1em 0");
          }
        }
        // Fix <img> spacing directly — covers emails where multiple images
        // are siblings inside the same <p> or <div>, or are direct body children.
        for (const img of Array.from(doc.querySelectorAll("img"))) {
          const existing = img.getAttribute("style") ?? "";
          // Trim any trailing semicolons before appending so we never get ";;".
          let s = existing.replace(/;+$/, "");
          if (!s.includes("display")) s = (s ? s + ";" : "") + "display:block";
          if (!s.includes("margin-bottom")) s += ";margin-bottom:1em";
          if (!s.includes("max-width")) s += ";max-width:100%;height:auto";
          img.setAttribute("style", s);
        }

        bodyHtml = doc.body.innerHTML.trim() || "<p></p>";

        // Embed remote images as base64 data URIs so they display in the
        // composer preview and are self-contained in the outgoing message.
        if (bodyHtml !== "<p></p>") {
          bodyHtml = await embedRemoteImages(bodyHtml);
        }
      } else if (body?.text) {
        const { main } = stripQuotedText(body.text);
        const escaped = main.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // Wrap in a div with pre-wrap so newlines render exactly as in the
        // original plain-text email. This is routed through rawBodyHtml below
        // so Tiptap normalisation is bypassed entirely — the text moves over
        // verbatim into the editable preview.
        bodyHtml = `<div style="white-space:pre-wrap;font-family:inherit">${escaped}</div>`;
      } else {
        bodyHtml = "<p></p>";
      }

      let outAttachments: OutgoingAttachment[] = [];
      if (body?.attachments?.length && activeAccountId && message.folderPath && message.uid > 0) {
        const account = await getAccount(activeAccountId);
        const secrets = await getAccountSecrets(activeAccountId);
        if (account && secrets) {
          const cfg = {
            host: account.imap_host,
            port: account.imap_port,
            username: account.imap_username ?? account.email,
            password: secrets.imapPassword,
            security: account.imap_security,
          };
          const tmp = await tempDir();
          const sep = tmp.endsWith("/") || tmp.endsWith("\\") ? "" : "/";
          const stamp = Date.now();
          outAttachments = await Promise.all(
            body.attachments.map(async (att) => {
              const filename = att.filename ?? `attachment-${att.index + 1}`;
              const safeName = filename.replace(/[/\\:*?"<>|]/g, "_");
              const destPath = `${tmp}${sep}cursus-${stamp}-${att.index}-${safeName}`;
              await ipc.imapSaveAttachment(cfg, message.folderPath, message.uid, att.index, destPath);
              return {
                filename,
                path: destPath,
                contentType: att.contentType,
              } satisfies OutgoingAttachment;
            }),
          );
        }
      }

      // Both HTML and plain-text bodies go through rawBodyHtml so the compose
      // window renders them faithfully in the contentEditable preview (no
      // Tiptap normalisation). Hide the empty Tiptap editor in both cases —
      // the raw preview itself is editable, so the empty editor area above
      // is redundant.
      if (body?.html || body?.text) {
        openComposeWith({
          rawBodyHtml: bodyHtml,
          attachments: outAttachments,
          hideEditor: true,
        });
      } else {
        openComposeWith({
          bodyHtml,
          attachments: outAttachments,
        });
      }
    } catch (e) {
      toast.error("Failed to prepare Send New: " + String(e));
    } finally {
      setSendingNew(false);
    }
  }

  return (
    <div className="flex items-center gap-2 px-7 py-3 border-t border-soft">
      <ReplyButton onClick={() => openReply(syntheticThread, body?.html ?? null, body?.text ?? null, null, preferredFromAccountId, _activeAccount?.email ?? null)} disabled={!canReply}>
        <Reply size={14} /> Reply
      </ReplyButton>
      <ReplyButton onClick={() => _activeAccount && openReplyAll(syntheticThread, body?.html ?? null, body?.text ?? null, _activeAccount.email, null, preferredFromAccountId)} disabled={!canReply}>
        <ReplyAll size={14} /> Reply all
      </ReplyButton>
      <ReplyButton onClick={() => openForward(syntheticThread, body?.html ?? null, body?.text ?? null, null, preferredFromAccountId)} disabled={!canReply}>
        <Forward size={14} /> Forward
      </ReplyButton>
      <ReplyButton onClick={() => void handleSendNew()} disabled={!canReply || sendingNew}>
        {sendingNew ? <Loader2 size={14} className="animate-spin" /> : <MailPlus size={14} />} Send New
      </ReplyButton>
    </div>
  );
}

function IconToggle({
  children,
  label,
  active: _active,
  accent,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  accent?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded transition-colors",
        accent ? "text-accent" : "text-muted",
        "hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

function EmptyReadingPane() {
  return (
    <section className="flex items-center justify-center bg-raised">
      <div className="flex flex-col items-center text-center max-w-xs">
        <div
          className="h-14 w-14 rounded-full flex items-center justify-center mb-4"
          style={{ background: "var(--accent-soft)" }}
        >
          <InboxIcon size={20} className="text-accent" />
        </div>
        <h3 className="text-[14px] font-semibold text-primary">Nothing selected</h3>
        <p className="text-[12.5px] text-muted mt-1">
          Pick a conversation from the list to read it here.
        </p>
      </div>
    </section>
  );
}

function ActionButton({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        active ? "text-accent" : "text-muted",
        !disabled && "hover:bg-hover hover:text-primary",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="h-5 w-px mx-1 bg-[color:var(--border-strong)]" />;
void Divider;

const extractEmailLabel = (raw: string): string => {
  const m = raw.match(/<([^>]+)>/);
  return m && m[1] ? `<${m[1]}>` : "";
};
void extractEmailLabel;

function isMediaAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (ct.startsWith("audio/")) return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["mp3","wav","flac","aac","m4a"].includes(ext);
}

function isVideoAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (ct.startsWith("video/")) return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["mp4","webm","ogv","ogg","mov","avi","mkv","m4v"].includes(ext);
}

function isImageAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (ct.startsWith("image/")) return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["jpg","jpeg","png","gif","webp","bmp","svg","svgz","tiff","tif","ico","avif","heic","heif","jfif","jxl"].includes(ext);
}

function isPdfAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (ct === "application/pdf" || ct === "application/x-pdf") return true;
  return (a.filename ?? "").split(".").pop()?.toLowerCase() === "pdf";
}

function isDocxAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (
    ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ct === "application/msword" ||
    ct === "application/wps-office.docx" ||
    ct === "application/wps-office.wps"
  ) return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["docx","doc","wps","odt"].includes(ext);
}

function isTxtAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (
    ct === "text/plain" ||
    ct === "application/json" ||
    ct === "text/javascript" || ct === "application/javascript" ||
    ct === "text/css" || ct === "text/xml" || ct === "application/xml" ||
    ct === "text/x-python" || ct === "application/x-python" ||
    ct === "text/x-shellscript"
  ) return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["txt","log","csv","md","json","xml","yaml","yml","js","ts","py","css","sh","bat","ini","toml","cfg","conf","env","gitignore"].includes(ext);
}

function isHtmlAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (ct === "text/html") return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ext === "html" || ext === "htm";
}

function isSpreadsheetAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (
    ct === "application/vnd.ms-excel" ||
    ct === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ct === "application/vnd.oasis.opendocument.spreadsheet"
  ) return true;
  const ext = (a.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return ["xlsx","xls","ods"].includes(ext);
}

function isRtfAttachment(a: Attachment): boolean {
  const ct = a.contentType.toLowerCase();
  if (ct === "text/rtf" || ct === "application/rtf") return true;
  return (a.filename ?? "").split(".").pop()?.toLowerCase() === "rtf";
}

const isPreviewableAttachment = (a: Attachment): boolean => {
  return (
    isPdfAttachment(a) || isImageAttachment(a) || isDocxAttachment(a) ||
    isTxtAttachment(a) || isHtmlAttachment(a) || isVideoAttachment(a) ||
    isSpreadsheetAttachment(a) || isRtfAttachment(a)
  );
};
void isPreviewableAttachment;

function AttachmentStrip({
  attachments,
  accountId,
  folderPath,
  uid,
  threadId,
}: {
  attachments: Attachment[];
  accountId: number;
  folderPath: string;
  uid: number;
  threadId: number;
}) {
  const playMedia = useMediaPlayerStore((s) => s.play);
  const activeTrack = useMediaPlayerStore((s) => s.track);
  const openPreview = useAttachmentPreviewStore((s) => s.open);
  const openGallery = useImageGalleryStore((s) => s.open);

  const imageAttachments = attachments.filter(isImageAttachment);
  const otherAttachments = attachments.filter((a) => !isImageAttachment(a));

  // Pre-warm the cache for all image attachments as soon as the strip renders
  useEffect(() => {
    if (imageAttachments.length === 0) return;
    prefetchAttachments(accountId, folderPath, uid, imageAttachments.map((a) => a.index));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, folderPath, uid]);

  return (
    <div className="border-b border-soft shrink-0">
      {/* Gallery banner for images */}
      {imageAttachments.length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2">
          {/* Mini thumbnails — up to 5 */}
          {imageAttachments.slice(0, 5).map((a, i) => (
            <MiniThumb
              key={a.index}
              attachment={a}
              accountId={accountId}
              folderPath={folderPath}
              uid={uid}
              onClick={() => openGallery({ accountId, folderPath, uid, attachments: imageAttachments, index: i })}
            />
          ))}
          {imageAttachments.length > 5 && (
            <button
              type="button"
              onClick={() => openGallery({ accountId, folderPath, uid, attachments: imageAttachments })}
              className="flex items-center justify-center h-10 w-10 rounded-md border border-soft bg-sunken text-[11px] text-muted hover:bg-hover hover:text-primary transition-colors shrink-0"
            >
              +{imageAttachments.length - 5}
            </button>
          )}
          {/* Spacer */}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => openGallery({ accountId, folderPath, uid, attachments: imageAttachments })}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors shrink-0"
          >
            <Images size={12} />
            <span>Open Gallery</span>
          </button>
        </div>
      )}
      {/* Chips row for non-image attachments */}
      {otherAttachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-6 py-2">
          <Paperclip size={13} className="text-muted" />
          {otherAttachments.map((a) => (
            <AttachmentChip
              key={a.index}
              attachment={a}
              accountId={accountId}
              folderPath={folderPath}
              uid={uid}
              onPlay={
                isMediaAttachment(a)
                  ? () => playMedia({ accountId, folderPath, uid, threadId, attachment: a })
                  : undefined
              }
              isPlaying={
                activeTrack?.uid === uid &&
                activeTrack.attachment.index === a.index
              }
              onPreview={
                (isPdfAttachment(a) || isDocxAttachment(a) || isTxtAttachment(a) ||
                 isHtmlAttachment(a) || isVideoAttachment(a) || isSpreadsheetAttachment(a) || isRtfAttachment(a))
                  ? () => openPreview({ accountId, folderPath, uid, attachment: a })
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Small lazy-loaded thumbnail for the gallery banner strip. */
function MiniThumb({
  attachment,
  accountId,
  folderPath,
  uid,
  onClick,
}: {
  attachment: Attachment;
  accountId: number;
  folderPath: string;
  uid: number;
  onClick: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const display = attachment.filename ?? `image-${attachment.index + 1}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) setVisible(true); },
      { rootMargin: "100px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const b64 = await loadAttachmentB64(accountId, folderPath, uid, attachment.index);
        if (cancelled) return;
        const small = await new Promise<string>((resolve) => {
          const img = new Image();
          img.onload = () => {
            const s = Math.min(1, 80 / img.naturalWidth, 80 / img.naturalHeight);
            const w = Math.max(1, Math.round(img.naturalWidth * s));
            const h = Math.max(1, Math.round(img.naturalHeight * s));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.75));
          };
          img.onerror = () => resolve(`data:${attachment.contentType};base64,${b64}`);
          img.src = `data:${attachment.contentType};base64,${b64}`;
        });
        if (!cancelled) setSrc(small);
      } catch { /* show placeholder */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [visible, accountId, folderPath, uid, attachment.index, attachment.contentType]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={display}
      className="relative flex-none rounded-md overflow-hidden border border-soft bg-sunken hover:border-[color:var(--accent)] transition-colors shrink-0"
      style={{ width: 40, height: 40 }}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={10} className="animate-spin text-muted" />
        </div>
      )}
      {src ? (
        <img src={src} alt={display} className="w-full h-full object-cover" draggable={false} />
      ) : !loading ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Images size={12} className="text-muted" />
        </div>
      ) : null}
    </button>
  );
}

function AttachmentChip({
  attachment,
  accountId,
  folderPath,
  uid,
  onPlay,
  isPlaying,
  onPreview,
}: {
  attachment: Attachment;
  accountId: number;
  folderPath: string;
  uid: number;
  onPlay?: () => void;
  isPlaying?: boolean;
  onPreview?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState<"dl" | "attach" | null>(null);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);
  const display = attachment.filename || `attachment-${attachment.index + 1}`;

  async function handleMediaDownload() {
    if (mediaBusy) return;
    try {
      const destPath = await save({ defaultPath: display, title: "Save attachment" });
      if (!destPath) return;
      setMediaBusy("dl");
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      await ipc.imapSaveAttachment(
        { host: account.imap_host, port: account.imap_port, username: account.imap_username ?? account.email, password: secrets.imapPassword, security: account.imap_security },
        folderPath, uid, attachment.index, destPath,
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setMediaBusy(null);
    }
  }

  async function handleMediaAttach() {
    if (mediaBusy) return;
    setMediaBusy("attach");
    try {
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      const tmp = await tempDir();
      const sep = tmp.endsWith("/") || tmp.endsWith("\\") ? "" : "/";
      const safeName = display.replace(/[/\\:*?"<>|]/g, "_");
      const destPath = `${tmp}${sep}cursus-${Date.now()}-${attachment.index}-${safeName}`;
      await ipc.imapSaveAttachment(
        { host: account.imap_host, port: account.imap_port, username: account.imap_username ?? account.email, password: secrets.imapPassword, security: account.imap_security },
        folderPath, uid, attachment.index, destPath,
      );
      openComposeWith({ attachments: [{ filename: display, path: destPath, contentType: attachment.contentType }] });
    } catch (e) {
      toast.error("Failed to attach: " + String(e));
    } finally {
      setMediaBusy(null);
    }
  }

  if (onPlay) {
    return (
      <div className="flex items-center gap-0">
        {/* Play / stop */}
        <button
          type="button"
          onClick={onPlay}
          title={`${isPlaying ? "Stop" : "Play"} ${display}`}
          className={cn(
            "flex items-center gap-2 h-7 rounded-l-md px-2.5 text-[12px]",
            "bg-sunken border-y border-l text-secondary",
            "hover:bg-hover hover:text-primary transition-colors",
            isPlaying
              ? "border-[color:var(--color-accent)] text-[color:var(--color-accent)]"
              : "border-soft",
          )}
        >
          <span className="truncate max-w-[180px]">{display}</span>
          <span className="text-muted tabular-nums">{formatSize(attachment.size)}</span>
          {isPlaying ? <Pause size={12} /> : <Play size={12} />}
        </button>
        {/* Download */}
        <button
          type="button"
          onClick={() => void handleMediaDownload()}
          disabled={mediaBusy !== null}
          title={`Download ${display}`}
          className={cn(
            "flex items-center justify-center h-7 w-7 text-[12px]",
            "bg-sunken border-y border-l text-muted",
            isPlaying ? "border-[color:var(--color-accent)]" : "border-soft",
            "hover:bg-hover hover:text-primary transition-colors",
            "disabled:opacity-60 disabled:cursor-wait",
          )}
        >
          {mediaBusy === "dl" ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
        </button>
        {/* Attach to new email */}
        <button
          type="button"
          onClick={() => void handleMediaAttach()}
          disabled={mediaBusy !== null}
          title="Attach to new email"
          className={cn(
            "flex items-center justify-center h-7 w-7 rounded-r-md text-[12px]",
            "bg-sunken border text-muted",
            isPlaying ? "border-[color:var(--color-accent)]" : "border-soft",
            "hover:bg-hover hover:text-primary transition-colors",
            "disabled:opacity-60 disabled:cursor-wait",
          )}
        >
          {mediaBusy === "attach" ? <Loader2 size={11} className="animate-spin" /> : <MailPlus size={11} />}
        </button>
      </div>
    );
  }

  if (onPreview) {
    return (
      <div className="flex items-center gap-0">
        <button
          type="button"
          onClick={onPreview}
          title={`Preview ${display}`}
          className={cn(
            "flex items-center gap-2 h-7 rounded-l-md px-2.5 text-[12px]",
            "bg-sunken border border-r-0 border-soft text-secondary",
            "hover:bg-hover hover:text-primary transition-colors",
          )}
        >
          <span className="truncate max-w-[200px]">{display}</span>
          <span className="text-muted tabular-nums">{formatSize(attachment.size)}</span>
          <Eye size={12} />
        </button>
        <DownloadIconButton
          attachment={attachment}
          accountId={accountId}
          folderPath={folderPath}
          uid={uid}
          display={display}
          roundedRight={false}
        />
        <button
          type="button"
          onClick={() => void handleMediaAttach()}
          disabled={mediaBusy !== null}
          title="Attach to new email"
          className={cn(
            "flex items-center justify-center h-7 w-7 rounded-r-md text-[12px]",
            "bg-sunken border-y border-r border-l-0 border-soft text-muted",
            "hover:bg-hover hover:text-primary transition-colors",
            "disabled:opacity-60 disabled:cursor-wait",
          )}
        >
          {mediaBusy === "attach" ? <Loader2 size={11} className="animate-spin" /> : <MailPlus size={11} />}
        </button>
      </div>
    );
  }

  async function handleDownload() {
    if (busy) return;
    setErr(null);
    try {
      const destPath = await save({
        defaultPath: display,
        title: "Save attachment",
      });
      if (!destPath) return;
      setBusy(true);
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      await ipc.imapSaveAttachment(
        {
          host: account.imap_host,
          port: account.imap_port,
          username: account.imap_username ?? account.email,
          password: secrets.imapPassword,
          security: account.imap_security,
        },
        folderPath,
        uid,
        attachment.index,
        destPath,
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={busy}
      title={err ?? `Download ${display}`}
      className={cn(
        "flex items-center gap-2 h-7 rounded-md px-2.5 text-[12px]",
        "bg-sunken border border-soft text-secondary",
        "hover:bg-hover hover:text-primary transition-colors",
        "disabled:opacity-60 disabled:cursor-wait",
        err && "border-[color:var(--color-danger)] text-[color:var(--color-danger)]",
      )}
    >
      <span className="truncate max-w-[220px]">{display}</span>
      <span className="text-muted tabular-nums">{formatSize(attachment.size)}</span>
      {busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <Download size={12} />
      )}
    </button>
  );
}

/** Small download-only icon button, used as secondary action next to preview chips. */
function DownloadIconButton({
  attachment,
  accountId,
  folderPath,
  uid,
  display,
  roundedRight = true,
}: {
  attachment: Attachment;
  accountId: number;
  folderPath: string;
  uid: number;
  display: string;
  roundedRight?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  async function handleDownload() {
    if (busy) return;
    try {
      const destPath = await save({ defaultPath: display, title: "Save attachment" });
      if (!destPath) return;
      setBusy(true);
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      await ipc.imapSaveAttachment(
        {
          host: account.imap_host,
          port: account.imap_port,
          username: account.imap_username ?? account.email,
          password: secrets.imapPassword,
          security: account.imap_security,
        },
        folderPath,
        uid,
        attachment.index,
        destPath,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={busy}
      title={`Download ${display}`}
      className={cn(
        "flex items-center justify-center h-7 w-7 text-[12px]",
        roundedRight ? "rounded-r-md" : "",
        "bg-sunken border border-soft text-muted",
        "hover:bg-hover hover:text-primary transition-colors",
        "disabled:opacity-60 disabled:cursor-wait",
      )}
    >
      {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
    </button>
  );
}

function parseMailto(uri: string): {
  to: string;
  subject: string;
  body: string;
} {
  // RFC 6068: `mailto:<to>?subject=...&body=...&cc=...`
  const withoutScheme = uri.replace(/^mailto:/i, "");
  const [toPart, queryPart] = withoutScheme.split("?", 2);
  const to = decodeURIComponent(toPart ?? "").trim();
  const params = new URLSearchParams(queryPart ?? "");
  const subject = params.get("subject") ?? "unsubscribe";
  const body = params.get("body") ?? "unsubscribe";
  return { to, subject, body };
}

function UnsubscribeBanner({
  info,
  senderLabel,
  onMailto,
}: {
  info: UnsubscribeInfo;
  senderLabel: string;
  onMailto: (to: string, subject: string, body: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handle() {
    if (busy || done) return;
    setErr(null);

    // Prefer RFC 8058 one-click: silent POST, no user interaction. This is
    // what Gmail's one-click button does when the sender opts in.
    if (info.oneClick && info.http) {
      setBusy(true);
      try {
        await ipc.unsubscribeOneClick(info.http);
        setDone(true);
        toast.success(`Unsubscribed from ${senderLabel}`);
      } catch (e) {
        setErr(String(e));
        toast.error(`Unsubscribe failed: ${e}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Fallback 1: mailto URI — pre-fill the composer. Sender usually just
    // wants any reply to their dedicated unsub address; subject/body from
    // the URI are honoured per RFC 6068.
    if (info.mailto) {
      const { to, subject, body } = parseMailto(info.mailto);
      onMailto(to, subject, body);
      return;
    }

    // Fallback 2: https URI — open in the system browser, user finishes
    // the unsub flow on the sender's web page.
    if (info.http) {
      try {
        await openUrl(info.http);
      } catch (e) {
        setErr(String(e));
        toast.error(`Could not open browser: ${e}`);
      }
      return;
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        borderBottomColor: "var(--border-soft)",
      }}
      className="flex items-center gap-3 px-6 py-2 border-b shrink-0"
    >
      <BellOff size={14} className="text-muted shrink-0" />
      <span className="text-[12.5px] text-secondary flex-1 min-w-0 truncate">
        {done
          ? `You're unsubscribed from ${senderLabel}.`
          : `This is a mailing list. You can stop receiving messages from ${senderLabel}.`}
      </span>
      {!done && (
        <button
          type="button"
          onClick={() => void handle()}
          disabled={busy}
          style={{ color: "var(--accent)" }}
          className="text-[12.5px] font-medium hover:underline disabled:opacity-60 disabled:cursor-wait shrink-0"
        >
          {busy
            ? "Unsubscribing…"
            : info.oneClick
              ? "Unsubscribe"
              : info.mailto
                ? "Unsubscribe by email"
                : "Unsubscribe in browser"}
        </button>
      )}
      {err && (
        <span
          className="text-[11.5px] shrink-0"
          style={{ color: "var(--color-danger)" }}
          title={err}
        >
          failed
        </span>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SnoozeMenu({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const snoozeThread = useThreadsStore((s) => s.snoozeThread);
  const selectThread = useUiStore((s) => s.selectThread);

  function pick(unix: number) {
    setOpen(false);
    selectThread(null);
    void snoozeThread(thread.id, unix);
  }

  function pickCustom() {
    setOpen(false);
    // Native datetime-local prompt — keeps the dependency surface small.
    const now = new Date();
    const sample = new Date(now.getTime() + 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16); // YYYY-MM-DDTHH:MM
    const input = window.prompt(
      "Snooze until (YYYY-MM-DD HH:MM, local time):",
      sample.replace("T", " "),
    );
    if (!input) return;
    const trimmed = input.trim().replace(" ", "T");
    const target = new Date(trimmed);
    if (Number.isNaN(target.getTime())) {
      toast.error("Invalid date — expected YYYY-MM-DD HH:MM");
      return;
    }
    if (target.getTime() <= Date.now()) {
      toast.error("Snooze time must be in the future");
      return;
    }
    selectThread(null);
    void snoozeThread(thread.id, Math.floor(target.getTime() / 1000));
  }

  return (
    <div className="relative">
      <ActionButton label="Snooze" onClick={() => setOpen((o) => !o)}>
        <Clock size={15} />
      </ActionButton>
      {open && (
        <>
          {/* Click-outside catcher */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-1 z-50 w-[200px] rounded-lg border p-1 fade-in"
            style={{
              background: "var(--bg-raised)",
              borderColor: "var(--border-strong)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {SNOOZE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => pick(p.computeUnix())}
                className="flex items-center w-full h-8 rounded-md px-3 text-[12.5px] text-secondary hover:bg-hover hover:text-primary transition-colors text-left"
              >
                {p.label}
              </button>
            ))}
            <div className="h-px my-1" style={{ background: "var(--border-soft)" }} />
            <button
              type="button"
              onClick={pickCustom}
              className="flex items-center w-full h-8 rounded-md px-3 text-[12.5px] text-secondary hover:bg-hover hover:text-primary transition-colors text-left"
            >
              Pick a date and time…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ReplyButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 h-8 rounded-md px-3 text-[12.5px] font-medium",
        "text-secondary bg-transparent border border-transparent",
        "hover:bg-hover hover:border-soft hover:text-primary transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent disabled:hover:text-secondary",
      )}
    >
      {children}
    </button>
  );
}
