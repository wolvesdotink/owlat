use serde::Deserialize;
use tauri::{
    command,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Manager, Runtime,
};

use crate::window;

/// One tray quick-peek row supplied by the frontend: the newest unread mail.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayPeekItem {
    pub message_id: String,
    pub folder_role: String,
    /// "Sender — Subject", already plain-text + truncated by the caller.
    pub title: String,
}

/// Encode a peek row as a stable menu-item id we can parse on click.
fn peek_id(item: &TrayPeekItem) -> String {
    // messageId/folderRole are ids without ':'; a fixed field order keeps parsing
    // unambiguous.
    format!("peek:{}:{}", item.folder_role, item.message_id)
}

/// Parse a `peek:<folderRole>:<messageId>` id back to (folderRole, messageId).
fn parse_peek_id(id: &str) -> Option<(String, String)> {
    let rest = id.strip_prefix("peek:")?;
    let (role, message_id) = rest.split_once(':')?;
    if role.is_empty() || message_id.is_empty() {
        return None;
    }
    Some((role.to_string(), message_id.to_string()))
}

/// Build the tray context menu: fixed actions, then the (optional) quick-peek
/// list of the newest unread messages, then Quit.
fn build_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    peek: &[TrayPeekItem],
) -> Result<Menu<R>, tauri::Error> {
    let show = MenuItem::with_id(manager, "show", "Show Owlat", true, None::<&str>)?;
    let inbox = MenuItem::with_id(manager, "inbox", "Open Inbox", true, None::<&str>)?;
    let chat = MenuItem::with_id(manager, "chat", "Open Chat", true, None::<&str>)?;
    let sep_top = MenuItem::with_id(manager, "sep-top", "---", false, None::<&str>)?;
    let quit = MenuItem::with_id(manager, "quit", "Quit Owlat", true, None::<&str>)?;

    let menu = Menu::new(manager)?;
    menu.append(&show)?;
    menu.append(&inbox)?;
    menu.append(&chat)?;
    menu.append(&sep_top)?;

    if peek.is_empty() {
        let none =
            MenuItem::with_id(manager, "peek-empty", "No unread mail", false, None::<&str>)?;
        menu.append(&none)?;
    } else {
        let header =
            MenuItem::with_id(manager, "peek-header", "Newest unread", false, None::<&str>)?;
        menu.append(&header)?;
        for item in peek {
            let mi = MenuItem::with_id(manager, peek_id(item), &item.title, true, None::<&str>)?;
            menu.append(&mi)?;
        }
    }

    let sep_bottom = MenuItem::with_id(manager, "sep-bottom", "---", false, None::<&str>)?;
    menu.append(&sep_bottom)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// Handle a tray menu-item click: fixed actions plus dynamic `peek:` rows,
/// which focus the main window and deep-link to that thread in the inbox.
fn on_menu_event(app: &AppHandle, id: &str) {
    if let Some((folder_role, message_id)) = parse_peek_id(id) {
        window::show_main_window(app);
        if let Some(win) = app.get_webview_window("main") {
            window::navigate_to(
                &win,
                &format!("/dashboard/postbox/{}/{}", folder_role, message_id),
            );
        }
        return;
    }
    match id {
        "show" => {
            window::show_main_window(app);
        }
        "inbox" => {
            window::show_main_window(app);
            if let Some(win) = app.get_webview_window("main") {
                window::navigate_to(&win, "/dashboard/inbox");
            }
        }
        "chat" => {
            window::show_main_window(app);
            if let Some(win) = app.get_webview_window("main") {
                window::navigate_to(&win, "/dashboard/chat");
            }
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/// Creates the system tray icon with a context menu.
/// The tray shows an unread count badge (updated via frontend events) and a
/// quick-peek list of the newest unread mail (updated via `update_tray_peek`).
pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app, &[])?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Owlat")
        .on_menu_event(|app, event| on_menu_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                window::show_main_window(app);
            }
        })
        .build(app)?;

    Ok(())
}

/// Tauri command: refresh the tray quick-peek list with the newest unread
/// messages. Fast + text-only; an empty list shows "No unread mail".
#[command]
pub fn update_tray_peek(app: AppHandle, items: Vec<TrayPeekItem>) {
    if let Ok(menu) = build_menu(&app, &items) {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
