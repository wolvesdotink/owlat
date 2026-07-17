import { v } from 'convex/values';
import { PLUGIN_AUTOMATION_TRIGGER_CAPABILITY } from '@owlat/plugin-kit';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internalMutation } from '../_generated/server';
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
import {
	isCoreTriggerKind,
	pluginTriggerCatalogEntry,
	type TriggerKind as PersistedTriggerKind,
} from './triggers/catalog';
import { pluginTriggerModuleFor } from './triggers/pluginTriggers';
import { authorizeSystemBundledPlugin } from '../plugins/authorization';
import { createContact } from '../contacts/creation';
import { throwNotFound } from '../_utils/errors';

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
 * Generic-free trigger module shape the fanout calls. Both the core registry
 * (via {@link fireTrigger}) and the host-composed plugin registry (via
 * {@link firePluginTrigger}) resolve to this shape, so plugin and core triggers
 * share one identical fanout — one running-instance guard, one no-steps guard,
 * one stats bump, one scheduled walker.
 */
interface ErasedTriggerModule {
	parseConfig?: (raw: unknown) => unknown;
	matches: (input: unknown, config: unknown) => boolean;
	buildTriggerData?: (input: unknown, config: unknown) => TriggerData;
}

async function fanoutTrigger(
	ctx: MutationCtx,
	kind: PersistedTriggerKind,
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
		const existingRun = await ctx.db
			.query('automationRuns')
			.withIndex('by_automation_and_contact', (q) =>
				q.eq('automationId', automation._id).eq('contactId', input.contactId)
			)
			.filter((q) => q.eq(q.field('status'), 'running'))
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

// ============== Host-composed plugin trigger firing ==============

/**
 * Unwrap a plugin trigger's persisted config. Plugin automations store their
 * trigger config under the `{ pluginConfig }` arm of `triggerConfigValidator`
 * (mirroring `pluginConfig` on step config), so the plugin's `parseConfig` sees
 * its own opaque record — never the host's core config shapes. A row without the
 * arm yields `{}` so a config-less plugin trigger still parses.
 */
function unwrapPluginTriggerConfig(raw: unknown): unknown {
	return raw && typeof raw === 'object' && 'pluginConfig' in raw
		? (raw as { pluginConfig: unknown }).pluginConfig
		: {};
}

// A plugin's `buildTriggerData` output is untrusted text that lands verbatim on
// the host-owned `automationRuns.triggerData`, so it is clamped at the host
// boundary exactly like the step failure reason: bounded key count, bounded code
// points per key and per string value, and control characters replaced with a
// space. Non-string primitives (number/boolean/null) are size-bounded already.
const MAX_TRIGGER_DATA_KEYS = 32;
const MAX_TRIGGER_DATA_KEY_CODE_POINTS = 128;
const MAX_TRIGGER_DATA_VALUE_CODE_POINTS = 1024;

function clampTriggerText(text: string, maxCodePoints: number): string {
	let out = '';
	let count = 0;
	for (const character of text) {
		if (count >= maxCodePoints) break;
		const codePoint = character.codePointAt(0) ?? 0;
		out += codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
		count += 1;
	}
	return out;
}

function clampTriggerData(data: TriggerData): TriggerData {
	const clamped: TriggerData = {};
	let keys = 0;
	for (const [key, value] of Object.entries(data)) {
		if (keys >= MAX_TRIGGER_DATA_KEYS) break;
		const clampedKey = clampTriggerText(key, MAX_TRIGGER_DATA_KEY_CODE_POINTS);
		clamped[clampedKey] =
			typeof value === 'string'
				? clampTriggerText(value, MAX_TRIGGER_DATA_VALUE_CODE_POINTS)
				: value;
		keys += 1;
	}
	return clamped;
}

/**
 * Fire a bundled plugin trigger. This is the host seam a plugin's own code
 * (e.g. a future webhook-event source) calls to fan a contact into automations
 * that subscribe to its namespaced trigger kind. Fails closed: an unknown kind,
 * a disabled plugin flag, or an ungranted `automation:trigger` capability fans
 * out nothing. The plugin decides `matches`/`buildTriggerData`; the host owns
 * the running-instance guard, the no-steps guard, stats, and scheduling.
 */
export const firePluginTrigger = internalMutation({
	args: {
		pluginId: v.string(),
		localId: v.string(),
		contactId: v.id('contacts'),
		payload: v.optional(v.record(v.string(), jsonPrimitiveValue)),
	},
	handler: async (ctx, args): Promise<{ triggered: number }> => {
		const kind = `plugin.${args.pluginId}.${args.localId}`;
		const entry = pluginTriggerCatalogEntry(kind);
		if (!entry || entry.pluginId !== args.pluginId) return { triggered: 0 };

		const scope = await authorizeSystemBundledPlugin(
			ctx,
			args.pluginId,
			PLUGIN_AUTOMATION_TRIGGER_CAPABILITY
		);
		if (!scope) return { triggered: 0 };

		const module = pluginTriggerModuleFor(kind);
		if (!module) return { triggered: 0 };

		const input = { contactId: args.contactId, payload: args.payload ?? {} };
		const erased: ErasedTriggerModule = {
			parseConfig: (raw) => module.parseConfig(unwrapPluginTriggerConfig(raw)),
			matches: (fireInput, config) => module.matches(fireInput as typeof input, config),
			...(module.buildTriggerData
				? {
						buildTriggerData: (fireInput, config) =>
							clampTriggerData(module.buildTriggerData!(fireInput as typeof input, config)),
					}
				: {}),
		};
		// The catalog entry above proves `kind` is a composed plugin trigger kind,
		// which the schema-derived union admits once a plugin contributes it.
		const triggered = await fanoutTrigger(ctx, kind as PersistedTriggerKind, input, erased);
		return { triggered: triggered.length };
	},
});

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

export const fireEventReceivedTrigger = internalMutation({
	args: {
		contactId: v.id('contacts'),
		eventName: v.string(),
		eventProperties: v.optional(v.string()),
	},
	handler: async (ctx, args) =>
		fireTrigger(ctx, 'event_received', {
			contactId: args.contactId,
			eventName: args.eventName,
			eventProperties: args.eventProperties,
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

/**
 * Send an event for a contact (by email). Optionally creates the contact,
 * fires `contact_created` for them, then fires `event_received` for the
 * supplied event.
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
	},
	handler: async (ctx, args) => {
		validateStringLength(args.eventName, STRING_LIMITS.EVENT_NAME, 'Event name');

		// Soft-deleted Contacts are invisible to this API surface (per
		// CONVENTIONS.md soft-delete contract). When the only `by_email`
		// match is a gravestone, this lookup returns null — the call then
		// either creates a fresh Contact (when `createContactIfNotExists`)
		// or throws "not found." The resolution module guarantees identifier
		// reclaimability on day 1 via the identity cascade.
		let contact: Doc<'contacts'> | null = await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) => q.eq('email', args.email.toLowerCase()))
			.filter((q) => q.eq(q.field('deletedAt'), undefined))
			.first();

		if (!contact && args.createContactIfNotExists) {
			// Contact creation (module) owns the created trio (count +
			// contact_created trigger + created activity) — the ad-hoc
			// fireTrigger('contact_created') this path used to do is now unified,
			// and the count + activity it used to skip are fixed for free.
			const { contactId } = await createContact(ctx, {
				channel: 'email',
				identifier: args.email,
				source: 'api',
				mode: 'upsert',
			});
			contact = await ctx.db.get(contactId);
		}

		if (!contact) {
			throwNotFound(`Contact with email ${args.email}`);
		}

		const triggered = await fireTrigger(ctx, 'event_received', {
			contactId: contact._id,
			eventName: args.eventName,
			eventProperties:
				args.eventProperties != null ? JSON.stringify(args.eventProperties) : undefined,
		});

		return {
			contactId: contact._id,
			eventName: args.eventName,
			triggeredAutomations: triggered.length,
		};
	},
});
