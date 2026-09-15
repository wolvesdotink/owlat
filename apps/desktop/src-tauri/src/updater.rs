//! Server-managed OTA updates.
//!
//! The JS `check()` from @tauri-apps/plugin-updater takes headers, a timeout, a
//! proxy and a target — but not an endpoint; endpoints come from
//! `tauri.conf.json` and nowhere else. The endpoint we want depends on which
//! workspace the app is currently connected to, which is only known in the
//! webview, so the check moves down here where `updater_builder().endpoints()`
//! is reachable.
//!
//! Three commands, in the order the webview calls them:
//!
//!   1. `updater_check(endpoint)` — `None` uses the GitHub endpoint baked into
//!      the config (an instance that predates server-managed updates, a
//!      plain-http dev server, or no workspace yet); `Some(url)` points at the
//!      active instance's manifest route. A found update is stashed in managed
//!      state rather than returned, because an `Update` cannot cross the IPC
//!      boundary and the install has to act on the very object the check
//!      verified.
//!   2. `updater_install(on_event)` — downloads and installs the stashed
//!      update, streaming progress over a `Channel` the same way
//!      `ssh_exec_stream` streams remote output.
//!   3. `updater_restart()` — applies it.
//!
//! Plus `updater_notify_ready`, the native "update is ready" toast with a
//! Restart-now action on the platforms that can render one (see below).
//!
//! What this does NOT change: where bytes come from (GitHub) or who verifies
//! them (the minisign key baked into the app, checked by the plugin on every
//! download). A server chooses among signed releases; it can never substitute
//! one. Endpoints are required to be https — the plugin refuses plain http
//! unless `dangerousInsecureTransportProtocol` is set, and that flag stays off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{command, AppHandle, State, Url};
use tauri_plugin_updater::UpdaterExt;

/// How long the whole check (connect + manifest fetch) may take. The manifest
/// route is one cached Convex read, so a server that has not answered in 30s is
/// down rather than slow, and the next scheduled check will pick it up.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The update found by the last successful check, waiting to be installed.
///
/// `Update` carries the verified manifest entry (URL + signature) for THIS
/// platform; keeping it means the install downloads exactly what the check
/// resolved, with no second round trip to the endpoint.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

/// What the webview learns about an available update.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    /// The release body, when the manifest carries one.
    notes: Option<String>,
    /// Publication time in whole seconds since the epoch.
    date: Option<i64>,
}

/// Download progress, streamed over the `Channel` the install command is given.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateProgress {
    /// First chunk: `content_length` is absent when the server sent no
    /// `Content-Length` (the UI then shows an indeterminate bar).
    Started { content_length: Option<u64> },
    Progress { chunk_length: usize },
    Finished,
}

/// Parse and vet an endpoint handed in by the webview.
///
/// https-only, matching the plugin's own rule, so a compromised or simply
/// misconfigured workspace URL cannot move the update check onto a transport
/// someone can rewrite in flight. (The signature check would still catch a
/// swapped bundle; this keeps the manifest honest too.)
///
/// The `{{target}}` / `{{arch}}` / `{{current_version}}` placeholders survive
/// parsing percent-encoded (`%7B%7Btarget%7D%7D`), which is exactly what a
/// config-provided endpoint looks like by the time the plugin substitutes them.
fn parse_endpoint(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("unknown: invalid update endpoint ({e})"))?;
    if url.scheme() != "https" {
        return Err("unknown: update endpoints must be https".to_string());
    }
    Ok(url)
}

/// `owlat-desktop/<version>`, so an instance (and GitHub) can tell desktop
/// checks apart from the server's own `owlat-selfhost/<version>` polling.
fn user_agent(version: &str) -> String {
    format!("owlat-desktop/{version}")
}

/// A poisoned state mutex means a previous command panicked mid-update; there
/// is nothing to recover, so report it like any other unclassified failure.
fn poisoned() -> String {
    "unknown: updater state poisoned".to_string()
}

/// Sort a failure into the three kinds the UI distinguishes: `network` (retry
/// later, say nothing loud), `signature` (a bundle that failed verification —
/// the one case worth alarming about) and `unknown`.
///
/// Classified on the rendered message rather than by matching the plugin's
/// error enum, because the interesting distinction cuts across variants: a
/// reqwest error is network whether it surfaced as `Reqwest`, `Io` or a naked
/// timeout, and minisign failures arrive from more than one place too.
fn classify_error(message: &str) -> &'static str {
    let m = message.to_ascii_lowercase();
    if m.contains("signature")
        || m.contains("minisign")
        || m.contains("pubkey")
        || m.contains("public key")
        || m.contains("verif")
    {
        return "signature";
    }
    if m.contains("network")
        || m.contains("timed out")
        || m.contains("timeout")
        || m.contains("connect")
        || m.contains("dns")
        || m.contains("sending request")
        || m.contains("unreachable")
        || m.contains("certificate")
        || m.contains("tls")
    {
        return "network";
    }
    "unknown"
}

/// Render an error as `<kind>: <message>`. Tauri rejects a command with a
/// string, so the kind rides in front of it and the bridge splits it back into
/// `{ error, message }` (see apps/desktop/src/updater.ts).
fn updater_error(e: impl std::fmt::Display) -> String {
    let message = e.to_string();
    format!("{}: {message}", classify_error(&message))
}

/// Check for an update, optionally against a server-provided endpoint.
///
/// Returns `None` when the endpoint says "nothing for you" (a 204 from an
/// instance holding the fleet back, or simply no newer release).
#[command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
    endpoint: Option<String>,
) -> Result<Option<UpdateInfo>, String> {
    let ua = user_agent(&app.package_info().version.to_string());
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    builder = builder.header("User-Agent", ua).map_err(updater_error)?;
    if let Some(raw) = endpoint {
        let url = parse_endpoint(&raw)?;
        builder = builder.endpoints(vec![url]).map_err(updater_error)?;
    }

    let updater = builder.build().map_err(updater_error)?;
    let found = updater.check().await.map_err(updater_error)?;
    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|d| d.unix_timestamp()),
    });

    let mut pending = state.0.lock().map_err(|_| poisoned())?;
    *pending = found;
    Ok(info)
}

/// Download and install the update the last check found, reporting progress.
///
/// Consumes the pending update: a failed install leaves nothing behind to
/// retry, so the webview re-checks (cheap — one cached read) rather than
/// reusing a manifest entry whose download already went wrong.
#[command]
pub async fn updater_install(
    state: State<'_, PendingUpdate>,
    on_event: Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = {
        let mut pending = state.0.lock().map_err(|_| poisoned())?;
        pending.take()
    }
    .ok_or_else(|| "unknown: no update is ready to install".to_string())?;

    // The plugin reports the total length on every chunk; the UI wants it once,
    // up front, so the first chunk doubles as the "download started" event.
    let progress = on_event.clone();
    let started = AtomicBool::new(false);
    let on_chunk = move |chunk_length: usize, content_length: Option<u64>| {
        if !started.swap(true, Ordering::Relaxed) {
            let _ = progress.send(UpdateProgress::Started { content_length });
        }
        let _ = progress.send(UpdateProgress::Progress { chunk_length });
    };
    let on_finish = move || {
        let _ = on_event.send(UpdateProgress::Finished);
    };

    update
        .download_and_install(on_chunk, on_finish)
        .await
        .map_err(updater_error)?;
    Ok(())
}

/// Relaunch into the installed version. Needs no extra plugin: `restart()`
/// exits the process and starts the (now replaced) binary again.
#[command]
pub fn updater_restart(app: AppHandle) {
    app.restart();
}

// ── "Update ready" notification ────────────────────────────────────────────
//
// Same split as notifications.rs: the notification plugin only renders action
// buttons on mobile, so the Restart-now action is driven through the native
// crates directly (mac-notification-sys on macOS, notify-rust on Linux, both
// already dependencies). Windows falls back to a plain notification and the
// in-app "Restart to update" button on the device page. The action is delivered
// to the webview as an `updater-action` event rather than restarting from here,
// so the restart always runs through the same command path the button uses.

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone, serde::Serialize)]
struct UpdaterActionEvent {
    /// Only `restart` today; a string so adding a second action needs no
    /// change on the listening side.
    action: String,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn emit_updater_action(app: &AppHandle, action: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "updater-action",
        UpdaterActionEvent {
            action: action.to_string(),
        },
    );
}

#[cfg(target_os = "macos")]
fn notify_update_ready(app: &AppHandle, title: String, body: String, action_label: String) {
    use mac_notification_sys::{
        send_notification, set_application, MainButton, Notification, NotificationResponse,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        // Shares the global the plugin's own notification path sets; an
        // "already set" error is fine, it just has to be set before sending.
        let _ = set_application(&app.config().identifier);
        let mut options = Notification::new();
        options.main_button(MainButton::SingleAction(&action_label));
        let response = send_notification(&title, None, &body, Some(&options));
        if let Ok(NotificationResponse::ActionButton(_)) = response {
            emit_updater_action(&app, "restart");
        }
    });
}

#[cfg(target_os = "linux")]
fn notify_update_ready(app: &AppHandle, title: String, body: String, action_label: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .action("restart", &action_label)
            .show();
        if let Ok(handle) = handle {
            handle.wait_for_action(|action| {
                if action == "restart" {
                    emit_updater_action(&app, "restart");
                }
            });
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn notify_update_ready(app: &AppHandle, title: String, body: String, _action_label: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

/// Tauri command: announce a downloaded update, with a Restart-now action where
/// the OS supports one. The webview passes the already-translated strings.
#[command]
pub fn updater_notify_ready(app: AppHandle, title: String, body: String, action_label: String) {
    notify_update_ready(&app, title, body, action_label);
}

#[cfg(test)]
mod tests {
    use super::{classify_error, parse_endpoint, updater_error, user_agent};

    #[test]
    fn endpoint_keeps_the_tauri_placeholders_and_requires_https() {
        let raw = "https://acme.example/api/desktop/update/{{target}}/{{arch}}/{{current_version}}";
        // The url crate percent-encodes braces in a path. That is also what a
        // `tauri.conf.json` endpoint looks like after parsing, and the plugin
        // substitutes on this encoded form — so the placeholders are intact.
        let encoded = "https://acme.example/api/desktop/update/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/%7B%7Bcurrent_version%7D%7D";
        assert_eq!(parse_endpoint(raw).unwrap().as_str(), encoded);
    }

    #[test]
    fn endpoint_rejects_plain_http_and_junk() {
        // `tauri dev` over http://localhost:3000 lands here; the web side is
        // expected to have chosen GitHub already, and this is the backstop.
        assert!(parse_endpoint("http://localhost:3000/api/desktop/update/a/b/c").is_err());
        assert!(parse_endpoint("file:///etc/passwd").is_err());
        assert!(parse_endpoint("not a url").is_err());
    }

    #[test]
    fn user_agent_names_the_app_and_version() {
        assert_eq!(user_agent("0.4.6"), "owlat-desktop/0.4.6");
    }

    #[test]
    fn signature_failures_are_told_apart_from_network_ones() {
        assert_eq!(classify_error("signature verification failed"), "signature");
        assert_eq!(classify_error("Minisign: bad trusted comment"), "signature");
        assert_eq!(classify_error("error sending request"), "network");
        assert_eq!(classify_error("operation timed out"), "network");
        assert_eq!(classify_error("tcp connect error"), "network");
        assert_eq!(classify_error("manifest was not valid json"), "unknown");
    }

    #[test]
    fn errors_are_rendered_kind_first_for_the_bridge_to_split() {
        assert_eq!(updater_error("timed out"), "network: timed out");
        assert_eq!(updater_error("weird"), "unknown: weird");
    }
}
