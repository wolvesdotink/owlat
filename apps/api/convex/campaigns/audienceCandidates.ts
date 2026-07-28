/**
 * Audience candidates (module) — the eligibility predicate, the unpaginated
 * candidate STREAM, and the counting core that sits on top of it. Split out of
 * `audienceResolution.ts` (which keeps the paginated per-hop page resolver and
 * the Convex entry points) once that file passed the ~500 LOC split threshold
 * in `apps/api/convex/CONVENTIONS.md`. The dependency runs ONE way:
 * `audienceResolution.ts` → this module.
 *
 * See CONTEXT.md "Audience resolution (module)" and
 * docs/adr/0033-audience-resolution-module.md.
 */

import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { Infer } from 'convex/values';
import type { StoredAudience } from './audience';
import { segmentFiltersValidator } from '../lib/convexValidators';
import { logWarn } from '../lib/runtimeLog';
import { normalizeEmail } from '../lib/inputGuards';
import { loadSuppressionSet, loadSuppressionSetBounded } from '../lib/suppression';
import {
	conditionsLookupReadsPerBatch,
	conditionsLookupReadsPerContact,
	preloadConditionsLookup,
	preloadConditionsLookupForContacts,
	parseSegmentFilters,
	makeSegmentPredicate,
	type ParsedSegmentFilters,
} from '../conditions';

export interface CampaignRecipient {
	_id: Id<'contacts'>;
	email: string;
	firstName?: string;
	lastName?: string;
	timezone?: string;
	language?: string;
	/**
	 * `contacts.engagementScore` (0-100) at resolution time. Projected here so
	 * the enqueue path can put it on the send envelope for the MTA's
	 * enqueue-time priority bands without a second read of the contact row.
	 * Absent for a contact the scorer has not reached yet.
	 */
	engagementScore?: number;
}

/** Segment-filter shape — `frozenFilters` or the live Segment's `filters`. */
export type SegmentFilters = Infer<typeof segmentFiltersValidator>;

/**
 * Project a loaded Contact onto the recipient shape. Only ever called after
 * `selectRecipient`'s email-present gate, so `email` is guaranteed.
 */
function projectRecipient(contact: Doc<'contacts'>): CampaignRecipient {
	return {
		_id: contact._id,
		email: contact.email!,
		firstName: contact.firstName,
		lastName: contact.lastName,
		timezone: contact.timezone,
		language: contact.language,
		engagementScore: contact.engagementScore,
	};
}

/**
 * The eligibility decision for one loaded Contact — the ONLY definition of
 * "eligible recipient". `null` = excluded. Ordered predicate:
 * live-contact → email-present → not-suppressed → not-globally-unsubscribed →
 * DOI (topic only) → form-forced-DOI still pending (topic membership only).
 *
 * The global-unsubscribe gate applies to BOTH paths (topic and segment): a
 * Contact who used the public unsubscribe link / preference-center "unsubscribe
 * from everything" set `contacts.unsubscribedAt`, and must never be re-targeted
 * by ANY marketing audience — including a segment that selects from the contacts
 * table independent of topic membership (the CAN-SPAM/GDPR gap this closes).
 *
 * `requiresDoi` is true ONLY for a topic Audience whose Topic requires DOI; it
 * is always false for a segment Audience (the named asymmetry — segments are
 * explicit operator targeting, not consent-derived membership). Do not gate the
 * segment path on DOI without revisiting CONTEXT.md "Audience resolution
 * (module)".
 *
 * `membershipPendingDoi` is the per-membership `contactTopics.pendingDoiConfirmation`
 * flag: a public form with its own "Enable Double Opt-In" toggle (forceDoi) can
 * require confirmation on a topic that itself does NOT set `requireDoubleOptIn`.
 * Such a membership is stored with `pendingDoiConfirmation: true` and only cleared
 * once the contact confirms (see contacts/doiLifecycle.ts). A still-pending
 * membership is excluded even when `requiresDoi` is false — otherwise the form's
 * DOI toggle would be silently ignored at send time (consent/legal exposure). It
 * is always undefined/false on the segment path (no membership).
 */
export function selectRecipient(
	contact: Doc<'contacts'>,
	gate: { requiresDoi: boolean; blockedEmails: ReadonlySet<string> },
	membershipPendingDoi?: boolean
): CampaignRecipient | null {
	if (contact.deletedAt !== undefined) return null; // live-contact
	if (!contact.email) return null; // email-present
	if (gate.blockedEmails.has(normalizeEmail(contact.email))) return null; // suppression
	if (contact.unsubscribedAt !== undefined) return null; // global marketing opt-out
	if (
		gate.requiresDoi &&
		contact.doiStatus !== 'confirmed' &&
		contact.doiStatus !== 'not_required'
	) {
		return null; // DOI (topic only)
	}
	if (membershipPendingDoi === true) {
		return null; // form-forced DOI on a non-DOI topic, not yet confirmed
	}
	return projectRecipient(contact);
}

/**
 * Ceiling for `countRecipients`. The wizard readout streams until it has either
 * exhausted the audience or accumulated this many CANDIDATES (topic memberships,
 * or segment MATCHES), then stops and returns `completeness: 'candidate_capped'` (the UI
 * renders `25,000+`).
 *
 * NOTE — this caps candidates, NOT documents read. For a topic it also bounds the
 * scan (memberships ARE the population). For a SEGMENT it does not: a narrow
 * segment over a large contacts table streams every live contact before it ever
 * reaches the ceiling, so the reactive count is O(live contacts) up to the Convex
 * per-execution read limit (beyond which it errors). This is still a large
 * improvement over the previous page-loop, which threw on its 2nd `.paginate()`
 * once a segment had >500 live contacts. Exact counts for narrow segments over
 * very large tables ultimately want a denormalized/aggregate counter rather than
 * a live scan — tracked as a follow-up.
 */
export const COUNT_CEILING = 25_000;

/**
 * A budget on DOCUMENTS READ (not rows examined, and not candidates yielded).
 *
 * Convex caps a single function execution at 16,384 document reads, and the
 * audience scan does not cost one document per row: a topic candidate costs the
 * membership PLUS its contact, and a segment candidate costs the contact plus
 * one point read per (contact × condition lookup). Charging rows would let a
 * "bounded" scan overrun the limit by 2-3x on exactly the shapes the bound
 * exists for.
 *
 * `COUNT_CEILING` bounds candidates, which for a topic also bounds the scan —
 * memberships ARE the population — but for a SEGMENT does not: a narrow segment
 * streams every live contact before it ever reaches a candidate ceiling. A
 * caller that runs inside a MUTATION (the binding capacity pre-flight) cannot
 * afford that: it would blow the per-execution read limit and drag the whole
 * live contacts table into the mutation's OCC read set. Such callers pass a
 * budget and treat `exhausted` as "could not measure" rather than as a count.
 */
export interface ExamineBudget {
	/** Documents this scan may read in total. */
	readonly limit: number;
	/** Documents charged so far. */
	spent: number;
	/** The budget could not cover the next read; the scan stopped short. */
	exhausted: boolean;
	/**
	 * The suppression set was truncated, so candidates were filtered through a
	 * SUBSET of the blocklist and the eligible tally is an OVER-count. Tracked
	 * separately from `exhausted` because an over-count bounds nothing in either
	 * direction — see `AudienceCountCompleteness`.
	 */
	suppressionTruncated: boolean;
}

/**
 * Charge `documents` reads against the budget. `false` ⇒ the budget cannot
 * cover them; stop streaming. Charged BEFORE the reads happen, so the limit is
 * a real ceiling rather than an after-the-fact observation.
 */
function spendDocuments(budget: ExamineBudget | undefined, documents: number): boolean {
	if (!budget) return true;
	if (budget.spent + documents > budget.limit) {
		budget.exhausted = true;
		return false;
	}
	budget.spent += documents;
	return true;
}

/**
 * Documents one topic candidate costs: the `contactTopics` membership the
 * iterator yields, plus the `ctx.db.get` of its contact.
 */
const TOPIC_DOCUMENTS_PER_CANDIDATE = 2;

/**
 * Suppressed addresses a BUDGETED scan will read. The blocklist is intrinsically
 * small (one row per suppressed address), but "small" is not a bound, and the
 * budgeted caller runs inside a send mutation where an unbounded collect is both
 * a read-limit risk and an OCC-conflict surface (D16). Exceeding it is reported
 * through `ExamineBudget.suppressionTruncated`, never thrown.
 */
const SUPPRESSION_SCAN_LIMIT = 2_000;

/**
 * How many examined contacts share one condition-lookup preload on the budgeted
 * segment path. Small enough that the per-batch point reads stay well inside the
 * per-execution read limit, large enough that the batching overhead is noise.
 */
const SEGMENT_LOOKUP_BATCH = 200;

/** Load the suppression set under the scan's read budget, charging what it costs. */
async function loadBudgetedSuppression(
	ctx: QueryCtx,
	budget: ExamineBudget | undefined
): Promise<ReadonlySet<string>> {
	if (!budget) return await loadSuppressionSet(ctx);
	const { blockedEmails, truncated, rowsRead } = await loadSuppressionSetBounded(
		ctx,
		SUPPRESSION_SCAN_LIMIT
	);
	if (truncated) budget.suppressionTruncated = true;
	// Charge the ROWS the query read, not the de-duplicated set that survived it:
	// `.take(bound + 1)` reads every row it returns, duplicates and the truncation
	// probe included, and charging the smaller number would let the "bound" under-
	// count exactly the reads it exists to cap. `spendDocuments` returning false
	// only means the scan is already over budget; the read happened either way, and
	// the per-candidate charges below will see `exhausted` and stop immediately.
	spendDocuments(budget, rowsRead);
	return blockedEmails;
}

/**
 * The BOUNDED segment scan: identical predicate and identical yields to the
 * unbudgeted branch of `streamAudienceCandidates`, but the condition lookup is
 * resolved per batch of examined contacts (`preloadConditionsLookupForContacts`,
 * point reads) instead of by front-loading whole columns. Reads therefore scale
 * with the read budget, never with the size of a topic or any other column a
 * condition happens to reference.
 */
async function* streamSegmentMatchesBounded(
	ctx: QueryCtx,
	parsedFilters: ParsedSegmentFilters,
	gate: { requiresDoi: boolean; blockedEmails: ReadonlySet<string> },
	budget: ExamineBudget
): AsyncGenerator<{ recipient: CampaignRecipient | null }> {
	// The contact row itself, plus whatever the batched lookup point-reads for it.
	// The parsed conditions are already in hand, so this is exact, not a guess.
	const documentsPerContact = 1 + conditionsLookupReadsPerContact(parsedFilters.conditions);
	// The preload's FIXED set-up, paid once per batch rather than per contact
	// (resolving a custom property key to its id, say). Left uncharged it is a
	// per-batch hole in a budget whose whole job is to be a real ceiling.
	const documentsPerBatch = conditionsLookupReadsPerBatch(parsedFilters.conditions);
	let batch: Doc<'contacts'>[] = [];

	async function* drain(): AsyncGenerator<{ recipient: CampaignRecipient | null }> {
		if (batch.length === 0) return;
		const pending = batch;
		batch = [];
		// Charged BEFORE the preload runs, like every other read on this path. It
		// may push the scan over budget; the flush below still yields what was
		// already read, and the contact loop stops on the next `spendDocuments`.
		spendDocuments(budget, documentsPerBatch);
		const lookup = await preloadConditionsLookupForContacts(ctx, parsedFilters.conditions, pending);
		const matches = makeSegmentPredicate(parsedFilters, lookup);
		for (const contact of pending) {
			if (matches(contact)) yield { recipient: selectRecipient(contact, gate) };
		}
	}

	for await (const contact of ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))) {
		// Every live contact is a DOCUMENT read even when it is not a candidate, and
		// it drags its condition lookups along with it, so the budget is charged here
		// — before the predicate — not on matches. Exhaustion stops the scan but still
		// flushes what was already read: a partial count is a valid LOWER bound and
		// the caller is told so (`read_budget_exhausted`).
		if (!spendDocuments(budget, documentsPerContact)) break;
		batch.push(contact);
		if (batch.length >= SEGMENT_LOOKUP_BATCH) yield* drain();
	}
	yield* drain();
}

/**
 * Async-stream every CANDIDATE of an Audience — one yield per raw candidate the
 * page walk would examine (the `pageCandidates` unit), carrying the eligible
 * `recipient` or `null` — WITHOUT `.paginate()`. Convex permits a single
 * `.paginate()` per function execution, so the count/materialize entries cannot
 * loop pages; they iterate this stream and stop at COUNT_CEILING. The per-row
 * eligibility (suppression, DOI gate, segment predicate) is IDENTICAL to
 * `resolveRecipientPageImpl` — only the fetch strategy differs (row stream vs one
 * paginated page per scheduled hop).
 */
export async function* streamAudienceCandidates(
	ctx: QueryCtx,
	audience: StoredAudience,
	budget?: ExamineBudget
): AsyncGenerator<{ recipient: CampaignRecipient | null }> {
	const blockedEmails = await loadBudgetedSuppression(ctx, budget);

	if (audience.kind === 'topic') {
		const topic = await ctx.db.get(audience.topicId);
		const gate = { requiresDoi: topic?.requireDoubleOptIn === true, blockedEmails };
		for await (const membership of ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', audience.topicId))) {
			if (!spendDocuments(budget, TOPIC_DOCUMENTS_PER_CANDIDATE)) return;
			const contact = await ctx.db.get(membership.contactId);
			// Every membership is a candidate (mirrors `pageCandidates: page.length`);
			// an orphan membership (contact hard-deleted) is still a candidate but
			// yields no recipient. A form-forced-DOI membership still pending
			// confirmation is a candidate too, but is excluded (yields null).
			yield {
				recipient: contact
					? selectRecipient(contact, gate, membership.pendingDoiConfirmation)
					: null,
			};
		}
		return;
	}

	// segment — DOI never gates (named asymmetry).
	const gate = { requiresDoi: false, blockedEmails };
	let filters: SegmentFilters | null = audience.frozenFilters ?? null;
	if (!filters) {
		const segment = await ctx.db.get(audience.segmentId);
		filters = segment ? (segment.filters as SegmentFilters) : null;
	}
	if (!filters) return;

	let parsedFilters: ParsedSegmentFilters;
	try {
		parsedFilters = parseSegmentFilters(filters);
	} catch (err) {
		logWarn('audienceCandidates: segment filters failed to parse; resolving zero recipients', err);
		return;
	}

	// A budgeted stream is a BOUNDED one, end to end. `preloadConditionsLookup`
	// front-loads whole columns — for a `topic_membership` condition it
	// `.collect()`s the entire `contactTopics.by_topic` range — and the budgeted
	// caller (the binding capacity pre-flight) runs inside `campaigns.scheduling
	// .schedule` / `campaigns.campaigns.sendNow`. An unbounded collect there would
	// exceed the Convex per-execution read limit, turning a failure to MEASURE
	// into a blocked SEND (D2), and would drag the whole junction table into the
	// mutation's OCC read set (D16). So the budgeted path preloads per BATCH of
	// examined contacts via point reads instead. Unbudgeted callers (the reactive
	// wizard readout) keep the shipped whole-column preload unchanged.
	if (budget) {
		yield* streamSegmentMatchesBounded(ctx, parsedFilters, gate, budget);
		return;
	}

	const lookup = await preloadConditionsLookup(ctx, parsedFilters.conditions);
	const matches = makeSegmentPredicate(parsedFilters, lookup);

	// Live Contacts over `by_deleted_at` pinned to `deletedAt === undefined`:
	// soft-deleted rows never enter the stream (the index range is exactly the
	// live population). Only segment-matches are candidates.
	for await (const contact of ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))) {
		if (!matches(contact)) continue;
		yield { recipient: selectRecipient(contact, gate) };
	}
}

/**
 * How complete a count is — ONE discriminated field rather than a handful of
 * booleans that could encode impossible combinations.
 *
 *  - `exact`                 — the audience was enumerated to the end.
 *  - `candidate_capped`      — `ceiling` candidates were reached; the counts are
 *                              clamped to it and the audience is "at least" that.
 *  - `read_budget_exhausted` — the document budget ran out first; the counts are
 *                              a LOWER bound on an audience whose real size is
 *                              unknown (the scan stopped mid-stream).
 *  - `suppression_truncated` — the suppression set could not be read in full, so
 *                              candidates were filtered through a SUBSET of the
 *                              blocklist and `eligible` is an OVER-count. It
 *                              bounds the audience in NEITHER direction and must
 *                              never license a decision.
 *
 * `candidate_capped` and `read_budget_exhausted` mean "at least"; only `exact`
 * licenses quoting the number as the audience size, and only `exact` /
 * `candidate_capped` / `read_budget_exhausted` may be read as a lower bound.
 */
export type AudienceCountCompleteness =
	| 'exact'
	| 'candidate_capped'
	| 'read_budget_exhausted'
	| 'suppression_truncated';

export interface AudienceCount {
	total: number;
	eligible: number;
	completeness: AudienceCountCompleteness;
}

/**
 * The ctx-bound counting core. Callers that already hold a `QueryCtx` (or a
 * `MutationCtx`, which is one) call this DIRECTLY — no `ctx.runQuery` hop, no
 * sub-transaction, no session to launder.
 *
 * `ceiling` lets a caller bound its own CANDIDATE count below `COUNT_CEILING`
 * when it only needs to know "at least N": the binding capacity pre-flight
 * stops counting as soon as the audience provably exceeds everything the
 * deployment could send, so its cost is bounded by capacity, not audience size.
 *
 * `documentBudget` bounds DOCUMENTS READ, which is the only bound that holds for
 * a segment audience (see `ExamineBudget`). Hitting it yields
 * `completeness: 'read_budget_exhausted'` — the counts are then a LOWER bound on
 * an audience of unknown size, never the size itself.
 */
export async function countAudience(
	ctx: QueryCtx,
	audience: StoredAudience,
	options: { ceiling?: number; documentBudget?: number } = {}
): Promise<AudienceCount> {
	const requested = options.ceiling;
	const ceiling =
		requested !== undefined && Number.isFinite(requested) && requested > 0
			? Math.min(COUNT_CEILING, Math.ceil(requested))
			: COUNT_CEILING;
	const requestedBudget = options.documentBudget;
	const budget: ExamineBudget | undefined =
		requestedBudget !== undefined && Number.isFinite(requestedBudget) && requestedBudget > 0
			? {
					limit: Math.ceil(requestedBudget),
					spent: 0,
					exhausted: false,
					suppressionTruncated: false,
				}
			: undefined;
	let total = 0;
	let eligible = 0;
	for await (const { recipient } of streamAudienceCandidates(ctx, audience, budget)) {
		total += 1;
		if (recipient) eligible += 1;
		if (total >= ceiling) {
			// Cap reached — clamp to the ceiling and stop streaming. There may be
			// more candidates, so the readout is "at least CEILING".
			return {
				total: ceiling,
				eligible: Math.min(eligible, ceiling),
				completeness: budget?.suppressionTruncated ? 'suppression_truncated' : 'candidate_capped',
			};
		}
	}
	// An over-count outranks an under-count: a truncated suppression set makes
	// `eligible` unusable as a bound in either direction, so it is reported even
	// when the scan also ran out of budget.
	if (budget?.suppressionTruncated) {
		return { total, eligible, completeness: 'suppression_truncated' };
	}
	if (budget?.exhausted) return { total, eligible, completeness: 'read_budget_exhausted' };
	return { total, eligible, completeness: 'exact' };
}
