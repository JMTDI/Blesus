import { create } from "zustand";
import type { Thread } from "@/types";
import type { OutgoingAttachment } from "@/lib/ipc";
import type { StoredDraft } from "@/lib/db";
import { useAccountsStore } from "@/stores/accounts";
import { useThreadsStore } from "@/stores/threads";
import { useBodiesStore } from "@/stores/bodies";
import { useUiStore } from "@/stores/ui";

export type ComposerMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposerSnapshot {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyHtml: string;
  /** Original email HTML preserved verbatim (bypasses Tiptap) for Send New. */
  rawBodyHtml: string | null;
  attachments: OutgoingAttachment[];
  accountId: number;
  mode: ComposerMode;
  inReplyToThread: Thread | null;
  /** The draft ID at the time of send, so undo-send can restore it and
   *  prevent handleClose from creating a duplicate draft on exit. */
  draftId: number | null;
}

interface ComposerState {
  open: boolean;
  draftBumpKey: number;
  mode: ComposerMode;
  inReplyToThread: Thread | null;
  prefillTo: string;
  prefillCc: string;
  prefillBcc: string;
  prefillSubject: string;
  prefillBodyHtml: string;
  prefillAttachments: OutgoingAttachment[];
  /** Raw HTML that bypasses Tiptap — rendered in an iframe in the compose window. */
  prefillRawBodyHtml: string | null;
  /** When true the empty Tiptap editor is hidden — used for plain-text Send New so only the raw preview is shown. */
  prefillHideEditor: boolean;
  /** Account ID to pre-select in From dropdown for replies/forwards. */
  preferredFromAccountId: number | null;
  /** Draft ID when opening an existing draft from the Drafts folder. */
  prefillDraftId: number | null;

  /**
   * One-shot channel for appending an attachment to a composer that is
   * already open (e.g. when the user clicks "Attach to this thread" inside
   * the image or PDF viewer while a reply draft is up). The Composer
   * watches `pendingAppendBump`; when it changes, it consumes
   * `pendingAppendAttachment` and appends it to the current attachments list.
   */
  pendingAppendAttachment: OutgoingAttachment | null;
  pendingAppendBump: number;

  openFromDraft: (draft: StoredDraft) => void;
  openCompose: (signatureHtml?: string | null) => void;
  openComposeWith: (prefill: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    bodyHtml?: string;
    attachments?: OutgoingAttachment[];
    /** Pass raw email HTML here to preserve it faithfully (shown as iframe, not editable). */
    rawBodyHtml?: string;
    /** Hide the empty Tiptap editor area so only the raw preview is visible (used for plain-text Send New). */
    hideEditor?: boolean;
  }) => void;
  openReply: (
    thread: Thread,
    originalHtml: string | null,
    originalText: string | null,
    signatureHtml?: string | null,
    preferredFromAccountId?: number | null,
    currentAccountEmail?: string | null,
  ) => void;
  openReplyAll: (
    thread: Thread,
    originalHtml: string | null,
    originalText: string | null,
    currentAccountEmail: string,
    signatureHtml?: string | null,
    preferredFromAccountId?: number | null,
  ) => void;
  openForward: (
    thread: Thread,
    originalHtml: string | null,
    originalText: string | null,
    signatureHtml?: string | null,
    preferredFromAccountId?: number | null,
  ) => void;
  reopenFromSnapshot: (snap: ComposerSnapshot) => void;
  close: () => void;
  bumpDraftKey: () => void;

  /** Append an attachment to the currently-open composer (no-op if closed). */
  appendAttachmentToOpen: (attachment: OutgoingAttachment) => boolean;
  /** Called by the Composer after it has consumed the pending append. */
  consumePendingAttachment: () => void;
  /**
   * Open a reply to the thread that contains the given message (track), with
   * the supplied attachment pre-attached. Used by the image/PDF viewer
   * "Attach to this thread" buttons. Falls back to a plain compose with the
   * attachment if the thread can't be resolved.
   */
  openReplyForAttachment: (
    track: { accountId: number; folderPath: string; uid: number },
    attachment: OutgoingAttachment,
  ) => void;
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  open: false,
  draftBumpKey: 0,
  mode: "new",
  inReplyToThread: null,
  prefillTo: "",
  prefillCc: "",
  prefillBcc: "",
  prefillSubject: "",
  prefillBodyHtml: "",
  prefillAttachments: [],
  prefillRawBodyHtml: null,
  prefillHideEditor: false,
  preferredFromAccountId: null,
  prefillDraftId: null,
  pendingAppendAttachment: null,
  pendingAppendBump: 0,

  openFromDraft: (draft) =>
    set({
      open: true,
      mode: draft.mode,
      inReplyToThread: null,
      prefillTo: withTrailingComma(draft.to_addresses ?? ""),
      prefillCc: withTrailingComma(draft.cc_addresses ?? ""),
      prefillBcc: withTrailingComma(draft.bcc_addresses ?? ""),
      prefillSubject: draft.subject ?? "",
      // Raw-body drafts (from Send New) must go through the iframe to preserve
      // complex HTML; Tiptap-based drafts can be edited normally.
      prefillBodyHtml: draft.body_is_raw ? "<p></p>" : (draft.html_body ?? "<p></p>"),
      prefillRawBodyHtml: draft.body_is_raw ? (draft.html_body ?? null) : null,
      prefillHideEditor: false,
      prefillAttachments: (() => {
        if (!draft.attachments_json) return [];
        try {
          const parsed = JSON.parse(draft.attachments_json) as Array<{ filename: string; path: string }>;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      preferredFromAccountId: null,
      prefillDraftId: draft.id,
    }),

  openCompose: (signatureHtml?: string | null) =>
    set({
      open: true,
      mode: "new",
      inReplyToThread: null,
      prefillTo: "",
      prefillCc: "",
      prefillBcc: "",
      prefillSubject: "",
      prefillBodyHtml: appendSignatureNew("<p></p>", signatureHtml),
      prefillAttachments: [],
      prefillRawBodyHtml: null,
      prefillHideEditor: false,
      prefillDraftId: null,
    }),

  openComposeWith: (prefill) =>
    set({
      open: true,
      mode: "new",
      inReplyToThread: null,
      prefillTo: withTrailingComma(prefill.to ?? ""),
      prefillCc: withTrailingComma(prefill.cc ?? ""),
      prefillBcc: withTrailingComma(prefill.bcc ?? ""),
      prefillSubject: prefill.subject ?? "",
      prefillBodyHtml: prefill.bodyHtml ?? "<p></p>",
      prefillAttachments: prefill.attachments ?? [],
      prefillRawBodyHtml: prefill.rawBodyHtml ?? null,
      prefillHideEditor: prefill.hideEditor ?? false,
      prefillDraftId: null,
    }),

  openReply: (thread, originalHtml, originalText, signatureHtml, preferredFromAccountId, currentAccountEmail?) => {
    const selfEmails = buildSelfEmailSet(currentAccountEmail ?? null);
    const toParticipant = selfEmails.size > 0
      ? (thread.participants.find((p) => !selfEmails.has(extractEmail(p).toLowerCase())) ?? thread.participants[0] ?? "")
      : (thread.participants[0] ?? "");
    set({
      open: true,
      mode: "reply",
      inReplyToThread: thread,
      prefillTo: withTrailingComma(extractEmail(toParticipant)),
      prefillCc: "",
      prefillBcc: "",
      prefillSubject: withRePrefix(thread.subject),
      prefillBodyHtml: buildReplyQuote(thread, originalHtml, originalText, signatureHtml),
      prefillAttachments: [],
      preferredFromAccountId: preferredFromAccountId ?? null,
    });
  },

  openReplyAll: (thread, originalHtml, originalText, currentAccountEmail, signatureHtml, preferredFromAccountId) => {
    const selfEmails = buildSelfEmailSet(currentAccountEmail);
    const toParticipant = thread.participants.find((p) => !selfEmails.has(extractEmail(p).toLowerCase())) ?? thread.participants[0] ?? "";
    const toEmail = extractEmail(toParticipant).toLowerCase();
    set({
      open: true,
      mode: "replyAll",
      inReplyToThread: thread,
      prefillTo: withTrailingComma(extractEmail(toParticipant)),
      prefillCc: withTrailingComma(
        thread.participants
          .map(extractEmail)
          .filter((e) => e && !selfEmails.has(e.toLowerCase()) && e.toLowerCase() !== toEmail)
          .join(", "),
      ),
      prefillBcc: "",
      prefillSubject: withRePrefix(thread.subject),
      prefillBodyHtml: buildReplyQuote(thread, originalHtml, originalText, signatureHtml),
      prefillAttachments: [],
      preferredFromAccountId: preferredFromAccountId ?? null,
      prefillRawBodyHtml: null,
      prefillDraftId: null,
    });
  },

  openForward: (thread, originalHtml, originalText, signatureHtml, preferredFromAccountId) =>
    set({
      open: true,
      mode: "forward",
      inReplyToThread: thread,
      prefillTo: "",
      prefillCc: "",
      prefillBcc: "",
      prefillSubject: withFwdPrefix(thread.subject),
      prefillBodyHtml: buildForwardQuote(thread, originalHtml, originalText, signatureHtml),
      prefillAttachments: [],
      preferredFromAccountId: preferredFromAccountId ?? null,
      prefillRawBodyHtml: null,
      prefillDraftId: null,
    }),

  reopenFromSnapshot: (snap) =>
    set({
      open: true,
      mode: snap.mode,
      inReplyToThread: snap.inReplyToThread,
      prefillTo: withTrailingComma(snap.to),
      prefillCc: withTrailingComma(snap.cc),
      prefillBcc: withTrailingComma(snap.bcc),
      prefillSubject: snap.subject,
      prefillBodyHtml: snap.bodyHtml,
      prefillAttachments: snap.attachments,
      prefillRawBodyHtml: snap.rawBodyHtml ?? null,
      // Restore the original draftId so handleClose calls updateDraft()
      // instead of insertDraft() — preventing a duplicate draft on exit.
      prefillDraftId: snap.draftId,
    }),

  close: () => set({ open: false, prefillRawBodyHtml: null, prefillHideEditor: false, prefillDraftId: null }),
  bumpDraftKey: () => set((s) => ({ draftBumpKey: s.draftBumpKey + 1 })),

  appendAttachmentToOpen: (attachment) => {
    if (!get().open) return false;
    set((s) => ({
      pendingAppendAttachment: attachment,
      pendingAppendBump: s.pendingAppendBump + 1,
    }));
    return true;
  },

  consumePendingAttachment: () => set({ pendingAppendAttachment: null }),

  openReplyForAttachment: (track, attachment) => {
    const threads = useThreadsStore.getState().threads;
    const selectedId = useUiStore.getState().selectedThreadId;
    const thread =
      threads.find((t) => t.id === selectedId) ??
      threads.find((t) => t.messages.some((m) => m.uid === track.uid)) ??
      threads.find((t) => t.id === track.uid) ??
      null;

    if (!thread) {
      set({
        open: true,
        mode: "new",
        inReplyToThread: null,
        prefillTo: "",
        prefillCc: "",
        prefillBcc: "",
        prefillSubject: "",
        prefillBodyHtml: "<p></p>",
        prefillAttachments: [attachment],
        prefillRawBodyHtml: null,
        prefillHideEditor: false,
        preferredFromAccountId: null,
        prefillDraftId: null,
      });
      return;
    }

    const bodyKey = `${track.folderPath}:${track.uid}`;
    const body = useBodiesStore.getState().bodies[bodyKey] ?? null;
    const accounts = useAccountsStore.getState().accounts;
    const myEmail = accounts.find((a) => a.id === thread.accountId)?.email ?? null;
    const selfEmails = buildSelfEmailSet(myEmail);
    const toParticipant =
      selfEmails.size > 0
        ? thread.participants.find((p) => !selfEmails.has(extractEmail(p).toLowerCase())) ??
          thread.participants[0] ??
          ""
        : thread.participants[0] ?? "";

    set({
      open: true,
      mode: "reply",
      inReplyToThread: thread,
      prefillTo: withTrailingComma(extractEmail(toParticipant)),
      prefillCc: "",
      prefillBcc: "",
      prefillSubject: withRePrefix(thread.subject),
      prefillBodyHtml: buildReplyQuote(thread, body?.html ?? null, body?.text ?? null, null),
      prefillAttachments: [attachment],
      preferredFromAccountId: thread.accountId,
      prefillRawBodyHtml: null,
      prefillHideEditor: false,
      prefillDraftId: null,
    });
  },
}));

function extractEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  return raw.trim();
}

/**
 * Builds a Set of all lowercase email addresses that belong to the current
 * user: the active account's primary email plus any send-via (Resend)
 * addresses from all configured accounts.
 */
function buildSelfEmailSet(currentAccountEmail: string | null): Set<string> {
  const self = new Set<string>();
  if (currentAccountEmail) self.add(extractEmail(currentAccountEmail).toLowerCase());
  const allAccounts = useAccountsStore.getState().accounts;
  for (const a of allAccounts) {
    self.add(extractEmail(a.email).toLowerCase());
    if (a.sendViaEmail) self.add(extractEmail(a.sendViaEmail).toLowerCase());
  }
  return self;
}

/** Ensures a pre-filled address string ends with ", " so all tokens render as chips. */
function withTrailingComma(s: string): string {
  if (!s.trim()) return s;
  return /[,;]\s*$/.test(s) ? s : s + ", ";
}

function withRePrefix(subject: string): string {
  if (/^re:\s/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

function withFwdPrefix(subject: string): string {
  if (/^(fwd?|re):\s/i.test(subject)) return subject;
  return `Fwd: ${subject}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function buildReplyQuote(
  thread: Thread,
  originalHtml: string | null,
  originalText: string | null,
  signatureHtml: string | null | undefined,
): string {
  const sender = escapeHtml(thread.participants[0] ?? "Unknown");
  const date = escapeHtml(formatDate(thread.lastMessageAt));
  const bodyHtml = originalHtml
    ? originalHtml
    : originalText
      ? `<p>${escapeHtml(originalText).replace(/\n/g, "<br>")}</p>`
      : `<p>${escapeHtml(thread.snippet)}</p>`;

  return [
    "<p></p>",
    "<p></p>",
    signatureBlock(signatureHtml),
    `<blockquote><p><em>On ${date}, ${sender} wrote:</em></p>${bodyHtml}</blockquote>`,
  ].join("");
}

function buildForwardQuote(
  thread: Thread,
  originalHtml: string | null,
  originalText: string | null,
  signatureHtml: string | null | undefined,
): string {
  const sender = escapeHtml(thread.participants[0] ?? "Unknown");
  const date = escapeHtml(formatDate(thread.lastMessageAt));
  const subject = escapeHtml(thread.subject);
  const bodyHtml = originalHtml
    ? originalHtml
    : originalText
      ? `<p>${escapeHtml(originalText).replace(/\n/g, "<br>")}</p>`
      : `<p>${escapeHtml(thread.snippet)}</p>`;

  return [
    "<p></p>",
    "<p></p>",
    signatureBlock(signatureHtml),
    "<p><strong>---------- Forwarded message ---------</strong></p>",
    `<p>From: ${sender}<br>`,
    `Date: ${date}<br>`,
    `Subject: ${subject}</p>`,
    bodyHtml,
  ].join("");
}

/**
 * Render the per-account signature as a paragraph block. We accept either
 * raw HTML (kept as-is) or plain text (escaped + newlines → <br>). A
 * pragmatic check: if it contains `<` we treat it as HTML.
 */
export function signatureBlock(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return "";
  const trimmed = raw.trim();
  const isHtml = /<\w+/.test(trimmed);
  const inner = isHtml
    ? trimmed
    : escapeHtml(trimmed).replace(/\n/g, "<br>");
  return `<p data-role="signature">${inner}</p>`;
}

/**
 * For new compose: signature appears below the cursor area, separated by an
 * empty paragraph. Hand-cranking the markup keeps TipTap happy on insert.
 */
function appendSignatureNew(
  body: string,
  signatureHtml: string | null | undefined,
): string {
  const sig = signatureBlock(signatureHtml);
  if (!sig) return body;
  return `${body}<p></p>${sig}`;
}
