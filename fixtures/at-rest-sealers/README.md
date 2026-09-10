# At-rest sealer fixtures

Envelopes produced by the three Web Crypto AES-256-GCM sealers **before** they
were consolidated onto the shared `apps/api/convex/lib/webSecretBox.ts`
primitive. Each file pins one sealed value, its plaintext, and the instance
secret it was sealed under, so the tests can prove the refactor did not move a
single byte of the wire format: an envelope written by the old code must still
open under the new code.

The ciphertexts were generated offline against the pre-refactor
implementations; regenerating them would defeat their purpose. Treat them as
frozen. A change that makes one of these fail to open is a **data-loss
migration**, not a test to update — bump the envelope version and add a re-seal
migration instead.

The secret is a fixture value that never existed on a real deployment.

## Files

- `atRestBodies-v1.json` — `apps/api/convex/lib/atRestBodies.ts`. Both
  envelopes: the colon-delimited inline-body string
  (`atrest:1:<b64 iv>:<b64 ct>`) and the binary blob envelope
  (`"ARBLB1" ‖ version ‖ iv ‖ ct`, stored here base64-encoded). Consumed by
  `apps/api/convex/lib/__tests__/atRestBodies.test.ts`.
- `credentialSeal-v1.json` — `apps/api/convex/integrationImports/credentialSeal.ts`.
  The `impcred:1:<b64 iv>:<b64 ct>` envelope that rides in
  `_scheduled_functions` args. Consumed by
  `apps/api/convex/integrationImports/__tests__/credentialSeal.test.ts`.
- `storageCursor-v1.json` — `apps/api/convex/plugins/storageCursor.ts`. The
  `plugin-storage-cursor.1.<b64url iv>.<b64url ct>` token, whose GCM
  additional-data binds the tenant, plugin, prefix and limit — so the fixture
  records the exact scope/request it was sealed under; opening it under any
  other scope must fail.
