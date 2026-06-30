use tauri::{command, AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Sets up close-to-tray behavior: hides the window instead of quitting.
/// On macOS, this also hides the dock icon when the window is not visible.
pub fn setup_close_handler(app: &AppHandle) {
    let app_handle = app.clone();
    if let Some(window) = app_handle.get_webview_window("main") {
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the window from being destroyed
                api.prevent_close();
                // Hide the window instead
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
        });
    }
}

/// Shows the main window, bringing it to focus.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Navigate the main window to a specific path.
/// Uses window.location.pathname assignment for Nuxt's file-based routing.
pub fn navigate_to(window: &WebviewWindow, path: &str) {
    let js = format!(
        "if (window.__NUXT_ROUTER__) {{ window.__NUXT_ROUTER__.push('{}') }} else {{ window.location.pathname = '{}' }}",
        path, path
    );
    let _ = window.eval(&js);
}

/// Open (or focus) the dedicated compose window at `path` (e.g. "/compose" or
/// "/compose?to=…&subject=…"). Reusing an existing window full-navigates it to
/// the new path so a fresh mailto seed takes effect.
pub fn open_compose_window(app: &AppHandle, path: &str) {
    if let Some(win) = app.get_webview_window("compose") {
        let safe = path.replace('\'', "");
        let _ = win.eval(&format!("window.location.assign('{}')", safe));
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    // WebviewUrl::App paths are app-relative — drop any leading slash.
    let rel = path.trim_start_matches('/');
    let _ = WebviewWindowBuilder::new(app, "compose", WebviewUrl::App(rel.into()))
        .title("Compose — Owlat")
        .inner_size(720.0, 640.0)
        .min_inner_size(480.0, 380.0)
        .resizable(true)
        .build();
}

/// Command: open the compose window. Invoked from the SPA (mailto handling).
#[command]
pub fn open_compose(app: AppHandle, path: Option<String>) {
    open_compose_window(&app, &path.unwrap_or_else(|| "/compose".to_string()));
}
