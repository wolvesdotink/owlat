/**
 * A deliverability SEED mailbox is org infrastructure, not a user inbox.
 *
 * Two regressions live here, both found in review:
 *
 *   1. `listConnectableAccounts` is what the mail-sync AccountManager reconciles
 *      against. A seed leaking into it makes the worker open an IMAP IDLE
 *      connection to the operator's personal consumer mailbox and ingest its
 *      whole contents into Convex as an ordinary Postbox mailbox — flatly
 *      contradicting "its mail is never indexed", re-ingesting every shadow copy
 *      as inbound mail, and racing the prober's sweep on `\Seen`.
 *   2. Connecting a seed makes every campaign the org sends deliver a full copy
 *      into a mailbox the connecting member controls. That is an ADMIN action,
 *      exactly as connecting a shared team inbox is.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getMutationContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

function setSession(role: 'owner' | 'admin' | 'editor' | null): void {
	sessionMock.role = role;
}

const CREDS = {
	imapHost: 'imap.gmail.example',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.gmail.example',
	smtpPort: 587,
	isSmtpSecure: false,
	imapUsername: 'seed-login',
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

async function connectSeed(t: TestConvex<typeof schema>, emailAddress: string): Promise<void> {
	await t.mutation(internal.mail.externalAccounts._connectSeedInternal, {
		...CREDS,
		emailAddress,
		seedProvider: 'gmail',
	});
}

describe('the seed connect path has an admin floor', () => {
	it('refuses an ordinary member', async () => {
		const t = convexTest(schema, modules);
		setSession('editor');
		await expect(connectSeed(t, 'owlat.seed.01@gmail.example')).rejects.toThrow(
			/owners and admins/
		);
		const rows = await t.run(async (ctx) => ctx.db.query('externalMailAccounts').collect());
		expect(rows).toEqual([]);
	});

	it('refuses an unauthenticated caller', async () => {
		const t = convexTest(schema, modules);
		setSession(null);
		await expect(connectSeed(t, 'owlat.seed.01@gmail.example')).rejects.toThrow();
	});

	it('allows an admin, and tags the row as a seed', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');
		const rows = await t.run(async (ctx) => ctx.db.query('externalMailAccounts').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.purpose).toBe('seed');
		expect(rows[0]?.seedProvider).toBe('gmail');
	});
});

describe('a seed mailbox is never handed to the inbound sync worker', () => {
	it('is excluded from listConnectableAccounts while ordinary accounts are not', async () => {
		const t = convexTest(schema, modules);
		setSession('admin');
		await connectSeed(t, 'owlat.seed.01@gmail.example');

		// A perfectly ordinary BYO account in the same deployment, in the same
		// `pending` status a freshly-connected seed has.
		const ordinaryId = await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-2',
				organizationId: 'org-1',
				address: 'real@user.example',
				domain: 'user.example',
				kind: 'external' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			return ctx.db.insert('externalMailAccounts', {
				userId: 'user-2',
				organizationId: 'org-1',
				mailboxId,
				imapHost: 'imap.user.example',
				imapPort: 993,
				isImapSecure: true,
				imapUsername: 'real',
				smtpHost: 'smtp.user.example',
				smtpPort: 587,
				isSmtpSecure: false,
				smtpUsername: 'real',
				authMethod: 'password' as const,
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'pending' as const,
				createdAt: 1,
				updatedAt: 1,
			});
		});

		const connectable = await t.query(internal.mail.externalAccounts.listConnectableAccounts, {});
		expect(connectable.map((a) => a.accountId)).toEqual([ordinaryId]);
	});
});
