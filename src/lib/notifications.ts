import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useUiStore } from "@/stores/ui";

let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        const res = await requestPermission();
        return res === "granted";
      } catch {
        return false;
      }
    })();
  }
  return permissionPromise;
}

function windowIsFocused(): boolean {
  return typeof document !== "undefined" && !document.hidden && document.hasFocus();
}

/**
 * True when `now` falls inside [start, end). The window may wrap past
 * midnight (e.g. start=22:00, end=08:00 covers 22:00–24:00 plus 00:00–08:00).
 * Returns false on malformed times or zero-length windows.
 */
export function isInQuietHours(
  start: string,
  end: string,
  now: Date = new Date(),
): boolean {
  const sm = start.match(/^(\d{1,2}):(\d{2})$/);
  const em = end.match(/^(\d{1,2}):(\d{2})$/);
  if (!sm || !em) return false;
  const s = Number(sm[1]) * 60 + Number(sm[2]);
  const e = Number(em[1]) * 60 + Number(em[2]);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

export async function sendTestNotification(): Promise<void> {
  if (!(await ensurePermission())) {
    throw new Error("Notifications permission denied");
  }
  sendNotification({
    title: "Blesus",
    body: "Test notification — toasts are working.",
  });
}

export async function notifyNewMail(
  subject: string,
  from: string,
  count: number,
): Promise<void> {
  const ui = useUiStore.getState();
  if (!ui.notificationsEnabled) return;
  if (
    ui.quietHoursEnabled &&
    isInQuietHours(ui.quietHoursStart, ui.quietHoursEnd)
  )
    return;
  // Never spam when the user is actively looking at the app.
  if (windowIsFocused()) return;
  if (!(await ensurePermission())) return;
  try {
    const title = count > 1 ? `${count} new messages` : "New message";
    const body = count > 1 ? `${from}: ${subject}` : `${from} — ${subject}`;
    sendNotification({ title, body });
  } catch (err) {
    console.warn("sendNotification failed:", err);
  }
}
