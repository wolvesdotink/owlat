//! OS-keychain access for per-workspace session tokens.
//!
//! Backs the cross-domain auth client's storage (see apps/web keychainStorage.ts):
//! the BetterAuth session blob for each connected workspace is stored under a
//! per-workspace account key in the native secret store.

use keyring::{Entry, Error as KeyringError};
use tauri::command;

const SERVICE: &str = "com.owlat.desktop";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// Store (or overwrite) a secret for the given account key.
#[command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    entry(&account)?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

/// Read a secret. Returns `None` when no entry exists (not an error).
#[command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a secret. Missing entries are treated as success (idempotent).
#[command]
pub fn secret_delete(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
