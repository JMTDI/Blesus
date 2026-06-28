import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  ChevronDown,
  RefreshCw,
  SlidersHorizontal,
  AlertCircle,
  Archive,
  Trash2,
  Star,
  X as XIcon,
  Check,
  CheckCheck,
  Search as SearchIcon,
  Merge,
  Pencil,
  Database,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAccountsStore } from "@/stores/accounts";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore, type ListFilter, type ListSort } from "@/stores/ui";
import { CategoryTabs } from "@/components/mail/CategoryTabs";
import { MessageRow } from "@/components/mail/MessageRow";
import {
  RowContextMenu,
  type ContextMenuState,
} from "@/components/mail/RowContextMenu";
import { deleteDraft, listDrafts, searchMessages, type SearchHit, type StoredDraft } from "@/lib/db";
import { getOverallSyncStatus, type OverallSyncStatus } from "@/lib/syncStatus";
import { indexAllMail } from "@/lib/indexAllMail";
import { backfillAttachmentIndex } from "@/lib/fullSync";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useFullSyncStore } from "@/stores/fullSync";
import { useComposerStore } from "@/stores/composer";
import { toast } from "@/stores/toasts";
import { addressName, formatDateStack } from "@/lib/time";
import type { Thread } from "@/types";

export function MessageList() {
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const activeFolderId = useAccountsStore((s) => s.activeFolderId);
  const folders = useAccountsStore((s) => s.folders);
  const threads = useThreadsStore((s) => s.threads);
  const starredThreads = useThreadsStore((s) => s.starredThreads);
  const fetchAllStarred = useThreadsStore((s) => s.fetchAllStarred);
  const loading = useThreadsStore((s) => s.loading);
  const error = useThreadsStore((s) => s.error);
  const fetchFolder = useThreadsStore((s) => s.fetchFolder);
  const loadMore = useThreadsStore((s) => s.loadMore);
  const fetchAllUnread = useThreadsStore((s) => s.fetchAllUnread);
  const loadingMore = useThreadsStore((s) => s.loadingMore);
  const hasMore = useThreadsStore((s) => s.hasMore);
  const markManyRead = useThreadsStore((s) => s.markManyRead);
  const archiveThread = useThreadsStore((s) => s.archiveThread);
  const trashThread = useThreadsStore((s) => s.trashThread);
  const permanentDeleteThread = useThreadsStore((s) => s.permanentDeleteThread);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectThread = useUiStore((s) => s.selectThread);
  const activeCategory = useUiStore((s) => s.activeCategory);
  const starredView = useUiStore((s) => s.starredView);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const toggleSelection = useUiStore((s) => s.toggleSelection);
  const selectRange = useUiStore((s) => s.selectRange);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const listFilter = useUiStore((s) => s.listFilter);
  const listSort = useUiStore((s) => s.listSort);
  const listQuery = useUiStore((s) => s.listQuery);
  const setListFilter = useUiStore((s) => s.setListFilter);
  const setListSort = useUiStore((s) => s.setListSort);
  const setListQuery = useUiStore((s) => s.setListQuery);
  const searchRef = useRef<HTMLInputElement>(null);
  const syncPhase = useFullSyncStore((s) => s.phase);
  const syncFoldersDone = useFullSyncStore((s) => s.foldersDone);
  const syncFoldersTotal = useFullSyncStore((s) => s.foldersTotal);
  const syncBodiesDone = useFullSyncStore((s) => s.bodiesDone);
  const syncBodiesTotal = useFullSyncStore((s) => s.bodiesTotal);
  const syncAttDone = useFullSyncStore((s) => s.attachmentsDone);
  const syncAttTotal = useFullSyncStore((s) => s.attachmentsTotal);
  const syncAttFile = useFullSyncStore((s) => s.attachmentsCurrentFile);
  const reindexing = syncPhase === "headers" || syncPhase === "bodies" || syncPhase === "attachments";
  const reindexDone = syncPhase === "done";
  const [confirmReindex, setConfirmReindex] = useState(false);
  const [confirmForceReOcr, setConfirmForceReOcr] = useState(false);

  const reindexProgress = reindexing ? (() => {
    if (syncPhase === "headers") {
      const pct = syncFoldersTotal > 0 ? Math.round((syncFoldersDone / syncFoldersTotal) * 33) : 0;
      return { label: `Indexing headers… ${syncFoldersDone}/${syncFoldersTotal} folders`, pct };
    }
    if (syncPhase === "bodies") {
      const pct = syncBodiesTotal > 0 ? 33 + Math.round((syncBodiesDone / syncBodiesTotal) * 34) : 33;
      return { label: `Downloading bodies… ${syncBodiesDone}/${syncBodiesTotal} messages`, pct };
    }
    // attachments
    const file = syncAttFile ? ` · ${syncAttFile}` : "";
    const pct = syncAttTotal > 0 ? 67 + Math.round((syncAttDone / syncAttTotal) * 33) : 67;
    return { label: `Extracting attachments… ${syncAttDone}/${syncAttTotal}${file}`, pct };
  })() : null;

  function startReindex(force?: boolean) {
    if (reindexing) return;
    if (force) setConfirmForceReOcr(true);
    else setConfirmReindex(true);
  }

  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);

  // ── Sync status indicator ──────────────────────────────────────────────
  // Polls the local DB every ~5 s (and immediately when reindex transitions
  // away from a running phase) so the user can see at a glance whether
  // search is operating against the full mailbox or a partial cache.
  const [syncStatus, setSyncStatus] = useState<OverallSyncStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const s = await getOverallSyncStatus();
        if (!cancelled) setSyncStatus(s);
      } catch {/* ignore — DB might be locked momentarily */}
      if (!cancelled) {
        // Poll faster while indexing is in progress so the numbers feel live.
        const next = reindexing ? 2000 : 8000;
        timer = window.setTimeout(refresh, next);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [reindexing, reindexDone]);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const SEARCH_PAGE = 50;

  const activeFolder = folders.find((f) => f.id === activeFolderId);
  const isDraftsFolder = activeFolder?.specialUse === "drafts";
  const openFromDraft = useComposerStore((s) => s.openFromDraft);
  const bumpDraftKey = useComposerStore((s) => s.bumpDraftKey);
  const composerOpen = useComposerStore((s) => s.open);
  const [localDrafts, setLocalDrafts] = useState<StoredDraft[]>([]);
  const prevComposerOpenRef = useRef(false);

  useEffect(() => {
    if (!isDraftsFolder || !activeAccountId) {
      setLocalDrafts([]);
      return;
    }
    void listDrafts(activeAccountId).then(setLocalDrafts).catch((err) => {
      console.error("[Blesus] listDrafts failed:", err);
      toast.error(`Failed to load drafts: ${String(err)}`);
    });
  }, [isDraftsFolder, activeAccountId]);

  // Refresh local drafts when the composer closes (the user may have saved a new draft).
  useEffect(() => {
    if (composerOpen) {
      prevComposerOpenRef.current = true;
      return;
    }
    if (!prevComposerOpenRef.current) return;
    prevComposerOpenRef.current = false;
    if (!isDraftsFolder || !activeAccountId) return;
    const t = setTimeout(() => {
      void listDrafts(activeAccountId).then(setLocalDrafts).catch((err) => {
        console.error("[Blesus] listDrafts refresh failed:", err);
        toast.error(`Failed to refresh drafts: ${String(err)}`);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [composerOpen, isDraftsFolder, activeAccountId]);

  // FTS search — runs when the user types in the search bar.
  useEffect(() => {
    const q = listQuery.trim();
    if (!q) {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchHasMore(false);
      setSearchOffset(0);
      return;
    }
    // Silently backfill any attachment text from OCR cache before searching
    // (catches emails moved between folders that haven't been opened yet).
    backfillAttachmentIndex().catch(() => {});
    let cancelled = false;
    setSearchLoading(true);
    setSearchOffset(0);
    setSearchHasMore(false);
    const handle = setTimeout(async () => {
      try {
        const hits = await searchMessages(q, SEARCH_PAGE + 1, 0);
        if (!cancelled) {
          setSearchHasMore(hits.length > SEARCH_PAGE);
          setSearchHits(hits.slice(0, SEARCH_PAGE));
          setSearchOffset(SEARCH_PAGE);
          setSearchLoading(false);
        }
      } catch {
        if (!cancelled) {
          setSearchHits([]);
          setSearchLoading(false);
        }
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [listQuery]);

  async function loadMoreSearchResults() {
    const q = listQuery.trim();
    if (!q || searchLoadingMore) return;
    setSearchLoadingMore(true);
    try {
      const hits = await searchMessages(q, SEARCH_PAGE + 1, searchOffset);
      setSearchHasMore(hits.length > SEARCH_PAGE);
      setSearchHits((prev) => [...prev, ...hits.slice(0, SEARCH_PAGE)]);
      setSearchOffset((prev) => prev + SEARCH_PAGE);
    } catch {
      // Non-fatal; user can retry.
    } finally {
      setSearchLoadingMore(false);
    }
  }

  function openHit(hit: SearchHit) {
    const accounts = useAccountsStore.getState();
    const folder = accounts.folders.find(
      (f) => f.accountId === hit.accountId && f.path === hit.folderPath,
    );
    if (folder) {
      accounts.setActiveAccount(hit.accountId);
      accounts.setActiveFolder(folder.id);
      const synthetic: Thread = {
        id: hit.imapUid,
        accountId: hit.accountId,
        folderId: folder.id,
        subject: hit.subject ?? "(no subject)",
        snippet: hit.snippet ?? "",
        participants: [hit.fromAddress ?? "Unknown"],
        messageCount: 1,
        hasUnread: false,
        isPinned: !!(hit.isStarred),
        hasAttachments: false,
        lastMessageAt: (hit.receivedAt ?? 0) * 1000,
        category: null,
        messages: [],
      };
      useThreadsStore.getState().ensureThread(synthetic);
    } else {
      accounts.setActiveAccount(hit.accountId);
    }
    useUiStore.getState().selectThread(hit.imapUid);
  }

  function handleStarHit(hit: SearchHit) {
    const accounts = useAccountsStore.getState();
    const folder = accounts.folders.find(
      (f) => f.accountId === hit.accountId && f.path === hit.folderPath,
    );
    if (!folder) return;
    const nextStarred = !(hit.isStarred);
    setSearchHits((prev) =>
      prev.map((h) =>
        h.imapUid === hit.imapUid && h.folderPath === hit.folderPath
          ? { ...h, isStarred: nextStarred ? 1 : 0 }
          : h,
      ),
    );
    const synthetic: Thread = {
      id: hit.imapUid,
      accountId: hit.accountId,
      folderId: folder.id,
      subject: hit.subject ?? "(no subject)",
      snippet: hit.snippet ?? "",
      participants: [hit.fromAddress ?? "Unknown"],
      messageCount: 1,
      hasUnread: false,
      isPinned: !nextStarred,
      hasAttachments: false,
      lastMessageAt: (hit.receivedAt ?? 0) * 1000,
      category: null,
      messages: [],
    };
    useThreadsStore.getState().ensureThread(synthetic);
    void useThreadsStore.getState().toggleStar(hit.imapUid).catch(() => {
      setSearchHits((prev) =>
        prev.map((h) =>
          h.imapUid === hit.imapUid && h.folderPath === hit.folderPath
            ? { ...h, isStarred: nextStarred ? 0 : 1 }
            : h,
        ),
      );
    });
  }

  const setThreads = useThreadsStore((s) => s.setThreads);
  useEffect(() => {
    if (activeAccountId && activeFolder) {
      // Clear stale threads immediately so the previous folder's emails
      // never linger while the new folder loads.
      setThreads([]);
      fetchFolder(activeAccountId, activeFolder.path, activeFolder.id);
    }
    // Changing folder should drop any bulk selection and search query from the previous folder.
    clearSelection();
    setListQuery("");
  }, [activeAccountId, activeFolder?.id, activeFolder?.path, fetchFolder, clearSelection, setThreads, setListQuery]);

  // Also clear search query whenever activeFolderId changes (covers cases where
  // activeFolder object reference doesn't change but the folder ID does).
  useEffect(() => {
    setListQuery("");
  }, [activeFolderId, setListQuery]);

  // Load all starred messages from DB when the starred view is activated.
  useEffect(() => {
    if (starredView) void fetchAllStarred();
  }, [starredView, fetchAllStarred]);

  // When the user picks "Oldest first" we need all messages loaded so the
  // truly oldest ones appear at the top rather than just the oldest of the
  // first page.  Auto-page until hasMore is false whenever oldest is active —
  // but cap each burst so a 40 k folder doesn't trigger thousands of IMAP
  // round-trips before the UI is usable. The user can resume with the
  // "Load older messages" button.
  const MAX_AUTO_PAGES = 20; // ~1000 threads per burst at PAGE_SIZE=50
  const autoPageCountRef = useRef(0);
  const [autoPageHalted, setAutoPageHalted] = useState(false);

  useEffect(() => {
    autoPageCountRef.current = 0;
    setAutoPageHalted(false);
  }, [activeAccountId, activeFolderId, listSort]);

  useEffect(() => {
    if (
      listSort === "oldest" &&
      hasMore &&
      !loadingMore &&
      !loading &&
      activeAccountId != null &&
      activeFolder != null &&
      !autoPageHalted
    ) {
      if (autoPageCountRef.current >= MAX_AUTO_PAGES) {
        setAutoPageHalted(true);
        return;
      }
      autoPageCountRef.current += 1;
      void loadMore(activeAccountId, activeFolder.path, activeFolder.id);
    }
  }, [listSort, hasMore, loadingMore, loading, activeAccountId, activeFolder, loadMore, autoPageHalted]);

  const resumeAutoPage = useCallback(() => {
    autoPageCountRef.current = 0;
    setAutoPageHalted(false);
  }, []);

  // The Unread tab uses IMAP UID SEARCH UNSEEN under the hood — one round-
  // trip pulls every server-side unread message in the folder, no matter
  // how far back it sits. Re-run guard: only fire when we entered the tab
  // and the visible list is below the server-side unread count (otherwise
  // we'd thrash the inbox on every render).
  const unreadFetchedRef = useRef(false);
  useEffect(() => {
    unreadFetchedRef.current = false;
  }, [activeAccountId, activeFolderId, activeCategory]);

  const scopedThreads = useMemo(() => {
    // In starred view use the cross-account starredThreads list; otherwise use the folder threads.
    let list = starredView ? starredThreads : threads;
    if (listFilter === "unread") list = list.filter((t) => t.hasUnread);
    else if (listFilter === "attachments")
      list = list.filter((t) => t.hasAttachments);
    const q = listQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((t) => {
        if (t.subject && t.subject.toLowerCase().includes(q)) return true;
        if (t.snippet && t.snippet.toLowerCase().includes(q)) return true;
        return t.participants.some((p) => p.toLowerCase().includes(q));
      });
    }
    const sorted = [...list].sort((a, b) =>
      listSort === "oldest"
        ? a.lastMessageAt - b.lastMessageAt
        : b.lastMessageAt - a.lastMessageAt,
    );
    return sorted;
  }, [threads, starredThreads, starredView, listFilter, listSort, listQuery]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, people: 0, newsletters: 0, notifications: 0 };
    for (const t of scopedThreads) {
      if (!t.hasUnread) continue;
      c.all = (c.all ?? 0) + 1;
      if (t.category && c[t.category] !== undefined) {
        c[t.category] = (c[t.category] ?? 0) + 1;
      }
    }
    return c;
  }, [scopedThreads]);

  const pinned = useMemo(
    () => (starredView ? [] : scopedThreads.filter((t) => t.isPinned)),
    [scopedThreads, starredView],
  );
  const visible = useMemo(
    () =>
      scopedThreads.filter((t) => {
        if (!starredView && t.isPinned) return false;
        if (activeCategory === "all") return true;
        if (activeCategory === "unread") return t.hasUnread;
        return t.category === activeCategory;
      }),
    [scopedThreads, starredView, activeCategory],
  );

  const orderedIds = useMemo(
    () => [...pinned.map((t) => t.id), ...visible.map((t) => t.id)],
    [pinned, visible],
  );

  // Single-shot pull of all server-side unread mail when the user lands on
  // the Unread tab. We only do this if the cached unread count is lower than
  // what the IMAP STATUS UNSEEN reports (i.e. the server has more unread
  // than we currently know about). Otherwise the cache already has them all.
  useEffect(() => {
    if (
      activeCategory !== "unread" ||
      unreadFetchedRef.current ||
      loadingMore ||
      loading ||
      activeAccountId == null ||
      activeFolder == null
    ) {
      return;
    }
    const serverUnread = activeFolder.unreadCount ?? 0;
    const cachedUnread = scopedThreads.filter((t) => t.hasUnread).length;
    if (serverUnread === 0 || cachedUnread >= serverUnread) {
      // Nothing to pull (no server unread, or our cache already covers it).
      unreadFetchedRef.current = true;
      return;
    }
    unreadFetchedRef.current = true;
    void fetchAllUnread(activeAccountId, activeFolder.path, activeFolder.id);
  }, [
    activeCategory,
    activeFolder,
    activeAccountId,
    loading,
    loadingMore,
    scopedThreads,
    fetchAllUnread,
  ]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  function handleContextMenu(thread: Thread, event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    setMenu({ thread, x: event.clientX, y: event.clientY });
  }

  function handleRowClick(thread: Thread, event: React.MouseEvent<HTMLButtonElement>) {
    if (event.shiftKey) {
      event.preventDefault();
      selectRange(thread.id, orderedIds);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSelection(thread.id);
      return;
    }
    clearSelection();
    selectThread(thread.id);
    // markRead now runs in App.tsx via a useEffect on selectedThreadId so
    // keyboard navigation (j/k, Enter, arrows) marks the thread too.
  }

  function refresh() {
    if (activeAccountId && activeFolder) {
      fetchFolder(activeAccountId, activeFolder.path, activeFolder.id);
    }
  }

  // Marks every UNREAD thread that's currently visible (respects category
  // tab, starred view, and the Filters dropdown). Threads hidden by the
  // current filter are left alone.
  const visibleUnreadIds = useMemo(() => {
    return scopedThreads
      .filter((t) => {
        if (!t.hasUnread) return false;
        if (activeCategory === "all" || activeCategory === "unread") return true;
        return t.category === activeCategory;
      })
      .map((t) => t.id);
  }, [scopedThreads, activeCategory]);

  function markAllVisibleAsRead() {
    if (visibleUnreadIds.length === 0) return;
    void markManyRead(visibleUnreadIds);
  }

  return (
    <section
      className="relative flex flex-col bg-raised border-r border-soft overflow-hidden"
      aria-label="Message list"
    >
      <header className="flex items-center gap-2 pl-3 pr-3 pt-3 pb-2 shrink-0">
        {/* Title block: allowed to shrink so a narrow message-list panel
            doesn't starve the search box. Title truncates with an ellipsis
            instead. */}
        <div className="min-w-0 shrink">
          <h1 className="text-[16px] font-semibold text-primary truncate">
            {starredView ? "Starred" : activeFolder?.name ?? "Inbox"}
          </h1>
          <p className="text-[11.5px] text-muted tabular-nums">
            {loading
              ? "Loading…"
              : `${scopedThreads.length} conversations${counts.all ? ` · ${counts.all} unread` : ""}`}
          </p>
          {syncStatus && syncStatus.total_local > 0 && (() => {
            const indexed = syncStatus.total_indexed;
            const total = syncStatus.total_local;
            const withBody = syncStatus.total_with_body;
            const attachable = syncStatus.total_with_attachable;
            const withAttText = syncStatus.total_with_attachment_text;
            const pendingNoSi = syncStatus.pending_no_si;
            const pendingBody = syncStatus.pending_index;
            const indexedPct = Math.round((indexed / total) * 100);
            const bodyPct = Math.round((withBody / total) * 100);
            // attachment-coverage % only counts toward "ok" when there ARE
            // some indexable attachments; otherwise the segment is hidden.
            const attPct = attachable > 0 ? Math.round((withAttText / attachable) * 100) : 100;
            // Color states:
            //   green: ≥98% indexed AND ≥95% with body text AND ≥80% attachments
            //   amber: ≥80% indexed
            //   red:   <80% indexed (significant gap)
            const ok = indexedPct >= 98 && bodyPct >= 95 && attPct >= 80;
            const partial = !ok && indexedPct >= 80;
            const dotClass = ok
              ? "bg-emerald-500"
              : partial
                ? "bg-amber-500"
                : "bg-rose-500";
            const attachSegment = attachable > 0 ? ` · attach ${withAttText}/${attachable}` : "";
            const label = ok
              ? "Search index complete"
              : `Search indexed: ${indexed}/${total} headers, ${withBody}/${total} bodies${attachable > 0 ? `, ${withAttText}/${attachable} attachments` : ""}${pendingNoSi > 0 ? ` · ${pendingNoSi} missing index` : ""}${pendingBody > 0 ? ` · ${pendingBody} bodies pending` : ""}`;
            return (
              <p
                className="text-[10.5px] text-muted tabular-nums flex items-center gap-1.5 mt-0.5"
                title={label + (ok ? "" : " · Click the database icon to reindex")}
              >
                <span className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", dotClass)} />
                <span className="truncate">
                  {ok
                    ? `Indexed ${indexed}/${total}${attachSegment}`
                    : `Indexed ${indexed}/${total} · bodies ${withBody}/${total}${attachSegment}`}
                </span>
              </p>
            );
          })()}
        </div>

        {/* Search box. A 140px minimum guarantees the icon + a few chars of
            placeholder remain visible even when the message-list panel is
            dragged very narrow. We also use the slightly stronger
            `--bg-soft` background and `--border-strong` border so the box
            stays visually distinct against `--bg-raised` instead of fading
            into the header. */}
        <div
          className="flex h-8 flex-1 min-w-[140px] max-w-xl items-center gap-2 rounded-full px-3 transition-colors"
          style={{
            background: "var(--bg-soft)",
            border: `1px solid ${
              listQuery ? "var(--accent)" : "var(--border-strong, var(--border-soft))"
            }`,
          }}
          onClick={() => searchRef.current?.focus()}
        >
          <SearchIcon size={13} className="text-muted shrink-0" />
          <input
            id="blesus-titlebar-search"
            ref={searchRef}
            value={listQuery}
            onChange={(e) => setListQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setListQuery("");
                searchRef.current?.blur();
              }
            }}
            placeholder="Search mailbox…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[12.5px] text-primary placeholder:text-muted"
          />
          {listQuery ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setListQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
              className="text-muted hover:text-primary shrink-0"
            >
              <XIcon size={13} />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); startReindex(e.shiftKey); }}
              disabled={reindexing}
              title="Reindex all mail · Shift+click to force re-OCR"
              className="text-muted hover:text-primary shrink-0 disabled:opacity-40"
            >
              {reindexing
                ? <RefreshCw size={12} className="animate-spin" />
                : <Database size={12} className={reindexDone ? "text-emerald-500" : ""} />}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <HeaderButton onClick={refresh} disabled={loading} title="Refresh">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </HeaderButton>
          <HeaderButton
            onClick={markAllVisibleAsRead}
            disabled={visibleUnreadIds.length === 0}
            title={
              visibleUnreadIds.length === 0
                ? "Nothing unread in view"
                : `Mark ${visibleUnreadIds.length} as read`
            }
          >
            <CheckCheck size={14} />
          </HeaderButton>
          <FilterMenu value={listFilter} onChange={setListFilter} />
          <SortMenu value={listSort} onChange={setListSort} />
        </div>
      </header>

      <ConfirmDialog
        open={confirmReindex}
        title="Reindex all mail"
        message="This will download all message bodies and extract text from attachments (including OCR for image-only PDFs). Already-indexed attachments are skipped. Continue?"
        confirmLabel="Start reindex"
        onConfirm={() => { setConfirmReindex(false); void indexAllMail(); }}
        onCancel={() => setConfirmReindex(false)}
      />

      <ConfirmDialog
        open={confirmForceReOcr}
        title="Force re-OCR all attachments"
        message="This will re-run OCR on every attachment, overwriting previously indexed text and bounding box cache. Use this to rebuild the database with Windows OCR. Continue?"
        confirmLabel="Force re-OCR"
        onConfirm={() => { setConfirmForceReOcr(false); void indexAllMail({ forceReOcr: true }); }}
        onCancel={() => setConfirmForceReOcr(false)}
      />

      {reindexProgress && (
        <div className="shrink-0 border-b border-soft">
          <div className="h-0.5 overflow-hidden" style={{ background: "var(--bg-soft)" }}>
            <div
              className="h-full transition-all duration-300 ease-out"
              style={{ width: `${reindexProgress.pct}%`, background: "var(--accent)" }}
            />
          </div>
          <div className="px-4 py-1.5 flex items-center gap-1.5">
            <Loader2 size={9} className="animate-spin shrink-0 text-muted" />
            <span className="text-[10.5px] text-muted truncate leading-none">
              {reindexProgress.label}
            </span>
          </div>
        </div>
      )}

      <CategoryTabs counts={counts} />

      <div className="flex-1 min-h-0 flex flex-col">
        {listQuery.trim() ? (
          // ── Search results ────────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto">
            {searchLoading && searchHits.length === 0 && (
              <div className="px-4 py-6 text-[12.5px] text-muted text-center">Searching…</div>
            )}
            {!searchLoading && searchHits.length === 0 && (
              <div className="px-4 py-6 text-[12.5px] text-muted text-center">
                No results for &ldquo;{listQuery.trim()}&rdquo;
              </div>
            )}
            {searchHits.length > 0 && (() => {
              const dateStartIdx = searchHits.findIndex((h) => h.rank === 0);
              const hasBm25 = dateStartIdx !== 0; // first hit has a BM25 score
              const hasDate = dateStartIdx !== -1; // at least one date-sorted hit
              return (
                <>
                  {hasBm25 && <ListSectionHeader>Relevant</ListSectionHeader>}
                  {!hasBm25 && <ListSectionHeader>Newest to oldest</ListSectionHeader>}
                  {searchHits.map((hit, i) => (
                    <Fragment key={`${hit.accountId}-${hit.folderPath}-${hit.imapUid}`}>
                      {hasDate && hasBm25 && i === dateStartIdx && (
                        <ListSectionHeader>Newest to oldest</ListSectionHeader>
                      )}
                      <SearchHitRow
                        hit={hit}
                        selected={selectedThreadId === hit.imapUid}
                        onClick={() => openHit(hit)}
                        onToggleStar={() => handleStarHit(hit)}
                      />
                    </Fragment>
                  ))}
                </>
              );
            })()}
            {searchHits.length > 0 && (
              <div className="px-4 py-2 text-center text-[11px] text-muted">
                {searchHits.length} result{searchHits.length === 1 ? "" : "s"}
              </div>
            )}
            {searchHasMore && (
              <div className="flex items-center justify-center py-4">
                <button
                  type="button"
                  disabled={searchLoadingMore}
                  onClick={() => void loadMoreSearchResults()}
                  className="px-3 py-1.5 text-[12px] text-secondary hover:text-primary hover:bg-hover rounded-md transition-colors disabled:opacity-50"
                >
                  {searchLoadingMore ? "Loading…" : "Load more results"}
                </button>
              </div>
            )}
          </div>
        ) : (
          // ── Normal thread list (virtualized) ──────────────────────────────
          <NormalThreadList
            error={error}
            refresh={refresh}
            isDraftsFolder={isDraftsFolder}
            localDrafts={localDrafts}
            setLocalDrafts={setLocalDrafts}
            openFromDraft={openFromDraft}
            bumpDraftKey={bumpDraftKey}
            listSort={listSort}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loading={loading}
            pinned={pinned}
            visible={visible}
            selectedThreadId={selectedThreadId}
            selectedSet={selectedSet}
            handleRowClick={handleRowClick}
            toggleSelection={toggleSelection}
            handleContextMenu={handleContextMenu}
            archiveThread={archiveThread}
            trashThread={trashThread}
            permanentDeleteThread={permanentDeleteThread}
            selectThread={selectThread}
            activeFolder={activeFolder}
            activeAccountId={activeAccountId}
            activeCategory={activeCategory}
            loadMore={loadMore}
            autoPageHalted={autoPageHalted}
            resumeAutoPage={resumeAutoPage}
          />
        )}
      </div>

      {selectedIds.length > 0 && <BulkActionBar count={selectedIds.length} />}
      {menu && <RowContextMenu state={menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function BulkActionBar({ count }: { count: number }) {
  const selectedIds = useUiStore((s) => s.selectedIds);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const selectThread = useUiStore((s) => s.selectThread);
  const archiveMany = useThreadsStore((s) => s.archiveMany);
  const trashThread = useThreadsStore((s) => s.trashThread);
  const permanentDeleteThread = useThreadsStore((s) => s.permanentDeleteThread);
  const toggleStarMany = useThreadsStore((s) => s.toggleStarMany);
  const mergeThreads = useThreadsStore((s) => s.mergeThreads);

  function isInTrashFolder() {
    const { folders, activeFolderId } = useAccountsStore.getState();
    const f = folders.find((fl) => fl.id === activeFolderId);
    const leaf = (f?.path ?? "").split(/[\/. \\]/).filter(Boolean).pop() ?? "";
    return (
      f?.specialUse === "trash" ||
      /^(trash|deleted(\s*items?)?)$/i.test(f?.name ?? "") ||
      /^(trash|deleted(\s*items?)?)$/i.test(leaf)
    );
  }

  async function runArchive() {
    const ids = [...selectedIds];
    clearSelection();
    await archiveMany(ids);
  }
  async function runTrash() {
    const ids = [...selectedIds];
    clearSelection();
    if (isInTrashFolder()) {
      await Promise.all(ids.map((id) => permanentDeleteThread(id)));
    } else {
      await Promise.all(ids.map((id) => trashThread(id)));
    }
  }
  async function runStar() {
    const ids = [...selectedIds];
    await toggleStarMany(ids);
  }

  async function runMerge() {
    if (selectedIds.length < 2) return;
    const [primaryId, ...secondaryIds] = [...selectedIds];
    clearSelection();
    selectThread(primaryId!);
    await mergeThreads(primaryId!, secondaryIds);
  }

  const inTrash = isInTrashFolder();

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      style={{
        background: "var(--bg-raised)",
        borderColor: "var(--border-strong)",
        boxShadow: "var(--shadow-md)",
      }}
      className="absolute left-3 right-3 bottom-3 flex items-center gap-1 rounded-xl border px-3 py-2"
    >
      <span className="text-[12.5px] text-primary font-medium mr-2 tabular-nums">
        {count} selected
      </span>
      <BulkButton label="Star / unstar" onClick={runStar}>
        <Star size={14} />
      </BulkButton>
      {count >= 2 && (
        <BulkButton label="Merge into one thread" onClick={runMerge}>
          <Merge size={14} />
        </BulkButton>
      )}
      <BulkButton label="Archive" onClick={runArchive}>
        <Archive size={14} />
      </BulkButton>
      <BulkButton label={inTrash ? "Delete permanently" : "Trash"} onClick={runTrash} danger>
        <Trash2 size={14} />
      </BulkButton>
      <div className="flex-1" />
      <BulkButton label="Clear selection" onClick={clearSelection}>
        <XIcon size={14} />
      </BulkButton>
    </div>
  );
}

function BulkButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        "text-secondary hover:bg-hover hover:text-primary",
        danger && "hover:text-[color:var(--color-danger)]",
      )}
    >
      {children}
    </button>
  );
}

function HeaderButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md px-2 text-muted",
        "hover:bg-hover hover:text-primary transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

function DraftRow({ draft, onClick, onDelete }: { draft: StoredDraft; onClick: () => void; onDelete: () => void }) {
  const recipientRaw = draft.to_addresses?.split(",")[0]?.trim() ?? "";
  const recipientName = recipientRaw ? (addressName(recipientRaw) || recipientRaw) : "(No recipient)";
  const subjectText = draft.subject?.trim() || "(No subject)";
  const { primary, secondary } = formatDateStack(
    draft.updated_at ? draft.updated_at * 1000 : 0,
  );

  return (
    <div className="relative group flex items-start gap-3 pl-7 pr-4 py-3 border-b border-soft/50 hover:bg-hover transition-colors">
      <button
        type="button"
        onClick={onClick}
        className="flex items-start gap-3 flex-1 min-w-0 text-left"
      >
        <div className="mt-1 shrink-0 w-7 h-7 rounded-full bg-amber-500/15 flex items-center justify-center">
          <Pencil size={13} className="text-amber-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-primary truncate">{recipientName}</span>
            <div className="shrink-0 text-right">
              <span className="text-[11.5px] text-muted">{primary}</span>
              {secondary && <span className="block text-[10.5px] text-disabled">{secondary}</span>}
            </div>
          </div>
          <div className="text-[12.5px] text-secondary truncate">{subjectText}</div>
          <div className="text-[11px] text-amber-500 font-medium mt-0.5">Draft</div>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete draft"
        aria-label="Delete draft"
        className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-[color:var(--color-danger)] hover:bg-hover transition-all"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function ListSectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="pl-7 pr-4 pt-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-disabled">
      {children}
    </div>
  );
}

function FilterMenu({
  value,
  onChange,
}: {
  value: ListFilter;
  onChange: (v: ListFilter) => void;
}) {
  const options: ReadonlyArray<{ value: ListFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread only" },
    { value: "attachments", label: "Has attachments" },
  ];
  const active = value !== "all";
  return (
    <HeaderPopover
      trigger={
        <HeaderButton title="Filters">
          <SlidersHorizontal
            size={14}
            style={active ? { color: "var(--accent)" } : undefined}
          />
        </HeaderButton>
      }
    >
      {(close) => (
        <>
          {options.map((o) => (
            <MenuRow
              key={o.value}
              selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                close();
              }}
            >
              {o.label}
            </MenuRow>
          ))}
        </>
      )}
    </HeaderPopover>
  );
}

function SortMenu({
  value,
  onChange,
}: {
  value: ListSort;
  onChange: (v: ListSort) => void;
}) {
  const options: ReadonlyArray<{ value: ListSort; label: string }> = [
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
  ];
  const label = options.find((o) => o.value === value)?.label ?? "Newest";
  return (
    <HeaderPopover
      trigger={
        <HeaderButton title="Sort">
          <span className="text-[12px] mr-1">{label}</span>
          <ChevronDown size={13} />
        </HeaderButton>
      }
    >
      {(close) => (
        <>
          {options.map((o) => (
            <MenuRow
              key={o.value}
              selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                close();
              }}
            >
              {o.label}
            </MenuRow>
          ))}
        </>
      )}
    </HeaderPopover>
  );
}

function HeaderPopover({
  trigger,
  children,
}: {
  trigger: React.ReactElement<{ onClick?: () => void }>;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      )
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerWithHandler = {
    ...trigger,
    props: {
      ...trigger.props,
      onClick: () => setOpen((v) => !v),
    },
  } as React.ReactElement;

  return (
    <div ref={wrapperRef} className="relative">
      {triggerWithHandler}
      {open && (
        <div
          role="menu"
          style={{
            background: "var(--bg-raised)",
            borderColor: "var(--border-strong)",
            boxShadow: "var(--shadow-md)",
          }}
          className="absolute right-0 top-full mt-1 z-40 min-w-[180px] rounded-lg border py-1"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  children,
  selected,
  onClick,
}: {
  children: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-primary hover:bg-hover"
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center shrink-0">
        {selected && <Check size={13} style={{ color: "var(--accent)" }} />}
      </span>
      <span className="flex-1">{children}</span>
    </button>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-4 my-3 rounded-lg border border-[color:var(--color-danger)] bg-[color:rgba(229,72,77,0.08)] px-3 py-2 flex items-start gap-2">
      <AlertCircle size={14} className="text-[color:var(--color-danger)] mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] text-primary font-medium">Could not load messages</p>
        <p className="text-[11.5px] text-muted mt-0.5 break-words">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="text-[12px] text-accent hover:underline shrink-0"
      >
        Retry
      </button>
    </div>
  );
}

function SearchHitRow({
  hit,
  selected,
  onClick,
  onToggleStar,
}: {
  hit: SearchHit;
  selected: boolean;
  onClick: () => void;
  onToggleStar: () => void;
}) {
  const sender = addressName(hit.fromAddress ?? "") || hit.fromAddress || "Unknown";
  const { primary } = formatDateStack((hit.receivedAt ?? 0) * 1000);
  const starred = !!(hit.isStarred);
  return (
    <div
      style={selected ? { background: "var(--bg-selected)" } : undefined}
      className="flex items-center w-full border-b border-soft/50 hover:bg-hover transition-colors"
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
        aria-label={starred ? "Unstar" : "Star"}
        className="shrink-0 pl-4 pr-1 py-3 flex items-center justify-center transition-colors"
        style={{ color: starred ? "var(--accent)" : "var(--text-disabled)", opacity: starred ? 1 : 0.5 }}
      >
        <Star size={14} fill={starred ? "currentColor" : "none"} strokeWidth={starred ? 1.5 : 2} />
      </button>
      <button
        type="button"
        onClick={onClick}
        className="flex items-start gap-3 flex-1 min-w-0 pr-4 py-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className="text-[13px] font-semibold text-primary truncate">{sender}</span>
            <span className="text-[11.5px] text-muted tabular-nums shrink-0">{primary}</span>
          </div>
          <div className="text-[12.5px] text-secondary truncate font-medium">
            {hit.subject || "(no subject)"}
          </div>
          {hit.snippet && (
            <div className="text-[11.5px] text-muted truncate mt-0.5">{hit.snippet}</div>
          )}
          <div className="text-[10.5px] text-disabled truncate mt-0.5">{hit.folderPath}</div>
        </div>
      </button>
    </div>
  );
}

// ── Virtualized normal thread list ─────────────────────────────────────────

type NormalRow =
  | { kind: "error"; message: string }
  | { kind: "draft-header" }
  | { kind: "draft"; draft: StoredDraft }
  | { kind: "oldest-banner" }
  | { kind: "pinned-header" }
  | { kind: "pinned"; thread: Thread }
  | { kind: "inbox-header" }
  | { kind: "message"; thread: Thread };

interface NormalThreadListProps {
  error: string | null;
  refresh: () => void;
  isDraftsFolder: boolean;
  localDrafts: StoredDraft[];
  setLocalDrafts: React.Dispatch<React.SetStateAction<StoredDraft[]>>;
  openFromDraft: (d: StoredDraft) => void;
  bumpDraftKey: () => void;
  listSort: ListSort;
  hasMore: boolean;
  loadingMore: boolean;
  loading: boolean;
  pinned: Thread[];
  visible: Thread[];
  selectedThreadId: number | null;
  selectedSet: Set<number>;
  handleRowClick: (thread: Thread, e: React.MouseEvent<HTMLButtonElement>) => void;
  toggleSelection: (id: number) => void;
  handleContextMenu: (thread: Thread, e: React.MouseEvent<HTMLDivElement>) => void;
  archiveThread: (id: number) => Promise<void> | void;
  trashThread: (id: number) => Promise<void> | void;
  permanentDeleteThread: (id: number) => Promise<void> | void;
  selectThread: (id: number | null) => void;
  activeFolder: import("@/types").MailFolder | undefined;
  activeAccountId: number | null;
  activeCategory: string;
  loadMore: (accountId: number, folderPath: string, folderId: number) => Promise<void> | void;
  autoPageHalted: boolean;
  resumeAutoPage: () => void;
}

function NormalThreadList(props: NormalThreadListProps) {
  const {
    error, refresh, isDraftsFolder, localDrafts, setLocalDrafts,
    openFromDraft, bumpDraftKey, listSort, hasMore, loadingMore, loading,
    pinned, visible, selectedThreadId, selectedSet,
    handleRowClick, toggleSelection, handleContextMenu,
    archiveThread, trashThread, permanentDeleteThread, selectThread,
    activeFolder, activeAccountId, activeCategory, loadMore,
    autoPageHalted, resumeAutoPage,
  } = props;

  const isTrash =
    activeFolder?.specialUse === "trash" ||
    /^(trash|deleted(\s*items?)?)$/i.test(activeFolder?.name ?? "");

  const rows = useMemo<NormalRow[]>(() => {
    const out: NormalRow[] = [];
    if (error) out.push({ kind: "error", message: error });
    if (isDraftsFolder && localDrafts.length > 0) {
      out.push({ kind: "draft-header" });
      for (const d of localDrafts) out.push({ kind: "draft", draft: d });
    }
    if (listSort === "oldest" && (hasMore || loadingMore) && !autoPageHalted) {
      out.push({ kind: "oldest-banner" });
    }
    if (pinned.length > 0) {
      out.push({ kind: "pinned-header" });
      for (const t of pinned) out.push({ kind: "pinned", thread: t });
    }
    if (visible.length > 0) {
      if (pinned.length > 0) out.push({ kind: "inbox-header" });
      for (const t of visible) out.push({ kind: "message", thread: t });
    }
    return out;
  }, [error, isDraftsFolder, localDrafts, listSort, hasMore, loadingMore, pinned, visible, autoPageHalted]);

  const computeItemKey = useCallback((index: number, row: NormalRow) => {
    switch (row.kind) {
      case "error": return "error";
      case "draft-header": return "draft-header";
      case "draft": return `draft-${row.draft.id}`;
      case "oldest-banner": return "oldest-banner";
      case "pinned-header": return "pinned-header";
      case "pinned": return `pinned-${row.thread.id}`;
      case "inbox-header": return "inbox-header";
      case "message": return `m-${row.thread.id}`;
      default: return `i-${index}`;
    }
  }, []);

  const renderRow = useCallback((_: number, row: NormalRow) => {
    switch (row.kind) {
      case "error":
        return <ErrorBanner message={row.message} onRetry={refresh} />;
      case "draft-header":
        return <ListSectionHeader>Local drafts</ListSectionHeader>;
      case "draft":
        return (
          <DraftRow
            draft={row.draft}
            onClick={() => openFromDraft(row.draft)}
            onDelete={() => {
              void deleteDraft(row.draft.id)
                .then(() => {
                  setLocalDrafts((prev) => prev.filter((d) => d.id !== row.draft.id));
                  bumpDraftKey();
                })
                .catch(() => {});
            }}
          />
        );
      case "oldest-banner":
        return (
          <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-soft text-[11px] text-muted">
            <Loader2 size={9} className="animate-spin shrink-0" />
            <span>Loading older messages…</span>
          </div>
        );
      case "pinned-header":
        return <ListSectionHeader>Pinned</ListSectionHeader>;
      case "inbox-header":
        return <ListSectionHeader>Inbox</ListSectionHeader>;
      case "pinned":
      case "message": {
        const thread = row.thread;
        return (
          <MessageRow
            thread={thread}
            selected={thread.id === selectedThreadId}
            checked={selectedSet.has(thread.id)}
            onClick={(e) => handleRowClick(thread, e)}
            onToggleCheck={() => toggleSelection(thread.id)}
            onContextMenu={(e) => handleContextMenu(thread, e)}
            onArchive={() => { selectThread(null); void archiveThread(thread.id); }}
            onTrash={() => {
              selectThread(null);
              void (isTrash ? permanentDeleteThread(thread.id) : trashThread(thread.id));
            }}
          />
        );
      }
    }
  }, [
    refresh, openFromDraft, setLocalDrafts, bumpDraftKey,
    selectedThreadId, selectedSet, handleRowClick, toggleSelection, handleContextMenu,
    selectThread, archiveThread, trashThread, permanentDeleteThread, isTrash,
  ]);

  const showLoadMoreFooter =
    hasMore && (listSort !== "oldest" || autoPageHalted) && activeAccountId != null && !!activeFolder && !loading;

  const virtuosoComponents = useMemo(() => {
    if (!showLoadMoreFooter) return {};
    return {
      Footer: () => (
        <div className="flex items-center justify-center py-4">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => {
              if (autoPageHalted) resumeAutoPage();
              void loadMore(activeAccountId!, activeFolder!.path, activeFolder!.id);
            }}
            className="px-3 py-1.5 text-[12px] text-secondary hover:text-primary hover:bg-hover rounded-md transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load older messages"}
          </button>
        </div>
      ),
    };
  }, [showLoadMoreFooter, loadingMore, autoPageHalted, resumeAutoPage, loadMore, activeAccountId, activeFolder]);

  // Empty state when there's no error, no drafts, no pinned, no visible.
  if (rows.length === 0 && !loading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex flex-col items-center justify-center pt-16 gap-3 text-muted text-[12.5px]">
          {activeCategory === "unread" && loadingMore ? (
            <span>Loading unread messages…</span>
          ) : (
            <span>
              {activeCategory === "unread"
                ? "No unread conversations found."
                : "No conversations in this folder."}
            </span>
          )}
        </div>
        {hasMore && (listSort !== "oldest" || autoPageHalted) && activeAccountId != null && activeFolder && (
          <div className="flex items-center justify-center py-4">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => {
                if (autoPageHalted) resumeAutoPage();
                void loadMore(activeAccountId, activeFolder.path, activeFolder.id);
              }}
              className="px-3 py-1.5 text-[12px] text-secondary hover:text-primary hover:bg-hover rounded-md transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load older messages"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Virtuoso<NormalRow>
      style={{ flex: 1 }}
      data={rows}
      computeItemKey={computeItemKey}
      itemContent={renderRow}
      increaseViewportBy={400}
      components={virtuosoComponents}
    />
  );
}
