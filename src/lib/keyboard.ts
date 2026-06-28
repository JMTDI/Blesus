import { useEffect } from "react";
import { useAccountsStore } from "@/stores/accounts";
import { useBodiesStore } from "@/stores/bodies";
import { useComposerStore } from "@/stores/composer";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { ipc } from "@/lib/ipc";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Global shortcuts that fire even while typing — the user expects
      // Ctrl+K and Ctrl+Q to work from anywhere, same as VSCode/Slack.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        void ipc.appQuit().catch(() => {});
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // The mailbox search lives in the titlebar above the message list.
        // Ctrl+K just focuses it — no overlay.
        const el = document.getElementById("blesus-titlebar-search") as HTMLInputElement | null;
        if (el) {
          el.focus();
          el.select();
        }
        return;
      }

      // Below this point: skip if typing in an input / contenteditable.
      if (isEditableTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const composer = useComposerStore.getState();
      if (composer.open) return;
      const ui = useUiStore.getState();
      if (ui.settingsOpen) return;

      // `threads` below is the VISIBLE, filtered list — the one the user
      // sees in the list pane. j/k/arrows, Shift-range, and "x" all navigate
      // this. Using the raw collection would let navigation jump to rows
      // hidden by the current category tab or starred filter.
      const rawThreads = useThreadsStore.getState().threads;
      const scoped = ui.starredView
        ? rawThreads.filter((t) => t.isPinned)
        : rawThreads;
      const pinned = ui.starredView ? [] : scoped.filter((t) => t.isPinned);
      const visible = scoped.filter((t) => {
        if (!ui.starredView && t.isPinned) return false;
        if (ui.activeCategory === "all") return true;
        return t.category === ui.activeCategory;
      });
      const threads = [...pinned, ...visible];

      // Row-actions (r/a/f/e/#/s/!) operate on whatever is shown in the
      // reader, even if that thread currently falls outside the active
      // category filter — so we look it up against the full list.
      const selectedId = ui.selectedThreadId;
      const selected =
        selectedId != null
          ? rawThreads.find((t) => t.id === selectedId) ?? null
          : null;

      const accounts = useAccountsStore.getState();
      const activeAccount = accounts.accounts.find(
        (a) => a.id === accounts.activeAccountId,
      );

      const bodyFor = (id: number) => useBodiesStore.getState().bodies[id];
      const hasSelection = ui.selectedIds.length > 0;

      const key = e.key;
      const shift = e.shiftKey;

      // --- Selection navigation (Shift+Arrow/j/k) -------------------------
      if (shift && (key === "ArrowDown" || key === "j")) {
        if (threads.length === 0) return;
        e.preventDefault();
        const anchor = ui.selectionAnchorId ?? selectedId ?? threads[0]?.id ?? null;
        if (anchor == null) return;
        const idx = threads.findIndex((t) => t.id === anchor);
        const nextIdx = Math.min((idx < 0 ? -1 : idx) + 1, threads.length - 1);
        const next = threads[nextIdx];
        if (!next) return;
        ui.selectRange(
          next.id,
          threads.map((t) => t.id),
        );
        return;
      }
      if (shift && (key === "ArrowUp" || key === "k")) {
        if (threads.length === 0) return;
        e.preventDefault();
        const anchor = ui.selectionAnchorId ?? selectedId ?? threads[0]?.id ?? null;
        if (anchor == null) return;
        const idx = threads.findIndex((t) => t.id === anchor);
        const prevIdx = Math.max((idx < 0 ? 0 : idx) - 1, 0);
        const prev = threads[prevIdx];
        if (!prev) return;
        ui.selectRange(
          prev.id,
          threads.map((t) => t.id),
        );
        return;
      }

      if (shift) return; // No other Shift combos.

      switch (key) {
        // --- Cycle category tabs -----------------------------------------
        case "ArrowRight":
        case "ArrowLeft": {
          e.preventDefault();
          const order: ReadonlyArray<
            "all" | "unread" | "people" | "newsletters" | "notifications"
          > = ["all", "unread", "people", "newsletters", "notifications"];
          const i = order.findIndex((x) => x === ui.activeCategory);
          const step = key === "ArrowRight" ? 1 : -1;
          const base = i < 0 ? 0 : i;
          const nextIdx = (base + step + order.length) % order.length;
          const next = order[nextIdx];
          if (next) ui.setActiveCategory(next);
          return;
        }

        // --- Single navigation -------------------------------------------
        case "ArrowDown":
        case "j": {
          if (threads.length === 0) return;
          e.preventDefault();
          const idx = selected ? threads.findIndex((t) => t.id === selected.id) : -1;
          const next = threads[Math.min(idx + 1, threads.length - 1)] ?? threads[0];
          if (next) ui.selectThread(next.id);
          return;
        }
        case "ArrowUp":
        case "k": {
          if (threads.length === 0) return;
          e.preventDefault();
          const idx = selected ? threads.findIndex((t) => t.id === selected.id) : 0;
          const prev = threads[Math.max(idx - 1, 0)] ?? threads[0];
          if (prev) ui.selectThread(prev.id);
          return;
        }
        case "Home": {
          if (threads.length === 0) return;
          e.preventDefault();
          const first = threads[0];
          if (first) ui.selectThread(first.id);
          return;
        }
        case "End": {
          if (threads.length === 0) return;
          e.preventDefault();
          const last = threads[threads.length - 1];
          if (last) ui.selectThread(last.id);
          return;
        }
        case "Enter":
        case "o": {
          if (selected || threads.length === 0) return;
          e.preventDefault();
          const first = threads[0];
          if (first) ui.selectThread(first.id);
          return;
        }
        case "u": {
          e.preventDefault();
          if (hasSelection) {
            ui.clearSelection();
            return;
          }
          if (ui.selectedThreadId != null) ui.selectThread(null);
          return;
        }
        case "Escape": {
          if (hasSelection) {
            e.preventDefault();
            ui.clearSelection();
            return;
          }
          if (ui.selectedThreadId != null) {
            e.preventDefault();
            ui.selectThread(null);
          }
          return;
        }

        // --- Focus search ------------------------------------------------
        case "/": {
          e.preventDefault();
          const el = document.getElementById("blesus-titlebar-search");
          if (el instanceof HTMLInputElement) {
            el.focus();
            el.select();
          }
          return;
        }

        // --- Toggle check on focused row ---------------------------------
        case "x": {
          const target = selected?.id ?? threads[0]?.id;
          if (target == null) return;
          e.preventDefault();
          ui.toggleSelection(target);
          return;
        }

        // --- Compose ------------------------------------------------------
        case "c": {
          e.preventDefault();
          useComposerStore.getState().openCompose(activeAccount?.signatureHtml ?? null);
          return;
        }
        case "r": {
          if (!selected) return;
          e.preventDefault();
          const body = bodyFor(selected.id);
          useComposerStore
            .getState()
            .openReply(
              selected,
              body?.html ?? null,
              body?.text ?? null,
              activeAccount?.signatureHtml ?? null,
              null,
              activeAccount?.email ?? null,
            );
          return;
        }
        case "a": {
          if (!selected || !activeAccount) return;
          e.preventDefault();
          const body = bodyFor(selected.id);
          useComposerStore
            .getState()
            .openReplyAll(
              selected,
              body?.html ?? null,
              body?.text ?? null,
              activeAccount.email,
              activeAccount.signatureHtml,
            );
          return;
        }
        case "f": {
          if (!selected) return;
          e.preventDefault();
          const body = bodyFor(selected.id);
          useComposerStore
            .getState()
            .openForward(
              selected,
              body?.html ?? null,
              body?.text ?? null,
              activeAccount?.signatureHtml ?? null,
            );
          return;
        }

        // --- Row / bulk actions ------------------------------------------
        case "e": {
          e.preventDefault();
          if (hasSelection) {
            const ids = [...ui.selectedIds];
            ui.clearSelection();
            void useThreadsStore.getState().archiveMany(ids);
            return;
          }
          if (!selected) return;
          ui.selectThread(null);
          void useThreadsStore.getState().archiveThread(selected.id);
          return;
        }
        case "#":
        case "Delete": {
          e.preventDefault();
          const { folders: kbFolders, activeFolderId: kbFolderId } = accounts;
          const kbActiveFolder = kbFolders.find((fl) => fl.id === kbFolderId);
          const kbLeaf = (kbActiveFolder?.path ?? "").split(/[\/. \\]/).filter(Boolean).pop() ?? "";
          const kbInTrash =
            kbActiveFolder?.specialUse === "trash" ||
            /^(trash|deleted(\s*items?)?)$/i.test(kbActiveFolder?.name ?? "") ||
            /^(trash|deleted(\s*items?)?)$/i.test(kbLeaf);
          if (hasSelection) {
            const ids = [...ui.selectedIds];
            ui.clearSelection();
            if (kbInTrash) {
              ids.forEach((id) => void useThreadsStore.getState().permanentDeleteThread(id));
            } else {
              void useThreadsStore.getState().trashMany(ids);
            }
            return;
          }
          if (!selected) return;
          ui.selectThread(null);
          if (kbInTrash) {
            void useThreadsStore.getState().permanentDeleteThread(selected.id);
          } else {
            void useThreadsStore.getState().trashThread(selected.id);
          }
          return;
        }
        case "s": {
          e.preventDefault();
          if (hasSelection) {
            void useThreadsStore.getState().toggleStarMany([...ui.selectedIds]);
            return;
          }
          if (!selected) return;
          void useThreadsStore.getState().toggleStar(selected.id);
          return;
        }
        case "!": {
          if (!selected) return;
          e.preventDefault();
          return;
        }
        case "m": {
          if (!selected) return;
          e.preventDefault();
          ui.openMove(selected.id);
          return;
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
