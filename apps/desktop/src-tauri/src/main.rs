// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod menu;
mod notifications;
mod secrets;
mod shortcuts;
mod ssh;
mod window;

// `Manager` brings `get_webview_window` into scope — used by the macOS
// traffic-light setup and the non-macOS menu wiring below.
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
        // Launch-at-login: opens the app un-minimized like any other launch.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
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
        // One-shot allowlist of paths the user authorized to read (native pick
        // or OS drop). See files.rs — it keeps `read_authorized_file` from being
        // an arbitrary-path read.
        .manage(files::AllowedReads::default())
        // Register Tauri commands
        .invoke_handler(tauri::generate_handler![
            notifications::update_unread_badge,
            notifications::send_native_notification,
            notifications::send_actionable_notification,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            files::pick_files,
            files::read_authorized_file,
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
        // Capture OS-level file drops in Rust so `read_authorized_file` will
        // serve their bytes. This runs synchronously in the event loop before
        // the webview's drag-drop event is delivered, so by the time JS invokes
        // the read command the dropped paths are already authorized. Each drop
        // replaces the previous authorized-read generation (see files.rs), so a
        // drop where no zone reads the files doesn't leave them readable forever.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let allow = window.state::<files::AllowedReads>();
                files::remember_dropped_paths(&allow, paths);
            }
        })
        .setup(|app| {
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
