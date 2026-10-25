# Development

How to get a working local Owlat for one checkout, find its ports and data,
and stop exactly what you started. Every command here has been run against
the scripts it describes. For the architecture and the hosted-deployment
setup, see the [developer guide](https://docs.owlat.app/developer/).

## Prerequisites

- Bun (the version in `package.json` → `packageManager`).
- Docker with Compose v2. The stack runs the Convex backend and Redis in
  containers; nothing else needs Docker.
- On Windows, WSL2 (see [CONTRIBUTING.md](../../CONTRIBUTING.md#developing-on-windows)).

## A fresh checkout or worktree

```sh
bun run setup:worktree
```

`scripts/setup-worktree.ts` does three things and is safe to run again:

1. Links `.env` and `.env.local` from the main checkout when this worktree has
   none. A real file in the worktree is never replaced. Run in the main
   checkout itself, it links nothing.
2. `bun install --frozen-lockfile`. A stale lockfile fails setup; it is never
   rewritten.
3. Builds the workspace packages the web app imports from `dist/`
   (`turbo run build --filter=@owlat/web^...`, which includes the plugin and
   provider kits). Without them `nuxt dev` never becomes ready.

T3 Code runs it when it creates a worktree (`t3.json`). Progress is visible in
`.owlat-dev/`:

| Marker          | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `setup-running` | Setup is working. Holds `<pid>-<run id>`. Do not run `bun install`. |
| `setup-done`    | Finished.                                                           |
| `setup-failed`  | Failed or cancelled; the file says why (with the output tail).      |

A second run while one is in progress prints `setup is already running (…)`
and leaves it alone. A marker left by a process that died is taken over by the
next run; when several runs find the same dead marker, one takes it over and
the others stand down. A run removes `setup-running` only while it still holds
its own run id. If a run was killed in the middle of a takeover, the next one
stops and names a `setup-takeover-*` file to delete.

## The local stack

```sh
bun run dev:stack
```

In order, it:

1. Prints the ports this checkout uses (see [Ports](#ports)).
2. Starts the Convex backend and Redis with `docker/dev-stack.compose.yml` in
   a Compose project of their own (`owlat-dev-<dir>-<hash>`).
3. Reads the admin key from the backend and writes it into the stage's
   `.env.local` (see [State](#state)).
4. Sets the deployment variables the app needs: `SITE_URL` and
   `ALLOWED_ORIGINS` (the web origin), `BETTER_AUTH_SECRET`,
   `INSTANCE_SECRET` and `OWLAT_DEV_MODE=true`. Variables you set yourself
   (provider keys and the like) are left alone.
5. Pushes the functions once (`convex dev --once`). The first push on a new
   volume takes one to two minutes; later ones take seconds. A failed push
   stops here: nothing is seeded and Nuxt does not start.
6. Seeds demo data with `bun run dev:seed` unless `--no-seed` is given.
7. Runs the Convex watcher and `nuxt dev` in the foreground, with output
   prefixed `[convex]` and `[web]`. Editing anything under `apps/api/convex`
   re-syncs the stage (`[stage] 1 copied, 0 removed`) and the watcher pushes.

Sign in at the printed web URL as `dev@example.com` / `devpassword12345`
(owner), or `taylor@example.com` (admin) and `jordan@example.com` (member)
with the same password.

### Why functions are pushed from a stage

The Convex CLI pushes every single-dot `.ts` file under `convex/` as a
function module, including test helpers in `__tests__` (`import.meta.glob`,
`node:fs` fixtures). Pushing `apps/api` directly fails on them. The stack
mirrors `apps/api/package.json` and `apps/api/convex` without any `__tests__`
directory into `.owlat-dev/api` and pushes from there, which is what the
deploy image does too (`docker/convex-deploy.Dockerfile`). The watcher runs
with codegen off, so a push never rewrites the committed `_generated/`.
After adding a function module, update `convex/_generated/api.d.ts` as before
(`bun run --cwd apps/api lint` checks it).

### Ports

Every port is a base port plus one offset per checkout:

| Service            | Base | Started by the stack |
| ------------------ | ---- | -------------------- |
| Web (`nuxt dev`)   | 3000 | yes                  |
| Convex             | 3210 | yes                  |
| Convex site (HTTP) | 3211 | yes                  |
| Redis              | 6379 | yes                  |
| MTA                | 3100 | no, reserved         |
| Mail sync          | 3200 | no, reserved         |

- The main checkout uses offset 0, so its ports match `.env.example`.
- A linked worktree hashes its path into an offset between 10000 and about
  26000 in steps of 13. The step keeps two worktrees from ever putting
  different services on the same port; only two paths that hash to the same
  slot collide.
- `OWLAT_PORT_OFFSET=<n>` overrides both (0 included).

```sh
bun run dev:stack ports
```

```text
Compose project  owlat-dev-<dir>-<hash>
Port offset      15005 (hash of the worktree path (slot 385))
Web              http://localhost:18005
Convex           http://127.0.0.1:18215
Convex site      http://127.0.0.1:18216
Redis            redis://127.0.0.1:21384
MTA (by hand)    PORT=18105
Mail sync (hand) MAIL_SYNC_PORT=18205
```

Before binding, `dev:stack` checks that the web port and the container ports
are free (ports held by this checkout's own running containers are fine). A
taken port stops it with the offset to try next:

```text
✗ Already in use: web port 18005.
Another checkout may have hashed to the same ports, or another server is running there.
Pick a different offset, for example: OWLAT_PORT_OFFSET=15018 bun run dev:stack
```

The Nuxt dev server gets `PORT`, `NUXT_PUBLIC_SITE_URL`,
`NUXT_PUBLIC_CONVEX_URL` and `NUXT_PUBLIC_CONVEX_SITE_URL` from the stack.
Process environment wins over the repository `.env` files, so a `.env` that
points at a hosted deployment does not leak in.

Inside the container the backend listens on the same port numbers as on the
host: actions call back into the backend through its public origin, which has
to resolve in the container too.

### State

Everything a stack writes lives in `.owlat-dev/` (gitignored):

| Path             | Contents                                                    |
| ---------------- | ----------------------------------------------------------- |
| `secrets.json`   | Instance secret, auth secret, Redis password (mode 0600).   |
| `compose.env`    | Ports and secrets for Compose interpolation (mode 0600).    |
| `api/`           | The stage: `package.json` and `convex/` without tests.      |
| `api/.env.local` | `CONVEX_SELF_HOSTED_URL`, the admin key, `CONVEX_SITE_URL`. |
| `setup-*`        | Setup markers (see above).                                  |

The data itself is in two named volumes of the Compose project,
`<project>_convex-data` and `<project>_redis-data`. The repository `.env` and
`.env.local` are never written, so a worktree that links them from the main
checkout does not hand its ports or credentials to anyone else.

To run the Convex CLI against this checkout's backend, run it from the stage:

```sh
cd .owlat-dev/api
../../node_modules/.bin/convex data emailSends --limit 1
../../node_modules/.bin/convex logs --history 5 --success
```

## Seeding

`dev:stack` seeds on every start; the seed is idempotent, so existing rows are
reported as skipped. To seed by hand or reset the demo data:

```sh
bun run dev:seed            # owner, teammates, demo content (idempotent)
bun run dev:seed --reset    # delete seed-tagged demo rows, then reseed
bun run dev:seed --wipe     # POST /dev/reset: blank instance, then seed
bun run dev:stack --no-seed # start without seeding
```

`dev:seed` targets the same deployment as the stack for both its Convex CLI
calls and its HTTP requests: the stage `.env.local` when it exists, otherwise
whatever `apps/api` selects. It refuses any site URL that is not localhost.

## Screenshots for a UI pull request

A PR that changes the UI carries before/after screenshots. `bun run capture`
takes them from the running stack: it signs in as the seeded owner through the
login form and screenshots named surfaces in system Chrome (Playwright's
Chromium if Chrome is missing). Start the stack and leave it running, then:

```sh
bun run capture --list                        # the named surfaces
bun run capture before --surface postbox,contacts
# ...make the change...
bun run capture after --surface postbox,contacts
```

- **Surfaces.** Each one reaches a seeded page the way a person would (the
  shared Team inbox with a message open, a contact, the sent campaign's
  report, the draft campaign's editor, ...) and waits for its seeded content.
  `--path /dashboard/admin/team` captures any other route as it renders.
- **Output.** `<label>-<shot>.png` in `~/.cache/owlat-captures/<checkout>/`,
  or `--out <dir>`. A directory inside the checkout is refused, also through a
  symlink. Nothing is written unless every shot succeeded, so a failed sign-in,
  a missing fixture or a page that never finished loading never leaves a PNG
  behind. An existing capture is never replaced without `--force`.
- **Pairs.** The first run in a directory records the theme
  (`--theme light|dark`), the viewport (`--viewport 1440x900`), `--full-page`
  and the app's clock in `capture.json`. Later runs reuse them, so relative
  times such as "5m ago" match, and a flag that disagrees is refused. Use a new
  `--out` for a new pair.
- **Target.** The app URL follows this checkout's ports, so run it with the
  same `OWLAT_PORT_OFFSET` as `dev:stack`. `--url http://localhost:<port>`
  points it at another local app; remote hosts are refused.
  `OWLAT_CAPTURE_EMAIL` and `OWLAT_CAPTURE_PASSWORD` sign in as an owner the
  seed did not create.
- **Postbox.** The `postbox` surfaces need the Email client feature, which a
  fresh stack has off: turn it on once under Settings > Features. The
  "Services out of sync" banner there does not matter for the dev stack.

Capturing changes a few things in the local data, the same way a person
clicking through would: the first run marks the welcome screen as seen,
`postbox` opens a message (which marks it read) and both postbox surfaces save
the inbox view they show (`--list` says which surface changes what). Those
surfaces always run before the others, so when both labels of a pair name the
same surfaces, every shot of the "before" sees the same state as the "after",
also on freshly seeded data.

Take "before" before you edit: once the change is in the working tree the
original state is gone. The mock-Convex screenshot harness some contributors
keep locally is a different tool and stays out of the repository.

## Stopping what you started

| You want to                                | Run                                                   |
| ------------------------------------------ | ----------------------------------------------------- |
| Stop Nuxt and the watcher                  | Ctrl-C in the `dev:stack` terminal                    |
| Stop this checkout's containers, keep data | `bun run dev:stack down`                              |
| Delete this checkout's data as well        | `bun run dev:stack down --volumes`                    |
| See what is running                        | `bun run dev:stack status`                            |
| Read the container logs                    | `bun run dev:stack logs [convex \| redis] [--follow]` |

Ctrl-C stops only the processes `dev:stack` started (each runs in its own
process group) and returns once those groups are empty, including anything a
process left behind when it exited. The containers keep running so the next start skips the cold
boot; `down` stops them. Every command acts on this checkout's Compose project
only. Never stop another checkout's stack by name pattern, and never
`docker system|volume prune` on a shared machine.

Starting again after `down` keeps the data: the next start reports the owner
account as already present and the demo rows as skipped.

## `bun run dev` and `bun run dev:api`

These run `convex dev` directly in `apps/api` against whatever `.env` and
`apps/api/.env.local` select. The CLI bundles the functions on your machine
before it talks to any deployment, so this path hits the test-helper problem
described above whichever deployment it targets. Use `bun run dev:stack` for
backend work.

## Troubleshooting

- **A port is taken.** Use the `OWLAT_PORT_OFFSET` the error suggests, or stop
  whatever holds the port if it is yours.
- **The first push fails.** Read the `convex dev --once` output above the
  error. The containers keep running; fix the code and start again.
- **`nuxt dev` never becomes ready.** The web dependencies are not built: run
  `bun run setup:worktree` (or check `.owlat-dev/setup-failed`).
- **Start from scratch.** `bun run dev:stack down --volumes`, then
  `bun run dev:stack`. Secrets in `.owlat-dev/secrets.json` are reused.

For logs, metrics and following one send through the system, see
[observability.md](./observability.md).
