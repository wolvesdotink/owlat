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
| PGP/MIME | `pgp-mime/*.eml` | **Real, self-verified** — genuine OpenPGP material produced by `pgp-mime/generate.mjs` with the committed throwaway keys: `good-sig` verifies, `bad-sig` fails, `protected-headers` decrypts to the inner subject (outer `Subject` stays `...` per D4). Bytes are CRLF; `.gitattributes` exempts the corpus from EOL normalization | `node pgp-mime/generate.mjs` |
| ARC | `arc/*.eml` | **Structural placeholders** — RFC 8617 header sets are real; the `b=`/`bh=` signature values are placeholders. No sanctioned offline ARC sealer is in the dependency set, so real chains are a QA follow-up | `gpg`/OpenARC below |

> The ARC `.eml` files still carry **placeholder** cryptographic material
> (`PLACEHOLDER_...`, `=AAAA` armor tails): they exercise the RFC 8617 header-set
> parsing and the honesty-audit state machine (valid-rescue / broken-ams /
> untrusted-sealer / cv-fail) but not real seal verification. Producing real
> chains with a committed keyring is a tracked follow-up; do it offline and
> overwrite the bytes in place so CI stays gpg-free.
>
> The PGP/MIME `.eml` files are **real**: regenerate them any time with
> `node pgp-mime/generate.mjs` (resolves the checked-in `openpgp` dependency; no
> GnuPG needed). The script self-verifies and exits non-zero if the material is
> not genuine.

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

The throwaway keys that produced these fixtures are committed under
`pgp-mime/keys/` (`alice` signs, `bob` decrypts; public + private, ASCII-armored).
They protect nothing — they exist purely so verification/decryption is
reproducible and so downstream honesty-audit tests can assert real signatures.

Regenerate, gpg-free, with the checked-in `openpgp` dependency (added in P0) —
run from `apps/api` (where `openpgp` resolves):

```sh
node fixtures/sealed-mail/pgp-mime/generate.mjs
```

`generate.mjs` mints fresh Alice/Bob keys, signs the exact CRLF body part
(`good-sig`), signs the original body then embeds a modified one (`bad-sig`),
encrypts an inner MIME part whose real `Subject` travels inside while the outer
`Subject` stays `...` (`protected-headers`), overwrites the `.eml` + key bytes in
place, and self-verifies (exits non-zero if the material is not genuine). Because
it re-mints keys, every run rewrites `keys/` too.

GnuPG regeneration remains a valid offline alternative but is not required and CI
never invokes it.

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
