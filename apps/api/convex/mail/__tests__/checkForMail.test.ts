/**
 * "Check for mail" (mail/external/checkForMail.ts): the desktop tray and the
 * command palette ask the mail-sync worker to sync now. The request names
 * exactly the connected accounts behind the caller's readable mailboxes, the
 * personal one and the team inboxes they belong to, and nothing else.
 */

import { type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import type schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { liveMailTest, seedMailbox } from './helpers.testlib';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'editor' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

async function connectAccount(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	opts: { userId?: string; status?: 'connected' | 'disconnected' } = {}
): Promise<Id<'externalMailAccounts'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert('externalMailAccounts', {
			userId: opts.userId ?? 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password',
			imapUsername: 'someone@owlat.test',
			status: opts.status ?? 'connected',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: id });
		return id;
	});
}

async function scheduledWakes(t: TestConvex<typeof schema>): Promise<string[][]> {
	const jobs = await t.run(async (ctx) => ctx.db.system.query('_scheduled_functions').collect());
	return jobs
		.filter((job) => job.name.includes('checkForMail'))
		.map((job) => [...(job.args[0] as { accountIds: string[] }).accountIds].sort());
}

describe('mail.external.checkForMail.request', () => {
	it("wakes the worker for the caller's connected personal and team accounts only", async () => {
		const t = liveMailTest();
		const personal = await seedMailbox(t, { kind: 'external', address: 'a@owlat.test' });
		const personalAccount = await connectAccount(t, personal);
		const team = await seedMailbox(t, {
			kind: 'external',
			scope: 'shared',
			userId: 'user-B',
			address: 'sales@owlat.test',
		});
		const teamAccount = await connectAccount(t, team, { userId: 'user-B' });
		await t.run(async (ctx) => {
			await ctx.db.insert('mailboxMembers', {
				mailboxId: team,
				authUserId: 'user-A',
				role: 'member',
				addedBy: 'user-B',
				createdAt: Date.now(),
			});
		});
		// Not the caller's: another member's personal account.
		const other = await seedMailbox(t, { kind: 'external', userId: 'user-C', address: 'c@x.test' });
		await connectAccount(t, other, { userId: 'user-C' });
		// Disconnected: nothing for the worker to sync.
		const old = await seedMailbox(t, { kind: 'external', address: 'old@owlat.test' });
		await connectAccount(t, old, { status: 'disconnected' });
		// Hosted mail arrives without the worker.
		await seedMailbox(t, { address: 'hosted@owlat.test' });

		expect(await t.mutation(api.mail.external.checkForMail.request, {})).toEqual({
			accounts: 2,
		});
		expect(await scheduledWakes(t)).toEqual([[personalAccount, teamAccount].sort()]);
	});

	it('schedules nothing when the caller has no connected account', async () => {
		const t = liveMailTest();
		await seedMailbox(t, { address: 'hosted@owlat.test' });

		expect(await t.mutation(api.mail.external.checkForMail.request, {})).toEqual({
			accounts: 0,
		});
		expect(await scheduledWakes(t)).toEqual([]);
	});

	it('stops waking the worker when the same person asks again and again', async () => {
		const t = liveMailTest();
		const personal = await seedMailbox(t, { kind: 'external' });
		await connectAccount(t, personal);

		const answers = [];
		for (let i = 0; i < 10; i++) {
			answers.push(await t.mutation(api.mail.external.checkForMail.request, {}));
		}

		expect(answers[0]).toEqual({ accounts: 1 });
		expect(answers[answers.length - 1]).toEqual({ accounts: 1, throttled: true });
		expect((await scheduledWakes(t)).length).toBeLessThan(10);
	});
});
