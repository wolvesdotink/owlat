/**
 * The reducer's writer: the difference between the rows a fold started from
 * and the in-memory state it ended with (`replay.ts`), written in the
 * reducer's transaction, with one activity row per changed item and the item
 * counters adjusted (`counters.ts`).
 *
 *   - a new item or fact is inserted with its lineage, text and quotes sealed;
 *   - a changed item gets its derived fields (status, disposition, completion,
 *     quotes, deadline, amount, options, verify, review flag, possible
 *     duplicate) and a new revision; fields people own (correction, assignee,
 *     reminder, commitment) are never touched;
 *   - in a REPLAY, an item or fact an earlier extraction created that the
 *     replay no longer produces is retired (superseded / retracted), unless a
 *     person corrected it.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ActivityType, InterpretMode, ItemStatus } from '@owlat/shared/threadBrief';
import type { Evidence } from '../../lib/validators/threadBrief';
import { threadRefToFields, type ThreadRef } from '../../lib/validators/threadRef';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { appendActivity } from './activity';
import {
	applyItemShifts,
	itemBucketOf,
	itemSortKey,
	listBucketOf,
	type ItemBucket,
} from './counters';
import { counterpartyKeyOf, evidenceKey, responsibilityOf } from './reducePlan';
import {
	sameEvidence,
	type MemEvidence,
	type MemFact,
	type MemItem,
	type MemState,
} from './replay';
import type { ReduceFact } from './reduceInput';

const STATUS_LOCKING = new Set(['markedDone', 'reopened', 'untracked', 'notARequest']);

export interface WriteArgs {
	ref: ThreadRef;
	mode: InterpretMode;
	briefId: Id<'threadBriefs'>;
	after: MemState;
	rows: ReadonlyMap<string, Doc<'threadItems'>>;
	factRows: ReadonlyMap<string, Doc<'threadFacts'>>;
	isRebuild: boolean;
	/** Activity idempotency prefix of this application. */
	keyBase: string;
	eventAt: number;
	mailboxId?: Id<'mailboxes'>;
	/** Team thread assignee: the default assignee of new items (D4). */
	assigneeUserId?: string;
	now: number;
}

async function sealEvidence(
	evidence: readonly MemEvidence[],
	stored: readonly Evidence[] = []
): Promise<Evidence[]> {
	const byKey = new Map(stored.map((e) => [evidenceKey(e), e]));
	return Promise.all(
		evidence.map(async ({ isPlain, ...e }) => {
			const kept = byKey.get(evidenceKey(e));
			if (kept) return kept;
			return isPlain && e.quote !== undefined ? { ...e, quote: await sealBodyAtWrite(e.quote) } : e;
		})
	);
}

async function sealDisplay(display: { en: string; de: string }) {
	return { en: await sealBodyAtWrite(display.en), de: await sealBodyAtWrite(display.de) };
}

async function sealFactValue(value: ReduceFact['value']): Promise<Doc<'threadFacts'>['value']> {
	if (!value) return undefined;
	if (value.kind === 'date' || value.kind === 'money') return value;
	return { kind: value.kind, text: await sealBodyAtWrite(value.text) };
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function statusActivity(from: ItemStatus, to: ItemStatus): ActivityType {
	if (to === 'open') return 'item_reopened';
	if (to === 'superseded') return 'item_replaced';
	if (from !== to) return 'item_closed';
	return 'item_changed';
}

/** Write the state difference. Returns the ids of the items it inserted. */
export async function writeState(ctx: MutationCtx, args: WriteArgs): Promise<Id<'threadItems'>[]> {
	const created: Id<'threadItems'>[] = [];
	const shifts: Array<[ItemBucket | null, ItemBucket | null]> = [];
	const itemIds = new Map<string, Id<'threadItems'>>();
	const factIds = new Map<string, Id<'threadFacts'>>();
	const resolveItem = (id: string | undefined) =>
		id === undefined
			? undefined
			: id.startsWith('new:')
				? itemIds.get(id)
				: (id as Id<'threadItems'>);
	const resolveFact = (id: string | undefined) =>
		id === undefined
			? undefined
			: id.startsWith('new:')
				? factIds.get(id)
				: (id as Id<'threadFacts'>);
	const activity = { threadRef: args.ref, mode: args.mode, eventAt: args.eventAt };
	const actor = { kind: 'system' as const };

	for (const item of args.after.items.values()) {
		if (item.isNew) {
			const id = await insertItem(ctx, args, item, resolveItem(item.possibleDuplicateOfId));
			if (!id) continue;
			itemIds.set(item._id, id);
			created.push(id);
			const responsible = item.proposal?.responsible ?? { isUs: false };
			shifts.push([
				null,
				itemBucketOf({
					status: item.status,
					responsibility: responsibilityOf(responsible),
					verify: item.verify,
				}),
			]);
			await appendActivity(ctx, {
				...activity,
				idempotencyKey: `${args.keyBase}:item:${item.lineage ?? id}`,
				type: 'item_opened',
				actor,
				provenance: 'reported',
				itemId: id,
				itemRevision: 1,
			});
			continue;
		}
		const row = args.rows.get(item._id);
		if (row) await patchItem(ctx, args, row, item, resolveItem(item.possibleDuplicateOfId), shifts);
	}

	if (args.isRebuild) {
		for (const row of args.rows.values()) {
			if (!row.lineage || args.after.items.has(row._id) || row.status === 'superseded') continue;
			if (row.correction && STATUS_LOCKING.has(row.correction.kind)) continue;
			const revision = row.revision + 1;
			await ctx.db.patch(row._id, {
				status: 'superseded',
				listBucket: 'closed',
				completion: undefined,
				revision,
				updatedAt: args.now,
			});
			shifts.push([itemBucketOf(row), 'closed']);
			await appendActivity(ctx, {
				...activity,
				idempotencyKey: `${args.keyBase}:item:${row._id}`,
				type: 'item_replaced',
				actor,
				provenance: 'reported',
				itemId: row._id,
				itemRevision: revision,
				delta: { statusFrom: row.status, statusTo: 'superseded' },
			});
		}
	}
	if (shifts.length > 0) await applyItemShifts(ctx, args.briefId, shifts);

	if (args.mode === 'brief' && args.ref.kind === 'mail') {
		for (const fact of args.after.facts.values()) {
			if (fact.isNew) {
				const id = await insertFact(
					ctx,
					args,
					fact,
					resolveFact(fact.supersedesId),
					resolveFact(fact.conflictsWithId)
				);
				if (!id) continue;
				factIds.set(fact._id, id);
				if (fact.supersedesId || fact.conflictsWithId) {
					await appendActivity(ctx, {
						...activity,
						idempotencyKey: `${args.keyBase}:fact:${fact.lineage ?? id}`,
						type: 'fact_changed',
						actor,
						provenance: 'reported',
						delta: { factId: id },
					});
				}
				continue;
			}
			const row = args.factRows.get(fact._id);
			if (row)
				await patchFact(
					ctx,
					args,
					row,
					fact,
					resolveFact(fact.supersedesId),
					resolveFact(fact.conflictsWithId)
				);
		}
		if (args.isRebuild) {
			for (const row of args.factRows.values()) {
				if (!row.lineage || args.after.facts.has(row._id) || row.status === 'retracted') continue;
				await ctx.db.patch(row._id, {
					status: 'retracted',
					revision: row.revision + 1,
					updatedAt: args.now,
				});
			}
		}
	}
	return created;
}

async function insertItem(
	ctx: MutationCtx,
	args: WriteArgs,
	item: MemItem,
	possibleDuplicateOfId: Id<'threadItems'> | undefined
): Promise<Id<'threadItems'> | null> {
	const p = item.proposal;
	if (!p) return null;
	const counterpartyKey = counterpartyKeyOf(p);
	const responsibility = responsibilityOf(p.responsible);
	const id = await ctx.db.insert('threadItems', {
		...threadRefToFields(args.ref),
		...(args.mailboxId ? { mailboxId: args.mailboxId } : {}),
		revision: 1,
		intent: p.intent,
		facets: p.facets,
		...(p.consequences ? { consequences: p.consequences } : {}),
		assertion: await sealBodyAtWrite(p.assertion),
		display: await sealDisplay(p.display),
		requester: p.requester,
		responsible: p.responsible,
		...(p.beneficiary ? { beneficiary: p.beneficiary } : {}),
		responsibility,
		...(args.ref.kind === 'team' && args.assigneeUserId
			? { assigneeUserId: args.assigneeUserId }
			: {}),
		status: item.status,
		disposition: item.disposition,
		...(item.completion ? { completion: item.completion } : {}),
		...(item.due ? { due: item.due } : {}),
		...(item.amount ? { amount: item.amount } : {}),
		...(item.options ? { options: item.options } : {}),
		evidence: await sealEvidence(item.evidence),
		...(possibleDuplicateOfId ? { possibleDuplicateOfId } : {}),
		verify: item.verify,
		listBucket: listBucketOf({ status: item.status, responsibility, verify: item.verify }),
		...(item.isReviewNeeded ? { isReviewNeeded: true } : {}),
		...(counterpartyKey ? { counterpartyKey } : {}),
		...(item.lineage ? { lineage: item.lineage } : {}),
		askedAt: item.askedAt,
		createdAt: args.now,
		updatedAt: args.now,
	});
	// The order key ends in the id, known only now.
	await ctx.db.patch(id, {
		sortKey: itemSortKey({ _id: id, due: item.due, facets: p.facets, askedAt: item.askedAt }),
	});
	return id;
}

async function patchItem(
	ctx: MutationCtx,
	args: WriteArgs,
	row: Doc<'threadItems'>,
	item: MemItem,
	possibleDuplicateOfId: Id<'threadItems'> | undefined,
	shifts: Array<[ItemBucket | null, ItemBucket | null]>
): Promise<void> {
	const patch: Partial<Doc<'threadItems'>> = {};
	if (item.status !== row.status) patch.status = item.status;
	if (item.completion !== row.completion) patch.completion = item.completion;
	if (item.disposition !== row.disposition) patch.disposition = item.disposition;
	if (item.verify !== row.verify) patch.verify = item.verify;
	if ((item.isReviewNeeded === true) !== (row.isReviewNeeded === true)) {
		patch.isReviewNeeded = item.isReviewNeeded === true ? true : undefined;
	}
	if (!same(item.due, row.due)) patch.due = item.due;
	if (!same(item.amount, row.amount)) patch.amount = item.amount;
	if (!same(item.options, row.options)) patch.options = item.options;
	if (possibleDuplicateOfId !== row.possibleDuplicateOfId && args.isRebuild) {
		patch.possibleDuplicateOfId = possibleDuplicateOfId;
	}
	if (!sameEvidence(item.evidence, row.evidence)) {
		patch.evidence = await sealEvidence(item.evidence, row.evidence);
	}
	const p = item.proposal;
	let responsibility = row.responsibility;
	if (
		p &&
		args.isRebuild &&
		item.storedAssertionText !== undefined &&
		p.assertion !== item.storedAssertionText
	) {
		responsibility = responsibilityOf(p.responsible);
		Object.assign(patch, {
			intent: p.intent,
			facets: p.facets,
			consequences: p.consequences,
			assertion: await sealBodyAtWrite(p.assertion),
			display: await sealDisplay(p.display),
			requester: p.requester,
			responsible: p.responsible,
			beneficiary: p.beneficiary,
			responsibility,
		});
	}
	const after = { status: item.status, responsibility, verify: item.verify };
	const listBucket = listBucketOf(after);
	const sortKey = itemSortKey({
		_id: row._id,
		due: 'due' in patch ? patch.due : row.due,
		facets: patch.facets ?? row.facets,
		askedAt: row.askedAt,
	});
	const derived = {
		...(listBucket !== row.listBucket ? { listBucket } : {}),
		...(sortKey !== row.sortKey ? { sortKey } : {}),
	};
	if (Object.keys(patch).length === 0) {
		// A row stored before these existed: fill them in, no revision or activity.
		if (Object.keys(derived).length > 0) await ctx.db.patch(row._id, derived);
		return;
	}
	Object.assign(patch, derived);
	const revision = row.revision + 1;
	await ctx.db.patch(row._id, { ...patch, revision, updatedAt: args.now });
	shifts.push([itemBucketOf(row), itemBucketOf(after)]);
	const statusChanged = item.status !== row.status;
	const dispositionChanged = item.disposition !== row.disposition;
	await appendActivity(ctx, {
		threadRef: args.ref,
		mode: args.mode,
		eventAt: args.eventAt,
		idempotencyKey: `${args.keyBase}:item:${row._id}`,
		type: statusChanged ? statusActivity(row.status, item.status) : 'item_changed',
		actor: { kind: 'system' },
		provenance: 'reported',
		itemId: row._id,
		itemRevision: revision,
		...(statusChanged || dispositionChanged
			? {
					delta: {
						...(statusChanged ? { statusFrom: row.status, statusTo: item.status } : {}),
						...(statusChanged && item.completion ? { completion: item.completion } : {}),
						...(dispositionChanged
							? { dispositionFrom: row.disposition, dispositionTo: item.disposition }
							: {}),
					},
				}
			: {}),
	});
}

async function insertFact(
	ctx: MutationCtx,
	args: WriteArgs,
	fact: MemFact,
	supersedesId: Id<'threadFacts'> | undefined,
	conflictsWithId: Id<'threadFacts'> | undefined
): Promise<Id<'threadFacts'> | null> {
	const f = fact.proposal;
	if (!f) return null;
	return ctx.db.insert('threadFacts', {
		...threadRefToFields(args.ref),
		factKey: f.key,
		assertion: await sealBodyAtWrite(f.assertion),
		display: await sealDisplay(f.display),
		...(f.value ? { value: await sealFactValue(f.value) } : {}),
		evidence: await sealEvidence(fact.evidence),
		provenance: 'reported',
		...(supersedesId ? { supersedesId } : {}),
		...(conflictsWithId ? { conflictsWithId } : {}),
		status: fact.status,
		...(fact.lineage ? { lineage: fact.lineage } : {}),
		revision: 1,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

async function patchFact(
	ctx: MutationCtx,
	args: WriteArgs,
	row: Doc<'threadFacts'>,
	fact: MemFact,
	supersedesId: Id<'threadFacts'> | undefined,
	conflictsWithId: Id<'threadFacts'> | undefined
): Promise<void> {
	const patch: Partial<Doc<'threadFacts'>> = {};
	if (fact.status !== row.status) patch.status = fact.status;
	if (!sameEvidence(fact.evidence, row.evidence)) {
		patch.evidence = await sealEvidence(fact.evidence, row.evidence);
	}
	if (args.isRebuild) {
		if (supersedesId !== row.supersedesId) patch.supersedesId = supersedesId;
		if (conflictsWithId !== row.conflictsWithId) patch.conflictsWithId = conflictsWithId;
		const f = fact.proposal;
		if (f && fact.storedAssertionText !== undefined && f.assertion !== fact.storedAssertionText) {
			Object.assign(patch, {
				factKey: f.key,
				assertion: await sealBodyAtWrite(f.assertion),
				display: await sealDisplay(f.display),
				value: await sealFactValue(f.value),
			});
		}
	}
	if (Object.keys(patch).length === 0) return;
	await ctx.db.patch(row._id, { ...patch, revision: row.revision + 1, updatedAt: args.now });
}
