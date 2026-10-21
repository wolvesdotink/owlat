/**
 * FROZEN WIRE FIXTURES — what the backend answers the IMAP server and the
 * mail-sync worker with, recorded once per outcome of every worker-called
 * function.
 *
 * Test-only, but declared here rather than in a `__tests__` folder for one
 * reason: it is the only place apps/api and both workers can import ONE copy
 * from. A fixture each suite kept its own copy of would drift with the code it
 * was meant to catch. "Test-only" is enforced, not just stated: importing the
 * `@owlat/worker-protocol/wireFixtures` subpath outside a `__tests__/` folder
 * fails `scripts/check-cross-package-imports.sh`.
 *
 * THREE GATES HOLD THE FIXTURES TO THE CONTRACT.
 *
 * 1. TYPE, at compile time: each registry's fixtures `satisfies` a mapped type
 *    over that registry, so every endpoint needs at least one case and every
 *    value must be what the endpoint `returns`.
 * 2. THE PRODUCER, in apps/api: `mail/__tests__/workerWire*.test.ts` seed the
 *    deployment the fixtures describe, run each real handler (convex-test holds
 *    the answer to the registered `returns`), bind the placeholders to the ids
 *    the deployment minted, and require the answer to EQUAL the fixture.
 * 3. THE CONSUMERS, in apps/imap and apps/mail-sync: each fixture is fed through
 *    the worker's shipped checked client, which must hand it back unchanged.
 *
 * `MAIL_SYNC_LEGACY_WIRE_FIXTURES` are answers only an older backend gives; the
 * worker still accepts them mid-rollout, and no current handler may produce one.
 */

export {
	IMAP_FIXTURE_ENVELOPE_1,
	IMAP_FIXTURE_ENVELOPE_2,
	IMAP_FIXTURE_FOLDERS,
	IMAP_WIRE_FIXTURES,
	IMAP_WIRE_IDS,
} from './imap';
export {
	MAIL_SYNC_FIXTURE_CREDENTIALS,
	MAIL_SYNC_FIXTURE_OAUTH_CREDENTIALS,
	MAIL_SYNC_LEGACY_WIRE_FIXTURES,
	MAIL_SYNC_WIRE_FIXTURES,
	MAIL_SYNC_WIRE_IDS,
} from './mailSync';
export {
	bindWirePlaceholders,
	WIRE_PLACEHOLDER_PREFIX,
	type LegacyWireFixtures,
	type WireFixtureCase,
	type WireFixtureCases,
	type WireFixtures,
} from './types';

/** The instant every fixture deployment is seeded at. */
export const WIRE_FIXTURE_NOW = 1_750_000_000_000;
