import { create } from "zustand";
import type { Attachment } from "@/lib/ipc";
import { loadAttachmentB64 } from "@/lib/attachmentCache";

export interface PreviewTrack {
  accountId: number;
  folderPath: string;
  uid: number;
  attachment: Attachment;
}

interface AttachmentPreviewState {
  track: PreviewTrack | null;
  b64Data: string | null;
  loading: boolean;
  error: string | null;
  open: (track: PreviewTrack) => void;
  close: () => void;
}

export const useAttachmentPreviewStore = create<AttachmentPreviewState>((set, get) => ({
  track: null,
  b64Data: null,
  loading: false,
  error: null,

  open: (track) => {
    const current = get();
    // Toggle off if same attachment
    if (
      current.track &&
      current.track.uid === track.uid &&
      current.track.attachment.index === track.attachment.index
    ) {
      set({ track: null, b64Data: null, loading: false, error: null });
      return;
    }
    set({ track, b64Data: null, loading: true, error: null });

    (async () => {
      try {
        const b64 = await loadAttachmentB64(
          track.accountId,
          track.folderPath,
          track.uid,
          track.attachment.index,
        );
        if (get().track !== track) return;
        set({ b64Data: b64, loading: false });
      } catch (e) {
        if (get().track !== track) return;
        set({ error: String(e), loading: false });
      }
    })();
  },

  close: () => set({ track: null, b64Data: null, loading: false, error: null }),
}));
