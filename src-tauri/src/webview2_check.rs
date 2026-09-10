//! Detects whether the Microsoft Edge WebView2 Runtime is installed before
//! Tauri/wry tries to create the main window's webview.
//!
//! Without the runtime present, webview creation fails deep inside wry with
//! a cryptic HRESULT (commonly `0x80070002`, "The system cannot find the
//! file specified") and, because Blesus is built with
//! `#![windows_subsystem = "windows"]`, there's no console to surface that
//! error — the app just silently never shows a window. We probe for the
//! runtime ourselves first so we can tell the user what's wrong and point
//! them at the installer instead of failing invisibly.

use windows::core::HSTRING;
use windows::Win32::Foundation::ERROR_MORE_DATA;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SAM_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

/// Registry subkey (relative to the roots/views probed below) that the
/// Evergreen WebView2 Runtime installer (and per-user installs) register
/// themselves under. `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` is the fixed
/// GUID Microsoft assigns to the WebView2 Runtime client, documented at
/// <https://learn.microsoft.com/microsoft-edge/webview2/concepts/find-existing-webview>.
const CLIENT_KEY_PATH: &str =
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WOW6432_CLIENT_KEY_PATH: &str =
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const VERSION_VALUE_NAME: &str = "pv";

/// Checks for the WebView2 Runtime and, if it's missing, shows a dialog
/// pointing the user at the Evergreen installer download page and exits.
pub fn ensure_present() {
    if webview2_runtime_available() {
        return;
    }
    show_missing_runtime_dialog();
}

/// Reads the `pv` (product version) registry value the WebView2 Runtime
/// installer writes on success. This is the detection method Microsoft
/// itself documents for apps that bundle the WebView2 SDK, and it's
/// reliable regardless of whether the runtime was installed machine-wide,
/// per-user, or as the 32- or 64-bit variant — unlike probing for a
/// `WebView2Loader.dll` file, which Blesus does not ship as a standalone
/// DLL (the loader is statically linked into the executable), so that
/// probe always reported "missing" even when the runtime was installed.
fn webview2_runtime_available() -> bool {
    // Machine-wide install, native registry view for this process's bitness.
    if has_version_value(HKEY_LOCAL_MACHINE, CLIENT_KEY_PATH, KEY_READ) {
        return true;
    }
    // Machine-wide install registered by the 32-bit installer on a 64-bit OS
    // (Evergreen x86 installs write here instead of `CLIENT_KEY_PATH`).
    if has_version_value(
        HKEY_LOCAL_MACHINE,
        WOW6432_CLIENT_KEY_PATH,
        REG_SAM_FLAGS(KEY_READ.0 | KEY_WOW64_32KEY.0),
    ) {
        return true;
    }
    // Explicitly probe both WOW64 views in case this binary and the
    // installed runtime differ in bitness.
    if has_version_value(
        HKEY_LOCAL_MACHINE,
        CLIENT_KEY_PATH,
        REG_SAM_FLAGS(KEY_READ.0 | KEY_WOW64_32KEY.0),
    ) {
        return true;
    }
    if has_version_value(
        HKEY_LOCAL_MACHINE,
        CLIENT_KEY_PATH,
        REG_SAM_FLAGS(KEY_READ.0 | KEY_WOW64_64KEY.0),
    ) {
        return true;
    }
    // Per-user install (no admin rights required to install this variant).
    if has_version_value(HKEY_CURRENT_USER, CLIENT_KEY_PATH, KEY_READ) {
        return true;
    }

    false
}

/// Returns `true` if `root\subkey` exists and has a non-empty `pv` string
/// value, using the given access rights/registry view flags.
fn has_version_value(root: HKEY, subkey: &str, sam: REG_SAM_FLAGS) -> bool {
    // SAFETY: `RegOpenKeyExW`/`RegQueryValueExW`/`RegCloseKey` only read
    // from the registry; all pointers passed are valid for the duration of
    // each call, and the opened key is always closed before returning.
    unsafe {
        let subkey_h = HSTRING::from(subkey);
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(root, &subkey_h, 0, sam, &mut hkey).is_err() {
            return false;
        }

        let value_h = HSTRING::from(VERSION_VALUE_NAME);
        let mut data_size: u32 = 0;
        let query_status =
            RegQueryValueExW(hkey, &value_h, None, None, None, Some(&mut data_size));
        let has_value = query_status.is_ok() || query_status == ERROR_MORE_DATA;

        let _ = RegCloseKey(hkey);

        // `data_size` includes the value's null terminator; a non-empty
        // string needs at least one UTF-16 code unit plus that terminator.
        has_value && data_size > 2
    }
}

fn show_missing_runtime_dialog() {
    log::error!("Microsoft Edge WebView2 Runtime not found; Blesus cannot create its window");

    unsafe {
        let _ = MessageBoxW(
            None,
            &HSTRING::from(
                "Blesus needs the Microsoft Edge WebView2 Runtime, which isn't installed \
                 on this PC.\n\nOpening the download page now — install it, then relaunch \
                 Blesus.",
            ),
            &HSTRING::from("Blesus \u{2014} missing component"),
            MB_ICONERROR | MB_OK,
        );
    }

    let _ = std::process::Command::new("cmd")
        .args([
            "/C",
            "start",
            "",
            "https://developer.microsoft.com/microsoft-edge/webview2/",
        ])
        .spawn();

    std::process::exit(1);
}

/// Shown when the main window's webview fails to actually spin up even
/// though `ensure_present` above found a registered WebView2 Runtime.
///
/// This happens because our (and Tauri's own) pre-flight checks only ask
/// the loader for an available browser *version string*; they don't
/// verify that WebView2 can actually launch its browser process and write
/// to its user data folder. Known causes, gathered from Tauri/WebView2
/// bug trackers, that pass the version check but still fail here:
///   - A partially uninstalled or corrupted Evergreen runtime (registry
///     still has a `pv` value, but the runtime's own files are gone).
///   - A stale `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` environment variable
///     pointing at a path that no longer has the runtime in it.
///   - A cloud-sync client (OneDrive, iCloud Drive, pCloud, ...) or an
///     antivirus's "controlled folder access" locking/blocking file
///     creation under `%LOCALAPPDATA%`, where WebView2 keeps its per-app
///     user data folder (`EBWebView`).
///   - WebView2 registered for a different Windows user account than the
///     one currently running Blesus.
///
/// Because Blesus is built with `#![windows_subsystem = "windows"]`,
/// there's no console for the underlying error to print to, so without
/// this dialog the app either panics invisibly or the window never
/// appears with no indication why. `err` is included so the exact
/// HRESULT/message is visible for support requests.
pub fn report_webview_creation_failure<E: std::fmt::Display>(err: &E) {
    log::error!("failed to create the main webview: {err}");

    unsafe {
        let _ = MessageBoxW(
            None,
            &HSTRING::from(format!(
                "Blesus couldn't start its window component (Microsoft Edge WebView2).\n\n\
                 Error: {err}\n\n\
                 Things to try:\n\
                 \u{2022} Repair the WebView2 Runtime: Settings > Apps > Installed apps > \
                 \"Microsoft Edge WebView2 Runtime\" > Modify > Repair (or download the \
                 installer from https://developer.microsoft.com/microsoft-edge/webview2/ \
                 and run it again).\n\
                 \u{2022} Check whether a WEBVIEW2_BROWSER_EXECUTABLE_FOLDER environment \
                 variable is set to a folder that no longer exists, and remove it.\n\
                 \u{2022} If a cloud sync tool (OneDrive, iCloud Drive, pCloud, etc.) or an \
                 antivirus is syncing/blocking your AppData\\Local folder, pause it and \
                 try again.\n\n\
                 Relaunch Blesus once you've tried one of these."
            )),
            &HSTRING::from("Blesus \u{2014} failed to start"),
            MB_ICONERROR | MB_OK,
        );
    }

    std::process::exit(1);
}

