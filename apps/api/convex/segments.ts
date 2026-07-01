import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { internalMutation, internalQuery } from './_generated/server';
import { authedQuery, authedMutation, authedAction } from './lib/authedFunctions';
import { internal } from './_generated/api';
import { requireOrgPermission } from './lib/sessionOrganization';
import { throwNotFound } from './_utils/errors';
import {
	evaluateSegmentCount,
	countLiveMatchesForSegments,
	countMatchingContactsPage as countMatchingContactsPageImpl,
	listMatchingContactsPage as listMatchingContactsPageImpl,
	type SegmentCountPage,
	type SegmentMemberPage,
} from './conditions';
import type { Doc } from './_generated/dataModel';
import { validateStringLength, STRING_LIMITS } from './lib/inputGuards';
import { segmentFiltersValidator } from './lib/convexValidators';
import { listResources } from './lib/listing';
import { segmentListing } from './segments/listing';
import { toPaginationCursor } from './lib/paginationCursor';
import { recordAuditLog } from './lib/auditLog';

// Types for segment filter configuration — re-exported from the canonical
// `Condition` union owned by `apps/api/convex/conditions/`.
export type FilterLogic = 'AND' | 'OR';
export type { Condition as FilterCondition, ConditionKind as FilterConditionKind } from './conditions/types';

export type { SegmentFilters } from './conditions';

// Get a single segment by ID
export const get = authedQuery({
	args: { id: v.id('segments') },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.id);
	},
});

/**
 * Number of live contacts a single member page scans before filtering. A
 * segment's membership is computed (a predicate over the live-Contact
 * population), not materialized in a junction table, so each page paginates the
 * `contacts` table by this many rows and returns just the subset that matches —
 * a page can therefore hold fewer than this many members. The segment-detail
 * view drives `listMembers` page-by-page through `usePaginatedQuery`; this
 * bounds the per-transaction read set the same way the count walk does.
 */
const MEMBER_PAGE_SCAN = 200;

/**
 * List the contacts that currently match a saved segment, page by page. The
 * membership view of a segment (the segment-detail page) — the counterpart to
 * `topics.getContacts`, except segment membership is computed at read time
 * rather than stored in a junction table. Returns the `{ page, isDone,
 * continueCursor }` pagination contract so the web client can stream members
 * with the shared `usePaginatedQuery` composable. Each page resolves its
 * filters against just the scanned slice (per-contact point reads), so no
 * single transaction collects the whole Contacts table.
 */
// all-members: read-only membership view of a saved segment, available to every member (mirrors topics.getContacts).
export const listMembers = authedQuery({
	args: {
		id: v.id('segments'),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const segment = await ctx.db.get(args.id);
		if (!segment) return { page: [], isDone: true, continueCursor: '' };

		const result = await listMatchingContactsPageImpl(
			ctx,
			segment.filters,
			args.paginationOpts.cursor,
			args.paginationOpts.numItems > 0 ? args.paginationOpts.numItems : MEMBER_PAGE_SCAN,
		);

		return {
			page: result.members,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

/**
 * Live contacts scanned per member-export page, and the safety bound on the
 * total scan. The CSV export walks the whole live-Contact population once and
 * keeps the matched Docs; this caps the per-page read set (one bounded
 * transaction) and the total walk respectively. Mirrors `COUNT_PAGE_SIZE` /
 * `COUNT_MAX_SCAN`, plus a hard cap on the materialized member array so the
 * action's return payload stays within the Convex output-size budget (the same
 * 10k ceiling the contacts export rides — see `listForExportByOrganization`).
 */
const EXPORT_PAGE_SCAN = 500;
const EXPORT_MAX_SCAN = 100_000;
const EXPORT_MAX_MEMBERS = 10_000;

/**
 * One bounded page of the segment-member export. Internal query driven by the
 * `listMembersForExport` action — each call scans a single page of live
 * contacts and resolves the segment predicate for just that page (per-contact
 * point reads, never a whole-column collect), so the per-transaction read set
 * stays bounded. The membership counterpart to `countMatchingContactsPage`.
 */
export const listMembersPage = internalQuery({
	args: {
		filters: segmentFiltersValidator,
		cursor: v.union(v.string(), v.null()),
		numItems: v.number(),
	},
	handler: async (ctx, args): Promise<SegmentMemberPage> =>
		listMatchingContactsPageImpl(ctx, args.filters, args.cursor, args.numItems),
});

/**
 * Return EVERY contact that currently matches a saved segment, for CSV export.
 *
 * An ACTION, not a reactive query, and the export's single source of truth: it
 * walks all member pages server-side (checkpointing a cursor across bounded
 * internal page queries, exactly like `countMatchingContacts`) and returns the
 * complete matched set in one call. The web client therefore exports the whole
 * segment from one await instead of racing a reactive `usePaginatedQuery`
 * subscription to drain itself client-side — a loop that could exit on a
 * transient `LoadingMore` status and silently export a truncated window.
 *
 * `truncated` is true when the walk hit either the member cap or the scan cap,
 * so the caller can warn the user rather than present an incomplete CSV as
 * complete.
 */
// all-members: read-only membership export of a saved segment, available to every member (mirrors listForExportByOrganization).
export const listMembersForExport = authedAction({
	args: {
		id: v.id('segments'),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ members: Doc<'contacts'>[]; truncated: boolean }> => {
		const segment = await ctx.runQuery(internal.segments.getInternal, { id: args.id });
		if (!segment) return { members: [], truncated: false };

		const members: Doc<'contacts'>[] = [];
		let cursor: string | null = null;
		let scanned = 0;
		let truncated = false;

		for (;;) {
			const page: SegmentMemberPage = await ctx.runQuery(internal.segments.listMembersPage, {
				filters: segment.filters,
				cursor,
				numItems: EXPORT_PAGE_SCAN,
			});
			scanned += EXPORT_PAGE_SCAN;
			for (const member of page.members) {
				if (members.length >= EXPORT_MAX_MEMBERS) {
					truncated = true;
					break;
				}
				members.push(member);
			}
			if (truncated || page.isDone) break;
			if (scanned >= EXPORT_MAX_SCAN) {
				truncated = true;
				break;
			}
			cursor = page.continueCursor;
		}

		return { members, truncated };
	},
});

/**
 * Internal fetch of a segment's stored filters for the export action (an action
 * has no `ctx.db`). Org-scoped reads are still enforced at the `listMembersPage`
 * boundary; this only reads the segment's own row.
 */
export const getInternal = internalQuery({
	args: { id: v.id('segments') },
	handler: async (ctx, args) => ctx.db.get(args.id),
});

// Update a segment
export const update = authedMutation({
	args: {
		id: v.id('segments'),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		filters: v.optional(segmentFiltersValidator),
	},
	handler: async (ctx, args) => {
		// Validate input lengths
		if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.description) validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

		const session = await requireOrgPermission(ctx, 'segments:manage', 'Only owners and admins can update segments');

		const existing = await ctx.db.get(args.id);
		if (!existing) { throwNotFound('Segment'); }

		await ctx.db.patch(args.id, {
			...(args.name !== undefined && { name: args.name }),
			...(args.description !== undefined && { description: args.description }),
			...(args.filters !== undefined && { filters: args.filters }),
			updatedAt: Date.now(),
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'segment.updated',
			resource: 'segment',
			resourceId: args.id,
			details: { name: args.name ?? existing.name },
		});

		// Async count update when filters change (fire-and-forget)
		if (args.filters !== undefined) {
			await ctx.scheduler.runAfter(0, internal.segments.refreshSingleSegmentCount, {
				segmentId: args.id,
			});
		}
	},
});

// Delete a segment
export const remove = authedMutation({
	args: { id: v.id('segments') },
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'segments:manage', 'Only owners and admins can delete segments');

		const existing = await ctx.db.get(args.id);
		if (!existing) { throwNotFound('Segment'); }

		await ctx.db.delete(args.id);

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'segment.deleted',
			resource: 'segment',
			resourceId: args.id,
			details: { name: existing.name },
		});
	},
});

// ==========================================
// SESSION-BASED QUERIES AND MUTATIONS (US-405)
// These use BetterAuth session for authentication
// instead of requiring it as a parameter.
// ==========================================

/**
 * List segments (session-auth shell). Paginated { page, … } contract via the
 * Listing engine (ADR-0037).
 */
export const list = authedQuery({
	args: {
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) =>
		listResources(ctx.db, segmentListing, { paginationOpts: args.paginationOpts }),
});

/**
 * Create a new segment using session-based organization context.
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		description: v.optional(v.string()),
		filters: segmentFiltersValidator,
	},
	handler: async (ctx, args) => {
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
		if (args.description) validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

		const session = await requireOrgPermission(ctx, 'segments:manage', 'Only owners and admins can create segments');

		const now = Date.now();

		const segmentId = await ctx.db.insert('segments', {
			name: args.name,
			description: args.description,
			filters: args.filters,
			createdAt: now,
			updatedAt: now,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'segment.created',
			resource: 'segment',
			resourceId: segmentId,
			details: { name: args.name },
		});

		// Async count update (fire-and-forget)
		await ctx.scheduler.runAfter(0, internal.segments.refreshSingleSegmentCount, {
			segmentId,
		});

		return segmentId;
	},
});

/**
 * Page size for the segment-builder audience-count walk. Each page is one
 * bounded internal-query transaction; the action loops until done or the safety
 * cap is hit.
 */
const COUNT_PAGE_SIZE = 500;

/**
 * Safety bound on the live audience-size estimate the builder shows. A walk that
 * scans this many live contacts without finishing returns the partial count
 * (the UI renders it as an approximate "N+"). Saved segments still get an exact
 * `cachedCount` from the cron / on-write refresh; this only caps the unsaved
 * builder preview.
 */
const COUNT_MAX_SCAN = 100_000;

/**
 * One bounded page of the segment-builder audience count. Internal query driven
 * by the `countMatchingContacts` action — each call reads a single page of live
 * contacts and resolves conditions for just that page (per-contact point reads,
 * never a whole-column collect), so the per-transaction read set stays bounded.
 */
export const countMatchingContactsPage = internalQuery({
	args: {
		filters: segmentFiltersValidator,
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args): Promise<SegmentCountPage> =>
		countMatchingContactsPageImpl(ctx, args.filters, args.cursor, COUNT_PAGE_SIZE),
});

/**
 * Estimate how many contacts match a (usually unsaved) segment filter set, for
 * the segment-builder preview. An ACTION, not a reactive query: it does not
 * subscribe to the unbounded `contacts` table, so it neither re-runs on every
 * keystroke (the web caller debounces) nor re-executes on every Contacts write
 * (invalidation amplification). It checkpoints a cursor across bounded internal
 * page queries so no single transaction scans the whole table.
 */
// all-members: read-only audience-size estimate for the segment builder, available to every member.
export const countMatchingContacts = authedAction({
	args: {
		filters: segmentFiltersValidator,
	},
	handler: async (ctx, args): Promise<number> => {
		let cursor: string | null = null;
		let total = 0;
		let scanned = 0;
		for (;;) {
			const page: SegmentCountPage = await ctx.runQuery(
				internal.segments.countMatchingContactsPage,
				{ filters: args.filters, cursor },
			);
			total += page.matched;
			scanned += page.scanned;
			if (page.isDone || page.continueCursor === null || scanned >= COUNT_MAX_SCAN) break;
			cursor = page.continueCursor;
		}
		return total;
	},
});

// ==========================================
// INTERNAL MUTATIONS FOR CRON-BASED REFRESH
// ==========================================

const BATCH_SIZE = 10;

/**
 * Refresh cached counts for a batch of segments.
 * Called by cron every 30 minutes. Processes segments in batches
 * using Convex .paginate() to avoid full table scans.
 * Groups segments by org to share contact data across evaluations.
 */
export const refreshAllSegmentCounts = internalMutation({
	args: {
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Use Convex pagination — each batch only reads its own page
		const paginationResult = await ctx.db
			.query('segments')
			.paginate({
				cursor: toPaginationCursor(args.cursor),
				numItems: BATCH_SIZE,
			});

		const batch = paginationResult.page;

		if (batch.length > 0) {
			// Use batch evaluation — groups by org, shares contact data
			const counts = await countLiveMatchesForSegments(
				ctx,
				batch.map((s) => ({
					segmentId: s._id as string,
					filters: s.filters,
				}))
			);

			for (const segment of batch) {
				const count = counts.get(segment._id as string) ?? 0;
				await ctx.db.patch(segment._id, {
					cachedCount: count,
					cachedCountUpdatedAt: Date.now(),
				});
			}
		}

		// If there are more segments, schedule the next batch
		if (!paginationResult.isDone) {
			await ctx.scheduler.runAfter(0, internal.segments.refreshAllSegmentCounts, {
				cursor: paginationResult.continueCursor as string,
			});
		}
	},
});

/**
 * Refresh the cached count for a single segment.
 * Used as a fire-and-forget task after create/update mutations.
 */
export const refreshSingleSegmentCount = internalMutation({
	args: {
		segmentId: v.id('segments'),
	},
	handler: async (ctx, args) => {
		const segment = await ctx.db.get(args.segmentId);
		if (!segment) return;

		const result = await evaluateSegmentCount(ctx, segment.filters);
		await ctx.db.patch(args.segmentId, {
			cachedCount: result.total,
			cachedCountUpdatedAt: Date.now(),
		});
	},
});
