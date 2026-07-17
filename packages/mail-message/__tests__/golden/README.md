# Golden `.eml` corpus

Byte-for-byte reference outputs of the in-house mail stack — the "insurance
policy" for `@owlat/mail-message` (own-the-mail piece R2).

Each `<case>.eml` is the EXACT wire message our own code produces for one case in
the M2 differential corpus (`../fixtures/corpus.ts`):

```
composeMessage(toComposeInput(case)).raw   →   signMessage(raw, key)
```

i.e. the RFC 5322 / MIME builder that replaced nodemailer, followed by the DKIM
signer that replaced mailauth. The single source of truth for how a golden is
built is [`goldens.ts`](./goldens.ts); the key material and the frozen sign time
are in [`keyMaterial.ts`](./keyMaterial.ts).

## What the goldens guard

- **`__tests__/golden.test.ts`** — recomputes every golden and asserts it equals
  the committed bytes EXACTLY (stricter than the semantic compose differential),
  then re-verifies each committed signature with **mailauth** (the independent
  oracle) so the bytes we ship keep verifying `pass` under a foreign
  implementation.
- **`src/__tests__/goldenParse.differential.test.ts`** — feeds every golden back
  through the parse-side P3 differential (parse with mailparser vs our
  `parseMessage`, compare every consumed field). The compose half and the parse
  half of the one package must agree on the wire format they emit and read.

## Determinism

Goldens are reproducible because everything that could vary is pinned: the
compose boundary seed (`case.name`), each case's `messageId` + `date`, a fixed
2048-bit test key and a frozen `t=` sign time. Re-generating with no code change
leaves the working tree clean.

## Regenerating (the ONLY sanctioned way)

Never hand-edit a `.eml` — that defeats the byte-for-byte gate. When a
legitimate change to the composer or signer moves the bytes:

```sh
# from the repo root
bun run goldens:update
# or from packages/mail-message
bun run goldens:update
```

This rewrites one `.eml` per corpus case and deletes any orphan whose case was
removed. Eyeball the resulting `git diff` and commit the regenerated corpus
alongside the code change.

## Test key

`keyMaterial.ts` holds a throwaway RSA key that signs ONLY these fixtures, under
the reserved TLD `owlat.test` (which can never receive real mail). It is never
referenced by any runtime code path and grants access to nothing. Its public
half is the DKIM DNS `TXT` record the byte-diff test resolves for verification.
