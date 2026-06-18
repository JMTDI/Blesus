import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Mark, Node, mergeAttributes } from "@tiptap/core";
import Underline from "@tiptap/extension-underline";
import LinkExtension from "@tiptap/extension-link";

// Inline image node — inserted via the toolbar "Insert image" button as a
// base64 data-URI so the image travels with the email body.
const InlineImageNode = Node.create({
  name: "inlineImage",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-inline-image]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        "data-inline-image": "",
        style: "max-width:100%;height:auto;vertical-align:middle;",
      }),
    ];
  },
});

// Inline image node for flag emojis — Windows/WebView2 can't render regional
// indicator Unicode pairs as flags, so we insert them as CDN images instead.
const FlagEmojiNode = Node.create({
  name: "flagEmoji",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-flag]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        "data-flag": "",
        style: "width:1.2em;height:1.2em;vertical-align:-0.2em;display:inline-block;",
      }),
    ];
  },
});

// Inline TextStyle mark — applies font-family as an inline span style.
// Avoids the @tiptap/extension-text-style version conflict with @tiptap/core.
const TextStyleMark = Mark.create({
  name: "textStyle",
  priority: 200, // render outside Strike/Bold/etc so font-size is inherited correctly
  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.fontFamily?.replace(/['"]/g, "") || null,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.fontFamily) return {};
          return { style: `font-family: ${attrs.fontFamily as string}` };
        },
      },
      fontSize: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.fontSize || null,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.fontSize) return {};
          return { style: `font-size: ${attrs.fontSize as string}` };
        },
      },
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.color || null,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.color) return {};
          return { style: `color: ${attrs.color as string}` };
        },
      },
      backgroundColor: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.backgroundColor) return {};
          return { style: `background-color: ${attrs.backgroundColor as string}` };
        },
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span",
        getAttrs: (node: HTMLElement | string) => {
          if (typeof node === "string") return false;
          return (node.style.fontFamily || node.style.fontSize || node.style.color || node.style.backgroundColor) ? {} : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ["span", HTMLAttributes, 0];
  },
});

// Extended paragraph that preserves data-role="signature" so we can reliably
// find and swap the signature when the "send via" account changes.
const SignatureParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-role": {
        default: null,
        parseHTML: (el) => el.getAttribute("data-role"),
        renderHTML: (attrs) =>
          attrs["data-role"] ? { "data-role": attrs["data-role"] } : {},
      },
    };
  },
});
import DOMPurify from "dompurify";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
  X,
  Send,
  Loader2,
  AlertCircle,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  Undo,
  Redo,
  Minus,
  Square,
  Maximize2,
  Minimize2,
  Paperclip,
  FileText,
  Clock,
  Highlighter,
  Smile,
  Link as LinkIcon,
  Check,
  Unlink,
  Image as ImageIcon,
  Camera,
  RemoveFormatting,
} from "lucide-react";
import EmojiPicker, { type EmojiClickData, Theme, EmojiStyle } from "emoji-picker-react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { tempDir } from "@tauri-apps/api/path";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useComposerStore, signatureBlock, type ComposerSnapshot } from "@/stores/composer";
import { useAccountsStore } from "@/stores/accounts";
import { useUiStore } from "@/stores/ui";
import {
  deleteDraft,
  findReplyDraft,
  getAccount,
  getAccountSecrets,
  getThreadingHeadersForUid,
  insertDraft,
  insertScheduledSend,
  updateDraft,
  type DraftInput,
  type DraftMode,
} from "@/lib/db";
import { executeOutgoingSend, type SendPayload } from "@/lib/sender";
import { getSettings } from "@/lib/settings";
import { RecipientsField } from "@/components/composer/RecipientsField";
import {
  ipc,
  type OutgoingAttachment,
  type ResendTemplateSummary,
} from "@/lib/ipc";
import { toast } from "@/stores/toasts";
import { flog } from "@/lib/logger";
import { ImageViewer, PdfViewer } from "@/components/mail/AttachmentPreview";

interface PendingAttachment {
  id: string;
  filename: string;
  path: string;
}

/** Converts a Uint8Array to a base64 string safely (chunked to avoid stack overflow). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
  }
  return btoa(binary);
}

/** Replace (or append) the signature paragraph in the editor for the given account. */
function swapSignatureInEditor(
  editor: ReturnType<typeof useEditor>,
  accounts: import("@/types").Account[],
  accountId: number,
): void {
  if (!editor) return;
  const acc = accounts.find((a) => a.id === accountId);
  const newBlock = signatureBlock(acc?.signatureHtml ?? null);
  const html = editor.getHTML();
  // Match the signature paragraph regardless of attribute order in the tag.
  const sigPattern = /<p\b[^>]*\bdata-role="signature"[^>]*>[\s\S]*?<\/p>/;
  if (sigPattern.test(html)) {
    // Replace existing signature (empty newBlock removes it).
    const updated = html.replace(sigPattern, newBlock);
    if (updated !== html) editor.commands.setContent(updated, { emitUpdate: false });
  } else if (newBlock) {
    // No existing signature — insert before <blockquote (replies/forwards)
    // or append at end (new compose).
    const bqIdx = html.indexOf("<blockquote");
    if (bqIdx > 0) {
      const updated = html.slice(0, bqIdx) + newBlock + html.slice(bqIdx);
      editor.commands.setContent(updated, { emitUpdate: false });
    } else {
      editor.commands.setContent(html + "<p></p>" + newBlock, { emitUpdate: false });
    }
  }
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "tiff", "tif"]);
const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif", tiff: "image/tiff", tif: "image/tiff",
};

/** Modal that previews a local (disk) file — image or PDF. */
function LocalFilePreviewModal({
  file,
  onClose,
}: {
  file: PendingAttachment;
  onClose: () => void;
}) {
  const [b64, setB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
  const isPdf = ext === "pdf";
  const isImage = IMAGE_EXTS.has(ext);
  const mimeType = IMAGE_MIME[ext] ?? "image/jpeg";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setB64(null);
    readFile(file.path)
      .then((bytes) => {
        if (cancelled) return;
        setB64(uint8ToBase64(bytes));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [file.path]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const w = expanded ? "calc(100vw - 8px)" : "90vw";
  const h = expanded ? "calc(100vh - 8px)" : "90vh";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        className="relative z-10 flex flex-col rounded-xl shadow-2xl overflow-hidden transition-all duration-150"
        style={{ width: w, height: h, background: "var(--bg-raised)" }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-2 shrink-0 border-b"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
        >
          <span className="text-[13px] font-medium text-primary truncate flex-1 min-w-0">
            {file.filename}
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Restore" : "Expand"}
            className="flex items-center justify-center h-7 w-7 rounded-md text-muted hover:text-primary hover:bg-hover"
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-muted hover:text-primary hover:bg-hover"
          >
            <X size={15} />
          </button>
        </div>
        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={24} className="animate-spin text-muted" />
            </div>
          )}
          {err && (
            <div className="flex items-center justify-center h-full p-6">
              <p className="text-[13px] text-danger text-center">{err}</p>
            </div>
          )}
          {!loading && !err && b64 && isPdf && <PdfViewer b64Data={b64} track={null} initialScale={0.5} />}
          {!loading && !err && b64 && isImage && <ImageViewer b64Data={b64} contentType={mimeType} initialZoom={0.75} />}
          {!loading && !err && !isPdf && !isImage && (
            <div className="flex items-center justify-center h-full p-6">
              <p className="text-[13px] text-muted text-center">
                Preview is not available for this file type.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Renders raw email HTML (from Send New) in a sandboxed, auto-sizing iframe
// so complex layouts (tables, divs, inline styles) are shown exactly as intended.
// Renders raw email HTML in a sanitized, editable div so the user can modify
// the text while preserving the original HTML structure (no Tiptap normalisation).
// Changes are reported via onChange so the send logic receives the edited HTML.
const RawBodyPreview = React.forwardRef<
  HTMLDivElement,
  { html: string; onChange?: (newHtml: string) => void }
>(function RawBodyPreview({ html, onChange }, forwardedRef) {
  const divRef = useRef<HTMLDivElement>(null);
  // Tracks the last HTML value that came from user typing so we can distinguish
  // "prop echoing user input back" (don't reset) from "new email loaded" (do reset).
  const lastUserHtmlRef = useRef<string | null>(null);

  // Expose our internal ref through the forwarded ref so the parent can target
  // execCommand at this div (e.g. when the toolbar applies bold/italic/lists).
  useImperativeHandle(forwardedRef, () => divRef.current as HTMLDivElement, []);

  useEffect(() => {
    if (!divRef.current) return;
    // If this update is just the state echo of what the user typed, skip — resetting
    // the innerHTML would move the cursor to the start.
    if (lastUserHtmlRef.current !== null && html === lastUserHtmlRef.current) return;
    // Otherwise html came from outside (new email opened, or initial mount) — reinitialise.
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ["script", "object", "embed"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
      ALLOW_DATA_ATTR: false,
      // Allow data: URIs in img src so embedded base64 images (from Send New
      // inline-image resolution) are not stripped before display.
      ADD_DATA_URI_TAGS: ["img"],
    });
    divRef.current.innerHTML = clean;
    lastUserHtmlRef.current = null; // reset so the next external change also takes effect
  }, [html]);

  return (
    <div
      ref={divRef}
      contentEditable
      suppressContentEditableWarning
      onInput={(e) => {
        const newHtml = e.currentTarget.innerHTML;
        lastUserHtmlRef.current = newHtml; // mark as user-originated
        onChange?.(newHtml);
      }}
      onContextMenu={(e) => {
        // Suppress WebView2's native context menu ("Save image as", "Open in
        // new tab", etc.) when right-clicking on an inline image in the body.
        // This prevents any attempt to fetch/download URLs from untrusted HTML.
        let node: HTMLElement | null = e.target as HTMLElement;
        while (node && node !== e.currentTarget) {
          if (node.tagName === "IMG") { e.preventDefault(); return; }
          node = node.parentElement;
        }
      }}
      className="outline-none px-7 py-3 text-[13px] leading-relaxed border-t border-soft"
      style={{ wordWrap: "break-word", lineHeight: "1.6", minHeight: 60 }}
    />
  );
});

/** Extract plain-text subject from the subject contenteditable div,
 * converting <img data-flag alt="🇺🇸"> nodes back to their Unicode alt values. */
function getSubjectText(div: HTMLDivElement): string {
  let text = "";
  for (const node of Array.from(div.childNodes)) {
    if (node.nodeType === globalThis.Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLImageElement && node.hasAttribute("data-flag")) {
      text += node.alt;
    } else {
      text += (node as HTMLElement).textContent ?? "";
    }
  }
  return text;
}

/**
 * Before sending, replace every <img data-flag src="/flag-emojis/X.png"> in
 * the body HTML with an inline base64 data URI so the image is self-contained
 * and renders in any email client (which cannot reach tauri://localhost/).
 */
async function inlineFlagEmojis(html: string): Promise<string> {
  if (!html.includes("data-flag")) return html;

  // Collect unique non-data-URI srcs from <img data-flag> tags
  const flagImgRe = /<img\b([^>]*\bdata-flag\b[^>]*)>/gi;
  const srcAttrRe = /\bsrc="([^"]*)"/i;
  const srcs = new Set<string>();
  for (const m of html.matchAll(flagImgRe)) {
    const attrs = m[1];
    if (!attrs) continue;
    const srcMatch = srcAttrRe.exec(attrs);
    if (srcMatch?.[1] && !srcMatch[1].startsWith("data:")) srcs.add(srcMatch[1]);
  }
  if (srcs.size === 0) return html;

  // Fetch each unique local asset and convert to base64 data URI
  const dataUris = new Map<string, string>();
  await Promise.all(
    Array.from(srcs).map(async (src) => {
      try {
        const resp = await fetch(src);
        if (!resp.ok) return;
        const blob = await resp.blob();
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        dataUris.set(src, dataUri);
      } catch { /* leave as-is on error */ }
    }),
  );
  if (dataUris.size === 0) return html;

  // Swap src values in-place without re-serialising the whole document
  return html.replace(flagImgRe, (imgTag) =>
    imgTag.replace(srcAttrRe, (_, src) => {
      const uri = dataUris.get(src);
      return uri ? `src="${uri}"` : `src="${src}"`;
    }),
  );
}

export function Composer() {
  const open = useComposerStore((s) => s.open);
  const mode = useComposerStore((s) => s.mode);
  const inReplyToThread = useComposerStore((s) => s.inReplyToThread);
  const prefillTo = useComposerStore((s) => s.prefillTo);
  const prefillCc = useComposerStore((s) => s.prefillCc);
  const prefillBcc = useComposerStore((s) => s.prefillBcc);
  const prefillSubject = useComposerStore((s) => s.prefillSubject);
  const prefillBodyHtml = useComposerStore((s) => s.prefillBodyHtml);
  const prefillAttachments = useComposerStore((s) => s.prefillAttachments);
  const prefillRawBodyHtml = useComposerStore((s) => s.prefillRawBodyHtml);
  const prefillHideEditor = useComposerStore((s) => s.prefillHideEditor);
  const preferredFromAccountId = useComposerStore((s) => s.preferredFromAccountId);
  const prefillDraftId = useComposerStore((s) => s.prefillDraftId);
  const pendingAppendBump = useComposerStore((s) => s.pendingAppendBump);
  const close = useComposerStore((s) => s.close);

  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const accounts = useAccountsStore((s) => s.accounts).filter((a) => !a.isImapOnly);
  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [fromAccountId, setFromAccountId] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [previewFile, setPreviewFile] = useState<PendingAttachment | null>(null);
  const [rawBodyHtml, setRawBodyHtml] = useState<string | null>(null);
  const [rawBodyKey, setRawBodyKey] = useState(0);
  const [hideEditor, setHideEditor] = useState(false);
  // Ref to the contentEditable raw body div so the toolbar can apply
  // execCommand formatting to its current selection.
  const rawBodyRef = useRef<HTMLDivElement | null>(null);
  const subjectInputRef = useRef<HTMLDivElement>(null);
  const subjectFromDiv = useRef(false);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const effectiveFromAccountId = fromAccountId ?? activeAccount?.id ?? accounts[0]?.id ?? null;
  const [editorVersion, setEditorVersion] = useState(0);
  const [toolbarActive, setToolbarActive] = useState({ bold: false, italic: false, underline: false, strike: false, bulletList: false, orderedList: false });
  const [templates, setTemplates] = useState<ResendTemplateSummary[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always-current snapshot of form state so handleClose never reads a stale closure.
  const draftSaveRef = useRef<{
    to: string; cc: string; bcc: string; subject: string;
    mode: DraftMode; replyUid: number | null; draftId: number | null; sending: boolean;
    rawBodyHtml: string | null; attachments: PendingAttachment[];
  }>({ to: "", cc: "", bcc: "", subject: "", mode: "new", replyUid: null, draftId: null, sending: false, rawBodyHtml: null, attachments: [] });
  useEffect(() => {
    draftSaveRef.current = {
      to, cc, bcc, subject,
      mode: mode as DraftMode,
      replyUid: inReplyToThread?.id ?? null,
      draftId,
      sending,
      rawBodyHtml,
      attachments,
    };
  });

  // Sync subject state → contenteditable div when changed from outside
  // (e.g. composer opens with a pre-filled subject). Skip when the change
  // originated from the div itself (subjectFromDiv prevents cursor reset).
  useEffect(() => {
    const div = subjectInputRef.current;
    if (!div) return;
    if (subjectFromDiv.current) {
      subjectFromDiv.current = false;
      return;
    }
    if (div.textContent !== subject) {
      div.textContent = subject;
    }
  }, [subject]);

  const editor = useEditor(
    {
      extensions: [StarterKit.configure({ paragraph: false }), SignatureParagraph, TextStyleMark, Underline, FlagEmojiNode, InlineImageNode, LinkExtension.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } })],
      content: "<p></p>",
      editorProps: {
        attributes: {
          class: "blesus-editor outline-none min-h-[220px] px-4 py-3 text-[13px] leading-relaxed",
        },
      },
      onTransaction: ({ editor: e }) => {
        setToolbarActive({
          bold: e.isActive("bold"),
          italic: e.isActive("italic"),
          underline: e.isActive("underline"),
          strike: e.isActive("strike"),
          bulletList: e.isActive("bulletList"),
          orderedList: e.isActive("orderedList"),
        });
      },
    },
    [],
  );

  // When the user changes the "send via" dropdown, swap the signature.
  // Uses data-role="signature" (preserved by SignatureParagraph) so TipTap's
  // HTML normalisation (e.g. <b>→<strong>) doesn't break the match.
  useEffect(() => {
    if (!editor || fromAccountId == null) return;
    swapSignatureInEditor(editor, accounts, fromAccountId);
  }, [fromAccountId, editor, accounts]);

  useEffect(() => {
    if (!open) {
      // Eagerly clear raw body state when the composer closes so stale HTML
      // never bleeds into the next Send New session (defence-in-depth alongside
      // the rawBodyKey remount mechanism).
      setRawBodyHtml(null);
      setHideEditor(false);
      return;
    }
    setTo(prefillTo);
    setCc(prefillCc);
    setBcc(prefillBcc);
    setShowCcBcc(Boolean(prefillCc) || Boolean(prefillBcc));
    setSubject(prefillSubject);
    setError(null);
    setMinimized(false);
    setMaximized(false);

    // Set editor content first so the inline swapSig calls below (which run
    // after setContent) always operate on the freshly-loaded body.
    if (editor) {
      editor.commands.setContent(prefillBodyHtml || "<p></p>", { emitUpdate: false });
      setTimeout(() => editor.commands.focus("start"), 30);
    }

    // Helper: resolve an account id, set it, and immediately fix the signature.
    // Called inline so the swap always runs even when fromAccountId doesn't
    // change between opens (in which case the useEffect above never fires).
    const resolveFrom = (id: number | null) => {
      setFromAccountId(id);
      const accs = useAccountsStore.getState().accounts.filter((a) => !a.isImapOnly);
      if (id != null && editor) swapSignatureInEditor(editor, accs, id);
    };

    // For new composes use the saved default account; for replies use the
    // preferredFromAccountId (the account that was used to send in this thread)
    // falling back to the active account.
    const isNewCompose = !prefillTo && !inReplyToThread;
    if (isNewCompose) {
      void getSettings(["default_compose_account_id"]).then((s) => {
        const saved = s["default_compose_account_id"];
        const savedId = saved ? Number(saved) : null;
        const allAccounts = useAccountsStore.getState().accounts.filter((a) => !a.isImapOnly);
        const valid = savedId != null && allAccounts.some((a) => a.id === savedId);
        resolveFrom(valid ? savedId : (allAccounts[0]?.id ?? activeAccountId ?? null));
      });
    } else if (preferredFromAccountId != null) {
      // Reply/forward — honour the account detected from the thread history.
      const allAccounts = useAccountsStore.getState().accounts.filter((a) => !a.isImapOnly);
      const valid = allAccounts.some((a) => a.id === preferredFromAccountId);
      resolveFrom(valid ? preferredFromAccountId : (allAccounts[0]?.id ?? activeAccountId ?? null));
    } else {
      // Reply/forward with no prior outgoing message — fall back to the saved
      // default compose account before using the active inbox account.
      void getSettings(["default_compose_account_id"]).then((s) => {
        const saved = s["default_compose_account_id"];
        const savedId = saved ? Number(saved) : null;
        const allAccounts = useAccountsStore.getState().accounts.filter((a) => !a.isImapOnly);
        const valid = savedId != null && allAccounts.some((a) => a.id === savedId);
        resolveFrom(valid ? savedId : (allAccounts[0]?.id ?? activeAccountId ?? null));
      });
    }
    setAttachments(
      prefillAttachments.map((a, i) => ({
        id: `${Date.now()}-${i}-${a.path}`,
        filename: a.filename,
        path: a.path,
      })),
    );
    setRawBodyHtml(prefillRawBodyHtml ?? null);
    setRawBodyKey((k) => k + 1);
    setHideEditor(prefillHideEditor);
    setDraftId(null);
    setDraftReady(false);
  }, [
    open,
    prefillTo,
    prefillCc,
    prefillBcc,
    prefillSubject,
    prefillBodyHtml,
    prefillAttachments,
    prefillRawBodyHtml,
    prefillHideEditor,
    preferredFromAccountId,
    editor,
  ]);


  // Resume an existing draft for this (account, mode, replyUid). Runs once per open.
  useEffect(() => {
    if (!open || !editor || !activeAccountId) {
      setDraftReady(open ? false : true);
      return;
    }
    // When opening from the Drafts folder list, the draft is already pre-filled.
    // Just set the draftId directly and skip the lookup.
    if (prefillDraftId != null) {
      setDraftId(prefillDraftId);
      setDraftReady(true);
      return;
    }
    // Only auto-resume saved drafts for replies/forwards — plain new composes
    // should always start blank so existing drafts don't bleed in.
    if (!inReplyToThread) {
      setDraftReady(true);
      return;
    }
    let cancelled = false;
    const replyUid = inReplyToThread?.id ?? null;
    const currentMode: DraftMode = mode;
    void findReplyDraft(activeAccountId, currentMode, replyUid)
      .then((draft) => {
        if (cancelled || !draft) return;
        setDraftId(draft.id);
        setTo(withAddrTrailingComma(draft.to_addresses ?? ""));
        setCc(withAddrTrailingComma(draft.cc_addresses ?? ""));
        setBcc(withAddrTrailingComma(draft.bcc_addresses ?? ""));
        setShowCcBcc(Boolean(draft.cc_addresses) || Boolean(draft.bcc_addresses));
        setSubject(draft.subject ?? "");
        if (draft.html_body) {
          editor.commands.setContent(draft.html_body, { emitUpdate: false });
        }
      })
      .catch(() => {
        // Best-effort; keep the prefilled composer as-is.
      })
      .finally(() => {
        if (!cancelled) setDraftReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editor, activeAccountId, mode, inReplyToThread?.id, prefillDraftId]);

  // Load Resend templates when the composer opens on a Resend account.
  useEffect(() => {
    if (!open || !activeAccount || activeAccount.id == null) return;
    if (!activeAccountId) return;
    let cancelled = false;
    (async () => {
      try {
        const account = await getAccount(activeAccountId);
        if (!account || account.smtp_mode !== "resend") {
          if (!cancelled) setTemplates([]);
          return;
        }
        const secrets = await getAccountSecrets(activeAccountId);
        if (!secrets.resendApiKey) return;
        const list = await ipc.resendListTemplates(secrets.resendApiKey);
        if (!cancelled) setTemplates(list);
      } catch (err) {
        console.warn("resendListTemplates failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeAccountId, activeAccount]);

  // Bump a counter whenever the editor content changes so the debounced save sees it.
  useEffect(() => {
    if (!editor) return;
    const handler = () => setEditorVersion((v) => v + 1);
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor]);

  // Debounced draft auto-save (3s).
  useEffect(() => {
    if (!open || !draftReady || !editor || !activeAccountId || sending) return;
    const html = rawBodyHtml ?? editor.getHTML();
    const text = editor.getText();
    const hasContent =
      to.trim() || cc.trim() || bcc.trim() || subject.trim() || text.trim() ||
      (rawBodyHtml != null && rawBodyHtml.trim().length > 0) ||
      attachments.length > 0;
    if (!hasContent) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const input = {
        accountId: activeAccountId,
        mode,
        replyUid: inReplyToThread?.id ?? null,
        to,
        cc,
        bcc,
        subject,
        htmlBody: html,
        textBody: text,
        bodyIsRaw: rawBodyHtml != null,
        attachments: attachments.map((a) => ({ filename: a.filename, path: a.path })),
      };
      (draftId == null
        ? insertDraft(input).then((id) => setDraftId(id))
        : updateDraft(draftId, input)
      ).catch(() => {
        // Non-fatal; next keystroke triggers another attempt.
      });
    }, 3000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [
    open,
    draftReady,
    editor,
    activeAccountId,
    mode,
    inReplyToThread?.id,
    to,
    cc,
    bcc,
    subject,
    rawBodyHtml,
    editorVersion,
    attachments,
    draftId,
    sending,
  ]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void handleClose();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        void handleSend();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editor]);

  const canSend = useMemo(
    () => parseRecipients(to).length > 0 && !sending,
    [to, sending],
  );

  async function handlePickAttachment() {
    try {
      const picked = await openDialog({ multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      const next: PendingAttachment[] = paths.map((p, i) => ({
        id: `${Date.now()}-${i}-${p}`,
        filename: basename(p),
        path: p,
      }));
      setAttachments((cur) => [...cur, ...next]);
    } catch (e) {
      setError(String(e));
    }
  }

  function addAttachmentFromPath(filename: string, path: string) {
    const id = `${Date.now()}-${filename}`;
    setAttachments((cur) => [...cur, { id, filename, path }]);
  }

  // Consume one-shot append requests from the attachment viewer's
  // "Attach to this thread" button.
  useEffect(() => {
    if (!open || pendingAppendBump === 0) return;
    const { pendingAppendAttachment, consumePendingAttachment } =
      useComposerStore.getState();
    if (pendingAppendAttachment) {
      addAttachmentFromPath(pendingAppendAttachment.filename, pendingAppendAttachment.path);
      consumePendingAttachment();
    }
  }, [open, pendingAppendBump]);

  function removeAttachment(id: string) {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }

  async function handleDiscard() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (draftId != null) {
      await deleteDraft(draftId).catch(() => {});
    }
    close();
  }

  async function handleClose() {
    // Cancel the pending auto-save timer and flush a synchronous save.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // Read live state from the ref (avoids stale closure issues in keyboard handler)
    // and pull account ID directly from the store.
    const s = draftSaveRef.current;
    const currentAccountId = useAccountsStore.getState().activeAccountId;
    if (!s.sending && currentAccountId && editor) {
      const html = s.rawBodyHtml ?? editor.getHTML();
      const text = editor.getText();
      const hasContent =
        s.to.trim() || s.cc.trim() || s.bcc.trim() || s.subject.trim() || text.trim() ||
        (s.rawBodyHtml != null && s.rawBodyHtml.trim().length > 0) ||
        s.attachments.length > 0;
      if (hasContent) {
        const input: DraftInput = {
          accountId: currentAccountId,
          mode: s.mode,
          replyUid: s.replyUid,
          to: s.to,
          cc: s.cc,
          bcc: s.bcc,
          subject: s.subject,
          htmlBody: html,
          textBody: text,
          bodyIsRaw: s.rawBodyHtml != null,
          attachments: s.attachments.map((a) => ({ filename: a.filename, path: a.path })),
        };
        await (s.draftId == null
          ? insertDraft(input)
          : updateDraft(s.draftId, input)
        ).then(() => {
          toast.success("Draft saved");
        }).catch((err) => {
          console.error("[Blesus] Draft save on close failed:", err);
          toast.error(`Draft save failed: ${String(err)}`);
        });
      }
    }
    close();
  }

  async function handleSend() {
    if (!editor) return;
    setError(null);

    const selectedAccountId = effectiveFromAccountId;
    const selectedAccount = selectedAccountId != null
      ? useAccountsStore.getState().accounts.find((a) => a.id === selectedAccountId && !a.isImapOnly) ?? null
      : null;
    if (!selectedAccount) {
      setError("Select a valid From account before sending.");
      return;
    }
    flog.info(`compose: handleSend selectedAccount=${selectedAccount.id} activeAccount=${activeAccountId ?? "none"} to=${JSON.stringify(to)} subject=${JSON.stringify(subject)}`);

    const toList = parseRecipients(to);
    const ccList = parseRecipients(cc);
    const bccList = parseRecipients(bcc);

    // --- Pre-send validation / confirmation ---
    const confirmEnabled = useUiStore.getState().confirmBeforeSend;
    if (confirmEnabled) {
      if (toList.length + ccList.length + bccList.length === 0) {
        setError("Add at least one recipient before sending.");
        return;
      }
      if (subject.trim() === "") {
        if (!window.confirm("Send with an empty subject?")) return;
      }
      const plain = editor.getText().toLowerCase();
      const mentionsAttachment = /\battach(?:ed|ing|ment|ments)?\b/.test(plain);
      if (mentionsAttachment && attachments.length === 0) {
        if (
          !window.confirm(
            "Your message mentions an attachment but none is attached. Send anyway?",
          )
        ) {
          return;
        }
      }
    } else if (toList.length + ccList.length + bccList.length === 0) {
      setError("Add at least one recipient before sending.");
      return;
    }

    // --- Capture snapshot of everything needed to send OR restore on undo ---
    const editorHtml = editor.getHTML();
    // If there's a raw HTML body (from Send New), combine editor content with it.
    // If the editor is empty (just a blank <p></p>), use the raw HTML alone.
    const html = rawBodyHtml
      ? (editorHtml === "<p></p>" ? rawBodyHtml : `${editorHtml}${rawBodyHtml}`)
      : editorHtml;
    const text = editor.getText();
    const outgoingAttachments: OutgoingAttachment[] = attachments.map((a) => ({
      filename: a.filename,
      path: a.path,
    }));
    const snapshot: ComposerSnapshot = {
      to,
      cc,
      bcc,
      subject,
      bodyHtml: html,
      rawBodyHtml,
      attachments: outgoingAttachments,
      accountId: selectedAccount.id,
      mode,
      inReplyToThread,
      // Preserve the draft ID so undo-send can restore it and handleClose
      // calls updateDraft() instead of insertDraft() (preventing a duplicate).
      draftId,
    };

    const undoSec = useUiStore.getState().undoSendSeconds;
    close();

    if (undoSec === 0) {
      await performSend(snapshot, text, draftId);
      return;
    }

    const startedDraftId = draftId;
    let cancelled = false;
    const undoMs = undoSec * 1000;

    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      void performSend(snapshot, text, startedDraftId);
    }, undoMs);

    // Visible per-second countdown so the user knows how long they have to
    // hit Undo. We push the toast first to capture its id, then tick it
    // down with a 1s interval until the timeout fires or Undo is hit.
    const startedAt = Date.now();
    const toastId = toast.push({
      kind: "info",
      message: `Sending… ${undoSec}s`,
      durationMs: undoMs,
      action: {
        label: "Undo",
        onClick: () => {
          cancelled = true;
          clearTimeout(timeoutId);
          clearInterval(tickId);
          useComposerStore.getState().reopenFromSnapshot(snapshot);
        },
      },
    });

    const tickId = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((undoMs - (Date.now() - startedAt)) / 1000));
      if (remaining <= 0 || cancelled) {
        clearInterval(tickId);
        return;
      }
      toast.update(toastId, { message: `Sending… ${remaining}s` });
    }, 1000);
  }

  async function handleSendLater(): Promise<void> {
    if (!editor) return;

    const selectedAccountId = effectiveFromAccountId;
    const selectedAccount = selectedAccountId != null
      ? useAccountsStore.getState().accounts.find((a) => a.id === selectedAccountId && !a.isImapOnly) ?? null
      : null;
    if (!selectedAccount) {
      setError("Select a valid From account before scheduling.");
      return;
    }
    flog.info(`compose: handleSendLater selectedAccount=${selectedAccount.id} activeAccount=${activeAccountId ?? "none"}`);
    const html = editor.getHTML();
    const text = editor.getText();
    const sample = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    const input = window.prompt(
      "Send at (YYYY-MM-DD HH:MM, local time):",
      sample,
    );
    if (!input) return;
    const target = new Date(input.trim().replace(" ", "T"));
    if (Number.isNaN(target.getTime())) {
      toast.error("Invalid date — expected YYYY-MM-DD HH:MM");
      return;
    }
    if (target.getTime() <= Date.now()) {
      toast.error("Send time must be in the future");
      return;
    }

    const payload: Record<string, unknown> = {
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      html,
      text,
      attachments: attachments.map((a) => ({ filename: a.filename, path: a.path })),
    };

    // Embed threading headers in the payload so the scheduled-send worker
    // can include them even if the original message is later deleted.
    if (
      (mode === "reply" || mode === "replyAll" || mode === "forward") &&
      inReplyToThread
    ) {
      const th = await getThreadingHeadersForUid(
        inReplyToThread.accountId,
        inReplyToThread.folderId,
        inReplyToThread.id,
      ).catch(() => ({ messageIdHeader: null, referencesHeader: null }));
      if (th.messageIdHeader) {
        payload.inReplyTo = `<${th.messageIdHeader}>`;
        const existingRefs = th.referencesHeader
          ? th.referencesHeader.split(/\s+/).filter(Boolean).map((id) => `<${id}>`)
          : [];
        payload.references = [...existingRefs, `<${th.messageIdHeader}>`].join(" ");
      }
    }

    try {
      await insertScheduledSend({
        accountId: selectedAccount.id,
        payloadJson: JSON.stringify(payload),
        mode,
        replyUid: inReplyToThread?.id ?? null,
        draftId,
        scheduledAt: Math.floor(target.getTime() / 1000),
      });
      toast.success(
        `Scheduled for ${target.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
      );
      close();
    } catch (err) {
      toast.error(`Schedule failed: ${err}`);
    }
  }

  async function performSend(
    snap: ComposerSnapshot,
    text: string,
    snapshotDraftId: number | null,
  ): Promise<void> {
    setSending(true);
    flog.info(
      `compose: performSend start account=${snap.accountId} mode=${snap.mode} ` +
      `to=${snap.to} cc=${snap.cc} bcc=${snap.bcc} subj=${JSON.stringify(snap.subject)}`,
    );
    try {
      // Build RFC 2822 threading headers for replies/forwards.
      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (
        (snap.mode === "reply" || snap.mode === "replyAll" || snap.mode === "forward") &&
        snap.inReplyToThread
      ) {
        const t = snap.inReplyToThread;
        const th = await getThreadingHeadersForUid(t.accountId, t.folderId, t.id).catch(
          () => ({ messageIdHeader: null, referencesHeader: null }),
        );
        if (th.messageIdHeader) {
          inReplyTo = `<${th.messageIdHeader}>`;
          const existingRefs = th.referencesHeader
            ? th.referencesHeader.split(/\s+/).filter(Boolean).map((id) => `<${id}>`)
            : [];
          references = [...existingRefs, `<${th.messageIdHeader}>`].join(" ");
        }
      }

      const payload: SendPayload = {
        to: parseRecipients(snap.to),
        cc: parseRecipients(snap.cc),
        bcc: parseRecipients(snap.bcc),
        subject: snap.subject,
        html: await inlineFlagEmojis(snap.bodyHtml),
        text,
        attachments: snap.attachments,
        inReplyTo,
        references,
      };

      await executeOutgoingSend(payload, {
        accountId: snap.accountId,
        mode: snap.mode,
        replyUid: snap.inReplyToThread?.id ?? null,
        draftId: snapshotDraftId,
        onDraftDeleted: snapshotDraftId != null
          ? () => useComposerStore.getState().bumpDraftKey()
          : undefined,
      });
      flog.info("compose: performSend ok");
      toast.success("Message sent");
    } catch (err) {
      flog.error("compose: performSend failed:", err);
      toast.error(`Send failed: ${err}`);
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  return (
    <>
      {!minimized && <div className="fixed inset-0 bg-black/50 z-40 no-drag" onClick={() => void handleClose()} />}
      <div
        className={cn(
          "fixed z-50 shadow-lift rounded-xl bg-raised border border-strong overflow-hidden no-drag",
          minimized
            ? "bottom-4 right-4 w-[320px]"
            : maximized
            ? "inset-3"
            : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[720px] max-w-[95vw] h-[560px] max-h-[90vh]",
          "flex flex-col",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-soft shrink-0 bg-sunken">
          <h2 className="text-[13px] font-semibold text-primary truncate">
            {subject || (prefillSubject ? "…" : "New message")}
          </h2>
          <div className="flex items-center gap-0.5">
            {!minimized && (
              <HeaderIconButton onClick={() => setMaximized((m) => !m)} title={maximized ? "Restore" : "Maximise"}>
                {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </HeaderIconButton>
            )}
            <HeaderIconButton onClick={() => { setMinimized((m) => !m); setMaximized(false); }} title="Minimize">
              {minimized ? <Square size={12} /> : <Minus size={13} />}
            </HeaderIconButton>
            <HeaderIconButton onClick={() => void handleClose()} title="Close">
              <X size={14} />
            </HeaderIconButton>
          </div>
        </header>

        {!minimized && (
          <>
            <div className="flex flex-col gap-1 px-4 pt-3 pb-2 border-b border-soft shrink-0">
              <AddrRow label="From">
                {accounts.length > 1 ? (
                  <select
                    value={effectiveFromAccountId ?? ""}
                    onChange={(e) => setFromAccountId(Number(e.target.value))}
                    className="bg-transparent border-0 outline-none text-[13px] text-secondary cursor-pointer hover:text-primary max-w-full"
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[13px] text-secondary">
                    {activeAccount ? activeAccount.email : "No account selected"}
                  </span>
                )}
              </AddrRow>
              <AddrRow
                label="To"
                trailing={
                  !showCcBcc && (
                    <button
                      type="button"
                      onClick={() => setShowCcBcc(true)}
                      className="text-[11.5px] text-muted hover:text-primary px-1.5"
                    >
                      Cc · Bcc
                    </button>
                  )
                }
              >
                <RecipientsField
                  value={to}
                  onChange={setTo}
                  placeholder="recipient@example.com, another@example.com"
                />
              </AddrRow>
              {showCcBcc && (
                <>
                  <AddrRow label="Cc">
                    <RecipientsField value={cc} onChange={setCc} />
                  </AddrRow>
                  <AddrRow label="Bcc">
                    <RecipientsField value={bcc} onChange={setBcc} />
                  </AddrRow>
                </>
              )}
              <AddrRow label="Subject">
                <div
                  ref={subjectInputRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(e) => {
                    subjectFromDiv.current = true;
                    setSubject(getSubjectText(e.currentTarget as HTMLDivElement));
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
                  onPaste={(e) => {
                    e.preventDefault();
                    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
                  }}
                  data-placeholder="Subject"
                  className="subject-editor flex-1 bg-transparent outline-none text-[13px] text-primary"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <InlineEmojiButton
                  onEmoji={(data) => {
                    const div = subjectInputRef.current;
                    const isFlag = /^1f1[0-9a-f]{2}-1f1[0-9a-f]{2}$/i.test(data.unified);
                    if (!div) { setSubject((s) => s + data.emoji); return; }
                    div.focus();
                    if (isFlag) {
                      document.execCommand(
                        "insertHTML",
                        false,
                        `<img src="/flag-emojis/${data.unified}.png" alt="${data.emoji}" data-flag="" style="width:1.2em;height:1.2em;vertical-align:-0.2em;display:inline-block;" />`,
                      );
                    } else {
                      document.execCommand("insertText", false, data.emoji);
                    }
                    subjectFromDiv.current = true;
                    setSubject(getSubjectText(div));
                  }}
                />
              </AddrRow>
            </div>

            <Toolbar
              editor={editor}
              toolbarActive={toolbarActive}
              rawBodyRef={rawBodyRef}
              onRawBodyChange={(h) => setRawBodyHtml(h)}
              onAttach={handlePickAttachment}
              onAddAttachment={addAttachmentFromPath}
              onOpenTemplates={
                templates.length > 0 ? () => setTemplatesOpen((v) => !v) : null
              }
              templatesActive={templatesOpen}
            />
            {templatesOpen && templates.length > 0 && (
              <div
                style={{
                  background: "var(--bg-raised)",
                  borderColor: "var(--border-strong)",
                  boxShadow: "var(--shadow-md)",
                }}
                className="absolute left-3 right-3 top-[140px] rounded-lg border p-1 z-10 max-h-[260px] overflow-y-auto"
              >
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      if (t.subject) setSubject(t.subject);
                      setTemplatesOpen(false);
                      toast.info(`Template applied: ${t.name}`);
                    }}
                    className="flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
                  >
                    <FileText size={13} className="text-muted mt-0.5 shrink-0" />
                    <span className="flex-1 min-w-0">
                      <div className="truncate text-primary">{t.name}</div>
                      {t.subject && (
                        <div className="truncate text-muted text-[11.5px]">
                          {t.subject}
                        </div>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-soft shrink-0">
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    className="flex items-center gap-2 h-7 rounded-md px-2.5 text-[12px] bg-sunken border border-soft text-secondary"
                    title={a.path}
                  >
                    <Paperclip size={12} className="text-muted" />
                    <button
                      type="button"
                      onClick={() => setPreviewFile(a)}
                      className="truncate max-w-[220px] hover:text-primary hover:underline"
                    >
                      {a.filename}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className="text-muted hover:text-primary"
                      aria-label={`Remove ${a.filename}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className={cn("flex-1 overflow-y-auto", rawBodyHtml && "flex flex-col")}>
              {!hideEditor && (
                <div className={rawBodyHtml ? "shrink-0 [&_.blesus-editor]:min-h-[40px]" : ""}>
                  <EditorContent editor={editor} />
                </div>
              )}
              {rawBodyHtml && (
                <RawBodyPreview
                  key={rawBodyKey}
                  ref={rawBodyRef}
                  html={rawBodyHtml}
                  onChange={(h) => setRawBodyHtml(h)}
                />
              )}
            </div>

            {error && (
              <div className="mx-4 mb-2 rounded-lg border border-[color:var(--color-danger)] bg-[color:rgba(229,72,77,0.08)] px-3 py-2 flex items-start gap-2 shrink-0">
                <AlertCircle size={13} className="text-[color:var(--color-danger)] mt-0.5 shrink-0" />
                <p className="text-[12px] text-primary break-words">{error}</p>
              </div>
            )}

            <footer className="flex items-center justify-between px-4 py-3 border-t border-soft shrink-0 bg-sunken">
              <Button variant="ghost" onClick={() => void handleDiscard()} disabled={sending}>
                Discard
              </Button>
              <div className="flex items-center gap-2">
                <span className="text-[11.5px] text-muted tabular-nums">
                  {sending ? "Sending…" : canSend ? "Ready · Ctrl+Enter to send" : ""}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => void handleSendLater()}
                  disabled={!canSend}
                  leading={<Clock size={14} />}
                >
                  Send later
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSend}
                  disabled={!canSend}
                  leading={sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  className="min-w-[120px] px-6"
                >
                  Send
                </Button>
              </div>
            </footer>
          </>
        )}
      </div>

      {previewFile && (
        <LocalFilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}

      <style>{`
        .blesus-editor { font-family: Arial, sans-serif; }
        .blesus-editor p { margin: 0 0 0.6em 0; }
        .blesus-editor blockquote {
          border-left: 3px solid var(--border-strong);
          margin: 0.6em 0;
          padding: 0 0 0 12px;
          color: var(--fg-secondary);
        }
        .blesus-editor ul, .blesus-editor ol { margin: 0 0 0.6em 1.2em; padding: 0; }
        .blesus-editor h1, .blesus-editor h2, .blesus-editor h3 { margin: 0.8em 0 0.4em; font-weight: 600; }
        .blesus-editor a { color: var(--accent); text-decoration: none; }
        .blesus-editor a:hover { text-decoration: underline; }
        .blesus-editor code {
          background: rgba(128,128,128,0.12);
          padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
        }
      `}</style>
    </>
  );
}

const FONTS = [
  { label: "Arial", value: "Arial" },
  { label: "Arial Black", value: "Arial Black" },
  { label: "Comic Sans MS", value: "Comic Sans MS" },
  { label: "Courier New", value: "Courier New" },
  { label: "Georgia", value: "Georgia" },
  { label: "Helvetica", value: "Helvetica" },
  { label: "Impact", value: "Impact" },
  { label: "Lucida Sans", value: "Lucida Sans" },
  { label: "Tahoma", value: "Tahoma" },
  { label: "Times New Roman", value: "Times New Roman" },
  { label: "Trebuchet MS", value: "Trebuchet MS" },
  { label: "Verdana", value: "Verdana" },
] as const;
const DEFAULT_FONT = "Arial";

const FONT_SIZES = [8, 10, 12, 14, 18, 24, 36] as const;
const DEFAULT_SIZE = "12";
const DEFAULT_COLOR = "#000000";
const PRESET_HIGHLIGHTS = [
  "#fef08a", "#bbf7d0", "#bfdbfe", "#fce7f3", "#fed7aa",
  "#fde047", "#4ade80", "#60a5fa", "#f472b6", "#fb923c",
  "#facc15", "#34d399", "#38bdf8", "#e879f9", "#f87171",
] as const;
const PRESET_COLORS = [
  "#000000", "#374151", "#6b7280", "#9ca3af", "#ffffff",
  "#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e",
  "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#a855f7",
  "#ec4899", "#f43f5e", "#7c3aed", "#0369a1", "#065f46",
] as const;
// Maps pt value to the legacy execCommand fontSize level (1–7)
const PT_TO_EXEC_SIZE: Record<string, string> = {
  "8": "1", "10": "2", "12": "3", "14": "4", "18": "5", "24": "6", "36": "7",
};

function Toolbar({
  editor,
  toolbarActive,
  rawBodyRef,
  onRawBodyChange,
  onAttach,
  onAddAttachment,
  onOpenTemplates,
  templatesActive,
}: {
  editor: Editor | null;
  toolbarActive: { bold: boolean; italic: boolean; underline: boolean; strike: boolean; bulletList: boolean; orderedList: boolean };
  rawBodyRef?: React.RefObject<HTMLDivElement | null>;
  onRawBodyChange?: (newHtml: string) => void;
  onAttach: () => void;
  onAddAttachment: (filename: string, path: string) => void;
  onOpenTemplates: (() => void) | null;
  templatesActive: boolean;
}) {
  const [currentFont, setCurrentFont] = useState(DEFAULT_FONT);
  const [currentSize, setCurrentSize] = useState(DEFAULT_SIZE);
  const [currentColor, setCurrentColor] = useState(DEFAULT_COLOR);
  const [currentHighlight, setCurrentHighlight] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiContainerRef = useRef<HTMLDivElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkBtnRef = useRef<HTMLDivElement>(null);
  const savedRawRange = useRef<Range | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const attrs = editor.getAttributes("textStyle");
      setCurrentFont((attrs.fontFamily as string | null) ?? DEFAULT_FONT);
      const raw = attrs.fontSize as string | null | undefined;
      setCurrentSize(raw ? raw.replace("pt", "") : DEFAULT_SIZE);
      setCurrentColor((attrs.color as string | null) ?? DEFAULT_COLOR);
      setCurrentHighlight((attrs.backgroundColor as string | null) ?? null);
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  if (!editor) return null;

  // Returns the raw body div iff it currently contains the document selection.
  // When this returns non-null, toolbar commands should target it via
  // document.execCommand (which respects the active selection in any
  // contentEditable element) instead of the Tiptap editor.
  const rawBodyTarget = (): HTMLDivElement | null => {
    const node = rawBodyRef?.current;
    if (!node) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const anchor = sel.anchorNode;
    if (!anchor) return null;
    return node.contains(anchor) ? node : null;
  };

  // Applies an execCommand to the raw body and reports the new innerHTML so
  // the parent's state stays in sync with the DOM.
  const runRaw = (cmd: string, target: HTMLDivElement) => {
    target.focus();
    document.execCommand(cmd, false);
    onRawBodyChange?.(target.innerHTML);
  };

  const handleFont = (font: string) => {
    const raw = rawBodyTarget();
    if (raw) {
      raw.focus();
      document.execCommand("fontName", false, font);
      onRawBodyChange?.(raw.innerHTML);
      setCurrentFont(font);
      return;
    }
    const existing = editor.getAttributes("textStyle");
    editor.chain().focus().setMark("textStyle", { ...existing, fontFamily: font }).run();
    setCurrentFont(font);
  };

  const handleSize = (size: string) => {
    const raw = rawBodyTarget();
    if (raw) {
      raw.focus();
      document.execCommand("fontSize", false, PT_TO_EXEC_SIZE[size] ?? "3");
      onRawBodyChange?.(raw.innerHTML);
      setCurrentSize(size);
      return;
    }
    const existing = editor.getAttributes("textStyle");
    editor.chain().focus().setMark("textStyle", { ...existing, fontSize: `${size}pt` }).run();
    setCurrentSize(size);
  };

  const handleColor = (color: string) => {
    const raw = rawBodyTarget();
    if (raw) {
      raw.focus();
      document.execCommand("foreColor", false, color);
      onRawBodyChange?.(raw.innerHTML);
      setCurrentColor(color);
      return;
    }
    const existing = editor.getAttributes("textStyle");
    editor.chain().focus().setMark("textStyle", { ...existing, color }).run();
    setCurrentColor(color);
  };

  const handleHighlight = (color: string | null) => {
    const raw = rawBodyTarget();
    if (raw) {
      raw.focus();
      document.execCommand("hiliteColor", false, color ?? "transparent");
      onRawBodyChange?.(raw.innerHTML);
      setCurrentHighlight(color);
      return;
    }
    const existing = editor.getAttributes("textStyle");
    editor.chain().focus().setMark("textStyle", { ...existing, backgroundColor: color }).run();
    setCurrentHighlight(color);
  };

  const handleBodyEmoji = (data: EmojiClickData) => {
    const emoji = data.emoji;
    // Flag emojis are pairs of regional indicator characters (e.g. 1f1fa-1f1f8).
    // Windows/WebView2 has no font that renders them, so they appear as two letters.
    // Insert as an inline image instead.
    const isFlag = /^1f1[0-9a-f]{2}-1f1[0-9a-f]{2}$/i.test(data.unified);
    const raw = rawBodyTarget();
    if (isFlag) {
      const imgHtml = `<img src="/flag-emojis/${data.unified}.png" alt="${emoji}" data-flag="" style="width:1.2em;height:1.2em;vertical-align:-0.2em;display:inline-block;" />`;
      if (raw) {
        raw.focus();
        document.execCommand("insertHTML", false, imgHtml);
        onRawBodyChange?.(raw.innerHTML);
      } else if (editor) {
        editor.chain().focus().insertContent({
          type: "flagEmoji",
          attrs: { src: `/flag-emojis/${data.unified}.png`, alt: emoji },
        }).run();
      }
    } else {
      if (raw) {
        raw.focus();
        document.execCommand("insertText", false, emoji);
        onRawBodyChange?.(raw.innerHTML);
      } else if (editor) {
        editor.chain().focus().insertContent(emoji).run();
      }
    }
    setEmojiOpen(false);
  };

  // Tiptap path (default) — kept unchanged for replies/new composes that use
  // the Tiptap editor. The raw-body branch above takes precedence whenever the
  // selection is inside the contentEditable preview.
  const handleClearFormatting = () => {
    const raw = rawBodyTarget();
    if (raw) {
      raw.focus();
      document.execCommand("removeFormat", false);
      onRawBodyChange?.(raw.innerHTML);
      return;
    }
    editor.chain().focus().unsetAllMarks().clearNodes().run();
  };

  const handle = (cmd: "bold" | "italic" | "underline" | "strike" | "bulletList" | "orderedList" | "undo" | "redo") => () => {
    const raw = rawBodyTarget();
    if (raw) {
      const map: Record<typeof cmd, string> = {
        bold: "bold",
        italic: "italic",
        underline: "underline",
        strike: "strikeThrough",
        bulletList: "insertUnorderedList",
        orderedList: "insertOrderedList",
        undo: "undo",
        redo: "redo",
      };
      runRaw(map[cmd], raw);
      return;
    }
    switch (cmd) {
      case "bold": editor.chain().focus().toggleBold().run(); break;
      case "italic": editor.chain().focus().toggleItalic().run(); break;
      case "underline": editor.chain().focus().toggleUnderline().run(); break;
      case "strike": editor.chain().focus().toggleStrike().run(); break;
      case "bulletList": editor.chain().focus().toggleBulletList().run(); break;
      case "orderedList": editor.chain().focus().toggleOrderedList().run(); break;
      case "undo": editor.chain().focus().undo().run(); break;
      case "redo": editor.chain().focus().redo().run(); break;
    }
  };

  // Prevent the toolbar button mousedown from blurring the raw body (which
  // would clear the selection before execCommand could act on it).
  const keepSelection = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const handleLinkClick = () => {
    const raw = rawBodyTarget();
    if (raw) {
      const sel = window.getSelection();
      savedRawRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
      setLinkUrl("");
    } else {
      savedRawRange.current = null;
      setLinkUrl(editor.isActive("link") ? ((editor.getAttributes("link").href as string) ?? "") : "");
    }
    setLinkOpen((v) => !v);
  };

  const handleLinkSubmit = (url: string) => {
    setLinkOpen(false);
    const trimmed = url.trim();
    if (!trimmed) return;
    const href = /^(https?|mailto|ftp):\/?\/?/i.test(trimmed)
      ? trimmed
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
        ? `mailto:${trimmed}`
        : `https://${trimmed}`;
    const raw = rawBodyRef?.current;
    if (savedRawRange.current && raw) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRawRange.current);
      raw.focus();
      document.execCommand("createLink", false, href);
      raw.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`).forEach((a) => {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      });
      onRawBodyChange?.(raw.innerHTML);
      savedRawRange.current = null;
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  };

  const handleLinkRemove = () => {
    setLinkOpen(false);
    const raw = rawBodyRef?.current;
    if (savedRawRange.current && raw) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRawRange.current);
      raw.focus();
      document.execCommand("unlink", false);
      onRawBodyChange?.(raw.innerHTML);
      savedRawRange.current = null;
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
  };

  const handleInlineImage = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"] }],
      });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      const bytes = await readFile(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "jpeg";
      const mime = IMAGE_MIME[ext] ?? "image/jpeg";
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
      const src = `data:${mime};base64,${btoa(bin)}`;
      const raw = rawBodyRef?.current;
      if (raw) {
        raw.focus();
        document.execCommand("insertHTML", false, `<img src="${src}" data-inline-image="" style="max-width:100%;height:auto;vertical-align:middle;" />`);
        onRawBodyChange?.(raw.innerHTML);
      } else if (editor) {
        editor.chain().focus().insertContent({ type: "inlineImage", attrs: { src, alt: path.split(/[\\/]/).pop() ?? "" } }).run();
      }
    } catch (e) {
      console.error("Inline image error:", e);
    }
  };

  const handleCameraInline = (dataUrl: string) => {
    const raw = rawBodyRef?.current;
    if (raw) {
      raw.focus();
      document.execCommand(
        "insertHTML",
        false,
        `<img src="${dataUrl}" data-inline-image="" style="max-width:100%;height:auto;vertical-align:middle;" /><br><br>`,
      );
      onRawBodyChange?.(raw.innerHTML);
    } else if (editor) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "inlineImage", attrs: { src: dataUrl, alt: "photo" } })
        .insertContent("<p></p>")
        .run();
    }
  };

  const handleCameraAttach = async (dataUrl: string) => {
    try {
      const tmp = await tempDir();
      const filename = `photo-${Date.now()}.jpg`;
      const sep = tmp.endsWith("/") || tmp.endsWith("\\") ? "" : "/";
      const destPath = `${tmp}${sep}${filename}`;
      const b64 = dataUrl.split(",")[1] ?? "";
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await writeFile(destPath, bytes);
      onAddAttachment(filename, destPath);
    } catch (e) {
      console.error("Camera attach error:", e);
    }
  };

  return (
    <div
      className="flex items-center gap-0.5 px-3 py-1.5 border-b border-soft shrink-0 flex-wrap"
      onMouseDown={keepSelection}
    >
      <select
        value={currentFont}
        onChange={(e) => handleFont(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-7 rounded-md px-1.5 text-[12px] bg-transparent border border-soft text-secondary hover:border-strong focus:outline-none cursor-pointer mr-1"
        style={{ minWidth: 100 }}
        title="Font family"
      >
        {FONTS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={currentSize}
        onChange={(e) => handleSize(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-7 rounded-md px-1.5 text-[12px] bg-transparent border border-soft text-secondary hover:border-strong focus:outline-none cursor-pointer mr-1"
        style={{ minWidth: 52 }}
        title="Font size"
      >
        {FONT_SIZES.map((s) => (
          <option key={s} value={String(s)}>
            {s}
          </option>
        ))}
      </select>
      <ColorPicker currentColor={currentColor} onColor={handleColor} />
      <HighlightPicker currentHighlight={currentHighlight} onHighlight={handleHighlight} />
      <Divider />
      <ToolButton active={toolbarActive.bold} onClick={handle("bold")}>
        <Bold size={13} />
      </ToolButton>
      <ToolButton active={toolbarActive.italic} onClick={handle("italic")}>
        <Italic size={13} />
      </ToolButton>
      <ToolButton active={toolbarActive.underline} onClick={handle("underline")} title="Underline">
        <UnderlineIcon size={13} />
      </ToolButton>
      <ToolButton active={toolbarActive.strike} onClick={handle("strike")} title="Strikethrough">
        <Strikethrough size={13} />
      </ToolButton>
      <ToolButton onClick={handleClearFormatting} title="Clear formatting">
        <RemoveFormatting size={13} />
      </ToolButton>
      <div ref={linkBtnRef} className="relative">
        <ToolButton active={linkOpen || editor.isActive("link")} onClick={handleLinkClick} title="Insert link">
          <LinkIcon size={13} />
        </ToolButton>
        <PortalLinkDialog
          anchorRef={linkBtnRef}
          open={linkOpen}
          initialUrl={linkUrl}
          onSubmit={handleLinkSubmit}
          onRemove={handleLinkRemove}
          onClose={() => setLinkOpen(false)}
        />
      </div>
      <Divider />
      <ToolButton active={toolbarActive.bulletList} onClick={handle("bulletList")}>
        <List size={14} />
      </ToolButton>
      <ToolButton active={toolbarActive.orderedList} onClick={handle("orderedList")}>
        <ListOrdered size={14} />
      </ToolButton>
      <Divider />
      <ToolButton onClick={handle("undo")}>
        <Undo size={13} />
      </ToolButton>
      <ToolButton onClick={handle("redo")}>
        <Redo size={13} />
      </ToolButton>
      <Divider />
      <ToolButton onClick={onAttach} title="Attach files">
        <Paperclip size={13} />
      </ToolButton>
      <ToolButton onClick={handleInlineImage} title="Insert inline image">
        <ImageIcon size={13} />
      </ToolButton>
      <ToolButton onClick={() => setCameraOpen(true)} title="Take a photo">
        <Camera size={13} />
      </ToolButton>
      <CameraModal
        open={cameraOpen}
        onInline={handleCameraInline}
        onAttach={handleCameraAttach}
        onClose={() => setCameraOpen(false)}
      />
      {onOpenTemplates && (
        <ToolButton
          active={templatesActive}
          onClick={onOpenTemplates}
          title="Resend templates"
        >
          <FileText size={13} />
        </ToolButton>
      )}
      <Divider />
      <div ref={emojiContainerRef} className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <ToolButton onClick={() => setEmojiOpen((v) => !v)} title="Insert emoji" active={emojiOpen}>
          <Smile size={13} />
        </ToolButton>
        <PortalEmojiPicker
          anchorRef={emojiContainerRef}
          open={emojiOpen}
          onEmojiClick={handleBodyEmoji}
          onClose={() => setEmojiOpen(false)}
        />
      </div>
    </div>
  );
}

function PortalEmojiPicker({
  anchorRef,
  open,
  onEmojiClick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onEmojiClick: (data: EmojiClickData) => void;
  onClose: () => void;
}) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const ph = 380, pw = 320;
    const top = window.innerHeight - rect.bottom >= ph + 8 ? rect.bottom + 4 : rect.top - ph - 4;
    const left = rect.left + pw > window.innerWidth ? rect.right - pw : rect.left;
    setCoords({ top, left });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (anchorRef.current?.contains(t) || portalRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div ref={portalRef} style={{ position: "fixed", top: coords.top, left: coords.left, zIndex: 9999 }}>
      <EmojiPicker
        onEmojiClick={(data) => { onEmojiClick(data); onClose(); }}
        theme={Theme.AUTO}
        emojiStyle={EmojiStyle.GOOGLE}
        lazyLoadEmojis
        height={380}
        width={320}
        searchPlaceholder="Search emoji…"
      />
    </div>,
    document.body,
  );
}

function PortalLinkDialog({
  anchorRef,
  open,
  initialUrl,
  onSubmit,
  onRemove,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  initialUrl: string;
  onSubmit: (url: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const inputRef = useRef<HTMLInputElement>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  useEffect(() => { setUrl(initialUrl); }, [initialUrl, open]);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 4, left: rect.left });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (anchorRef.current?.contains(t) || portalRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={portalRef}
      style={{ position: "fixed", top: coords.top, left: coords.left, zIndex: 9999 }}
      className="flex items-center gap-1 p-1.5 rounded-lg shadow-lg border border-soft bg-surface"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onSubmit(url); }
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="https://example.com or name@email.com"
        className="h-7 w-56 rounded px-2 text-sm bg-transparent border border-soft text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500"
      />
      <button
        type="button"
        title="Apply link"
        onClick={() => onSubmit(url)}
        className="flex h-7 w-7 items-center justify-center rounded text-green-600 hover:bg-hover"
      >
        <Check size={13} />
      </button>
      {initialUrl && (
        <button
          type="button"
          title="Remove link"
          onClick={onRemove}
          className="flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-hover"
        >
          <Unlink size={13} />
        </button>
      )}
    </div>,
    document.body,
  );
}

function CameraModal({
  open,
  onInline,
  onAttach,
  onClose,
}: {
  open: boolean;
  onInline: (dataUrl: string) => void;
  onAttach: (dataUrl: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [crop, setCrop] = useState<Crop>({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | undefined>();
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);

  const startStream = useCallback(async (deviceId?: string) => {
    setCamError(null);
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.play();
      }
      // Enumerate after permission granted so device labels are available
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoCams = devices.filter((d) => d.kind === "videoinput");
      setCameras(videoCams);
      const activeId = deviceId ?? s.getVideoTracks()[0]?.getSettings()?.deviceId ?? "";
      setSelectedCamera(activeId);
    } catch (e) {
      setCamError(String(e));
    }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (open) {
      setCaptured(null);
      setCamError(null);
      setCameras([]);
      setSelectedCamera("");
      setBrightness(100);
      setContrast(100);
      setSaturation(100);
      startStream();
    }
    return () => { if (open) stopStream(); };
  }, [open, startStream, stopStream]);

  const getCroppedDataUrl = useCallback((): string => {
    const img = imgRef.current;
    if (!img) return captured ?? "";
    const hasCrop = completedCrop && completedCrop.width > 0 && completedCrop.height > 0;
    const filterStr = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    const hasFilter = brightness !== 100 || contrast !== 100 || saturation !== 100;
    if (!hasCrop && !hasFilter) return captured ?? "";
    const scaleX = img.naturalWidth / img.width;
    const scaleY = img.naturalHeight / img.height;
    const canvas = document.createElement("canvas");
    if (hasCrop) {
      canvas.width = Math.round(completedCrop.width * scaleX);
      canvas.height = Math.round(completedCrop.height * scaleY);
    } else {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return captured ?? "";
    ctx.filter = filterStr;
    if (hasCrop) {
      ctx.drawImage(
        img,
        completedCrop.x * scaleX, completedCrop.y * scaleY,
        completedCrop.width * scaleX, completedCrop.height * scaleY,
        0, 0, canvas.width, canvas.height,
      );
    } else {
      ctx.drawImage(img, 0, 0);
    }
    return canvas.toDataURL("image/jpeg", 0.9);
  }, [captured, completedCrop, brightness, contrast, saturation]);

  const capture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    setCaptured(dataUrl);
    setCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
    setCompletedCrop(undefined);
    stopStream();
  };

  const retake = () => {
    setCaptured(null);
    setCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
    setCompletedCrop(undefined);
    setBrightness(100);
    setContrast(100);
    setSaturation(100);
    startStream(selectedCamera || undefined);
  };

  if (!open) return null;
  return createPortal(
    /* outer: full-screen scrollable backdrop — no flex centering, content stacks from top */
    <div
      style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, backgroundColor: "rgba(0,0,0,0.7)", overflowY: "auto", padding: "20px 16px" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* card: plain block, centered by auto margins */}
      <div
        style={{ background: "var(--bg-surface)", borderRadius: 12, padding: 16, width: "100%", maxWidth: 860, marginLeft: "auto", marginRight: "auto", border: "1px solid var(--border-soft, #333)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontWeight: 500, fontSize: 14, color: "var(--text-primary)" }}>Take a photo</span>
          <button
            type="button"
            onClick={() => { stopStream(); onClose(); }}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 4, border: "none", background: "none", cursor: "pointer", color: "var(--text-muted)" }}
          >
            <X size={14} />
          </button>
        </div>
        {camError && (
          <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>Camera error: {camError}</p>
        )}
        {/* camera selector — only shown when multiple cameras are available, hidden after capture */}
        {cameras.length > 1 && !captured && (
          <div style={{ marginBottom: 8 }}>
            <select
              value={selectedCamera}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedCamera(id);
                stopStream();
                startStream(id);
              }}
              style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-soft, #333)", background: "var(--bg-surface)", color: "var(--text-primary)", cursor: "pointer", maxWidth: "100%" }}
            >
              {cameras.map((cam, i) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* live video: resizable container, video fills it via absolute positioning (pure CSS, no JS) */}
        {!captured ? (
          <div style={{ position: "relative", resize: "both", overflow: "hidden", width: "100%", height: 460, minWidth: 200, minHeight: 120, borderRadius: 8, background: "#000" }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "contain", filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)` }}
            />
          </div>
        ) : (
          /* captured image: natural height, no resize container needed */
          <>
            <p style={{ fontSize: 12, marginBottom: 4, color: "var(--text-muted)" }}>
              Drag to crop — leave full selection to use the whole photo
            </p>
            <ReactCrop
              crop={crop}
              onChange={(c) => setCrop(c)}
              onComplete={(c) => setCompletedCrop(c)}
            >
              <img
                ref={imgRef}
                src={captured ?? ""}
                alt="Captured"
                style={{ display: "block", width: "100%", height: "auto", filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)` }}
              />
            </ReactCrop>
          </>
        )}
        {/* adjustment sliders */}
        <div style={{ display: "flex", gap: 16, marginTop: 10, marginBottom: 4, flexWrap: "wrap", alignItems: "center" }}>
          {(["Brightness", "Contrast", "Saturation"] as const).map((label) => {
            const val = label === "Brightness" ? brightness : label === "Contrast" ? contrast : saturation;
            const set = label === "Brightness" ? setBrightness : label === "Contrast" ? setContrast : setSaturation;
            return (
              <label key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
                {label}
                <input type="range" min={0} max={200} value={val}
                  onChange={(e) => set(Number(e.target.value))}
                  style={{ width: 90, accentColor: "var(--accent-indigo, #6366f1)" }} />
                <span style={{ minWidth: 34, fontSize: 11 }}>{val}%</span>
              </label>
            );
          })}
          <button type="button"
            onClick={() => { setBrightness(100); setContrast(100); setSaturation(100); }}
            style={{ fontSize: 12, padding: "2px 8px", border: "1px solid var(--border-soft, #333)", background: "none", borderRadius: 4, cursor: "pointer", color: "var(--text-muted)" }}>
            Reset
          </button>
        </div>
        {/* buttons: plain block div — always rendered below media, never clipped */}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {!captured ? (
            <button
              type="button"
              onClick={capture}
              disabled={!!camError}
              style={{ flex: 1, height: 36, borderRadius: 8, border: "none", background: "var(--accent-indigo, #6366f1)", color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              <Camera size={13} /> Take Photo
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { onInline(getCroppedDataUrl()); onClose(); }}
                style={{ flex: 1, height: 36, borderRadius: 8, border: "none", background: "var(--accent-indigo, #6366f1)", color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
              >
                Insert Inline
              </button>
              <button
                type="button"
                onClick={() => { onAttach(getCroppedDataUrl()); onClose(); }}
                style={{ flex: 1, height: 36, borderRadius: 8, border: "none", background: "var(--accent-indigo, #6366f1)", fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#fff" }}
              >
                Attach as File
              </button>
              <button
                type="button"
                onClick={retake}
                style={{ height: 36, padding: "0 12px", borderRadius: 8, border: "none", background: "var(--accent-indigo, #6366f1)", fontSize: 13, cursor: "pointer", color: "#fff" }}
              >
                Retake
              </button>
            </>
          )}
        </div>
        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
    </div>,
    document.body,
  );
}

function InlineEmojiButton({ onEmoji }: { onEmoji: (data: EmojiClickData) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        title="Insert emoji"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded transition-colors text-muted hover:text-primary hover:bg-hover"
      >
        <Smile size={13} />
      </button>
      <PortalEmojiPicker
        anchorRef={ref}
        open={open}
        onEmojiClick={onEmoji}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

function HighlightPicker({ currentHighlight, onHighlight }: { currentHighlight: string | null; onHighlight: (color: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && containerRef.current && !containerRef.current.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = (color: string | null) => { onHighlight(color); setOpen(false); };
  const barColor = currentHighlight ?? "#e5e7eb";

  return (
    <div ref={containerRef} className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Highlight color"
        onClick={() => setOpen((v) => !v)}
        className="flex flex-col h-7 w-7 items-center justify-center gap-px rounded-md transition-colors text-muted hover:bg-hover hover:text-primary"
      >
        <Highlighter size={12} />
        <span className="h-[3px] w-[14px] rounded-[1px]" style={{ backgroundColor: barColor }} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 rounded-lg shadow-lg border border-soft bg-raised p-2" style={{ minWidth: 130 }}>
          <div className="grid grid-cols-5 gap-1">
            {PRESET_HIGHLIGHTS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => pick(c)}
                className="h-5 w-5 rounded-sm transition-transform hover:scale-110 focus:outline-none"
                style={{
                  backgroundColor: c,
                  border: c === currentHighlight ? "2px solid #4f46e5" : "1px solid #d1d5db",
                }}
              />
            ))}
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-soft flex flex-col gap-0.5">
            <input
              ref={inputRef}
              type="color"
              defaultValue={currentHighlight ?? "#fef08a"}
              className="sr-only"
              onInput={(e) => pick((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              className="w-full text-left text-[11px] text-secondary hover:text-primary px-1 py-0.5 rounded hover:bg-hover"
              onClick={() => inputRef.current?.click()}
            >
              Custom…
            </button>
            {currentHighlight && (
              <button
                type="button"
                className="w-full text-left text-[11px] text-secondary hover:text-primary px-1 py-0.5 rounded hover:bg-hover"
                onClick={() => pick(null)}
              >
                Clear highlight
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ColorPicker({ currentColor, onColor }: { currentColor: string; onColor: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && containerRef.current && !containerRef.current.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = (color: string) => { onColor(color); setOpen(false); };

  return (
    <div ref={containerRef} className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Font color"
        onClick={() => setOpen((v) => !v)}
        className="flex flex-col h-7 w-7 items-center justify-center gap-px rounded-md transition-colors text-muted hover:bg-hover hover:text-primary"
      >
        <span className="text-[12px] font-bold leading-none" style={{ color: currentColor }}>A</span>
        <span className="h-[3px] w-[14px] rounded-[1px]" style={{ backgroundColor: currentColor === "#ffffff" ? "#e5e7eb" : currentColor }} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 rounded-lg shadow-lg border border-soft bg-raised p-2" style={{ minWidth: 130 }}>
          <div className="grid grid-cols-5 gap-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => pick(c)}
                className="h-5 w-5 rounded-sm transition-transform hover:scale-110 focus:outline-none"
                style={{
                  backgroundColor: c,
                  border: c === currentColor ? "2px solid #4f46e5" : c === "#ffffff" ? "1px solid #d1d5db" : "1px solid transparent",
                }}
              />
            ))}
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-soft">
            <input
              ref={inputRef}
              type="color"
              defaultValue={currentColor}
              className="sr-only"
              onInput={(e) => pick((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              className="w-full text-left text-[11px] text-secondary hover:text-primary px-1 py-0.5 rounded hover:bg-hover"
              onClick={() => inputRef.current?.click()}
            >
              Custom…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "text-white"
          : "text-muted hover:bg-hover hover:text-primary",
      )}
      style={active ? { backgroundColor: "#4f46e5", color: "#ffffff" } : undefined}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="h-4 w-px mx-1 bg-[color:var(--border-strong)]" />;
}

/** Ensures a pre-filled address string ends with ", " so all tokens render as chips. */
function withAddrTrailingComma(s: string): string {
  if (!s.trim()) return s;
  return /[,;]\s*$/.test(s) ? s : s + ", ";
}

function AddrRow({
  label,
  children,
  trailing,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 min-h-[28px]">
      <span className="w-[60px] shrink-0 text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted pt-[5px]">
        {label}
      </span>
      <div className="flex-1 min-w-0 flex items-center pt-0.5">{children}</div>
      {trailing}
    </div>
  );
}

function HeaderIconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-primary"
    >
      {children}
    </button>
  );
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}


