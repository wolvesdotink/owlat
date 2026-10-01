/**
 * The order queued write-backs reach the provider in (`remoteOps.ts`).
 *
 * A failed op is backed off, so reading the queue by due time alone lets a
 * newer op for the same message overtake it, and the older retry then undoes
 * the member's later action: "mark read" fails, "mark unread" succeeds, the
 * read retry lands last and the provider ends up read. So ops for one message
 * run in the order they were recorded — an op is handed to the worker only
 * once every older op for its message has settled — except two flag changes
 * that touch different flags, which cannot undo each other. A backed-off
 * message holds back only its own later ops; other messages keep moving.
 *
 * A flag change also supersedes the same flags in the older ops still queued
 * for the same copy of its message (the same folder) when it is recorded, so
 * only the latest value of each flag is left to send and a failing older write
 * never holds a newer one back. A change to another copy — a message filed in
 * two folders — is kept, and runs after the older one.
 *
 * A folder rename or delete changes the remote name that message ops address
 * the folder (and every folder below it) by. It waits until no message op
 * naming the folder is queued, and runs after any older folder op on the same
 * branch of the tree.
 */

import type { WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';

type RemoteOpRow = Doc<'externalMailRemoteOps'>;
type FlagChanges = NonNullable<RemoteOpRow['flags']>;

const FLAG_KEYS = ['seen', 'flagged', 'answered'] as const;
/** A message's queued ops its order is decided from; an op further back than this waits. */
const MESSAGE_OPS_LIMIT = 25;
/** Held due ops one read steps over before it returns what it has. */
const DUE_SCAN_LIMIT = 250;
/** Queued ops a folder op is checked against; while more are queued it waits. */
const FOLDER_SCAN_LIMIT = 500;
/** Hierarchy delimiters a remote name may use. Matching on both only ever makes a folder op wait longer. */
const DELIMITERS = ['/', '.'];

/** The account's queued ops for one message, oldest first. */
async function opsForMessage(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>,
	rfc822MessageId: string
): Promise<RemoteOpRow[]> {
	return await ctx.db
		.query('externalMailRemoteOps')
		.withIndex('by_account_and_message', (q) =>
			q.eq('accountId', accountId).eq('rfc822MessageId', rfc822MessageId)
		)
		.take(MESSAGE_OPS_LIMIT);
}

/**
 * Whether `older`, queued earlier for the same message, has to settle before
 * `op` may run. Flag changes on different flags commute; anything else does
 * not (a flag change follows the message's moves, and a move or delete must
 * not run against a message an older op has yet to move).
 */
function mustPrecede(
	older: Pick<RemoteOpRow, 'kind' | 'flags'>,
	op: Pick<RemoteOpRow, 'kind' | 'flags'>
): boolean {
	if (older.kind !== 'flags' || op.kind !== 'flags') return true;
	return FLAG_KEYS.some((key) => older.flags?.[key] !== undefined && op.flags?.[key] !== undefined);
}

/** `flags` without the keys `newer` sets, or null when none is left. */
function withoutFlags(flags: FlagChanges, newer: FlagChanges): FlagChanges | null {
	const rest: FlagChanges = {};
	for (const key of FLAG_KEYS) {
		if (flags[key] !== undefined && newer[key] === undefined) rest[key] = flags[key];
	}
	return Object.keys(rest).length > 0 ? rest : null;
}

/**
 * Queue one write-back behind the ops already queued for its message: a flag
 * change takes its flags out of the older ops on the same copy of the message
 * (deleting one left with none), and an op that has to wait behind an older
 * one is not due before it, so a backed-off message does not fill the front of
 * the due index with ops that every read would only step over.
 */
export async function insertRemoteOp(
	ctx: MutationCtx,
	op: WithoutSystemFields<RemoteOpRow>
): Promise<void> {
	let nextAttemptAt = op.nextAttemptAt;
	if (op.rfc822MessageId !== undefined) {
		for (const older of await opsForMessage(ctx, op.accountId, op.rfc822MessageId)) {
			let flags = older.flags;
			const sameCopy = JSON.stringify(older.source) === JSON.stringify(op.source);
			if (older.kind === 'flags' && op.kind === 'flags' && sameCopy && flags && op.flags) {
				const rest = withoutFlags(flags, op.flags);
				if (rest === null) {
					await ctx.db.delete(older._id);
					continue;
				}
				if (Object.keys(rest).length < Object.keys(flags).length) {
					await ctx.db.patch(older._id, { flags: rest });
					flags = rest;
				}
			}
			if (mustPrecede({ kind: older.kind, flags }, op)) {
				nextAttemptAt = Math.max(nextAttemptAt, older.nextAttemptAt);
			}
		}
	}
	await ctx.db.insert('externalMailRemoteOps', { ...op, nextAttemptAt });
}

/**
 * A failed op was pushed back to `until`: push the later ops of its message
 * that wait behind it along with it (see `insertRemoteOp`).
 */
export async function deferOpsBehind(
	ctx: MutationCtx,
	op: RemoteOpRow,
	until: number
): Promise<void> {
	if (op.rfc822MessageId === undefined) return;
	for (const newer of await opsForMessage(ctx, op.accountId, op.rfc822MessageId)) {
		if (newer._creationTime <= op._creationTime || newer._id === op._id) continue;
		if (newer.nextAttemptAt < until && mustPrecede(op, newer)) {
			await ctx.db.patch(newer._id, { nextAttemptAt: until });
		}
	}
}

/** `name` is `folder` or a folder below it. */
function within(name: string, folder: string): boolean {
	return (
		name === folder ||
		(name.length > folder.length &&
			name.startsWith(folder) &&
			DELIMITERS.includes(name.charAt(folder.length)))
	);
}

function remoteNames(op: RemoteOpRow): string[] {
	const names: string[] = [];
	for (const ref of [op.source, op.target]) if (ref && 'remote' in ref) names.push(ref.remote);
	return names;
}

/** Whether a folder op has to wait for other queued ops that name its folder. */
function folderOpWaits(op: RemoteOpRow, queued: RemoteOpRow[]): boolean {
	if (!('remote' in op.source)) return false;
	const folder = op.source.remote;
	return queued.some((other) => {
		if (other._id === op._id) return false;
		const names = remoteNames(other);
		if (other.rfc822MessageId !== undefined) return names.some((name) => within(name, folder));
		return (
			other._creationTime < op._creationTime &&
			names.some((name) => within(name, folder) || within(folder, name))
		);
	});
}

/**
 * Up to `pageSize` of the account's due ops that may run now, in due order:
 * each skips the ops still waiting behind an older op (see the module header).
 */
export async function dueRemoteOps(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>,
	now: number,
	pageSize: number
): Promise<RemoteOpRow[]> {
	const byMessage = new Map<string, RemoteOpRow[]>();
	// Every queued op of the account, read once for the folder ops; null when there are too many.
	let queued: RemoteOpRow[] | null | undefined;

	const waits = async (op: RemoteOpRow): Promise<boolean> => {
		if (op.rfc822MessageId === undefined) {
			if (queued === undefined) {
				const rows = await ctx.db
					.query('externalMailRemoteOps')
					.withIndex('by_account_and_next_attempt', (q) => q.eq('accountId', accountId))
					.take(FOLDER_SCAN_LIMIT + 1);
				queued = rows.length > FOLDER_SCAN_LIMIT ? null : rows;
			}
			return queued === null || folderOpWaits(op, queued);
		}
		let ops = byMessage.get(op.rfc822MessageId);
		if (!ops) {
			ops = await opsForMessage(ctx, accountId, op.rfc822MessageId);
			byMessage.set(op.rfc822MessageId, ops);
		}
		for (const older of ops) {
			if (older._id === op._id) return false;
			if (mustPrecede(older, op)) return true;
		}
		return true;
	};

	const page: RemoteOpRow[] = [];
	let skipped = 0;
	for await (const op of ctx.db
		.query('externalMailRemoteOps')
		.withIndex('by_account_and_next_attempt', (q) =>
			q.eq('accountId', accountId).lte('nextAttemptAt', now)
		)) {
		if (await waits(op)) {
			if (++skipped >= DUE_SCAN_LIMIT) break;
			continue;
		}
		page.push(op);
		if (page.length >= pageSize) break;
	}
	return page;
}
