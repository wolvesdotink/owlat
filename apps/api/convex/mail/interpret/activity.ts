/**
 * The append-only per-thread activity log (SPEC §5 "Activity writers").
 *
 * {@link appendActivity} is THE writer: the reducer, the reactions and every
 * pipeline hook (sends, bookings, assignments, mutes …) append through it, in
 * the transaction of the change they record, so a row exists exactly when the
 * change does.
 *
 * - `seq` is allocated from `threadBriefs.lastActivitySeq` (the row is created
 *   on first use), so a thread's rows are totally ordered.
 * - The writer's `idempotencyKey` is scoped to the thread (stored as
 *   `<threadRefKey>|<key>`): a second append with the same key is a no-op that
 *   returns the first row. Pick keys that name the event, e.g.
 *   `send:<messageId>`, `assign:<threadId>:<at>`.
 * - `visibility` defaults to `defaultActivityVisibility(type)`; housekeeping
 *   rows (assign, snooze, label, archive, mute, item assignment/reminders)
 *   stay out of the brief's "Activity" block.
 * - `payload` is JSON detail (names, counts, a quote), sealed like a body.
 *
 * `record` is the internal mutation for writers that live in an action.
 */

import { v } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import {
	defaultActivityVisibility,
	type ActivityActor,
	type ActivityType,
	type ActivityVisibility,
	type InterpretMode,
} from '@owlat/shared/threadBrief';
import type { Infer } from 'convex/values';
import {
	activityActorValidator,
	activityDeltaValidator,
	activityOpRefValidator,
	activityProvenanceValidator,
	activityTypeValidator,
	activityVisibilityValidator,
	interpretModeValidator,
} from '../../lib/validators/threadBrief';
import {
	threadRefKey,
	threadRefToFields,
	threadRefValidator,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { ensureBriefRow } from './briefRow';

/** Shape version of the sealed `threadActivity.payload` JSON. */
export const ACTIVITY_PAYLOAD_VERSION = 1;

export interface AppendActivityInput {
	threadRef: ThreadRef;
	/** Names the event; scoped to the thread. A repeat is a no-op. */
	idempotencyKey: string;
	type: ActivityType;
	actor: { kind: ActivityActor; id?: string };
	provenance: Infer<typeof activityProvenanceValidator>;
	/** Defaults to `defaultActivityVisibility(type)`. */
	visibility?: ActivityVisibility;
	itemId?: Id<'threadItems'>;
	itemRevision?: number;
	delta?: Infer<typeof activityDeltaValidator>;
	opRef?: Infer<typeof activityOpRefValidator>;
	/** JSON-serializable detail; sealed at rest. */
	payload?: Record<string, unknown>;
	/** When it happened (default: now). */
	eventAt?: number;
	/** Mode for a brief row this append has to create (default: the thread's own). */
	mode?: InterpretMode;
}

export type AppendActivityResult =
	| { activityId: Id<'threadActivity'>; seq: number; isDuplicate: boolean }
	/** The thread is gone: nothing was written. */
	| null;

/** The stored, thread-scoped form of a writer's idempotency key. */
export function scopedIdempotencyKey(ref: ThreadRef, key: string): string {
	return `${threadRefKey(ref)}|${key}`;
}

/** Append one activity row in the caller's transaction (see the module doc). */
export async function appendActivity(
	ctx: MutationCtx,
	input: AppendActivityInput
): Promise<AppendActivityResult> {
	const idempotencyKey = scopedIdempotencyKey(input.threadRef, input.idempotencyKey);
	const existing = await ctx.db
		.query('threadActivity')
		.withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', idempotencyKey))
		.first();
	if (existing) return { activityId: existing._id, seq: existing.seq, isDuplicate: true };

	const brief = await ensureBriefRow(ctx, input.threadRef, input.mode);
	if (!brief) return null;
	const seq = brief.lastActivitySeq + 1;
	const now = Date.now();
	await ctx.db.patch(brief._id, { lastActivitySeq: seq, updatedAt: now });

	const payload =
		input.payload === undefined ? undefined : await sealBodyAtWrite(JSON.stringify(input.payload));
	const activityId = await ctx.db.insert('threadActivity', {
		...threadRefToFields(input.threadRef),
		seq,
		idempotencyKey,
		type: input.type,
		actor: input.actor,
		provenance: input.provenance,
		visibility: input.visibility ?? defaultActivityVisibility(input.type),
		...(input.itemId ? { itemId: input.itemId } : {}),
		...(input.itemRevision !== undefined ? { itemRevision: input.itemRevision } : {}),
		...(input.delta ? { delta: input.delta } : {}),
		...(input.opRef ? { opRef: input.opRef } : {}),
		...(payload !== undefined ? { payload, payloadVersion: ACTIVITY_PAYLOAD_VERSION } : {}),
		eventAt: input.eventAt ?? now,
		recordedAt: now,
	});
	return { activityId, seq, isDuplicate: false };
}

/** {@link appendActivity} for writers running in an action. */
export const record = internalMutation({
	args: {
		threadRef: threadRefValidator,
		idempotencyKey: v.string(),
		type: activityTypeValidator,
		actor: activityActorValidator,
		provenance: activityProvenanceValidator,
		visibility: v.optional(activityVisibilityValidator),
		itemId: v.optional(v.id('threadItems')),
		itemRevision: v.optional(v.number()),
		delta: v.optional(activityDeltaValidator),
		opRef: v.optional(activityOpRefValidator),
		// JSON object text; sealed on write.
		payloadJson: v.optional(v.string()),
		eventAt: v.optional(v.number()),
		mode: v.optional(interpretModeValidator),
	},
	handler: async (ctx, args): Promise<AppendActivityResult> => {
		const { payloadJson, ...rest } = args;
		let payload: Record<string, unknown> | undefined;
		if (payloadJson !== undefined) {
			const parsed: unknown = JSON.parse(payloadJson);
			payload =
				parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: { value: parsed };
		}
		return appendActivity(ctx, { ...rest, ...(payload ? { payload } : {}) });
	},
});
