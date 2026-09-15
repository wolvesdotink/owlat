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
//!   2. `updater_install(on_event)` — downloads and VERIFIES the stashed
//!      update, streaming progress over a `Channel` the same way
//!      `ssh_exec_stream` streams remote output, and keeps the verified bytes.
//!   3. `updater_restart()` — installs those bytes and relaunches. Kept apart
//!      from the download on purpose: on Windows the plugin's install hands
//!      over to the NSIS/MSI installer and exits the process on the spot, so
//!      doing it inside step 2 would close the app in the middle of whatever
//!      the user was doing, at whatever six-hour tick found the update. Here
//!      the process only ever goes away on the user's own "Restart now".
//!
//! The state between the steps is one `Pending` slot: idle → found →
//! downloading → ready. A check while a download is in flight is refused, a
//! check while an update is ready just reports that update again, and an
//! install is never run twice for the same bytes — two webviews (the compose
//! window boots the same SPA) cannot race each other through it.
//!
//! Plus `updater_notify_ready`, the native "update is ready" toast with a
//! Restart-now action on the platforms that can render one (see below).
//!
//! What this does NOT change: where bytes come from (GitHub) or who verifies
//! them (the minisign key baked into the app, checked by the plugin on every
//! download). A server chooses among signed releases; it can never substitute
//! one. Endpoints are required to be https — the plugin refuses plain http
//! unless `dangerousInsecureTransportProtocol` is set, and that flag stays off.
//!
//! The manifest itself is not signed, only the bundle is, so the plugin's
//! "newer than me?" decision reads a version string the endpoint can make up.
//! `vet_download_url` closes that gap: the bundle URL a check came back with
//! has to be a GitHub release asset of THIS repository under a tag carrying the
//! very version the manifest claims. An endpoint can therefore only ever name
//! one of our own releases, honestly labelled — it cannot pair "9.9.9" with an
//! old bundle and its genuine (public) signature to roll a client back, and it
//! cannot point the download at some other host at all.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
// `Manager` is what puts `package_info()` and `config()` on an `AppHandle`
// (same reason menu.rs and notifications.rs import it).
use tauri::{command, AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// How long the whole check (connect + manifest fetch) may take. The manifest
/// route is one cached Convex read, so a server that has not answered in 30s is
/// down rather than slow, and the next scheduled check will pick it up.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Where an update stands between the three commands.
#[derive(Default)]
pub enum Pending {
    #[default]
    Idle,
    /// The last check found this; `Update` carries the vetted manifest entry
    /// (URL + signature) for THIS platform, so the download fetches exactly
    /// what the check resolved with no second round trip to the endpoint.
    Found(Update),
    /// A download is in flight; checks and installs are refused until it lands.
    Downloading,
    /// Downloaded and signature-verified, waiting for "Restart now".
    Ready { update: Update, bytes: Vec<u8> },
}

/// The one update slot, shared by every webview of the process.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Pending>);

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
///
/// `rename_all` on an enum renames the VARIANTS; the fields inside a struct
/// variant need `rename_all_fields` as well, or `content_length` would go over
/// the wire as-is while apps/desktop/src/updater.ts reads `contentLength`.
#[derive(Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateProgress {
    /// First chunk: `content_length` is absent when the server sent no
    /// `Content-Length` (the UI then shows an indeterminate bar).
    Started {
        content_length: Option<u64>,
    },
    Progress {
        chunk_length: usize,
    },
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

/// The host every bundle has to come from.
const RELEASE_HOST: &str = "github.com";

/// `/<owner>/<repo>/releases/download/`, from the `repository` field in
/// Cargo.toml so a fork or a rename is the same single edit it is on the web
/// side (`GITHUB_REPO_SLUG` in @owlat/shared).
fn release_path_prefix() -> String {
    let repo = env!("CARGO_PKG_REPOSITORY")
        .trim_end_matches('/')
        .strip_prefix("https://github.com")
        .expect("Cargo.toml `repository` must be a github.com URL");
    format!("{repo}/releases/download/")
}

/// Refuse a bundle URL that is not a release asset of this repository under a
/// tag matching the version the manifest claims (`v<version>` on the unified
/// line, `desktop-v<version>` on the desktop-only line).
///
/// This is what binds the unsigned `version` field — the only thing the
/// plugin's "is it newer?" check looks at — to something GitHub, not the
/// endpoint, controls. Without it an endpoint could announce "9.9.9", point at
/// an older release's bundle with that bundle's genuine signature, and roll a
/// client back; or point at any host at all and have the app buffer whatever
/// comes back before the signature check ever runs.
fn vet_download_url(url: &Url, version: &str) -> Result<(), String> {
    let refuse =
        || format!("signature: {url} is not a release asset of this app for version {version}");
    if url.scheme() != "https" || url.host_str() != Some(RELEASE_HOST) {
        return Err(refuse());
    }
    let prefix = release_path_prefix();
    let path = url.path();
    let asset = [format!("v{version}/"), format!("desktop-v{version}/")]
        .iter()
        .find_map(|tag| path.strip_prefix(&format!("{prefix}{tag}")));
    match asset {
        // A tag directory alone, or a path that keeps going, is not an asset.
        Some(name) if !name.is_empty() && !name.contains('/') => Ok(()),
        _ => Err(refuse()),
    }
}

fn info_of(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|d| d.unix_timestamp()),
    }
}

const ALREADY_DOWNLOADING: &str = "unknown: an update is already downloading";

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
/// instance holding the fleet back, or simply no newer release). An update
/// that is already downloaded is reported again without asking anyone — the
/// running binary still says the old version, so an endpoint would only offer
/// the same release a second time — and a download in flight is left alone.
#[command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
    endpoint: Option<String>,
) -> Result<Option<UpdateInfo>, String> {
    {
        let pending = state.0.lock().map_err(|_| poisoned())?;
        if let Pending::Ready { update, .. } = &*pending {
            return Ok(Some(info_of(update)));
        }
        if matches!(*pending, Pending::Downloading) {
            return Err(ALREADY_DOWNLOADING.to_string());
        }
    }

    let ua = user_agent(&app.package_info().version.to_string());
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    builder = builder.header("User-Agent", ua).map_err(updater_error)?;
    if let Some(raw) = endpoint {
        let url = parse_endpoint(&raw)?;
        builder = builder.endpoints(vec![url]).map_err(updater_error)?;
    }

    let updater = builder.build().map_err(updater_error)?;
    let checked = updater
        .check()
        .await
        .map_err(updater_error)
        .and_then(|found| match found {
            Some(update) => {
                vet_download_url(&update.download_url, &update.version)?;
                Ok(Some(update))
            }
            None => Ok(None),
        });

    let mut pending = state.0.lock().map_err(|_| poisoned())?;
    // Another webview may have got ahead while this check was on the wire.
    if let Pending::Ready { update, .. } = &*pending {
        return Ok(Some(info_of(update)));
    }
    if matches!(*pending, Pending::Downloading) {
        return Err(ALREADY_DOWNLOADING.to_string());
    }
    match checked {
        Ok(found) => {
            let info = found.as_ref().map(info_of);
            *pending = found.map_or(Pending::Idle, Pending::Found);
            Ok(info)
        }
        Err(e) => {
            *pending = Pending::Idle;
            Err(e)
        }
    }
}

/// Download and verify the update the last check found, reporting progress.
/// The bytes stay in the slot for `updater_restart`; nothing is installed yet.
///
/// A failed download leaves nothing behind to retry, so the webview re-checks
/// (cheap — one cached read) rather than reusing a manifest entry whose
/// download already went wrong. An update that is already downloaded is
/// reported as finished straight away, so a webview that boots into a ready
/// slot (a workspace switch reloads it) converges on "ready" without a second
/// download.
#[command]
pub async fn updater_install(
    state: State<'_, PendingUpdate>,
    on_event: Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = {
        let mut pending = state.0.lock().map_err(|_| poisoned())?;
        match std::mem::take(&mut *pending) {
            Pending::Found(update) => {
                *pending = Pending::Downloading;
                update
            }
            Pending::Ready { update, bytes } => {
                let size = bytes.len();
                *pending = Pending::Ready { update, bytes };
                let _ = on_event.send(UpdateProgress::Started {
                    content_length: Some(size as u64),
                });
                let _ = on_event.send(UpdateProgress::Progress { chunk_length: size });
                let _ = on_event.send(UpdateProgress::Finished);
                return Ok(());
            }
            Pending::Downloading => {
                *pending = Pending::Downloading;
                return Err(ALREADY_DOWNLOADING.to_string());
            }
            Pending::Idle => return Err("unknown: no update is ready to install".to_string()),
        }
    };

    // The plugin reports the total length on every chunk; the UI wants it once,
    // up front, so the first chunk doubles as the "download started" event.
    let progress = on_event.clone();
    let mut started = false;
    let on_chunk = move |chunk_length: usize, content_length: Option<u64>| {
        if !started {
            started = true;
            let _ = progress.send(UpdateProgress::Started { content_length });
        }
        let _ = progress.send(UpdateProgress::Progress { chunk_length });
    };
    let on_finish = move || {
        let _ = on_event.send(UpdateProgress::Finished);
    };

    // Verified against the minisign key inside `download`; an unsigned or
    // mislabelled bundle never reaches the slot.
    let downloaded = update
        .download(on_chunk, on_finish)
        .await
        .map_err(updater_error);

    let mut pending = state.0.lock().map_err(|_| poisoned())?;
    match downloaded {
        Ok(bytes) => {
            *pending = Pending::Ready { update, bytes };
            Ok(())
        }
        Err(e) => {
            *pending = Pending::Idle;
            Err(e)
        }
    }
}

/// Install the downloaded update and relaunch into it.
///
/// macOS and Linux: the plugin replaces the bundle (the AppImage in place; deb
/// and rpm through the system package manager, which may ask for a password
/// here) and `restart()` starts the new binary. Windows: the plugin launches
/// the NSIS/MSI installer and exits this process itself; the installer
/// relaunches the app when it is done, so `restart()` is never reached there.
/// Either way the process only ends because the user asked for it.
///
/// Consumes the slot: a failed install is reported and the next check starts
/// over rather than retrying bytes that already went wrong on disk.
#[command]
pub async fn updater_restart(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let (update, bytes) = {
        let mut pending = state.0.lock().map_err(|_| poisoned())?;
        match std::mem::take(&mut *pending) {
            Pending::Ready { update, bytes } => (update, bytes),
            other => {
                *pending = other;
                return Err("unknown: no update is ready to install".to_string());
            }
        }
    };
    update.install(bytes).map_err(updater_error)?;
    app.restart()
}

// ── "Update ready" notification ────────────────────────────────────────────
//
// Same split as notifications.rs: the notification plugin only renders action
// buttons on mobile, so the Restart-now action is driven through the native
// crates directly (mac-notification-sys on macOS, notify-rust on Linux, both
// already dependencies). Windows falls back to a plain notification and the
// in-app "Restart now" button on the device page, which on Windows hands over
// to the installer (see `updater_restart`). The action is delivered to the
// webview as an `updater-action` event rather than restarting from here, so
// the restart always runs through the same command path the button uses.

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
    use super::{
        classify_error, parse_endpoint, release_path_prefix, updater_error, user_agent,
        vet_download_url, UpdateProgress,
    };
    use tauri::Url;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// A release asset URL as tauri-action publishes them in `latest.json`.
    fn asset(tag: &str, name: &str) -> Url {
        url(&format!(
            "https://github.com/wolvesdotink/owlat/releases/download/{tag}/{name}"
        ))
    }

    #[test]
    fn release_path_prefix_comes_from_the_cargo_repository_field() {
        let prefix = release_path_prefix();
        assert_eq!(prefix, "/wolvesdotink/owlat/releases/download/");
    }

    #[test]
    fn bundle_url_must_be_a_release_asset_under_a_tag_carrying_the_claimed_version() {
        let unified = asset("v0.4.7", "Owlat.app.tar.gz");
        assert!(vet_download_url(&unified, "0.4.7").is_ok());
        let desktop_line = asset("desktop-v0.4.7", "Owlat_0.4.7_amd64.AppImage");
        assert!(vet_download_url(&desktop_line, "0.4.7").is_ok());
        let rc = asset("v0.5.0-rc.1", "Owlat.app.tar.gz");
        assert!(vet_download_url(&rc, "0.5.0-rc.1").is_ok());
    }

    #[test]
    fn bundle_url_naming_another_release_is_refused_as_a_signature_problem() {
        // The rollback: "9.9.9" announced, an old bundle (with its genuine,
        // public signature) named. The tag does not carry the claimed version.
        let old = asset("v0.4.0", "Owlat.app.tar.gz");
        let err = vet_download_url(&old, "9.9.9").unwrap_err();
        assert!(err.starts_with("signature: "), "{err}");
        assert_eq!(classify_error(&err), "signature");
        // A tag that merely starts with the version is not the version.
        let longer = asset("v0.4.70", "x.tar.gz");
        assert!(vet_download_url(&longer, "0.4.7").is_err());
    }

    #[test]
    fn bundle_url_off_github_or_off_this_repository_is_refused() {
        let releases = "https://github.com/wolvesdotink/owlat/releases/download";
        for bad in [
            "https://attacker.example/blob".to_string(),
            "http://192.168.1.1:8080/blob".to_string(),
            "https://objects.githubusercontent.com/x/v0.4.7/Owlat.app.tar.gz".to_string(),
            "https://github.com/someone-else/owlat/releases/download/v0.4.7/x.tar.gz".to_string(),
            format!("{releases}/v0.4.7/"),
            format!("{releases}/v0.4.7/nested/x.tar.gz"),
            "https://github.com/wolvesdotink/owlat/archive/v0.4.7.tar.gz".to_string(),
        ] {
            assert!(vet_download_url(&url(&bad), "0.4.7").is_err(), "{bad}");
        }
    }

    #[test]
    fn progress_events_cross_the_ipc_boundary_in_camel_case() {
        // The webview (apps/desktop/src/updater.ts) reads `contentLength` and
        // `chunkLength`; a snake_case field would leave the progress bar at NaN.
        let sized = UpdateProgress::Started {
            content_length: Some(1),
        };
        let unknown_size = UpdateProgress::Started {
            content_length: None,
        };
        let progress = UpdateProgress::Progress { chunk_length: 40 };
        assert_eq!(
            serde_json::to_string(&sized).unwrap(),
            r#"{"kind":"started","contentLength":1}"#
        );
        assert_eq!(
            serde_json::to_string(&unknown_size).unwrap(),
            r#"{"kind":"started","contentLength":null}"#
        );
        assert_eq!(
            serde_json::to_string(&progress).unwrap(),
            r#"{"kind":"progress","chunkLength":40}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateProgress::Finished).unwrap(),
            r#"{"kind":"finished"}"#
        );
    }

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
