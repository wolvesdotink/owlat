/**
 * Saved segments: the CRUD the segment pages use, the computed membership view
 * and its CSV export, and the segment-builder audience estimate.
 */
import { v, type Infer, type ObjectType } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import {
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedQuery, authedMutation, authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import {
	hasPermission,
	requirePermission,
	type MutationSessionContext,
} from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import {
	countMatchingContactsPage as countMatchingContactsPageImpl,
	listMatchingContactsPage as listMatchingContactsPageImpl,
	type SegmentCountPage,
	type SegmentMemberPage,
} from '../conditions';
import { redactContactCapabilityFields, type PublicContact } from '../contacts/listing';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { segmentFiltersValidator } from '../lib/convexValidators';
import { listResources } from '../lib/listing';
import { segmentListing } from './listing';
import { recordAuditLog } from '../lib/auditLog';

// Types for segment filter configuration — re-exported from the canonical
// `Condition` union owned by `apps/api/convex/conditions/`.
export type FilterLogic = 'AND' | 'OR';
export type { Condition as FilterCondition } from '../conditions/types';

export type { SegmentFilters } from '../conditions';

/** The arguments of `get` and `getInternal`. */
export const segmentIdArgs = { id: v.id('segments') };

// Get a single segment by ID
// all-members: segments are campaign audiences, which every role picks when
// it builds a campaign; writing them needs segments:manage.
export const get = authedQuery({
	args: segmentIdArgs,
	handler: async (ctx, args) => await readSegment(ctx, args.id),
});

/** The body of `get` and `getInternal`. */
export async function readSegment(ctx: QueryCtx, id: Id<'segments'>) {
	return await ctx.db.get(id);
}

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

/** `listMembers`' arguments. */
export const listMembersArgs = {
	id: v.id('segments'),
	paginationOpts: paginationOptsValidator,
};

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
	args: listMembersArgs,
	handler: async (ctx, args) => await listSegmentMembers(ctx, args),
});

/** The body of `listMembers`. */
export async function listSegmentMembers(ctx: QueryCtx, args: ObjectType<typeof listMembersArgs>) {
	const segment = await ctx.db.get(args.id);
	if (!segment) return { page: [], isDone: true, continueCursor: '' };

	const result = await listMatchingContactsPageImpl(
		ctx,
		segment.filters,
		args.paginationOpts.cursor,
		args.paginationOpts.numItems > 0 ? args.paginationOpts.numItems : MEMBER_PAGE_SCAN
	);

	// The page scan already excludes soft-deleted (GDPR-erased) rows via the
	// `by_deleted_at` index. Redact the DOI capability fields
	// (doiConfirmationToken / doiTokenExpiresAt) so this member-readable
	// membership view never leaks the /confirm/doi bearer token — the same
	// contract topics.getContacts applies.
	return {
		page: result.members.map(redactContactCapabilityFields),
		isDone: result.isDone,
		continueCursor: result.continueCursor,
	};
}

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

/** `listMembersPage`'s arguments. */
export const listMembersPageArgs = {
	filters: segmentFiltersValidator,
	cursor: v.union(v.string(), v.null()),
	numItems: v.number(),
};

/**
 * One bounded page of the segment-member export. Internal query driven by the
 * `listMembersForExport` action — each call scans a single page of live
 * contacts and resolves the segment predicate for just that page (per-contact
 * point reads, never a whole-column collect), so the per-transaction read set
 * stays bounded. The membership counterpart to `countMatchingContactsPage`.
 */
export const listMembersPage = internalQuery({
	args: listMembersPageArgs,
	handler: async (ctx, args): Promise<SegmentMemberPage> => await readMembersPage(ctx, args),
});

/** The body of `listMembersPage`. */
export async function readMembersPage(
	ctx: QueryCtx,
	args: ObjectType<typeof listMembersPageArgs>
): Promise<SegmentMemberPage> {
	return await listMatchingContactsPageImpl(ctx, args.filters, args.cursor, args.numItems);
}

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
// all-members: read-only membership export of a saved segment, available to every
// member. Like `listForExportByOrganization`, it excludes soft-deleted rows (the
// `listMembersPage` scan rides the `by_deleted_at` index) and redacts the DOI
// capability fields (doiConfirmationToken / doiTokenExpiresAt) below, so the
// export never carries the /confirm/doi bearer token.
export const listMembersForExport = authedAction({
	args: segmentIdArgs,
	handler: async (ctx, args): Promise<{ members: PublicContact[]; truncated: boolean }> =>
		await exportSegmentMembers(ctx, args.id),
});

/** The body of `listMembersForExport`. */
export async function exportSegmentMembers(
	ctx: ActionCtx,
	id: Id<'segments'>
): Promise<{ members: PublicContact[]; truncated: boolean }> {
	const segment = await ctx.runQuery(internal.segments.segments.getInternal, { id });
	if (!segment) return { members: [], truncated: false };

	const members: PublicContact[] = [];
	let cursor: string | null = null;
	let scanned = 0;
	let truncated = false;

	for (;;) {
		const page: SegmentMemberPage = await ctx.runQuery(internal.segments.segments.listMembersPage, {
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
			members.push(redactContactCapabilityFields(member));
		}
		if (truncated || page.isDone) break;
		if (scanned >= EXPORT_MAX_SCAN) {
			truncated = true;
			break;
		}
		cursor = page.continueCursor;
	}

	return { members, truncated };
}

/**
 * Internal fetch of a segment's stored filters for the export action (an action
 * has no `ctx.db`). Org-scoped reads are still enforced at the `listMembersPage`
 * boundary; this only reads the segment's own row.
 */
export const getInternal = internalQuery({
	args: segmentIdArgs,
	handler: async (ctx, args) => await readSegment(ctx, args.id),
});

/** `update`'s arguments. */
export const updateSegmentArgs = {
	id: v.id('segments'),
	name: v.optional(v.string()),
	description: v.optional(v.string()),
	filters: v.optional(segmentFiltersValidator),
};

// Update a segment
// authz: updateSegment requires segments:manage before it reads or writes.
export const update = authedMutation({
	args: updateSegmentArgs,
	handler: async (ctx, args, session) => await updateSegment(ctx, args, session),
});

/** The body of `update`. */
export async function updateSegment(
	ctx: MutationCtx,
	args: ObjectType<typeof updateSegmentArgs>,
	session: MutationSessionContext
): Promise<void> {
	// Validate input lengths
	if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
	if (args.description)
		validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

	requirePermission(
		hasPermission(session.role, 'segments:manage'),
		'Only owners and admins can update segments'
	);

	const existing = await getOrThrow(ctx, args.id, 'Segment');

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
		await ctx.scheduler.runAfter(0, internal.segments.countRefresh.refreshSingleSegmentCount, {
			segmentId: args.id,
		});
	}
}

// Delete a segment
// authz: removeSegment requires segments:manage before it reads or writes.
export const remove = authedMutation({
	args: segmentIdArgs,
	handler: async (ctx, args, session) => await removeSegment(ctx, args.id, session),
});

/** The body of `remove`. */
export async function removeSegment(
	ctx: MutationCtx,
	id: Id<'segments'>,
	session: MutationSessionContext
): Promise<void> {
	requirePermission(
		hasPermission(session.role, 'segments:manage'),
		'Only owners and admins can delete segments'
	);

	const existing = await getOrThrow(ctx, id, 'Segment');

	await ctx.db.delete(id);

	await recordAuditLog(ctx, {
		userId: session.userId,
		action: 'segment.deleted',
		resource: 'segment',
		resourceId: id,
		details: { name: existing.name },
	});
}

/** `list`'s arguments. */
export const listSegmentsArgs = { paginationOpts: paginationOptsValidator };

/**
 * List segments (session-auth shell). Paginated { page, … } contract via the
 * Listing engine.
 */
// all-members: the campaign audience picker every role uses.
export const list = authedQuery({
	args: listSegmentsArgs,
	handler: async (ctx, args) => await listSegments(ctx, args),
});

/** The body of `list`. */
export async function listSegments(ctx: QueryCtx, args: ObjectType<typeof listSegmentsArgs>) {
	return await listResources(ctx.db, segmentListing, { paginationOpts: args.paginationOpts });
}

/** `create`'s arguments. */
export const createSegmentArgs = {
	name: v.string(),
	description: v.optional(v.string()),
	filters: segmentFiltersValidator,
};

/**
 * Create a new segment using session-based organization context.
 */
// authz: createSegment requires segments:manage before it writes.
export const create = authedMutation({
	args: createSegmentArgs,
	handler: async (ctx, args, session) => await createSegment(ctx, args, session),
});

/** The body of `create`. */
export async function createSegment(
	ctx: MutationCtx,
	args: ObjectType<typeof createSegmentArgs>,
	session: MutationSessionContext
): Promise<Id<'segments'>> {
	// Validate input lengths
	validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
	if (args.description)
		validateStringLength(args.description, STRING_LIMITS.DESCRIPTION, 'Description');

	requirePermission(
		hasPermission(session.role, 'segments:manage'),
		'Only owners and admins can create segments'
	);

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
	await ctx.scheduler.runAfter(0, internal.segments.countRefresh.refreshSingleSegmentCount, {
		segmentId,
	});

	return segmentId;
}

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

/** `countMatchingContactsPage`'s arguments. */
export const countMatchingContactsPageArgs = {
	filters: segmentFiltersValidator,
	cursor: v.union(v.string(), v.null()),
};

/**
 * One bounded page of the segment-builder audience count. Internal query driven
 * by the `countMatchingContacts` action — each call reads a single page of live
 * contacts and resolves conditions for just that page (per-contact point reads,
 * never a whole-column collect), so the per-transaction read set stays bounded.
 */
export const countMatchingContactsPage = internalQuery({
	args: countMatchingContactsPageArgs,
	handler: async (ctx, args): Promise<SegmentCountPage> => await readCountPage(ctx, args),
});

/** The body of `countMatchingContactsPage`. */
export async function readCountPage(
	ctx: QueryCtx,
	args: ObjectType<typeof countMatchingContactsPageArgs>
): Promise<SegmentCountPage> {
	return await countMatchingContactsPageImpl(ctx, args.filters, args.cursor, COUNT_PAGE_SIZE);
}

/** `countMatchingContacts`' arguments. */
export const countMatchingContactsArgs = { filters: segmentFiltersValidator };

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
	args: countMatchingContactsArgs,
	handler: async (ctx, args): Promise<number> => await countSegmentMatches(ctx, args.filters),
});

/** The body of `countMatchingContacts`. */
export async function countSegmentMatches(
	ctx: ActionCtx,
	filters: Infer<typeof segmentFiltersValidator>
): Promise<number> {
	let cursor: string | null = null;
	let total = 0;
	let scanned = 0;
	for (;;) {
		const page: SegmentCountPage = await ctx.runQuery(
			internal.segments.segments.countMatchingContactsPage,
			{ filters, cursor }
		);
		total += page.matched;
		scanned += page.scanned;
		if (page.isDone || page.continueCursor === null || scanned >= COUNT_MAX_SCAN) break;
		cursor = page.continueCursor;
	}
	return total;
}
