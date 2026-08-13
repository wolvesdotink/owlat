import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Code work / coding-agent task table.
 *
 * Spread into `defineSchema()` from schema.ts via `...codeWorkTables`.
 */
export const codeWorkTables = {
	// Code Work Tasks - tracks coding agent task execution
	codeWorkTasks: defineTable({
		description: v.string(),
		// Source context
		inboundMessageId: v.optional(v.id('inboundMessages')),
		// Git context
		branch: v.optional(v.string()),
		prUrl: v.optional(v.string()),
		// Execution status
		status: v.union(
			v.literal('queued'),
			v.literal('running'),
			v.literal('testing'),
			v.literal('review'),
			v.literal('merged'),
			v.literal('failed')
		),
		// Results
		testResults: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
		// Retry accounting. `attempts` counts claims (incremented when the worker
		// takes the task), `maxAttempts` is the per-row ceiling, and
		// `nextAttemptAt` is the backoff gate a requeued task waits behind before
		// the worker may claim it again. All optional: rows written before retries
		// existed carry none of them and fall back to the defaults in
		// `lib/codeTaskRetry.ts`.
		attempts: v.optional(v.number()),
		maxAttempts: v.optional(v.number()),
		nextAttemptAt: v.optional(v.number()),
		// LLM cost tracking
		llmCost: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_status', ['status'])
		.index('by_created_at', ['createdAt'])
		// Idempotent inbound → code-task creation (createFromInbound dedupes here).
		.index('by_inbound', ['inboundMessageId'])
		// Resolve a task from a merged GitHub PR (the merge webhook looks up by URL).
		.index('by_pr_url', ['prUrl']),
};
