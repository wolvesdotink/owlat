// Default test environment: a configured MTA delivery provider.
//
// The operating-modes work made "is a delivery provider configured?" an
// explicit, fail-closed check (`lib/sendProviders/capability.ts`). Before it,
// the send paths implicitly defaulted to the MTA, so tests exercised sending
// without ever setting `EMAIL_PROVIDER`. Restore that baseline here so the
// thousands of existing send-path tests keep a provider; the handful of tests
// that exercise the *unconfigured* path clear these vars themselves.
//
// `??=` keeps any value already provided by the CI environment.
process.env['EMAIL_PROVIDER'] ??= 'mta';
process.env['MTA_API_URL'] ??= 'http://mta:3100';
process.env['MTA_API_KEY'] ??= 'test-key';

// The BetterAuth session-signing secret is now fail-closed (auth.ts uses
// getRequired, not getOptional) so a misconfigured deploy can't silently fall
// back to a publicly-known default. Real deploys always set it (quickstart
// generates it); provide a fixed one here so auth-constructing tests work.
process.env['BETTER_AUTH_SECRET'] ??= 'test-better-auth-secret-0123456789abcdef';
