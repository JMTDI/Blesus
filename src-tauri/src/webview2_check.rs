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

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_MORE_DATA;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SAM_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

// `GetAvailableCoreWebView2BrowserVersionString` is the API Microsoft
// documents for probing the installed WebView2 Runtime before creating an
// environment/webview:
// <https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/webview2-idl#getavailablecorewebview2browserversionstring>.
// It is implemented by `WebView2LoaderStatic.lib`/`WebView2Loader.dll`, the
// exact same loader that wry statically links into Blesus to create the
// webview itself, so a successful result here means wry's own runtime
// resolution will succeed too — unlike our registry probing below, which
// only checks that an install was *recorded*, not that its files are still
// present and loadable (e.g. after a partial uninstall or a corrupted
// install that leaves stale registry keys behind).
#[cfg_attr(
    target_env = "msvc",
    link(name = "WebView2LoaderStatic", kind = "static")
)]
#[cfg_attr(not(target_env = "msvc"), link(name = "WebView2Loader.dll"))]
extern "system" {
    fn GetAvailableCoreWebView2BrowserVersionString(
        browser_executable_folder: PCWSTR,
        version_info: *mut PWSTR,
    ) -> windows::core::HRESULT;
}

/// Asks the WebView2 loader itself (the same static library wry links in to
/// create the webview) whether it can find a usable WebView2 Runtime.
fn loader_reports_runtime_available() -> bool {
    // SAFETY: `version_info` is an out-parameter the loader fills in with a
    // pointer it allocates via `CoTaskMemAlloc`; per the documented contract
    // we free it with `CoTaskMemFree` once we're done reading it. Passing a
    // null `browser_executable_folder` tells the loader to look up the
    // installed Evergreen/fixed-version runtime the normal way.
    unsafe {
        let mut version_info = PWSTR::null();
        let hr = GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version_info);

        if hr.is_err() || version_info.is_null() {
            return false;
        }

        let has_version = !version_info
            .to_string()
            .map(|version| version.is_empty())
            .unwrap_or(true);

        CoTaskMemFree(Some(version_info.as_ptr() as *const _));

        has_version
    }
}

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

/// Determines whether wry will be able to create a webview: first via the
/// authoritative `GetAvailableCoreWebView2BrowserVersionString` loader call
/// (see above), then falling back to reading the `pv` (product version)
/// registry value the WebView2 Runtime installer writes on success. The
/// registry probe is reliable regardless of whether the runtime was
/// installed machine-wide, per-user, or as the 32- or 64-bit variant —
/// unlike probing for a `WebView2Loader.dll` file, which Blesus does not
/// ship as a standalone DLL (the loader is statically linked into the
/// executable), so that probe always reported "missing" even when the
/// runtime was installed. It can, however, report a stale "installed" state
/// after a partial uninstall or a corrupted install, which is why the
/// loader call above takes precedence.
fn webview2_runtime_available() -> bool {
    // Ask the loader first: this is the authoritative check, since it's the
    // exact same lookup wry performs when it later tries to create the
    // webview. If this says yes, webview creation will not fail with
    // "WebView2 Runtime not found".
    if loader_reports_runtime_available() {
        return true;
    }

    // The loader call above should already cover every case below, but keep
    // the registry probes as a fallback in case the loader lookup itself
    // fails for an unrelated reason (e.g. it's more conservative about
    // partially-registered installs than we need to be here).
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
