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

	it('ages expired rows out as it goes', async () => {
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;
		for (let index = 0; index < 10; index += 1) {
			await t.mutation(claim, claimArgs(`stale-${index}`, Date.now() - 1));
		}
		await t.mutation(claim, claimArgs('fresh'));

		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows.map((row) => row.deliveryDigest)).toEqual(['fresh']);
	});

	it('the cron sweeps what an idle route leaves behind, and only that', async () => {
		// The claim mutation's own sweep runs only when a delivery is authorized.
		// Disable the plugin, or let the provider go quiet after a burst, and the
		// residue would otherwise sit there forever — so the invariant "this table
		// empties itself" belongs to the cron, not to the hot path.
		const t = convexTest(schema, modules);
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.claim, claimArgs('still-live'));
		// Written straight to the table: the point is rows NO later claim ever
		// reaches, which is exactly what going through the claim mutation would
		// clean up on the way in.
		await t.run(async (ctx) => {
			for (let index = 0; index < 5; index += 1) {
				await ctx.db.insert('pluginWebhookDeliveries', {
					pluginId: PLUGIN_ID,
					transportKind: KIND,
					deliveryDigest: `abandoned-${index}`,
					claimedAt: Date.now() - TOLERANCE_MS,
					expiresAt: Date.now() - 1,
				});
			}
		});

		const { deletedCount } = await t.mutation(
			internal.webhooks.cleanup.cleanupPluginWebhookDeliveries,
			{}
		);

		expect(deletedCount).toBe(5);
		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows.map((row) => row.deliveryDigest)).toEqual(['still-live']);
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
