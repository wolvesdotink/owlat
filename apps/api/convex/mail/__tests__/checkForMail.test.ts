/**
 * "Check for mail" (mail/external/checkForMail.ts): the desktop tray and the
 * command palette ask the mail-sync worker to sync now. The request names
 * exactly the connected accounts behind the caller's readable mailboxes, the
 * personal one and the team inboxes they belong to, and nothing else, and the
 * answer says whether the worker took it.
 */

import { type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubEnv('MAIL_SYNC_API_URL', 'http://mail-sync.test');
	vi.stubEnv('MAIL_SYNC_API_KEY', 'sync-key');
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(Response.json({ accepted: 1 }, { status: 202 }));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

/** The account ids of each `POST /sync` the worker received. */
function syncRequests(): string[][] {
	return fetchMock.mock.calls
		.filter(([url]) => String(url) === 'http://mail-sync.test/sync')
		.map(([, init]) =>
			[
				...(JSON.parse(String((init as RequestInit).body)) as { accountIds: string[] }).accountIds,
			].sort()
		);
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

		expect(await t.action(api.mail.external.checkForMail.request, {})).toEqual({
			status: 'checking',
		});
		expect(syncRequests()).toEqual([[personalAccount, teamAccount].sort()]);
	});

	it('asks the worker nothing when the caller has no connected account', async () => {
		const t = liveMailTest();
		await seedMailbox(t, { address: 'hosted@owlat.test' });

		expect(await t.action(api.mail.external.checkForMail.request, {})).toEqual({
			status: 'nothing_to_check',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fails when mail-sync cannot be reached', async () => {
		const t = liveMailTest();
		await connectAccount(t, await seedMailbox(t, { kind: 'external' }));
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));

		expect(await t.action(api.mail.external.checkForMail.request, {})).toEqual({
			status: 'failed',
		});
	});

	it('fails when mail-sync refuses the request', async () => {
		const t = liveMailTest();
		await connectAccount(t, await seedMailbox(t, { kind: 'external' }));
		fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));

		expect(await t.action(api.mail.external.checkForMail.request, {})).toEqual({
			status: 'failed',
		});
		expect(syncRequests()).toHaveLength(1);
	});

	it('fails when mail-sync is not configured', async () => {
		const t = liveMailTest();
		await connectAccount(t, await seedMailbox(t, { kind: 'external' }));
		vi.stubEnv('MAIL_SYNC_API_URL', '');

		expect(await t.action(api.mail.external.checkForMail.request, {})).toEqual({
			status: 'failed',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('stops waking the worker when the same person asks again and again', async () => {
		const t = liveMailTest();
		const personal = await seedMailbox(t, { kind: 'external' });
		await connectAccount(t, personal);

		const answers = [];
		for (let i = 0; i < 10; i++) {
			answers.push(await t.action(api.mail.external.checkForMail.request, {}));
		}

		expect(answers[0]).toEqual({ status: 'checking' });
		expect(answers[answers.length - 1]).toEqual({ status: 'rate_limited' });
		expect(syncRequests().length).toBeLessThan(10);
	});
});
