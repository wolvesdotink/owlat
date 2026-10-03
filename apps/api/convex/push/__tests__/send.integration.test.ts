/**
 * The Web Push sender (push/send): one encrypted POST per device through the
 * SSRF guard, https only, and the push service's answer written back — 404/410
 * prunes the device, 201 stamps it, anything else leaves it alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { VAPID_ENV, pushHarness, seedDevice, seedMailbox, seedMessage } from './pushFixtures';

const guard = vi.hoisted(() => ({
	calls: [] as Array<{ url: string; init: Record<string, unknown> }>,
	statusFor: (_url: string): number => 201,
}));

vi.mock('../../lib/ssrfGuard', async () => {
	const actual = await vi.importActual('../../lib/ssrfGuard');
	return {
		...actual,
		fetchGuarded: vi.fn(async (url: string, init: Record<string, unknown>) => {
			guard.calls.push({ url, init });
			return new Response(null, { status: guard.statusFor(url) });
		}),
	};
});

const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([key, load]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../push/' + key.slice(3), load]
			: [key, load]
	)
);

beforeEach(() => {
	guard.calls = [];
	guard.statusFor = () => 201;
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
	vi.stubEnv('SITE_URL', 'https://owlat.example.com');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('push.send.deliver', () => {
	it('posts one encrypted message per device and prunes the ones that are gone', async () => {
		const t = await pushHarness(modules);
		await enableFeatures(t, ['postbox']);
		const { mailboxId, inboxId } = await seedMailbox(t, 'user-a');
		const { messageId } = await seedMessage(t, { mailboxId, folderId: inboxId });
		const live = await seedDevice(t, 'user-a', { endpoint: 'https://push.example.com/live' });
		const gone = await seedDevice(t, 'user-a', { endpoint: 'https://push.example.com/gone' });
		guard.statusFor = (url) => (url.endsWith('/gone') ? 410 : 201);

		await t.action(internal.push.send.deliver, {
			userId: 'user-a',
			event: { kind: 'mail', messageId },
		});

		expect(guard.calls.map((call) => call.url).sort()).toEqual([
			'https://push.example.com/gone',
			'https://push.example.com/live',
		]);
		const call = guard.calls[0]!;
		expect(call.init['method']).toBe('POST');
		expect(call.init['protocols']).toEqual(['https:']);
		const headers = call.init['headers'] as Record<string, string>;
		expect(headers['Content-Encoding']).toBe('aes128gcm');
		expect(headers['Urgency']).toBe('high');
		expect(headers['Authorization']).toMatch(/^vapid t=.+, k=/);
		// The body is ciphertext: nothing of the mail is readable on the wire.
		const body = new TextDecoder().decode(call.init['body'] as Uint8Array);
		expect(body).not.toContain('Lunch');

		const rows = await t.run((ctx) => ctx.db.query('pushSubscriptions').collect());
		expect(rows.map((row) => row._id)).toEqual([live]);
		expect(rows[0]?.lastSuccessAt).toBeTypeOf('number');
		expect(await t.run((ctx) => ctx.db.get(gone))).toBeNull();
	});

	it('keeps a device when its push service is only having a bad moment', async () => {
		const t = await pushHarness(modules);
		const device = await seedDevice(t, 'user-a');
		guard.statusFor = () => 503;
		await t.action(internal.push.send.deliver, {
			userId: 'user-a',
			event: { kind: 'test', subscriptionId: device },
		});
		expect(guard.calls).toHaveLength(1);
		const row = await t.run((ctx) => ctx.db.get(device));
		expect(row).not.toBeNull();
		expect(row?.lastSuccessAt).toBeUndefined();
	});

	it('sends nothing when the VAPID keys are gone', async () => {
		const t = await pushHarness(modules);
		const device = await seedDevice(t, 'user-a');
		vi.stubEnv('VAPID_PUBLIC_KEY', '');
		await t.action(internal.push.send.deliver, {
			userId: 'user-a',
			event: { kind: 'test', subscriptionId: device },
		});
		expect(guard.calls).toHaveLength(0);
	});
});
