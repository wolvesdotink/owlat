import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	delayedActionAnchorValidator,
	delayedActionCancelReasonValidator,
	delayedActionStateValidator,
	digestItemValidator,
	digestOverflowByKindValidator,
	digestStateValidator,
	digestVisitedValidator,
	filterAiConditionValidator,
} from '../lib/validators/arrival';
import {
	mailFilterActionValidator,
	mailFilterConditionValidator,
	mailFilterMatchTypeValidator,
} from './mailRules';

/** A compiled rule the person confirms before it is saved (§6.1). */
export const ruleDraftPreviewValidator = v.object({
	name: v.string(),
	conditions: v.array(mailFilterConditionValidator),
	matchType: v.optional(mailFilterMatchTypeValidator),
	aiCondition: v.optional(filterAiConditionValidator),
	actions: v.array(mailFilterActionValidator),
});

/**
 * Read on arrival, lane rules (SPEC §6): async rule compiles, delayed
 * actions and the digest. Part of `MAIL_ARRIVAL_TABLES`
 * (schema/mailArrival.ts), which spreads this in.
 */
export const mailArrivalRulesTables = {
	// Async compile results of plain-language and Fix rules; the UI subscribes.
	mailRuleDrafts: defineTable({
		mailboxId: v.id('mailboxes'),
		// What the person typed. Sealed.
		sourceText: v.string(),
		status: v.union(v.literal('compiling'), v.literal('ready'), v.literal('failed')),
		preview: v.optional(ruleDraftPreviewValidator),
		origin: v.union(v.literal('fix'), v.literal('plain_language')),
		fromMessageId: v.optional(v.id('mailMessages')),
		createdAt: v.number(),
		expiresAt: v.number(), // 7 days
	})
		.index('by_mailbox_created', ['mailboxId', 'createdAt'])
		.index('by_expires', ['expiresAt']),

	// One delayed archive of one message (§6.4). `actionKey` is unique:
	// `${messageId}:archive:${source}`.
	mailDelayedActions: defineTable({
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		messageId: v.id('mailMessages'),
		actionKey: v.string(),
		action: v.literal('archive'),
		runAt: v.number(),
		source: v.union(v.literal('rule'), v.literal('code_detector')),
		filterId: v.optional(v.id('mailFilters')),
		// The operation whose undo cancels this row while pending.
		createdByOperationId: v.optional(v.id('mailArrivalOperations')),
		anchor: delayedActionAnchorValidator,
		state: delayedActionStateValidator,
		cancelledBy: v.optional(delayedActionCancelReasonValidator),
		// The `delayed_archive` operation its execution wrote.
		operationId: v.optional(v.id('mailArrivalOperations')),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_state_run', ['state', 'runAt'])
		.index('by_message', ['messageId'])
		.index('by_thread_state', ['threadId', 'state'])
		.index('by_action_key', ['actionKey'])
		// Mailbox erasure.
		.index('by_mailbox', ['mailboxId']),

	// One digest per (mailbox, period), claimed before the paid call (§6.5).
	mailDigests: defineTable({
		mailboxId: v.id('mailboxes'),
		periodKey: v.string(),
		state: digestStateValidator,
		claimToken: v.string(),
		claimUntil: v.number(),
		// Incremented in the claim mutation before the paid call; capped at 2.
		generationAttempts: v.number(),
		// ≤15 rendered lines (≤5 per kind); spans sealed.
		items: v.array(digestItemValidator),
		// ≤200 threads consumed on send, with the boundary snapshotted at selection.
		visited: v.array(digestVisitedValidator),
		overflowByKind: digestOverflowByKindValidator,
		overflowLabel: v.union(v.literal('exact'), v.literal('at_least')),
		generatedAt: v.optional(v.number()),
		sentAt: v.optional(v.number()),
		sentMessageId: v.optional(v.id('mailMessages')),
		createdAt: v.number(),
		expiresAt: v.number(), // 30 days
	})
		.index('by_mailbox_period', ['mailboxId', 'periodKey'])
		// Message purge: the mailbox's unsent digests.
		.index('by_mailbox_state', ['mailboxId', 'state'])
		.index('by_expires', ['expiresAt']),
};
