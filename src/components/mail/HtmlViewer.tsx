import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { Copy, Download, ExternalLink, ImageOff } from "lucide-react";
import { useUiStore } from "@/stores/ui";
import { useComposerStore } from "@/stores/composer";
import { flog } from "@/lib/logger";

interface Props {
  html: string;
  uid: number;
}

// Strips remote resources from sanitized HTML. Returns the modified HTML
// plus a count of blocked <img> tags so the reader can show a "load images"
// banner when policy is "ask".
function applyImagePolicy(html: string): { html: string; blocked: number } {
  const template = document.createElement("template");
  template.innerHTML = html;
  let blocked = 0;

  const stripRemote = (el: Element, attr: string): boolean => {
    const v = el.getAttribute(attr);
    if (v && /^https?:/i.test(v)) {
      el.removeAttribute(attr);
      return true;
    }
    return false;
  };

  for (const img of Array.from(template.content.querySelectorAll("img"))) {
    let any = false;
    if (stripRemote(img, "src")) any = true;
    if (stripRemote(img, "srcset")) any = true;
    if (any) {
      blocked++;
      // Keep an alt hint so the reader shows the broken-image placeholder
      // only when the email had one; otherwise collapse the tag.
      if (!img.getAttribute("alt")) img.remove();
    }
  }
  for (const el of Array.from(template.content.querySelectorAll("source"))) {
    stripRemote(el, "src");
    stripRemote(el, "srcset");
  }
  for (const el of Array.from(template.content.querySelectorAll("video,audio"))) {
    stripRemote(el, "src");
    stripRemote(el, "poster");
  }
  for (const el of Array.from(template.content.querySelectorAll("link"))) {
    el.remove();
  }
  for (const el of Array.from(template.content.querySelectorAll("[style]"))) {
    const s = el.getAttribute("style") ?? "";
    if (/url\(\s*['"]?https?:/i.test(s)) {
      const next = s.replace(
        /url\(\s*['"]?https?:[^)'"\s]+['"]?\s*\)/gi,
        "none",
      );
      el.setAttribute("style", next);
    }
  }

  return { html: template.innerHTML, blocked };
}

/**
 * Wraps bare URLs (and `mailto:`-eligible email addresses) in <a> tags so
 * messages whose sender pasted them as plain text become clickable. Skips
 * text inside existing <a>, <code>, <pre>, <script>, <style>, and <textarea>
 * to avoid double-linking or breaking code blocks.
 */
function autolinkify(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  // (scheme://…) | (www.host…) | (bare email)
  const urlRe =
    /\b((?:https?|ftp):\/\/[^\s<>"']+|www\.[^\s<>"']+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

  const isSkip = (n: Node): boolean => {
    for (let p: Node | null = n.parentNode; p; p = p.parentNode) {
      if (p.nodeType !== 1) continue;
      const tag = (p as Element).tagName;
      if (
        tag === "A" ||
        tag === "CODE" ||
        tag === "PRE" ||
        tag === "SCRIPT" ||
        tag === "STYLE" ||
        tag === "TEXTAREA"
      ) {
        return true;
      }
    }
    return false;
  };

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null = null;
  while ((n = walker.nextNode())) {
    if (isSkip(n)) continue;
    const t = n as Text;
    if (urlRe.test(t.data)) targets.push(t);
    urlRe.lastIndex = 0;
  }

  for (const t of targets) {
    const text = t.data;
    const frag = document.createDocumentFragment();
    let last = 0;
    urlRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text))) {
      let raw = m[0];
      let trailing = "";
      // Trim common trailing punctuation that almost never belongs to the URL.
      const trim = raw.match(/[)\].,;:!?'"]+$/);
      if (trim) {
        trailing = trim[0];
        raw = raw.slice(0, -trailing.length);
      }
      if (raw.length === 0) {
        last = m.index + m[0].length;
        continue;
      }
      const start = m.index;
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const a = document.createElement("a");
      const href = raw.includes("@") && !/^[a-z]+:/i.test(raw)
        ? `mailto:${raw}`
        : /^www\./i.test(raw)
          ? `http://${raw}`
          : raw;
      a.setAttribute("href", href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.textContent = raw;
      frag.appendChild(a);
      if (trailing) frag.appendChild(document.createTextNode(trailing));
      last = start + raw.length + trailing.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    t.parentNode?.replaceChild(frag, t);
  }

  return template.innerHTML;
}

/**
 * Removes known quoted-reply containers from sanitized HTML.
 */
function stripQuotedHtml(html: string): { main: string; hasQuotes: boolean } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const body = doc.body;
  let removed = false;

  // Pass 1a: Named wrapper elements (Gmail, Yahoo, Outlook Web, Apple Mail)
  for (const sel of [
    "div.gmail_quote", "div.gmail_extra", "div.gmail_attr", "div.yahoo_quoted",
    "div#appendonsend", "div[id*='divRplyFwdMsg']", ".moz-cite-prefix",
    'blockquote[type="cite"]',
  ]) {
    for (const el of Array.from(body.querySelectorAll(sel))) {
      el.remove();
      removed = true;
    }
  }

  // Pass 1b: Outlook forward/reply header block — identified by its CSS border-top
  // separator line and containing From/Subject fields.
  if (!removed) {
    for (const el of Array.from(body.querySelectorAll('div[style*="border-top"]'))) {
      const txt = el.textContent ?? "";
      if (/from\s*:/i.test(txt) && /subject\s*:/i.test(txt)) {
        // Remove el and all following siblings at each ancestor level up to body.
        // This preserves content BEFORE the quote separator.
        let cur: Node = el;
        while (cur.parentNode && cur.parentNode !== body) {
          const parent = cur.parentNode;
          // Remove cur and every sibling that follows it
          let toRemove: Node | null = cur;
          while (toRemove) {
            const next: Node | null = toRemove.nextSibling;
            parent.removeChild(toRemove);
            toRemove = next;
          }
          cur = parent;
        }
        // cur is now a direct child of body — remove any body-level siblings after it
        let sib = cur.nextSibling;
        while (sib) { const n = sib.nextSibling; cur.parentNode?.removeChild(sib); sib = n; }
        removed = true;
        break;
      }
    }
  }

  // Pass 2: Search body.innerHTML directly for separator text patterns and
  // truncate the HTML string at the match position. Re-parsing the truncated
  // fragment auto-closes any open tags. Works when the separator appears as a
  // contiguous string in the raw HTML (plain-text and simple HTML emails).
  const bodyHtml = body.innerHTML;
  const inlinePatterns: RegExp[] = [
    /-{3,}\s*original\s+message\s*-{3,}/i,   // ----- Original message -----
    // Real attribution headers always start with a capitalized "On" at the
    // beginning of a line / paragraph (preceded by `>`, newline, or start of
    // string). Anchoring on capitalization AND a block boundary prevents
    // matching mid-sentence prose like "… on Tuesday. -Clarence" that happens
    // to be followed (in a separate paragraph) by a real quote header.
    /(?<=^|[\r\n>])\s*On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{2,199}\s+wrote:/,
  ];

  let bestIdx = -1;
  for (const re of inlinePatterns) {
    const m = re.exec(bodyHtml);
    if (m && m.index > 5 && (bestIdx === -1 || m.index < bestIdx)) {
      bestIdx = m.index;
    }
  }

  if (bestIdx > 0) {
    // Cut the HTML string at the separator position and re-parse to close open tags
    const truncated = bodyHtml.slice(0, bestIdx);
    const tmp = new DOMParser().parseFromString(
      `<!doctype html><html><body>${truncated}</body></html>`,
      "text/html",
    );
    body.innerHTML = tmp.body.innerHTML;
    removed = true;
  }

  // Pass 3: textContent-based search — handles separators split across HTML spans
  // (common in Outlook Word-format emails where each word may be its own <span>).
  // Only runs when Pass 2 didn't already strip.
  if (!removed) {
    const fullText = body.textContent ?? "";
    const textPatterns: RegExp[] = [
      /-{3,}\s*original\s+message\s*-{3,}/i,
      // Capital `On` only — textContent collapses block boundaries, so case is
      // the most reliable distinguisher between real attribution headers and
      // in-prose phrases like "… on Tuesday. -Clarence".
      /\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d).{2,199}\s+wrote:/,
      /from\s*:[\s\S]{1,200}(?:sent|date)\s*:[\s\S]{1,200}to\s*:[\s\S]{1,200}subject\s*:/i,
    ];
    let earliest = -1;
    for (const re of textPatterns) {
      const m = re.exec(fullText);
      if (m && m.index > 5 && (earliest === -1 || m.index < earliest)) {
        earliest = m.index;
      }
    }
    if (earliest > 0) {
      let charCount = 0;
      const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let tNode: Node | null;
      while ((tNode = walker.nextNode())) {
        const text = tNode.textContent ?? "";
        if (charCount + text.length > earliest) {
          const offset = earliest - charCount;
          // Truncate this text node at the cut point
          tNode.textContent = text.slice(0, offset);
          // Remove all subsequent siblings of this text node
          let sib: Node | null = tNode.nextSibling;
          while (sib) { const n = sib.nextSibling; tNode.parentNode?.removeChild(sib); sib = n; }
          // Walk up to body, removing right-siblings of each ancestor
          let anc: Node | null = tNode.parentNode;
          while (anc && anc !== body) {
            let rs: Node | null = anc.nextSibling;
            while (rs) { const n = rs.nextSibling; anc.parentNode?.removeChild(rs); rs = n; }
            anc = anc.parentNode;
          }
          removed = true;
          break;
        }
        charCount += text.length;
      }
    }
  }

  return { main: body.innerHTML.trim(), hasQuotes: removed };
}

interface CtxLink {
  href: string;
  x: number;
  y: number;
}

interface CtxImage {
  src: string;
  x: number;
  y: number;
}

async function downloadImage(src: string) {
  try {
    let bytes: Uint8Array;
    let defaultName = "image.png";

    if (src.startsWith("data:")) {
      const _parts = src.split(",", 2);
      const header: string = _parts[0] ?? "";
      const b64 = _parts[1] ?? "";
      const mime = header.match(/data:([^;]+)/)?.[1] ?? "image/png";
      const ext = mime.split("/")[1]?.split("+")[0] ?? "png";
      defaultName = `image.${ext}`;
      const binary = b64 ? atob(b64) : "";
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      // Fetch through Tauri's Rust HTTP client — bypasses WebView2 network stack
      try { defaultName = new URL(src).pathname.split("/").pop() || "image.jpg"; } catch { /* ignore */ }
      const resp = await tauriFetch(src);
      const ab = await resp.arrayBuffer();
      bytes = new Uint8Array(ab);
    }

    // ext used for file dialog filter
    void defaultName.split(".").pop();
    const path = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] }],
    });
    if (!path) return;
    await writeFile(path, bytes);
  } catch (err) {
    flog.error("Save image failed:", err);
  }
}

export function HtmlViewer({ html, uid }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const remoteImages = useUiStore((s) => s.remoteImages);
  const allowedImageUids = useUiStore((s) => s.allowedImageUids);
  const allowImagesForUid = useUiStore((s) => s.allowImagesForUid);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);

  const [showFull, setShowFull] = useState(false);
  const [hoveredHref, setHoveredHref] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxImage, setCtxImage] = useState<CtxImage | null>(null);
  const [ctxLink, setCtxLink] = useState<CtxLink | null>(null);

  // Reset "show full" when a different message is opened
  useEffect(() => { setShowFull(false); }, [uid]);

  // Dismiss image context menu on outside click
  useEffect(() => {
    if (!ctxImage) return;
    const dismiss = () => setCtxImage(null);
    window.addEventListener("mousedown", dismiss, { once: true });
    return () => window.removeEventListener("mousedown", dismiss);
  }, [ctxImage]);

  // Dismiss link context menu on outside click
  useEffect(() => {
    if (!ctxLink) return;
    const dismiss = () => setCtxLink(null);
    window.addEventListener("mousedown", dismiss, { once: true });
    return () => window.removeEventListener("mousedown", dismiss);
  }, [ctxLink]);

  const allowed =
    remoteImages === "always" || allowedImageUids.includes(uid);

  const { clean, blocked, trimmed, hasQuotes } = useMemo(() => {
    const sanitized = DOMPurify.sanitize(html, {
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
      ALLOW_DATA_ATTR: false,
    });
    let full: string;
    let blockedCount: number;
    if (allowed) {
      full = sanitized;
      blockedCount = 0;
    } else {
      const result = applyImagePolicy(sanitized);
      full = result.html;
      blockedCount = result.blocked;
    }
    full = autolinkify(full);
    const { main, hasQuotes: hq } = stripQuotedHtml(full);

    return { clean: full, blocked: blockedCount, trimmed: main, hasQuotes: hq };
  }, [html, allowed, uid]);

  const renderedHtml = showFull ? clean : trimmed;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    const fg = getComputedStyle(document.documentElement).getPropertyValue("--fg-primary");
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-raised");
    const linkColor = getComputedStyle(document.documentElement).getPropertyValue("--accent");

    // Detect dark theme by checking if the background luminance is low.
    // Parse the CSS color value to determine brightness.
    const isDark = (() => {
      const tmp = document.createElement("div");
      tmp.style.color = bg.trim();
      document.body.appendChild(tmp);
      const computed = getComputedStyle(tmp).color;
      document.body.removeChild(tmp);
      const m = computed.match(/\d+/g);
      if (!m || m.length < 3) return false;
      const r = parseInt(m[0] ?? "0");
      const g = parseInt(m[1] ?? "0");
      const b = parseInt(m[2] ?? "0");
      // Standard luminance formula
      return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
    })();

    doc.open();
    doc.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      html, body { margin: 0; padding: 0; }
      body {
        font-family: Inter, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: ${fg.trim()};
        background: ${bg.trim()};
        padding: 24px 28px;
        word-wrap: break-word;
      }
      a { color: ${linkColor.trim()}; text-decoration: none; }
      a:hover { text-decoration: underline; }
      img { max-width: 100%; height: auto; }
      blockquote {
        border-left: 3px solid rgba(128, 128, 128, 0.25);
        margin: 0;
        padding: 0 0 0 16px;
        color: ${fg.trim()};
        opacity: 0.8;
      }
      pre { overflow-x: auto; background: rgba(128,128,128,0.08); padding: 10px; border-radius: 6px; }
      ${isDark ? `
      /* Dark theme: override hardcoded dark/black text colors that are invisible on dark backgrounds.
         We target common patterns used in HTML emails. */
      *:not(a) {
        color: inherit !important;
      }
      body, body * {
        border-color: rgba(128,128,128,0.3) !important;
      }
      /* Restore white/light text that was intentionally light */
      [style*="color:#fff"], [style*="color: #fff"],
      [style*="color:white"], [style*="color: white"],
      [style*="color:#ffffff"], [style*="color: #ffffff"],
      [style*="color:rgb(255,255,255)"], [style*="color: rgb(255,255,255)"] {
        color: #ffffff !important;
      }
      /* Let background colors through — some emails use colored sections */
      [bgcolor], [style*="background"] {
        color: inherit !important;
      }
      ` : ''}
    </style>
  </head>
  <body>${renderedHtml}</body>
</html>`);
    doc.close();

    // Auto-size the iframe to its full content height so it flows naturally
    // inside the scrollable conversation list instead of clipping.
    const sizeIframe = () => {
      const h = iframe.contentDocument?.documentElement.scrollHeight ?? 0;
      if (h > 0) iframe.style.height = `${h}px`;
    };
    const raf = requestAnimationFrame(sizeIframe);
    // Re-measure after images / fonts finish loading
    iframe.addEventListener("load", sizeIframe);

    // Intercept link clicks
    const onClick = (event: Event) => {
      let node = event.target as Node | null;
      while (node && node.nodeType === 1 && (node as Element).tagName !== "A") {
        node = (node as Element).parentElement;
      }
      if (!node || node.nodeType !== 1) return;
      const anchor = node as HTMLAnchorElement;
      const href = anchor.getAttribute("href") ?? "";
      if (!href) return;
      const lower = href.toLowerCase();
      if (lower.startsWith("mailto:")) {
        event.preventDefault();
        // Parse the mailto: URI — extract address and optional subject/body params
        const withoutScheme = href.slice("mailto:".length);
        const [addressPart, queryPart] = withoutScheme.split("?");
        const to = decodeURIComponent(addressPart ?? "").trim();
        const params = new URLSearchParams(queryPart ?? "");
        const subject = params.get("subject") ?? undefined;
        const body = params.get("body");
        const bodyHtml = body ? `<p>${body.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` : undefined;
        openComposeWith({ to, ...(subject ? { subject } : {}), ...(bodyHtml ? { bodyHtml } : {}) });
        return;
      }
      if (
        lower.startsWith("http://") ||
        lower.startsWith("https://") ||
        lower.startsWith("tel:")
      ) {
        event.preventDefault();
        openUrl(href).catch((err) => {
          flog.error(`openUrl failed for ${href}:`, err);
        });
        return;
      }
      // Anything else (javascript:, data:, file:, in-page #anchor) gets blocked
      // outright — we don't trust it and the iframe sandbox would have
      // navigated the inner frame to the broken-CSP screen anyway.
      event.preventDefault();
    };
    doc.addEventListener("click", onClick, true);

    // Show hovered link URL
    const onMouseOver = (event: Event) => {
      let node = event.target as Node | null;
      while (node && node.nodeType === 1 && (node as Element).tagName !== "A") {
        node = (node as Element).parentElement;
      }
      if (!node || (node as Element).tagName !== "A") { setHoveredHref(null); return; }
      const href = (node as HTMLAnchorElement).getAttribute("href") ?? "";
      setHoveredHref(href || null);
    };
    const onMouseOut = () => { setHoveredHref(null); setTooltipPos(null); };
    const onMouseMove = (event: Event) => {
      const me = event as MouseEvent;
      const rect = iframe.getBoundingClientRect();
      setTooltipPos({ x: rect.left + me.clientX, y: rect.top + me.clientY });
    };
    doc.addEventListener("mouseover", onMouseOver, true);
    doc.addEventListener("mouseout", onMouseOut, true);
    doc.addEventListener("mousemove", onMouseMove, true);

    // Intercept the native WebView2 context menu. When text is selected,
    // let the native menu through so the user can copy. On images, show our
    // own safe save menu. On links, show a copy-link menu. Suppress otherwise.
    const onContextMenu = (e: Event) => {
      const me = e as MouseEvent;

      // Allow the native menu when text is selected so "Copy" works.
      const sel = doc.getSelection();
      if (sel && sel.toString().trim().length > 0) return;

      e.preventDefault();
      const rect = iframe.getBoundingClientRect();
      const x = rect.left + me.clientX;
      const y = rect.top + me.clientY;

      // Check for image
      let imgNode: Element | null = me.target as Element;
      while (imgNode && imgNode.tagName !== "IMG") imgNode = imgNode.parentElement;
      if (imgNode) {
        const img = imgNode as HTMLImageElement;
        const src = img.getAttribute("src") ?? img.src ?? "";
        if (src && !src.startsWith("blob:")) {
          setCtxImage({ src, x, y });
          return;
        }
      }

      // Check for link
      let linkNode: Element | null = me.target as Element;
      while (linkNode && linkNode.tagName !== "A") linkNode = linkNode.parentElement;
      if (linkNode) {
        const href = (linkNode as HTMLAnchorElement).getAttribute("href") ?? "";
        if (href) {
          setCtxLink({ href, x, y });
          return;
        }
      }
    };
    doc.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("contextmenu", onContextMenu, true);
      doc.removeEventListener("mouseover", onMouseOver, true);
      doc.removeEventListener("mouseout", onMouseOut, true);
      doc.removeEventListener("mousemove", onMouseMove, true);
      iframe.removeEventListener("load", sizeIframe);
      cancelAnimationFrame(raf);
    };
  }, [renderedHtml]);

  const showBanner = remoteImages === "ask" && blocked > 0 && !allowed;

  return (
    <div className="flex flex-col">
      {showBanner && (
        <div
          style={{
            background: "var(--bg-sunken)",
            borderBottomColor: "var(--border-soft)",
          }}
          className="flex items-center gap-3 px-6 py-2 border-b shrink-0"
        >
          <ImageOff size={14} className="text-muted shrink-0" />
          <span className="text-[12.5px] text-secondary flex-1 min-w-0">
            {blocked} {blocked === 1 ? "image" : "images"} blocked to prevent
            tracking pixels.
          </span>
          <button
            type="button"
            onClick={() => allowImagesForUid(uid)}
            style={{ color: "var(--accent)" }}
            className="text-[12.5px] font-medium hover:underline"
          >
            Load images
          </button>
        </div>
      )}
      <div className="relative">
        <iframe
          ref={iframeRef}
          sandbox="allow-same-origin"
          className="w-full border-0 bg-raised"
          title="Email content"
        />
        {ctxImage && (
          <div
            className="fixed z-50 rounded shadow-lg overflow-hidden"
            style={{
              left: ctxImage.x,
              top: ctxImage.y,
              background: "var(--bg-raised)",
              border: "1px solid var(--border-soft)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
              minWidth: 160,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-[13px] text-left hover:bg-[var(--bg-hover)] transition-colors"
              style={{ color: "var(--fg-primary)" }}
              onClick={() => { setCtxImage(null); downloadImage(ctxImage.src); }}
            >
              <Download size={13} className="shrink-0 opacity-70" />
              Save image
            </button>
          </div>
        )}
        {ctxLink && (
          <div
            className="fixed z-50 rounded shadow-lg overflow-hidden"
            style={{
              left: ctxLink.x,
              top: ctxLink.y,
              background: "var(--bg-raised)",
              border: "1px solid var(--border-soft)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
              minWidth: 180,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-[13px] text-left hover:bg-[var(--bg-hover)] transition-colors"
              style={{ color: "var(--fg-primary)" }}
              onClick={() => {
                setCtxLink(null);
                navigator.clipboard.writeText(ctxLink.href).catch(() => {});
              }}
            >
              <Copy size={13} className="shrink-0 opacity-70" />
              Copy link
            </button>
            <button
              type="button"
              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-[13px] text-left hover:bg-[var(--bg-hover)] transition-colors"
              style={{ color: "var(--fg-primary)" }}
              onClick={() => {
                setCtxLink(null);
                const href = ctxLink.href;
                const lower = href.toLowerCase();
                if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:") || lower.startsWith("tel:")) {
                  openUrl(href).catch(() => {});
                }
              }}
            >
              <ExternalLink size={13} className="shrink-0 opacity-70" />
              Open link
            </button>
          </div>
        )}
        {hoveredHref && tooltipPos && (
          <div
            className="fixed max-w-[60vw] truncate rounded px-2 py-0.5 text-[11px] pointer-events-none select-none"
            style={{
              left: tooltipPos.x + 14,
              top: tooltipPos.y + 18,
              background: "var(--bg-raised)",
              color: "var(--fg-secondary)",
              border: "1px solid var(--border-soft)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
              zIndex: 9999,
            }}
          >
            {hoveredHref}
          </div>
        )}
      </div>
      {hasQuotes && (
        <button
          type="button"
          onClick={() => setShowFull((v) => !v)}
          className="shrink-0 text-left px-6 py-2 text-[12px] text-muted hover:text-primary transition-colors border-t"
          style={{ borderColor: "var(--border-soft)" }}
        >
          {showFull ? "▲ Hide quoted text" : "▼ Show quoted text"}
        </button>
      )}
    </div>
  );
}
