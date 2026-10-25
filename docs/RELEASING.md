# Release runbook

How an Owlat release is cut, what the pipeline gates on, and the manual steps
that CANNOT be automated — read the GHCR section before shipping anything that
adds a new service image.

## Cutting a release

Every unified release goes through a release candidate. The candidate runs the
whole pipeline, and the stable release is its commit, tagged once that run is
green:

```sh
bun run release:cut <major|minor|patch|X.Y.Z> --no-commit # prepare X.Y.Z: bump + changelog + schema snapshot
# curate the generated CHANGELOG.md section, then commit and tag the candidate:
git add -A && git commit -m "chore(release): vX.Y.Z-rc.1"
git tag -a vX.Y.Z-rc.1 -m "Owlat vX.Y.Z-rc.1"
git push origin main vX.Y.Z-rc.1
# wait for release.yml to pass on the candidate, test it (below), then:
bun run release:promote vX.Y.Z-rc.1 --push    # tag vX.Y.Z on the candidate's commit
```

Without `--no-commit`, `release:cut` commits and tags the candidate itself
(add `--push` to push both). The stable release is the candidate's commit, so
changelog edits made after the tag exist only in a later commit: they reach a
release only through the next candidate (`release:cut rc`).

A fix found while testing goes to main as usual, then
`bun run release:cut rc` cuts `vX.Y.Z-rc.2` from main: it keeps the prepared
versions, adds what landed since `rc.1` to the version's CHANGELOG section
and moves the schema snapshot forward. To fold in hand-written notes under
[Unreleased] or curate the section again, cut it with `--no-commit` as above
and commit and tag `vX.Y.Z-rc.2` after curating. Only the newest candidate can be
promoted. `release:cut` refuses to prepare a new version while the prepared one
is unreleased: cut its next candidate or promote one first.

What a candidate does, and what it never does:

|                                                                                             | Candidate `vX.Y.Z-rc.N`          | Stable `vX.Y.Z` |
| ------------------------------------------------------------------------------------------- | -------------------------------- | --------------- |
| Verification, server images, desktop apps, install gates                                    | yes                              | yes             |
| Update gate from the previous stable release, before publication                            | yes                              | yes             |
| GitHub release                                                                              | prerelease, never "latest"       | "latest"        |
| Image aliases (`latest`, `X.Y`)                                                             | no                               | yes             |
| `install.sh`, `owlat upgrade`, the in-app update check, the desktop updater's `latest.json` | not by default                   | yes             |
| Managed desktop updates                                                                     | only on the `prerelease` channel | yes             |

The `resolve` job of `release.yml` (`scripts/ci/release-gate.ts`) enforces
this. A candidate must sit on a prepared commit, where the root `package.json`
already holds `X.Y.Z`. A stable tag must point at the commit of the newest
`vX.Y.Z-rc.N`, which has to be published as a prerelease, and the newest
`release.yml` run for that candidate must have succeeded. Anything else stops
before a build. `release:promote` runs the same check before it creates the
tag. The stable run builds the artifacts again from that same commit, so they
carry the stable version and signatures.

Testing a candidate means installing it by name, never by default:

```sh
curl -fsSL https://get.owlat.app | OWLAT_REF=vX.Y.Z-rc.N bash   # fresh install
owlat upgrade --version X.Y.Z-rc.N                           # an existing test install
```

Desktop apps get it from the candidate's release assets, or through managed
desktop updates on the `prerelease` channel. The candidate's artifacts carry
`X.Y.Z-rc.N`; the Windows installer's MSI version is `X.Y.Z.N`, because
Windows Installer versions are numeric (`scripts/ci/msi-version.ts`).

Other prerelease tags (`vX.Y.Z-beta.1`) still publish a prerelease the same
way, but can never be promoted.

The curated section is also the release's notes: `release.yml` builds the
GitHub Release body with `scripts/release-body.ts`, which puts that section
first and the update instructions after it, and the in-app update card shows
the section to admins. A candidate's body is the `X.Y.Z` section under a
release-candidate note, so the candidate and the stable release carry the same
notes. A tag without a CHANGELOG section fails before anything is built.
Preview the body with
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
bun run --cwd apps/api schema-compat:refresh   # snapshots the newest stable vX.Y.Z tag
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
| `vX.Y.Z-rc.N`    | `release.yml` (unified) | the same, published as a prerelease that nothing follows by default                          |
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
7. **`update-gate`** — the in-app update from the highest published stable
   release below this version (`scripts/ci/aliases.ts` `previousRelease`; a
   candidate starts from the stable release below `X.Y.Z`) to this draft,
   through `update-flow.yml` (see "The update gate" below). `update-target`
   downloads the draft's compose template and checksum with the workflow's
   credentials, from the tag the caller created (`server-vX.Y.Z` for a
   server-only release), and hands them over as a run artifact. A first
   release with no earlier stable release skips the gate with a notice.

### The update gate

`update-flow.yml` runs two scenarios, each on its own runner and each against
a Docker daemon of its own (`scripts/e2e-update-flow-dind.sh`: a pinned
`docker:dind` container whose image store is a named volume, with the whole
harness running inside it and no host socket mounted; its cleanup removes
only the container and volume that carry its own random owner label), because the updater
prunes images and the harness takes its stack down with its volumes. Before
either update it installs the previous release, seeds Convex data through it
(its sample data plus one queued Send, with no way to send mail) and records a
baseline: the named contact, sent campaign and its Sends, draft campaign and
queued Send, plus every document within two id references of them, keyed by
id (`scripts/e2e-update-flow-data.sh`).

- **success**: the previous release's shipped updater applies this release's
  template unchanged. The stack has to land on it (compose file, `.env`, every
  image, the updater replaced, the Convex deployment's `OWLAT_VERSION`), and
  every baseline document must still exist with every field it had,
  deep-equal, and no added soft-delete marker. Other added fields are allowed,
  except on the queued Send, which must be identical. The campaign stats
  rollup runs before both snapshots, so its counters compare strictly. A
  migration that rewrites one of those fields on purpose lists it in that
  script's `DATA_REWRITE_ALLOWLIST`.
- **rollback**: this release's own updater applies the same template with
  web's healthcheck made to fail (`scripts/e2e-update-flow-rollback.sh`), so
  the snapshot, the deploy and `up` succeed and the release then fails the
  readiness check. While it waits there, the harness deletes the seeded
  contact through the new functions and overwrites a Redis sentinel, and
  fails if the rollback had already begun. The updater has to answer HTTP 500
  with rollout `rolled-back` after a successful restore and readiness check,
  and the stack has to be the previous release again: its compose file,
  override and `.env` byte for byte, the same image on every service, the
  updater not replaced, web and the deployment reporting the previous version,
  the sentinel's old value and every baseline document as the previous release
  wrote it (no rewrite allowance applies).

Outside the nightly and dispatched runs, so in the release gate and on pull
requests, a pair the flow cannot test (an updater without rollback, a target
naming images that no longer pull) fails instead of passing with a warning.
Pull requests that touch the updater or the flow run both scenarios with the
PR's updater, built inside the dedicated daemon. The nightly run checks the
latest published pair and cannot cover every intermediate release when several
ship between runs.

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

- `scripts/gen-release-compose.sh` — release compose generation + digest
  pinning (unit-tested via `bun run lint:script-tests`).
- `install.sh` / `scripts/owlat upgrade` — the consumer side of the release
  assets.
