use tauri::{command, AppHandle, Manager};

/// Tauri command: reflect the unread count on the app icon's badge — the macOS
/// dock badge, the Windows taskbar overlay, and the Linux Unity launcher count.
/// A count of 0 clears the badge. `set_badge_count` lives on the window in Tauri
/// 2.x (the AppHandle has no `set_badge_label` in 2.10).
#[command]
pub fn update_unread_badge(app: AppHandle, count: u32) {
    if let Some(window) = app.get_webview_window("main") {
        // Windows has no badge count (Tauri: "Unsupported, use set_overlay_icon"),
        // so the call used to be a silent no-op there. The taskbar overlay is the
        // native equivalent: a small dot over the icon, like Outlook and Teams.
        #[cfg(windows)]
        {
            let icon = (count > 0).then(|| {
                tauri::image::Image::new_owned(
                    badge_dot_rgba(BADGE_DOT_SIZE),
                    BADGE_DOT_SIZE,
                    BADGE_DOT_SIZE,
                )
            });
            let _ = window.set_overlay_icon(icon);
        }
        #[cfg(not(windows))]
        let _ = window.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}

/// Overlay icon edge, in pixels. Windows draws taskbar overlays at 16×16 (it
/// scales larger sources down), so a 32px source stays crisp on HiDPI.
#[cfg(windows)]
const BADGE_DOT_SIZE: u32 = 32;

/// RGBA pixels of the taskbar overlay: an anti-aliased terracotta dot (the app
/// icon's owl colour, #c4785a) with a thin white ring, so it reads on light and
/// dark taskbars alike.
#[cfg(any(windows, test))]
fn badge_dot_rgba(size: u32) -> Vec<u8> {
    const FILL: [f64; 3] = [196.0, 120.0, 90.0];
    let center = size as f64 / 2.0;
    let outer = center - 0.5;
    let ring = (size as f64 / 10.0).max(1.5);
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let dx = x as f64 + 0.5 - center;
            let dy = y as f64 + 0.5 - center;
            let d = (dx * dx + dy * dy).sqrt();
            // Coverage of this pixel by the disc / by the inner fill (1px AA edge).
            let alpha = (outer - d + 0.5).clamp(0.0, 1.0);
            let fill = (outer - ring - d + 0.5).clamp(0.0, 1.0);
            for c in FILL {
                rgba.push((255.0 * (1.0 - fill) + c * fill).round() as u8);
            }
            rgba.push((255.0 * alpha).round() as u8);
        }
    }
    rgba
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
    /// "open" (notification clicked), "archive" (Archive button), "read"
    /// (Mark read button), or "reply" (text typed into the inline reply field).
    action: String,
    message_id: String,
    folder_role: String,
    /// The text the user typed into the inline reply field (macOS only). `None`
    /// for every other action so the webview can route reply → send without a
    /// second round trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn emit_notification_action(
    app: &AppHandle,
    action: &str,
    message_id: &str,
    folder_role: &str,
    reply: Option<String>,
) {
    use tauri::Emitter;
    let _ = app.emit(
        "notification-action",
        NotificationActionEvent {
            action: action.to_string(),
            message_id: message_id.to_string(),
            folder_role: folder_role.to_string(),
            reply,
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
        // A macOS notification renders a SINGLE main button. We spend it on an
        // inline reply text field (the headline "answer from the notification"
        // moment) and keep Archive reachable as the alternate (close) button.
        // Mark-read isn't offered here — it's a tap away in-app.
        options.main_button(MainButton::Response("Reply"));
        options.close_button("Archive");
        match send_notification(&title, None, &body, Some(&options)) {
            Ok(NotificationResponse::Reply(text)) => {
                emit_notification_action(&app, "reply", &message_id, &folder_role, Some(text))
            }
            Ok(NotificationResponse::CloseButton(_)) => {
                emit_notification_action(&app, "archive", &message_id, &folder_role, None)
            }
            // Defensive: an explicit action button (should not occur without a
            // dropdown) still maps to a sensible triage effect.
            Ok(NotificationResponse::ActionButton(label)) => {
                let action = if label == "Mark read" {
                    "read"
                } else {
                    "archive"
                };
                emit_notification_action(&app, action, &message_id, &folder_role, None)
            }
            Ok(NotificationResponse::Click) => {
                emit_notification_action(&app, "open", &message_id, &folder_role, None)
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
                // Linux (notify-rust/zbus) has no inline text-input capability,
                // so reply is macOS-only; these actions never carry reply text.
                emit_notification_action(&app, mapped, &message_id, &folder_role, None);
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

/// Tauri command: send a per-message notification with inline actions
/// (macOS/Linux). macOS offers an inline **Reply** field (→ "reply" + text)
/// plus an Archive alternate button (→ "archive"); Linux offers Open / Archive
/// / Mark read. A click → "open". All are delivered to the webview via the
/// `notification-action` event.
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

#[cfg(test)]
mod tests {
    use super::badge_dot_rgba;

    fn pixel(rgba: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * size + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn badge_dot_is_an_opaque_brand_disc_with_a_white_ring_on_transparency() {
        let size = 32;
        let rgba = badge_dot_rgba(size);
        assert_eq!(rgba.len(), (size * size * 4) as usize);
        // Center: solid brand fill.
        assert_eq!(pixel(&rgba, size, 16, 16), [196, 120, 90, 255]);
        // Just inside the edge: the white ring.
        assert_eq!(pixel(&rgba, size, 16, 1), [255, 255, 255, 255]);
        // Corners: fully transparent.
        assert_eq!(pixel(&rgba, size, 0, 0)[3], 0);
        assert_eq!(pixel(&rgba, size, 31, 31)[3], 0);
    }
}
