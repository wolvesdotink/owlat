/**
 * The mail-sync wire fixtures are what these handlers answer.
 *
 * Each case seeds the deployment the fixtures describe
 * (`workerWireMailSync.testlib.ts`), runs the real handler the mail-sync worker
 * calls, and requires the answer to equal the frozen fixture once its
 * placeholders are bound to the ids this deployment minted. convex-test also
 * holds every answer to the function's registered `returns`. The legacy
 * fixtures (answers only an older backend gives) must match no `returns`.
 */

import { MAIL_SYNC_ENDPOINTS } from '@owlat/worker-protocol/mailSync';
import { matchesValidator } from '@owlat/worker-protocol/validatorMatch';
import {
	bindWirePlaceholders,
	MAIL_SYNC_LEGACY_WIRE_FIXTURES,
	MAIL_SYNC_WIRE_FIXTURES,
	WIRE_FIXTURE_NOW,
} from '@owlat/worker-protocol/wireFixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGoogleAccessTokenCache } from '../external/googleOAuthTokens';
import { seedMailSyncWireWorld } from './workerWireMailSync.testlib';
import { MAIL_SYNC_DRIVES, type MailSyncDrive } from './workerWireMailSyncDrives.testlib';
import { MAIL_SYNC_REMOTE_DRIVES } from './workerWireMailSyncRemoteDrives.testlib';

type Endpoint = keyof typeof MAIL_SYNC_ENDPOINTS;

const DRIVES: { readonly [K in Endpoint]: Readonly<Record<string, MailSyncDrive>> } = {
	...MAIL_SYNC_DRIVES,
	...MAIL_SYNC_REMOTE_DRIVES,
};

beforeEach(() => {
	vi.useFakeTimers({ now: WIRE_FIXTURE_NOW });
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	vi.stubEnv('SITE_URL', 'https://owlat.example/');
	vi.stubEnv('CONVEX_SITE_URL', 'https://convex.owlat.example');
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'client-secret');
	clearGoogleAccessTokenCache();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

const FIXTURE_CASES = (Object.keys(MAIL_SYNC_ENDPOINTS) as Endpoint[]).flatMap((key) =>
	MAIL_SYNC_WIRE_FIXTURES[key].map((fixture) => [`${key}: ${fixture.name}`, key, fixture] as const)
);

describe('mail-sync wire fixtures are what the handlers answer', () => {
	it('drives every fixture case, and only those', () => {
		expect(Object.keys(DRIVES).sort()).toEqual(Object.keys(MAIL_SYNC_ENDPOINTS).sort());
		for (const key of Object.keys(MAIL_SYNC_ENDPOINTS) as Endpoint[]) {
			expect(Object.keys(DRIVES[key]).sort(), key).toEqual(
				MAIL_SYNC_WIRE_FIXTURES[key].map((fixture) => fixture.name).sort()
			);
		}
	});

	it.each(FIXTURE_CASES)('%s', async (_title, key, fixture) => {
		const w = await seedMailSyncWireWorld();
		const answer = await DRIVES[key][fixture.name]!(w);
		expect(answer).toEqual(bindWirePlaceholders(fixture.value, w.ids));
	});
});

describe('legacy mail-sync answers', () => {
	it('are accepted by the worker and produced by no current handler', () => {
		for (const [key, fixtures] of Object.entries(MAIL_SYNC_LEGACY_WIRE_FIXTURES)) {
			const endpoint = MAIL_SYNC_ENDPOINTS[key as Endpoint];
			for (const fixture of fixtures) {
				expect(matchesValidator(endpoint.accepts, fixture.value), fixture.name).toBe(true);
				expect(matchesValidator(endpoint.returns, fixture.value), fixture.name).toBe(false);
			}
		}
	});
});
