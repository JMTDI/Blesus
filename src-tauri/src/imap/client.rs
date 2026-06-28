use std::time::Duration;

use async_imap::Session;
use futures::StreamExt;
use mail_parser::MessageParser;
use native_tls::TlsConnector;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_native_tls::TlsStream;

use super::types::{FlagMode, Folder, FolderStatus, ImapConfig, ImapSecurity, MessageBody, MessageSummary};
use crate::error::{Error, Result};

/// How long to wait for a TCP connection to the IMAP server to be established.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for an IMAP STATUS command (UNSEEN MESSAGES) to complete.
/// Some servers (e.g. Fastmail) can be slow to respond to STATUS on large or
/// rarely-accessed folders.  60 s gives more headroom while still preventing
/// an indefinite hang.
const STATUS_TIMEOUT: Duration = Duration::from_secs(60);

/// How long to wait for a paginated header fetch (UID FETCH … RFC822.HEADER)
/// to complete.  Headers are small (~5 KB each), so 200 of them should arrive
/// well within ~30 s even on a slow connection — but some IMAP servers
/// (Fastmail's Sent Mail in particular) can take much longer when the folder
/// has been recently churned or the connection is stale.  Bumped to 1000 s so
/// a slow first batch on a very large folder doesn't abort the whole sync;
/// combined with the retry-on-timeout in [`fetch_messages`], one transient
/// stall gets a second chance with a fresh connection before failing.
const HEADER_FETCH_TIMEOUT: Duration = Duration::from_secs(1000);

/// How long to wait for a batch body-fetch (UID FETCH … BODY.PEEK[]) to
/// complete.  50 bodies at ~50 KB each = ~2.5 MB; even at 1 Mbps that is
/// ~20 s.  Bumped to 600 s to match the spirit of the header-fetch bump:
/// generous headroom for one very large email or a slow server, while still
/// preventing an indefinite hang.
const BATCH_FETCH_TIMEOUT: Duration = Duration::from_secs(600);

type TlsSession = Session<TlsStream<TcpStream>>;

pub async fn test_connection(config: &ImapConfig) -> Result<()> {
    let mut session = connect(config).await?;
    session
        .logout()
        .await
        .map_err(|e| Error::Imap(format!("logout: {e}")))?;
    Ok(())
}

pub async fn list_folders(config: &ImapConfig) -> Result<Vec<Folder>> {
    let mut session = connect(config).await?;
    let mut stream = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|e| Error::Imap(format!("list: {e}")))?;

    let mut folders = Vec::new();
    while let Some(item) = stream.next().await {
        let entry = item.map_err(|e| Error::Imap(format!("list item: {e}")))?;
        folders.push(Folder {
            name: entry.name().to_string(),
            path: entry.name().to_string(),
            delimiter: entry.delimiter().map(str::to_string),
            flags: entry
                .attributes()
                .iter()
                .map(name_attribute_label)
                .collect(),
        });
    }
    drop(stream);

    session
        .logout()
        .await
        .map_err(|e| Error::Imap(format!("logout: {e}")))?;
    Ok(folders)
}

pub async fn folder_status(config: &ImapConfig, folder: &str) -> Result<FolderStatus> {
    timeout(STATUS_TIMEOUT, folder_status_inner(config, folder))
        .await
        .map_err(|_| Error::Imap(format!(
            "folder status timed out after {}s (folder \"{}\")",
            STATUS_TIMEOUT.as_secs(),
            folder,
        )))?
}

async fn folder_status_inner(config: &ImapConfig, folder: &str) -> Result<FolderStatus> {
    let mut session = connect(config).await?;
    let mbox = session
        .status(folder, "(UNSEEN MESSAGES)")
        .await
        .map_err(|e| Error::Imap(format!("status {folder}: {e}")))?;
    let _ = session.logout().await;
    Ok(FolderStatus {
        unseen: mbox.unseen.unwrap_or(0),
        total: mbox.exists,
    })
}

/// Check the UNSEEN/MESSAGES status of many folders in a single IMAP session,
/// returning one `FolderStatus` per path in the same order as `folders`.
/// Individual folder failures are silently replaced with a zero-count status
/// so one bad path does not abort the whole batch.
pub async fn folder_status_batch(
    config: &ImapConfig,
    folders: &[String],
) -> Result<Vec<FolderStatus>> {
    if folders.is_empty() {
        return Ok(Vec::new());
    }
    timeout(STATUS_TIMEOUT, folder_status_batch_inner(config, folders))
        .await
        .map_err(|_| Error::Imap(format!(
            "folder status batch timed out after {}s",
            STATUS_TIMEOUT.as_secs(),
        )))?
}

async fn folder_status_batch_inner(
    config: &ImapConfig,
    folders: &[String],
) -> Result<Vec<FolderStatus>> {
    let mut session = connect(config).await?;
    let mut results = Vec::with_capacity(folders.len());
    for folder in folders {
        let status = match session.status(folder, "(UNSEEN MESSAGES)").await {
            Ok(mbox) => FolderStatus {
                unseen: mbox.unseen.unwrap_or(0),
                total: mbox.exists,
            },
            Err(_) => FolderStatus { unseen: 0, total: 0 },
        };
        results.push(status);
    }
    let _ = session.logout().await;
    Ok(results)
}

pub async fn fetch_messages(
    config: &ImapConfig,
    folder: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<MessageSummary>> {
    // First attempt — most calls succeed here.
    let first = timeout(
        HEADER_FETCH_TIMEOUT,
        fetch_messages_inner(config, folder, limit, offset),
    )
    .await;

    match first {
        Ok(Ok(rows)) => return Ok(rows),
        Ok(Err(e)) => {
            // Inner returned an error (not a timeout).  Retry once with a
            // fresh connection — many such errors are stale-session issues
            // that disappear on reconnect (e.g. "BYE" from server, "session
            // closed", broken pipe).
            log::warn!(
                "fetch_messages error on first attempt (folder \"{}\", offset {}): {} — retrying once",
                folder, offset, e,
            );
        }
        Err(_) => {
            // Outer timeout fired.  Retry once with a fresh connection.
            log::warn!(
                "fetch_messages timed out after {}s on first attempt (folder \"{}\", offset {}) — retrying once",
                HEADER_FETCH_TIMEOUT.as_secs(), folder, offset,
            );
        }
    }

    // Second (and final) attempt.
    timeout(
        HEADER_FETCH_TIMEOUT,
        fetch_messages_inner(config, folder, limit, offset),
    )
    .await
    .map_err(|_| Error::Imap(format!(
        "header fetch timed out after {}s (folder \"{}\", offset {}) — retried once",
        HEADER_FETCH_TIMEOUT.as_secs(),
        folder,
        offset,
    )))?
}

async fn fetch_messages_inner(
    config: &ImapConfig,
    folder: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<MessageSummary>> {
    let mut session = connect(config).await?;
    let mailbox = session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let exists = mailbox.exists;
    if exists == 0 || offset >= exists {
        let _ = session.logout().await;
        return Ok(Vec::new());
    }

    // `offset` skips the most-recent N messages — the inbox is fetched
    // newest-first in pages of `limit`. Pages further back than `exists`
    // bottom out at sequence 1.
    let end = exists.saturating_sub(offset);
    let start = end.saturating_sub(limit.saturating_sub(1)).max(1);
    let query = format!("{start}:{end}");

    let mut stream = session
        .fetch(&query, "(UID FLAGS INTERNALDATE RFC822.HEADER)")
        .await
        .map_err(|e| Error::Imap(format!("fetch: {e}")))?;

    let mut summaries: Vec<MessageSummary> = Vec::new();
    while let Some(item) = stream.next().await {
        let fetch = item.map_err(|e| Error::Imap(format!("fetch item: {e}")))?;
        summaries.push(summary_from(&fetch));
    }
    drop(stream);
    let _ = session.logout().await;

    summaries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(summaries)
}

/// `UID SEARCH UNSEEN` + a single `UID FETCH` of the matched UIDs. Used by
/// the Unread tab to surface every server-side unread message in one round-
/// trip rather than paginating through cronological pages and discarding
/// the read ones.
pub async fn fetch_unread(
    config: &ImapConfig,
    folder: &str,
    limit: u32,
) -> Result<Vec<MessageSummary>> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let uids = session
        .uid_search("UNSEEN")
        .await
        .map_err(|e| Error::Imap(format!("uid_search UNSEEN: {e}")))?;

    if uids.is_empty() {
        let _ = session.logout().await;
        return Ok(Vec::new());
    }

    // Cap at `limit` newest UIDs so we don't pull thousands at once for
    // accounts with massive unread counts. Sorted descending so the cap
    // keeps the most recent ones.
    let mut sorted: Vec<u32> = uids.into_iter().collect();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    let take = limit.min(sorted.len() as u32) as usize;
    let chosen: Vec<String> = sorted.into_iter().take(take).map(|u| u.to_string()).collect();
    let query = chosen.join(",");

    let mut stream = session
        .uid_fetch(&query, "(UID FLAGS INTERNALDATE RFC822.HEADER)")
        .await
        .map_err(|e| Error::Imap(format!("uid_fetch: {e}")))?;

    let mut summaries: Vec<MessageSummary> = Vec::new();
    while let Some(item) = stream.next().await {
        let fetch = item.map_err(|e| Error::Imap(format!("fetch item: {e}")))?;
        summaries.push(summary_from(&fetch));
    }
    drop(stream);
    let _ = session.logout().await;

    summaries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(summaries)
}

/// Searches for messages in `folder` whose SUBJECT header contains `subject`
/// (case-insensitive, server-side IMAP SEARCH). Fetches the matched headers
/// and returns summaries — works on any message regardless of how old it is,
/// unlike the paginated `fetch_messages` which is capped to the N most-recent.
/// Returns every UID present in `folder` via `UID SEARCH ALL`. Used by the
/// expunge-detection path to find messages that have been deleted on other
/// clients since the last sync.
pub async fn fetch_all_uids(config: &ImapConfig, folder: &str) -> Result<Vec<u32>> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;
    let uids = session
        .uid_search("ALL")
        .await
        .map_err(|e| Error::Imap(format!("uid_search ALL: {e}")))?;
    let _ = session.logout().await;
    Ok(uids.into_iter().collect())
}

pub async fn search_by_subject(
    config: &ImapConfig,
    folder: &str,
    subject: &str,
) -> Result<Vec<MessageSummary>> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    // RFC 3501 §6.4.4: SEARCH SUBJECT matches messages that contain `subject`
    // in the Subject header (case-insensitive by spec). We quote the term so
    // spaces / special chars are handled correctly.
    let escaped = subject.replace('\\', "\\\\").replace('"', "\\\"");
    let search_term = format!("SUBJECT \"{escaped}\"");

    let uids = session
        .uid_search(&search_term)
        .await
        .map_err(|e| Error::Imap(format!("uid_search SUBJECT: {e}")))?;

    if uids.is_empty() {
        let _ = session.logout().await;
        return Ok(Vec::new());
    }

    let chosen: Vec<String> = uids.into_iter().map(|u| u.to_string()).collect();
    let query = chosen.join(",");

    let mut stream = session
        .uid_fetch(&query, "(UID FLAGS INTERNALDATE RFC822.HEADER)")
        .await
        .map_err(|e| Error::Imap(format!("uid_fetch: {e}")))?;

    let mut summaries: Vec<MessageSummary> = Vec::new();
    while let Some(item) = stream.next().await {
        let fetch = item.map_err(|e| Error::Imap(format!("fetch item: {e}")))?;
        summaries.push(summary_from(&fetch));
    }
    drop(stream);
    let _ = session.logout().await;

    summaries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(summaries)
}

pub async fn set_flags(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
    flags: &[String],
    mode: FlagMode,
) -> Result<()> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let flag_list = flags.join(" ");
    let prefix = match mode {
        FlagMode::Add => "+FLAGS",
        FlagMode::Remove => "-FLAGS",
        FlagMode::Replace => "FLAGS",
    };
    let query = format!("{prefix} ({flag_list})");

    let mut stream = session
        .uid_store(uid.to_string(), &query)
        .await
        .map_err(|e| Error::Imap(format!("uid_store: {e}")))?;

    // Drain the stream so the command completes on the wire.
    while stream.next().await.is_some() {}
    drop(stream);

    let _ = session.logout().await;
    Ok(())
}

/// Same as `set_flags` but operates on a set of UIDs in a single round-trip.
/// The UID list is formatted as a comma-separated sequence set, e.g. "101,103,107".
pub async fn set_flags_multi(
    config: &ImapConfig,
    folder: &str,
    uids: &[u32],
    flags: &[String],
    mode: FlagMode,
) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let uid_set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let flag_list = flags.join(" ");
    let prefix = match mode {
        FlagMode::Add => "+FLAGS",
        FlagMode::Remove => "-FLAGS",
        FlagMode::Replace => "FLAGS",
    };
    let query = format!("{prefix} ({flag_list})");

    let mut stream = session
        .uid_store(&uid_set, &query)
        .await
        .map_err(|e| Error::Imap(format!("uid_store_multi: {e}")))?;

    while stream.next().await.is_some() {}
    drop(stream);

    let _ = session.logout().await;
    Ok(())
}

/// Permanently delete a single message: mark it `\Deleted` then issue
/// `UID EXPUNGE` so the server removes it immediately.  Used when deleting
/// from the Trash or Spam folder where "move to Trash" would be a no-op.
pub async fn expunge_uid(config: &ImapConfig, folder: &str, uid: u32) -> Result<()> {
    expunge_uids(config, folder, &[uid]).await
}

/// Permanently delete a batch of messages in one IMAP session.
/// Marks all `uids` as `\Deleted` then issues a single `UID EXPUNGE`.
pub async fn expunge_uids(config: &ImapConfig, folder: &str, uids: &[u32]) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let uid_set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let mut store = session
        .uid_store(&uid_set, "+FLAGS (\\Deleted)")
        .await
        .map_err(|e| Error::Imap(format!("uid_store \\Deleted: {e}")))?;
    while store.next().await.is_some() {}
    drop(store);

    let expunge = session
        .uid_expunge(&uid_set)
        .await
        .map_err(|e| Error::Imap(format!("uid_expunge: {e}")))?;
    let mut expunge = Box::pin(expunge);
    while expunge.next().await.is_some() {}
    drop(expunge);

    let _ = session.logout().await;
    Ok(())
}

pub async fn move_uid(
    config: &ImapConfig,
    folder: &str,
    dest_folder: &str,
    uid: u32,
) -> Result<()> {
    move_uids(config, folder, dest_folder, &[uid]).await
}

/// Move multiple UIDs from `folder` to `dest_folder` in a single IMAP session.
pub async fn move_uids(
    config: &ImapConfig,
    folder: &str,
    dest_folder: &str,
    uids: &[u32],
) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let uid_set = uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    // Try RFC 6851 UID MOVE first (supported by Dovecot, Gmail, Cyrus, etc).
    match session.uid_mv(&uid_set, dest_folder).await {
        Ok(_) => {}
        Err(_move_err) => {
            // Fallback: COPY + STORE +FLAGS \Deleted + UID EXPUNGE.
            session
                .uid_copy(&uid_set, dest_folder)
                .await
                .map_err(|e| Error::Imap(format!("uid_copy: {e}")))?;

            let mut store = session
                .uid_store(&uid_set, "+FLAGS (\\Deleted)")
                .await
                .map_err(|e| Error::Imap(format!("uid_store: {e}")))?;
            while store.next().await.is_some() {}
            drop(store);

            let expunge = session
                .uid_expunge(&uid_set)
                .await
                .map_err(|e| Error::Imap(format!("uid_expunge: {e}")))?;
            let mut expunge = Box::pin(expunge);
            while expunge.next().await.is_some() {}
        }
    }

    let _ = session.logout().await;
    Ok(())
}

pub async fn fetch_message_body(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
) -> Result<MessageBody> {
    let bytes = fetch_raw_message(config, folder, uid).await?;
    crate::parser::parse_raw(&bytes, uid)
}

/// Fetch multiple message bodies in a **single IMAP session** (one login,
/// one SELECT, one `UID FETCH` command).  Results are returned in whatever
/// order the server sends them; each `MessageBody` carries its own `uid`.
/// Messages the server does not return (unknown UID, expunged, etc.) are
/// silently skipped — the caller can detect them by checking which UIDs
/// are absent from the result.
///
/// The entire operation is wrapped in a [`BATCH_FETCH_TIMEOUT`] deadline so a
/// server that stops sending mid-stream does not stall the bulk-download
/// indefinitely.  On timeout the error is propagated and the caller counts
/// the whole chunk as failed (to be retried on the next run).
pub async fn fetch_message_bodies_batch(
    config: &ImapConfig,
    folder: &str,
    uids: &[u32],
) -> Result<Vec<MessageBody>> {
    if uids.is_empty() {
        return Ok(vec![]);
    }

    timeout(BATCH_FETCH_TIMEOUT, fetch_message_bodies_batch_inner(config, folder, uids))
        .await
        .map_err(|_| Error::Imap(format!(
            "batch body fetch timed out after {}s ({} UIDs in folder \"{}\")",
            BATCH_FETCH_TIMEOUT.as_secs(),
            uids.len(),
            folder,
        )))?
}

async fn fetch_message_bodies_batch_inner(
    config: &ImapConfig,
    folder: &str,
    uids: &[u32],
) -> Result<Vec<MessageBody>> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let uid_set = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let mut stream = session
        .uid_fetch(&uid_set, "(UID BODY.PEEK[])")
        .await
        .map_err(|e| Error::Imap(format!("uid_fetch batch: {e}")))?;

    let mut results = Vec::new();
    while let Some(item) = stream.next().await {
        let fetch = match item {
            Ok(f) => f,
            Err(_) => continue, // skip malformed fetch responses
        };
        let uid = match fetch.uid {
            Some(u) if u > 0 => u,
            _ => continue,
        };
        if let Some(body_bytes) = fetch.body() {
            if let Ok(parsed) = crate::parser::parse_raw(body_bytes, uid) {
                results.push(parsed);
            }
        }
    }
    drop(stream);
    let _ = session.logout().await;

    Ok(results)
}

pub async fn save_attachment(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
    index: u32,
    dest_path: &str,
) -> Result<()> {
    let bytes = fetch_raw_message(config, folder, uid).await?;
    let attachment = crate::parser::extract_attachment(&bytes, index)?;
    std::fs::write(dest_path, &attachment)?;
    Ok(())
}

pub async fn load_attachment_b64(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
    index: u32,
) -> Result<String> {
    use base64::{Engine as _, engine::general_purpose};
    let bytes = fetch_raw_message(config, folder, uid).await?;
    let attachment = crate::parser::extract_attachment(&bytes, index)?;
    Ok(general_purpose::STANDARD.encode(&attachment))
}

pub async fn create_folder(config: &ImapConfig, name: &str) -> Result<()> {
    let mut session = connect(config).await?;
    session
        .create(name)
        .await
        .map_err(|e| Error::Imap(format!("create {name}: {e}")))?;
    let _ = session.logout().await;
    Ok(())
}

pub async fn rename_folder(config: &ImapConfig, from: &str, to: &str) -> Result<()> {
    let mut session = connect(config).await?;
    session
        .rename(from, to)
        .await
        .map_err(|e| Error::Imap(format!("rename {from} -> {to}: {e}")))?;
    let _ = session.logout().await;
    Ok(())
}

pub async fn delete_folder(config: &ImapConfig, path: &str) -> Result<()> {
    let mut session = connect(config).await?;
    session
        .delete(path)
        .await
        .map_err(|e| Error::Imap(format!("delete {path}: {e}")))?;
    let _ = session.logout().await;
    Ok(())
}

pub async fn append_message(
    config: &ImapConfig,
    folder: &str,
    bytes: &[u8],
    flags: &[String],
) -> Result<()> {
    let mut session = connect(config).await?;

    // async-imap 0.10 expects flags as a raw parenthesised IMAP list
    // (e.g. `(\Seen)`), not a slice. Build it only when we actually have
    // flags to avoid sending an empty `()` which some servers reject.
    let flags_str: Option<String> = if flags.is_empty() {
        None
    } else {
        Some(format!("({})", flags.join(" ")))
    };

    session
        .append(folder, flags_str.as_deref(), None, bytes)
        .await
        .map_err(|e| Error::Imap(format!("append to {folder}: {e}")))?;

    let _ = session.logout().await;
    Ok(())
}

async fn fetch_raw_message(config: &ImapConfig, folder: &str, uid: u32) -> Result<Vec<u8>> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("select {folder}: {e}")))?;

    let mut stream = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .await
        .map_err(|e| Error::Imap(format!("uid_fetch: {e}")))?;

    let mut raw: Option<Vec<u8>> = None;
    let mut items_seen: u32 = 0;
    while let Some(item) = stream.next().await {
        let fetch = item.map_err(|e| Error::Imap(format!("fetch item: {e}")))?;
        items_seen += 1;
        if let Some(body) = fetch.body() {
            raw = Some(body.to_vec());
            break;
        }
    }
    drop(stream);
    let _ = session.logout().await;

    raw.ok_or_else(|| {
        if items_seen == 0 {
            Error::Imap(format!(
                "UID {uid} not found in folder \"{folder}\" (message may have been moved or deleted)"
            ))
        } else {
            Error::Imap(format!(
                "server returned {items_seen} FETCH response(s) for UID {uid} but none contained a body"
            ))
        }
    })
}

fn summary_from(fetch: &async_imap::types::Fetch) -> MessageSummary {
    let uid = fetch.uid.unwrap_or(0);
    let flags: Vec<String> = fetch.flags().map(|f| format!("{f:?}")).collect();
    let internal_date = fetch.internal_date().map(|d| d.timestamp());

    // Parse the raw RFC822.HEADER bytes with mail-parser — this handles
    // RFC 2047 encoded-words (`=?utf-8?Q?...?=`) automatically so subject
    // and names come out human-readable.
    let header_bytes = fetch.header().unwrap_or(&[]);
    let parsed = MessageParser::default().parse(header_bytes);

    let subject = parsed
        .as_ref()
        .and_then(|p| p.subject())
        .map(String::from);

    let from = parsed
        .as_ref()
        .and_then(|p| p.from())
        .and_then(|a| a.first())
        .map(format_mp_addr);

    let to = parsed
        .as_ref()
        .and_then(|p| p.to())
        .map(|a| a.iter().map(format_mp_addr).collect::<Vec<_>>())
        .unwrap_or_default();

    let cc = parsed
        .as_ref()
        .and_then(|p| p.cc())
        .map(|a| a.iter().map(format_mp_addr).collect::<Vec<_>>())
        .unwrap_or_default();

    let bcc = parsed
        .as_ref()
        .and_then(|p| p.bcc())
        .map(|a| a.iter().map(format_mp_addr).collect::<Vec<_>>())
        .unwrap_or_default();

    let header_date = parsed
        .as_ref()
        .and_then(|p| p.date())
        .map(|d| d.to_timestamp());

    let is_bulk = parsed.as_ref().is_some_and(|p| {
        p.header("List-Unsubscribe").is_some()
            || p.header("List-Id").is_some()
            || header_text(p, "Precedence").is_some_and(|v| {
                let lv = v.to_ascii_lowercase();
                lv.contains("bulk") || lv.contains("list")
            })
    });

    let is_auto = parsed.as_ref().is_some_and(|p| {
        header_text(p, "Auto-Submitted").is_some_and(|v| !v.eq_ignore_ascii_case("no"))
    });

    let message_id = parsed
        .as_ref()
        .and_then(|p| header_text(p, "Message-ID").or_else(|| header_text(p, "Message-Id")))
        .map(normalise_message_id)
        .unwrap_or_default();

    let in_reply_to = parsed
        .as_ref()
        .and_then(|p| header_text(p, "In-Reply-To"))
        .map(normalise_message_id)
        .unwrap_or_default();

    let references = parsed
        .as_ref()
        .and_then(|p| header_text(p, "References"))
        .map(extract_references)
        .unwrap_or_default();

    MessageSummary {
        uid,
        subject,
        from,
        to,
        cc,
        bcc,
        date: header_date.or(internal_date),
        snippet: None,
        flags,
        has_attachments: false,
        is_bulk,
        is_auto,
        message_id,
        in_reply_to,
        references,
    }
}

/// Strip outer angle brackets and lowercase. The wire form is typically
/// `<abc.123@host.com>`; we want `abc.123@host.com`. Some senders include
/// surrounding whitespace or quotes — those are also trimmed.
fn normalise_message_id(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches(|c: char| c == '<' || c == '>' || c == '"' || c.is_whitespace());
    trimmed.to_ascii_lowercase()
}

/// `References:` is whitespace-separated. We split on whitespace, then
/// normalise each token. Empty tokens are skipped.
fn extract_references(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(normalise_message_id)
        .filter(|s| !s.is_empty())
        .collect()
}

fn header_text<'a>(msg: &'a mail_parser::Message<'_>, name: &'a str) -> Option<&'a str> {
    msg.header(name).and_then(|v| v.as_text())
}

fn format_mp_addr(a: &mail_parser::Addr<'_>) -> String {
    let name = a.name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());
    let address = a.address.as_deref().map(|s| s.trim());
    match (name, address) {
        (Some(n), Some(addr)) => format!("{n} <{addr}>"),
        (None, Some(addr)) => addr.to_string(),
        (Some(n), None) => n.to_string(),
        _ => String::new(),
    }
}

fn name_attribute_label(attr: &async_imap::imap_proto::NameAttribute<'_>) -> String {
    use async_imap::imap_proto::NameAttribute;
    match attr {
        NameAttribute::NoInferiors => "\\NoInferiors".into(),
        NameAttribute::NoSelect => "\\NoSelect".into(),
        NameAttribute::Marked => "\\Marked".into(),
        NameAttribute::Unmarked => "\\Unmarked".into(),
        NameAttribute::Extension(s) => s.to_string(),
        // The enum is marked non_exhaustive; any newer variant falls back
        // to its debug form so the frontend at least sees something.
        other => format!("{other:?}"),
    }
}

pub(crate) async fn connect(config: &ImapConfig) -> Result<TlsSession> {
    match config.security {
        ImapSecurity::Ssl => connect_ssl(config).await,
        ImapSecurity::StartTls => connect_starttls(config).await,
        ImapSecurity::None => Err(Error::Config(
            "Plain IMAP is not supported — choose SSL or STARTTLS".into(),
        )),
    }
}

async fn connect_ssl(config: &ImapConfig) -> Result<TlsSession> {
    let tcp = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((config.host.as_str(), config.port)),
    )
    .await
    .map_err(|_| Error::Imap(format!("connect timed out after {}s", CONNECT_TIMEOUT.as_secs())))?
    .map_err(|e| Error::Imap(format!("connect: {e}")))?;
    let tls_stream = tls_handshake(&config.host, tcp).await?;
    finish_login(tls_stream, config).await
}

async fn connect_starttls(config: &ImapConfig) -> Result<TlsSession> {
    let tcp = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((config.host.as_str(), config.port)),
    )
    .await
    .map_err(|_| Error::Imap(format!("connect timed out after {}s", CONNECT_TIMEOUT.as_secs())))?
    .map_err(|e| Error::Imap(format!("connect: {e}")))?;
    let mut plain = async_imap::Client::new(tcp);
    plain
        .run_command_and_check_ok("STARTTLS", None)
        .await
        .map_err(|e| Error::Imap(format!("starttls: {e}")))?;
    let tcp = plain.into_inner();
    let tls_stream = tls_handshake(&config.host, tcp).await?;
    finish_login(tls_stream, config).await
}

async fn tls_handshake(host: &str, tcp: TcpStream) -> Result<TlsStream<TcpStream>> {
    let tls = TlsConnector::builder().build()?;
    let tls = tokio_native_tls::TlsConnector::from(tls);
    tls.connect(host, tcp)
        .await
        .map_err(|e| Error::Imap(format!("tls handshake: {e}")))
}

async fn finish_login(
    stream: TlsStream<TcpStream>,
    config: &ImapConfig,
) -> Result<TlsSession> {
    let client = async_imap::Client::new(stream);
    let session = client
        .login(&config.username, &config.password)
        .await
        .map_err(|(e, _)| Error::Imap(format!("login: {e}")))?;
    Ok(session)
}
