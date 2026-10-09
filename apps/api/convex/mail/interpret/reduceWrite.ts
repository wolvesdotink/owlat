/**
 * The reducer's writer: the difference between the rows a fold started from
 * and the in-memory state it ended with (`fold.ts`), written in the
 * reducer's transaction, with one activity row per changed item and the item
 * counters adjusted (`counters.ts`).
 *
 *   - a new item or fact is inserted with its lineage, text and quotes sealed;
 *   - a changed item gets its derived fields (status, disposition, completion,
 *     quotes, deadline, amount, options, verify, review flag, possible
 *     duplicate) and a new revision; fields people own (correction, assignee,
 *     reminder, commitment) are never touched;
 *   - a promoted proposal takes its verified claim's text, display and
 *     parties field by field; a same-source fact re-read likewise;
 *   - nothing is ever retired by omission (round 4 M1, `fold.ts`).
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
import { evidenceKey } from './reducePlan';
import { counterpartyKeyOf, responsibilityOf } from './parties';
import { exactValueKey } from './factEquivalence';
import {
	sameEvidence,
	type MemEvidence,
	type MemFact,
	type MemHeld,
	type MemItem,
	type MemState,
} from './fold';
import type { ReduceFact } from './reduceInput';

export interface WriteArgs {
	ref: ThreadRef;
	mode: InterpretMode;
	briefId: Id<'threadBriefs'>;
	after: MemState;
	rows: ReadonlyMap<string, Doc<'threadItems'>>;
	factRows: ReadonlyMap<string, Doc<'threadFacts'>>;
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

/** JSON with sorted keys: the same value whatever order its fields were written in. */
function canon(value: unknown): string {
	return JSON.stringify(value ?? null, (_key, v: unknown) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
			: v
	);
}

const HELD_VALUE_KEYS = [
	'due',
	'amount',
	'options',
	'requester',
	'responsible',
	'beneficiary',
	'responsibility',
	'removes',
	'transitions',
] as const;

/**
 * Same held update as stored? Quotes by identity, wording against the stored
 * wording as opened at load (`storedPending`), every other field by value.
 */
function samePending(item: MemItem, row: Doc<'threadItems'>['pendingUpdate']): boolean {
	const a = item.pendingUpdate;
	if (!a || !row) return !a && !row;
	return (
		sameEvidence(a.evidence, row.evidence) &&
		HELD_VALUE_KEYS.every((key) => canon(a[key]) === canon(row[key])) &&
		a.assertion === item.storedPending?.assertion &&
		canon(a.display) === canon(item.storedPending?.display)
	);
}

/** A held update as stored: wording and new quotes sealed. */
async function sealHeld(
	held: MemHeld,
	stored?: Doc<'threadItems'>['pendingUpdate']
): Promise<NonNullable<Doc<'threadItems'>['pendingUpdate']>> {
	const { evidence, assertion, display, ...rest } = held;
	return {
		...rest,
		evidence: await sealEvidence(evidence, stored?.evidence),
		...(assertion !== undefined ? { assertion: await sealBodyAtWrite(assertion) } : {}),
		...(display ? { display: await sealDisplay(display) } : {}),
	};
}

function statusActivity(from: ItemStatus, to: ItemStatus): ActivityType {
	if (to === 'open') return 'item_reopened';
	if (to === 'superseded') return 'item_replaced';
	if (from !== to) return 'item_closed';
	return 'item_changed';
}

/**
 * Write the state difference. Returns the ids of the items it inserted and
 * every in-memory id it gave a row (`new:…` → the inserted row's id).
 */
export async function writeState(
	ctx: MutationCtx,
	args: WriteArgs
): Promise<{ created: Id<'threadItems'>[]; ids: Map<string, string> }> {
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
			if (item.status !== 'open') {
				// Born closed: a completion read before its request (round 5 F7).
				await appendActivity(ctx, {
					...activity,
					idempotencyKey: `${args.keyBase}:item:${item.lineage ?? id}:${item.status}`,
					type: statusActivity('open', item.status),
					actor,
					provenance: 'reported',
					itemId: id,
					itemRevision: 1,
					delta: {
						statusFrom: 'open',
						statusTo: item.status,
						...(item.completion ? { completion: item.completion } : {}),
					},
				});
			}
			continue;
		}
		const row = args.rows.get(item._id);
		if (row) await patchItem(ctx, args, row, item, shifts);
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
			if (row) await patchFact(ctx, args, row, fact);
		}
	}
	return { created, ids: new Map<string, string>([...itemIds, ...factIds]) };
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
		...(item.lastTransitionAt !== undefined ? { lastTransitionAt: item.lastTransitionAt } : {}),
		...(item.statusSource ? { statusSource: item.statusSource } : {}),
		...(item.dispositionSource ? { dispositionSource: item.dispositionSource } : {}),
		...(item.due ? { due: item.due } : {}),
		...(item.amount ? { amount: item.amount } : {}),
		...(item.options ? { options: item.options } : {}),
		evidence: await sealEvidence(item.evidence),
		...(item.pendingUpdate ? { pendingUpdate: await sealHeld(item.pendingUpdate) } : {}),
		...(possibleDuplicateOfId ? { possibleDuplicateOfId } : {}),
		verify: item.verify,
		listBucket: listBucketOf({ status: item.status, responsibility, verify: item.verify }),
		...(item.isReviewNeeded ? { isReviewNeeded: true } : {}),
		...(counterpartyKey ? { counterpartyKey } : {}),
		...(item.lineage ? { lineage: item.lineage } : {}),
		...(item.lineageKeys?.length ? { lineageKeys: item.lineageKeys } : {}),
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
	shifts: Array<[ItemBucket | null, ItemBucket | null]>
): Promise<void> {
	const patch: Partial<Doc<'threadItems'>> = {};
	if (item.status !== row.status) patch.status = item.status;
	if (item.completion !== row.completion) patch.completion = item.completion;
	if (item.disposition !== row.disposition) patch.disposition = item.disposition;
	if (item.lastTransitionAt !== row.lastTransitionAt) {
		patch.lastTransitionAt = item.lastTransitionAt;
	}
	if (!same(item.statusSource, row.statusSource)) patch.statusSource = item.statusSource;
	if (!same(item.dispositionSource, row.dispositionSource)) {
		patch.dispositionSource = item.dispositionSource;
	}
	if (item.verify !== row.verify) patch.verify = item.verify;
	if ((item.isReviewNeeded === true) !== (row.isReviewNeeded === true)) {
		patch.isReviewNeeded = item.isReviewNeeded === true ? true : undefined;
	}
	if (!same(item.due, row.due)) patch.due = item.due;
	if (!same(item.amount, row.amount)) patch.amount = item.amount;
	if (!same(item.options, row.options)) patch.options = item.options;
	if (!same(item.redactedFields, row.redactedFields)) patch.redactedFields = item.redactedFields;
	if (!sameEvidence(item.evidence, row.evidence)) {
		patch.evidence = await sealEvidence(item.evidence, row.evidence);
	}
	// The identity record is bookkeeping: written, but no revision or activity of its own.
	const lineageKeys =
		item.lineageKeys && !same([...item.lineageKeys].sort(), [...(row.lineageKeys ?? [])].sort())
			? item.lineageKeys
			: undefined;
	if (!samePending(item, row.pendingUpdate)) {
		patch.pendingUpdate = item.pendingUpdate
			? await sealHeld(item.pendingUpdate, row.pendingUpdate)
			: undefined;
	}
	// A replayed proposal: each derived field is compared and updated on its own
	// (review round 2 F5), so a repair that corrects only the owner, the facets
	// or the wording still lands.
	const p = item.proposal;
	let responsibility = row.responsibility;
	if (p) {
		responsibility = responsibilityOf(p.responsible);
		if (p.intent !== row.intent) patch.intent = p.intent;
		if (!same(p.facets, row.facets)) patch.facets = p.facets;
		if (!same(p.consequences, row.consequences)) patch.consequences = p.consequences;
		if (!same(p.requester, row.requester)) patch.requester = p.requester;
		if (!same(p.responsible, row.responsible)) patch.responsible = p.responsible;
		if (!same(p.beneficiary, row.beneficiary)) patch.beneficiary = p.beneficiary;
		if (responsibility !== row.responsibility) patch.responsibility = responsibility;
		const counterpartyKey = counterpartyKeyOf(p);
		if (counterpartyKey !== row.counterpartyKey) patch.counterpartyKey = counterpartyKey;
		if (item.storedAssertionText === undefined || p.assertion !== item.storedAssertionText) {
			patch.assertion = await sealBodyAtWrite(p.assertion);
		}
		if (!same(p.display, item.storedDisplay)) patch.display = await sealDisplay(p.display);
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
		...(lineageKeys ? { lineageKeys } : {}),
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
	fact: MemFact
): Promise<void> {
	const patch: Partial<Doc<'threadFacts'>> = {};
	if (fact.status !== row.status) patch.status = fact.status;
	if (!same(fact.redactedFields, row.redactedFields)) patch.redactedFields = fact.redactedFields;
	if (!sameEvidence(fact.evidence, row.evidence)) {
		patch.evidence = await sealEvidence(fact.evidence, row.evidence);
	}
	{
		// A same-source re-read replaced the claim: each field on its own (a
		// corrected amount with the same wording, one locale's display, a value
		// the re-read no longer gives).
		const f = fact.proposal;
		if (f) {
			if (f.key !== row.factKey) patch.factKey = f.key;
			if (fact.storedAssertionText === undefined || f.assertion !== fact.storedAssertionText) {
				patch.assertion = await sealBodyAtWrite(f.assertion);
			}
			if (!same(f.display, fact.storedDisplay)) patch.display = await sealDisplay(f.display);
			if (exactValueKey(f.value) !== fact.storedValueKey) {
				patch.value = await sealFactValue(f.value);
			}
		}
	}
	if (Object.keys(patch).length === 0) return;
	await ctx.db.patch(row._id, { ...patch, revision: row.revision + 1, updatedAt: args.now });
}
