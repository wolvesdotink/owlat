# Sealed Mail test fixtures

Checked-in, offline-generated fixture bytes for the Sealed Mail test suites. CI
never needs `gpg`, a live MTA, or Redis — the bytes are committed directly.

## Outbound sealing / protected headers (RFC 9580 profile, E3)

- `pgp/protected-headers-input.eml` — a canonical RFC 5322 message (real
  `Subject`, a plaintext body carrying the `CANARY_SEALED_FIXTURE_PLAINTEXT_…`
  marker, and one base64 attachment). Consumed by
  `apps/api/convex/e2ee/__tests__/seal.test.ts` as the cross-check fixture: the
  test seals it with `sealMime`, then decrypts the ciphertext with a freshly
  generated recipient key and verifies the sender signature with `openpgp.js`,
  and asserts the recovered inner message is **structurally identical** to this
  fixture (same real subject + body + attachment inside) while the outer message
  carries only `Subject: ...` and no plaintext canary.

  GnuPG interop is a **QA follow-up**: the committed artifact here is the
  deterministic plaintext INPUT (a sealed sample's ciphertext is
  non-deterministic — a random session key per encryption — so it cannot be a
  byte-stable fixture). Re-verifying that GnuPG (`gpg --decrypt`) opens a
  `sealMime` output offline is tracked as manual QA, not a CI gate; the
  `openpgp.js` round-trip above is the automated regression.

## Inbound unsealing / decrypt-on-ingest (E4)

A committed, byte-stable **sealed message** plus the keys needed to open it, so
the inbound path (`e2ee/open.ts:openSealed`) can be regression-tested against a
ciphertext it did not itself produce. Consumed by
`apps/api/convex/e2ee/__tests__/open.test.ts` (the INTEROP case).

- `pgp/inbound-sealed-goodsig.eml` — a PGP/MIME `multipart/encrypted` message
  whose outer `Subject` is the `...` placeholder (protected headers, D4); the
  inner ciphertext holds the real subject `Q3 sealed interop numbers` and a
  `multipart/alternative` body carrying the `CANARY_INBOUND_INTEROP_…` marker in
  both `text/plain` and `text/html`. Encrypted to `inbound-recipient` and signed
  by `inbound-sender`.
- `pgp/inbound-recipient.secret.asc` / `pgp/inbound-recipient.public.asc` — the
  test recipient keypair; the secret half opens the fixture.
- `pgp/inbound-sender.public.asc` — the test sender's public key; verifying the
  fixture's signature against it yields `signatureValid: true`.

These bytes were generated **offline** with `openpgp.js` (RFC 9580 profile) — the
same standards-compliant encoding GnuPG/Thunderbird emit — so CI never needs
`gpg`. Cross-opening the fixture with GnuPG/Thunderbird remains manual QA, exactly
as for the outbound E3 fixture above; the `openpgp.js` decrypt here is the
automated regression. The recipient private key is unencrypted **on purpose** —
it is a throwaway test key that guards nothing.

## TLS-RPT (RFC 8460)

- `tls-report-sample.json` — a human-readable real-world-shaped aggregate report
  (Google reporting an `sts` enforce policy for our MX, with two failure types).
- `tls-report-sample.json.gz` — the same report gzip-compressed, i.e. the exact
  `application/tlsrpt+gzip` wire form a receiver posts to our reporting address.
  Consumed by `apps/api/convex/domains/__tests__/tlsReports.test.ts`.

Regenerate with:

```sh
node -e '
const { gzipSync } = require("zlib");
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("fixtures/sealed-mail/tls-report-sample.json", "utf8"));
fs.writeFileSync("fixtures/sealed-mail/tls-report-sample.json.gz", gzipSync(Buffer.from(JSON.stringify(r))));
'
```
