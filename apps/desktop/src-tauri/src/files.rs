//! Read a user-chosen file's bytes for the upload surfaces.
//!
//! The native file picker (tauri-plugin-dialog) and OS-level file drops both
//! hand back an absolute filesystem *path*, but every upload surface in the web
//! app consumes a `File`/`Blob`. This command bridges the gap: given a path the
//! user explicitly picked (or dropped onto the window), it returns the raw
//! bytes, which the JS side wraps into a `File`. Type validation and the
//! upload/scan pipeline are unchanged — they run on the resulting `File` exactly
//! as they do for an HTML `<input type=file>`.
//!
//! Only paths the user chose through a native dialog or drop reach here, so the
//! surface stays as narrow as the existing `<input type=file>` path.

use std::fs;
use tauri::command;
use tauri::ipc::Response;

/// Read the file at `path` and return its raw bytes as a binary IPC response
/// (delivered to JS as an `ArrayBuffer`, avoiding a JSON number-array round
/// trip). Errors surface as a message string.
#[command]
pub fn read_file(path: String) -> Result<Response, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}
