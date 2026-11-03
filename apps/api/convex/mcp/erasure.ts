/**
 * A member's MCP clients and their activity log, as ranges the member-erasure
 * phase (`auth/erasure/memberPhases.ts`) drains. Each range is emptied by the
 * deletes the phase makes, so reading it again resumes.
 *
 * Not a Convex function; kept here so the erasure phase names one helper.
 */

import type { MutationCtx } from '../_generated/server';

export function memberMcpClientRanges(ctx: MutationCtx, userId: string) {
	return [
		(n: number) =>
			ctx.db
				.query('mcpClientActivity')
				.withIndex('by_user', (q) => q.eq('userId', userId))
				.take(n),
		(n: number) =>
			ctx.db
				.query('mcpClients')
				.withIndex('by_user_and_org', (q) => q.eq('userId', userId))
				.take(n),
	];
}
