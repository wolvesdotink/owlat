/**
 * The screener decision shared by the Reply Queue gate and the reader's
 * `senderState` (mail/ai/needsReplyScoring.ts): `resolveScreenerEnabled` turns
 * the screener off for a shared mailbox and follows the owner's preference on a
 * personal one, and `scoreAndScreenResult` applies exactly that answer.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { resolveScreenerEnabled, scoreAndScreenResult } from '../ai/needsReplyScoring';
import { senderSignalFromContact } from '../ai/priorityScore';
import { modules, seedMailbox } from './helpers.testlib';

type T = ReturnType<typeof convexTest>;

async function seedScreener(t: T, userId: string, on: boolean): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailUserSettings', {
			userId,
			autoAdvance: 'next',
			isSenderScreenerOn: on,
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function screenerFor(t: T, mailboxId: Id<'mailboxes'>): Promise<boolean> {
	return t.run(async (ctx) => {
		const mailbox = await ctx.db.get(mailboxId);
		if (!mailbox) throw new Error('mailbox missing');
		return resolveScreenerEnabled(ctx, mailbox);
	});
}

describe('resolveScreenerEnabled', () => {
	it("follows the owner's preference on a personal mailbox", async () => {
		const t = convexTest(schema, modules);
		const on = await seedMailbox(t, { userId: 'owner-on', address: 'on@owlat.test' });
		const off = await seedMailbox(t, { userId: 'owner-off', address: 'off@owlat.test' });
		const unset = await seedMailbox(t, { userId: 'owner-unset', address: 'unset@owlat.test' });
		await seedScreener(t, 'owner-on', true);
		await seedScreener(t, 'owner-off', false);

		expect(await screenerFor(t, on)).toBe(true);
		expect(await screenerFor(t, off)).toBe(false);
		expect(await screenerFor(t, unset)).toBe(false);
	});

	it('is off for a shared mailbox even when its connecting user has it on', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'admin-user', scope: 'shared' });
		await seedScreener(t, 'admin-user', true);
		expect(await screenerFor(t, mailboxId)).toBe(false);
	});
});

describe('scoreAndScreenResult', () => {
	async function score(t: T, mailboxId: Id<'mailboxes'>) {
		return t.run(async (ctx) => {
			const mailbox = await ctx.db.get(mailboxId);
			if (!mailbox) throw new Error('mailbox missing');
			return scoreAndScreenResult(ctx, {
				mailbox,
				message: { fromAddress: 'stranger@example.com' } as Doc<'mailMessages'>,
				resolved: { messageId: 'm1' as Id<'mailMessages'>, urgency: 'normal' as const },
			});
		});
	}

	it('holds an unknown sender out on a personal mailbox with the screener on', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'owner-user' });
		await seedScreener(t, 'owner-user', true);
		expect(await score(t, mailboxId)).toBeNull();
	});

	it('scores an unknown sender on a shared mailbox instead of screening it', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'admin-user', scope: 'shared' });
		await seedScreener(t, 'admin-user', true);
		expect(await score(t, mailboxId)).toMatchObject({ priorityScore: expect.any(Number) });
	});
});

describe('senderSignalFromContact', () => {
	it('reads no row as a stranger', () => {
		expect(senderSignalFromContact(null, 0)).toEqual({});
	});

	it('reads any row as a known contact, carrying its VIP and accepted flags', () => {
		const signal = senderSignalFromContact(
			{ isVip: true, isScreenerAccepted: true, useCount: 0, lastUsedAt: 0 },
			0
		);
		expect(signal).toMatchObject({ isVip: true, accepted: true, isKnownContact: true });
		expect(senderSignalFromContact({ useCount: 1, lastUsedAt: 0 }, 0)).toMatchObject({
			isVip: false,
			accepted: false,
			isKnownContact: true,
		});
	});
});
