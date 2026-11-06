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
 *   - into a connected account, the copy is uploaded by an `append` write-back
 *     and a move's source survives until that upload has landed; a failed
 *     upload takes the copy away and leaves the source; the undo of a move
 *     still uploading keeps the original;
 *   - a move out of a connected account deletes the provider's copy;
 *   - a message the target already holds is skipped, not duplicated.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { MAX_REMOTE_OP_ATTEMPTS } from '../external/remoteOps';
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

/** A connected account's mailbox, with the account the worker syncs it through. */
async function connectedMailbox(
	t: Test,
	account: { syncMode?: 'full' | 'incoming' } = {}
): Promise<{
	mailboxId: Id<'mailboxes'>;
	inboxId: Id<'mailFolders'>;
	accountId: Id<'externalMailAccounts'>;
}> {
	const box = await seedMailboxWithFolders(t, { address: 'me@example.com', kind: 'external' });
	const accountId = await t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId: box.mailboxId,
			imapHost: 'imap.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password',
			imapUsername: 'me@example.com',
			status: 'connected',
			...(account.syncMode ? { syncMode: account.syncMode } : {}),
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(box.mailboxId, { externalAccountId: id });
		return id;
	});
	return { ...box, accountId };
}

/** The queued write-backs, oldest first, as the worker would be told them. */
async function remoteOps(t: Test) {
	const rows = await t.run(async (ctx) => ctx.db.query('externalMailRemoteOps').collect());
	return rows.map(({ kind, rfc822MessageId, source }) => ({ kind, rfc822MessageId, source }));
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

		expect(result).toEqual({ ok: true, moved: [], skipped: [messageId], uploading: false });
		expect((await messagesIn(t, personal.mailboxId)).map((m) => m._id)).toEqual([messageId]);
		expect(await messagesIn(t, work.mailboxId)).toHaveLength(1);
	});

	it('copies one message once when two sources share its Message-ID', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const shared = '<twice@example.com>';
		const first = await seedMessage(t, personal.mailboxId, { rfc822MessageId: shared });
		const second = await seedMessage(t, personal.mailboxId, {
			rfc822MessageId: shared,
			role: 'archive',
		});

		const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [first, second],
			targetMailboxId: work.mailboxId,
			mode: 'move',
		});

		expect(result.skipped).toEqual([second]);
		expect(await messagesIn(t, work.mailboxId)).toHaveLength(1);
		expect((await messagesIn(t, personal.mailboxId)).map((m) => m._id)).toEqual([second]);
	});

	it('refuses a sent message while any recipient is still queued', async () => {
		const t = convexTest(schema, modules);
		const { work, personal } = await setup(t);
		const messageId = await seedMessage(t, personal.mailboxId);
		const recipient = (idx: number, state: 'queued' | 'sent') => ({
			idx,
			address: `r${idx}@example.com`,
			mtaJobId: `pb-${messageId}-${idx}`,
			state,
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, {
				outbound: { state: 'partial', recipients: [recipient(0, 'sent'), recipient(1, 'queued')] },
			});
		});

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [messageId],
				targetMailboxId: work.mailboxId,
				mode: 'move',
			})
		).rejects.toThrow(/still being sent/);
		expect(await messagesIn(t, personal.mailboxId)).toHaveLength(1);
		expect(await messagesIn(t, work.mailboxId)).toEqual([]);
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

	it('refuses a connected account that takes no mail from Owlat', async () => {
		const t = convexTest(schema, modules);
		const { personal } = await setup(t);
		const connected = await connectedMailbox(t, { syncMode: 'incoming' });
		const messageId = await seedMessage(t, personal.mailboxId);

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [messageId],
				targetMailboxId: connected.mailboxId,
				mode: 'copy',
			})
		).rejects.toThrow(/takes no mail from Owlat/);
		expect(await messagesIn(t, connected.mailboxId)).toEqual([]);
		expect(await remoteOps(t)).toEqual([]);
	});

	it('moves out of a connected account and deletes the provider copy', async () => {
		const t = convexTest(schema, modules);
		const { work } = await setup(t);
		const connected = await connectedMailbox(t);
		const messageId = await seedMessage(t, connected.mailboxId, { rfc822MessageId: 'out@x' });

		const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
			messageIds: [messageId],
			targetMailboxId: work.mailboxId,
			mode: 'move',
		});

		expect(result.uploading).toBe(false);
		expect(await messagesIn(t, connected.mailboxId)).toEqual([]);
		expect(await messagesIn(t, work.mailboxId)).toHaveLength(1);
		expect(await remoteOps(t)).toEqual([
			{ kind: 'delete', rfc822MessageId: 'out@x', source: { role: 'inbox' } },
		]);
	});

	it('refuses to move mail out of Gmail All Mail, where the provider would keep it', async () => {
		const t = convexTest(schema, modules);
		const { work } = await setup(t);
		const connected = await connectedMailbox(t);
		await t.run(async (ctx) => {
			const archive = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', connected.mailboxId).eq('role', 'archive')
				)
				.first();
			await ctx.db.insert('externalMailFolderSync', {
				accountId: connected.accountId,
				mailboxId: connected.mailboxId,
				folderId: archive!._id,
				remoteName: '[Gmail]/All Mail',
				remoteUidValidity: 1,
				lastSeenUid: 0,
				lastSyncedAt: Date.now(),
			});
		});
		const messageId = await seedMessage(t, connected.mailboxId, {
			rfc822MessageId: 'archived@x',
			role: 'archive',
		});

		await expect(
			t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [messageId],
				targetMailboxId: work.mailboxId,
				mode: 'move',
			})
		).rejects.toThrow(/All Mail/);
		expect((await messagesIn(t, connected.mailboxId)).map((m) => m._id)).toEqual([messageId]);
		expect(await messagesIn(t, work.mailboxId)).toEqual([]);
		expect(await remoteOps(t)).toEqual([]);
	});

	describe('into a connected account', () => {
		async function moveIn(mode: 'move' | 'copy' = 'move') {
			const t = convexTest(schema, modules);
			const { personal } = await setup(t);
			const connected = await connectedMailbox(t);
			const sourceId = await seedMessage(t, personal.mailboxId, {
				rfc822MessageId: 'in@x',
				receivedAt: 1_700_000_000_000,
			});
			await t.run(async (ctx) => ctx.db.patch(sourceId, { flagSeen: true }));
			const result = await t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [sourceId],
				targetMailboxId: connected.mailboxId,
				mode,
			});
			const [op] = await t.run(async (ctx) => ctx.db.query('externalMailRemoteOps').collect());
			return { t, personal, connected, sourceId, result, op: op! };
		}

		it('queues the upload with its flags and keeps the source until it has landed', async () => {
			const { t, personal, connected, sourceId, result, op } = await moveIn();

			expect(result.uploading).toBe(true);
			const [copy] = await messagesIn(t, connected.mailboxId);
			expect(copy).toMatchObject({ _id: result.moved[0]!.messageId, folderId: connected.inboxId });
			expect(await messagesIn(t, personal.mailboxId)).toHaveLength(1);
			expect(op).toMatchObject({
				accountId: connected.accountId,
				kind: 'append',
				rfc822MessageId: 'in@x',
				target: { role: 'inbox' },
				flags: { seen: true, flagged: false, answered: false },
				append: { messageId: copy!._id, sourceMessageId: sourceId, receivedAt: 1_700_000_000_000 },
			});
			// The worker fetches the bytes through the op, from the copy.
			expect(
				await t.query(internal.mail.external.remoteAppend.appendRawSource, { opId: op._id })
			).toBe(copy!.rawStorageId);

			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: op._id, outcome: 'done' }],
			});

			expect(await messagesIn(t, personal.mailboxId)).toEqual([]);
			expect((await messagesIn(t, connected.mailboxId)).map((m) => m._id)).toEqual([copy!._id]);
			expect(await remoteOps(t)).toEqual([]);
		});

		it('takes the copy away and leaves the source when the upload fails for good', async () => {
			const { t, personal, connected, sourceId, op } = await moveIn();
			await t.run(async (ctx) => ctx.db.patch(op._id, { attempts: MAX_REMOTE_OP_ATTEMPTS - 1 }));

			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: op._id, outcome: 'failed', error: 'NO [OVERQUOTA]' }],
			});

			expect((await messagesIn(t, personal.mailboxId)).map((m) => m._id)).toEqual([sourceId]);
			expect(await messagesIn(t, connected.mailboxId)).toEqual([]);
			expect(await remoteOps(t)).toEqual([]);
		});

		it('leaves the source while a failed upload is retried', async () => {
			const { t, personal, connected, op } = await moveIn();

			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: op._id, outcome: 'failed', error: 'NO [OVERQUOTA]' }],
			});

			expect(await messagesIn(t, personal.mailboxId)).toHaveLength(1);
			expect(await messagesIn(t, connected.mailboxId)).toHaveLength(1);
		});

		it('a copy keeps its source whatever the upload does', async () => {
			const { t, personal, op } = await moveIn('copy');
			expect(op.append?.sourceMessageId).toBeUndefined();

			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: op._id, outcome: 'done' }],
			});

			expect(await messagesIn(t, personal.mailboxId)).toHaveLength(1);
		});

		it('the undo of a move still uploading keeps the original and lets the copy go', async () => {
			const { t, personal, connected, sourceId, result, op } = await moveIn();

			const undone = await t.mutation(api.mail.mailboxTransfer.transfer, {
				messageIds: [result.moved[0]!.messageId],
				targetMailboxId: personal.mailboxId,
				targetFolderId: result.moved[0]!.sourceFolderId,
				mode: 'move',
			});

			expect(undone.moved.map((m) => m.messageId)).toEqual([sourceId]);
			expect(await messagesIn(t, connected.mailboxId)).toEqual([]);
			// The upload may already be in flight: it stays, the copy's delete runs
			// after it, and it no longer takes the original with it.
			expect(await remoteOps(t)).toEqual([
				{ kind: 'append', rfc822MessageId: 'in@x', source: { role: 'inbox' } },
				{ kind: 'delete', rfc822MessageId: 'in@x', source: { role: 'inbox' } },
			]);
			// With the copy gone, the upload reads the original's bytes.
			const original = (await messagesIn(t, personal.mailboxId))[0]!;
			expect(
				await t.query(internal.mail.external.remoteAppend.appendRawSource, { opId: op._id })
			).toBe(original.rawStorageId);

			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: op._id, outcome: 'done' }],
			});
			expect((await messagesIn(t, personal.mailboxId)).map((m) => m._id)).toEqual([sourceId]);
		});

		it('refuses a message whose Message-ID the worker invented', async () => {
			const t = convexTest(schema, modules);
			const { personal } = await setup(t);
			const connected = await connectedMailbox(t);
			const messageId = await seedMessage(t, personal.mailboxId, {
				rfc822MessageId: 'abc123@owlat-mail-sync',
			});

			await expect(
				t.mutation(api.mail.mailboxTransfer.transfer, {
					messageIds: [messageId],
					targetMailboxId: connected.mailboxId,
					mode: 'move',
				})
			).rejects.toThrow(/no Message-ID/);
			expect(await messagesIn(t, connected.mailboxId)).toEqual([]);
		});
	});
});
