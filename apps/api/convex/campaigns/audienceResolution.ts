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
 *   - `resolveRecipients`    — internalQuery, materializes candidates by streaming
 *                              (test/asserts only), bounded by COUNT_CEILING.
 *   - `countRecipients`      — public query, accumulates integers by streaming,
 *                              capped at COUNT_CEILING.
 *
 * The checkpointed send walker takes ONE page per scheduled hop via
 * `resolveRecipientPageImpl` (one `.paginate()` per execution); the count and
 * materialize entries instead STREAM candidates via `streamAudienceCandidates`
 * (async iteration, no `.paginate()`) because Convex allows a single
 * `.paginate()` per function execution. All three apply the identical
 * eligibility, so the wizard count, the in-memory resolve, and the walker can
 * never disagree.
 *
 * The binding capacity pre-flight (`campaigns/capacityPreflight.ts`) calls
 * `countAudience` from `audienceCandidates.ts` directly, with its own ceiling
 * and document budget.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { audienceValidator, type StoredAudience } from './audience';
import { batchGet } from '../_utils/batchLoader';
import { logWarn } from '../lib/runtimeLog';
import { loadSuppressionSet } from '../lib/suppression';
import { preloadConditionsLookup, parseSegmentFilters, makeSegmentPredicate } from '../conditions';
import type { ParsedSegmentFilters } from '../conditions';
import {
	COUNT_CEILING,
	countAudience,
	selectRecipient,
	streamAudienceCandidates,
	type AudienceCount,
	type CampaignRecipient,
	type SegmentFilters,
} from './audienceCandidates';

/**
 * Page size for one Audience-resolution hop. Each page is one `.paginate()`
 * (topic: `contactTopics.by_topic`; segment: `contacts.by_deleted_at` pinned
 * to `deletedAt === undefined`) plus, for the topic branch, one batched
 * `ctx.db.get` fan-out over the page's `contactId`s — so a topic/segment of
 * any size resolves in bounded pages of reads rather than one `.collect()` +
 * N sequential point-reads, keeping any single query under the Convex
 * per-query document-read limit.
 */
const PAGE_SIZE = 500;

/** One resolved page: the eligible recipients, the next cursor, the raw
 *  candidate count examined on this page. `nextCursor === null` ⇒ exhausted. */
export interface ResolvedPage {
	recipients: CampaignRecipient[];
	nextCursor: string | null;
	pageCandidates: number;
}

/**
 * Resolve exactly ONE page of an Audience's candidates at `cursor`. The single
 * walk primitive shared by every entry below. `selectRecipient` (the
 * eligibility predicate) and the segment match are UNCHANGED from the
 * pre-checkpoint per-page loop — this just exposes one page instead of
 * draining them all inside one query.
 *
 * `cursor === ''` starts at the beginning. `nextCursor` is the opaque Convex
 * `continueCursor` when more pages remain, or `null` when the page was the
 * last. `pageCandidates` is the raw candidate count examined on this page
 * (topic memberships / segment matches), so summing it across pages preserves
 * the prior `total` semantics (`total - eligible` = honest excluded gap).
 */
async function resolveRecipientPageImpl(
	ctx: QueryCtx,
	args: { audience: StoredAudience; cursor: string; numItems: number }
): Promise<ResolvedPage> {
	const { audience, cursor, numItems } = args;

	// Suppression set — one bulk read of blockedEmails (intrinsically small
	// table) via the shared `loadSuppressionSet`, which owns the normalization
	// so its keys match `selectRecipient`'s `normalizeEmail(contact.email)`
	// membership test. Recomputed per page: a contact suppressed between two
	// hops is excluded on the later page (the "suppression mid-run" invariant).
	const blockedEmails = await loadSuppressionSet(ctx);

	if (audience.kind === 'topic') {
		const topic = await ctx.db.get(audience.topicId);
		const gate = { requiresDoi: topic?.requireDoubleOptIn === true, blockedEmails };

		const { page, isDone, continueCursor } = await ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', audience.topicId))
			.paginate({ cursor: cursor === '' ? null : cursor, numItems });

		const contacts = await batchGet<Doc<'contacts'>>(
			ctx,
			page.map((membership) => membership.contactId)
		);
		const recipients: CampaignRecipient[] = [];
		for (const membership of page) {
			const contact = contacts.get(String(membership.contactId));
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

	// segment — DOI never gates (named asymmetry).
	const gate = { requiresDoi: false, blockedEmails };

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

	const lookup = await preloadConditionsLookup(ctx, parsedFilters.conditions);
	const matches = makeSegmentPredicate(parsedFilters, lookup);

	// Stream the live Contacts over the `by_deleted_at` index pinned to
	// `deletedAt === undefined`: soft-deleted rows never enter the page (the
	// index range is exactly the live population — closes the soft-delete leak
	// without a post-filter), and no single page collects the whole Contacts
	// table.
	const { page, isDone, continueCursor } = await ctx.db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.eq('deletedAt', undefined))
		.paginate({ cursor: cursor === '' ? null : cursor, numItems });

	const recipients: CampaignRecipient[] = [];
	let pageCandidates = 0;
	for (const contact of page) {
		if (!matches(contact)) continue;
		pageCandidates++; // raw segment-match count (live contacts; empty conditions match all)
		const recipient = selectRecipient(contact, gate);
		if (recipient) recipients.push(recipient);
	}

	return {
		recipients,
		nextCursor: isDone ? null : continueCursor,
		pageCandidates,
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
			numItems: args.numItems ?? PAGE_SIZE,
		});
	},
});

// ── Entry 1: materialize rows in ONE bounded page. Used only by tests/asserts
// (`countRecipients(a).eligible === resolveRecipients(a).length`) — no production
// path calls this; the send paths stream via the checkpointed walker
// (`resolveRecipientPage`, one page per scheduled hop). Convex allows a single
// `.paginate()` per function execution, so this cannot loop pages; it resolves a
// single page bounded by COUNT_CEILING, which is more than any test seeds. ──
export const resolveRecipients = internalQuery({
	args: { audience: audienceValidator },
	handler: async (ctx, { audience }): Promise<CampaignRecipient[]> => {
		const recipients: CampaignRecipient[] = [];
		let candidates = 0;
		for await (const { recipient } of streamAudienceCandidates(ctx, audience)) {
			candidates += 1;
			if (recipient) recipients.push(recipient);
			if (candidates >= COUNT_CEILING) break;
		}
		return recipients;
	},
});

// ── Entry 2: accumulate integers. The wizard's audience-size readout. Runs
// the IDENTICAL predicate (via the same candidate stream) as resolveRecipients,
// so `eligible` equals the delivered count; `total - eligible` is the honest
// excluded gap. Capped at COUNT_CEILING — past the cap it stops streaming and
// reports `completeness: 'candidate_capped'` so the wizard renders `25,000+`. ──
export const countRecipients = authedQuery({
	args: { audience: v.optional(audienceValidator) },
	handler: async (ctx, { audience }): Promise<AudienceCount> => {
		if (!audience) return { total: 0, eligible: 0, completeness: 'exact' };
		return await countAudience(ctx, audience);
	},
});
