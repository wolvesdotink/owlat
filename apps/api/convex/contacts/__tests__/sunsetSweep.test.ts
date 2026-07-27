import { describe, it, expect } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import { SUNSET_BATCH_SIZE, SUNSET_STALE_MS } from '../sunsetSweep';
import { DAY, harness, type Harness } from './sunsetFixtures';

/**
 * THE SWEEP IS BOUNDED, RESUMABLE AND DOES NOT RESCAN SETTLED CONTACTS
 * (deliverability plan P4-4). It is a cursor-ranged indexed scan, never a
 * full-table walk: `sunsetEvaluatedAt` is both the freshness stamp and the
 * cursor, so a contact leaves the scanned range the moment it is looked at.
 */

const agoReal = (days: number): number => Date.now() - days * DAY;

async function seedQuietContacts(t: Harness, count: number): Promise<Id<'contacts'>[]> {
	return await t.run(async (ctx) => {
		const ids: Id<'contacts'>[] = [];
		for (let i = 0; i < count; i += 1) {
			ids.push(
				await ctx.db.insert(
					'contacts',
					createTestContact({
						email: `sweep-${i}@example.com`,
						createdAt: agoReal(500),
						updatedAt: agoReal(500),
					})
				)
			);
		}
		return ids;
	});
}

describe('sunset sweep — boundedness', () => {
	it('never scans more than the clamped batch in one transaction', async () => {
		const t = harness();
		await seedQuietContacts(t, SUNSET_BATCH_SIZE + 5);

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			// A caller asking for an unbounded batch is clamped, not obeyed: the
			// clamp is what keeps the transaction inside the read budget.
			batchSize: 100_000,
			batchesRemaining: 1,
		});

		expect(result.scanned).toBe(SUNSET_BATCH_SIZE);
		expect(result.isDone).toBe(false);
		expect(result.isBudgetExhausted).toBe(true);
	});

	it('reports done when the stale range is drained', async () => {
		const t = harness();
		await seedQuietContacts(t, 3);

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(result.scanned).toBe(3);
		expect(result.isDone).toBe(true);
		expect(result.isBudgetExhausted).toBe(false);
	});
});

describe('sunset sweep — the cursor', () => {
	it('resumes where it stopped instead of restarting', async () => {
		const t = harness();
		await seedQuietContacts(t, 5);

		const first = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 1,
		});
		const second = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 1,
		});
		const third = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 1,
		});

		expect([first.scanned, second.scanned, third.scanned]).toEqual([2, 2, 1]);
		expect(third.isDone).toBe(true);

		const stamped = await t.run(async (ctx) => {
			const contacts = await ctx.db.query('contacts').collect();
			return contacts.filter((contact) => contact.sunsetEvaluatedAt !== undefined).length;
		});
		expect(stamped).toBe(5);
	});

	it('does not rescan settled contacts', async () => {
		const t = harness();
		await seedQuietContacts(t, 4);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		const again = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});

		expect(again.scanned).toBe(0);
		expect(again.isDone).toBe(true);
	});

	it('re-scans a contact once its stamp goes stale', async () => {
		const t = harness();
		const ids = await seedQuietContacts(t, 1);
		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});

		await t.run(async (ctx) => {
			const id = ids[0];
			if (id === undefined) throw new Error('fixture contact missing');
			await ctx.db.patch(id, { sunsetEvaluatedAt: Date.now() - SUNSET_STALE_MS - 1000 });
		});

		const again = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(again.scanned).toBe(1);
	});

	it('stamps a soft-deleted contact so it cannot pin the head of the scan', async () => {
		const t = harness();
		const ids = await seedQuietContacts(t, 1);
		await t.run(async (ctx) => {
			const id = ids[0];
			if (id === undefined) throw new Error('fixture contact missing');
			await ctx.db.patch(id, { deletedAt: Date.now() });
		});

		const first = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(first.scanned).toBe(1);

		const second = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(second.scanned).toBe(0);
	});
});

describe('sunset sweep — it actually transitions contacts', () => {
	it('counts each kind of transition it applied', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			const suppressMe = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'sweep-suppress@example.com',
					createdAt: agoReal(500),
					updatedAt: agoReal(500),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: suppressMe,
				activityType: 'email_sent',
				occurredAt: agoReal(480),
			});

			const reengageMe = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'sweep-reengage@example.com',
					createdAt: agoReal(400),
					updatedAt: agoReal(400),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: reengageMe,
				activityType: 'email_sent',
				occurredAt: agoReal(390),
			});
			await ctx.db.insert('contactActivities', {
				contactId: reengageMe,
				activityType: 'email_opened',
				occurredAt: agoReal(200),
			});
		});

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});

		expect(result.scanned).toBe(2);
		expect(result.suppressed).toBe(1);
		expect(result.reengaged).toBe(1);

		await t.run(async (ctx) => {
			const blocked = await ctx.db.query('blockedEmails').collect();
			expect(blocked).toHaveLength(1);
			expect(blocked[0]?.email).toBe('sweep-suppress@example.com');
			expect(blocked[0]?.reason).toBe('unengaged');
		});
	});
});

describe('sunset sweep — self-scheduling', () => {
	/**
	 * The chain is what turns a 50-contact transaction into a
	 * `SUNSET_CONTACTS_PER_TICK` tick, and the batch budget is what stops it
	 * running forever. Every other case in this file passes
	 * `batchesRemaining: 1`, which exercises neither.
	 */
	it('enqueues exactly one follow-up while budget remains', async () => {
		const t = harness();
		await seedQuietContacts(t, SUNSET_BATCH_SIZE + 5);

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: SUNSET_BATCH_SIZE,
			batchesRemaining: 2,
		});

		expect(result.isDone).toBe(false);
		expect(result.isBudgetExhausted).toBe(false);

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]!.args[0]).toMatchObject({ batchesRemaining: 1 });
	});

	it('stops chaining on the last batch of the budget', async () => {
		const t = harness();
		await seedQuietContacts(t, SUNSET_BATCH_SIZE + 5);

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: SUNSET_BATCH_SIZE,
			batchesRemaining: 1,
		});

		expect(result.isDone).toBe(false);
		// The book is bigger than this tick: the sweep says so rather than
		// chaining past its ceiling.
		expect(result.isBudgetExhausted).toBe(true);

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(0);
	});

	it('does not chain when the range is already drained', async () => {
		const t = harness();
		await seedQuietContacts(t, 2);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: SUNSET_BATCH_SIZE,
			batchesRemaining: 5,
		});

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(0);
	});
});

/**
 * THE BLAST-RADIUS CEILING. Every per-contact guard answers "is THIS contact
 * quiet". None of them can notice that the answer became "yes" for the whole
 * book at once — a jumped clock, a bad import, a mis-saved policy. The ceiling
 * is the bound on that entire class of mistake.
 */
describe('sunset sweep — the per-tick suppression ceiling', () => {
	async function seedSuppressibleContacts(t: Harness, count: number): Promise<void> {
		await t.run(async (ctx) => {
			for (let i = 0; i < count; i += 1) {
				const id = await ctx.db.insert(
					'contacts',
					createTestContact({
						email: `ceiling-${i}@example.com`,
						createdAt: agoReal(500),
						updatedAt: agoReal(500),
					})
				);
				await ctx.db.insert('contactActivities', {
					contactId: id,
					activityType: 'email_sent',
					occurredAt: agoReal(480),
				});
			}
		});
	}

	it('stops at the ceiling instead of suppressing the whole batch', async () => {
		const t = harness();
		await seedSuppressibleContacts(t, 6);

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
			maxSuppressions: 2,
		});

		expect(result.suppressed).toBe(2);
		expect(result.deferredSuppressions).toBe(1);
		expect(result.isSuppressionCeilingHit).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(2);
		});
	});

	it('leaves the refused contact in the stale range so the next tick retries it', async () => {
		const t = harness();
		await seedSuppressibleContacts(t, 4);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
			maxSuppressions: 1,
		});

		// One suppressed, one refused-and-unstamped, two never reached.
		const unsettled = await t.run(async (ctx) => {
			const rows = await ctx.db.query('contacts').collect();
			return rows.filter((row) => row.sunsetEvaluatedAt === undefined).length;
		});
		expect(unsettled).toBe(3);

		const second = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
			maxSuppressions: 1,
		});
		expect(second.suppressed).toBe(1);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(2);
		});
	});

	it('stops chaining once the ceiling is hit', async () => {
		const t = harness();
		await seedSuppressibleContacts(t, 6);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 10,
			maxSuppressions: 1,
		});

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(0);
	});

	it('records an operator-readable summary naming the ceiling', async () => {
		const t = harness();
		await seedSuppressibleContacts(t, 4);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
			maxSuppressions: 1,
		});

		const summary = await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			return logs.find((log) => log.action === 'contact.sunset_sweep_summary');
		});
		expect(summary).toBeDefined();
		expect(summary?.userId).toBe('system');
		expect(summary?.details?.['suppressed']).toBe(1);
		expect(summary?.details?.['deferredSuppressions']).toBe(1);
		expect(summary?.details?.['isSuppressionCeilingHit']).toBe(true);
		expect(String(summary?.details?.['message'])).toMatch(/Auto-suppression paused/);
	});

	it('summarises an ordinary suppressing tick too, and stays silent on a quiet one', async () => {
		const t = harness();
		await seedSuppressibleContacts(t, 2);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		const afterSuppressing = await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			return logs.filter((log) => log.action === 'contact.sunset_sweep_summary');
		});
		expect(afterSuppressing).toHaveLength(1);
		expect(String(afterSuppressing[0]?.details?.['message'])).toMatch(/auto-suppressed/);

		// A second tick has nothing left to do — and writes no summary.
		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		const afterQuiet = await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			return logs.filter((log) => log.action === 'contact.sunset_sweep_summary');
		});
		expect(afterQuiet).toHaveLength(1);
	});
});

/**
 * THE JUMPED CLOCK, THROUGH THE CRON — the only production caller.
 *
 * The engine's corroboration guard was previously asserted only against
 * `evaluateSunset` with a hand-supplied second reading of time. That is not
 * where it has to hold: the sweep DERIVES that second reading from the freshest
 * `sunsetEvaluatedAt` in the table and also WRITES that field, so a guard that
 * runs after the write protects exactly one tick and is inert from the second
 * one onwards. These fixtures run consecutive ticks under a clock that
 * disagrees with every stored stamp and assert the LAST tick is still inert.
 */
describe('sunset sweep — a host clock that disagrees with the stored stamps', () => {
	/**
	 * Contacts that would be suppressed on a trustworthy clock: long-tenured,
	 * measurable, silent since the first send — and stamped by an "earlier tick"
	 * so far in the past that `now` cannot be reconciled with it.
	 */
	async function seedSkewedBook(t: Harness, count: number): Promise<void> {
		await t.run(async (ctx) => {
			for (let i = 0; i < count; i += 1) {
				const id = await ctx.db.insert(
					'contacts',
					createTestContact({
						email: `skew-${i}@example.com`,
						createdAt: agoReal(900),
						updatedAt: agoReal(900),
					})
				);
				await ctx.db.insert('contactActivities', {
					contactId: id,
					activityType: 'email_sent',
					occurredAt: agoReal(880),
				});
				await ctx.db.patch(id, { sunsetEvaluatedAt: agoReal(365) });
			}
		});
	}

	const readStamps = async (t: Harness): Promise<(number | undefined)[]> =>
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('contacts').collect();
			return rows.map((row) => row.sunsetEvaluatedAt);
		});

	it('is inert on the SECOND and every later tick, not just the first', async () => {
		const t = harness();
		await seedSkewedBook(t, 4);
		const before = await readStamps(t);

		for (let tick = 0; tick < 3; tick += 1) {
			const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
				batchSize: 10,
				batchesRemaining: 1,
			});
			expect(result.isClockSkewed).toBe(true);
			expect(result.scanned).toBe(0);
			expect(result.suppressed).toBe(0);
		}

		// The property that matters after the LAST tick: nothing was suppressed
		// and no contact was moved to a sunset stage.
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
			const rows = await ctx.db.query('contacts').collect();
			expect(rows.filter((row) => row.sunsetStage === 'suppressed')).toHaveLength(0);
			expect(rows.filter((row) => row.sunsetStage === 'reengagement')).toHaveLength(0);
		});

		// …and the reason it stays inert: the freshness stamp — which IS the
		// corroboration source — was never advanced, so every later tick
		// re-detects the same disagreement instead of believing its own writes.
		expect(await readStamps(t)).toEqual(before);
	});

	it('does not chain, and burns no batch budget, while the clock is wrong', async () => {
		const t = harness();
		await seedSkewedBook(t, 4);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 20,
		});

		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(0);
	});

	it('tells the operator why the sweep stalled', async () => {
		const t = harness();
		await seedSkewedBook(t, 2);

		await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});

		const summary = await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			return logs.find((log) => log.action === 'contact.sunset_sweep_summary');
		});
		expect(summary).toBeDefined();
		expect(summary?.details?.['isClockSkewed']).toBe(true);
		expect(summary?.details?.['suppressed']).toBe(0);
		expect(String(summary?.details?.['message'])).toMatch(/clock/i);
	});

	it('resumes normally once the stored stamps agree with the clock again', async () => {
		const t = harness();
		await seedSkewedBook(t, 2);

		const skewed = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(skewed.isClockSkewed).toBe(true);

		// The operator fixes the clock: the stamps are now plausibly recent
		// relative to `now`, while still stale enough to be re-evaluated.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('contacts').collect();
			for (const row of rows) {
				await ctx.db.patch(row._id, { sunsetEvaluatedAt: Date.now() - SUNSET_STALE_MS - 1000 });
			}
		});

		const recovered = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(recovered.isClockSkewed).toBe(false);
		expect(recovered.scanned).toBe(2);
		expect(recovered.suppressed).toBe(2);
	});
});

/**
 * A NON-FINITE ARGUMENT MUST DEGRADE, NEVER THROW. A throw inside this mutation
 * rolls the transaction back, which re-presents the identical head of the scan
 * to the next tick — the chain would wedge permanently rather than skip a bad
 * call.
 */
describe('sunset sweep — hostile arguments', () => {
	it('falls back to the built-in bounds when they are not finite numbers', async () => {
		const t = harness();
		await seedQuietContacts(t, 3);

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: Number.NaN,
			batchesRemaining: Number.NaN,
			suppressedSoFar: Number.NaN,
			maxSuppressions: Number.NaN,
		});

		// The batch was taken, not `.take(NaN)`-ed.
		expect(result.scanned).toBe(3);
		expect(result.isDone).toBe(true);
	});

	it('treats an unreadable prior suppression count as budget already spent', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'nan-budget@example.com',
					createdAt: agoReal(500),
					updatedAt: agoReal(500),
				})
			);
			await ctx.db.insert('contactActivities', {
				contactId: id,
				activityType: 'email_sent',
				occurredAt: agoReal(480),
			});
		});

		const result = await t.mutation(internal.contacts.sunsetSweep.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
			suppressedSoFar: Number.NaN,
		});

		expect(result.suppressed).toBe(0);
		expect(result.deferredSuppressions).toBe(1);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('blockedEmails').collect()).toHaveLength(0);
		});
	});
});
