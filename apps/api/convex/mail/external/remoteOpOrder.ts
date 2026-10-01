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
 * A folder rename or delete waits until no message op naming the folder is
 * queued, and runs after any older folder op on the same branch of the tree
 * (`remoteFolderOpOrder.ts`).
 */

import type { WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { deferFolderOpsBehind, folderOpOrder, type Held } from './remoteFolderOpOrder';

type RemoteOpRow = Doc<'externalMailRemoteOps'>;
type FlagChanges = NonNullable<RemoteOpRow['flags']>;

const FLAG_KEYS = ['seen', 'flagged', 'answered'] as const;
/** A message's queued ops its order is decided from; an op further back than this waits. */
const MESSAGE_OPS_LIMIT = 25;
/** Held due ops one read steps over before it follows them to what they wait for. */
const DUE_SCAN_LIMIT = 250;
/** Ops one read follows from the held ops to what they wait for. */
const LEAD_STEPS_LIMIT = 100;
/** Later ops of a message one failed op looks at to push back with it. */
const DEFER_LIMIT = 500;

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
 * the due index with ops that every read would only step over. The folder ops
 * that wait for it are pushed back the same way.
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
	const id = await ctx.db.insert('externalMailRemoteOps', { ...op, nextAttemptAt });
	if (nextAttemptAt > op.nextAttemptAt) {
		// Queued behind a pushed-back op: so are the folder ops that wait for this one.
		const row = await ctx.db.get(id);
		if (row) await deferFolderOpsBehind(ctx, [row], nextAttemptAt);
	}
}

/**
 * A failed op was pushed back to `until`: push the later ops of its message
 * that wait behind it (or behind one of those) along with it, and the folder
 * ops that wait for any of them (see `insertRemoteOp`).
 */
export async function deferOpsBehind(
	ctx: MutationCtx,
	op: RemoteOpRow,
	until: number
): Promise<void> {
	const held = [op];
	if (op.rfc822MessageId !== undefined) {
		const later = ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_and_message', (q) =>
				q
					.eq('accountId', op.accountId)
					.eq('rfc822MessageId', op.rfc822MessageId)
					.gt('_creationTime', op._creationTime)
			);
		let read = 0;
		for await (const newer of later) {
			if (++read > DEFER_LIMIT) break;
			if (!held.some((older) => mustPrecede(older, newer))) continue;
			held.push(newer);
			if (newer.nextAttemptAt < until) await ctx.db.patch(newer._id, { nextAttemptAt: until });
		}
	}
	await deferFolderOpsBehind(ctx, held, until);
}

/**
 * Up to `pageSize` of the account's due ops that may run now, in due order:
 * each skips the ops still waiting behind an older op (see the module header).
 *
 * A read steps over at most `DUE_SCAN_LIMIT` held ops. Each held op names the
 * op it waits for, and when the page is not full those are followed until one
 * that may run turns up, even past where the scan stopped. Waiting is acyclic
 * (behind older ops of a message, behind message ops for a folder, behind older
 * folder ops), so the front of the queue always leads to an op that can run
 * now or to one that was pushed back, and the ops waiting for a pushed-back op
 * are pushed back with it (`deferOpsBehind`), out of the way of the rest.
 */
export async function dueRemoteOps(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>,
	now: number,
	pageSize: number
): Promise<RemoteOpRow[]> {
	const byMessage = new Map<string, RemoteOpRow[]>();
	const folderOpHeld = folderOpOrder(ctx, accountId);
	const verdicts = new Map<Id<'externalMailRemoteOps'>, Held | null>();

	const messageOpHeld = async (op: RemoteOpRow, messageId: string): Promise<Held | null> => {
		let ops = byMessage.get(messageId);
		if (!ops) {
			ops = await opsForMessage(ctx, accountId, messageId);
			byMessage.set(messageId, ops);
		}
		for (const older of ops) {
			if (older._id === op._id) return null;
			if (mustPrecede(older, op)) return { lead: older };
		}
		// Further back than the ops read for its message: it waits its turn.
		return { lead: ops[0] };
	};
	const held = async (op: RemoteOpRow): Promise<Held | null> => {
		if (!verdicts.has(op._id)) {
			verdicts.set(
				op._id,
				op.rfc822MessageId === undefined
					? await folderOpHeld(op)
					: await messageOpHeld(op, op.rfc822MessageId)
			);
		}
		return verdicts.get(op._id) ?? null;
	};

	const page: RemoteOpRow[] = [];
	const leads: RemoteOpRow[] = [];
	let skipped = 0;
	for await (const op of ctx.db
		.query('externalMailRemoteOps')
		.withIndex('by_account_and_next_attempt', (q) =>
			q.eq('accountId', accountId).lte('nextAttemptAt', now)
		)) {
		const wait = await held(op);
		if (wait === null) {
			page.push(op);
			if (page.length >= pageSize) return page;
			continue;
		}
		if (wait.lead) leads.push(wait.lead);
		if (++skipped >= DUE_SCAN_LIMIT) break;
	}

	// Follow each held op to what it waits for; one of those may run now.
	const handedOut = new Set(page.map((op) => op._id));
	let steps = 0;
	for (const lead of leads) {
		let next: RemoteOpRow | undefined = lead;
		while (next && !handedOut.has(next._id) && next.nextAttemptAt <= now) {
			if (++steps > LEAD_STEPS_LIMIT) return page;
			const wait = await held(next);
			if (wait === null) {
				page.push(next);
				handedOut.add(next._id);
				if (page.length >= pageSize) return page;
				break;
			}
			next = wait.lead;
		}
	}
	return page;
}
