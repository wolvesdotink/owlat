/**
 * Moving and copying messages between mailboxes (`mail/mailboxTransfer.ts`).
 *
 * The properties worth pinning:
 *   - a move writes the target row before it deletes the source, keeps read,
 *     star and label state, and shares the blobs rather than losing them;
 *   - moving the copy back (the client's undo) restores the message;
 *   - a copy leaves the source alone;
 *   - the target must be on the caller's own rail, whatever their org role;
 *   - a sealed message only travels to a mailbox on its own address;
 *   - a connected account is never the target, and never the source of a move;
 *   - a message the target already holds is skipped, not duplicated.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { readMailboxUsage } from '../mailboxUsage';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: sessionMocks.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(session),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
});

type Test = TestConvex<typeof schema>;

async function seedMailboxWithFolders(
	t: Test,
	seed: Parameters<typeof seedMailbox>[1]
): Promise<{ mailboxId: Id<'mailboxes'>; inboxId: Id<'mailFolders'> }> {
	const mailboxId = await seedMailbox(t, seed);
	const inboxId = await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'archive');
	return { mailboxId, inboxId };
}

async function messagesIn(t: Test, mailboxId: Id<'mailboxes'>): Promise<Doc<'mailMessages'>[]> {
	return t.run((ctx) =>
		ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
			.collect()
	);
}

async function setup(t: Test) {
	const work = await seedMailboxWithFolders(t, { address: 'work@owlat.test' });
	const personal = await seedMailboxWithFolders(t, { address: 'me@owlat.test' });
	return { work, personal };
}

describe('mail.mailboxTransfer.transfer', () => {
	it('moves a message with its flags and labels, and the undo brings it back', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const messageId = await seedMessage(t, personal.mailboxId, { subject: 'Contract' });
		const rawStorageId = await t.run(async (ctx) => {
			const parent = await ctx.db.insert('mailLabels', {
				mailboxId: personal.mailboxId,
				name: 'Clients',
				createdAt: 0,
			});
			const leaf = await ctx.db.insert('mailLabels', {
				mailboxId: personal.mailboxId,
				name: 'Acme',
				parentId: parent,
				createdAt: 0,
			});
			await ctx.db.patch(messageId, { flagSeen: true, flagFlagged: true, labelIds: [leaf] });
			return (await ctx.db.get(messageId))!.rawStorageId;
		});

		const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: work.mailboxId,
			mode: 'move',
		});

		expect(result.skipped).toEqual([]);
		expect(result.moved).toHaveLength(1);
		expect(result.moved[0]!.sourceFolderId).toBe(personal.inboxId);
		expect(await messagesIn(t, personal.mailboxId)).toEqual([]);
		const [copy] = await messagesIn(t, work.mailboxId);
		expect(copy).toMatchObject({
			_id: result.moved[0]!.messageId,
			folderId: work.inboxId,
			subject: 'Contract',
			flagSeen: true,
			flagFlagged: true,
			rawStorageId,
		});
		const copyLabels = await t.run(async (ctx) =>
			Promise.all(copy!.labelIds.map(async (id) => ctx.db.get(id)))
		);
		expect(copyLabels.map((label) => [label?.mailboxId, label?.name])).toEqual([
			[work.mailboxId, 'Acme'],
		]);
		// The raw blob outlived the source row: the copy still references it.
		expect(await t.run(async (ctx) => ctx.storage.getUrl(rawStorageId))).not.toBeNull();
		const thread = await t.run(async (ctx) => ctx.db.get(copy!.threadId));
		expect(thread).toMatchObject({ mailboxId: work.mailboxId, messageCount: 1, hasFlagged: true });
		const usage = await t.run(async (ctx) => ({
			work: (await readMailboxUsage(ctx.db, (await ctx.db.get(work.mailboxId))!)).usedBytes,
			personal: (await readMailboxUsage(ctx.db, (await ctx.db.get(personal.mailboxId))!)).usedBytes,
		}));
		expect(usage).toEqual({ work: copy!.rawSize, personal: 0 });

		// Undo: the client moves each copy back to the folder its source sat in.
		await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [copy!._id],
			targetMailboxId: personal.mailboxId,
			targetFolderId: result.moved[0]!.sourceFolderId,
			mode: 'move',
		});
		expect(await messagesIn(t, work.mailboxId)).toEqual([]);
		const [back] = await messagesIn(t, personal.mailboxId);
		expect(back).toMatchObject({ folderId: personal.inboxId, flagSeen: true, flagFlagged: true });
	});

	it('a copy leaves the source where it was', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const messageId = await seedMessage(t, personal.mailboxId, { subject: 'Receipt' });

		const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: work.mailboxId,
			mode: 'copy',
		});

		expect(result.moved).toHaveLength(1);
		expect((await messagesIn(t, personal.mailboxId)).map((m) => m._id)).toEqual([messageId]);
		expect(await messagesIn(t, work.mailboxId)).toHaveLength(1);
	});

	it('files into the folder it is given', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const archiveId = await t.run(async (ctx) =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', work.mailboxId).eq('role', 'archive')
				)
				.first()
		);
		const messageId = await seedMessage(t, personal.mailboxId);

		await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: work.mailboxId,
			targetFolderId: archiveId!._id,
			mode: 'move',
		});

		const [copy] = await messagesIn(t, work.mailboxId);
		expect(copy?.folderId).toBe(archiveId!._id);
	});

	it('skips a message the target already holds', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const shared = '<same@example.com>';
		const messageId = await seedMessage(t, personal.mailboxId, { rfc822MessageId: shared });
		await seedMessage(t, work.mailboxId, { rfc822MessageId: shared });

		const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: work.mailboxId,
			mode: 'move',
		});

		expect(result).toEqual({ ok: true, moved: [], skipped: [messageId] });
		expect((await messagesIn(t, personal.mailboxId)).map((m) => m._id)).toEqual([messageId]);
		expect(await messagesIn(t, work.mailboxId)).toHaveLength(1);
	});

	it("refuses a teammate's personal mailbox, even to an org owner", async () => {
		const t = convexTest(schema, modules);
		const { personal } = await setup(t);
		const teammate = await seedMailboxWithFolders(t, {
			userId: 'user-B',
			address: 'b@owlat.test',
		});
		const messageId = await seedMessage(t, personal.mailboxId);
		sessionMocks.role = 'owner';

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [messageId],
				targetMailboxId: teammate.mailboxId,
				mode: 'move',
			})
		).rejects.toThrow(/not accessible/);
		expect(await messagesIn(t, personal.mailboxId)).toHaveLength(1);
	});

	it('lets a team inbox member file into it, and nobody else', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await setup(t);
		const team = await seedMailboxWithFolders(t, {
			userId: 'user-B',
			address: 'team@owlat.test',
			scope: 'shared',
		});
		const first = await seedMessage(t, personal.mailboxId, { subject: 'one' });
		const second = await seedMessage(t, personal.mailboxId, { subject: 'two' });
		const args = { targetMailboxId: team.mailboxId, mode: 'move' as const };

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, { ...args, messageIds: [first] })
		).rejects.toThrow(/not accessible/);

		await t.run(async (ctx) => {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: team.mailboxId,
				authUserId: 'user-A',
				role: 'member',
				addedBy: 'user-B',
				createdAt: 0,
			});
		});
		await t.mutation(api.mail.mailboxTransfer.transfer, { ...args, messageIds: [second] });
		expect((await messagesIn(t, team.mailboxId)).map((m) => m.subject)).toEqual(['two']);
	});

	it('does not move what the caller cannot reach in the source', async () => {
		const t = convexTest(schema, modules);
		const { work } = await setup(t);
		const teammate = await seedMailboxWithFolders(t, {
			userId: 'user-B',
			address: 'b@owlat.test',
		});
		const messageId = await seedMessage(t, teammate.mailboxId);

		const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: work.mailboxId,
			mode: 'move',
		});

		expect(result.moved).toEqual([]);
		expect(await messagesIn(t, teammate.mailboxId)).toHaveLength(1);
		expect(await messagesIn(t, work.mailboxId)).toEqual([]);
	});

	it('keeps a sealed message on its own address', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const sameAddress = await seedMailboxWithFolders(t, { address: 'me@owlat.test' });
		const messageId = await seedMessage(t, personal.mailboxId);
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, {
				inboundEncryptionInfo: { isSealed: true, isDecrypted: false },
			});
		});

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [messageId],
				targetMailboxId: work.mailboxId,
				mode: 'copy',
			})
		).rejects.toThrow(/sealed/);
		expect(await messagesIn(t, work.mailboxId)).toEqual([]);

		await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: sameAddress.mailboxId,
			mode: 'move',
		});
		expect(await messagesIn(t, sameAddress.mailboxId)).toHaveLength(1);
	});

	it('never writes into a connected account', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await setup(t);
		const connected = await seedMailboxWithFolders(t, {
			address: 'me@example.com',
			kind: 'external',
		});
		const messageId = await seedMessage(t, personal.mailboxId);

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [messageId],
				targetMailboxId: connected.mailboxId,
				mode: 'copy',
			})
		).rejects.toThrow(/connected account/);
		expect(await messagesIn(t, connected.mailboxId)).toEqual([]);
	});

	it('copies out of a connected account but does not move out of one', async () => {
		const t = convexTest(schema, modules);
		const { work } = await setup(t);
		const connected = await seedMailboxWithFolders(t, {
			address: 'me@example.com',
			kind: 'external',
		});
		const messageId = await seedMessage(t, connected.mailboxId);
		const args = { messageIds: [messageId], targetMailboxId: work.mailboxId };

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, { ...args, mode: 'move' })
		).rejects.toThrow(/copied, not moved/);
		expect(await messagesIn(t, work.mailboxId)).toEqual([]);

		await t.mutation(api.mail.mailboxTransfer.transfer, { ...args, mode: 'copy' });
		expect(await messagesIn(t, work.mailboxId)).toHaveLength(1);
		expect(await messagesIn(t, connected.mailboxId)).toHaveLength(1);
	});
});
