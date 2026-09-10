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

use windows::core::{HSTRING, PCSTR};
use windows::Win32::Foundation::FreeLibrary;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

/// Null-terminated ASCII name of the WebView2Loader.dll export we probe.
const GET_AVAILABLE_VERSION_PROC_NAME: &[u8] = b"GetAvailableCoreWebView2BrowserVersionString\0";

/// Checks for the WebView2 Runtime and, if it's missing, shows a dialog
/// pointing the user at the Evergreen installer download page and exits.
pub fn ensure_present() {
    if webview2_runtime_available() {
        return;
    }
    show_missing_runtime_dialog();
}

/// Calls WebView2Loader.dll's `GetAvailableCoreWebView2BrowserVersionString`,
/// the same probe the WebView2 SDK itself uses to detect an installed
/// Evergreen runtime. Returns `false` if the loader or the runtime it
/// reports on is missing.
fn webview2_runtime_available() -> bool {
    type GetAvailableVersionFn = unsafe extern "system" fn(*const u16, *mut *mut u16) -> i32;

    // SAFETY: WebView2Loader.dll ships next to Blesus.exe (tauri-build
    // copies it into every Windows bundle); loading it and calling its
    // documented, side-effect-free version probe is safe. The module and
    // any returned string are released before returning.
    unsafe {
        let Ok(module) = LoadLibraryW(&HSTRING::from("WebView2Loader.dll")) else {
            return false;
        };

        let available =
            match GetProcAddress(module, PCSTR(GET_AVAILABLE_VERSION_PROC_NAME.as_ptr())) {
                Some(proc) => {
                    let get_version: GetAvailableVersionFn = std::mem::transmute(proc);
                    let mut version_ptr: *mut u16 = std::ptr::null_mut();
                    let hr = get_version(std::ptr::null(), &mut version_ptr);
                    let ok = hr >= 0 && !version_ptr.is_null();
                    if !version_ptr.is_null() {
                        CoTaskMemFree(Some(version_ptr as *const _));
                    }
                    ok
                }
                None => false,
            };

        let _ = FreeLibrary(module);
        available
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
