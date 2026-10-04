/**
 * Email lookups on `contacts` resolve the LIVE contact, never a soft-deleted
 * one (#1242).
 *
 * Soft-deleting a contact keeps its email on the row for the retention window,
 * and the address can be used again on day 1, so a deleted original and the
 * live contact that replaced it share an email. `by_email` returns equal keys
 * in creation order, so an unfiltered `.first()` picked the deleted original:
 * a relay unsubscribe opted out the deleted row while the live contact kept
 * receiving marketing mail.
 *
 * Every case seeds the deleted row FIRST, which is the order that exposed it.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { DatabaseWriter } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import {
	createTestContact,
	createTestTopic,
	createTestTransactionalEmail,
	flushScheduled,
} from '../../__tests__/factories';
import { findLiveContactByEmail, LIVE_CONTACT_EMAIL_SCAN_LIMIT } from '../../lib/contactHelpers';
import { contactsLoader } from '../../seedDemo/loaders/contacts';

// The unsubscribe outcome recorder resolves the singleton org through the
// BetterAuth component, which convex-test does not register.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_test') };
});

// Unsubscribes and send transitions schedule webhook fanout and counters.
afterEach(async () => {
	await flushScheduled();
});

const EMAIL = 'jane@example.com';
const DAY_MS = 86_400_000;

/** A soft-deleted original, then the live contact that replaced it. */
async function seedDeletedThenLive(
	ctx: { db: DatabaseWriter },
	overrides: { deleted?: Record<string, unknown>; live?: Record<string, unknown> } = {}
): Promise<{ deletedId: Id<'contacts'>; liveId: Id<'contacts'> }> {
	const deletedId = await ctx.db.insert(
		'contacts',
		createTestContact({
			email: EMAIL,
			deletedAt: Date.now() - DAY_MS,
			deletedBy: 'user-1',
			...overrides.deleted,
		})
	);
	const liveId = await ctx.db.insert(
		'contacts',
		createTestContact({ email: EMAIL, ...overrides.live })
	);
	return { deletedId, liveId };
}

async function joinTopic(ctx: { db: DatabaseWriter }, contactId: Id<'contacts'>): Promise<void> {
	const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
	await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
}

async function memberships(
	ctx: { db: DatabaseWriter },
	contactId: Id<'contacts'>
): Promise<number> {
	const rows = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect();
	return rows.length;
}

describe('findLiveContactByEmail', () => {
	it('returns the live contact when a soft-deleted one shares the email', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const { liveId } = await seedDeletedThenLive(ctx);
			expect((await findLiveContactByEmail(ctx, EMAIL))?._id).toBe(liveId);
		});
	});

	it('normalizes the address before the lookup', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const { liveId } = await seedDeletedThenLive(ctx);
			expect((await findLiveContactByEmail(ctx, '  Jane@Example.COM '))?._id).toBe(liveId);
		});
	});

	it('returns null when only soft-deleted rows carry the email', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: EMAIL, deletedAt: Date.now(), deletedBy: 'user-1' })
			);
			expect(await findLiveContactByEmail(ctx, EMAIL)).toBeNull();
			expect(await findLiveContactByEmail(ctx, '   ')).toBeNull();
		});
	});

	it('reads at most LIVE_CONTACT_EMAIL_SCAN_LIMIT rows, newest first', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			// A live row older than a full window of deleted ones cannot happen
			// (a second live row is refused, and deleted rows are never restored);
			// seeding it shows where the bounded read stops.
			await ctx.db.insert('contacts', createTestContact({ email: EMAIL }));
			for (let i = 0; i < LIVE_CONTACT_EMAIL_SCAN_LIMIT; i++) {
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: EMAIL, deletedAt: Date.now(), deletedBy: 'user-1' })
				);
			}
			expect(await findLiveContactByEmail(ctx, EMAIL)).toBeNull();
		});
	});
});

describe('processUnsubscribeByEmail', () => {
	it('opts out the live contact, not the soft-deleted original', async () => {
		const t = convexTest(schema, modules);
		const { deletedId, liveId } = await t.run(async (ctx) => {
			const ids = await seedDeletedThenLive(ctx);
			await joinTopic(ctx, ids.deletedId);
			await joinTopic(ctx, ids.liveId);
			return ids;
		});

		const result = await t.mutation(
			internal.delivery.unsubscribeQueries.processUnsubscribeByEmail,
			{
				email: EMAIL,
			}
		);

		expect(result).toEqual({ success: true, alreadyUnsubscribed: false, listsRemoved: 1 });
		await t.run(async (ctx) => {
			const live = await ctx.db.get(liveId);
			const deleted = await ctx.db.get(deletedId);
			expect(live?.unsubscribedAt).toBeTypeOf('number');
			expect(await memberships(ctx, liveId)).toBe(0);
			expect(deleted?.unsubscribedAt).toBeUndefined();
			expect(await memberships(ctx, deletedId)).toBe(1);
		});
	});

	it('answers not_found when only a soft-deleted contact carries the address', async () => {
		const t = convexTest(schema, modules);
		const deletedId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({ email: EMAIL, deletedAt: Date.now(), deletedBy: 'user-1' })
			);
			await joinTopic(ctx, id);
			return id;
		});

		const result = await t.mutation(
			internal.delivery.unsubscribeQueries.processUnsubscribeByEmail,
			{
				email: EMAIL,
			}
		);

		expect(result).toEqual({ success: false, reason: 'not_found' });
		await t.run(async (ctx) => {
			expect((await ctx.db.get(deletedId))?.unsubscribedAt).toBeUndefined();
		});
	});
});

describe('applySuppressionBatch (import carry-over)', () => {
	// The original had opted out before it was deleted; the live contact that
	// replaced it has not. Each case runs with and without a topic membership on
	// the live contact: with one, the writer decides the count; without one, the
	// count rests on the importer's own pre-read of the opt-out stamp.
	it.each([
		{ liveInTopic: true, label: 'in a topic' },
		{ liveInTopic: false, label: 'in no topic' },
	])('opts out and counts the live contact $label', async ({ liveInTopic }) => {
		const t = convexTest(schema, modules);
		const originalOptOut = Date.now() - 2 * DAY_MS;
		const { deletedId, liveId } = await t.run(async (ctx) => {
			const ids = await seedDeletedThenLive(ctx, { deleted: { unsubscribedAt: originalOptOut } });
			if (liveInTopic) await joinTopic(ctx, ids.liveId);
			return ids;
		});

		const counts = await t.mutation(
			internal.integrationImports.suppressions.applySuppressionBatch,
			{
				provider: 'mailchimp',
				entries: [{ email: EMAIL, reason: 'unsubscribe', evidence: 'unsubscribed' }],
				skipped: 0,
			}
		);

		expect(counts).toMatchObject({ unsubscribed: 1, alreadyUnsubscribed: 0, noContact: 0 });
		await t.run(async (ctx) => {
			expect((await ctx.db.get(liveId))?.unsubscribedAt).toBeTypeOf('number');
			expect(await memberships(ctx, liveId)).toBe(0);
			expect((await ctx.db.get(deletedId))?.unsubscribedAt).toBe(originalOptOut);
		});
	});
});

describe('resolveRecipientContact (soft-bounce counter)', () => {
	it('counts a contact-less send against the live contact with that address', async () => {
		const t = convexTest(schema, modules);
		const { ids, txSendId } = await t.run(async (ctx) => {
			const seeded = await seedDeletedThenLive(ctx);
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			const sendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional' as const,
				transactionalEmailId,
				email: EMAIL,
				status: 'sent' as const,
				providerMessageId: 'tx_live_contact',
				sentAt: Date.now(),
			});
			return { ids: seeded, txSendId: sendId };
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: txSendId },
			transition: { to: 'bounced', at: Date.now(), bounceType: 'soft' },
		});

		expect(outcome.ok).toBe(true);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.liveId))?.softBounceCount).toBe(1);
			expect((await ctx.db.get(ids.deletedId))?.softBounceCount).toBeUndefined();
		});
	});
});

describe('demo seed contacts loader', () => {
	it('inserts a live contact instead of reusing a soft-deleted one', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const deletedId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: EMAIL, deletedAt: Date.now(), deletedBy: 'user-1' })
			);

			const result = await contactsLoader.load(
				ctx,
				[{ slug: 'jane', email: EMAIL, source: 'api', doiStatus: 'not_required' }],
				{},
				{ inert: false }
			);

			expect(result).toMatchObject({ inserted: 1, skipped: 0 });
			const seeded = (await ctx.db.get(result.ids['jane'] as Id<'contacts'>)) as Doc<'contacts'>;
			expect(seeded._id).not.toBe(deletedId);
			expect(seeded.deletedAt).toBeUndefined();
		});
	});
});
