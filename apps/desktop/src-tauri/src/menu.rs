//! Native application menu (the macOS menu bar / Windows-Linux window menu).
//!
//! macOS gets an app-global menu (App / File / Edit / View / Window / Help) set
//! via `app.set_menu`; Windows & Linux get the same tree (minus the macOS-only
//! App submenu and roles) attached to the main window. Either way the events are
//! delivered through the app-global `app.on_menu_event` handler wired in `main.rs`.
//!
//! Navigation items reuse `window::navigate_to` (a small JS-injection helper);
//! app-level actions emit `menu://…` events the SPA listens for (see apps/web
//! `useDesktopMenu.ts`). The Edit submenu uses predefined roles so
//! Cut/Copy/Paste/Select-All work inside the webview — essential on macOS.
//!
//! NB: Tauri 2.10 exposes no dock-menu API — the macOS dock menu is provided
//! only through the `NSApplicationDelegate.applicationDockMenu:` hook, which tao
//! owns, so we can't attach one without swizzling the delegate. The quick verbs
//! it would carry (Compose / Open Inbox) instead live in this File menu, the
//! native surface Owlat actually reaches today; the macOS dock right-click menu
//! falls back to the OS default (Show / Quit).

use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Wry,
};
use tauri_plugin_shell::ShellExt;

use crate::window;

/// Build the full application menu. Branded labels, native shape.
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about_meta = AboutMetadataBuilder::new()
        .name(Some("Owlat"))
        .version(Some(app.package_info().version.to_string()))
        .copyright(Some("© 2026 Owlat"))
        .website(Some("https://owlat.app"))
        .website_label(Some("owlat.app"))
        .build();

    // Custom (handled) items, shared across platforms.
    let compose = MenuItem::with_id(
        app,
        "compose",
        "New Message",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let new_ws = MenuItem::with_id(
        app,
        "new_workspace",
        "New Workspace",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let inbox = MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "Chat", true, None::<&str>)?;
    let docs = MenuItem::with_id(app, "docs", "Owlat Documentation", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "Report an Issue…", true, None::<&str>)?;
    let prefs = MenuItem::with_id(
        app,
        "preferences",
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    // Manual update check. The handler emits `menu://check-updates`; the SPA
    // re-dispatches it to the auto-updater (see apps/web updater.client.ts).
    // Lives in the app menu on macOS (native home for it) and Help elsewhere.
    let check_updates =
        MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;

    // Edit / Window are identical on every platform.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let about = PredefinedMenuItem::about(app, Some("About Owlat"), Some(about_meta))?;
        let services = PredefinedMenuItem::services(app, None)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let quit = PredefinedMenuItem::quit(app, None)?;
        let close = PredefinedMenuItem::close_window(app, None)?;

        let app_menu = SubmenuBuilder::new(app, "Owlat")
            .item(&about)
            .item(&check_updates)
            .separator()
            .item(&prefs)
            .separator()
            .item(&services)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&quit)
            .build()?;
        let file = SubmenuBuilder::new(app, "File")
            .item(&compose)
            .item(&new_ws)
            .separator()
            .item(&close)
            .build()?;
        // `fullscreen()` is a macOS-only predefined role.
        let view = SubmenuBuilder::new(app, "View")
            .item(&reload)
            .fullscreen()
            .separator()
            .item(&inbox)
            .item(&chat)
            .build()?;
        // Check-for-Updates lives in the app menu above, so Help is just links.
        let help = SubmenuBuilder::new(app, "Help")
            .item(&docs)
            .item(&report)
            .build()?;

        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window_menu, &help])
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No app submenu on Windows/Linux: fold About / Preferences / Quit into File.
        let about = PredefinedMenuItem::about(app, Some("About Owlat"), Some(about_meta))?;
        let quit = PredefinedMenuItem::quit(app, None)?;
        let close = PredefinedMenuItem::close_window(app, None)?;
        // No predefined fullscreen role off macOS — toggle it ourselves (see handler).
        let fullscreen = MenuItem::with_id(
            app,
            "toggle_fullscreen",
            "Toggle Full Screen",
            true,
            Some("F11"),
        )?;

        let file = SubmenuBuilder::new(app, "File")
            .item(&compose)
            .item(&new_ws)
            .item(&close)
            .separator()
            .item(&prefs)
            .separator()
            .item(&about)
            .item(&quit)
            .build()?;
        let view = SubmenuBuilder::new(app, "View")
            .item(&reload)
            .item(&fullscreen)
            .separator()
            .item(&inbox)
            .item(&chat)
            .build()?;
        // No macOS app menu, so Check-for-Updates rides in Help (Windows/Linux
        // convention) above the doc links.
        let help = SubmenuBuilder::new(app, "Help")
            .item(&check_updates)
            .separator()
            .item(&docs)
            .item(&report)
            .build()?;

        Menu::with_items(app, &[&file, &edit, &view, &window_menu, &help])
    }
}

/// Dispatch a menu click. Predefined roles (Edit, Quit, Close, Minimize, …) are
/// handled natively by the OS and never reach here; only our custom ids do.
// `Shell::open` is deprecated in favour of tauri-plugin-opener, but this app
// already ships tauri-plugin-shell (shell:allow-open) and not the opener plugin.
#[allow(deprecated)]
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "compose" => {
            window::open_compose_window(app, "/compose");
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
        "reload" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("window.location.reload()");
            }
        }
        "new_workspace" => {
            window::show_main_window(app);
            let _ = app.emit("menu://new-workspace", ());
        }
        "preferences" => {
            window::show_main_window(app);
            let _ = app.emit("menu://preferences", ());
        }
        "check_updates" => {
            window::show_main_window(app);
            let _ = app.emit("menu://check-updates", ());
        }
        "toggle_fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                let on = win.is_fullscreen().unwrap_or(false);
                let _ = win.set_fullscreen(!on);
            }
        }
        "docs" => {
            let _ = app.shell().open("https://owlat.app/docs", None);
        }
        "report" => {
            let _ = app
                .shell()
                .open("https://github.com/wolvesdotink/owlat/issues/new", None);
        }
        _ => {}
    }
}
