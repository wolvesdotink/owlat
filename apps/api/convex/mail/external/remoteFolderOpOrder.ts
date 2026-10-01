/**
 * Where folder renames and deletes go in the write-back queue
 * (`remoteOpOrder.ts`).
 *
 * A folder rename or delete changes the remote name that message ops address
 * the folder (and every folder below it) by. It waits until no message op
 * naming the folder is queued, and runs after any older folder op on the same
 * branch of the tree. Both are found by remote name through an index, so how
 * many other ops are queued does not matter.
 *
 * A folder op is not due before the ops it waits for (`remoteOpDeferral.ts`).
 *
 * While a reported rename's queued ops are still being rewritten to the new
 * name (`remoteFolderRename.ts`), the ops it has yet to reach wait for it too
 * (`renameRewriteHold`).
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';

type RemoteOpRow = Doc<'externalMailRemoteOps'>;

/**
 * Why an op cannot run yet. `lead` is the queued op it waits for, which may be
 * able to run in its place; none when it only waits its turn.
 */
export type Held = { lead?: RemoteOpRow };

export const MESSAGE_KINDS = ['move', 'flags', 'delete'] as const;
export const FOLDER_KINDS = ['renameFolder', 'deleteFolder'] as const;
/** Folder ops one read looks up what they wait for; the rest wait for the next read. */
const FOLDER_CHECKS_LIMIT = 50;
/** Ops below a folder read before its folder op is ordered among the oldest folder ops instead. */
const BELOW_SCAN_LIMIT = 100;
/** The oldest folder ops that fallback orders; a newer one waits until they have run. */
const FOLDER_OPS_LIMIT = 500;
/** Renames with an unfinished rewrite one read checks against; past this, every op waits. */
const REWRITES_LIMIT = 20;
/**
 * Hierarchy delimiters a remote name may use. Matching on both only ever makes
 * a folder op wait longer. They are adjacent characters ('.' U+002E, '/'
 * U+002F), so every name below a folder sorts from `folder + '.'` up to, but not
 * including, `folder + '0'` (U+0030): one index range.
 */
const DELIMITERS = ['.', '/'];
export const BELOW_FROM = '.';
export const BELOW_TO = '0';

/** `name` is `folder` or a folder below it. */
function within(name: string, folder: string): boolean {
	return (
		name === folder ||
		(name.length > folder.length &&
			name.startsWith(folder) &&
			DELIMITERS.includes(name.charAt(folder.length)))
	);
}

/** One of the two folders contains the other: they are on one branch. */
function sameBranch(a: string, b: string): boolean {
	return within(a, b) || within(b, a);
}

/** The folders `name` is `within`: every folder above it, then itself. */
export function selfAndAncestors(name: string): string[] {
	const names: string[] = [];
	for (let i = 1; i < name.length; i++) {
		if (DELIMITERS.includes(name.charAt(i))) names.push(name.slice(0, i));
	}
	names.push(name);
	return names;
}

export function remoteNames(op: RemoteOpRow): string[] {
	const names: string[] = [];
	for (const ref of [op.source, op.target]) if (ref && 'remote' in ref) names.push(ref.remote);
	return names;
}

/** The folder a folder op renames or deletes, when it names one by remote name. */
export function folderOf(op: RemoteOpRow): string | null {
	return op.rfc822MessageId === undefined && 'remote' in op.source ? op.source.remote : null;
}

/** A queued message op that names `folder` or a folder below it, if any. */
async function messageOpNaming(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>,
	folder: string
): Promise<RemoteOpRow | null> {
	const ops = ctx.db.query('externalMailRemoteOps');
	for (const kind of MESSAGE_KINDS) {
		const named =
			(await ops
				.withIndex('by_account_kind_and_source_remote', (q) =>
					q.eq('accountId', accountId).eq('kind', kind).eq('source.remote', folder)
				)
				.first()) ??
			(await ops
				.withIndex('by_account_kind_and_source_remote', (q) =>
					q
						.eq('accountId', accountId)
						.eq('kind', kind)
						.gte('source.remote', folder + BELOW_FROM)
						.lt('source.remote', folder + BELOW_TO)
				)
				.first());
		if (named) return named;
	}
	// Only a move has a target.
	return (
		(await ops
			.withIndex('by_account_kind_and_target_remote', (q) =>
				q.eq('accountId', accountId).eq('kind', 'move').eq('target.remote', folder)
			)
			.first()) ??
		(await ops
			.withIndex('by_account_kind_and_target_remote', (q) =>
				q
					.eq('accountId', accountId)
					.eq('kind', 'move')
					.gte('target.remote', folder + BELOW_FROM)
					.lt('target.remote', folder + BELOW_TO)
			)
			.first())
	);
}

/**
 * Decides, for one read of the queue, whether a folder op may run: null when
 * it may, otherwise what it waits for.
 */
export function folderOpOrder(ctx: QueryCtx, accountId: Id<'externalMailAccounts'>, now: number) {
	const ops = ctx.db.query('externalMailRemoteOps');
	let folderOps: RemoteOpRow[] | undefined;
	let checks = 0;

	/** The account's oldest folder ops, oldest first. */
	const oldestFolderOps = async () =>
		(folderOps ??= await ops
			.withIndex('by_account_and_message', (q) =>
				q.eq('accountId', accountId).eq('rfc822MessageId', undefined)
			)
			.take(FOLDER_OPS_LIMIT));

	/** An older folder op on the branch of `folder`, which `op` runs after. */
	const olderOnBranch = async (op: RemoteOpRow, folder: string): Promise<Held | null> => {
		for (const kind of FOLDER_KINDS) {
			for (const name of selfAndAncestors(folder)) {
				const older = await ops
					.withIndex('by_account_kind_and_source_remote', (q) =>
						q
							.eq('accountId', accountId)
							.eq('kind', kind)
							.eq('source.remote', name)
							.lt('_creationTime', op._creationTime)
					)
					.first();
				if (older) return { lead: older };
			}
		}
		let read = 0;
		for (const kind of FOLDER_KINDS) {
			const below = ops.withIndex('by_account_kind_and_source_remote', (q) =>
				q
					.eq('accountId', accountId)
					.eq('kind', kind)
					.gte('source.remote', folder + BELOW_FROM)
					.lt('source.remote', folder + BELOW_TO)
			);
			for await (const other of below) {
				if (other._creationTime < op._creationTime) return { lead: other };
				if (++read <= BELOW_SCAN_LIMIT) continue;
				// Many newer ops below it (they all wait for it): order it among the oldest instead.
				const oldest = await oldestFolderOps();
				const at = oldest.findIndex((o) => o._id === op._id);
				if (at === -1) return { lead: oldest.find((o) => o.nextAttemptAt <= now) };
				const first = oldest
					.slice(0, at)
					.find((o) => remoteNames(o).some((name) => sameBranch(name, folder)));
				return first ? { lead: first } : null;
			}
		}
		return null;
	};

	return async (op: RemoteOpRow): Promise<Held | null> => {
		const folder = folderOf(op);
		if (folder === null) return null;
		if (checks >= FOLDER_CHECKS_LIMIT) return {};
		checks++;
		const older = await olderOnBranch(op, folder);
		if (older) return older;
		const naming = await messageOpNaming(ctx, accountId, folder);
		return naming ? { lead: naming } : null;
	};
}

/**
 * Decides, for one read of the queue, whether an op waits for a reported
 * rename whose queued ops are still being rewritten (`remoteFolderRename.ts`):
 * the rename op itself, an op naming the old folder or one below it (a
 * restarted worker would look for it there), and a folder op on the branch of
 * the old or the new name (it must see every op already rewritten, and a
 * second rename must not run before the first one's rewrite has). None of
 * them has a lead: the rename that holds them is never handed out again.
 */
export function renameRewriteHold(ctx: QueryCtx, accountId: Id<'externalMailAccounts'>) {
	let rewrites: RemoteOpRow[] | undefined;
	return async (op: RemoteOpRow): Promise<Held | null> => {
		if (op.renameRewrite) return {};
		rewrites ??= await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_and_rename_rewrite', (q) =>
				q.eq('accountId', accountId).gte('renameRewrite.from', '')
			)
			.take(REWRITES_LIMIT + 1);
		if (rewrites.length === 0) return null;
		if (rewrites.length > REWRITES_LIMIT) return {};
		const folder = folderOf(op);
		for (const rename of rewrites) {
			if (!rename.renameRewrite) continue;
			const { from, delimiter } = rename.renameRewrite;
			// What the rewrite rewrites: the folder and, by the provider's delimiter, those below it.
			const below = (name: string, renamed: string) =>
				name === renamed || (delimiter !== '' && name.startsWith(renamed + delimiter));
			const waits =
				folder === null
					? remoteNames(op).some((name) => below(name, from))
					: [from, ...remoteNames(rename)].some(
							(name) => sameBranch(folder, name) || below(folder, name) || below(name, folder)
						);
			if (waits) return {};
		}
		return null;
	};
}
