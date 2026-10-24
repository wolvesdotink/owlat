//! Instrumentation for the packaged-app smoke test and the updater end-to-end
//! run (scripts/desktop-smoke.ts). Only compiled with the `e2e-fixture`
//! feature, which main.rs refuses in optimized builds, and inert unless
//! `OWLAT_E2E_REPORT=1` is set when the app starts.
//!
//! The harness cannot see inside the webview, so this reports on stdout, one
//! `owlat-e2e {json}` line per event:
//!
//!   - `boot`: the version this process runs, before any window exists;
//!   - `mounted`: the SPA mounted the welcome page (a fresh profile has no
//!     workspace). The window is revealed at splash paint, earlier than this,
//!     so the reveal alone does not prove the bundle booted;
//!   - `renderer-error`: an uncaught error, an unhandled rejection or a
//!     resource that failed to load, caught in the webview;
//!   - the update steps, when `OWLAT_E2E_UPDATE_ENDPOINT` names a manifest
//!     route: `update-found` / `no-update`, then `update-downloaded` or
//!     `update-error`, then `restarting`. The restart goes through
//!     `updater_restart`, so the relaunched binary reports its own `boot`;
//!   - `done`: the scenario is over and the app exits with status 0.
//!
//! The update steps call the very commands the webview calls (updater.rs), on
//! the same shared `PendingUpdate` slot, so signature checks, URL vetting and
//! the install are the production code paths.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Map, Value};
use tauri::ipc::Channel;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{AppHandle, Builder, Listener, Manager, Wry};

use crate::updater::{self, PendingUpdate};

/// Set to `1` to turn the instrumentation on.
const REPORT_ENV: &str = "OWLAT_E2E_REPORT";
/// The manifest route to update against, `{{target}}` placeholders included.
const ENDPOINT_ENV: &str = "OWLAT_E2E_UPDATE_ENDPOINT";
/// The event the webview probe emits; listened to app-wide.
const PROBE_EVENT: &str = "owlat-e2e";
/// The prefix scripts/desktop-smoke/report.ts parses.
const LINE_PREFIX: &str = "owlat-e2e ";

/// Runs before the page's own scripts in the main frame of every window. It
/// emits through the event plugin the default capability already grants
/// (`core:event:default`), so the instrumentation needs no IPC permission of
/// its own. Mount is detected with a MutationObserver rather than a timer: the
/// welcome page's address field inside the mounted Vue root, with the page
/// title set.
const RENDERER_PROBE: &str = r#"(() => {
	const send = (payload) => {
		try {
			window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'owlat-e2e', payload });
		} catch (_) {}
	};
	window.addEventListener('error', (event) => {
		const target = event.target;
		if (target && target !== window && (target.src || target.href)) {
			send({ event: 'renderer-error', kind: 'resource', detail: String(target.src || target.href) });
			return;
		}
		send({
			event: 'renderer-error',
			kind: 'uncaught',
			detail: `${event.message} (${event.filename}:${event.lineno})`,
		});
	}, true);
	window.addEventListener('unhandledrejection', (event) => {
		const reason = event.reason;
		send({
			event: 'renderer-error',
			kind: 'unhandled-rejection',
			detail: String((reason && reason.stack) || reason),
		});
	});
	let reported = false;
	const check = () => {
		if (reported) return;
		const root = document.getElementById('__nuxt');
		if (!root || !root.__vue_app__ || !root.querySelector('input')) return;
		if (!location.pathname.startsWith('/desktop/welcome') || !document.title) return;
		reported = true;
		observer.disconnect();
		send({ event: 'mounted', path: location.pathname, title: document.title });
	};
	const observer = new MutationObserver(check);
	observer.observe(document, { childList: true, subtree: true, characterData: true });
})();"#;

/// Adds the instrumentation when `OWLAT_E2E_REPORT=1`; otherwise the builder is
/// returned untouched and a fixture build behaves like any other debug build.
pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    if std::env::var(REPORT_ENV).as_deref() != Ok("1") {
        return builder;
    }
    builder.plugin(plugin())
}

fn plugin() -> TauriPlugin<Wry> {
    PluginBuilder::new("owlat-e2e")
        .js_init_script(RENDERER_PROBE)
        .setup(|app, _api| {
            report(
                "boot",
                json!({ "version": app.package_info().version.to_string() }),
            );
            let endpoint = std::env::var(ENDPOINT_ENV).ok();
            let started = AtomicBool::new(false);
            let handle = app.clone();
            app.listen_any(PROBE_EVENT, move |event| {
                let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(event.payload())
                else {
                    return;
                };
                // The page names only the two events it may report; anything
                // else cannot pose as a native step such as `done`.
                let name = match fields.get("event").and_then(Value::as_str) {
                    Some("mounted") => "mounted",
                    Some("renderer-error") => "renderer-error",
                    _ => "renderer-unknown",
                };
                let mounted = name == "mounted";
                report(name, Value::Object(fields));
                // A reload mounts again; the scenario runs once per process.
                if mounted && !started.swap(true, Ordering::SeqCst) {
                    let handle = handle.clone();
                    let endpoint = endpoint.clone();
                    tauri::async_runtime::spawn(run_scenario(handle, endpoint));
                }
            });
            Ok(())
        })
        .build()
}

async fn run_scenario(app: AppHandle, endpoint: Option<String>) {
    if let Some(endpoint) = endpoint {
        update(&app, endpoint).await;
    }
    report("done", json!({}));
    app.exit(0);
}

/// Check, download and install-and-restart, reporting each step. Returns when
/// the scenario ends in this process; a successful restart never returns.
async fn update(app: &AppHandle, endpoint: String) {
    let state = app.state::<PendingUpdate>();
    let found = match updater::updater_check(app.clone(), state, Some(endpoint)).await {
        Ok(found) => found,
        Err(error) => return report("update-error", error_fields("check", &error)),
    };
    let Some(info) = found else {
        let version = app.package_info().version.to_string();
        return report("no-update", json!({ "version": version }));
    };
    report(
        "update-found",
        serde_json::to_value(&info).unwrap_or(Value::Null),
    );

    let progress = Channel::new(|_| Ok(()));
    if let Err(error) = updater::updater_install(app.state::<PendingUpdate>(), progress).await {
        return report("update-error", error_fields("download", &error));
    }
    report("update-downloaded", json!({}));

    report("restarting", json!({}));
    if let Err(error) = updater::updater_restart(app.clone(), app.state::<PendingUpdate>()).await {
        report("update-error", error_fields("install", &error));
    }
}

/// Split the `<kind>: <message>` rendering of an updater error back apart.
fn error_fields(stage: &str, error: &str) -> Value {
    let (kind, message) = error.split_once(": ").unwrap_or(("unknown", error));
    json!({ "stage": stage, "kind": kind, "message": message })
}

fn report_line(event: &str, fields: Value) -> String {
    let mut line = match fields {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => Map::from_iter([("value".to_string(), other)]),
    };
    line.insert("event".to_string(), Value::from(event));
    line.insert("pid".to_string(), Value::from(std::process::id()));
    format!("{LINE_PREFIX}{}", Value::Object(line))
}

fn report(event: &str, fields: Value) {
    println!("{}", report_line(event, fields));
}

#[cfg(test)]
mod tests {
    use super::{error_fields, report_line, LINE_PREFIX};
    use serde_json::{json, Value};

    fn parse(line: &str) -> Value {
        serde_json::from_str(line.strip_prefix(LINE_PREFIX).expect("prefixed")).unwrap()
    }

    #[test]
    fn report_lines_carry_the_event_and_the_process_id() {
        let line = parse(&report_line("boot", json!({ "version": "0.6.16" })));
        assert_eq!(line["event"], "boot");
        assert_eq!(line["version"], "0.6.16");
        assert_eq!(line["pid"], std::process::id());
    }

    #[test]
    fn the_event_name_is_the_reporters_not_the_payloads() {
        let line = parse(&report_line(
            "mounted",
            json!({ "event": "spoofed", "path": "/x" }),
        ));
        assert_eq!(line["event"], "mounted");
        assert_eq!(line["path"], "/x");
    }

    #[test]
    fn updater_errors_split_into_kind_and_message() {
        let fields = error_fields("download", "signature: bad signature: x");
        assert_eq!(fields["stage"], "download");
        assert_eq!(fields["kind"], "signature");
        assert_eq!(fields["message"], "bad signature: x");
        assert_eq!(error_fields("check", "odd")["kind"], "unknown");
    }
}
