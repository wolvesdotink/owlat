/**
 * Member groups: named sets of workspace members (Management, Product, …) that
 * a task can be shown to. Every member can see which groups exist and who is
 * in them, because that is who a group task reaches. Owners and admins create,
 * rename and delete groups and change their members.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { adminMutation, authedQuery } from '../lib/authedFunctions';
import { isOrgMember } from './members';

/** Far above any real number of groups or members of one group. */
const MAX_GROUPS = 200;
const MAX_MEMBERS = 500;
const MAX_NAME_LENGTH = 60;

export interface MemberGroupView {
	_id: Id<'memberGroups'>;
	name: string;
	memberUserIds: string[];
	isMember: boolean;
}

function cleanName(raw: string): string {
	const name = raw.replace(/\s+/g, ' ').trim();
	if (!name) throwInvalidInput('A group needs a name.');
	if (name.length > MAX_NAME_LENGTH) {
		throwInvalidInput(`A group name is at most ${MAX_NAME_LENGTH} characters.`);
	}
	return name;
}

async function membersOf(ctx: QueryCtx, groupId: Id<'memberGroups'>) {
	return await ctx.db
		.query('memberGroupMembers')
		.withIndex('by_group_user', (q) => q.eq('groupId', groupId))
		.take(MAX_MEMBERS);
}

async function assertNameFree(ctx: QueryCtx, name: string, except?: Id<'memberGroups'>) {
	const groups = await ctx.db.query('memberGroups').take(MAX_GROUPS); // bounded: a workspace's groups
	const lower = name.toLowerCase();
	if (groups.some((g) => g._id !== except && g.name.toLowerCase() === lower)) {
		throwInvalidInput(`There is already a group called ${name}.`);
	}
}

// all-members: a group's name and members are who a group task reaches, which every member may know.
export const list = authedQuery({
	args: {},
	handler: async (ctx, _args, session): Promise<MemberGroupView[]> => {
		const groups = await ctx.db.query('memberGroups').withIndex('by_name').take(MAX_GROUPS);
		return await Promise.all(
			groups.map(async (group: Doc<'memberGroups'>) => {
				const memberUserIds = (await membersOf(ctx, group._id)).map((row) => row.userId);
				return {
					_id: group._id,
					name: group.name,
					memberUserIds,
					isMember: memberUserIds.includes(session.userId),
				};
			})
		);
	},
});

export const create = adminMutation({
	args: { name: v.string(), memberUserIds: v.optional(v.array(v.string())) },
	handler: async (ctx, args, session): Promise<Id<'memberGroups'>> => {
		const name = cleanName(args.name);
		await assertNameFree(ctx, name);
		const now = Date.now();
		const groupId = await ctx.db.insert('memberGroups', {
			name,
			createdBy: session.userId,
			createdAt: now,
			updatedAt: now,
		});
		for (const userId of new Set(args.memberUserIds ?? [])) {
			if (!(await isOrgMember(ctx, session.activeOrganizationId, userId))) {
				throwInvalidInput('Only workspace members can join a group.');
			}
			await ctx.db.insert('memberGroupMembers', {
				groupId,
				userId,
				addedBy: session.userId,
				addedAt: now,
			});
		}
		return groupId;
	},
});

export const rename = adminMutation({
	args: { groupId: v.id('memberGroups'), name: v.string() },
	handler: async (ctx, args): Promise<null> => {
		await getOrThrow(ctx, args.groupId, 'Group');
		const name = cleanName(args.name);
		await assertNameFree(ctx, name, args.groupId);
		await ctx.db.patch(args.groupId, { name, updatedAt: Date.now() });
		return null;
	},
});

/**
 * A group that still has tasks cannot be deleted: its tasks would lose their
 * audience. Move them to another group or finish them first.
 */
export const remove = adminMutation({
	args: { groupId: v.id('memberGroups') },
	handler: async (ctx, args): Promise<null> => {
		await getOrThrow(ctx, args.groupId, 'Group');
		const task = await ctx.db
			.query('tasks')
			.withIndex('by_group_status_due', (q) => q.eq('groupId', args.groupId))
			.first();
		if (task) throwInvalidState('This group still has tasks. Move them to another group first.');
		for (const row of await membersOf(ctx, args.groupId)) await ctx.db.delete(row._id);
		await ctx.db.delete(args.groupId);
		return null;
	},
});

export const addMember = adminMutation({
	args: { groupId: v.id('memberGroups'), userId: v.string() },
	handler: async (ctx, args, session): Promise<null> => {
		await getOrThrow(ctx, args.groupId, 'Group');
		if (!(await isOrgMember(ctx, session.activeOrganizationId, args.userId))) {
			throwInvalidInput('Only workspace members can join a group.');
		}
		const existing = await ctx.db
			.query('memberGroupMembers')
			.withIndex('by_group_user', (q) => q.eq('groupId', args.groupId).eq('userId', args.userId))
			.first();
		if (existing) return null;
		await ctx.db.insert('memberGroupMembers', {
			groupId: args.groupId,
			userId: args.userId,
			addedBy: session.userId,
			addedAt: Date.now(),
		});
		await ctx.db.patch(args.groupId, { updatedAt: Date.now() });
		return null;
	},
});

/**
 * Leaving a group hides its tasks from that person, except the ones they
 * created or are assigned to (tasks/access.ts).
 */
export const removeMember = adminMutation({
	args: { groupId: v.id('memberGroups'), userId: v.string() },
	handler: async (ctx, args): Promise<null> => {
		const row = await ctx.db
			.query('memberGroupMembers')
			.withIndex('by_group_user', (q) => q.eq('groupId', args.groupId).eq('userId', args.userId))
			.first();
		if (!row) return null;
		await ctx.db.delete(row._id);
		await ctx.db.patch(args.groupId, { updatedAt: Date.now() });
		return null;
	},
});
