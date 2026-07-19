# Deliverability Lab fixtures

`seed-test-payload.json` is the canonical Tier-3 seed-test job payload. It pins
the wire contract that crosses the plugin/worker boundary: the
`@owlat/example-deliverability-lab` package emits this shape from
`buildSeedTestPayload`, and `apps/code-worker`'s `runSeedTest` consumes it. Both
test suites read this same file, so the two independently maintained sides
cannot drift on the payload shape without a test failing.
