//! Global (system-wide) keyboard shortcuts.
//!
//! Only combos that make sense from outside the app are registered globally
//! (show/hide toggle, quick-compose) — a global hotkey fires and swallows the
//! keystroke regardless of which app is focused, so common in-app shortcuts
//! like Cmd+K must NOT be registered here. The command palette handles
//! Cmd/Ctrl+K itself inside the webview (AppCommandPalette.vue).

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window;

/// CmdOrCtrl, per platform (Cmd on macOS, Ctrl elsewhere).
fn primary() -> Modifiers {
    #[cfg(target_os = "macos")]
    {
        Modifiers::SUPER
    }
    #[cfg(not(target_os = "macos"))]
    {
        Modifiers::CONTROL
    }
}

fn compose_shortcut() -> Shortcut {
    Shortcut::new(Some(primary() | Modifiers::SHIFT), Code::KeyC)
}

fn toggle_shortcut() -> Shortcut {
    Shortcut::new(Some(primary() | Modifiers::SHIFT), Code::KeyO)
}

/// Handler passed to the plugin builder; dispatches on the pressed shortcut.
pub fn handle(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }

    if shortcut == &toggle_shortcut() {
        if let Some(w) = app.get_webview_window("main") {
            if w.is_visible().unwrap_or(false) {
                let _ = w.hide();
            } else {
                window::show_main_window(app);
            }
        }
    } else if shortcut == &compose_shortcut() {
        window::open_compose_window(app, "/compose");
    }
}

/// Register the global shortcuts. Registration silently no-ops if a combo is
/// already taken by another app.
pub fn register_global_shortcuts(app: &AppHandle) {
    let gs = app.global_shortcut();
    for sc in [toggle_shortcut(), compose_shortcut()] {
        let _ = gs.register(sc);
    }
}
