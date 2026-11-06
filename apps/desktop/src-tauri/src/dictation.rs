//! Dictation that stays on this device: speech to text for the composer's and
//! the AI bar's mic, for webviews whose own speech engine would send the audio
//! to a cloud service.
//!
//! macOS runs the Speech framework's recognizer with on-device recognition
//! required (macos.rs), so the audio never leaves the Mac. A language without
//! an on-device model reports unavailable, and the SPA keeps its mic hidden.
//! Windows and Linux always report unavailable: WebView2's speech recognition
//! is a Microsoft cloud service, and WebKitGTK has none.
//!
//! There is one session at a time, app-wide, since there is one microphone:
//! starting one ends the one before. `dictation_start` returns the session's
//! id, and stop and cancel act only on that id, so one window's late stop
//! cannot end another window's session (session.rs). A session also ends when
//! its webview navigates, or its window closes or hides (`release`), so a page
//! that went away or out of sight never leaves the microphone open.

#[cfg(target_os = "macos")]
mod macos;
mod model;
mod session;

pub use model::DictationEvent;

use tauri::ipc::Channel;
use tauri::{command, AppHandle, Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
fn on_main<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(task());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// Whether `lang` (a BCP 47 tag, `navigator.language`) can be dictated on
/// this device.
#[command]
pub fn dictation_available<R: Runtime>(app: AppHandle<R>, lang: String) -> bool {
    if model::language(&lang).is_none() {
        return false;
    }
    #[cfg(target_os = "macos")]
    return on_main(&app, move || macos::available(&lang)).unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// Start listening in `lang`; what is heard arrives on `on_event`. Returns the
/// session id for `dictation_stop` and `dictation_cancel`.
#[command]
pub fn dictation_start<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    lang: String,
    on_event: Channel<DictationEvent>,
) -> Result<u64, String> {
    if model::language(&lang).is_none() {
        return Err("unsupported language tag".into());
    }
    #[cfg(target_os = "macos")]
    {
        let owner = window.label().to_string();
        let hop = app.clone();
        let main: macos::MainThread = std::sync::Arc::new(move |task: Box<dyn FnOnce() + Send>| {
            let _ = hop.run_on_main_thread(task);
        });
        on_main(&app, move || {
            let emit: macos::Emit = std::rc::Rc::new(move |event: DictationEvent| {
                let _ = on_event.send(event);
            });
            macos::start(owner, lang, emit, main)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, on_event);
        Err(UNAVAILABLE.into())
    }
}

/// Stop listening; what was heard still arrives, then the session ends.
#[command]
pub fn dictation_stop<R: Runtime>(app: AppHandle<R>, session: u64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return on_main(&app, move || macos::stop(session));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
        Ok(())
    }
}

/// Stop listening and drop what was not delivered yet.
#[command]
pub fn dictation_cancel<R: Runtime>(app: AppHandle<R>, session: u64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return on_main(&app, move || macos::cancel(session));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, session);
        Ok(())
    }
}

/// End the session of the webview `label`: it navigated, or its window closed
/// or hid. A hidden window's page stays loaded, so it hears `End` and resets
/// its mic. Runs right away on the main thread, and is queued for it from any
/// other.
pub fn release<R: Runtime>(app: &AppHandle<R>, label: &str) {
    #[cfg(target_os = "macos")]
    {
        let label = label.to_owned();
        let _ = app.run_on_main_thread(move || macos::release(&label));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label);
}

#[cfg(not(target_os = "macos"))]
const UNAVAILABLE: &str = "dictation is not available on this platform";

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use tauri::ipc::Channel;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    #[test]
    fn other_platforms_offer_no_dictation() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let app = app.handle().clone();
        assert!(!super::dictation_available(app.clone(), "en-US".into()));
        let events = Channel::new(|_| Ok(()));
        assert!(super::dictation_start(app.clone(), window, "en-US".into(), events).is_err());
        assert!(super::dictation_stop(app.clone(), 1).is_ok());
        assert!(super::dictation_cancel(app, 1).is_ok());
    }
}
