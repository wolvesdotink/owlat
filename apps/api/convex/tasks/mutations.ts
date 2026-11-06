/**
 * Changing tasks. Whoever can see a task may work on it (tasks/access.ts);
 * the audience rules decide who it may be shown to and assigned to.
 */

import { v } from 'convex/values';
import { companyKeyOfDomain } from '@owlat/shared/companyKey';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { getOrThrow, throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { groupByCompany, teamThreadCompanies } from '../companies/eligibility';
import { loadOwnDomains } from '../companies/ownDomains';
import { isSharedInboxReader } from '../inbox/access';
import { authedMutation } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { taskStatusValidator, taskVisibilityValidator } from '../lib/validators/tasks';
import { requireMailboxAccess } from '../mail/permissions';
import {
	TASK_AUDIENCE_MESSAGES,
	canSeeTask,
	checkTaskAudience,
	mayMakePrivate,
	type TaskAudienceRequest,
	type TaskViewer,
} from './access';
import { isGroupMember, isOrgMember, loadViewer } from './members';

export const MAX_TITLE_LENGTH = 300;
export const MAX_NOTES_LENGTH = 5000;

function cleanTitle(raw: string): string {
	const title = raw.replace(/\s+/g, ' ').trim();
	if (!title) throwInvalidInput('A task needs a title.');
	if (title.length > MAX_TITLE_LENGTH) {
		throwInvalidInput(`A task title is at most ${MAX_TITLE_LENGTH} characters.`);
	}
	return title;
}

function cleanNotes(raw: string | null | undefined): string | undefined {
	if (raw === null || raw === undefined) return undefined;
	const notes = raw.trim();
	if (notes.length > MAX_NOTES_LENGTH) {
		throwInvalidInput(`Task notes are at most ${MAX_NOTES_LENGTH} characters.`);
	}
	return notes || undefined;
}

/** Throws unless the actor may give a task this audience and owner. */
async function assertAudience(
	ctx: MutationCtx,
	session: MutationSessionContext,
	actor: TaskViewer,
	request: TaskAudienceRequest
): Promise<void> {
	if (request.assigneeUserId !== actor.userId) {
		if (!(await isOrgMember(ctx, session.activeOrganizationId, request.assigneeUserId))) {
			throwInvalidInput('The assignee is not a member of this workspace.');
		}
	}
	let assigneeInGroup = false;
	if (request.visibility === 'group' && request.groupId) {
		const groupId = request.groupId as Id<'memberGroups'>;
		await getOrThrow(ctx, groupId, 'Group');
		assigneeInGroup = await isGroupMember(ctx, groupId, request.assigneeUserId);
	}
	const outcome = checkTaskAudience(request, actor, assigneeInGroup);
	if (!outcome.ok) throwInvalidInput(TASK_AUDIENCE_MESSAGES[outcome.reason]);
}

interface SourceArgs {
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
	threadItemId?: Id<'threadItems'>;
}

/**
 * The source conversation's fields on the task, after checking the actor can
 * open it, and the company it involves (the first one, by participant order).
 */
async function resolveSource(
	ctx: MutationCtx,
	session: MutationSessionContext,
	args: SourceArgs
): Promise<{ fields: Partial<Doc<'tasks'>>; companyKey?: string }> {
	if (args.mailThreadId && args.conversationThreadId) {
		throwInvalidInput('A task comes from one conversation.');
	}
	if (args.mailThreadId) {
		const thread = await getOrThrow(ctx, args.mailThreadId, 'Conversation');
		const access = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('You cannot open that conversation.');
		if (args.threadItemId) {
			const item = await ctx.db.get(args.threadItemId);
			if (!item || item.mailThreadId !== thread._id) throwNotFound('Item');
		}
		const companies = groupByCompany(thread.participants, await loadOwnDomains(ctx));
		return {
			fields: {
				sourceMailThreadId: thread._id,
				sourceMailboxId: thread.mailboxId,
				...(args.threadItemId ? { sourceThreadItemId: args.threadItemId } : {}),
			},
			companyKey: companies.keys().next().value,
		};
	}
	if (args.conversationThreadId) {
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) {
			throwForbidden('You cannot open that conversation.');
		}
		const thread = await getOrThrow(ctx, args.conversationThreadId, 'Conversation');
		if (args.threadItemId) {
			const item = await ctx.db.get(args.threadItemId);
			if (!item || item.conversationThreadId !== thread._id) throwNotFound('Item');
		}
		const companies = teamThreadCompanies(thread, await loadOwnDomains(ctx));
		return {
			fields: {
				sourceConversationThreadId: thread._id,
				...(args.threadItemId ? { sourceThreadItemId: args.threadItemId } : {}),
			},
			companyKey: companies.keys().next().value,
		};
	}
	if (args.threadItemId) throwInvalidInput('An item needs its conversation.');
	return { fields: {} };
}

function cleanCompanyKey(raw: string): string {
	const key = companyKeyOfDomain(raw);
	if (key === null) throwInvalidInput('That is not a company domain.');
	return key;
}

// authz: the source conversation is gated by requireMailboxAccess / the shared-inbox reader rule in resolveSource; the audience by checkTaskAudience.
export const create = authedMutation({
	args: {
		title: v.string(),
		notes: v.optional(v.string()),
		visibility: taskVisibilityValidator,
		groupId: v.optional(v.id('memberGroups')),
		assigneeUserId: v.optional(v.string()),
		dueAt: v.optional(v.number()),
		companyKey: v.optional(v.string()),
		mailThreadId: v.optional(v.id('mailThreads')),
		conversationThreadId: v.optional(v.id('conversationThreads')),
		threadItemId: v.optional(v.id('threadItems')),
	},
	handler: async (ctx, args, session): Promise<Id<'tasks'>> => {
		const actor = await loadViewer(ctx, session.userId);
		const assigneeUserId = args.assigneeUserId ?? session.userId;
		const audience = {
			visibility: args.visibility,
			...(args.groupId ? { groupId: args.groupId as string } : {}),
			assigneeUserId,
		};
		await assertAudience(ctx, session, actor, audience);
		const source = await resolveSource(ctx, session, args);
		const companyKey = args.companyKey ? cleanCompanyKey(args.companyKey) : source.companyKey;
		const notes = cleanNotes(args.notes);
		const now = Date.now();
		return await ctx.db.insert('tasks', {
			title: cleanTitle(args.title),
			...(notes ? { notes } : {}),
			visibility: args.visibility,
			...(args.groupId ? { groupId: args.groupId } : {}),
			createdBy: session.userId,
			assigneeUserId,
			status: 'open',
			...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}),
			...(companyKey ? { companyKey } : {}),
			...source.fields,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/** Loads a task the actor can see; one they cannot see reads as missing. */
async function loadVisibleTask(ctx: MutationCtx, taskId: Id<'tasks'>, actor: TaskViewer) {
	const task = await ctx.db.get(taskId);
	if (!task || !canSeeTask(task, actor)) throwNotFound('Task');
	return task;
}

// authz: the actor must see the task (canSeeTask); audience changes pass checkTaskAudience and mayMakePrivate.
export const update = authedMutation({
	args: {
		taskId: v.id('tasks'),
		title: v.optional(v.string()),
		notes: v.optional(v.union(v.string(), v.null())),
		dueAt: v.optional(v.union(v.number(), v.null())),
		companyKey: v.optional(v.union(v.string(), v.null())),
		visibility: v.optional(taskVisibilityValidator),
		groupId: v.optional(v.union(v.id('memberGroups'), v.null())),
		assigneeUserId: v.optional(v.string()),
	},
	handler: async (ctx, args, session): Promise<null> => {
		const actor = await loadViewer(ctx, session.userId);
		const task = await loadVisibleTask(ctx, args.taskId, actor);
		const visibility = args.visibility ?? task.visibility;
		const groupId =
			visibility !== 'group' ? undefined : args.groupId === undefined ? task.groupId : args.groupId;
		const assigneeUserId = args.assigneeUserId ?? task.assigneeUserId;
		const audienceChanged =
			visibility !== task.visibility ||
			groupId !== task.groupId ||
			assigneeUserId !== task.assigneeUserId;
		if (audienceChanged) {
			if (
				visibility === 'private' &&
				task.visibility !== 'private' &&
				!mayMakePrivate(task, actor.userId)
			) {
				throwForbidden('Only a task you created and own yourself can be made private.');
			}
			await assertAudience(ctx, session, actor, {
				visibility,
				...(groupId ? { groupId: groupId as string } : {}),
				assigneeUserId,
			});
		}
		const patch: Partial<Doc<'tasks'>> = { updatedAt: Date.now() };
		if (args.title !== undefined) patch.title = cleanTitle(args.title);
		if (args.notes !== undefined) patch.notes = cleanNotes(args.notes);
		if (args.dueAt !== undefined) patch.dueAt = args.dueAt ?? undefined;
		if (args.companyKey !== undefined) {
			patch.companyKey = args.companyKey === null ? undefined : cleanCompanyKey(args.companyKey);
		}
		if (audienceChanged) {
			patch.visibility = visibility;
			patch.groupId = groupId ?? undefined;
			patch.assigneeUserId = assigneeUserId;
		}
		await ctx.db.patch(task._id, patch);
		return null;
	},
});

// authz: the actor must see the task (canSeeTask); whoever sees a task may finish, drop or reopen it.
export const setStatus = authedMutation({
	args: { taskId: v.id('tasks'), status: taskStatusValidator },
	handler: async (ctx, args, session): Promise<null> => {
		const actor = await loadViewer(ctx, session.userId);
		const task = await loadVisibleTask(ctx, args.taskId, actor);
		if (task.status === args.status) return null;
		const now = Date.now();
		await ctx.db.patch(task._id, {
			status: args.status,
			completedAt: args.status === 'open' ? undefined : now,
			completedBy: args.status === 'open' ? undefined : session.userId,
			updatedAt: now,
		});
		return null;
	},
});
