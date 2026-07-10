// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod menu;
mod notifications;
mod secrets;
mod shortcuts;
mod ssh;
mod tray;
mod window;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // single-instance MUST be the first plugin: a second launch (e.g. from a
        // deep link) focuses the running window instead of spawning a new process.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main_window(app);
        }))
        // Plugins
        .plugin(tauri_plugin_notification::init())
        // Native file pickers (e.g. choosing an SSH key in the server-setup flow).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        // Launch-at-login. `--minimized` (passed on autostart) starts hidden to tray.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // System-wide shortcuts: quick-compose, quick-switcher, show/hide.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    shortcuts::handle(app, shortcut, event.state);
                })
                .build(),
        )
        // Hold live SSH sessions for the "set up a new server" flow.
        .manage(ssh::SshState::default())
        // Register Tauri commands
        .invoke_handler(tauri::generate_handler![
            notifications::update_tray_badge,
            notifications::send_native_notification,
            notifications::send_actionable_notification,
            tray::update_tray_peek,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            window::open_compose,
            window::set_traffic_lights_visible,
            window::set_accent_frame,
            ssh::ssh_connect,
            ssh::ssh_accept_host_key,
            ssh::ssh_authenticate,
            ssh::ssh_exec_stream,
            ssh::ssh_write_file,
            ssh::ssh_upload_dir,
            ssh::ssh_push_images,
            ssh::local_exec_stream,
            ssh::ssh_disconnect,
        ])
        .setup(|app| {
            // Initialize system tray
            tray::create_tray(app)?;

            // Set up close-to-tray behavior
            let handle = app.handle().clone();
            window::setup_close_handler(&handle);

            // Register global keyboard shortcuts
            shortcuts::register_global_shortcuts(app.handle());

            // Native application menu. macOS gets the app-global menu bar; on
            // Windows/Linux we drop the native frame (the branded
            // <DesktopTitlebar> takes over) and attach the menu to the main
            // window. Both deliver events through the app-global handler below.
            let app_menu = menu::build_menu(app.handle())?;
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu)?;
            // macOS: center the traffic lights in the 44px titlebar strip and
            // keep them there via a synchronous frame-change observer (see
            // window::setup_traffic_lights for why nothing else works).
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                window::setup_traffic_lights(&w);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(false);
                w.set_menu(app_menu)?;
            }
            app.on_menu_event(|app, event| menu::handle_menu_event(app, event.id.as_ref()));

            // Launched at login with --minimized → start hidden to the tray.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
