# Sealed Mail — two-real-instance manual QA

The automated headline proof runs entirely in CI:
`apps/api/convex/e2ee/__tests__/twoInstance.test.ts` stands up two independent
in-process instances (separate `INSTANCE_SECRET`s + key material), mocks the HTTP
between them, and proves discovery → seal → ciphertext-on-the-wire → open →
verified → unsigned-key-change conflict, against real OpenPGP crypto and no `gpg`.

This checklist covers only the parts that a CI fixture **cannot** stand in for —
a real GUI mail client, a third-party provider, a public network, and a human
eye on the badges. Run it against a **staging pair of real Owlat instances**
before flipping `sealedMail` / `senderAuthBadges` on by default.

Locked decisions this exercise validates end to end: **D1** PGP/MIME via
openpgp.js, **D2** auto-seal only when every recipient has a usable key, **D3**
decrypt-on-ingest into the normal pipeline, **D4** protected headers (outer
subject `...`), **D6** DANE via `DANE_MODE` (report-only never bounces by
default), **D7** recovery kit only.

---

## 0. Staging setup (once)

- [ ] Two internet-reachable Owlat instances on distinct domains — call them
      **A** (`a.staging.example`) and **B** (`b.staging.example`) — each with its
      own `INSTANCE_SECRET`, a valid TLS cert, and outbound mail working.
- [ ] On both: an admin enables **Sealed Mail** in Settings, then runs
      **"Publish encryption keys"** (backfill). Confirm delivery-readiness shows
      *encryption keys published* and that
      `https://<domain>/.well-known/owlat.json` returns a signed manifest and
      `https://<domain>/.well-known/openpgpkey/hu/<hash>?l=<localpart>` returns a
      binary key body for a real mailbox.
- [ ] A test mailbox on each: `alice@a.staging.example`, `bob@b.staging.example`.
- [ ] A **Thunderbird** profile (with the built-in OpenPGP/end-to-end feature)
      and access to a **Proton Mail** account for the interop legs.

## 1. WKD discovery from Thunderbird

- [ ] In Thunderbird, compose to `bob@b.staging.example` and let it discover the
      key via **WKD** (Account Settings → End-To-End Encryption → *Discover Keys*,
      or the compose-window key status). It must find B's published key.
- [ ] The discovered fingerprint matches B's admin key panel for that mailbox.

## 2. Thunderbird-composed sealed message opens in Owlat

> Moved here from the E4 automated gate by plan-owner decision (2026-07-13):
> a client-composed PGP/MIME message is a GUI artifact, not a checked-in fixture.

- [ ] From Thunderbird, send an **OpenPGP-encrypted + signed** message to
      `bob@b.staging.example` (encrypt to B's WKD key, sign with the Thunderbird
      key, and — if available — enable *protected headers* / encrypted subject).
- [ ] In B's Postbox the message **decrypts on ingest** (D3): the real subject
      and body render; the raw sealed `.eml` is still downloadable.
- [ ] The badge is honest: **verified** only if B has pinned the Thunderbird
      sender key (TOFU); otherwise it reads *sealed, sender not verified* — never
      a false "verified".

## 3. Owlat ↔ Owlat sealed round-trip (both directions)

- [ ] From A's Postbox, `alice@…` sends `bob@…` a 1:1 message. Auto-seal engages
      (D2) because bob's key is pinned. On the wire / in the stored `.eml`: the
      outer `Subject:` is the literal `...` (D4) and there is **no plaintext**.
- [ ] B opens it: real subject + body restored, badge **Sealed — sender
      verified** (signature verifies against the alice key B pinned).
- [ ] Reverse direction `bob@… → alice@…` behaves identically.
- [ ] Reply within the thread stays sealed; agent-drafted replies seal the same
      way (no special-casing).

## 4. Proton interop (one direction)

- [ ] From A, seal + send to the Proton address (A discovers Proton's key via
      WKD). Proton opens and verifies it. (Owlat mints the GnuPG/Proton-compatible
      *legacy* curve25519 profile, so Proton accepts the encryption target.)
- [ ] Real subject is hidden on the wire; Proton shows the protected subject.

## 5. Unsigned key change is caught (matches the CI proof, live)

- [ ] Re-mint B's `bob@…` key (rotate) **without** publishing a signed rotation.
- [ ] A's next send to bob **refuses to auto-seal** and surfaces *key changed —
      review before sending* (never silently seals to the new key). An admin
      re-accept restores sealing.

## 6. Transport hardening (external checkers)

- [ ] **MTA-STS**: an external checker (e.g. an MTA-STS validator / `hardenize`)
      sees A's and B's published `mta-sts.txt` policy + `_mta-sts` TXT, and a mail
      from a strict-policy sender to each domain negotiates TLS.
- [ ] **DANE** (only if `DANE_MODE` is `report`/`enforce`, `DANE_RESOLVER_URL` is
      set, and TLSA records are published, D6): a staging send to a DANE-enabled
      domain validates the TLSA record via the configured validating resolver (AD
      bit trusted; AD absent ⇒ treated as no TLSA). In `report` the result surfaces
      in TLS-RPT (tlsa policy) without ever bouncing; `enforce` defers a non-match.
      A local validating resolver is the documented production setup.
- [ ] **TLS-RPT**: with a `_smtp._tls` reporting record live, confirm at least one
      aggregate TLS report is received and appears on the TLS-RPT dashboard.

## 7. Badge visual pass (light + dark)

- [ ] Walk each reader state and confirm the copy is exactly what was
      cryptographically checked (the honesty audit):
      - **Sealed — sender verified** — only when decrypted **and** the signature
        verified against the pinned key.
      - **Sealed — sender not verified** — decrypted but no/failed signature pin.
      - **Encrypted — can't decrypt** — no usable key (unchanged legacy path).
      - **Key changed — review** — pinned fingerprint no longer matches.
      - Composer lock state for a recipient with no key / a changed key.
- [ ] Each state is legible in **light and dark** themes, uses the Fluid
      Functionalism tokens, and is keyboard-reachable with a visible focus ring.

---

### Sign-off

| Leg | Result | Notes |
| --- | --- | --- |
| 1 WKD from Thunderbird | ☐ pass ☐ fail | |
| 2 Thunderbird → Owlat opens | ☐ pass ☐ fail | |
| 3 Owlat ↔ Owlat round-trip | ☐ pass ☐ fail | |
| 4 Proton interop | ☐ pass ☐ fail | |
| 5 Key-change caught | ☐ pass ☐ fail | |
| 6 MTA-STS / DANE / TLS-RPT | ☐ pass ☐ fail | |
| 7 Badge visual pass | ☐ pass ☐ fail | |

Ship the default-on flag flip only when every leg passes.
