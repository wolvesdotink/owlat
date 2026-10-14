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

import { createHmac } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginWebhookSignatureContract } from '@owlat/plugin-kit';
import { internal } from '../../_generated/api';
import { verifyPluginWebhookDelivery } from '../../plugins/inboundSignature';
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

/** A claim row's state; `undefined` is a row written before the column existed. */
type RowStatus = 'completed' | 'in_flight' | undefined;

/**
 * Every state an expired row can be left in. Expiry must retire all three: a
 * sweep that kept in-flight rows (a dispatch that died mid-way) or legacy rows
 * (no status at all) would let the table grow without bound.
 */
const EXPIRED_ROW_STATES: readonly (readonly [string, RowStatus])[] = [
	['completed', 'completed'],
	['in flight', 'in_flight'],
	['legacy (no status)', undefined],
];

/**
 * Receipts whose window has already closed, written straight to the table: the
 * claim mutation refuses to take a claim that is already expired, so it cannot
 * be used to make one.
 */
async function insertExpiredRows(
	t: ReturnType<typeof convexTest>,
	digests: readonly string[],
	status: RowStatus
) {
	await t.run(async (ctx) => {
		for (const digest of digests) {
			await ctx.db.insert('pluginWebhookDeliveries', {
				pluginId: PLUGIN_ID,
				transportKind: KIND,
				deliveryDigest: digest,
				claimedAt: Date.now() - TOLERANCE_MS,
				expiresAt: Date.now() - 1,
				...(status === undefined ? {} : { status }),
			});
		}
	});
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

	it.each(EXPIRED_ROW_STATES)('lets an EXPIRED %s digest through again', async (_label, status) => {
		// Not a loosening: the same request can no longer verify once its signed
		// timestamp is outside tolerance, so remembering it past that point buys
		// nothing and only grows the table.
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;

		await insertExpiredRows(t, ['digest-d'], status);
		await expect(t.mutation(claim, claimArgs('digest-d'))).resolves.toBe('claimed');
		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows.filter((row) => row.deliveryDigest === 'digest-d')).toEqual([
			expect.objectContaining({ status: 'in_flight' }),
		]);
	});

	it.each(EXPIRED_ROW_STATES)('ages expired %s rows out as it goes', async (_label, status) => {
		const t = convexTest(schema, modules);
		const claim = internal.webhooks.pluginFeedbackDeliveries.claim;
		await insertExpiredRows(
			t,
			Array.from({ length: 10 }, (_, index) => `stale-${index}`),
			status
		);
		await t.mutation(claim, claimArgs('fresh'));

		const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
		expect(rows.map((row) => row.deliveryDigest)).toEqual(['fresh']);
	});

	it.each(EXPIRED_ROW_STATES)(
		'the cron sweeps the %s rows an idle route leaves behind, and only those',
		async (_label, status) => {
			// The claim mutation's own sweep runs only when a delivery is authorized.
			// Disable the plugin, or let the provider go quiet after a burst, and the
			// residue would otherwise sit there forever — so the invariant "this table
			// empties itself" belongs to the cron, not to the hot path.
			const t = convexTest(schema, modules);
			await t.mutation(internal.webhooks.pluginFeedbackDeliveries.claim, claimArgs('still-live'));
			// Written straight to the table: the point is rows NO later claim ever
			// reaches, which is exactly what going through the claim mutation would
			// clean up on the way in.
			await insertExpiredRows(
				t,
				Array.from({ length: 5 }, (_, index) => `abandoned-${index}`),
				status
			);

			const { deletedCount } = await t.mutation(
				internal.webhooks.cleanup.cleanupPluginWebhookDeliveries,
				{}
			);

			expect(deletedCount).toBe(5);
			const rows = await t.run(async (ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
			expect(rows.map((row) => row.deliveryDigest)).toEqual(['still-live']);
		}
	);

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
		const claimedAt = 1_770_000_000_000;
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			// Claimed while live — a claim whose window has already closed is refused.
			vi.setSystemTime(claimedAt);
			await t.mutation(claim, claimArgs('digest-h', claimedAt + 1_000));
			await t.mutation(complete, completeArgs('digest-h'));

			vi.setSystemTime(claimedAt + 1_001);
			const { deletedCount } = await t.mutation(
				internal.webhooks.cleanup.cleanupPluginWebhookDeliveries,
				{}
			);

			expect(deletedCount).toBe(1);
		} finally {
			vi.useRealTimers();
		}
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

/**
 * The claim must not expire while the request it records can still verify
 * (#1328 review). The two arms round the clock differently — Svix floors it to
 * whole seconds, the parameterized check compares milliseconds — so each is
 * walked to its own last accepted instant with a delivery signed as far ahead
 * of our clock as the window allows, the case that leaves the least room.
 */
describe('a claim and the signature it records', () => {
	const SECRET_ENV = 'PLUGIN_BOUNDARY_WEBHOOK_SECRET';
	const TOLERANCE_SECONDS = 300;
	const ACCEPTED_AT_MS = 1_770_000_000_000;
	const SIGNED_AT = ACCEPTED_AT_MS / 1000 + TOLERANCE_SECONDS;
	const BODY = '{"events":[{"type":"bounce","id":"edge"}]}';
	const SVIX_SECRET_BASE64 = 'YWJjZGVmZ2hpamtsbW5vcA==';
	const HMAC_SECRET = 'boundary-signing-secret';

	const ARMS: readonly {
		readonly label: string;
		readonly secret: string;
		readonly contract: PluginWebhookSignatureContract;
		readonly headers: Record<string, string>;
		readonly lastAcceptedMs: number;
	}[] = [
		{
			label: 'svix',
			secret: `whsec_${SVIX_SECRET_BASE64}`,
			contract: { scheme: 'svix', secretEnvVar: SECRET_ENV, toleranceSeconds: TOLERANCE_SECONDS },
			headers: {
				'svix-id': 'msg_edge',
				'svix-timestamp': String(SIGNED_AT),
				'svix-signature': `v1,${createHmac('sha256', Buffer.from(SVIX_SECRET_BASE64, 'base64'))
					.update(`msg_edge.${SIGNED_AT}.${BODY}`)
					.digest('base64')}`,
			},
			// Floored to the second: every instant of the second after the window.
			lastAcceptedMs: (SIGNED_AT + TOLERANCE_SECONDS + 1) * 1000 - 1,
		},
		{
			label: 'the parameterized HMAC',
			secret: HMAC_SECRET,
			contract: {
				header: 'x-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: SECRET_ENV,
				replay: { timestampHeader: 'x-timestamp', toleranceSeconds: TOLERANCE_SECONDS },
			},
			headers: {
				'x-timestamp': String(SIGNED_AT),
				'x-signature': createHmac('sha256', HMAC_SECRET)
					.update(`${SIGNED_AT}.${BODY}`)
					.digest('hex'),
			},
			// Inclusive, to the millisecond.
			lastAcceptedMs: (SIGNED_AT + TOLERANCE_SECONDS) * 1000,
		},
	];

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it.each(ARMS)(
		'$label: a copy that still verifies still finds its claim',
		async ({ secret, contract, headers, lastAcceptedMs }) => {
			vi.stubEnv(SECRET_ENV, secret);
			vi.useFakeTimers({ toFake: ['Date'] });
			const t = convexTest(schema, modules);
			const table = internal.webhooks.pluginFeedbackDeliveries;
			const verify = (nowMs: number) =>
				verifyPluginWebhookDelivery({
					contract,
					pluginId: PLUGIN_ID,
					transportKind: KIND,
					rawBody: BODY,
					headers: new Headers(headers),
					nowMs,
				});

			vi.setSystemTime(ACCEPTED_AT_MS);
			const first = await verify(ACCEPTED_AT_MS);
			if (!first.ok) throw new Error(`expected the first copy to verify: ${first.reason}`);
			await expect(
				t.mutation(table.claim, claimArgs(first.deliveryDigest, first.expiresAtMs))
			).resolves.toBe('claimed');
			await t.mutation(table.complete, completeArgs(first.deliveryDigest));

			vi.setSystemTime(lastAcceptedMs);
			const replay = await verify(lastAcceptedMs);
			if (!replay.ok) throw new Error(`expected the replay to verify: ${replay.reason}`);
			await expect(
				t.mutation(table.claim, claimArgs(replay.deliveryDigest, replay.expiresAtMs))
			).resolves.toBe('duplicate_completed');

			// A copy that verified in time but reaches the claim once the window has
			// closed is refused there, and the receipt it would have displaced is
			// left exactly as it was.
			vi.setSystemTime(replay.expiresAtMs);
			await expect(
				t.mutation(table.claim, claimArgs(replay.deliveryDigest, replay.expiresAtMs))
			).resolves.toBe('expired');
			const rows = await t.run((ctx) => ctx.db.query('pluginWebhookDeliveries').collect());
			expect(rows).toEqual([
				expect.objectContaining({ deliveryDigest: first.deliveryDigest, status: 'completed' }),
			]);

			// One millisecond on, the request itself is refused, so the claim has
			// nothing left to guard.
			await expect(verify(lastAcceptedMs + 1)).resolves.toMatchObject({ ok: false, status: 401 });
		}
	);
});
