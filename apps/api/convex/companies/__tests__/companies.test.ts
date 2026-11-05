/**
 * The company index and what each member reads from it:
 *
 *   - the indexer files a conversation under its company and leaves out
 *     free-mail, the workspace's own domain and bulk mail;
 *   - `companies.get` shows a member only the conversations they could open;
 *     a colleague's personal mail adds that colleague's id and nothing else;
 *   - `companies.forThread` answers nothing for a thread the caller cannot
 *     open.
 */

import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import {
	type Harness,
	seedMailbox,
	seedTeamThread,
	seedThread,
	workspaceHarness,
} from '../../tasks/__tests__/fixtures.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-dev',
	role: 'editor' as 'owner' | 'admin' | 'editor',
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.orgId,
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
	};
});

function as(userId: string, role: 'owner' | 'admin' | 'editor' = 'editor') {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

const MEMBERS = { 'user-dev': 'owner', 'user-taylor': 'admin', 'user-jordan': 'editor' };

async function indexedRows(t: Harness) {
	await t.mutation(internal.companies.indexer.sweep, {});
	return await t.run((ctx) => ctx.db.query('companyThreads').collect());
}

describe('company indexer', () => {
	it('indexes conversations and leaves out free-mail, own-domain and bulk threads', async () => {
		const t = await workspaceHarness(MEMBERS);
		const box = await seedMailbox(t, 'user-dev', 'dev@owlat.test');
		const northwind = await seedThread(t, box, {
			participants: ['Mia@Northwind.example', 'dev@owlat.test', 'sam@mail.northwind.example'],
			subject: 'Onboarding call',
		});
		await seedThread(t, box, { participants: ['alex@gmail.com'], subject: 'Meetup talk' });
		await seedThread(t, box, { participants: ['taylor@owlat.test'], subject: 'Lunch?' });
		await seedThread(t, box, {
			participants: ['news@acmecorp.example'],
			subject: 'Acme monthly',
			category: { label: 'newsletter', source: 'heuristic', classifiedAt: Date.now() },
		});
		await seedThread(t, box, {
			participants: ['offers@initech.example'],
			subject: 'Junk',
			folderRoles: ['spam'],
		});
		const team = await seedTeamThread(t, 'ben@acmecorp.example', 'Invoice address');
		await seedTeamThread(t, 'priya@gmail.com', 'Password reset');

		const rows = await indexedRows(t);
		expect(
			rows
				.map((row) => ({
					key: row.companyKey,
					kind: row.kind,
					thread: row.mailThreadId ?? row.conversationThreadId,
					addresses: row.addresses,
					owner: row.ownerUserId ?? null,
				}))
				.sort((a, b) => a.key.localeCompare(b.key))
		).toEqual([
			{
				key: 'acmecorp.example',
				kind: 'team',
				thread: team,
				addresses: ['ben@acmecorp.example'],
				owner: null,
			},
			{
				key: 'northwind.example',
				kind: 'mail',
				thread: northwind,
				addresses: ['mia@northwind.example', 'sam@mail.northwind.example'],
				owner: 'user-dev',
			},
		]);

		// A second sweep over unchanged threads writes no duplicate.
		expect(await indexedRows(t)).toHaveLength(2);
	});
});

async function northwindWorkspace() {
	const t = await workspaceHarness(MEMBERS);
	const devBox = await seedMailbox(t, 'user-dev', 'dev@owlat.test');
	const taylorBox = await seedMailbox(t, 'user-taylor', 'taylor@owlat.test');
	const teamBox = await seedMailbox(t, 'user-dev', 'team@owlat.test', {
		scope: 'shared',
		members: ['user-jordan'],
	});
	const devThread = await seedThread(t, devBox, {
		participants: ['sam@northwind.example'],
		subject: 'Our 40-seat pricing',
	});
	await seedThread(t, taylorBox, {
		participants: ['omar@northwind.example'],
		subject: 'Contract renewal terms',
	});
	const teamThread = await seedThread(t, teamBox, {
		participants: ['mia@northwind.example'],
		subject: 'Move the onboarding call',
	});
	const inboxThread = await seedTeamThread(t, 'elena@northwind.example', 'Security questionnaire');
	await t.mutation(internal.companies.indexer.sweep, {});
	return { t, devThread, teamThread, inboxThread };
}

describe('companies.get', () => {
	it('shows a member their own conversations and only the ids of colleagues in touch', async () => {
		const { t, teamThread } = await northwindWorkspace();
		as('user-jordan');
		const company = await t.query(api.companies.companies.get, { key: 'northwind.example' });
		expect(company?.conversations.map((c) => c.mailThreadId)).toEqual([teamThread]);
		expect(company?.people.map((p) => p.address)).toEqual(['mia@northwind.example']);
		expect(company?.colleagueUserIds.sort()).toEqual(['user-dev', 'user-taylor']);
		// Nothing of the colleagues' mail itself, and nothing of the Team Inbox.
		const text = JSON.stringify(company);
		for (const secret of ['sam@', 'omar@', 'elena@', '40-seat', 'renewal', 'questionnaire']) {
			expect(text).not.toContain(secret);
		}

		const list = await t.query(api.companies.companies.list, {});
		expect(list).toEqual([expect.objectContaining({ key: 'northwind.example', conversations: 1 })]);
	});

	it('shows an owner their mailboxes and the Team Inbox, and a colleague only by id', async () => {
		const { t, devThread, teamThread, inboxThread } = await northwindWorkspace();
		as('user-dev', 'owner');
		const company = await t.query(api.companies.companies.get, { key: 'northwind.example' });
		const opened = company?.conversations.map((c) => c.mailThreadId ?? c.conversationThreadId);
		expect(opened?.sort()).toEqual([devThread, teamThread, inboxThread].sort());
		expect(company?.colleagueUserIds).toEqual(['user-taylor']);
		expect(JSON.stringify(company)).not.toContain('omar@');
	});
});

describe('companies.forThread', () => {
	it('answers nothing for a thread the caller cannot open', async () => {
		const { t, devThread, inboxThread } = await northwindWorkspace();
		as('user-jordan');
		expect(await t.query(api.companies.companies.forThread, { mailThreadId: devThread })).toEqual(
			[]
		);
		expect(
			await t.query(api.companies.companies.forThread, { conversationThreadId: inboxThread })
		).toEqual([]);

		as('user-dev', 'owner');
		const [company] = await t.query(api.companies.companies.forThread, {
			mailThreadId: devThread,
		});
		expect(company?.key).toBe('northwind.example');
		// The panel sits beside the open thread, so it lists the others.
		expect(company?.conversations.map((c) => c.mailThreadId)).not.toContain(devThread);
		expect(company?.conversations).toHaveLength(2);
	});
});
