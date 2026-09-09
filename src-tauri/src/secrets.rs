use crate::error::{Error, Result};

const SERVICE: &str = "blesus";
/// Pre-rename service name. We still read from it on `load` and migrate
/// the value over to the new service the first time it's needed, so users
/// upgrading from a "cursus"-era build don't lose their stored secrets.
const LEGACY_SERVICE: &str = "cursus";
/// Pre-rename service name from the "flow-mail"-era build, one rename
/// further back. Same migrate-on-read treatment.
const LEGACY_SERVICE_2: &str = "flow-mail";

pub fn save(key: &str, value: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, key)
        .map_err(|e| Error::Config(format!("keyring new: {e}")))?;
    entry
        .set_password(value)
        .map_err(|e| Error::Config(format!("keyring set: {e}")))?;
    // Best-effort cleanup of any value left in the legacy services so the
    // password isn't stored multiple times.
    for legacy_service in [LEGACY_SERVICE, LEGACY_SERVICE_2] {
        if let Ok(legacy) = keyring::Entry::new(legacy_service, key) {
            let _ = legacy.delete_credential();
        }
    }
    Ok(())
}

pub fn load(key: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(SERVICE, key)
        .map_err(|e| Error::Config(format!("keyring new: {e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => load_legacy_and_migrate(key),
        Err(e) => Err(Error::Config(format!("keyring get: {e}"))),
    }
}

fn load_legacy_and_migrate(key: &str) -> Result<Option<String>> {
    for legacy_service in [LEGACY_SERVICE, LEGACY_SERVICE_2] {
        let legacy = keyring::Entry::new(legacy_service, key)
            .map_err(|e| Error::Config(format!("keyring new (legacy): {e}")))?;
        let value = match legacy.get_password() {
            Ok(v) => v,
            Err(keyring::Error::NoEntry) => continue,
            Err(e) => return Err(Error::Config(format!("keyring get (legacy): {e}"))),
        };
        // Promote into the new service. If either side fails, return the value
        // anyway — losing the secret would be worse than a dangling legacy entry.
        if let Ok(new_entry) = keyring::Entry::new(SERVICE, key) {
            let _ = new_entry.set_password(&value);
        }
        let _ = legacy.delete_credential();
        return Ok(Some(value));
    }
    Ok(None)
}

pub fn delete(key: &str) -> Result<()> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, key) {
        match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(Error::Config(format!("keyring delete: {e}"))),
        }
    }
    // Also clean the legacy services so old credentials don't linger.
    for legacy_service in [LEGACY_SERVICE, LEGACY_SERVICE_2] {
        if let Ok(legacy) = keyring::Entry::new(legacy_service, key) {
            let _ = legacy.delete_credential();
        }
    }
    Ok(())
}
