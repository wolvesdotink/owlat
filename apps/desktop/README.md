# Owlat Desktop

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

**Security.** Like the `secret_*` keychain commands, the `ssh_*` commands are not
ACL-gated — they trust the locally-bundled SPA (`tauri://localhost`), which is the
app's trust boundary (see the CSP in `tauri.conf.json`; no remote-origin content
is ever loaded). SSH credentials are never persisted by default and are not
echoed to the log.

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
cd apps/desktop
bun run dev      # tauri dev — loads the Nuxt dev server at localhost:3000
```

In dev the app loads `devUrl` (the Nuxt dev server), which has the full Nitro
server, so both the web cookie flow and the desktop cross-domain flow work.

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
   `128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png`. Generate from a 1024×1024
   brand PNG:
   ```sh
   cd apps/desktop && bunx tauri icon path/to/owlat-1024.png
   ```
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
trigger Gatekeeper/SmartScreen warnings.

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `…_PASSWORD` | Sign updater bundles |
| `APPLE_CERTIFICATE` / `…_PASSWORD` / `APPLE_SIGNING_IDENTITY` | macOS code-sign |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS notarization |
| `WINDOWS_CERTIFICATE` / `…_PASSWORD` | Windows Authenticode |

The updater endpoint is configured in `tauri.conf.json`
(`plugins.updater.endpoints`); point it at where `latest.json` + bundles are served.

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
