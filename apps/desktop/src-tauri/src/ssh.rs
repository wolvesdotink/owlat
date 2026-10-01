//! SSH transport for the desktop "set up a new server" flow.
//!
//! The desktop app provisions a bare VPS by driving the existing installer over
//! SSH and streaming its output to an animated timeline. This module exposes the
//! minimal command surface the setup UI needs, holding the live `ssh2::Session`
//! in app state keyed by an opaque `sessionId` so credentials cross the IPC
//! boundary exactly once (at `ssh_authenticate`), never on every exec.
//!
//! Host-key handling is trust-on-first-use: `ssh_connect` performs the TCP +
//! SSH handshake (which sends NO credentials) and returns the server's SHA256
//! fingerprint plus whether it matches `known_hosts`. The UI shows it, the user
//! accepts (`ssh_accept_host_key` persists it), and only then does
//! `ssh_authenticate` send the password / key — so a MITM cannot harvest creds.
//!
//! ssh2 is blocking, so every network operation runs on a blocking thread
//! (`spawn_blocking`); long-running execs stream stdout/stderr line-by-line back
//! through a Tauri `Channel`.
//!
//! The local-source install paths (uploading this machine's checkout, building
//! and pushing images from it) live in [`dev`], which only exists in builds with
//! the `dev-provisioning` feature. Release builds contain just the commands here.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ssh2::{HashType, Session};
use tauri::ipc::Channel;
use tauri::{command, AppHandle, Manager, State};

#[cfg(feature = "dev-provisioning")]
pub mod dev;

/// A live, authenticated-or-not SSH connection held across commands.
pub struct SshConn {
    /// Wrapped in a Mutex so channel use is serialized (libssh2 is not safe for
    /// concurrent channels on one session; the wizard runs one step at a time).
    session: Mutex<Session>,
    host: String,
    port: u16,
    /// SHA256 fingerprint observed at handshake; persisted on host-key accept.
    fingerprint: String,
}

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, Arc<SshConn>>>,
}

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    session_id: String,
    /// OpenSSH-style `SHA256:<base64>` host-key fingerprint.
    fingerprint: String,
    host_key_type: String,
    /// `new` (unseen), `match` (== stored), or `mismatch` (changed — danger).
    known_host_status: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthInput {
    Password {
        password: String,
    },
    /// Either pasted key material (`private_key`) or a path to a key file on
    /// this machine (`private_key_path`, `~` expanded) — exactly one is used,
    /// content taking precedence.
    #[serde(rename_all = "camelCase")]
    Key {
        private_key: Option<String>,
        private_key_path: Option<String>,
        passphrase: Option<String>,
    },
}

/// Expand a leading `~/` to the user's home directory (macOS/Linux `HOME`,
/// Windows `USERPROFILE`) so key paths like `~/.ssh/id_ed25519` just work.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// Streamed line of remote output (or the final exit code).
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exit { code: i32 },
}

#[derive(Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

// ---- helpers ---------------------------------------------------------------

fn get_conn(state: &State<'_, SshState>, id: &str) -> Result<Arc<SshConn>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "ssh state poisoned".to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "No such SSH session (it may have disconnected).".to_string())
}

/// Standard base64 (no padding) — only used to format the host-key fingerprint,
/// so a tiny inline encoder beats pulling another crate.
fn base64_nopad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ssh-known-hosts.json"))
}

fn load_known_hosts(path: &PathBuf) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_known_hosts(path: &PathBuf, map: &HashMap<String, String>) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// Append decoded bytes to a carry buffer and emit each completed line.
fn emit_lines(bytes: &[u8], carry: &mut String, kind: StreamKind, ch: &Channel<ExecEvent>) {
    carry.push_str(&String::from_utf8_lossy(bytes));
    while let Some(pos) = carry.find('\n') {
        let line = carry[..pos].trim_end_matches('\r').to_string();
        carry.drain(..=pos);
        let event = match kind {
            StreamKind::Stdout => ExecEvent::Stdout { line },
            StreamKind::Stderr => ExecEvent::Stderr { line },
        };
        let _ = ch.send(event);
    }
}

// ---- commands --------------------------------------------------------------

/// TCP-connect + SSH-handshake only (NO credentials sent). Returns the host-key
/// fingerprint and whether it matches `known_hosts`, and stores the session.
#[command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    host: String,
    port: Option<u16>,
) -> Result<ConnectInfo, String> {
    let port = port.unwrap_or(22);
    let host_for_blocking = host.clone();

    let (session, fingerprint, key_type) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Session, String, String), String> {
            let addr = (host_for_blocking.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| format!("Could not resolve {host_for_blocking}: {e}"))?
                .next()
                .ok_or_else(|| format!("Could not resolve {host_for_blocking}"))?;
            let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(20))
                .map_err(|e| format!("Could not connect to {host_for_blocking}:{port}: {e}"))?;

            let mut sess = Session::new().map_err(|e| e.to_string())?;
            sess.set_timeout(30_000);
            sess.set_tcp_stream(tcp);
            sess.handshake()
                .map_err(|e| format!("SSH handshake failed: {e}"))?;

            let digest = sess
                .host_key_hash(HashType::Sha256)
                .ok_or("Server presented no host key")?;
            let fingerprint = format!("SHA256:{}", base64_nopad(digest));
            let key_type = sess
                .host_key()
                .map(|(_, t)| format!("{t:?}"))
                .unwrap_or_else(|| "unknown".to_string());
            Ok((sess, fingerprint, key_type))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    let known = load_known_hosts(&known_hosts_path(&app)?);
    let status = match known.get(&format!("{host}:{port}")) {
        Some(fp) if *fp == fingerprint => "match",
        Some(_) => "mismatch",
        None => "new",
    };

    let session_id = format!("ssh-{}", SESSION_COUNTER.fetch_add(1, Ordering::Relaxed));
    let conn = Arc::new(SshConn {
        session: Mutex::new(session),
        host,
        port,
        fingerprint: fingerprint.clone(),
    });
    state
        .sessions
        .lock()
        .map_err(|_| "ssh state poisoned".to_string())?
        .insert(session_id.clone(), conn);

    Ok(ConnectInfo {
        session_id,
        fingerprint,
        host_key_type: key_type,
        known_host_status: status.to_string(),
    })
}

/// Persist the session's host key to `known_hosts` (user accepted the fingerprint).
///
/// A *changed* key (we already trusted a different one for this host:port) is the
/// possible-MITM case: never silently overwrite it. The caller must pass
/// `accept_changed = true` — set only after an explicit, scarier confirmation in
/// the UI — to replace a previously trusted key. A brand-new key (trust on first
/// use) is accepted as before.
#[command]
pub fn ssh_accept_host_key(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    accept_changed: Option<bool>,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let path = known_hosts_path(&app)?;
    let mut map = load_known_hosts(&path);
    let key = format!("{}:{}", conn.host, conn.port);
    if let Some(existing) = map.get(&key) {
        if *existing != conn.fingerprint && accept_changed != Some(true) {
            return Err(
                "This server's host key has CHANGED since you last connected. \
                 Confirm the change explicitly before continuing."
                    .to_string(),
            );
        }
    }
    map.insert(key, conn.fingerprint.clone());
    save_known_hosts(&path, &map)
}

/// Authenticate the stored session with a password or private key.
#[command]
pub async fn ssh_authenticate(
    state: State<'_, SshState>,
    session_id: String,
    username: String,
    auth: AuthInput,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        match auth {
            AuthInput::Password { password } => sess
                .userauth_password(&username, &password)
                .map_err(|e| format!("Authentication failed: {e}"))?,
            AuthInput::Key {
                private_key,
                private_key_path,
                passphrase,
            } => match (private_key, private_key_path) {
                (Some(key), _) => sess
                    .userauth_pubkey_memory(&username, None, &key, passphrase.as_deref())
                    .map_err(|e| format!("Key authentication failed: {e}"))?,
                (None, Some(path)) => {
                    let path = expand_tilde(&path);
                    if !path.is_file() {
                        return Err(format!("No key file at {}.", path.display()));
                    }
                    sess.userauth_pubkey_file(&username, None, &path, passphrase.as_deref())
                        .map_err(|e| format!("Key authentication failed: {e}"))?
                }
                (None, None) => return Err("Provide a private key or a key file path.".to_string()),
            },
        }
        if !sess.authenticated() {
            return Err("Authentication failed.".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run a command, streaming stdout/stderr line-by-line, returning the exit code.
#[command]
pub async fn ssh_exec_stream(
    state: State<'_, SshState>,
    session_id: String,
    command: String,
    on_event: Channel<ExecEvent>,
) -> Result<i32, String> {
    let conn = get_conn(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        sess.set_blocking(true);
        let mut chan = sess.channel_session().map_err(|e| e.to_string())?;
        chan.exec(&command).map_err(|e| e.to_string())?;

        // Non-blocking so stdout and stderr can be interleaved live.
        sess.set_blocking(false);
        let mut out_carry = String::new();
        let mut err_carry = String::new();
        let mut buf = [0u8; 8192];

        loop {
            let mut progressed = false;

            // stderr — scoped so its immutable borrow of `chan` ends before the
            // mutable stdout read below.
            {
                let mut es = chan.stderr();
                match es.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        progressed = true;
                        emit_lines(&buf[..n], &mut err_carry, StreamKind::Stderr, &on_event);
                    }
                    Err(ref e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e.to_string()),
                }
            }

            // stdout
            match chan.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    progressed = true;
                    emit_lines(&buf[..n], &mut out_carry, StreamKind::Stdout, &on_event);
                }
                Err(ref e) if e.kind() == ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.to_string()),
            }

            if chan.eof() && !progressed {
                break;
            }
            if !progressed {
                std::thread::sleep(Duration::from_millis(40));
            }
        }

        // Flush any trailing partial line.
        if !out_carry.is_empty() {
            let _ = on_event.send(ExecEvent::Stdout { line: out_carry });
        }
        if !err_carry.is_empty() {
            let _ = on_event.send(ExecEvent::Stderr { line: err_carry });
        }

        sess.set_blocking(true);
        let _ = chan.wait_close();
        let code = chan.exit_status().unwrap_or(-1);
        let _ = on_event.send(ExecEvent::Exit { code });
        Ok(code)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upload a small file to the server (used for the generated setup config).
/// Content is written via the remote shell's stdin (binary-safe), `umask 077`.
#[command]
pub async fn ssh_write_file(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    content: String,
    mode: Option<String>,
) -> Result<(), String> {
    if path.contains('\'') {
        return Err("Invalid remote path.".to_string());
    }
    let mode = mode.unwrap_or_else(|| "600".to_string());
    if mode.is_empty() || !mode.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid file mode.".to_string());
    }
    let conn = get_conn(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        sess.set_blocking(true);
        let mut chan = sess.channel_session().map_err(|e| e.to_string())?;
        let cmd = format!("umask 077; cat > '{path}' && chmod {mode} '{path}'");
        chan.exec(&cmd).map_err(|e| e.to_string())?;
        chan.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        // Full close handshake: signal our EOF, wait for the remote's, then
        // close. wait_close before the remote EOF arrives is a libssh2 error
        // (-34); small writes only won the race.
        chan.send_eof().map_err(|e| e.to_string())?;
        chan.wait_eof().map_err(|e| e.to_string())?;
        chan.close().map_err(|e| e.to_string())?;
        chan.wait_close().map_err(|e| e.to_string())?;
        match chan.exit_status() {
            Ok(0) => Ok(()),
            Ok(code) => Err(format!("Remote write failed (exit {code}).")),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop a session (closes the connection).
#[command]
pub fn ssh_disconnect(state: State<'_, SshState>, session_id: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "ssh state poisoned".to_string())?
        .remove(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{base64_nopad, expand_tilde};

    #[test]
    fn expand_tilde_resolves_home_and_leaves_absolute_paths_alone() {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap();
        assert_eq!(
            expand_tilde("~/.ssh/id_ed25519"),
            std::path::PathBuf::from(&home).join(".ssh/id_ed25519")
        );
        assert_eq!(
            expand_tilde("/etc/ssh/key"),
            std::path::PathBuf::from("/etc/ssh/key")
        );
        // A bare `~user` form is not expanded — passed through untouched.
        assert_eq!(
            expand_tilde("~root/key"),
            std::path::PathBuf::from("~root/key")
        );
    }

    #[test]
    fn base64_matches_rfc4648_vectors_without_padding() {
        // RFC 4648 test vectors, padding stripped (OpenSSH fingerprint style).
        assert_eq!(base64_nopad(b""), "");
        assert_eq!(base64_nopad(b"f"), "Zg");
        assert_eq!(base64_nopad(b"fo"), "Zm8");
        assert_eq!(base64_nopad(b"foo"), "Zm9v");
        assert_eq!(base64_nopad(b"foob"), "Zm9vYg");
        assert_eq!(base64_nopad(b"fooba"), "Zm9vYmE");
        assert_eq!(base64_nopad(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_encodes_a_32_byte_digest_to_43_chars() {
        // A SHA256 host-key digest is 32 bytes → 43 base64 chars (no padding),
        // which is exactly what an OpenSSH `SHA256:` fingerprint shows.
        let digest = [0u8; 32];
        assert_eq!(base64_nopad(&digest).len(), 43);
    }
}
