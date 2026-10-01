/**
 * Keeps ops that wait for another op from being due before it
 * (`remoteOpOrder.ts`), so the front of the due index holds ops that can run
 * or that wait for an op which can.
 *
 * - push: an op failed and was pushed back to `until`. Every later op of its
 *   message that waits behind it (or behind one of those) goes back with it,
 *   and so does every folder op waiting for any of them, and every newer
 *   folder op on the branch of one of those.
 * - raise: a new folder op is not due before the queued ops it waits for.
 *
 * However many ops that touches, one transaction reads at most
 * `DEFER_ROWS_PER_RUN` rows. Work left over is carried, as plain data, to a
 * scheduled continuation (`remoteOps.continueRemoteOpDeferral`) that runs
 * until it is done and then nudges the worker.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { remoteOpKindValidator } from '../../lib/validators/mail';
import {
	BELOW_FROM,
	BELOW_TO,
	FOLDER_KINDS,
	MESSAGE_KINDS,
	folderOf,
	remoteNames,
	selfAndAncestors,
} from './remoteFolderOpOrder';

type RemoteOpRow = Doc<'externalMailRemoteOps'>;

/**
 * Rows one transaction reads for deferrals (each query counting at least one)
 * before it hands the rest to a continuation.
 */
const DEFER_ROWS_PER_RUN = 1000;
const FLAG_KEYS = ['seen', 'flagged', 'answered'] as const;

/** One pass over the queued ops naming a remote folder (`name`, or every folder below it). */
const scanValidator = v.object({
	field: v.union(v.literal('source'), v.literal('target')),
	kind: remoteOpKindValidator,
	name: v.string(),
	below: v.boolean(),
	// Only ops created after / before this.
	newerThan: v.optional(v.number()),
	olderThan: v.optional(v.number()),
	// Where the pass got to: the last row read.
	after: v.optional(v.object({ name: v.string(), creation: v.number() })),
});

export const deferralValidator = v.object({
	accountId: v.id('externalMailAccounts'),
	// push: the time the ops found are pushed back to.
	until: v.number(),
	// raise: the op raised to the latest due time of the ops found.
	raise: v.optional(v.id('externalMailRemoteOps')),
	// push: the later ops of a failed op's message still to look at, and what
	// the ones held so far wait on (any non-flag op, or these flags).
	message: v.optional(
		v.object({
			rfc822MessageId: v.string(),
			after: v.number(),
			all: v.boolean(),
			keys: v.array(v.union(v.literal('seen'), v.literal('flagged'), v.literal('answered'))),
		})
	),
	// The passes queued so far and their `newerThan` (-1 for none): a pass over
	// the same ops from the same point on or later adds nothing.
	queued: v.array(v.object({ key: v.string(), from: v.number() })),
	scans: v.array(scanValidator),
});

type Scan = Infer<typeof scanValidator>;
export type Deferral = Infer<typeof deferralValidator>;

/** The rows deferrals may still read in this transaction, and the work they left. */
export type DeferralBudget = { rows: number; leftover: Deferral[] };

export function deferralBudget(): DeferralBudget {
	return { rows: DEFER_ROWS_PER_RUN, leftover: [] };
}

function flagKeys(op: RemoteOpRow): Array<(typeof FLAG_KEYS)[number]> {
	return FLAG_KEYS.filter((key) => op.flags?.[key] !== undefined);
}

/** `d.queued` by key, built once per deferral object. */
const queuedByKey = new WeakMap<Deferral, Map<string, number>>();

/** Queue a pass unless one already queued covers it. */
function queueScan(d: Deferral, scan: Scan): void {
	let queued = queuedByKey.get(d);
	if (!queued) {
		queued = new Map(d.queued.map((q) => [q.key, q.from]));
		queuedByKey.set(d, queued);
	}
	const key = [scan.field, scan.kind, scan.below ? 'below' : 'at', scan.name].join('|');
	const from = scan.newerThan ?? -1;
	const earlier = queued.get(key);
	if (earlier !== undefined && earlier <= from) return;
	queued.set(key, from);
	if (earlier !== undefined) d.queued = d.queued.filter((q) => q.key !== key);
	d.queued.push({ key, from });
	d.scans.push(scan);
}

/** The folder ops waiting for a message op that names `name`: those on it or above it. */
function seedScans(d: Deferral, names: string[]): void {
	for (const name of names) {
		for (const folder of selfAndAncestors(name)) {
			for (const kind of FOLDER_KINDS) {
				queueScan(d, { field: 'source', kind, name: folder, below: false });
			}
		}
	}
}

/** The newer folder ops on the branch of folder op `op`: they run after it. */
function branchScans(d: Deferral, op: RemoteOpRow): void {
	const folder = folderOf(op);
	if (folder === null) return;
	const newerThan = op._creationTime;
	for (const kind of FOLDER_KINDS) {
		for (const name of selfAndAncestors(folder)) {
			queueScan(d, { field: 'source', kind, name, below: false, newerThan });
		}
		queueScan(d, { field: 'source', kind, name: folder, below: true, newerThan });
	}
}

/** Push back what waits for `op`, which failed and is not due before `until`. */
export function pushBehind(op: RemoteOpRow, until: number): Deferral {
	const d: Deferral = { accountId: op.accountId, until, queued: [], scans: [] };
	if (op.rfc822MessageId === undefined) {
		branchScans(d, op);
	} else {
		d.message = {
			rfc822MessageId: op.rfc822MessageId,
			after: op._creationTime,
			all: op.kind !== 'flags',
			keys: flagKeys(op),
		};
		seedScans(d, remoteNames(op));
	}
	return d;
}

/** Push back the folder ops waiting for message op `op`, which is not due before `until`. */
export function pushFolderOpsBehind(op: RemoteOpRow, until: number): Deferral {
	const d: Deferral = { accountId: op.accountId, until, queued: [], scans: [] };
	seedScans(d, remoteNames(op));
	return d;
}

/** Make new folder op `op` not due before the queued ops it waits for. */
export function raiseFolderOp(op: RemoteOpRow): Deferral | null {
	const folder = folderOf(op);
	if (folder === null) return null;
	const d: Deferral = { accountId: op.accountId, until: 0, raise: op._id, queued: [], scans: [] };
	for (const kind of MESSAGE_KINDS) {
		d.scans.push({ field: 'source', kind, name: folder, below: false });
		d.scans.push({ field: 'source', kind, name: folder, below: true });
	}
	d.scans.push({ field: 'target', kind: 'move', name: folder, below: false });
	d.scans.push({ field: 'target', kind: 'move', name: folder, below: true });
	const olderThan = op._creationTime;
	for (const kind of FOLDER_KINDS) {
		for (const name of selfAndAncestors(folder)) {
			d.scans.push({ field: 'source', kind, name, below: false, olderThan });
		}
		d.scans.push({ field: 'source', kind, name: folder, below: true, olderThan });
	}
	return d;
}

/** The remote name a scan's index orders `row` by. */
function scannedName(scan: Scan, row: RemoteOpRow): string {
	const ref = scan.field === 'source' ? row.source : row.target;
	return ref && 'remote' in ref ? ref.remote : '';
}

/** Up to `limit` rows of `scan` after where it got to, in index order. */
async function readScan(
	ctx: MutationCtx,
	accountId: Id<'externalMailAccounts'>,
	scan: Scan,
	limit: number
): Promise<RemoteOpRow[]> {
	const ops = ctx.db.query('externalMailRemoteOps');
	const index =
		scan.field === 'source'
			? ('by_account_kind_and_source_remote' as const)
			: ('by_account_kind_and_target_remote' as const);
	const field = scan.field === 'source' ? ('source.remote' as const) : ('target.remote' as const);
	// One name, from a creation time on.
	const named = (name: string, after: number | undefined, take: number) =>
		ops
			.withIndex(index, (q) => {
				const rows = q.eq('accountId', accountId).eq('kind', scan.kind).eq(field, name);
				return after === undefined ? rows : rows.gt('_creationTime', after);
			})
			.take(take);
	// The names below the scan's folder, from (or after) `from` on.
	const below = (from: string, inclusive: boolean, take: number) =>
		ops
			.withIndex(index, (q) => {
				const kind = q.eq('accountId', accountId).eq('kind', scan.kind);
				return (inclusive ? kind.gte(field, from) : kind.gt(field, from)).lt(
					field,
					scan.name + BELOW_TO
				);
			})
			.take(take);

	if (!scan.below) return await named(scan.name, scan.after?.creation ?? scan.newerThan, limit);
	if (!scan.after) return await below(scan.name + BELOW_FROM, true, limit);
	const rest = await named(scan.after.name, scan.after.creation, limit);
	if (rest.length >= limit) return rest;
	return [...rest, ...(await below(scan.after.name, false, limit - rest.length))];
}

/**
 * Carry out `d` within `budget`. Work left once the budget is spent goes to
 * `budget.leftover`, for the caller to schedule.
 */
export async function runDeferral(
	ctx: MutationCtx,
	d: Deferral,
	budget: DeferralBudget
): Promise<void> {
	const raised = d.raise ? await ctx.db.get(d.raise) : null;
	if (d.raise && !raised) return;
	let raisedTo = raised?.nextAttemptAt ?? 0;

	while (d.message) {
		if (budget.rows <= 0) {
			budget.leftover.push(d);
			return;
		}
		const { message } = d;
		const later = await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_and_message', (q) =>
				q
					.eq('accountId', d.accountId)
					.eq('rfc822MessageId', message.rfc822MessageId)
					.gt('_creationTime', message.after)
			)
			.take(budget.rows);
		budget.rows -= Math.max(1, later.length);
		if (later.length === 0) d.message = undefined;
		for (const newer of later) {
			message.after = newer._creationTime;
			const keys = flagKeys(newer);
			// Waits for a held op: a held non-flag op, a non-flag op itself, or a shared flag.
			if (!message.all && newer.kind === 'flags' && !keys.some((k) => message.keys.includes(k))) {
				continue;
			}
			if (newer.kind !== 'flags') message.all = true;
			for (const key of keys) if (!message.keys.includes(key)) message.keys.push(key);
			if (newer.nextAttemptAt < d.until) {
				await ctx.db.patch(newer._id, { nextAttemptAt: d.until });
			}
			seedScans(d, remoteNames(newer));
		}
	}

	while (d.scans.length > 0) {
		if (budget.rows <= 0) {
			budget.leftover.push(d);
			return;
		}
		const scan = d.scans[0]!;
		const rows = await readScan(ctx, d.accountId, scan, budget.rows);
		budget.rows -= Math.max(1, rows.length);
		if (rows.length === 0) {
			d.scans.shift();
			continue;
		}
		for (const row of rows) {
			scan.after = { name: scannedName(scan, row), creation: row._creationTime };
			if (scan.newerThan !== undefined && row._creationTime <= scan.newerThan) continue;
			if (scan.olderThan !== undefined && row._creationTime >= scan.olderThan) continue;
			if (raised) {
				if (row._id !== raised._id && row.nextAttemptAt > raisedTo) {
					raisedTo = row.nextAttemptAt;
					await ctx.db.patch(raised._id, { nextAttemptAt: raisedTo });
				}
			} else if (row.nextAttemptAt < d.until) {
				await ctx.db.patch(row._id, { nextAttemptAt: d.until });
				branchScans(d, row);
			}
		}
	}
}
