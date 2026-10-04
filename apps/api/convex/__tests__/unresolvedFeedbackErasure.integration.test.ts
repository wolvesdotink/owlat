/**
 * Unresolved feedback (#1194) leaves with the contact whose address it names,
 * whichever way that address stopped being findable: an alias that was added
 * after the feedback arrived and then dropped at soft-delete, a merge into
 * another contact, an email change, or more identities than one read covers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { createTestContact, createTestContactIdentity } from './factories';
import { newHarness } from './testModules';
import { dispatchInboundEvent } from '../webhooks/dispatcher';
import {
	mergeContactRelations,
	permanentlyDeleteContactWithRelations,
	softDeleteContact,
} from '../lib/contactMutations';
import { changeContactEmail } from '../contacts/resolution';

type T = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** An unattributed SES complaint naming `recipient`, through the real dispatcher. */
function complain(t: T, providerMessageId: string, recipient: string): Promise<void> {
	const actionCtx = {
		runMutation: (mutation: Parameters<ActionCtx['runMutation']>[0], args: unknown) =>
			t.mutation(mutation, args as never),
	} as unknown as ActionCtx;
	return dispatchInboundEvent(actionCtx, {
		kind: 'email.complained',
		providerMessageId,
		recipient,
		providerType: 'ses',
		at: Date.now(),
	});
}

async function rows(t: T) {
	return await t.run(async (ctx) => await ctx.db.query('unresolvedFeedback').collect());
}

async function seedContact(
	t: T,
	email: string,
	aliases: readonly string[] = [],
	overrides: Record<string, unknown> = {}
): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact({ email, ...overrides }));
		await ctx.db.insert(
			'contactIdentities',
			createTestContactIdentity({ contactId, identifier: email, isPrimary: true })
		);
		for (const identifier of aliases) {
			await ctx.db.insert(
				'contactIdentities',
				createTestContactIdentity({ contactId, identifier, isPrimary: false })
			);
		}
		return contactId;
	});
}

/** Soft-delete the contact the ordinary way, past its grace, and run the erasure walker. */
async function softDeleteAndErase(t: T, contactId: Id<'contacts'>): Promise<void> {
	await t.run(async (ctx) => {
		await softDeleteContact(ctx, contactId, 'test');
		await ctx.db.patch(contactId, { deletedAt: Date.now() - 40 * DAY });
	});
	await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await t.run(async (ctx) => await ctx.db.get(contactId))).toBeNull();
}

describe('unresolved feedback stored before its address belonged to the contact', () => {
	it('is erased after an ordinary soft-delete removed the alias', async () => {
		const t = newHarness();
		await complain(t, 'pre-link', 'alias@example.com');
		const contactId = await seedContact(t, 'primary@example.com', ['alias@example.com']);
		expect((await rows(t))[0]?.contactId).toBeUndefined();

		await softDeleteAndErase(t, contactId);

		expect(await rows(t)).toEqual([]);
	});

	it('is erased after an email change retired the old address', async () => {
		const t = newHarness();
		await complain(t, 'old-address', 'old@example.com');
		const contactId = await seedContact(t, 'old@example.com');
		await t.run(async (ctx) => {
			const contact = (await ctx.db.get(contactId))!;
			const { email } = await changeContactEmail(ctx, contact, 'new@example.com');
			await ctx.db.patch(contactId, { email });
		});

		await softDeleteAndErase(t, contactId);

		expect(await rows(t)).toEqual([]);
	});
});

describe('unresolved feedback through a contact merge', () => {
	it('follows the merge, and goes when the survivor is erased', async () => {
		const t = newHarness();
		const sourceId = await seedContact(t, 'source@example.com');
		const targetId = await seedContact(t, 'target@example.com');
		await complain(t, 'merged', 'source@example.com');
		expect((await rows(t))[0]?.contactId).toBe(sourceId);

		await t.run(async (ctx) => {
			await mergeContactRelations(ctx, targetId, sourceId);
			await ctx.db.delete(sourceId);
		});
		expect((await rows(t))[0]?.contactId).toBe(targetId);

		await softDeleteAndErase(t, targetId);

		expect(await rows(t)).toEqual([]);
	});
});

describe('unresolved feedback naming one of many identities', () => {
	const aliases = Array.from({ length: 150 }, (_, i) => `alias-${i + 1}@example.com`);

	it('the inline erasure reaches every identity', async () => {
		const t = newHarness();
		await complain(t, 'alias-150', 'alias-150@example.com');
		const contactId = await seedContact(t, 'primary@example.com', aliases);

		await t.run(async (ctx) => await permanentlyDeleteContactWithRelations(ctx, contactId));

		expect(await rows(t)).toEqual([]);
	});

	it('the erasure walker reaches every identity across bounded transactions', async () => {
		const t = newHarness();
		// More identities than one walker transaction may touch (400 rows).
		const many = Array.from({ length: 450 }, (_, i) => `alias-${i + 1}@example.com`);
		await complain(t, 'alias-450-walk', 'alias-450@example.com');
		// Rows a soft-delete from before this release left behind: the identities
		// are still there and the feedback is not linked.
		const contactId = await seedContact(t, 'primary@example.com', many, {
			deletedAt: Date.now() - 40 * DAY,
		});

		await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await t.run(async (ctx) => await ctx.db.get(contactId))).toBeNull();
		expect(await rows(t)).toEqual([]);
	});
});
