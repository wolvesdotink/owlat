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

Pushing the tag triggers one of three pipelines:

| Tag | Workflow | Ships |
| --- | --- | --- |
| `vX.Y.Z` | `release.yml` (unified) | server images + desktop apps + install assets — the line `install.sh` and the updater follow |
| `server-vX.Y.Z` | `server-release.yml` | server images + compose assets only |
| `desktop-vX.Y.Z` | `desktop-release.yml` | desktop apps only |

## What gates the release

Both server pipelines run the reusable core (`_server-build.yml`). The GitHub
Release is created as a DRAFT up front; every job below must pass before the
`publish` job flips it live, so a red gate means nothing was shipped:

1. **`verify`** (the shared `_verify.yml`, called by all three release
   workflows) — full `ci:verify` of the exact tagged commit.
2. **`build-and-push`** — builds all eight images, cosign-signs each digest,
   publishes SLSA attestations, and records each image digest for compose
   pinning.
3. **`verify-anonymous-pull`** — `docker manifest inspect` on every image
   WITHOUT credentials. This is the backstop for the GHCR visibility trap
   below.
4. **`upload-release-assets`** — generates `docker-compose-<version>.yml` with
   every Owlat image pinned to `:<version>@sha256:<digest>` (the digests come
   from build-push-action, via `scripts/gen-release-compose.sh`), plus its
   `.sha256` manifest and provenance attestation.
5. **`e2e-install`** — from a clean runner with no checkout: downloads the
   compose + checksum from the draft release, pulls every first-party image
   anonymously, boots the stack with a scripted minimal env, deploys the
   Convex functions, and waits for web / MTA(+worker) / Redis / ClamAV health.
   Runs twice: `fresh` volumes and volumes `seeded` by the previous release
   (the upgrade path — Redis/ClamAV volume-ownership regressions only show up
   there).

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

- add it to the `build-and-push` matrix in `_server-build.yml`;
- add it to the image list in the `verify-anonymous-pull` job (kept in sync by
  hand);
- after the first release run pushes it: flip the package public, then re-run.

## Related

- `docs/adr/` — architecture decisions, including supply-chain hardening.
- `scripts/gen-release-compose.sh` — release compose generation + digest
  pinning (unit-tested via `bun run lint:release-compose`).
- `install.sh` / `scripts/owlat upgrade` — the consumer side of the release
  assets.
