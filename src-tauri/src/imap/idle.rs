//! IMAP IDLE (RFC 2177) — push-receive instead of polling.
//!
//! For the user-visible folder we keep a single TCP+TLS connection alive
//! in IDLE state. The server pushes EXISTS / EXPUNGE notifications as soon
//! as anything changes, and we re-emit them as a Tauri event the frontend
//! listens for. The frontend reacts by calling `fetchFolder` (silent), so
//! new mail appears in seconds rather than at the next poll tick.
//!
//! Cancellation:
//!  - Each IDLE session is owned by a tokio task addressed by a string key
//!    `account_id:folder_path`.
//!  - `IdleManager::stop(key)` notifies that task to exit at the next safe
//!    boundary (current IDLE returns either via the StopSource cancel or
//!    when the 25-minute timer fires).
//!
//! Lifetime:
//!  - The 25-minute timeout is below the RFC 2177 maximum of 29 minutes.
//!  - Errors trigger a 30-second backoff so a flaky network can recover
//!    without hammering the server.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

use super::client::connect;
use super::types::ImapConfig;
use crate::error::{Error, Result};

const IDLE_KEEPALIVE: Duration = Duration::from_secs(25 * 60);
const RETRY_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleEvent {
    pub account_id: i64,
    pub folder: String,
}

#[derive(Default)]
pub struct IdleManager {
    handles: Mutex<HashMap<String, Arc<Notify>>>,
}

impl IdleManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or restart) an IDLE session for `(account_id, folder)`.
    /// If one is already running for the same key, it is stopped first.
    pub async fn start(
        self: Arc<Self>,
        app: AppHandle,
        account_id: i64,
        config: ImapConfig,
        folder: String,
    ) {
        let key = format!("{account_id}:{folder}");
        self.stop(&key).await;

        let cancel = Arc::new(Notify::new());
        self.handles.lock().await.insert(key.clone(), cancel.clone());

        let app_clone = app.clone();
        let folder_clone = folder.clone();
        let manager = self.clone();

        tokio::spawn(async move {
            loop {
                // Single IDLE round. Returns when something changes, the
                // 25-minute timer fires, or the cancel notify is signalled.
                let outcome = run_one_idle(&config, &folder_clone, cancel.clone()).await;

                match outcome {
                    Ok(IdleOutcome::Update) => {
                        let _ = app_clone.emit(
                            "imap-update",
                            &IdleEvent {
                                account_id,
                                folder: folder_clone.clone(),
                            },
                        );
                        // Loop straight back into IDLE to catch the next push.
                    }
                    Ok(IdleOutcome::KeepaliveExpired) => {
                        // RFC 2177 says re-issue IDLE before the 29-minute
                        // limit. Loop straight back to do that.
                    }
                    Ok(IdleOutcome::Cancelled) => {
                        // Manager asked us to stop. Drop our slot in the
                        // map and exit.
                        manager.handles.lock().await.remove(&key);
                        return;
                    }
                    Err(e) => {
                        log::warn!("IDLE for {key}: {e}, backing off {RETRY_BACKOFF:?}");
                        // Sleep with cancellation: a stop() during backoff
                        // should still terminate quickly.
                        tokio::select! {
                            _ = tokio::time::sleep(RETRY_BACKOFF) => {}
                            _ = cancel.notified() => {
                                manager.handles.lock().await.remove(&key);
                                return;
                            }
                        }
                    }
                }
            }
        });
    }

    pub async fn stop(&self, key: &str) {
        if let Some(notify) = self.handles.lock().await.remove(key) {
            // Signal any awaiter inside the IDLE select! to break out.
            notify.notify_waiters();
        }
    }

}

enum IdleOutcome {
    Update,
    KeepaliveExpired,
    Cancelled,
}

async fn run_one_idle(
    config: &ImapConfig,
    folder: &str,
    cancel: Arc<Notify>,
) -> Result<IdleOutcome> {
    let mut session = connect(config).await?;
    session
        .select(folder)
        .await
        .map_err(|e| Error::Imap(format!("idle select {folder}: {e}")))?;

    let mut idle = session.idle();
    idle.init()
        .await
        .map_err(|e| Error::Imap(format!("idle init: {e}")))?;

    // Scope the borrow of `idle` so we can call `idle.done()` afterwards
    // without conflicting with the lifetime of the wait future.
    let outcome = {
        let (idle_fut, stop_src) = idle.wait_with_timeout(IDLE_KEEPALIVE);
        tokio::pin!(idle_fut);

        tokio::select! {
            res = &mut idle_fut => match res {
                Ok(IdleResponse::NewData(_)) => IdleOutcome::Update,
                Ok(IdleResponse::Timeout) => IdleOutcome::KeepaliveExpired,
                Ok(IdleResponse::ManualInterrupt) => IdleOutcome::Cancelled,
                Err(e) => return Err(Error::Imap(format!("idle wait: {e}"))),
            },
            _ = cancel.notified() => {
                // Drop the stop source to interrupt the wait future. Then
                // poll it once to let it finish its cleanup; this also
                // unblocks the underlying TCP read.
                drop(stop_src);
                let _ = idle_fut.await;
                IdleOutcome::Cancelled
            }
        }
    };

    // Always send DONE so the connection ends cleanly. Errors here are
    // best-effort — the server will time us out anyway if we just drop.
    let mut session = idle.done().await.map_err(|e| Error::Imap(format!("idle done: {e}")))?;
    let _ = session.logout().await;

    Ok(outcome)
}

// We need to expose a single Stream import path for futures::StreamExt
// elsewhere; keep this as the canonical place.
#[allow(dead_code)]
fn _ensure_stream_ext() {
    fn _take<T: StreamExt>(_: T) {}
}
