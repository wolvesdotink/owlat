# ADR-0063: IMAP wire version and a written backend/IMAP skew policy

## Status

Accepted.

## Context

The IMAP server (`apps/imap`) calls backend functions directly with the admin
key; the `fn` table in `apps/imap/src/convex.ts` lists them. Their arguments
and results are a contract between two images that ship from one commit but
are deployed separately: the backend first, the IMAP container after it. The
maintenance docs state that order, and nothing records whether the second step
happened or says how far the IMAP container may fall behind.

So every expand/contract change across that boundary stopped at the expand
step. `mail/imap/move:expungeFolder` still returns `sequenceNumbers` and
`nextSequenceNumber` for v0.6.6 IMAP servers that write their `* n EXPUNGE`
lines from them (#1144 had to leave them in place). Removing them while such a
server still runs would throw after the page's deletions committed, and the
client's next `STORE n` could hit the wrong message. The backend could not
tell whether that server was still around, so it could never remove the
fields (#1145).

## Best-practice basis

- **A written, bounded skew window, enforced by upgrade order.** Kubernetes
  upgrades the control plane first; a kubelet may lag kube-apiserver by a
  stated number of minor releases and must never be newer
  ([version skew policy](https://kubernetes.io/releases/version-skew-policy/)).
  Each node publishes its kubelet version in its status
  ([node status](https://kubernetes.io/docs/reference/node/node-status/)), so
  an operator can see the skew rather than infer it.
- **Negotiate on an integer protocol version at connection time.** MongoDB's
  `hello` handshake returns `minWireVersion` and `maxWireVersion`, and drivers
  use them to decide whether they can talk to the server at all
  ([hello](https://www.mongodb.com/docs/manual/reference/command/hello/)).
  Kafka clients send `ApiVersions` after connecting and pick the highest
  version both sides support; a broker answers an unsupported one with
  `UNSUPPORTED_VERSION`
  ([protocol](https://kafka.apache.org/43/design/protocol)). Compatibility is a
  property of the protocol, not of the release string, and an incompatible
  peer is refused at the handshake, not halfway through an operation.
- **Contract only on evidence.** In a parallel change, the contract step
  removes the old interface "once all usages have been migrated"
  ([ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)). The
  evidence has to be reported by the consumers, not assumed.

## Decision

### 1. One integer contract version, shared by both sides

`@owlat/shared/imapWire` holds `IMAP_WIRE_VERSION` (the contract this build
speaks, 1 to start with) and `IMAP_WIRE_MIN_SUPPORTED` (the oldest IMAP
contract the backend still serves, 0 today). IMAP servers from before
reporting (v0.6.7 and older) count as wire version 0. The module is
dependency-free, and the api, imap and web images already copy
`packages/shared`.

- `IMAP_WIRE_VERSION` is bumped in the PR that changes the contract: a function
  the IMAP server calls changes an argument or a result field, or the IMAP
  server starts calling a function the previous backend does not have.
- `IMAP_WIRE_MIN_SUPPORTED` is raised only in the PR that removes a
  compatibility path, and only to a version every IMAP release inside the skew
  window speaks.

### 2. The skew policy

- Update the backend first, then the IMAP container. The in-app update and
  `owlat upgrade` do both, in that order.
- The IMAP server may run one release behind the backend: the N-1 window
  `apps/api/convex/CONVENTIONS.md` already gives every other client of the
  backend.
- It is never newer than the backend. A newer IMAP server waits for the
  backend instead of serving.
- An IMAP server outside the window refuses to start, with a log line naming
  both versions and the fix.

### 3. The handshake

Before it listens, the IMAP server calls `mail/imap/serverRegistry:report`
with a random per-process id, the container hostname, its `OWLAT_VERSION`, its
wire version and its start time. The backend records the report (one row per
host and build in `imapServers`) and answers with its own wire version, its
minimum and a verdict.

- Compatible: the server starts listening.
- Older than the minimum: the server logs one operator-facing error ("update
  the IMAP container") and exits non-zero. It never serves an unsupported
  contract.
- The backend is older (it has no `report` function, or reports a lower wire
  version): the server logs "update the backend first" and retries with capped
  backoff (1 s doubling to 60 s), because the backend may be mid-deploy.
- The backend cannot be reached: the same retry.

After that the server reports every 5 minutes on an unref'd timer. When a
later report says the backend no longer serves it (the backend was updated
past it, or rolled back below it), the server stops through the normal
shutdown path, which says BYE to every session, and exits non-zero, so its
restart runs the handshake again. A failed report is only logged.

### 4. Seeing servers that never report

A v0.6.7 IMAP server never calls `report`. It does call `mail/appPasswords:touch`
after each LOGIN. The new IMAP server passes `imapWireVersion` there, and the
SMTP submission webhook, the only other caller, passes `channel: 'smtp'`. A
touch with neither is a login through a legacy IMAP server: the backend
stamps `legacyImapSeenAt` on the `imapLegacy` row of `instanceCounters`, at
most once an hour, so logins do not contend on one row.

### 5. Operator visibility

- `npx convex run mail/imap/serverRegistry:status '{"days": 7}'` lists every
  server seen in the window with its release, wire version, last report and
  verdict (`current`, `supported`, `unsupported`, `ahead`), plus
  `legacyImapSeenAt`, `oldestWireVersionSeen` and `safeToRaiseMinTo`, the
  highest minimum that would refuse no server seen in the window (legacy
  counting as 0).
- Settings → System & updates shows the same for the last 7 days, with a
  warning when a legacy, unsupported or waiting server was seen.
- A daily cron deletes reports no server has refreshed for 30 days.

### 6. How a contract step uses this

The PR that removes a compatibility path (the first one will be
`expungeFolder`'s `sequenceNumbers` / `nextSequenceNumber`) raises
`IMAP_WIRE_MIN_SUPPORTED` past the releases that need it, which the policy
allows once those releases are outside the N-1 window. It cites the status
output of a deployment running the window's oldest IMAP release, and its
release notes tell operators to run the status command before updating. A
deployment that still runs an older IMAP container gets a refused start with
a clear log line instead of an IMAP server that fails halfway through an
EXPUNGE.

## Alternatives rejected

- **Compare release strings (semver).** A release says nothing about the
  contract: most releases do not change it, `dev` builds have no version, and
  the backend does not reliably know its own release (the Convex runtime's
  `OWLAT_VERSION` is set at setup, and an in-app update does not refresh it).
  An integer that moves only when the contract moves is exact and cannot be
  stale.
- **A version argument on every IMAP-called function.** Each function would
  have to branch on it, every new function would need it, and a mismatch would
  still surface partway through a command, after earlier writes committed.
  One check at the handshake refuses the server before it accepts a
  connection.
- **Warn only.** A warning in a log nobody reads leaves the failure the issue
  describes in place: an old server keeps serving and breaks after a
  contract step. Refusing to start is loud, safe and fixed by the update the
  operator was going to do anyway.

## Consequences

- An IMAP container started before its backend has been deployed (a fresh
  install before `convex-deploy`, the manual update path that runs
  `docker compose up -d` before deploying) waits and logs until the backend
  answers, instead of accepting logins that fail.
- The records are per deployment. The project still cannot see self-hosted
  deployments, so the skew window is what makes a contract step safe for all
  of them; the status command and the refused start make the window visible
  and enforced on each.
- A contract change across the boundary now needs a wire version bump in the
  same PR. `apps/api/convex/CONVENTIONS.md` ("IMAP wire version") says when.
