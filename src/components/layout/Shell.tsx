import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { MessageList } from "@/components/layout/MessageList";
import { MessageView } from "@/components/layout/MessageView";
import { TitleBar } from "@/components/layout/TitleBar";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { Composer } from "@/components/composer/Composer";
import { MoveToFolderPicker } from "@/components/mail/MoveToFolderPicker";
import { SearchOverlay } from "@/components/mail/SearchOverlay";
import { Toaster } from "@/components/ui/Toaster";
import { useUiStore } from "@/stores/ui";
import { useAccountsStore } from "@/stores/accounts";
import { useMediaPlayerStore } from "@/stores/mediaPlayer";
const AttachmentPreviewModal = lazy(async () => {
  const mod = await import("@/components/mail/AttachmentPreview");
  return { default: mod.AttachmentPreviewModal };
});
const ImageGalleryModal = lazy(async () => {
  const mod = await import("@/components/mail/AttachmentPreview");
  return { default: mod.ImageGalleryModal };
});
import { useImageGalleryStore } from "@/stores/imageGallery";
import {
  X,
  Loader2,
  Music2,
  Lock,
} from "lucide-react";

function LockedFolderPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full text-muted select-none">
      <Lock size={32} className="opacity-40" />
      <p className="text-[13px] opacity-60">This folder is password protected.</p>
      <p className="text-[12px] opacity-40">Click the folder in the sidebar to unlock it.</p>
    </div>
  );
}

function PersistentMediaPlayer() {
  const track = useMediaPlayerStore((s) => s.track);
  const objectUrl = useMediaPlayerStore((s) => s.objectUrl);
  const loading = useMediaPlayerStore((s) => s.loading);
  const error = useMediaPlayerStore((s) => s.error);
  const stop = useMediaPlayerStore((s) => s.stop);

  const mediaRef = useRef<HTMLAudioElement & HTMLVideoElement>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  // Reset error when track changes
  useEffect(() => { setMediaError(null); }, [track]);

  // autoPlay is blocked by WebView2 after async src assignment; trigger play
  // from onCanPlay so the element is guaranteed to be in the DOM with a loaded src.
  function handleCanPlay() {
    const el = mediaRef.current;
    if (!el) return;
    el.play().catch((e: unknown) => {
      const msg = (e instanceof Error) ? `${e.name}: ${e.message}` : String(e);
      console.warn('[Audio] play() rejected:', msg);
      setMediaError(`Autoplay blocked — ${msg}`);
    });
  }

  if (!track) return null;

  const display = track.attachment.filename || `attachment-${track.attachment.index + 1}`;
  const isVideo =
    track.attachment.contentType.startsWith("video/") ||
    ["mp4", "webm", "mov", "avi", "mkv"].includes(
      (track.attachment.filename ?? "").split(".").pop()?.toLowerCase() ?? "",
    );

  return (
    <div
      className="border-t shrink-0"
      style={{
        background: "var(--bg-sunken)",
        borderColor: "var(--border-soft)",
      }}
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Music2 size={14} className="text-muted shrink-0" style={{ color: "var(--accent)" }} />
        <span className="text-[12px] font-medium text-secondary truncate flex-1 min-w-0">
          {display}
        </span>
        {loading && <Loader2 size={14} className="animate-spin text-muted shrink-0" />}
        {(error || mediaError) && (
          <span className="text-[11px] shrink-0" style={{ color: "var(--color-danger)" }}>
            {error ? "Failed to load" : mediaError}
          </span>
        )}
        <button
          type="button"
          onClick={stop}
          title="Close player"
          className="text-muted hover:text-primary transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>
      {objectUrl && !isVideo && (
        <audio
          ref={mediaRef}
          key={objectUrl}
          controls
          src={objectUrl}
          className="w-full px-4 pb-2"
          style={{ display: "block" }}
          onCanPlay={handleCanPlay}
          onError={() => {
            const el = mediaRef.current;
            const code = el?.error?.code ?? "?";
            const msg = el?.error?.message || "unknown";
            setMediaError(`Audio error ${code}: ${msg}`);
          }}
        />
      )}
      {objectUrl && isVideo && (
        <video
          ref={mediaRef}
          key={objectUrl}
          controls
          src={objectUrl}
          className="w-full max-h-64 px-4 pb-2"
          style={{ display: "block" }}
          onCanPlay={handleCanPlay}
          onError={() => {
            const el = mediaRef.current;
            const code = el?.error?.code ?? "?";
            const msg = el?.error?.message || "unknown";
            setMediaError(`Video error ${code}: ${msg}`);
          }}
        />
      )}
    </div>
  );
}

export function Shell() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const readingPane = useUiStore((s) => s.readingPane);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const messageListWidth = useUiStore((s) => s.messageListWidth);
  const setMessageListWidth = useUiStore((s) => s.setMessageListWidth);
  const protectedFolderIds = useUiStore((s) => s.protectedFolderIds);
  const unlockedFolderIds = useUiStore((s) => s.unlockedFolderIds);
  const folderAutoLockMinutes = useUiStore((s) => s.folderAutoLockMinutes);
  const checkAutoLock = useUiStore((s) => s.checkAutoLock);
  const starredView = useUiStore((s) => s.starredView);
  const { activeFolderId } = useAccountsStore();
  const gallerySessionId = useImageGalleryStore((s) => s.sessionId);
  const selectedThreadId = useUiStore((s) => s.selectedThreadId);
  const selectThread = useUiStore((s) => s.selectThread);
  const paneOffOpen = readingPane === "off" && selectedThreadId != null;

  const isFolderLocked =
    !starredView &&
    activeFolderId != null &&
    protectedFolderIds.has(activeFolderId) &&
    !unlockedFolderIds.has(activeFolderId);

  // Auto-lock timer: checks every 30 s, re-locks expired folders.
  useEffect(() => {
    if (folderAutoLockMinutes === 0) return;
    const id = setInterval(checkAutoLock, 30_000);
    return () => clearInterval(id);
  }, [folderAutoLockMinutes, checkAutoLock]);

  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeSettings();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, closeSettings]);

  // When reading pane is off, Escape closes the message overlay
  useEffect(() => {
    if (!paneOffOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") selectThread(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneOffOpen, selectThread]);

  const sidebarWidth = sidebarCollapsed ? 64 : 240;

  return (
    <div className="h-full flex flex-col bg-base">
      <TitleBar />
      <div
        className="flex-1 grid overflow-hidden"
        style={{
          gridTemplateColumns: settingsOpen
            ? "1fr"
            : readingPane === "right"
              ? `${sidebarWidth}px ${messageListWidth}px 6px 1fr`
              : `${sidebarWidth}px 1fr`,
        }}
      >
        {settingsOpen ? (
          <SettingsPage />
        ) : (
          <>
            <Sidebar />
            {isFolderLocked ? <LockedFolderPlaceholder /> : <MessageList />}
            {readingPane === "right" && !isFolderLocked && (
              <>
                <ResizeHandle
                  value={messageListWidth}
                  onChange={setMessageListWidth}
                />
                <MessageView />
              </>
            )}
            {paneOffOpen && !isFolderLocked && createPortal(
              <>
                <div className="fixed inset-x-0 bottom-0 z-[40]" style={{ top: 40 }}>
                  <MessageView fullHeight />
                </div>
                <Suspense fallback={null}>
                  <AttachmentPreviewModal />
                  <ImageGalleryModal key={gallerySessionId} />
                </Suspense>
              </>,
              document.body,
            )}
          </>
        )}
      </div>
      <Composer />
      <MoveToFolderPicker />
      <SearchOverlay />
      <PersistentMediaPlayer />
      <Suspense fallback={null}>
        <AttachmentPreviewModal />
        <ImageGalleryModal key={gallerySessionId} />
      </Suspense>
      <Toaster />
    </div>
  );
}
