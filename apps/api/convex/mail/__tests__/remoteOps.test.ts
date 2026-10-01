/**
 * Local → remote write-back queue (mail/external/remoteOps.ts).
 *
 * What a member does to an external mailbox in Owlat has to reach the provider.
 * Pinned here:
 *   - each triage path records exactly the change it made — a move names both
 *     folders, a flag write only the flags that actually changed, "Delete
 *     forever" the folder it deleted from;
 *   - a user folder is named by its chain of local names;
 *   - nothing is recorded where there is no provider to tell: hosted mailboxes,
 *     disconnected accounts, messages without a real Message-ID;
 *   - an IMAP client's COPY + EXPUNGE reaches the provider as a move, never as a
 *     delete of mail the member still has;
 *   - the worker's settle retires or backs off each op;
 *   - a folder the worker renamed is known by its new name from then on: its
 *     mapping and the ops still naming the old name follow it, so a worker
 *     restart forgets nothing.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { MAX_REMOTE_OP_ATTEMPTS } from '../external/remoteOps';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	// The auth floor hands this session to the mailbox gate (plan 1.13), so it
	// carries the active organization the gate scopes by.
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type Fixture = {
	t: TestConvex<typeof schema>;
	mailboxId: Id<'mailboxes'>;
	accountId: Id<'externalMailAccounts'>;
	folders: Record<'inbox' | 'archive' | 'trash', Id<'mailFolders'>>;
};

async function externalMailbox(
	status: 'connected' | 'disconnected' = 'connected'
): Promise<Fixture> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, { kind: 'external' });
	const folders = {
		inbox: await seedFolder(t, mailboxId, 'inbox'),
		archive: await seedFolder(t, mailboxId, 'archive'),
		trash: await seedFolder(t, mailboxId, 'trash'),
	};
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
			status,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: id });
		return id;
	});
	return { t, mailboxId, accountId, folders };
}

async function queued(t: TestConvex<typeof schema>) {
	const rows = await t.run(async (ctx) => ctx.db.query('externalMailRemoteOps').collect());
	return rows.map(({ kind, rfc822MessageId, source, target, flags }) => ({
		kind,
		rfc822MessageId,
		source,
		...(target ? { target } : {}),
		...(flags ? { flags } : {}),
	}));
}

async function userFolder(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	name: string,
	parentId?: Id<'mailFolders'>
): Promise<Id<'mailFolders'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('mailFolders', {
			mailboxId,
			name,
			parentId,
			uidNext: 1,
			uidValidity: now,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('recording local changes on an external mailbox', () => {
	it('records an archive as a move between the two system folders', async () => {
		const { t, mailboxId } = await externalMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });

		expect(await queued(t)).toEqual([
			{
				kind: 'move',
				rfc822MessageId: 'a@x.example',
				source: { role: 'inbox' },
				target: { role: 'archive' },
			},
		]);
	});

	it('names a user folder by its chain of local names', async () => {
		const { t, mailboxId } = await externalMailbox();
		const projects = await userFolder(t, mailboxId, 'Projects');
		const owlat = await userFolder(t, mailboxId, 'Owlat', projects);
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.move, { messageIds: [id], targetFolderId: owlat });

		expect(await queued(t)).toEqual([
			{
				kind: 'move',
				rfc822MessageId: 'a@x.example',
				source: { role: 'inbox' },
				target: { path: ['Projects', 'Owlat'] },
			},
		]);
	});

	it('records only the flags a write actually changed', async () => {
		const { t, mailboxId } = await externalMailbox();
		const unread = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		const read = await seedMessage(t, mailboxId, {
			rfc822MessageId: 'b@x.example',
			flagSeen: true,
		});

		await t.mutation(api.mail.messageActions.setFlags, {
			messageIds: [unread, read],
			seen: true,
			flagged: false,
		});

		// `read` was already seen and neither was flagged: nothing to tell the provider about it.
		expect(await queued(t)).toEqual([
			{
				kind: 'flags',
				rfc822MessageId: 'a@x.example',
				source: { role: 'inbox' },
				flags: { seen: true },
			},
		]);
	});

	it('records "Delete forever" as a delete from the folder it left', async () => {
		const { t, mailboxId } = await externalMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example', role: 'trash' });

		await t.mutation(api.mail.messageActions.purge, { messageIds: [id] });

		expect(await queued(t)).toEqual([
			{ kind: 'delete', rfc822MessageId: 'a@x.example', source: { role: 'trash' } },
		]);
	});

	it('turns an IMAP COPY + EXPUNGE into a move, never a delete', async () => {
		const { t, mailboxId, folders } = await externalMailbox();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		// A client without MOVE: copy to Archive, flag the original, expunge the inbox.
		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: folders.inbox,
			targetFolderId: folders.archive,
			messageIds: [id],
		});
		await t.mutation(internal.mail.imap.flags.storeFlags, {
			messageIds: [id],
			flags: ['\\Deleted'],
			mode: 'add',
		});
		await t.mutation(internal.mail.imap.move.expungeFolder, { folderId: folders.inbox });

		expect(await queued(t)).toEqual([
			{
				kind: 'move',
				rfc822MessageId: 'a@x.example',
				source: { role: 'inbox' },
				target: { role: 'archive' },
			},
		]);
	});

	it('nudges the worker once per mutation, not once per message', async () => {
		const { t, mailboxId } = await externalMailbox();
		const a = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		const b = await seedMessage(t, mailboxId, { rfc822MessageId: 'b@x.example' });

		await t.mutation(api.mail.messageActions.trash, { messageIds: [a, b] });

		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled.filter((s) => s.name.includes('remoteOps:notifyWorker'))).toHaveLength(1);
		expect(await queued(t)).toHaveLength(2);
	});
});

describe('nothing to tell', () => {
	it('records nothing for a hosted mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		await seedFolder(t, mailboxId, 'archive');
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });

		expect(await queued(t)).toEqual([]);
	});

	it('records nothing once the account is disconnected', async () => {
		const { t, mailboxId } = await externalMailbox('disconnected');
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });

		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });

		expect(await queued(t)).toEqual([]);
	});

	it('records nothing for a message the worker gave an invented Message-ID', async () => {
		const { t, mailboxId } = await externalMailbox();
		const id = await seedMessage(t, mailboxId, {
			rfc822MessageId: '1700000000.42.INBOX@owlat-mail-sync',
		});

		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });

		expect(await queued(t)).toEqual([]);
	});
});

describe('the worker surface', () => {
	async function oneQueuedOp() {
		const fixture = await externalMailbox();
		const id = await seedMessage(fixture.t, fixture.mailboxId, { rfc822MessageId: 'a@x.example' });
		await fixture.t.mutation(api.mail.messageActions.archive, { messageIds: [id] });
		const [op] = await fixture.t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId: fixture.accountId,
		});
		if (!op) throw new Error('expected a queued op');
		return { ...fixture, op };
	}

	it('retires an applied op', async () => {
		const { t, op } = await oneQueuedOp();

		await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
			results: [{ opId: op.opId, outcome: 'done' }],
		});

		expect(await queued(t)).toEqual([]);
	});

	it('backs a failed op off so the next read skips it', async () => {
		const { t, accountId, op } = await oneQueuedOp();

		await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
			results: [{ opId: op.opId, outcome: 'failed', error: 'NO [OVERQUOTA]' }],
		});

		const row = await t.run(async (ctx) => ctx.db.get(op.opId));
		expect(row).toMatchObject({ attempts: 1, lastError: 'NO [OVERQUOTA]' });
		expect(await t.query(internal.mail.external.remoteOps.listDueRemoteOps, { accountId })).toEqual(
			[]
		);
	});

	it('drops an op whose attempts are spent', async () => {
		const { t, op } = await oneQueuedOp();
		await t.run(async (ctx) => ctx.db.patch(op.opId, { attempts: MAX_REMOTE_OP_ATTEMPTS - 1 }));

		await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
			results: [{ opId: op.opId, outcome: 'failed', error: 'still failing' }],
		});

		expect(await queued(t)).toEqual([]);
	});
});

describe('a folder the worker renamed', () => {
	async function mirroredFolders() {
		const fixture = await externalMailbox();
		const { t, mailboxId, accountId } = fixture;
		const projects = await userFolder(t, mailboxId, 'Projects');
		const owlat = await userFolder(t, mailboxId, 'Owlat', projects);
		const sub = await userFolder(t, mailboxId, 'Sub', owlat);
		const other = await userFolder(t, mailboxId, 'Owlat.old', projects);
		await t.run(async (ctx) => {
			for (const [folderId, remoteName] of [
				[projects, 'Projects'],
				[owlat, 'Projects/Owlat'],
				[sub, 'Projects/Owlat/Sub'],
				// '/' is this provider's delimiter: a sibling that only starts with the name.
				[other, 'Projects/Owlat.old'],
			] as const) {
				await ctx.db.insert('externalMailFolderSync', {
					accountId,
					mailboxId,
					folderId,
					remoteName,
					remoteUidValidity: 1,
					lastSeenUid: 0,
					lastSyncedAt: Date.now(),
				});
			}
		});
		return { ...fixture, owlat, sub };
	}

	async function mappedNames(t: TestConvex<typeof schema>) {
		const rows = await t.run(async (ctx) => ctx.db.query('externalMailFolderSync').collect());
		return rows.map((r) => r.remoteName).sort();
	}

	/** The worker's side: list the rename, run it, report the new name, settle. */
	async function renameAtProvider(
		t: TestConvex<typeof schema>,
		accountId: Id<'externalMailAccounts'>,
		between: () => Promise<void> = async () => {}
	) {
		const [rename] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId,
		});
		if (rename?.kind !== 'renameFolder') throw new Error('expected the rename to be due');
		// Changes the member makes while the worker is renaming still name the old folder.
		await between();
		await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
			opId: rename.opId,
			remoteName: 'Projects/Clients',
			delimiter: '/',
		});
		await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
			results: [{ opId: rename.opId, outcome: 'done' }],
		});
	}

	it('points the mapping of the folder, and of the folders below it, at the new name', async () => {
		const { t, accountId, owlat } = await mirroredFolders();
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });

		await renameAtProvider(t, accountId);

		expect(await mappedNames(t)).toEqual([
			'Projects',
			'Projects/Clients',
			'Projects/Clients/Sub',
			'Projects/Owlat.old',
		]);
	});

	it('rewrites the ops queued meanwhile, and names the folder by its new name from then on', async () => {
		const { t, mailboxId, accountId, owlat, sub } = await mirroredFolders();
		const a = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		const b = await seedMessage(t, mailboxId, { rfc822MessageId: 'b@x.example' });
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });

		await renameAtProvider(t, accountId, async () => {
			await t.mutation(api.mail.messageActions.move, { messageIds: [a], targetFolderId: owlat });
			await t.mutation(api.mail.messageActions.move, { messageIds: [b], targetFolderId: sub });
		});
		// Recorded after the backend learned the new name.
		await t.mutation(api.mail.messageActions.setFlags, { messageIds: [a], seen: true });

		expect(await queued(t)).toEqual([
			{
				kind: 'move',
				rfc822MessageId: 'a@x.example',
				source: { role: 'inbox' },
				target: { remote: 'Projects/Clients' },
			},
			{
				kind: 'move',
				rfc822MessageId: 'b@x.example',
				source: { role: 'inbox' },
				target: { remote: 'Projects/Clients/Sub' },
			},
			{
				kind: 'flags',
				rfc822MessageId: 'a@x.example',
				source: { remote: 'Projects/Clients' },
				flags: { seen: true },
			},
		]);
	});

	it('drops a stale mapping that already held the new name', async () => {
		const { t, mailboxId, accountId, owlat } = await mirroredFolders();
		const gone = await userFolder(t, mailboxId, 'Gone');
		await t.run(async (ctx) => {
			await ctx.db.insert('externalMailFolderSync', {
				accountId,
				mailboxId,
				folderId: gone,
				remoteName: 'Projects/Clients',
				remoteUidValidity: 1,
				lastSeenUid: 0,
				lastSyncedAt: Date.now(),
			});
		});
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });

		await renameAtProvider(t, accountId);

		const rows = await t.run(async (ctx) => ctx.db.query('externalMailFolderSync').collect());
		expect(rows.filter((r) => r.remoteName === 'Projects/Clients').map((r) => r.folderId)).toEqual([
			owlat,
		]);
	});

	/** Queue an op as the backend would, naming folders by remote name. */
	async function enqueue(
		t: TestConvex<typeof schema>,
		accountId: Id<'externalMailAccounts'>,
		fields: { kind: 'flags' | 'deleteFolder'; source: { remote: string }; rfc822MessageId?: string }
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert('externalMailRemoteOps', {
				accountId,
				...fields,
				...(fields.kind === 'flags' ? { flags: { seen: true } } : {}),
				attempts: 0,
				nextAttemptAt: Date.now(),
				createdAt: Date.now(),
			});
		});
	}

	it('records a report sent again as nothing new', async () => {
		const { t, accountId, owlat } = await mirroredFolders();
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });
		const [rename] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId,
		});
		const report = {
			opId: rename!.opId,
			remoteName: 'Projects/Clients',
			delimiter: '/',
		};

		await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, report);
		// The answer was lost, so the worker reports again.
		await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, report);

		expect(await mappedNames(t)).toEqual([
			'Projects',
			'Projects/Clients',
			'Projects/Clients/Sub',
			'Projects/Owlat.old',
		]);
		expect(await queued(t)).toEqual([
			{
				kind: 'renameFolder',
				source: { remote: 'Projects/Clients' },
				target: { path: ['Clients'] },
			},
		]);
	});

	it('keeps a rename whose report failed queued, ahead of the ops for the old name, until a later report', async () => {
		const { t, accountId, owlat } = await mirroredFolders();
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });
		const [rename] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId,
		});
		// RENAME went through at the provider, but the report did not reach the backend.
		await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
			results: [{ opId: rename!.opId, outcome: 'failed', error: 'fetch failed' }],
		});
		// Recorded meanwhile, still by the old name.
		await enqueue(t, accountId, { kind: 'deleteFolder', source: { remote: 'Projects/Owlat' } });
		await enqueue(t, accountId, {
			kind: 'flags',
			rfc822MessageId: 'a@x.example',
			source: { remote: 'Projects/Owlat/Sub' },
		});

		// The folder delete waits for the rename; it is not settled against a name the provider dropped.
		const due = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, { accountId });
		expect(due.map((o) => o.kind)).not.toContain('deleteFolder');
		// A restarted worker finds the rename still queued, and reports it.
		const renames = await t.query(
			internal.mail.external.remoteFolderRename.listQueuedFolderRenames,
			{ accountId }
		);
		expect(renames.map((o) => [o.opId, o.source])).toEqual([
			[rename!.opId, { remote: 'Projects/Owlat' }],
		]);
		await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
			opId: rename!.opId,
			remoteName: 'Projects/Clients',
			delimiter: '/',
		});

		expect(await queued(t)).toEqual([
			{
				kind: 'renameFolder',
				source: { remote: 'Projects/Clients' },
				target: { path: ['Clients'] },
			},
			{ kind: 'deleteFolder', source: { remote: 'Projects/Clients' } },
			{
				kind: 'flags',
				rfc822MessageId: 'a@x.example',
				source: { remote: 'Projects/Clients/Sub' },
				flags: { seen: true },
			},
		]);
	});

	it('rewrites more queued ops than one transaction holds', async () => {
		const { t, accountId, owlat } = await mirroredFolders();
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });
		const [rename] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId,
		});
		await t.run(async (ctx) => {
			for (let i = 0; i < 1005; i++) {
				await ctx.db.insert('externalMailRemoteOps', {
					accountId,
					kind: 'flags',
					rfc822MessageId: `m${i}@x.example`,
					source: { remote: 'Projects/Owlat' },
					flags: { seen: true },
					attempts: 0,
					nextAttemptAt: Date.now(),
					createdAt: Date.now(),
				});
			}
		});

		vi.useFakeTimers({ now: Date.now() });
		try {
			await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
				opId: rename!.opId,
				remoteName: 'Projects/Clients',
				delimiter: '/',
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		const names = new Set(
			(await queued(t)).map((o) => ('remote' in o.source ? o.source.remote : ''))
		);
		expect([...names]).toEqual(['Projects/Clients']);
	});

	it('ignores a report for an op that is not a folder rename', async () => {
		const { t, mailboxId, accountId } = await mirroredFolders();
		const id = await seedMessage(t, mailboxId, { rfc822MessageId: 'a@x.example' });
		await t.mutation(api.mail.messageActions.archive, { messageIds: [id] });
		const [op] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, { accountId });

		await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
			opId: op!.opId,
			remoteName: 'Projects/Clients',
			delimiter: '/',
		});

		expect(await mappedNames(t)).toContain('Projects/Owlat');
	});

	/** Queue `count` message ops naming the folder by its old name, as recorded while the worker renames it. */
	async function queueForOldName(
		t: TestConvex<typeof schema>,
		accountId: Id<'externalMailAccounts'>,
		kind: 'delete' | 'flags',
		count: number
	) {
		await t.run(async (ctx) => {
			for (let i = 0; i < count; i++) {
				await ctx.db.insert('externalMailRemoteOps', {
					accountId,
					kind,
					rfc822MessageId: `${kind}-${i}@x.example`,
					source: { remote: 'Projects/Owlat' },
					...(kind === 'flags' ? { flags: { seen: true } } : {}),
					attempts: 0,
					nextAttemptAt: Date.now(),
					createdAt: Date.now(),
				});
			}
		});
	}

	/**
	 * The worker's side after a restart: it has forgotten the renames it made,
	 * so it addresses each op by the name the backend hands it. An op for a
	 * folder the provider does not have is not found, as the replayer settles
	 * it (apps/mail-sync/src/remoteOps.ts); a rename moves the folder and the
	 * folders below it, and is reported before it is settled.
	 */
	async function drainQueue(
		t: TestConvex<typeof schema>,
		accountId: Id<'externalMailAccounts'>,
		provider: Set<string>
	) {
		const replayed: Array<{ kind: string; source: string; outcome: 'done' | 'not_found' }> = [];
		for (;;) {
			const due = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, { accountId });
			if (due.length === 0) return replayed;
			const results: Array<{ opId: Id<'externalMailRemoteOps'>; outcome: 'done' | 'not_found' }> =
				[];
			for (const op of due) {
				const source = 'remote' in op.source ? op.source.remote : '';
				const outcome = provider.has(source) ? 'done' : 'not_found';
				const name = op.target && 'path' in op.target ? op.target.path[0] : undefined;
				if (op.kind === 'renameFolder' && outcome === 'done' && name) {
					const to = [...source.split('/').slice(0, -1), name].join('/');
					for (const folder of Array.from(provider)) {
						if (folder !== source && !folder.startsWith(`${source}/`)) continue;
						provider.delete(folder);
						provider.add(to + folder.slice(source.length));
					}
					await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
						opId: op.opId,
						remoteName: to,
						delimiter: '/',
					});
				}
				replayed.push({ kind: op.kind, source, outcome });
				results.push({ opId: op.opId, outcome });
			}
			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, { results });
		}
	}

	it('keeps the ops a rename has yet to rewrite from a restarted worker until the rewrite is done', async () => {
		const { t, accountId, owlat } = await mirroredFolders();
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });
		const [rename] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId,
		});
		// Recorded while the worker renames: five deletes, then more flag changes
		// than one rewrite transaction reaches, so the deletes are left for its continuation.
		await queueForOldName(t, accountId, 'delete', 5);
		await queueForOldName(t, accountId, 'flags', 1000);
		// A folder off the renamed branch, whose name only starts with the old one.
		await enqueue(t, accountId, {
			kind: 'flags',
			rfc822MessageId: 'sibling@x.example',
			source: { remote: 'Projects/Owlat.old' },
		});
		const provider = new Set([
			'Projects',
			'Projects/Clients',
			'Projects/Clients/Sub',
			'Projects/Owlat.old',
		]);

		vi.useFakeTimers({ now: Date.now() });
		try {
			await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
				opId: rename!.opId,
				remoteName: 'Projects/Clients',
				delimiter: '/',
			});
			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: rename!.opId, outcome: 'done' }],
			});
			// The worker restarts before the continuation runs. The rename is
			// recorded, so there is nothing for it to report again.
			expect(
				await t.query(internal.mail.external.remoteFolderRename.listQueuedFolderRenames, {
					accountId,
				})
			).toEqual([]);
			const beforeRewrite = await drainQueue(t, accountId, provider);
			expect(beforeRewrite.filter((op) => op.kind === 'delete')).toEqual([]);
			expect(beforeRewrite.filter((op) => op.outcome !== 'done')).toEqual([]);
			// Only the ops the rewrite has yet to reach wait.
			expect(beforeRewrite.map((op) => op.source)).toContain('Projects/Owlat.old');

			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		expect(await drainQueue(t, accountId, provider)).toEqual(
			Array.from({ length: 5 }, () => ({
				kind: 'delete',
				source: 'Projects/Clients',
				outcome: 'done',
			}))
		);
		expect(await queued(t)).toEqual([]);
	});

	it('runs a second rename of the folder only once the first one has rewritten every op', async () => {
		const { t, accountId, owlat } = await mirroredFolders();
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Clients' });
		const [rename] = await t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
			accountId,
		});
		// While the worker renames it, the member renames the folder again, and
		// changes are still recorded by the old name.
		await t.mutation(api.mail.folders.rename, { folderId: owlat, name: 'Partners' });
		await queueForOldName(t, accountId, 'delete', 5);
		await queueForOldName(t, accountId, 'flags', 1000);
		const provider = new Set([
			'Projects',
			'Projects/Clients',
			'Projects/Clients/Sub',
			'Projects/Owlat.old',
		]);

		vi.useFakeTimers({ now: Date.now() });
		try {
			await t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
				opId: rename!.opId,
				remoteName: 'Projects/Clients',
				delimiter: '/',
			});
			await t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [{ opId: rename!.opId, outcome: 'done' }],
			});
			const beforeRewrite = await drainQueue(t, accountId, provider);
			expect(beforeRewrite.map((op) => op.kind)).not.toContain('renameFolder');
			expect(provider).toContain('Projects/Clients');

			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		const afterRewrite = await drainQueue(t, accountId, provider);
		expect(afterRewrite.filter((op) => op.outcome !== 'done')).toEqual([]);
		expect(afterRewrite.filter((op) => op.kind === 'delete')).toHaveLength(5);
		expect(afterRewrite[afterRewrite.length - 1]).toEqual({
			kind: 'renameFolder',
			source: 'Projects/Clients',
			outcome: 'done',
		});
		expect([...provider].sort()).toEqual([
			'Projects',
			'Projects/Owlat.old',
			'Projects/Partners',
			'Projects/Partners/Sub',
		]);
		expect(await mappedNames(t)).toEqual([...provider].sort());
		expect(await queued(t)).toEqual([]);
	});
});
