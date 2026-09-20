/**
 * Segment matching (module) — the single owner of "match a Contact population
 * against a stored filter set". See CONTEXT.md "Segment matching (module)".
 *
 * The `conditions/` registry owns the per-Condition primitive (`evaluateOne`)
 * and the lookup preload. This module owns the layer above it: filter
 * normalization, the empty-conditions ("match all") rule, the AND/OR combine,
 * and the live-Contact scan — the bundle of decisions that previously drifted
 * across five open-coded copies (the preview, the count, the multi-segment
 * cron, the Audience resolution segment branch, and the automation step).
 *
 * Two layers:
 *   - Pure core (throws on corrupt filters — they are storage-validated, so a
 *     parse failure is corrupt data, not user input; callers decide whether to
 *     swallow or surface): `parseSegmentFilters` + `makeSegmentPredicate`.
 *   - Lenient async conveniences for the preview / count / cron paths, which
 *     bake in the soft-delete-excluding live-Contact scan and treat corrupt filters as a zero
 *     match: `countLiveMatches`, `matchLiveContacts`, `countLiveMatchesForSegments`.
 *     Each covers ONE budgeted slice of the population and reports where it
 *     stopped; their callers reschedule themselves until the walk is done.
 *
 * The send path (Audience resolution) does NOT use the conveniences — it builds
 * the predicate from the pure core so it can interleave eligibility filtering
 * in one walk and log-and-zero on corrupt data rather than silently swallow.
 */

import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import {
	parseCondition,
	preloadConditionsLookup,
	preloadConditionsLookupForContacts,
	conditionsLookupReadsPerContact,
	conditionsLookupReadsPerBatch,
	evaluateOne,
	type Condition,
} from './index';
import {
	forEachLiveContactChunk,
	type LiveScanOptions,
	type LiveScanProgress,
} from './liveContactScan';

/**
 * Stored segment-filter shape (`segments.filters`, `campaigns.audience`'s
 * `frozenFilters`). Conditions are `unknown[]` at the boundary so callers can
 * pass validator-derived, JSON-parsed, or legacy shapes without casting; the
 * module normalizes each through the conditions registry.
 */
export interface SegmentFilters {
	logic: 'AND' | 'OR';
	conditions: readonly unknown[];
}

/** Filters whose conditions have been normalized to typed `Condition`s. */
export interface ParsedSegmentFilters {
	logic: 'AND' | 'OR';
	conditions: Condition[];
}

/** The preloaded lookup type, derived so the registry internal stays private. */
type ConditionsLookup = Awaited<ReturnType<typeof preloadConditionsLookup>>;

/**
 * Normalize stored filters into typed conditions. Throws on bad JSON or a
 * condition shape/operator/field violation — corrupt data, not user input.
 */
export function parseSegmentFilters(input: string | SegmentFilters): ParsedSegmentFilters {
	const raw: SegmentFilters =
		typeof input === 'string' ? (JSON.parse(input) as SegmentFilters) : input;
	return {
		logic: raw.logic,
		conditions: (raw.conditions ?? []).map((c) => parseCondition(c)),
	};
}

/**
 * Build the per-Contact match predicate for a parsed filter set over a
 * preloaded lookup. Pure and synchronous — the test surface. Empty conditions
 * match every Contact; otherwise the conditions are combined with short-circuit
 * AND/OR. The lookup must have been preloaded for (at least) these conditions.
 */
export function makeSegmentPredicate(
	filters: ParsedSegmentFilters,
	lookup: ConditionsLookup
): (contact: Doc<'contacts'>) => boolean {
	const { logic, conditions } = filters;
	if (conditions.length === 0) return () => true;
	return (contact) => {
		if (logic === 'AND') {
			for (const c of conditions) {
				if (!evaluateOne(c, contact, lookup)) return false;
			}
			return true;
		}
		for (const c of conditions) {
			if (evaluateOne(c, contact, lookup)) return true;
		}
		return false;
	};
}

/**
 * Evaluate a logic-joined set of already-parsed conditions against a single
 * Contact. The single-Contact case of the matcher — used by the automation
 * `condition` step (one condition, one Contact at a time).
 */
export async function evaluateAgainstContact(
	ctx: { db: DatabaseReader },
	conditions: Condition[],
	logic: 'AND' | 'OR',
	contact: Doc<'contacts'>
): Promise<boolean> {
	if (conditions.length === 0) return true;
	// Bounded resolution for the single contact — point reads, not a whole-column
	// collect. The automation `condition` step reaches this per run, per step.
	const lookup = await preloadConditionsLookupForContacts(ctx, conditions, [contact]);
	return makeSegmentPredicate({ logic, conditions }, lookup)(contact);
}

/**
 * The per-execution slice of a live-Contact walk. Every convenience below
 * returns one: its own partial result plus the {@link LiveScanProgress} the
 * caller needs to resume. None of them counts the whole population in one go —
 * see `liveContactScan.ts` for why streaming is not the same as bounded.
 */
export type SegmentCountScan = LiveScanProgress & { matched: number };
export type SegmentMatchScan = LiveScanProgress & { contacts: Doc<'contacts'>[] };
export type SegmentsCountScan = LiveScanProgress & { counts: Map<string, number> };

/**
 * Documents one Contact and one lookup preload cost for `conditions`. The
 * chunked walk resolves its lookup per chunk (point reads over just those
 * Contacts) rather than front-loading whole columns, so the read cost scales
 * with the budget instead of with the size of whatever topic or property a
 * condition happens to name.
 */
function scanCost(conditions: Condition[]): {
	documentsPerContact: number;
	documentsPerChunk: number;
} {
	return {
		documentsPerContact: 1 + conditionsLookupReadsPerContact(conditions),
		documentsPerChunk: conditionsLookupReadsPerBatch(conditions),
	};
}

/**
 * Count live Contacts matching a stored filter set, for ONE budgeted execution.
 * Lenient: corrupt filters count as zero (preview / count posture). The caller
 * sums `matched` across executions, resuming from `cursor` until `done`.
 */
export async function countLiveMatches(
	ctx: { db: DatabaseReader },
	input: string | SegmentFilters,
	opts?: Pick<LiveScanOptions, 'cursor' | 'documentBudget'>
): Promise<SegmentCountScan> {
	let filters: ParsedSegmentFilters;
	try {
		filters = parseSegmentFilters(input);
	} catch {
		return { matched: 0, scanned: 0, done: true, cursor: null };
	}

	let matched = 0;
	const progress = await forEachLiveContactChunk(
		ctx,
		{ ...opts, ...scanCost(filters.conditions) },
		async (chunk) => {
			const lookup = await preloadConditionsLookupForContacts(ctx, filters.conditions, chunk);
			const matches = makeSegmentPredicate(filters, lookup);
			for (const contact of chunk) {
				if (matches(contact)) matched++;
			}
		}
	);
	return { matched, ...progress };
}

/**
 * Return live Contacts matching a stored filter set, optionally capped at
 * `limit`, for ONE budgeted execution. Lenient: corrupt filters yield no
 * matches. Hitting `limit` ends the walk (`done`) — the caller has what it
 * asked for; running out of budget does not, and hands back a cursor.
 */
export async function matchLiveContacts(
	ctx: { db: DatabaseReader },
	input: string | SegmentFilters,
	opts?: Pick<LiveScanOptions, 'cursor' | 'documentBudget'> & { limit?: number }
): Promise<SegmentMatchScan> {
	const limit = opts?.limit;
	let filters: ParsedSegmentFilters;
	try {
		filters = parseSegmentFilters(input);
	} catch {
		return { contacts: [], scanned: 0, done: true, cursor: null };
	}

	const contacts: Doc<'contacts'>[] = [];
	const progress = await forEachLiveContactChunk(
		ctx,
		{ ...opts, ...scanCost(filters.conditions) },
		async (chunk) => {
			const lookup = await preloadConditionsLookupForContacts(ctx, filters.conditions, chunk);
			const matches = makeSegmentPredicate(filters, lookup);
			for (const contact of chunk) {
				if (!matches(contact)) continue;
				contacts.push(contact);
				if (limit !== undefined && contacts.length >= limit) return false; // stop the walk
			}
		}
	);
	return { contacts, ...progress };
}

/**
 * Count live matches for many segments in ONE budgeted execution — every
 * segment's predicate is evaluated against each visited Contact, so a batch of
 * segments shares one walk and one lookup preload per chunk instead of one walk
 * each. Lenient per segment: a segment whose filters fail to parse counts as
 * zero. The caller sums each segment's count across executions.
 */
export async function countLiveMatchesForSegments(
	ctx: { db: DatabaseReader },
	segments: Array<{ segmentId: string; filters: string | SegmentFilters }>,
	opts?: Pick<LiveScanOptions, 'cursor' | 'documentBudget'>
): Promise<SegmentsCountScan> {
	const results = new Map<string, number>();

	const parsed: { segmentId: string; filters: ParsedSegmentFilters }[] = [];
	for (const seg of segments) {
		try {
			parsed.push({ segmentId: seg.segmentId, filters: parseSegmentFilters(seg.filters) });
		} catch {
			results.set(seg.segmentId, 0);
		}
	}
	if (parsed.length === 0) return { counts: results, scanned: 0, done: true, cursor: null };

	const allConditions: Condition[] = parsed.flatMap((p) => p.filters.conditions);
	const counts = parsed.map(({ segmentId, filters }) => ({ segmentId, filters, count: 0 }));

	const progress = await forEachLiveContactChunk(
		ctx,
		{ ...opts, ...scanCost(allConditions) },
		async (chunk) => {
			// One preload covers every segment's conditions for this chunk, so the
			// shared walk stays one lookup wide rather than one per segment.
			const lookup = await preloadConditionsLookupForContacts(ctx, allConditions, chunk);
			for (const entry of counts) {
				const matches = makeSegmentPredicate(entry.filters, lookup);
				for (const contact of chunk) {
					if (matches(contact)) entry.count++;
				}
			}
		}
	);
	for (const { segmentId, count } of counts) {
		results.set(segmentId, count);
	}
	return { counts: results, ...progress };
}

/** One page of {@link countMatchingContactsPage}. */
export interface SegmentCountPage {
	matched: number;
	scanned: number;
	isDone: boolean;
	continueCursor: string | null;
}

/** One page of {@link listMatchingContactsPage}. */
export interface SegmentMemberPage {
	members: Doc<'contacts'>[];
	isDone: boolean;
	continueCursor: string;
}

/**
 * Return the matching members within ONE bounded page of the live-Contact
 * population. The membership counterpart to {@link countMatchingContactsPage}:
 * same per-page lookup (per-contact point reads, never a whole-column collect)
 * and same soft-delete-excluding `by_deleted_at` scan, but it returns the
 * matched Contact Docs rather than just a tally. The reactive `segments.listMembers`
 * query drives it page-by-page through the standard `paginationOpts` contract,
 * so the segment-detail view can scroll the materialized membership without any
 * single transaction collecting the whole Contacts table. A page may contain
 * fewer matches than it scanned (most Contacts are filtered out); the caller
 * keeps paging on the returned cursor until `isDone`. Lenient: corrupt filters
 * yield an empty, done page.
 */
export async function listMatchingContactsPage(
	ctx: { db: DatabaseReader },
	input: string | SegmentFilters,
	cursor: string | null,
	pageSize: number
): Promise<SegmentMemberPage> {
	let filters: ParsedSegmentFilters;
	try {
		filters = parseSegmentFilters(input);
	} catch {
		return { members: [], isDone: true, continueCursor: '' };
	}

	const { page, isDone, continueCursor } = await ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))
		.paginate({ cursor, numItems: pageSize });

	const lookup = await preloadConditionsLookupForContacts(ctx, filters.conditions, page);
	const matches = makeSegmentPredicate(filters, lookup);
	const members: Doc<'contacts'>[] = [];
	for (const contact of page) {
		if (matches(contact)) members.push(contact);
	}

	return { members, isDone, continueCursor };
}

/**
 * Count matches within ONE bounded page of the live-Contact population, resolving
 * each kind's lookup for just that page (per-contact point reads — never a
 * whole-column collect). Returns the page's partial count + the cursor to
 * continue from. The caller (a cursor-checkpointed action walker) sums the
 * partials across invocations, so no single transaction scans the whole table
 * and no reactive subscription re-runs the count on every Contacts write.
 * Lenient: corrupt filters yield a zero, done page.
 */
export async function countMatchingContactsPage(
	ctx: { db: DatabaseReader },
	input: string | SegmentFilters,
	cursor: string | null,
	pageSize: number
): Promise<SegmentCountPage> {
	let filters: ParsedSegmentFilters;
	try {
		filters = parseSegmentFilters(input);
	} catch {
		return { matched: 0, scanned: 0, isDone: true, continueCursor: null };
	}

	const { page, isDone, continueCursor } = await ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))
		.paginate({ cursor, numItems: pageSize });

	const lookup = await preloadConditionsLookupForContacts(ctx, filters.conditions, page);
	const matches = makeSegmentPredicate(filters, lookup);
	let matched = 0;
	for (const contact of page) {
		if (matches(contact)) matched++;
	}

	return {
		matched,
		scanned: page.length,
		isDone,
		continueCursor: isDone ? null : continueCursor,
	};
}

/**
 * Evaluate a single raw filter condition against one contact. Lenient: an
 * unknown / malformed condition matches nothing. A convenience over the pure
 * core — new code should prefer the batch entries above or the registry
 * directly. ADR-0033 keeps this name stable for the segment-builder surface.
 */
export async function evaluateCondition(
	ctx: { db: DatabaseReader },
	conditionRaw: unknown,
	contact: Doc<'contacts'>
): Promise<boolean> {
	let filters: ParsedSegmentFilters;
	try {
		filters = parseSegmentFilters({ logic: 'AND', conditions: [conditionRaw] });
	} catch {
		return false;
	}
	const lookup = await preloadConditionsLookup(ctx, filters.conditions);
	return makeSegmentPredicate(filters, lookup)(contact);
}

/**
 * Count contacts matching a set of segment filters, with an `eligible` field
 * that mirrors `total` (DOI never gates a segment — see the Audience resolution
 * module for the campaign-send eligibility gap). The `{ total, eligible }`
 * adapter over {@link countLiveMatches} the segment-count caller expects; it
 * inherits the same per-execution budget, so `total` is this execution's
 * partial until `done`.
 */
export async function evaluateSegmentCount(
	ctx: { db: DatabaseReader },
	filtersInput: string | SegmentFilters,
	opts?: Pick<LiveScanOptions, 'cursor' | 'documentBudget'>
): Promise<LiveScanProgress & { total: number; eligible: number }> {
	const { matched, ...progress } = await countLiveMatches(ctx, filtersInput, opts);
	return { total: matched, eligible: matched, ...progress };
}
