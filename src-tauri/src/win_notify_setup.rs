// Portable-app fix for WinRT toast notifications.
//
// Toast notifications dispatched via tauri-plugin-notification go through
// `ToastNotificationManager::CreateToastNotifier(aumid)`. Windows refuses to
// display a toast unless the AUMID is registered — i.e. there's a Start Menu
// shortcut whose `System.AppUserModel.ID` property matches. Installer-based
// builds get this for free; portable EXEs don't, and the toasts are silently
// dropped.
//
// We solve it the way Microsoft documents in
// learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid:
// at process start we (a) bind the running process to our AUMID and (b)
// idempotently write a Start Menu shortcut for that AUMID. After this, the
// notification plugin works without any other change. Cost is ~10ms per
// launch and a single 3 KB .lnk under the user's Start Menu\Programs.

#[cfg(not(windows))]
pub fn ensure_aumid_shortcut(_aumid: &str, _app_name: &str) {}

#[cfg(windows)]
pub fn ensure_aumid_shortcut(aumid: &str, app_name: &str) {
    if let Err(err) = ensure_aumid_shortcut_inner(aumid, app_name) {
        log::warn!("AUMID shortcut setup failed: {err}");
    } else {
        log::info!("AUMID shortcut ensured for '{aumid}'");
    }
}

#[cfg(windows)]
fn ensure_aumid_shortcut_inner(aumid: &str, app_name: &str) -> Result<(), String> {
    use std::path::PathBuf;
    use windows::core::{Interface, HSTRING, PROPVARIANT};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };

    unsafe {
        // (a) Tell Windows that *this* process belongs to <aumid>. The
        // notification plugin uses CreateToastNotifier under the hood, which
        // looks up the AUMID set by this call. Failure here is non-fatal —
        // some systems set it via the bundle ID derived from the manifest.
        let aumid_h = HSTRING::from(aumid);
        if let Err(err) = SetCurrentProcessExplicitAppUserModelID(&aumid_h) {
            log::warn!("SetCurrentProcessExplicitAppUserModelID: {err}");
        }

        // (b) Create / overwrite the Start Menu shortcut with the AUMID
        // property. CoInitializeEx is safe to call repeatedly — it returns
        // S_FALSE on subsequent calls within an already-initialised apartment.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let appdata = std::env::var("APPDATA").map_err(|e| format!("APPDATA: {e}"))?;
        let lnk_dir: PathBuf = PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        std::fs::create_dir_all(&lnk_dir)
            .map_err(|e| format!("create Programs dir: {e}"))?;

        // One-shot cleanup: earlier builds passed the pre-rename app name
        // ("Cursus") here, which left a stray "Cursus.lnk" Start Menu
        // shortcut alongside the installer's real "Blesus.lnk" shortcut —
        // two icons for one app. Remove it now that we always pass "Blesus".
        if app_name != "Cursus" {
            let stale_lnk = lnk_dir.join("Cursus.lnk");
            let _ = std::fs::remove_file(stale_lnk);
        }

        let lnk_path = lnk_dir.join(format!("{app_name}.lnk"));

        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        let exe_h = HSTRING::from(exe.as_os_str());

        let link: IShellLinkW =
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance(ShellLink): {e}"))?;

        link.SetPath(&exe_h).map_err(|e| format!("SetPath: {e}"))?;
        if let Some(parent) = exe.parent() {
            let cwd_h = HSTRING::from(parent.as_os_str());
            let _ = link.SetWorkingDirectory(&cwd_h);
        }
        let _ = link.SetIconLocation(&exe_h, 0);
        let _ = link.SetDescription(&HSTRING::from(app_name));

        // Stash the AUMID into the shortcut's IPropertyStore. The PROPVARIANT
        // ends up VT_BSTR (windows-rs 0.58 has no helper for VT_LPWSTR), but
        // PKEY_AppUserModel_ID is documented to accept either form on
        // SetValue — Windows internalises both into the same storage.
        let store: IPropertyStore = link
            .cast()
            .map_err(|e| format!("cast IPropertyStore: {e}"))?;
        let pv = PROPVARIANT::from(aumid);
        store
            .SetValue(&PKEY_AppUserModel_ID, &pv)
            .map_err(|e| format!("SetValue AUMID: {e}"))?;
        store.Commit().map_err(|e| format!("Commit: {e}"))?;

        let persist: IPersistFile = link
            .cast()
            .map_err(|e| format!("cast IPersistFile: {e}"))?;
        let lnk_h = HSTRING::from(lnk_path.as_os_str());
        persist
            .Save(&lnk_h, true)
            .map_err(|e| format!("PersistFile.Save: {e}"))?;
    }
    Ok(())
}
