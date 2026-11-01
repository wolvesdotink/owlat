/**
 * Previous-release paths of `segments/segments.ts`. The segment pages, the
 * segment builder and the campaign audience picker in a tab opened before the
 * deploy call `segments:*` by path, and a member export or audience estimate
 * the previous release started mid-run calls the internal page queries by
 * path. Each keeps its old path, builder, auth floor, arguments and result
 * shape, and runs the same body as its replacement. Remove after release 0.6.17.
 */
import { internalQuery } from './_generated/server';
import { authedAction, authedMutation, authedQuery } from './lib/authedFunctions';
import type { SegmentCountPage, SegmentMemberPage } from './conditions';
import type { PublicContact } from './contacts/listing';
import {
	countMatchingContactsArgs,
	countMatchingContactsPageArgs,
	countSegmentMatches,
	createSegment,
	createSegmentArgs,
	exportSegmentMembers,
	listMembersArgs,
	listMembersPageArgs,
	listSegmentMembers,
	listSegments,
	listSegmentsArgs,
	readCountPage,
	readMembersPage,
	readSegment,
	removeSegment,
	segmentIdArgs,
	updateSegment,
	updateSegmentArgs,
} from './segments/segments';

/** Remove after release 0.6.17; this release calls `segments/segments:get`. */
// all-members: segments are campaign audiences, which every role picks when
// it builds a campaign; writing them needs segments:manage.
export const get = authedQuery({
	args: segmentIdArgs,
	handler: async (ctx, args) => await readSegment(ctx, args.id),
});

/** Remove after release 0.6.17; this release calls `segments/segments:listMembers`. */
// all-members: read-only membership view of a saved segment, available to every member (mirrors topics.getContacts).
export const listMembers = authedQuery({
	args: listMembersArgs,
	handler: async (ctx, args) => await listSegmentMembers(ctx, args),
});

/** Remove after release 0.6.17; this release calls `segments/segments:listMembersPage`. */
export const listMembersPage = internalQuery({
	args: listMembersPageArgs,
	handler: async (ctx, args): Promise<SegmentMemberPage> => await readMembersPage(ctx, args),
});

/** Remove after release 0.6.17; this release calls `segments/segments:listMembersForExport`. */
// all-members: read-only membership export of a saved segment, available to every
// member. exportSegmentMembers excludes soft-deleted rows and redacts the DOI
// capability fields, so the export never carries the /confirm/doi bearer token.
export const listMembersForExport = authedAction({
	args: segmentIdArgs,
	handler: async (ctx, args): Promise<{ members: PublicContact[]; truncated: boolean }> =>
		await exportSegmentMembers(ctx, args.id),
});

/** Remove after release 0.6.17; this release calls `segments/segments:getInternal`. */
export const getInternal = internalQuery({
	args: segmentIdArgs,
	handler: async (ctx, args) => await readSegment(ctx, args.id),
});

/** Remove after release 0.6.17; this release calls `segments/segments:update`. */
// authz: updateSegment requires segments:manage before it reads or writes.
export const update = authedMutation({
	args: updateSegmentArgs,
	handler: async (ctx, args, session) => await updateSegment(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `segments/segments:remove`. */
// authz: removeSegment requires segments:manage before it reads or writes.
export const remove = authedMutation({
	args: segmentIdArgs,
	handler: async (ctx, args, session) => await removeSegment(ctx, args.id, session),
});

/** Remove after release 0.6.17; this release calls `segments/segments:list`. */
// all-members: the campaign audience picker every role uses.
export const list = authedQuery({
	args: listSegmentsArgs,
	handler: async (ctx, args) => await listSegments(ctx, args),
});

/** Remove after release 0.6.17; this release calls `segments/segments:create`. */
// authz: createSegment requires segments:manage before it writes.
export const create = authedMutation({
	args: createSegmentArgs,
	handler: async (ctx, args, session) => await createSegment(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `segments/segments:countMatchingContactsPage`. */
export const countMatchingContactsPage = internalQuery({
	args: countMatchingContactsPageArgs,
	handler: async (ctx, args): Promise<SegmentCountPage> => await readCountPage(ctx, args),
});

/** Remove after release 0.6.17; this release calls `segments/segments:countMatchingContacts`. */
// all-members: read-only audience-size estimate for the segment builder, available to every member.
export const countMatchingContacts = authedAction({
	args: countMatchingContactsArgs,
	handler: async (ctx, args): Promise<number> => await countSegmentMatches(ctx, args.filters),
});
