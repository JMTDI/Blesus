import { useEffect, useRef, useState, useCallback, forwardRef, type CSSProperties } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerCode from "pdfjs-dist/build/pdf.worker.min.mjs?raw";
import { invoke } from "@tauri-apps/api/core";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import {
  X,
  Loader2,
  Search,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Download,
  Images,
  Printer,
  Maximize2,
  Minimize2,
  Pencil,
  PenLine,
  Square,
  Circle as CircleIcon,
  ArrowRight,
  Type,
  Highlighter,
  Paintbrush,
  Undo2,
  Trash2,
  MailPlus,
  Reply,
} from "lucide-react";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { tempDir } from "@tauri-apps/api/path";
import jsPDF from "jspdf";
import { cn } from "@/lib/cn";
import { ipc, type Attachment, type OutgoingAttachment } from "@/lib/ipc";
import { useComposerStore } from "@/stores/composer";
import { toast } from "@/stores/toasts";
import { getAccount, getAccountSecrets, getOcrCache, setOcrCache } from "@/lib/db";
import type { OcrWord } from "@/lib/db";
import { loadAttachmentB64 } from "@/lib/attachmentCache";
import { useAttachmentPreviewStore } from "@/stores/attachmentPreview";
import type { PreviewTrack } from "@/stores/attachmentPreview";
import { useImageGalleryStore } from "@/stores/imageGallery";

// Inline the worker as a blob URL — guarantees application/javascript MIME type
// regardless of how Tauri's custom protocol serves .mjs files.
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([pdfWorkerCode], { type: "application/javascript" }),
);

// pdfjs v5 checks window.location.origin and treats custom schemes like tauri://
// as opaque (origin === "null"). When origin is null, it wraps the workerSrc in a
// "CDN wrapper" blob that does `await import(originalUrl)`. That inner import() is
// blocked by our script-src CSP (which doesn't include blob:). Fix: override the
// static _isSameOrigin method to always return true so the CDN wrapper is skipped
// and pdfjs creates new Worker(blobUrl, {type:"module"}) directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pdfjsLib as any).PDFWorker._isSameOrigin = () => true;

// JBig2 / OpenJPEG WASM base directory. Files are copied to public/pdfjs-wasm/
// at build time so Vite serves them as static assets at a stable URL.
// pdfjs v5 requires a trailing slash — it appends filenames itself.
const WASM_BASE_URL = "/pdfjs-wasm/";

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// OcrWord is imported from db.ts

// ---------- Image viewer ----------

export function ImageViewer({
  b64Data,
  contentType,
  initialZoom = 1,
}: {
  b64Data: string;
  contentType: string;
  initialZoom?: number;
}) {
  const [zoom, setZoom] = useState(initialZoom);
  const containerRef = useRef<HTMLDivElement>(null);
  const src = `data:${contentType};base64,${b64Data}`;

  // Ctrl+wheel → zoom in/out
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.min(8, Math.max(0.1, Math.round((z + delta) * 100) / 100)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function handlePrint() {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:0";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!doc) return;
    doc.open();
    doc.write(
      `<!DOCTYPE html><html><head><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
        img { max-width: 100%; max-height: 100vh; object-fit: contain; }
        @page { margin: 0.5cm; }
      </style></head><body><img src="${src}" /></body></html>`,
    );
    doc.close();
    iframe.contentWindow?.addEventListener("load", () => {
      iframe.contentWindow?.print();
      setTimeout(() => document.body.removeChild(iframe), 2000);
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
      >
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}
          title="Zoom out"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[12px] text-muted tabular-nums w-12 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(8, z + 0.25))}
          title="Zoom in"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="text-[11px] text-muted hover:text-primary transition-colors px-1"
        >
          Reset
        </button>
        <div className="w-px h-4 bg-soft mx-1 shrink-0" />
        <button
          type="button"
          onClick={handlePrint}
          title="Print image"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <Printer size={14} />
        </button>
        <span className="ml-auto text-[11px] text-muted select-none">Ctrl+scroll to zoom</span>
      </div>
      {/* Image */}
      <div ref={containerRef} className="flex-1 overflow-auto flex items-center justify-center p-6 bg-[#111]">
        <img
          src={src}
          alt="Attachment"
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "center center",
            maxWidth: "100%",
            display: "block",
            imageRendering: zoom > 2 ? "pixelated" : "auto",
          }}
        />
      </div>
    </div>
  );
}

// ─── Annotation system ──────────────────────────────────────────────────────
type AnnotTool = "pen" | "rect" | "ellipse" | "arrow" | "text" | "highlight" | "highlight-pen";
type AnnotShape =
  | { id: string; type: "pen"; d: string; color: string; width: number }
  | { id: string; type: "rect"; x: number; y: number; w: number; h: number; color: string; width: number }
  | { id: string; type: "ellipse"; cx: number; cy: number; rx: number; ry: number; color: string; width: number }
  | { id: string; type: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { id: string; type: "text"; x: number; y: number; text: string; color: string; fontSize: number; fontFamily: string }
  | { id: string; type: "highlight"; x: number; y: number; w: number; h: number; color: string }
  | { id: string; type: "highlight-pen"; d: string; color: string; width: number };

const ANN_COLORS = [
  "#000000","#ffffff","#ef4444","#f97316","#f59e0b",
  "#facc15","#22c55e","#14b8a6","#3b82f6","#6366f1",
  "#a855f7","#ec4899","#64748b","#78350f","#134e4a",
];
const ANN_FONTS  = ["Arial","Georgia","Courier New","Verdana","Times New Roman"];

function annotArrow(x1: number, y1: number, x2: number, y2: number, sz = 14): string {
  const a = Math.atan2(y2 - y1, x2 - x1), s = Math.PI / 6;
  return `M${x2 - sz * Math.cos(a - s)},${y2 - sz * Math.sin(a - s)} L${x2},${y2} L${x2 - sz * Math.cos(a + s)},${y2 - sz * Math.sin(a + s)}`;
}

/** Draw annotation shapes onto a 2D canvas, scaling coords by scaleX/scaleY. */
function drawAnnotOnCanvas(ctx: CanvasRenderingContext2D, shapes: AnnotShape[], scaleX = 1, scaleY = 1) {
  for (const s of shapes) {
    ctx.save();
    const shapeWidth = ("width" in s) ? (s as unknown as { width: number }).width : 2;
    ctx.strokeStyle = s.color; ctx.lineWidth = shapeWidth * Math.max(scaleX, scaleY); ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (s.type === "pen") {
      const d = s.d.replace(/([-\d.]+),([-\d.]+)/g, (_: string, x: string, y: string) => `${+x * scaleX},${+y * scaleY}`);
      ctx.stroke(new Path2D(d));
    } else if (s.type === "rect") {
      ctx.strokeRect(Math.min(s.x, s.x + s.w) * scaleX, Math.min(s.y, s.y + s.h) * scaleY, Math.abs(s.w) * scaleX, Math.abs(s.h) * scaleY);
    } else if (s.type === "ellipse") {
      ctx.beginPath(); ctx.ellipse(s.cx * scaleX, s.cy * scaleY, s.rx * scaleX, s.ry * scaleY, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (s.type === "arrow") {
      ctx.beginPath(); ctx.moveTo(s.x1 * scaleX, s.y1 * scaleY); ctx.lineTo(s.x2 * scaleX, s.y2 * scaleY); ctx.stroke();
      const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), sz = 14, sp = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo((s.x2 - sz * Math.cos(a - sp)) * scaleX, (s.y2 - sz * Math.sin(a - sp)) * scaleY);
      ctx.lineTo(s.x2 * scaleX, s.y2 * scaleY);
      ctx.lineTo((s.x2 - sz * Math.cos(a + sp)) * scaleX, (s.y2 - sz * Math.sin(a + sp)) * scaleY);
      ctx.stroke();
    } else if (s.type === "text") {
      ctx.fillStyle = s.color; ctx.font = `${s.fontSize * Math.max(scaleX, scaleY)}px ${s.fontFamily}`;
      ctx.fillText(s.text, s.x * scaleX, s.y * scaleY);
    } else if (s.type === "highlight") {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.min(s.x, s.x + s.w) * scaleX, Math.min(s.y, s.y + s.h) * scaleY, Math.abs(s.w) * scaleX, Math.abs(s.h) * scaleY);
    } else if (s.type === "highlight-pen") {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width * Math.max(scaleX, scaleY); ctx.lineCap = "round"; ctx.lineJoin = "round";
      const d = s.d.replace(/([-\d.]+),([-\d.]+)/g, (_: string, x: string, y: string) => `${+x * scaleX},${+y * scaleY}`);
      ctx.stroke(new Path2D(d));
    }
    ctx.restore();
  }
}

function AnnotShapes({ shapes }: { shapes: AnnotShape[] }) {
  return (
    <>
      {shapes.map((s) => {
        if (s.type === "pen")           return <path key={s.id} d={s.d} stroke={s.color} strokeWidth={s.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
        if (s.type === "highlight-pen") return <path key={s.id} d={s.d} stroke={s.color} strokeWidth={s.width} strokeOpacity={0.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
        if (s.type === "rect")      return <rect key={s.id} x={Math.min(s.x, s.x+s.w)} y={Math.min(s.y, s.y+s.h)} width={Math.abs(s.w)} height={Math.abs(s.h)} stroke={s.color} strokeWidth={s.width} fill="none" />;
        if (s.type === "ellipse")   return <ellipse key={s.id} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} stroke={s.color} strokeWidth={s.width} fill="none" />;
        if (s.type === "arrow")     return <g key={s.id}><line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={s.width} strokeLinecap="round" /><path d={annotArrow(s.x1,s.y1,s.x2,s.y2)} stroke={s.color} strokeWidth={s.width} fill="none" strokeLinejoin="round" strokeLinecap="round" /></g>;
        if (s.type === "text")      return <text key={s.id} x={s.x} y={s.y} fill={s.color} fontSize={s.fontSize} fontFamily={s.fontFamily} style={{ userSelect:"none" }}>{s.text}</text>;
        if (s.type === "highlight") return <rect key={s.id} x={Math.min(s.x, s.x+s.w)} y={Math.min(s.y, s.y+s.h)} width={Math.abs(s.w)} height={Math.abs(s.h)} fill={s.color} fillOpacity={0.35} stroke="none" />;
        return null;
      })}
    </>
  );
}

/**
 * Transparent SVG overlay for drawing annotations.
 * coordScale: divide raw SVG coords by this to get stored units (PDF pages use scale > 1).
 */
function AnnotationLayer({
  shapes, tool, color, strokeWidth, fontSize, fontFamily, onAdd, onUndo, coordScale = 1, style,
}: {
  shapes: AnnotShape[]; tool: AnnotTool; color: string; strokeWidth: number;
  fontSize: number; fontFamily: string;
  onAdd: (s: AnnotShape) => void; onUndo: () => void;
  coordScale?: number; style?: CSSProperties;
}) {
  const svgRef  = useRef<SVGSVGElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const drawing = useRef(false);
  const penPath = useRef("");
  const textValRef = useRef("");
  const [preview,  setPreview]  = useState<AnnotShape | null>(null);
  const [textPos,  setTextPos]  = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [_textVal,  setTextVal]  = useState("");

  function coords(e: React.MouseEvent): { x: number; y: number } {
    const svg = svgRef.current!;
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const inv = svg.getScreenCTM()?.inverse();
    if (!inv) return { x: 0, y: 0 };
    const p = pt.matrixTransform(inv);
    return { x: p.x / coordScale, y: p.y / coordScale };
  }

  function onDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    if (tool === "text") {
      e.preventDefault(); e.stopPropagation();
      const { x, y } = coords(e);
      const sx = e.clientX, sy = e.clientY;
      // Build a DOM input directly — sidesteps every React/WebView2 rendering quirk.
      const wrap = document.createElement("div");
      wrap.style.cssText = `position:fixed;left:${sx - 4}px;top:${sy - fsNum - 4}px;z-index:2147483647;background:#fff;border:2px dashed #6366f1;border-radius:4px;padding:2px 4px;box-shadow:0 4px 16px rgba(0,0,0,.25);`;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "Type, then Enter";
      inp.style.cssText = `display:block;width:240px;font-size:${fsNum}px;font-family:${fontFamily};color:${color};background:transparent;outline:none;border:none;padding:2px 4px;`;
      wrap.appendChild(inp);
      document.body.appendChild(wrap);
      const cleanup = () => { wrap.remove(); document.removeEventListener("mousedown", offClick, true); };
      const commit = () => {
        const val = inp.value;
        if (val && val.trim()) {
          onAdd({ id: crypto.randomUUID(), type: "text", x, y, text: val, color, fontSize, fontFamily });
        }
        cleanup();
      };
      const offClick = (ev: MouseEvent) => { if (!wrap.contains(ev.target as Node)) commit(); };
      inp.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { ev.preventDefault(); cleanup(); }
      });
      // Defer the outside-click handler so the originating click doesn't immediately close it.
      setTimeout(() => document.addEventListener("mousedown", offClick, true), 0);
      // Multiple focus attempts to win against WebView2's focus races.
      [0, 30, 100, 250].forEach(ms => setTimeout(() => inp.focus(), ms));
      return;
    }
    e.preventDefault(); e.stopPropagation();
    drawing.current = true;
    const { x, y } = coords(e);
    if (tool === "pen") {
      penPath.current = `M${x.toFixed(1)},${y.toFixed(1)}`;
      setPreview({ id: "__pre", type: "pen", d: penPath.current, color, width: strokeWidth });
    } else if (tool === "rect") {
      setPreview({ id: "__pre", type: "rect", x, y, w: 0, h: 0, color, width: strokeWidth });
    } else if (tool === "ellipse") {
      setPreview({ id: "__pre", type: "ellipse", cx: x, cy: y, rx: 0, ry: 0, color, width: strokeWidth });
    } else if (tool === "arrow") {
      setPreview({ id: "__pre", type: "arrow", x1: x, y1: y, x2: x, y2: y, color, width: strokeWidth });
    } else if (tool === "highlight") {
      setPreview({ id: "__pre", type: "highlight", x, y, w: 0, h: 0, color });
    } else if (tool === "highlight-pen") {
      penPath.current = `M${x.toFixed(1)},${y.toFixed(1)}`;
      setPreview({ id: "__pre", type: "highlight-pen", d: penPath.current, color, width: strokeWidth });
    }
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!drawing.current || !preview) return;
    const { x, y } = coords(e);
    if      (preview.type === "pen")           { penPath.current += ` L${x.toFixed(1)},${y.toFixed(1)}`; setPreview({ ...preview, d: penPath.current }); }
    else if (preview.type === "highlight-pen") { penPath.current += ` L${x.toFixed(1)},${y.toFixed(1)}`; setPreview({ ...preview, d: penPath.current }); }
    else if (preview.type === "rect")           setPreview({ ...preview, w: x - preview.x, h: y - preview.y });
    else if (preview.type === "ellipse")        setPreview({ ...preview, rx: Math.abs(x - preview.cx), ry: Math.abs(y - preview.cy) });
    else if (preview.type === "arrow")          setPreview({ ...preview, x2: x, y2: y });
    else if (preview.type === "highlight")      setPreview({ ...preview, w: x - preview.x, h: y - preview.y });
  }

  function onUp() {
    if (!drawing.current || !preview) return;
    drawing.current = false;
    const c = { ...preview, id: crypto.randomUUID() } as AnnotShape;
    let ok = false;
    if      (c.type === "pen")           ok = penPath.current.includes("L");
    else if (c.type === "highlight-pen") ok = penPath.current.includes("L");
    else if (c.type === "rect")          ok = Math.abs(c.w) > 2 || Math.abs(c.h) > 2;
    else if (c.type === "ellipse")       ok = c.rx > 2 || c.ry > 2;
    else if (c.type === "arrow")         { const dx = c.x2-c.x1, dy = c.y2-c.y1; ok = dx*dx+dy*dy > 9; }
    else if (c.type === "highlight")     ok = Math.abs(c.w) > 2 || Math.abs(c.h) > 2;
    if (ok) onAdd(c);
    setPreview(null);
  }

  // Ctrl+Z for annotation undo — only fires when the text box is closed
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (textPos) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); onUndo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onUndo, textPos]);

const inner = <><AnnotShapes shapes={shapes} />{preview && <AnnotShapes shapes={[preview]} />}</>;

  // text annotation helpers — wired via ref for future UI
  void useRef({ commit: () => { if (textPos) { const val = textValRef.current; if (val.trim()) onAdd({ id: crypto.randomUUID(), type: "text", x: textPos.x, y: textPos.y, text: val, color, fontSize, fontFamily }); } setTextPos(null); setTextVal(""); textValRef.current = ""; }, cancel: () => { setTextPos(null); setTextVal(""); textValRef.current = ""; } });

  const fsNum = typeof fontSize === "number" ? fontSize : (parseInt(String(fontSize)) || 16);

  // Imperatively focus the input after mount AND on every render while textPos is set.
  // autoFocus alone is unreliable in WebView2 when the click that triggered the mount
  // is still being processed by the parent gallery's mouse handlers.
  useEffect(() => {
    if (!textPos) return;
    const tries = [0, 50, 150, 300];
    const ids: number[] = tries.map(ms => window.setTimeout(() => {
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        try { el.setSelectionRange(textValRef.current.length, textValRef.current.length); } catch {}
      }
    }, ms));
    return () => { ids.forEach(id => clearTimeout(id)); };
  }, [textPos]);

  return (
    <>
      <svg
        ref={svgRef}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", overflow: "visible",
          cursor: tool === "text" ? "text" : "crosshair", touchAction: "none",
          letterSpacing: "normal", wordSpacing: "normal", lineHeight: "normal", ...style }}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
      >
        {coordScale !== 1 ? <g transform={`scale(${coordScale})`}>{inner}</g> : inner}
      </svg>
    </>
  );
}

function AnnotationToolbar({
  tool, setTool, color, setColor, strokeWidth, setStrokeWidth,
  fontSize, setFontSize, fontFamily, setFontFamily, onUndo, onClear,
}: {
  tool: AnnotTool; setTool: (t: AnnotTool) => void;
  color: string; setColor: (c: string) => void;
  strokeWidth: number; setStrokeWidth: (w: number) => void;
  fontSize: number; setFontSize: (s: number) => void;
  fontFamily: string; setFontFamily: (f: string) => void;
  onUndo: () => void; onClear: () => void;
}) {
  const tools: [AnnotTool, React.ReactNode, string][] = [
    ["pen",          <PenLine size={13} />,     "Freehand pen"],
    ["highlight-pen",<Paintbrush size={13} />,  "Highlight pen"],
    ["highlight",    <Highlighter size={13} />, "Highlighter (box)"],
    ["rect",         <Square size={13} />,      "Rectangle"],
    ["ellipse",      <CircleIcon size={13} />,  "Ellipse"],
    ["arrow",        <ArrowRight size={13} />,  "Arrow"],
    ["text",         <Type size={13} />,        "Text box"],
  ];
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 flex-wrap"
      style={{
        borderColor: "var(--border-soft)",
        background: "var(--bg-raised)"
      }}
    >
      <div className="flex items-center gap-0.5">
        {tools.map(([t, icon, title]) => (
          <button key={t} type="button" title={title} onClick={() => setTool(t)}
            className={cn("flex items-center justify-center h-7 w-7 rounded-md transition-colors",
              tool === t ? "bg-accent text-white" : "hover:bg-hover text-muted hover:text-primary")}>
            {icon}
          </button>
        ))}
      </div>
      <div className="w-px h-4 bg-soft shrink-0" />
      {/* Color chips */}
      <div className="flex items-center gap-1 flex-wrap">
        {ANN_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} title={c}
            style={{
              background: c,
              outline: color === c ? "2px solid var(--color-accent)" : "2px solid transparent",
              outlineOffset: 2,
              border: c === "#ffffff" ? "1px solid #999" : "1px solid transparent"
            }}
            className="h-4 w-4 rounded-full shrink-0 transition-all" />
        ))}
        {/* Custom color picker */}
        <label
          className="relative h-5 w-5 rounded-full overflow-hidden cursor-pointer border-2 shrink-0 transition-all"
          title="Custom color"
          style={{
            background: ANN_COLORS.includes(color) ? "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" : color,
            borderColor: !ANN_COLORS.includes(color) ? "var(--color-accent)" : "var(--border-soft)",
          }}
        >
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" />
        </label>
      </div>
      <div className="w-px h-4 bg-soft shrink-0" />
      {/* Stroke width */}
      <div className="flex items-center gap-0.5">
        {([2, 4, 7] as const).map((w) => (
          <button key={w} type="button" onClick={() => setStrokeWidth(w)} title={`Stroke ${w}px`}
            className={cn("flex items-center justify-center h-7 w-7 rounded-md transition-colors",
              strokeWidth === w ? "bg-hover ring-1 ring-inset ring-soft" : "hover:bg-hover")}>
            <div className="rounded-full" style={{ width: w + 3, height: w + 3, background: color }} />
          </button>
        ))}
      </div>
      {tool === "text" && (
        <>
          <div className="w-px h-4 bg-soft shrink-0" />
          <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
            className="h-7 px-1.5 rounded-md text-[11px] bg-sunken border border-soft text-primary shrink-0">
            {ANN_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <div className="flex items-center gap-0.5 shrink-0">
            <button type="button" onClick={() => setFontSize(Math.max(8, fontSize - 2))}
              className="h-6 w-5 flex items-center justify-center rounded text-[13px] font-semibold hover:bg-hover text-muted hover:text-primary">−</button>
            <span className="text-[11px] tabular-nums w-7 text-center text-primary select-none">{fontSize}</span>
            <button type="button" onClick={() => setFontSize(Math.min(96, fontSize + 2))}
              className="h-6 w-5 flex items-center justify-center rounded text-[13px] font-semibold hover:bg-hover text-muted hover:text-primary">+</button>
          </div>
        </>
      )}
      <div className="flex-1 min-w-0" />
      <button type="button" onClick={onUndo} title="Undo last (Ctrl+Z)"
        className="flex items-center gap-1.5 h-7 px-2 rounded-md text-[11px] hover:bg-hover text-muted hover:text-primary transition-colors shrink-0">
        <Undo2 size={12} /><span>Undo</span>
      </button>
      <button type="button" onClick={onClear} title="Clear all annotations"
        className="flex items-center gap-1.5 h-7 px-2 rounded-md text-[11px] hover:bg-hover text-muted hover:text-primary transition-colors shrink-0">
        <Trash2 size={12} /><span>Clear</span>
      </button>
    </div>
  );
}

// ---------- PDF viewer ----------

/** Renders one PDF page: canvas + transparent text overlay for selection. */
const PdfPage = forwardRef<HTMLDivElement, {
  pdf: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  track: PreviewTrack | null;
  formValues: Record<string, string | boolean>;
  onInitField: (name: string, defaultValue: string | boolean) => void;
  onFieldChange: (name: string, value: string | boolean) => void;
  onFormDetected: () => void;
  pageAnnotations: AnnotShape[];
  annMode: boolean;
  annTool: AnnotTool;
  annColor: string;
  annStrokeWidth: number;
  annFontSize: number;
  annFontFamily: string;
  onAddAnnotation: (s: AnnotShape) => void;
  onUndoAnnotation: () => void;
  searchQuery: string;
}>(function PdfPage({ pdf, pageNum, scale, track, formValues, onInitField, onFieldChange, onFormDetected, pageAnnotations, annMode, annTool, annColor, annStrokeWidth, annFontSize, annFontFamily, onAddAnnotation, onUndoAnnotation, searchQuery }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderViewport, setRenderViewport] = useState<pdfjsLib.PageViewport | null>(null);
  const [widgetAnnotations, setWidgetAnnotations] = useState<any[]>([]);

  // Text segment data for search highlighting (populated during render)
  const textDataRef = useRef<Array<{ text: string; x: number; y: number; w: number; h: number; start: number; end: number }>>([]);
  const [highlights, setHighlights] = useState<Array<{ x: number; y: number; w: number; h: number }>>([]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy["render"]> | null = null;

    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;

      const viewport = page.getViewport({ scale });
      setRenderViewport(viewport);
      const canvas = canvasRef.current;
      const textLayerEl = textLayerRef.current;
      if (!canvas || !textLayerEl) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      console.log(`[PDF p${pageNum}] canvas ${Math.round(viewport.width)}×${Math.round(viewport.height)} scale=${scale}`);
      const ctx = canvas.getContext("2d");
      if (!ctx) { console.error(`[PDF p${pageNum}] getContext("2d") returned null`); return; }

      // Render canvas and fetch text content in parallel
      let renderErr: unknown = null;
      renderTask = page.render({ canvasContext: ctx, viewport, canvas: canvas });
      const [, content] = await Promise.all([
        renderTask.promise.catch((e) => { renderErr = e; }),
        page.getTextContent(),
      ]);
      // If the component was unmounted / scale changed, bail out before touching any state
      if (cancelled) return;
      if (renderErr) {
        // RenderingCancelledException is expected when a new render supersedes the old one — not a user-visible error
        if ((renderErr as any)?.name === "RenderingCancelledException") return;
        console.error(`[PDF render p${pageNum}]`, renderErr);
        setRenderError(String(renderErr));
        return;
      }
      // Sample centre pixel to confirm canvas has content
      try {
        const px = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        console.log(`[PDF p${pageNum}] centre pixel RGBA: [${[...px]}]`);
      } catch (_) { /* cross-origin or security errors ignored */ }

      textLayerEl.innerHTML = "";
      textLayerEl.style.width = `${viewport.width}px`;
      textLayerEl.style.height = `${viewport.height}px`;

      const newTextData: Array<{ text: string; x: number; y: number; w: number; h: number; start: number; end: number }> = [];
      let textPos = 0;

      if (content.items.length > 0) {
        // Searchable PDF: use pdfjs text positions
        for (const item of content.items) {
          if (!("str" in item) || !item.str) continue;
          const textItem = item as { str: string; transform: number[]; width: number; height: number; fontName?: string };
          const tx = pdfjsLib.Util.transform(viewport.transform, textItem.transform);
          const angle = Math.atan2(tx[1], tx[0]);
          const fontHeight = Math.max(Math.hypot(tx[2], tx[3]), 1);
          const ascent = fontHeight * 0.8;
          const span = document.createElement("span");
          span.textContent = textItem.str;
          const parts = [
            `position:absolute`,
            `left:${tx[4].toFixed(1)}px`,
            `top:${(tx[5] - ascent).toFixed(1)}px`,
            `font-size:${fontHeight.toFixed(1)}px`,
            `font-family:sans-serif`,
            `color:rgba(0,0,0,0.005)`,
            `white-space:pre`,
            `transform-origin:0% 0%`,
            `cursor:text`,
            `line-height:1`,
            `pointer-events:all`,
            `user-select:text`,
            `-webkit-user-select:text`,
          ];
          if (angle !== 0) {
            parts.push(`transform:rotate(${(angle * 180 / Math.PI).toFixed(2)}deg)`);
          }
          span.style.cssText = parts.join(";");
          textLayerEl.appendChild(span);
          // Collect position for search highlighting
          newTextData.push({ text: textItem.str, x: tx[4], y: tx[5] - ascent, w: textItem.width * scale, h: fontHeight, start: textPos, end: textPos + textItem.str.length });
          textPos += textItem.str.length + 1;
        }
        textDataRef.current = newTextData;
        if (!cancelled) setHighlights(computeHighlights(newTextData, searchQueryRef.current));
      } else {
        // Image-only PDF: check persistent cache first, then run OCR.
        try {
          let words: OcrWord[] | null = null;

          // 1. Try the DB cache (populated by a previous open or reindex)
          if (track) {
            const cached = await getOcrCache(
              track.accountId, track.uid,
              track.attachment.index, pageNum,
            ).catch(() => null);
            if (cached) {
              // Cached coords are normalised to scale-1.0 (PDF units); scale up to current display px
              words = cached.map(w => ({
                text: w.text,
                x: w.x * scale,
                y: w.y * scale,
                w: w.w * scale,
                h: w.h * scale,
              }));
            }
          }

          // 2. Cache miss → run Windows OCR at clamped 3× resolution
          if (!words) {
            const MAX_OCR_PX = 2048;
            const rawViewport = page.getViewport({ scale: scale * 3 });
            const clamp = Math.min(1, MAX_OCR_PX / Math.max(rawViewport.width, rawViewport.height));
            const ocrScale = scale * 3 * clamp;
            const ocrViewport = page.getViewport({ scale: ocrScale });
            const ocrCanvas = document.createElement("canvas");
            ocrCanvas.width = ocrViewport.width;
            ocrCanvas.height = ocrViewport.height;
            const ocrCtx = ocrCanvas.getContext("2d");
            if (ocrCtx) {
              await page.render({ canvasContext: ocrCtx, viewport: ocrViewport, canvas: ocrCanvas }).promise;
            }
            const pngBase64 = ocrCanvas.toDataURL("image/png").split(",")[1];
            if (cancelled) return;
            const raw = await invoke<OcrWord[]>("ocr_page", { pngBase64 });
            if (cancelled) return;
            // Normalise to scale-1.0 (PDF units) so the cache is zoom-independent
            const toScale1 = 1 / ocrScale;
            const normalizedWords = raw.map(w => ({
              text: w.text,
              x: w.x * toScale1,
              y: w.y * toScale1,
              w: w.w * toScale1,
              h: w.h * toScale1,
            }));
            // Persist normalised coords
            if (track) {
              setOcrCache(
                track.accountId, track.uid,
                track.attachment.index, pageNum, normalizedWords,
              ).catch(() => {});
            }
            // Scale up to current display px
            words = normalizedWords.map(w => ({
              text: w.text,
              x: w.x * scale,
              y: w.y * scale,
              w: w.w * scale,
              h: w.h * scale,
            }));
          }

          if (cancelled) return;
          for (const word of words) {
            if (!word.text.trim()) continue;
            const h = Math.max(word.h, 1);
            const span = document.createElement("span");
            span.textContent = word.text + " ";
            span.style.cssText = [
              "position:absolute",
              `left:${word.x.toFixed(1)}px`,
              `top:${word.y.toFixed(1)}px`,
              `width:${word.w.toFixed(1)}px`,
              `height:${h.toFixed(1)}px`,
              `font-size:${(h * 0.9).toFixed(1)}px`,
              "color:rgba(0,0,0,0.005)",
              "white-space:pre",
              "cursor:text",
              "user-select:text",
              "-webkit-user-select:text",
              "pointer-events:all",
              "line-height:1",
              "transform-origin:0% 0%",
              "overflow:hidden",
            ].join(";");
            textLayerEl.appendChild(span);
            // Collect position for search highlighting
            newTextData.push({ text: word.text, x: word.x, y: word.y, w: word.w, h: h, start: textPos, end: textPos + word.text.length });
            textPos += word.text.length + 1;
          }
          textDataRef.current = newTextData;
          if (!cancelled) setHighlights(computeHighlights(newTextData, searchQueryRef.current));
        } catch (e) {
          console.error("[OCR] error:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTask) { try { renderTask.cancel(); } catch { /* ignore */ } }
    };
  }, [pdf, pageNum, scale, track]);

  // Keep a ref so the render effect can compute highlights without depending on searchQuery
  const searchQueryRef = useRef(searchQuery);
  useEffect(() => { searchQueryRef.current = searchQuery; });

  // Helper to compute highlight rects from text segments + query
  const computeHighlights = (
    segments: Array<{ text: string; x: number; y: number; w: number; h: number; start: number; end: number }>,
    q: string,
  ) => {
    if (!q.trim() || !segments.length) return [];
    const lower = q.toLowerCase();
    const fullText = segments.map(s => s.text).join(" ").toLowerCase();
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    let matchPos = fullText.indexOf(lower);
    while (matchPos !== -1) {
      const matchEnd = matchPos + lower.length;
      for (const seg of segments) {
        if (seg.end > matchPos && seg.start < matchEnd) {
          rects.push({ x: seg.x, y: seg.y, w: seg.w, h: seg.h });
        }
      }
      matchPos = fullText.indexOf(lower, matchPos + 1);
    }
    return rects;
  };

  // Recompute search highlights whenever the query changes
  useEffect(() => {
    setHighlights(computeHighlights(textDataRef.current, searchQuery));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Fetch form field annotations once per page (not per scale)
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const annotations = await page.getAnnotations();
      if (cancelled) return;
      const widgets = (annotations as any[]).filter(
        (a: any) => a.subtype === "Widget" && !a.hidden && a.fieldName,
      );
      if (widgets.length > 0) {
        setWidgetAnnotations(widgets);
        onFormDetected();
        widgets.forEach((ann: any) => {
          if (!ann.fieldName) return;
          const dv: string | boolean =
            ann.checkBox || ann.radioButton
              ? ann.fieldValue !== "Off" && !!ann.fieldValue
              : String(ann.fieldValue ?? "");
          onInitField(ann.fieldName, dv);
        });
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNum]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      {renderError && (
        <div style={{ background: "#7f1d1d", color: "#fca5a5", fontSize: 11, padding: "4px 8px", fontFamily: "monospace" }}>
          Render error p{pageNum}: {renderError}
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="shadow-2xl"
        style={{ display: "block", pointerEvents: "none" }}
      />
      <div
        ref={textLayerRef}
        className="pdf-text-overlay"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          pointerEvents: "auto",
          userSelect: "text",
          WebkitUserSelect: "text",
          overflow: "visible",
        }}
      />
      {highlights.map((r, i) => (
        <div key={i} style={{
          position: "absolute",
          left: r.x,
          top: r.y,
          width: Math.max(r.w, 4),
          height: Math.max(r.h, 4),
          background: "rgba(255, 200, 0, 0.45)",
          pointerEvents: "none",
          borderRadius: 2,
          mixBlendMode: "multiply",
        }} />
      ))}
      {renderViewport && widgetAnnotations.map((ann: any, i: number) => {
        if (!Array.isArray(ann.rect) || ann.rect.length < 4) return null;
        const t: number[] = renderViewport.transform;
        const sx1 = (ann.rect[0] as number) * t[0]! + (ann.rect[1] as number) * t[2]! + t[4]!;
        const sy1 = (ann.rect[0] as number) * t[1]! + (ann.rect[1] as number) * t[3]! + t[5]!;
        const sx2 = (ann.rect[2] as number) * t[0]! + (ann.rect[3] as number) * t[2]! + t[4]!;
        const sy2 = (ann.rect[2] as number) * t[1]! + (ann.rect[3] as number) * t[3]! + t[5]!;
        const fl = Math.min(sx1, sx2);
        const ft = Math.min(sy1, sy2);
        const fw = Math.abs(sx2 - sx1);
        const fh = Math.abs(sy2 - sy1);
        const name: string = ann.fieldName ?? `field-p${pageNum}-${i}`;
        const val = formValues[name];
        const base: CSSProperties = {
          position: "absolute",
          left: fl,
          top: ft,
          width: fw,
          height: fh,
          boxSizing: "border-box",
          background: "rgba(255,255,255,0.88)",
          border: "1.5px solid rgba(99,102,241,0.45)",
          borderRadius: 2,
          outline: "none",
          fontSize: Math.min(fh * 0.62, 13),
          padding: "1px 3px",
          color: "#111",
          lineHeight: 1.3,
          fontFamily: "sans-serif",
          zIndex: 2,
        };
        if (ann.fieldType === "Tx") {
          if (ann.multiLine) {
            return (
              <textarea
                key={`${name}-${i}`}
                value={typeof val === "string" ? val : ""}
                onChange={(e) => onFieldChange(name, e.target.value)}
                readOnly={ann.readOnly}
                style={{ ...base, resize: "none" }}
              />
            );
          }
          return (
            <input
              key={`${name}-${i}`}
              type="text"
              value={typeof val === "string" ? val : ""}
              onChange={(e) => onFieldChange(name, e.target.value)}
              readOnly={ann.readOnly}
              style={base}
            />
          );
        }
        if (ann.fieldType === "Btn") {
          if (ann.radioButton) {
            return (
              <input
                key={`${name}-${ann.buttonValue ?? i}`}
                type="radio"
                name={name}
                value={ann.buttonValue ?? ""}
                checked={val === ann.buttonValue}
                onChange={() => onFieldChange(name, ann.buttonValue ?? "")}
                disabled={ann.readOnly}
                style={{ ...base, background: "none", border: "none", cursor: "pointer", padding: 0 }}
              />
            );
          }
          return (
            <input
              key={`${name}-${i}`}
              type="checkbox"
              checked={val === true}
              onChange={(e) => onFieldChange(name, e.target.checked)}
              disabled={ann.readOnly}
              style={{ ...base, width: Math.min(fw, fh), background: "none", border: "none", cursor: "pointer", padding: 0 }}
            />
          );
        }
        if (ann.fieldType === "Ch") {
          return (
            <select
              key={`${name}-${i}`}
              value={typeof val === "string" ? val : ""}
              onChange={(e) => onFieldChange(name, e.target.value)}
              disabled={ann.readOnly}
              size={ann.combo ? 1 : undefined}
              style={{ ...base, padding: "1px 2px" }}
            >
              <option value="" />
              {(ann.options ?? []).map((opt: any) => (
                <option key={opt.exportValue} value={opt.exportValue}>
                  {opt.displayValue}
                </option>
              ))}
            </select>
          );
        }
        return null;
      })}
      {/* Static annotation display when not actively drawing */}
      {renderViewport && !annMode && pageAnnotations.length > 0 && (
        <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
          <g transform={`scale(${scale})`}><AnnotShapes shapes={pageAnnotations} /></g>
        </svg>
      )}
      {/* Interactive annotation layer */}
      {renderViewport && annMode && (
        <AnnotationLayer
          shapes={pageAnnotations}
          tool={annTool} color={annColor} strokeWidth={annStrokeWidth}
          fontSize={annFontSize} fontFamily={annFontFamily}
          onAdd={onAddAnnotation} onUndo={onUndoAnnotation}
          coordScale={scale}
        />
      )}
    </div>
  );
});

interface SearchResult {
  page: number;
  snippet: string;
}

export function PdfViewer({ b64Data, track, initialScale = 1.3 }: { b64Data: string; track: PreviewTrack | null; initialScale?: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [scale, setScale] = useState(initialScale);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [hasForm, setHasForm] = useState(false);
  const [pdfFullscreen, setPdfFullscreen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);
  const openReplyForAttachment = useComposerStore((s) => s.openReplyForAttachment);
  const appendAttachmentToOpen = useComposerStore((s) => s.appendAttachmentToOpen);
  const composerOpen = useComposerStore((s) => s.open);
  const closePreviewModal = useAttachmentPreviewStore((s) => s.close);
  // Annotation state
  const [annMode, setAnnMode] = useState(false);
  const [annTool, setAnnTool] = useState<AnnotTool>("pen");
  const [annColor, setAnnColor] = useState("#000000");
  const [annStrokeWidth, setAnnStrokeWidth] = useState(3);
  const [annFontSize, setAnnFontSize] = useState(18);
  const [annFontFamily, setAnnFontFamily] = useState("Arial");
  const [pdfAnnotations, setPdfAnnotations] = useState<Record<number, AnnotShape[]>>({});
  const annHistory = useRef<number[]>([]); // stack of page numbers for undo
  const pageWrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ctrl+scroll to zoom — accumulate deltas then commit after a short pause
  // to avoid firing a new PDF render for every individual wheel tick.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      wheelAccum.current += e.deltaY > 0 ? -0.1 : 0.1;
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        const delta = wheelAccum.current;
        wheelAccum.current = 0;
        setScale((s) => Math.min(8, Math.max(0.2, Math.round((s + delta) * 10) / 10)));
      }, 80);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    };
  }, []);

  // Sync fullscreen state with browser
  useEffect(() => {
    function onFsChange() { setPdfFullscreen(!!document.fullscreenElement); }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  function togglePdfFullscreen() {
    if (!document.fullscreenElement) pdfContainerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  }

  function handleAddPdfAnnotation(page: number) {
    return (s: AnnotShape) => {
      setPdfAnnotations(prev => ({ ...prev, [page]: [...(prev[page] ?? []), s] }));
      annHistory.current.push(page);
    };
  }
  function handleUndoPdfAnnotation() {
    const page = annHistory.current.pop();
    if (page === undefined) return;
    setPdfAnnotations(prev => ({ ...prev, [page]: (prev[page] ?? []).slice(0, -1) }));
  }

  const handleInitField = useCallback((name: string, defaultValue: string | boolean) => {
    setFormValues(prev => (name in prev ? prev : { ...prev, [name]: defaultValue }));
  }, []);
  const handleFieldChange = useCallback((name: string, value: string | boolean) => {
    setFormValues(prev => ({ ...prev, [name]: value }));
  }, []);
  const handleFormDetected = useCallback(() => setHasForm(true), []);

  function handlePrint() {
    if (!pdf) return;
    const PRINT_SCALE = 2;

    // Render all pages to data URLs in the MAIN document context
    // (avoids loading pdfjs annotation scripts inside the iframe,
    // which triggers Trusted Types errors for new Function() in print-preview.bundle.js)
    (async () => {
      const pageDataUrls: string[] = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: PRINT_SCALE });
        const canvas = document.createElement("canvas"); // main doc, not iframe
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        // annotationMode: 0 = DISABLE — prevents pdfjs from loading the
        // annotation editor layer (which pulls in print-preview.bundle.js)
        await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0, canvas }).promise;

        // Draw filled form values directly onto the canvas
        if (hasForm && Object.keys(formValues).length > 0) {
          const pageAnnotations = await page.getAnnotations();
          for (const ann of pageAnnotations as any[]) {
            if (ann.subtype !== "Widget" || ann.hidden || !ann.fieldName) continue;
            const fv = formValues[ann.fieldName];
            if (fv === undefined || fv === "" || fv === false) continue;
            if (!Array.isArray(ann.rect) || ann.rect.length < 4) continue;
            const t = vp.transform;
            const sx1 = (ann.rect[0] ?? 0) * (t[0] ?? 1) + (ann.rect[1] ?? 0) * (t[2] ?? 0) + (t[4] ?? 0);
            const sy1 = (ann.rect[0] ?? 0) * (t[1] ?? 0) + (ann.rect[1] ?? 0) * (t[3] ?? 1) + (t[5] ?? 0);
            const sx2 = (ann.rect[2] ?? 0) * (t[0] ?? 1) + (ann.rect[3] ?? 0) * (t[2] ?? 0) + (t[4] ?? 0);
            const sy2 = (ann.rect[2] ?? 0) * (t[1] ?? 0) + (ann.rect[3] ?? 0) * (t[3] ?? 1) + (t[5] ?? 0);
            const fl = Math.min(sx1, sx2);
            const ft = Math.min(sy1, sy2);
            const fw = Math.abs(sx2 - sx1);
            const fh = Math.abs(sy2 - sy1);
            ctx.save();
            ctx.fillStyle = "#111";
            ctx.textBaseline = "middle";
            if (ann.fieldType === "Tx") {
              ctx.font = `${Math.min(fh * 0.65, 13 * PRINT_SCALE)}px Arial`;
              ctx.fillText(String(fv), fl + 3, ft + fh / 2, fw - 6);
            } else if (ann.fieldType === "Btn") {
              if ((ann.checkBox && fv === true) || (!ann.radioButton && !ann.checkBox && fv === true)) {
                ctx.font = `${Math.min(fh * 0.8, 14 * PRINT_SCALE)}px Arial`;
                ctx.textAlign = "center";
                ctx.fillText("\u2713", fl + fw / 2, ft + fh / 2);
              } else if (ann.radioButton && fv === ann.buttonValue) {
                ctx.beginPath();
                ctx.arc(fl + fw / 2, ft + fh / 2, Math.min(fw, fh) * 0.28, 0, Math.PI * 2);
                ctx.fill();
              }
            } else if (ann.fieldType === "Ch") {
              const opt = (ann.options ?? []).find((o: any) => o.exportValue === fv);
              const label = opt?.displayValue ?? String(fv);
              ctx.font = `${Math.min(fh * 0.65, 13 * PRINT_SCALE)}px Arial`;
              ctx.fillText(label, fl + 3, ft + fh / 2, fw - 6);
            }
            ctx.restore();
          }
        }

        pageDataUrls.push(canvas.toDataURL("image/png"));
      }

      // Draw annotations on top of each page
      for (let i = 1; i <= pdf.numPages; i++) {
        const pageAnn = pdfAnnotations[i] ?? [];
        if (pageAnn.length > 0) {
          // Re-render annotations onto the already-pushed data URL via a temp canvas
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: PRINT_SCALE });
          const tmp = document.createElement("canvas");
          tmp.width = vp.width; tmp.height = vp.height;
          const img2 = new Image();
          img2.src = pageDataUrls[i - 1] ?? "";
          await new Promise<void>((r) => { img2.onload = () => r(); img2.onerror = () => r(); });
          const tc = tmp.getContext("2d")!;
          tc.drawImage(img2, 0, 0);
          drawAnnotOnCanvas(tc, pageAnn, PRINT_SCALE, PRINT_SCALE);
          pageDataUrls[i - 1] = tmp.toDataURL("image/png");
        }
      }

      // Build a static print iframe — only <img> tags, no JS, no pdfjs.
      // Use a Blob URL + load event so print() is only called after the
      // browser has fully decoded all images (avoids blank print preview).
      const imgTags = pageDataUrls
        .map((url) => `<div class="page"><img src="${url}" /></div>`)
        .join("");

      const html = `<!DOCTYPE html><html><head><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #fff; }
        .page { page-break-after: always; display: flex; justify-content: center; }
        .page:last-child { page-break-after: avoid; }
        img { max-width: 100%; display: block; }
        @page { margin: 0.5cm; }
      </style></head><body>${imgTags}</body></html>`;

      // Use srcdoc (same-origin, no blob: CSP issue) so the load event fires
      // reliably once all data-URL images are decoded before print() is called.
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:0";
      iframe.srcdoc = html;

      iframe.addEventListener("load", () => {
        iframe.contentWindow?.print();
        setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe); }, 3000);
      }, { once: true });

      document.body.appendChild(iframe);
    })().catch(() => {});
  }

  async function handleDownloadPdf() {
    if (!pdf) return;
    const PRINT_SCALE = 2;
    const defaultName = (track?.attachment.filename ?? "document").replace(/\.pdf$/i, "") + "-annotated.pdf";
    const destPath = await save({ defaultPath: defaultName, title: "Save annotated PDF", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!destPath) return;
    const pageCanvases: { canvas: HTMLCanvasElement; vp: { width: number; height: number } }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: PRINT_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0, canvas }).promise;
      if (hasForm && Object.keys(formValues).length > 0) {
        const pageAnnotations = await page.getAnnotations();
        for (const ann of pageAnnotations as any[]) {
          if (ann.subtype !== "Widget" || ann.hidden || !ann.fieldName) continue;
          const fv = formValues[ann.fieldName];
          if (fv === undefined || fv === "" || fv === false) continue;
          if (!Array.isArray(ann.rect) || ann.rect.length < 4) continue;
          const t = vp.transform;
          const sx1 = (ann.rect[0] ?? 0) * (t[0] ?? 1) + (ann.rect[1] ?? 0) * (t[2] ?? 0) + (t[4] ?? 0);
          const sy1 = (ann.rect[0] ?? 0) * (t[1] ?? 0) + (ann.rect[1] ?? 0) * (t[3] ?? 1) + (t[5] ?? 0);
          const sx2 = (ann.rect[2] ?? 0) * (t[0] ?? 1) + (ann.rect[3] ?? 0) * (t[2] ?? 0) + (t[4] ?? 0);
          const sy2 = (ann.rect[2] ?? 0) * (t[1] ?? 0) + (ann.rect[3] ?? 0) * (t[3] ?? 1) + (t[5] ?? 0);
          const fl = Math.min(sx1, sx2); const ft = Math.min(sy1, sy2);
          const fw = Math.abs(sx2 - sx1); const fh = Math.abs(sy2 - sy1);
          ctx.save(); ctx.fillStyle = "#111"; ctx.textBaseline = "middle";
          if (ann.fieldType === "Tx") {
            ctx.font = `${Math.min(fh * 0.65, 13 * PRINT_SCALE)}px Arial`;
            ctx.fillText(String(fv), fl + 3, ft + fh / 2, fw - 6);
          } else if (ann.fieldType === "Btn") {
            if ((ann.checkBox && fv === true) || (!ann.radioButton && !ann.checkBox && fv === true)) {
              ctx.font = `${Math.min(fh * 0.8, 14 * PRINT_SCALE)}px Arial`;
              ctx.textAlign = "center";
              ctx.fillText("\u2713", fl + fw / 2, ft + fh / 2);
            } else if (ann.radioButton && fv === ann.buttonValue) {
              ctx.beginPath();
              ctx.arc(fl + fw / 2, ft + fh / 2, Math.min(fw, fh) * 0.28, 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (ann.fieldType === "Ch") {
            const opt = (ann.options ?? []).find((o: any) => o.exportValue === fv);
            const label = opt?.displayValue ?? String(fv);
            ctx.font = `${Math.min(fh * 0.65, 13 * PRINT_SCALE)}px Arial`;
            ctx.fillText(label, fl + 3, ft + fh / 2, fw - 6);
          }
          ctx.restore();
        }
      }
      const pageAnn = pdfAnnotations[i] ?? [];
      if (pageAnn.length > 0) drawAnnotOnCanvas(ctx, pageAnn, PRINT_SCALE, PRINT_SCALE);
      pageCanvases.push({ canvas, vp: { width: vp.width, height: vp.height } });
    }
    if (pageCanvases.length === 0) return;
    const first = pageCanvases[0];
    if (!first) return;
    const orientation = first.vp.width > first.vp.height ? "landscape" : "portrait";
    const doc = new jsPDF({ orientation, unit: "px", format: [first.vp.width, first.vp.height], compress: true });
    pageCanvases.forEach(({ canvas, vp }, idx) => {
      if (idx > 0) doc.addPage([vp.width, vp.height], vp.width > vp.height ? "landscape" : "portrait");
      doc.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, vp.width, vp.height);
    });
    try {
      await writeFile(destPath, new Uint8Array(doc.output("arraybuffer") as ArrayBuffer));
      console.log("[PDF download] saved to", destPath);
    } catch (e) {
      console.error("[PDF download] writeFile failed:", e);
    }
  }

  async function handleAttachEmail(target: "new" | "thread" = "new") {
    if (!pdf || attachBusy) return;
    setAttachBusy(true);
    try {
      const PRINT_SCALE = 2;
      const rawName = track?.attachment.filename ?? "document.pdf";
      const baseName = rawName.replace(/\.pdf$/i, "");
      const hasAnnotations = Object.values(pdfAnnotations).some((a) => a.length > 0);
      const filename = hasAnnotations ? baseName + "-annotated.pdf" : rawName;
      const pageCanvases: { canvas: HTMLCanvasElement; vp: { width: number; height: number } }[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: PRINT_SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0, canvas }).promise;
        if (hasForm && Object.keys(formValues).length > 0) {
          const pageAnnotations = await page.getAnnotations();
          for (const ann of pageAnnotations as any[]) {
            if (ann.subtype !== "Widget" || ann.hidden || !ann.fieldName) continue;
            const fv = formValues[ann.fieldName];
            if (fv === undefined || fv === "" || fv === false) continue;
            if (!Array.isArray(ann.rect) || ann.rect.length < 4) continue;
            const t = vp.transform;
            const sx1 = (ann.rect[0] ?? 0) * (t[0] ?? 1) + (ann.rect[1] ?? 0) * (t[2] ?? 0) + (t[4] ?? 0);
            const sy1 = (ann.rect[0] ?? 0) * (t[1] ?? 0) + (ann.rect[1] ?? 0) * (t[3] ?? 1) + (t[5] ?? 0);
            const sx2 = (ann.rect[2] ?? 0) * (t[0] ?? 1) + (ann.rect[3] ?? 0) * (t[2] ?? 0) + (t[4] ?? 0);
            const sy2 = (ann.rect[2] ?? 0) * (t[1] ?? 0) + (ann.rect[3] ?? 0) * (t[3] ?? 1) + (t[5] ?? 0);
            const fl = Math.min(sx1, sx2); const ft = Math.min(sy1, sy2);
            const fw = Math.abs(sx2 - sx1); const fh = Math.abs(sy2 - sy1);
            ctx.save(); ctx.fillStyle = "#111"; ctx.textBaseline = "middle";
            if (ann.fieldType === "Tx") {
              ctx.font = `${Math.min(fh * 0.65, 13 * PRINT_SCALE)}px Arial`;
              ctx.fillText(String(fv), fl + 3, ft + fh / 2, fw - 6);
            } else if (ann.fieldType === "Btn") {
              if ((ann.checkBox && fv === true) || (!ann.radioButton && !ann.checkBox && fv === true)) {
                ctx.font = `${Math.min(fh * 0.8, 14 * PRINT_SCALE)}px Arial`;
                ctx.textAlign = "center";
                ctx.fillText("\u2713", fl + fw / 2, ft + fh / 2);
              } else if (ann.radioButton && fv === ann.buttonValue) {
                ctx.beginPath();
                ctx.arc(fl + fw / 2, ft + fh / 2, Math.min(fw, fh) * 0.28, 0, Math.PI * 2);
                ctx.fill();
              }
            } else if (ann.fieldType === "Ch") {
              const opt = (ann.options ?? []).find((o: any) => o.exportValue === fv);
              const label = opt?.displayValue ?? String(fv);
              ctx.font = `${Math.min(fh * 0.65, 13 * PRINT_SCALE)}px Arial`;
              ctx.fillText(label, fl + 3, ft + fh / 2, fw - 6);
            }
            ctx.restore();
          }
        }
        const pageAnn = pdfAnnotations[i] ?? [];
        if (pageAnn.length > 0) drawAnnotOnCanvas(ctx, pageAnn, PRINT_SCALE, PRINT_SCALE);
        pageCanvases.push({ canvas, vp: { width: vp.width, height: vp.height } });
      }
      if (pageCanvases.length === 0) return;
      const first = pageCanvases[0];
      if (!first) return;
      const orientation = first.vp.width > first.vp.height ? "landscape" : "portrait";
      const doc = new jsPDF({ orientation, unit: "px", format: [first.vp.width, first.vp.height], compress: true });
      pageCanvases.forEach(({ canvas, vp }, idx) => {
        if (idx > 0) doc.addPage([vp.width, vp.height], vp.width > vp.height ? "landscape" : "portrait");
        doc.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, vp.width, vp.height);
      });
      const tmp = await tempDir();
      const sep = tmp.endsWith("/") || tmp.endsWith("\\") ? "" : "/";
      const safeName = filename.replace(/[/\\:*?"<>|]/g, "_");
      const destPath = `${tmp}${sep}cursus-${Date.now()}-${safeName}`;
      await writeFile(destPath, new Uint8Array(doc.output("arraybuffer") as ArrayBuffer));
      const att: OutgoingAttachment = { filename, path: destPath, contentType: "application/pdf" };
      if (target === "thread") {
        if (composerOpen) {
          appendAttachmentToOpen(att);
          toast.success("Attached to open draft");
        } else if (track) {
          openReplyForAttachment(track, att);
        } else {
          openComposeWith({ attachments: [att] });
        }
        closePreviewModal();
      } else {
        closePreviewModal();
        openComposeWith({ attachments: [att] });
      }
    } catch (e) {
      console.error("[PDF attach email] failed:", e);
      toast.error("Failed to attach PDF: " + String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  // Load PDF
  useEffect(() => {
    setPdf(null);
    setNumPages(0);
    setPdfError(null);
    setFormValues({});
    setHasForm(false);
    const bytes = b64ToBytes(b64Data);
    console.log(`[PDF] loading ${bytes.length} bytes`);
    pdfjsLib
      .getDocument({ data: bytes, wasmUrl: WASM_BASE_URL })
      .promise.then((doc) => {
        console.log(`[PDF] loaded, pages: ${doc.numPages}`);
        setPdf(doc);
        setNumPages(doc.numPages);
        pageWrapperRefs.current = new Array(doc.numPages).fill(null);
      })
      .catch((err: unknown) => {
        console.error("[PdfViewer] getDocument failed:", err);
        setPdfError(err instanceof Error ? err.message : String(err));
      });
  }, [b64Data]);

  // Search
  useEffect(() => {
    if (!pdf || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const q = searchQuery.toLowerCase();
    setSearching(true);
    const results: SearchResult[] = [];

    Promise.all(
      Array.from({ length: numPages }, (_, idx) =>
        pdf.getPage(idx + 1).then(async (page) => {
          const content = await page.getTextContent();
          let fullText = "";

          if (content.items.length > 0) {
            // Searchable PDF: use embedded text layer
            fullText = content.items
              .flatMap((item: Record<string, unknown>) => (typeof item.str === "string" ? [item.str] : []))
              .join("");
          } else if (track) {
            // Image-only PDF: try OCR cache
            const cached = await getOcrCache(
              track.accountId, track.uid,
              track.attachment.index, idx + 1,
            ).catch(() => null);
            if (cached && cached.length > 0) {
              fullText = cached.map((w) => w.text).join(" ");
            }
          }

          if (!fullText) return;
          const lower = fullText.toLowerCase();
          let pos = lower.indexOf(q);
          while (pos !== -1) {
            const start = Math.max(0, pos - 50);
            const end = Math.min(fullText.length, pos + q.length + 50);
            const snippet =
              (start > 0 ? "…" : "") +
              fullText.slice(start, pos) +
              "【" +
              fullText.slice(pos, pos + q.length) +
              "】" +
              fullText.slice(pos + q.length, end) +
              (end < fullText.length ? "…" : "");
            results.push({ page: idx + 1, snippet });
            pos = lower.indexOf(q, pos + 1);
          }
        }),
      ),
    )
      .then(() => {
        results.sort((a, b) => a.page - b.page);
        setSearchResults(results);
      })
      .finally(() => setSearching(false));
  }, [pdf, searchQuery, numPages, track]);

  const scrollToPage = useCallback((page: number) => {
    pageWrapperRefs.current[page - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentPage(page);
  }, []);

  return (
    <div ref={pdfContainerRef} className="flex flex-col h-full" style={pdfFullscreen ? { background: "var(--bg-base)" } : undefined}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
      >
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search in PDF…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={cn(
              "w-full h-7 pl-7 pr-3 text-[12px] rounded-md border text-primary",
              "bg-raised placeholder:text-muted focus:outline-none focus:ring-1",
              "border-soft",
            )}
            style={{ ["--tw-ring-color" as string]: "var(--accent)" }}
          />
        </div>
        {searching && <Loader2 size={12} className="animate-spin text-muted shrink-0" />}
        {searchQuery && !searching && (
          <span className="text-[11.5px] text-muted shrink-0">
            {searchResults.length} match{searchResults.length !== 1 ? "es" : ""}
          </span>
        )}

        {/* Page nav */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[12px] text-muted tabular-nums px-1">
            {currentPage} / {numPages}
          </span>
          <button
            type="button"
            onClick={() => scrollToPage(Math.min(numPages, currentPage + 1))}
            disabled={currentPage >= numPages}
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Zoom */}
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
          title="Zoom out"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[12px] text-muted tabular-nums w-10 text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(4, s + 0.2))}
          title="Zoom in"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <ZoomIn size={14} />
        </button>
        <div className="w-px h-4 bg-soft mx-1 shrink-0" />
        <button
          type="button"
          onClick={() => setAnnMode((v) => !v)}
          title={annMode ? "Exit annotation mode" : "Annotate PDF"}
          className={cn("flex items-center justify-center h-7 w-7 rounded-md transition-colors",
            annMode ? "bg-accent text-white" : "hover:bg-hover text-muted hover:text-primary")}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={handleDownloadPdf}
          title="Download PDF with annotations"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          onClick={() => void handleAttachEmail("new")}
          disabled={!pdf || attachBusy}
          title="Attach to new email (with annotations)"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary disabled:opacity-50"
        >
          {attachBusy ? <Loader2 size={14} className="animate-spin" /> : <MailPlus size={14} />}
        </button>
        <button
          type="button"
          onClick={() => void handleAttachEmail("thread")}
          disabled={!pdf || attachBusy}
          title={composerOpen ? "Attach to open draft (with annotations)" : "Attach to this email thread (with annotations)"}
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary disabled:opacity-50"
        >
          <Reply size={14} />
        </button>
        <button
          type="button"
          onClick={handlePrint}
          title="Print PDF"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <Printer size={14} />
        </button>
        <button
          type="button"
          onClick={togglePdfFullscreen}
          title={pdfFullscreen ? "Exit fullscreen (F11)" : "Fullscreen (F11)"}
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          {pdfFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {hasForm && (
          <button
            type="button"
            onClick={() => setFormValues({})}
            title="Clear all form fields"
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] hover:bg-hover transition-colors text-muted hover:text-primary shrink-0"
          >
            <X size={12} />
            <span>Clear form</span>
          </button>
        )}
      </div>

      {/* Annotation toolbar (when annotation mode is active) — horizontal bar under the top toolbar */}
      {annMode && (
        <AnnotationToolbar
          tool={annTool} setTool={setAnnTool}
          color={annColor} setColor={setAnnColor}
          strokeWidth={annStrokeWidth} setStrokeWidth={setAnnStrokeWidth}
          fontSize={annFontSize} setFontSize={setAnnFontSize}
          fontFamily={annFontFamily} setFontFamily={setAnnFontFamily}
          onUndo={handleUndoPdfAnnotation}
          onClear={() => { setPdfAnnotations({}); annHistory.current = []; }}
        />
      )}

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Search results panel */}
        {searchResults.length > 0 && (
          <div
            className="w-60 shrink-0 border-r overflow-y-auto flex flex-col"
            style={{
              borderColor: "var(--border-soft)",
              background: "var(--bg-sunken)",
            }}
          >
            <p className="px-3 py-2 text-[11px] text-muted font-medium uppercase tracking-wide border-b shrink-0"
              style={{ borderColor: "var(--border-soft)" }}
            >
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
            </p>
            {searchResults.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => scrollToPage(r.page)}
                className="text-left px-3 py-2 border-b hover:bg-hover transition-colors shrink-0"
                style={{ borderColor: "var(--border-soft)" }}
              >
                <p className="text-[11.5px] font-semibold text-secondary mb-0.5">
                  Page {r.page}
                </p>
                <p className="text-[11px] text-muted leading-snug break-words whitespace-pre-wrap">
                  {r.snippet}
                </p>
              </button>
            ))}
          </div>
        )}

        {/* Pages scroll area */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto p-6 flex flex-col items-center gap-6"
          style={{ background: "#1a1a1a" }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {pdfError && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <AlertCircle size={28} style={{ color: "var(--color-danger)" }} />
              <p className="text-[13px] text-primary font-medium">Could not render PDF</p>
              <p className="text-[12px] text-muted max-w-sm text-center break-words">{pdfError}</p>
            </div>
          )}
          {!pdfError && numPages === 0 && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-muted" />
            </div>
          )}
          {pdf && Array.from({ length: numPages }, (_, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              pageNum={i + 1}
              scale={scale}
              track={track}
              formValues={formValues}
              onInitField={handleInitField}
              onFieldChange={handleFieldChange}
              onFormDetected={handleFormDetected}
              pageAnnotations={pdfAnnotations[i + 1] ?? []}
              annMode={annMode}
              annTool={annTool}
              annColor={annColor}
              annStrokeWidth={annStrokeWidth}
              annFontSize={annFontSize}
              annFontFamily={annFontFamily}
              onAddAnnotation={handleAddPdfAnnotation(i + 1)}
              onUndoAnnotation={handleUndoPdfAnnotation}
              searchQuery={searchQuery}
              ref={(el) => { pageWrapperRefs.current[i] = el; }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- DOCX/DOC viewer ----------

/** Returns true if the bytes look like an OLE2 compound file (legacy .doc / .wps). */
function isOle2(bytes: Uint8Array): boolean {
  return bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
}

// ---------- Plain text viewer ----------

function TextViewer({ b64Data }: { b64Data: string }) {
  const text = (() => {
    try { return new TextDecoder().decode(b64ToBytes(b64Data)); }
    catch { return atob(b64Data); }
  })();
  const [zoom, setZoom] = useState(1);
  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
      >
        <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))} title="Zoom out"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary">
          <ZoomOut size={14} />
        </button>
        <span className="text-[12px] text-muted tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.1))} title="Zoom in"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary">
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={() => setZoom(1)}
          className="text-[11px] text-muted hover:text-primary transition-colors px-1">Reset</button>
      </div>
      <div className="flex-1 overflow-auto p-6" style={{ background: "var(--bg-base)" }}>
        <pre
          className="text-[13px] text-primary whitespace-pre-wrap break-words font-mono leading-relaxed"
          style={{ transformOrigin: "top left", transform: `scale(${zoom})` }}
        >{text}</pre>
      </div>
    </div>
  );
}

// ---------- DOCX / DOC / WPS viewer ----------

function DocxViewer({ b64Data, filename, onDownload }: { b64Data: string; filename: string; onDownload?: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLegacyDoc, setIsLegacyDoc] = useState(false);
  const [zoom, setZoom] = useState(1);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  useEffect(() => {
    setHtml(null);
    setError(null);
    setIsLegacyDoc(false);
    (async () => {
      try {
        const binary = atob(b64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        // .wps (Kingsoft) and OLE2 binary formats cannot be parsed by mammoth
        if (ext === "wps" || isOle2(bytes)) {
          setIsLegacyDoc(true);
          return;
        }

        const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
        setHtml(result.value);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [b64Data]);

  if (isLegacyDoc) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-sunken border border-soft">
          <span className="text-[22px]">📄</span>
        </div>
        <p className="text-[13px] text-primary font-medium">
          {ext === "wps" ? "WPS format" : "Legacy .doc format"}
        </p>
        <p className="text-[12px] text-muted max-w-xs leading-relaxed">
          {ext === "wps"
            ? "This WPS file cannot be rendered inline."
            : "This file uses the older binary Word 97–2003 format (.doc) which cannot be rendered inline."}{" "}
          {onDownload ? (
            <button
              type="button"
              onClick={onDownload}
              className="underline text-accent hover:opacity-80 transition-opacity"
            >
              Download it
            </button>
          ) : (
            "Download it"
          )}{" "}
          and open it in Word or LibreOffice.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <AlertCircle size={28} style={{ color: "var(--color-danger)" }} />
        <p className="text-[13px] text-primary font-medium">Could not render document</p>
        <p className="text-[12px] text-muted max-w-sm text-center">{error}</p>
      </div>
    );
  }

  if (!html) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
      >
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
          title="Zoom out"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[12px] text-muted tabular-nums w-12 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
          title="Zoom in"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="text-[11px] text-muted hover:text-primary transition-colors px-1"
        >
          Reset
        </button>
        <div className="w-px h-4 bg-soft mx-1 shrink-0" />
        <button
          type="button"
          onClick={() => {
            const iframe = document.createElement("iframe");
            iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:0";
            document.body.appendChild(iframe);
            const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
            if (!doc) return;
            doc.open();
            doc.write(`<!DOCTYPE html><html><head><style>
              body { font-family: sans-serif; font-size: 11pt; margin: 2cm; color: #000; }
              h1,h2,h3,h4,h5,h6 { margin: 0.5em 0; }
              p { margin: 0.4em 0; line-height: 1.5; }
              table { border-collapse: collapse; }
              td, th { border: 1px solid #ccc; padding: 4px 8px; }
              @page { margin: 2cm; }
            </style></head><body>${html}</body></html>`);
            doc.close();
            iframe.contentWindow?.addEventListener("load", () => {
              iframe.contentWindow?.print();
              setTimeout(() => document.body.removeChild(iframe), 2000);
            });
          }}
          title="Print document"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary"
        >
          <Printer size={14} />
        </button>
      </div>
      {/* Document body */}
      <div
        className="flex-1 overflow-auto p-8"
        style={{ background: "var(--bg-base)" }}
      >
        <div
          className="mx-auto bg-white text-black shadow-lg rounded"
          style={{
            maxWidth: 800,
            padding: "3cm 2.5cm",
            transformOrigin: "top center",
            transform: `scale(${zoom})`,
            minHeight: "29.7cm",
            fontFamily: "Georgia, serif",
            fontSize: 11,
            lineHeight: 1.6,
          }}
          // mammoth output is sanitized (no scripts, just formatting HTML)
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

// ---------- HTML viewer ----------

function HtmlViewer({ b64Data }: { b64Data: string }) {
  const html = (() => {
    try { return new TextDecoder().decode(b64ToBytes(b64Data)); }
    catch { return atob(b64Data); }
  })();
  return (
    <iframe
      srcDoc={html}
      sandbox=""
      title="HTML preview"
      className="w-full h-full border-0"
      style={{ background: "#fff" }}
    />
  );
}

// ---------- Video viewer ----------

function VideoViewer({ b64Data, contentType }: { b64Data: string; contentType: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    const bytes = b64ToBytes(b64Data);
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: contentType || "video/mp4" });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [b64Data, contentType]);
  if (!blobUrl) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={24} className="animate-spin text-muted" />
    </div>
  );
  return (
    <div className="flex items-center justify-center h-full" style={{ background: "#000" }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video controls src={blobUrl} className="max-w-full max-h-full" style={{ outline: "none" }} />
    </div>
  );
}

// ---------- Spreadsheet viewer ----------

function SpreadsheetViewer({ b64Data }: { b64Data: string }) {
  type SheetData = { name: string; html: string }[];
  const [sheets, setSheets] = useState<SheetData | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const bytes = b64ToBytes(b64Data);
      const wb = XLSX.read(bytes, { type: "array" });
      const result: SheetData = wb.SheetNames.flatMap((name) => {
        const sheet = wb.Sheets[name];
        if (!sheet) return [];
        return [{ name, html: XLSX.utils.sheet_to_html(sheet, { id: "sheet-table" }) }];
      });
      setSheets(result);
      setActiveSheet(0);
    } catch (e) {
      setError(String(e));
    }
  }, [b64Data]);

  if (error) return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <AlertCircle size={28} style={{ color: "var(--color-danger)" }} />
      <p className="text-[13px] text-primary font-medium">Could not read spreadsheet</p>
      <p className="text-[12px] text-muted max-w-sm text-center">{error}</p>
    </div>
  );
  if (!sheets) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={24} className="animate-spin text-muted" />
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {sheets.length > 1 && (
        <div
          className="flex items-center gap-1 px-4 py-1.5 border-b shrink-0 overflow-x-auto"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
        >
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={cn(
                "px-3 h-7 rounded-md text-[12px] shrink-0 transition-colors",
                i === activeSheet
                  ? "bg-hover text-primary font-medium"
                  : "text-muted hover:text-primary hover:bg-hover",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto" style={{ background: "var(--bg-base)" }}>
        <style>{`
          #sheet-table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
          #sheet-table td, #sheet-table th {
            border: 1px solid var(--border-soft);
            padding: 3px 8px;
            color: var(--color-primary);
          }
          #sheet-table tr:first-child td, #sheet-table th {
            background: var(--bg-sunken);
            font-weight: 600;
          }
        `}</style>
        {/* SheetJS output is a sanitized table — no scripts */}
        {/* eslint-disable-next-line react/no-danger */}
        <div dangerouslySetInnerHTML={{ __html: sheets[activeSheet]?.html ?? "" }} className="p-4" />
      </div>
    </div>
  );
}

// ---------- RTF viewer ----------

function stripRtf(rtf: string): string {
  let s = rtf;
  s = s.replace(/\{\\[*][^}]*\}/g, "");
  s = s.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|fldinst|themedata|colorschememapping|latentstyles)[^}]*(?:\{[^}]*\}[^}]*)*\}/g, "");
  s = s.replace(/\\(?:par|pard|sect|column|page)\b\s*/g, "\n");
  s = s.replace(/\\(?:line|softline)\b\s*/g, "\n");
  s = s.replace(/\\(?:tab)\b\s*/g, "\t");
  s = s.replace(/\\(?:cell|row)\b\s*/g, " ");
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => {
    try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; }
  });
  s = s.replace(/\\[a-z]+[-]?\d*\s?/gi, "");
  s = s.replace(/\\\n/g, "\n");
  s = s.replace(/\\[^a-z\n]/gi, "");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function RtfViewer({ b64Data }: { b64Data: string }) {
  const text = (() => {
    try {
      const raw = new TextDecoder("windows-1252").decode(b64ToBytes(b64Data));
      return stripRtf(raw);
    } catch {
      return stripRtf(atob(b64Data));
    }
  })();
  const [zoom, setZoom] = useState(1);
  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-sunken)" }}
      >
        <button type="button" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))} title="Zoom out"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary">
          <ZoomOut size={14} />
        </button>
        <span className="text-[12px] text-muted tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.1))} title="Zoom in"
          className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary">
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={() => setZoom(1)}
          className="text-[11px] text-muted hover:text-primary transition-colors px-1">Reset</button>
      </div>
      <div className="flex-1 overflow-auto p-6" style={{ background: "var(--bg-base)" }}>
        <pre
          className="text-[13px] text-primary whitespace-pre-wrap break-words font-mono leading-relaxed"
          style={{ transformOrigin: "top left", transform: `scale(${zoom})` }}
        >{text}</pre>
      </div>
    </div>
  );
}

// ---------- Modal shell ----------

export function AttachmentPreviewModal() {
  const track = useAttachmentPreviewStore((s) => s.track);
  const b64Data = useAttachmentPreviewStore((s) => s.b64Data);
  const loading = useAttachmentPreviewStore((s) => s.loading);
  const error = useAttachmentPreviewStore((s) => s.error);
  const close = useAttachmentPreviewStore((s) => s.close);
  const [downloading, setDownloading] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);

  async function handleDownload() {
    if (!track || downloading) return;
    const { attachment, accountId, folderPath, uid } = track;
    const defaultName = attachment.filename ?? `attachment-${attachment.index + 1}`;
    const destPath = await save({ defaultPath: defaultName, title: "Save attachment" });
    if (!destPath) return;
    setDownloading(true);
    try {
      const account = await getAccount(accountId);
      if (!account) throw new Error(`Account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      await ipc.imapSaveAttachment(
        {
          host: account.imap_host,
          port: account.imap_port,
          username: account.imap_username ?? account.email,
          password: secrets.imapPassword,
          security: account.imap_security,
        },
        folderPath,
        uid,
        attachment.index,
        destPath,
      );
    } finally {
      setDownloading(false);
    }
  }

  async function handleAttachEmail() {
    if (!track || attaching) return;
    setAttaching(true);
    try {
      const { attachment, accountId, folderPath, uid } = track;
      const filename = attachment.filename ?? `attachment-${attachment.index + 1}`;
      const account = await getAccount(accountId);
      if (!account) throw new Error(`Account ${accountId} not found`);
      const secrets = await getAccountSecrets(accountId);
      const tmp = await tempDir();
      const sep = tmp.endsWith("/") || tmp.endsWith("\\") ? "" : "/";
      const safeName = filename.replace(/[/\\:*?"<>|]/g, "_");
      const destPath = `${tmp}${sep}cursus-${Date.now()}-${attachment.index}-${safeName}`;
      await ipc.imapSaveAttachment(
        {
          host: account.imap_host,
          port: account.imap_port,
          username: account.imap_username ?? account.email,
          password: secrets.imapPassword,
          security: account.imap_security,
        },
        folderPath,
        uid,
        attachment.index,
        destPath,
      );
      close();
      openComposeWith({ attachments: [{ filename, path: destPath, contentType: attachment.contentType } satisfies OutgoingAttachment] });
    } catch (e) {
      console.error("[attach email] failed:", e);
      toast.error("Failed to attach: " + String(e));
    } finally {
      setAttaching(false);
    }
  }

  useEffect(() => {
    if (!track) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [track, close]);

  if (!track) return null;

  const { attachment } = track;
  const filename = attachment.filename ?? `attachment-${attachment.index + 1}`;
  const ct = attachment.contentType.toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const isPdf = ct === "application/pdf" || ct === "application/x-pdf" || ext === "pdf";
  const isDocx =
    ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ct === "application/msword" ||
    ct === "application/wps-office.docx" ||
    ct === "application/wps-office.wps" ||
    ext === "docx" || ext === "doc" || ext === "wps" || ext === "odt";
  const isTxt =
    ct === "text/plain" ||
    ct === "application/json" ||
    ct === "text/javascript" || ct === "application/javascript" ||
    ct === "text/css" ||
    ct === "text/xml" || ct === "application/xml" ||
    ct === "text/x-python" || ct === "application/x-python" ||
    ct === "text/x-shellscript" ||
    ["txt","log","csv","md","json","xml","yaml","yml","js","ts","py","css","sh","bat","ini","toml","cfg","conf","env","gitignore"].includes(ext);
  const isHtml = ct === "text/html" || ext === "html" || ext === "htm";
  const isVideo =
    ct.startsWith("video/") ||
    ["mp4","webm","ogv","ogg","mov","avi","mkv","m4v"].includes(ext);
  const isSpreadsheet =
    ct === "application/vnd.ms-excel" ||
    ct === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ct === "application/vnd.oasis.opendocument.spreadsheet" ||
    ext === "xlsx" || ext === "xls" || ext === "ods";
  const isRtf = ct === "text/rtf" || ct === "application/rtf" || ext === "rtf";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.65)" }}
        onClick={close}
      />
      {/* Panel — 92% of viewport */}
      <div
        className="relative z-10 flex flex-col rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: "92vw",
          height: "92vh",
          background: "var(--bg-base)",
        }}
      >
        {/* Header bar */}
        <div
          className="flex items-center gap-3 px-4 h-10 border-b shrink-0"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-raised)" }}
        >
          <span className="text-[13px] font-semibold text-primary truncate flex-1 min-w-0">
            {filename}
          </span>
          {loading && <Loader2 size={14} className="animate-spin text-muted shrink-0" />}
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading}
            title="Download attachment"
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary shrink-0 disabled:opacity-50"
          >
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </button>
          <button
            type="button"
            onClick={() => void handleAttachEmail()}
            disabled={attaching}
            title="Attach to new email"
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary shrink-0 disabled:opacity-50"
          >
            {attaching ? <Loader2 size={14} className="animate-spin" /> : <MailPlus size={14} />}
          </button>
          <button
            type="button"
            onClick={close}
            title="Close (Esc)"
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-[13px]">Loading {filename}…</span>
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <AlertCircle size={28} style={{ color: "var(--color-danger)" }} />
              <p className="text-[13px] text-primary font-medium">Could not load file</p>
              <p className="text-[12px] text-muted max-w-sm text-center">{error}</p>
            </div>
          )}
          {b64Data && isPdf && <PdfViewer b64Data={b64Data} track={track} />}
          {b64Data && isDocx && <DocxViewer b64Data={b64Data} filename={filename} onDownload={() => void handleDownload()} />}
          {b64Data && isTxt && <TextViewer b64Data={b64Data} />}
          {b64Data && isHtml && <HtmlViewer b64Data={b64Data} />}
          {b64Data && isVideo && <VideoViewer b64Data={b64Data} contentType={attachment.contentType} />}
          {b64Data && isSpreadsheet && <SpreadsheetViewer b64Data={b64Data} />}
          {b64Data && isRtf && <RtfViewer b64Data={b64Data} />}
          {b64Data && !isPdf && !isDocx && !isTxt && !isHtml && !isVideo && !isSpreadsheet && !isRtf && (
            <ImageViewer b64Data={b64Data} contentType={attachment.contentType} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Gallery thumbnail (footer strip) ----

function GalleryThumb({
  attachment,
  accountId,
  folderPath,
  uid,
  active,
  onClick,
}: {
  attachment: Attachment;
  accountId: number;
  folderPath: string;
  uid: number;
  active: boolean;
  onClick: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const display = attachment.filename ?? `image-${attachment.index + 1}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) setVisible(true); },
      { rootMargin: "100px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const b64 = await loadAttachmentB64(accountId, folderPath, uid, attachment.index);
        if (cancelled) return;
        const small = await new Promise<string>((resolve) => {
          const img = new Image();
          img.onload = () => {
            const s = Math.min(1, 144 / img.naturalWidth, 144 / img.naturalHeight);
            const w = Math.max(1, Math.round(img.naturalWidth * s));
            const h = Math.max(1, Math.round(img.naturalHeight * s));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (ctx) ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.75));
          };
          img.onerror = () => resolve(`data:${attachment.contentType};base64,${b64}`);
          img.src = `data:${attachment.contentType};base64,${b64}`;
        });
        if (!cancelled) setSrc(small);
      } catch {
        // show placeholder
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, accountId, folderPath, uid, attachment.index, attachment.contentType]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={display}
      data-gallery-active={active ? "true" : undefined}
      className={cn(
        "relative flex-none rounded-md overflow-hidden border-2 transition-all",
        active
          ? "border-[color:var(--accent)] opacity-100"
          : "border-transparent opacity-60 hover:opacity-90",
      )}
      style={{ width: 72, height: 72 }}
    >
      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: "var(--bg-raised)" }}
        >
          <Loader2 size={12} className="animate-spin text-muted" />
        </div>
      )}
      {src ? (
        <img src={src} alt={display} className="w-full h-full object-cover" draggable={false} />
      ) : !loading ? (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: "var(--bg-raised)" }}
        >
          <Images size={16} className="text-muted" />
        </div>
      ) : null}
    </button>
  );
}

// ---- Image gallery modal ----

export function ImageGalleryModal() {
  const session = useImageGalleryStore((s) => s.session);
  const close = useImageGalleryStore((s) => s.close);
  const setIndex = useImageGalleryStore((s) => s.setIndex);
  const openComposeWith = useComposerStore((s) => s.openComposeWith);
  const openReplyForAttachment = useComposerStore((s) => s.openReplyForAttachment);
  const appendAttachmentToOpen = useComposerStore((s) => s.appendAttachmentToOpen);
  const composerOpen = useComposerStore((s) => s.open);

  const [mainSrc, setMainSrc] = useState<string | null>(null);
  const [mainLoading, setMainLoading] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlAllBusy, setDlAllBusy] = useState(false);
  const [dlAllDone, setDlAllDone] = useState(0);
  const [attachBusy, setAttachBusy] = useState(false);
  const thumbStripRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [galleryFullscreen, setGalleryFullscreen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Annotation state
  const [annMode, setAnnMode] = useState(false);
  const [annTool, setAnnTool] = useState<AnnotTool>("pen");
  const [annColor, setAnnColor] = useState("#000000");
  const [annStrokeWidth, setAnnStrokeWidth] = useState(3);
  const [annFontSize, setAnnFontSize] = useState(18);
  const [annFontFamily, setAnnFontFamily] = useState("Arial");
  const [imgAnnotations, setImgAnnotations] = useState<Record<number, AnnotShape[]>>({});
  const [imgRenderedSize, setImgRenderedSize] = useState<{ w: number; h: number } | null>(null);

  function handleClose() {
    setAnnMode(false);
    setImgAnnotations({});
    close();
  }

  // Sync fullscreen state
  useEffect(() => {
    function onFsChange() { setGalleryFullscreen(!!document.fullscreenElement); }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  function toggleGalleryFullscreen() {
    if (!document.fullscreenElement) panelRef.current?.requestFullscreen();
    else document.exitFullscreen();
  }

  const attachments = session?.attachments ?? [];
  const index = session?.index ?? 0;
  const total = attachments.length;
  const current = attachments[index];

  // Fetch main image when session/index changes
  useEffect(() => {
    if (!session || !current) return;
    let cancelled = false;
    setMainSrc(null);
    setMainLoading(true);
    (async () => {
      try {
        const b64 = await loadAttachmentB64(
          session.accountId,
          session.folderPath,
          session.uid,
          current.index,
        );
        if (!cancelled) setMainSrc(`data:${current.contentType};base64,${b64}`);
      } catch {
        // show nothing
      } finally {
        if (!cancelled) setMainLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.accountId, session?.folderPath, session?.uid, index]);

  // Scroll active thumbnail into view
  useEffect(() => {
    const strip = thumbStripRef.current;
    if (!strip) return;
    const activeBtn = strip.querySelector<HTMLElement>("[data-gallery-active='true']");
    activeBtn?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [index]);

  // Keyboard navigation
  useEffect(() => {
    if (!session) return;
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") handleClose();
      else if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      else if (e.key === "ArrowRight" && index < total - 1) setIndex(index + 1);
      else if (e.key === "f" || e.key === "F") toggleGalleryFullscreen();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, index, total, close, setIndex]);

  // Reset zoom/pan when switching images
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  const sessionId = useImageGalleryStore((s) => s.sessionId);
  // Reset annotation state on every open/close cycle
  useEffect(() => {
    setAnnMode(false);
    setImgAnnotations({});
  }, [sessionId]);

  async function buildImapConfig() {
    if (!session) throw new Error("No session");
    const account = await getAccount(session.accountId);
    if (!account) throw new Error(`Account ${session.accountId} not found`);
    const secrets = await getAccountSecrets(session.accountId);
    return {
      host: account.imap_host,
      port: account.imap_port,
      username: account.imap_username ?? account.email,
      password: secrets.imapPassword,
      security: account.imap_security,
    };
  }

  async function handleDownloadCurrent() {
    if (!session || !current || dlBusy) return;
    const display = current.filename ?? `image-${current.index + 1}`;
    try {
      const destPath = await save({ defaultPath: display, title: "Save image" });
      if (!destPath) return;
      setDlBusy(true);
      const cfg = await buildImapConfig();
      await ipc.imapSaveAttachment(cfg, session.folderPath, session.uid, current.index, destPath);
    } catch {
      // silent
    } finally {
      setDlBusy(false);
    }
  }

  async function handleDownloadAll() {
    if (!session || dlAllBusy) return;
    try {
      const dir = await openDialog({ directory: true, title: "Choose folder to save all images" });
      if (!dir) return;
      setDlAllBusy(true);
      setDlAllDone(0);
      const cfg = await buildImapConfig();
      const dirStr = dir as string;
      const sep = dirStr.includes("\\") ? "\\" : "/";
      for (const att of attachments) {
        const filename = att.filename ?? `image-${att.index + 1}`;
        await ipc.imapSaveAttachment(cfg, session.folderPath, session.uid, att.index, `${dirStr}${sep}${filename}`);
        setDlAllDone((n) => n + 1);
      }
    } catch {
      // silent
    } finally {
      setDlAllBusy(false);
      setDlAllDone(0);
    }
  }

  const ZOOM_STEP = 0.25;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 5;
  function handleZoomIn() { setZoom(z => Math.min(MAX_ZOOM, parseFloat((z + ZOOM_STEP).toFixed(2)))); }
  function handleZoomOut() {
    setZoom(z => {
      const clamped = Math.max(MIN_ZOOM, parseFloat((z - ZOOM_STEP).toFixed(2)));
      if (clamped <= 1) setPan({ x: 0, y: 0 });
      return clamped;
    });
  }
  function handleResetZoom() { setZoom(1); setPan({ x: 0, y: 0 }); }

  if (!session) return null;
  const display = current?.filename ?? `image-${(current?.index ?? 0) + 1}`;

  async function handleDownloadAnnotated() {
    if (!mainSrc) return;
    const currentAnn = imgAnnotations[index] ?? [];
    const ext = (current?.filename ?? "").match(/\.(png|gif|webp|bmp)$/i) ? RegExp.$1.toLowerCase() : "png";
    const baseName = (current?.filename ?? `image-${index + 1}`).replace(/\.[^.]+$/, "");
    const defaultName = baseName + "-annotated." + ext;
    const destPath = await save({ defaultPath: defaultName, title: "Save annotated image", filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }] });
    if (!destPath) return;
    const img = new Image();
    img.src = mainSrc;
    await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    if (currentAnn.length > 0 && imgRenderedSize) {
      drawAnnotOnCanvas(ctx, currentAnn, img.naturalWidth / imgRenderedSize.w, img.naturalHeight / imgRenderedSize.h);
    }
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    try {
      await writeFile(destPath, new Uint8Array(await blob.arrayBuffer()));
      console.log("[Image download] saved to", destPath);
    } catch (e) {
      console.error("[Image download] writeFile failed:", e);
    }
  }

  async function handleAttachEmail(target: "new" | "thread" = "new") {
    if (!mainSrc || attachBusy) return;
    setAttachBusy(true);
    try {
      const currentAnn = imgAnnotations[index] ?? [];
      const rawName = current?.filename ?? `image-${index + 1}`;
      let filename: string;
      let contentType: string;
      let bytes: Uint8Array;

      if (currentAnn.length > 0) {
        // Bake annotations: canvas → toDataURL (synchronous, no callback race)
        filename = rawName.replace(/\.[^.]+$/, "") + "-annotated.png";
        contentType = "image/png";
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Image failed to load for annotation"));
          img.src = mainSrc!;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || 1;
        canvas.height = img.naturalHeight || 1;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        if (imgRenderedSize) {
          drawAnnotOnCanvas(ctx, currentAnn, canvas.width / imgRenderedSize.w, canvas.height / imgRenderedSize.h);
        }
        const dataUrl = canvas.toDataURL("image/png");
        const b64 = dataUrl.split(",")[1] ?? "";
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        // No annotations — decode original bytes directly from the data URI
        filename = rawName;
        const header = mainSrc.match(/^data:([^;]+);base64,/);
        contentType = header?.[1] ?? current?.contentType ?? "image/jpeg";
        const b64 = mainSrc.split(",")[1] ?? "";
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      }

      const tmp = await tempDir();
      const sep = tmp.endsWith("/") || tmp.endsWith("\\") ? "" : "/";
      const safeName = filename.replace(/[/\\:*?"<>|]/g, "_");
      const destPath = `${tmp}${sep}cursus-${Date.now()}-${safeName}`;
      await writeFile(destPath, bytes);
      const att: OutgoingAttachment = { filename, path: destPath, contentType };
      if (target === "thread") {
        if (composerOpen) {
          appendAttachmentToOpen(att);
          toast.success("Attached to open draft");
        } else if (session) {
          openReplyForAttachment(
            { accountId: session.accountId, folderPath: session.folderPath, uid: session.uid },
            att,
          );
        } else {
          openComposeWith({ attachments: [att] });
        }
        close();
      } else {
        close();
        openComposeWith({ attachments: [att] });
      }
    } catch (e) {
      console.error("[Image attach email] failed:", e);
      toast.error("Failed to attach image: " + String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  async function handlePrint() {
    if (!mainSrc) return;
    const currentAnn = imgAnnotations[index] ?? [];
    let printSrc = mainSrc;
    if (currentAnn.length > 0 && imgRenderedSize) {
      const img = new Image();
      img.src = mainSrc;
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        drawAnnotOnCanvas(ctx, currentAnn, img.naturalWidth / imgRenderedSize.w, img.naturalHeight / imgRenderedSize.h);
        printSrc = canvas.toDataURL("image/png");
      }
    }
    const html = `<!DOCTYPE html><html><head><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #fff; }
      img { max-width: 100%; max-height: 100vh; object-fit: contain; }
      @page { margin: 0.5cm; }
    </style></head><body><img src="${printSrc}" /></body></html>`;
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:0";
    iframe.srcdoc = html;
    iframe.addEventListener("load", () => {
      iframe.contentWindow?.print();
      setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe); }, 3000);
    }, { once: true });
    document.body.appendChild(iframe);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.72)" }}
        onClick={handleClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className="relative z-10 flex flex-col overflow-hidden shadow-2xl"
        style={{
          width: galleryFullscreen ? "100vw" : "92vw",
          height: galleryFullscreen ? "100vh" : "92vh",
          background: "var(--bg-base)",
          borderRadius: galleryFullscreen ? 0 : "0.75rem",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 h-11 border-b shrink-0"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-raised)" }}
        >
          <Images size={15} className="text-muted shrink-0" />
          <span className="text-[13px] font-semibold text-primary truncate flex-1 min-w-0">
            {display}
          </span>
          <span className="text-[12px] text-muted tabular-nums shrink-0 px-2">
            {index + 1} / {total}
          </span>
          <button
            type="button"
            onClick={handleDownloadCurrent}
            disabled={dlBusy || mainLoading}
            title="Download this image"
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            {dlBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            <span>Save</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadAll}
            disabled={dlAllBusy}
            title={`Download all ${total} images to a folder`}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            {dlAllBusy ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                <span className="tabular-nums">{dlAllDone}/{total}</span>
              </>
            ) : (
              <>
                <Download size={12} />
                <span>Save all ({total})</span>
              </>
            )}
          </button>
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= MIN_ZOOM}
              title="Zoom out"
              className="flex items-center justify-center h-7 w-7 rounded-l-md bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-40"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              title="Reset zoom (double-click image)"
              className="flex items-center justify-center h-7 px-1.5 bg-sunken border-y border-soft text-secondary hover:bg-hover hover:text-primary transition-colors text-[11px] tabular-nums min-w-[38px]"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= MAX_ZOOM}
              title="Zoom in"
              className="flex items-center justify-center h-7 w-7 rounded-r-md bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-40"
            >
              <ZoomIn size={13} />
            </button>
          </div>
          <button
            type="button"
            onClick={handleDownloadAnnotated}
            disabled={!mainSrc || mainLoading}
            title="Download image with annotations"
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            <Download size={12} />
            <span>Export</span>
          </button>
          <button
            type="button"
            onClick={() => void handleAttachEmail("new")}
            disabled={!mainSrc || mainLoading || attachBusy}
            title="Attach to new email (with annotations)"
            className="flex items-center justify-center h-7 w-7 rounded-md bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            {attachBusy ? <Loader2 size={13} className="animate-spin" /> : <MailPlus size={13} />}
          </button>
          <button
            type="button"
            onClick={() => void handleAttachEmail("thread")}
            disabled={!mainSrc || mainLoading || attachBusy}
            title={composerOpen ? "Attach to open draft (with annotations)" : "Attach to this email thread (with annotations)"}
            className="flex items-center justify-center h-7 w-7 rounded-md bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            <Reply size={13} />
          </button>
          <button
            type="button"
            onClick={handlePrint}
            disabled={!mainSrc || mainLoading}
            title="Print this image"
            className="flex items-center justify-center h-7 w-7 rounded-md bg-sunken border border-soft text-secondary hover:bg-hover hover:text-primary transition-colors disabled:opacity-50 shrink-0"
          >
            <Printer size={13} />
          </button>
          <button
            type="button"
            onClick={() => setAnnMode((v) => !v)}
            title={annMode ? "Exit annotation mode" : "Annotate image"}
            className={cn("flex items-center justify-center h-7 w-7 rounded-md transition-colors shrink-0",
              annMode ? "bg-accent text-white" : "hover:bg-hover text-muted hover:text-primary")}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={toggleGalleryFullscreen}
            title={galleryFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary shrink-0"
          >
            {galleryFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="Close (Esc)"
            className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-hover transition-colors text-muted hover:text-primary shrink-0"
          >
            <X size={14} />
          </button>
        </div>
        {annMode && (
          <AnnotationToolbar
            tool={annTool} setTool={setAnnTool}
            color={annColor} setColor={setAnnColor}
            strokeWidth={annStrokeWidth} setStrokeWidth={setAnnStrokeWidth}
            fontSize={annFontSize} setFontSize={setAnnFontSize}
            fontFamily={annFontFamily} setFontFamily={setAnnFontFamily}
            onUndo={() => setImgAnnotations(prev => { const c = [...(prev[index] ?? [])]; c.pop(); return { ...prev, [index]: c }; })}
            onClear={() => setImgAnnotations(prev => ({ ...prev, [index]: [] }))}
          />
        )}

        {/* Main image */}
        <div
          className="flex-1 relative overflow-hidden flex items-center justify-center"
          style={{ background: "#111", cursor: annMode ? "default" : (zoom > 1 ? "grab" : "default"), userSelect: "none" }}
          onWheel={(e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
              const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
              setZoom(z => {
                const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parseFloat((z + delta).toFixed(2))));
                if (clamped <= 1) setPan({ x: 0, y: 0 });
                return clamped;
              });
            } else {
              if (e.deltaY > 0 && index < total - 1) setIndex(index + 1);
              else if (e.deltaY < 0 && index > 0) setIndex(index - 1);
            }
          }}
          onMouseDown={(e) => {
            if (annMode) return;
            if (zoom > 1) {
              e.preventDefault();
              dragStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
            }
          }}
          onMouseMove={(e) => {
            if (dragStart.current) {
              setPan({
                x: dragStart.current.px + (e.clientX - dragStart.current.x),
                y: dragStart.current.py + (e.clientY - dragStart.current.y),
              });
            }
          }}
          onMouseUp={() => { dragStart.current = null; }}
          onMouseLeave={() => { dragStart.current = null; }}
        >
          {mainLoading && (
            <div className="flex flex-col items-center gap-3 text-muted">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-[12px]">Loading…</span>
            </div>
          )}
          {mainSrc && !mainLoading && (
            <div
              style={{
                position: "relative",
                display: "inline-block",
                lineHeight: 0,
                transform: zoom !== 1 || pan.x !== 0 || pan.y !== 0
                  ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
                  : undefined,
                transformOrigin: "center center",
                transition: "transform 0.1s ease",
              }}
            >
              <img
                src={mainSrc}
                alt={display}
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onDoubleClick={handleResetZoom}
                onLoad={(e) => setImgRenderedSize({ w: e.currentTarget.offsetWidth, h: e.currentTarget.offsetHeight })}
                style={{ maxWidth: "88vw", maxHeight: "83vh", objectFit: "contain", display: "block" }}
              />
              {!annMode && (imgAnnotations[index]?.length ?? 0) > 0 && (
                <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
                  <AnnotShapes shapes={imgAnnotations[index] ?? []} />
                </svg>
              )}
              {annMode && (
                <AnnotationLayer
                  shapes={imgAnnotations[index] ?? []}
                  tool={annTool} color={annColor} strokeWidth={annStrokeWidth}
                  fontSize={annFontSize} fontFamily={annFontFamily}
                  onAdd={(s) => setImgAnnotations(prev => ({ ...prev, [index]: [...(prev[index] ?? []), s] }))}
                  onUndo={() => setImgAnnotations(prev => { const c = [...(prev[index] ?? [])]; c.pop(); return { ...prev, [index]: c }; })}
                />
              )}
            </div>
          )}
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex(index - 1)}
              className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center justify-center h-10 w-10 rounded-full bg-black/50 hover:bg-black/75 text-white transition-colors"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          {index < total - 1 && (
            <button
              type="button"
              onClick={() => setIndex(index + 1)}
              className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center h-10 w-10 rounded-full bg-black/50 hover:bg-black/75 text-white transition-colors"
            >
              <ChevronRight size={22} />
            </button>
          )}
        </div>

        {/* Thumbnail strip — only shown when there are multiple images */}
        {total > 1 && (
          <div
            ref={thumbStripRef}
            className="flex items-center gap-2 px-4 py-2 overflow-x-auto shrink-0 border-t"
            style={{
              borderColor: "var(--border-soft)",
              background: "var(--bg-sunken)",
              minHeight: 92,
            }}
          >
            {attachments.map((att, i) => (
              <GalleryThumb
                key={att.index}
                attachment={att}
                accountId={session.accountId}
                folderPath={session.folderPath}
                uid={session.uid}
                active={i === index}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
