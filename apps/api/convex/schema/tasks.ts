import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { taskStatusValidator, taskVisibilityValidator } from '../lib/validators/tasks';

/**
 * Tasks and member groups.
 *
 * A task is work someone owns: added by hand, or taken from a conversation
 * (an email in a Postbox mailbox, a Team Inbox thread). Its visibility decides
 * who sees it; the rules live in `tasks/access.ts`.
 *
 * A member group is a named set of workspace members, such as "Management",
 * that a task can be shown to. Owners and admins manage the groups.
 */
export const taskTables = {
	tasks: defineTable({
		title: v.string(),
		notes: v.optional(v.string()),
		visibility: taskVisibilityValidator,
		// Set exactly when `visibility` is `group`.
		groupId: v.optional(v.id('memberGroups')),
		createdBy: v.string(), // BetterAuth user id
		// Always set. A private task's assignee is its creator.
		assigneeUserId: v.string(), // BetterAuth user id
		status: taskStatusValidator,
		dueAt: v.optional(v.number()),
		// The organisational domain of the company the task is about
		// (`@owlat/shared/companyKey`).
		companyKey: v.optional(v.string()),
		// The conversation the task came from. A teammate who cannot open that
		// conversation still sees the task, but never its subject: the task's
		// own title is what the creator chose to share.
		sourceMailThreadId: v.optional(v.id('mailThreads')),
		sourceMailboxId: v.optional(v.id('mailboxes')),
		sourceConversationThreadId: v.optional(v.id('conversationThreads')),
		sourceThreadItemId: v.optional(v.id('threadItems')),
		completedAt: v.optional(v.number()),
		completedBy: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_assignee_status_due', ['assigneeUserId', 'status', 'dueAt'])
		.index('by_creator_status', ['createdBy', 'status'])
		.index('by_visibility_status_due', ['visibility', 'status', 'dueAt'])
		.index('by_group_status_due', ['groupId', 'status', 'dueAt'])
		.index('by_company_status', ['companyKey', 'status'])
		.index('by_source_mail_thread', ['sourceMailThreadId'])
		.index('by_source_mailbox', ['sourceMailboxId'])
		.index('by_source_conversation_thread', ['sourceConversationThreadId'])
		// Member erasure anonymizes who finished a task.
		.index('by_completed_by', ['completedBy']),

	memberGroups: defineTable({
		name: v.string(),
		createdBy: v.string(), // BetterAuth user id
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_name', ['name'])
		// Member erasure anonymizes who created a group.
		.index('by_created_by', ['createdBy']),

	memberGroupMembers: defineTable({
		groupId: v.id('memberGroups'),
		userId: v.string(), // BetterAuth user id
		addedBy: v.string(), // BetterAuth user id
		addedAt: v.number(),
	})
		.index('by_group_user', ['groupId', 'userId'])
		.index('by_user', ['userId'])
		// Member erasure anonymizes who added a member.
		.index('by_added_by', ['addedBy']),
};
