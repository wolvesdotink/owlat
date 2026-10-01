//! Developer-only provisioning: the "local source" install paths of the server
//! wizard, which upload this machine's Owlat checkout instead of cloning the
//! published repo and can build the images here and stream them to the server.
//!
//! This module is compiled only with the `dev-provisioning` Cargo feature. `bun
//! run dev` (`tauri dev`) enables it; release builds do not, so a shipped binary
//! neither contains nor registers these commands, whatever the webview asks for.
//! Even in a developer build every command keeps its inputs narrow: the checkout
//! must be an Owlat repository root, and the local Docker invocations are typed
//! operations whose program, subcommands, flags, tags and environment are fixed
//! here. The webview picks a build shape, the target platform and Compose
//! service/profile names; it never supplies command arguments, flags or
//! environment variables.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{command, State};

use super::{get_conn, ExecEvent, OpToken, SshState, CANCELLED};

/// The tag the local builds carry: docker-compose.yml's "local build, never
/// pushed" sentinel (`LOCAL_VERSION_TAG` in the web app's provisioningCommands.ts).
const LOCAL_VERSION_TAG: &str = "dev";

/// The setup-cli image a local-source install runs quickstart in
/// (`LOCAL_SETUP_IMAGE` in provisioningCommands.ts).
const LOCAL_SETUP_IMAGE: &str = "ghcr.io/wolvesdotink/setup:dev";

/// The Docker platforms a server can report (`dockerPlatform` in the web app).
const PLATFORMS: &[&str] = &["linux/amd64", "linux/arm64"];

/// Upper bound on the names one request may carry (services, profiles, images).
const MAX_NAMES: usize = 64;

/// Resolve `local_dir` to the Owlat checkout it has to be: an absolute path to
/// a folder holding the monorepo markers (`turbo.json`, the same check as
/// setup-cli's verifyMonorepo, and the root `docker-compose.yml` the local
/// builds read). Anything else is refused before it is read or run in.
fn checkout_root(local_dir: &str) -> Result<PathBuf, String> {
    let root = Path::new(local_dir);
    if !root.is_absolute() {
        return Err(format!("{local_dir} is not an absolute path."));
    }
    for marker in ["turbo.json", "docker-compose.yml"] {
        if !root.join(marker).is_file() {
            return Err(format!(
                "{local_dir} is not the Owlat repository root (no {marker} found)."
            ));
        }
    }
    Ok(root.to_path_buf())
}

fn check_platform(platform: &str) -> Result<(), String> {
    if PLATFORMS.contains(&platform) {
        Ok(())
    } else {
        Err(format!("Unsupported build platform: {platform}"))
    }
}

/// A Compose service or profile name: starts with a letter or digit, then
/// letters, digits, `_`, `.` or `-`. So it can only ever be read as a name,
/// never as a flag.
fn is_compose_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn check_compose_names(kind: &str, names: &[String]) -> Result<(), String> {
    if names.len() > MAX_NAMES {
        return Err(format!("Too many compose {kind}s."));
    }
    match names.iter().find(|n| !is_compose_name(n)) {
        Some(bad) => Err(format!("Invalid compose {kind} name: {bad}")),
        None => Ok(()),
    }
}

/// An image the push may stream: a lowercase repository reference carrying the
/// local `dev` tag (every entry of `DEV_IMAGES` in provisioningCommands.ts).
fn is_local_image(image: &str) -> bool {
    image.len() <= 255
        && image
            .strip_suffix(LOCAL_VERSION_TAG)
            .and_then(|rest| rest.strip_suffix(':'))
            .is_some_and(|repo| {
                let mut chars = repo.chars();
                chars
                    .next()
                    .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && chars.all(|c| {
                        c.is_ascii_lowercase()
                            || c.is_ascii_digit()
                            || matches!(c, '.' | '_' | '-' | '/')
                    })
            })
}

fn check_local_images(images: &[String]) -> Result<(), String> {
    if images.is_empty() {
        return Err("No images to push.".to_string());
    }
    if images.len() > MAX_NAMES {
        return Err("Too many images to push.".to_string());
    }
    match images.iter().find(|i| !is_local_image(i)) {
        Some(bad) => Err(format!("Not a local {LOCAL_VERSION_TAG} image: {bad}")),
        None => Ok(()),
    }
}

/// A local process owned by one operation. It is killed, with everything it
/// started, and reaped when the operation is cancelled and whenever the guard
/// is dropped before the process exited (an early error return, a panic), so
/// no `docker` keeps running after the wizard gave up on it.
struct ChildGuard {
    child: Arc<Mutex<Child>>,
    /// Tells the cancellation watcher to stop.
    done: Arc<AtomicBool>,
}

/// How often a guarded process is checked for exit and cancellation.
const CHILD_POLL: Duration = Duration::from_millis(50);

impl ChildGuard {
    /// Spawn `cmd` in its own process group (so the Docker CLI's plugin
    /// processes go down with it) and kill it as soon as `token` is cancelled.
    /// Take the child's pipes with [`ChildGuard::take_stdout`] and friends.
    fn spawn(cmd: &mut Command, token: OpToken) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = Arc::new(Mutex::new(cmd.spawn()?));
        let done = Arc::new(AtomicBool::new(false));
        let (watched, watching) = (child.clone(), done.clone());
        std::thread::spawn(move || {
            while !watching.load(Ordering::SeqCst) {
                if token.is_cancelled() {
                    if let Ok(mut child) = watched.lock() {
                        kill_tree(&mut child);
                    }
                    return;
                }
                std::thread::sleep(CHILD_POLL);
            }
        });
        Ok(Self { child, done })
    }

    fn take_stdout(&self) -> Option<std::process::ChildStdout> {
        self.child.lock().ok()?.stdout.take()
    }

    fn take_stderr(&self) -> Option<std::process::ChildStderr> {
        self.child.lock().ok()?.stderr.take()
    }

    /// Wait for the process to exit (or to be killed by a cancellation).
    fn wait(&self) -> Result<ExitStatus, String> {
        loop {
            {
                let mut child = self
                    .child
                    .lock()
                    .map_err(|_| "child poisoned".to_string())?;
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    return Ok(status);
                }
            }
            std::thread::sleep(CHILD_POLL);
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            if matches!(child.try_wait(), Ok(None)) {
                kill_tree(&mut child);
            }
            let _ = child.wait();
        }
    }
}

/// Kill a guarded process and the processes it started. `docker compose` and
/// `docker buildx` run as plugin processes of the `docker` CLI, so killing the
/// CLI alone would leave the build running (and holding its output pipes).
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // The guard spawned the child as the leader of its own process group.
        if let Ok(pgid) = i32::try_from(child.id()) {
            // SAFETY: killpg only sends a signal; the group id is our child's pid.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
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
    // Only the monorepo root is ever packed: the installer needs it, and it
    // keeps this from uploading an arbitrary folder.
    let root = checkout_root(&local_dir)?;
    let conn = get_conn(&state, &session_id)?;
    let token = conn.begin()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let tarball = pack_dir_targz(&root)?;

        let sess = conn
            .session
            .lock()
            .map_err(|_| "session poisoned".to_string())?;
        sess.set_blocking(true);
        let mut chan = sess.channel_session().map_err(|e| e.to_string())?;
        let cmd = format!("tar -xzf - -C '{remote_dir}'");
        chan.exec(&cmd).map_err(|e| e.to_string())?;
        // In slices, so a cancellation lands between them.
        for slice in tarball.chunks(256 * 1024) {
            if token.is_cancelled() {
                let _ = chan.close();
                return Err(CANCELLED.to_string());
            }
            chan.write_all(slice).map_err(|e| e.to_string())?;
        }
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

/// A local image build, as the webview may ask for it: the Compose stack
/// (services and profiles of the checkout's docker-compose.yml) or the setup-cli
/// image, each for one server platform. Everything else about the invocation is
/// fixed by [`docker_invocation`].
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocalBuild {
    /// `docker compose [--profile …] build <services>` with the stack's `dev`
    /// tag and the server's platform.
    Stack {
        platform: String,
        profiles: Vec<String>,
        services: Vec<String>,
    },
    /// `docker build` of `apps/setup-cli/Dockerfile` as the local setup image.
    SetupImage { platform: String },
}

/// The exact `docker` argv and the variables added to its environment.
#[derive(Debug, PartialEq)]
struct DockerInvocation {
    args: Vec<String>,
    env: Vec<(&'static str, String)>,
}

/// Validate a [`LocalBuild`] and spell out the `docker` invocation it means.
fn docker_invocation(build: &LocalBuild) -> Result<DockerInvocation, String> {
    match build {
        LocalBuild::Stack {
            platform,
            profiles,
            services,
        } => {
            check_platform(platform)?;
            check_compose_names("profile", profiles)?;
            if services.is_empty() {
                return Err("No compose services to build.".to_string());
            }
            check_compose_names("service", services)?;
            let mut args = vec!["compose".to_string()];
            for profile in profiles {
                args.push("--profile".to_string());
                args.push(profile.clone());
            }
            args.push("build".to_string());
            args.extend(services.iter().cloned());
            Ok(DockerInvocation {
                args,
                // INSTANCE_SECRET only silences compose interpolation warnings.
                env: vec![
                    ("OWLAT_VERSION", LOCAL_VERSION_TAG.to_string()),
                    ("DOCKER_DEFAULT_PLATFORM", platform.clone()),
                    ("INSTANCE_SECRET", "build-only".to_string()),
                ],
            })
        }
        LocalBuild::SetupImage { platform } => {
            check_platform(platform)?;
            let args = [
                "build",
                "--platform",
                platform,
                "-f",
                "apps/setup-cli/Dockerfile",
                "-t",
                LOCAL_SETUP_IMAGE,
                ".",
            ];
            Ok(DockerInvocation {
                args: args.iter().map(|a| a.to_string()).collect(),
                env: Vec::new(),
            })
        }
    }
}

/// Build images on THIS machine for the push-images dev install path, in the
/// Owlat checkout at `local_dir`, streaming stdout/stderr line-by-line like
/// `ssh_exec_stream`. Returns docker's exit code. The build belongs to the SSH
/// session `session_id` (the server it is for): cancelling or disconnecting
/// that session kills it.
#[command]
pub async fn local_docker_build(
    state: State<'_, SshState>,
    session_id: String,
    local_dir: String,
    build: LocalBuild,
    on_event: Channel<ExecEvent>,
) -> Result<i32, String> {
    let root = checkout_root(&local_dir)?;
    let invocation = docker_invocation(&build)?;
    let token = get_conn(&state, &session_id)?.begin()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
        let child = ChildGuard::spawn(
            Command::new("docker")
                .args(&invocation.args)
                .current_dir(&root)
                .envs(invocation.env.iter().map(|(k, v)| (*k, v.as_str())))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped()),
            token.clone(),
        )
        .map_err(|e| format!("Could not start docker: {e}"))?;

        let stdout = child.take_stdout().ok_or("no stdout")?;
        let stderr = child.take_stderr().ok_or("no stderr")?;
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
        let status = child.wait()?;
        if token.is_cancelled() {
            // Not joined: a grandchild that escaped the kill could still hold
            // the pipes open, and the readers end on their own when it exits.
            return Err(CANCELLED.to_string());
        }
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
/// (in MiB sent) every ~64 MiB so the UI can show upload movement. Fails the
/// write once the operation is cancelled.
struct ChannelWriter<'a> {
    chan: &'a mut ssh2::Channel,
    events: &'a Channel<ExecEvent>,
    token: &'a OpToken,
    sent: u64,
    last_report: u64,
}

impl std::io::Write for ChannelWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.token.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                CANCELLED,
            ));
        }
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
/// not incremental) but the transfer is one gzip'd stream. Only local `dev`
/// images are accepted (see [`is_local_image`]).
#[command]
pub async fn ssh_push_images(
    state: State<'_, SshState>,
    session_id: String,
    images: Vec<String>,
    on_event: Channel<ExecEvent>,
) -> Result<(), String> {
    check_local_images(&images)?;
    let conn = get_conn(&state, &session_id)?;
    let token = conn.begin()?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Guarded: every early return below (a failed upload, a cancellation)
        // kills and reaps `docker save` instead of leaving it running.
        let child = ChildGuard::spawn(
            Command::new("docker")
                .arg("save")
                .args(&images)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped()),
            token.clone(),
        )
        .map_err(|e| format!("Could not start docker save: {e}"))?;
        let mut tar_stream = child.take_stdout().ok_or("no stdout")?;
        // Drain stderr on its own thread so a chatty `docker save` (progress /
        // warnings on a large multi-image save) can't fill the OS pipe buffer and
        // deadlock the stdout copy below — which carries the whole multi-GB
        // transfer over a potentially slow uplink. local_docker_build already
        // drains both streams concurrently; this path previously did not.
        let mut stderr_pipe = child.take_stderr().ok_or("no stderr")?;
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

        let copied = {
            let writer = ChannelWriter {
                chan: &mut chan,
                events: &on_event,
                token: &token,
                sent: 0,
                last_report: 0,
            };
            // fast(): the bottleneck is usually the uplink, not CPU — but level-1
            // gzip still roughly halves docker-save output.
            let mut gz = flate2::write::GzEncoder::new(writer, flate2::Compression::fast());
            std::io::copy(&mut tar_stream, &mut gz).and_then(|_| gz.finish().map(|_| ()))
        };
        if let Err(e) = copied {
            let _ = chan.close();
            return Err(if token.is_cancelled() {
                CANCELLED.to_string()
            } else {
                e.to_string()
            });
        }

        let status = child.wait()?;
        if token.is_cancelled() {
            let _ = chan.close();
            return Err(CANCELLED.to_string());
        }
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

#[cfg(test)]
mod tests {
    use super::{
        check_local_images, checkout_root, docker_invocation, pack_dir_targz, DockerInvocation,
        LocalBuild,
    };
    #[cfg(unix)]
    use super::{ChildGuard, Command};
    #[cfg(unix)]
    use crate::ssh::Cancel;
    #[cfg(unix)]
    use std::io::BufRead;
    #[cfg(unix)]
    use std::sync::Arc;
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    fn stack(platform: &str, profiles: &[&str], services: &[&str]) -> LocalBuild {
        LocalBuild::Stack {
            platform: platform.to_string(),
            profiles: profiles.iter().map(|s| s.to_string()).collect(),
            services: services.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn stack_build_is_a_fixed_compose_build_of_the_named_services() {
        let inv =
            docker_invocation(&stack("linux/arm64", &["deploy", "ai"], &["web", "mta"])).unwrap();
        assert_eq!(
            inv,
            DockerInvocation {
                args: [
                    "compose",
                    "--profile",
                    "deploy",
                    "--profile",
                    "ai",
                    "build",
                    "web",
                    "mta"
                ]
                .map(String::from)
                .to_vec(),
                env: vec![
                    ("OWLAT_VERSION", "dev".to_string()),
                    ("DOCKER_DEFAULT_PLATFORM", "linux/arm64".to_string()),
                    ("INSTANCE_SECRET", "build-only".to_string()),
                ],
            }
        );
    }

    #[test]
    fn setup_image_build_is_fixed_apart_from_the_platform() {
        let build = LocalBuild::SetupImage {
            platform: "linux/amd64".to_string(),
        };
        let inv = docker_invocation(&build).unwrap();
        assert_eq!(
            inv.args,
            [
                "build",
                "--platform",
                "linux/amd64",
                "-f",
                "apps/setup-cli/Dockerfile",
                "-t",
                "ghcr.io/wolvesdotink/setup:dev",
                "."
            ]
            .map(String::from)
            .to_vec()
        );
        assert!(inv.env.is_empty());
    }

    #[test]
    fn builds_reject_anything_but_platforms_and_plain_compose_names() {
        for platform in ["", "linux/amd64 --push", "windows/amd64", "--platform"] {
            assert!(
                docker_invocation(&stack(platform, &[], &["web"])).is_err(),
                "{platform}"
            );
            let setup = LocalBuild::SetupImage {
                platform: platform.to_string(),
            };
            assert!(docker_invocation(&setup).is_err(), "{platform}");
        }
        for name in [
            "",
            "-f",
            "--file=x.yml",
            "web mta",
            "web;id",
            "../web",
            "a=b",
            "é",
        ] {
            assert!(
                docker_invocation(&stack("linux/amd64", &[], &[name])).is_err(),
                "{name}"
            );
            assert!(
                docker_invocation(&stack("linux/amd64", &[name], &["web"])).is_err(),
                "{name}"
            );
        }
        assert!(docker_invocation(&stack("linux/amd64", &["deploy"], &[])).is_err());
        let many: Vec<String> = (0..65).map(|i| format!("svc{i}")).collect();
        let too_many = LocalBuild::Stack {
            platform: "linux/amd64".to_string(),
            profiles: vec![],
            services: many,
        };
        assert!(docker_invocation(&too_many).is_err());
    }

    #[test]
    fn local_build_accepts_only_the_typed_shapes() {
        let parse = |json: &str| serde_json::from_str::<LocalBuild>(json);
        assert!(parse(
            r#"{"kind":"stack","platform":"linux/amd64","profiles":["deploy"],"services":["web"]}"#
        )
        .is_ok());
        assert!(parse(r#"{"kind":"setupImage","platform":"linux/arm64"}"#).is_ok());
        assert!(parse(r#"{"kind":"exec","program":"docker","args":["run"]}"#).is_err());
        assert!(parse(r#"{"program":"docker","args":["run"]}"#).is_err());
    }

    #[test]
    fn push_accepts_only_local_dev_images() {
        let images = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(check_local_images(&images(&[
            "ghcr.io/wolvesdotink/web:dev",
            "ghcr.io/wolvesdotink/setup:dev",
            "owlat-code-worker:dev",
        ]))
        .is_ok());
        assert!(check_local_images(&[]).is_err());
        for bad in [
            "-o",
            "--output=/tmp/x",
            "ghcr.io/wolvesdotink/web:latest",
            "ghcr.io/wolvesdotink/web",
            ":dev",
            "Owlat/web:dev",
            "web:dev extra",
            "web@sha256:abc",
        ] {
            assert!(check_local_images(&images(&[bad])).is_err(), "{bad}");
        }
    }

    /// Whether a process id still names a live (or unreaped) process.
    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    fn gone_within(pid: u32, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_kills_a_local_build_and_what_it_started() {
        // A shell standing in for the docker CLI, with a grandchild standing in
        // for its compose/buildx plugin: both must go, and the shell is reaped.
        let cancel = Arc::new(Cancel::default());
        let child = ChildGuard::spawn(
            Command::new("sh")
                .args(["-c", "sleep 60 & echo $!; wait"])
                .stdout(std::process::Stdio::piped()),
            cancel.token(),
        )
        .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.take_stdout().unwrap())
            .read_line(&mut line)
            .unwrap();
        let grandchild: u32 = line.trim().parse().unwrap();
        assert!(alive(grandchild));

        let asked = Instant::now();
        cancel.cancel_running();
        let status = child.wait().unwrap();
        assert!(asked.elapsed() < Duration::from_secs(5));
        assert!(!status.success());
        assert!(
            gone_within(grandchild, Duration::from_secs(5)),
            "plugin outlived the build"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_early_return_kills_and_reaps_the_child() {
        let cancel = Arc::new(Cancel::default());
        let child = ChildGuard::spawn(Command::new("sleep").arg("60"), cancel.token()).unwrap();
        let pid = child.child.lock().unwrap().id();
        assert!(alive(pid));
        // e.g. the image upload failed and `?` returned before `wait()`.
        drop(child);
        // Reaped by the guard itself, so the pid is gone at once (no zombie).
        assert!(!alive(pid));
    }

    #[test]
    fn checkout_root_requires_an_absolute_owlat_repository_root() {
        let root = std::env::temp_dir().join(format!("owlat-checkout-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.to_string_lossy().into_owned();

        assert!(checkout_root("relative/owlat").is_err());
        assert!(checkout_root(&dir).is_err());
        std::fs::write(root.join("turbo.json"), "{}").unwrap();
        assert!(
            checkout_root(&dir).is_err(),
            "turbo.json alone is not enough"
        );
        std::fs::write(root.join("docker-compose.yml"), "services: {}").unwrap();
        assert_eq!(checkout_root(&dir).unwrap(), root);

        std::fs::remove_dir_all(&root).unwrap();
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
