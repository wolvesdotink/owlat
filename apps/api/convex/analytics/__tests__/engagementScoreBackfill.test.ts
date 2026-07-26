import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import { recordContactActivity } from '../../contactActivities/writer';
import { BACKFILL_BATCH_SIZE, ENGAGEMENT_SCORE_STALE_MS } from '../engagementScoreSync';
import { engagementBand } from '../engagementScore';

/**
 * The engagement-score write plane through the real convex-test harness
 * (deliverability plan P0-2): the nightly backfill's boundedness, its resume
 * behaviour, its refusal to rewrite an unchanged score — and the two acceptance
 * criteria the plan names (a recent clicker lands HIGH, a 200-day-silent contact
 * lands COLD).
 */

// Vite's `import.meta.glob` excludes the directory chain it climbed to reach the
// glob base, so `'../../**'` from this `analytics/__tests__` file omits the
// sibling `analytics/*` modules. Merge a second glob rooted at `analytics/` and
// re-prefix its keys so convex-test resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		mod,
	])
);
const modules = { ...rootGlob, ...analyticsGlob };

const DAY = 24 * 60 * 60 * 1000;

function harness() {
	return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

async function seedContacts(
	t: Harness,
	count: number,
	tenureDays = 400
): Promise<Id<'contacts'>[]> {
	return t.run(async (ctx) => {
		const ids: Id<'contacts'>[] = [];
		for (let i = 0; i < count; i += 1) {
			ids.push(
				await ctx.db.insert(
					'contacts',
					createTestContact({ createdAt: Date.now() - tenureDays * DAY })
				)
			);
		}
		return ids;
	});
}

/**
 * Cached scores in `ids` order. Unscored rows come back as `null`, not
 * `undefined` — a `t.run` return value crosses the Convex value boundary and
 * `undefined` is not a storable Convex value inside an array.
 */
async function scoresOf(t: Harness, ids: Id<'contacts'>[]): Promise<Array<number | null>> {
	return t.run(async (ctx) => {
		const out: Array<number | null> = [];
		for (const id of ids) out.push((await ctx.db.get(id))?.engagementScore ?? null);
		return out;
	});
}

describe('backfillEngagementScores — boundedness', () => {
	it('scores at most `batchSize` contacts per invocation', async () => {
		const t = harness();
		const ids = await seedContacts(t, 7);

		const first = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 3, batchesRemaining: 1 }
		);

		expect(first).toEqual({ scanned: 3, rescored: 3, isDone: false });
		const scored = (await scoresOf(t, ids)).filter((s) => s !== null);
		expect(scored).toHaveLength(3);
	});

	it('defaults to a bounded batch rather than the whole table', () => {
		expect(BACKFILL_BATCH_SIZE).toBeGreaterThan(0);
		expect(BACKFILL_BATCH_SIZE).toBeLessThanOrEqual(500);
	});

	it('clamps an absurd caller-supplied batch size', async () => {
		const t = harness();
		await seedContacts(t, 3);
		const result = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 1_000_000, batchesRemaining: 1 }
		);
		expect(result.scanned).toBe(3);
		expect(result.isDone).toBe(true);
	});
});

describe('backfillEngagementScores — resumption', () => {
	it('resumes where the previous tick stopped and never re-scores the same row', async () => {
		const t = harness();
		const ids = await seedContacts(t, 7);

		const seen: Array<number | null> = [];
		for (const expected of [3, 3, 1]) {
			const before = await scoresOf(t, ids);
			const result = await t.mutation(
				internal.analytics.engagementScoreSync.backfillEngagementScores,
				{ batchSize: 3, batchesRemaining: 1 }
			);
			expect(result.scanned).toBe(expected);
			// Every contact this tick touched was untouched before it — the stale
			// range shrinks monotonically, so no row is visited twice.
			expect(result.rescored).toBe(expected);
			const after = await scoresOf(t, ids);
			const newlyScored = after.filter((s, i) => s !== null && before[i] === null);
			expect(newlyScored).toHaveLength(expected);
			seen.push(...newlyScored);
		}

		expect(seen).toHaveLength(7);
		expect((await scoresOf(t, ids)).every((s) => s !== null)).toBe(true);

		// Nothing is stale any more.
		const drained = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 3, batchesRemaining: 1 }
		);
		expect(drained).toEqual({ scanned: 0, rescored: 0, isDone: true });
	});

	it('sorts never-scored contacts ahead of merely-stale ones', async () => {
		const t = harness();
		const [stale] = await seedContacts(t, 1);
		if (!stale) throw new Error('seed failed');
		await t.run(async (ctx) => {
			await ctx.db.patch(stale, {
				engagementScore: 7,
				engagementScoreUpdatedAt: Date.now() - 5 * DAY,
				engagementScoreState: { raw: 1, softBounceRaw: 0, isSuppressed: false },
			});
		});
		const [fresh] = await seedContacts(t, 1);
		if (!fresh) throw new Error('seed failed');

		await t.mutation(internal.analytics.engagementScoreSync.backfillEngagementScores, {
			batchSize: 1,
			batchesRemaining: 1,
		});

		const [freshScore] = await scoresOf(t, [fresh]);
		expect(freshScore).not.toBeNull();
	});
});

describe('backfillEngagementScores — idempotence', () => {
	it('does not rewrite an unchanged score', async () => {
		const t = harness();
		// No activities and a long tenure → the score is a stable 0.
		const [id] = await seedContacts(t, 1, 500);
		if (!id) throw new Error('seed failed');

		const first = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 10, batchesRemaining: 1 }
		);
		expect(first.rescored).toBe(1);

		const afterFirst = await t.run(async (ctx) => ctx.db.get(id));
		expect(afterFirst?.engagementScore).toBe(0);

		// Age the freshness stamp so the row re-enters the stale range.
		const agedAt = Date.now() - 2 * ENGAGEMENT_SCORE_STALE_MS;
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { engagementScoreUpdatedAt: agedAt });
		});

		const second = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 10, batchesRemaining: 1 }
		);
		expect(second.scanned).toBe(1);
		expect(second.rescored).toBe(0);

		const afterSecond = await t.run(async (ctx) => ctx.db.get(id));
		expect(afterSecond?.engagementScore).toBe(0);
		// The freshness stamp DID advance — the accumulator is only meaningful
		// relative to the instant it belongs to, so the two move together.
		expect(afterSecond?.engagementScoreUpdatedAt ?? 0).toBeGreaterThan(agedAt);
	});

	it('stamps soft-deleted contacts past without scoring them', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1);
		if (!id) throw new Error('seed failed');
		await t.run(async (ctx) => ctx.db.patch(id, { deletedAt: Date.now() }));

		const result = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 10, batchesRemaining: 1 }
		);
		expect(result).toEqual({ scanned: 1, rescored: 0, isDone: true });

		const doc = await t.run(async (ctx) => ctx.db.get(id));
		expect(doc?.engagementScore).toBeUndefined();
		expect(doc?.engagementScoreUpdatedAt).toBeDefined();
	});
});

describe('the acceptance criteria, end to end', () => {
	it('scores a contact with recent clicks in the HIGH band', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1, 400);
		if (!id) throw new Error('seed failed');

		const now = Date.now();
		await t.run(async (ctx) => {
			for (const days of [2, 6, 11]) {
				await recordContactActivity(ctx, {
					literal: 'email_clicked',
					contactId: id,
					metadata: { campaignId: 'c1', linkUrl: 'https://example.com' },
					occurredAt: now - days * DAY,
				});
			}
			for (const days of [1, 3, 9, 12, 20]) {
				await recordContactActivity(ctx, {
					literal: 'email_opened',
					contactId: id,
					metadata: { campaignId: 'c1' },
					occurredAt: now - days * DAY,
				});
			}
		});

		// The incremental writer path alone must already reach the band.
		const incremental = await t.run(async (ctx) => (await ctx.db.get(id))?.engagementScore ?? -1);
		expect(engagementBand(incremental)).toBe('high');

		// …and the full recompute agrees with it.
		const recomputed = await t.mutation(
			internal.analytics.engagementScoreSync.recomputeContactScore,
			{ contactId: id }
		);
		expect(recomputed).not.toBeNull();
		expect(engagementBand(recomputed ?? -1)).toBe('high');
	});

	it('scores a 200-day-silent contact COLD', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1, 400);
		if (!id) throw new Error('seed failed');

		await t.run(async (ctx) => {
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_opened',
				metadata: { campaignId: 'c1' },
				occurredAt: Date.now() - 200 * DAY,
			});
		});

		const score = await t.mutation(internal.analytics.engagementScoreSync.recomputeContactScore, {
			contactId: id,
		});
		expect(score).not.toBeNull();
		expect(engagementBand(score ?? -1)).toBe('cold');
	});

	it('marks a hard-bounced contact isSuppressed on the writer hot path', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1, 200);
		if (!id) throw new Error('seed failed');

		await t.run(async (ctx) => {
			await recordContactActivity(ctx, {
				literal: 'email_clicked',
				contactId: id,
				metadata: { campaignId: 'c1', linkUrl: 'https://example.com' },
				occurredAt: Date.now() - DAY,
			});
			await recordContactActivity(ctx, {
				literal: 'email_bounced',
				contactId: id,
				metadata: { campaignId: 'c1', bounceType: 'hard' },
			});
		});

		const doc = await t.run(async (ctx) => ctx.db.get(id));
		expect(doc?.engagementScore).toBe(0);
		expect(doc?.engagementScoreState?.isSuppressed).toBe(true);
	});

	it('preserves the shipped hasOpened/hasClicked denormalization', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1);
		if (!id) throw new Error('seed failed');

		await t.run(async (ctx) => {
			await recordContactActivity(ctx, {
				literal: 'email_opened',
				contactId: id,
				metadata: { campaignId: 'c1' },
			});
			await recordContactActivity(ctx, {
				literal: 'email_clicked',
				contactId: id,
				metadata: { campaignId: 'c1', linkUrl: 'https://example.com' },
			});
		});

		const doc = await t.run(async (ctx) => ctx.db.get(id));
		expect(doc?.hasOpened).toBe(true);
		expect(doc?.hasClicked).toBe(true);
	});

	it('leaves contacts untouched for activity types the score ignores', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1);
		if (!id) throw new Error('seed failed');

		await t.run(async (ctx) => {
			await recordContactActivity(ctx, {
				literal: 'email_sent',
				contactId: id,
				metadata: { campaignId: 'c1', emailSubject: 'hi' },
			});
		});

		const doc = await t.run(async (ctx) => ctx.db.get(id));
		expect(doc?.engagementScore).toBeUndefined();
		expect(doc?.engagementScoreUpdatedAt).toBeUndefined();
	});
});

describe('the incremental hot path — hostile inputs', () => {
	it('clamps a far-future activity instead of folding it at full weight', async () => {
		const t = harness();
		const [skewed] = await seedContacts(t, 1, 400);
		const [sane] = await seedContacts(t, 1, 400);
		if (!skewed || !sane) throw new Error('seed failed');

		const before = Date.now();
		await t.run(async (ctx) => {
			// A malformed provider webhook date / skewed caller clock.
			await recordContactActivity(ctx, {
				literal: 'email_clicked',
				contactId: skewed,
				metadata: { campaignId: 'c1', linkUrl: 'https://example.com' },
				occurredAt: before + 365 * DAY,
			});
			// The same click, honestly dated.
			await recordContactActivity(ctx, {
				literal: 'email_clicked',
				contactId: sane,
				metadata: { campaignId: 'c1', linkUrl: 'https://example.com' },
				occurredAt: before,
			});
		});

		const [skewedDoc, saneDoc] = await t.run(
			async (ctx) => [await ctx.db.get(skewed), await ctx.db.get(sane)] as const
		);

		// Clamped to `now`: the skewed row cannot out-score the honest one…
		expect(skewedDoc?.engagementScore).toBe(saneDoc?.engagementScore);
		// …and its freshness stamp stays in the present, so the nightly backfill
		// can still reach it (a future stamp would pin it out of the stale range).
		expect(skewedDoc?.engagementScoreUpdatedAt ?? 0).toBeLessThanOrEqual(Date.now());
		expect(skewedDoc?.engagementScoreUpdatedAt ?? 0).toBeGreaterThanOrEqual(before);
	});

	it('folds a redelivered webhook once', async () => {
		const t = harness();
		const [dupe] = await seedContacts(t, 1, 400);
		const [once] = await seedContacts(t, 1, 400);
		if (!dupe || !once) throw new Error('seed failed');

		const at = Date.now() - DAY;
		await t.run(async (ctx) => {
			for (const _attempt of [0, 1, 2]) {
				await recordContactActivity(ctx, {
					literal: 'email_opened',
					contactId: dupe,
					metadata: { campaignId: 'c1' },
					occurredAt: at,
				});
			}
			await recordContactActivity(ctx, {
				literal: 'email_opened',
				contactId: once,
				metadata: { campaignId: 'c1' },
				occurredAt: at,
			});
		});

		const [dupeDoc, onceDoc] = await t.run(
			async (ctx) => [await ctx.db.get(dupe), await ctx.db.get(once)] as const
		);
		expect(dupeDoc?.engagementScore).toBe(onceDoc?.engagementScore);

		// And the full recompute — which dedupes the whole window — agrees.
		const recomputed = await t.mutation(
			internal.analytics.engagementScoreSync.recomputeContactScore,
			{ contactId: dupe }
		);
		expect(recomputed).toBe(onceDoc?.engagementScore);
	});

	it('still folds a genuinely distinct second open at the same instant-1ms', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1, 400);
		if (!id) throw new Error('seed failed');

		const at = Date.now() - DAY;
		await t.run(async (ctx) => {
			await recordContactActivity(ctx, {
				literal: 'email_opened',
				contactId: id,
				metadata: { campaignId: 'c1' },
				occurredAt: at,
			});
		});
		const afterFirst = await t.run(async (ctx) => (await ctx.db.get(id))?.engagementScore ?? -1);

		await t.run(async (ctx) => {
			await recordContactActivity(ctx, {
				literal: 'email_opened',
				contactId: id,
				metadata: { campaignId: 'c1' },
				occurredAt: at + 1,
			});
		});
		const afterSecond = await t.run(async (ctx) => (await ctx.db.get(id))?.engagementScore ?? -1);

		expect(afterSecond).toBeGreaterThan(afterFirst);
	});
});
