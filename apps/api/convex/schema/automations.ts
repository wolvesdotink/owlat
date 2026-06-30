import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	triggerConfigValidator,
	stepConfigValidator,
	jsonPrimitiveRecord,
} from '../lib/convexValidators';

/**
 * Automation tables — trigger-based email workflows + per-contact runs + per-step run state.
 *
 * Spread into `defineSchema()` from schema.ts via `...automationTables`.
 */
export const automationTables = {
	// Automations - triggered email workflows
	automations: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		// Trigger configuration
		triggerType: v.union(
			v.literal('contact_created'),
			v.literal('contact_updated'),
			v.literal('event_received'),
			v.literal('topic_subscribed')
		),
		// JSON config for trigger-specific settings
		// contact_updated: { propertyKey: string }
		// event_received: { eventName: string }
		// topic_subscribed: { topicId: Id<"topics"> }
		triggerConfig: v.optional(triggerConfigValidator),
		// Automation status
		status: v.union(v.literal('draft'), v.literal('active'), v.literal('paused')),
		// Stats
		statsEntered: v.optional(v.number()), // Total contacts who entered
		statsActive: v.optional(v.number()), // Currently in flow
		statsCompleted: v.optional(v.number()), // Finished all steps
		// Circuit breaker: consecutive runs that failed all retries. Reset to 0 on
		// any completed run; at the threshold the automation auto-pauses so a
		// systematically-broken step (deleted template, down SMTP) can't keep
		// burning a per-contact run forever. See automations/lifecycle.ts.
		consecutiveRunFailures: v.optional(v.number()),
		// Timestamps
		activatedAt: v.optional(v.number()),
		pausedAt: v.optional(v.number()),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_status', ['status'])
		.index('by_status_trigger', ['status', 'triggerType'])
		.index('by_trigger_type', ['triggerType']),

	// Automation Steps - workflow steps within an automation
	automationSteps: defineTable({
		automationId: v.id('automations'),
		// Step ordering (0-indexed)
		stepIndex: v.number(),
		// Step type
		stepType: v.union(v.literal('email'), v.literal('delay'), v.literal('condition')),
		// Step configuration (JSON string)
		// email: { emailTemplateId: Id<"emailTemplates">, subjectOverride?: string }
		// delay: { duration: number, unit: "minutes" | "hours" | "days" | "weeks" }
		// condition: { condition: Condition, yesBranchStepIndex?: number|null, noBranchStepIndex?: number|null }
		//   yes/noBranchStepIndex are raw stepIndex positions; automations/steps.ts
		//   remaps them on reorder/remove/insert so they follow the moved steps.
		config: stepConfigValidator,
		// Denormalized per-status step-run counts, maintained by the step-run
		// transition mutations (stepExecutorQueries.ts: createStepRun /
		// markStepExecuting / markStepCompleted / markStepFailed). getStepAnalytics
		// + getAutomationStats read these off the bounded step rows instead of
		// scanning every run × step-run on the reactive automation detail page.
		statPending: v.optional(v.number()),
		statExecuting: v.optional(v.number()),
		statCompleted: v.optional(v.number()),
		statFailed: v.optional(v.number()),
		statSkipped: v.optional(v.number()),
		seedTag: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_automation', ['automationId'])
		.index('by_automation_and_index', ['automationId', 'stepIndex']),

	// Automation Runs - tracks contacts going through automations
	automationRuns: defineTable({
		automationId: v.id('automations'),
		contactId: v.id('contacts'),
		// Current step position in the workflow
		currentStepIndex: v.number(),
		// Total step executions claimed by this run. Bounded by MAX_STEPS_PER_RUN
		// in the walker to stop a backward-branching condition step from looping
		// forever and re-sending emails. Optional for rows created pre-cap.
		stepsExecuted: v.optional(v.number()),
		// Run status
		status: v.union(v.literal('running'), v.literal('completed'), v.literal('cancelled')),
		// Timestamps
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		nextStepAt: v.optional(v.number()), // When the next step should execute (for delays)
		// Trigger information
		triggeredBy: v.string(), // The trigger type that started this run
		triggerData: v.optional(jsonPrimitiveRecord), // Trigger-specific data
	})
		.index('by_automation', ['automationId'])
		.index('by_contact', ['contactId'])
		.index('by_automation_and_contact', ['automationId', 'contactId'])
		.index('by_automation_contact_status', ['automationId', 'contactId', 'status'])
		.index('by_automation_and_status', ['automationId', 'status'])
		.index('by_status_and_next_step', ['status', 'nextStepAt']),

	// Automation Step Runs - tracks individual step execution within automation runs
	automationStepRuns: defineTable({
		automationRunId: v.id('automationRuns'),
		automationStepId: v.id('automationSteps'),
		stepIndex: v.number(),
		stepType: v.union(v.literal('email'), v.literal('delay'), v.literal('condition')),
		// Execution status
		status: v.union(
			v.literal('pending'),
			v.literal('executing'),
			v.literal('completed'),
			v.literal('failed'),
			v.literal('skipped')
		),
		// Timestamps
		scheduledAt: v.number(), // When this step was scheduled
		startedAt: v.optional(v.number()), // When execution started
		completedAt: v.optional(v.number()), // When execution completed
		// For email steps: track the email send
		emailSendId: v.optional(v.string()), // Reference to the email provider's message ID
		// For delay steps: when the delay expires
		delayUntil: v.optional(v.number()),
		// Error tracking
		errorMessage: v.optional(v.string()),
		retryCount: v.optional(v.number()),
	})
		.index('by_automation_run', ['automationRunId'])
		.index('by_automation_run_and_step', ['automationRunId', 'stepIndex'])
		.index('by_status', ['status'])
		.index('by_status_and_delay_until', ['status', 'delayUntil']),

	// Write-sharded automation run counters (inc-only: entered/completed/cancelled).
	// fireTrigger / complete / cancel bump a RANDOM shard instead of the single
	// automations row, so a bulk-import burst into a contact_created automation
	// doesn't serialize per-entry RMWs on one document. A rollup cron sums shards
	// into automations.stats* and derives statsActive = entered − completed −
	// cancelled (the read interface). See automations/statShards.ts.
	automationStatShards: defineTable({
		automationId: v.id('automations'),
		shardKey: v.number(),
		statsEntered: v.optional(v.number()),
		statsCompleted: v.optional(v.number()),
		statsCancelled: v.optional(v.number()),
	}).index('by_automation_and_shard', ['automationId', 'shardKey']),
};
