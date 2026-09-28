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

`release:cut` also moves the schema-compatibility guard forward: it snapshots
HEAD's table validators as the new release into
`apps/api/convex/__tests__/schemaCompat/previousRelease.json` and puts the
file in the release commit, so later PRs are checked against the rows this
release can store (see "Release data compatibility" in
`apps/api/convex/CONVENTIONS.md`). To redo the snapshot by hand, for example
after a cut made without the script:

```sh
bun run --cwd apps/api schema-compat:refresh   # snapshots the newest vX.Y.Z tag
git add apps/api/convex/__tests__/schemaCompat/previousRelease.json
git commit -m "test(api): snapshot the v<X.Y.Z> schema for the compat guard"
```

The snapshot's diff shows that release's schema changes, one field per line. If
the release ships data migrations, its notes carry the migration manifest.

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
   workflows) — full `ci:verify` of the exact tagged commit.
2. **`build-and-push`** — builds every image natively for linux/amd64 (on
   `ubuntu-latest`) and linux/arm64 (on `ubuntu-24.04-arm`), pushing each
   per-arch image untagged, by digest.
3. **`merge-manifests`** — stitches the two per-arch digests of each image
   into one multi-arch manifest list per tag, fails if either platform is
   missing, cosign-signs the LIST digest, publishes the SLSA attestation, and
   records that digest for compose pinning. Consumers pin, pull and verify the
   list digest, never a per-arch leaf.
4. **`verify-anonymous-pull`** — `docker manifest inspect` on every image
   WITHOUT credentials, also asserting both platforms are listed. This is the backstop for the GHCR visibility trap
   below.
5. **`upload-release-assets`** — generates `docker-compose-<version>.yml` with
   every Owlat image pinned to `:<version>@sha256:<digest>` (the digests come
   from build-push-action, via `scripts/gen-release-compose.sh`), plus its
   `.sha256` manifest and provenance attestation.
6. **`e2e-install`** — from a clean runner with no checkout: downloads the
   compose + checksum from the draft release, pulls every first-party image
   anonymously, boots the stack with a scripted minimal env, deploys the
   Convex functions, and waits for web / MTA(+worker) / Redis / ClamAV health.
   Runs three times: `fresh` volumes and volumes `seeded` by the previous
   release on amd64 (the upgrade path — Redis/ClamAV volume-ownership
   regressions only show up there), plus `fresh` on an arm64 runner to prove
   the multi-arch manifests actually boot there.

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
- add it to the `**Images:**` line of the release body in `release.yml` and
  `server-release.yml` (`bun run lint:script-tests` fails until you do);
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
  `docker/` and need nothing else from the tree.
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
