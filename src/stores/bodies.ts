import { create } from "zustand";
import { ipc, type Attachment, type UnsubscribeInfo } from "@/lib/ipc";
import {
  getAccount,
  getAccountSecrets,
  getMessageBody,
  getSearchIndexBody,
  setMessageBody,
  upsertSearchBody,
} from "@/lib/db";
import { useAccountsStore } from "@/stores/accounts";

export interface BodyState {
  html: string | null;
  text: string | null;
  attachments: Attachment[];
  unsubscribe: UnsubscribeInfo | null;
  /** True when the body came from a stale search-index fallback (IMAP fetch failed). */
  unavailable?: boolean;
}

interface BodiesStore {
  bodies: Record<string, BodyState>;
  loading: Record<string, boolean>;
  errors: Record<string, string | null>;
  fetchBody: (accountId: number, folderPath: string, uid: number) => Promise<void>;
  /** Inject a body directly (used for locally-stored sent_log entries). */
  seedBody: (folderPath: string, uid: number, html: string | null, text: string | null) => void;
  clear: () => void;
}

function folderIdFor(accountId: number, folderPath: string): number | null {
  const f = useAccountsStore
    .getState()
    .folders.find((x) => x.accountId === accountId && x.path === folderPath);
  return f && f.id > 0 ? f.id : null;
}

export const useBodiesStore = create<BodiesStore>((set, get) => ({
  bodies: {},
  loading: {},
  errors: {},
  fetchBody: async (accountId, folderPath, uid) => {
    // IMAP UIDs are per-folder — use a compound key so two messages that
    // happen to share the same uid (e.g. uid=5 in INBOX and uid=5 in Sent)
    // never collide in the cache.
    const key = `${folderPath}:${uid}`;
    const cached = get().bodies[key];
    // Skip fetch if we already have a good body for this exact folder+uid.
    // If the cached result was marked unavailable (stale index fallback),
    // retry in case the message is now accessible after a re-index.
    if (cached && !cached.unavailable) return;

    // Phase 1: hit the DB. If we already have the body persisted, skip the
    // round-trip entirely. Cold-start instant for any message previously
    // opened — and for messages that never need re-fetching at all.
    const folderId = folderIdFor(accountId, folderPath);
    if (folderId != null) {
      try {
        const cached = await getMessageBody(folderId, uid);
        if (cached) {
          // If the cached HTML still has unresolved cid: references the message
          // was stored before inline-image resolution was added — fall through to
          // a fresh IMAP fetch so the images get properly embedded this time.
          const hasUnresolvedCids = cached.html && /\bcid:[^"'>\s]+/i.test(cached.html);
          if (!hasUnresolvedCids) {
            let attachments: Attachment[] = [];
            if (cached.attachments) {
              try {
                attachments = JSON.parse(cached.attachments) as Attachment[];
              } catch {
                attachments = [];
              }
            }
            set((s) => ({
              bodies: {
                ...s.bodies,
                [key]: {
                  html: cached.html,
                  text: cached.text,
                  attachments,
                  unsubscribe: null,
                },
              },
            }));
            return;
          }
        }
      } catch (err) {
        console.warn("getMessageBody failed", err);
      }
    }

    // Phase 2: round-trip IMAP.
    set((s) => ({ loading: { ...s.loading, [key]: true }, errors: { ...s.errors, [key]: null } }));
    try {
      const account = await getAccount(accountId);
      if (!account) throw new Error(`account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);

      const body = await ipc.imapFetchMessageBody(
        {
          host: account.imap_host,
          port: account.imap_port,
          username: account.imap_username ?? account.email,
          password: secrets.imapPassword,
          security: account.imap_security,
        },
        folderPath,
        uid,
      );

      const attachments = body.attachments ?? [];
      set((s) => ({
        bodies: {
          ...s.bodies,
          [key]: {
            html: body.html,
            text: body.text,
            attachments,
            unsubscribe: body.unsubscribe ?? null,
          },
        },
        loading: { ...s.loading, [key]: false },
      }));

      // Phase 3: persist body for next cold-start. Only when we have a real
      // folder row (synthetic folders carry negative ids — those would
      // violate the FK).
      if (folderId != null) {
        void setMessageBody(
          folderId,
          uid,
          body.html,
          body.text,
          attachments.length > 0 ? JSON.stringify(attachments) : null,
        ).catch((err) => console.warn("setMessageBody failed", err));
      }

      // Fill the search index with the body so full-text search now covers
      // this message. Prefer the plain-text extracted by mail-parser; fall
      // back to stripped HTML if only that is available.
      const textForIndex =
        body.text && body.text.length > 0
          ? body.text
          : body.html
            ? body.html
              .replace(/<style[\s\S]*?<\/style>/gi, " ")
              .replace(/<script[\s\S]*?<\/script>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/gi, " ")
              .replace(/&amp;/gi, "&")
              .replace(/&lt;/gi, "<")
              .replace(/&gt;/gi, ">")
              .replace(/&quot;/gi, '"')
              .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
              .replace(/&[a-z]{2,8};/gi, " ")
              .replace(/\s+/g, " ")
              .trim()
            : "";
      if (textForIndex) {
        void upsertSearchBody(accountId, folderPath, uid, textForIndex).catch(
          () => {},
        );
      }
    } catch (err) {
      // Before giving up, try the search_index — it may have a full text_body
      // cached from a prior indexing run even if IMAP can no longer serve the
      // message (e.g. moved, expunged, or server-side issue).
      const indexed = await getSearchIndexBody(accountId, folderPath, uid).catch(() => null);
      if (indexed !== null) {
        // We have a search_index row. Use the best available text, and append
        // a note when the full body wasn't available so the user knows why the
        // message may appear truncated.
        const text = indexed.text_body
          ?? (indexed.snippet ? indexed.snippet : null);
        set((s) => ({
          bodies: {
            ...s.bodies,
            [key]: { html: null, text, attachments: [], unsubscribe: null, unavailable: true },
          },
          loading: { ...s.loading, [key]: false },
        }));
        return;
      }
      set((s) => ({
        loading: { ...s.loading, [key]: false },
        errors: { ...s.errors, [key]: String(err) },
      }));
    }
  },
  seedBody: (folderPath, uid, html, text) => {
    const key = `${folderPath}:${uid}`;
    set((s) => ({
      bodies: {
        ...s.bodies,
        [key]: { html, text, attachments: [], unsubscribe: null },
      },
    }));
  },
  clear: () => set({ bodies: {}, loading: {}, errors: {} }),
}));
