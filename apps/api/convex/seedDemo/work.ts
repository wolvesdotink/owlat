/**
 * Seed step: member groups, tasks and the company index for the demo
 * workspace.
 *
 * Runs after `seedDemo/messages.ts` (`seedDemoHttp` calls it last), because a
 * task taken from a conversation points at a thread that only exists once the
 * fixture mail is delivered, and the company index is built from those
 * threads. The index sweep runs here once so the companies show up right
 * after the seed, without waiting for the cron.
 *
 * Like the mailboxes, these are ordinary tenant rows with no `seedTag`: not
 * swept by `?reset=true`, wiped by `POST /dev/reset`. A re-run dedupes groups
 * by name and tasks by creator and title. Due dates are relative to seed time.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { runSweep } from '../companies/indexer';
import { nextUtcDayStart } from '../lib/clock';
import { internalMutation } from '../lib/writeFence';
import groupsFixture from './fixtures/memberGroups.json';
import tasksFixture from './fixtures/tasks.json';
import { authUserIdByEmail } from './loaders/mailboxes';

interface GroupFixture {
	name: string;
	createdBy: string;
	members: string[];
}

type DuePreset = 'overdue' | 'today' | 'week' | 'later';

interface TaskFixture {
	title: string;
	notes?: string;
	visibility: 'private' | 'everyone' | 'group';
	/** Name of a group from memberGroups.json. */
	group?: string;
	/** Login emails. A missing assignee is the creator. */
	createdBy: string;
	assignee?: string;
	due?: DuePreset;
	status?: 'open' | 'done';
	company?: string;
	/** Message-ID of a fixture message in mailboxMessages.json. */
	source?: string;
}

const DAY = 24 * 60 * 60 * 1000;

function dueAt(preset: DuePreset | undefined, now: number): number | undefined {
	switch (preset) {
		case 'overdue':
			return now - 2 * DAY;
		case 'today':
			return nextUtcDayStart(now) - 60_000;
		case 'week':
			return now + 3 * DAY;
		case 'later':
			return now + 14 * DAY;
		case undefined:
			return undefined;
	}
}

/** Login email → BetterAuth user id, for every account the fixtures name. */
async function resolveUsers(ctx: MutationCtx, emails: string[]): Promise<Map<string, string>> {
	const users = new Map<string, string>();
	for (const email of new Set(emails)) {
		const id = await authUserIdByEmail(ctx, email);
		if (id) users.set(email, id);
	}
	return users;
}

async function seedGroups(
	ctx: MutationCtx,
	users: Map<string, string>,
	now: number
): Promise<{ ids: Map<string, Id<'memberGroups'>>; inserted: number }> {
	const ids = new Map<string, Id<'memberGroups'>>();
	let inserted = 0;
	for (const group of groupsFixture as GroupFixture[]) {
		const createdBy = users.get(group.createdBy);
		if (!createdBy) continue;
		const existing = await ctx.db
			.query('memberGroups')
			.withIndex('by_name', (q) => q.eq('name', group.name))
			.first();
		if (existing) {
			ids.set(group.name, existing._id);
			continue;
		}
		const groupId = await ctx.db.insert('memberGroups', {
			name: group.name,
			createdBy,
			createdAt: now,
			updatedAt: now,
		});
		for (const email of group.members) {
			const userId = users.get(email);
			if (!userId) continue;
			await ctx.db.insert('memberGroupMembers', {
				groupId,
				userId,
				addedBy: createdBy,
				addedAt: now,
			});
		}
		ids.set(group.name, groupId);
		inserted++;
	}
	return { ids, inserted };
}

/** The thread and mailbox a fixture message landed in, once delivered. */
async function sourceOf(ctx: MutationCtx, messageId: string | undefined) {
	if (!messageId) return {};
	const message = await ctx.db
		.query('mailMessages')
		.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', messageId))
		.first();
	if (!message) return {};
	return { sourceMailThreadId: message.threadId, sourceMailboxId: message.mailboxId };
}

async function seedTasks(
	ctx: MutationCtx,
	users: Map<string, string>,
	groups: Map<string, Id<'memberGroups'>>,
	now: number
): Promise<number> {
	let inserted = 0;
	for (const task of tasksFixture as TaskFixture[]) {
		const createdBy = users.get(task.createdBy);
		const assigneeUserId = task.assignee ? users.get(task.assignee) : createdBy;
		const groupId = task.group ? groups.get(task.group) : undefined;
		if (!createdBy || !assigneeUserId || (task.visibility === 'group' && !groupId)) continue;
		const own = await ctx.db
			.query('tasks')
			.withIndex('by_creator_status', (q) => q.eq('createdBy', createdBy))
			.take(200);
		if (own.some((row) => row.title === task.title)) continue;
		const due = dueAt(task.due, now);
		const done = task.status === 'done';
		await ctx.db.insert('tasks', {
			title: task.title,
			...(task.notes ? { notes: task.notes } : {}),
			visibility: task.visibility,
			...(groupId ? { groupId } : {}),
			createdBy,
			assigneeUserId,
			status: done ? 'done' : 'open',
			...(due !== undefined ? { dueAt: due } : {}),
			...(task.company ? { companyKey: task.company } : {}),
			...(await sourceOf(ctx, task.source)),
			...(done ? { completedAt: now - DAY, completedBy: assigneeUserId } : {}),
			createdAt: now - 3 * DAY,
			updatedAt: now,
		});
		inserted++;
	}
	return inserted;
}

export const seedWork = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ groups: number; tasks: number; indexed: number }> => {
		const now = Date.now();
		const groups = groupsFixture as GroupFixture[];
		const tasks = tasksFixture as TaskFixture[];
		const users = await resolveUsers(ctx, [
			...groups.flatMap((group) => [group.createdBy, ...group.members]),
			...tasks.flatMap((task) => [task.createdBy, ...(task.assignee ? [task.assignee] : [])]),
		]);
		const seededGroups = await seedGroups(ctx, users, now);
		const insertedTasks = await seedTasks(ctx, users, seededGroups.ids, now);
		const { indexed } = await runSweep(ctx, now);
		return { groups: seededGroups.inserted, tasks: insertedTasks, indexed };
	},
});
