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
//! A key file is read only if the user chose it in the native picker
//! ([`ssh_pick_key_file`]), never from a path the webview names: script running
//! in the webview must not be able to sign in to the user's servers with
//! `~/.ssh/id_ed25519` (the same rule `files.rs` applies to uploads).
//!
//! ssh2 is blocking, so every network operation runs on a blocking thread
//! (`spawn_blocking`); long-running execs stream stdout/stderr line-by-line back
//! through a Tauri `Channel`.
//!
//! The local-source install paths (uploading this machine's checkout, building
//! and pushing images from it) live in [`dev`], which only exists in builds with
//! the `dev-provisioning` feature. Release builds contain just the commands here.
//!
//! Cancellation: an operation holds the session mutex for as long as it runs,
//! so stopping it must not need that mutex. Each session carries a [`Cancel`]
//! that operations poll through an [`OpToken`]. `ssh_cancel` stops whatever is
//! running and keeps the session usable (the wizard then removes the uploaded
//! setup config over it); `ssh_disconnect` also shuts the TCP socket down, so a
//! blocking libssh2 call returns at once instead of after its timeout. Neither
//! kills a command that is already running ON THE SERVER: closing the channel
//! makes sshd close that command's pipes, so it fails on its next write, but a
//! process it detached from (a `docker run` container) can finish on its own.
//! The installer is idempotent, so a later run picks up from there.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    /// A second handle on the session's TCP socket, outside the mutex, so a
    /// disconnect can shut the socket down under a running operation.
    socket: TcpStream,
    /// Stops this session's running operations without taking the mutex.
    cancel: Arc<Cancel>,
    host: String,
    port: u16,
    /// SHA256 fingerprint observed at handshake; persisted on host-key accept.
    fingerprint: String,
}

impl SshConn {
    /// Start an operation: its token reports cancellation by a later
    /// `ssh_cancel` or `ssh_disconnect`. Refused once the session is closed.
    fn begin(&self) -> Result<OpToken, String> {
        if self.cancel.closed.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        Ok(self.cancel.token())
    }

    /// Stop everything running on the session and close its socket.
    fn close(&self) {
        self.cancel.closed.store(true, Ordering::SeqCst);
        self.cancel.cancel_running();
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// Cancellation state shared by a session and its running operations.
#[derive(Default)]
pub(crate) struct Cancel {
    /// Bumped by every cancel: an operation that began under an older value
    /// has been cancelled. Later operations are not affected.
    epoch: AtomicU64,
    /// Set by `ssh_disconnect`; nothing runs on the session after that.
    closed: AtomicBool,
}

impl Cancel {
    /// A token for an operation starting now.
    fn token(self: &Arc<Self>) -> OpToken {
        OpToken {
            cancel: self.clone(),
            epoch: self.epoch.load(Ordering::SeqCst),
        }
    }

    /// Cancel every operation that is running now.
    fn cancel_running(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
}

/// What one operation polls to learn it has been cancelled.
#[derive(Clone)]
pub(crate) struct OpToken {
    cancel: Arc<Cancel>,
    epoch: u64,
}

impl OpToken {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.closed.load(Ordering::SeqCst)
            || self.cancel.epoch.load(Ordering::SeqCst) != self.epoch
    }
}

/// The error a cancelled operation returns.
pub(crate) const CANCELLED: &str = "Cancelled.";

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, Arc<SshConn>>>,
}

impl SshState {
    /// Stop the session's running operations, keeping the session itself.
    fn cancel(&self, id: &str) -> Result<(), String> {
        let conn = self
            .sessions
            .lock()
            .map_err(|_| "ssh state poisoned".to_string())?
            .get(id)
            .cloned();
        if let Some(conn) = conn {
            conn.cancel.cancel_running();
        }
        Ok(())
    }

    /// Forget the session and stop everything running on it. The connection
    /// itself is freed when the last running operation lets go of it.
    fn disconnect(&self, id: &str) -> Result<(), String> {
        let conn = self
            .sessions
            .lock()
            .map_err(|_| "ssh state poisoned".to_string())?
            .remove(id);
        if let Some(conn) = conn {
            conn.close();
        }
        Ok(())
    }
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
    /// Either pasted key material (`private_key`) or the key file the user
    /// chose with [`ssh_pick_key_file`] (`use_picked_key_file`). Pasted
    /// material takes precedence. There is no path field: the webview cannot
    /// name a file for this to read.
    #[serde(rename_all = "camelCase")]
    Key {
        private_key: Option<String>,
        #[serde(default)]
        use_picked_key_file: bool,
        passphrase: Option<String>,
    },
}

/// The key file the user last chose in the native picker. Each pick replaces
/// it; nothing else sets it.
#[derive(Default)]
pub struct PickedKeyFile(Mutex<Option<PathBuf>>);

impl PickedKeyFile {
    fn set(&self, path: Option<PathBuf>) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = path;
        }
    }

    fn get(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

/// Where a key comes from once the request has been checked.
#[derive(Debug, PartialEq, Eq)]
enum KeySource {
    Pasted(String),
    File(PathBuf),
}

fn resolve_key_source(
    private_key: Option<String>,
    use_picked_key_file: bool,
    picked: Option<PathBuf>,
) -> Result<KeySource, String> {
    match (private_key, use_picked_key_file) {
        (Some(key), _) => Ok(KeySource::Pasted(key)),
        (None, true) => picked
            .map(KeySource::File)
            .ok_or_else(|| "Choose your key file first.".to_string()),
        (None, false) => Err("Provide a private key or choose a key file.".to_string()),
    }
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
/// Returns false when an event could not be delivered (the webview that asked
/// for the output is gone).
fn emit_lines(bytes: &[u8], carry: &mut String, kind: StreamKind, ch: &Channel<ExecEvent>) -> bool {
    carry.push_str(&String::from_utf8_lossy(bytes));
    let mut delivered = true;
    while let Some(pos) = carry.find('\n') {
        let line = carry[..pos].trim_end_matches('\r').to_string();
        carry.drain(..=pos);
        let event = match kind {
            StreamKind::Stdout => ExecEvent::Stdout { line },
            StreamKind::Stderr => ExecEvent::Stderr { line },
        };
        delivered &= ch.send(event).is_ok();
    }
    delivered
}

/// Where a remote command's output is read from: the SSH channel, or a fake in
/// the tests.
trait ExecOutput {
    fn read_stdout(&mut self, buf: &mut [u8]) -> std::io::Result<usize>;
    fn read_stderr(&mut self, buf: &mut [u8]) -> std::io::Result<usize>;
    fn at_eof(&self) -> bool;
}

impl ExecOutput for ssh2::Channel {
    fn read_stdout(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.read(buf)
    }
    fn read_stderr(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.stderr().read(buf)
    }
    fn at_eof(&self) -> bool {
        self.eof()
    }
}

/// How long a remote command may run. An install streams build and log output
/// throughout; half an hour of silence means the server stopped answering.
#[derive(Clone, Copy)]
struct ExecLimits {
    idle: Duration,
    overall: Duration,
    poll: Duration,
}

const EXEC_LIMITS: ExecLimits = ExecLimits {
    idle: Duration::from_secs(30 * 60),
    overall: Duration::from_secs(4 * 60 * 60),
    poll: Duration::from_millis(40),
};

/// Why output pumping stopped before the command's EOF.
#[derive(Debug, PartialEq)]
enum ExecStop {
    Cancelled,
    /// The output channel to the webview failed: nobody is listening any more.
    Undeliverable,
    Idle,
    Overall,
    Io(String),
}

impl ExecStop {
    fn message(&self) -> String {
        match self {
            ExecStop::Cancelled | ExecStop::Undeliverable => CANCELLED.to_string(),
            ExecStop::Idle => format!(
                "The server sent no output for {} minutes; the command was stopped.",
                EXEC_LIMITS.idle.as_secs() / 60
            ),
            ExecStop::Overall => format!(
                "The command ran for more than {} hours and was stopped.",
                EXEC_LIMITS.overall.as_secs() / 3600
            ),
            ExecStop::Io(e) => e.clone(),
        }
    }
}

/// Read a running command's stdout and stderr until EOF, handing each chunk to
/// `emit` (which returns false when its output can no longer be delivered).
/// Polls `token` between reads, so it stops promptly on cancellation even when
/// the server never sends EOF, and enforces `limits`.
fn pump_exec_output<O: ExecOutput>(
    out: &mut O,
    token: &OpToken,
    limits: ExecLimits,
    mut emit: impl FnMut(StreamKind, &[u8]) -> bool,
) -> Result<(), ExecStop> {
    let started = Instant::now();
    let mut last_output = started;
    let mut buf = [0u8; 8192];
    loop {
        if token.is_cancelled() {
            return Err(ExecStop::Cancelled);
        }
        let mut progressed = false;
        for kind in [StreamKind::Stderr, StreamKind::Stdout] {
            let read = match kind {
                StreamKind::Stderr => out.read_stderr(&mut buf),
                StreamKind::Stdout => out.read_stdout(&mut buf),
            };
            match read {
                Ok(0) => {}
                Ok(n) => {
                    progressed = true;
                    if !emit(kind, &buf[..n]) {
                        return Err(ExecStop::Undeliverable);
                    }
                }
                Err(ref e) if e.kind() == ErrorKind::WouldBlock => {}
                Err(e) => return Err(ExecStop::Io(e.to_string())),
            }
        }
        let now = Instant::now();
        if progressed {
            last_output = now;
        } else if out.at_eof() {
            return Ok(());
        } else if now.duration_since(last_output) >= limits.idle {
            return Err(ExecStop::Idle);
        }
        if now.duration_since(started) >= limits.overall {
            return Err(ExecStop::Overall);
        }
        if !progressed {
            std::thread::sleep(limits.poll);
        }
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

    let (session, socket, fingerprint, key_type) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Session, TcpStream, String, String), String> {
            let addr = (host_for_blocking.as_str(), port)
                .to_socket_addrs()
                .map_err(|e| format!("Could not resolve {host_for_blocking}: {e}"))?
                .next()
                .ok_or_else(|| format!("Could not resolve {host_for_blocking}"))?;
            let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(20))
                .map_err(|e| format!("Could not connect to {host_for_blocking}:{port}: {e}"))?;

            let socket = tcp.try_clone().map_err(|e| e.to_string())?;
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
            Ok((sess, socket, fingerprint, key_type))
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
        socket,
        cancel: Arc::default(),
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

/// Open the native file picker to choose an SSH private key (starting in
/// `~/.ssh` when it exists) and remember the choice for [`ssh_authenticate`].
/// Returns the path for display, or `None` when the user cancelled. No path
/// parameter exists, so the webview cannot steer it at a file.
#[command]
pub async fn ssh_pick_key_file(
    app: AppHandle,
    picked: State<'_, PickedKeyFile>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let ssh_dir = app
        .path()
        .home_dir()
        .ok()
        .map(|home| home.join(".ssh"))
        .filter(|dir| dir.is_dir());
    let dialog = app.clone();
    let choice = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = dialog.dialog().file();
        if let Some(title) = title {
            builder = builder.set_title(title);
        }
        if let Some(dir) = ssh_dir {
            builder = builder.set_directory(dir);
        }
        builder.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let path = choice.and_then(|file| file.into_path().ok());
    // A cancelled pick keeps the earlier choice: the form still shows it.
    if path.is_none() {
        return Ok(None);
    }
    picked.set(path.clone());
    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

/// Authenticate the stored session with a password or private key.
#[command]
pub async fn ssh_authenticate(
    state: State<'_, SshState>,
    picked: State<'_, PickedKeyFile>,
    session_id: String,
    username: String,
    auth: AuthInput,
) -> Result<(), String> {
    let conn = get_conn(&state, &session_id)?;
    let picked = picked.get();
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
                use_picked_key_file,
                passphrase,
            } => match resolve_key_source(private_key, use_picked_key_file, picked)? {
                KeySource::Pasted(key) => sess
                    .userauth_pubkey_memory(&username, None, &key, passphrase.as_deref())
                    .map_err(|e| format!("Key authentication failed: {e}"))?,
                KeySource::File(path) => {
                    if !path.is_file() {
                        return Err(format!("No key file at {}.", path.display()));
                    }
                    sess.userauth_pubkey_file(&username, None, &path, passphrase.as_deref())
                        .map_err(|e| format!("Key authentication failed: {e}"))?
                }
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
/// Fails with [`CANCELLED`] when the session's operations are cancelled, and
/// when the command outlives [`EXEC_LIMITS`].
#[command]
pub async fn ssh_exec_stream(
    state: State<'_, SshState>,
    session_id: String,
    command: String,
    on_event: Channel<ExecEvent>,
) -> Result<i32, String> {
    let conn = get_conn(&state, &session_id)?;
    let token = conn.begin()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        if token.is_cancelled() {
            return Err(CANCELLED.to_string());
        }
        sess.set_blocking(true);
        let mut chan = sess.channel_session().map_err(|e| e.to_string())?;
        chan.exec(&command).map_err(|e| e.to_string())?;

        // Non-blocking so stdout and stderr can be interleaved live, and so the
        // loop gets to check for cancellation while the server is silent.
        sess.set_blocking(false);
        let mut out_carry = String::new();
        let mut err_carry = String::new();
        let pumped = pump_exec_output(&mut chan, &token, EXEC_LIMITS, |kind, bytes| {
            let carry = match kind {
                StreamKind::Stdout => &mut out_carry,
                StreamKind::Stderr => &mut err_carry,
            };
            emit_lines(bytes, carry, kind, &on_event)
        });
        if let Err(stop) = pumped {
            // Close our end; sshd then closes the command's pipes. Best-effort:
            // after a disconnect the socket is already gone.
            let _ = chan.close();
            sess.set_blocking(true);
            return Err(stop.message());
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
    let token = conn.begin()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        if token.is_cancelled() {
            return Err(CANCELLED.to_string());
        }
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

/// Stop whatever is running on the session (see the module docs for what that
/// means on the server), keeping the session for the commands that follow. A
/// no-op for an unknown session.
#[command]
pub fn ssh_cancel(state: State<'_, SshState>, session_id: String) -> Result<(), String> {
    state.cancel(&session_id)
}

/// Drop a session: stop its running operations and close the connection, even
/// while an operation holds the session.
#[command]
pub fn ssh_disconnect(state: State<'_, SshState>, session_id: String) -> Result<(), String> {
    state.disconnect(&session_id)
}

#[cfg(test)]
mod tests {
    use super::{
        base64_nopad, pump_exec_output, resolve_key_source, AuthInput, Cancel, ExecLimits,
        ExecOutput, ExecStop, KeySource, SshConn, SshState, StreamKind,
    };
    use std::io::{ErrorKind, Read};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    /// A remote command's output as scripted chunks; once they run out it
    /// either reaches EOF or, like a hung server, stays silent forever.
    struct FakeOutput {
        chunks: Vec<&'static [u8]>,
        eof_when_drained: bool,
    }

    impl FakeOutput {
        fn silent_forever() -> Self {
            Self {
                chunks: Vec::new(),
                eof_when_drained: false,
            }
        }
    }

    impl ExecOutput for FakeOutput {
        fn read_stdout(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.chunks.is_empty() {
                return Err(ErrorKind::WouldBlock.into());
            }
            let chunk = self.chunks.remove(0);
            buf[..chunk.len()].copy_from_slice(chunk);
            Ok(chunk.len())
        }
        fn read_stderr(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Err(ErrorKind::WouldBlock.into())
        }
        fn at_eof(&self) -> bool {
            self.eof_when_drained && self.chunks.is_empty()
        }
    }

    /// A server that keeps talking: always another chunk, never EOF.
    struct Chatty;

    impl ExecOutput for Chatty {
        fn read_stdout(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            buf[0] = b'.';
            Ok(1)
        }
        fn read_stderr(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Err(ErrorKind::WouldBlock.into())
        }
        fn at_eof(&self) -> bool {
            false
        }
    }

    const LONG: ExecLimits = ExecLimits {
        idle: Duration::from_secs(3600),
        overall: Duration::from_secs(3600),
        poll: Duration::from_millis(5),
    };

    /// A session as `ssh_connect` stores it, over a loopback socket whose far
    /// end is returned so a test can watch it close. No SSH handshake happens:
    /// cancellation never needs one.
    fn connected(state: &SshState, id: &str) -> (Arc<SshConn>, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (peer, _) = listener.accept().unwrap();
        let conn = Arc::new(SshConn {
            session: Mutex::new(ssh2::Session::new().unwrap()),
            socket,
            cancel: Arc::default(),
            host: "127.0.0.1".to_string(),
            port: 22,
            fingerprint: String::new(),
        });
        state
            .sessions
            .lock()
            .unwrap()
            .insert(id.to_string(), conn.clone());
        (conn, peer)
    }

    #[test]
    fn exec_output_is_pumped_until_eof() {
        let mut out = FakeOutput {
            chunks: vec![b"one\n", b"two\n"],
            eof_when_drained: true,
        };
        let token = Arc::new(Cancel::default()).token();
        let mut seen = Vec::new();
        let pumped = pump_exec_output(&mut out, &token, LONG, |kind, bytes| {
            assert!(matches!(kind, StreamKind::Stdout));
            seen.extend_from_slice(bytes);
            true
        });
        assert_eq!(pumped, Ok(()));
        assert_eq!(seen, b"one\ntwo\n");
    }

    #[test]
    fn disconnect_stops_a_command_that_never_ends_while_it_holds_the_session() {
        let state = Arc::new(SshState::default());
        let (conn, mut peer) = connected(&state, "ssh-busy");
        let token = conn.begin().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = conn.clone();
        std::thread::spawn(move || {
            // What ssh_exec_stream does: hold the session for the whole run.
            let _session = worker.session.lock().unwrap();
            started_tx.send(()).unwrap();
            let mut hung = FakeOutput::silent_forever();
            done_tx
                .send(pump_exec_output(&mut hung, &token, LONG, |_, _| true))
                .unwrap();
        });
        started_rx.recv().unwrap();
        assert!(conn.session.try_lock().is_err(), "the session is busy");

        let asked = Instant::now();
        state.disconnect("ssh-busy").unwrap();
        assert!(
            asked.elapsed() < Duration::from_millis(500),
            "disconnect waited"
        );

        let stopped = done_rx.recv_timeout(Duration::from_secs(5));
        assert_eq!(stopped, Ok(Err(ExecStop::Cancelled)));
        // The session is forgotten, refuses new work, and its socket is shut.
        assert!(state.sessions.lock().unwrap().get("ssh-busy").is_none());
        assert!(conn.begin().is_err());
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(peer.read(&mut [0u8; 8]).unwrap(), 0, "socket still open");
    }

    #[test]
    fn cancel_stops_the_running_command_but_keeps_the_session() {
        let state = SshState::default();
        let (conn, _peer) = connected(&state, "ssh-keep");
        let running = conn.begin().unwrap();
        state.cancel("ssh-keep").unwrap();
        assert!(running.is_cancelled());

        let mut hung = FakeOutput::silent_forever();
        assert_eq!(
            pump_exec_output(&mut hung, &running, LONG, |_, _| true),
            Err(ExecStop::Cancelled)
        );
        // The cleanup that follows runs normally on the same session.
        assert!(state.sessions.lock().unwrap().contains_key("ssh-keep"));
        let next = conn.begin().unwrap();
        assert!(!next.is_cancelled());
        // Unknown sessions are a no-op, not an error.
        assert!(state.cancel("ssh-gone").is_ok());
        assert!(state.disconnect("ssh-gone").is_ok());
    }

    #[test]
    fn a_silent_server_hits_the_idle_deadline() {
        let token = Arc::new(Cancel::default()).token();
        let limits = ExecLimits {
            idle: Duration::from_millis(50),
            ..LONG
        };
        let mut hung = FakeOutput::silent_forever();
        assert_eq!(
            pump_exec_output(&mut hung, &token, limits, |_, _| true),
            Err(ExecStop::Idle)
        );
    }

    #[test]
    fn a_command_that_never_stops_talking_hits_the_overall_deadline() {
        let token = Arc::new(Cancel::default()).token();
        let limits = ExecLimits {
            overall: Duration::from_millis(50),
            ..LONG
        };
        assert_eq!(
            pump_exec_output(&mut Chatty, &token, limits, |_, _| true),
            Err(ExecStop::Overall)
        );
    }

    #[test]
    fn output_nobody_can_receive_stops_the_command() {
        let token = Arc::new(Cancel::default()).token();
        assert_eq!(
            pump_exec_output(&mut Chatty, &token, LONG, |_, _| false),
            Err(ExecStop::Undeliverable)
        );
    }

    #[test]
    fn a_key_file_is_only_the_one_the_user_picked() {
        let picked = std::path::PathBuf::from("/home/u/.ssh/id_ed25519");
        assert_eq!(
            resolve_key_source(None, true, Some(picked.clone())),
            Ok(KeySource::File(picked))
        );
        // Nothing picked: no file is read, whatever the webview asks for.
        assert!(resolve_key_source(None, true, None).is_err());
        assert!(resolve_key_source(None, false, None).is_err());
    }

    #[test]
    fn pasted_key_material_takes_precedence() {
        assert_eq!(
            resolve_key_source(
                Some("KEY".into()),
                true,
                Some(std::path::PathBuf::from("/k"))
            ),
            Ok(KeySource::Pasted("KEY".into()))
        );
    }

    #[test]
    fn an_auth_request_naming_a_key_path_does_not_name_a_file() {
        // The removed `privateKeyPath` field is ignored, not honoured.
        let auth: AuthInput =
            serde_json::from_str(r#"{"type":"key","privateKeyPath":"~/.ssh/id_ed25519"}"#).unwrap();
        let AuthInput::Key {
            private_key,
            use_picked_key_file,
            ..
        } = auth
        else {
            panic!("expected key auth");
        };
        assert_eq!(
            resolve_key_source(private_key, use_picked_key_file, None),
            Err("Provide a private key or choose a key file.".to_string())
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
