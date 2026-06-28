# Blesus

A fast, private desktop email client for Windows, macOS, and Linux. Multi-account
IMAP, rich composer, FTS5 full-text search, rules engine, keyboard-first. **No AI,
no cloud, no tracking.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg)](https://tauri.app)
![GitHub Downloads (latest release)](https://img.shields.io/github/downloads/JMTDI/Blesus/latest/total)

> **Status:** v0.1 — feature-complete for daily use; pre-release polish in progress.

---

## Features

### Email & IMAP
- **Multi-account IMAP** with SSL/TLS, STARTTLS, and plaintext connections
- **IMAP IDLE** for real-time push updates without polling
- **Threading** — automatic conversation grouping by Message-ID / In-Reply-To / References (RFC 5322); subject normalization strips Re:/Fwd:/Aw:/Sv: prefixes across 8+ languages
- **Thread merge & split** — manually combine mis-threaded conversations or break messages out as standalone
- **UID-based flag sync** — star, read, archive, trash propagated to the server via `UID STORE` / `UID MOVE`
- **Snooze** — surfaces a thread at a chosen time using a custom IMAP keyword; survives reinstalls because it lives on the server
- Batch fetching (200 headers / 200 bodies per request) with server login-limit awareness (Fastmail, etc.)

### Sending
- **Two sending paths per account**: SMTP (lettre) or **Resend API**
- **Resend template picker** in the composer — browse and send pre-built templates
- Full RFC 2822 compliance (Message-ID, In-Reply-To, References, multipart MIME)
- Multiple recipients — To / Cc / Bcc
- **Scheduled send** — queue a message for delivery at any future time
- **Undo send** — configurable 0 / 5 / 10 / 30 second cancellation window
- **Confirm before send** guard (optional modal)
- Auto-appends to Sent folder after successful delivery
- **Send-only accounts** — appear in the From selector without an inbox

### Composer
- **Rich text editor** (TipTap): bold, italic, underline, strikethrough, text/background color, font family, font size, headings, bullet & numbered lists, blockquotes, code blocks, horizontal rule, links, inline images
- **Emoji picker**
- **Attachments** — multiple files, drag & drop, remove before send
- **Auto-save drafts** to local database every 3 seconds; resume on reopen
- **Reply / Reply All / Forward** with HTML-escaped quoting
- Per-account **HTML signature** (auto-inserted, preserved on account switch)
- Multiple From accounts with color indicator

### Full-Text Search
- SQLite **FTS5 with trigram tokenizer** — substring matches work ("tea" finds "ocean")
- Indexes subject, from, to, snippet, and full body text
- **Full-mailbox indexer** — two-phase (headers first, then bodies), cancellable at any time, shows live progress
- **Attachment text extraction** for search: PDF text layer + OCR fallback, DOCX (Mammoth), XLSX/XLS, plain text
- **Search overlay** (`Ctrl+K` / `Cmd+K`) with 150 ms debounce, keyboard navigation, result count

### Attachment & Media Viewers
- **Images** — inline preview, crop tool with aspect ratio presets, copy to clipboard, save to disk
- **PDF viewer** — page navigation, zoom, in-PDF text search, automatic OCR for image-only pages with word-bounding-box highlighting
- **Audio / Video player** — seek bar, volume control, thread indicator while playing
- **Office documents** — DOCX and XLSX rendered inline
- **OCR engine**: Windows uses native `Windows.Media.Ocr` (no install required); macOS/Linux use Tesseract.js; results cached in the database

### Rules Engine
- **Conditions**: from, to, subject, hasAttachment, isBulk — operators: contains, equals, regex, is
- **Actions**: move to folder, mark as read, star, trash
- Multiple conditions ANDed; configurable execution order; enable/disable per rule; per-account or global scope
- Auto-applies on every sync

### Folder Management
- Create, rename, delete folders; **empty trash** operation
- **Folder passwords** — PBKDF2-SHA256 (150 000 iterations, 256-bit key); per-folder lock with auto-lock timeout (0 / 5 / 15 / 30 / 60 / 240 minutes)
- Unread count badges; Sent / Drafts / Trash / Junk excluded from totals
- Automatic detection of special folders (Inbox, Sent, Drafts, Trash, Junk, Archive)

### Notifications
- Desktop notifications for new messages when the window is unfocused
- **Quiet hours** — suppress notifications between configurable start/end times (wraps past midnight)
- **Windows taskbar unread badge** (WinRT overlay icon)

### Contacts & Address Book
- Auto-populate contacts from message senders (interaction count + last-seen timestamp)
- Manually add / edit / delete contacts (name, email, phone, notes)
- **Contact groups** — named distribution lists; select a group in the composer to expand all members into To / Cc
- **CardDAV sync** — Nextcloud, iCloud, Fastmail, generic CardDAV; ETag-based diff (skips unchanged cards); vCard 3.0 and 4.0

### Account Management
- **Auto-discovery** by email domain — presets for Gmail, Outlook, Yahoo, iCloud, Fastmail, Zoho, AOL, GMX; generic guess for custom domains
- Manual IMAP / SMTP configuration (host, port, security)
- Per-account color (20 choices), display name, signature
- **Encrypted account backup / restore** — AES-GCM + Argon2 key derivation; import re-enters secrets into the OS keyring
- **OS keychain** for all secrets (Windows Credential Manager / macOS Keychain / libsecret on Linux) — never stored as plaintext

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` / `Cmd+K` | Open search |
| `j` / `↓` | Next thread |
| `k` / `↑` | Previous thread |
| `Shift+j/k` | Extend multi-selection |
| `r` | Mark read |
| `u` | Mark unread |
| `a` | Archive |
| `e` | Trash |
| `#` | Permanently delete |
| `s` / `*` | Toggle star |
| `!` | Mark as spam |
| `x` | Toggle select |
| `Ctrl+Q` / `Cmd+Q` | Quit |

### UI & Layout
- **Three-pane layout** — folder sidebar · thread list · reading pane with resizable panels
- **Reading pane positions**: right sidebar, bottom drawer, or hidden
- **Density modes**: compact, normal, relaxed; light / dark / auto themes
- **Category tabs**: All / People / Newsletters / Notifications (rule-based auto-categorization)
- **List filters**: all, unread only, has attachments; sort newest / oldest first
- **Starred view** — virtual cross-account inbox of all pinned threads
- **Context menu on threads**: archive, trash, star, mark read/unread, move to folder, snooze, spam, merge / split
- **Bulk actions** — checkbox + shift-click range select; archive, trash, star, mark read/unread on many at once
- Unsubscribe support — detects `List-Unsubscribe` header, mailto and RFC 8058 one-click HTTP
- Remote image policy — Never / Ask / Always; per-message allow banner
- Virtualized list rendering (react-virtuoso) for smooth performance at large mailbox sizes

### System Integration
- **System tray** — show / hide / quit; unread badge overlay on Windows
- **Single-instance** enforcement
- **Launch at login** (Windows / macOS / Linux)
- **Close to tray** — X button hides instead of quitting
- **Portable** — all data lives in `blesus-files/` next to the executable; zero registry pollution
- Rotating log files (`blesus-files/logs/`, max 2 MB × 5 files); open logs folder from Settings

---

## Out of scope (on purpose)

No AI features, no cloud sync, no telemetry, no analytics, no calendar,
no task extraction, no tracking pixels. Stripped on purpose.

---

## Download

Pre-built binaries will be published on
[GitHub Releases](https://github.com/JMTDI/blesus/releases)
once v0.1 ships.

> **macOS note:** Blesus is not signed with an Apple Developer ID, so Gatekeeper
> will show a warning the first time you open it. To allow the app after
> downloading the `.dmg`:
>
> 1. Open the `.dmg` and drag Blesus to **Applications** as usual.
> 2. Try to open Blesus — macOS will block it.
> 3. Go to **System Settings → Privacy & Security**, scroll down, and click
>    **"Open Anyway"** next to the Blesus entry.
> 4. Confirm the dialog that appears — Blesus will launch and the warning won't
>    appear again.
>
> Alternatively, remove the quarantine attribute from a terminal:
> ```bash
> xattr -d com.apple.quarantine /Applications/Blesus.app
> ```

> **Linux note:** Install the `.deb` package with:
> ```bash
> sudo dpkg -i blesus_*.deb
> sudo apt-get install -f   # install any missing dependencies
> ```
> After installation, Blesus should appear in your application menu (Activities /
> application launcher). You can also launch it from a terminal with `Blesus`.
>
> **System tray on Linux:** Blesus shows a system tray icon when your desktop
> supports it (requires `libayatana-appindicator3-1` or `libappindicator3-1`,
> installed automatically from the `.deb`). On GNOME you may need the
> [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/)
> to see the tray icon. Without a working tray, the X button will quit the app
> instead of hiding it to the tray.

## Build from source

Prerequisites:

- Node.js 20+
- Rust stable (via [rustup](https://rustup.rs))
- Tauri 2 system dependencies — see
  [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone https://github.com/JMTDI/blesus.git
cd blesus
npm install
npm run tauri dev          # development run
npm run tauri build        # production bundle (.exe / .msi / .AppImage / .deb)
```

The release executable is at `src-tauri/target/release/Blesus.exe` (Windows)
or `src-tauri/target/release/blesus` (Linux/macOS). Installers land under
`src-tauri/target/release/bundle/`.

### Rebuilding during development

Use **only** `npm run tauri build` (or the convenience wrapper
`npm run relaunch`) to produce a runnable binary. **Avoid running
`cargo build` directly** — `cargo build` produces a *debug* binary at
`src-tauri/target/debug/Blesus.exe` that:

* is unoptimized (3× larger, noticeably slower);
* uses its own SQLite database at `src-tauri/target/debug/blesus-files/blesus.db`,
  separate from the release binary's database next to
  `src-tauri/target/release/Blesus.exe`. Launching the debug binary therefore
  looks like Blesus has "lost" your mail because it's reading a different
  (often stale or empty) DB.

The recommended dev iteration loop on Windows is:

```powershell
npm run relaunch              # kills any running Blesus, rebuilds frontend
                              # + Tauri release binary, launches the new exe
npm run relaunch:no-launch    # same, but stops before launching (useful
                              # immediately before `git commit`)
```

The wrapper script lives at `scripts/rebuild-and-launch.ps1` and is also
safe to invoke directly with `powershell -ExecutionPolicy Bypass -File ...`.

## Stack

Tauri 2 · Rust (async-imap, lettre, mail-parser, keyring, sqlx) · React 19 ·
TypeScript · Tailwind v4 · TipTap · SQLite (FTS5) · Zustand · react-virtuoso.

## Contributing

PRs welcome — bug fixes, features, accessibility, translations, and packaging work.

For security issues, please **don't** open a public issue — see
[SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

