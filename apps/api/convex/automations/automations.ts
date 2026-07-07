// Feature-flag contract: the 'automations' flag is a product/UI gate, not an
// authorization boundary. It is asserted on the entry points that bring an
// automation into use (create + the lifecycle transitions + the list/count
// surfaces) and reinforced by the web layer's path-derived feature gate.
// Editing/reading an already-existing automation (update, steps, analytics, get)
// is gated by automations:manage (admin/owner) and intentionally does not
// re-assert the flag — authorization, not the product flag, is the security gate.
import { v } from 'convex/values';
import { requireAutomationManage, requireAutomation, requireDraftAutomation } from './guards';
import { paginationOptsValidator } from 'convex/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { throwInvalidState } from '../_utils/errors';
import { trackEvent } from '../lib/posthogHelpers';
import { triggerConfigValidator } from '../lib/convexValidators';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { listResources, countFacet } from '../lib/listing';
import { automationListing } from './listing';
import { enrichStepForQuery } from './steps';
import { enrichTriggerForQuery } from './triggers';
import type { TriggerKind } from './triggers/types';
import type { AutomationTransitionOutcome } from './lifecycle';

// Re-export validator-derived types for frontend use
export type { StepConfig } from '../lib/automationConfigTypes';

// ============== Types ==============

export type TriggerType = Doc<'automations'>['triggerType'];
export type AutomationStatus = Doc<'automations'>['status'];
export type StepType = Doc<'automationSteps'>['stepType'];

export interface ContactUpdatedTriggerConfig {
	propertyKey: string;
}

export interface EventReceivedTriggerConfig {
	eventName: string;
}

export interface TopicSubscribedTriggerConfig {
	topicId: string; // Id<"topics">
}

export interface EmailStepConfig {
	emailTemplateId: string; // Id<"emailTemplates">
	subjectOverride?: string;
}

export interface DelayStepConfig {
	duration: number;
	unit: 'minutes' | 'hours' | 'days' | 'weeks';
}

/**
 * Editor-facing vocabulary for condition step form values.
 *
 * The Vue templates bind `<option value="...">` strings against these
 * unions. Persisted condition shape is canonical `Condition` per ADR-0004
 * (`automations/steps/condition/index.ts`); these editor-side aliases
 * exist only to keep the existing form values stable while the persisted
 * data is canonical underneath.
 */
export type ConditionOperator =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'greater_than'
	| 'less_than'
	| 'is_set'
	| 'is_not_set';

export type ConditionType = 'property' | 'email_activity' | 'topic_membership';

// ============== Queries ==============

// List automations using session-based context.
export const list = authedQuery({
	args: {
		status: v.optional(v.union(v.literal('draft'), v.literal('active'), v.literal('paused'))),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'automations');
		return listResources(ctx.db, automationListing, {
			filters: { status: args.status },
			paginationOpts: args.paginationOpts,
		});
	},
});

// Get a single automation by ID with its steps
export const get = authedQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const automation = await ctx.db.get(args.automationId);
		if (!automation) return null;

		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automation._id))
			.collect(); // bounded: one automation's steps

		// Sort steps by stepIndex
		const sortedSteps = steps.sort((a, b) => a.stepIndex - b.stepIndex);

		return {
			...automation,
			steps: sortedSteps,
		};
	},
});

// Get automation with related data (email templates for email steps)
export const getWithRelations = authedQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const automation = await ctx.db.get(args.automationId);
		if (!automation) return null;

		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automation._id))
			.collect(); // bounded: one automation's steps

		const sortedSteps = steps.sort((a, b) => a.stepIndex - b.stepIndex);

		// Per-kind enrichment (email step joins its template, etc.) — dispatched
		// through the step module's optional `enrichForQuery` hook so this query
		// stays switch-free over `step.stepType`.
		const enrichedSteps = await Promise.all(
			sortedSteps.map((step) => enrichStepForQuery(ctx, step))
		);

		// Per-kind trigger enrichment (topic_subscribed joins the topic, etc.)
		// — dispatched through the trigger module's optional `enrichForQuery`
		// hook so this query stays switch-free over `triggerType`.
		const triggerEnrichment = await enrichTriggerForQuery(
			ctx,
			automation.triggerType as TriggerKind,
			automation.triggerConfig
		);

		return {
			...automation,
			steps: enrichedSteps,
			topic: null,
			...triggerEnrichment,
		};
	},
});

// Count automations by status — the descriptor's `byStatus` facet returns
// per-status counts plus their `total`.
export const countByStatus = authedQuery({
	args: {},
	handler: async (ctx) => {
		const counts = await countFacet(ctx.db, automationListing, 'byStatus');
		return counts as Record<string, number>;
	},
});

// ============== Mutations ==============

// Create a new automation
export const create = authedMutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		triggerType: v.union(
			v.literal('contact_created'),
			v.literal('contact_updated'),
			v.literal('event_received'),
			v.literal('topic_subscribed')
		),
		triggerConfig: v.optional(triggerConfigValidator),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'automations');
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'create automations');

		const now = Date.now();
		const automationId = await ctx.db.insert('automations', {
			name: args.name,
			description: args.description,
			triggerType: args.triggerType,
			triggerConfig: args.triggerConfig,
			status: 'draft',
			statsEntered: 0,
			statsActive: 0,
			statsCompleted: 0,
			createdAt: now,
			updatedAt: now,
		});

		await trackEvent(ctx, session, 'automation_created', { automationId });

		return automationId;
	},
});

// Update automation basics (name, description)
export const update = authedMutation({
	args: {
		automationId: v.id('automations'),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// authz: requireAutomation enforces automations:manage
		await requireAutomation(ctx, args.automationId, 'edit automations');

		const updates: Partial<Doc<'automations'>> = {
			updatedAt: Date.now(),
		};

		if (args.name !== undefined) updates.name = args.name;
		if (args.description !== undefined) updates.description = args.description;

		await ctx.db.patch(args.automationId, updates);
	},
});

// Update trigger configuration
export const updateTrigger = authedMutation({
	args: {
		automationId: v.id('automations'),
		triggerType: v.union(
			v.literal('contact_created'),
			v.literal('contact_updated'),
			v.literal('event_received'),
			v.literal('topic_subscribed')
		),
		triggerConfig: v.optional(triggerConfigValidator),
	},
	handler: async (ctx, args) => {
		// authz: requireDraftAutomation enforces automations:manage
		await requireDraftAutomation(
			ctx,
			args.automationId,
			'update automation triggers',
			'Cannot update trigger on active or paused automations',
		);

		await ctx.db.patch(args.automationId, {
			triggerType: args.triggerType,
			triggerConfig: args.triggerConfig,
			updatedAt: Date.now(),
		});
	},
});

// Translate the lifecycle's typed `reason` to a human-facing message. The
// lifecycle owns the typed contract; the human string is shell-local.
function reasonToMessage(
	reason: Extract<AutomationTransitionOutcome, { ok: false }>['reason'],
): string {
	switch (reason) {
		case 'automation_not_found':
			return 'Automation not found';
		case 'illegal_edge':
			return 'Automation is not in a state that allows this transition';
		case 'no_steps':
			return 'Automation must have at least one step to be activated';
		case 'invalid_trigger_config':
			return 'Automation trigger is missing required configuration';
	}
}

// Activate an automation — auth shell over `lifecycle.transition`.
export const activate = authedMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'automations');
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'activate automations');
		const outcome = await ctx.runMutation(internal.automations.lifecycle.transition, {
			automationId: args.automationId,
			input: { to: 'active', at: Date.now() },
			userId: session.userId,
		});
		if (!outcome.ok) throwInvalidState(reasonToMessage(outcome.reason));
	},
});

// Pause an automation — auth shell over `lifecycle.transition`.
export const pause = authedMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'automations');
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'pause automations');
		const outcome = await ctx.runMutation(internal.automations.lifecycle.transition, {
			automationId: args.automationId,
			input: { to: 'paused', at: Date.now() },
			userId: session.userId,
		});
		if (!outcome.ok) throwInvalidState(reasonToMessage(outcome.reason));
	},
});

// Resume a paused automation — auth shell over `lifecycle.transition`.
export const resume = authedMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'automations');
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'resume automations');
		const outcome = await ctx.runMutation(internal.automations.lifecycle.transition, {
			automationId: args.automationId,
			input: { to: 'active', at: Date.now() },
			userId: session.userId,
		});
		if (!outcome.ok) throwInvalidState(reasonToMessage(outcome.reason));
	},
});

// Revert a paused automation to draft for re-editing — auth shell over
// `lifecycle.transition`. New `paused → draft` edge per ADR-0024.
export const revertToDraft = authedMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'automations');
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'revert automations to draft');
		const outcome = await ctx.runMutation(internal.automations.lifecycle.transition, {
			automationId: args.automationId,
			input: { to: 'draft', at: Date.now() },
			userId: session.userId,
		});
		if (!outcome.ok) throwInvalidState(reasonToMessage(outcome.reason));
	},
});

// Duplicate an automation
export const duplicate = authedMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		// authz: requireAutomation enforces automations:manage
		const { automation } = await requireAutomation(ctx, args.automationId, 'duplicate automations');

		const now = Date.now();

		// Create new automation as draft
		const newAutomationId = await ctx.db.insert('automations', {
			name: `${automation.name} (Copy)`,
			description: automation.description,
			triggerType: automation.triggerType,
			triggerConfig: automation.triggerConfig,
			status: 'draft',
			statsEntered: 0,
			statsActive: 0,
			statsCompleted: 0,
			createdAt: now,
			updatedAt: now,
		});

		// Copy all steps
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
			.collect(); // bounded: one automation's steps

		for (const step of steps) {
			await ctx.db.insert('automationSteps', {
				automationId: newAutomationId,
				stepIndex: step.stepIndex,
				stepType: step.stepType,
				config: step.config,
				createdAt: now,
				updatedAt: now,
			});
		}

		return newAutomationId;
	},
});

// Delete an automation and its steps
export const remove = authedMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		// authz: requireAutomation enforces automations:manage
		const { automation } = await requireAutomation(ctx, args.automationId, 'delete automations');

		// Cannot delete active automations
		if (automation.status === 'active') {
			throwInvalidState('Cannot delete active automations. Please pause first.');
		}

		// Delete all steps
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', args.automationId))
			.collect(); // bounded: one automation's steps

		for (const step of steps) {
			await ctx.db.delete(step._id);
		}

		// Delete the automation
		await ctx.db.delete(args.automationId);
	},
});

