import { create } from "zustand";
import type { Theme, ReadingPane, Density, MailCategory } from "@/types";
import { getSettings, setSetting } from "@/lib/settings";

const KEY_THEME = "theme";
const KEY_READING_PANE = "reading_pane";
const KEY_DENSITY = "density";
const KEY_SIDEBAR = "sidebar_collapsed";
const KEY_LIST_WIDTH = "message_list_width";
const KEY_SYNC_INTERVAL = "sync_interval_ms";
const KEY_NOTIFICATIONS = "notifications_enabled";
const KEY_TASKBAR_BADGE = "taskbar_badge_enabled";
const KEY_REMOTE_IMAGES = "remote_images";
const KEY_LAUNCH_AT_LOGIN = "launch_at_login";
const KEY_CLOSE_TO_TRAY = "close_to_tray";
const KEY_UNDO_SEND_SEC = "undo_send_seconds";
const KEY_CONFIRM_SEND = "confirm_before_send";
const KEY_DONT_MARK_READ = "dont_mark_read_on_open";
const KEY_QUIET_HOURS_ENABLED = "quiet_hours_enabled";
const KEY_QUIET_HOURS_START = "quiet_hours_start";
const KEY_QUIET_HOURS_END = "quiet_hours_end";
const KEY_AUTO_OCR = "auto_ocr_on_arrival";
const KEY_FOLDER_AUTO_LOCK = "folder_auto_lock_minutes";

const LIST_WIDTH_MIN = 320;
const LIST_WIDTH_MAX = 720;
const LIST_WIDTH_DEFAULT = 460;

export const SYNC_INTERVAL_OPTIONS_MS = [0, 30_000, 60_000, 300_000, 900_000] as const;
export const UNDO_SEND_OPTIONS_SEC = [0, 5, 10, 30] as const;
export type RemoteImagesPolicy = "never" | "ask" | "always";
/** Auto-lock options in minutes. 0 = never. */
export const FOLDER_AUTO_LOCK_OPTIONS_MIN = [0, 5, 15, 30, 60, 240] as const;

export type ListFilter = "all" | "unread" | "attachments";
export type ListSort = "newest" | "oldest";

interface UiState {
  theme: Theme;
  readingPane: ReadingPane;
  density: Density;
  sidebarCollapsed: boolean;
  selectedThreadId: number | null;
  activeCategory: MailCategory | "all" | "unread";
  settingsOpen: boolean;
  settingsInitialSection: string | null;
  messageListWidth: number;
  starredView: boolean;
  selectedIds: number[];
  selectionAnchorId: number | null;
  syncIntervalMs: number;
  notificationsEnabled: boolean;
  taskbarBadgeEnabled: boolean;
  remoteImages: RemoteImagesPolicy;
  allowedImageUids: number[];
  launchAtLogin: boolean;
  closeToTray: boolean;
  undoSendSeconds: number;
  confirmBeforeSend: boolean;
  dontMarkReadOnOpen: boolean;
  quietHoursEnabled: boolean;
  /** "HH:MM", local time. Inclusive at start. */
  quietHoursStart: string;
  /** "HH:MM", local time. Exclusive at end. Window may wrap past midnight. */
  quietHoursEnd: string;
  autoOcr: boolean;
  /** Thread id awaiting a destination via the move-to-folder picker. Null
   *  when the picker is closed. */
  moveTargetThreadId: number | null;
  listFilter: ListFilter;
  listSort: ListSort;
  listQuery: string;
  /** Folder IDs that have a password set (loaded from DB on boot). */
  protectedFolderIds: Set<number>;
  /** Folder IDs unlocked this session (password verified). */
  unlockedFolderIds: Set<number>;
  /** Unix-ms timestamp when each folder was last unlocked, for auto-lock expiry. */
  unlockedAt: Record<number, number>;
  /** Minutes after unlock before auto-locking again. 0 = never. */
  folderAutoLockMinutes: number;
  setProtectedFolderIds: (ids: number[]) => void;
  markFolderProtected: (id: number) => void;
  unmarkFolderProtected: (id: number) => void;
  unlockFolder: (id: number) => void;
  lockFolder: (id: number) => void;
  setFolderAutoLockMinutes: (min: number) => void;
  /** Re-locks any unlocked folders whose unlock has exceeded the auto-lock timeout. */
  checkAutoLock: () => void;
  setTheme: (theme: Theme) => void;
  setReadingPane: (pane: ReadingPane) => void;
  setDensity: (density: Density) => void;
  toggleSidebar: () => void;
  selectThread: (id: number | null) => void;
  setActiveCategory: (category: MailCategory | "all" | "unread") => void;
  openSettings: () => void;
  openSettingsAt: (section: string) => void;
  closeSettings: () => void;
  setMessageListWidth: (width: number) => void;
  setStarredView: (on: boolean) => void;
  toggleSelection: (id: number) => void;
  selectRange: (toId: number, orderedIds: number[]) => void;
  clearSelection: () => void;
  setSyncIntervalMs: (ms: number) => void;
  setNotificationsEnabled: (on: boolean) => void;
  setTaskbarBadgeEnabled: (on: boolean) => void;
  setRemoteImages: (policy: RemoteImagesPolicy) => void;
  allowImagesForUid: (uid: number) => void;
  setLaunchAtLogin: (on: boolean) => void;
  setCloseToTray: (on: boolean) => void;
  setUndoSendSeconds: (sec: number) => void;
  setConfirmBeforeSend: (on: boolean) => void;
  setDontMarkReadOnOpen: (on: boolean) => void;
  setQuietHoursEnabled: (on: boolean) => void;
  setQuietHoursStart: (hhmm: string) => void;
  setQuietHoursEnd: (hhmm: string) => void;
  setAutoOcr: (on: boolean) => void;
  openMove: (threadId: number) => void;
  closeMove: () => void;
  setListFilter: (f: ListFilter) => void;
  setListSort: (s: ListSort) => void;
  setListQuery: (q: string) => void;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "black");
  const resolved: Theme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  if (resolved === "dark") root.classList.add("dark");
  if (resolved === "black") root.classList.add("black");
}

function persist(key: string, value: string | null) {
  void setSetting(key, value).catch(() => {});
}

let listWidthTimer: ReturnType<typeof setTimeout> | null = null;
function persistListWidth(width: number) {
  if (listWidthTimer) clearTimeout(listWidthTimer);
  listWidthTimer = setTimeout(() => {
    persist(KEY_LIST_WIDTH, String(width));
  }, 400);
}

export const useUiStore = create<UiState>((set) => ({
  theme: "dark",
  readingPane: "right",
  density: "comfortable",
  sidebarCollapsed: false,
  selectedThreadId: null,
  activeCategory: "all",
  settingsOpen: false,
  settingsInitialSection: null,
  messageListWidth: LIST_WIDTH_DEFAULT,
  starredView: false,
  selectedIds: [],
  selectionAnchorId: null,
  syncIntervalMs: 60_000,
  notificationsEnabled: true,
  taskbarBadgeEnabled: true,
  remoteImages: "ask",
  allowedImageUids: [],
  launchAtLogin: false,
  closeToTray: true,
  undoSendSeconds: 5,
  confirmBeforeSend: true,
  dontMarkReadOnOpen: false,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  autoOcr: true,
  moveTargetThreadId: null,
  listFilter: "all",
  listSort: "newest",
  listQuery: "",
  protectedFolderIds: new Set<number>(),
  unlockedFolderIds: new Set<number>(),
  unlockedAt: {},
  folderAutoLockMinutes: 0,
  setProtectedFolderIds: (ids) => set({ protectedFolderIds: new Set(ids) }),
  markFolderProtected: (id) =>
    set((s) => ({ protectedFolderIds: new Set([...s.protectedFolderIds, id]) })),
  unmarkFolderProtected: (id) =>
    set((s) => {
      const next = new Set(s.protectedFolderIds);
      next.delete(id);
      const unlocked = new Set(s.unlockedFolderIds);
      unlocked.delete(id);
      const unlockedAt = { ...s.unlockedAt };
      delete unlockedAt[id];
      return { protectedFolderIds: next, unlockedFolderIds: unlocked, unlockedAt };
    }),
  unlockFolder: (id) =>
    set((s) => ({
      unlockedFolderIds: new Set([...s.unlockedFolderIds, id]),
      unlockedAt: { ...s.unlockedAt, [id]: Date.now() },
    })),
  lockFolder: (id) =>
    set((s) => {
      const next = new Set(s.unlockedFolderIds);
      next.delete(id);
      const unlockedAt = { ...s.unlockedAt };
      delete unlockedAt[id];
      return { unlockedFolderIds: next, unlockedAt };
    }),
  setFolderAutoLockMinutes: (min) => {
    persist(KEY_FOLDER_AUTO_LOCK, String(min));
    set({ folderAutoLockMinutes: min });
  },
  checkAutoLock: () =>
    set((s) => {
      if (s.folderAutoLockMinutes === 0) return s;
      const thresholdMs = s.folderAutoLockMinutes * 60_000;
      const now = Date.now();
      const expired = Object.entries(s.unlockedAt).filter(
        ([, ts]) => now - ts >= thresholdMs,
      );
      if (expired.length === 0) return s;
      const next = new Set(s.unlockedFolderIds);
      const unlockedAt = { ...s.unlockedAt };
      for (const [idStr] of expired) {
        const id = Number(idStr);
        next.delete(id);
        delete unlockedAt[id];
      }
      return { unlockedFolderIds: next, unlockedAt };
    }),
  setTheme: (theme) => {
    applyTheme(theme);
    persist(KEY_THEME, theme);
    set({ theme });
  },
  setReadingPane: (readingPane) => {
    persist(KEY_READING_PANE, readingPane);
    set({ readingPane });
  },
  setDensity: (density) => {
    persist(KEY_DENSITY, density);
    set({ density });
  },
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      persist(KEY_SIDEBAR, next ? "1" : "0");
      return { sidebarCollapsed: next };
    }),
  selectThread: (id) => set({ selectedThreadId: id }),
  setActiveCategory: (category) => set({ activeCategory: category }),
  openSettings: () => set({ settingsOpen: true, settingsInitialSection: null }),
  openSettingsAt: (section) => set({ settingsOpen: true, settingsInitialSection: section }),
  closeSettings: () => set({ settingsOpen: false, settingsInitialSection: null }),
  setMessageListWidth: (w) => {
    const clamped = Math.min(Math.max(w, LIST_WIDTH_MIN), LIST_WIDTH_MAX);
    persistListWidth(clamped);
    set({ messageListWidth: clamped });
  },
  setStarredView: (on) => set({ starredView: on }),
  toggleSelection: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id);
      const selectedIds = has
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id];
      return { selectedIds, selectionAnchorId: id };
    }),
  selectRange: (toId, orderedIds) =>
    set((s) => {
      const anchor = s.selectionAnchorId ?? toId;
      const a = orderedIds.indexOf(anchor);
      const b = orderedIds.indexOf(toId);
      if (a === -1 || b === -1) return s;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const range = orderedIds.slice(lo, hi + 1);
      const union = Array.from(new Set([...s.selectedIds, ...range]));
      return { selectedIds: union, selectionAnchorId: toId };
    }),
  clearSelection: () => set({ selectedIds: [], selectionAnchorId: null }),
  setSyncIntervalMs: (ms) => {
    persist(KEY_SYNC_INTERVAL, String(ms));
    set({ syncIntervalMs: ms });
  },
  setNotificationsEnabled: (on) => {
    persist(KEY_NOTIFICATIONS, on ? "1" : "0");
    set({ notificationsEnabled: on });
  },
  setTaskbarBadgeEnabled: (on) => {
    persist(KEY_TASKBAR_BADGE, on ? "1" : "0");
    set({ taskbarBadgeEnabled: on });
  },
  setRemoteImages: (policy) => {
    persist(KEY_REMOTE_IMAGES, policy);
    set({ remoteImages: policy });
  },
  allowImagesForUid: (uid) =>
    set((s) =>
      s.allowedImageUids.includes(uid)
        ? s
        : { allowedImageUids: [...s.allowedImageUids, uid] },
    ),
  setLaunchAtLogin: (on) => {
    persist(KEY_LAUNCH_AT_LOGIN, on ? "1" : "0");
    set({ launchAtLogin: on });
  },
  setCloseToTray: (on) => {
    persist(KEY_CLOSE_TO_TRAY, on ? "1" : "0");
    set({ closeToTray: on });
  },
  setUndoSendSeconds: (sec) => {
    persist(KEY_UNDO_SEND_SEC, String(sec));
    set({ undoSendSeconds: sec });
  },
  setDontMarkReadOnOpen: (on) => {
    persist(KEY_DONT_MARK_READ, on ? "1" : "0");
    set({ dontMarkReadOnOpen: on });
  },
  setQuietHoursEnabled: (on) => {
    persist(KEY_QUIET_HOURS_ENABLED, on ? "1" : "0");
    set({ quietHoursEnabled: on });
  },
  setQuietHoursStart: (hhmm) => {
    persist(KEY_QUIET_HOURS_START, hhmm);
    set({ quietHoursStart: hhmm });
  },
  setQuietHoursEnd: (hhmm) => {
    persist(KEY_QUIET_HOURS_END, hhmm);
    set({ quietHoursEnd: hhmm });
  },
  setConfirmBeforeSend: (on) => {
    persist(KEY_CONFIRM_SEND, on ? "1" : "0");
    set({ confirmBeforeSend: on });
  },
  setAutoOcr: (on) => {
    persist(KEY_AUTO_OCR, on ? "1" : "0");
    set({ autoOcr: on });
  },
  openMove: (threadId) => set({ moveTargetThreadId: threadId }),
  closeMove: () => set({ moveTargetThreadId: null }),
  setListFilter: (f) => set({ listFilter: f }),
  setListSort: (s) => set({ listSort: s }),
  setListQuery: (q) => set({ listQuery: q }),
}));

function parseTheme(v: string | null): Theme | null {
  if (v === "light" || v === "dark" || v === "black" || v === "system") return v;
  return null;
}

function parsePane(v: string | null): ReadingPane | null {
  if (v === "right" || v === "bottom" || v === "off") return v;
  return null;
}

function parseDensity(v: string | null): Density | null {
  if (v === "compact" || v === "comfortable" || v === "spacious") return v;
  return null;
}

function parseWidth(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, LIST_WIDTH_MIN), LIST_WIDTH_MAX);
}

function parseSyncInterval(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return SYNC_INTERVAL_OPTIONS_MS.includes(n as typeof SYNC_INTERVAL_OPTIONS_MS[number])
    ? n
    : null;
}

function parseRemoteImages(v: string | null): RemoteImagesPolicy | null {
  if (v === "never" || v === "ask" || v === "always") return v;
  return null;
}

function parseHhmm(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function parseUndoSendSeconds(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return UNDO_SEND_OPTIONS_SEC.includes(n as typeof UNDO_SEND_OPTIONS_SEC[number])
    ? n
    : null;
}

export async function initializeUi(): Promise<void> {
  let stored: Record<string, string | null> = {};
  try {
    stored = await getSettings([
      KEY_THEME,
      KEY_READING_PANE,
      KEY_DENSITY,
      KEY_SIDEBAR,
      KEY_LIST_WIDTH,
      KEY_SYNC_INTERVAL,
      KEY_NOTIFICATIONS,
      KEY_TASKBAR_BADGE,
      KEY_REMOTE_IMAGES,
      KEY_LAUNCH_AT_LOGIN,
      KEY_CLOSE_TO_TRAY,
      KEY_DONT_MARK_READ,
      KEY_QUIET_HOURS_ENABLED,
      KEY_QUIET_HOURS_START,
      KEY_QUIET_HOURS_END,
      KEY_UNDO_SEND_SEC,
      KEY_CONFIRM_SEND,
      KEY_AUTO_OCR,
      KEY_FOLDER_AUTO_LOCK,
    ]);
  } catch {
    // Fall through to defaults if the DB is unavailable.
  }

  const theme = parseTheme(stored[KEY_THEME] ?? null) ?? useUiStore.getState().theme;
  const readingPane =
    parsePane(stored[KEY_READING_PANE] ?? null) ?? useUiStore.getState().readingPane;
  const density =
    parseDensity(stored[KEY_DENSITY] ?? null) ?? useUiStore.getState().density;
  const sidebarCollapsed = stored[KEY_SIDEBAR] === "1";
  const messageListWidth =
    parseWidth(stored[KEY_LIST_WIDTH] ?? null) ?? useUiStore.getState().messageListWidth;
  const syncIntervalMs =
    parseSyncInterval(stored[KEY_SYNC_INTERVAL] ?? null) ??
    useUiStore.getState().syncIntervalMs;
  const notificationsStored = stored[KEY_NOTIFICATIONS];
  const notificationsEnabled =
    notificationsStored == null
      ? useUiStore.getState().notificationsEnabled
      : notificationsStored !== "0";
  const taskbarBadgeStored = stored[KEY_TASKBAR_BADGE];
  const taskbarBadgeEnabled =
    taskbarBadgeStored == null
      ? useUiStore.getState().taskbarBadgeEnabled
      : taskbarBadgeStored !== "0";
  const remoteImages =
    parseRemoteImages(stored[KEY_REMOTE_IMAGES] ?? null) ??
    useUiStore.getState().remoteImages;
  const launchStored = stored[KEY_LAUNCH_AT_LOGIN];
  const launchAtLogin =
    launchStored == null ? useUiStore.getState().launchAtLogin : launchStored === "1";
  const trayStored = stored[KEY_CLOSE_TO_TRAY];
  const closeToTray =
    trayStored == null ? useUiStore.getState().closeToTray : trayStored === "1";
  const undoSendSeconds =
    parseUndoSendSeconds(stored[KEY_UNDO_SEND_SEC] ?? null) ??
    useUiStore.getState().undoSendSeconds;
  const confirmStored = stored[KEY_CONFIRM_SEND];
  const confirmBeforeSend =
    confirmStored == null
      ? useUiStore.getState().confirmBeforeSend
      : confirmStored !== "0";
  const dmrStored = stored[KEY_DONT_MARK_READ];
  const dontMarkReadOnOpen =
    dmrStored == null ? useUiStore.getState().dontMarkReadOnOpen : dmrStored === "1";
  const qhEnStored = stored[KEY_QUIET_HOURS_ENABLED];
  const quietHoursEnabled =
    qhEnStored == null
      ? useUiStore.getState().quietHoursEnabled
      : qhEnStored === "1";
  const quietHoursStart =
    parseHhmm(stored[KEY_QUIET_HOURS_START] ?? null) ??
    useUiStore.getState().quietHoursStart;
  const quietHoursEnd =
    parseHhmm(stored[KEY_QUIET_HOURS_END] ?? null) ??
    useUiStore.getState().quietHoursEnd;
  const autoOcrStored = stored[KEY_AUTO_OCR];
  const autoOcr =
    autoOcrStored == null ? useUiStore.getState().autoOcr : autoOcrStored !== "0";
  const alStored = stored[KEY_FOLDER_AUTO_LOCK];
  const folderAutoLockMinutes: number = (() => {
    if (alStored == null) return useUiStore.getState().folderAutoLockMinutes;
    const n = Number(alStored);
    return Number.isFinite(n) ? n : 0;
  })();

  useUiStore.setState({
    theme,
    readingPane,
    density,
    sidebarCollapsed,
    messageListWidth,
    syncIntervalMs,
    notificationsEnabled,
    taskbarBadgeEnabled,
    remoteImages,
    launchAtLogin,
    closeToTray,
    undoSendSeconds,
    confirmBeforeSend,
    dontMarkReadOnOpen,
    quietHoursEnabled,
    quietHoursStart,
    quietHoursEnd,
    autoOcr,
    folderAutoLockMinutes,
  });
  applyTheme(theme);
}
