/**
 * Audience — the Convex validator + stored shape for a Campaign's targeting
 * selection. See CONTEXT.md "Audience".
 *
 * The shared, snapshot-free selection type lives in `@owlat/shared`
 * (`Audience`). This module narrows its ids to `Id<...>` and adds the
 * send-time `frozenFilters` snapshot on the stored segment case, so an
 * already-sent Campaign reproduces the exact Segment definition it targeted
 * even after the Segment is later edited.
 *
 * Illegal states — `kind: 'topic'` carrying a `segmentId`, or `kind: 'segment'`
 * carrying neither id nor snapshot — are unrepresentable in storage.
 */

import { v } from 'convex/values';
import type { Infer } from 'convex/values';
import type { Audience, AudienceKind } from '@owlat/shared';
import { segmentFiltersValidator } from '../lib/convexValidators';

export const audienceValidator = v.union(
	v.object({
		kind: v.literal('topic'),
		topicId: v.id('topics'),
	}),
	v.object({
		kind: v.literal('segment'),
		segmentId: v.id('segments'),
		// Copied from the live Segment at send time by the Campaign send
		// orchestrator / preflight. Absent on a draft selection.
		frozenFilters: v.optional(segmentFiltersValidator),
	}),
);

/** The stored shape: the shared {@link Audience} selection + the optional snapshot. */
export type StoredAudience = Infer<typeof audienceValidator>;

// ── Infer lockstep ──────────────────────────────────────────────────────
// Keep the stored validator and the shared `Audience` in step. If a new
// `kind` is added to one but not the other, or a selection key drifts, one of
// these compile-time assertions fails.

// 1. The discriminant tags must be identical in both directions.
type _KindsMatch = [AudienceKind] extends [StoredAudience['kind']]
	? [StoredAudience['kind']] extends [AudienceKind]
		? true
		: never
	: never;
const _kindsMatch: _KindsMatch = true;
void _kindsMatch;

// 2. Dropping the send-time snapshot, every stored selection must be a valid
//    shared `Audience` (ids narrow from `string` to `Id<...>`).
type StoredSelection =
	| Extract<StoredAudience, { kind: 'topic' }>
	| Omit<Extract<StoredAudience, { kind: 'segment' }>, 'frozenFilters'>;
type _SelectionInLockstep = StoredSelection extends Audience ? true : never;
const _selectionInLockstep: _SelectionInLockstep = true;
void _selectionInLockstep;
