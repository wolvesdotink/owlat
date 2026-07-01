/**
 * Audience resolution (module) — the single mapping from an Audience to its
 * eligible recipients. See CONTEXT.md "Audience resolution (module)" and
 * docs/adr/0033-audience-resolution-module.md.
 *
 * One pure per-Contact eligibility predicate (`selectRecipient`) is the shared
 * core. The checkpointed send walker takes ONE page per scheduled hop via
 * `resolveRecipientPageImpl` (one `.paginate()` per execution); the count and
 * materialize entries instead STREAM candidates via `streamAudienceCandidates`
 * (async iteration, no `.paginate()`) because Convex allows a single `.paginate()`
 * per function execution. All three apply the identical eligibility, so the wizard
 * count, the in-memory resolve, and the walker can never disagree:
 *   - `resolveRecipientPage` — internalQuery, ONE page (the walker's hop).
 *   - `resolveRecipients`    — internalQuery, materializes candidates by streaming
 *                              (test/asserts only), bounded by COUNT_CEILING.
 *   - `countRecipients`      — public query, accumulates integers by streaming,
 *                              capped at COUNT_CEILING.
 */

import { v } from 'convex/values';
import type { Infer } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { audienceValidator, type StoredAudience } from './audience';
import { segmentFiltersValidator } from '../lib/convexValidators';
import { batchGet } from '../_utils/batchLoader';
import { logWarn } from '../lib/runtimeLog';
import { normalizeEmail } from '../lib/inputGuards';
import { loadSuppressionSet } from '../lib/suppression';
import {
	preloadConditionsLookup,
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
}

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
	};
}

/**
 * The eligibility decision for one loaded Contact — the ONLY definition of
 * "eligible recipient". `null` = excluded. Ordered predicate:
 * live-contact → email-present → not-suppressed → not-globally-unsubscribed →
 * DOI (topic only).
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
 */
export function selectRecipient(
	contact: Doc<'contacts'>,
	gate: { requiresDoi: boolean; blockedEmails: ReadonlySet<string> },
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
	return projectRecipient(contact);
}

/** Segment-filter shape — `frozenFilters` or the live Segment's `filters`. */
type SegmentFilters = Infer<typeof segmentFiltersValidator>;

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

/**
 * Ceiling for `countRecipients`. The wizard readout streams until it has either
 * exhausted the audience or accumulated this many CANDIDATES (topic memberships,
 * or segment MATCHES), then stops and returns `capped: true` (the UI renders
 * `25,000+`).
 *
 * NOTE — this caps candidates, NOT rows examined. For a topic it also bounds the
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
	args: { audience: StoredAudience; cursor: string; numItems: number },
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
			page.map((membership) => membership.contactId),
		);
		const recipients: CampaignRecipient[] = [];
		for (const membership of page) {
			const contact = contacts.get(String(membership.contactId));
			if (!contact) continue; // orphan membership (contact hard-deleted)
			const recipient = selectRecipient(contact, gate);
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
		logWarn(
			'audienceResolution: segment filters failed to parse; resolving zero recipients',
			err,
		);
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

/**
 * Async-stream every CANDIDATE of an Audience — one yield per raw candidate the
 * page walk would examine (the `pageCandidates` unit), carrying the eligible
 * `recipient` or `null` — WITHOUT `.paginate()`. Convex permits a single
 * `.paginate()` per function execution, so the count/materialize entries below
 * cannot loop pages; they iterate this stream and stop at COUNT_CEILING. The
 * per-row eligibility (suppression, DOI gate, segment predicate) is IDENTICAL to
 * `resolveRecipientPageImpl` — only the fetch strategy differs (row stream vs one
 * paginated page per scheduled hop).
 */
async function* streamAudienceCandidates(
	ctx: QueryCtx,
	audience: StoredAudience,
): AsyncGenerator<{ recipient: CampaignRecipient | null }> {
	const blockedEmails = await loadSuppressionSet(ctx);

	if (audience.kind === 'topic') {
		const topic = await ctx.db.get(audience.topicId);
		const gate = { requiresDoi: topic?.requireDoubleOptIn === true, blockedEmails };
		for await (const membership of ctx.db
			.query('contactTopics')
			.withIndex('by_topic', (q) => q.eq('topicId', audience.topicId))) {
			const contact = await ctx.db.get(membership.contactId);
			// Every membership is a candidate (mirrors `pageCandidates: page.length`);
			// an orphan membership (contact hard-deleted) is still a candidate but
			// yields no recipient.
			yield { recipient: contact ? selectRecipient(contact, gate) : null };
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
		logWarn('audienceResolution: segment filters failed to parse; resolving zero recipients', err);
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
// the IDENTICAL predicate (via the same page resolver) as resolveRecipients,
// so `eligible` equals the delivered count; `total - eligible` is the honest
// excluded gap. Capped at COUNT_CEILING — past the cap it stops streaming and
// returns `capped: true` so the wizard renders e.g. `25,000+`. ──
export const countRecipients = authedQuery({
	args: { audience: v.optional(audienceValidator) },
	handler: async (
		ctx,
		{ audience },
	): Promise<{ total: number; eligible: number; capped: boolean }> => {
		if (!audience) return { total: 0, eligible: 0, capped: false };
		let total = 0;
		let eligible = 0;
		for await (const { recipient } of streamAudienceCandidates(ctx, audience)) {
			total += 1;
			if (recipient) eligible += 1;
			if (total >= COUNT_CEILING) {
				// Cap reached — clamp to the ceiling and stop streaming. There may be
				// more candidates, so the readout is "at least CEILING".
				return { total: COUNT_CEILING, eligible: Math.min(eligible, COUNT_CEILING), capped: true };
			}
		}
		return { total, eligible, capped: false };
	},
});
