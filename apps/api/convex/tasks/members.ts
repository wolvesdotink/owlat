/**
 * Membership reads the task and group functions share: whether a user belongs
 * to the workspace, and which member groups someone belongs to.
 */

import { components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { TaskViewer } from './access';

/** Far above the number of groups one person belongs to. */
const MAX_GROUPS_PER_MEMBER = 200;

export async function isOrgMember(
	ctx: QueryCtx,
	organizationId: string,
	userId: string
): Promise<boolean> {
	const member = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: organizationId },
			{ field: 'userId', value: userId },
		],
	})) as { userId?: string } | null;
	return member !== null;
}

export async function loadGroupIds(ctx: QueryCtx, userId: string): Promise<Set<string>> {
	const rows = await ctx.db
		.query('memberGroupMembers')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.take(MAX_GROUPS_PER_MEMBER);
	return new Set(rows.map((row) => row.groupId as string));
}

export async function loadViewer(ctx: QueryCtx, userId: string): Promise<TaskViewer> {
	return { userId, groupIds: await loadGroupIds(ctx, userId) };
}

export async function isGroupMember(
	ctx: QueryCtx,
	groupId: Id<'memberGroups'>,
	userId: string
): Promise<boolean> {
	const row = await ctx.db
		.query('memberGroupMembers')
		.withIndex('by_group_user', (q) => q.eq('groupId', groupId).eq('userId', userId))
		.first();
	return row !== null;
}
