use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

use crate::window;

/// Creates the system tray icon with a context menu.
/// The tray shows an unread count badge (updated via frontend events).
pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show Owlat", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", "Open Inbox", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "Open Chat", true, None::<&str>)?;
    let separator = MenuItem::with_id(app, "sep", "---", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Owlat", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &inbox, &chat, &separator, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Owlat")
        .on_menu_event(|app, event| match event.id.as_ref() {
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
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                window::show_main_window(app);
            }
        })
        .build(app)?;

    Ok(())
}
