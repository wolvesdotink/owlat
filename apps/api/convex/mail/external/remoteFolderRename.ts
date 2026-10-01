/**
 * A folder rename the worker carried out at the provider (a `renameFolder` op,
 * `remoteOps.ts`), followed through the backend: the folder's mapping rows and
 * every queued op that still names it, or a folder below it (RENAME takes those
 * along), by the old remote name.
 *
 * Until the worker has reported the rename, the backend names the folder by
 * its old name, so the worker keeps the rename op queued until the report is
 * recorded, and reports again on every retry. After a restart the worker
 * first reports every queued rename the provider already shows as done
 * (`listQueuedFolderRenames`, page by page), before any op for the old name
 * runs.
 *
 * Recording names the rename op by the new name and marks it with the old one
 * (`renameRewrite`) until every queued op is rewritten, which can take more
 * than one transaction. Until then the op is neither handed out again nor
 * deleted by the worker's settle, and no op naming the old folder, and no
 * other folder op on its branch, is due (`renameRewriteHold`,
 * `remoteFolderOpOrder.ts`): a restarted worker would look for the old folder,
 * and a later rename must see every op already rewritten. A repeated report
 * only carries the rewrite on.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { internalMutation } from '../../lib/writeFence';
import { internal } from '../../_generated/api';
import { FOLDER_KINDS, MESSAGE_KINDS } from './remoteFolderOpOrder';
import { nudgeWorker, workerOp, writesBack } from './remoteOps';

/** Queued ops one transaction rewrites before it hands the rest to a continuation. */
const RENAME_ROWS_PER_RUN = 1000;
/** Queued renames one page of the worker's pre-replay check holds. */
const QUEUED_RENAMES_PAGE = 50;

const folderRenameValidator = v.object({
	accountId: v.id('externalMailAccounts'),
	from: v.string(),
	to: v.string(),
	// The provider's hierarchy delimiter: what separates a folder below from its parent.
	delimiter: v.string(),
});
type FolderRename = Infer<typeof folderRenameValidator>;

/** The new name of `name`, or null for a name the rename did not touch. */
function renamedName(rename: FolderRename, name: string): string | null {
	const { from, to, delimiter } = rename;
	if (name === from) return to;
	return delimiter && name.startsWith(from + delimiter) ? to + name.slice(from.length) : null;
}

/** Point the folder's mapping rows, and those of the folders below it, at the new name. */
async function renameMappings(ctx: MutationCtx, rename: FolderRename): Promise<void> {
	const rows = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account', (q) => q.eq('accountId', rename.accountId))
		.collect(); // bounded: one row per synced folder of one account
	const renamed = rows.flatMap((row) => {
		const remoteName = renamedName(rename, row.remoteName);
		return remoteName === null ? [] : [{ row, remoteName }];
	});
	for (const { row, remoteName } of renamed) {
		// A row already holding the new name maps a folder the provider no longer has.
		for (const stale of rows) {
			if (stale.remoteName === remoteName && !renamed.some((r) => r.row === stale)) {
				await ctx.db.delete(stale._id);
			}
		}
		await ctx.db.patch(row._id, { remoteName });
	}
}

/**
 * Rewrite the queued ops naming the old folder, or a folder below it, found by
 * index. A rewritten op leaves the range read, so each run starts over from
 * the front. True when a run stopped at its budget and ops may be left.
 */
async function renameQueuedOps(ctx: MutationCtx, rename: FolderRename): Promise<boolean> {
	const { accountId, from, delimiter } = rename;
	const below = from + delimiter;
	// Every name that starts with `below` sorts before its last character's successor.
	const belowEnd = below.slice(0, -1) + String.fromCharCode(below.charCodeAt(below.length - 1) + 1);
	const ops = ctx.db.query('externalMailRemoteOps');
	const scans = [...FOLDER_KINDS, ...MESSAGE_KINDS].flatMap((kind) => [
		{ kind, field: 'source' as const },
		...(kind === 'move' ? [{ kind, field: 'target' as const }] : []),
	]);
	let budget = RENAME_ROWS_PER_RUN;
	for (const { kind, field } of scans) {
		const index =
			field === 'source'
				? ('by_account_kind_and_source_remote' as const)
				: ('by_account_kind_and_target_remote' as const);
		const key = field === 'source' ? ('source.remote' as const) : ('target.remote' as const);
		const rows = await ops
			.withIndex(index, (q) => q.eq('accountId', accountId).eq('kind', kind).eq(key, from))
			.take(budget);
		if (delimiter && rows.length < budget) {
			rows.push(
				...(await ops
					.withIndex(index, (q) =>
						q.eq('accountId', accountId).eq('kind', kind).gte(key, below).lt(key, belowEnd)
					)
					.take(budget - rows.length))
			);
		}
		budget -= rows.length;
		for (const row of rows) {
			const ref = row[field];
			const remote = ref && 'remote' in ref ? renamedName(rename, ref.remote) : null;
			if (remote === null) continue;
			await ctx.db.patch(
				row._id,
				field === 'source' ? { source: { remote } } : { target: { remote } }
			);
		}
		if (budget <= 0) return true;
	}
	return false;
}

type RenameOp = Doc<'externalMailRemoteOps'> & {
	renameRewrite: NonNullable<Doc<'externalMailRemoteOps'>['renameRewrite']>;
};

/**
 * Rewrite one transaction's worth and hand what is left to a continuation.
 * Once nothing is left the rename op is done: deleted if the worker already
 * settled it, otherwise left for the worker's settle like any other op.
 */
async function applyRename(ctx: MutationCtx, op: RenameOp): Promise<void> {
	if (!('remote' in op.source)) return;
	const rename: FolderRename = {
		accountId: op.accountId,
		from: op.renameRewrite.from,
		to: op.source.remote,
		delimiter: op.renameRewrite.delimiter,
	};
	if (await renameQueuedOps(ctx, rename)) {
		await ctx.scheduler.runAfter(
			0,
			internal.mail.external.remoteFolderRename.continueFolderRename,
			{ opId: op._id }
		);
		return;
	}
	if (op.renameRewrite.settledAt !== undefined) await ctx.db.delete(op._id);
	else await ctx.db.patch(op._id, { renameRewrite: undefined });
	// The ops that waited for the rewrite can run now.
	await nudgeWorker(ctx, op.accountId);
}

/**
 * The worker renamed a mirrored folder at the provider to `remoteName`. Point
 * the folder's mapping, and every op still naming it by its old name, at the
 * new one, so a change recorded before the worker's next folder discovery, or
 * replayed after a worker restart, reaches the folder.
 */
export const recordRemoteFolderRename = internalMutation({
	args: {
		opId: v.id('externalMailRemoteOps'),
		remoteName: v.string(),
		delimiter: v.string(),
	},
	handler: async (ctx, args) => {
		const op = await ctx.db.get(args.opId);
		if (!op || op.kind !== 'renameFolder' || !('remote' in op.source)) return null;
		// Reported before: carry on its rewrite, in case its continuation was lost.
		if (op.renameRewrite) {
			await applyRename(ctx, { ...op, renameRewrite: op.renameRewrite });
			return null;
		}
		const rename: FolderRename = {
			accountId: op.accountId,
			from: op.source.remote,
			to: args.remoteName,
			delimiter: args.delimiter,
		};
		// Already recorded and rewritten: the rename op itself names the new folder.
		if (!rename.to || rename.to === rename.from) return null;
		await renameMappings(ctx, rename);
		// The rename op keeps the old name until every queued op is rewritten.
		const renameRewrite = { from: rename.from, delimiter: rename.delimiter };
		await ctx.db.patch(op._id, { source: { remote: rename.to }, renameRewrite });
		await applyRename(ctx, { ...op, source: { remote: rename.to }, renameRewrite });
		return null;
	},
});

/** Carry on rewriting the ops a rename's transaction had no room left for. */
export const continueFolderRename = internalMutation({
	args: { opId: v.id('externalMailRemoteOps') },
	handler: async (ctx, args) => {
		const op = await ctx.db.get(args.opId);
		// Gone with its account, or finished by a repeated report.
		if (!op?.renameRewrite) return;
		await applyRename(ctx, { ...op, renameRewrite: op.renameRewrite });
	},
});

/**
 * One page of the account's queued folder renames, in index order, for the
 * worker to check before its first replay: one it carried out but could not
 * report before it stopped is still named by the old name here. The worker
 * walks every page (`continueCursor` until `isDone`) before it replays
 * anything, so a rename past the first page is never missed.
 */
export const listQueuedFolderRenames = internalQuery({
	args: {
		accountId: v.id('externalMailAccounts'),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		if (!account || !writesBack(account)) return { page: [], isDone: true, continueCursor: '' };
		const result = await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_kind_and_source_remote', (q) =>
				q.eq('accountId', args.accountId).eq('kind', 'renameFolder')
			)
			.paginate({ numItems: QUEUED_RENAMES_PAGE, cursor: args.cursor ?? null });
		return {
			// One already recorded is not reported again.
			page: result.page.filter((r) => !r.renameRewrite).map(workerOp),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});
