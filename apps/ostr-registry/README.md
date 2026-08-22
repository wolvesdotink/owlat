# @owlat/ostr-registry

An OSTR registry node: an append-only Merkle transparency log, the reference
aggregator that runs the open scoring policy over it, DNS zone generation,
signed snapshots with a diff feed, and the public query API. It runs standalone
in one container and depends on nothing else in Owlat (plan §4.1, §8, §12.1;
spec in `docs/ostr/`).

One item of §12.1's list is deliberately not here: the public explorer UI. §13
puts an internal explorer at Phase 1 and the public per-subject evidence pages at
Phase 2, so it is deferred rather than dropped. `OSTR_REF_BASE_URL` is the seam
it will be served under — every published TXT answer already carries an evidence
link built from it — and until then that base points at whatever an operator
serves there.

Two claims come out of this process, signed by two different keys. The log
says "these leaves, in this order" and signs a tree head. The aggregator says
"this policy over those leaves gives these scores" and signs a snapshot.
Anyone can check either one without trusting the server, which is the whole
point of running a registry rather than a database.

## Run it

```sh
# one signing key; run it twice, once per key
node -e 'const {privateKey} = require("node:crypto").generateKeyPairSync("ed25519");
console.log(privateKey.export({type:"pkcs8",format:"der"}).subarray(16).toString("base64"))'
```

```sh
# development
cd apps/ostr-registry
OSTR_LOG_ID=log.ostr.example \
OSTR_LOG_PRIVATE_KEY=<key 1> \
OSTR_AGGREGATOR_PRIVATE_KEY=<key 2> \
bun run dev
```

```sh
# container, from the repo root
docker build -f apps/ostr-registry/Dockerfile -t owlat-ostr-registry .
docker run -p 3300:3300 -v ostr-data:/app/data \
  -e OSTR_LOG_ID=log.ostr.example \
  -e OSTR_LOG_PRIVATE_KEY=... \
  -e OSTR_AGGREGATOR_PRIVATE_KEY=... \
  owlat-ostr-registry
```

Both keys are raw 32-byte ed25519 private keys in base64, the form
`@owlat/ostr-core` signs with. Generate them with `generateEd25519KeyPair()`
from that package and publish the two public keys next to the node, because a
head or a snapshot nobody can verify is a claim nobody has to believe.

Mount a volume at the database directory. The log is append-only evidence: a
node that loses it cannot reproduce the heads it has already signed, and it
refuses to start rather than serve a tree that contradicts them.

## Configuration

| Variable                        | Default                              | What it does                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OSTR_LOG_ID`                   | required                             | This log's stable identifier. It is signed into every tree head and inclusion promise, so changing it on a live log orphans every proof already issued.                                                                                                                                                                                                                                        |
| `OSTR_LOG_PRIVATE_KEY`          | required                             | Raw base64 ed25519 key the log signs heads and promises with.                                                                                                                                                                                                                                                                                                                                  |
| `OSTR_AGGREGATOR_PRIVATE_KEY`   | required                             | Raw base64 ed25519 key the aggregator signs snapshots with. Keep it distinct from the log's: one key for both claims makes them indistinguishable to a monitor.                                                                                                                                                                                                                                |
| `OSTR_REGISTRY_PORT`            | `3300`                               | HTTP port. `0` takes an ephemeral one.                                                                                                                                                                                                                                                                                                                                                         |
| `OSTR_REGISTRY_LISTEN`          | `0.0.0.0`                            | Bind address: an IPv4/IPv6 literal or `localhost`. A hostname is refused at startup rather than surfacing as a `getaddrinfo` failure after both stores are already open.                                                                                                                                                                                                                       |
| `OSTR_DB_DIR`                   | `./.data` (`/app/data` in the image) | Directory holding `log.sqlite` and `scores.sqlite`. The dev default is dotted because the repo ignores `.data/`: a transparency log and its signing state must not sit in the working tree one `git add -A` away from being committed.                                                                                                                                                         |
| `OSTR_ZONE_ORIGIN`              | `ostr.invalid`                       | Apex of the generated query zone. The default is reserved by RFC 2606 and can never resolve, so an unconfigured node publishes an obvious placeholder instead of claiming a real name.                                                                                                                                                                                                         |
| `OSTR_REF_BASE_URL`             | `https://<origin>/s`                 | Evidence-page base URL interpolated into every published TXT answer.                                                                                                                                                                                                                                                                                                                           |
| `OSTR_STH_INTERVAL_SECONDS`     | `3600`                               | How often a tree head is published, whether or not anything was appended. Silence and a stalled log have to be distinguishable (spec 05 §5.3).                                                                                                                                                                                                                                                 |
| `OSTR_REFRESH_INTERVAL_SECONDS` | `3600`                               | How often scores, zone, snapshot and diff feed recompute from the log.                                                                                                                                                                                                                                                                                                                         |
| `OSTR_MMD_SECONDS`              | `86400`                              | Published maximum merge delay. Every inclusion promise states it, and missing it is a broken promise. **Invariant, checked at startup:** it must be at least `OSTR_STH_INTERVAL_SECONDS`. A leaf can only become covered at the head cadence, so a node publishing less often than the delay it promises is in permanent MMD violation from its first submission.                              |
| `OSTR_SUBMIT_RATE_PER_MINUTE`   | unset                                | Node-wide ceiling on submissions in any clock minute; over it, `POST` answers `429` with `Retry-After`. Unset means no limit. Node-wide and not per-IP on purpose: what a submission costs a third party is a DNS lookup for its attacker-chosen observer name, and the source address of a flood is the free part to forge. Reads are never limited. Publish whatever you set (spec 08 §8.2). |
| `LOG_LEVEL`                     | `info`                               | pino level for this process's own logging: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`.                                                                                                                                                                                                                                                                                     |
| `OSTR_BOOTSTRAP_OBSERVERS`      | unset                                | The §4.2 published allowlist. Only a genuinely **unset** variable means open submission — set-but-empty is refused, because an unset compose interpolation must not silently un-list every seed observer.                                                                                                                                                                                      |

Anything missing or malformed throws at startup. A node that boots with a
truncated key looks healthy and publishes signatures nobody can check.

### The bootstrap allowlist

Observer standing is earned by corroboration against other observers (§6.3),
which is circular at genesis. Phases 0 to 2 therefore run on an editorial trust
anchor, named as such: a list of seed observers this node accepts, and nobody
else. It sunsets by Phase 3.

```sh
# DNS keys, allowlist enforced
OSTR_BOOTSTRAP_OBSERVERS="mx.a.example, mx.b.example"

# key pinned inline, for a federation standing up before its DNS does
OSTR_BOOTSTRAP_OBSERVERS="mx.a.example=<base64 ed25519 public key>"
```

Listed observers still publish and rotate their keys at `_ostr.<domain>` unless
an entry pins one. The allowlist gates submission only. Nothing in the scoring
policy knows it exists, because a score bonus for being on a list is the
pay-with-data the policy bars (§11).

## API

Everything except submission is public, anonymous and cacheable. There are no
API keys: an attestation carries an ed25519 signature over its own canonical
form and names the observer whose key is in DNS, so the record authenticates
itself.

| Endpoint                                  | What you get                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/attestations`                   | Submit a signed attestation. `201` with the log index and a signed inclusion promise, or `422` with every validation error at once. Acceptance means well-formed and correctly signed, never true. `503` with `Retry-After` means key discovery is saturated — the submission is fine, retry it. |
| `GET /v1/log/sth`                         | The latest signed tree head. Never cached, since a stale head is indistinguishable from a stalled log.                                                                                                                                                                                           |
| `GET /v1/log/proof/inclusion?hash=&size=` | Audit path for a leaf, by leaf hash (`?index=` also works).                                                                                                                                                                                                                                      |
| `GET /v1/log/proof/consistency?from=&to=` | Consistency proof between two tree sizes.                                                                                                                                                                                                                                                        |
| `GET /v1/log/entries?start=&end=`         | A page of leaves, so a monitor can rebuild the tree and check this node's arithmetic.                                                                                                                                                                                                            |
| `GET /v1/subject/:subject`                | The subject's tier, score and explanation. A domain, an IPv4 literal, or a percent-encoded IPv6 literal.                                                                                                                                                                                         |
| `GET /v1/subject/:subject/evidence`       | The attestations behind the score, each with an inclusion proof against the head served alongside them. Verify that head yourself.                                                                                                                                                               |
| `GET /v1/snapshot`                        | The signed scored set, with the log heads it was computed against.                                                                                                                                                                                                                               |
| `GET /v1/diff?since=&limit=`              | Changed subjects since a feed sequence number. Unsigned in v1 — see below.                                                                                                                                                                                                                       |
| `GET /v1/zone`                            | The generated zone file: TXT tier answers plus the `bl.`/`wl.` A-record views an existing Postfix or Rspamd setup can consume unchanged.                                                                                                                                                         |
| `GET /healthz`                            | Liveness only. It answers without touching either database, so it says the process is up, never that the stores are readable.                                                                                                                                                                    |

The zone is emitted unsigned. It has to be served DNSSEC-signed, which for a
zone this size churning hourly means online signing with NSEC3 or compact
denial of existence. That is the nameserver's job, not the aggregator's.

A subject the policy admitted no evidence for is absent from the zone and
answers NXDOMAIN. It is never published as `tier=unknown`.

**The diff feed is unsigned in v1, and that one is a deviation.** Spec 08 §8.3
requires snapshots _and_ diffs to be signed; `@owlat/ostr-core` defines an
envelope for the first and none for the second, so this node serves diff pages
bare rather than inventing a signature format ahead of the spec. A page is
therefore worth what the connection you fetched it over is worth and no more —
`@owlat/ostr-client` refuses the feed unless `allowUnsignedDiffs` is set, and a
consumer that needs a checkable copy resyncs from `/v1/snapshot`, which is
signed. Every feed line does persist the policy version and the as-of head set
it was written under, so the same pages become signable unchanged the day core
lands the envelope.

## Operating notes

One writer per log. The node takes an exclusive lock on startup and a second
process over the same files fails there, loudly, instead of half way through an
append. Two writers would sequence different leaves at the same index and sign
two heads of one size, which is equivocation committed by a rolling restart.

`src/index.ts` is the only file in this workspace that calls a clock
unconditionally, arms a timer, resolves DNS or opens a file. Every one of those
is an argument elsewhere — two modules name a wall-clock default so a mis-wiring
degrades to real time rather than crashing — so replaying the same submissions
produces the same tree, the same heads and the same snapshot bytes, signature
included.

**Startup binds the port last.** Boot opens both stores, publishes a covering
head if the previous process left leaves uncovered, and runs one full refresh —
a rescore of every subject from the log — before the listener accepts anything.
That order means the first request served reads fresh scores rather than an
empty index, and the price is that on a log with real volume the container is up
with a closed port for the length of a scoring pass. Size an orchestrator's
startup probe accordingly; `/healthz` is liveness only and answers as soon as the
port is open.

Key discovery is bounded on the way out. An observer name in a submission is
attacker-chosen, so `_ostr.<observer>` lookups are cached (positive TTL, shorter
negative TTL, capped working set) **and** capped in concurrency: past the cap a
new name is refused with `503` + `Retry-After` instead of a query being issued.
Refusing our own submission is the right end of that trade — the alternative is
being someone's DNS amplifier against `<random>.victim.example`.

## Tests

```sh
cd apps/ostr-registry
npx vitest run          # vitest, never `bun test`
npx tsc --noEmit
npx oxlint --config ../../oxlintrc.json src
```

`src/__tests__/e2e.test.ts` boots the real node on an ephemeral port, submits
three signed attestations over HTTP and verifies every answer with
`@owlat/ostr-core` alone: the head against the log's key, the audit path against
that head's root, the snapshot against the aggregator's key. Three and not one
because a one-leaf tree has an empty audit path, which makes `verifyInclusion`
degenerate into comparing the leaf hash with the root and proves nothing about
sibling ordering or level construction. That is the Phase 0 exit check, and it is
what an outside monitor does.

`src/__tests__/composition.test.ts` covers what booting with `startTimers: false`
cannot reach: the schedules' overlap guard and error handling, the submission
valve, and the branch that picks a key directory.
