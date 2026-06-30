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
