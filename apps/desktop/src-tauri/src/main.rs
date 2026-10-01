// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The developer-only provisioning commands (ssh::dev) never ship: the feature
// is for `tauri dev`, and an optimized build that enables it does not compile.
#[cfg(all(feature = "dev-provisioning", not(debug_assertions)))]
compile_error!(
    "the `dev-provisioning` feature is for development builds only; build releases without it"
);

mod files;
#[cfg(test)]
mod ipc_commands;
mod links;
mod menu;
mod notifications;
mod secrets;
mod shortcuts;
mod ssh;
mod updater;
mod window;
mod zoom;

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
        // Size, position, maximized/fullscreen are restored per window — but
        // not visibility: windows are built hidden and revealed on the SPA's
        // first paint (window::arm_reveal), which a restore must not preempt.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        // Launch-at-login: opens the app un-minimized like any other launch.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // System-wide shortcuts: quick-compose, show/hide.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    shortcuts::handle(app, shortcut, event.state);
                })
                .build(),
        )
        // Hold live SSH sessions for the "set up a new server" flow.
        .manage(ssh::SshState::default())
        // The one update slot: found by `updater_check`, downloaded and verified
        // by `updater_install`, installed by `updater_restart` (an `Update`
        // cannot cross the IPC boundary, and the install must act on the entry
        // the check vetted). See updater.rs.
        .manage(updater::PendingUpdate::default())
        // One-shot allowlist of paths the user authorized to read (native pick
        // or OS drop). See files.rs — it keeps `read_authorized_file` from being
        // an arbitrary-path read.
        .manage(files::AllowedReads::default())
        // Which windows have had their first-paint reveal (window.rs).
        .manage(window::Revealed::default())
        // The app-wide page zoom (View → Zoom In/Out; zoom.rs).
        .manage(zoom::ZoomLevel::default())
        // Register Tauri commands. Which window may call which is decided by
        // the capabilities (see ipc_commands.rs, which lists every command
        // here); the local-source provisioning commands exist only in
        // `dev-provisioning` builds.
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
            window::window_ready,
            window::titlebar_double_click,
            zoom::zoom_level,
            ssh::ssh_connect,
            ssh::ssh_accept_host_key,
            ssh::ssh_authenticate,
            ssh::ssh_exec_stream,
            ssh::ssh_write_file,
            ssh::ssh_disconnect,
            #[cfg(feature = "dev-provisioning")]
            ssh::dev::ssh_upload_dir,
            #[cfg(feature = "dev-provisioning")]
            ssh::dev::ssh_push_images,
            #[cfg(feature = "dev-provisioning")]
            ssh::dev::local_docker_build,
            updater::updater_check,
            updater::updater_install,
            updater::updater_restart,
            updater::updater_notify_ready,
        ])
        // Capture OS-level file drops in Rust so `read_authorized_file` will
        // serve their bytes. This runs synchronously in the event loop before
        // the webview's drag-drop event is delivered, so by the time JS invokes
        // the read command the dropped paths are already authorized. Each drop
        // replaces the previous authorized-read generation (see files.rs), so a
        // drop where no zone reads the files doesn't leave them readable forever.
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                let allow = window.state::<files::AllowedReads>();
                files::remember_dropped_paths(&allow, paths);
            }
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::CloseRequested { api, .. } => {
                window::hide_main_on_close(window, api);
            }
            _ => {}
        })
        .setup(|app| {
            // Register global keyboard shortcuts
            shortcuts::register_global_shortcuts(app.handle());

            // Before any window exists: no AppKit auto-tabbing (window.rs), and
            // the persisted zoom the main window is built at.
            #[cfg(target_os = "macos")]
            window::disable_automatic_tabbing();
            zoom::load(app.handle());
            // `create: false` in tauri.conf.json — built here so it carries the
            // link policy (links.rs) and starts hidden until first paint.
            window::create_main_window(app.handle())?;

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: clicking the Dock icon (or re-launching from Finder /
            // Spotlight) with the main window closed brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                window::show_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
