use std::sync::atomic::{AtomicU64, Ordering};
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

/// What an actionable notification is about, echoed back verbatim in every
/// `notification-action` event it produces. Targets without action support
/// show a plain notification and never read it back.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", test)),
    allow(dead_code)
)]
struct ActionTarget {
    message_id: String,
    folder_role: String,
    /// The desktop workspace that sent the notification. A notification outlives
    /// a workspace switch and message ids are instance-scoped, so the webview
    /// resolves the action against this workspace, not the one active now.
    workspace_id: Option<String>,
    /// Process-unique id of this notification. Each notification emits at most
    /// one action, so the webview can drop a duplicate delivery of the same one.
    notification_id: u64,
}

/// Source of [`ActionTarget::notification_id`].
static NEXT_NOTIFICATION_ID: AtomicU64 = AtomicU64::new(1);

impl ActionTarget {
    fn new(message_id: String, folder_role: String, workspace_id: Option<String>) -> Self {
        Self {
            message_id,
            folder_role,
            workspace_id: workspace_id.filter(|id| !id.is_empty()),
            notification_id: NEXT_NOTIFICATION_ID.fetch_add(1, Ordering::Relaxed),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    notification_id: u64,
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
impl NotificationActionEvent {
    fn new(action: &str, target: &ActionTarget, reply: Option<String>) -> Self {
        Self {
            action: action.to_string(),
            message_id: target.message_id.clone(),
            folder_role: target.folder_role.clone(),
            reply,
            workspace_id: target.workspace_id.clone(),
            notification_id: target.notification_id,
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn emit_notification_action(
    app: &AppHandle,
    action: &str,
    target: &ActionTarget,
    reply: Option<String>,
) {
    use tauri::Emitter;
    let _ = app.emit(
        "notification-action",
        NotificationActionEvent::new(action, target, reply),
    );
}

#[cfg(target_os = "macos")]
fn notify_with_actions(app: &AppHandle, title: String, body: String, target: ActionTarget) {
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
                emit_notification_action(&app, "reply", &target, Some(text))
            }
            Ok(NotificationResponse::CloseButton(_)) => {
                emit_notification_action(&app, "archive", &target, None)
            }
            // Defensive: an explicit action button (should not occur without a
            // dropdown) still maps to a sensible triage effect.
            Ok(NotificationResponse::ActionButton(label)) => {
                let action = if label == "Mark read" {
                    "read"
                } else {
                    "archive"
                };
                emit_notification_action(&app, action, &target, None)
            }
            Ok(NotificationResponse::Click) => {
                emit_notification_action(&app, "open", &target, None)
            }
            _ => {}
        }
    });
}

#[cfg(target_os = "linux")]
fn notify_with_actions(app: &AppHandle, title: String, body: String, target: ActionTarget) {
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
                emit_notification_action(&app, mapped, &target, None);
            });
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn notify_with_actions(app: &AppHandle, title: String, body: String, _target: ActionTarget) {
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
/// `notification-action` event, which carries `workspace_id` back unchanged.
#[command]
pub fn send_actionable_notification(
    app: AppHandle,
    title: String,
    body: String,
    message_id: String,
    folder_role: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let target = ActionTarget::new(message_id, folder_role, workspace_id);
    notify_with_actions(&app, title, body, target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{badge_dot_rgba, ActionTarget, NotificationActionEvent};

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

    #[test]
    fn action_events_carry_the_sending_workspace_and_a_unique_notification_id() {
        let a = ActionTarget::new("m1".into(), "inbox".into(), Some("ws-a".into()));
        let b = ActionTarget::new("m1".into(), "inbox".into(), None);
        assert_ne!(a.notification_id, b.notification_id);

        let event = serde_json::to_value(NotificationActionEvent::new(
            "reply",
            &a,
            Some("thanks".into()),
        ))
        .unwrap();
        assert_eq!(event["workspaceId"], "ws-a");
        assert_eq!(event["messageId"], "m1");
        assert_eq!(event["reply"], "thanks");
        assert_eq!(event["notificationId"], a.notification_id);

        // No workspace (and an empty one) is omitted, never sent as "".
        let event = serde_json::to_value(NotificationActionEvent::new("open", &b, None)).unwrap();
        assert!(event.get("workspaceId").is_none());
        let empty = ActionTarget::new("m1".into(), "inbox".into(), Some(String::new()));
        assert!(empty.workspace_id.is_none());
    }
}
