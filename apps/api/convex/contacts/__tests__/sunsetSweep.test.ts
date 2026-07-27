import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import { SUNSET_BATCH_SIZE, SUNSET_STALE_MS } from '../sunset';
import { DAY } from './sunsetFixtures';

/**
 * THE SWEEP IS BOUNDED, RESUMABLE AND DOES NOT RESCAN SETTLED CONTACTS
 * (deliverability plan P4-4). It is a cursor-ranged indexed scan, never a
 * full-table walk: `sunsetEvaluatedAt` is both the freshness stamp and the
 * cursor, so a contact leaves the scanned range the moment it is looked at.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const contactsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../contacts/'),
		mod,
	])
);
const modules = { ...rootGlob, ...contactsGlob };

function harness() {
	return convexTest(schema, modules);
}

type Harness = ReturnType<typeof harness>;

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

		const result = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
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

		const result = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
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

		const first = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 1,
		});
		const second = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
			batchSize: 2,
			batchesRemaining: 1,
		});
		const third = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
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

		await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		const again = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});

		expect(again.scanned).toBe(0);
		expect(again.isDone).toBe(true);
	});

	it('re-scans a contact once its stamp goes stale', async () => {
		const t = harness();
		const ids = await seedQuietContacts(t, 1);
		await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});

		await t.run(async (ctx) => {
			const id = ids[0];
			if (id === undefined) throw new Error('fixture contact missing');
			await ctx.db.patch(id, { sunsetEvaluatedAt: Date.now() - SUNSET_STALE_MS - 1000 });
		});

		const again = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
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

		const first = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
			batchSize: 10,
			batchesRemaining: 1,
		});
		expect(first.scanned).toBe(1);

		const second = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
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

		const result = await t.mutation(internal.contacts.sunset.sweepSunsetPolicy, {
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
