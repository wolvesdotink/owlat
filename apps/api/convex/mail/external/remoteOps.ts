/**
 * Local → remote write-back for connected external (IMAP) mailboxes.
 *
 * The mail-sync worker pulls new mail in, and until this module existed that
 * was the only direction: a message archived or filed in Owlat stayed in the
 * provider's inbox, read state and stars never left, and "Delete forever" left
 * the provider's copy in its Trash. Now every local mutation that relocates,
 * re-flags or permanently deletes a message in an external mailbox records the
 * change as an `externalMailRemoteOps` row in the same transaction, nudges the
 * worker, and the worker replays the queue over IMAP
 * (`apps/mail-sync/src/remoteOps.ts`).
 *
 * A message is addressed by Message-ID plus the remote folder it sits in, not
 * by remote UID: rows ingested before this queue existed carry no UID, a UID
 * changes with every move, and Owlat keeps one row for what Gmail lists in two
 * folders (Inbox and All Mail).
 *
 * Recording never fails the member's action. Nothing is recorded for a mailbox
 * that is not external, an account that is disconnected, a seed or set to
 * receive new mail only (`syncMode: 'incoming'`), or a message whose Message-ID
 * the worker had to invent. The opposite direction — changes made on the
 * provider — is `remoteState.ts`. The order ops reach the provider in, and how
 * a newer flag change supersedes an older one, is `remoteOpOrder.ts`.
 */

import { v, type Infer } from 'convex/values';
import {
	internalAction,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type {
	remoteFlagChangesValidator,
	remoteFolderRefValidator,
} from '../../lib/validators/mail';
import { findDuplicateInMailbox } from '../deliveryPipeline/insert';
import { getMailSyncConfig, mtaFetch } from '../mtaClient';
import { deferOpsBehind, dueRemoteOps, insertRemoteOp } from './remoteOpOrder';

export type RemoteFolderRef = Infer<typeof remoteFolderRefValidator>;
export type RemoteFlagChanges = Infer<typeof remoteFlagChangesValidator>;

/** One local change to mirror on the provider. `message` is the row as it was BEFORE the change. */
export type RemoteChange =
	| {
			kind: 'move';
			message: Doc<'mailMessages'>;
			sourceFolderId: Id<'mailFolders'>;
			targetFolderId: Id<'mailFolders'>;
	  }
	| { kind: 'flags'; message: Doc<'mailMessages'>; flags: RemoteFlagChanges }
	| { kind: 'delete'; message: Doc<'mailMessages'> };

/** Attempts before a failing op is dropped. With the backoff below, about two hours. */
export const MAX_REMOTE_OP_ATTEMPTS = 8;
/** Ops handed to the worker per read. */
const DUE_PAGE_SIZE = 50;
/** Deepest user-folder nesting a path is built for. */
const MAX_FOLDER_DEPTH = 16;
/**
 * The id the worker invents for a message that arrived without a Message-ID
 * header (`apps/mail-sync/src/ingest.ts`). The provider's copy has no such
 * header to search for, so a change to one of these is not recorded.
 */
const SYNTHETIC_MESSAGE_ID_SUFFIX = '@owlat-mail-sync';

/**
 * The subset of `next` that differs from the message's current flags — what a
 * flag write actually changed, and so what the provider has to be told.
 */
export function changedRemoteFlags(
	message: Pick<Doc<'mailMessages'>, 'flagSeen' | 'flagFlagged' | 'flagAnswered'>,
	next: RemoteFlagChanges
): RemoteFlagChanges {
	const changed: RemoteFlagChanges = {};
	if (next.seen !== undefined && next.seen !== message.flagSeen) changed.seen = next.seen;
	if (next.flagged !== undefined && next.flagged !== message.flagFlagged) {
		changed.flagged = next.flagged;
	}
	if (next.answered !== undefined && next.answered !== message.flagAnswered) {
		changed.answered = next.answered;
	}
	return changed;
}

function sameRef(a: RemoteFolderRef, b: RemoteFolderRef): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Record `changes` for the worker and nudge it once per account touched. Call
 * AFTER the local writes: a delete looks for a surviving copy of the message
 * (an IMAP client's COPY + EXPUNGE), which only makes sense once the row is gone.
 */
export async function recordRemoteChanges(
	ctx: MutationCtx,
	changes: ReadonlyArray<RemoteChange>
): Promise<void> {
	if (changes.length === 0) return;
	const accounts = new Map<Id<'mailboxes'>, Id<'externalMailAccounts'> | null>();
	const mappings = new Map<Id<'externalMailAccounts'>, Map<Id<'mailFolders'>, string>>();
	const refs = new Map<Id<'mailFolders'>, RemoteFolderRef | null>();
	const nudge = new Set<Id<'externalMailAccounts'>>();
	const now = Date.now();

	const accountFor = async (mailboxId: Id<'mailboxes'>) => {
		if (!accounts.has(mailboxId)) accounts.set(mailboxId, await liveAccountFor(ctx, mailboxId));
		return accounts.get(mailboxId) ?? null;
	};
	let accountId: Id<'externalMailAccounts'> | null = null;
	const refFor = async (folderId: Id<'mailFolders'>) => {
		if (!refs.has(folderId)) {
			let mapped: Map<Id<'mailFolders'>, string> | undefined;
			if (accountId) {
				mapped = mappings.get(accountId);
				if (!mapped) {
					mapped = await remoteNamesByFolder(ctx, accountId);
					mappings.set(accountId, mapped);
				}
			}
			const remote = mapped?.get(folderId);
			refs.set(folderId, remote ? { remote } : await remoteFolderRef(ctx, folderId));
		}
		return refs.get(folderId) ?? null;
	};

	for (const change of changes) {
		const { message } = change;
		if (message.rfc822MessageId.endsWith(SYNTHETIC_MESSAGE_ID_SUFFIX)) continue;
		accountId = await accountFor(message.mailboxId);
		if (!accountId) continue;
		const base = {
			accountId,
			rfc822MessageId: message.rfc822MessageId,
			attempts: 0,
			nextAttemptAt: now,
			createdAt: now,
		};

		if (change.kind === 'flags') {
			if (Object.keys(change.flags).length === 0) continue;
			const source = await refFor(message.folderId);
			if (!source) continue;
			await insertRemoteOp(ctx, { ...base, kind: 'flags', source, flags: change.flags });
		} else {
			let sourceFolderId = message.folderId;
			let targetFolderId: Id<'mailFolders'> | null = null;
			if (change.kind === 'move') {
				sourceFolderId = change.sourceFolderId;
				targetFolderId = change.targetFolderId;
			} else {
				// A copy that survives the delete means the message was relocated, not
				// removed (an IMAP client without MOVE copies, then expunges): mirror
				// that as a move, and never delete what the member still has.
				const survivor = await findDuplicateInMailbox(
					ctx,
					message.mailboxId,
					message.rfc822MessageId
				);
				if (survivor) targetFolderId = survivor.folderId;
			}
			const source = await refFor(sourceFolderId);
			if (!source) continue;
			if (targetFolderId === null) {
				await insertRemoteOp(ctx, { ...base, kind: 'delete', source });
			} else {
				const target = await refFor(targetFolderId);
				if (!target || sameRef(source, target)) continue;
				await insertRemoteOp(ctx, { ...base, kind: 'move', source, target });
			}
		}
		nudge.add(accountId);
	}

	for (const id of nudge) await nudgeWorker(ctx, id);
}

/** Wake the worker for an account (best-effort; it also drains on every poll). */
export async function nudgeWorker(
	ctx: MutationCtx,
	accountId: Id<'externalMailAccounts'>
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.mail.external.remoteOps.notifyWorker, { accountId });
}

/**
 * Rename or delete, at the provider, a local folder that mirrors one of its
 * folders. A rename changes only the folder's own name, so it stays where it
 * sits in the provider's tree. A delete must be recorded BEFORE the folder's
 * mapping rows go (they name the remote folder); the worker moves whatever the
 * provider still holds in it to the inbox first — the same thing deleting a
 * folder does here — so no mail Owlat never imported is lost with it. A folder
 * the provider never had records nothing.
 */
export async function recordRemoteFolderChange(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>,
	change: { kind: 'rename'; name: string } | { kind: 'delete' }
): Promise<void> {
	const folder = await ctx.db.get(folderId);
	if (!folder || folder.role) return;
	const mappings = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_folder', (q) => q.eq('folderId', folderId))
		.collect(); // bounded: a folder maps to one remote folder per account
	for (const mapping of mappings) {
		const account = await ctx.db.get(mapping.accountId);
		if (!account || account.status === 'disconnected' || account.purpose === 'seed') continue;
		if (!writesBack(account)) continue;
		await enqueueRemoteOp(
			ctx,
			account._id,
			change.kind === 'rename'
				? {
						kind: 'renameFolder',
						source: { remote: mapping.remoteName },
						target: { path: [change.name] },
					}
				: { kind: 'deleteFolder', source: { remote: mapping.remoteName } }
		);
		await nudgeWorker(ctx, account._id);
	}
}

/**
 * Queue one write-back directly, for the reconcile that decides the provider is
 * the side to change (`remoteState.ts`) and for folder changes. The caller
 * nudges the worker once.
 */
export async function enqueueRemoteOp(
	ctx: MutationCtx,
	accountId: Id<'externalMailAccounts'>,
	op: {
		kind: Doc<'externalMailRemoteOps'>['kind'];
		rfc822MessageId?: string;
		source: RemoteFolderRef;
		target?: RemoteFolderRef;
		flags?: RemoteFlagChanges;
	}
): Promise<void> {
	const now = Date.now();
	await insertRemoteOp(ctx, {
		...op,
		accountId,
		attempts: 0,
		nextAttemptAt: now,
		createdAt: now,
	});
}

/** The remote name each mapped local folder of an account syncs with. */
export async function remoteNamesByFolder(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>
): Promise<Map<Id<'mailFolders'>, string>> {
	const rows = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account', (q) => q.eq('accountId', accountId))
		.collect(); // bounded: one row per synced folder of one account
	return new Map(rows.map((r) => [r.folderId, r.remoteName]));
}

/** An account whose provider is told about local changes: not set to new-mail-only. */
export function writesBack(account: Pick<Doc<'externalMailAccounts'>, 'syncMode'>): boolean {
	return (account.syncMode ?? 'full') === 'full';
}

/**
 * The account whose provider mirrors this mailbox, or null when nothing should
 * be written back: a hosted mailbox, a disconnected or purging account, or a
 * deliverability seed (org infrastructure, never a member's inbox).
 */
async function liveAccountFor(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Id<'externalMailAccounts'> | null> {
	const accounts = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.collect(); // bounded: one live account per mailbox, plus the disconnected ones a re-attach left
	const live = accounts.find(
		(a) => a.status !== 'disconnected' && a.purpose !== 'seed' && a.purgeStartedAt === undefined
	);
	return live && writesBack(live) ? live._id : null;
}

/**
 * Name a local folder for the worker. A user folder nested under a system
 * folder is named from the user folders only, so it lands at the top level of
 * the provider's tree rather than under a path that differs per provider.
 */
async function remoteFolderRef(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<RemoteFolderRef | null> {
	const folder = await ctx.db.get(folderId);
	if (!folder) return null;
	if (folder.role) return { role: folder.role };
	const path = [folder.name];
	let parentId = folder.parentId;
	while (parentId && path.length < MAX_FOLDER_DEPTH) {
		const parent = await ctx.db.get(parentId);
		if (!parent || parent.role) break;
		path.unshift(parent.name);
		parentId = parent.parentId;
	}
	return { path };
}

// ── Worker surface ─────────────────────────────────────────────────────

/**
 * The account's due ops that may run now: none that waits behind an older op
 * still queued for its message or folder (`remoteOpOrder.ts`). None while the
 * account receives new mail only.
 */
export const listDueRemoteOps = internalQuery({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		if (!account || !writesBack(account)) return [];
		const rows = await dueRemoteOps(ctx, args.accountId, Date.now(), DUE_PAGE_SIZE);
		return rows.map((r) => ({
			opId: r._id,
			kind: r.kind,
			rfc822MessageId: r.rfc822MessageId,
			source: r.source,
			target: r.target,
			flags: r.flags,
			attempts: r.attempts,
		}));
	},
});

/** Backoff after the `attempts`-th failure: 1, 2, 4 … minutes, capped at an hour. */
export function remoteOpRetryDelayMs(attempts: number): number {
	return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Close out a batch the worker replayed. `done` and `not_found` retire the op
 * (there is nothing left to do on the server); `failed` pushes it back, along
 * with the later ops of its message that wait behind it, and drops it once its
 * attempts are spent.
 */
export const settleRemoteOps = internalMutation({
	args: {
		results: v.array(
			v.object({
				opId: v.id('externalMailRemoteOps'),
				outcome: v.union(v.literal('done'), v.literal('not_found'), v.literal('failed')),
				error: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		for (const result of args.results) {
			const op = await ctx.db.get(result.opId);
			if (!op) continue;
			if (result.outcome !== 'failed') {
				await ctx.db.delete(op._id);
				continue;
			}
			const attempts = op.attempts + 1;
			const lastError = result.error?.slice(0, 500);
			if (attempts >= MAX_REMOTE_OP_ATTEMPTS) {
				console.warn(
					`[remoteOps] dropping ${op.kind} for account ${op.accountId} after ${attempts} attempts: ${lastError ?? 'unknown error'}`
				);
				await ctx.db.delete(op._id);
				continue;
			}
			const nextAttemptAt = now + remoteOpRetryDelayMs(attempts);
			await ctx.db.patch(op._id, { attempts, lastError, nextAttemptAt });
			await deferOpsBehind(ctx, op, nextAttemptAt);
		}
	},
});

/**
 * Tell the worker an account has changes waiting. Best-effort: when the worker
 * is not configured or does not answer, it still drains the queue on its next
 * poll and after every reconnect.
 */
export const notifyWorker = internalAction({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (_ctx, args) => {
		const config = getMailSyncConfig();
		if (!config) return;
		try {
			const res = await mtaFetch(
				config,
				'/remote-ops',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ accountId: args.accountId }),
				},
				5_000
			);
			if (!res.ok) console.warn(`[remoteOps] worker nudge answered ${res.status}`);
		} catch (err) {
			console.warn('[remoteOps] worker nudge failed', err);
		}
	},
});
