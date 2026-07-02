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

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ssh2::{HashType, Session};
use tauri::ipc::Channel;
use tauri::{command, AppHandle, Manager, State};

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

/// Git's view of the working tree: tracked files PLUS untracked-but-not-ignored
/// ones. This is the correct upload set — a pure gitignore walk would silently
/// drop tracked files that sit under an ignore rule (e.g. email-builder's
/// committed `previews/` components vs the root "Email preview output" rule).
/// Returns None when `git` is unavailable or the folder isn't a repository.
fn list_working_tree(root: &Path) -> Option<Vec<PathBuf>> {
    let out = std::process::Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut files: Vec<PathBuf> = out
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| PathBuf::from(String::from_utf8_lossy(s).into_owned()))
        .collect();
    files.sort();
    files.dedup();
    Some(files)
}

/// A regular file must be uploaded executable when it is a shell entry point
/// the server invokes directly — `scripts/owlat`, `install.sh`, or any `*.sh`
/// — OR when the client's on-disk mode already carries an exec bit (so exec
/// bits from a Unix checkout are preserved). A Windows checkout has no Unix
/// exec bit, so without the name-based rule `./scripts/owlat quickstart` would
/// arrive 0644 and fail on the server with permission denied.
fn is_exec_script(rel: &Path, disk_mode: Option<u32>) -> bool {
    if disk_mode.is_some_and(|m| m & 0o111 != 0) {
        return true;
    }
    // Normalise separators so a Windows client's `scripts\owlat` matches too.
    let norm = rel.to_string_lossy().replace('\\', "/");
    norm == "scripts/owlat" || norm == "install.sh" || norm.ends_with(".sh")
}

/// The file's Unix permission bits on disk, or `None` on platforms (Windows)
/// that do not expose them.
fn disk_mode_of(meta: &std::fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode())
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

/// Append one regular file to the tarball with a deterministic mode, chosen by
/// [`is_exec_script`] rather than copied from disk metadata — so shell entry
/// points ship 0o755 even from a checkout with no Unix exec bit, and every
/// other regular file ships 0o644.
fn append_regular_file<W: Write>(
    tar: &mut tar::Builder<W>,
    abs: &Path,
    rel: &Path,
    disk_mode: Option<u32>,
) -> std::io::Result<()> {
    let bytes = std::fs::read(abs)?;
    let mode = if is_exec_script(rel, disk_mode) {
        0o755
    } else {
        0o644
    };
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mtime(0);
    header.set_mode(mode);
    header.set_cksum();
    tar.append_data(&mut header, rel, &bytes[..])
}

/// Archive one working-tree entry: regular files get a normalised mode via
/// [`append_regular_file`]; symlinks (kept as symlinks by `follow_symlinks(false)`)
/// and directories keep their existing metadata-copying handling.
fn append_entry<W: Write>(
    tar: &mut tar::Builder<W>,
    abs: &Path,
    rel: &Path,
    meta: &std::fs::Metadata,
) -> Result<(), String> {
    let result = if meta.file_type().is_file() {
        append_regular_file(tar, abs, rel, disk_mode_of(meta))
    } else {
        tar.append_path_with_name(abs, rel)
    };
    result.map_err(|e| format!("Could not archive {}: {e}", rel.display()))
}

/// Pack a working tree into a gzipped tarball. Uses git's working-tree view
/// when available (see `list_working_tree`); falls back to a `.gitignore`-
/// honouring walk for non-git folders. Shell entry points (`scripts/owlat`,
/// `install.sh`, `*.sh`) are forced executable (0o755) so they survive a
/// Windows checkout that carries no Unix exec bit; symlinks are archived as
/// symlinks, not followed.
fn pack_dir_targz(root: &Path) -> Result<Vec<u8>, String> {
    let enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(enc);
    tar.follow_symlinks(false);

    if let Some(files) = list_working_tree(root) {
        for rel in files {
            let abs = root.join(&rel);
            // `ls-files --cached` also lists files deleted from disk but still
            // in the index — skip anything that no longer exists.
            let meta = match abs.symlink_metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            append_entry(&mut tar, &abs, &rel, &meta)?;
        }
    } else {
        let walker = ignore::WalkBuilder::new(root)
            .hidden(false) // dotfiles like .env templates and .dockerignore must ship
            .require_git(false) // honour .gitignore even if the folder isn't a git checkout
            .filter_entry(|e| e.file_name() != ".git")
            .build();

        for entry in walker {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path == root {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            let meta = path.symlink_metadata().map_err(|e| e.to_string())?;
            append_entry(&mut tar, path, &rel, &meta)?;
        }
    }

    let enc = tar.into_inner().map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
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
        // Same close handshake as ssh_upload_dir: wait_close before the remote
        // EOF arrives is a libssh2 error (-34); small writes only won the race.
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

/// Upload a local directory tree into `remote_dir` as a streamed tar.gz (the
/// "local source" dev install path — used instead of git-cloning the published
/// repo). The tree is packed with `.gitignore` honoured (~4 MB for the Owlat
/// monorepo), so building it in memory is fine.
#[command]
pub async fn ssh_upload_dir(
    state: State<'_, SshState>,
    session_id: String,
    local_dir: String,
    remote_dir: String,
) -> Result<(), String> {
    if remote_dir.contains('\'') {
        return Err("Invalid remote path.".to_string());
    }
    let conn = get_conn(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let root = PathBuf::from(&local_dir);
        // Guard against uploading an arbitrary folder: the installer needs the
        // monorepo root (same `turbo.json` check as setup-cli's verifyMonorepo).
        if !root.join("turbo.json").is_file() {
            return Err(format!(
                "{local_dir} is not the Owlat repository root (no turbo.json found)."
            ));
        }
        let tarball = pack_dir_targz(&root)?;

        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        sess.set_blocking(true);
        let mut chan = sess.channel_session().map_err(|e| e.to_string())?;
        let cmd = format!("tar -xzf - -C '{remote_dir}'");
        chan.exec(&cmd).map_err(|e| e.to_string())?;
        chan.write_all(&tarball).map_err(|e| e.to_string())?;
        // Full close handshake: signal our EOF, wait for the remote's (tar may
        // still be extracting), then close. Calling wait_close before the
        // remote EOF arrives is a libssh2 error (-34).
        chan.send_eof().map_err(|e| e.to_string())?;
        chan.wait_eof().map_err(|e| e.to_string())?;
        chan.close().map_err(|e| e.to_string())?;
        chan.wait_close().map_err(|e| e.to_string())?;
        match chan.exit_status() {
            Ok(0) => Ok(()),
            Ok(code) => Err(format!("Remote extraction failed (exit {code}).")),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run a LOCAL process (e.g. `docker compose build` on the developer machine
/// for the push-images dev install path), streaming stdout/stderr line-by-line
/// like `ssh_exec_stream`. Returns the exit code.
#[command]
pub async fn local_exec_stream(
    program: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    on_event: Channel<ExecEvent>,
) -> Result<i32, String> {
    // Hardening: this is a high-privilege IPC command (arbitrary local process
    // execution) reachable from the webview. It exists solely to drive the local
    // Docker CLI for the push-images install path, so restrict it to an allowlist
    // instead of letting any webview-originated call run an arbitrary program.
    const ALLOWED_PROGRAMS: &[&str] = &["docker"];
    if !ALLOWED_PROGRAMS.contains(&program.as_str()) {
        return Err(format!(
            "local_exec_stream: program '{program}' is not allowed"
        ));
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        let mut child = std::process::Command::new(&program)
            .args(&args)
            .current_dir(&cwd)
            .envs(&env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start {program}: {e}"))?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let out_ch = on_event.clone();
        let err_ch = on_event.clone();
        let t_out = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                let _ = out_ch.send(ExecEvent::Stdout { line });
            }
        });
        let t_err = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                let _ = err_ch.send(ExecEvent::Stderr { line });
            }
        });
        let status = child.wait().map_err(|e| e.to_string())?;
        let _ = t_out.join();
        let _ = t_err.join();
        let code = status.code().unwrap_or(-1);
        let _ = on_event.send(ExecEvent::Exit { code });
        Ok(code)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// io::Write adapter that streams into an SSH channel, reporting progress
/// (in MiB sent) every ~64 MiB so the UI can show upload movement.
struct ChannelWriter<'a> {
    chan: &'a mut ssh2::Channel,
    events: &'a Channel<ExecEvent>,
    sent: u64,
    last_report: u64,
}

impl std::io::Write for ChannelWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.chan
            .write_all(buf)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        self.sent += buf.len() as u64;
        if self.sent - self.last_report >= 64 * 1024 * 1024 {
            self.last_report = self.sent;
            let _ = self.events.send(ExecEvent::Stdout {
                line: format!("… uploaded {} MiB", self.sent / (1024 * 1024)),
            });
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Stream locally built images to the server over the live SSH session:
/// `docker save <images>` on this machine, gzip'd in transit, `docker load`
/// remotely. No registry involved; re-pushes reuse nothing (docker save is
/// not incremental) but the transfer is one gzip'd stream.
#[command]
pub async fn ssh_push_images(
    state: State<'_, SshState>,
    session_id: String,
    images: Vec<String>,
    on_event: Channel<ExecEvent>,
) -> Result<(), String> {
    if images.is_empty() {
        return Err("No images to push.".to_string());
    }
    let conn = get_conn(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut child = std::process::Command::new("docker")
            .arg("save")
            .args(&images)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start docker save: {e}"))?;
        let mut tar_stream = child.stdout.take().ok_or("no stdout")?;
        // Drain stderr on its own thread so a chatty `docker save` (progress /
        // warnings on a large multi-image save) can't fill the OS pipe buffer and
        // deadlock the stdout copy below — which carries the whole multi-GB
        // transfer over a potentially slow uplink. local_exec_stream already
        // drains both streams concurrently; this path previously did not.
        let mut stderr_pipe = child.stderr.take().ok_or("no stderr")?;
        let stderr_handle = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr_pipe.read_to_string(&mut buf);
            buf
        });

        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        sess.set_blocking(true);
        let mut chan = sess.channel_session().map_err(|e| e.to_string())?;
        chan.exec("gunzip | docker load")
            .map_err(|e| e.to_string())?;

        {
            let writer = ChannelWriter {
                chan: &mut chan,
                events: &on_event,
                sent: 0,
                last_report: 0,
            };
            // fast(): the bottleneck is usually the uplink, not CPU — but level-1
            // gzip still roughly halves docker-save output.
            let mut gz = flate2::write::GzEncoder::new(writer, flate2::Compression::fast());
            std::io::copy(&mut tar_stream, &mut gz).map_err(|e| e.to_string())?;
            gz.finish().map_err(|e| e.to_string())?;
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr_output = stderr_handle.join().unwrap_or_default();
        if !status.success() {
            return Err(format!("docker save failed: {}", stderr_output.trim()));
        }

        chan.send_eof().map_err(|e| e.to_string())?;
        chan.wait_eof().map_err(|e| e.to_string())?;
        // Surface `docker load` output (one line per loaded image).
        let mut out = String::new();
        let _ = chan.read_to_string(&mut out);
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            let _ = on_event.send(ExecEvent::Stdout {
                line: line.to_string(),
            });
        }
        chan.close().map_err(|e| e.to_string())?;
        chan.wait_close().map_err(|e| e.to_string())?;
        match chan.exit_status() {
            Ok(0) => Ok(()),
            Ok(code) => Err(format!("Remote docker load failed (exit {code}).")),
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
    use super::{base64_nopad, expand_tilde, pack_dir_targz};

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

    /// Build a throwaway tree, pack it, and list the archive's entries.
    /// Returns (relative paths, modes) keyed by path.
    fn pack_fixture() -> std::collections::HashMap<String, u32> {
        // Unique per call — the two pack tests run in parallel in one process.
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("owlat-pack-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("turbo.json"), "{}").unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(root.join(".env.selfhost.example"), "X=1\n").unwrap();
        std::fs::write(root.join("scripts/owlat"), "#!/bin/sh\n").unwrap();
        // Shell entry points with DEFAULT (non-exec) perms — the server must
        // still receive them executable even from a Windows checkout.
        std::fs::write(root.join("install.sh"), "#!/bin/sh\n").unwrap();
        std::fs::write(root.join("foo.sh"), "#!/bin/sh\n").unwrap();
        std::fs::write(root.join("node_modules/dep/index.js"), "x").unwrap();
        std::fs::write(root.join(".git/config"), "[core]").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join("scripts/owlat"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }

        let bytes = pack_dir_targz(&root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        let gz = flate2::read::GzDecoder::new(&bytes[..]);
        let mut archive = tar::Archive::new(gz);
        let mut entries = std::collections::HashMap::new();
        for entry in archive.entries().unwrap() {
            let entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            entries.insert(path, entry.header().mode().unwrap());
        }
        entries
    }

    #[test]
    fn pack_dir_honours_gitignore_and_skips_dot_git() {
        let entries = pack_fixture();
        assert!(entries.contains_key("turbo.json"));
        // Dotfiles (env templates) must ship even though the walker skips .git.
        assert!(entries.contains_key(".env.selfhost.example"));
        assert!(!entries.keys().any(|p| p.starts_with("node_modules")));
        assert!(!entries.keys().any(|p| p.starts_with(".git/")));
    }

    #[test]
    fn pack_dir_in_a_git_repo_keeps_tracked_files_under_ignore_rules() {
        // The repo has tracked files living below `.gitignore`d paths (e.g.
        // email-builder's committed previews/ vs the "Email preview output"
        // rule). The upload must follow git's view, not a raw ignore walk.
        let root = std::env::temp_dir().join(format!("owlat-pack-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("previews")).unwrap();
        std::fs::write(root.join(".gitignore"), "previews/\nnode_modules/\n").unwrap();
        std::fs::write(root.join("previews/Tracked.vue"), "<template/>").unwrap();
        std::fs::write(root.join("untracked.txt"), "new file").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/dep.js"), "x").unwrap();

        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["add", ".gitignore"]);
        git(&["add", "-f", "previews/Tracked.vue"]); // tracked despite the rule

        let bytes = pack_dir_targz(&root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        let gz = flate2::read::GzDecoder::new(&bytes[..]);
        let mut archive = tar::Archive::new(gz);
        let entries: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries.contains(&"previews/Tracked.vue".to_string()),
            "{entries:?}"
        );
        assert!(entries.contains(&"untracked.txt".to_string()));
        assert!(!entries.iter().any(|p| p.starts_with("node_modules")));
    }

    #[test]
    fn pack_dir_forces_exec_bit_on_shell_scripts_regardless_of_disk_mode() {
        // A Windows client checkout carries no Unix exec bit, so scripts/owlat,
        // install.sh and *.sh files would arrive 0644 and the server's
        // `./scripts/owlat quickstart` would fail with permission denied. They
        // must be forced to 0o755 by name, on every OS. This test does not rely
        // on `#[cfg(unix)]` set_mode, so it exercises the name-based rule for
        // install.sh / foo.sh even on Unix (where they were left non-exec).
        let entries = pack_fixture();
        for name in ["scripts/owlat", "install.sh", "foo.sh"] {
            let mode = entries[name];
            assert_ne!(mode & 0o100, 0, "{name} missing owner-exec bit: {mode:o}");
        }
        // A plain, non-script file stays non-executable (0o644).
        assert_eq!(
            entries["turbo.json"] & 0o111,
            0,
            "plain file unexpectedly executable: {:o}",
            entries["turbo.json"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn pack_dir_preserves_the_executable_bit() {
        // scripts/owlat must stay executable after the upload round-trip — the
        // installer is invoked as `./scripts/owlat quickstart` on the server.
        let entries = pack_fixture();
        let mode = entries["scripts/owlat"];
        assert_ne!(mode & 0o111, 0, "exec bit lost: {mode:o}");
    }
}
