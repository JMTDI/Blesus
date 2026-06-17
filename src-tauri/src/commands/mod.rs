use std::sync::Arc;

use crate::error::Result;
use crate::imap::idle::IdleManager;
use crate::imap::types::{FlagMode, Folder, FolderStatus, ImapConfig, MessageBody, MessageSummary};
use crate::imap::{self};
use crate::smtp::resend::ResendTemplateSummary;
use crate::smtp::types::{OutgoingMessage, SaveToSent, SendResult, SmtpConfig};
use crate::smtp::{lettre_transport, resend};

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
pub fn secrets_save(key: String, value: String) -> Result<()> {
    crate::secrets::save(&key, &value)
}

#[tauri::command]
pub fn secrets_load(key: String) -> Result<Option<String>> {
    crate::secrets::load(&key)
}

#[tauri::command]
pub fn secrets_delete(key: String) -> Result<()> {
    crate::secrets::delete(&key)
}

#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn backup_seal(password: String, plaintext: String) -> std::result::Result<String, String> {
    crate::backup::seal(&password, &plaintext)
}

#[tauri::command]
pub fn backup_unseal(password: String, blob: String) -> std::result::Result<String, String> {
    crate::backup::unseal(&password, &blob)
}

#[tauri::command]
pub fn backup_write_file(path: String, contents: String) -> std::result::Result<(), String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("write {}: {}", path, e))
}

#[tauri::command]
pub fn backup_read_file(path: String) -> std::result::Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

#[tauri::command]
pub async fn window_set_unread_badge(app: tauri::AppHandle, count: u32) -> Result<()> {
    use tauri::Manager;
    log::info!("window_set_unread_badge(count={count}) invoked");
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| crate::error::Error::Config("no main window".into()))?;
    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|e| crate::error::Error::Config(format!("hwnd: {e}")))?;
        log::info!("  hwnd = {:?}", hwnd.0);
        match crate::badge::set_unread(hwnd.0 as isize, count) {
            Ok(()) => log::info!("  badge set ok"),
            Err(e) => log::warn!("  badge failed: {e}"),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        crate::badge::set_unread(0, count)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn imap_test_connection(config: ImapConfig) -> Result<()> {
    imap::client::test_connection(&config).await
}

#[tauri::command]
pub async fn imap_list_folders(config: ImapConfig) -> Result<Vec<Folder>> {
    imap::client::list_folders(&config).await
}

#[tauri::command]
pub async fn imap_folder_status(config: ImapConfig, folder: String) -> Result<FolderStatus> {
    imap::client::folder_status(&config, &folder).await
}

#[tauri::command]
pub async fn imap_folder_status_batch(
    config: ImapConfig,
    folders: Vec<String>,
) -> Result<Vec<FolderStatus>> {
    imap::client::folder_status_batch(&config, &folders).await
}

#[tauri::command]
pub async fn imap_fetch_messages(
    config: ImapConfig,
    folder: String,
    limit: u32,
    offset: Option<u32>,
) -> Result<Vec<MessageSummary>> {
    imap::client::fetch_messages(&config, &folder, limit, offset.unwrap_or(0)).await
}

#[tauri::command]
pub async fn imap_fetch_unread(
    config: ImapConfig,
    folder: String,
    limit: u32,
) -> Result<Vec<MessageSummary>> {
    imap::client::fetch_unread(&config, &folder, limit).await
}

#[tauri::command]
pub async fn imap_fetch_message_body(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<MessageBody> {
    imap::client::fetch_message_body(&config, &folder, uid).await
}

#[tauri::command]
pub async fn imap_fetch_message_bodies_batch(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<Vec<MessageBody>> {
    imap::client::fetch_message_bodies_batch(&config, &folder, &uids).await
}

#[tauri::command]
pub async fn imap_expunge_uid(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<()> {
    imap::client::expunge_uid(&config, &folder, uid).await
}

#[tauri::command]
pub async fn imap_expunge_uids(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<()> {
    imap::client::expunge_uids(&config, &folder, &uids).await
}

#[tauri::command]
pub async fn imap_save_attachment(
    config: ImapConfig,
    folder: String,
    uid: u32,
    index: u32,
    dest_path: String,
) -> Result<()> {
    imap::client::save_attachment(&config, &folder, uid, index, &dest_path).await
}

#[tauri::command]
pub async fn imap_load_attachment_b64(
    config: ImapConfig,
    folder: String,
    uid: u32,
    index: u32,
) -> Result<String> {
    imap::client::load_attachment_b64(&config, &folder, uid, index).await
}

#[tauri::command]
pub async fn imap_create_folder(config: ImapConfig, name: String) -> Result<()> {
    imap::client::create_folder(&config, &name).await
}

#[tauri::command]
pub async fn imap_rename_folder(
    config: ImapConfig,
    from: String,
    to: String,
) -> Result<()> {
    imap::client::rename_folder(&config, &from, &to).await
}

#[tauri::command]
pub async fn imap_delete_folder(config: ImapConfig, path: String) -> Result<()> {
    imap::client::delete_folder(&config, &path).await
}

#[tauri::command]
pub async fn imap_set_flags(
    config: ImapConfig,
    folder: String,
    uid: u32,
    flags: Vec<String>,
    mode: FlagMode,
) -> Result<()> {
    log::info!(
        "imap_set_flags → host={} folder={:?} uid={} mode={:?} flags={:?}",
        config.host, folder, uid, mode, flags,
    );
    match imap::client::set_flags(&config, &folder, uid, &flags, mode).await {
        Ok(()) => {
            log::info!("imap_set_flags ok uid={}", uid);
            Ok(())
        }
        Err(e) => {
            log::error!("imap_set_flags failed uid={}: {e}", uid);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn imap_set_flags_multi(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    mode: FlagMode,
) -> Result<()> {
    log::info!(
        "imap_set_flags_multi → host={} folder={:?} uids={:?} mode={:?} flags={:?}",
        config.host, folder, uids, mode, flags,
    );
    imap::client::set_flags_multi(&config, &folder, &uids, &flags, mode).await
}

#[tauri::command]
pub async fn imap_fetch_all_uids(
    config: ImapConfig,
    folder: String,
) -> Result<Vec<u32>> {
    imap::client::fetch_all_uids(&config, &folder).await
}

#[tauri::command]
pub async fn imap_search_by_subject(
    config: ImapConfig,
    folder: String,
    subject: String,
) -> Result<Vec<MessageSummary>> {
    imap::client::search_by_subject(&config, &folder, &subject).await
}

#[tauri::command]
pub async fn imap_move_uid(
    config: ImapConfig,
    folder: String,
    dest_folder: String,
    uid: u32,
) -> Result<()> {
    log::info!(
        "imap_move_uid → host={} from={:?} to={:?} uid={}",
        config.host, folder, dest_folder, uid,
    );
    match imap::client::move_uid(&config, &folder, &dest_folder, uid).await {
        Ok(()) => {
            log::info!("imap_move_uid ok uid={}", uid);
            Ok(())
        }
        Err(e) => {
            log::error!("imap_move_uid failed uid={}: {e}", uid);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn imap_move_uids(
    config: ImapConfig,
    folder: String,
    dest_folder: String,
    uids: Vec<u32>,
) -> Result<()> {
    log::info!(
        "imap_move_uids → host={} from={:?} to={:?} uids={:?}",
        config.host, folder, dest_folder, uids,
    );
    match imap::client::move_uids(&config, &folder, &dest_folder, &uids).await {
        Ok(()) => {
            log::info!("imap_move_uids ok count={}", uids.len());
            Ok(())
        }
        Err(e) => {
            log::error!("imap_move_uids failed: {e}");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn smtp_test_connection(config: SmtpConfig) -> Result<()> {
    lettre_transport::test_connection(&config).await
}

#[tauri::command]
pub async fn smtp_send(
    config: SmtpConfig,
    message: OutgoingMessage,
    save_to_sent: Option<SaveToSent>,
) -> Result<SendResult> {
    log::info!(
        "smtp_send → host={} port={} from={} to={:?} subj={:?}",
        config.host, config.port, message.from, message.to, message.subject,
    );
    match lettre_transport::send(&config, &message, save_to_sent.as_ref()).await {
        Ok(r) => {
            log::info!("smtp_send ok: id={:?} appended={:?}", r.message_id, r.imap_appended);
            Ok(r)
        }
        Err(e) => {
            log::error!("smtp_send failed: {e}");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn resend_send(
    api_key: String,
    message: OutgoingMessage,
    save_to_sent: Option<SaveToSent>,
) -> Result<SendResult> {
    log::info!(
        "resend_send → from={} to={:?} subj={:?} attachments={}",
        message.from, message.to, message.subject, message.attachments.len(),
    );
    match resend::send(&api_key, &message, save_to_sent.as_ref()).await {
        Ok(r) => {
            log::info!("resend_send ok: id={:?} appended={:?}", r.message_id, r.imap_appended);
            Ok(r)
        }
        Err(e) => {
            log::error!("resend_send failed: {e}");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn resend_send_template(
    api_key: String,
    template_id: String,
    from: String,
    to: Vec<String>,
    variables: serde_json::Value,
) -> Result<SendResult> {
    log::info!("resend_send_template → template={} from={} to={:?}", template_id, from, to);
    match resend::send_template(&api_key, &template_id, &from, &to, &variables).await {
        Ok(r) => {
            log::info!("resend_send_template ok: id={:?}", r.message_id);
            Ok(r)
        }
        Err(e) => {
            log::error!("resend_send_template failed: {e}");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn resend_list_templates(api_key: String) -> Result<Vec<ResendTemplateSummary>> {
    resend::list_templates(&api_key).await
}

/// RFC 8058 one-click unsubscribe. POSTs `List-Unsubscribe=One-Click` to the
/// provided https URL with the required Content-Type. Returns Ok on any 2xx;
/// error with the status + body on non-2xx so the UI can surface it.
#[tauri::command]
pub async fn unsubscribe_one_click(url: String) -> Result<()> {
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| crate::error::Error::Http(e))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(crate::error::Error::Config(format!(
            "unsubscribe one-click: {status}: {text}"
        )));
    }
    Ok(())
}

/// Start an IMAP IDLE session for `(account_id, folder)`. The Rust side
/// keeps the connection alive and emits a `imap-update` event whenever the
/// server pushes EXISTS / EXPUNGE. Calling this for the same key while one
/// is already running stops the old session first.
#[tauri::command]
pub async fn imap_idle_start(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<IdleManager>>,
    account_id: i64,
    config: ImapConfig,
    folder: String,
) -> Result<()> {
    manager.inner().clone().start(app, account_id, config, folder).await;
    Ok(())
}

/// Stop the IDLE session for `(account_id, folder)`. No-op if none active.
#[tauri::command]
pub async fn imap_idle_stop(
    manager: tauri::State<'_, Arc<IdleManager>>,
    account_id: i64,
    folder: String,
) -> Result<()> {
    let key = format!("{account_id}:{folder}");
    manager.stop(&key).await;
    Ok(())
}

/// Forward a log line from the frontend into the unified Rust logger so it
/// lands in the same rotated file as backend logs. Unknown levels collapse
/// to info — never reject a log call, the cost of losing context is higher.
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: "frontend", "{message}"),
        "warn" => log::warn!(target: "frontend", "{message}"),
        "debug" => log::debug!(target: "frontend", "{message}"),
        _ => log::info!(target: "frontend", "{message}"),
    }
}

/// Absolute path of `<exe_dir>/blesus-files/logs/`. Used by the "Open log
/// folder" button in Settings → About.
#[tauri::command]
pub fn get_logs_dir(state: tauri::State<'_, crate::LogsDir>) -> String {
    state.0.to_string_lossy().into_owned()
}

/// Returns the absolute path to the attachment cache directory.
#[tauri::command]
pub fn get_attachment_cache_dir(state: tauri::State<'_, crate::LogsDir>) -> String {
    let logs_dir = &state.0;
    let cache_dir = logs_dir
        .parent()
        .unwrap_or(logs_dir)
        .join("attachment-cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    cache_dir.to_string_lossy().into_owned()
}

/// Reads a cached attachment file and returns it as base64.
/// Uses spawn_blocking so the synchronous file I/O does not block the async runtime.
#[tauri::command]
pub async fn attachment_cache_read(
    state: tauri::State<'_, crate::LogsDir>,
    file_name: String,
) -> Result<String> {
    use base64::Engine;
    let logs_dir = &state.0;
    let cache_dir = logs_dir.parent().unwrap_or(logs_dir).join("attachment-cache");
    let path = cache_dir.join(&file_name);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| crate::Error::Imap(format!("spawn_blocking: {e}")))?
        .map_err(|e| crate::Error::Imap(format!("cache read {file_name}: {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Writes base64 attachment data to a cache file on disk.
/// Uses spawn_blocking so the synchronous file I/O does not block the async runtime.
#[tauri::command]
pub async fn attachment_cache_write(
    state: tauri::State<'_, crate::LogsDir>,
    file_name: String,
    b64: String,
) -> Result<()> {
    use base64::Engine;
    let logs_dir = &state.0;
    let cache_dir = logs_dir.parent().unwrap_or(logs_dir).join("attachment-cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .map_err(|e| crate::Error::Imap(format!("base64 decode: {e}")))?;
    let path = cache_dir.join(&file_name);
    tokio::task::spawn_blocking(move || std::fs::write(&path, &bytes))
        .await
        .map_err(|e| crate::Error::Imap(format!("spawn_blocking: {e}")))?
        .map_err(|e| crate::Error::Imap(format!("cache write {file_name}: {e}")))?;
    Ok(())
}

/// Deletes a cached attachment file from disk.
/// Uses spawn_blocking so the synchronous file I/O does not block the async runtime.
#[tauri::command]
pub async fn attachment_cache_delete(
    state: tauri::State<'_, crate::LogsDir>,
    file_name: String,
) -> Result<()> {
    let logs_dir = &state.0;
    let cache_dir = logs_dir.parent().unwrap_or(logs_dir).join("attachment-cache");
    let path = cache_dir.join(&file_name);
    tokio::task::spawn_blocking(move || {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| crate::Error::Imap(format!("cache delete {file_name}: {e}")))?;
        }
        Ok::<(), crate::Error>(())
    })
    .await
    .map_err(|e| crate::Error::Imap(format!("spawn_blocking: {e}")))?
}
