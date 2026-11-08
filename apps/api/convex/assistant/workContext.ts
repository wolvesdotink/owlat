/**
 * Internal reads behind the assistant's task and company tools.
 *
 * The runner is a scheduled action with no session, so these queries take the
 * turn's own user (`AssistantAudience.mailReader`) and rebuild that user's
 * session from their membership row. Everything after that goes through the
 * same helpers the task and company pages use (`loadTaskList`,
 * `loadCompanyTasks`, `loadCompanyViewer`, `loadCompany`), so a private task,
 * a group task outside the user's groups, or a colleague's personal mail
 * reaches the assistant exactly as far as it reaches that user's own screen.
 * Never pass a user id the model chose: the tool takes it from the turn.
 */

import { v } from 'convex/values';
import { companyKeyOf, companyKeyOfDomain } from '@owlat/shared/companyKey';
import { components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { listCompanies } from '../companies/companies';
import { loadCompany, loadCompanyViewer } from '../companies/read';
import type { OrganizationRole } from '../lib/sessionOrganization';
import { loadGroupIds } from '../tasks/members';
import { loadCompanyTasks, loadTaskList } from '../tasks/tasks';
import type { SessionLike, TaskView } from '../tasks/view';
import { clampText } from './prompt';

const MAX_SUBJECT = 200;
const DEFAULT_TASK_LIMIT = 20;
const MAX_TASK_LIMIT = 50;
const COMPANY_CONVERSATIONS = 10;
const COMPANY_PEOPLE = 10;
const COMPANY_TASKS = 20;

/** The views the tool offers; the task page's `private` and `created` lists stay out. */
export const ASSISTANT_TASK_VIEWS = ['mine', 'everyone', 'group', 'done'] as const;
type AssistantTaskView = (typeof ASSISTANT_TASK_VIEWS)[number];

const readerArgs = { userId: v.string(), organizationId: v.string() };

/**
 * The turn's user as a session, or null when they are no longer a member of
 * the organization: a removed member's turn reads nothing.
 */
async function readerSession(
	ctx: QueryCtx,
	reader: { userId: string; organizationId: string }
): Promise<SessionLike | null> {
	const member = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: reader.organizationId },
			{ field: 'userId', value: reader.userId },
		],
	})) as { role?: string } | null;
	if (!member) return null;
	return {
		userId: reader.userId,
		role: (member.role ?? null) as OrganizationRole | null,
		activeOrganizationId: reader.organizationId,
	};
}

/**
 * Display names for workspace members, as the task page shows them: the
 * profile name, else the sign-in address. The reader is "you".
 */
async function memberNames(
	ctx: QueryCtx,
	readerId: string,
	userIds: Iterable<string>
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	for (const userId of userIds) {
		if (names.has(userId)) continue;
		if (userId === readerId) {
			names.set(userId, 'you');
			continue;
		}
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', userId))
			.first();
		const name = profile && !profile.deletedAt ? profile.name?.trim() || profile.email : null;
		names.set(userId, name ?? 'someone');
	}
	return names;
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

export interface AssistantTask {
	title: string;
	status: TaskView['status'];
	visibility: TaskView['visibility'];
	/** The group that sees a group task. */
	group: string | null;
	due: string | null;
	company: string | null;
	companyDomain: string | null;
	assignee: string;
	createdBy: string;
	source: 'from email' | 'from team inbox' | null;
	/** Only for a conversation the reader can open. */
	sourceSubject: string | null;
	completedAt: string | null;
}

async function toAssistantTasks(
	ctx: QueryCtx,
	readerId: string,
	views: readonly TaskView[]
): Promise<AssistantTask[]> {
	const names = await memberNames(
		ctx,
		readerId,
		views.flatMap((view) => [view.assigneeUserId, view.createdBy])
	);
	return views.map((view) => {
		const source = view.source;
		const subject = source?.canOpen && source.subject ? source.subject : null;
		return {
			title: view.title,
			status: view.status,
			visibility: view.visibility,
			group: view.visibility === 'group' ? view.groupName : null,
			due: iso(view.dueAt),
			company: view.companyName,
			companyDomain: view.companyKey,
			assignee: names.get(view.assigneeUserId) ?? 'someone',
			createdBy: names.get(view.createdBy) ?? 'someone',
			source: source ? (source.kind === 'mail' ? 'from email' : 'from team inbox') : null,
			sourceSubject: subject ? clampText(subject, MAX_SUBJECT) : null,
			completedAt: iso(view.completedAt),
		};
	});
}

/** The member group of the reader's that carries this name, if any. */
async function readerGroupByName(
	ctx: QueryCtx,
	userId: string,
	name: string
): Promise<{ match: Id<'memberGroups'> | null; groupNames: string[] }> {
	const wanted = name.trim().toLowerCase();
	const groupNames: string[] = [];
	for (const groupId of await loadGroupIds(ctx, userId)) {
		const group = await ctx.db.get(groupId as Id<'memberGroups'>);
		if (!group) continue;
		if (group.name.trim().toLowerCase() === wanted) return { match: group._id, groupNames };
		groupNames.push(group.name);
	}
	return { match: null, groupNames };
}

export interface AssistantTaskList {
	view: AssistantTaskView;
	tasks: AssistantTask[];
	/** How many the list held before the limit. */
	total: number;
	note?: string;
}

// authz: the reader is the turn's own user; rows come from loadTaskList, which passes each through canSeeTask.
export const myTasks = internalQuery({
	args: {
		...readerArgs,
		view: v.union(v.literal('mine'), v.literal('everyone'), v.literal('group'), v.literal('done')),
		groupName: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<AssistantTaskList> => {
		const session = await readerSession(ctx, args);
		if (!session) return { view: args.view, tasks: [], total: 0, note: 'Not a workspace member.' };
		let groupId: Id<'memberGroups'> | undefined;
		if (args.view === 'group') {
			if (!args.groupName?.trim()) {
				return { view: args.view, tasks: [], total: 0, note: 'Name the group to list.' };
			}
			const { match, groupNames } = await readerGroupByName(ctx, session.userId, args.groupName);
			if (!match) {
				const yours = groupNames.length > 0 ? ` Your groups: ${groupNames.join(', ')}.` : '';
				return {
					view: args.view,
					tasks: [],
					total: 0,
					note: `You are not in a group called "${clampText(args.groupName, 80)}".${yours}`,
				};
			}
			groupId = match;
		}
		const views = await loadTaskList(ctx, session, {
			view: args.view,
			...(groupId ? { groupId } : {}),
		});
		const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT));
		return {
			view: args.view,
			tasks: await toAssistantTasks(ctx, session.userId, views.slice(0, limit)),
			total: views.length,
		};
	},
});

/**
 * The company key the model asked about: a domain or address as written, or
 * else a company name matched against the companies in the reader's own
 * conversations. A name never reaches a company the reader has no
 * conversation with.
 */
async function resolveCompanyKey(
	ctx: QueryCtx,
	viewer: Awaited<ReturnType<typeof loadCompanyViewer>>,
	query: string
): Promise<string | null> {
	const trimmed = query.trim();
	if (trimmed.includes('@')) return companyKeyOf(trimmed);
	if (trimmed.includes('.')) return companyKeyOfDomain(trimmed);
	const wanted = trimmed.toLowerCase();
	if (!wanted) return null;
	const companies = await listCompanies(ctx, viewer);
	const exact = companies.find(
		(company) => company.name.toLowerCase() === wanted || company.key.split('.')[0] === wanted
	);
	if (exact) return exact.key;
	return companies.find((company) => company.name.toLowerCase().includes(wanted))?.key ?? null;
}

export type AssistantCompanyContext =
	| { found: false; note: string }
	| {
			found: true;
			company: string;
			domain: string;
			lastContact: string | null;
			people: Array<{
				name: string | null;
				address: string;
				conversations: number;
				lastContact: string;
			}>;
			conversations: Array<{ subject: string; mailbox: string; date: string }>;
			openTasks: AssistantTask[];
			/** Colleagues in touch through mail the reader cannot open: their names only. */
			colleaguesInTouch: string[];
			note?: string;
	  };

// authz: the reader is the turn's own user; loadCompany keeps rows they cannot open down to the colleague, and tasks pass canSeeTask.
export const companyContext = internalQuery({
	args: { ...readerArgs, company: v.string() },
	handler: async (ctx, args): Promise<AssistantCompanyContext> => {
		const session = await readerSession(ctx, args);
		if (!session) return { found: false, note: 'Not a workspace member.' };
		const viewer = await loadCompanyViewer(ctx, session);
		const key = await resolveCompanyKey(ctx, viewer, args.company);
		if (key === null) {
			return {
				found: false,
				note: `No company called "${clampText(args.company.trim(), 80)}" in your conversations. Try its domain, such as northwind.example.`,
			};
		}
		const company = await loadCompany(ctx, viewer, key, {
			conversations: COMPANY_CONVERSATIONS,
			people: COMPANY_PEOPLE,
		});
		const tasks = (await loadCompanyTasks(ctx, session, key)).slice(0, COMPANY_TASKS);
		const colleagues = await memberNames(ctx, session.userId, company.colleagueUserIds);
		const isEmpty =
			company.people.length === 0 && company.colleagueUserIds.length === 0 && tasks.length === 0;
		return {
			found: true,
			company: company.name,
			domain: company.key,
			lastContact: iso(company.lastMessageAt),
			people: company.people.map((person) => ({
				name: person.name,
				address: person.address,
				conversations: person.conversations,
				lastContact: new Date(person.lastMessageAt).toISOString(),
			})),
			conversations: company.conversations.map((conversation) => ({
				subject: clampText(conversation.subject, MAX_SUBJECT),
				mailbox: conversation.kind === 'team' ? 'Team Inbox' : (conversation.mailboxName ?? ''),
				date: new Date(conversation.lastMessageAt).toISOString(),
			})),
			openTasks: await toAssistantTasks(ctx, session.userId, tasks),
			colleaguesInTouch: [...colleagues.values()],
			...(isEmpty ? { note: 'Nothing in your conversations or tasks involves this company.' } : {}),
		};
	},
});
