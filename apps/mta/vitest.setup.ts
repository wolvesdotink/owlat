/**
 * Vitest global setup for the MTA suite.
 *
 * Provides a default MTA_SECRET so modules that seal transport secrets at rest
 * (smtp/dkimStore.ts via lib/secretBox.ts) work in unit tests without every test
 * file having to set it — in particular the DKIM store/rotation/sign suites,
 * which round-trip sealed private keys transparently. Uses `??=` so a test that
 * deliberately sets or clears MTA_SECRET (e.g. config validation) keeps control.
 */

process.env['MTA_SECRET'] ??= 'test-mta-secret-0123456789abcdef0123456789abcdef';
