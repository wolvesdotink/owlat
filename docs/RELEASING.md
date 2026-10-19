# Release runbook

How an Owlat release is cut, what the pipeline gates on, and the manual steps
that CANNOT be automated — read the GHCR section before shipping anything that
adds a new service image.

## Cutting a release

```sh
bun run release:cut <version|major|minor|patch>   # bump + changelog + commit + tag
# curate the generated CHANGELOG.md section, then:
git push origin main v<X.Y.Z>
```

The curated section is also the release's notes: `release.yml` builds the
GitHub Release body with `scripts/release-body.ts`, which puts that section
first and the update instructions after it, and the in-app update card shows
the section to admins. A tag without a CHANGELOG section fails before anything
is built. Preview the body with
`bun scripts/release-body.ts <X.Y.Z> --repo wolvesdotink/owlat`.

`release:cut` also moves the schema-compatibility guard forward: it snapshots
HEAD's table validators and the argument validators of the functions its
clients and workers call as the new release into
`apps/api/convex/__tests__/schemaCompat/previousRelease.json` and puts the
file in the release commit, so later PRs are checked against the rows this
release can store and the calls it can make (see "Release data compatibility"
in `apps/api/convex/CONVENTIONS.md`). To redo the snapshot by hand, for example
after a cut made without the script:

```sh
bun run --cwd apps/api schema-compat:refresh   # snapshots the newest vX.Y.Z tag
git add apps/api/convex/__tests__/schemaCompat/previousRelease.json
git commit -m "test(api): snapshot the v<X.Y.Z> schema for the compat guard"
```

The snapshot's diff shows that release's schema and argument changes, one field
or function per line. If the release ships data migrations, its notes carry the
migration manifest.

Pushing the tag triggers one of three pipelines:

| Tag              | Workflow                | Ships                                                                                        |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `vX.Y.Z`         | `release.yml` (unified) | server images + desktop apps + install assets — the line `install.sh` and the updater follow |
| `server-vX.Y.Z`  | `server-release.yml`    | server images + compose assets only                                                          |
| `desktop-vX.Y.Z` | `desktop-release.yml`   | desktop apps only                                                                            |

## What gates the release

Both server pipelines run the reusable core (`_server-build.yml`). The GitHub
Release is created as a DRAFT up front; every job below must pass before the
`publish` job flips it live, so a red gate means nothing was shipped:

1. **`verify`** (the shared `_verify.yml`, called by all three release
   workflows) — accepts a fresh successful full `test.yml` main-push run for
   the exact tagged commit, including its identified `ci-verification` artifact.
   The newest matching run controls the decision; a known failed run blocks
   publication. Missing, cancelled or expired evidence uses the same full CI
   graph through `workflow_call`. API errors, deleted artifacts and rerun races
   also request full verification; none authorize reuse. Recover from a known
   main failure by rerunning main CI successfully, then rerunning the release.
   The lookup waits at most 35 minutes (90 seconds
   when no main run exists). Coverage, both ramp modes, Java and Docker smokes
   are part of this shared graph. The probe job allows 50 minutes overall for
   setup and bounded API retries around the 35-minute main wait.
2. **`build-and-push`** — builds every image natively for linux/amd64 (on
   `ubuntu-latest`) and linux/arm64 (on `ubuntu-24.04-arm`), pushing each
   per-arch image untagged, by digest.
3. **`merge-manifests`** — stitches the two per-arch digests of each image
   into one multi-arch manifest list per version, fails if either platform is
   missing, cosign-signs the LIST digest, publishes the SLSA attestation, and
   records that digest for compose pinning. Consumers pin, pull and verify the
   list digest, never a per-arch leaf.
4. **`verify-anonymous-pull`** — `docker manifest inspect` on every image
   WITHOUT credentials, also asserting both platforms are listed. This is the backstop for the GHCR visibility trap
   below.
5. **`upload-release-assets`** — generates `docker-compose-<version>.yml` with
   every Owlat image pinned to `:<version>@sha256:<digest>` (the digests come
   from build-push-action, via `scripts/gen-release-compose.sh`), plus its
   `.sha256` manifest and provenance attestation. It also publishes an attested
   `image-digests-<version>.txt` and checksum covering every image, including
   setup and other images absent from the compose template.
6. **`e2e-install`** — from a clean runner with no checkout: downloads the
   compose + checksum from the draft release, pulls every first-party image
   anonymously, boots the stack with a scripted minimal env, deploys the
   Convex functions, and waits for web / MTA(+worker) / Redis / ClamAV health.
   Runs three times: `fresh` volumes and volumes `seeded` by the previous
   release on amd64 (the upgrade path — Redis/ClamAV volume-ownership
   regressions only show up there), plus `fresh` on an arm64 runner to prove
   the multi-arch manifests actually boot there.

## Caches and post-publish checks

Main CI produces the amd64 Docker cache that releases restore. PRs restore
main caches without exporting their own. Tag builds do
not export Docker or Bun caches that another tag cannot read. The separate
`desktop-cache.yml` workflow warms release-profile Rust dependencies on main
with the same pinned `rust-toolchain.toml`, OS, targets, Tauri release config and
shared cache key as release packaging. It also runs twice a week to prevent idle
eviction. Dependency crates are cached; the app and its embedded
frontend are rebuilt with the tag's version. The first release after rollout
may still be cold while the producer seeds its caches.

A successful stable unified release calls `promote-aliases.yml`. Its repository
lock protects a reconciliation of the highest eligible published stable version
and each major.minor line. It checks the published digest manifest and compose
checksums before pointing aliases at those exact signed digests and re-inspects
each alias afterward. The lock uses GitHub's `queue: max` to retain up to 100
pending reconciliations instead of cancelling a published release's pending
caller. Every invocation recomputes current published state, so ordering is not
required. Beyond that queue limit, or after a post-publish cancellation/failure,
the release remains published: rerun reconciliation to repair aliases. Candidate
builds, prereleases and single-target releases only publish versioned images.
Older releases without the digest manifest retain their existing aliases.
The nightly reconciliation and manual dispatch can repair an interrupted
promotion without rebuilding images.

After merging changes to alias reconciliation, confirm a scheduled or manually
dispatched run on main succeeds before cutting the next release tag. This checks
GitHub's reusable-workflow/queue handling, which PR CI cannot exercise. On the
first warm desktop release, record the compiled crate count per OS; also compare
ARM64 build times and exact-commit reuse rates over the next few releases.

The unified workflow explicitly calls Update flow after publication, using the
highest earlier stable unified version and this release's version. This tests
the actual previous updater applying the new release. The rollout result is a
post-publication check; the three install gates above still block publication.
GitHub suppresses release events created using GITHUB_TOKEN, so the handoff is
`workflow_call` rather than `release: published`. Nightly checks remain useful
but cannot cover every intermediate release when several ship between runs.

To reproduce the timing/cache baseline with read-only GitHub access:

```sh
bun run ci:report > ci-baseline.json
```

The report records job queue time, actual peak overlap, latest-attempt job-minutes, successful
attempt duration, attempt count, run-creation-to-publication time and cache bytes
by ref. Compare similar changes, report first-attempt success separately, and
use p90 only when there are at least 20 samples. Hosted-runner improvements
require observation over real CI and release runs; local checks cannot establish
warm-cache or notarization timings.

## GHCR visibility: the manual step (read before adding a new image)

**The first push of any NEW image creates a PRIVATE GHCR package.** Packages
created by a `GITHUB_TOKEN` push default to private, and there is **no API to
change that** — a human must flip it:

> GitHub → the `wolvesdotink` org → **Packages** → select the new package →
> **Package settings** → Danger Zone → **Change visibility** → Public.

Until that flip, every anonymous pull of the image returns `denied` (a 403),
which makes the release uninstallable — this shipped once (#551: all of
v0.4.2's pulls were 403s). `verify-anonymous-pull` now fails the release
before the draft goes live instead. When it goes red on a new image:

1. Flip the package public (steps above). This also un-breaks older releases
   of that image retroactively.
2. Re-run the failed jobs — the images are already pushed; the gate re-checks
   visibility.

So when a release adds a new service image, expect its first run to stop at
`verify-anonymous-pull` by design. Checklist for a new image:

- add an entry to `docker/images.json` (see below). The `build-and-push` and
  `merge-manifests` matrices and the `verify-anonymous-pull` loop all read it,
  so there is no list in `_server-build.yml` to edit;
- add it to the `**Images:**` line of the release body in `server-release.yml`
  (`bun run lint:script-tests` fails until you do); `release.yml` builds its
  body with `scripts/release-body.ts`, which reads the manifest;
- after the first release run pushes it: flip the package public, then re-run.

## The image manifest: `docker/images.json`

One entry per published image, `ghcr.io/wolvesdotink/<name>`:

| Field         | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `name`        | image name under `ghcr.io/wolvesdotink/`, also the cache scope and artifact name    |
| `dockerfile`  | Dockerfile path from the repository root                                            |
| `context`     | build context from the repository root                                              |
| `title`       | `org.opencontainers.image.title` label                                              |
| `description` | `org.opencontainers.image.description` label                                        |
| `rootCompose` | how the root `docker-compose.yml` runs it: `ghcr` (pulled), `local` (built), `none` |

- **Context.** The first-party apps build from the monorepo root (`.`): their
  `catalog:` versions only resolve through a bun workspace install (see each
  Dockerfile). `clamav`, `tinyproxy` and `unbound` are thin wrappers around
  upstream images that are not multi-arch under one name; they build from
  `docker/` and need nothing else from the tree. `convex-backend` and
  `convex-dashboard` wrap Convex's images (moved from `ghcr.io/get-convex/` to
  `ghcr.io/convex/`, a prefix shipped updaters refuse) and pin them by digest:
  bump both digests together, as the header of
  `docker/convex-backend.Dockerfile` describes.
- **Labels.** The Dockerfiles carry no `LABEL` lines. The release build sets
  `title` and `description` from the manifest through `docker/metadata-action`,
  which also computes `source`, `licenses`, `version`, `revision` and `created`.
  The updater's image prune relies on `source`, so local builds (no labels)
  prune nothing. The `OWLAT_VERSION`, `OWLAT_GIT_SHA` and `OWLAT_BUILD_DATE`
  build args stay: the runtime reads them from the environment.
- **`rootCompose`.** `bun run lint:compose` checks that every `ghcr` entry is
  pinned to `ghcr.io/wolvesdotink/<name>:${OWLAT_VERSION:-dev}` in the root
  compose file, and that the file pulls no other `ghcr.io/wolvesdotink` image.

## Related

- `docs/adr/` — architecture decisions, including supply-chain hardening.
- `scripts/gen-release-compose.sh` — release compose generation + digest
  pinning (unit-tested via `bun run lint:script-tests`).
- `install.sh` / `scripts/owlat upgrade` — the consumer side of the release
  assets.
