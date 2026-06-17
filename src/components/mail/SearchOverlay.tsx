import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon, Star } from "lucide-react";
import { countSearchIndexed, searchMessages, type SearchHit } from "@/lib/db";
import { indexAllMailForSearch, type FullSyncProgress } from "@/lib/fullSync";
import { useAccountsStore } from "@/stores/accounts";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { addressName, formatDateStack } from "@/lib/time";
import type { Thread } from "@/types";

const DEBOUNCE_MS = 150;
const MAX_RESULTS = 50;

export function SearchOverlay() {
  const open = useUiStore((s) => s.searchOpen);
  const closeSearch = useUiStore((s) => s.closeSearch);
  const searchInitialQuery = useUiStore((s) => s.searchInitialQuery);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [indexedCount, setIndexedCount] = useState<number | null>(null);
  const [syncProgress, setSyncProgress] = useState<FullSyncProgress | null>(null);
  const [syncDone, setSyncDone] = useState(false);
  const syncAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(searchInitialQuery);
    setHits([]);
    setCursor(0);
    setSyncDone(false);
    setSyncProgress(null);
    setTimeout(() => inputRef.current?.focus(), 20);
    // Load indexed count each time the overlay opens
    countSearchIndexed().then(setIndexedCount).catch(() => {});
  }, [open, searchInitialQuery]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setCursor(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const results = await searchMessages(q, MAX_RESULTS);
        if (cancelled) return;
        setHits(results);
        setCursor(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${cursor}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  // Cancel any running sync when the overlay closes
  useEffect(() => {
    if (!open) {
      syncAbortRef.current?.abort();
      syncAbortRef.current = null;
    }
  }, [open]);

  async function startIndexing() {
    const ctrl = new AbortController();
    syncAbortRef.current = ctrl;
    setSyncDone(false);
    setSyncProgress({ foldersDone: 0, foldersTotal: 0, currentFolder: "", messagesIndexed: 0 });
    try {
      await indexAllMailForSearch((p) => setSyncProgress(p), ctrl.signal);
      if (!ctrl.signal.aborted) {
        const count = await countSearchIndexed().catch(() => null);
        if (count !== null) setIndexedCount(count);
        setSyncDone(true);
        setSyncProgress(null);
      }
    } catch {
      setSyncProgress(null);
    }
    syncAbortRef.current = null;
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(0, hits.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) openHit(hit);
    }
  }

  function handleStarHit(hit: SearchHit, e: React.MouseEvent) {
    e.stopPropagation();
    const accounts = useAccountsStore.getState();
    const folder = accounts.folders.find(
      (f) => f.accountId === hit.accountId && f.path === hit.folderPath,
    );
    if (!folder) return;
    const nextStarred = !(hit.isStarred);
    // Optimistic UI update
    setHits((prev) =>
      prev.map((h) =>
        h.imapUid === hit.imapUid && h.folderPath === hit.folderPath
          ? { ...h, isStarred: nextStarred ? 1 : 0 }
          : h,
      ),
    );
    // Ensure a synthetic thread exists in the store for toggleStar
    const synthetic: Thread = {
      id: hit.imapUid,
      accountId: hit.accountId,
      folderId: folder.id,
      subject: hit.subject ?? "(no subject)",
      snippet: hit.snippet ?? "",
      participants: [hit.fromAddress ?? "Unknown"],
      messageCount: 1,
      hasUnread: false,
      isPinned: !nextStarred, // current state before toggle
      hasAttachments: false,
      lastMessageAt: (hit.receivedAt ?? 0) * 1000,
      category: null,
      messages: [],
    };
    useThreadsStore.getState().ensureThread(synthetic);
    void useThreadsStore.getState().toggleStar(hit.imapUid).catch(() => {
      // Revert on failure
      setHits((prev) =>
        prev.map((h) =>
          h.imapUid === hit.imapUid && h.folderPath === hit.folderPath
            ? { ...h, isStarred: nextStarred ? 0 : 1 }
            : h,
        ),
      );
    });
  }

  function openHit(hit: SearchHit) {
    const accounts = useAccountsStore.getState();
    const folder = accounts.folders.find(
      (f) => f.accountId === hit.accountId && f.path === hit.folderPath,
    );
    if (folder) {
      accounts.setActiveAccount(hit.accountId);
      accounts.setActiveFolder(folder.id);
      // Inject a synthetic thread so MessageView has header data even if the
      // message falls outside the latest-50 window being rendered in the list.
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
    closeSearch();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-24 px-6"
      role="dialog"
      aria-modal="true"
      onKeyDown={onKey}
      onClick={closeSearch}
    >
      <div
        style={{ background: "rgba(0,0,0,0.55)" }}
        className="absolute inset-0 backdrop-blur-sm"
        aria-hidden
      />
      <div
        style={{
          background: "var(--bg-raised)",
          borderColor: "var(--border-strong)",
          boxShadow: "var(--shadow-md)",
        }}
        className="relative w-full max-w-[720px] rounded-xl border overflow-hidden flex flex-col max-h-[min(560px,80vh)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderBottomColor: "var(--border-soft)" }}
        >
          <SearchIcon size={16} className="text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail — subject, sender, body…"
            className="flex-1 bg-transparent outline-none border-0 text-[14px] text-primary placeholder:text-disabled"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd
            className="rounded bg-sunken px-1.5 py-0.5 text-[10.5px] text-muted border border-soft"
            style={{ borderColor: "var(--border-soft)" }}
          >
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {loading && hits.length === 0 && (
            <div className="px-4 py-6 text-[12.5px] text-muted text-center">
              Searching…
            </div>
          )}
          {!loading && query.trim() && hits.length === 0 && (
            <div className="px-4 py-6 text-[12.5px] text-muted text-center">
              No matches for "{query.trim()}"
            </div>
          )}
          {!query.trim() && hits.length === 0 && (
            <div className="px-4 py-5 flex flex-col items-center gap-3">
              {syncProgress ? (
                <div className="w-full flex flex-col items-center gap-2">
                  <p className="text-[12px] text-muted text-center">
                    Indexing{syncProgress.currentFolder ? ` ${syncProgress.currentFolder}` : ""}…
                    {syncProgress.foldersTotal > 0 && (
                      <span className="ml-1 text-disabled">
                        ({syncProgress.foldersDone}/{syncProgress.foldersTotal} folders,{" "}
                        {syncProgress.messagesIndexed.toLocaleString()} messages)
                      </span>
                    )}
                  </p>
                  <div
                    className="w-full h-1 rounded-full overflow-hidden"
                    style={{ background: "var(--bg-sunken)" }}
                  >
                    {syncProgress.foldersTotal > 0 && (
                      <div
                        className="h-full rounded-full transition-all duration-200"
                        style={{
                          background: "var(--accent)",
                          width: `${Math.round((syncProgress.foldersDone / syncProgress.foldersTotal) * 100)}%`,
                        }}
                      />
                    )}
                  </div>
                  <button
                    className="text-[11px] text-muted underline underline-offset-2"
                    onClick={() => { syncAbortRef.current?.abort(); setSyncProgress(null); }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-[12px] text-muted text-center">
                    {syncDone
                      ? `Index updated — ${(indexedCount ?? 0).toLocaleString()} messages searchable.`
                      : indexedCount !== null && indexedCount > 0
                      ? `${indexedCount.toLocaleString()} messages indexed. Search, or re-index to catch up.`
                      : "Type to search conversations you've opened or synced. Results come from a local index — no cloud, no tracking."}
                  </p>
                  <button
                    className="rounded-md px-3 py-1.5 text-[12px] font-medium border transition-colors"
                    style={{
                      background: "var(--bg-raised)",
                      borderColor: "var(--border-strong)",
                      color: "var(--text-primary)",
                    }}
                    onClick={startIndexing}
                  >
                    {indexedCount !== null && indexedCount > 0
                      ? "Re-index all mail"
                      : "Index all mail"}
                  </button>
                </>
              )}
            </div>
          )}
          {hits.map((hit, idx) => {
            const active = idx === cursor;
            return (
              <HitRow
                key={`${hit.accountId}-${hit.folderPath}-${hit.imapUid}`}
                hit={hit}
                active={active}
                index={idx}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => openHit(hit)}
                onToggleStar={(e) => handleStarHit(hit, e)}
              />
            );
          })}
        </div>

        {hits.length > 0 && (
          <div
            className="flex items-center gap-3 px-4 py-2 border-t"
            style={{ borderTopColor: "var(--border-soft)" }}
          >
            <span className="text-[11px] text-muted">
              {hits.length} result{hits.length === 1 ? "" : "s"}
            </span>
            <div className="flex-1" />
            <ShortcutHint keys="↑ ↓" label="Navigate" />
            <ShortcutHint keys="↵" label="Open" />
            <ShortcutHint keys="Esc" label="Close" />
          </div>
        )}
      </div>
    </div>
  );
}

function HitRow({
  hit,
  active,
  index,
  onClick,
  onMouseEnter,
  onToggleStar,
}: {
  hit: SearchHit;
  active: boolean;
  index: number;
  onClick: () => void;
  onMouseEnter: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
}) {
  const sender = addressName(hit.fromAddress ?? "") || hit.fromAddress || "Unknown";
  const when = hit.receivedAt ? formatDateStack(hit.receivedAt * 1000) : null;
  const starred = !!(hit.isStarred);
  return (
    <div
      data-idx={index}
      onMouseEnter={onMouseEnter}
      style={active ? { background: "var(--bg-selected)" } : undefined}
      className={"flex items-center gap-1 w-full border-b transition-colors"}
    >
      <button
        type="button"
        onClick={onToggleStar}
        aria-label={starred ? "Unstar" : "Star"}
        className="shrink-0 pl-3 pr-1 py-2.5 flex items-center justify-center transition-colors"
        style={{ color: starred ? "var(--accent)" : "var(--text-disabled)", opacity: starred ? 1 : 0.5 }}
      >
        <Star
          size={14}
          fill={starred ? "currentColor" : "none"}
          strokeWidth={starred ? 1.5 : 2}
        />
      </button>
      <button
        type="button"
        onClick={onClick}
        className="flex items-start gap-3 flex-1 min-w-0 pr-4 py-2.5 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[13px] font-semibold text-primary truncate">
              {sender}
            </span>
            {when && (
              <span className="text-[11px] text-muted tabular-nums shrink-0">
                {when.primary}
              </span>
            )}
          </div>
          <div className="text-[12.5px] text-primary truncate font-medium">
            {hit.subject || "(no subject)"}
          </div>
          {hit.snippet && (
            <div className="text-[11.5px] text-muted truncate mt-0.5">
              {hit.snippet}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-[10.5px] text-muted">
      <kbd
        className="rounded bg-sunken px-1.5 py-0.5 border border-soft font-mono"
        style={{ borderColor: "var(--border-soft)" }}
      >
        {keys}
      </kbd>
      <span>{label}</span>
    </span>
  );
}
