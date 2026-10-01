// The app's own IPC commands, grouped by the windows allowed to call them.
//
// build.rs `include!`s this file and generates an `allow-<command>` permission
// for every command listed here; the capability files grant those permissions
// per window. Because the app declares that manifest, Tauri checks every app
// command against the capabilities: a command no capability grants to a window
// cannot be invoked from it, and a registered command missing from these lists
// cannot be invoked at all. The tests below keep the lists, the capabilities
// and main.rs's `generate_handler!` in step.

/// Commands every app window uses (`main` and `compose`): notifications, the
/// keychain, user-picked files, window chrome, zoom and updates.
pub const WINDOW_COMMANDS: &[&str] = &[
    "update_unread_badge",
    "send_native_notification",
    "send_actionable_notification",
    "secret_set",
    "secret_get",
    "secret_delete",
    "pick_files",
    "read_authorized_file",
    "open_compose",
    "set_traffic_lights_visible",
    "set_accent_frame",
    "window_ready",
    "titlebar_double_click",
    "zoom_level",
    "updater_check",
    "updater_install",
    "updater_restart",
    "updater_notify_ready",
];

/// The server wizard's SSH transport (ssh.rs). Granted to the `main` window
/// only (capabilities/provisioning.json); the compose window never provisions.
pub const PROVISIONING_COMMANDS: &[&str] = &[
    "ssh_connect",
    "ssh_accept_host_key",
    "ssh_authenticate",
    "ssh_exec_stream",
    "ssh_write_file",
    "ssh_cancel",
    "ssh_disconnect",
];

/// The local-source install commands (ssh/dev.rs). They exist only in builds
/// with the `dev-provisioning` feature, and so does their permission and the
/// capability granting it to `main` (capabilities-dev/).
pub const DEV_PROVISIONING_COMMANDS: &[&str] =
    &["ssh_upload_dir", "ssh_push_images", "local_docker_build"];

#[cfg(test)]
mod tests {
    use super::{DEV_PROVISIONING_COMMANDS, PROVISIONING_COMMANDS, WINDOW_COMMANDS};
    use std::collections::BTreeSet;

    const DEV: bool = cfg!(feature = "dev-provisioning");

    fn permission(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    fn permissions(commands: &[&str]) -> BTreeSet<String> {
        commands.iter().map(|c| permission(c)).collect()
    }

    /// Every command this build registers, per the lists.
    fn listed_commands() -> Vec<&'static str> {
        let mut all = [WINDOW_COMMANDS, PROVISIONING_COMMANDS].concat();
        if DEV {
            all.extend_from_slice(DEV_PROVISIONING_COMMANDS);
        }
        all
    }

    struct Capability {
        file: String,
        windows: Vec<String>,
        permissions: Vec<String>,
    }

    /// The capability files this build compiles in, read the way build.rs
    /// selects them: capabilities/ always, capabilities-dev/ with the feature.
    fn capabilities() -> Vec<Capability> {
        let mut dirs = vec!["capabilities"];
        if DEV {
            dirs.push("capabilities-dev");
        }
        let mut out = Vec::new();
        for dir in dirs {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
            for entry in std::fs::read_dir(&path).unwrap() {
                let file = entry.unwrap().path();
                let raw = std::fs::read_to_string(&file).unwrap();
                let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let strings = |key: &str| -> Vec<String> {
                    json[key]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| {
                                    item.as_str()
                                        .or_else(|| item["identifier"].as_str())
                                        .map(String::from)
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                };
                out.push(Capability {
                    file: file.display().to_string(),
                    windows: strings("windows"),
                    permissions: strings("permissions"),
                });
            }
        }
        out
    }

    /// Whether a capability's window pattern covers `label` (exact, or a
    /// trailing `*` glob).
    fn covers(pattern: &str, label: &str) -> bool {
        match pattern.strip_suffix('*') {
            Some(prefix) => label.starts_with(prefix),
            None => pattern == label,
        }
    }

    /// Every permission granted to the window `label`.
    fn granted(label: &str) -> BTreeSet<String> {
        capabilities()
            .into_iter()
            .filter(|c| c.windows.iter().any(|w| covers(w, label)))
            .flat_map(|c| c.permissions)
            .collect()
    }

    #[test]
    fn the_main_window_is_granted_every_registered_command() {
        let main = granted("main");
        for command in listed_commands() {
            assert!(main.contains(&permission(command)), "main lacks {command}");
        }
    }

    #[test]
    fn the_compose_window_keeps_its_commands_but_not_provisioning() {
        let compose = granted("compose");
        for command in WINDOW_COMMANDS {
            assert!(
                compose.contains(&permission(command)),
                "compose lacks {command}"
            );
        }
        let provisioning =
            permissions(&[PROVISIONING_COMMANDS, DEV_PROVISIONING_COMMANDS].concat());
        let leaked: Vec<_> = compose.intersection(&provisioning).collect();
        assert!(leaked.is_empty(), "compose may provision: {leaked:?}");
    }

    #[test]
    fn other_windows_get_no_app_commands() {
        // e.g. the bare WebView2 window Windows opens for a blob: preview.
        let app = permissions(&listed_commands());
        for label in ["popup", "compose-2", "main-2", ""] {
            let leaked: Vec<_> = granted(label).intersection(&app).cloned().collect();
            assert!(leaked.is_empty(), "{label:?} may call {leaked:?}");
        }
    }

    #[test]
    fn capabilities_grant_only_listed_app_commands() {
        let known = permissions(&listed_commands());
        for capability in capabilities() {
            for granted in capability.permissions {
                // Plugin permissions are prefixed (`core:`, `dialog:` …).
                if !granted.contains(':') {
                    assert!(
                        known.contains(&granted),
                        "{} grants unknown {granted}",
                        capability.file
                    );
                }
            }
        }
    }

    #[test]
    fn release_builds_grant_no_developer_command() {
        if DEV {
            return;
        }
        let all: BTreeSet<String> = capabilities()
            .into_iter()
            .flat_map(|c| c.permissions)
            .collect();
        for command in DEV_PROVISIONING_COMMANDS {
            assert!(!all.contains(&permission(command)), "{command} granted");
        }
    }

    /// main.rs's `generate_handler!` list as (command, compiled only with the
    /// `dev-provisioning` feature).
    fn registered_commands() -> Vec<(String, bool)> {
        let main = include_str!("main.rs");
        let open = "generate_handler![";
        let start = main.find(open).expect("generate_handler! in main.rs") + open.len();
        let end = start + main[start..].find("])").expect("end of generate_handler!");
        let mut out = Vec::new();
        let mut dev_only = false;
        for line in main[start..end].lines().map(str::trim) {
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            if line == "#[cfg(feature = \"dev-provisioning\")]" {
                dev_only = true;
                continue;
            }
            assert!(!line.starts_with('#'), "unexpected attribute {line}");
            let name = line.trim_end_matches(',').rsplit("::").next().unwrap();
            out.push((name.to_string(), dev_only));
            dev_only = false;
        }
        out
    }

    #[test]
    fn the_registered_commands_match_the_lists() {
        let registered = registered_commands();
        let always: BTreeSet<&str> = registered
            .iter()
            .filter(|(_, dev)| !dev)
            .map(|(n, _)| n.as_str())
            .collect();
        let dev_only: BTreeSet<&str> = registered
            .iter()
            .filter(|(_, dev)| *dev)
            .map(|(n, _)| n.as_str())
            .collect();
        let expected: BTreeSet<&str> = [WINDOW_COMMANDS, PROVISIONING_COMMANDS]
            .concat()
            .into_iter()
            .collect();
        assert_eq!(always, expected);
        assert_eq!(
            dev_only,
            DEV_PROVISIONING_COMMANDS
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
        );
    }

    /// The ACL itself, as the running app enforces it: a mock app built from
    /// the real config and capabilities, invoked from each window. The command
    /// bodies are stand-ins (the real ones are bound to the Wry runtime); the
    /// ACL only looks at the command name, the window and the origin.
    mod runtime {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
        use tauri::webview::InvokeRequest;
        use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

        #[tauri::command]
        fn zoom_level() -> f64 {
            1.0
        }

        #[tauri::command]
        fn ssh_disconnect() {}

        #[tauri::command]
        fn local_docker_build() {}

        fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str) -> Result<(), serde_json::Value> {
            // The bundled SPA's origin (Windows serves custom protocols over http).
            let url = if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            };
            get_ipc_response(
                window,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: url.parse().unwrap(),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|_| ())
        }

        #[test]
        fn commands_are_scoped_to_their_windows() {
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![
                    zoom_level,
                    ssh_disconnect,
                    local_docker_build
                ])
                .build(tauri::generate_context!(test = true))
                .expect("mock app");
            let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
                .build()
                .unwrap();
            let compose = WebviewWindowBuilder::new(&app, "compose", WebviewUrl::default())
                .build()
                .unwrap();
            let other = WebviewWindowBuilder::new(&app, "popup", WebviewUrl::default())
                .build()
                .unwrap();

            assert!(invoke(&main, "zoom_level").is_ok());
            assert!(invoke(&compose, "zoom_level").is_ok());
            assert!(invoke(&other, "zoom_level").is_err());

            assert!(invoke(&main, "ssh_disconnect").is_ok());
            assert!(invoke(&compose, "ssh_disconnect").is_err());

            // Developer builds grant the local build to main; release builds
            // have no such permission (nor command) for any window.
            assert_eq!(
                invoke(&main, "local_docker_build").is_ok(),
                cfg!(feature = "dev-provisioning")
            );
            assert!(invoke(&compose, "local_docker_build").is_err());
        }
    }
}
