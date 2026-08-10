/**
 * The replay claim, against a real database (the seams plan's D6/P2.2).
 *
 * The route suite proves the ROUTE refuses a delivery the claim mutation
 * rejects. This proves the mutation itself does the rejecting — the property the
 * whole replay defense rests on — plus the three things a claim table gets wrong
 * if nobody looks: it must not grow without bound, it must not turn our own
 * failure into a permanent refusal of the provider's honest redelivery, and it
 * must not report a delivery still IN FLIGHT as one already applied — the claim
 * is taken before dispatch, so those are different facts and answering them
 * alike loses whole batches.
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

function completeArgs(digest: string) {
	return { pluginId: PLUGIN_ID, transportKind: KIND, deliveryDigest: digest };
}

describe('plugin webhook delivery claims', () => {
	it('accepts a digest once and refuses it while it is live', async () => {
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;

		await expect(t.mutation(claim, claimArgs('digest-a'))).resolves.toBe('claimed');
		await expect(t.mutation(claim, claimArgs('digest-a'))).resolves.toBe('duplicate_in_flight');
		// A different delivery is unaffected — the claim is per digest, not a lock
		// on the plugin.
		await expect(t.mutation(claim, claimArgs('digest-b'))).resolves.toBe('claimed');
	});

	it('stores nothing but the hash, the owner, the window and the state', async () => {
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
				'status',
				'transportKind',
			].sort()
		);
		// A fresh claim is IN FLIGHT: nothing has been dispatched yet, and the whole
		// point of the column is that those are different facts.
		expect(rows[0]!.status).toBe('in_flight');
	});

	it('lets an EXPIRED digest through again', async () => {
		// Not a loosening: the same request can no longer verify once its signed
		// timestamp is outside tolerance, so remembering it past that point buys
		// nothing and only grows the table.
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;

		await t.mutation(claim, claimArgs('digest-d', Date.now() - 1));
		await expect(t.mutation(claim, claimArgs('digest-d'))).resolves.toBe('claimed');
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
		await expect(t.mutation(claim, claimArgs('digest-e'))).resolves.toBe('claimed');
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

describe('a claim that has been completed', () => {
	it('answers a redelivery as a true duplicate, not as work in progress', async () => {
		const t = convexTest(schema, modules);
		const { claim, complete } = internal.webhooks.pluginFeedbackDeliveries;

		await expect(t.mutation(claim, claimArgs('digest-f'))).resolves.toBe('claimed');
		// Still in flight — the batch is being dispatched, so a second copy of the
		// same bytes must NOT be acknowledged: this copy may yet fail and hand the
		// claim back, and a provider that has been told 2xx never comes again.
		await expect(t.mutation(claim, claimArgs('digest-f'))).resolves.toBe('duplicate_in_flight');

		await t.mutation(complete, completeArgs('digest-f'));
		await expect(t.mutation(claim, claimArgs('digest-f'))).resolves.toBe('duplicate_completed');
	});

	it('is never given back by a release', async () => {
		// Releasing an applied delivery would invite the provider to redeliver it
		// AND erase the record that lets the next copy be answered 200.
		const t = convexTest(schema, modules);
		const { claim, complete, release } = internal.webhooks.pluginFeedbackDeliveries;

		await t.mutation(claim, claimArgs('digest-g'));
		await t.mutation(complete, completeArgs('digest-g'));
		await t.mutation(release, { deliveryDigest: 'digest-g' });

		await expect(t.mutation(claim, claimArgs('digest-g'))).resolves.toBe('duplicate_completed');
	});

	it('keeps expiring with the tolerance window', async () => {
		// Completion is not immortality: past the signature tolerance the same bytes
		// cannot verify again, so the row buys nothing and the sweeps take it.
		const t = convexTest(schema, modules);
		const { claim, complete } = internal.webhooks.pluginFeedbackDeliveries;

		await t.mutation(claim, claimArgs('digest-h', Date.now() - 1));
		await t.mutation(complete, completeArgs('digest-h'));
		const { deletedCount } = await t.mutation(
			internal.webhooks.cleanup.cleanupPluginWebhookDeliveries,
			{}
		);

		expect(deletedCount).toBe(1);
	});

	it('reads a row written before the state column existed as IN FLIGHT', async () => {
		// The safe default across a deploy: at worst one redelivery of a batch that
		// was already applied (every lane this route dispatches into is idempotent
		// per event), where the other default silently drops a batch outright.
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('pluginWebhookDeliveries', {
				pluginId: PLUGIN_ID,
				transportKind: KIND,
				deliveryDigest: 'legacy',
				claimedAt: Date.now(),
				expiresAt: Date.now() + TOLERANCE_MS,
			});
		});

		await expect(
			t.mutation(internal.webhooks.pluginFeedbackDeliveries.claim, claimArgs('legacy'))
		).resolves.toBe('duplicate_in_flight');
	});
});

describe('the durable feedback-activity marker', () => {
	it('is stamped per transport kind when a batch completes', async () => {
		// The signal `delivery.status.getProviderFeedbackStatus` grades a plugin
		// channel by. It cannot be the claim row (gone within fifteen minutes) and it
		// cannot be the raw payload (retention is opt-in, default off).
		const t = convexTest(schema, modules);
		const { claim, complete } = internal.webhooks.pluginFeedbackDeliveries;

		await t.mutation(claim, claimArgs('digest-i'));
		await t.mutation(complete, completeArgs('digest-i'));

		const rows = await t.run(async (ctx) =>
			ctx.db.query('pluginWebhookFeedbackActivity').collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ pluginId: PLUGIN_ID, transportKind: KIND });
		expect(rows[0]!.lastEventAt).toBeLessThanOrEqual(Date.now());
	});

	it('keeps ONE row per kind and never walks the timestamp backwards', async () => {
		const t = convexTest(schema, modules);
		const { claim, complete } = internal.webhooks.pluginFeedbackDeliveries;

		await t.mutation(claim, claimArgs('digest-j'));
		await t.mutation(complete, completeArgs('digest-j'));
		const first = await t.run(async (ctx) => ctx.db.query('pluginWebhookFeedbackActivity').first());
		// A completion that lands out of order must not report a live channel stale.
		const ahead = first!.lastEventAt + 60_000;
		await t.run(async (ctx) => ctx.db.patch(first!._id, { lastEventAt: ahead }));

		await t.mutation(claim, claimArgs('digest-k'));
		await t.mutation(complete, completeArgs('digest-k'));

		const rows = await t.run(async (ctx) =>
			ctx.db.query('pluginWebhookFeedbackActivity').collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.lastEventAt).toBe(ahead);
	});

	it('is stamped even when the claim row is already gone', async () => {
		// The delivery still happened; the claim simply aged out underneath it.
		const t = convexTest(schema, modules);
		await t.mutation(internal.webhooks.pluginFeedbackDeliveries.complete, completeArgs('vanished'));

		const rows = await t.run(async (ctx) =>
			ctx.db.query('pluginWebhookFeedbackActivity').collect()
		);
		expect(rows.map((row) => row.transportKind)).toEqual([KIND]);
	});
});
