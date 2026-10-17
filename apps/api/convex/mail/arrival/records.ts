/**
 * Read on arrival (SPEC §2.8): the arrival record, one row per live inbound
 * message of a personal Postbox mailbox.
 *
 * Delivery writes it ({@link writeArrivalRecord}, from the post-insert tail,
 * after filters and sender status). Every other writer patches only its own
 * fields, in its own mutation, and recomputes the thread's projection in that
 * same mutation (`projection.ts`):
 *
 *   - category refinement: category, categorySource ({@link noteRecordCategory})
 *   - the interpretation run: depth, modelCalls, reasonKeys, degradedBy
 *     ({@link noteArrivalRun})
 *   - delivery: filterMatches (lane rules)
 *
 * Convex mutations are serializable, so field-scoped patches cannot lose each
 * other. A run's result lands only while the record still exists: a purged
 * message took its record along, and the patch is a no-op.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Depth, DegradedBy, ReasonKey } from '@owlat/shared/arrival';
import { ARRIVAL_DEPTH_REASONS } from '@owlat/shared/arrivalDepth';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { isPersonalMailbox } from '../permissions';
import { sourceOrderKey } from '../interpret/sourceOrder';
import { ARRIVAL_RETENTION_MS } from './changeRows';
import { refreshArrivalProjection } from './projection';

type ArrivalRecord = Doc<'mailArrivalRecords'>;

/** Reason keys one record keeps; a later writer's key never pushes out an earlier one twice. */
const MAX_REASON_KEYS = 12;

/** What the live-ingest rules pass hands the record (lane rules, SPEC §6.2). */
export interface ArrivalRecordSeed {
	pendingAiFilters?: ArrivalRecord['pendingAiFilters'];
	rulePlacement?: ArrivalRecord['rulePlacement'];
	exclusiveWinners?: ArrivalRecord['exclusiveWinners'];
	filterMatches?: ArrivalRecord['filterMatches'];
	/** The rule operation that set `rulePlacement` (its undo guard, §4.4). */
	lastOperationId?: ArrivalRecord['lastOperationId'];
}

/** A message's arrival record, or null. */
export async function loadArrivalRecord(
	ctx: Pick<QueryCtx, 'db'>,
	messageId: Id<'mailMessages'>
): Promise<ArrivalRecord | null> {
	return ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_message', (q) => q.eq('messageId', messageId))
		.first();
}

/** The thread's newest inbound record (by `sourceOrderKey`), or null. */
export async function newestArrivalRecord(
	ctx: Pick<QueryCtx, 'db'>,
	threadId: Id<'mailThreads'>
): Promise<ArrivalRecord | null> {
	return ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_thread_source_order', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();
}

/**
 * Write the arrival record of a message delivery just inserted. Only live
 * inbound mail of a personal mailbox gets one; the owner's own copies, a
 * history import and shared mailboxes do not. Idempotent: a second call finds
 * the row. Returns it, or null. The caller projects the thread once its other
 * delivery writes are in (`deliveryPipeline/afterInsert.ts`).
 */
export async function writeArrivalRecord(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	opts: { isLive: boolean } & ArrivalRecordSeed
): Promise<ArrivalRecord | null> {
	if (!opts.isLive) return null;
	const mailbox = await ctx.db.get(message.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return null;
	if (isFromMailboxOwner(message, mailbox.address)) return null;
	const existing = await loadArrivalRecord(ctx, message._id);
	if (existing) return existing;
	const now = Date.now();
	const id = await ctx.db.insert('mailArrivalRecords', {
		mailboxId: message.mailboxId,
		threadId: message.threadId,
		messageId: message._id,
		sourceKey: interpretationSourceKey({ kind: 'mail', id: message._id }),
		sourceOrderKey: sourceOrderKey(message),
		...(opts.pendingAiFilters?.length ? { pendingAiFilters: opts.pendingAiFilters } : {}),
		...(opts.rulePlacement ? { rulePlacement: opts.rulePlacement } : {}),
		...(opts.exclusiveWinners ? { exclusiveWinners: opts.exclusiveWinners } : {}),
		...(opts.filterMatches?.length ? { filterMatches: opts.filterMatches } : {}),
		...(opts.lastOperationId ? { lastOperationId: opts.lastOperationId } : {}),
		modelCalls: 0,
		reasonKeys: [],
		createdAt: now,
		updatedAt: now,
		expiresAt: now + ARRIVAL_RETENTION_MS.arrivalRecord,
	});
	return ctx.db.get(id);
}

/** `existing` with `added` appended, one entry per key (the first one kept), bounded. */
export function appendReasonKeys(existing: readonly ReasonKey[], added: readonly ReasonKey[]) {
	const seen = new Set(existing.map((r) => r.key));
	const next = [...existing];
	for (const reason of added) {
		if (seen.has(reason.key)) continue;
		seen.add(reason.key);
		next.push(reason);
	}
	return next.slice(0, MAX_REASON_KEYS);
}

/**
 * The run's fields (§2.8): the depth it read at, the model calls it made and
 * why. Reason keys are appended (sender status writes its own). Then the
 * projection is recomputed. A message without a record (no longer there, or
 * never one) is left alone. Returns whether a record was patched.
 */
export async function noteArrivalRun(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	run: {
		depth: Depth;
		reasonKeys?: readonly ReasonKey[];
		modelCalls?: number;
		degradedBy?: DegradedBy;
	}
): Promise<boolean> {
	const record = await loadArrivalRecord(ctx, messageId);
	if (!record) return false;
	await ctx.db.patch(record._id, {
		depth: run.depth,
		modelCalls: record.modelCalls + (run.modelCalls ?? 0),
		reasonKeys: appendReasonKeys(record.reasonKeys, run.reasonKeys ?? []),
		...(run.degradedBy ? { degradedBy: run.degradedBy } : {}),
		updatedAt: Date.now(),
	});
	await refreshArrivalProjection(ctx, record.threadId);
	return true;
}

/** The run's skips that are rows 1 and 5 of the depth table (§2.2), by skip reason. */
const SKIP_DEPTH_REASONS: Readonly<Record<string, string>> = {
	ineligible: ARRIVAL_DEPTH_REASONS.ineligible,
	bulk: ARRIVAL_DEPTH_REASONS.ineligible,
	security: ARRIVAL_DEPTH_REASONS.security,
};

/**
 * A run that skipped the message before any depth decision (bulk mail from a
 * stranger, a muted thread, security mail flagged by the guard) read it at
 * depth `none`: the record says so, instead of "not read yet" for good.
 * Only a record without a depth gets one. A later skip (a rerun after the
 * thread was reclassified) never replaces what an earlier read recorded.
 */
export async function noteArrivalSkip(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	skipReason: string | undefined
): Promise<void> {
	const key = skipReason ? SKIP_DEPTH_REASONS[skipReason] : undefined;
	if (!key) return;
	const record = await loadArrivalRecord(ctx, messageId);
	if (!record || record.depth !== undefined) return;
	await noteArrivalRun(ctx, messageId, { depth: 'none', reasonKeys: [{ key }] });
}

/**
 * Category refinement's fields: the thread's category was just written, and
 * it is the category of its newest inbound message, whose record takes it.
 */
export async function noteRecordCategory(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	category: {
		label: NonNullable<ArrivalRecord['category']>;
		source: ArrivalRecord['categorySource'];
	}
): Promise<void> {
	const record = await newestArrivalRecord(ctx, threadId);
	if (!record) return;
	if (record.category !== category.label || record.categorySource !== category.source) {
		await ctx.db.patch(record._id, {
			category: category.label,
			...(category.source ? { categorySource: category.source } : {}),
			updatedAt: Date.now(),
		});
	}
	await refreshArrivalProjection(ctx, threadId);
}
