/**
 * Web Push device management (push/subscriptions): the self-scoped surface
 * behind Preferences → This device. Covers the "feature hidden without keys"
 * contract, input validation on the endpoint the sender will later fetch,
 * ownership moves, the per-person device cap, and that no read ever hands the
 * device keys back to the browser.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { DEVICE_KEYS, VAPID_ENV, seedDevice } from './pushFixtures';

const session = vi.hoisted(() => ({ userId: 'user-a' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const current = () => ({
		userId: session.userId,
		role: 'editor',
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => current()),
		getMutationContext: vi.fn(async () => current()),
		getBetterAuthSessionWithRole: vi.fn(async () => current()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

// Sibling `push/*` modules glob in as `../foo.ts`; convex-test resolves function
// paths from the convex root, so re-root them to `../../push/foo.ts`.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([key, load]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../push/' + key.slice(3), load]
			: [key, load]
	)
);

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

function subscribeArgs(overrides: Record<string, string> = {}) {
	return {
		endpoint: ENDPOINT,
		...DEVICE_KEYS,
		label: 'Chrome on macOS',
		timeZone: 'Europe/Berlin',
		...overrides,
	};
}

beforeEach(() => {
	session.userId = 'user-a';
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('push.subscriptions without VAPID keys', () => {
	it('reports the feature as off and refuses to register a device', async () => {
		vi.unstubAllEnvs();
		vi.stubEnv('VAPID_PUBLIC_KEY', '');
		vi.stubEnv('VAPID_PRIVATE_KEY', '');
		const t = convexTest(schema, modules);
		const status = await t.query(api.push.subscriptions.status, {});
		expect(status).toEqual({ isConfigured: false, publicKey: null, isPrivate: false, devices: [] });
		await expect(t.mutation(api.push.subscriptions.subscribe, subscribeArgs())).rejects.toThrow(
			/not set up/
		);
	});
});

describe('push.subscriptions', () => {
	it('registers a device and lists it without its keys or endpoint', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.push.subscriptions.subscribe, subscribeArgs());

		const status = await t.query(api.push.subscriptions.status, { endpoint: ENDPOINT });
		expect(status.isConfigured).toBe(true);
		expect(status.publicKey).toBe(VAPID_ENV.VAPID_PUBLIC_KEY);
		expect(status.devices).toHaveLength(1);
		expect(status.devices[0]).toMatchObject({ label: 'Chrome on macOS', isCurrent: true });
		const serialized = JSON.stringify(status);
		expect(serialized).not.toContain(DEVICE_KEYS.auth);
		expect(serialized).not.toContain(DEVICE_KEYS.p256dh);
		expect(serialized).not.toContain(ENDPOINT);

		const elsewhere = await t.query(api.push.subscriptions.status, {
			endpoint: 'https://push.example.com/other',
		});
		expect(elsewhere.devices[0]?.isCurrent).toBe(false);

		const row = await t.run((ctx) => ctx.db.query('pushSubscriptions').first());
		expect(row?.timeZone).toBe('Europe/Berlin');
	});

	it('refuses endpoints the sender must never fetch, and malformed keys', async () => {
		const t = convexTest(schema, modules);
		for (const endpoint of [
			'http://push.example.com/x',
			'https://127.0.0.1/x',
			'https://user:pass@push.example.com/x',
			'not a url',
			`https://push.example.com/${'a'.repeat(2100)}`,
		]) {
			await expect(
				t.mutation(api.push.subscriptions.subscribe, subscribeArgs({ endpoint }))
			).rejects.toThrow();
		}
		await expect(
			t.mutation(api.push.subscriptions.subscribe, subscribeArgs({ p256dh: 'AAAA' }))
		).rejects.toThrow(/P-256/);
		await expect(
			t.mutation(api.push.subscriptions.subscribe, subscribeArgs({ auth: 'not base64!' }))
		).rejects.toThrow(/16 bytes/);
		expect(await t.run((ctx) => ctx.db.query('pushSubscriptions').collect())).toHaveLength(0);
	});

	it('drops an unknown time zone instead of storing it', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.push.subscriptions.subscribe, subscribeArgs({ timeZone: 'Mars/Olympus' }));
		const row = await t.run((ctx) => ctx.db.query('pushSubscriptions').first());
		expect(row?.timeZone).toBeUndefined();
	});

	it('moves an endpoint to whoever enabled it last, without a duplicate row', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.push.subscriptions.subscribe, subscribeArgs());
		session.userId = 'user-b';
		await t.mutation(api.push.subscriptions.subscribe, subscribeArgs({ label: 'Shared laptop' }));
		const rows = await t.run((ctx) => ctx.db.query('pushSubscriptions').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ userId: 'user-b', label: 'Shared laptop' });
		session.userId = 'user-a';
		expect((await t.query(api.push.subscriptions.status, {})).devices).toHaveLength(0);
	});

	it('keeps at most 20 devices, dropping the one silent the longest', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const stalest = await seedDevice(t, 'user-a', { createdAt: now - 10 * 86_400_000 });
		for (let i = 0; i < 19; i++) {
			await seedDevice(t, 'user-a', { createdAt: now - i * 1000, lastSuccessAt: now });
		}
		await t.mutation(api.push.subscriptions.subscribe, subscribeArgs());
		const rows = await t.run((ctx) =>
			ctx.db
				.query('pushSubscriptions')
				.withIndex('by_user', (q) => q.eq('userId', 'user-a'))
				.collect()
		);
		expect(rows).toHaveLength(20);
		expect(rows.some((row) => row._id === stalest)).toBe(false);
		expect(rows.some((row) => row.endpoint === ENDPOINT)).toBe(true);
	});

	it('removes only the caller’s own devices', async () => {
		const t = convexTest(schema, modules);
		const theirs = await seedDevice(t, 'user-b');
		expect(await t.mutation(api.push.subscriptions.remove, { subscriptionId: theirs })).toEqual({
			removed: false,
		});

		await t.mutation(api.push.subscriptions.subscribe, subscribeArgs());
		expect(await t.mutation(api.push.subscriptions.remove, { endpoint: ENDPOINT })).toEqual({
			removed: true,
		});
		const rows = await t.run((ctx) => ctx.db.query('pushSubscriptions').collect());
		expect(rows.map((row) => row._id)).toEqual([theirs]);
	});

	it('stores private notifications on the shared hide-preview preference', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.push.subscriptions.setPrivate, { isPrivate: true });
		const row = await t.run((ctx) => ctx.db.query('mailUserSettings').first());
		expect(row).toMatchObject({ userId: 'user-a', isHidePreviewOn: true, autoAdvance: 'next' });
		expect((await t.query(api.push.subscriptions.status, {})).isPrivate).toBe(true);
		await t.mutation(api.push.subscriptions.setPrivate, { isPrivate: false });
		expect((await t.query(api.push.subscriptions.status, {})).isPrivate).toBe(false);
	});

	it('schedules a test push for the caller’s device and refuses anyone else’s', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const mine = await seedDevice(t, 'user-a');
		const theirs = await seedDevice(t, 'user-b');
		await t.mutation(api.push.subscriptions.sendTest, { subscriptionId: mine });
		await expect(
			t.mutation(api.push.subscriptions.sendTest, { subscriptionId: theirs })
		).rejects.toThrow(/not found/i);
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.name).toBe('push/send:deliver');
		expect(scheduled[0]?.args[0]).toEqual({
			userId: 'user-a',
			event: { kind: 'test', subscriptionId: mine },
		});
	});
});
