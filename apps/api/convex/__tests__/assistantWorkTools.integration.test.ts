/**
 * The assistant's task and company tools read as the turn's own user, through
 * the task and company pages' own visibility helpers:
 *
 *   - `listMyTasks` never returns another member's private task or a group
 *     task of a group the user is not in, in any view, and names a source
 *     conversation's subject only when the user can open it;
 *   - `getCompanyContext` shows the user's own conversations with a company,
 *     and a colleague's personal mail only as that colleague's name;
 *   - in a reply a whole room reads, neither tool reads anything.
 *
 * The tools run over a real convex-test harness; only the session of the
 * mutations that seed the tasks is mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { api, internal } from '../_generated/api';
import { buildAssistantTools } from '../assistant/tools';
import type { AssistantAudience } from '../assistant/toolRegistry';
import { actionCtxOver } from '../aiRouting/__tests__/spend.testlib';
import {
	type Harness,
	ORG_ID,
	seedMailbox,
	seedTeamThread,
	seedThread,
	workspaceHarness,
} from '../tasks/__tests__/fixtures.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-dev',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		requireAdminContext: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

function as(userId: string, role: 'owner' | 'admin' | 'editor' = 'editor') {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

const MEMBERS = { 'user-dev': 'owner', 'user-taylor': 'admin', 'user-jordan': 'editor' };
const NAMES = {
	'user-dev': 'Dev Okafor',
	'user-taylor': 'Taylor Reed',
	'user-jordan': 'Jordan Li',
};

const options: ToolExecutionOptions = { toolCallId: 'call-1', messages: [] };

/**
 * Jordan's workspace. Taylor (an admin) has a private task and, with Dev, a
 * Management group task, both about Northwind, and talks to Northwind from a
 * personal mailbox. Jordan reads Northwind through a shared mailbox and has
 * a task Dev handed over from Dev's own mail.
 */
async function workspace() {
	const t = await workspaceHarness(MEMBERS);
	await t.run(async (ctx) => {
		for (const [authUserId, name] of Object.entries(NAMES)) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				name,
				email: `${authUserId}@owlat.test`,
				createdAt: 0,
				updatedAt: 0,
			});
		}
	});
	const devBox = await seedMailbox(t, 'user-dev', 'dev@owlat.test');
	const taylorBox = await seedMailbox(t, 'user-taylor', 'taylor@owlat.test');
	const salesBox = await seedMailbox(t, 'user-dev', 'sales@owlat.test', {
		scope: 'shared',
		members: ['user-jordan'],
	});
	await t.run((ctx) => ctx.db.patch(salesBox, { displayName: 'Sales' }));
	const devThread = await seedThread(t, devBox, {
		participants: ['sam@northwind.example'],
		subject: 'Our 40-seat pricing',
	});
	const taylorThread = await seedThread(t, taylorBox, {
		participants: ['omar@northwind.example'],
		subject: 'Contract renewal terms',
	});
	const salesThread = await seedThread(t, salesBox, {
		participants: ['mia@northwind.example'],
		subject: 'Move the onboarding call',
	});
	await seedTeamThread(t, 'elena@northwind.example', 'Security questionnaire');
	await t.mutation(internal.companies.indexer.sweep, {});

	as('user-taylor', 'admin');
	await t.mutation(api.tasks.mutations.create, {
		title: 'Counter-offer 18% for Northwind',
		visibility: 'private',
		mailThreadId: taylorThread,
	});
	const management = await t.mutation(api.tasks.groups.create, {
		name: 'Management',
		memberUserIds: ['user-dev', 'user-taylor'],
	});
	await t.mutation(api.tasks.mutations.create, {
		title: 'Decide on the Northwind price increase',
		visibility: 'group',
		groupId: management,
		companyKey: 'northwind.example',
	});
	as('user-dev', 'owner');
	await t.mutation(api.tasks.mutations.create, {
		title: 'Send Northwind the signed order',
		visibility: 'everyone',
		assigneeUserId: 'user-jordan',
		mailThreadId: devThread,
		dueAt: Date.UTC(2026, 10, 20),
	});
	as('user-jordan');
	await t.mutation(api.tasks.mutations.create, {
		title: 'Confirm the onboarding date',
		visibility: 'private',
		mailThreadId: salesThread,
	});
	return t;
}

const JORDAN: AssistantAudience = {
	canReadInbox: false,
	mailReader: { userId: 'user-jordan', organizationId: ORG_ID },
};

async function toolsFor(t: Harness, audience: AssistantAudience): Promise<ToolSet> {
	return await buildAssistantTools(actionCtxOver(t).ctx, audience);
}

async function run(tools: ToolSet, name: string, input: Record<string, unknown>) {
	return (await tools[name]?.execute?.(input, options)) as Record<string, unknown>;
}

const HIDDEN_TASKS = ['Counter-offer 18%', 'price increase'];

let t: Harness;
let tools: ToolSet;

beforeEach(async () => {
	t = await workspace();
	tools = await toolsFor(t, JORDAN);
});

describe('listMyTasks', () => {
	it('lists the caller’s open tasks, with names and only the subjects they can open', async () => {
		const result = await run(tools, 'listMyTasks', {});
		expect(result['tasks']).toEqual([
			{
				title: 'Send Northwind the signed order',
				status: 'open',
				visibility: 'everyone',
				group: null,
				due: '2026-11-20T00:00:00.000Z',
				company: 'Northwind',
				companyDomain: 'northwind.example',
				assignee: 'you',
				createdBy: 'Dev Okafor',
				source: 'from email',
				// From Dev's own mailbox, which Jordan cannot open.
				sourceSubject: null,
				completedAt: null,
			},
			expect.objectContaining({
				title: 'Confirm the onboarding date',
				visibility: 'private',
				assignee: 'you',
				createdBy: 'you',
				source: 'from email',
				sourceSubject: 'Move the onboarding call',
			}),
		]);
		expect(JSON.stringify(result)).not.toContain('40-seat');
	});

	it('never returns another member’s private task or a group task outside the caller’s groups', async () => {
		for (const input of [
			{},
			{ view: 'mine' },
			{ view: 'everyone' },
			{ view: 'done' },
			{ view: 'group', groupName: 'Management' },
		]) {
			const text = JSON.stringify(await run(tools, 'listMyTasks', input));
			for (const title of HIDDEN_TASKS) expect(text, JSON.stringify(input)).not.toContain(title);
		}
		const group = await run(tools, 'listMyTasks', { view: 'group', groupName: 'Management' });
		expect(group).toMatchObject({ tasks: [], note: expect.stringContaining('not in a group') });

		// Taylor, in the group, sees both through the same tool.
		const taylor = await toolsFor(t, {
			canReadInbox: true,
			mailReader: { userId: 'user-taylor', organizationId: ORG_ID },
		});
		const mine = JSON.stringify(await run(taylor, 'listMyTasks', {}));
		for (const title of HIDDEN_TASKS) expect(mine).toContain(title);
	});
	it('reads nothing for someone who is no longer a member', async () => {
		const gone = await toolsFor(t, {
			canReadInbox: false,
			mailReader: { userId: 'user-left', organizationId: ORG_ID },
		});
		expect(await run(gone, 'listMyTasks', { view: 'everyone' })).toMatchObject({ tasks: [] });
		expect(await run(gone, 'getCompanyContext', { company: 'northwind.example' })).toMatchObject({
			found: false,
		});
	});
});

describe('getCompanyContext', () => {
	it('shows the caller’s own conversations and a colleague’s personal mail as a name alone', async () => {
		for (const company of ['Northwind', 'northwind.example', 'mia@northwind.example']) {
			const result = await run(tools, 'getCompanyContext', { company });
			expect(result).toMatchObject({
				found: true,
				company: 'Northwind',
				domain: 'northwind.example',
				people: [expect.objectContaining({ address: 'mia@northwind.example' })],
				conversations: [
					{ subject: 'Move the onboarding call', mailbox: 'Sales', date: expect.any(String) },
				],
			});
			expect((result['colleaguesInTouch'] as string[]).sort()).toEqual([
				'Dev Okafor',
				'Taylor Reed',
			]);
			expect((result['openTasks'] as Array<{ title: string }>).map((task) => task.title)).toEqual([
				'Send Northwind the signed order',
				'Confirm the onboarding date',
			]);
			// Nothing of the colleagues' mail, the Team Inbox, or the hidden tasks.
			const text = JSON.stringify(result);
			for (const secret of [
				'sam@',
				'omar@',
				'elena@',
				'40-seat',
				'renewal',
				'questionnaire',
				'user-taylor',
				'user-dev',
				...HIDDEN_TASKS,
			]) {
				expect(text, `${company}: ${secret}`).not.toContain(secret);
			}
		}
	});

	it('does not resolve a name the caller has no conversation with', async () => {
		const result = await run(tools, 'getCompanyContext', { company: 'Initech' });
		expect(result).toMatchObject({ found: false });
	});
});

describe('in a reply a whole room reads', () => {
	it('reads neither tasks nor companies', async () => {
		const room = await toolsFor(t, { canReadInbox: false });
		const tasks = await run(room, 'listMyTasks', {});
		expect(tasks).toMatchObject({ tasks: [], note: expect.any(String) });
		const company = await run(room, 'getCompanyContext', { company: 'northwind.example' });
		expect(company).toMatchObject({ found: false, note: expect.any(String) });
	});
});
