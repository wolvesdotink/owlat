/**
 * The replay claim, against a real database (the seams plan's D6/P2.2).
 *
 * The route suite proves the ROUTE refuses a delivery the claim mutation
 * rejects. This proves the mutation itself does the rejecting — the property the
 * whole replay defense rests on — plus the two things a claim table gets wrong
 * if nobody looks: it must not grow without bound, and it must not turn our own
 * failure into a permanent refusal of the provider's honest redelivery.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';

// Two globs merged, because Vite's `import.meta.glob` omits the directory chain
// it climbed to reach the base — see the note in `adapterRegistry.test.ts`.
const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
			path.replace(/^\.\.\//, '../../webhooks/'),
			mod,
		])
	),
};

const PLUGIN_ID = 'mail-pack';
const KIND = 'plugin.mail-pack.postmark';
const TOLERANCE_MS = 600_000;

function claimArgs(digest: string, expiresAt = Date.now() + TOLERANCE_MS) {
	return { pluginId: PLUGIN_ID, transportKind: KIND, deliveryDigest: digest, expiresAt };
}

describe('plugin webhook delivery claims', () => {
	it('accepts a digest once and refuses it while it is live', async () => {
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;

		await expect(t.mutation(claim, claimArgs('digest-a'))).resolves.toBe(true);
		await expect(t.mutation(claim, claimArgs('digest-a'))).resolves.toBe(false);
		// A different delivery is unaffected — the claim is per digest, not a lock
		// on the plugin.
		await expect(t.mutation(claim, claimArgs('digest-b'))).resolves.toBe(true);
	});

	it('stores nothing but the hash, the owner and the window', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.claim, claimArgs('digest-c'));

		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]!).sort()).toEqual(
			[
				'_creationTime',
				'_id',
				'claimedAt',
				'deliveryDigest',
				'expiresAt',
				'pluginId',
				'transportKind',
			].sort()
		);
	});

	it('lets an EXPIRED digest through again', async () => {
		// Not a loosening: the same request can no longer verify once its signed
		// timestamp is outside tolerance, so remembering it past that point buys
		// nothing and only grows the table.
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;

		await t.mutation(claim, claimArgs('digest-d', Date.now() - 1));
		await expect(t.mutation(claim, claimArgs('digest-d'))).resolves.toBe(true);
		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows.filter((row) => row.deliveryDigest === 'digest-d')).toHaveLength(1);
	});

	it('ages expired rows out as it goes, with no cron', async () => {
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;
		for (let index = 0; index < 10; index += 1) {
			await t.mutation(claim, claimArgs(`stale-${index}`, Date.now() - 1));
		}
		await t.mutation(claim, claimArgs('fresh'));

		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows.map((row) => row.deliveryDigest)).toEqual(['fresh']);
	});

	it('releases a claim so a redelivery after our failure is accepted', async () => {
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;

		await t.mutation(claim, claimArgs('digest-e'));
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.release, {
			deliveryDigest: 'digest-e',
		});
		await expect(t.mutation(claim, claimArgs('digest-e'))).resolves.toBe(true);
	});

	it('releasing an unknown digest is a no-op', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(internal.webhooks.pluginFeedbackDeliveries.release, {
				deliveryDigest: 'never-claimed',
			})
		).resolves.toBeNull();
	});
});
