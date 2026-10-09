import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { threadRefFields } from '../lib/validators/threadRef';
import {
	interpretationSourceValidator,
	interpretModeValidator,
} from '../lib/validators/threadBrief';
import { THREAD_BRIEF_TABLES } from './threadBrief';

/** The thread brief tables plus their purge jobs: what the organization wipe sweeps of them. */
export const BRIEF_WIPE_TABLES = [...THREAD_BRIEF_TABLES, 'threadPurgeJobs'] as const;
export type BriefWipeTable = (typeof BRIEF_WIPE_TABLES)[number];

/** What a thread brief purge job does (mail/interpret/purgeDrain.ts). */
export const purgeJobKindValidator = v.union(
	// Purged source messages: their extractions, evidence, claims and links.
	v.literal('sources'),
	// A deleted thread: every thread brief row of it.
	v.literal('thread'),
	// A mailbox scope change: the thread's outputs of the old mode.
	v.literal('scope')
);

/**
 * Where a job's current range stands: the position of the last row handled
 * (`at`: creation time or activity seq; `key`: an ask session's owner), or
 * for a range of sub-ranges the first unfinished one (`step`).
 */
export const purgeCursorValidator = v.object({
	at: v.optional(v.number()),
	key: v.optional(v.string()),
	step: v.optional(v.number()),
	// A two-level range: the position inside the row at `at`'s successor (a follow-up's sends).
	inner: v.optional(v.number()),
	// The last slice stopped inside a row: read the range one row at a time.
	isNarrow: v.optional(v.boolean()),
	// The last slice stopped inside a row: read the range one row at a time.
	isNarrow: v.optional(v.boolean()),
});

/**
 * Thread brief purge jobs (SPEC §5 "Erasure", "Scope change"): one resumable
 * walk over a thread's ranges, a page at a time, with a durable cursor per
 * range. The job row is deleted when every range is exhausted.
 *
 * Holds ids only (no mail content). Spread into `defineSchema()` from
 * schema.ts via `...threadPurgeJobTables`.
 */
export const threadPurgeJobTables = {
	threadPurgeJobs: defineTable({
		...threadRefFields,
		kind: purgeJobKindValidator,
		// Find-or-create key of a job its caller drives itself (the erasure
		// walkers); absent on scheduled jobs.
		jobKey: v.optional(v.string()),
		// `sources` jobs: the purged sources.
		sources: v.optional(v.array(interpretationSourceValidator)),
		// `sources` jobs of a received Team Inbox message: every team reply
		// that answered it is added to `sources` (paged, before anything else).
		inboundMessageId: v.optional(v.id('inboundMessages')),
		// `scope` jobs: the thread's new mode.
		mode: v.optional(interpretModeValidator),
		// The range being drained (index into the kind's range list) and its cursor.
		rangeIndex: v.number(),
		cursor: v.optional(purgeCursorValidator),
		// What the walk found, acted on when the job settles.
		isInterpreted: v.boolean(),
		isItemDeleted: v.boolean(),
		isClaimChanged: v.boolean(),
		// A claim lost evidence and survived: its thread is re-read (F3c).
		isSurvivorChanged: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_job_key', ['jobKey']),
};
