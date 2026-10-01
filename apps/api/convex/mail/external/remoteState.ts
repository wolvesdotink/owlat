/**
 * Remote → local change sync for connected external (IMAP) mailboxes.
 *
 * New mail has always come in through `delivery.ts`. With full sync
 * (`externalMailAccounts.syncMode`, the default) the mail-sync worker also
 * watches what happens to mail that is already here: it keeps a per-folder view
 * of the provider (UIDs, Message-IDs, flags), and whenever a message sits
 * somewhere other than where Owlat has it, or carries other flags, it reports an
 * observation. `applyRemoteObservations` turns those into local moves, flag
 * changes and deletions — without recording them for write-back, which would
 * echo them straight back to the provider.
 *
 * A deletion is only ever inferred for mail the provider was seen holding:
 * each local message records its `remoteSighting` (folder, UIDVALIDITY, UID),
 * at ingest and from the worker's `sightings`. The worker's views are lost on
 * a restart; the sightings are not, so a message deleted on the provider while
 * the worker was down is still found missing from the folder it was seen in.
 *
 * Owlat → provider is `remoteOps.ts`. The two meet in two places:
 *   - a message with a write-back still queued is skipped: Owlat's own change is
 *     in flight, and the provider will match once the worker applies it;
 *   - the first reconcile after full sync is switched on (and after the upgrade
 *     that introduced it) MERGES instead of pulling. Before then, changes on
 *     either side never reached the other, so neither is simply right: mail
 *     Owlat still has in the inbox follows the provider (it was triaged there),
 *     mail filed in Owlat is pushed to the provider, and flags are combined —
 *     read, starred or answered on either side is read, starred or answered on
 *     both. Nothing is deleted on either side by the merge.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { Doc, Id } from '../../_generated/dataModel';
import { paginationOptsValidator } from 'convex/server';
import { remoteSightingValidator } from '../../lib/validators/mail';
import { moveMessagesToFolder } from '../messageActions';
import { applyFlagDelta } from '../flagWrites';
import { purgeMessageRow } from '../messagePurge';
import { dropFolderMembership } from '../folderMembership';
import { rebuildThreadAggregates } from '../threadAggregates';
import {
	enqueueRemoteOp,
	nudgeWorker,
	remoteNamesByFolder,
	writesBack,
	type RemoteFlagChanges,
} from './remoteOps';

/** Worker-invented Message-IDs (`apps/mail-sync/src/ingest.ts`) cannot be matched remotely. */
const SYNTHETIC_MESSAGE_ID_SUFFIX = '@owlat-mail-sync';
/** Local rows kept per Message-ID; more than one is an IMAP COPY. */
const ROWS_PER_MESSAGE_ID = 10;

const FLAG_KEYS = ['seen', 'flagged', 'answered'] as const;
const FLAG_COLUMNS = {
	seen: 'flagSeen',
	flagged: 'flagFlagged',
	answered: 'flagAnswered',
} as const;

const flagStateValidator = v.object({
	seen: v.boolean(),
	flagged: v.boolean(),
	answered: v.boolean(),
});

type RemoteSighting = NonNullable<Doc<'mailMessages'>['remoteSighting']>;

/** What the worker needs per local message to compare it with the provider. */
type LocalRow = {
	messageId: string;
	remoteName: string | null;
	role: Doc<'mailFolders'>['role'] | null;
	flags: { seen: boolean; flagged: boolean; answered: boolean };
	sighting: RemoteSighting | null;
};

async function toLocalRows(
	ctx: QueryCtx,
	messages: ReadonlyArray<Doc<'mailMessages'>>,
	remoteByFolder: Map<Id<'mailFolders'>, string>
): Promise<LocalRow[]> {
	const roles = new Map<Id<'mailFolders'>, Doc<'mailFolders'>['role'] | null>();
	const rows: LocalRow[] = [];
	for (const m of messages) {
		if (m.rfc822MessageId.endsWith(SYNTHETIC_MESSAGE_ID_SUFFIX)) continue;
		if (!roles.has(m.folderId)) roles.set(m.folderId, (await ctx.db.get(m.folderId))?.role ?? null);
		rows.push({
			messageId: m.rfc822MessageId,
			remoteName: remoteByFolder.get(m.folderId) ?? null,
			role: roles.get(m.folderId) ?? null,
			flags: { seen: m.flagSeen, flagged: m.flagFlagged, answered: m.flagAnswered },
			sighting: m.remoteSighting ?? null,
		});
	}
	return rows;
}

function sameSighting(a: RemoteSighting, b: RemoteSighting | undefined): boolean {
	return a.remoteName === b?.remoteName && a.uidValidity === b.uidValidity && a.uid === b.uid;
}

async function liveFullSyncAccount(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>
): Promise<Doc<'externalMailAccounts'> | null> {
	const account = await ctx.db.get(accountId);
	if (!account || account.status === 'disconnected' || !writesBack(account)) return null;
	return account;
}

/** The account's sync mode, read by the worker every cycle so a switch applies at once. */
export const getSyncSettings = internalQuery({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		return {
			mode: account?.syncMode ?? 'full',
			isAligned: account?.fullSyncAlignedAt !== undefined,
		};
	},
});

/** One page of the mailbox's messages as the worker compares them — the full reconcile. */
export const listLocalMessages = internalQuery({
	args: { accountId: v.id('externalMailAccounts'), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		const account = await liveFullSyncAccount(ctx, args.accountId);
		if (!account) return { page: [], isDone: true, continueCursor: '' };
		const result = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', account.mailboxId))
			.paginate(args.paginationOpts);
		const remoteByFolder = await remoteNamesByFolder(ctx, account._id);
		return {
			page: await toLocalRows(ctx, result.page, remoteByFolder),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

async function rowsForMessageId(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	messageId: string
): Promise<Doc<'mailMessages'>[]> {
	// The same Message-ID sits in every mailbox a message reached (a newsletter
	// to the whole team), so walk the index rather than taking a first page that
	// may hold only other mailboxes' copies.
	const rows: Doc<'mailMessages'>[] = [];
	for await (const row of ctx.db
		.query('mailMessages')
		.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', messageId))) {
		if (row.mailboxId !== mailboxId) continue;
		rows.push(row);
		if (rows.length >= ROWS_PER_MESSAGE_ID) break;
	}
	return rows;
}

/** The local rows behind the Message-IDs that changed on the provider since the last cycle. */
export const lookupLocalMessages = internalQuery({
	args: { accountId: v.id('externalMailAccounts'), messageIds: v.array(v.string()) },
	handler: async (ctx, args) => {
		const account = await liveFullSyncAccount(ctx, args.accountId);
		if (!account) return [];
		const messages: Doc<'mailMessages'>[] = [];
		for (const id of args.messageIds) {
			messages.push(...(await rowsForMessageId(ctx, account.mailboxId, id)));
		}
		return await toLocalRows(ctx, messages, await remoteNamesByFolder(ctx, account._id));
	},
});

/**
 * Bring local messages in line with what the worker saw on the provider.
 *
 *   - `remoteFolders`: the synced remote folders now holding the message, best
 *     first. When the local folder is not among them, the message moves to the
 *     first one that has a local folder (the inbox wins).
 *   - `isGone`: the message left the folder Owlat has it in and is on none of
 *     the synced folders — deleted on the provider. Out of Trash or Spam it is
 *     deleted here too; from anywhere else it goes to Trash, so nothing a
 *     misread can cost is unrecoverable. A copy moved to Trash drops its
 *     sighting, so it is not called gone a second time.
 *   - `flags`: the provider's flags, applied where they differ.
 *   - `sightings`: where the synced folders hold the message now, with UIDs.
 *     Each local copy records the one for the folder it ends up in.
 *   - `forgetSightings`: drop the recorded sightings. A merge sends it for mail
 *     it finds nowhere, because a merge deletes nothing and a sighting kept
 *     from before it would get the message deleted once the account is aligned.
 */
export const applyRemoteObservations = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		observations: v.array(
			v.object({
				messageId: v.string(),
				remoteFolders: v.optional(v.array(v.string())),
				isGone: v.optional(v.boolean()),
				flags: v.optional(flagStateValidator),
				sightings: v.optional(v.array(remoteSightingValidator)),
				forgetSightings: v.optional(v.boolean()),
			})
		),
	},
	handler: async (ctx, args) => {
		const account = await liveFullSyncAccount(ctx, args.accountId);
		if (!account) return { pulled: 0, pushed: 0 };
		const isAligned = account.fullSyncAlignedAt !== undefined;
		const remoteByFolder = await remoteNamesByFolder(ctx, account._id);
		const folderByRemote = new Map([...remoteByFolder].map(([folderId, name]) => [name, folderId]));
		const folders = new Map<Id<'mailFolders'>, Doc<'mailFolders'> | null>();
		const folderOf = async (id: Id<'mailFolders'>) => {
			if (!folders.has(id)) folders.set(id, await ctx.db.get(id));
			return folders.get(id) ?? null;
		};
		const roleFolder = async (role: 'inbox' | 'trash') =>
			await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', account.mailboxId).eq('role', role)
				)
				.first();
		const inbox = await roleFolder('inbox');
		const touchedThreads = new Set<Id<'mailThreads'>>();
		let pulled = 0;
		let pushed = 0;

		for (const obs of args.observations) {
			// Ahead of the in-flight check: dropping evidence is always safe, and a
			// queued write-back must not keep a sighting the merge meant to drop.
			if (obs.forgetSightings) {
				for (const row of await rowsForMessageId(ctx, account.mailboxId, obs.messageId)) {
					if (row.remoteSighting) await ctx.db.patch(row._id, { remoteSighting: undefined });
				}
			}
			const pending = await ctx.db
				.query('externalMailRemoteOps')
				.withIndex('by_account_and_message', (q) =>
					q.eq('accountId', account._id).eq('rfc822MessageId', obs.messageId)
				)
				.first();
			if (pending) continue;

			for (const row of await rowsForMessageId(ctx, account.mailboxId, obs.messageId)) {
				const folder = await folderOf(row.folderId);
				if (!folder) continue;
				const local = remoteByFolder.get(row.folderId);

				if (obs.isGone && isAligned && local !== undefined) {
					if (folder.role === 'sent' || folder.role === 'drafts') continue;
					if (folder.role === 'trash' || folder.role === 'spam') {
						touchedThreads.add(await purgeMessageRow(ctx, row));
						pulled += 1;
						continue;
					}
					const trash = await roleFolder('trash');
					if (trash) {
						await moveMessagesToFolder(
							ctx,
							{ messageIds: [row._id], targetFolderId: trash._id },
							{ writeBack: false }
						);
						if (row.remoteSighting) await ctx.db.patch(row._id, { remoteSighting: undefined });
						pulled += 1;
					}
					continue;
				}

				// The remote folder the row sits in once any move below is applied.
				let at = local;

				const remoteFolders = obs.remoteFolders ?? [];
				if (remoteFolders.length > 0 && (local === undefined || !remoteFolders.includes(local))) {
					const mapped = remoteFolders.filter((name) => folderByRemote.has(name));
					const targetName =
						mapped.find((name) => folderByRemote.get(name) === inbox?._id) ?? mapped[0];
					const targetFolderId = targetName ? folderByRemote.get(targetName) : undefined;
					if (targetName && targetFolderId && targetFolderId !== row.folderId) {
						if (isAligned || folder.role === 'inbox' || local === undefined) {
							await moveMessagesToFolder(
								ctx,
								{ messageIds: [row._id], targetFolderId },
								{ writeBack: false }
							);
							at = targetName;
							pulled += 1;
						} else {
							await enqueueRemoteOp(ctx, account._id, {
								kind: 'move',
								rfc822MessageId: obs.messageId,
								source: { remote: targetName },
								target: { remote: local },
							});
							pushed += 1;
						}
					}
				}

				const sighting = obs.sightings?.find((s) => s.remoteName === at);
				if (sighting && !sameSighting(sighting, row.remoteSighting)) {
					await ctx.db.patch(row._id, { remoteSighting: sighting });
				}

				if (obs.flags) {
					const fresh = await ctx.db.get(row._id);
					if (!fresh) continue;
					const pull: RemoteFlagChanges = {};
					const push: RemoteFlagChanges = {};
					for (const key of FLAG_KEYS) {
						const remote = obs.flags[key];
						if (remote === fresh[FLAG_COLUMNS[key]]) continue;
						// Merging: set on either side is set on both.
						if (isAligned || remote) pull[key] = remote;
						else push[key] = true;
					}
					if (Object.keys(pull).length > 0) {
						await applyFlagDelta(ctx, fresh, pull);
						touchedThreads.add(fresh.threadId);
						pulled += 1;
					}
					const where = remoteFolders[0] ?? local;
					if (Object.keys(push).length > 0 && where) {
						await enqueueRemoteOp(ctx, account._id, {
							kind: 'flags',
							rfc822MessageId: obs.messageId,
							source: { remote: where },
							flags: push,
						});
						pushed += 1;
					}
				}
			}
		}

		for (const threadId of touchedThreads) await rebuildThreadAggregates(ctx, threadId);
		if (pushed > 0) await nudgeWorker(ctx, account._id);
		return { pulled, pushed };
	},
});

/**
 * The worker finished a complete reconcile while the account was unaligned:
 * from now on the provider's changes are pulled rather than merged.
 */
export const markFullSyncAligned = internalMutation({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const account = await liveFullSyncAccount(ctx, args.accountId);
		if (!account || account.fullSyncAlignedAt !== undefined) return;
		await ctx.db.patch(account._id, { fullSyncAlignedAt: Date.now(), updatedAt: Date.now() });
	},
});

/**
 * The provider's folder list after a completed two-way cycle. A mapped folder
 * the provider no longer lists was renamed or deleted there: its mapping goes,
 * and a user folder left with no mail, no subfolders and no other mapping is
 * deleted here too. Its mail has already followed by then — the reconcile that
 * runs first moves it to the renamed folder, or to Trash when it went with the
 * folder — so a folder still holding mail (Owlat-only mail, say) is kept.
 *
 * `retired` names folders the provider still lists but the worker stopped
 * mirroring: the virtual views (Gmail's Important, say) an older worker took
 * for real folders. Their mail lives in other folders on the provider, and the
 * reconcile moves it there, but only while the mapping exists: a message whose
 * folder has no mapping has no remote name and is never looked at again. So a
 * retired mapping goes only once its folder is empty, and the folder with it.
 */
export const forgetRemoteFolders = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		listed: v.array(v.string()),
		retired: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const account = await liveFullSyncAccount(ctx, args.accountId);
		if (!account) return { forgotten: 0 };
		const retired = new Set(args.retired ?? []);
		const listed = new Set(args.listed.filter((name) => !retired.has(name)));
		const rows = await ctx.db
			.query('externalMailFolderSync')
			.withIndex('by_account', (q) => q.eq('accountId', account._id))
			.collect(); // bounded: one row per synced folder of one account
		const gone = rows.filter((r) => !listed.has(r.remoteName));
		if (gone.length === 0) return { forgotten: 0 };
		const stillMapped = new Set(
			rows.filter((r) => listed.has(r.remoteName)).map((r) => r.folderId)
		);
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', account.mailboxId))
			.collect(); // bounded: one mailbox's folders
		const holdsMail = async (folderId: Id<'mailFolders'>): Promise<boolean> =>
			(await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
				.first()) !== null;
		let forgotten = 0;
		for (const row of gone) {
			if (retired.has(row.remoteName) && (await holdsMail(row.folderId))) continue;
			await ctx.db.delete(row._id);
			forgotten += 1;
			if (stillMapped.has(row.folderId)) continue;
			const folder = folders.find((f) => f._id === row.folderId);
			if (!folder || folder.role) continue;
			if (folders.some((f) => f.parentId === folder._id)) continue;
			if (await holdsMail(folder._id)) continue;
			await dropFolderMembership(ctx, folder._id);
			await ctx.db.delete(folder._id);
		}
		return { forgotten };
	},
});
