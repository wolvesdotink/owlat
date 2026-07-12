# Sealed Mail interop fixtures

Checked-in byte corpus for the Sealed Mail pipeline (2026-07-11 plan): PGP/MIME
signing + encryption, ARC chain evaluation, TLS-RPT ingest, WKD hashing, and DNS
policy lookups. **CI never runs `gpg` or the network** — every consumer reads
these bytes directly, so the fixtures are committed rather than generated at test
time. Regeneration is an offline, developer-only step documented below.

## Generation status

| Group | Files | Status | Regeneration |
| --- | --- | --- | --- |
| WKD hashing | `wkd/hash-vectors.json` | **Real, verified** — deterministic z-base32(SHA-1(lowercase(local-part))); the `joe.doe` vector matches the canonical WKD draft example | `node` one-liner below |
| TLS-RPT | `tls-rpt/report.json`, `tls-rpt/report.json.gz` | **Real** — RFC 8460 report, gzipped exactly as a reporter would POST it | `node`/`zlib` below |
| DNS mocks | `dns/tlsa.json`, `dns/mta-sts-txt.json` | **Real** — hand-authored resolver-answer shapes (TLSA usage/selector/matching-type; `_mta-sts` TXT + policy body) | edit by hand |
| PGP/MIME | `pgp-mime/*.eml` | **Structural placeholders** — RFC 3156 message structure is real; the armored signature/ciphertext blocks are placeholders. Regenerating with real OpenPGP keys is a QA follow-up | `gpg` or `openpgp` below |
| ARC | `arc/*.eml` | **Structural placeholders** — RFC 8617 header sets are real; the `b=`/`bh=` signature values are placeholders. Regenerating with real keys is a QA follow-up | `gpg`/OpenARC below |

> The PGP/MIME and ARC `.eml` files carry **placeholder** cryptographic material
> (`PLACEHOLDER_...`, `=AAAA` armor tails). They exercise MIME parsing, header
> extraction, and the honesty-audit state machine (good-sig / bad-sig / no-sig /
> protected-headers; valid-rescue / broken-ams / untrusted-sealer / cv-fail).
> Producing GnuPG- or openpgp.js-signed versions with a committed test keyring is
> a tracked QA follow-up; do it offline and overwrite the bytes in place so CI
> stays gpg-free.

## PGP/MIME (`pgp-mime/`)

Four cases the reader badge state machine must distinguish:

- `good-sig.eml` — `multipart/signed`, detached OpenPGP signature that verifies.
- `bad-sig.eml` — `multipart/signed`, signature over the *original* body; the
  body was modified so verification must fail.
- `no-sig.eml` — ordinary `text/plain`; no OpenPGP layer at all (falls back to
  DKIM/SPF/DMARC only).
- `protected-headers.eml` — `multipart/encrypted` (PGP/MIME) with protected
  headers per locked decision **D4**: the outer `Subject` is the literal `...`
  and the real subject travels inside the encrypted part.

Regenerate with GnuPG (offline; uses a throwaway keyring):

```sh
export GNUPGHOME="$(mktemp -d)"
gpg --batch --quick-generate-key 'Alice <alice@sealed.example.com>' rsa3072 default never
# Sign the body part to produce a multipart/signed message:
gpg --armor --detach-sign --digest-algo SHA256 body.txt   # -> signature.asc
# Encrypt to Bob's public key for the protected-headers case:
gpg --armor --encrypt --recipient bob@sealed.example.org inner.eml
```

Or, keeping the repo gpg-free, with the checked-in `openpgp` dependency (added in
P0) via a one-off Node script:

```js
import * as openpgp from 'openpgp';
const { privateKey } = await openpgp.generateKey({ userIDs: [{ name: 'Alice', email: 'alice@sealed.example.com' }], type: 'ecc', curve: 'ed25519' });
const message = await openpgp.createMessage({ text: bodyPart });
const detachedSignature = await openpgp.sign({ message, signingKeys: privateKey, detached: true });
```

## ARC (`arc/`)

RFC 8617 chains for the ARC evaluator:

- `valid-rescue.eml` — intact chain (`cv=pass` at the receiver, trusted sealer)
  rescues a message whose SPF/DKIM broke through a forwarder.
- `broken-ams.eml` — the `ARC-Message-Signature` no longer covers the body.
- `untrusted-sealer.eml` — cryptographically intact but sealed by a domain not on
  the trusted-sealer list; its `cv=pass` must be ignored.
- `cv-fail.eml` — a prior set was tampered, so the latest seal records `cv=fail`.

Regenerate a real chain with OpenARC (`openarc`) or a Python `dkimpy`/`authres`
script sealing across two hops; overwrite the `b=`/`bh=` values in place.

## TLS-RPT (`tls-rpt/`)

`report.json` is an RFC 8460 aggregate report (STS enforce policy, one
validation failure); `report.json.gz` is the gzip a reporter POSTs. Regenerate:

```sh
node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync("report.json.gz",z.gzipSync(f.readFileSync("report.json")))'
```

## WKD hashing (`wkd/hash-vectors.json`)

Deterministic local-part hashing for the advanced WKD method
(`https://<domain>/.well-known/openpgpkey/hu/<hash>`). Recompute:

```sh
node -e 'const c=require("crypto");const A="ybndrfg8ejkmcpqxot1uwisza345h769";const zb=b=>{let s="";for(const x of b)s+=x.toString(2).padStart(8,"0");let o="";for(let i=0;i<s.length;i+=5)o+=A[parseInt(s.slice(i,i+5).padEnd(5,"0"),2)];return o};const wkd=l=>zb(c.createHash("sha1").update(l.toLowerCase(),"utf8").digest());console.log(wkd("Joe.Doe"))'
# -> iy9q119eutrkn8s1mk4r39qejnbu3n5q  (canonical WKD example)
```

## DNS mocks (`dns/`)

`tlsa.json` and `mta-sts-txt.json` are resolver-answer fixtures for the DANE
(**D6**: absent AD bit is treated as "no TLSA") and MTA-STS discovery paths.
Hand-edit to add cases.
