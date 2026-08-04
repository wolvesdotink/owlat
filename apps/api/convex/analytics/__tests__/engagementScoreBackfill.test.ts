import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import {
	recordContactActivity,
	type RecordContactActivityArgs,
} from '../../contactActivities/writer';
import type { ContactActivityType } from '../../contactActivities/catalog';
import { ENGAGEMENT_ACTIVITY_LITERALS } from '../engagementActivity';
import {
	BACKFILL_BATCH_SIZE,
	BACKFILL_CONTACTS_PER_HOUR,
	BACKFILL_MAX_BATCHES,
	BACKFILL_READ_BUDGET_DOCS,
	ENGAGEMENT_SCORE_STALE_MS,
	MAX_ACTIVITIES_PER_RECOMPUTE,
} from '../engagementScoreSync';
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

		expect(first).toEqual({ scanned: 3, rescored: 3, isDone: false, isBudgetExhausted: true });
		const scored = (await scoresOf(t, ids)).filter((s) => s !== null);
		expect(scored).toHaveLength(3);
	});

	it('defaults to a bounded batch rather than the whole table', () => {
		expect(BACKFILL_BATCH_SIZE).toBeGreaterThan(0);
		expect(BACKFILL_BATCH_SIZE).toBeLessThanOrEqual(500);
	});

	it('clamps an absurd caller-supplied batch size to the document budget', async () => {
		const t = harness();
		// One more contact than the clamp allows, so an unclamped batchSize would
		// visibly scan them all in a single transaction.
		await seedContacts(t, BACKFILL_BATCH_SIZE + 1);
		const result = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchSize: 1_000_000, batchesRemaining: 1 }
		);
		expect(result.scanned).toBe(BACKFILL_BATCH_SIZE);
		expect(result.isDone).toBe(false);
	});

	it('keeps the batch bound sized in DOCUMENTS, not contacts', () => {
		// The bound that matters is the transaction's document-read count: each
		// contact costs one contact row plus up to MAX_ACTIVITIES_PER_RECOMPUTE
		// activity rows. Sizing the batch in contacts alone is what lets one tick
		// blow the Convex per-transaction read limit and wedge the chain forever.
		expect(BACKFILL_BATCH_SIZE * (MAX_ACTIVITIES_PER_RECOMPUTE + 1)).toBeLessThanOrEqual(
			BACKFILL_READ_BUDGET_DOCS
		);
	});

	it('stays inside its read budget with a full batch of maximally heavy contacts', async () => {
		const t = harness();
		const ids = await seedContacts(t, BACKFILL_BATCH_SIZE, 300);

		// Every contact in the batch carries the most activities a recompute will
		// ever read. This is the shape that used to throw (and roll back, and
		// re-present the identical stalest head next tick, forever).
		const now = Date.now();
		await t.run(async (ctx) => {
			for (const id of ids) {
				for (let i = 0; i < MAX_ACTIVITIES_PER_RECOMPUTE; i += 1) {
					await ctx.db.insert('contactActivities', {
						contactId: id,
						activityType: 'email_opened',
						metadata: { campaignId: 'c1' },
						// Distinct instants: the recompute must not dedupe them away.
						occurredAt: now - i * 60_000,
					});
				}
			}
		});

		const result = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchesRemaining: 1 }
		);

		expect(result.scanned).toBe(BACKFILL_BATCH_SIZE);
		expect(result.rescored).toBe(BACKFILL_BATCH_SIZE);
		expect((await scoresOf(t, ids)).every((s) => s !== null)).toBe(true);
	});
});

describe('backfillEngagementScores — the self-chaining bound', () => {
	it('clamps batchesRemaining to BACKFILL_MAX_BATCHES and terminates', async () => {
		const t = harness();
		// More contacts than one batch, far fewer than the batch budget, so the
		// chain must stop because the WORK ran out rather than because the budget
		// did — and it must stop at all, which is the property under test.
		const ids = await seedContacts(t, BACKFILL_BATCH_SIZE * 3);

		// Fake timers + runAllTimers is convex-test's pattern for draining a
		// self-chaining `runAfter(0)`.
		vi.useFakeTimers();
		try {
			const first = await t.mutation(
				internal.analytics.engagementScoreSync.backfillEngagementScores,
				{ batchesRemaining: BACKFILL_MAX_BATCHES * 1000 }
			);
			expect(first.scanned).toBe(BACKFILL_BATCH_SIZE);
			expect(first.isDone).toBe(false);
			// It chained rather than declaring victory, and it did NOT report the
			// budget as exhausted — the clamp left plenty of batches.
			expect(first.isBudgetExhausted).toBe(false);

			// The chain drains the rest and then STOPS. If a future edit made it
			// unbounded, this would never settle.
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		expect((await scoresOf(t, ids)).every((s) => s !== null)).toBe(true);

		const afterwards = await t.mutation(
			internal.analytics.engagementScoreSync.backfillEngagementScores,
			{ batchesRemaining: 1 }
		);
		expect(afterwards).toEqual({
			scanned: 0,
			rescored: 0,
			isDone: true,
			isBudgetExhausted: false,
		});
	});

	it('stops chaining when the batch budget runs out, with work still queued', async () => {
		const t = harness();
		const ids = await seedContacts(t, BACKFILL_BATCH_SIZE * 3);

		// Two batches for three batches' worth of work: the chain must run exactly
		// twice and then give up rather than scheduling itself forever.
		vi.useFakeTimers();
		try {
			const first = await t.mutation(
				internal.analytics.engagementScoreSync.backfillEngagementScores,
				{ batchesRemaining: 2 }
			);
			expect(first.isBudgetExhausted).toBe(false);

			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		const scored = (await scoresOf(t, ids)).filter((s) => s !== null);
		expect(scored).toHaveLength(BACKFILL_BATCH_SIZE * 2);
	});

	it('states its per-tick capacity', () => {
		expect(BACKFILL_CONTACTS_PER_HOUR).toBe(BACKFILL_BATCH_SIZE * BACKFILL_MAX_BATCHES);
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
		expect(drained).toEqual({ scanned: 0, rescored: 0, isDone: true, isBudgetExhausted: false });
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
		expect(result).toEqual({ scanned: 1, rescored: 0, isDone: true, isBudgetExhausted: false });

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

	it('gives a suppression recorded in error a way back', async () => {
		const t = harness();
		const [id] = await seedContacts(t, 1, 200);
		if (!id) throw new Error('seed failed');

		const bounceId = await t.run(async (ctx) => {
			await recordContactActivity(ctx, {
				literal: 'email_clicked',
				contactId: id,
				metadata: { campaignId: 'c1', linkUrl: 'https://example.com' },
				occurredAt: Date.now() - DAY,
			});
			return recordContactActivity(ctx, {
				literal: 'email_bounced',
				contactId: id,
				metadata: { campaignId: 'c1', bounceType: 'hard' },
			});
		});

		// Clearing alone is not enough while the offending row is still there —
		// the recompute simply sees it again.
		const stillSuppressed = await t.mutation(
			internal.analytics.engagementScoreSync.clearEngagementSuppression,
			{ contactId: id }
		);
		expect(stillSuppressed).toBe(0);

		// Correct the record, then clear: the contact recovers.
		await t.run(async (ctx) => {
			await ctx.db.delete(bounceId);
			return null;
		});
		const recovered = await t.mutation(
			internal.analytics.engagementScoreSync.clearEngagementSuppression,
			{ contactId: id }
		);
		expect(recovered).toBeGreaterThan(0);

		const doc = await t.run(async (ctx) => ctx.db.get(id));
		expect(doc?.engagementScoreState?.isSuppressed).toBe(false);
		expect(doc?.engagementScoreState?.suppressedAt).toBeUndefined();

		// And the nightly backfill does not resurrect it.
		await t.run(async (ctx) => {
			await ctx.db.patch(id, {
				engagementScoreUpdatedAt: Date.now() - 2 * ENGAGEMENT_SCORE_STALE_MS,
			});
		});
		await t.mutation(internal.analytics.engagementScoreSync.backfillEngagementScores, {
			batchesRemaining: 1,
		});
		const afterBackfill = await t.run(async (ctx) => ctx.db.get(id));
		expect(afterBackfill?.engagementScoreState?.isSuppressed).toBe(false);
		expect(afterBackfill?.engagementScore ?? 0).toBeGreaterThan(0);
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

	it('reacts on the hot path to EVERY literal the adapter maps', async () => {
		// The writer's trigger set is DERIVED from `ENGAGEMENT_ACTIVITY_LITERALS`,
		// so adding a mapping to the adapter cannot leave the hot path silently
		// not folding it. This walks the whole set through the real writer and
		// asserts the contact was stamped for each one — it fails if the two ever
		// come apart again.
		const metadataByLiteral: Partial<Record<ContactActivityType, unknown>> = {
			email_opened: { campaignId: 'c1' },
			email_clicked: { campaignId: 'c1', linkUrl: 'https://example.com' },
			email_bounced: { campaignId: 'c1', bounceType: 'soft' },
			email_complained: { campaignId: 'c1' },
			inbound_replied: {},
		};

		expect(ENGAGEMENT_ACTIVITY_LITERALS.size).toBeGreaterThan(0);
		for (const literal of ENGAGEMENT_ACTIVITY_LITERALS) {
			const metadata = metadataByLiteral[literal];
			// A new mapping with no fixture here is a test failure, not a skip.
			expect(metadata, `no metadata fixture for '${literal}'`).toBeDefined();

			const t = harness();
			const [id] = await seedContacts(t, 1);
			if (!id) throw new Error('seed failed');

			await t.run(async (ctx) => {
				await recordContactActivity(ctx, {
					literal,
					contactId: id,
					metadata,
				} as RecordContactActivityArgs);
			});

			const doc = await t.run(async (ctx) => ctx.db.get(id));
			expect(doc?.engagementScoreUpdatedAt, literal).toBeTypeOf('number');
			expect(doc?.engagementScoreState, literal).toBeDefined();
		}
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
