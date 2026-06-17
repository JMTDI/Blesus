import { create } from "zustand";
import type { Attachment } from "@/lib/ipc";
import { loadAttachmentB64 } from "@/lib/attachmentCache";

export interface ActiveTrack {
  accountId: number;
  folderPath: string;
  /** IMAP uid of the message owning this attachment */
  uid: number;
  /** Thread id (for MessageRow indicator) */
  threadId: number;
  attachment: Attachment;
}

interface MediaPlayerState {
  /** The track we are loading / playing */
  track: ActiveTrack | null;
  objectUrl: string | null;
  loading: boolean;
  error: string | null;

  play: (track: ActiveTrack) => void;
  stop: () => void;
}

function revoke(url: string | null) {
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
}

export const useMediaPlayerStore = create<MediaPlayerState>((set, get) => ({
  track: null,
  objectUrl: null,
  loading: false,
  error: null,

  play: (track) => {
    const current = get();
    // Toggling the same track off
    if (
      current.track &&
      current.track.uid === track.uid &&
      current.track.attachment.index === track.attachment.index
    ) {
      revoke(current.objectUrl);
      set({ track: null, objectUrl: null, loading: false, error: null });
      return;
    }
    // Revoke previous object URL
    revoke(current.objectUrl);
    set({ track, objectUrl: null, loading: true, error: null });

    (async () => {
      try {
        const b64 = await loadAttachmentB64(
          track.accountId,
          track.folderPath,
          track.uid,
          track.attachment.index,
        );
        // Check we haven't been superseded
        if (get().track !== track) return;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: track.attachment.contentType });
        const url = URL.createObjectURL(blob);
        set({ objectUrl: url, loading: false });
      } catch (e) {
        if (get().track !== track) return;
        set({ error: String(e), loading: false });
      }
    })();
  },

  stop: () => {
    revoke(get().objectUrl);
    set({ track: null, objectUrl: null, loading: false, error: null });
  },
}));
