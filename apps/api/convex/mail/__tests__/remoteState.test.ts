/**
 * Remote → local change sync (mail/external/remoteState.ts) and the sync-mode
 * switch (mail/external/syncMode.ts).
 *
 * Pinned here:
 *   - once aligned, the provider's moves, deletions and flags are mirrored
 *     locally WITHOUT being queued back to the provider;
 *   - a message with a write-back in flight is left alone;
 *   - before alignment the two sides are merged: inbox mail follows the
 *     provider, mail filed in Owlat is pushed, flags are combined, nothing is
 *     deleted;
 *   - each message records where the provider was last seen holding it, so
 *     a restarted worker can still tell a deletion from mail it never had;
 *   - "new mail only" stops both directions and drops the queue;
 *   - provider folders are mirrored as local folders, and mail lands in them.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type Roles = 'inbox' | 'archive' | 'trash' | 'sent';
const REMOTE: Record<Roles, string> = {
	inbox: 'INBOX',
	archive: 'Archive',
	trash: 'Trash',
	sent: 'Sent',
};

async function fullSyncMailbox(opts: { aligned?: boolean; syncMode?: 'full' | 'incoming' } = {}) {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, { kind: 'external' });
	const folders = {} as Record<Roles, Id<'mailFolders'>>;
	for (const role of Object.keys(REMOTE) as Roles[]) {
		folders[role] = await seedFolder(t, mailboxId, role);
	}
	const accountId = await t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password',
			imapUsername: 'a@owlat.test',
			status: 'connected',
			...(opts.syncMode ? { syncMode: opts.syncMode } : {}),
			...(opts.aligned === false ? {} : { fullSyncAlignedAt: now }),
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: id });
		for (const role of Object.keys(REMOTE) as Roles[]) {
			await ctx.db.insert('externalMailFolderSync', {
				accountId: id,
				mailboxId,
				folderId: folders[role],
				remoteName: REMOTE[role],
				remoteUidValidity: 1,
				lastSeenUid: 0,
				lastSyncedAt: now,
			});
		}
		return id;
	});
	return { t, mailboxId, accountId, folders };
}

async function folderOf(t: TestConvex<typeof schema>, id: Id<'mailMessages'>) {
	return await t.run(async (ctx) => (await ctx.db.get(id))?.folderId ?? null);
}

async function queuedOps(t: TestConvex<typeof schema>) {
	const rows = await t.run(async (ctx) => ctx.db.query('externalMailRemoteOps').collect());
	return rows.map(({ kind, source, target, flags }) => ({
		kind,
		source,
		...(target ? { target } : {}),
		...(flags ? { flags } : {}),
	}));
}

const observe = (
	t: TestConvex<typeof schema>,
	accountId: Id<'externalMailAccounts'>,
	observations: Array<{
		messageId: string;
		remoteFolders?: string[];
		isGone?: boolean;
		flags?: { seen: boolean; flagged: boolean; answered: boolean };
		sightings?: Array<{ remoteName: string; uidValidity: number; uid: number }>;
		forgetSightings?: boolean;
	}>
) =>
	t.mutation(internal.mail.external.remoteState.applyRemoteObservations, {
		accountId,
		observations,
	});

describe('mirroring provider changes once aligned', () => {
	it('moves a message the provider moved, without queueing it back', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await observe(t, accountId, [{ messageId: 'a@x.example', remoteFolders: ['Archive'] }]);

		expect(await folderOf(t, id)).toBe(folders.archive);
		expect(await queuedOps(t)).toEqual([]);
	});

	it('prefers the inbox when the provider files a message in several folders', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'a@x.example',
			role: 'archive',
		});

		await observe(t, accountId, [{ messageId: 'a@x.example', remoteFolders: ['Trash', 'INBOX'] }]);

		expect(await folderOf(t, id)).toBe(folders.inbox);
	});

	it('moves a message deleted on the provider to Trash, and deletes one gone from Trash', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const inInbox = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		const inTrash = await seedMessage(t, mailboxId, {
			rfc822MessageId: 't@x.example',
			role: 'trash',
		});

		await observe(t, accountId, [
			{ messageId: 'a@x.example', isGone: true },
			{ messageId: 't@x.example', isGone: true },
		]);

		expect(await folderOf(t, inInbox)).toBe(folders.trash);
		expect(await folderOf(t, inTrash)).toBeNull();
		expect(await queuedOps(t)).toEqual([]);
	});

	it('never deletes Sent mail the provider does not have', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const sent = await seedMessage(t, mailboxId, { rfc822MessageId: 's@x.example', role: 'sent' });

		await observe(t, accountId, [{ messageId: 's@x.example', isGone: true }]);

		expect(await folderOf(t, sent)).toBe(folders.sent);
	});

	it('takes the provider flags', async () => {
		const { t, mailboxId, accountId } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'a@x.example',
			flagSeen: true,
		});

		await observe(t, accountId, [
			{ messageId: 'a@x.example', flags: { seen: false, flagged: true, answered: false } },
		]);

		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({ flagSeen: false, flagFlagged: true });
		expect(await queuedOps(t)).toEqual([]);
	});

	it('leaves a message alone while its own write-back is in flight', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });

		// The provider has not been told yet, so it still shows the inbox.
		await observe(t, accountId, [{ messageId: 'a@x.example', remoteFolders: ['INBOX'] }]);

		expect(await folderOf(t, id)).toBe(folders.archive);
	});
});

describe('where the provider was seen holding a message (#1071)', () => {
	const sightingOf = async (t: TestConvex<typeof schema>, id: Id<'mailMessages'>) =>
		await t.run(async (ctx) => (await ctx.db.get(id))?.remoteSighting ?? null);
	const seenIn = (t: TestConvex<typeof schema>, id: Id<'mailMessages'>, remoteName: string) =>
		t.run(async (ctx) =>
			ctx.db.patch(id, { remoteSighting: { remoteName, uidValidity: 1, uid: 9 } })
		);

	it('records it at ingest and hands it to the worker', async () => {
		const { t, accountId } = await fullSyncMailbox();
		const blob = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw'])));
		const outcome = await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
			accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 42,
			remoteUidValidity: 3,
			rawStorageId: blob,
			rawSize: 3,
			from: 'someone@example.com',
			to: ['a@owlat.test'],
			cc: [],
			bcc: [],
			subject: 'New',
			messageId: '<n@x.example>',
			receivedAt: Date.now(),
			attachments: [],
			origin: 'sync',
		});
		if (!('messageId' in outcome)) throw new Error('not ingested');

		const sighting = { remoteName: 'INBOX', uidValidity: 3, uid: 42 };
		expect(await sightingOf(t, outcome.messageId)).toEqual(sighting);
		const listed = await t.query(internal.mail.external.remoteState.listLocalMessages, {
			accountId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(listed.page).toEqual([expect.objectContaining({ messageId: 'n@x.example', sighting })]);
	});

	it('records the sighting of the folder each copy sits in', async () => {
		const { t, mailboxId, accountId } = await fullSyncMailbox();
		const inInbox = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		const inSent = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'a@x.example',
			role: 'sent',
		});

		await observe(t, accountId, [
			{
				messageId: 'a@x.example',
				sightings: [
					{ remoteName: 'INBOX', uidValidity: 1, uid: 10 },
					{ remoteName: 'Archive', uidValidity: 1, uid: 20 },
				],
			},
		]);

		expect(await sightingOf(t, inInbox)).toEqual({ remoteName: 'INBOX', uidValidity: 1, uid: 10 });
		expect(await sightingOf(t, inSent)).toBeNull();
	});

	it('records the sighting of the folder a pulled move lands in', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		await seenIn(t, id, 'INBOX');

		await observe(t, accountId, [
			{
				messageId: 'a@x.example',
				remoteFolders: ['Archive'],
				sightings: [{ remoteName: 'Archive', uidValidity: 1, uid: 20 }],
			},
		]);

		expect(await folderOf(t, id)).toBe(folders.archive);
		expect(await sightingOf(t, id)).toEqual({ remoteName: 'Archive', uidValidity: 1, uid: 20 });
	});

	it('drops the sighting of mail it moves to Trash as gone, so it is not called gone again', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		await seenIn(t, id, 'INBOX');

		await observe(t, accountId, [{ messageId: 'a@x.example', isGone: true }]);

		expect(await folderOf(t, id)).toBe(folders.trash);
		expect(await sightingOf(t, id)).toBeNull();
	});

	it('forgets sightings when a merge asks, even with a write-back in flight', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox({ aligned: false });
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		await seenIn(t, id, 'INBOX');
		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });

		await observe(t, accountId, [{ messageId: 'a@x.example', forgetSightings: true }]);

		expect(await sightingOf(t, id)).toBeNull();
		expect(await folderOf(t, id)).toBe(folders.archive);
	});
});

describe('merging on the first full sync', () => {
	it('lets inbox mail follow the provider but pushes mail filed in Owlat', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox({ aligned: false });
		const stillInbox = await seedMessage(t, mailboxId, { rfc822MessageId: 'i@x.example' });
		const filed = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'f@x.example',
			role: 'archive',
		});

		await observe(t, accountId, [
			{ messageId: 'i@x.example', remoteFolders: ['Archive'] },
			{ messageId: 'f@x.example', remoteFolders: ['INBOX'] },
		]);

		expect(await folderOf(t, stillInbox)).toBe(folders.archive);
		expect(await folderOf(t, filed)).toBe(folders.archive);
		expect(await queuedOps(t)).toEqual([
			{ kind: 'move', source: { remote: 'INBOX' }, target: { remote: 'Archive' } },
		]);
	});

	it('combines flags and deletes nothing', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox({ aligned: false });
		const id = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'a@x.example',
			flagSeen: true,
		});
		const gone = await seedMessage(t, mailboxId, { rfc822MessageId: 'g@x.example' });

		await observe(t, accountId, [
			{ messageId: 'a@x.example', flags: { seen: false, flagged: true, answered: false } },
			{ messageId: 'g@x.example', isGone: true },
		]);

		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row).toMatchObject({ flagSeen: true, flagFlagged: true });
		expect(await queuedOps(t)).toEqual([
			{ kind: 'flags', source: { remote: 'INBOX' }, flags: { seen: true } },
		]);
		expect(await folderOf(t, gone)).toBe(folders.inbox);
	});

	it('marks the account aligned', async () => {
		const { t, accountId } = await fullSyncMailbox({ aligned: false });
		await t.mutation(internal.mail.external.remoteState.markFullSyncAligned, { accountId });
		expect(
			await t.query(internal.mail.external.remoteState.getSyncSettings, { accountId })
		).toEqual({ mode: 'full', isAligned: true });
	});
});

describe('new mail only', () => {
	it('writes nothing back and applies nothing from the provider', async () => {
		const { t, mailboxId, accountId, folders } = await fullSyncMailbox({ syncMode: 'incoming' });
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.trash, { messageIds: [id] });
		await observe(t, accountId, [{ messageId: 'a@x.example', remoteFolders: ['Archive'] }]);

		expect(await queuedOps(t)).toEqual([]);
		expect(await folderOf(t, id)).toBe(folders.trash);
	});

	it('is chosen by the member, drops the queue, and starts over with a merge when undone', async () => {
		const { t, mailboxId, accountId } = await fullSyncMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });
		expect(await queuedOps(t)).toHaveLength(1);

		await t.mutation(api.mail.external.syncMode.setSyncMode, { mode: 'incoming' });
		await t.mutation(internal.mail.external.syncMode.discardRemoteOps, { accountId });

		expect(await queuedOps(t)).toEqual([]);
		const view = await t.query(api.mail.external.accounts.getForCurrentUser, {});
		expect(view).toMatchObject({ configured: true, syncMode: 'incoming' });

		await t.mutation(api.mail.external.syncMode.setSyncMode, { mode: 'full' });
		expect(
			await t.query(internal.mail.external.remoteState.getSyncSettings, { accountId })
		).toEqual({ mode: 'full', isAligned: false });
	});
});

describe('mirrored provider folders', () => {
	it('creates the local folder tree and lands mail in it', async () => {
		const { t, mailboxId, accountId } = await fullSyncMailbox();

		await t.mutation(internal.mail.external.delivery.recordFolderMapping, {
			accountId,
			folderPath: ['Projects', 'Owlat'],
			remoteName: 'Projects/Owlat',
			remoteUidValidity: 7,
			initialLastSeenUid: 0,
		});
		// A provider folder called Archive next to the system Archive gets its own name.
		await t.mutation(internal.mail.external.delivery.recordFolderMapping, {
			accountId,
			folderPath: ['Archive'],
			remoteName: 'Labels/Archive',
			remoteUidValidity: 7,
			initialLastSeenUid: 0,
		});

		const folders = await t.run(async (ctx) =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.collect()
		);
		const projects = folders.find((f) => f.name === 'Projects');
		const owlat = folders.find((f) => f.name === 'Owlat');
		expect(owlat?.parentId).toBe(projects?._id);
		expect(folders.find((f) => f.name === 'Archive (2)')?.role).toBeUndefined();

		const blob = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw'])));
		const outcome = await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
			accountId,
			remoteName: 'Projects/Owlat',
			remoteUid: 1,
			remoteUidValidity: 7,
			rawStorageId: blob,
			rawSize: 3,
			from: 'someone@example.com',
			to: ['a@owlat.test'],
			cc: [],
			bcc: [],
			subject: 'Filed on the provider',
			messageId: '<p@x.example>',
			receivedAt: Date.now(),
			attachments: [],
			origin: 'sync',
		});
		expect('messageId' in outcome).toBe(true);
		if (!('messageId' in outcome)) return;
		expect(await folderOf(t, outcome.messageId)).toBe(owlat?._id);
	});

	it('names a mirrored folder by its remote name when writing back', async () => {
		const { t, mailboxId, accountId } = await fullSyncMailbox();
		await t.mutation(internal.mail.external.delivery.recordFolderMapping, {
			accountId,
			folderPath: ['Receipts'],
			remoteName: 'INBOX.Receipts',
			remoteUidValidity: 7,
			initialLastSeenUid: 0,
		});
		const receipts = await t.run(async (ctx) =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_name', (q) =>
					q.eq('mailboxId', mailboxId).eq('name', 'Receipts')
				)
				.first()
		);
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.move, {
			messageIds: [id],
			targetFolderId: receipts!._id,
		});

		expect(await queuedOps(t)).toEqual([
			{ kind: 'move', source: { remote: 'INBOX' }, target: { remote: 'INBOX.Receipts' } },
		]);
	});
});

describe('mirrored folders renamed or deleted', () => {
	async function withReceipts(opts: { syncMode?: 'full' | 'incoming' } = {}) {
		const fixture = await fullSyncMailbox(opts);
		await fixture.t.mutation(internal.mail.external.delivery.recordFolderMapping, {
			accountId: fixture.accountId,
			folderPath: ['Receipts'],
			remoteName: 'INBOX.Receipts',
			remoteUidValidity: 7,
			initialLastSeenUid: 0,
		});
		const receipts = await fixture.t.run(async (ctx) =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_name', (q) =>
					q.eq('mailboxId', fixture.mailboxId).eq('name', 'Receipts')
				)
				.first()
		);
		return { ...fixture, receiptsId: receipts!._id };
	}

	it('renames the provider folder when the Owlat folder is renamed', async () => {
		const { t, receiptsId } = await withReceipts();

		await t.mutation(api.mail.folders.rename, { folderId: receiptsId, name: 'Bills' });

		expect(await queuedOps(t)).toEqual([
			{ kind: 'renameFolder', source: { remote: 'INBOX.Receipts' }, target: { path: ['Bills'] } },
		]);
	});

	it('deletes the provider folder after the moves its mail made on the way out', async () => {
		const { t, mailboxId, folders, receiptsId } = await withReceipts();
		await t.mutation(api.mail.messageActions.move, {
			messageIds: [await seedMessage(t, mailboxId, { rfc822MessageId: 'r@x.example' })],
			targetFolderId: receiptsId,
		});
		await t.run(async (ctx) => {
			for (const op of await ctx.db.query('externalMailRemoteOps').collect()) {
				await ctx.db.delete(op._id);
			}
		});

		await t.mutation(internal.mail.folders.relocateAndDeleteFolder, {
			folderId: receiptsId,
			inboxId: folders.inbox,
		});

		expect(await queuedOps(t)).toEqual([
			{ kind: 'move', source: { remote: 'INBOX.Receipts' }, target: { remote: 'INBOX' } },
			{ kind: 'deleteFolder', source: { remote: 'INBOX.Receipts' } },
		]);
	});

	it('tells the provider nothing about a folder it never had, or in new-mail-only mode', async () => {
		const { t, mailboxId, receiptsId } = await withReceipts({ syncMode: 'incoming' });
		await t.mutation(api.mail.folders.rename, { folderId: receiptsId, name: 'Bills' });
		const localOnly = await t.mutation(api.mail.folders.create, { mailboxId, name: 'Scratch' });
		await t.mutation(api.mail.folders.rename, { folderId: localOnly, name: 'Notes' });

		expect(await queuedOps(t)).toEqual([]);
	});

	it('removes the empty local copy of a folder the provider no longer has', async () => {
		const { t, accountId, receiptsId } = await withReceipts();

		await t.mutation(internal.mail.external.remoteState.forgetRemoteFolders, {
			accountId,
			listed: Object.values(REMOTE),
		});

		expect(await t.run(async (ctx) => ctx.db.get(receiptsId))).toBeNull();
		const mappings = await t.run(async (ctx) =>
			ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_folder', (q) => q.eq('folderId', receiptsId))
				.collect()
		);
		expect(mappings).toEqual([]);
	});

	it('keeps a vanished folder that still holds mail', async () => {
		const { t, mailboxId, accountId, receiptsId } = await withReceipts();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'r@x.example' });
		await t.run(async (ctx) => ctx.db.patch(id, { folderId: receiptsId }));

		await t.mutation(internal.mail.external.remoteState.forgetRemoteFolders, {
			accountId,
			listed: Object.values(REMOTE),
		});

		expect(await t.run(async (ctx) => ctx.db.get(receiptsId))).not.toBeNull();
	});

	// Gmail's Important view ("[Gmail]/Wichtig") was mirrored as a folder by
	// workers that read `specialUse` only. The provider still lists it, so it is
	// not "gone"; the worker names it retired. Dropping its mapping while it held
	// mail would leave that mail with no remote name, never reconciled again.
	it('keeps a retired folder mapped while it holds mail, then drops it once empty', async () => {
		const { t, mailboxId, accountId, receiptsId } = await withReceipts();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'r@x.example' });
		await t.run(async (ctx) => ctx.db.patch(id, { folderId: receiptsId }));
		const mappings = async () =>
			await t.run(async (ctx) =>
				ctx.db
					.query('externalMailFolderSync')
					.withIndex('by_folder', (q) => q.eq('folderId', receiptsId))
					.collect()
			);
		const listed = [...Object.values(REMOTE), 'INBOX.Receipts'];

		await t.mutation(internal.mail.external.remoteState.forgetRemoteFolders, {
			accountId,
			listed,
			retired: ['INBOX.Receipts'],
		});
		expect(await mappings()).toHaveLength(1);
		expect(await t.run(async (ctx) => ctx.db.get(receiptsId))).not.toBeNull();

		// Reconcile moved the message to where it lives on the provider.
		const inbox = await t.run(
			async (ctx) =>
				(await ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
					.collect())!.find((f) => f.role === 'inbox')!._id
		);
		await t.run(async (ctx) => ctx.db.patch(id, { folderId: inbox }));

		await t.mutation(internal.mail.external.remoteState.forgetRemoteFolders, {
			accountId,
			listed,
			retired: ['INBOX.Receipts'],
		});
		expect(await mappings()).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.get(receiptsId))).toBeNull();
	});

	it('keeps a folder the provider renamed, which its new name still maps to', async () => {
		const { t, accountId, receiptsId } = await withReceipts();
		await t.mutation(internal.mail.external.delivery.recordFolderMapping, {
			accountId,
			folderPath: ['Receipts'],
			remoteName: 'INBOX.Bills',
			remoteUidValidity: 8,
			initialLastSeenUid: 0,
		});

		await t.mutation(internal.mail.external.remoteState.forgetRemoteFolders, {
			accountId,
			listed: [...Object.values(REMOTE), 'INBOX.Bills'],
		});

		expect(await t.run(async (ctx) => ctx.db.get(receiptsId))).not.toBeNull();
		const names = await t.run(async (ctx) =>
			(
				await ctx.db
					.query('externalMailFolderSync')
					.withIndex('by_folder', (q) => q.eq('folderId', receiptsId))
					.collect()
			).map((r) => r.remoteName)
		);
		expect(names).toEqual(['INBOX.Bills']);
	});
});
