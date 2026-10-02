//! OS-keychain access for per-workspace session tokens.
//!
//! Backs the cross-domain auth client's storage (see apps/web keychainStorage.ts):
//! the BetterAuth session blob for each connected workspace is stored under a
//! per-workspace account key in the native secret store.
//!
//! Every window of the app (main, compose) keeps its own copy of the session
//! and writes it back as it changes, so one keychain entry can have several
//! writers. Each entry therefore carries a session revision, held here in the
//! process every webview shares. A window reads the value together with its
//! revision, and its writes land only while that revision is current. Signing
//! in again or removing the workspace replaces the session and moves the
//! revision on, so a window still holding the older session cannot write it
//! back (or clear the new one), and is told to read the new one instead.
//!
//! The revisions live in memory only: after a restart every window reads the
//! entry afresh, so there is no older copy left to fence.

use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{command, AppHandle, Emitter};

const SERVICE: &str = "com.owlat.desktop";

/// Emitted to every window after a session is replaced or removed.
pub const SESSION_REPLACED_EVENT: &str = "session-secret-replaced";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// The native secret store, behind a trait so the ledger can be tested
/// without touching the real keychain.
trait SecretBackend {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct Keyring;

impl SecretBackend for Keyring {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        entry(account)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// A session value and the revision it was read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionEntry {
    pub value: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
struct SessionReplaced<'a> {
    account: &'a str,
    revision: u64,
}

/// The current session revision of every entry, and the lock that makes a
/// revision check and the keychain call behind it one step.
#[derive(Default)]
struct SessionLedger {
    revisions: Mutex<HashMap<String, u64>>,
}

impl SessionLedger {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        // A panic while holding the lock leaves the map itself intact.
        self.revisions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn read(&self, backend: &dyn SecretBackend, account: &str) -> Result<SessionEntry, String> {
        let revisions = self.lock();
        let value = backend.get(account)?;
        Ok(SessionEntry {
            value,
            revision: revisions.get(account).copied().unwrap_or(0),
        })
    }

    /// Write `value` if `revision` is still the entry's revision. Returns
    /// false, writing nothing, when the session has been replaced since.
    fn write(
        &self,
        backend: &dyn SecretBackend,
        account: &str,
        value: &str,
        revision: u64,
    ) -> Result<bool, String> {
        let revisions = self.lock();
        if revisions.get(account).copied().unwrap_or(0) != revision {
            return Ok(false);
        }
        backend.set(account, value)?;
        Ok(true)
    }

    /// Replace the session (`None` removes the entry) and move the revision on.
    /// The revision stays where it was when the keychain call fails, because
    /// the entry still holds the session the current revision describes.
    fn replace(
        &self,
        backend: &dyn SecretBackend,
        account: &str,
        value: Option<&str>,
    ) -> Result<u64, String> {
        let mut revisions = self.lock();
        match value {
            Some(value) => backend.set(account, value)?,
            None => backend.delete(account)?,
        }
        let revision = revisions.get(account).copied().unwrap_or(0) + 1;
        revisions.insert(account.to_owned(), revision);
        Ok(revision)
    }
}

fn ledger() -> &'static SessionLedger {
    static LEDGER: OnceLock<SessionLedger> = OnceLock::new();
    LEDGER.get_or_init(SessionLedger::default)
}

/// Read a secret. Returns `None` when no entry exists (not an error).
#[command]
pub fn secret_get(account: String) -> Result<Option<String>, String> {
    Keyring.get(&account)
}

/// Read a workspace session together with its revision.
#[command]
pub fn session_secret_read(account: String) -> Result<SessionEntry, String> {
    ledger().read(&Keyring, &account)
}

/// Write back a window's copy of a session. Returns false, writing nothing,
/// when the session was replaced after the window read `revision`.
#[command]
pub fn session_secret_write(account: String, value: String, revision: u64) -> Result<bool, String> {
    ledger().write(&Keyring, &account, &value, revision)
}

/// Store a new session for a workspace (`value`), or remove it (`None`), and
/// tell every window so the ones holding the older session read the new one.
#[command]
pub fn session_secret_replace(
    app: AppHandle,
    account: String,
    value: Option<String>,
) -> Result<u64, String> {
    let revision = ledger().replace(&Keyring, &account, value.as_deref())?;
    let _ = app.emit(
        SESSION_REPLACED_EVENT,
        SessionReplaced {
            account: &account,
            revision,
        },
    );
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::{SecretBackend, SessionEntry, SessionLedger};
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Memory {
        entries: RefCell<HashMap<String, String>>,
        fail: RefCell<bool>,
    }

    impl SecretBackend for Memory {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.entries.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            if *self.fail.borrow() {
                return Err("keychain locked".into());
            }
            self.entries
                .borrow_mut()
                .insert(account.to_owned(), value.to_owned());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            if *self.fail.borrow() {
                return Err("keychain locked".into());
            }
            self.entries.borrow_mut().remove(account);
            Ok(())
        }
    }

    const A: &str = "owlat-ws:a";

    #[test]
    fn a_window_writes_while_its_revision_is_current() {
        let (ledger, keychain) = (SessionLedger::default(), Memory::default());
        let read = ledger.read(&keychain, A).unwrap();
        assert_eq!(
            read,
            SessionEntry {
                value: None,
                revision: 0
            }
        );
        assert!(ledger
            .write(&keychain, A, "refreshed", read.revision)
            .unwrap());
        assert_eq!(keychain.get(A).unwrap().as_deref(), Some("refreshed"));
    }

    #[test]
    fn a_window_holding_the_older_session_cannot_write_it_back() {
        let (ledger, keychain) = (SessionLedger::default(), Memory::default());
        keychain.set(A, "old").unwrap();
        let compose = ledger.read(&keychain, A).unwrap();

        let revision = ledger.replace(&keychain, A, Some("new")).unwrap();
        assert_eq!(revision, 1);

        assert!(!ledger.write(&keychain, A, "old", compose.revision).unwrap());
        assert!(!ledger.write(&keychain, A, "{}", compose.revision).unwrap());
        assert_eq!(keychain.get(A).unwrap().as_deref(), Some("new"));

        let reread = ledger.read(&keychain, A).unwrap();
        assert_eq!(reread.value.as_deref(), Some("new"));
        assert!(ledger
            .write(&keychain, A, "new, refreshed", reread.revision)
            .unwrap());
    }

    #[test]
    fn removing_a_session_fences_writers_that_would_recreate_it() {
        let (ledger, keychain) = (SessionLedger::default(), Memory::default());
        keychain.set(A, "old").unwrap();
        let stale = ledger.read(&keychain, A).unwrap();
        ledger.replace(&keychain, A, None).unwrap();
        assert!(!ledger.write(&keychain, A, "old", stale.revision).unwrap());
        assert_eq!(keychain.get(A).unwrap(), None);
    }

    #[test]
    fn a_failed_replace_keeps_the_revision() {
        let (ledger, keychain) = (SessionLedger::default(), Memory::default());
        keychain.set(A, "old").unwrap();
        let current = ledger.read(&keychain, A).unwrap();
        *keychain.fail.borrow_mut() = true;
        assert!(ledger.replace(&keychain, A, Some("new")).is_err());
        *keychain.fail.borrow_mut() = false;
        assert!(ledger
            .write(&keychain, A, "old, refreshed", current.revision)
            .unwrap());
    }

    #[test]
    fn revisions_are_per_entry() {
        let (ledger, keychain) = (SessionLedger::default(), Memory::default());
        let b = ledger.read(&keychain, "owlat-ws:b").unwrap();
        ledger.replace(&keychain, A, Some("new")).unwrap();
        assert!(ledger
            .write(&keychain, "owlat-ws:b", "b", b.revision)
            .unwrap());
    }
}
