# Owlat Desktop

> The desktop app is in **alpha**, the same status as the rest of Owlat — it works end-to-end, but expect rough edges and breaking changes between releases.

Tauri 2 + Rust shell that bundles the `apps/web` SPA and connects to one or more
remote owlat instances (multi-workspace). The same web UI is used everywhere — no
duplicated components.

## How it works

- **Frontend**: the bundled `apps/web` static build (`bun run generate:desktop`,
  produced with no baked Convex URL). The active workspace's Convex/site URLs are
  read at runtime from `tauri-plugin-store` + the OS keychain.
- **Auth**: per-workspace, via the system browser. "Add workspace" opens the
  instance's `/desktop/connect` page; on success it returns a one-time token over
  the `owlat://auth` deep link, which the app redeems for a cross-domain session
  (header-based, no cookies) stored in the OS keychain. See
  `apps/web/app/lib/desktop/*` and `apps/web/app/composables/useDesktopWorkspaces.ts`.
- **Switching workspaces** reloads the webview so the auth + Convex singletons
  re-seed from the newly-active workspace.

## Native behaviour

The app should behave like a Mac / Windows / Linux application, not a web page
in a window:

- **Links leave the app.** Web links (`target="_blank"`, `window.open`, or a
  plain navigation away from the SPA) open in the default browser, and
  `mailto:` links open Owlat's compose window. The webview never loads a page
  other than the bundled SPA (`src-tauri/src/links.rs`).
- **No blank launch.** Windows are built hidden and shown once the SPA has
  painted (`window_ready`), with a 3-second fallback (`window.rs`). The main
  window is built in `setup` (`create: false` in `tauri.conf.json`) so it can
  carry the link policy.
- **macOS window lifecycle.** Closing the main window hides it; the app keeps
  syncing and badging, and the Dock icon or Window → Owlat brings it back. ⌘Q
  quits. Automatic window tabbing is off. Windows and Linux still quit on close
  (there is no tray to come back from).
- **Menus.** Go → Back / Forward (⌘[ ⌘], Alt+← Alt+→), Edit → Find… (⌘F, the
  command palette), View → Actual Size / Zoom In / Zoom Out (⌘0 ⌘= ⌘−, one level
  for every window, persisted in `view.json`). On macOS the Window menu lists
  open windows and Help has the menu search field.
- **Title bar.** A double-click on the macOS title bar follows the system
  setting (zoom, minimize or nothing) instead of always maximizing.
- **Unread badge on Windows.** Tauri has no badge count there, so an overlay dot
  on the taskbar icon stands in for it.
- **Chrome is not a page.** No browser context menu on app chrome (kept in text
  fields, on selected text and on external links; dev builds keep it
  everywhere), no text selection or ghost-dragging of the titlebar, sidebar and
  controls, the arrow cursor there, and no rubber-banding of the app shell
  (`apps/web` `lib/desktop/nativeFeel.client.ts`, `assets/css/desktop.css`).

## Set up a new server (SSH provisioning)

From `/desktop/welcome` → **Set up a new server**, an admin can install Owlat on
a bare Linux VPS without touching a terminal. The app SSHes in and drives the
**existing** installer, streaming progress to an animated timeline.

- **Native transport** (`src-tauri/src/ssh.rs`, `ssh2` vendored): `ssh_connect`
  does the TCP + SSH handshake and returns the SHA256 host-key fingerprint
  (trust-on-first-use, persisted to `ssh-known-hosts.json` in the app config
  dir) — **no credentials are sent** until the user accepts it and
  `ssh_authenticate` runs. The live session is held in Rust state keyed by an
  opaque `sessionId`, so the password/key crosses the IPC boundary exactly once.
  `ssh_exec_stream` runs a command and streams stdout/stderr line-by-line over a
  Tauri `Channel`; `ssh_write_file` uploads the generated config.
- **Leaving the wizard** stops what is running: `ssh_cancel` cancels the
  session's current operation without waiting for the session lock it holds
  (local Docker builds are killed with their plugin processes), the wizard then
  removes the uploaded config, and `ssh_disconnect` shuts the socket down. A
  silent remote command is also stopped after 30 minutes without output, and
  any command after 4 hours. A command already running on the server is not
  killed: its pipes close, so it fails on its next write, and the installer is
  idempotent for the next run.
- **The setup config** (admin password, provider keys in plaintext) is removed
  after every install that uploaded it, successful or not, and on leaving. The
  installer also deletes it itself when its run ends (`OWLAT_CONSUME_CONFIG=1`
  in `scripts/owlat`), so a desktop that is killed mid-install does not leave it
  behind. A failed removal is shown next to the install error, with the command
  that removes it by hand.
- **One source of orchestration truth**: the desktop does *not* re-implement the
  ~13-step install. It runs preflight / fetch over SSH, uploads an
  `owlat-setup.json`, then runs the normal installer with
  `OWLAT_PROGRESS=json` (`apps/setup-cli`). That CLI emits one
  `@@OWLAT_PROGRESS@@{…}` NDJSON line per step (wire shape in
  `@owlat/shared/setupProgress`); the wizard parses them off the SSH stream to
  drive the timeline, and treats everything else as raw log output.
- **Web side** (`apps/web`): `lib/desktop/provisioning.ts` (timeline + commands),
  `composables/useServerProvisioning.ts` (the state machine — fully unit tested
  against a fake transport), `components/desktop/ProvisioningTimeline.vue`, and
  `pages/desktop/setup.vue`. On success it reuses the normal `addWorkspace`
  handshake to connect the new instance.

**Security.** Every app command is ACL-gated per window.
`src-tauri/src/ipc_commands.rs` lists the commands; `build.rs` turns each into an
`allow-<command>` permission, and the files under `src-tauri/capabilities/` grant
them. The `ssh_*` commands go to the main window only (`provisioning.json`); the
compose window gets the everyday commands but cannot provision. The SPA is still
only ever loaded from the bundle (see the CSP in `tauri.conf.json`; no
remote-origin content is ever loaded). SSH credentials are never persisted by
default and are not echoed to the log.

**Local-source installs (development only).** The hidden "local source" install
(upload this checkout instead of cloning; optionally build the images here and
stream them to the server) uses `ssh_upload_dir`, `ssh_push_images` and
`local_docker_build` (`src-tauri/src/ssh/dev.rs`). They exist only with the
`dev-provisioning` Cargo feature, which `bun run dev` passes to `tauri dev`.
Release builds neither compile nor register them, and an optimized build with
the feature refuses to compile. Even in development the inputs are narrow: the
folder must be an Owlat checkout, a local build is a typed choice (the Compose
stack by service and profile name, or the setup image) for `linux/amd64` or
`linux/arm64`, and only local `:dev` images are pushed.

**Remote reachability.** For the desktop to connect to the box *after* the
install, give it a **public domain** in the wizard. That sets
`SITE_URL` / `NUXT_PUBLIC_*` to `owlat.` / `convex.` / `convex-site.<domain>`
(the `Caddyfile.example` convention). The operator must point those DNS A-records
at the server, open 80/443, and the install must run the `tls` Caddy profile to
issue certs — DNS + TLS bring-up is the operator/e2e step. Without a domain it's
a localhost-only install (reachable only on the box itself).

**Build note.** The remote install runs the `ghcr.io/wolvesdotink/setup` container, so
that image must be built from a revision that includes the `--config` /
`OWLAT_PROGRESS=json` support in `apps/setup-cli`. The real end-to-end run can
only be validated against an actual fresh VPS.

## Develop

```sh
bun run dev      # from the repo root — web (localhost:3000) + Convex backend
cd apps/desktop
bun run dev      # tauri dev — loads the Nuxt dev server at localhost:3000
```

In dev the app loads `devUrl` (the Nuxt dev server), which has the full Nitro
server, so both the web cookie flow and the desktop cross-domain flow work.

**Auto-connect.** In dev the boot plugin seeds a `local-dev` workspace for the
page's own origin (discovered via `/api/instance-info`), so there is no manual
"connect a server" handshake: the app opens straight onto the in-app login
form, which signs into the local backend cross-domain and persists the session
to the OS keychain (`owlat-ws:local-dev`). Subsequent launches restore it
automatically. Seed accounts come from `bun run dev:seed` (see the root
README); connecting additional (remote) workspaces still works via
Settings → Connected workspaces.

## Verify auth (headless spike)

Before building the GUI you can confirm the whole cookieless cross-domain auth
chain against a running instance (the same code paths the app uses):

```sh
CONVEX_SITE_URL=https://<deployment>.convex.site \
TEST_EMAIL=you@example.com TEST_PASSWORD='…' \
  bun run --cwd apps/desktop auth-spike
```

It checks: cross-domain sign-in → cookieless `/convex/token` JWT (R1) →
one-time-token generate → fresh-client redeem via
`/cross-domain/one-time-token/verify` → JWT again (R3). Non-zero exit on any
failure. Requires this branch's `apps/api` (crossDomain + oneTimeToken plugins)
deployed and a known email/password user.

## Build

```sh
cd apps/desktop
bun run build    # runs `generate:desktop` then bundles per the host platform
```

Requires:

1. **Icons** — `src-tauri/icons/` must contain `32x32.png`, `128x128.png`,
   `128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png`. The master source is
   `src-tauri/icons/icon.svg` (terracotta owl on the dark brand plate); regenerate
   all platform icons from it:
   ```sh
   rsvg-convert -w 1024 -h 1024 src-tauri/icons/icon.svg -o /tmp/owlat-1024.png
   cd apps/desktop && bunx tauri icon /tmp/owlat-1024.png
   ```
   `tauri icon` also emits `icons/android/` and `icons/ios/` — delete those (we
   don't ship mobile).
2. **Updater signing key** (for auto-update):
   ```sh
   bunx tauri signer generate -w ~/.owlat/desktop-updater.key
   ```
   - Put the **public** key in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
   - Add the **private** key + password as CI secrets `TAURI_SIGNING_PRIVATE_KEY` /
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never commit the private key.

## Release (CI)

Push a `desktop-v*` tag to trigger `.github/workflows/desktop-release.yml`
(macOS universal, Ubuntu, Windows matrix via `tauri-action`). It uploads signed
artifacts + `latest.json` to a draft GitHub Release.

Signing/notarization is **secret-gated** — without the secrets below the build
still produces unsigned artifacts (so forks/PRs build), but distributables will
trigger Gatekeeper/SmartScreen warnings. Unsigned release builds emit a
`::warning::` + job-summary notice; when the macOS secrets ARE configured, the
workflow verifies `codesign`, the stapled notarization ticket, and a `spctl`
Gatekeeper assessment on the built `.app` before the Release is published, so
a broken signing setup fails in CI instead of on a user's machine.

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD` | Sign updater bundles |
| `APPLE_CERTIFICATE` / `…_PASSWORD` / `APPLE_SIGNING_IDENTITY` | macOS code-sign |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS notarization |
| `WINDOWS_CERTIFICATE` / `…_PASSWORD` | Windows Authenticode |

### macOS signing + notarization setup (one-time)

Both halves are required for a download that opens without the
“Apple could not verify …” Gatekeeper block: **signing** identifies the
developer, **notarization** is Apple's malware scan that Gatekeeper checks on
first launch. Prerequisite: a paid [Apple Developer Program](https://developer.apple.com/programs/)
membership (the certificate type below is not available on free accounts).

1. **Developer ID Application certificate** — in Xcode (Settings → Accounts →
   Manage Certificates) or on the [developer portal](https://developer.apple.com/account/resources/certificates/list),
   create a **Developer ID Application** certificate (this is the
   direct-distribution type; "Apple Development"/"Apple Distribution" won't
   pass Gatekeeper). Export it from Keychain Access as a `.p12` with a
   password, then:
   ```sh
   base64 -i DeveloperIDApplication.p12 | pbcopy
   ```
   - `APPLE_CERTIFICATE` = the base64 output
   - `APPLE_CERTIFICATE_PASSWORD` = the `.p12` export password
   - `APPLE_SIGNING_IDENTITY` = the certificate's full common name, e.g.
     `Developer ID Application: Your Name (TEAMID1234)`
2. **Notarization credentials** — create an [app-specific password](https://account.apple.com/account/manage)
   for your Apple ID:
   - `APPLE_ID` = the Apple ID email
   - `APPLE_PASSWORD` = the app-specific password (not the account password)
   - `APPLE_TEAM_ID` = the 10-character team id shown on the
     [membership page](https://developer.apple.com/account#MembershipDetailsCard)

Add all six as repo Actions secrets; the next `v*` / `desktop-v*` tag ships
signed + notarized macOS builds (hardened runtime is on by default in Tauri 2,
and `tauri-action` submits to the notary service and staples the ticket
whenever these env vars are present). No config changes are needed.

### Where the app looks for updates

The app asks the Owlat instance it is connected to. On boot (when "check for
updates" is on), every six hours while it stays open, and on the manual "Check
for Updates…" menu item, the webview probes the active workspace's
`GET /api/desktop/update-policy`; on a 200 it points the updater at that
instance's `/api/desktop/update/{{target}}/{{arch}}/{{current_version}}`, which
serves the release that instance's policy allows (it can pin a version, pause
updates, or defer a fresh release for a while).

It falls back to the endpoint in `tauri.conf.json`
(`plugins.updater.endpoints`, GitHub's `latest.json`) when there is no
workspace yet, when the workspace URL is not https (`tauri dev` over
`http://localhost:3000`), or when the instance predates the route and answers
404. An instance that is merely unreachable means "skip this check", not "go
around it".

Because the endpoint has to be chosen at runtime and the JS `check()` cannot
take one, the check lives in `src-tauri/src/updater.rs` (`updater_check`,
`updater_install`, `updater_restart`) with `src/updater.ts` as the bridge.
Bundles are still downloaded from GitHub and still verified against the
minisign public key baked into the app, so an instance can choose among signed
releases or withhold them all — it can never substitute one. The manifest is
not signed, so the Rust side additionally refuses any bundle URL that is not a
release asset of this repository under a tag carrying the version the manifest
claims (`v<version>` or `desktop-v<version>`): an endpoint cannot label an old
bundle as a newer version to roll a client back, and cannot send the download
anywhere but GitHub.

The download and the install are two steps. `updater_install` downloads and
verifies in the background and keeps the bytes; `updater_restart` (the "Restart
now" button or the notification action) installs them and relaunches. On
Windows that last step hands over to the NSIS/MSI installer, which exits the
app and relaunches it itself — the app never closes on a timer tick. Only the
main window runs the updater; the compose window shares the process's one
update slot and stays out of it.

## Webview CSP rationale

The CSP in `src-tauri/tauri.conf.json` keeps two allowances on purpose:

- `connect-src https://* wss://*` — the desktop shell connects to whatever
  self-hosted Owlat instance the user configures; there is no fixed origin to
  pin. Tightening this would break every non-localhost instance.
- `script-src 'unsafe-inline'` — the bundled Nuxt SPA injects an inline
  bootstrap/config script at build time. Removing the allowance requires
  hash-pinning that snippet per build; revisit when the SPA build emits a
  stable hash we can inject into the config during `tauri build`.

Everything else is locked to `'self'`; the webview never loads remote code.
