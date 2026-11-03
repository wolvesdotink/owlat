import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../_generated/dataModel';
import {
	type Harness,
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedIdentity,
	seedMembership,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Saved replies under member erasure: the member's personal replies go
 * (including ones written before saved replies, on their personal mailbox);
 * the shared replies they wrote stay with the organization, without their
 * name on them; a colleague's replies are untouched.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function reply(name: string, fields: Record<string, unknown>) {
	return {
		name,
		shortcut: '',
		bodyHtml: `<p>${name}</p>`,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...fields,
	};
}

async function insertReply(t: Harness, name: string, fields: Record<string, unknown>) {
	return t.run((ctx) => ctx.db.insert('mailSnippets', reply(name, fields) as never));
}

/** A reply carrying one file it owns through a bound upload receipt. */
async function insertReplyWithFile(t: Harness, name: string, fields: Record<string, unknown>) {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([name]));
		const replyId = await ctx.db.insert('mailSnippets', {
			...reply(name, fields),
			attachments: [
				{ storageId, filename: `${name}.pdf`, contentType: 'application/pdf', size: 4 },
			],
		} as never);
		await ctx.db.insert('storageUploads', {
			userId: 'someone',
			organizationId: 'org-x',
			storageId,
			status: 'bound',
			resourceKey: `mailSnippets:${replyId}`,
		});
		return { replyId, storageId };
	});
}

describe('saved replies', () => {
	it('erases personal replies, clears authorship on shared ones, keeps a colleague’s', async () => {
		const t = erasureHarness();
		const { organizationId, authUserId, requestId } = await seedEditor(t);
		const { mailboxId } = await seedPersonalMailbox(t, authUserId);
		const colleagueId = await seedIdentity(t, 'colleague@example.com');
		await seedMembership(t, organizationId, colleagueId, 'editor');

		const personal = await insertReply(t, 'mine', { scope: 'personal', ownerUserId: authUserId });
		const legacy = await insertReply(t, 'old', { mailboxId });
		const shared = await insertReply(t, 'team', {
			scope: 'shared',
			organizationId,
			authorUserId: authUserId,
		});
		const colleagues = await insertReply(t, 'theirs', {
			scope: 'personal',
			ownerUserId: colleagueId,
		});

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			for (const gone of [personal, legacy] as Id<'mailSnippets'>[]) {
				expect(await ctx.db.get(gone), String(gone)).toBeNull();
			}
			const kept = await ctx.db.get(shared as Id<'mailSnippets'>);
			expect(kept).toMatchObject({ scope: 'shared', name: 'team' });
			expect(kept?.authorUserId).toBeUndefined();
			expect(await ctx.db.get(colleagues as Id<'mailSnippets'>)).not.toBeNull();
		});
	});

	it('deletes the files of personal replies and keeps a shared reply’s file a draft borrowed', async () => {
		const t = erasureHarness();
		const { organizationId, authUserId, requestId } = await seedEditor(t);
		const { mailboxId } = await seedPersonalMailbox(t, authUserId);

		const personal = await insertReplyWithFile(t, 'mine', {
			scope: 'personal',
			ownerUserId: authUserId,
		});
		const legacy = await insertReplyWithFile(t, 'old', { mailboxId });
		const shared = await insertReplyWithFile(t, 'team', { scope: 'shared', organizationId });
		await t.run((ctx) =>
			ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: [],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: '',
				bodyHtml: '',
				attachments: [
					{
						storageId: shared.storageId,
						filename: 'team.pdf',
						contentType: 'application/pdf',
						size: 4,
						isInline: false,
						savedReplyId: shared.replyId,
					},
				],
				state: 'draft',
				lastEditedAt: Date.now(),
				createdAt: Date.now(),
			})
		);

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			for (const gone of [personal, legacy]) {
				expect(await ctx.db.get(gone.replyId)).toBeNull();
				expect(await ctx.db.system.get(gone.storageId)).toBeNull();
				const receipt = await ctx.db
					.query('storageUploads')
					.withIndex('by_storage', (q) => q.eq('storageId', gone.storageId))
					.unique();
				expect(receipt).toBeNull();
			}
			expect(await ctx.db.get(shared.replyId)).not.toBeNull();
			expect(await ctx.db.system.get(shared.storageId)).not.toBeNull();
		});
	});
});
