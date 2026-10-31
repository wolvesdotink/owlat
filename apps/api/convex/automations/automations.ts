// Feature-flag contract: the 'automations' flag is a product/UI gate, not an
// authorization boundary. Every public function in automations/** runs on the
// gated `automationsQuery` / `automationsMutation` builders (./_helpers.ts), so
// with the flag off an automation can be neither listed nor read, edited,
// duplicated or removed — the same floor the web layer's path-derived gate on
// /dashboard/automations applies. Authorization stays in the handler:
// automations:manage (admin/owner) is the security gate.
import { v } from 'convex/values';
import { requireAutomationManage, requireAutomation, requireDraftAutomation } from './guards';
import { paginationOptsValidator } from 'convex/server';
import { automationsQuery, automationsMutation } from './_helpers';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOrThrow, throwInvalidState } from '../_utils/errors';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { getLive } from '../lib/softDelete';
import { restoreAutomation, softDeleteAutomation } from './deletion';
import { trackEvent } from '../lib/posthogHelpers';
import { triggerConfigValidator } from '../lib/convexValidators';
import { listResources, countFacet } from '../lib/listing';
import { recordListingCounter } from '../lib/listingCounters';
import { automationListing } from './listing';
import { enrichStepForQuery, loadOrderedSteps } from './steps';
import { enrichTriggerForQuery } from './triggers';
import type { TriggerKind } from './triggers/types';
import type { AutomationTransitionOutcome } from './lifecycle';

// Re-export validator-derived types for frontend use
export type { StepConfig } from '../lib/automationConfigTypes';

// ============== Types ==============

export type TriggerType = Doc<'automations'>['triggerType'];
export type AutomationStatus = Doc<'automations'>['status'];

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
 * unions. Persisted condition shape is canonical `Condition`
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

// ============== Queries ==============

/**
 * One automation plus its steps in walk order, or null when it does not exist
 * or is in Recently deleted.
 */
async function loadAutomationWithSteps(
	ctx: Pick<QueryCtx, 'db'>,
	automationId: Id<'automations'>
): Promise<{ automation: Doc<'automations'>; steps: Doc<'automationSteps'>[] } | null> {
	const automation = await getLive(ctx, automationId);
	if (!automation) return null;
	return { automation, steps: await loadOrderedSteps(ctx.db, automation._id) };
}

// List automations using session-based context.
// all-members: the automation list is readable by every member; only the writes
// below require automations:manage (automations/guards.ts).
export const list = automationsQuery({
	args: {
		status: v.optional(v.union(v.literal('draft'), v.literal('active'), v.literal('paused'))),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		return listResources(ctx.db, automationListing, {
			filters: { status: args.status },
			paginationOpts: args.paginationOpts,
		});
	},
});

// Get a single automation by ID with its steps
// all-members: the read-only automation view every member may open (step
// configs hold no credentials; plugin secrets stay in the deployment env).
export const get = automationsQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const loaded = await loadAutomationWithSteps(ctx, args.automationId);
		if (!loaded) return null;
		return { ...loaded.automation, steps: loaded.steps };
	},
});

// Get automation with related data (email templates for email steps)
// all-members: the same read-only automation view as `get`, joined with the
// templates and topic every member may also read.
export const getWithRelations = automationsQuery({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		const loaded = await loadAutomationWithSteps(ctx, args.automationId);
		if (!loaded) return null;
		const { automation, steps } = loaded;

		// Per-kind enrichment (email step joins its template, etc.) — dispatched
		// through the step module's optional `enrichForQuery` hook so this query
		// stays switch-free over `step.stepType`.
		const enrichedSteps = await Promise.all(steps.map((step) => enrichStepForQuery(ctx, step)));

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
// all-members: per-status counts behind the member-readable automation list.
export const countByStatus = automationsQuery({
	args: {},
	handler: async (ctx) => {
		const counts = await countFacet(ctx.db, automationListing, 'byStatus');
		return counts as Record<string, number>;
	},
});

// ============== Mutations ==============

// Create a new automation
export const create = automationsMutation({
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
		await recordListingCounter(ctx, 'automationStatus', null, { status: 'draft' });

		await trackEvent(ctx, session, 'automation_created', { automationId });

		return automationId;
	},
});

// Update automation basics (name, description)
export const update = automationsMutation({
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
export const updateTrigger = automationsMutation({
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
			'Cannot update trigger on active or paused automations'
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
	reason: Extract<AutomationTransitionOutcome, { ok: false }>['reason']
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
		case 'status_changed':
			return 'The automation was paused or resumed since; nothing was undone';
	}
}

/**
 * What a pause or resume returns: `statusChangedAt` is the stamp its
 * transition wrote, which an undo passes back as `ifStatusChangedAt`; null
 * when the automation was already in that state and nothing changed.
 */
type StatusChangeResult = { statusChangedAt: number | null };

const statusChangeArgs = {
	automationId: v.id('automations'),
	// Set by an undo: see `lifecycle.transition`.
	ifStatusChangedAt: v.optional(v.number()),
};

async function changeStatus(
	ctx: MutationCtx,
	args: { automationId: Id<'automations'>; ifStatusChangedAt?: number },
	to: 'active' | 'paused',
	userId: string
): Promise<StatusChangeResult> {
	const at = Date.now();
	const outcome = await ctx.runMutation(internal.automations.lifecycle.transition, {
		automationId: args.automationId,
		input: { to, at },
		userId,
		...(args.ifStatusChangedAt !== undefined ? { ifStatusChangedAt: args.ifStatusChangedAt } : {}),
	});
	if (!outcome.ok) throwInvalidState(reasonToMessage(outcome.reason));
	return { statusChangedAt: outcome.applied === 'transitioned' ? at : null };
}

// Activate an automation — auth shell over `lifecycle.transition`.
export const activate = automationsMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
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
export const pause = automationsMutation({
	args: statusChangeArgs,
	handler: async (ctx, args): Promise<StatusChangeResult> => {
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'pause automations');
		return await changeStatus(ctx, args, 'paused', session.userId);
	},
});

// Resume a paused automation — auth shell over `lifecycle.transition`.
export const resume = automationsMutation({
	args: statusChangeArgs,
	handler: async (ctx, args): Promise<StatusChangeResult> => {
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'resume automations');
		return await changeStatus(ctx, args, 'active', session.userId);
	},
});

// Duplicate an automation
export const duplicate = automationsMutation({
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
		await recordListingCounter(ctx, 'automationStatus', null, { status: 'draft' });

		// Copy all steps
		const steps = await loadOrderedSteps(ctx.db, args.automationId);

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

// Delete an automation: it moves to Recently deleted with its steps, restorable
// for 30 days (automations/deletion.ts). Deleting one already there is a no-op.
export const remove = automationsMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args) => {
		// authz: requireAutomationManage enforces automations:manage
		const session = await requireAutomationManage(ctx, 'delete automations');
		const automation = await getOrThrow(ctx, args.automationId, 'Automation');
		await softDeleteAutomation(ctx, automation, session.userId);
	},
});

// Bring an automation back from Recently deleted. The permission a delete
// needs, whoever deleted it. Restoring a live automation is a no-op.
export const restore = automationsMutation({
	args: {
		automationId: v.id('automations'),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'automations:manage'),
			'Only owners and admins can restore automations'
		);
		await restoreAutomation(ctx, args.automationId, session.userId);
	},
});
