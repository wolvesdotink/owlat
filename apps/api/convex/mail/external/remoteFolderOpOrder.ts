/**
 * Where folder renames and deletes go in the write-back queue
 * (`remoteOpOrder.ts`).
 *
 * A folder rename or delete changes the remote name that message ops address
 * the folder (and every folder below it) by. It waits until no message op
 * naming the folder is queued, and runs after any older folder op on the same
 * branch of the tree. The message ops are found by remote name through an
 * index, so how many other ops are queued does not matter; the older folder ops
 * are read from the account's folder ops, oldest first.
 *
 * A folder op that waits for an op which failed and was pushed back is pushed
 * back with it, so the ops still due are ones that can run.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

type RemoteOpRow = Doc<'externalMailRemoteOps'>;

/**
 * Why an op cannot run yet. `lead` is the queued op it waits for, which may be
 * able to run in its place; none when it only waits its turn.
 */
export type Held = { lead?: RemoteOpRow };

const MESSAGE_KINDS = ['move', 'flags', 'delete'] as const;
const FOLDER_KINDS = ['renameFolder', 'deleteFolder'] as const;
/** The oldest folder ops one read orders; a newer one waits until they have run. */
const FOLDER_OPS_LIMIT = 500;
/** Folder ops one read looks the message ops up for; the rest wait for the next read. */
const FOLDER_CHECKS_LIMIT = 100;
/** Folder ops one failed op pushes back with it. */
const FOLDER_DEFER_LIMIT = 200;
/**
 * Hierarchy delimiters a remote name may use. Matching on both only ever makes
 * a folder op wait longer. They are adjacent characters ('.' U+002E, '/'
 * U+002F), so every name below a folder sorts from `folder + '.'` up to, but not
 * including, `folder + '0'` (U+0030): one index range.
 */
const DELIMITERS = ['.', '/'];
const BELOW_FROM = '.';
const BELOW_TO = '0';

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
function selfAndAncestors(name: string): string[] {
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
function folderOf(op: RemoteOpRow): string | null {
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
export function folderOpOrder(ctx: QueryCtx, accountId: Id<'externalMailAccounts'>) {
	let folderOps: RemoteOpRow[] | undefined;
	let checks = 0;
	return async (op: RemoteOpRow): Promise<Held | null> => {
		const folder = folderOf(op);
		if (folder === null) return null;
		folderOps ??= await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_and_message', (q) =>
				q.eq('accountId', accountId).eq('rfc822MessageId', undefined)
			)
			.take(FOLDER_OPS_LIMIT);
		const at = folderOps.findIndex((other) => other._id === op._id);
		// Past the oldest ones: none of those waits for it, so they drain first.
		if (at === -1) return { lead: folderOps[0] };
		const older = folderOps
			.slice(0, at)
			.find((other) => remoteNames(other).some((name) => sameBranch(name, folder)));
		if (older) return { lead: older };
		if (checks >= FOLDER_CHECKS_LIMIT) return {};
		checks++;
		const naming = await messageOpNaming(ctx, accountId, folder);
		return naming ? { lead: naming } : null;
	};
}

/** The queued folder ops on `name` (any age, `after` a creation time if given). */
async function folderOpsOn(
	ctx: MutationCtx,
	accountId: Id<'externalMailAccounts'>,
	name: string,
	after?: number
): Promise<RemoteOpRow[]> {
	const rows: RemoteOpRow[] = [];
	for (const kind of FOLDER_KINDS) {
		rows.push(
			...(await ctx.db
				.query('externalMailRemoteOps')
				.withIndex('by_account_kind_and_source_remote', (q) => {
					const named = q.eq('accountId', accountId).eq('kind', kind).eq('source.remote', name);
					return after === undefined ? named : named.gt('_creationTime', after);
				})
				.take(FOLDER_DEFER_LIMIT))
		);
	}
	return rows;
}

/** The queued folder ops newer than `op` on its branch: they run after it. */
async function newerOnBranch(ctx: MutationCtx, op: RemoteOpRow): Promise<RemoteOpRow[]> {
	const folder = folderOf(op);
	if (folder === null) return [];
	const rows: RemoteOpRow[] = [];
	for (const name of selfAndAncestors(folder)) {
		rows.push(...(await folderOpsOn(ctx, op.accountId, name, op._creationTime)));
	}
	for (const kind of FOLDER_KINDS) {
		const below = await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_kind_and_source_remote', (q) =>
				q
					.eq('accountId', op.accountId)
					.eq('kind', kind)
					.gte('source.remote', folder + BELOW_FROM)
					.lt('source.remote', folder + BELOW_TO)
			)
			.take(FOLDER_DEFER_LIMIT);
		rows.push(...below.filter((row) => row._creationTime > op._creationTime));
	}
	return rows;
}

/**
 * `held` — a failed op and the ops of its message pushed back with it — is not
 * due before `until`: push the folder ops that wait for any of them back too,
 * and the folder ops that wait for those.
 */
export async function deferFolderOpsBehind(
	ctx: MutationCtx,
	held: RemoteOpRow[],
	until: number
): Promise<void> {
	const first = held[0];
	if (!first) return;
	const seen = new Set<Id<'externalMailRemoteOps'>>(held.map((op) => op._id));
	const queue = held.filter((op) => folderOf(op) !== null);
	const defer = async (row: RemoteOpRow) => {
		if (seen.has(row._id) || seen.size >= FOLDER_DEFER_LIMIT) return;
		seen.add(row._id);
		if (row.nextAttemptAt < until) await ctx.db.patch(row._id, { nextAttemptAt: until });
		queue.push(row);
	};

	const named = new Set(held.filter((op) => op.rfc822MessageId !== undefined).flatMap(remoteNames));
	const folders = new Set([...named].flatMap(selfAndAncestors));
	for (const folder of folders) {
		for (const row of await folderOpsOn(ctx, first.accountId, folder)) await defer(row);
	}
	for (let next = queue.shift(); next; next = queue.shift()) {
		for (const row of await newerOnBranch(ctx, next)) await defer(row);
	}
}
