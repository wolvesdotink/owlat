//! User-mediated file reads for the desktop upload surfaces.
//!
//! Every upload surface in the web app consumes a `File`/`Blob`, but the two
//! desktop entry points — the native picker and OS-level file drops — deal in
//! filesystem *paths*. Rather than expose a "read any path" command (which any
//! script running in the webview could aim at `~/.ssh/id_ed25519` the moment an
//! XSS slips past the Postbox sanitizer), user mediation is enforced **in Rust**:
//!
//!   * [`pick_files`] opens the native dialog on the Rust side and records the
//!     chosen paths as authorized reads. JS never opens the dialog, so it can
//!     only learn the paths the user actually picked.
//!   * OS drops are captured in the window's `DragDrop` event (see `main.rs`)
//!     and recorded the same way — the only place a drop's real paths reach Rust.
//!   * [`read_authorized_file`] reads a path **only** if it is on that one-shot
//!     allowlist, removing it once read. A path the webview invents is refused,
//!     so this is never wider than a browser `<input type=file>`.
//!
//! Bytes are returned over the binary IPC channel (one raw blob per response),
//! not as a JSON number array, so picking a large video doesn't balloon into a
//! multi-hundred-MB JSON string. Type validation and the upload/scan pipeline
//! are unchanged — they run on the resulting `File` exactly as on web.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::{async_runtime, command, AppHandle, State};
use tauri_plugin_dialog::DialogExt;

/// Hard ceiling on a single desktop file read, matching the app's largest
/// upload limit (the 50 MB file-library cap; tighter per-surface limits — e.g.
/// the 25 MB attachment cap — are still enforced on the web side). Larger files
/// are rejected after a `stat`, before any bytes are read into memory or shipped
/// over IPC (a lazy disk-backed `<input type=file>` never had to).
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// One-shot allowlist of paths the user has authorized to read. Populated only
/// by a native pick ([`pick_files`]) or an OS drop ([`remember_dropped_paths`]);
/// consumed (removed) by [`read_authorized_file`]. This is the whole security
/// boundary: a path the webview names that isn't here is refused.
#[derive(Default)]
pub struct AllowedReads(Mutex<HashSet<PathBuf>>);

impl AllowedReads {
    fn allow(&self, path: PathBuf) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(path);
        }
    }

    /// Remove `path`, returning whether it was authorized (present).
    fn take(&self, path: &Path) -> bool {
        self.0
            .lock()
            .map(|mut set| set.remove(path))
            .unwrap_or(false)
    }
}

/// Record OS-dropped paths as authorized reads. Called from the window's
/// `DragDrop` handler in `main.rs`, which is the only place a drop's real paths
/// are known to the Rust side.
pub fn remember_dropped_paths(state: &AllowedReads, paths: &[PathBuf]) {
    for path in paths {
        state.allow(path.clone());
    }
}

/// A picker format filter, mirroring the JS `FilePickerFilter`.
#[derive(serde::Deserialize)]
pub struct PickFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Open the native OS file picker and return the chosen absolute paths, each
/// recorded as an authorized read so [`read_authorized_file`] will serve its
/// bytes. Returns an empty vec when the user cancels. No path parameter exists,
/// so the webview cannot steer the dialog at a file the user didn't choose.
///
/// `async` so it runs off the main thread; the dialog itself is driven on a
/// blocking worker (Tauri dispatches it to the main thread internally) so the UI
/// stays responsive while it is open.
#[command]
pub async fn pick_files(
    app: AppHandle,
    allow: State<'_, AllowedReads>,
    title: Option<String>,
    filters: Vec<PickFilter>,
    multiple: bool,
) -> Result<Vec<String>, String> {
    let picked = async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file();
        if let Some(title) = title {
            builder = builder.set_title(title);
        }
        for filter in &filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(filter.name.as_str(), &extensions);
        }
        if multiple {
            builder.blocking_pick_files()
        } else {
            builder.blocking_pick_file().map(|path| vec![path])
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();

    for path in &paths {
        allow.allow(path.clone());
    }
    Ok(paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// Read an authorized file's bytes as a binary IPC response (delivered to JS as
/// an `ArrayBuffer`). Rejects any path not on the one-shot allowlist, caps the
/// size before reading, and reads on a blocking worker so a large file never
/// freezes the UI. Errors surface as a message string.
#[command]
pub async fn read_authorized_file(
    path: String,
    allow: State<'_, AllowedReads>,
) -> Result<Response, String> {
    if !allow.take(Path::new(&path)) {
        return Err("This file was not authorized for reading.".to_string());
    }
    let bytes = async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(format!(
                "File is larger than the {} MB limit.",
                MAX_FILE_BYTES / 1024 / 1024
            ));
        }
        fs::read(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}
