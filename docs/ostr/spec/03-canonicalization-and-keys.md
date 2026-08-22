# 03. Canonicalization, signing, and key discovery

[Index](../spec-v0.md) · prev: [02. Attestations](02-attestations.md) · next:
[04. Evidence and reporting](04-evidence-and-reporting.md)

## 3.1 Canonical form

Attestations are signed as canonical JSON, not as whatever bytes happened to
arrive. Every party that hashes or signs an attestation MUST use RFC 8785 (JSON
Canonicalization Scheme):

- object members sorted by UTF-16 code-unit order of their names,
- no insignificant whitespace,
- numbers serialized per the ECMAScript `Number::toString` rules RFC 8785
  requires,
- strings escaped per RFC 8785, UTF-8 output.

`canonicalize(value)` and `canonicalBytes(value)` in
`packages/ostr-core/src/jcs.ts` are the reference implementation.

Constraints that follow, and that verifiers MUST enforce:

1. An attestation MUST NOT contain a JSON `null`, a non-finite number, or a
   value RFC 8785 cannot serialize.
2. Numbers MUST be integers within the safe-integer range unless a field's table
   entry says otherwise. Counts and log-scale buckets are integers; there is no
   float in the schema.
3. Duplicate member names in received JSON MUST cause rejection. Parsers that
   keep the last duplicate silently change what was signed.
4. Verification MUST re-canonicalize the parsed document rather than signature
   checking the received bytes. Two encodings of the same document are the same
   attestation, and only the canonical form is signed.

## 3.2 Signing

The signature covers the canonical form of the attestation with `sig` absent,
which is exactly `UnsignedAttestation`.

```
sig = "ed25519:" || base64( Ed25519-Sign( privKey, canonicalBytes(unsigned) ) )
```

Requirements:

- Signers MUST use Ed25519 (RFC 8032). The `ed25519:` prefix is the only
  algorithm label defined at `v: 1`; a verifier MUST reject any other prefix
  rather than inferring an algorithm from key or signature length.
- The base64 encoding MUST be standard base64 with padding (RFC 4648 §4).
- Removing `sig` MUST happen before canonicalization, not by string surgery
  afterwards.
- A verifier MUST check the signature before any schema or admissibility
  reasoning, and MUST NOT let an unverified attestation reach scoring, an
  explanation, or a query answer.

Keys travel as raw 32-byte Ed25519 values in base64. DER framing stays an
implementation detail (`packages/ostr-core/src/crypto.ts`).

## 3.3 Key discovery: `_ostr.<domain>`

An author's key lives in DNS, under the author's own domain, so key discovery
and rotation ride on the same control assumption email authentication already
makes. There is no new PKI and no registry-issued identity.

```
_ostr.mx.hinterland.camp. 3600 IN TXT "v=1; k=ed25519; p=Zm9vYmFyYmF6..."
```

Record format, `tag=value` pairs separated by `;` with optional surrounding
whitespace:

| Tag | Required | Value                                                                                                                                                                                                            |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v` | yes      | `1`. A record carrying any other `v` is for a version this document does not define: a verifier MUST skip it and MUST NOT treat it as a failure of the name, so future versions can be published beside this one |
| `k` | no       | Key type, default `ed25519`, which is the only value defined here. Absent means `ed25519`; any other value makes the record unusable and it is skipped                                                           |
| `p` | yes      | Base64 of the raw 32-byte public key. An empty `p` marks the key revoked                                                                                                                                         |

Rules:

- Tag order carries no meaning. Publishers SHOULD write `v` first for
  readability, and parsers MUST NOT depend on it; DNS gives no ordering
  guarantee worth building on.
- Tag names are case-insensitive; `p` is case-sensitive base64.
- A record with an unknown tag MUST be accepted and the unknown tag ignored.
- A malformed record MUST be ignored, and MUST NOT invalidate other records at
  the same name.
- A TXT record split into several character strings MUST be concatenated
  without separators before parsing, as DKIM does.

### Rotation and multiple records

Several TXT records at `_ostr.<domain>` mean rotation is in progress, not
ambiguity. A verifier MUST accept an attestation whose signature validates under
**any** well-formed record at the name.

- Publishers SHOULD publish the new key beside the old one for at least the
  longest TTL they have served, then withdraw the old one.
- Verifiers MUST NOT prefer records by order; DNS does not preserve it.
- Verifiers SHOULD cache by TTL and MUST NOT cache beyond it. A compromised key
  is withdrawn from DNS, and a verifier holding it past its TTL keeps a
  revocation from taking effect.
- An empty `p` explicitly revokes: a verifier MUST reject signatures under a key
  whose only record has an empty `p`.

### DNSSEC

Verifiers SHOULD validate the DNSSEC chain to `_ostr.<domain>` and MUST record
whether validation succeeded, because that fact is an input to observer
weighting. An unvalidated key record is usable, and scoring MAY weight it lower:
`ostr-policy-v1` does not, so at v1 the recorded fact is available to monitors
and to a later policy version rather than moving a number today
([06 §6.6](06-scoring.md)).

### What key discovery does not prove

A signature under the key at `_ostr.example.com` proves control of that DNS zone
at verification time and nothing more. It does not prove the author is honest,
that the counts are real, or that the same operator does not run forty other
observer domains. Those questions belong to observer standing
([06 §6.4](06-scoring.md)), diversity collapse, and monitor findings. Key
discovery answers "who signed this", never "is this true".

## 3.4 Key compromise

A compromised author key is a poisoning route ([10](10-threat-model.md)), and
the recovery path is public rather than quiet:

1. Withdraw the key from DNS, or publish it with an empty `p`.
2. Publish the replacement record.
3. For a subject, publish a `posture` attestation carrying
   `compromiseDisclosure` with `rotatedAt` and `affectedSelectors`.
4. Policy MAY retroactively exclude attestations signed by the compromised key
   inside the disclosed window. Exclusion MUST be a policy rule that everyone
   recomputes identically, never an aggregator-local edit, and the excluded
   entries stay in the log.

Disclosure is scored leniently exactly once. A domain that discloses compromise
repeatedly is telling the registry something true about its operations, and
chronic disclosure is negative evidence.
