import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { threadRefFields } from '../lib/validators/threadRef';
import {
	claimIdValidator,
	interpretEligibilitySignalsValidator,
	interpretationSourceValidator,
} from '../lib/validators/threadBrief';
import { interpretDeferReasonValidator } from '../lib/validators/aiRouting';
import {
	depthValidator,
	reasonKeyValidator,
	sourceReadOutcomeValidator,
} from '../lib/validators/arrival';

/**
 * Interpretation source snapshots, split out of `schema/threadBrief.ts` at the
 * size cap. `threadBriefTables` spreads this in its place, so the table stays a
 * thread brief table (`THREAD_BRIEF_TABLES`, the erasure registries, the wipe
 * order) exactly as before.
 */
export const interpretSourceTables = {
	// One row per source message, written at enqueue (mail/interpret/sources.ts):
	// the eligibility signals every retry reuses, a team reply's sent text.
	interpretSources: defineTable({
		...threadRefFields,
		source: interpretationSourceValidator,
		sourceKey: v.string(),
		eligibility: interpretEligibilitySignalsValidator,
		// Team replies: the sent content, captured at send finalization. Sealed.
		snapshot: v.optional(
			v.object({ subject: v.string(), text: v.string(), capturedAt: v.number() })
		),
		// The source's lineage record (mail/interpret/reduceIdentity.ts).
		claimIds: v.optional(v.array(claimIdValidator)),
		isClaimRecordFull: v.optional(v.boolean()),
		// Enqueued, not yet recorded (outstanding.ts; threadBriefs.pendingSources);
		// since when, the stale sweep's re-runs so far; `isUnread`: the sweep gave
		// up on it (threadBriefs.unreadSources) until an outcome lands.
		isOutstanding: v.optional(v.boolean()),
		outstandingSince: v.optional(v.number()),
		outstandingTries: v.optional(v.number()),
		isUnread: v.optional(v.boolean()),
		// A run waiting for the category refinement (mail/interpret/categoryDefer.ts).
		categoryDeferredUntil: v.optional(v.number()),
		// D10 (ADR-0073): deferred until the thread is opened, because the reader
		// display is the only consumer left. NOT outstanding: the stale sweep and
		// the backfill skip it, and the brief counts it in
		// `threadBriefs.deferredSources` instead of `pendingSources`. Opening the
		// thread processes it (mail/interpret/lazy.ts), which clears all three.
		isDeferred: v.optional(v.boolean()),
		deferredAt: v.optional(v.number()),
		deferReason: v.optional(interpretDeferReasonValidator),
		// Postbox sources: the message's place in its thread, sortable
		// (mail/interpret/sourceOrder.ts). Written at capture and, for older
		// rows, when deferred. Absent sorts first, so a legacy deferred row is
		// read as the oldest.
		sourceOrderKey: v.optional(v.string()),
		// Read on arrival (SPEC §2.3, §2.5): the depth read, a terminal outcome
		// short of a full read (clears isOutstanding/isDeferred), whether the
		// upgrade rule may still read it in full, why it was skipped; the
		// per-message category wait marker and the per-source run lease.
		depth: v.optional(depthValidator),
		readOutcome: v.optional(sourceReadOutcomeValidator),
		isUpgradeable: v.optional(v.boolean()),
		skipReason: v.optional(reasonKeyValidator),
		categoryPendingAt: v.optional(v.number()),
		leaseUntil: v.optional(v.number()),
		leaseToken: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_source_key', ['sourceKey'])
		// The stale-source sweep (mail/interpret/outstanding.ts).
		.index('by_outstanding', ['isOutstanding', 'outstandingSince'])
		// Thread erasure (mail/interpret/purgeRows.ts threadBriefRanges).
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId'])
		// D10: a thread's deferred sources in thread order: the oldest
		// predecessor of an eager source, the newest one an open reads.
		.index('by_mail_thread_deferred_order', ['mailThreadId', 'isDeferred', 'sourceOrderKey'])
		// Upgradeable predecessors of a source that needs a full read (§2.3.4).
		.index('by_mail_thread_upgradeable_order', ['mailThreadId', 'isUpgradeable', 'sourceOrderKey']),
};
