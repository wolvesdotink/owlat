//! The tray icon: a menu bar extra on macOS, a notification-area icon on
//! Windows and Linux.
//!
//! It shows the unread count and a menu with the newest unread messages and
//! the app's quick verbs. The content comes from the main window's SPA
//! (`update_tray`), which owns the unread peek; a new document in the main
//! window (a reload, a workspace switch) clears it until that page reports.
//!
//! Whether the icon is shown, whether closing the main window keeps the app
//! running in it, and on macOS whether the Dock icon is hidden, are device
//! settings the SPA owns (`settings.json`, see
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
const ID_CHECK: &str = "tray:check";
const ID_PAUSE: &str = "tray:pause";
const ID_QUIT: &str = "tray:quit";

/// Asks the SPA to flip its "notifications enabled" setting. The SPA pushes
/// the new state back through `update_tray`.
const TOGGLE_NOTIFICATIONS_EVENT: &str = "tray://toggle-notifications";

/// Asks the SPA to have the mail-sync worker sync the connected accounts now.
/// The SPA holds the session the request needs.
const CHECK_MAIL_EVENT: &str = "tray://check-mail";

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
    /// macOS: the app leaves the Dock and runs from the menu bar icon alone.
    /// Only honoured while that icon is on screen (`hides_dock_icon`).
    pub hide_dock_icon: bool,
}

impl Default for TrayPreferences {
    fn default() -> Self {
        Self {
            visible: true,
            close_to_tray: true,
            hide_dock_icon: false,
        }
    }
}

/// Whether the Dock icon goes away. Without the menu bar icon nothing would be
/// left on screen to bring the app back, so hiding the tray icon, or a tray
/// that could not be created, keeps the Dock icon whatever the setting says.
pub fn hides_dock_icon(preferences: TrayPreferences, tray_exists: bool) -> bool {
    preferences.hide_dock_icon && preferences.visible && tray_exists
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
        hide_dock_icon: global["hideDockIcon"]
            .as_bool()
            .unwrap_or(defaults.hide_dock_icon),
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

/// The verbs below the message rows, in menu order: id and label. A check item
/// (Pause Notifications) follows them.
const VERBS: [(&str, &str); 3] = [
    (ID_SHOW, "Open Owlat"),
    (ID_COMPOSE, "New Message"),
    (ID_CHECK, "Check for Mail"),
];

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
    for (id, label) in VERBS {
        menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
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

/// Show or hide the icon, creating it the first time it is shown, then give
/// the Dock icon the state that goes with it.
fn apply_preferences(app: &AppHandle, preferences: TrayPreferences) {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => {
            let _ = tray.set_visible(preferences.visible);
        }
        None if preferences.visible => {
            if build_tray(app) {
                refresh(app);
            }
        }
        None => {}
    }
    apply_dock_icon(
        app,
        hides_dock_icon(preferences, app.tray_by_id(TRAY_ID).is_some()),
    );
}

/// macOS: an accessory app has no Dock icon, and macOS shows no menu bar for
/// it. At launch the app starts as a regular one and switches here, so the
/// Dock icon shows briefly before it goes.
#[cfg(target_os = "macos")]
fn apply_dock_icon(app: &AppHandle, hidden: bool) {
    let policy = if hidden {
        tauri::ActivationPolicy::Accessory
    } else {
        tauri::ActivationPolicy::Regular
    };
    if let Err(e) = app.set_activation_policy(policy) {
        eprintln!("[tray] could not change the Dock icon: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_dock_icon(_app: &AppHandle, _hidden: bool) {}

/// Read the stored preferences and create the icon if it is enabled. Call from
/// `setup`, on the main thread.
pub fn setup(app: &AppHandle) {
    let preferences = load_preferences(app);
    if let Ok(mut inner) = app.state::<TrayState>().0.lock() {
        inner.preferences = preferences;
    }
    apply_preferences(app, preferences);
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

/// What a click on a menu row does.
#[derive(Debug, PartialEq)]
enum TrayAction<'a> {
    OpenMessage(&'a str),
    Show,
    Compose,
    CheckMail,
    TogglePause,
    Quit,
}

fn tray_action(id: &str) -> Option<TrayAction<'_>> {
    if let Some(message_id) = id.strip_prefix(ID_MESSAGE_PREFIX) {
        return Some(TrayAction::OpenMessage(message_id));
    }
    match id {
        ID_SHOW => Some(TrayAction::Show),
        ID_COMPOSE => Some(TrayAction::Compose),
        ID_CHECK => Some(TrayAction::CheckMail),
        ID_PAUSE => Some(TrayAction::TogglePause),
        ID_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match tray_action(id) {
        Some(TrayAction::OpenMessage(message_id)) => {
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
        }
        Some(TrayAction::Show) => window::show_main_window(app),
        Some(TrayAction::Compose) => {
            window::open_compose_window(app, "/compose");
        }
        // The main window's SPA answers it even while the window is hidden to
        // the tray, so the check runs without bringing the window up.
        Some(TrayAction::CheckMail) => {
            let _ = app.emit(CHECK_MAIL_EVENT, ());
        }
        Some(TrayAction::TogglePause) => {
            let _ = app.emit(TOGGLE_NOTIFICATIONS_EVENT, ());
        }
        Some(TrayAction::Quit) => app.exit(0),
        None => {}
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

/// Command: the device settings for the icon changed. A shell older than the
/// SPA's `hideDockIcon` never sees it; an SPA older than this shell sends none
/// and keeps the Dock icon.
#[command]
pub fn set_tray_preferences(
    app: AppHandle,
    visible: bool,
    close_to_tray: bool,
    hide_dock_icon: Option<bool>,
) {
    let preferences = TrayPreferences {
        visible,
        close_to_tray,
        hide_dock_icon: hide_dock_icon.unwrap_or(false),
    };
    if let Ok(mut inner) = app.state::<TrayState>().0.lock() {
        inner.preferences = preferences;
    }
    apply_preferences(&app, preferences);
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
                close_to_tray: true,
                hide_dock_icon: false
            }
        );
    }

    #[test]
    fn preferences_are_read_from_the_spa_settings() {
        let settings = json!({
            "state": { "version": 1, "global": {
                "showTrayIcon": false, "closeToTray": false, "hideDockIcon": true
            } }
        });
        assert_eq!(
            preferences_from_settings(&settings),
            TrayPreferences {
                visible: false,
                close_to_tray: false,
                hide_dock_icon: true
            }
        );
    }

    #[test]
    fn a_malformed_preference_keeps_its_default() {
        let settings = json!({
            "state": { "global": { "showTrayIcon": "no", "closeToTray": false, "hideDockIcon": 1 } }
        });
        assert_eq!(
            preferences_from_settings(&settings),
            TrayPreferences {
                visible: true,
                close_to_tray: false,
                hide_dock_icon: false
            }
        );
    }

    #[test]
    fn the_dock_icon_hides_only_while_the_tray_icon_is_there() {
        let hide = TrayPreferences {
            hide_dock_icon: true,
            ..TrayPreferences::default()
        };
        assert!(hides_dock_icon(hide, true));
        // No way back to the app without one of the two icons.
        assert!(!hides_dock_icon(hide, false));
        assert!(!hides_dock_icon(
            TrayPreferences {
                visible: false,
                ..hide
            },
            true
        ));
        assert!(!hides_dock_icon(TrayPreferences::default(), true));
    }

    #[test]
    fn the_menu_offers_check_for_mail_after_new_message() {
        let ids: Vec<&str> = VERBS.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, [ID_SHOW, ID_COMPOSE, ID_CHECK]);
        assert_eq!(VERBS[2].1, "Check for Mail");
        assert_eq!(tray_action(ID_CHECK), Some(TrayAction::CheckMail));
    }

    #[test]
    fn each_menu_row_maps_to_its_action() {
        assert_eq!(
            tray_action("tray:message:m1"),
            Some(TrayAction::OpenMessage("m1"))
        );
        assert_eq!(tray_action(ID_SHOW), Some(TrayAction::Show));
        assert_eq!(tray_action(ID_COMPOSE), Some(TrayAction::Compose));
        assert_eq!(tray_action(ID_PAUSE), Some(TrayAction::TogglePause));
        assert_eq!(tray_action(ID_QUIT), Some(TrayAction::Quit));
        assert_eq!(tray_action("tray:count"), None);
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
