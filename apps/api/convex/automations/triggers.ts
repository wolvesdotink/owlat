import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { jsonPrimitiveValue } from '../lib/convexValidators';
import { bumpAutomationStats } from './statShards';
import { contactCreatedTrigger } from './triggers/contact_created';
import { contactUpdatedTrigger } from './triggers/contact_updated';
import { eventReceivedTrigger } from './triggers/event_received';
import { topicSubscribedTrigger } from './triggers/topic_subscribed';
import type { FireInputFor, TriggerKind, TriggerModule, TriggerData } from './triggers/types';
import { isCoreTriggerKind } from './triggers/catalog';
import { createContactStrict } from '../contacts/contactEdit';
import { findLiveContactByEmail } from '../lib/contactHelpers';
import {
	idempotencyArgValidator,
	lookupReceipt,
	storedEventResponse,
	writeReceipt,
} from '../auth/apiRequestReceipts';

// ============== Module registry ==============

const TRIGGER_MODULES = {
	contact_created: contactCreatedTrigger,
	contact_updated: contactUpdatedTrigger,
	event_received: eventReceivedTrigger,
	topic_subscribed: topicSubscribedTrigger,
} as const satisfies {
	[K in TriggerKind]: TriggerModule<K, unknown, FireInputFor<K>>;
};

export function triggerModuleFor<K extends TriggerKind>(kind: K): (typeof TRIGGER_MODULES)[K] {
	return TRIGGER_MODULES[kind];
}

/**
 * Walk a (triggerType, triggerConfig) pair through its module's optional
 * `enrichForQuery` hook, returning the join fields to merge onto the
 * automation row. Modules without the hook produce `{}`. Lets the
 * `getWithRelations` query stay free of `if (triggerType === ...)`
 * branches.
 */
export async function enrichTriggerForQuery(
	ctx: Pick<QueryCtx, 'db'>,
	triggerType: string,
	triggerConfig: unknown
): Promise<Record<string, unknown>> {
	// Plugin triggers own no host-side query join — the query returns them as-is.
	if (!isCoreTriggerKind(triggerType)) return {};
	const module = triggerModuleFor(triggerType);
	if (!module.enrichForQuery) return {};
	const config = module.parseConfig
		? (module.parseConfig as (raw: unknown) => unknown)(triggerConfig)
		: null;
	return (
		module.enrichForQuery as (
			c: Pick<QueryCtx, 'db'>,
			cfg: unknown
		) => Promise<Record<string, unknown>>
	)(ctx, config);
}

// ============== The Trigger fanout walker ==============

/**
 * Run the trigger fanout pipeline for one kind:
 *   1. fetch active automations with this trigger
 *   2. per automation: narrow config, evaluate `matches`, skip if running, skip if no steps
 *   3. insert run, patch stats, schedule the step walker
 *
 * Replaces the five fire*Trigger mutations and the inline copy in sendEvent.
 */
export async function fireTrigger<K extends TriggerKind>(
	ctx: MutationCtx,
	kind: K,
	input: FireInputFor<K>
): Promise<Id<'automationRuns'>[]> {
	const module = triggerModuleFor(kind);
	// Erase generics so the union of per-kind modules is callable without
	// the intersection-type narrowing TS inserts at the call site.
	const erased = module as unknown as ErasedTriggerModule;
	return fanoutTrigger(ctx, kind, input, erased);
}

/**
 * Generic-free trigger module shape the fanout calls. Every core trigger uses
 * this identical fanout — one running-instance guard, one no-steps guard, one
 * stats bump, one scheduled walker.
 */
interface ErasedTriggerModule {
	parseConfig?: (raw: unknown) => unknown;
	matches: (input: unknown, config: unknown) => boolean;
	buildTriggerData?: (input: unknown, config: unknown) => TriggerData;
}

async function fanoutTrigger(
	ctx: MutationCtx,
	kind: TriggerKind,
	input: { readonly contactId: Id<'contacts'> },
	erased: ErasedTriggerModule
): Promise<Id<'automationRuns'>[]> {
	const automations = await ctx.db
		.query('automations')
		.withIndex('by_status_trigger', (q) => q.eq('status', 'active').eq('triggerType', kind))
		.collect(); // bounded: active automations of one trigger kind (org-scale)

	const triggered: Id<'automationRuns'>[] = [];
	const now = Date.now();

	for (const automation of automations) {
		const config = erased.parseConfig ? erased.parseConfig(automation.triggerConfig) : null;
		if (!erased.matches(input, config)) continue;

		// Skip if contact is already in a running instance of this automation.
		// All three fields are index equalities, so the check reads at most one
		// row however much completed/cancelled history the pair has, and the
		// read set still covers any concurrent insert of a running row.
		const existingRun = await ctx.db
			.query('automationRuns')
			.withIndex('by_automation_contact_status', (q) =>
				q
					.eq('automationId', automation._id)
					.eq('contactId', input.contactId)
					.eq('status', 'running')
			)
			.first();
		if (existingRun) continue;

		// Skip if the automation has no steps to execute.
		const firstStep = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automation._id))
			.first();
		if (!firstStep) continue;

		const triggerData: TriggerData | undefined = erased.buildTriggerData
			? erased.buildTriggerData(input, config)
			: undefined;

		const runId = await ctx.db.insert('automationRuns', {
			automationId: automation._id,
			contactId: input.contactId,
			currentStepIndex: 0,
			status: 'running',
			startedAt: now,
			triggeredBy: kind,
			...(triggerData ? { triggerData } : {}),
		});

		// Sharded counter (no per-entry RMW on the automations row). statsActive is
		// derived (entered − completed − cancelled) by the rollup, so bump entered.
		await bumpAutomationStats(ctx, automation._id, { statsEntered: 1 });

		await ctx.scheduler.runAfter(0, internal.automations.stepWalker.startAutomationRun, {
			automationRunId: runId,
		});

		triggered.push(runId);
	}

	return triggered;
}

// ============== Per-kind internal mutation wrappers ==============

export const fireContactCreatedTrigger = internalMutation({
	args: {
		contactId: v.id('contacts'),
	},
	handler: async (ctx, args) => fireTrigger(ctx, 'contact_created', { contactId: args.contactId }),
});

export const fireContactUpdatedTrigger = internalMutation({
	args: {
		contactId: v.id('contacts'),
		changedProperties: v.array(v.string()),
	},
	handler: async (ctx, args) =>
		fireTrigger(ctx, 'contact_updated', {
			contactId: args.contactId,
			changedProperties: args.changedProperties,
		}),
});

export const fireTopicSubscribedTrigger = internalMutation({
	args: {
		contactId: v.id('contacts'),
		topicId: v.id('topics'),
	},
	handler: async (ctx, args) =>
		fireTrigger(ctx, 'topic_subscribed', {
			contactId: args.contactId,
			topicId: args.topicId,
		}),
});

// ============== Event-send mutation (internal) ==============

/** The actor `contact.created` audit rows name for API-key writes. */
const API_KEY_ACTOR = 'api';

/** A unique id handed to the caller for one accepted event. */
export function generateEventId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 10);
	return `evt_${timestamp}${random}`;
}

type SendEventOutcome =
	| {
			ok: true;
			eventId: string;
			contactId: Id<'contacts'>;
			eventName: string;
			triggeredAutomations: number;
			contactCreated: boolean;
			/** Answered from the Idempotency-Key's receipt: nothing fired this time. */
			replayed?: true;
	  }
	| { ok: false; reason: 'contact_not_found' | 'idempotency_conflict' };

/**
 * Send an event for a contact (by email). Optionally creates the contact,
 * which fires `contact_created` for them, then fires `event_received` for the
 * supplied event.
 *
 * One transaction owns the whole request: the contact lookup, its creation,
 * the trigger fanout, the event id and the Idempotency-Key receipt
 * (`auth/apiRequestReceipts.ts`), so a keyed repeat can never create the
 * contact or fan out a second time.
 *
 * Internal-only: the sole entry point is the API-key-authenticated REST route
 * `POST /api/v1/events` (`eventsApi.ts`), which calls this via
 * `internal.automations.triggers.sendEvent`. It is NOT exposed on the public
 * Convex client API — an anonymous caller must not be able to fabricate events
 * or auto-create contacts.
 */
export const sendEvent = internalMutation({
	args: {
		email: v.string(),
		eventName: v.string(),
		eventProperties: v.optional(v.record(v.string(), jsonPrimitiveValue)),
		createContactIfNotExists: v.optional(v.boolean()),
		idempotency: v.optional(idempotencyArgValidator),
	},
	handler: async (ctx, args): Promise<SendEventOutcome> => {
		validateStringLength(args.eventName, STRING_LIMITS.EVENT_NAME, 'Event name');

		if (args.idempotency) {
			const lookup = await lookupReceipt(ctx, 'events', args.idempotency);
			if (lookup.kind === 'conflict') return { ok: false, reason: 'idempotency_conflict' };
			if (lookup.kind === 'replay') {
				return {
					ok: true,
					...storedEventResponse(lookup.receipt),
					eventName: args.eventName,
					replayed: true,
				};
			}
		}

		// Soft-deleted Contacts are invisible to this API surface (per
		// CONVENTIONS.md soft-delete contract). When the only `by_email`
		// match is a gravestone, this lookup returns null — the call then
		// either creates a fresh Contact (when `createContactIfNotExists`)
		// or reports it missing. The resolution module guarantees identifier
		// reclaimability on day 1 via the identity cascade.
		const contact: Doc<'contacts'> | null = await findLiveContactByEmail(ctx, args.email);
		let contactId: Id<'contacts'>;
		let contactCreated = false;
		if (contact) {
			contactId = contact._id;
		} else if (args.createContactIfNotExists) {
			// The strict create the REST contacts API uses: the created trio
			// (count + contact_created trigger + created activity) plus the
			// `contact.created` audit row naming the API key as the actor.
			contactId = await createContactStrict(
				ctx,
				{ email: args.email, source: 'api' },
				{ actorUserId: API_KEY_ACTOR }
			);
			contactCreated = true;
		} else {
			return { ok: false, reason: 'contact_not_found' };
		}

		const triggered = await fireTrigger(ctx, 'event_received', {
			contactId,
			eventName: args.eventName,
			eventProperties:
				args.eventProperties != null ? JSON.stringify(args.eventProperties) : undefined,
		});

		const eventId = generateEventId();
		if (args.idempotency) {
			await writeReceipt(ctx, args.idempotency, {
				endpoint: 'events',
				contactId,
				contactCreated,
				eventId,
				triggeredAutomations: triggered.length,
			});
		}

		return {
			ok: true,
			eventId,
			contactId,
			eventName: args.eventName,
			triggeredAutomations: triggered.length,
			contactCreated,
		};
	},
});
