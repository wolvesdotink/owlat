/**
 * External mailbox accounts — feature gating, secret-hiding, provisioning,
 * disconnect, dedup, and the outbound transport decision.
 *
 * `getBetterAuthSessionWithRole` is mocked; the `mail.external` feature gate
 * reads a seeded `instanceSettings` row. Lives in convex/__tests__/ (with the
 * `../**` glob) like the other function-calling integration tests so
 * convex-test resolves `api.mail.*` / `internal.mail.*` by path.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		// Auth-floor helpers (used by authedQuery/authedMutation) derive from the
		// same per-test session set via `setSession`, so the secure-by-default
		// wrappers admit the owner the test configured.
		getUserIdFromSession: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return s.userId;
		}),
		getMutationContext: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role };
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role };
		}),
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { subject: s.userId, issuer: 'test', tokenIdentifier: `test|${s.userId}` };
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const CREDS = {
	emailAddress: 'me@example.com',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'me@example.com',
	authMethod: 'password' as const,
	secretCiphertext: 'ZmFrZS1jaXBoZXI=',
	secretIv: 'ZmFrZS1pdg==',
	secretAuthTag: 'ZmFrZS10YWc=',
	secretEnvelopeVersion: 1,
};

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null, orgId = 'org-1') {
	if (role === null) {
		sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(null);
		return;
	}
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role,
		activeOrganizationId: orgId,
	});
}

async function enableExternal(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'mail.external': true },
			createdAt: Date.now(),
		});
	});
}

describe('mail.external — feature gate', () => {
	it('getForCurrentUser throws when the flag is disabled', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A', 'owner');
		await expect(t.query(api.mail.externalAccounts.getForCurrentUser, {})).rejects.toThrow(
			/disabled/i
		);
	});

	it('getForCurrentUser returns { configured: false } when enabled but no account', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const result = await t.query(api.mail.externalAccounts.getForCurrentUser, {});
		expect(result.configured).toBe(false);
	});
});

describe('mail.external — connect + provisioning', () => {
	it('provisions an external mailbox (kind=external, unlimited quota, 6 folders)', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.externalAccounts._connectInternal,
			CREDS
		);

		const mailbox = await t.run((ctx) => ctx.db.get(mailboxId));
		expect(mailbox?.kind).toBe('external');
		expect(mailbox?.externalAccountId).toBe(externalAccountId);
		expect(mailbox?.quotaBytes).toBeUndefined();
		expect(mailbox?.address).toBe('me@example.com');

		const folders = await t.run((ctx) =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.collect()
		);
		expect(folders).toHaveLength(6);
	});

	it('never returns the encrypted credential fields from getForCurrentUser', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);

		const result = await t.query(api.mail.externalAccounts.getForCurrentUser, {});
		expect(result.configured).toBe(true);
		expect(result).not.toHaveProperty('secretCiphertext');
		expect(result).not.toHaveProperty('secretIv');
		expect(result).not.toHaveProperty('secretAuthTag');
		expect(result.emailAddress).toBe('me@example.com');
		expect(result.status).toBe('pending');
	});

	it('refuses a second connected account for the same user', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);
		await expect(
			t.mutation(internal.mail.externalAccounts._connectInternal, {
				...CREDS,
				emailAddress: 'second@example.com',
			})
		).rejects.toThrow(/already/i);
	});
});

describe('mail.external — disconnect', () => {
	it('soft-disables the account + mailbox and retains the rows', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.externalAccounts._connectInternal,
			CREDS
		);

		await t.mutation(api.mail.externalAccounts.disconnect, {});

		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		const mailbox = await t.run((ctx) => ctx.db.get(mailboxId));
		expect(account?.status).toBe('disconnected');
		expect(mailbox?.status).toBe('deleted');

		const result = await t.query(api.mail.externalAccounts.getForCurrentUser, {});
		expect(result.configured).toBe(false);
	});
});

describe('resolveOutboundTransport', () => {
	it('returns hosted for a hosted mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await t.run((ctx) =>
			ctx.db.insert('mailboxes', {
				userId: 'u',
				organizationId: 'org-1',
				address: 'hosted@x.camp',
				domain: 'x.camp',
				status: 'active',
				usedBytes: 0,
				uidValidity: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
		const res = await t.query(internal.mail.outboundTransport.resolveOutboundTransport, {
			mailboxId,
		});
		expect(res.kind).toBe('hosted');
	});

	it('returns external (smtp, no password) for an external mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'owner');
		const { mailboxId } = await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);

		const res = await t.query(internal.mail.outboundTransport.resolveOutboundTransport, {
			mailboxId,
		});
		expect(res.kind).toBe('external');
		if (res.kind === 'external') {
			expect(res.smtpHost).toBe('smtp.example.com');
			expect(res.smtpPort).toBe(465);
			expect(res.smtpUsername).toBe('me@example.com');
			expect(res.fromAddress).toBe('me@example.com');
		}
		expect(res).not.toHaveProperty('imapPassword');
		expect(res).not.toHaveProperty('smtpPassword');
		expect(res).not.toHaveProperty('secretCiphertext');
	});
});
