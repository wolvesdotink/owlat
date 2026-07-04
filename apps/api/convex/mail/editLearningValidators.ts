import { v } from 'convex/values';

// Edit-learning flywheel validators — the recurring draft→sent deltas the user
// makes to AI drafts, classified into a small fixed vocabulary. These live in a
// feature-local sibling of mail/editLearning.ts (rather than the shared
// lib/convexValidators.ts) so the shared module stays under the file-size cap.
// See mail/editLearning.ts for the engine and schema/mail.ts for the tables.

export const editDeltaKindValidator = v.union(
	v.literal('removed_greeting'),
	v.literal('added_greeting'),
	v.literal('removed_signoff'),
	v.literal('added_signoff'),
	v.literal('shortened'),
	v.literal('lengthened'),
	v.literal('removed_emoji'),
	v.literal('removed_exclamation'),
	v.literal('language_switch')
);

// One learned adjustment: a delta kind plus its human-readable prompt directive,
// a live observation counter, and a `promoted` flag that only flips true once the
// recurrence threshold is crossed — a one-off edit never becomes a durable rule.
export const editAdjustmentValidator = v.object({
	kind: editDeltaKindValidator,
	directive: v.string(),
	observations: v.number(),
	promoted: v.boolean(),
	firstSeenAt: v.number(),
	lastSeenAt: v.number(),
});
