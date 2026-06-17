/**
 * Extract plain text from common attachment types for search indexing.
 *
 * Supported formats:
 *  - PDF  — pdfjs text layer; falls back to Windows OCR (Windows) or
 *           Tesseract.js (macOS/Linux) for image-only pages
 *  - DOCX — mammoth.extractRawText
 *  - XLSX / XLS — xlsx sheet_to_csv
 *  - text/* — plain UTF-8 decode
 *
 * Returns null when the content type is unsupported or extraction fails.
 */

import * as pdfjsLib from "pdfjs-dist";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { createWorker } from "tesseract.js";
import { invoke } from "@tauri-apps/api/core";
import { setOcrCache } from "@/lib/db";
import type { OcrWord } from "@/lib/db";

// Configure pdfjs worker (idempotent — safe to call from multiple modules)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

/** Characters per page below which we fall back to OCR */
const OCR_THRESHOLD = 100;

/** Max decoded attachment size to attempt extraction (~5 MB in base64 ≈ ~7.3 MB b64) */
const MAX_B64_LEN = 7_340_032; // 5 MB * (4/3)

/** Max extracted characters to store per attachment */
const MAX_CHARS = 20_000;

/** Cache key passed from the indexer so OCR results are stored for the viewer */
export interface OcrCacheKey {
  accountId: number;
  folderPath: string;
  uid: number;
  attachmentIndex: number;
}

// Lazy singleton Tesseract worker (non-Windows fallback)
let _ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;

async function getTesseractWorker() {
  if (!_ocrWorker) {
    const workerUrl = new URL(
      "tesseract.js/dist/worker.min.js",
      import.meta.url,
    ).href;
    _ocrWorker = await createWorker("eng", 1, { workerPath: workerUrl });
  }
  return _ocrWorker;
}

function b64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function extractPdfText(b64: string, cacheKey?: OcrCacheKey, forceOcr?: boolean): Promise<string> {
  const data = b64ToUint8Array(b64);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const parts: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .flatMap((item) => ("str" in item && typeof (item as { str: unknown }).str === "string" ? [(item as { str: string }).str] : []))
      .join(" ")
      .trim();

    const meaningfulChars = pageText.replace(/\s+/g, "").length;
    if (!forceOcr && meaningfulChars >= OCR_THRESHOLD) {
      parts.push(pageText);
      continue;
    }

    // Image-only page — render canvas and OCR
    const OCR_SCALE = 2.0;
    const MAX_OCR_PX = 2048;
    const rawVp = page.getViewport({ scale: OCR_SCALE });
    const clamp = Math.min(1, MAX_OCR_PX / Math.max(rawVp.width, rawVp.height));
    const ocrScale = OCR_SCALE * clamp;
    const viewport = page.getViewport({ scale: ocrScale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas }).promise;

    // Try Windows OCR first
    let ocrText = "";
    try {
      const pngBase64 = canvas.toDataURL("image/png").split(",")[1];
      const words = await invoke<OcrWord[]>("ocr_page", { pngBase64 });
      ocrText = words.map(w => w.text).join(" ");
      // Store bounding boxes in the persistent cache so the viewer is instant
      if (cacheKey && words.length > 0) {
        // Coordinates are in OCR-canvas px; scale down to scale-1.0 px so the
        // viewer can re-scale to its own display scale.
        const toScale1 = 1 / ocrScale;
        const normalised: OcrWord[] = words.map(w => ({
          text: w.text,
          x: w.x * toScale1,
          y: w.y * toScale1,
          w: w.w * toScale1,
          h: w.h * toScale1,
        }));
        setOcrCache(
          cacheKey.accountId, cacheKey.folderPath, cacheKey.uid,
          cacheKey.attachmentIndex, pageNum, normalised,
        ).catch(() => {});
      }
    } catch (err) {
      console.warn(`[OCR] Windows OCR unavailable (page ${pageNum}), falling back to Tesseract:`, err);
      // Not on Windows — fall back to Tesseract.js
      try {
        const worker = await getTesseractWorker();
        const { data: { text } } = await worker.recognize(canvas);
        ocrText = text;
      } catch {
        // OCR unavailable on this page
      }
    }

    if (ocrText.trim()) parts.push(ocrText.trim());
  }

  return parts.join("\n\n");
}

async function extractDocxText(b64: string): Promise<string> {
  const bytes = b64ToUint8Array(b64);
  const result = await mammoth.extractRawText({
    arrayBuffer: bytes.buffer as ArrayBuffer,
  });
  return result.value;
}

function extractXlsxText(b64: string): string {
  const bytes = b64ToUint8Array(b64);
  const wb = XLSX.read(bytes, { type: "array" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    parts.push(XLSX.utils.sheet_to_csv(sheet));
  }
  return parts.join("\n");
}

/**
 * Extracts indexable text from an attachment.
 *
 * @param b64         Base-64 encoded attachment bytes
 * @param contentType MIME type of the attachment
 * @param filename    Original filename (used as fallback for type detection)
 * @param cacheKey    When provided, OCR bounding boxes are stored in the DB cache
 * @returns Extracted text (up to MAX_CHARS), or null if unsupported / too large
 */
export async function extractAttachmentText(
  b64: string,
  contentType: string,
  filename: string | null,
  cacheKey?: OcrCacheKey,
  forceOcr?: boolean,
): Promise<string | null> {
  if (b64.length > MAX_B64_LEN) return null;

  const ct = contentType.toLowerCase();
  const ext = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";

  const isPdf = ct === "application/pdf" || ct.includes("/pdf") || ext === "pdf";
  const isDocx =
    ct.includes("wordprocessingml.document") ||
    ct === "application/msword" ||
    ext === "docx";
  const isXlsx =
    ct.includes("spreadsheetml.sheet") ||
    ct === "application/vnd.ms-excel" ||
    ct.includes("excel") ||
    ext === "xlsx" ||
    ext === "xls";
  const isText =
    ct.startsWith("text/") || ["txt", "csv", "md", "json", "xml"].includes(ext);

  try {
    let text: string;
    if (isPdf) {
      text = await extractPdfText(b64, cacheKey, forceOcr);
    } else if (isDocx) {
      text = await extractDocxText(b64);
    } else if (isXlsx) {
      text = extractXlsxText(b64);
    } else if (isText) {
      text = new TextDecoder().decode(b64ToUint8Array(b64));
    } else {
      return null;
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, MAX_CHARS) : null;
  } catch (err) {
    console.error("[extractAttachmentText] failed for", filename, ":", err);
    return null;
  }
}

