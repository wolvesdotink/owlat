use serde::Deserialize;
use tauri::{command, AppHandle, Manager};

#[derive(Deserialize)]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
}

/// Tauri command: Update the tray icon tooltip with unread count.
/// On macOS, also updates the dock badge.
#[command]
pub fn update_tray_badge(app: AppHandle, count: u32) {
    let tooltip = if count > 0 {
        format!("Owlat ({} unread)", count)
    } else {
        "Owlat".to_string()
    };

    // Update tray tooltip
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(&tooltip));
    }

    // Set the OS badge (macOS dock count, Windows taskbar overlay, Linux Unity).
    // `set_badge_count` lives on the window in Tauri 2.x (AppHandle has no
    // `set_badge_label` in 2.10).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}

/// Tauri command: Send a native OS notification.
#[command]
pub fn send_native_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Actionable notifications ───────────────────────────────────────────────
//
// The Tauri notification plugin only renders action buttons / emits action
// events on MOBILE, so we drive desktop actions through the underlying native
// crates directly: mac-notification-sys on macOS (synchronous response) and
// notify-rust's `wait_for_action` on Linux (zbus). Both block until the user
// interacts, so each runs on its own thread and emits a `notification-action`
// Tauri event the webview routes. Windows (and any other target) falls back to
// a plain notification — clicking it still focuses the app via the OS default.

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationActionEvent {
    /// "open" (notification clicked), "archive" (Archive button), or
    /// "read" (Mark read button).
    action: String,
    message_id: String,
    folder_role: String,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn emit_notification_action(app: &AppHandle, action: &str, message_id: &str, folder_role: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "notification-action",
        NotificationActionEvent {
            action: action.to_string(),
            message_id: message_id.to_string(),
            folder_role: folder_role.to_string(),
        },
    );
}

#[cfg(target_os = "macos")]
fn notify_with_actions(
    app: &AppHandle,
    title: String,
    body: String,
    message_id: String,
    folder_role: String,
) {
    use mac_notification_sys::{
        send_notification, set_application, MainButton, Notification, NotificationResponse,
    };
    let app = app.clone();
    let bundle = app.config().identifier.clone();
    std::thread::spawn(move || {
        // Shares the global the plugin's notify-rust path also sets; an
        // "already set" error is fine — it just has to be set before sending.
        let _ = set_application(&bundle);
        let mut options = Notification::new();
        // A dropdown lets us offer BOTH Archive and Mark read (macOS notifications
        // render a single main button, whose long-press/expand reveals the list).
        options.main_button(MainButton::DropdownActions(
            "Actions",
            &["Archive", "Mark read"],
        ));
        match send_notification(&title, None, &body, Some(&options)) {
            Ok(NotificationResponse::ActionButton(label)) => {
                let action = if label == "Mark read" {
                    "read"
                } else {
                    "archive"
                };
                emit_notification_action(&app, action, &message_id, &folder_role)
            }
            Ok(NotificationResponse::Click) => {
                emit_notification_action(&app, "open", &message_id, &folder_role)
            }
            _ => {}
        }
    });
}

#[cfg(target_os = "linux")]
fn notify_with_actions(
    app: &AppHandle,
    title: String,
    body: String,
    message_id: String,
    folder_role: String,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .action("default", "Open")
            .action("archive", "Archive")
            .action("read", "Mark read")
            .show();
        if let Ok(handle) = handle {
            handle.wait_for_action(|action| {
                let mapped = match action {
                    "archive" => "archive",
                    "read" => "read",
                    "default" => "open",
                    _ => return,
                };
                emit_notification_action(&app, mapped, &message_id, &folder_role);
            });
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn notify_with_actions(
    app: &AppHandle,
    title: String,
    body: String,
    _message_id: String,
    _folder_role: String,
) {
    // No action support on this target — show a plain notification.
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

/// Tauri command: send a per-message notification with an Archive action
/// (macOS/Linux). A click → "open", the button → "archive", delivered to the
/// webview via the `notification-action` event.
#[command]
pub fn send_actionable_notification(
    app: AppHandle,
    title: String,
    body: String,
    message_id: String,
    folder_role: String,
) -> Result<(), String> {
    notify_with_actions(&app, title, body, message_id, folder_role);
    Ok(())
}
