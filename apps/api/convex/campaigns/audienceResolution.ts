/**
 * Audience resolution (module) — the single mapping from an Audience to its
 * eligible recipients. See CONTEXT.md "Audience resolution (module)" and
 * docs/adr/0033-audience-resolution-module.md.
 *
 * One pure per-Contact eligibility predicate (`selectRecipient`) is the shared
 * core; it lives with the candidate stream and the counting core in the domain
 * sibling `audienceCandidates.ts`. This file owns the PAGINATED walk and the
 * Convex entry points:
 *   - `resolveRecipientPage` — internalQuery, ONE page (the walker's hop).
 *   - `countRecipients`      — public query, the wizard's readout: ONE budgeted
 *                              page inline, else the resumable count job's
 *                              state (`audienceCountJob.ts`, #916).
 *
 * The checkpointed send walker takes ONE page per scheduled hop via
 * `resolveRecipientPageImpl` (one `.paginate()` per execution), and so does
 * the wizard count: its subscribed query reads the first page, and an audience
 * that does not fit in it is counted by a job that walks the same pages. Both
 * paths apply the identical eligibility predicate.
 *
 * The binding capacity pre-flight (`campaigns/capacityPreflight.ts`) calls
 * `countAudience` from `audienceCandidates.ts` directly, with its own ceiling
 * and document budget.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { campaignsQuery } from './_helpers';
import type { QueryCtx } from '../_generated/server';
import { audienceValidator, type StoredAudience } from './audience';
import type { Doc } from '../_generated/dataModel';
import { batchGet } from '../_utils/batchLoader';
import { logWarn } from '../lib/runtimeLog';
import { loadSuppressedAmong } from '../lib/suppression';
import { contactMarketingIneligibility } from '../lib/marketingEligibility';
import {
	conditionsLookupReadsPerBatch,
	conditionsLookupReadsPerContact,
	preloadConditionsLookupForContacts,
	parseSegmentFilters,
	makeSegmentPredicate,
} from '../conditions';
import type { ParsedSegmentFilters } from '../conditions';
import {
	selectRecipient,
	SEND_PAGE_SIZE,
	type AudienceCount,
	type CampaignRecipient,
	type SegmentFilters,
} from './audienceCandidates';
import {
	audienceCountTarget,
	findAudienceCountJob,
	AUDIENCE_COUNT_MAX_AGE_MS,
	AUDIENCE_COUNT_STALL_MS,
	type AudienceCountBackground,
} from './audienceCountState';

/** One resolved page: the eligible recipients, the next cursor, the raw
 *  candidate count examined on this page. `nextCursor === null` ⇒ exhausted. */
export interface ResolvedPage {
	recipients: CampaignRecipient[];
	nextCursor: string | null;
	pageCandidates: number;
}

/**
 * What one page may cost, in the two units Convex limits per execution: index
 * ranges opened (every `db.get` and every `db.query`; the platform cap is
 * 4,096) and documents read (the per-execution cap the rest of this module
 * budgets against is 16,384). Both sit well under the caps so the walker's own
 * reads around the page never tip it over.
 *
 * A page costs a FIXED set-up plus a per-candidate fan-out that depends on the
 * Audience: a topic candidate is its membership, its contact and one
 * suppression point read; a segment candidate is its contact, one point read
 * per distinct condition lookup and one suppression point read. A segment
 * carrying many conditions therefore resolves fewer contacts per page — the
 * cursor advances by what was read, so a smaller page only means more hops.
 */
const PAGE_QUERY_BUDGET = 3_000;
const PAGE_DOCUMENT_BUDGET = 12_000;

interface PageCost {
	fixedQueries: number;
	fixedDocuments: number;
	queriesPerCandidate: number;
	documentsPerCandidate: number;
}

/** The largest page, up to `requested`, whose worst-case cost fits the budget. */
function budgetedPageSize(requested: number, cost: PageCost): number {
	const byQueries = Math.floor((PAGE_QUERY_BUDGET - cost.fixedQueries) / cost.queriesPerCandidate);
	const byDocuments = Math.floor(
		(PAGE_DOCUMENT_BUDGET - cost.fixedDocuments) / cost.documentsPerCandidate
	);
	return Math.max(1, Math.min(Math.floor(requested), byQueries, byDocuments));
}

/**
 * The page's suppression gate: point reads for exactly the addresses this page
 * could send to, read fresh on every page so an address blocked between two
 * hops is excluded on the later one (the "suppression mid-run" invariant).
 * Contacts the eligibility predicate drops before suppression (no email, soft-
 * deleted, globally unsubscribed) need no lookup.
 */
async function pageSuppressionGate(
	ctx: QueryCtx,
	contacts: Iterable<Doc<'contacts'>>
): Promise<ReadonlySet<string>> {
	const emails: string[] = [];
	for (const contact of contacts) {
		if (contact.email && contactMarketingIneligibility(contact) === null) {
			emails.push(contact.email);
		}
	}
	return await loadSuppressedAmong(ctx, emails);
}

/**
 * Resolve exactly ONE page of an Audience's candidates at `cursor`. The single
 * walk primitive shared by every entry below. `selectRecipient` (the
 * eligibility predicate) and the segment match are the same ones the count
 * path uses — this just exposes one page instead of draining them all inside
 * one query.
 *
 * Every supporting read is scoped to the page: condition lookups are point
 * reads for the page's contacts (`preloadConditionsLookupForContacts`) and the
 * suppression gate is point reads for the page's addresses. A page's cost is
 * therefore independent of the size of the blocklist and of every column a
 * condition references; `budgetedPageSize` bounds its fan-out.
 *
 * `cursor === ''` starts at the beginning. `nextCursor` is the opaque Convex
 * `continueCursor` when more pages remain, or `null` when the page was the
 * last. `pageCandidates` is the raw candidate count examined on this page
 * (topic memberships / segment matches), so summing it across pages preserves
 * the prior `total` semantics (`total - eligible` = honest excluded gap).
 */
export async function resolveRecipientPageImpl(
	ctx: QueryCtx,
	args: { audience: StoredAudience; cursor: string; numItems: number }
): Promise<ResolvedPage> {
	const { audience, cursor, numItems } = args;

	if (audience.kind === 'topic') {
		const topic = await ctx.db.get(audience.topicId);
		// membership + contact + suppression per candidate; topic get + paginate.
		const pageSize = budgetedPageSize(numItems, {
			fixedQueries: 2,
			fixedDocuments: 1,
			queriesPerCandidate: 2,
			documentsPerCandidate: 3,
		});

		const { page, isDone, continueCursor } = await ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', audience.topicId))
			.paginate({ cursor: cursor === '' ? null : cursor, numItems: pageSize });

		const contacts = await batchGet(
			ctx,
			page.map((membership) => membership.contactId)
		);
		const blockedEmails = await pageSuppressionGate(
			ctx,
			[...contacts.values()].filter((c): c is Doc<'contacts'> => c !== null)
		);
		const gate = { requiresDoi: topic?.requireDoubleOptIn === true, blockedEmails };
		const recipients: CampaignRecipient[] = [];
		for (const membership of page) {
			const contact = contacts.get(membership.contactId);
			if (!contact) continue; // orphan membership (contact hard-deleted)
			const recipient = selectRecipient(contact, gate, membership.pendingDoiConfirmation);
			if (recipient) recipients.push(recipient);
		}

		return {
			recipients,
			nextCursor: isDone ? null : continueCursor,
			pageCandidates: page.length,
		};
	}

	let filters: SegmentFilters | null = audience.frozenFilters ?? null;
	if (!filters) {
		const segment = await ctx.db.get(audience.segmentId);
		filters = segment ? (segment.filters as SegmentFilters) : null;
	}
	if (!filters) return { recipients: [], nextCursor: null, pageCandidates: 0 };

	// Conditions are storage-validated (`segmentFiltersValidator`), so a parse
	// failure means corrupt/legacy data, not user input. The Segment matching
	// (module) throws on corrupt filters; the count path swallows that to zero,
	// but the send entry logs first — a silent zero means the Campaign reaches
	// nobody.
	let parsedFilters: ParsedSegmentFilters;
	try {
		parsedFilters = parseSegmentFilters(filters);
	} catch (err) {
		logWarn('audienceResolution: segment filters failed to parse; resolving zero recipients', err);
		return { recipients: [], nextCursor: null, pageCandidates: 0 };
	}

	const lookupsPerContact = conditionsLookupReadsPerContact(parsedFilters.conditions);
	const lookupSetup = conditionsLookupReadsPerBatch(parsedFilters.conditions);
	const pageSize = budgetedPageSize(numItems, {
		// segment get + paginate + the lookup's per-page set-up.
		fixedQueries: 2 + lookupSetup,
		fixedDocuments: 1 + lookupSetup,
		queriesPerCandidate: lookupsPerContact + 1,
		documentsPerCandidate: 1 + lookupsPerContact + 1,
	});

	// Stream the live Contacts over the `by_deleted_at` index pinned to
	// `deletedAt === undefined`: soft-deleted rows never enter the page (the
	// index range is exactly the live population — closes the soft-delete leak
	// without a post-filter), and no single page collects the whole Contacts
	// table.
	const { page, isDone, continueCursor } = await ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))
		.paginate({ cursor: cursor === '' ? null : cursor, numItems: pageSize });

	// Paginate FIRST, then resolve the conditions for just this page's contacts.
	const lookup = await preloadConditionsLookupForContacts(ctx, parsedFilters.conditions, page);
	const matches = makeSegmentPredicate(parsedFilters, lookup);
	const matched = page.filter((contact) => matches(contact));

	// segment — DOI never gates (named asymmetry).
	const gate = { requiresDoi: false, blockedEmails: await pageSuppressionGate(ctx, matched) };
	const recipients: CampaignRecipient[] = [];
	for (const contact of matched) {
		const recipient = selectRecipient(contact, gate);
		if (recipient) recipients.push(recipient);
	}

	return {
		recipients,
		nextCursor: isDone ? null : continueCursor,
		// raw segment-match count (live contacts; empty conditions match all)
		pageCandidates: matched.length,
	};
}

// ── Entry 0: ONE page. The checkpointed walker's hop. ────────────────────
// The walker (`emails.resolveCampaignPage`) calls this once per scheduled
// hop at `job.cursor`, enqueues the returned `recipients`, then patches the
// job cursor to `nextCursor`. `cursor === ''` starts at the beginning.
export const resolveRecipientPage = internalQuery({
	args: {
		audience: audienceValidator,
		cursor: v.string(),
		numItems: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ResolvedPage> => {
		return await resolveRecipientPageImpl(ctx, {
			audience: args.audience,
			cursor: args.cursor,
			numItems: args.numItems ?? SEND_PAGE_SIZE,
		});
	},
});

/**
 * Candidates the wizard readout resolves per execution, inline in the
 * subscribed query and per step of the count job alike. One page of the send
 * resolver, which also shrinks it to the per-page query/document budget.
 */
export const COUNT_PAGE_SIZE = 1_000;

/** The wizard readout: the counts plus where the exact count stands. */
export type RecipientCountReadout = AudienceCount & { background: AudienceCountBackground };

/**
 * The body of `countRecipients`, exported for the cost probe and tests.
 *
 * Every execution is bounded: at most one indexed job lookup plus ONE budgeted
 * recipient page (`COUNT_PAGE_SIZE`, the page resolver's query and document
 * budgets). It never streams the audience, so a 50,000-member topic or a
 * zero-match segment over 100,000 contacts costs the same as a small one.
 *
 *  1. A job for this exact definition is complete → its exact totals.
 *  2. A job is counting → its running totals, a lower bound.
 *  3. Otherwise the first page inline: `exact` when it reached the end,
 *     else a lower bound (`read_budget_exhausted`) and `unavailable`, which
 *     tells the client to request a job.
 *
 * While a job exists the query does not read the page at all, so the reruns
 * each committed step triggers cost a few documents, not a page.
 */
export async function countRecipientsForAudience(
	ctx: QueryCtx,
	audience: StoredAudience
): Promise<RecipientCountReadout> {
	const target = await audienceCountTarget(ctx, audience);
	if (target === null) {
		return { total: 0, eligible: 0, completeness: 'exact', background: { status: 'not_needed' } };
	}
	const job = await findAudienceCountJob(ctx, target);
	if (job?.status === 'complete') {
		const countedAt = job.completedAt ?? job.updatedAt;
		return {
			total: job.total,
			eligible: job.eligible,
			completeness: 'exact',
			background: {
				status: 'complete',
				countedAt,
				retryAfter: countedAt + AUDIENCE_COUNT_MAX_AGE_MS,
			},
		};
	}
	if (job?.status === 'counting') {
		return {
			total: job.total,
			eligible: job.eligible,
			completeness: 'read_budget_exhausted',
			background: {
				status: 'counting',
				startedAt: job.startedAt,
				retryAfter: job.updatedAt + AUDIENCE_COUNT_STALL_MS,
			},
		};
	}
	const page = await resolveRecipientPageImpl(ctx, {
		audience: target.audience,
		cursor: '',
		numItems: COUNT_PAGE_SIZE,
	});
	const reachedEnd = page.nextCursor === null;
	return {
		total: page.pageCandidates,
		eligible: page.recipients.length,
		completeness: reachedEnd ? 'exact' : 'read_budget_exhausted',
		background: reachedEnd ? { status: 'not_needed' } : { status: 'unavailable' },
	};
}

// ── Entry 1: the wizard's audience-size readout. Runs the IDENTICAL predicate
// (the same page resolver) as the send walk, so `eligible` equals the delivered
// count; `total - eligible` is the honest excluded gap. Bounded per execution;
// an audience past one page is counted by `audienceCountJob.ts` (#916). ──
export const countRecipients = campaignsQuery({
	args: { audience: v.optional(audienceValidator) },
	handler: async (ctx, { audience }): Promise<RecipientCountReadout> => {
		if (!audience) {
			return { total: 0, eligible: 0, completeness: 'exact', background: { status: 'not_needed' } };
		}
		return await countRecipientsForAudience(ctx, audience);
	},
});
