//! The tray icon: a menu bar extra on macOS, a notification-area icon on
//! Windows and Linux.
//!
//! It shows the unread count and a menu with the newest unread messages and
//! the app's quick verbs. The content comes from the main window's SPA
//! (`update_tray`), which owns the unread peek; a new document in the main
//! window (a reload, a workspace switch) clears it until that page reports.
//!
//! Whether the icon is shown, and whether closing the main window keeps the
//! app running in it, are device settings the SPA owns (`settings.json`, see
//! apps/web lib/desktop/settingsTypes.ts). They are read from that file at
//! launch, so a close before the SPA has booted already follows them, and the
//! SPA pushes every later change (`set_tray_preferences`).
//!
//! The labels are English, like the native application menu (menu.rs).

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    command,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{notifications, window};

const TRAY_ID: &str = "owlat";

/// The settings file the SPA writes through tauri-plugin-store, and the key it
/// keeps its state under (apps/desktop src/settings.ts).
const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_KEY: &str = "state";

/// How many unread messages the menu lists. The SPA's unread peek carries the
/// same number.
const MAX_MESSAGES: usize = 5;

/// A menu row is one line; longer text is cut with an ellipsis.
const MAX_LABEL_CHARS: usize = 60;

/// Menu ids. A message row carries its message id after the prefix, so a click
/// on a row of a menu that has since been replaced still opens that message.
const ID_MESSAGE_PREFIX: &str = "tray:message:";
const ID_SHOW: &str = "tray:show";
const ID_COMPOSE: &str = "tray:compose";
const ID_PAUSE: &str = "tray:pause";
const ID_QUIT: &str = "tray:quit";

/// Asks the SPA to flip its "notifications enabled" setting. The SPA pushes
/// the new state back through `update_tray`.
const TOGGLE_NOTIFICATIONS_EVENT: &str = "tray://toggle-notifications";

/// One unread message as the menu lists it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrayMessage {
    pub message_id: String,
    pub sender: String,
    pub subject: String,
}

/// What the SPA last reported.
#[derive(Clone, Default)]
struct TrayContent {
    /// `None` until a page with a workspace reports its count.
    unread: Option<u32>,
    messages: Vec<TrayMessage>,
    /// The workspace the messages belong to; a click opens the message there.
    workspace_id: Option<String>,
    notifications_paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrayPreferences {
    pub visible: bool,
    /// Windows and Linux: closing the main window hides it to the tray. macOS
    /// always hides it (window.rs) and ignores this.
    pub close_to_tray: bool,
}

impl Default for TrayPreferences {
    fn default() -> Self {
        Self {
            visible: true,
            close_to_tray: true,
        }
    }
}

#[derive(Default)]
pub struct TrayState(Mutex<TrayStateInner>);

#[derive(Default)]
struct TrayStateInner {
    content: TrayContent,
    preferences: TrayPreferences,
}

/// The tray preferences in the SPA's settings value. A missing or malformed
/// field keeps its default, the way the SPA's own `normalizeDesktopSettings`
/// reads the file.
pub fn preferences_from_settings(settings: &serde_json::Value) -> TrayPreferences {
    let global = &settings[SETTINGS_KEY]["global"];
    let defaults = TrayPreferences::default();
    TrayPreferences {
        visible: global["showTrayIcon"].as_bool().unwrap_or(defaults.visible),
        close_to_tray: global["closeToTray"]
            .as_bool()
            .unwrap_or(defaults.close_to_tray),
    }
}

fn load_preferences(app: &AppHandle) -> TrayPreferences {
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read(dir.join(SETTINGS_FILE)).ok())
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .map(|settings| preferences_from_settings(&settings))
        .unwrap_or_default()
}

/// The first menu row: what the icon is counting.
fn count_label(unread: Option<u32>) -> String {
    match unread {
        None => "Owlat".to_string(),
        Some(0) => "No unread mail".to_string(),
        Some(1) => "1 unread message".to_string(),
        Some(n) => format!("{n} unread messages"),
    }
}

/// The text next to the icon (macOS menu bar, Linux panels that show
/// indicator labels). Nothing when there is nothing unread.
fn count_title(unread: Option<u32>) -> Option<String> {
    match unread {
        Some(n) if n > 999 => Some("999+".to_string()),
        Some(n) if n > 0 => Some(n.to_string()),
        _ => None,
    }
}

/// Windows shows no title, so the count goes into the tooltip.
fn tooltip(unread: Option<u32>) -> String {
    match unread {
        Some(n) if n > 0 => format!("Owlat: {}", count_label(Some(n))),
        _ => "Owlat".to_string(),
    }
}

/// A menu row for text that came out of the mail: one line, cut to length,
/// and with `&` escaped, because the menu reads a single `&` as a mnemonic
/// marker on every platform.
fn literal_label(text: &str) -> String {
    let line: String = text
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let cut = if line.chars().count() > MAX_LABEL_CHARS {
        let kept: String = line.chars().take(MAX_LABEL_CHARS - 1).collect();
        format!("{}…", kept.trim_end())
    } else {
        line
    };
    cut.replace('&', "&&")
}

fn message_label(message: &TrayMessage) -> String {
    let subject = message.subject.trim();
    let subject = if subject.is_empty() {
        "(no subject)"
    } else {
        subject
    };
    literal_label(&format!("{}: {subject}", message.sender.trim()))
}

fn build_menu(app: &AppHandle, content: &TrayContent) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "tray:count",
        count_label(content.unread),
        false,
        None::<&str>,
    )?)?;
    if !content.messages.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for message in content.messages.iter().take(MAX_MESSAGES) {
            menu.append(&MenuItem::with_id(
                app,
                format!("{ID_MESSAGE_PREFIX}{}", message.message_id),
                message_label(message),
                true,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        ID_SHOW,
        "Open Owlat",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        ID_COMPOSE,
        "New Message",
        true,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        ID_PAUSE,
        "Pause Notifications",
        true,
        content.notifications_paused,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        ID_QUIT,
        "Quit Owlat",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Repaint the icon's menu, title and tooltip from the stored content. The
/// lock is released first: menu and tray calls run on the main thread, which
/// may itself be waiting for the lock in a menu click.
fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let Some(content) = app
        .state::<TrayState>()
        .0
        .lock()
        .ok()
        .map(|inner| inner.content.clone())
    else {
        return;
    };
    if let Ok(menu) = build_menu(app, &content) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_title(count_title(content.unread));
    let _ = tray.set_tooltip(Some(tooltip(content.unread)));
}

/// Build the icon. On Linux the tray library loads libappindicator at run time
/// and panics when it is missing, which must not take the app down with it:
/// the app then runs without a tray, and closing the window quits it.
fn build_tray(app: &AppHandle) -> bool {
    let build = || -> tauri::Result<()> {
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Owlat")
            .menu(&build_menu(app, &TrayContent::default())?)
            // Windows: a left click opens the window and a right click the
            // menu, like other tray apps there. macOS opens the menu on
            // either; Linux reports no clicks and always opens the menu.
            .show_menu_on_left_click(!cfg!(windows))
            .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if cfg!(windows) {
                        window::show_main_window(tray.app_handle());
                    }
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(build)) {
        Ok(Ok(())) => true,
        Ok(Err(e)) => {
            eprintln!("[tray] could not create the tray icon: {e}");
            false
        }
        Err(_) => {
            eprintln!("[tray] the tray icon is unavailable on this system");
            false
        }
    }
}

/// Show or hide the icon, creating it the first time it is shown.
fn apply_visibility(app: &AppHandle, visible: bool) {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => {
            let _ = tray.set_visible(visible);
        }
        None if visible => {
            if build_tray(app) {
                refresh(app);
            }
        }
        None => {}
    }
}

/// Read the stored preferences and create the icon if it is enabled. Call from
/// `setup`, on the main thread.
pub fn setup(app: &AppHandle) {
    let preferences = load_preferences(app);
    if let Ok(mut inner) = app.state::<TrayState>().0.lock() {
        inner.preferences = preferences;
    }
    apply_visibility(app, preferences.visible);
}

/// Whether closing the main window should hide it rather than quit (Windows
/// and Linux; see window.rs). Only while the icon is on screen: otherwise
/// nothing would be left to bring the window back.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn keeps_running_on_close(app: &AppHandle) -> bool {
    let preferences = app
        .state::<TrayState>()
        .0
        .lock()
        .map(|inner| inner.preferences)
        .unwrap_or_default();
    preferences.visible && preferences.close_to_tray && app.tray_by_id(TRAY_ID).is_some()
}

/// A new document started loading in the main window: what the last page
/// reported may belong to another workspace or to a signed-out session.
pub fn clear_content(app: &AppHandle) {
    if let Ok(mut inner) = app.state::<TrayState>().0.lock() {
        inner.content = TrayContent::default();
    }
    refresh(app);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(message_id) = id.strip_prefix(ID_MESSAGE_PREFIX) {
        let workspace_id = app
            .state::<TrayState>()
            .0
            .lock()
            .ok()
            .and_then(|inner| inner.content.workspace_id.clone());
        window::show_main_window(app);
        // The same event a clicked notification sends, so the SPA's routing
        // opens it, in its own workspace if the user has switched since.
        notifications::emit_open_message(app, message_id.to_string(), workspace_id);
        return;
    }
    match id {
        ID_SHOW => window::show_main_window(app),
        ID_COMPOSE => {
            window::open_compose_window(app, "/compose");
        }
        ID_PAUSE => {
            let _ = app.emit(TOGGLE_NOTIFICATIONS_EVENT, ());
        }
        ID_QUIT => app.exit(0),
        _ => {}
    }
}

/// Command: the main window's unread state. `unread` is `None` when the page
/// has no count to show.
#[command]
pub fn update_tray(
    app: AppHandle,
    unread: Option<u32>,
    messages: Vec<TrayMessage>,
    workspace_id: Option<String>,
    notifications_paused: bool,
) {
    if let Ok(mut inner) = app.state::<TrayState>().0.lock() {
        inner.content = TrayContent {
            unread,
            messages: messages.into_iter().take(MAX_MESSAGES).collect(),
            workspace_id: workspace_id.filter(|id| !id.is_empty()),
            notifications_paused,
        };
    }
    refresh(&app);
}

/// Command: the device settings for the icon changed.
#[command]
pub fn set_tray_preferences(app: AppHandle, visible: bool, close_to_tray: bool) {
    if let Ok(mut inner) = app.state::<TrayState>().0.lock() {
        inner.preferences = TrayPreferences {
            visible,
            close_to_tray,
        };
    }
    apply_visibility(&app, visible);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preferences_default_to_a_visible_icon_that_keeps_the_app_running() {
        assert_eq!(
            preferences_from_settings(&json!(null)),
            TrayPreferences::default()
        );
        assert_eq!(
            preferences_from_settings(&json!({ "state": { "global": {} } })),
            TrayPreferences {
                visible: true,
                close_to_tray: true
            }
        );
    }

    #[test]
    fn preferences_are_read_from_the_spa_settings() {
        let settings = json!({
            "state": { "version": 1, "global": { "showTrayIcon": false, "closeToTray": false } }
        });
        assert_eq!(
            preferences_from_settings(&settings),
            TrayPreferences {
                visible: false,
                close_to_tray: false
            }
        );
    }

    #[test]
    fn a_malformed_preference_keeps_its_default() {
        let settings = json!({
            "state": { "global": { "showTrayIcon": "no", "closeToTray": false } }
        });
        assert_eq!(
            preferences_from_settings(&settings),
            TrayPreferences {
                visible: true,
                close_to_tray: false
            }
        );
    }

    #[test]
    fn the_count_reads_as_a_sentence_and_a_short_title() {
        assert_eq!(count_label(None), "Owlat");
        assert_eq!(count_label(Some(0)), "No unread mail");
        assert_eq!(count_label(Some(1)), "1 unread message");
        assert_eq!(count_label(Some(12)), "12 unread messages");
        assert_eq!(count_title(None), None);
        assert_eq!(count_title(Some(0)), None);
        assert_eq!(count_title(Some(7)).as_deref(), Some("7"));
        assert_eq!(count_title(Some(1000)).as_deref(), Some("999+"));
        assert_eq!(tooltip(Some(0)), "Owlat");
        assert_eq!(tooltip(Some(3)), "Owlat: 3 unread messages");
    }

    #[test]
    fn mail_text_becomes_one_literal_line() {
        assert_eq!(literal_label("Tom & Jerry"), "Tom && Jerry");
        assert_eq!(literal_label("Line one\r\n\tline two"), "Line one line two");
        let long = "x".repeat(MAX_LABEL_CHARS + 10);
        let cut = literal_label(&long);
        assert_eq!(cut.chars().count(), MAX_LABEL_CHARS);
        assert!(cut.ends_with('…'));
        // Characters, not bytes: a multibyte subject is cut on a boundary.
        let wide = "ü".repeat(MAX_LABEL_CHARS + 1);
        assert_eq!(literal_label(&wide).chars().count(), MAX_LABEL_CHARS);
    }

    #[test]
    fn a_message_row_names_the_sender_and_subject() {
        let message = TrayMessage {
            message_id: "m1".into(),
            sender: "Ada Lovelace".into(),
            subject: "Notes on the engine".into(),
        };
        assert_eq!(message_label(&message), "Ada Lovelace: Notes on the engine");
        let blank = TrayMessage {
            subject: "  ".into(),
            ..message
        };
        assert_eq!(message_label(&blank), "Ada Lovelace: (no subject)");
    }
}
