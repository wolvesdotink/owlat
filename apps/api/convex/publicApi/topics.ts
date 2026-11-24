/**
 * What `GET /api/v1/topics` answers (`topics/apiHttp.ts`): one page of the
 * topic list every member picks audiences from, through the same listing the
 * web app reads, in the public contract's shape.
 */

import { v } from 'convex/values';
import type { PaginatedResponse, Topic } from '@owlat/public-contract';
import { internalQuery } from '../_generated/server';
import { countFacet, listResources } from '../lib/listing';
import { topicListing } from '../topics/listing';

export const listForApi = internalQuery({
	args: { limit: v.number(), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args): Promise<PaginatedResponse<Topic>> => {
		const [page, total] = await Promise.all([
			// The descriptor's `contactCount` enrichment is not part of the
			// response, and for a topic without a cached count it scans the
			// memberships, so it is turned off here.
			listResources(
				ctx.db,
				{ ...topicListing, enrich: undefined },
				{
					paginationOpts: { numItems: args.limit, cursor: args.cursor },
					clientCursor: true,
				}
			),
			countFacet(ctx.db, topicListing, 'total'),
		]);
		return {
			data: page.page.map((topic) => ({
				id: topic._id,
				name: topic.name,
				description: topic.description ?? null,
				requiresDoubleOptIn: topic.requireDoubleOptIn === true,
				createdAt: new Date(topic.createdAt).toISOString(),
			})),
			pagination: {
				limit: args.limit,
				totalItems: total as number,
				cursor: page.isDone ? null : page.continueCursor,
				isDone: page.isDone,
			},
		};
	},
});
