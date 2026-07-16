import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { contactPropertyConditionModule } from './contact_property';
import { emailActivityConditionModule } from './email_activity';
import { topicMembershipConditionModule } from './topic_membership';
import type { Condition, ConditionKind, ConditionOfKind, ConditionTypeModule } from './types';
import { isPluginConditionKind } from './catalog';

// ============== Module registry ==============

const CONDITION_MODULES = {
	contact_property: contactPropertyConditionModule,
	email_activity: emailActivityConditionModule,
	topic_membership: topicMembershipConditionModule,
} as const satisfies {
	[K in ConditionKind]: ConditionTypeModule<K, unknown>;
};

export function conditionTypeModuleFor<K extends ConditionKind>(
	kind: K
): (typeof CONDITION_MODULES)[K] {
	return CONDITION_MODULES[kind];
}

// ============== Parsing ==============

/**
 * Parse a raw persisted condition (from `segments.filters[]` or
 * `automationSteps.config.condition`) into a typed `Condition`.
 *
 * Throws on shape/operator/field violations — callers should treat that as
 * a corrupt-data condition, not user input.
 */
export function parseCondition(raw: unknown): Condition {
	if (!raw || typeof raw !== 'object') {
		throw new Error('Condition must be an object');
	}
	const kind = (raw as { kind?: unknown }).kind;
	if (typeof kind !== 'string') {
		throw new Error('Condition must have a string `kind` discriminator');
	}
	if (kind === 'contact_property' || kind === 'email_activity' || kind === 'topic_membership') {
		return conditionTypeModuleFor(kind).parseCondition(raw) as Condition;
	}
	// Plugin condition kinds are namespaced and carry editor metadata through the
	// host (see `conditions/catalog.ts`), but the shared segment matcher does not
	// yet evaluate them — a persisted plugin condition would only arrive here via
	// the audience/segment surface, which owns its own gating. Reject it
	// explicitly rather than mislabel it as corrupt data.
	if (isPluginConditionKind(kind)) {
		throw new Error(`Plugin condition kind "${kind}" is not evaluable in this context`);
	}
	throw new Error(`Unknown condition kind "${kind}"`);
}

// ============== Multi-kind evaluation ==============

/**
 * Preloaded lookup data, keyed by condition kind. Each entry is the typed
 * Lookup returned by that kind's `preloadLookup`.
 *
 * Internal — produced by `preloadConditionsLookup`, consumed by `evaluateOne`.
 */
type ConditionsLookup = {
	[K in ConditionKind]?: unknown;
};

/**
 * Pre-fetch all data needed to evaluate `conditions` over many contacts in
 * O(1) per condition. Group conditions by kind, hand each batch to the kind's
 * module, and store the typed lookup keyed by kind.
 */
export async function preloadConditionsLookup(
	ctx: { db: DatabaseReader },
	conditions: Condition[]
): Promise<ConditionsLookup> {
	const grouped = new Map<ConditionKind, Condition[]>();
	for (const c of conditions) {
		const list = grouped.get(c.kind);
		if (list) list.push(c);
		else grouped.set(c.kind, [c]);
	}

	const out: ConditionsLookup = {};
	for (const [kind, list] of grouped) {
		// Each module's preload accepts only its own kind — narrowed by the kind key.
		out[kind] = await (
			conditionTypeModuleFor(kind).preloadLookup as (
				ctx: { db: DatabaseReader },
				conds: ConditionOfKind<typeof kind>[]
			) => Promise<unknown>
		)(ctx, list as ConditionOfKind<typeof kind>[]);
	}
	return out;
}

/**
 * Bounded variant of {@link preloadConditionsLookup}: resolve the same lookup
 * shape for just `contacts` (one contact, or one page of a cursor-checkpointed
 * walk) via per-contact point reads instead of front-loading whole columns.
 * Produces the identical `ConditionsLookup` that `evaluateOne` consumes, so the
 * matcher is unchanged — only the read profile differs.
 */
export async function preloadConditionsLookupForContacts(
	ctx: { db: DatabaseReader },
	conditions: Condition[],
	contacts: readonly Doc<'contacts'>[]
): Promise<ConditionsLookup> {
	const grouped = new Map<ConditionKind, Condition[]>();
	for (const c of conditions) {
		const list = grouped.get(c.kind);
		if (list) list.push(c);
		else grouped.set(c.kind, [c]);
	}

	const out: ConditionsLookup = {};
	for (const [kind, list] of grouped) {
		out[kind] = await (
			conditionTypeModuleFor(kind).preloadLookupForContacts as (
				ctx: { db: DatabaseReader },
				conds: ConditionOfKind<typeof kind>[],
				contacts: readonly Doc<'contacts'>[]
			) => Promise<unknown>
		)(ctx, list as ConditionOfKind<typeof kind>[], contacts);
	}
	return out;
}

/**
 * Evaluate a single condition against a contact using a preloaded lookup.
 * Dispatches to the per-kind module.
 */
export function evaluateOne(
	condition: Condition,
	contact: Doc<'contacts'>,
	lookup: ConditionsLookup
): boolean {
	const module = conditionTypeModuleFor(condition.kind);
	return (module.evaluate as (c: Condition, contact: Doc<'contacts'>, l: unknown) => boolean)(
		condition,
		contact,
		lookup[condition.kind]
	);
}

// ============== Segment matching ==============
// The layer above per-Condition evaluation — filter normalization, the
// empty/AND/OR combine, the live-Contact scan. Lives in `./segmentMatch` and
// is re-exported here so callers keep importing from `../conditions`.
export {
	type SegmentFilters,
	type ParsedSegmentFilters,
	type SegmentCountPage,
	type SegmentMemberPage,
	parseSegmentFilters,
	makeSegmentPredicate,
	evaluateAgainstContact,
	evaluateCondition,
	evaluateSegmentCount,
	countLiveMatches,
	matchLiveContacts,
	countLiveMatchesForSegments,
	countMatchingContactsPage,
	listMatchingContactsPage,
} from './segmentMatch';

export type { Condition, ConditionKind } from './types';
