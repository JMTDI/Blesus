// Frontend → backend log forwarder. Anything important enough to mention
// in production should go through `flog`, not `console.*` alone — toasts
// disappear, devtools aren't open, but the rotated log file in
// `blesus-files/logs/` stays. Mirrors to console for dev DX.

import { ipc } from "@/lib/ipc";

type Level = "info" | "warn" | "error" | "debug";

function send(level: Level, args: unknown[]): void {
  const message = args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  void ipc.logFrontend(level, message).catch(() => {});
  // Mirror to devtools console so the dev loop is unchanged.
  const fn =
    level === "error" ? console.error :
    level === "warn"  ? console.warn  :
    level === "debug" ? console.debug :
    console.info;
  fn("[fe]", ...args);
}

export const flog = {
  info:  (...args: unknown[]) => send("info", args),
  warn:  (...args: unknown[]) => send("warn", args),
  error: (...args: unknown[]) => send("error", args),
  debug: (...args: unknown[]) => send("debug", args),
};
