# Sealed Mail test fixtures

Checked-in, offline-generated fixture bytes for the Sealed Mail test suites. CI
never needs `gpg`, a live MTA, or Redis — the bytes are committed directly.

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
