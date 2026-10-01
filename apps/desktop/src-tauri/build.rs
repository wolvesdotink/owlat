// The app's IPC command ACL. Every command in src/ipc_commands.rs gets an
// `allow-<command>` permission, and the files under capabilities/ grant them
// per window. Declaring the manifest makes Tauri check every app command
// against the capabilities, so provisioning stays with the main window.
//
// The developer-only provisioning commands (ssh/dev.rs) and the capability
// granting them (capabilities-dev/) are only part of builds with the
// `dev-provisioning` feature; release builds define neither.
include!("src/ipc_commands.rs");

fn main() {
    println!("cargo:rerun-if-changed=src/ipc_commands.rs");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=capabilities-dev");

    let dev = std::env::var_os("CARGO_FEATURE_DEV_PROVISIONING").is_some();
    let mut commands = [WINDOW_COMMANDS, PROVISIONING_COMMANDS].concat();
    if dev {
        commands.extend_from_slice(DEV_PROVISIONING_COMMANDS);
    }
    let commands: &'static [&'static str] = Box::leak(commands.into_boxed_slice());
    let capabilities = if dev {
        "./capabilities*/**/*"
    } else {
        "./capabilities/**/*"
    };

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .capabilities_path_pattern(capabilities)
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
}
